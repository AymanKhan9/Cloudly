"use client";

import type { BudgetState } from "@/components/status";
import type { RunStatus } from "./harness";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 401) {
    window.location.assign("/signin");
    throw new ApiError(401, "Sign in required");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.message ?? `Request failed (${res.status})`);
  return body as T;
}

export interface User {
  id: string;
  login: string;
  avatarUrl: string | null;
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  createdAt: string;
  repo: string;
  baseBranch: string;
  prompt: string;
  harness: string;
  costUsd: number | null;
  prUrl: string | null;
  branch: string | null;
  error: string | null;
  cancelRequested: boolean;
}

export interface Budget {
  spentUsd: number;
  limitUsd: number | null;
  ratio: number;
  state: BudgetState;
  alertEmail: string | null;
}

export interface Repo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface ThreadSummary {
  id: string;
  repo: string;
  baseBranch: string;
  harness: string;
  title: string;
  branch: string;
  prUrl: string | null;
  updatedAt: string;
  createdAt: string;
  lastStatus: RunStatus;
  /** Set when the session is one agent of an arena. */
  arenaId?: string | null;
  /** Turns get a virtual desktop. */
  desktop?: boolean;
  /** Which other sessions its agent may read and message: "repo", "all" or "off". */
  peers?: string;
  /** Sidebar state, as in T3 Code's thread menu. */
  pinnedAt?: string | null;
  settledAt?: string | null;
  snoozedUntil?: string | null;
  archivedAt?: string | null;
  /** The question the agent asked with ask_user, until the user answers. */
  needsInput?: string | null;
  /** A turn ended (or a snooze ran out) since the user last looked. */
  unread?: boolean;
  /** Hidden until snoozedUntil. */
  snoozed?: boolean;
  /** Merge the pull request once it's ready, what that's waiting for, and when it merged. */
  autoMerge?: boolean;
  mergeStatus?: string | null;
  mergedAt?: string | null;
  /** The schedule that started it. */
  scheduleId?: string | null;
}

export interface Turn {
  id: string;
  prompt: string;
  status: RunStatus;
  createdAt: string;
  costUsd: number | null;
  /** Ran on the user's Claude or ChatGPT plan: no per-run cost. */
  onPlan: boolean;
  prUrl: string | null;
  error: string | null;
  cancelRequested: boolean;
  filesChanged?: number | null;
  additions?: number | null;
  deletions?: number | null;
  /** The turn ran with a virtual desktop. */
  desktop?: boolean;
  /** Another session's agent asked for this turn (a message, or a reply to one). */
  from?: { threadId: string; title: string | null } | null;
  /** Its answer goes back to this session. */
  replyToThreadId?: string | null;
  /**
   * turn; fix: Cloudly asked the agent to fix the checks its last change broke;
   * review: the reviewer looked at the session's change; review_fix: the author
   * was sent the reviewer's blocking findings; audit: the whole repo was reviewed.
   */
  kind?: "turn" | "fix" | "review" | "review_fix" | "audit" | "ci_fix";
  /** What on GitHub started the turn, when something did. */
  trigger?: { type: "issue" | "mention" | "pr_review" | "ci" | "schedule"; name?: string; by?: string; url?: string | null; number?: number; state?: string; sha?: string; checks?: string[] } | null;
  /** The agent that ran the turn; a review's is the reviewer. */
  harness?: string;
  /** A review's or audit's findings, as text. */
  output?: string | null;
  /** The repo's checks after the turn's changes. */
  checkStatus?: "passed" | "failed" | "error" | "skipped" | null;
  checkCommand?: string | null;
  checkOutput?: string | null;
  checkMs?: number | null;
}

export interface RepoCheckSettings {
  repo: string;
  settings: {
    checks: "auto" | "custom" | "off";
    checkCommand: string | null;
    fixAttempts: number;
    checkTimeoutSec: number;
    reviewer: string | null;
    reviewRounds: number;
    reviewPostToGitHub: boolean;
    triggerHarness: string | null;
    issueLabel: string;
    onIssueLabel: boolean;
    onMention: boolean;
    onPrReview: boolean;
    fixCi: boolean;
    ciFixAttempts: number;
    autoMerge: boolean;
    mergeMethod: "squash" | "merge" | "rebase";
  };
  last: { checkCommand: string | null; checkStatus: string; createdAt: string } | null;
}

export interface ReviewFinding {
  id: string;
  runId: string;
  file: string | null;
  line: number | null;
  severity: "blocking" | "suggestion" | "nit";
  title: string;
  body: string;
  status: "open" | "sent" | "dismissed";
  createdAt: string;
}

export interface SessionChanges {
  diff: string;
  diffBase: string | null;
  findings: ReviewFinding[];
  /** The repo's reviewer, or null when it has none. */
  reviewer: string | null;
}

export interface WebhookStatus {
  url: string;
  secretSet: boolean;
  appSlug: string | null;
  deliveries: { id: string; event: string; action: string | null; status: string; note: string | null; receivedAt: string }[];
}

export interface ThreadView {
  /** model and effort: chosen in the chat box for the rest of the session; null is the agent's default. */
  thread: Omit<ThreadSummary, "lastStatus"> & { model?: string | null; effort?: string | null };
  turns: Turn[];
}

export interface Capabilities {
  /** The sandbox image has the desktop preset built in. */
  desktop: boolean;
  /** PREVIEW_ORIGIN is set, so previews open in the browser. */
  previews: boolean;
  /** Connected MCP servers' names. */
  mcp: string[];
}

export interface McpServerRow {
  id: string;
  name: string;
  url: string;
  auth: "oauth" | "bearer" | "none";
  enabled: boolean;
  status: "connected" | "needs_auth" | "error";
  error: string | null;
  expiresAt: string | null;
}

export interface EnvSecretRow {
  id: string;
  name: string;
  repo: string;
  hosts: string;
  exposed: boolean;
  preview: string | null;
  updatedAt: string;
}

export interface RepoFileRow {
  path: string;
  size: number;
  sha256: string;
  updatedAt: string;
}

export interface Preview {
  id: string;
  status: "requested" | "starting" | "running" | "stopping" | "stopped" | "failed";
  command: string;
  port: number;
  desktop: boolean;
  error: string | null;
  log: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface ArenaEntry {
  thread: ThreadSummaryBase & { autoPr: boolean; model: string | null };
  turns: number;
  pushed: boolean;
  result: {
    id: string;
    status: RunStatus;
    latestStatus: RunStatus;
    cancelRequested: boolean;
    costUsd: number;
    onPlan: boolean;
    error: string | null;
    filesChanged: number;
    additions: number;
    deletions: number;
    durationMs: number | null;
    summary: string | null;
  } | null;
}

type ThreadSummaryBase = Omit<ThreadSummary, "lastStatus">;

export interface ArenaView {
  arena: { id: string; repo: string; baseBranch: string; prompt: string; winnerThreadId: string | null; createdAt: string };
  entries: ArenaEntry[];
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}


export interface CouncilSummary {
  id: string;
  question: string;
  members: string[];
  status: "running" | "done" | "stopped" | "failed" | "cancelled";
  round: number;
  rounds: number;
  repo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CouncilTurn {
  id: string;
  harness: string;
  round: number;
  role: "member" | "chair";
  status: RunStatus;
  cancelRequested: boolean;
  costUsd: number | null;
  onPlan: boolean;
  output: string | null;
  error: string | null;
  createdAt: string;
  durationMs: number | null;
}

export interface CouncilView {
  council: CouncilSummary & {
    chair: string;
    baseBranch: string | null;
    budgetUsd: number | null;
    guidance: { text: string; round: number; at: string }[];
    report: string | null;
    error: string | null;
  };
  turns: CouncilTurn[];
  spentUsd: number;
}

/** An agent sessions can use: built in, or added under Settings > Agents. */
export interface HarnessInfo {
  id: string;
  name: string;
  cost: "exact" | "estimated" | "none";
  icon?: string | null;
  /** Keys an added agent can't run without that aren't set yet. */
  missing?: string[];
  ready?: boolean;
  reason?: string;
}

/** Whether an agent can run now, and why not (GET /harnesses?check=). */
export interface AgentReadiness {
  id: string;
  name: string;
  ready: boolean;
  reason?: string;
}

export interface AgentKey {
  env: string;
  label: string;
  hosts: string[];
  optional?: boolean;
  reuse?: string;
  set: boolean;
  preview: string | null;
  reused: boolean;
}

/** An added agent, as Settings > Agents lists it. Keys show only their last four characters. */
export interface AgentRow {
  id: string;
  name: string;
  source: "catalog" | "registry" | "custom";
  sourceId: string | null;
  version: string | null;
  icon: string | null;
  enabled: boolean;
  spec: {
    launch: { install: { kind: string; packages?: string[]; cmd?: string; package?: string }; args: string[] };
    hosts: string[];
  };
  credentials: AgentKey[];
  missing: string[];
  /** A sandbox image with it in has finished building. */
  installed: boolean;
  createdAt: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  blurb: string;
  registryId?: string;
  icon: string | null;
  note?: string;
  unavailable?: string;
  credentials: { env: string; label: string; hosts: string[]; optional?: boolean; reuse?: string }[];
}

export interface RegistryItem {
  id: string;
  name: string;
  version: string;
  description: string;
  website: string | null;
  icon: string | null;
  installable: boolean;
  added: boolean;
  catalogId: string | null;
}

export interface AgentsSettings {
  agents: AgentRow[];
  catalog: CatalogItem[];
  builtin: { id: string; name: string; blurb: string }[];
  image: { status: "pending" | "building" | "ready" | "failed"; updatedAt: string } | null;
}

export interface Schedule {
  id: string;
  name: string;
  repo: string;
  baseBranch: string;
  harness: string;
  prompt: string;
  kind: "turn" | "audit";
  mode: "new" | "continue";
  frequency: "hourly" | "daily" | "weekdays" | "weekly";
  minuteOfDay: number;
  weekday: number | null;
  timeZone: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastNote: string | null;
  lastThreadId: string | null;
  lastThreadTitle: string | null;
  /** "Weekdays at 09:00". */
  description: string;
}
