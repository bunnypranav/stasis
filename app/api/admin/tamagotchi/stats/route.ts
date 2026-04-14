import { NextResponse } from "next/server"
import prisma from "@/lib/prisma"
import { requirePermission } from "@/lib/admin-auth"
import { Permission } from "@/lib/permissions"
import { TAMAGOTCHI_EVENT } from "@/lib/tamagotchi"

/**
 * GET /api/admin/tamagotchi/stats
 *
 * Returns aggregate stats and the full list of completers for the
 * Tamagotchi streak challenge.
 */
export async function GET() {
  const authCheck = await requirePermission(Permission.MANAGE_USERS)
  if (authCheck.error) return authCheck.error

  const fetchStart = new Date(TAMAGOTCHI_EVENT.START + "T00:00:00Z")
  fetchStart.setUTCDate(fetchStart.getUTCDate() - 1)
  const fetchEnd = new Date(TAMAGOTCHI_EVENT.END + "T00:00:00Z")
  fetchEnd.setUTCDate(fetchEnd.getUTCDate() + 2)

  // Count distinct participants (users with at least one journaled session in the window)
  const participantResult = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(DISTINCT p."userId") as count
    FROM work_session ws
    JOIN project p ON p.id = ws."projectId"
    WHERE ws."createdAt" >= ${fetchStart}
      AND ws."createdAt" < ${fetchEnd}
      AND ws.content IS NOT NULL
      AND TRIM(ws.content) <> ''
  `
  const totalParticipants = Number(participantResult[0].count)

  // Get all completers with user info
  const completers = await prisma.streakReward.findMany({
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          slackId: true,
          timezone: true,
        },
      },
    },
    orderBy: { completedAt: "asc" },
  })

  const totalCompleted = completers.length
  const totalClaimed = completers.filter((c) => c.claimed).length
  const totalShipped = completers.filter((c) => c.shipped).length

  // Count total grace days granted
  const graceDayResult = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count FROM streak_grace_day
  `
  const totalGraceDays = Number(graceDayResult[0].count)

  return NextResponse.json({
    stats: {
      totalParticipants,
      totalCompleted,
      totalClaimed,
      totalShipped,
      totalGraceDays,
      eventStart: TAMAGOTCHI_EVENT.START,
      eventEnd: TAMAGOTCHI_EVENT.END,
      streakGoal: TAMAGOTCHI_EVENT.STREAK_GOAL,
    },
    completers: completers.map((c) => ({
      userId: c.userId,
      name: c.user.name,
      email: c.user.email,
      slackId: c.user.slackId,
      timezone: c.user.timezone,
      completedAt: c.completedAt.toISOString(),
      claimed: c.claimed,
      shipped: c.shipped,
    })),
  })
}
