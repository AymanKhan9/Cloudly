/**
 * Agents added under Settings > Agents, beyond the three built in (Claude Code,
 * Codex, Gemini CLI). Every one of them speaks the Agent Client Protocol, so the
 * runner drives them all with one adapter. They come from three places, the same
 * way T3 Code offers them: Cloudly's own catalog (known agents with their keys
 * and hosts filled in), the public ACP registry, or a command the user enters.
 *
 * Keys follow the same rule as everything else in Cloudly: the sandbox gets a
 * placeholder, and the egress proxy swaps in the real value only on HTTPS
 * requests to the hosts that key belongs to.
 */

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/** Where the sandbox image installs added agents; each gets `<dir>/<id>/run`. */
export const AGENTS_DIR = "/opt/cloudly/agents";

/** Added agents' harness ids all start with this. */
export const PROVIDER_PREFIX = "acp-";

export function isProviderHarness(harness: string): boolean {
  return harness.startsWith(PROVIDER_PREFIX);
}

/** Agents driven over ACP, whose replies stream as chunks to be joined as-is. */
export function isAcpHarness(harness: string): boolean {
  return harness === "gemini-acp" || isProviderHarness(harness);
}

/** The script the image installs to start an added agent. */
export function launcherPath(id: string): string {
  return `${AGENTS_DIR}/${id}/run`;
}

export type Arch = "x86_64" | "aarch64";

export interface BinaryBuild {
  /** A .tar.gz, .tgz, .zip, or a bare executable. */
  url: string;
  sha256?: string;
  /** The executable, relative to where the archive is unpacked. */
  cmd: string;
}

export type AgentInstall =
  /** npm packages installed into the agent's own dir; the first package's bin is run. */
  | { kind: "npm"; packages: string[] }
  /** A release archive per CPU, as the ACP registry lists them. */
  | { kind: "binary"; builds: Partial<Record<Arch, BinaryBuild>> }
  /** A Python package, run with uvx. */
  | { kind: "uvx"; package: string }
  /** A root shell script run while the image builds, then `cmd` (absolute or on PATH). */
  | { kind: "script"; script: string; cmd: string };

export interface AgentLaunch {
  install: AgentInstall;
  args: string[];
  /** Plain settings, never secrets. */
  env?: Record<string, string>;
  /** Sent with ACP `authenticate` before a session starts, when the agent offers it. */
  authMethodId?: string;
  /** Files written under the sandbox HOME before the agent starts (path → contents). */
  homeFiles?: Record<string, string>;
  /** Give it ordinary pipes: some agents hang on the socket stdio Node and Bun spawn with. */
  pipes?: boolean;
}

/** A key an agent reads from its environment. */
export interface ProviderCredential {
  env: string;
  label: string;
  /** Where the key may be sent; the proxy fills it in only for these hosts and their subdomains. */
  hosts: string[];
  optional?: boolean;
  /** Use this Settings key (e.g. ANTHROPIC_API_KEY) when the agent has none of its own. */
  reuse?: string;
}

export interface ProviderSpec {
  launch: AgentLaunch;
  credentials: ProviderCredential[];
  /** Hosts the agent needs beyond its keys' (sign-in, model lists, updates). */
  hosts: string[];
}

export interface CatalogEntry {
  /** The harness id it gets once added. */
  id: string;
  name: string;
  blurb: string;
  /** Its entry in the ACP registry, which says how to install it. */
  registryId?: string;
  /** How to install and start it, when it isn't in the registry or needs more than the registry says. */
  install?: AgentInstall;
  args?: string[];
  env?: Record<string, string>;
  authMethodId?: string;
  homeFiles?: Record<string, string>;
  pipes?: boolean;
  /** Its mark in the web app's public/logos/agents, when not "<id without acp->.svg" (a colour mark ends in -color.svg). */
  iconFile?: string;
  /**
   * What it can do beyond plain ACP, checked against its source: resume its own
   * session across turns (session/load), and report what its turns cost
   * ("usage": ACP usage_update with a cost; "pi-session": Pi's session file).
   */
  features?: { resume?: boolean; cost?: "usage" | "pi-session" };
  credentials: ProviderCredential[];
  hosts: string[];
  /** Shown in place of "Add" when Cloudly can't run it safely. */
  unavailable?: string;
  /** Something to know before adding it (download size, which keys work). */
  note?: string;
}

const ANTHROPIC: ProviderCredential = { env: "ANTHROPIC_API_KEY", label: "Anthropic API key", hosts: ["api.anthropic.com"], optional: true, reuse: "ANTHROPIC_API_KEY" };
const OPENAI: ProviderCredential = { env: "OPENAI_API_KEY", label: "OpenAI API key", hosts: ["api.openai.com"], optional: true, reuse: "OPENAI_API_KEY" };
const OPENROUTER: ProviderCredential = { env: "OPENROUTER_API_KEY", label: "OpenRouter API key", hosts: ["openrouter.ai"], optional: true };

/**
 * The agents T3 Code offers by name. Claude, Codex and Gemini are built in;
 * the rest are added here, each with the keys it reads and where they go.
 */
export const PROVIDER_CATALOG: CatalogEntry[] = [
  {
    id: "acp-cursor",
    name: "Cursor",
    blurb: "Cursor's agent CLI, with Cursor's models.",
    registryId: "cursor",
    credentials: [{ env: "CURSOR_API_KEY", label: "Cursor API key", hosts: ["cursor.sh"] }],
    hosts: ["cursor.sh", "cursor.com"],
    note: "Uses a Cursor API key (cursor.com > Settings > API keys). Cursor trades it for a short-lived session token, which the agent holds while it runs.",
  },
  {
    id: "acp-grok",
    name: "Grok",
    blurb: "xAI's Grok Build agent.",
    registryId: "grok-build",
    authMethodId: "xai.api_key",
    credentials: [{ env: "XAI_API_KEY", label: "xAI API key", hosts: ["x.ai"] }],
    hosts: ["x.ai", "grok.com"],
  },
  {
    id: "acp-opencode",
    name: "OpenCode",
    blurb: "The open-source coding agent. Its free models need no key.",
    registryId: "opencode",
    // opencode acp (1.19): loadSession, and usage_update with the session's cost in USD.
    features: { resume: true, cost: "usage" },
    credentials: [ANTHROPIC, OPENAI, OPENROUTER],
    hosts: ["opencode.ai", "models.dev"],
    note: "Runs OpenCode's free hosted models with no key. Add a key to use that vendor's models; the Anthropic and OpenAI keys from Settings are used when you leave them empty.",
  },
  {
    id: "acp-antigravity",
    name: "Antigravity",
    blurb: "Google's Antigravity agent, on a Gemini API key.",
    registryId: "antigravity-acp",
    // Google's colour mark (via LobeHub's icon set, MIT), not the registry's one-colour one.
    iconFile: "antigravity-color.svg",
    // The server is a Python archive: unbuffered, or its replies sit in a pipe buffer
    // and the turn hangs (tried live). It runs the harness the archive ships next to it.
    env: {
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      PYTHONUNBUFFERED: "1",
      ANTIGRAVITY_HARNESS_PATH: `${AGENTS_DIR}/acp-antigravity/localharness_external`,
    },
    authMethodId: "gemini-api-key",
    // Tried live: it never answers over the socket stdio Bun gives it, only over pipes.
    pipes: true,
    homeFiles: { ".gemini/antigravity-acp/settings.json": JSON.stringify({ auth: { type: "gemini-api-key" } }) + "\n" },
    credentials: [{ env: "GEMINI_API_KEY", label: "Gemini API key", hosts: ["generativelanguage.googleapis.com"], reuse: "GEMINI_API_KEY" }],
    hosts: ["googleapis.com"],
    note: "A large download: it adds about 1.3 GB to the sandbox image. Google account sign-in isn't available; it uses a Gemini API key, the one from Settings unless you enter another.",
  },
  {
    id: "acp-pi",
    name: "Pi",
    blurb: "A minimal coding agent that works with many model vendors.",
    registryId: "pi-acp",
    install: { kind: "npm", packages: ["pi-acp", "@earendil-works/pi-coding-agent"] },
    // Without it every reply starts with Pi's version, skills and context banner.
    homeFiles: { ".pi/agent/settings.json": JSON.stringify({ quietStartup: true }) + "\n" },
    // pi-acp: loadSession via ~/.pi/pi-acp/session-map.json; each reply's cost is in Pi's session file.
    features: { resume: true, cost: "pi-session" },
    credentials: [ANTHROPIC, OPENAI, { env: "GEMINI_API_KEY", label: "Gemini API key", hosts: ["generativelanguage.googleapis.com"], optional: true, reuse: "GEMINI_API_KEY" }, OPENROUTER],
    // Its update check.
    hosts: ["pi.dev"],
    note: "Needs at least one model key. The Anthropic, OpenAI and Gemini keys from Settings are used when you leave them empty.",
  },
  {
    id: "acp-fx",
    name: "fx",
    blurb: "Vercel's Unix-like coding agent, through the AI Gateway.",
    install: { kind: "script", script: "curl -fsSL https://fx.sh/setup.sh | FX_INSTALL_DIR=/usr/local/bin bash", cmd: "/usr/local/bin/fx" },
    args: ["acp"],
    credentials: [{ env: "AI_GATEWAY_API_KEY", label: "Vercel AI Gateway API key", hosts: ["ai-gateway.vercel.sh"] }],
    hosts: ["fx.sh", "vercel.sh"],
    // Tried live: fx 0.0.16 opened its gateway connection directly, ignoring HTTPS_PROXY.
    unavailable: "fx connects to the AI Gateway directly and ignores proxy settings, and a Cloudly sandbox's only way out is its egress proxy. It can be added once fx honors HTTPS_PROXY.",
  },
  {
    id: "acp-muse",
    name: "Muse Code",
    blurb: "Meta's coding agent.",
    credentials: [],
    hosts: [],
    unavailable: "Muse Code signs in with a Meta account (muse login) and has no API key, so its sign-in would have to live inside the sandbox. Cloudly keeps every credential out of the sandbox, so it can't run Muse Code yet.",
  },
];

/** The built-in agents, shown in the same picker so the list matches T3 Code's. */
export const BUILTIN_AGENTS = [
  { id: "native-codex", name: "Codex", blurb: "OpenAI's Codex, on an API key or your ChatGPT plan." },
  { id: "native-claude", name: "Claude Code", blurb: "Anthropic's coding agent, on an API key or your Claude plan." },
  { id: "gemini-acp", name: "Gemini CLI", blurb: "Google's Gemini CLI, on a Gemini API key." },
] as const;

export function catalogEntry(id: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((e) => e.id === id);
}

/** A catalog agent's mark, served by the web app; null for one Cloudly can't run. */
export function catalogIconPath(id: string): string | null {
  const entry = catalogEntry(id);
  if (!entry || entry.unavailable) return null;
  return `/logos/agents/${entry.iconFile ?? `${id.replace(PROVIDER_PREFIX, "")}.svg`}`;
}

/** What an added agent can do beyond plain ACP; nothing for one added by command. */
export function agentFeatures(id: string): NonNullable<CatalogEntry["features"]> {
  return catalogEntry(id)?.features ?? {};
}

/** A name for an added agent where only its id is at hand (councils, the shared context). */
export function providerDisplayName(id: string): string {
  return catalogEntry(id)?.name ?? id.replace(PROVIDER_PREFIX, "");
}

// --- The ACP registry ---------------------------------------------------------------

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  website?: string;
  repository?: string;
  icon?: string;
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> };
    uvx?: { package: string; args?: string[]; env?: Record<string, string> };
    binary?: Record<string, { archive: string; cmd: string; args?: string[]; sha256?: string; env?: Record<string, string> }>;
  };
}

/** The registry's names for the Linux builds a sandbox can run. */
const REGISTRY_ARCH: Record<Arch, string> = { x86_64: "linux-x86_64", aarch64: "linux-aarch64" };

/** Whether Cloudly can install a registry agent in its Linux sandbox. */
export function registryInstallable(agent: RegistryAgent): boolean {
  const d = agent.distribution;
  return Boolean(d.npx || d.uvx || (d.binary && Object.values(REGISTRY_ARCH).some((a) => d.binary![a])));
}

/**
 * How to install and start a registry agent. npm and Python packages run the
 * same everywhere; a binary needs a Linux build for the sandbox's CPU.
 */
export function launchFromRegistry(agent: RegistryAgent): AgentLaunch | null {
  const d = agent.distribution;
  if (d.npx) return { install: { kind: "npm", packages: [d.npx.package] }, args: d.npx.args ?? [], env: d.npx.env };
  if (d.binary) {
    const builds: Partial<Record<Arch, BinaryBuild>> = {};
    let args: string[] = [];
    let env: Record<string, string> | undefined;
    for (const [arch, name] of Object.entries(REGISTRY_ARCH) as [Arch, string][]) {
      const b = d.binary[name];
      if (!b) continue;
      builds[arch] = { url: b.archive, sha256: b.sha256, cmd: b.cmd };
      args = b.args ?? [];
      env = b.env;
    }
    if (Object.keys(builds).length) return { install: { kind: "binary", builds }, args, env };
  }
  if (d.uvx) return { install: { kind: "uvx", package: d.uvx.package }, args: d.uvx.args ?? [], env: d.uvx.env };
  return null;
}

/** A catalog entry's install and launch, from the registry where it's listed there. */
export function catalogLaunch(entry: CatalogEntry, registry: RegistryAgent[]): AgentLaunch | null {
  const listed = entry.registryId ? registry.find((a) => a.id === entry.registryId) : undefined;
  const base = listed ? launchFromRegistry(listed) : null;
  // Pi's adapter runs `pi` itself, so it installs both; the registry only names the adapter.
  if (entry.install?.kind === "npm" && base?.install.kind === "npm") {
    const pinned = base.install.packages[0]!;
    entry = { ...entry, install: { kind: "npm", packages: [pinned, ...entry.install.packages.slice(1)] } };
  }
  const install = entry.install ?? base?.install;
  if (!install) return null;
  return {
    install,
    args: entry.args ?? base?.args ?? [],
    env: { ...base?.env, ...entry.env },
    authMethodId: entry.authMethodId,
    homeFiles: entry.homeFiles,
    pipes: entry.pipes,
  };
}

// --- Installing into the sandbox image -----------------------------------------------

/** Single quotes for sh, safe for any string. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

const SAFE_ID = /^acp-[a-z0-9][a-z0-9-]{0,62}$/;

export function validProviderId(id: string): boolean {
  return SAFE_ID.test(id);
}

/** A harness id from a name: "acp-" plus lowercase letters, digits and dashes. */
export function providerIdFrom(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${PROVIDER_PREFIX}${slug || "agent"}`;
}

/**
 * The shell lines that install an agent, and what `run` executes: `target` is a
 * double-quoted expression the build expands ($BIN, $CMD), `lead` are arguments
 * that come before the agent's own.
 */
function installSteps(id: string, install: AgentInstall): { steps: string[]; target: string; lead: string[] } {
  const dir = `${AGENTS_DIR}/${id}`;
  switch (install.kind) {
    case "npm": {
      const [main] = install.packages;
      // npx's rule for which bin to run: the one named after the package, else the only one.
      const findBin = `const p=require(${JSON.stringify(`${dir}/node_modules/${packageName(main!)}/package.json`)});` +
        `const b=typeof p.bin==="string"?{[p.name.split("/").pop()]:p.bin}:(p.bin||{});` +
        `const n=b[p.name.split("/").pop()]?p.name.split("/").pop():Object.keys(b)[0];` +
        `if(!n){console.error("no executable in "+p.name);process.exit(1)}console.log(n)`;
      return {
        steps: [
          `npm install --prefix ${shellQuote(dir)} --no-audit --no-fund --omit=dev ${install.packages.map(shellQuote).join(" ")}`,
          `BIN="$(node -e ${shellQuote(findBin)})"`,
        ],
        target: `"${dir}/node_modules/.bin/$BIN"`,
        lead: [],
      };
    }
    case "binary": {
      const cases = (Object.entries(install.builds) as [Arch, BinaryBuild][]).map(([arch, b]) =>
        `  ${arch}) URL=${shellQuote(b.url)}; SHA=${shellQuote(b.sha256 ?? "")}; CMD=${shellQuote(b.cmd.replace(/^\.\//, ""))} ;;`,
      );
      return {
        steps: [
          `case "$(uname -m)" in`,
          ...cases,
          `  *) echo "no Linux build of ${id} for $(uname -m)" >&2; exit 1 ;;`,
          `esac`,
          `curl -fsSL "$URL" -o /tmp/agent-download`,
          `if [ -n "$SHA" ]; then echo "$SHA  /tmp/agent-download" | sha256sum -c -; fi`,
          `case "$URL" in`,
          `  *.zip) unzip -q /tmp/agent-download -d ${shellQuote(dir)} ;;`,
          `  *.tar.gz|*.tgz) tar -xzf /tmp/agent-download -C ${shellQuote(dir)} ;;`,
          `  *.tar.xz) tar -xJf /tmp/agent-download -C ${shellQuote(dir)} ;;`,
          `  *) mv /tmp/agent-download ${shellQuote(dir)}/"$CMD" ;;`,
          `esac`,
          `rm -f /tmp/agent-download`,
          `chmod -R a+rX ${shellQuote(dir)}`,
          `chmod a+x ${shellQuote(dir)}/"$CMD"`,
        ],
        target: `"${dir}/$CMD"`,
        lead: [],
      };
    }
    case "uvx":
      return {
        steps: [
          `command -v uvx >/dev/null || curl -fsSL https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh`,
        ],
        target: shellQuote("uvx"),
        lead: [install.package],
      };
    case "script":
      return { steps: [install.script], target: shellQuote(install.cmd), lead: [] };
  }
}

/** "@scope/name@1.2.3" → "@scope/name". */
function packageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/**
 * The part of the image build that installs an added agent: its files under
 * /opt/cloudly/agents/<id>, and a `run` script that starts it with its args. A
 * failure leaves that agent out (its turns then say so) without failing the
 * rest of the image.
 */
/** Where a trial installs a new version, inside the sandbox, away from the one in the image. */
export const TRIAL_AGENTS_DIR = "/tmp/cloudly-trial";

/** Updates that can be tried inside a sandbox before they're installed (they install without root). */
export const trialable = (launch: AgentLaunch) => launch.install.kind === "npm" || launch.install.kind === "binary";

/** The install block for a trial: the same steps, under TRIAL_AGENTS_DIR; and where its `run` ends up. */
export function trialInstall(id: string, launch: AgentLaunch): { block: string; run: string } {
  const block = providerInstallBlock(id, launch).split(`${AGENTS_DIR}/${id}`).join(`${TRIAL_AGENTS_DIR}/${id}`);
  return { block, run: `${TRIAL_AGENTS_DIR}/${id}/run` };
}

export function providerInstallBlock(id: string, launch: AgentLaunch): string {
  if (!validProviderId(id)) throw new Error(`invalid agent id: ${id}`);
  const dir = `${AGENTS_DIR}/${id}`;
  const { steps, target, lead } = installSteps(id, launch.install);
  const run = shellQuote(`${dir}/run`);
  // printf writes each value as data, so nothing in an argument is expanded,
  // now or when the agent starts: the script gets every one single-quoted.
  const lines = [
    `printf '#!/bin/sh\\nPATH=%s:"$PATH"\\n' ${shellQuote(`${dir}/node_modules/.bin`)} > ${run}`,
    `printf 'exec "%s"' ${target} >> ${run}`,
    ...[...lead, ...launch.args].map((a) => `printf ' %s' ${shellQuote(shellQuote(a))} >> ${run}`),
    `printf ' "$@"\\n' >> ${run}`,
    `chmod 755 ${run}`,
  ];
  // Not `if ! ( … )`: a shell ignores set -e inside a subshell whose status it's testing.
  return [
    `# cloudly-agent:${id}`,
    `set +e`,
    `(`,
    `  set -eux`,
    `  rm -rf ${shellQuote(dir)} && mkdir -p ${shellQuote(dir)}`,
    ...[...steps, ...lines].map((l) => `  ${l}`),
    `)`,
    `CLOUDLY_RC=$?`,
    `set -e`,
    `if [ "$CLOUDLY_RC" -ne 0 ]; then`,
    `  rm -rf ${shellQuote(dir)}`,
    `  echo "cloudly: ${id} failed to install; the rest of the image is unaffected" >&2`,
    `fi`,
    `# end cloudly-agent:${id}`,
  ].join("\n");
}
