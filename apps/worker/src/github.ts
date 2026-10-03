import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { RequestError } from "@octokit/request-error";
import { githubAppCredentials, credentialsFingerprint } from "@repo/db";

let octokit: { fingerprint: string; client: Octokit } | undefined;
let auth: { fingerprint: string; strategy: ReturnType<typeof createAppAuth> } | undefined;

async function credentials() {
    const creds = await githubAppCredentials();
    if (!creds) throw new Error("The GitHub App isn't set up yet. Finish setup in the web app.");
    return { creds, fingerprint: credentialsFingerprint(creds) };
}

async function getOctokit(): Promise<Octokit> {
    const { creds, fingerprint } = await credentials();
    if (octokit?.fingerprint !== fingerprint) {
        octokit = { fingerprint, client: new Octokit({ authStrategy: createAppAuth, auth: { ...creds } }) };
    }
    return octokit.client;
}

async function getAuth(): Promise<ReturnType<typeof createAppAuth>> {
    const { creds, fingerprint } = await credentials();
    if (auth?.fingerprint !== fingerprint) {
        auth = { fingerprint, strategy: createAppAuth({ ...creds }) };
    }
    return auth.strategy;
}

/**
 * A fresh installation access token. `@octokit/auth-app` caches and
 * auto-refreshes internally, so this is cheap to call per run rather than
 * something the caller needs to cache itself.
 */
export async function getInstallationToken(): Promise<string> {
    const authenticate = await getAuth();
    const result = await authenticate({ type: "installation" });
    return result.token;
}

export async function authenticatedCloneUrl(owner: string, repo: string): Promise<string> {
    const token = await getInstallationToken();
    return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * `Run.repo` is stored as GitHub's own "owner/repo" shorthand, not a full
 * URL — credentials are fetched fresh per run via the App, never persisted.
 */
export function isRepoSlug(value: string): boolean {
    return REPO_SLUG_PATTERN.test(value);
}

/**
 * Validated here since this is the boundary where a user-supplied value
 * (from `POST /runs`) turns into a GitHub API path/clone URL component.
 */
export function parseRepoSlug(slug: string): { owner: string; repo: string } {
    if (!isRepoSlug(slug)) {
        throw new Error(`invalid repo slug: ${JSON.stringify(slug)}, expected "owner/repo"`);
    }
    const [owner, repo] = slug.split("/");
    return { owner: owner!, repo: repo! };
}

/**
 * `run.repo` as stored may be a real GitHub "owner/repo" slug (the live
 * path, needs a fresh installation token) or a plain git-cloneable source —
 * a local path or already-a-URL, as every worker test fixture uses today.
 * Only the slug case needs GitHub auth; anything else passes through
 * unchanged, so this is safe to call unconditionally.
 */
export async function resolveCloneSource(repo: string): Promise<string> {
    if (!isRepoSlug(repo)) {
        return repo;
    }
    const { owner, repo: repoName } = parseRepoSlug(repo);
    return authenticatedCloneUrl(owner, repoName);
}

export interface CreatePullRequestParams {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body?: string;
}

export interface CreatePullRequestResult {
    url: string;
    number: number;
    alreadyExisted: boolean;
}

export async function createPullRequest(
    params: CreatePullRequestParams,
): Promise<CreatePullRequestResult> {
    const client = await getOctokit();

    try {
        const response = await client.request("POST /repos/{owner}/{repo}/pulls", {
            owner: params.owner,
            repo: params.repo,
            head: params.head,
            base: params.base,
            title: params.title,
            body: params.body,
        });

        return { url: response.data.html_url, number: response.data.number, alreadyExisted: false };
    } catch (error) {
        if (!(error instanceof RequestError) || error.status !== 422) {
            throw error;
        }

        const data = error.response?.data as { errors?: Array<{ message?: string }> } | undefined;
        const alreadyExists = data?.errors?.some((e) =>
            e.message?.toLowerCase().includes("already exists"),
        );

        if (!alreadyExists) {
            throw error;
        }

        const existing = await client.request("GET /repos/{owner}/{repo}/pulls", {
            owner: params.owner,
            repo: params.repo,
            head: `${params.owner}:${params.head}`,
            base: params.base,
            state: "open",
        });

        const pr = existing.data[0];
        if (!pr) {
            throw error;
        }

        return { url: pr.html_url, number: pr.number, alreadyExisted: true };
    }
}
