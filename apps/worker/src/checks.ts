import path from "node:path";

import { prisma, budgetStatus, harnessUsesPlan } from "@repo/db";
import { readRegular } from "./repo-files";
import { ensureEgress, EGRESS_FLAGS, sandboxTrustFlags } from "./egress";
import { SANDBOX_LIMITS, envFlags, sandboxUser } from "./docker";
import { workspaceMounts } from "./workspace";

// The repo's checks (its tests, usually), run after every turn that changes code.
// They run in a container of their own on the run clone, after the patch has been
// captured, so nothing they do can change what gets committed. They reach the
// network through the egress proxy like the agent did (installing packages works)
// but get no model keys. When they fail, the agent is asked to fix them, a few
// times at most (see queueFix).

export type CheckStatus = "passed" | "failed" | "error" | "skipped";

export interface CheckResult {
  status: CheckStatus;
  command: string | null;
  output: string;
  ms: number;
}

export const DEFAULT_SETTINGS = {
  checks: "auto", checkCommand: null as string | null, fixAttempts: 2, checkTimeoutSec: 600,
  reviewer: null as string | null, reviewRounds: 2, reviewPostToGitHub: true,
  triggerHarness: null as string | null, issueLabel: "cloudly", onIssueLabel: true, onMention: true, onPrReview: true, fixCi: true, ciFixAttempts: 2,
  autoMerge: false, mergeMethod: "squash",
  screenshots: false, screenshotCommand: null as string | null, screenshotPort: 3000, screenshotPaths: ["/"] as string[],
};
const OUTPUT_CHARS = 12_000;
/** Bash's exit code for a command that isn't installed: "couldn't run", not a failing test. */
const NOT_FOUND = 127;
/** Python says this, with exit code 1, when the test runner itself isn't installed. */
const MISSING_PYTHON_TOOL = /No module named (pytest|pip)\b/;

export async function repoSettings(repo: string) {
  return (await prisma.repoSettings.findUnique({ where: { repo } })) ?? { repo, ...DEFAULT_SETTINGS };
}

async function readText(dir: string, file: string): Promise<string | null> {
  const bytes = await readRegular(path.join(dir, file), 512 * 1024);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

const exists = async (dir: string, file: string) => (await readText(dir, file)) !== null;

/**
 * The check command a repo most likely uses, from its own files. The run clone is
 * the agent's, so these reads are of untrusted files: regular files only, size
 * capped, and all they decide is which command runs in the check container.
 */
export async function detectCheckCommand(dir: string): Promise<string | null> {
  const pkgText = await readText(dir, "package.json");
  if (pkgText) {
    let test: unknown;
    try {
      test = JSON.parse(pkgText)?.scripts?.test;
    } catch {}
    // npm init's placeholder isn't a test suite.
    if (typeof test === "string" && test.trim() && !/no test specified/.test(test)) {
      if ((await exists(dir, "bun.lock")) || (await exists(dir, "bun.lockb"))) return "bun install && bun run test";
      if (await exists(dir, "pnpm-lock.yaml")) return "corepack pnpm install && corepack pnpm test";
      if (await exists(dir, "yarn.lock")) return "corepack yarn install && corepack yarn test";
      return "npm install --no-audit --no-fund && npm test";
    }
  }
  const pyproject = await readText(dir, "pyproject.toml");
  if ((pyproject && /pytest/.test(pyproject)) || (await exists(dir, "pytest.ini")) || (await exists(dir, "conftest.py"))) {
    const install = (await exists(dir, "requirements.txt")) ? "python3 -m pip install -q -r requirements.txt && " : "";
    return `${install}python3 -m pytest -q`;
  }
  if (await exists(dir, "go.mod")) return "go test ./...";
  if (await exists(dir, "Cargo.toml")) return "cargo test";
  const makefile = await readText(dir, "Makefile");
  if (makefile && /^test:/m.test(makefile)) return "make test";
  return null;
}

/** The command to run for this repo, or null when checks are off or none was found. */
export async function checkCommandFor(settings: { checks: string; checkCommand: string | null }, dir: string): Promise<string | null> {
  if (settings.checks === "off") return null;
  if (settings.checks === "custom") return settings.checkCommand?.trim() || null;
  return detectCheckCommand(dir);
}

export interface CheckRun {
  runId: string;
  runDir: string;
  /** The mirror's objects the run clone borrows; see workspaceMounts. */
  objectsDir?: string;
  command: string;
  image: string;
  timeoutSec: number;
  /** The session's HOME, so package caches carry over between checks. */
  homeDir?: string;
  /** The repo's kept files, read-only. */
  filesDir?: string;
  /** The same secrets (placeholders) the agent got. */
  env?: Record<string, string>;
}

export function tail(text: string, chars = OUTPUT_CHARS): string {
  return text.length > chars ? `[…earlier output cut]\n${text.slice(-chars)}` : text;
}

/** Runs the repo's checks on the run clone, in a container of their own. */
export async function runChecks(c: CheckRun): Promise<CheckResult> {
  const started = Date.now();
  await ensureEgress();
  const env = envFlags(c.env);
  const name = `check-${c.runId}`;
  const proc = Bun.spawn(
    [
      "docker", "run", "--rm", "--name", name,
      ...SANDBOX_LIMITS, ...EGRESS_FLAGS, ...(await sandboxTrustFlags()), "--init",
      ...workspaceMounts(c), "-w", "/workspace",
      ...(c.filesDir ? ["-v", `${c.filesDir}:/files:ro`] : []),
      ...(c.homeDir ? ["-v", `${c.homeDir}:/home/node`, "-e", "HOME=/home/node"] : []),
      // Test runners skip watch mode and colour codes in CI.
      "-e", "CI=true", "-e", "NO_COLOR=1",
      ...env.flags,
      "--user", sandboxUser(),
      c.image,
      "bash", "-c", `exec 2>&1\n${c.command}`,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env.env } },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    Bun.spawn(["docker", "kill", name], { stdout: "ignore", stderr: "ignore" });
  }, c.timeoutSec * 1000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const ms = Date.now() - started;
  const output = tail((out + (err ? `\n${err}` : "")).trim());
  if (timedOut) return { status: "failed", command: c.command, output: tail(`${output}\n\n[Cloudly stopped the checks after ${Math.round(c.timeoutSec / 60)} minutes.]`), ms };
  if (code === 0) return { status: "passed", command: c.command, output, ms };
  // 125: Docker couldn't start the container. A missing tool means the checks
  // couldn't run, which no change to the code would fix.
  if (code === 125) return { status: "error", command: c.command, output, ms };
  if (code === NOT_FOUND || MISSING_PYTHON_TOOL.test(output)) {
    const hint = "A tool the checks need isn't installed in the sandbox. Add it under Settings > Sandbox tools, or change the check command under Settings > Checks.";
    return { status: "error", command: c.command, output: tail(`${output}\n\n[${hint}]`), ms };
  }
  return { status: "failed", command: c.command, output, ms };
}

/** What the agent is told when its change broke the checks. The first line is the turn's title. */
export function fixPrompt(command: string, output: string, attempt: number, of: number): string {
  return [
    `Fix the failing checks (attempt ${attempt} of ${of})`,
    "",
    `Cloudly ran the repo's checks after your last change, and they failed. The command was:`,
    "",
    "```sh",
    command,
    "```",
    "",
    "Fix the code so they pass. Don't skip, delete or weaken tests to make them pass. If the failure has nothing to do with your change, or you can't fix it, say so plainly and stop.",
    "",
    "The end of the output:",
    "",
    "```",
    tail(output, 6000),
    "```",
  ].join("\n");
}

/**
 * After a turn whose checks failed: queue a fix turn for the same agent, unless
 * the attempts in a row are used up or the user has already sent something next.
 * Returns what happened, for the turn's log.
 */
export async function queueFix(
  run: { id: string; threadId?: string | null; repo: string; baseBranch: string; harness: string; userId?: string | null; kind?: string },
  check: CheckResult,
  fixAttempts: number,
): Promise<{ queued: boolean; attempt: number; of: number; reason?: string }> {
  const of = fixAttempts;
  if (!run.threadId || of <= 0 || check.status !== "failed" || !check.command) return { queued: false, attempt: 0, of, reason: "off" };
  // Fix turns in a row, this one included, back to the last turn the user (or another session) asked for.
  const recent = await prisma.run.findMany({ where: { threadId: run.threadId }, orderBy: { createdAt: "desc" }, take: of + 2, select: { id: true, kind: true, status: true } });
  const waiting = recent.some((r) => r.id !== run.id && (r.status === "queued" || r.status === "running"));
  if (waiting) return { queued: false, attempt: 0, of, reason: "a newer message is waiting" };
  let inARow = 0;
  for (const r of recent) {
    if (r.kind !== "fix") break;
    inARow++;
  }
  if (inARow >= of) return { queued: false, attempt: inARow, of, reason: "attempts used up" };
  if (run.userId && !(await harnessUsesPlan(run.harness)) && (await budgetStatus(run.userId)).state === "storm") {
    return { queued: false, attempt: inARow, of, reason: "the monthly spend limit is reached" };
  }
  const attempt = inARow + 1;
  await prisma.run.create({
    data: {
      repo: run.repo, baseBranch: run.baseBranch, harness: run.harness, userId: run.userId, threadId: run.threadId,
      status: "queued", kind: "fix", prompt: fixPrompt(check.command, check.output, attempt, of),
    },
  });
  await prisma.thread.update({ where: { id: run.threadId }, data: { updatedAt: new Date() } });
  return { queued: true, attempt, of };
}
