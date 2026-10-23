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

