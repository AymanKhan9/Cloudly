import type { GitHubPort, PrStatus } from "../src/github";

/** A stand-in for GitHub that records what Cloudly asked of it. */
export function fakeGitHub(repo: string, over: Partial<GitHubPort> = {}) {
  const calls: string[] = [];
  const pr: PrStatus = { state: "open", merged: false, draft: false, mergeable: true, mergeableState: "clean", headSha: "a".repeat(40), baseRef: "main" };
  const gh: GitHubPort = {
    comment: async (_o, _r, n, body) => void calls.push(`comment #${n}: ${body}`),
    react: async (_o, _r, id, c) => void calls.push(`react ${id} ${c}`),
    pullRequest: async (_o, _r, n) => ({ number: n, url: `https://github.com/${repo}/pull/${n}`, title: "Their PR", headRef: "feature/x", headRepo: repo, baseRef: "main", state: "open" }),
    reviewComments: async () => [{ path: "src/a.ts", line: 3, body: "Use a constant here." }],
    failedChecks: async () => [],
    prStatus: async () => pr,
    commitChecks: async () => ({ pending: [], failed: [], passed: 1 }),
    merge: async (_o, _r, n, sha, method) => {
      calls.push(`merge #${n} ${sha.slice(0, 7)} ${method}`);
      return { merged: true, message: "Pull Request successfully merged" };
    },
    updateBranch: async (_o, _r, n) => void calls.push(`update-branch #${n}`),
    ...over,
  };
  return { gh, calls };
}
