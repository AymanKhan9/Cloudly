import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { prisma, config } from "@repo/db";

export const BASE_IMAGE = "cloud-agents-base";
const LOG_CHARS = 8000;

// Toolchains from the setup script install system-wide, so these are set for
// every image built on top of the base, whether or not they're used.
const DOCKERFILE = `FROM ${BASE_IMAGE}
USER root
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:/usr/local/go/bin:$PATH
COPY setup.sh /tmp/cloudly-setup.sh
RUN bash /tmp/cloudly-setup.sh && rm -f /tmp/cloudly-setup.sh
USER 1000
`;

async function docker(args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, out: out + err };
}

async function row() {
  return prisma.sandboxImage.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}

/** The image runs start from: the last one that built successfully. */
export async function sandboxImage(): Promise<string> {
  const r = await row();
  if (r.image === BASE_IMAGE) return BASE_IMAGE;
  return (await docker(["image", "inspect", r.image])).ok ? r.image : BASE_IMAGE;
}

/** The current setup script, as runs and the preamble see it. */
export async function setupScript(): Promise<string> {
  return ((await config("SANDBOX_SETUP_SCRIPT")) ?? "").trim();
}

let building = false;

/**
 * Builds the sandbox image when the setup script (or the base image under it)
 * has changed. A failed build isn't retried until the script changes or the
 * user asks for a rebuild (status "pending"), so a broken script can't loop.
 */
export async function syncSandboxImage(): Promise<void> {
  if (building) return;
  const script = await setupScript();
  const current = await row();

  if (!script) {
    if (current.image !== BASE_IMAGE || current.status !== "ready" || current.scriptHash !== "") {
      await prisma.sandboxImage.update({
        where: { id: 1 },
        data: { image: BASE_IMAGE, status: "ready", scriptHash: "", log: "No setup script: runs use the base image." },
      });
    }
    return;
  }

  const base = await docker(["image", "inspect", BASE_IMAGE, "--format", "{{.Id}}"]);
  if (!base.ok) return; // the installer builds the base image; nothing to build on yet
  const hash = createHash("sha256").update(base.out.trim()).update("\n").update(script).digest("hex").slice(0, 12);
  const tag = `cloudly-sandbox:${hash}`;

  if (current.scriptHash === hash && current.status === "failed") return;
  if (current.scriptHash === hash && current.status === "ready" && current.image === tag) return;
  if ((await docker(["image", "inspect", tag])).ok) {
    await prisma.sandboxImage.update({ where: { id: 1 }, data: { scriptHash: hash, status: "ready", image: tag } });
    return;
  }

  building = true;
  const dir = await mkdtemp(path.join(tmpdir(), "sandbox-build-"));
  try {
    await prisma.sandboxImage.update({ where: { id: 1 }, data: { scriptHash: hash, status: "building", log: "" } });
    await writeFile(path.join(dir, "Dockerfile"), DOCKERFILE);
    await writeFile(
      path.join(dir, "setup.sh"),
      `set -eux\nexport DEBIAN_FRONTEND=noninteractive\napt-get update -qq\n${script}\nrm -rf /var/lib/apt/lists/*\n`,
    );
    console.log(`[sandbox] building ${tag}`);
    const result = await docker(["build", "--progress=plain", "-t", tag, dir]);
    const log = result.out.slice(-LOG_CHARS);
    if (!result.ok) {
      console.error(`[sandbox] build of ${tag} failed`);
      await prisma.sandboxImage.update({ where: { id: 1 }, data: { status: "failed", log } });
      return;
    }
    const previous = current.image;
    await prisma.sandboxImage.update({ where: { id: 1 }, data: { status: "ready", image: tag, log } });
    console.log(`[sandbox] ${tag} ready`);
    // ponytail: a run still on the previous image keeps it alive (docker refuses
    // to remove an image in use); it's then left behind until the next change.
    if (previous !== BASE_IMAGE && previous !== tag) await docker(["rmi", previous]);
  } finally {
    building = false;
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runSandboxImageLoop(signal: AbortSignal, intervalMs = 10_000): Promise<void> {
  while (!signal.aborted) {
    await syncSandboxImage().catch((err) => console.error("[sandbox] sync failed:", err));
    await Bun.sleep(intervalMs);
  }
}
