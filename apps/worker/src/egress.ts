import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config, EGRESS_DEFAULT_HOSTS, parseHostList } from "@repo/db";

// Run containers join an internal network: no route out and no outside DNS.
// The proxy container sits on it and on the normal network, and is the only
// way out (egress-proxy.ts). That keeps a prompt-injected agent from sending
// its model key anywhere but the allowed hosts.
export const SANDBOX_NETWORK = "cloudly-sandbox";
// The proxy's own way out. Not Docker's default network: other containers on the
// VM could reach the credential gateway there and spend the user's credits.
const OUT_NETWORK = "cloudly-egress-out";
const PROXY = "cloudly-egress";
const PROXY_URL = `http://${PROXY}:3128`;
/** Where run containers send model API calls; the gateway adds the real credential. */
export const GATEWAY_URL = `http://${PROXY}:3129`;
/** Credentials the gateway may add. Run containers only ever see placeholders. */
const INJECTED = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY"] as const;
const PROXY_SCRIPT = fileURLToPath(new URL("./egress-proxy.ts", import.meta.url));
const ALLOW_DIR = path.join(process.env.CLOUDLY_DATA_DIR ?? path.join(homedir(), ".cloudly"), "egress");
const KEYS_DIR = path.join(ALLOW_DIR, "..", "egress-keys");

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

/** The real credentials, readable only by the worker's user, which the proxy runs as. */
async function writeCredentials(): Promise<void> {
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 });
  await chmod(KEYS_DIR, 0o700);
  const creds: Record<string, string> = {};
  for (const name of INJECTED) {
    const value = await config(name);
    if (value) creds[name] = value;
  }
  // In place, like the allowlist: the proxy reads it through a bind mount.
  await writeFile(path.join(KEYS_DIR, "credentials.json"), JSON.stringify(creds), { mode: 0o600 });
}

async function ensureNetwork(name: string, internal: boolean): Promise<void> {
  if ((await docker(["network", "inspect", name])).ok) return;
  const made = await docker(["network", "create", ...(internal ? ["--internal"] : []), name]);
  if (!made.ok && !made.out.includes("already exists")) throw new Error(`couldn't create ${name}: ${made.out}`);
}

async function startProxy(): Promise<void> {
  await docker(["rm", "-f", PROXY]);
  const run = await docker([
    "run", "-d", "--name", PROXY, "--restart", "unless-stopped", "--network", OUT_NETWORK,
    "--memory", "128m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "-v", `${PROXY_SCRIPT}:/proxy.ts:ro`,
    "-v", `${ALLOW_DIR}:/allow:ro`,
    "-v", `${KEYS_DIR}:/keys:ro`,
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
  await ensureNetwork(SANDBOX_NETWORK, true);
  await ensureNetwork(OUT_NETWORK, false);
  await writeAllowlist();
  await writeCredentials();
  const running = await docker(["inspect", "-f", "{{.State.Running}}", PROXY]);
  if (fresh || running.out !== "true") await startProxy();
}

/** docker run flags that put a run container behind the proxy. */
export const EGRESS_FLAGS = [
  "--network", SANDBOX_NETWORK,
  ...["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].flatMap((v) => ["-e", `${v}=${PROXY_URL}`]),
  // The gateway is plain HTTP inside the sandbox network: talk to it directly.
  ...["NO_PROXY", "no_proxy"].flatMap((v) => ["-e", `${v}=localhost,127.0.0.1,${PROXY}`]),
  // Node's built-in fetch ignores the variables above unless told to.
  "-e", "NODE_USE_ENV_PROXY=1",
  // Telemetry hosts aren't on the list; don't make Claude retry them.
  "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
];
