import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";

let octokit: Octokit | undefined;

async function client(): Promise<Octokit> {
  if (!octokit) {
    const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID } = process.env;
    if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY_PATH || !GITHUB_APP_INSTALLATION_ID) {
      throw new Error("GitHub App is not configured (GITHUB_APP_ID / _PRIVATE_KEY_PATH / _INSTALLATION_ID)");
    }
    octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: GITHUB_APP_ID,
        privateKey: await Bun.file(GITHUB_APP_PRIVATE_KEY_PATH).text(),
        installationId: GITHUB_APP_INSTALLATION_ID,
      },
    });
  }
  return octokit;
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
