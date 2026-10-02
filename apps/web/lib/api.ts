"use client";

import type { BudgetState } from "@/components/notation";
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
  /** This run's position among the user's runs, oldest first: its plate number. */
  ordinal?: number;
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
}

export interface Turn {
  id: string;
  prompt: string;
  status: RunStatus;
  createdAt: string;
  costUsd: number | null;
  prUrl: string | null;
  error: string | null;
  cancelRequested: boolean;
}

export interface ThreadView {
  thread: Omit<ThreadSummary, "lastStatus">;
  turns: Turn[];
}
