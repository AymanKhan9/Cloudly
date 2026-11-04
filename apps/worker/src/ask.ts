import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma } from "@repo/db";
import { readRegular } from "./repo-files";

// ask_user (packages/runner/src/ask-mcp.ts): the agent's question comes back
// from /ask/question.json after the turn, read like the patch, and flags the
// session as needing the user until they reply.

const MAX_QUESTION = 2000;

export async function prepareAsk(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "run-ask-"));
}

/** The question the agent asked this turn, if it asked one. */
export async function readQuestion(dir: string): Promise<string | null> {
  const bytes = await readRegular(path.join(dir, "question.json"), 16 * 1024);
  if (!bytes) return null;
  try {
    const q = JSON.parse(new TextDecoder().decode(bytes))?.question;
    return typeof q === "string" && q.trim() ? q.trim().slice(0, MAX_QUESTION) : null;
  } catch {
    return null;
  }
}

/** Flags the session as needing the user, with the agent's question. */
export async function recordQuestion(threadId: string, dir: string): Promise<string | null> {
  const question = await readQuestion(dir);
  if (question) await prisma.thread.update({ where: { id: threadId }, data: { needsInput: question, settledAt: null, snoozedUntil: null } });
  return question;
}

export interface SecretRequest {
  name: string;
  description: string;
  hosts: string[];
}

const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HOST = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** The secret the agent asked for with request_secret this turn, if it asked for one. */
export async function readSecretRequest(dir: string): Promise<SecretRequest | null> {
  const bytes = await readRegular(path.join(dir, "secret.json"), 16 * 1024);
  if (!bytes) return null;
  try {
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    const name = String(raw?.name ?? "");
    const hosts = (Array.isArray(raw?.hosts) ? raw.hosts : []).map(String).filter((h: string) => HOST.test(h)).slice(0, 10);
    if (!SECRET_NAME.test(name) || !hosts.length) return null;
    return { name, description: String(raw?.description ?? "").slice(0, MAX_QUESTION), hosts };
  } catch {
    return null;
  }
}

/** Flags the session as needing the user, for the secret the agent asked for. */
export async function recordSecretRequest(threadId: string, dir: string): Promise<SecretRequest | null> {
  const request = await readSecretRequest(dir);
  if (request) {
    await prisma.thread.update({
      where: { id: threadId },
      data: { needsInput: `The agent needs a secret: ${request.name}`, settledAt: null, snoozedUntil: null },
    });
  }
  return request;
}

export async function destroyAsk(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
