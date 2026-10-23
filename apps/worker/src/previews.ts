import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { prisma, relayKey, secretsForRepo } from "@repo/db";
import { createWorkspace } from "./workspace";
import { resolveCloneSource } from "./github";
import { ensureEgress, EGRESS_FLAGS, SANDBOX_NETWORK, sandboxTrustFlags } from "./egress";
import { SANDBOX_LIMITS, envFlags, runnerMountFlags, sandboxUser } from "./docker";
import { materializeRepoFiles } from "./repo-files";
import { sandboxImage } from "./sandbox-image";

// --- The relay --------------------------------------------------------------------
// Started by the worker like the egress proxy. It joins the sandbox network to
// reach containers, and a network of its own to publish its two ports on the VM:
// the desktop port only on localhost (the web app proxies /relay to it), the
// preview port where PREVIEW_BIND says (Caddy fronts it on HTTPS installs).

const RELAY = "cloudly-relay";
const RELAY_NETWORK = "cloudly-relay-out";
const RELAY_SCRIPT = fileURLToPath(new URL("./relay.ts", import.meta.url));
const DATA_DIR = process.env.CLOUDLY_DATA_DIR ?? path.join(homedir(), ".cloudly");
const RELAY_DIR = path.join(DATA_DIR, "relay");

async function docker(args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, out: (out + err).trim() };
}

export async function ensureRelay(fresh = false): Promise<void> {
  await mkdir(RELAY_DIR, { recursive: true, mode: 0o700 });
  await writeFile(path.join(RELAY_DIR, "relay.key"), await relayKey(), { mode: 0o600 });
  const running = await docker(["inspect", "-f", "{{.State.Running}}", RELAY]);
  if (!fresh && running.out === "true") return;
  await ensureEgress();
  if (!(await docker(["network", "inspect", RELAY_NETWORK])).ok) await docker(["network", "create", RELAY_NETWORK]);
  await docker(["rm", "-f", RELAY]);
  const run = await docker([
    "run", "-d", "--name", RELAY, "--restart", "unless-stopped", "--network", RELAY_NETWORK,
    "-p", `127.0.0.1:${process.env.RELAY_PORT ?? 3140}:3140`,
    "-p", `${process.env.PREVIEW_BIND ?? "127.0.0.1"}:${process.env.PREVIEW_PORT ?? 3141}:3141`,
    "--memory", "128m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", sandboxUser(),
    "-v", `${RELAY_SCRIPT}:/relay.ts:ro`,
    "-v", `${RELAY_DIR}:/relay:ro`,
    "cloud-agents-base", "bun", "/relay.ts",
  ]);
  if (!run.ok) throw new Error(`couldn't start the relay: ${run.out}`);
  const join = await docker(["network", "connect", SANDBOX_NETWORK, RELAY]);
  if (!join.ok) throw new Error(`couldn't attach the relay: ${join.out}`);
}

// --- Previews ---------------------------------------------------------------------
// A preview runs the session's branch with the user's command in a container of
// its own (no model credentials; the same network rules, secrets and kept files
// as a run), until it's stopped or its time runs out.

export const PREVIEW_TTL_MINUTES = Number(process.env.PREVIEW_TTL_MINUTES ?? 60);
const LOG_CHARS = 8000;

export function previewContainer(id: string): string {
  return `preview-${id}`;
}

async function claimPreview(workerId: string) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "Preview" SET status = 'starting', "workerId" = ${workerId}, "updatedAt" = now()
    WHERE id = (
      SELECT id FROM "Preview" WHERE status = 'requested'
      ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id
  `;
  return rows[0] ? prisma.preview.findUnique({ where: { id: rows[0].id }, include: { thread: true } }) : null;
}

export async function startPreview(id: string): Promise<void> {
  const preview = await prisma.preview.findUniqueOrThrow({ where: { id }, include: { thread: true } });
  const { thread } = preview;
  const dirs: string[] = [];
  try {
    await ensureRelay();
    const ws = await createWorkspace(await resolveCloneSource(thread.repo), { branch: thread.branch, baseBranch: thread.baseBranch });
    dirs.push(ws.scratchDir);
    const files = await materializeRepoFiles(thread.repo);
    dirs.push(files.dir);
    const controlDir = await mkdtemp(path.join(tmpdir(), "preview-control-"));
    dirs.push(controlDir);
    const vncPassword = preview.desktop ? randomBytes(6).toString("base64url") : null;
    await writeFile(path.join(controlDir, "config.json"), JSON.stringify({
      command: preview.command,
      port: preview.port,
      desktop: vncPassword ? { password: vncPassword } : undefined,
    }));
    const secrets = await secretsForRepo(thread.repo);
    const env = envFlags(Object.fromEntries(secrets.map((s) => [s.name, s.exposed ? s.value : s.placeholder])));
    const run = Bun.spawn([
      "docker", "run", "-d", "--init", "--shm-size", "256m",
      ...SANDBOX_LIMITS, ...EGRESS_FLAGS, ...(await sandboxTrustFlags()),
      "--name", previewContainer(id),
      "--label", `preview_id=${id}`,
      // Where its scratch folders are, so whichever worker stops it can clean up.
      "--label", `cloudly_dirs=${dirs.join(",")}`,
      "-v", `${ws.runDir}:/workspace`,
      "-v", `${files.dir}:/files:ro`,
      ...runnerMountFlags(process.cwd()),
      "-w", "/repo/packages/runner",
      "-v", `${controlDir}:/control:ro`,
      "-e", "CONTROL_CONFIG_PATH=/control/config.json",
      ...env.flags,
      "--user", sandboxUser(),
      await sandboxImage(),
      "bun", "src/preview.ts",
    ], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env.env } });
    const [err, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
    if (code !== 0) throw new Error(`The preview container didn't start: ${err.trim()}`);
    await prisma.preview.update({
      where: { id },
      data: { status: "running", vncPassword, expiresAt: new Date(Date.now() + PREVIEW_TTL_MINUTES * 60_000), error: null },
    });
  } catch (err) {
    await docker(["rm", "-f", previewContainer(id)]);
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    await prisma.preview.update({ where: { id }, data: { status: "failed", error: err instanceof Error ? err.message : String(err) } });
  }
}

async function containerLogs(id: string): Promise<string | null> {
  const r = await docker(["logs", "--tail", "200", previewContainer(id)]);
  return r.ok ? r.out.slice(-LOG_CHARS) : null;
}

export async function stopPreview(id: string, status: "stopped" | "failed" = "stopped", error?: string): Promise<void> {
  const log = await containerLogs(id);
  const dirs = await docker(["inspect", "-f", '{{index .Config.Labels "cloudly_dirs"}}', previewContainer(id)]);
  await docker(["rm", "-f", previewContainer(id)]);
  if (dirs.ok) {
    for (const dir of dirs.out.split(",").filter((d) => d.startsWith(tmpdir()))) await rm(dir, { recursive: true, force: true });
  }
  await prisma.preview.update({ where: { id }, data: { status, vncPassword: null, ...(log !== null ? { log } : {}), ...(error ? { error } : {}) } });
}

/** Starts requested previews, stops expired or stopped ones, and keeps their logs current. */
export async function syncPreviews(workerId: string): Promise<void> {
  for (let claimed = await claimPreview(workerId); claimed; claimed = await claimPreview(workerId)) {
    await startPreview(claimed.id);
  }
  const live = await prisma.preview.findMany({ where: { status: { in: ["running", "stopping"] } } });
  for (const p of live) {
    if (p.status === "stopping") {
      await stopPreview(p.id);
      continue;
    }
    if (p.expiresAt && p.expiresAt < new Date()) {
      await stopPreview(p.id, "stopped", `Stopped after ${PREVIEW_TTL_MINUTES} minutes.`);
      continue;
    }
    const state = await docker(["inspect", "-f", "{{.State.Running}}", previewContainer(p.id)]);
    if (state.out !== "true") {
      await stopPreview(p.id, "failed", state.ok ? "The command exited. Its last output is below." : "The preview's container is gone.");
      continue;
    }
    const log = await containerLogs(p.id);
    if (log !== null && log !== p.log) await prisma.preview.update({ where: { id: p.id }, data: { log } });
  }
}

export async function runPreviewLoop(workerId: string, signal: AbortSignal, intervalMs = 2000): Promise<void> {
  while (!signal.aborted) {
    await syncPreviews(workerId).catch((err) => console.error("[preview] sync failed:", err));
    await Bun.sleep(intervalMs);
  }
}
