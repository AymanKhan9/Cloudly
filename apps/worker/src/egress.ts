import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config, EGRESS_DEFAULT_HOSTS, parseHostList } from "@repo/db";

// Run containers join an internal network: no route out and no outside DNS.
// The proxy container sits on it and on the normal network, and is the only
// way out (egress-proxy.ts). That keeps a prompt-injected agent from sending
// its model key anywhere but the allowed hosts.
export const SANDBOX_NETWORK = "cloudly-sandbox";
const PROXY = "cloudly-egress";
const PROXY_URL = `http://${PROXY}:3128`;
const PROXY_SCRIPT = fileURLToPath(new URL("./egress-proxy.ts", import.meta.url));
const ALLOW_DIR = path.join(process.env.CLOUDLY_DATA_DIR ?? path.join(homedir(), ".cloudly"), "egress");

async function docker(args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, out: (out + err).trim() };
}

export async function allowedHosts(): Promise<string[]> {
  return [...EGRESS_DEFAULT_HOSTS, ...parseHostList((await config("SANDBOX_EGRESS_HOSTS")) ?? "")];
}

/** Writes the allowlist the proxy reads on every connection. */
async function writeAllowlist(): Promise<void> {
  await mkdir(ALLOW_DIR, { recursive: true });
  // In place, not via rename: the proxy sees this directory through a bind mount.
  await writeFile(path.join(ALLOW_DIR, "hosts"), (await allowedHosts()).join("\n") + "\n");
}

async function startProxy(): Promise<void> {
  await docker(["rm", "-f", PROXY]);
  const run = await docker([
    "run", "-d", "--name", PROXY, "--restart", "unless-stopped",
    "--memory", "128m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "-v", `${PROXY_SCRIPT}:/proxy.ts:ro`,
    "-v", `${ALLOW_DIR}:/allow:ro`,
    "cloud-agents-base", "bun", "/proxy.ts",
  ]);
  if (!run.ok) throw new Error(`couldn't start the egress proxy: ${run.out}`);
  const join = await docker(["network", "connect", SANDBOX_NETWORK, PROXY]);
  if (!join.ok) throw new Error(`couldn't attach the egress proxy: ${join.out}`);
}

/**
 * Makes sure the network and proxy exist and the allowlist is current. `fresh`
 * recreates the proxy (on worker start) so an upgraded proxy script takes effect.
 */
export async function ensureEgress(fresh = false): Promise<void> {
  if (!(await docker(["network", "inspect", SANDBOX_NETWORK])).ok) {
    const made = await docker(["network", "create", "--internal", SANDBOX_NETWORK]);
    if (!made.ok && !made.out.includes("already exists")) throw new Error(`couldn't create ${SANDBOX_NETWORK}: ${made.out}`);
  }
  await writeAllowlist();
  const running = await docker(["inspect", "-f", "{{.State.Running}}", PROXY]);
  if (fresh || running.out !== "true") await startProxy();
}

/** docker run flags that put a run container behind the proxy. */
export const EGRESS_FLAGS = [
  "--network", SANDBOX_NETWORK,
  ...["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].flatMap((v) => ["-e", `${v}=${PROXY_URL}`]),
  ...["NO_PROXY", "no_proxy"].flatMap((v) => ["-e", `${v}=localhost,127.0.0.1`]),
  // Node's built-in fetch ignores the variables above unless told to.
  "-e", "NODE_USE_ENV_PROXY=1",
  // Telemetry hosts aren't on the list; don't make Claude retry them.
  "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
];
