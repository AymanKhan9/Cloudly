import { ARTIFACTS_RULE } from "@repo/shared/artifacts";
import { BASE_TOOLS_LABEL } from "@repo/db";

/**
 * The rules of the sandbox. Without them an agent tried to open PRs itself: it
 * made its own branches, switched back, and the worker found nothing to commit.
 */
/** The first line of the rules for a session without a project. */
export const NO_PROJECT_RULE = "You're running inside Cloudly, in a sandbox. This session has no project: /workspace is a folder of its own, kept from turn to turn, with no repository, branch or pull request behind it. Don't commit or push; Cloudly keeps what you leave there.";

export function sandboxRules(tools: string = BASE_TOOLS_LABEL, extras: string[] = []): string {
  const noProject = extras[0] === NO_PROJECT_RULE;
  return [
    ...(noProject
      ? [NO_PROJECT_RULE]
      : [
          "You're running inside Cloudly, in a sandbox with the repository checked out at /workspace.",
          "- Work on the branch that's already checked out. Don't create or switch branches, commit, push, or open pull requests: when you finish, Cloudly commits your changes and opens or updates this session's pull request.",
          "- One session produces one pull request. If you're asked for several, do the work for one and say the rest need their own sessions.",
        ]),
    "- There are no GitHub credentials here, so git push, gh and the remote won't work. That's expected.",
    `- Installed: ${tools}. You can't use apt. If you need another toolchain, install it in your home directory, or say it's missing.`,
    "- Run the project's tests when they exist, and say clearly if you couldn't run something.",
    ...(noProject ? extras.slice(1) : extras),
  ].join("\n");
}

export interface RunExtras {
  /** /artifacts is mounted: files there are shown to the user. */
  artifacts?: boolean;
  /** Connected MCP servers' names. */
  mcp?: string[];
  /** Names of the environment variables set from the user's secrets, and whether each holds a placeholder. */
  secrets?: { name: string; exposed: boolean }[];
  /** The repo's kept files are mounted at /files. */
  files?: boolean;
  desktop?: boolean;
  /** The repo's shared context, as Markdown, when the repo has it on. */
  context?: string;
  /** The user's other sessions this one may read and message. */
  sessions?: { count: number; scope: string; canSend: boolean };
  /** The ask_user tool is there (a session's turn). */
  ask?: boolean;
}

/** Lines for what this run has beyond the basics: kept files, secrets, MCP servers, a desktop. */
export function runExtras(extras: RunExtras): string[] {
  const lines: string[] = [];
  if (extras.artifacts) lines.push(ARTIFACTS_RULE);
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
  if (extras.ask) {
    lines.push("- Nobody watches a turn as it runs, and you have permission to run commands, edit files and install packages here. If you can't go on without the user (a decision that's theirs, or information you can't find), call ask_user with one clear question, then finish the turn with where things stand. Their answer comes as the next message. If you need a secret (an API key, a token, a password), call request_secret instead: never ask for one in chat, and never ask the user to paste one.");
  }
  if (extras.sessions) {
    const where = extras.sessions.scope === "all" ? "the user's other Cloudly sessions" : "the user's other Cloudly sessions on this repo";
    lines.push(
      `- Your sessions tools reach ${where} (${extras.sessions.count} now): list_sessions, and read_session for what each was asked and answered and which branch holds its work. If the user pastes a session's link, id or a copied reference, pass it to these tools as it is.` +
        (extras.sessions.canSend
          ? " send_to_session hands one a message, which runs there as its next turn after this one ends; ask for a reply and its answer comes back here as a new turn. Use them when the user refers to another session, or when work there matters to this task."
          : " This turn can't send messages: it's already deep in a chain of messages between sessions."),
    );
  }
  if (extras.context) {
    lines.push(
      "- This repo has shared context: notes and recent work from the other agents and editors working on it (other Cloudly sessions, and tools like Cursor or Claude Code on the user's machine). Follow its notes. Your context tools read it again (repo_context) and add to it (add_note): record conventions, decisions and their reasons, and gotchas worth knowing, so whoever works on this repo next has them. Cloudly records what this turn did on its own.",
      "",
      extras.context.trim(),
    );
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
