import { NextRequest, NextResponse } from "next/server"
import prisma from "@/lib/prisma"
import { requireAdmin } from "@/lib/admin-auth"
import { syncProjectToAirtable } from "@/lib/airtable"
import { getTierById } from "@/lib/tiers"

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authCheck = await requireAdmin()
  if (authCheck.error) return authCheck.error

  const { id } = await params

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      workSessions: true,
      bomItems: true,
      badges: true,
      user: { select: { name: true, email: true, slackId: true } },
    },
  })

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const sessions = project.workSessions
  const designSessions = sessions.filter((s) => s.stage === "DESIGN")
  const buildSessions = sessions.filter((s) => s.stage === "BUILD")
  const designHours = designSessions.reduce((sum, s) => sum + s.hoursClaimed, 0)
  const buildHours = buildSessions.reduce((sum, s) => sum + s.hoursClaimed, 0)
  const tierInfo = project.tier ? getTierById(project.tier) : null
  const isBuildApproved = project.buildStatus === "approved"
  const baseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000"

  // Helper: build the common tail (BOM, badges, github, description, journal link)
  function buildCommonTail(): string[] {
    const lines: string[] = []
    const approvedBom = project!.bomItems.filter((b) => b.status === "approved" || b.status === "pending")
    const bomItemsCost = approvedBom.reduce((sum, b) => sum + b.totalCost, 0)
    const bomTax = project!.bomTax ?? 0
    const bomShip = project!.bomShipping ?? 0
    const bomTotal = bomItemsCost + bomTax + bomShip
    if (approvedBom.length > 0 || bomTax > 0 || bomShip > 0) {
      const costParts = [`$${bomItemsCost.toFixed(2)} parts`]
      if (bomTax > 0) costParts.push(`$${bomTax.toFixed(2)} tax`)
      if (bomShip > 0) costParts.push(`$${bomShip.toFixed(2)} shipping`)
      lines.push(`BOM (${approvedBom.length} item${approvedBom.length === 1 ? "" : "s"}, ${costParts.join(" + ")} = $${bomTotal.toFixed(2)} total):`)
      for (const item of approvedBom) {
        const detail = item.quantity != null && item.quantity > 1
          ? `${item.quantity}x = $${item.totalCost.toFixed(2)}`
          : `$${item.totalCost.toFixed(2)}`
        lines.push(`  - ${item.name}: ${detail}${item.status === "pending" ? " (pending)" : ""}`)
      }
      lines.push("")
    }
    if (project!.badges.length > 0) {
      lines.push(`Badges: ${project!.badges.map((b) => b.badge).join(", ")}`)
      lines.push("")
    }
    if (project!.githubRepo) lines.push(`GitHub: ${project!.githubRepo}`)
    if (project!.description) lines.push(`Description: ${project!.description}`)
    lines.push("")
    lines.push(`The full journal for this project can be found at ${baseUrl}/dashboard/discover/${id}.`)
    return lines
  }

  // Helper: fetch first-pass and second-pass review text for a stage
  async function buildStageReviewLines(stage: "DESIGN" | "BUILD", label: string): Promise<string[]> {
    const lines: string[] = []
    const latestSubmission = await prisma.projectSubmission.findFirst({
      where: { projectId: id, stage },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    })
    if (latestSubmission) {
      const firstPass = await prisma.submissionReview.findFirst({
        where: { submissionId: latestSubmission.id, isAdminReview: false, result: "APPROVED" },
        orderBy: { createdAt: "desc" },
        select: { reviewerId: true, feedback: true, createdAt: true },
      })
      if (firstPass) {
        const fpUser = await prisma.user.findUnique({
          where: { id: firstPass.reviewerId },
          select: { name: true, email: true },
        })
        const fpName = fpUser?.name || fpUser?.email || "Unknown"
        const fpDate = firstPass.createdAt.toISOString().slice(0, 10)
        lines.push(`--- First-pass ${label} review (${fpDate} by ${fpName}) ---`)
        if (firstPass.feedback) lines.push(firstPass.feedback)
        lines.push("")
      }
    }
    const reviewAction = await prisma.projectReviewAction.findFirst({
      where: { projectId: id, stage, decision: "APPROVED" },
      orderBy: { createdAt: "desc" },
      select: { comments: true, createdAt: true, reviewerId: true },
    })
    if (reviewAction) {
      const reviewer = reviewAction.reviewerId
        ? await prisma.user.findUnique({ where: { id: reviewAction.reviewerId }, select: { name: true, email: true } })
        : null
      const reviewDate = reviewAction.createdAt.toISOString().slice(0, 10)
      lines.push(`--- Second-pass ${label} review (${reviewDate} by ${reviewer?.name || reviewer?.email || "Unknown"}) ---`)
      if (reviewAction.comments) lines.push(reviewAction.comments)
      lines.push("")
    }
    return lines
  }

  // Build stage-specific justifications
  const designReviewAction = await prisma.projectReviewAction.findFirst({
    where: { projectId: id, stage: "DESIGN", decision: "APPROVED" },
    orderBy: { createdAt: "desc" },
    select: { grantAmount: true },
  })
  const grantAmount = designReviewAction?.grantAmount ?? null

  let designJustification: string | undefined
  if (project.designStatus === "approved") {
    const lines: string[] = []
    lines.push(`**Design Review**`)
    lines.push("")
    lines.push(`Project: "${project.title}" (design approval)`)
    lines.push(`User: ${project.user.name || "Unknown"}`)
    if (tierInfo) lines.push(`Tier: ${tierInfo.name} (${tierInfo.bits} bits, ${tierInfo.minHours}-${tierInfo.maxHours === Infinity ? "67+" : tierInfo.maxHours}h range)`)
    lines.push("")
    lines.push(`This user logged ${designHours.toFixed(1)} design hours across ${designSessions.length} journal entr${designSessions.length === 1 ? "y" : "ies"}.`)
    lines.push("")
    lines.push(...await buildStageReviewLines("DESIGN", "design"))
    lines.push(...buildCommonTail())
    designJustification = lines.join("\n")
  }

  let buildJustification: string | undefined
  if (isBuildApproved) {
    const lines: string[] = []
    lines.push(`**Build Review**`)
    lines.push("")
    lines.push(`Project: "${project.title}" (build approval)`)
    lines.push(`User: ${project.user.name || "Unknown"}`)
    if (tierInfo) lines.push(`Tier: ${tierInfo.name} (${tierInfo.bits} bits, ${tierInfo.minHours}-${tierInfo.maxHours === Infinity ? "67+" : tierInfo.maxHours}h range)`)
    lines.push("")
    lines.push(`This user logged ${designHours.toFixed(1)} design hours across ${designSessions.length} journal entr${designSessions.length === 1 ? "y" : "ies"}.`)
    lines.push("")
    lines.push(...await buildStageReviewLines("DESIGN", "design"))
    lines.push(`This user logged ${buildHours.toFixed(1)} build hours across ${buildSessions.length} journal entr${buildSessions.length === 1 ? "y" : "ies"}.`)
    lines.push("")
    lines.push(...await buildStageReviewLines("BUILD", "build"))
    lines.push(...buildCommonTail())
    buildJustification = lines.join("\n")
  }

  try {
    // Sync every approved stage so manual re-sync can backfill missing records
    if (designJustification !== undefined) {
      await syncProjectToAirtable(
        project.userId,
        project,
        designJustification,
        grantAmount,
        { approvedHours: designHours },
      )
    }
    if (buildJustification !== undefined) {
      await syncProjectToAirtable(
        project.userId,
        project,
        buildJustification,
        grantAmount,
        { buildOnly: true },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("Failed to sync project to Airtable:", err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
