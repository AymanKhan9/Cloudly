import { BASE_TOOLS_LABEL } from "@repo/db";

/**
 * The rules of the sandbox, put in front of every task. Without them an agent
 * tried to open PRs itself: it made its own branches, switched back, and the
 * worker found nothing to commit.
 */
export function withPreamble(task: string, tools: string = BASE_TOOLS_LABEL): string {
  return [
    "You're running inside Cloudly, in a sandbox with the repository checked out at /workspace.",
    "- Work on the branch that's already checked out. Don't create or switch branches, commit, push, or open pull requests: when you finish, Cloudly commits your changes and opens or updates this session's pull request.",
    "- One session produces one pull request. If you're asked for several, do the work for one and say the rest need their own sessions.",
    "- There are no GitHub credentials here, so git push, gh and the remote won't work. That's expected.",
    `- Installed: ${tools}. You can't use apt. If you need another toolchain, install it in your home directory, or say it's missing.`,
    "- Run the project's tests when they exist, and say clearly if you couldn't run something.",
    "",
    "Your task:",
    task,
  ].join("\n");
}
