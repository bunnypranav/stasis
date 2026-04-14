import { NextRequest, NextResponse } from "next/server"
import prisma from "@/lib/prisma"
import { requirePermission } from "@/lib/admin-auth"
import { Permission } from "@/lib/permissions"
import {
  TAMAGOTCHI_EVENT,
  getEventDayDates,
  getEffectiveDate,
  validateTimezone,
  computeStreaks,
  type TamagotchiDay,
} from "@/lib/tamagotchi"

/**
 * GET /api/admin/tamagotchi/user-search?q=search_term
 *
 * Search for users by name, email, or Slack ID and return their
 * Tamagotchi streak status.
 */
export async function GET(request: NextRequest) {
  const authCheck = await requirePermission(Permission.MANAGE_USERS)
  if (authCheck.error) return authCheck.error

  const q = request.nextUrl.searchParams.get("q")?.trim()
  if (!q || q.length < 2) {
    return NextResponse.json({ users: [] })
  }

  // Find matching users (limit 20)
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { slackId: q },
      ],
    },
    select: {
      id: true,
      name: true,
      email: true,
      slackId: true,
      timezone: true,
    },
    take: 20,
  })

  if (users.length === 0) {
    return NextResponse.json({ users: [] })
  }

  const fetchStart = new Date(TAMAGOTCHI_EVENT.START + "T00:00:00Z")
  fetchStart.setUTCDate(fetchStart.getUTCDate() - 1)
  const fetchEnd = new Date(TAMAGOTCHI_EVENT.END + "T00:00:00Z")
  fetchEnd.setUTCDate(fetchEnd.getUTCDate() + 2)

  const userIds = users.map((u) => u.id)

  // Fetch all sessions and grace days for these users in bulk
  const [sessions, graceDays, rewards] = await Promise.all([
    prisma.workSession.findMany({
      where: {
        project: { userId: { in: userIds } },
        createdAt: { gte: fetchStart, lt: fetchEnd },
      },
      select: {
        createdAt: true,
        content: true,
        effectiveDate: true,
        project: { select: { userId: true } },
      },
    }),
    prisma.streakGraceDay.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, date: true },
    }),
    prisma.streakReward.findMany({
      where: { userId: { in: userIds } },
    }),
  ])

  // Group data by user
  const sessionsByUser = new Map<string, typeof sessions>()
  for (const s of sessions) {
    const uid = s.project.userId
    if (!sessionsByUser.has(uid)) sessionsByUser.set(uid, [])
    sessionsByUser.get(uid)!.push(s)
  }

  const graceByUser = new Map<string, Set<string>>()
  for (const g of graceDays) {
    if (!graceByUser.has(g.userId)) graceByUser.set(g.userId, new Set())
    graceByUser.get(g.userId)!.add(g.date)
  }

  const rewardByUser = new Map(rewards.map((r) => [r.userId, r]))

  const eventDates = getEventDayDates()
  const today = new Date().toISOString().slice(0, 10)

  const results = users.map((user) => {
    const userSessions = sessionsByUser.get(user.id) ?? []
    const userGrace = graceByUser.get(user.id) ?? new Set<string>()
    const tz = validateTimezone(user.timezone)

    // Build day map
    const dayMap = new Map<string, { hasJournal: boolean; sessions: number }>()
    for (const ws of userSessions) {
      const dateStr = ws.effectiveDate ?? getEffectiveDate(ws.createdAt, tz)
      if (dateStr < TAMAGOTCHI_EVENT.START || dateStr > TAMAGOTCHI_EVENT.END) continue
      const entry = dayMap.get(dateStr) || { hasJournal: false, sessions: 0 }
      if (ws.content && ws.content.trim().length > 0) entry.hasJournal = true
      entry.sessions += 1
      dayMap.set(dateStr, entry)
    }

    const allDays: TamagotchiDay[] = eventDates.map((date) => {
      const data = dayMap.get(date)
      const hasJournal = data?.hasJournal ?? false
      return {
        date,
        completed: hasJournal,
        hasJournal,
        sessions: data?.sessions ?? 0,
        isToday: date === today,
        isFuture: date > today,
        isGraceDay: userGrace.has(date) && !hasJournal,
      }
    })

    const { currentStreak, bestStreak, challengeComplete } = computeStreaks(allDays)
    const reward = rewardByUser.get(user.id)

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      slackId: user.slackId,
      timezone: user.timezone,
      bestStreak,
      currentStreak,
      challengeComplete: challengeComplete || !!reward,
      totalJournaledDays: allDays.filter((d) => d.completed).length,
      totalSessions: userSessions.length,
      graceDays: userGrace.size,
      reward: reward
        ? { completedAt: reward.completedAt.toISOString(), claimed: reward.claimed, shipped: reward.shipped }
        : null,
      days: allDays.map((d) => ({
        date: d.date,
        completed: d.completed,
        isGraceDay: d.isGraceDay,
      })),
    }
  })

  return NextResponse.json({ users: results })
}
