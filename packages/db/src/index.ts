import { prisma, Prisma } from "./client"

export { prisma, Prisma }
export * from "./secrets"
export * from "./github-credentials"

export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7)
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

export type BudgetState = "fair" | "change" | "storm"

export interface BudgetStatus {
  spentUsd: number
  limitUsd: number | null
  ratio: number
  state: BudgetState
}

// Fair < 80% ≤ Change < 100% ≤ Storm. Storm is the hard stop.
export function budgetState(spentUsd: number, limitUsd: number | null): BudgetState {
  if (!limitUsd || limitUsd <= 0) return "fair"
  const ratio = spentUsd / limitUsd
  if (ratio >= 1) return "storm"
  if (ratio >= 0.8) return "change"
  return "fair"
}

export async function budgetStatus(userId: string): Promise<BudgetStatus> {
  const [agg, budget] = await Promise.all([
    prisma.run.aggregate({
      where: { userId, createdAt: { gte: monthStart() } },
      _sum: { costUsd: true },
    }),
    prisma.budget.findUnique({ where: { userId } }),
  ])
  const spentUsd = agg._sum.costUsd?.toNumber() ?? 0
  const limitUsd = budget ? budget.monthlyLimitUsd.toNumber() : null
  return {
    spentUsd,
    limitUsd,
    ratio: limitUsd ? spentUsd / limitUsd : 0,
    state: budgetState(spentUsd, limitUsd),
  }
}
