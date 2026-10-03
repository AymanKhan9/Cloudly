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
