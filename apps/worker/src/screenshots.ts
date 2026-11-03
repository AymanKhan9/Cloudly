import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { prisma, hasDesktop, secretsForRepo, budgetStatus, harnessUsesPlan } from "@repo/db";
import type { Run } from "@repo/shared/run";

import { createWorkspace, destroyWorkspace, type Workspace } from "./workspace";
import { resolveCloneSource, updatePullRequestSection } from "./github";
import { insertEvents } from "./events";
import { repoSettings, tail } from "./checks";
import { ensureEgress, EGRESS_FLAGS, sandboxTrustFlags } from "./egress";
import { SANDBOX_LIMITS, envFlags, sandboxUser } from "./docker";
import { workspaceMounts } from "./workspace";
import { sandboxImage, setupScript } from "./sandbox-image";
import { threadHome } from "./process-run";
import { collectArtifacts, latestArtifacts } from "./artifacts";

// Before-and-after screenshots of a UI change. After a turn that changes UI
// files, on a repo that has them on: a turn of its own (kind "screenshots",
// targetRunId the turn) starts the app at that turn's commit, screenshots each
// page in headless Chromium, then does the same at the commit before it. They
// become the session's artifacts shots/<page>/before.png and after.png, shown
// side by side, and a Screenshots section in the pull request's description.
//
// It runs like the checks: a container of its own on the session's clone, the
// repo's secrets as placeholders, the network through the egress proxy.

/** Files whose change can change how the app looks. */
const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|styl|erb|hbs|njk|liquid|twig|php|mdx)$|(^|\/)(tailwind|postcss)\.config\.[cm]?[jt]s$|(^|\/)(public|static|assets)\//i;

/** The files a patch touches. */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((m) => m[2]!);
}

export const touchesUi = (files: string[]) => files.some((f) => UI_FILE.test(f));

/** "/settings/billing" → "settings-billing"; "/" → "home". */
export function pageSlug(p: string): string {
  const s = p.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "").replace(/[^\w-]+/g, "-").replace(/-+/g, "-").slice(0, 40);
  return s || "home";
}

/** After a committed turn: queue its screenshots, if the repo wants them and the change can be seen. */
export async function queueScreenshots(run: { id: string; threadId?: string | null; repo: string; baseBranch: string; harness: string; userId?: string | null }, patch: string): Promise<boolean> {
  if (!run.threadId) return false;
  const settings = await repoSettings(run.repo);
  if (!settings.screenshots || !settings.screenshotCommand) return false;
  if (!touchesUi(patchFiles(patch))) return false;
  // Chromium comes with the sandbox's desktop tools.
  if (!hasDesktop(await setupScript())) return false;
  if (run.userId && !(await harnessUsesPlan(run.harness)) && (await budgetStatus(run.userId)).state === "storm") return false;
  await prisma.run.create({
    data: {
      repo: run.repo, baseBranch: run.baseBranch, harness: run.harness, userId: run.userId, threadId: run.threadId,
      status: "queued", kind: "screenshots", targetRunId: run.id, prompt: "Screenshots of the change",
    },
  });
  return true;
}

/** The script the container runs: the app at each commit, a screenshot of each page. */
export function screenshotScript(): string {
  return String.raw`
set -u
cd /workspace
PAGES=$(printf '%s' "$SHOT_PAGES" | tr ',' ' ')
started=""
start_app() {
  setsid bash -lc "$SHOT_COMMAND" > "/tmp/app-$1.log" 2>&1 < /dev/null &
  started=$!
  for i in $(seq 1 "$SHOT_WAIT"); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then sleep 2; return 0; fi
    if ! kill -0 "$started" 2>/dev/null; then return 1; fi
    sleep 1
  done
  return 1
}
stop_app() {
  [ -n "$started" ] || return 0
  kill -TERM -- "-$started" 2>/dev/null; sleep 2; kill -KILL -- "-$started" 2>/dev/null
  for i in $(seq 1 20); do (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null || break; sleep 0.5; done
  started=""
}
shoot() {
  for page in $PAGES; do
    slug=$(printf '%s' "$page" | sed -e 's/[?#].*$//' -e 's#^/*##' -e 's#/*$##' -e 's/[^A-Za-z0-9_-]\{1,\}/-/g' | cut -c1-40)
    [ -n "$slug" ] || slug=home
    mkdir -p "/shots/shots/$slug"
    timeout 60 "$SHOT_BROWSER" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars \
      --window-size=1280,800 --virtual-time-budget=5000 --screenshot="/shots/shots/$slug/$1.png" "http://localhost:$PORT$page" > /dev/null 2>&1 \
      || echo "[cloudly] couldn't screenshot $page ($1)"
  done
}
for side in after before; do
  if [ "$side" = after ]; then sha=$SHOT_AFTER; else sha=$SHOT_BEFORE; fi
  git checkout -q -f --detach "$sha" || { echo "[cloudly] couldn't check out $sha"; continue; }
  echo "[cloudly] $side ($sha): starting the app"
  if start_app "$side"; then shoot "$side"; else echo "[cloudly] the app didn't start ($side):"; tail -n 40 "/tmp/app-$side.log"; fi
  stop_app
done
`;
}

const PR_START = "<!-- cloudly:screenshots -->";
const PR_END = "<!-- /cloudly:screenshots -->";

/** A pull request description with its Screenshots section put in, or replaced. */
export function withScreenshotSection(body: string, section: string): string {
  const block = `${PR_START}\n${section}\n${PR_END}`;
  const re = new RegExp(`${PR_START}[\\s\\S]*?${PR_END}`);
  return re.test(body) ? body.replace(re, block) : `${body.trimEnd()}\n\n${block}`;
}

export async function processScreenshots(run: Run, workerId: string): Promise<void> {
  const fenced = { id: run.id, workerId, leaseGen: run.leaseGen };
  let ws: Workspace | undefined;
  let out: string | undefined;
  try {
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: run.threadId! } });
    const target = await prisma.run.findFirstOrThrow({ where: { id: run.targetRunId ?? "", threadId: thread.id } });
    const settings = await repoSettings(run.repo);
    if (!target.commitSha) throw new Error("That turn has no commit to screenshot.");
    if (!settings.screenshotCommand) throw new Error("Set the command that starts the app under Settings > Checks > Screenshots.");

    ws = await createWorkspace(await resolveCloneSource(run.repo), { branch: thread.branch, baseBranch: run.baseBranch });
    const parent = await Bun.$`git --git-dir=${ws.mirrorDir} rev-parse --verify --quiet ${`${target.commitSha}^`}`.nothrow().quiet();
    if (parent.exitCode !== 0) throw new Error("The turn's commit has no parent to compare with.");
    const before = parent.text().trim();
    const n = (await prisma.run.findMany({ where: { threadId: thread.id, kind: { notIn: ["rewind", "fork", "import", "screenshots"] } }, orderBy: { createdAt: "asc" }, select: { id: true } })).findIndex((r) => r.id === target.id) + 1;

    out = await mkdtemp(path.join(tmpdir(), "run-shots-"));
    const pages = settings.screenshotPaths.length ? settings.screenshotPaths : ["/"];
    const secrets = await secretsForRepo(run.repo);
    const env = envFlags({
      ...Object.fromEntries(secrets.map((s) => [s.name, s.exposed ? s.value : s.placeholder])),
      SHOT_COMMAND: settings.screenshotCommand,
      SHOT_PAGES: pages.join(","),
      SHOT_AFTER: target.commitSha,
      SHOT_BEFORE: before,
      SHOT_WAIT: process.env.CLOUDLY_SHOT_WAIT ?? "240",
      SHOT_BROWSER: process.env.CLOUDLY_SHOT_BROWSER ?? "chromium",
      PORT: String(settings.screenshotPort),
    });
    await ensureEgress();
    const name = `shots-${run.id}`;
    const proc = Bun.spawn(
      [
        "docker", "run", "--rm", "--name", name,
        ...SANDBOX_LIMITS, ...EGRESS_FLAGS, ...(await sandboxTrustFlags()), "--init",
        ...workspaceMounts(ws), "-w", "/workspace",
        "-v", `${out}:/shots`,
        "-v", `${await threadHome(thread.id)}:/home/node`, "-e", "HOME=/home/node",
        ...env.flags,
        "--user", sandboxUser(),
        process.env.CLOUDLY_SHOT_IMAGE ?? (await sandboxImage()),
        "bash", "-c", screenshotScript(),
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env.env } },
    );
    const timer = setTimeout(() => Bun.spawn(["docker", "kill", name], { stdout: "ignore", stderr: "ignore" }), 15 * 60_000);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    const log = tail(`${stdout}\n${stderr}`.trim(), 4000);

    // Only what changed becomes a new version; the same picture twice doesn't.
    const latest = await latestArtifacts(thread.id);
    const got = await collectArtifacts({ dir: out, threadId: thread.id, started: new Map(latest.map((a) => [a.name, a.sha256])) }, run.id);
    const shots = await prisma.artifact.findMany({
      where: { threadId: thread.id, name: { startsWith: "shots/" } },
      orderBy: { version: "desc" },
      select: { id: true, name: true, version: true, shareToken: true, runId: true },
    });
    // What this run took (an unchanged picture isn't a new version, but it was taken).
    const taken: string[] = [];
    for (const p of pages) if (await Bun.file(path.join(out, "shots", pageSlug(p), "after.png")).exists()) taken.push(p);
    if (!taken.length) throw new Error(`No screenshots: the app didn't start, or the pages didn't load.\n\n${log}`);

    // The pull request's Screenshots section: links that work without signing in to Cloudly.
    const web = process.env.WEB_ORIGIN?.replace(/\/$/, "");
    if (thread.prUrl && web) {
      const link = async (name: string) => {
        const a = shots.find((s) => s.name === name);
        if (!a) return null;
        const token = a.shareToken ?? randomBytes(18).toString("base64url");
        if (!a.shareToken) await prisma.artifact.update({ where: { id: a.id }, data: { shareToken: token } });
        return `${web}/api/shared/${token}/content`;
      };
      const rows: string[] = [];
      for (const p of taken) {
        const slug = pageSlug(p);
        const [b, a] = [await link(`shots/${slug}/before.png`), await link(`shots/${slug}/after.png`)];
        rows.push(`| \`${p}\` | ${b ? `<img src="${b}" width="400">` : "(didn't load)"} | <img src="${a}" width="400"> |`);
      }
      const section = [`### Screenshots (turn ${n})`, "", "| Page | Before | After |", "|---|---|---|", ...rows, "", `<sub>Taken by Cloudly at ${target.commitSha.slice(0, 7)} and the commit before it.</sub>`].join("\n");
      await updatePullRequestSection(thread.prUrl, (body) => withScreenshotSection(body, section)).catch((err) => console.error(`run ${run.id}: couldn't add the screenshots to the pull request:`, err));
    }

    const missing = pages.filter((p) => !taken.includes(p));
    const said = [
      `Screenshots of turn ${n}, before and after: ${taken.map((p) => `\`${p}\``).join(", ")}.`,
      got.saved.length ? "" : "They look the same as last time.",
      missing.length ? `These didn't load: ${missing.map((p) => `\`${p}\``).join(", ")}.` : "",
    ].filter(Boolean).join(" ");
    const r = await prisma.run.updateMany({ where: fenced, data: { status: "succeeded", output: said } });
    if (r.count) {
      await insertEvents(run.id, [
        { seq: 0, ts: Date.now(), kind: "text", data: said },
        { seq: 1, ts: Date.now(), kind: "done", data: { result: said } },
      ]);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.run.updateMany({ where: fenced, data: { status: "failed", error: message } });
  } finally {
    if (ws) await destroyWorkspace(ws);
    if (out) await rm(out, { recursive: true, force: true });
  }
}
