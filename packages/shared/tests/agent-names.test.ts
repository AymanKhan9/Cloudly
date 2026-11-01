import { test, expect } from "bun:test";
import { agentsAskedFor } from "../src/agent-names";

test("a list of agents after 'use' or 'ask' is a group, in the order named", () => {
  expect(agentsAskedFor("Use claude,chatgpt, opencode,gemini and pi for this research work")).toEqual([
    "native-claude", "native-codex", "acp-opencode", "gemini-acp", "acp-pi",
  ]);
  expect(agentsAskedFor("Ask Gemini & Grok what changed in Postgres 18")).toEqual(["gemini-acp", "acp-grok"]);
  expect(agentsAskedFor("with the claude code, cursor, and open code agents, review this")).toEqual(["native-claude", "acp-cursor", "acp-opencode"]);
  // Each agent once, however it's named.
  expect(agentsAskedFor("use chatgpt, codex and claude")).toEqual(["native-codex", "native-claude"]);
});

test("names that aren't a request for agents are left alone", () => {
  // One agent isn't a group.
  expect(agentsAskedFor("Use claude to fix the flaky test")).toEqual([]);
  // About the vendors' SDKs, not their agents.
  expect(agentsAskedFor("use the openai and anthropic SDKs for the chat feature")).toEqual([]);
  // No lead word: mentions, not a request.
  expect(agentsAskedFor("Compare how claude and gemini handle long context")).toEqual([]);
  expect(agentsAskedFor("Explain why pi is irrational")).toEqual([]);
});

test("agents the user added are known by the names they gave them", () => {
  expect(agentsAskedFor("use claude and My Agent for this", [{ id: "acp-my-agent", name: "My Agent" }])).toEqual(["native-claude", "acp-my-agent"]);
});
