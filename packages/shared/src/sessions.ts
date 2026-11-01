/**
 * Sessions talking to each other, like T3 Code's threads: an agent can list the
 * user's other sessions, read one's conversation, and send one a message, which
 * becomes a turn there. With a reply asked for, the answer comes back to the
 * sending session as a turn of its own.
 *
 * Nothing in the sandbox reaches the API: the worker writes the sessions an
 * agent may see into /sessions before its turn, and reads the messages it sent
 * from /sessions/outbox.jsonl after, the way it reads /files and the patch.
 */

/** Which sessions a session's agent may read and message. */
export const PEER_SCOPES = ["repo", "all", "off"] as const;
export type PeerScope = (typeof PEER_SCOPES)[number];

export const PEER_SCOPE_LABEL: Record<PeerScope, string> = {
  repo: "This repo's sessions",
  all: "All your sessions",
  off: "No other sessions",
};

export const SESSIONS_DIR = "/sessions";

export const SESSION_LIMITS = {
  /** Sessions an agent sees, newest first. */
  listed: 30,
  /** Turns of each session's conversation it can read, newest last. */
  turns: 12,
  promptChars: 2000,
  replyChars: 4000,
  /** Messages one turn may send, at most one to each session. */
  sendsPerTurn: 3,
  messageChars: 8000,
  /**
   * How deep a chain of messages may go (A asks B, B's reply reaches A, A asks C…).
   * A turn this many messages deep can't send any more, so agents can't keep each
   * other busy on the user's money.
   */
  hops: 4,
} as const;

/** One session in /sessions/index.json. Its conversation is /sessions/<id>.md. */
export interface PeerSession {
  id: string;
  title: string;
  repo: string;
  branch: string;
  agent: string;
  /** The status of its latest turn. */
  status: string;
  prUrl: string | null;
  updatedAt: string;
  turns: number;
}

/** /sessions/index.json */
export interface SessionsIndex {
  /** The session this turn belongs to. */
  self: { id: string; title: string };
  scope: PeerScope;
  /** Messages this turn may still send; 0 once the chain is as deep as it may go. */
  canSend: number;
  sessions: PeerSession[];
}

/** One line of /sessions/outbox.jsonl, as the agent's tool writes it. */
export interface OutboxMessage {
  to: string;
  message: string;
  replyWanted: boolean;
}

/** The header a message from another session arrives with, as the turn's prompt. */
export function messagePrompt(from: { title: string; agent: string }, message: string, replyWanted: boolean): string {
  return [
    `A message from another of the user's Cloudly sessions, "${from.title}" (${from.agent}):`,
    "",
    message.trim(),
    "",
    replyWanted
      ? "Your answer to this turn is sent back to that session, so make your final reply a complete answer to it."
      : "No reply was asked for; do what it says if it's work on this repo.",
  ].join("\n");
}

/** The prompt a reply arrives with in the session that asked. */
export function replyPrompt(from: { title: string; agent: string }, reply: string): string {
  return [
    `The reply from your other session "${from.title}" (${from.agent}), to the message you sent it:`,
    "",
    reply.trim() || "(It finished without a written reply.)",
    "",
    "Carry on with the task the message was for.",
  ].join("\n");
}
