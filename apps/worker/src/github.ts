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

export interface PullRequestReviewParams {
    owner: string;
    repo: string;
    pullNumber: number;
    /** The commit the line numbers are on. */
    commitId: string;
    body: string;
    comments: { path: string; line: number; side: "RIGHT"; body: string }[];
}

/**
 * Posts a review (a comment, never an approval or a request for changes) on a
 * pull request. GitHub rejects the whole review when any comment's line isn't
 * in the diff, so on that 422 it's posted again with the comments in the body.
 */
export async function postPullRequestReview(params: PullRequestReviewParams): Promise<{ url: string; lineComments: number }> {
    const client = await getOctokit();
    const post = (body: string, comments: PullRequestReviewParams["comments"]) =>
        client.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
            owner: params.owner,
            repo: params.repo,
            pull_number: params.pullNumber,
            commit_id: params.commitId,
            event: "COMMENT",
            body,
            comments,
        });
    try {
        const r = await post(params.body, params.comments);
        return { url: r.data.html_url, lineComments: params.comments.length };
    } catch (error) {
        if (!(error instanceof RequestError) || error.status !== 422 || params.comments.length === 0) throw error;
        const inline = params.comments.map((c) => `- \`${c.path}:${c.line}\` ${c.body.replace(/\n+/g, " ")}`).join("\n");
        const r = await post(`${params.body}\n\n${inline}`, []);
        return { url: r.data.html_url, lineComments: 0 };
    }
}

// What the webhook handler (webhooks.ts) asks of GitHub. An interface so tests
// can stand in for GitHub.

export interface FailedCheck {
    name: string;
    url: string | null;
    title: string | null;
    summary: string | null;
    annotations: { path: string; line: number | null; message: string }[];
    /** The end of the job's log, for GitHub Actions. */
    log: string | null;
}

export interface GitHubPort {
    comment(owner: string, repo: string, issueNumber: number, body: string): Promise<void>;
    react(owner: string, repo: string, commentId: number, content: "eyes" | "+1"): Promise<void>;
    pullRequest(owner: string, repo: string, number: number): Promise<{ number: number; url: string; title: string; headRef: string; headRepo: string | null; baseRef: string; state: string }>;
    reviewComments(owner: string, repo: string, number: number, reviewId: number): Promise<{ path: string; line: number | null; body: string }[]>;
    failedChecks(owner: string, repo: string, suiteId: number): Promise<FailedCheck[]>;
    /** For merge-when-ready (merge.ts). */
    prStatus(owner: string, repo: string, number: number): Promise<PrStatus>;
    /** Every check run and commit status on a commit, by outcome. */
    commitChecks(owner: string, repo: string, sha: string): Promise<{ pending: string[]; failed: string[]; passed: number }>;
    merge(owner: string, repo: string, number: number, sha: string, method: string): Promise<{ merged: boolean; message: string }>;
    updateBranch(owner: string, repo: string, number: number, headSha: string): Promise<void>;
}

export interface PrStatus {
    state: string;
    merged: boolean;
    draft: boolean;
    /** null while GitHub is still working it out. */
    mergeable: boolean | null;
    /** clean | unstable | behind | dirty | blocked | has_hooks | draft | unknown */
    mergeableState: string;
    headSha: string;
    baseRef: string;
}

const LOG_TAIL = 8000;

const PASSING = new Set(["success", "neutral", "skipped"]);

export const github: GitHubPort = {
    async prStatus(owner, repo, number) {
        const client = await getOctokit();
        const { data } = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number });
        return {
            state: data.state, merged: data.merged, draft: Boolean(data.draft), mergeable: data.mergeable,
            mergeableState: data.mergeable_state, headSha: data.head.sha, baseRef: data.base.ref,
        };
    },
    async commitChecks(owner, repo, sha) {
        const client = await getOctokit();
        const pending: string[] = [];
        const failed: string[] = [];
        let passed = 0;
        const runs = await client.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { owner, repo, ref: sha, filter: "latest", per_page: 100 });
        for (const r of runs.data.check_runs) {
            if (r.status !== "completed") pending.push(r.name);
            else if (PASSING.has(r.conclusion ?? "")) passed++;
            else failed.push(r.name);
        }
        // Commit statuses (older CI services). Needs "Commit statuses: read"; without it there are none to see.
        try {
            const st = await client.request("GET /repos/{owner}/{repo}/commits/{ref}/status", { owner, repo, ref: sha });
            for (const x of st.data.statuses) {
                if (x.state === "pending") pending.push(x.context);
                else if (x.state === "success") passed++;
                else failed.push(x.context);
            }
        } catch (error) {
            if (!(error instanceof RequestError) || (error.status !== 403 && error.status !== 404)) throw error;
        }
        return { pending, failed, passed };
    },
    async merge(owner, repo, number, sha, method) {
        const client = await getOctokit();
        try {
            const { data } = await client.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
                owner, repo, pull_number: number, sha, merge_method: method as "merge" | "squash" | "rebase",
            });
            return { merged: data.merged, message: data.message };
        } catch (error) {
            // 405: not mergeable (rules, conflicts); 409: the head moved since we looked.
            if (error instanceof RequestError && (error.status === 405 || error.status === 409 || error.status === 422)) {
                return { merged: false, message: (error.response?.data as { message?: string } | undefined)?.message ?? error.message };
            }
            throw error;
        }
    },
    async updateBranch(owner, repo, number, headSha) {
        const client = await getOctokit();
        await client.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch", { owner, repo, pull_number: number, expected_head_sha: headSha });
    },
    async comment(owner, repo, issueNumber, body) {
        const client = await getOctokit();
        await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo, issue_number: issueNumber, body });
    },
    async react(owner, repo, commentId, content) {
        const client = await getOctokit();
        await client.request("POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions", { owner, repo, comment_id: commentId, content });
    },
    async pullRequest(owner, repo, number) {
        const client = await getOctokit();
        const { data } = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number });
        return {
            number: data.number, url: data.html_url, title: data.title, state: data.state,
            headRef: data.head.ref, headRepo: data.head.repo?.full_name ?? null, baseRef: data.base.ref,
        };
    },
    async reviewComments(owner, repo, number, reviewId) {
        const client = await getOctokit();
        const { data } = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments", {
            owner, repo, pull_number: number, review_id: reviewId, per_page: 100,
        });
        return data.map((c) => ({ path: c.path, line: (c as { line?: number | null }).line ?? null, body: c.body }));
    },
    async failedChecks(owner, repo, suiteId) {
        const client = await getOctokit();
        const { data } = await client.request("GET /repos/{owner}/{repo}/check-suites/{check_suite_id}/check-runs", {
            owner, repo, check_suite_id: suiteId, filter: "latest", per_page: 50,
        });
        const failed = data.check_runs.filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out");
        const out: FailedCheck[] = [];
        for (const r of failed.slice(0, 5)) {
            let annotations: FailedCheck["annotations"] = [];
            try {
                const a = await client.request("GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations", { owner, repo, check_run_id: r.id, per_page: 30 });
                annotations = a.data.map((x) => ({ path: x.path, line: x.start_line ?? null, message: x.message ?? "" }));
            } catch {}
            let log: string | null = null;
            // A GitHub Actions check run's id is its job's id.
            if (r.app?.slug === "github-actions") {
                try {
                    const l = await client.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", { owner, repo, job_id: r.id });
                    const text = typeof l.data === "string" ? l.data : new TextDecoder().decode(l.data as ArrayBuffer);
                    log = text.length > LOG_TAIL ? text.slice(-LOG_TAIL) : text;
                } catch {}
            }
            out.push({ name: r.name, url: r.html_url ?? null, title: r.output?.title ?? null, summary: r.output?.summary ?? null, annotations, log });
        }
        return out;
    },
};
