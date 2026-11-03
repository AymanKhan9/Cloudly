import { prisma } from "./client"

// The agent scorecard: how each agent's sessions on a repo have gone, from what
// Cloudly already records. Pull requests merged (by anyone) or closed, cost per
// merged pull request, the checks on the first try, the fix turns it took, what
// the reviewer flagged, and rewinds. "Auto" picks from it.

/** A pull request open this long without merging counts as not merged. */
const STALE_MS = 14 * 24 * 3600_000
/** Decided pull requests an agent needs on a repo before Auto trusts its record. */
export const PICK_MIN_DECIDED = 3

export interface AgentScore {
  harness: string
  sessions: number
  prs: number
  merged: number
  /** Closed without merging, or open for 14 days. */
  notMerged: number
  open: number
  /** merged / (merged + notMerged); null before any is decided. */
  mergeRate: number | null
  costUsd: number
  costPerMerged: number | null
  /** Turns whose checks passed the first time, of those that ran them. */
  checksFirstTry: number | null
  fixTurnsPerPr: number | null
  blockingPerReview: number | null
  hoursToMerge: number | null
  rewinds: number
}

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export async function agentScorecard(opts: { repo?: string | null; days?: number; now?: number } = {}): Promise<AgentScore[]> {
  const now = opts.now ?? Date.now()
  const since = new Date(now - (opts.days ?? 90) * 24 * 3600_000)
  const threads = await prisma.thread.findMany({
    where: { createdAt: { gte: since }, ...(opts.repo ? { repo: opts.repo } : {}), arenaId: null },
    select: { id: true, harness: true, prUrl: true, mergedAt: true, prClosedAt: true, createdAt: true },
  })
  if (!threads.length) return []
  const ids = threads.map((t) => t.id)
  const runs = await prisma.run.findMany({
    where: { threadId: { in: ids } },
    select: { threadId: true, kind: true, costUsd: true, checkStatus: true, harness: true },
  })
  const findings = await prisma.reviewFinding.groupBy({ by: ["threadId"], where: { threadId: { in: ids }, severity: "blocking" }, _count: true })
  const blockingBy = new Map(findings.map((f) => [f.threadId, f._count]))

  const by = new Map<string, typeof threads>()
  for (const t of threads) by.set(t.harness, [...(by.get(t.harness) ?? []), t])
  const runsBy = new Map<string, typeof runs>()
  for (const r of runs) if (r.threadId) runsBy.set(r.threadId, [...(runsBy.get(r.threadId) ?? []), r])

  const out: AgentScore[] = []
  for (const [harness, list] of by) {
    let merged = 0, notMerged = 0, open = 0, prs = 0, cost = 0, mergedCost = 0, fixTurns = 0, reviews = 0, blocking = 0, rewinds = 0, checked = 0, passed = 0
    const toMerge: number[] = []
    let sessions = 0
    for (const t of list) {
      const rs = runsBy.get(t.id) ?? []
      // Sessions that did something: not only imported or set up.
      if (!rs.some((r) => ["turn", "fix", "audit", "ci_fix", "review_fix"].includes(r.kind))) continue
      sessions++
      // The session's own agent's turns: a review's cost and checks are the reviewer's.
      const own = rs.filter((r) => r.kind !== "review")
      const c = own.reduce((s, r) => s + (r.costUsd ? Number(r.costUsd) : 0), 0)
      cost += c
      rewinds += rs.filter((r) => r.kind === "rewind").length
      for (const r of own) {
        if (r.kind === "turn" && (r.checkStatus === "passed" || r.checkStatus === "failed")) {
          checked++
          if (r.checkStatus === "passed") passed++
        }
      }
      reviews += rs.filter((r) => r.kind === "review").length
      blocking += blockingBy.get(t.id) ?? 0
      if (!t.prUrl) continue
      prs++
      fixTurns += rs.filter((r) => r.kind === "fix" || r.kind === "ci_fix" || r.kind === "review_fix").length
      if (t.mergedAt) {
        merged++
        mergedCost += c
        toMerge.push((t.mergedAt.getTime() - t.createdAt.getTime()) / 3600_000)
      } else if (t.prClosedAt || now - t.createdAt.getTime() > STALE_MS) notMerged++
      else open++
    }
    if (!sessions) continue
    out.push({
      harness, sessions, prs, merged, notMerged, open,
      mergeRate: merged + notMerged ? merged / (merged + notMerged) : null,
      costUsd: cost,
      costPerMerged: merged ? mergedCost / merged : null,
      checksFirstTry: checked ? passed / checked : null,
      fixTurnsPerPr: prs ? fixTurns / prs : null,
      blockingPerReview: reviews ? blocking / reviews : null,
      hoursToMerge: median(toMerge),
      rewinds,
    })
  }
  return out.sort((a, b) => (b.mergeRate ?? -1) - (a.mergeRate ?? -1) || b.sessions - a.sessions)
}

/**
 * The agent with the best record on a repo, among `candidates`: the most pull
 * requests merged, smoothed so two of two doesn't beat nine of ten, cheaper per
 * merge on a tie. Null until one has PICK_MIN_DECIDED decided pull requests.
 */
export function pickAgent(scores: AgentScore[], candidates: string[]): { harness: string; reason: string; score: number } | null {
  const ranked = scores
    .filter((s) => candidates.includes(s.harness) && s.merged + s.notMerged >= PICK_MIN_DECIDED)
    .map((s) => ({ s, score: (s.merged + 1) / (s.merged + s.notMerged + 2) }))
    .sort((a, b) => b.score - a.score || (a.s.costPerMerged ?? Infinity) - (b.s.costPerMerged ?? Infinity))
  const best = ranked[0]
  if (!best) return null
  const d = best.s.merged + best.s.notMerged
  return { harness: best.s.harness, score: best.score, reason: `${best.s.merged} of ${d} pull requests merged` }
}
