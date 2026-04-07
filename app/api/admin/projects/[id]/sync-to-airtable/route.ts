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

  // Build justification from review history (same format as build approval flow)
  const justLines: string[] = []
  const sessions = project.workSessions
  const designSessions = sessions.filter((s) => s.stage === "DESIGN")
  const buildSessions = sessions.filter((s) => s.stage === "BUILD")
  const designHours = designSessions.reduce((sum, s) => sum + s.hoursClaimed, 0)
  const buildHours = buildSessions.reduce((sum, s) => sum + s.hoursClaimed, 0)
  const tierInfo = project.tier ? getTierById(project.tier) : null

  // Design review context
  const designReviewAction = await prisma.projectReviewAction.findFirst({
    where: { projectId: id, stage: "DESIGN", decision: "APPROVED" },
    orderBy: { createdAt: "desc" },
    select: { comments: true, createdAt: true, reviewerId: true, grantAmount: true },
  })
  if (designReviewAction) {
    const designReviewer = designReviewAction.reviewerId
      ? await prisma.user.findUnique({ where: { id: designReviewAction.reviewerId }, select: { name: true, email: true } })
      : null
    const designDate = designReviewAction.createdAt.toISOString().slice(0, 10)
    justLines.push(`--- Design Review (approved ${designDate} by ${designReviewer?.name || designReviewer?.email || "Unknown"}) ---`)
    if (designReviewAction.comments) justLines.push(designReviewAction.comments)
    justLines.push(`  Design hours: ${designHours.toFixed(1)}h across ${designSessions.length} entr${designSessions.length === 1 ? "y" : "ies"}`)
    justLines.push("")
  }

  // Build review context
  const buildReviewAction = await prisma.projectReviewAction.findFirst({
    where: { projectId: id, stage: "BUILD", decision: "APPROVED" },
    orderBy: { createdAt: "desc" },
    select: { comments: true, createdAt: true, reviewerId: true },
  })
  if (buildReviewAction) {
    const buildReviewer = buildReviewAction.reviewerId
      ? await prisma.user.findUnique({ where: { id: buildReviewAction.reviewerId }, select: { name: true, email: true } })
      : null
    const buildDate = buildReviewAction.createdAt.toISOString().slice(0, 10)
    justLines.push(`--- Build Review (approved ${buildDate} by ${buildReviewer?.name || buildReviewer?.email || "Unknown"}) ---`)
    if (buildReviewAction.comments) justLines.push(buildReviewAction.comments)
    justLines.push("")
  }

  justLines.push(`Project: "${project.title}"`)
  justLines.push(`User: ${project.user.name || "Unknown"}`)
  if (tierInfo) justLines.push(`Tier: ${tierInfo.name} (${tierInfo.bits} bits, ${tierInfo.minHours}-${tierInfo.maxHours === Infinity ? "67+" : tierInfo.maxHours}h range)`)
  justLines.push("")

  if (buildSessions.length > 0) {
    justLines.push(`Build hours: ${buildHours.toFixed(1)}h across ${buildSessions.length} journal entr${buildSessions.length === 1 ? "y" : "ies"}.`)
    const approvedBuildHours = buildSessions.reduce((sum, s) => sum + (s.hoursApproved ?? s.hoursClaimed), 0)
    const buildDeflation = buildHours - approvedBuildHours
    if (buildDeflation !== 0) {
      justLines.push(`Journal deflated by ${buildDeflation.toFixed(1)}h (claimed ${buildHours.toFixed(1)}h → approved ${approvedBuildHours.toFixed(1)}h)`)
    }
    justLines.push("")
  }

  const approvedBom = project.bomItems.filter((b) => b.status === "approved" || b.status === "pending")
  const bomItemsCost = approvedBom.reduce((sum, b) => sum + b.totalCost, 0)
  const bomTax = project.bomTax ?? 0
  const bomShip = project.bomShipping ?? 0
  const bomTotal = bomItemsCost + bomTax + bomShip
  if (approvedBom.length > 0 || bomTax > 0 || bomShip > 0) {
    const costParts = [`$${bomItemsCost.toFixed(2)} parts`]
    if (bomTax > 0) costParts.push(`$${bomTax.toFixed(2)} tax`)
    if (bomShip > 0) costParts.push(`$${bomShip.toFixed(2)} shipping`)
    justLines.push(`BOM (${approvedBom.length} item${approvedBom.length === 1 ? "" : "s"}, ${costParts.join(" + ")} = $${bomTotal.toFixed(2)} total):`)
    for (const item of approvedBom) {
      const detail = item.quantity != null && item.quantity > 1
        ? `${item.quantity}x = $${item.totalCost.toFixed(2)}`
        : `$${item.totalCost.toFixed(2)}`
      justLines.push(`  - ${item.name}: ${detail}${item.status === "pending" ? " (pending)" : ""}`)
    }
    justLines.push("")
  }

  if (project.badges.length > 0) {
    justLines.push(`Badges: ${project.badges.map((b) => b.badge).join(", ")}`)
    justLines.push("")
  }
  if (project.githubRepo) justLines.push(`GitHub: ${project.githubRepo}`)
  if (project.description) justLines.push(`Description: ${project.description}`)
  justLines.push("")
  justLines.push(`(Resynced to Airtable by ${authCheck.session.user.name || authCheck.session.user.email})`)

  const justification = justLines.join("\n")
  const grantAmount = designReviewAction?.grantAmount ?? null
  const isBuildApproved = project.buildStatus === "approved"

  try {
    await syncProjectToAirtable(
      project.userId,
      project,
      justification,
      grantAmount,
      isBuildApproved ? { buildOnly: true } : undefined,
    )
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("Failed to sync project to Airtable:", err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
