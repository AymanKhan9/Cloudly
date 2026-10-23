import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHash, randomBytes } from "node:crypto";
import { config, setSetting, EGRESS_DEFAULT_HOSTS, parseHostList, gatewayMcpServers, proxySecrets, refreshMcpTokens } from "@repo/db";

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
/** The same gateway over HTTPS, for clients that insist on it (Codex's ChatGPT backend). */
export const GATEWAY_TLS_URL = `https://${PROXY}:3130`;
/** Credentials the gateway may add. Run containers only ever see placeholders. */
const INJECTED = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "CODEX_AUTH_JSON"] as const;
const PROXY_SCRIPT = fileURLToPath(new URL("./egress-proxy.ts", import.meta.url));
const ALLOW_DIR = path.join(process.env.CLOUDLY_DATA_DIR ?? path.join(homedir(), ".cloudly"), "egress");
const KEYS_DIR = path.join(ALLOW_DIR, "..", "egress-keys");
// Writable by the gateway: a ChatGPT sign-in it refreshed (see syncRefreshedCodexAuth).
const STATE_DIR = path.join(ALLOW_DIR, "..", "egress-state");
// The gateway's private CA. Its key stays here, mounted nowhere; the gateway gets
// only its own certificate, and sandboxes only the public bundle (CA_BUNDLE_DIR).
const CA_DIR = path.join(ALLOW_DIR, "..", "egress-ca-private");
export const CA_BUNDLE_DIR = path.join(ALLOW_DIR, "..", "egress-ca");

/**
 * A certificate for "cloudly-egress" from Cloudly's own CA, made once. Sandboxes
 * trust the CA through a bundle that also holds the system's public roots.
 */
async function ensureGatewayTls(): Promise<void> {
  // v2 adds chatgpt.com to the certificate (see egress-proxy.ts).
  if (await Bun.file(path.join(KEYS_DIR, "gateway-v2")).exists()) return;
  await mkdir(CA_DIR, { recursive: true, mode: 0o700 });
  await mkdir(CA_BUNDLE_DIR, { recursive: true });
  const run = async (args: string[]) => {
    const p = Bun.spawn(["openssl", ...args], { cwd: CA_DIR, stdout: "pipe", stderr: "pipe" });
    if ((await p.exited) !== 0) throw new Error(`openssl ${args[0]} failed: ${await new Response(p.stderr).text()}`);
  };
  await run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "3650",
    "-subj", "/CN=Cloudly sandbox gateway CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  await run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "gateway.key", "-out", "gateway.csr", "-subj", "/CN=cloudly-egress"]);
  await writeFile(path.join(CA_DIR, "gateway.ext"),
    "subjectAltName=DNS:cloudly-egress,DNS:chatgpt.com\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  await run(["x509", "-req", "-in", "gateway.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "gateway.pem", "-days", "3650", "-extfile", "gateway.ext"]);
  const system = await Bun.file("/etc/ssl/certs/ca-certificates.crt").text().catch(() => "");
  await writeFile(path.join(CA_BUNDLE_DIR, "bundle.pem"), (await Bun.file(path.join(CA_DIR, "ca.pem")).text()) + "\n" + system);
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 });
  await writeFile(path.join(KEYS_DIR, "gateway.pem"), await Bun.file(path.join(CA_DIR, "gateway.pem")).text(), { mode: 0o600 });
  await writeFile(path.join(KEYS_DIR, "gateway.key"), await Bun.file(path.join(CA_DIR, "gateway.key")).text(), { mode: 0o600 });
  await writeFile(path.join(KEYS_DIR, "gateway-v2"), "");
}

async function docker(args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, out: (out + err).trim() };
}

export async function allowedHosts(): Promise<string[]> {
  // A secret's hosts are where it's meant to go, so they're reachable too.
  const secretHosts = (await proxySecrets()).flatMap((s) => s.hosts);
  return [...new Set([...EGRESS_DEFAULT_HOSTS, ...parseHostList((await config("SANDBOX_EGRESS_HOSTS")) ?? ""), ...secretHosts])];
}

/** Writes the allowlist the proxy reads on every connection. */
async function writeAllowlist(): Promise<void> {
  await mkdir(ALLOW_DIR, { recursive: true });
  // In place, not via rename: the proxy sees this directory through a bind mount.
  await writeFile(path.join(ALLOW_DIR, "hosts"), (await allowedHosts()).join("\n") + "\n");
}

/**
 * The gateway refreshes a ChatGPT sign-in itself (single-use refresh tokens), so
 * keep its newest copy in Settings before writing the credentials again.
 */
async function syncRefreshedCodexAuth(): Promise<void> {
  const file = Bun.file(path.join(STATE_DIR, "codex-auth.json"));
  if (!(await file.exists())) return;
  try {
    const refreshed = await file.json();
    const saved = JSON.parse((await config("CODEX_AUTH_JSON")) ?? "{}");
    if (String(refreshed.last_refresh ?? "") > String(saved.last_refresh ?? "")) {
      await setSetting("CODEX_AUTH_JSON", JSON.stringify(refreshed));
    }
  } catch (err) {
    console.error("[egress] couldn't keep the refreshed ChatGPT sign-in:", err);
  }
}

/** The real credentials, readable only by the worker's user, which the proxy runs as. */
async function writeCredentials(): Promise<void> {
  await syncRefreshedCodexAuth();
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

/** Connected MCP servers and their tokens, for the gateway's /mcp/<name> routes. */
async function writeMcp(): Promise<void> {
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 });
  await writeFile(path.join(KEYS_DIR, "mcp.json"), JSON.stringify(await gatewayMcpServers()), { mode: 0o600 });
}

/**
 * A certificate from Cloudly's CA for every host a secret may go to (and its
 * subdomains), made when that set changes. The CA key never leaves the worker.
 */
async function interceptCertificate(hosts: string[]): Promise<{ cert: string; key: string }> {
  const sorted = [...new Set(hosts.map((h) => h.toLowerCase()))].sort();
  const id = createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
  const certFile = path.join(CA_DIR, `intercept-${id}.pem`);
  const keyFile = path.join(CA_DIR, `intercept-${id}.key`);
  if (!(await Bun.file(certFile).exists())) {
    const run = async (args: string[]) => {
      const p = Bun.spawn(["openssl", ...args], { cwd: CA_DIR, stdout: "pipe", stderr: "pipe" });
      if ((await p.exited) !== 0) throw new Error(`openssl ${args[0]} failed: ${await new Response(p.stderr).text()}`);
    };
    const sans = sorted.flatMap((h) => [`DNS:${h}`, `DNS:*.${h}`]).join(",");
    await writeFile(path.join(CA_DIR, `intercept-${id}.ext`),
      `subjectAltName=${sans}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    await run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", `intercept-${id}.csr`, "-subj", "/CN=Cloudly secrets"]);
    await run(["x509", "-req", "-in", `intercept-${id}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", certFile, "-days", "825", "-extfile", `intercept-${id}.ext`]);
  }
  return { cert: await Bun.file(certFile).text(), key: await Bun.file(keyFile).text() };
}

/** Secret placeholders, real values and allowed hosts, plus the certificate the proxy needs for those hosts. */
async function writeSecrets(): Promise<void> {
  const secrets = await proxySecrets();
  const conf = secrets.length ? { ...(await interceptCertificate(secrets.flatMap((s) => s.hosts))), secrets } : {};
  await writeFile(path.join(KEYS_DIR, "secrets.json"), JSON.stringify(conf), { mode: 0o600 });
}

// Turns allowed on the open web (research councils), by proxy credential. Kept in
// memory and written whole; the proxy re-reads the file on every connection.
const openTokens = new Set<string>();
/** The live credentials, as the proxy reads them. */
export const OPEN_TOKENS_FILE = path.join(KEYS_DIR, "open-tokens.json");

async function writeOpenTokens(): Promise<void> {
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 });
  await writeFile(OPEN_TOKENS_FILE, JSON.stringify([...openTokens]), { mode: 0o600 });
}

/**
 * A proxy credential that lets one turn reach any public HTTPS site, and the
 * environment that makes its tools use it. Revoke it when the turn ends.
 */
export async function grantOpenWeb(): Promise<{ token: string; env: Record<string, string> }> {
  const token = randomBytes(18).toString("base64url");
  openTokens.add(token);
  await writeOpenTokens();
  const url = `http://council:${token}@${PROXY}:3128`;
  return { token, env: Object.fromEntries(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].map((v) => [v, url])) };
}

export async function revokeOpenWeb(token: string): Promise<void> {
  openTokens.delete(token);
  await writeOpenTokens();
}

/** Rewrites what the gateway reads; it picks the files up on its next request. */
export async function refreshGatewayFiles(): Promise<void> {
  await writeCredentials();
  await writeMcp();
  await writeSecrets();
}

/** Refreshes MCP sign-ins close to expiring, so the gateway always holds a working token. */
export async function runMcpRefreshLoop(signal: AbortSignal, intervalMs = 60_000): Promise<void> {
  while (!signal.aborted) {
    try {
      if ((await refreshMcpTokens()) > 0) await writeMcp();
    } catch (err) {
      console.error("[mcp] refresh failed:", err);
    }
    await Bun.sleep(intervalMs);
  }
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
    "-v", `${STATE_DIR}:/state`,
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
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await ensureNetwork(SANDBOX_NETWORK, true);
  await ensureNetwork(OUT_NETWORK, false);
  await writeAllowlist();
  await writeCredentials();
  await writeOpenTokens();
  await writeMcp();
  await ensureGatewayTls();
  await ensureCaFiles();
  await writeSecrets();
  const running = await docker(["inspect", "-f", "{{.State.Running}}", PROXY]);
  if (fresh || running.out !== "true") await startProxy();
}

/** Cloudly's CA on its own, for tools that add to their roots rather than replace them. */
async function ensureCaFiles(): Promise<void> {
  const caOnly = path.join(CA_BUNDLE_DIR, "ca.pem");
  if (!(await Bun.file(caOnly).exists())) await writeFile(caOnly, await Bun.file(path.join(CA_DIR, "ca.pem")).text());
}

/**
 * When some host's traffic is opened to fill in secrets, the sandbox has to
 * trust Cloudly's CA for it. Node and Bun add the CA to their own roots; for
 * OpenSSL-based tools (curl, git, Python) the bundle replaces the system's, so
 * it's only used when it carries the system's roots too.
 */
export async function sandboxTrustFlags(): Promise<string[]> {
  const conf = await Bun.file(path.join(KEYS_DIR, "secrets.json")).json().catch(() => ({}));
  if (!conf?.secrets?.length) return [];
  const flags = ["-v", `${CA_BUNDLE_DIR}:/cloudly-ca:ro`, "-e", "NODE_EXTRA_CA_CERTS=/cloudly-ca/ca.pem"];
  const bundle = await Bun.file(path.join(CA_BUNDLE_DIR, "bundle.pem")).text().catch(() => "");
  if ((bundle.match(/BEGIN CERTIFICATE/g) ?? []).length > 1) {
    for (const name of ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO", "PIP_CERT"]) {
      flags.push("-e", `${name}=/cloudly-ca/bundle.pem`);
    }
  }
  return flags;
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
