import { prisma, budgetStatus, sandboxToolsLabel, harnessUsesPlan, gatewayMcpServers, secretsForRepo } from "@repo/db";
import { randomBytes } from "node:crypto";
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
import { withPreamble, sandboxRules, isCommand, runExtras } from "./preamble";
import { materializeRepoFiles, syncRepoFiles, destroyFilesDir, type FilesDir } from "./repo-files";
import { patchStats } from "./patch";
import { ensureRelay } from "./previews";
import { prepareContext, recordTurn, destroyContext, type ContextDir } from "./shared-context";
import { processCouncilTurn } from "./council";
import { prepareSessions, collectOutbox, deliverMessages, sendReply, destroySessions, type SessionsDir } from "./peer-sessions";
import { prepareAsk, recordQuestion, destroyAsk } from "./ask";
import { repoSettings, checkCommandFor, runChecks, queueFix, type CheckResult } from "./checks";
import { processReviewTurn, queueReview, branchDiff, baseRef } from "./review";
import { notifyTurnEnd } from "./notify";
import { processCheckpoint } from "./checkpoints";
import { processPlanTurn } from "./plans";
import { modelCommand } from "@repo/shared/model-command";
import { findCodexRollout, codexContext, findGeminiChat, geminiContext } from "./context-usage";
import { sandboxImage, setupScript } from "./sandbox-image";
import { type ContainerOptions } from "./docker";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { enforceBudget } from "./budget";
import { agentFeatures, isProviderHarness } from "@repo/shared/providers";

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
  if (harness === "native-codex") return findCodexRollout([CODEX_HOME, path.join(home, ".codex")], sessionId) !== null;
  // Pi and OpenCode keep their sessions in their own formats; the runner tries
  // session/load and, if it fails, starts over with the conversation in the prompt.
  if (agentFeatures(harness).resume) return true;
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

/** The checks' result, for a pull request's description. */
export function checkLine(check: CheckResult | null): string {
  if (!check || check.status === "skipped" || !check.command) return "";
  const what = check.status === "passed" ? "passed" : check.status === "failed" ? "failed" : "couldn't run";
  return `\n\n**Checks** ${what}: \`${check.command.split("\n")[0]!.slice(0, 200)}\``;
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
  // A council member's or chair's turn: an answer, not a change to commit.
  if (run.councilId) return processCouncilTurn(run, workerId, runContainer, heartbeatIntervalMs);
  // A review of the session's change, or an audit of the repo: findings, not a commit.
  if (run.kind === "review" || run.kind === "audit") return processReviewTurn(run, workerId, runContainer, heartbeatIntervalMs);
  // Going back to a checkpoint, or starting a fork from one: branch work, no agent.
  if (run.kind === "rewind" || run.kind === "fork") return processCheckpoint(run, workerId);
  // A planner breaking a big task into a plan's tasks.
  if (run.kind === "plan") return processPlanTurn(run, workerId, runContainer, heartbeatIntervalMs);
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

  // A turn's record in the repo's shared context. Never fails the turn: the work is already done.
  const shareTurn = async (ctx: ContextDir, extra: { summary?: string; prUrl?: string | null; stats?: { filesChanged: number; additions: number; deletions: number } }) =>
    // "/compact" and friends aren't work on the repo.
    !isCommand(run.prompt) &&
    recordTurn(ctx, { repo: run.repo, harness: run.harness, threadId: run.threadId, runId: run.id, prompt: run.prompt, ...extra }).catch((err) =>
      console.error(`run ${run.id}: couldn't record the turn in the shared context:`, err),
    );

  let ws: Workspace | undefined;
  let files: FilesDir | undefined;
  let context: ContextDir | null = null;
  let sessions: SessionsDir | null = null;
  let askDir: string | undefined;
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

    const nativeResume = Boolean(thread) && ((NATIVE_RESUME.has(run.harness) && run.harness !== "gemini-acp") || Boolean(agentFeatures(run.harness).resume));
    const containerOptions: ContainerOptions = {};
    // Whether this turn continues the agent's own session, or starts clean and
    // gets the earlier conversation written into its prompt.
    let resumed = false;
    // Every agent in a session keeps its home (sessions, chat logs) across turns.
    // Gemini still starts each turn clean: its own resume loses the history.
    if (thread) containerOptions.homeDir = await threadHome(thread.id);
    if (thread && nativeResume) {
      const home = containerOptions.homeDir!;
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
    if (thread?.effort) containerOptions.effort = thread.effort;

    // What the user connected: MCP servers (through the gateway), secrets (as
    // placeholders the proxy fills in), the repo's kept files, and a desktop.
    const mcp = Object.keys(await gatewayMcpServers());
    const secrets = await secretsForRepo(run.repo);
    files = await materializeRepoFiles(run.repo);
    containerOptions.mcpServers = mcp;
    containerOptions.filesDir = files.dir;
    containerOptions.env = Object.fromEntries(secrets.map((s) => [s.name, s.exposed ? s.value : s.placeholder]));
    if (thread?.desktop) {
      await ensureRelay().catch((err) => console.error(`run ${run.id}: relay:`, err));
      // VNC only reads the first 8 characters of a password.
      containerOptions.desktopPassword = randomBytes(6).toString("base64url");
      await prisma.run.updateMany({ where: { id: run.id, workerId, leaseGen: run.leaseGen }, data: { desktopPassword: containerOptions.desktopPassword } });
    }
    context = await prepareContext(run.repo, thread?.id);
    if (context) containerOptions.contextDir = context.dir;
    // The user's other sessions, to read and message (see peer-sessions.ts).
    sessions = thread ? await prepareSessions(run, thread) : null;
    if (sessions) containerOptions.sessionsDir = sessions.dir;
    // ask_user, so the agent can flag the session as needing the user.
    if (thread) containerOptions.askDir = askDir = await prepareAsk();
    const extras = runExtras({
      mcp, secrets, files: true, desktop: Boolean(thread?.desktop), context: context?.markdown,
      sessions: sessions ? { count: sessions.index.sessions.length, scope: sessions.index.scope, canSend: sessions.index.canSend > 0 } : undefined,
      ask: Boolean(askDir),
    });

    const tools = sandboxToolsLabel(containerOptions.image === "cloud-agents-base" ? "" : await setupScript());
    // A command goes to the agent as typed; history in front of it would turn it into text.
    const prompt = thread && !resumed && !isCommand(run.prompt)
      ? await promptWithHistory(thread.id, run.id, run.harness, run.prompt)
      : run.prompt;
    let task: string;
    if (run.harness === "native-claude") {
      // Claude takes the rules in its system prompt, so the message reaches it untouched.
      containerOptions.systemAppend = sandboxRules(tools, extras);
      task = prompt.trim();
    } else {
      task = withPreamble(prompt, tools, extras);
      // An added agent resuming its own session gets, as a fallback, the task with
      // the conversation written in, in case its session can't be loaded after all.
      if (resumed && thread && isProviderHarness(run.harness) && !isCommand(run.prompt)) {
        containerOptions.fallbackTask = withPreamble(await promptWithHistory(thread.id, run.id, run.harness, run.prompt), tools, extras);
      }
    }

    let lastSeq = -1;
    let sessionId = containerOptions.resume;
    // The agent's last reply: its own summary of the turn, for the shared context.
    let lastText: string | undefined;
    // What an added agent reports of its cost: Pi a turn's, OpenCode the session's so far.
    const acp = { resumed: false, sessionUsd: null as number | null, turnUsd: null as number | null };
    const acpCost = () => {
      if (acp.turnUsd !== null) return { usd: acp.turnUsd, estimated: false };
      if (acp.sessionUsd === null) return null;
      const before = acp.resumed ? thread?.agentSessionCost ?? 0 : 0;
      return { usd: Math.max(0, acp.sessionUsd - before), estimated: false };
    };
    try {
      for await (const event of runContainer(ws, task, run.harness, run.id, containerOptions)) {
        await insertEvents(run.id, [event]);
        lastSeq = Math.max(lastSeq, event.seq);
        if (event.kind === "text" && typeof event.data === "string" && event.data.trim()) lastText = event.data;
        if (event.kind === "error") {
          const d = event.data as { message?: unknown; subtype?: unknown } | string | null;
          agentError = typeof d === "string" ? d : typeof d?.message === "string" ? d.message : agentError;
          // Stopped at the ceiling: keep what it finished, the same way a cancel does.
          if (typeof d === "object" && d?.subtype === "error_max_budget_usd") {
            cancelled = true;
            stopNote = "Stopped at the spend-limit ceiling. The work it finished is committed to the branch.";
          }
        }

        const agentSession = agentSessionIdFromEvent(run.harness, event);
        if (agentSession) sessionId = agentSession;
        if (thread && nativeResume && agentSession) {
          await prisma.thread.update({ where: { id: thread.id }, data: { agentSessionId: agentSession } });
        }

        if (event.kind === "status" && isProviderHarness(run.harness)) {
          const d = event.data as { type?: string; resumed?: unknown; sessionUsd?: unknown; turnUsd?: unknown } | null;
          if (d?.type === "acp.session") acp.resumed = d.resumed === true;
          if (d?.type === "acp.cost" && typeof d.sessionUsd === "number") acp.sessionUsd = d.sessionUsd;
          if (d?.type === "acp.cost" && typeof d.turnUsd === "number") acp.turnUsd = d.turnUsd;
        }

        // Record cost the moment the harness reports it, before finalize, so
        // spend counts even if the push or PR step later fails.
        const reported = event.kind === "done" && isProviderHarness(run.harness) ? acpCost() : null;
        const cost = onPlan ? null : reported ?? costFromDoneEvent(run.harness, event);
        if (event.kind === "done" && thread && acp.sessionUsd !== null) {
          await prisma.thread.update({ where: { id: thread.id }, data: { agentSessionCost: acp.sessionUsd } });
        }
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

    // Codex and Gemini keep their context fill in their own session logs, not
    // the event stream; Claude reports it itself (the runner's context event).
    if (sessionId && containerOptions.homeDir) {
      let usage = null;
      if (run.harness === "native-codex") {
        const rollout = findCodexRollout([CODEX_HOME, path.join(containerOptions.homeDir, ".codex")], sessionId);
        usage = rollout ? codexContext(rollout) : null;
      } else if (run.harness === "gemini-acp") {
        const chat = findGeminiChat(containerOptions.homeDir, sessionId);
        usage = chat ? geminiContext(chat) : null;
      }
      if (usage) await insertEvents(run.id, [{ seq: ++lastSeq, ts: Date.now(), kind: "status", data: { type: "context", ...usage } }]);
    }

    // A question for the user: the session shows as needing them.
    if (askDir && thread) {
      const question = await recordQuestion(thread.id, askDir).catch((err) => (console.error(`run ${run.id}: couldn't save its question:`, err), null));
      if (question) await insertEvents(run.id, [{ seq: ++lastSeq, ts: Date.now(), kind: "status", data: { type: "ask_user", question } }]);
    }

    // Messages the agent sent other sessions become their next turns.
    if (sessions && thread) {
      try {
        const sent = await deliverMessages(run, thread, await collectOutbox(sessions));
        if (sent.length) await insertEvents(run.id, [{ seq: ++lastSeq, ts: Date.now(), kind: "status", data: { type: "sessions.sent", to: sent } }]);
      } catch (err) {
        console.error(`run ${run.id}: couldn't deliver its messages to other sessions:`, err);
      }
    }

    // The container has exited, so /files can be read without the agent changing it underneath.
    try {
      const synced = await syncRepoFiles(files);
      if (synced.saved.length || synced.deleted.length || synced.skipped.length) {
        await insertEvents(run.id, [{ seq: ++lastSeq, ts: Date.now(), kind: "status", data: { type: "files", ...synced } }]);
      }
    } catch (err) {
      console.error(`run ${run.id}: couldn't save /files:`, err);
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
        // Stopped before changing anything: say so, rather than "work committed".
        data: { status: cancelled ? "cancelled" : "succeeded", error: stopNote && "Stopped at the spend-limit ceiling before it changed any files." },
      });
      if (context) await shareTurn(context, { summary: lastText });
      // Asked to fix the reviewer's findings and changed nothing: the user decides.
      if (run.kind === "review_fix" && thread && !cancelled) {
        await prisma.thread.update({ where: { id: thread.id }, data: { needsInput: "The agent didn't change anything for the reviewer's findings. Read its reply, then say what to do.", settledAt: null } });
      }
      return;
    }

    // The repo's checks on the changed code, before it's committed (see checks.ts).
    // A cancelled turn or a /command isn't checked: nobody asked for it to be done.
    let check: CheckResult | null = null;
    let fixAttempts = 0;
    if (!cancelled && !isCommand(run.prompt)) {
      const settings = await repoSettings(run.repo);
      fixAttempts = settings.fixAttempts;
      const command = await checkCommandFor(settings, ws.runDir);
      if (command) {
        await insertEvents(run.id, [{ seq: ++lastSeq, ts: Date.now(), kind: "status", data: { type: "checks", status: "running", command } }]);
        check = await runChecks({
          runId: run.id, runDir: ws.runDir, objectsDir: ws.objectsDir, command, image: containerOptions.image!, timeoutSec: settings.checkTimeoutSec,
          homeDir: containerOptions.homeDir, filesDir: files.dir, env: containerOptions.env,
        });
        await insertEvents(run.id, [{ seq: ++lastSeq, ts: Date.now(), kind: "status", data: { type: "checks", status: check.status, command: check.command, ms: check.ms } }]);
      } else {
        // Recorded on the turn, but not logged: a repo without checks shouldn't say so every turn.
        check = { status: "skipped", command: null, ms: 0, output: settings.checks === "off" ? "Checks are off for this repo." : "No check command found in the repo. Set one under Settings > Checks." };
      }
      await prisma.run.updateMany({
        where: { id: run.id, workerId, leaseGen: run.leaseGen },
        data: { checkStatus: check.status, checkCommand: check.command, checkOutput: check.output, checkMs: check.ms },
      });
      if (leaseLost) return;
    }

    const commitInfo: CommitInfo = {
      branch: thread?.branch,
      runId: run.id,
      task: run.prompt,
      createdAt: run.createdAt,
    };
    publishResult = await publishCommit(ws, patch, commitInfo);
    const stats = patchStats(patch);

    // Everything the session has changed so far, for its Changes tab and its reviewer.
    if (thread) {
      const gitDir = path.join(publishResult.publishDir, ".git");
      const session = await branchDiff(gitDir, await baseRef(gitDir, run.baseBranch, false), "HEAD").catch(() => null);
      if (session) await prisma.thread.update({ where: { id: thread.id }, data: { diff: session.diff, diffBase: session.base } });
    }

    if (leaseLost) return;

    // Only GitHub-slug repos have a real remote to push to — every worker
    // test fixture uses a local path, same gate `resolveCloneSource` uses.
    let prUrl: string | undefined;
    if (isRepoSlug(run.repo)) {
      await pushBranch(publishResult, run.repo);

      // Cancelled or not, the push above still lands — only PR creation is
      // what cancellation skips (see the comment above `exportPatch`). Arena
      // sessions push too, but wait for their result to be picked.
      if (!cancelled && (thread?.autoPr ?? true)) {
        const pr = await openPullRequest({
          repoSlug: run.repo,
          baseBranch: run.baseBranch,
          branch: publishResult.branch,
          title: prTitle(thread?.title ?? run.prompt),
          body: `Opened by Cloudly for run \`${run.id}\` (${run.harness}).\n\n**Task**\n\n${run.prompt}${checkLine(check)}${thread?.issueNumber ? `\n\nCloses #${thread.issueNumber}` : ""}`,
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
        ...stats,
      },
    });
    if (context) await shareTurn(context, { summary: lastText, prUrl: prUrl ?? thread?.prUrl, stats });

    // Failing checks: the same agent gets another turn to fix them, a few times
    // in a row at most; after that the session asks the user.
    if (check?.status === "failed" && thread) {
      const fix = await queueFix(run, check, fixAttempts).catch((err) => (console.error(`run ${run.id}: couldn't queue a fix:`, err), null));
      if (fix?.queued) {
        await insertEvents(run.id, [{ seq: ++lastSeq, ts: Date.now(), kind: "status", data: { type: "checks.fix", attempt: fix.attempt, of: fix.of } }]);
      } else if (fix?.reason === "attempts used up" || fix?.reason === "the monthly spend limit is reached") {
        const why = fix.reason === "attempts used up" ? `after ${fix.of} fix attempt${fix.of === 1 ? "" : "s"}` : "and the monthly spend limit is reached, so no fix was attempted";
        await prisma.thread.update({ where: { id: thread.id }, data: { needsInput: `The checks (${check.command}) still fail ${why}. Look at the output, then reply with what to do.`, settledAt: null } });
        await insertEvents(run.id, [{ seq: ++lastSeq, ts: Date.now(), kind: "status", data: { type: "checks.gave_up", reason: fix.reason } }]);
      }
    } else if (thread && !cancelled && !isCommand(run.prompt)) {
      // Checks passed (or there are none): the repo's reviewer, if it has one, looks at the change.
      const queued = await queueReview(run).catch((err) => (console.error(`run ${run.id}: couldn't queue the review:`, err), false));
      if (queued) await insertEvents(run.id, [{ seq: ++lastSeq, ts: Date.now(), kind: "status", data: { type: "review.queued" } }]);
    }
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
    if (files) await destroyFilesDir(files);
    if (context) await destroyContext(context);
    if (sessions) await destroySessions(sessions);
    if (askDir) await destroyAsk(askDir);
    if (publishResult) await destroyPublish(publishResult);
    // A turn answering another session's message: its answer goes back there.
    if (run.replyToThreadId) await sendReply(run.id).catch((err) => console.error(`run ${run.id}: couldn't send its reply:`, err));
    // Tell the user, once the session has nothing more queued.
    if (!leaseLost) await notifyTurnEnd(run.id).catch((err) => console.error(`run ${run.id}: couldn't queue its notification:`, err));
  }
}
