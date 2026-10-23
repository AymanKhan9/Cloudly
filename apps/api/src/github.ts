import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { githubAppCredentials, credentialsFingerprint } from "@repo/db";

let cached: { fingerprint: string; octokit: Octokit } | undefined;

async function client(): Promise<Octokit> {
  const creds = await githubAppCredentials();
  if (!creds) throw new Error("The GitHub App isn't set up yet. Finish setup at /setup.");
  const fingerprint = credentialsFingerprint(creds);
  if (cached?.fingerprint !== fingerprint) {
    cached = { fingerprint, octokit: new Octokit({ authStrategy: createAppAuth, auth: { ...creds } }) };
  }
  return cached.octokit;
}

export interface InstallationRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export async function listInstallationRepos(): Promise<InstallationRepo[]> {
  const gh = await client();
  const repos: InstallationRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await gh.request("GET /installation/repositories", { per_page: 100, page });
    for (const r of res.data.repositories) {
      repos.push({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private });
    }
    if (res.data.repositories.length < 100) break;
  }
  return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/**
 * Opens a pull request, or returns the open one for the same branch (GitHub's
 * own "already exists" reply), so picking an arena's result twice is harmless.
 */
export async function openPullRequest(repo: string, head: string, base: string, title: string, body: string): Promise<string> {
  const gh = await client();
  const [owner, name] = repo.split("/") as [string, string];
  try {
    const res = await gh.request("POST /repos/{owner}/{repo}/pulls", { owner, repo: name, head, base, title, body });
    return res.data.html_url;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 422) throw error;
    const open = await gh.request("GET /repos/{owner}/{repo}/pulls", { owner, repo: name, head: `${owner}:${head}`, base, state: "open" });
    if (!open.data[0]) throw error;
    return open.data[0].html_url;
  }
}
