/** What every sandbox has before any setup script. */
export const BASE_TOOLS_LABEL = "Node 22, Bun, Python 3, git, C build tools (gcc, make)";

export interface SandboxPreset {
  id: string;
  label: string;
  /** How the agent is told about it in the preamble. */
  tool: string;
  /** Runs as root while the image builds, after `apt-get update`. */
  snippet: string;
  /** Shown next to the checkbox. */
  note?: string;
}

// Each preset sits in the script between marker comments, so the checkboxes and
// the editable script are one thing: the Settings page adds a preset's block when
// its box is ticked and removes it (marker to marker) when unticked.
export const SANDBOX_PRESETS: SandboxPreset[] = [
  {
    id: "pip",
    label: "Python pip and venv",
    tool: "pip and venv",
    snippet: "apt-get install -y --no-install-recommends python3-pip python3-venv",
  },
  {
    id: "rust",
    label: "Rust",
    tool: "Rust (rustc, cargo)",
    snippet: [
      "curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path",
      'chmod -R a+rwX "$RUSTUP_HOME" "$CARGO_HOME"',
    ].join("\n"),
    note: "Compiling Rust needs memory: on a 1 GB VM, builds of larger crates can run out of it.",
  },
  {
    id: "go",
    label: "Go",
    tool: "Go",
    snippet: [
      'GO_VERSION=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -1)',
      'curl -fsSL "https://go.dev/dl/${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz" | tar -C /usr/local -xz',
    ].join("\n"),
  },
  {
    id: "java",
    label: "Java (OpenJDK 17)",
    tool: "Java 17 (OpenJDK)",
    snippet: "apt-get install -y --no-install-recommends default-jdk-headless",
  },
  {
    id: "ruby",
    label: "Ruby",
    tool: "Ruby",
    snippet: "apt-get install -y --no-install-recommends ruby-full",
  },
];

const presetStart = (id: string) => `# cloudly:${id}`;
const presetEnd = (id: string) => `# end cloudly:${id}`;

export function presetBlock(p: SandboxPreset): string {
  return `${presetStart(p.id)}\n${p.snippet}\n${presetEnd(p.id)}`;
}

export function hasPreset(script: string, id: string): boolean {
  return script.includes(presetStart(id));
}

/** The "Installed:" line of the agent's preamble. */
export function sandboxToolsLabel(script: string): string {
  const picked = SANDBOX_PRESETS.filter((p) => hasPreset(script, p.id)).map((p) => p.tool);
  const custom = script
    .split("\n")
    .some((line) => line.trim() && !line.trim().startsWith("#") && !SANDBOX_PRESETS.some((p) => p.snippet.includes(line.trim())));
  return [BASE_TOOLS_LABEL, ...picked].join(", ") + (custom ? ", plus whatever the instance's custom setup script installs" : "");
}
