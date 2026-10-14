import { prisma, budgetStatus, sandboxToolsLabel, harnessUsesPlan } from "@repo/db";
import type { Run } from "@repo/shared/run";
import type { RunEvent } from "@repo/shared/run-event";

import { createWorkspace, destroyWorkspace, type Workspace } from "./workspace";
import { createRunContainer, cancelRun, CODEX_HOME } from "./docker";
import {
  exportPatch,
  publishCommit,
  destroyPublish,
  pushBranch,
  openPullRequest,
  type CommitInfo,
  type PublishResult,
} from "./finalize";
import { insertEvents } from "./events";
import { heartbeat } from "./heartbeat";
import { resolveCloneSource, isRepoSlug } from "./github";
import { costFromDoneEvent } from "./cost";
import { agentSessionIdFromEvent } from "./agent-session";
import { promptWithHistory } from "./transcript";
import { withPreamble, sandboxRules, isCommand } from "./preamble";
import { modelCommand } from "@repo/shared/model-command";
import { sandboxImage, setupScript } from "./sandbox-image";
import { type ContainerOptions } from "./docker";
import { mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { enforceBudget } from "./budget";

const HEARTBEAT_INTERVAL_MS = 20_000;

// Agents that resume their own session across turns, so /compact, /context and
// their automatic compaction work on the whole conversation. Claude by default;
// the others start each turn clean and get the earlier conversation in the
// prompt. Gemini CLI can't: after one session/load it rewrites the session file
// with only its startup context, losing the conversation.
const NATIVE_RESUME = new Set(
  (process.env.CLOUDLY_NATIVE_RESUME ?? "native-claude,native-codex").split(",").map((s) => s.trim()).filter(Boolean),
);

/**
 * Whether the agent's own session file is still on disk to resume. Claude keeps
 * ~/.claude/projects/<cwd with / as ->/<id>.jsonl; Codex keeps
 * <codex home>/sessions/<date>/rollout-<time>-<id>.jsonl, in the shared Codex
 * home on a ChatGPT sign-in and in the session's own home otherwise.
 */
function sessionExists(harness: string, home: string, sessionId: string): boolean {
  if (harness === "native-claude") {
    return existsSync(path.join(home, ".claude", "projects", "-workspace", `${sessionId}.jsonl`));
  }
  if (harness === "native-codex") {
    return [CODEX_HOME, path.join(home, ".codex")].some((dir) => {
      try {
        return readdirSync(path.join(dir, "sessions"), { recursive: true }).some((f) => String(f).endsWith(`-${sessionId}.jsonl`));
      } catch {
        return false;
      }
    });
  }
  return false;
}

// Without a monthly limit, an API-key run still stops here. Plan runs have no dollar cap.
const BACKSTOP_USD = 20;

/** Host dir that becomes the sandbox HOME for every turn of a thread. */
export async function threadHome(threadId: string): Promise<string> {
  const dir = path.join(process.env.CLOUDLY_DATA_DIR ?? path.join(homedir(), ".cloudly"), "threads", threadId, "home");
  await mkdir(dir, { recursive: true });
  return dir;
}

export function prTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0]!.replace(/\s+/g, " ");
  return firstLine.length > 72 ? `${firstLine.slice(0, 71).trimEnd()}…` : firstLine;
}

/** How far past the monthly limit a turn that's already running may go. */
export const OVERSHOOT_RATIO = 0.25;

export async function processRun(
  run: Run,
  workerId: string,
  runContainer: (
    ws: Workspace,
    task: string,
    harness: string,
    runId: string,
    options?: ContainerOptions,
  ) => AsyncIterable<RunEvent> = createRunContainer,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
): Promise<void> {
  let leaseLost = false;
  let cancelled = false;

  const heartbeatTimer = setInterval(() => {
    heartbeat(run.id, workerId).then((ok) => {
      if (!ok) {
        leaseLost = true;
        console.error(`run ${run.id}: lease lost, another worker took over`);
      }
    });

    prisma.run
      .findUnique({ where: { id: run.id }, select: { cancelRequested: true } })
      .then((current) => {
        if (current?.cancelRequested) {
          cancelled = true;
          cancelRun(run.id).catch((err) =>
            console.error(`run ${run.id}: failed to send SIGINT:`, err),
          );
        }
      });
  }, heartbeatIntervalMs);

  let ws: Workspace | undefined;
  let publishResult: PublishResult | undefined;
  // The container's stderr is usually empty; the agent's own error event isn't.
  let agentError: string | undefined;
  let stopNote: string | undefined;

  try {
    const thread = run.threadId ? await prisma.thread.findUnique({ where: { id: run.threadId } }) : null;

    // Codex and Gemini have no /model when headless. The API already saved the
    // choice on the session, so just confirm it instead of sending it as text.
    const chosen = modelCommand(run.prompt);
    if (chosen !== undefined && run.harness !== "native-claude") {
      const reply = chosen ? `Model set to ${chosen} for the rest of this session.` : "Back to the default model for this session.";
      await insertEvents(run.id, [
        { seq: 0, ts: Date.now(), kind: "text", data: reply },
        { seq: 1, ts: Date.now(), kind: "done", data: { result: reply } },
      ]);
      await prisma.run.updateMany({ where: { id: run.id, workerId, leaseGen: run.leaseGen }, data: { status: "succeeded" } });
      return;
    }

    ws = await createWorkspace(await resolveCloneSource(run.repo), {
      branch: thread?.branch,
      baseBranch: run.baseBranch,
    });

    const nativeResume = Boolean(thread) && NATIVE_RESUME.has(run.harness) && run.harness !== "gemini-acp";
    const containerOptions: ContainerOptions = {};
    // Whether this turn continues the agent's own session, or starts clean and
    // gets the earlier conversation written into its prompt.
    let resumed = false;
    if (thread && nativeResume) {
      const home = await threadHome(thread.id);
      containerOptions.homeDir = home;
      const id = thread.agentSessionId;
      // A missing session file (cleaned data dir, older install) falls back to the transcript.
      if (id && sessionExists(run.harness, home, id)) {
        containerOptions.resume = id;
        resumed = true;
      }
    }
    // A turn that starts under the limit may finish past it, so a task isn't cut
    // off halfway, but only up to a ceiling of 25% of the monthly limit beyond it.
    // Claude enforces that itself mid-run; Codex and Gemini can't, so for them the
    // limit only applies between turns.
    // ponytail: every concurrent run gets the whole allowance, so with
    // WORKER_CONCURRENCY > 1 they can overshoot together. Split it if that matters.
    // On the user's own plan there's no per-run cost: no cap, nothing counted.
    const onPlan = await harnessUsesPlan(run.harness);
    if (onPlan) await prisma.run.updateMany({ where: { id: run.id, workerId, leaseGen: run.leaseGen }, data: { onPlan: true } });
    const budget = run.userId && !onPlan ? await budgetStatus(run.userId) : null;
    if (budget?.limitUsd != null) {
      const remaining = budget.limitUsd - budget.spentUsd;
      if (remaining <= 0) throw new Error("Monthly spend limit reached");
      containerOptions.maxBudgetUsd = remaining + budget.limitUsd * OVERSHOOT_RATIO;
    } else if (!onPlan) {
      containerOptions.maxBudgetUsd = BACKSTOP_USD;
    }
    containerOptions.image = await sandboxImage();
    if (thread?.model) containerOptions.model = thread.model;
    const tools = sandboxToolsLabel(containerOptions.image === "cloud-agents-base" ? "" : await setupScript());
    // A command goes to the agent as typed; history in front of it would turn it into text.
    const prompt = thread && !resumed && !isCommand(run.prompt)
      ? await promptWithHistory(thread.id, run.id, run.harness, run.prompt)
      : run.prompt;
    let task: string;
    if (run.harness === "native-claude") {
      // Claude takes the rules in its system prompt, so the message reaches it untouched.
      containerOptions.systemAppend = sandboxRules(tools);
      task = prompt.trim();
    } else {
      task = withPreamble(prompt, tools);
    }

    try {
      for await (const event of runContainer(ws, task, run.harness, run.id, containerOptions)) {
        await insertEvents(run.id, [event]);
        if (event.kind === "error") {
          const d = event.data as { message?: unknown; subtype?: unknown } | string | null;
          agentError = typeof d === "string" ? d : typeof d?.message === "string" ? d.message : agentError;
          // Stopped at the ceiling: keep what it finished, the same way a cancel does.
          if (typeof d === "object" && d?.subtype === "error_max_budget_usd") {
            cancelled = true;
            stopNote = "Stopped at the spend-limit ceiling. The work it finished is committed to the branch.";
          }
        }

        const agentSession = thread && nativeResume ? agentSessionIdFromEvent(run.harness, event) : null;
        if (thread && agentSession) {
          await prisma.thread.update({ where: { id: thread.id }, data: { agentSessionId: agentSession } });
        }

        // Record cost the moment the harness reports it, before finalize, so
        // spend counts even if the push or PR step later fails.
        const cost = onPlan ? null : costFromDoneEvent(run.harness, event);
        if (cost) {
          await prisma.run.updateMany({
            where: { id: run.id, workerId, leaseGen: run.leaseGen },
            data: { costUsd: cost.usd },
          });
          if (run.userId) await enforceBudget(run.userId);
        }
      }
    } catch (err) {
      // A SIGINT-triggered abort throws the same way a genuine crash does —
      // the SDKs give no way to tell them apart from the thrown error alone.
      // We already know locally whether *we* requested the cancellation, so
      // that's the signal we trust, not the error's text or the exit code.
      if (!cancelled) throw err;
      console.error(`run ${run.id}: container exited via cancellation:`, err);
    }

    if (leaseLost) return;

    // Fenced transition: only the worker that still holds this exact
    // (workerId, leaseGen) pair may move the run into finalizing.
    const toFinalizing = await prisma.run.updateMany({
      where: { id: run.id, workerId, leaseGen: run.leaseGen },
      data: { status: "finalizing" },
    });
    if (toFinalizing.count === 0) return;

    // Cancelled or not, still export/commit whatever the agent produced —
    // only the (not-yet-built) PR step is what cancellation actually skips.
    const patch = await exportPatch(ws);

    // A turn that only answered a question changes nothing: nothing to commit,
    // push or open a PR for.
    if (patch.trim() === "") {
      if (leaseLost) return;
      await prisma.run.updateMany({
        where: { id: run.id, workerId, leaseGen: run.leaseGen },
        data: { status: cancelled ? "cancelled" : "succeeded", error: stopNote },
      });
      return;
    }

    const commitInfo: CommitInfo = {
      branch: thread?.branch,
      runId: run.id,
      task: run.prompt,
      createdAt: run.createdAt,
    };
    publishResult = await publishCommit(ws, patch, commitInfo);

    if (leaseLost) return;

    // Only GitHub-slug repos have a real remote to push to — every worker
    // test fixture uses a local path, same gate `resolveCloneSource` uses.
    let prUrl: string | undefined;
    if (isRepoSlug(run.repo)) {
      await pushBranch(publishResult, run.repo);

      // Cancelled or not, the push above still lands — only PR creation is
      // what cancellation skips (see the comment above `exportPatch`).
      if (!cancelled) {
        const pr = await openPullRequest({
          repoSlug: run.repo,
          baseBranch: run.baseBranch,
          branch: publishResult.branch,
          title: prTitle(thread?.title ?? run.prompt),
          body: `Opened by Cloudly for run \`${run.id}\` (${run.harness}).\n\n**Task**\n\n${run.prompt}`,
        });
        prUrl = pr.url;
        if (thread) await prisma.thread.update({ where: { id: thread.id }, data: { prUrl: pr.url } });
      }
    }

    if (leaseLost) return;

    await prisma.run.updateMany({
      where: { id: run.id, workerId, leaseGen: run.leaseGen },
      data: {
        status: cancelled ? "cancelled" : "succeeded",
        error: stopNote,
        commitSha: publishResult.commitSha,
        branch: publishResult.branch,
        prUrl,
      },
    });
  } catch (err) {
    await prisma.run.updateMany({
      where: { id: run.id, workerId, leaseGen: run.leaseGen },
      data: {
        status: "failed",
        error: agentError ?? (err instanceof Error ? err.message : String(err)),
      },
    });
    throw err;
  } finally {
    clearInterval(heartbeatTimer);
    if (ws) await destroyWorkspace(ws);
    if (publishResult) await destroyPublish(publishResult);
  }
}
