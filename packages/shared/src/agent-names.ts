/**
 * Agents as people name them in a message: "use claude, chatgpt, opencode,
 * gemini and pi for this" means a council of those five. Built-in agents and
 * the catalog's are known here; agents the user added by hand are matched by
 * the names they gave them.
 */

const ALIASES: [string, string[]][] = [
  ["native-claude", ["claude", "claude agent", "claude code", "anthropic"]],
  ["native-codex", ["codex", "chatgpt", "chat gpt", "openai", "gpt"]],
  ["gemini-acp", ["gemini", "gemini cli"]],
  ["acp-cursor", ["cursor"]],
  ["acp-grok", ["grok", "xai"]],
  ["acp-opencode", ["opencode", "open code"]],
  ["acp-antigravity", ["antigravity"]],
  ["acp-pi", ["pi"]],
  ["acp-fx", ["fx"]],
  ["acp-muse", ["muse", "muse code"]],
];

export interface NamedAgent {
  id: string;
  name: string;
}

/** Lowercase words, keeping "," "&" "/" "+" as their own tokens. */
function tokens(text: string): string[] {
  return text.toLowerCase().replace(/([,&/+;])/g, " $1 ").split(/\s+/).filter(Boolean).map((t) => t.replace(/^[^a-z0-9,&/+;]+|[^a-z0-9,&/+;]+$/g, "")).filter(Boolean);
}

const JOINERS = new Set([",", "and", "&", "/", "+", "or", ";"]);
// Words that come right before a list of agents to work with.
const LEADS = new Set(["use", "using", "ask", "with", "have", "get", "let", "run", "spawn", "between", "members", "agents", "council"]);
// After the list, these mean the names were about something else ("the openai and anthropic SDKs").
const NOT_AGENTS = new Set(["sdk", "sdks", "api", "apis", "key", "keys", "model", "models", "library", "libraries", "package", "packages", "docs", "pricing", "account", "accounts", "token", "tokens"]);

/**
 * The agents a message asks for as a group: two or more named in one list
 * ("claude, chatgpt and gemini") right after a word like "use" or "ask". Each
 * once, in the order named. Empty when the message doesn't ask for a group.
 */
export function agentsAskedFor(text: string, added: NamedAgent[] = []): string[] {
  const words = tokens(text);
  const names: [string, string[]][] = [
    ...ALIASES,
    // Agents added under Settings, by the name the user gave them.
    ...added.filter((a) => !ALIASES.some(([id]) => id === a.id)).map((a): [string, string[]] => [a.id, [a.name.toLowerCase()]]),
  ];
  const phrases = names.flatMap(([id, list]) => list.map((p) => ({ id, words: tokens(p) }))).sort((a, b) => b.words.length - a.words.length);
  const at = (i: number) => phrases.find((p) => p.words.every((w, k) => words[i + k] === w));

  for (let i = 0; i < words.length; i++) {
    if (!LEADS.has(words[i]!)) continue;
    // Skip "the" and "these" between the lead and the list.
    let j = i + 1;
    while (j < words.length && (words[j] === "the" || words[j] === "these" || words[j] === "all")) j++;
    const found: string[] = [];
    let expectName = true;
    while (j < words.length) {
      const w = words[j]!;
      if (expectName) {
        const p = at(j);
        if (!p) break;
        if (!found.includes(p.id)) found.push(p.id);
        j += p.words.length;
        expectName = false;
      } else if (JOINERS.has(w)) {
        j++;
        // "claude, and gemini"
        if (words[j] === "and" || words[j] === "or") j++;
        expectName = true;
      } else {
        break;
      }
    }
    if (found.length >= 2 && !NOT_AGENTS.has(words[j] ?? "")) return found;
  }
  return [];
}

/** A known name for an agent id, for messages about agents that aren't added. */
export function knownAgentName(id: string): string | undefined {
  const names: Record<string, string> = {
    "native-claude": "Claude Code", "native-codex": "Codex", "gemini-acp": "Gemini CLI", "acp-cursor": "Cursor", "acp-grok": "Grok",
    "acp-opencode": "OpenCode", "acp-antigravity": "Antigravity", "acp-pi": "Pi", "acp-fx": "fx", "acp-muse": "Muse Code",
  };
  return names[id];
}
