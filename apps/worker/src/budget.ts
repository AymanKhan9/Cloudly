import { prisma, budgetStatus, currentMonth, config, type BudgetStatus } from "@repo/db";

async function sendAlert(to: string | null, subject: string, text: string): Promise<void> {
  const apiKey = await config("RESEND_API_KEY");
  console.log(`[budget] ${subject}`);
  if (!apiKey || !to) return;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.ALERT_FROM ?? "Cloudly <onboarding@resend.dev>",
      to,
      subject,
      text,
    }),
  });
  if (!res.ok) console.error(`[budget] alert email failed: ${res.status} ${await res.text()}`);
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Called after a run records its cost. Each threshold fires once per month:
 * the conditional updateMany is the claim, so two workers finishing at once
 * can't both send the email or both cancel.
 */
export async function enforceBudget(userId: string): Promise<BudgetStatus> {
  const status = await budgetStatus(userId);
  if (status.state === "fair" || status.limitUsd === null) return status;

  const month = currentMonth();
  const notYet = (field: "warnedMonth" | "stoppedMonth") => ({
    OR: [{ [field]: null }, { [field]: { not: month } }],
  });
  const budget = await prisma.budget.findUnique({ where: { userId } });
  const spent = `${usd(status.spentUsd)} of ${usd(status.limitUsd)}`;

  if (status.state === "storm") {
    const claimed = await prisma.budget.updateMany({
      where: { userId, ...notYet("stoppedMonth") },
      data: { stoppedMonth: month, warnedMonth: month },
    });
    if (claimed.count === 0) return status;

    // Queued runs never start. A turn already running is left to finish, so a
    // task isn't cut off halfway; its own ceiling (process-run.ts) bounds it.
    await prisma.run.updateMany({
      where: { userId, status: "queued" },
      data: { status: "cancelled", cancelRequested: true, error: "Monthly spend limit reached" },
    });
    await sendAlert(
      budget?.alertEmail ?? null,
      `Cloudly stopped: spend limit reached (${spent})`,
      `Your Cloudly runs have spent ${spent} this month. New runs are blocked; a turn that was already running finishes first. Raise the limit in Settings to continue.`,
    );
    return status;
  }

  const claimed = await prisma.budget.updateMany({
    where: { userId, ...notYet("warnedMonth") },
    data: { warnedMonth: month },
  });
  if (claimed.count > 0) {
    await sendAlert(
      budget?.alertEmail ?? null,
      `Cloudly: 80% of your monthly spend limit used (${spent})`,
      `Your Cloudly runs have spent ${spent} this month. At 100% new runs are blocked; a turn already running finishes first.`,
    );
  }
  return status;
}
