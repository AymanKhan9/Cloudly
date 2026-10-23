import { BASE_TOOLS_LABEL } from "@repo/db";

/**
 * The rules of the sandbox. Without them an agent tried to open PRs itself: it
 * made its own branches, switched back, and the worker found nothing to commit.
 */
export function sandboxRules(tools: string = BASE_TOOLS_LABEL, extras: string[] = []): string {
  return [
    "You're running inside Cloudly, in a sandbox with the repository checked out at /workspace.",
    "- Work on the branch that's already checked out. Don't create or switch branches, commit, push, or open pull requests: when you finish, Cloudly commits your changes and opens or updates this session's pull request.",
    "- One session produces one pull request. If you're asked for several, do the work for one and say the rest need their own sessions.",
    "- There are no GitHub credentials here, so git push, gh and the remote won't work. That's expected.",
    `- Installed: ${tools}. You can't use apt. If you need another toolchain, install it in your home directory, or say it's missing.`,
    "- Run the project's tests when they exist, and say clearly if you couldn't run something.",
    ...extras,
  ].join("\n");
}

export interface RunExtras {
  /** Connected MCP servers' names. */
  mcp?: string[];
  /** Names of the environment variables set from the user's secrets, and whether each holds a placeholder. */
  secrets?: { name: string; exposed: boolean }[];
  /** The repo's kept files are mounted at /files. */
  files?: boolean;
  desktop?: boolean;
}

/** Lines for what this run has beyond the basics: kept files, secrets, MCP servers, a desktop. */
export function runExtras(extras: RunExtras): string[] {
  const lines: string[] = [];
  if (extras.files) {
    lines.push("- /files holds files the user keeps for this repo outside git (data, fixtures, notes). It isn't committed. Anything you leave there is kept for the next session on this repo; put scratch files elsewhere.");
  }
  const hidden = extras.secrets?.filter((s) => !s.exposed).map((s) => s.name) ?? [];
  const shown = extras.secrets?.filter((s) => s.exposed).map((s) => s.name) ?? [];
  if (hidden.length) {
    lines.push(`- These environment variables hold placeholders, not the real values: ${hidden.join(", ")}. Cloudly swaps in the real value when one is sent over HTTPS to the host it's meant for, in a header or the URL, so use them as they are in requests. A placeholder in a request body, or sent anywhere else, stays a placeholder. Don't print them or write them into files.`);
  }
  if (shown.length) lines.push(`- These environment variables are set for this repo: ${shown.join(", ")}. Don't print them or write them into files.`);
  if (extras.mcp?.length) lines.push(`- MCP servers connected by the user: ${extras.mcp.join(", ")}. Use their tools when they fit the task.`);
  if (extras.desktop) {
    lines.push("- A virtual desktop is running (DISPLAY=:99), with a browser. Use the desktop tools (screenshot, click, type, key, scroll, open_url) to see and use web apps you start, and check UI changes visually. The user may be watching it live.");
  }
  return lines;
}

/** A message starting with "/" is a command for the agent itself (/compact, /usage, a repo skill). */
export function isCommand(prompt: string): boolean {
  return /^\/[a-z0-9]/i.test(prompt.trim());
}

/**
 * For agents without a system-prompt hook, the rules go in front of the task.
 * Commands are sent untouched: anything in front of "/compact" turns it into text.
 */
export function withPreamble(task: string, tools: string = BASE_TOOLS_LABEL, extras: string[] = []): string {
  if (isCommand(task)) return task.trim();
  return `${sandboxRules(tools, extras)}\n\nYour task:\n${task}`;
}
