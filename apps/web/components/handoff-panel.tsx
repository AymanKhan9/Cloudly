"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { harnessById } from "@/lib/harness";
import { CodeBlock } from "./code-block";

/** Carry a session on on the user's own machine: the command, with a token if they make one. */
export function HandoffPanel({ threadId, harness, busy }: { threadId: string; harness: string; busy: boolean }) {
  const [origin, setOrigin] = useState("https://<your instance>");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);
  const own = { "native-claude": "Claude Code", "native-codex": "Codex", "acp-pi": "Pi" }[harness];

  async function create() {
    setError(null);
    try {
      setToken((await api<{ token: string }>("/settings/tokens", { method: "POST", body: JSON.stringify({ name: "Cloudly command" }) })).token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create a token.");
    }
  }

  return (
    <div className="handoff">
      <p className="hint">
        Run this in your clone of the repo. It checks out the session&apos;s branch and{" "}
        {own
          ? `puts ${own}'s own session where ${own} on your computer finds it, so it resumes with everything it remembers.`
          : `gives the agent you choose the conversation so far (${harnessById(harness).name} has no session to open there).`}{" "}
        With uncommitted changes, add <span className="mono">--worktree</span> to use a folder of its own.
      </p>
      <CodeBlock>{`curl -fsSL ${origin}/api/cloudly.mjs -o cloudly.mjs\nCLOUDLY_TOKEN=${token ?? "<token>"} node cloudly.mjs pull ${origin}/app/s/${threadId}`}</CodeBlock>
      {token ? (
        <p className="hint">Copy it now: the token isn&apos;t shown again. The same command imports sessions from your computer.</p>
      ) : (
        <div className="row-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={create}>
            Create a token for it
          </button>
        </div>
      )}
      <p className="hint">
        <span className="mono">--agent codex</span> (or claude, pi) carries on with another agent, with the conversation as its first message. Push to the branch and the session here
        picks up from there on its next turn.
      </p>
      {busy ? <p className="hint" style={{ color: "var(--warn)" }}>A turn is running: wait for it to finish first.</p> : null}
      {error ? (
        <p className="hint" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
