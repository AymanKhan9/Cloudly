"use client";

import { useState } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { HARNESSES, type HarnessId } from "@/lib/harness";

// The real event names each adapter in packages/runner maps from.
const DIALECTS: Record<HarnessId, string[]> = {
  "native-claude": ["assistant · text block", "assistant · tool_use", "user · tool_result", "result · total_cost_usd"],
  "native-codex": ["item.completed · agent_message", "item.started · command_execution", "item.completed · command_execution", "turn.completed · usage tokens"],
  "gemini-acp": ["session/update · agent_message_chunk", "session/update · tool_call", "session/update · tool_call_update", "prompt response · token quota"],
};
const UNIFIED = ["Agent message", "Tool call", "Tool result", "Done, with cost"];
const PROTOCOL: Record<HarnessId, string> = { "native-claude": "Agent SDK", "native-codex": "Codex SDK", "gemini-acp": "Agent Client Protocol" };

export function AgentsDemo() {
  const [id, setId] = useState<HarnessId>("native-claude");

  return (
    <div className="agents">
      <div className="segmented" role="group" aria-label="Agent">
        {HARNESSES.map((h) => (
          <button key={h.id} type="button" aria-pressed={h.id === id} onClick={() => setId(h.id)}>
            {h.name}
          </button>
        ))}
      </div>
      <div className="dialect">
        <div className="dialect-row head">
          <span>{PROTOCOL[id]} event</span>
          <span />
          <span>Cloudly log</span>
        </div>
        {DIALECTS[id].map((native, i) => (
          <div className="dialect-row" key={UNIFIED[i]}>
            <code className="mono" key={native}>
              {native}
            </code>
            <ArrowRight size={16} />
            <strong>{UNIFIED[i]}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
