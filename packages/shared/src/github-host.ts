/**
 * Where GitHub is. Always github.com in use; the two variables point Cloudly at
 * a stand-in GitHub for local end-to-end testing (see scripts/local-test).
 */

/** The REST API's base URL, when it isn't api.github.com. */
export function githubApiUrl(): string | undefined {
  return process.env.CLOUDLY_GITHUB_API_URL || undefined;
}

/**
 * The URL a repository is cloned from and pushed to. CLOUDLY_GITHUB_GIT_URL is
 * a directory of bare repos (owner/repo.git) for local testing.
 */
export function githubCloneUrl(owner: string, repo: string, token: string): string {
  const local = process.env.CLOUDLY_GITHUB_GIT_URL;
  if (local) return `${local.replace(/\/$/, "")}/${owner}/${repo}.git`;
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}
