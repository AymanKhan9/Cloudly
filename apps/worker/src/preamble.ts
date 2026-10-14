import { BASE_TOOLS_LABEL } from "@repo/db";

/**
 * The rules of the sandbox. Without them an agent tried to open PRs itself: it
 * made its own branches, switched back, and the worker found nothing to commit.
 */
export function sandboxRules(tools: string = BASE_TOOLS_LABEL): string {
  return [
    "You're running inside Cloudly, in a sandbox with the repository checked out at /workspace.",
    "- Work on the branch that's already checked out. Don't create or switch branches, commit, push, or open pull requests: when you finish, Cloudly commits your changes and opens or updates this session's pull request.",
    "- One session produces one pull request. If you're asked for several, do the work for one and say the rest need their own sessions.",
    "- There are no GitHub credentials here, so git push, gh and the remote won't work. That's expected.",
    `- Installed: ${tools}. You can't use apt. If you need another toolchain, install it in your home directory, or say it's missing.`,
    "- Run the project's tests when they exist, and say clearly if you couldn't run something.",
  ].join("\n");
}

/** A message starting with "/" is a command for the agent itself (/compact, /usage, a repo skill). */
export function isCommand(prompt: string): boolean {
  return /^\/[a-z0-9]/i.test(prompt.trim());
}

/**
 * For agents without a system-prompt hook, the rules go in front of the task.
 * Commands are sent untouched: anything in front of "/compact" turns it into text.
 */
export function withPreamble(task: string, tools: string = BASE_TOOLS_LABEL): string {
  if (isCommand(task)) return task.trim();
  return `${sandboxRules(tools)}\n\nYour task:\n${task}`;
}
