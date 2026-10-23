import { z } from 'zod';

export const HARNESSES = [
  { id: 'native-claude', name: 'Claude Agent', cost: 'exact' },
  { id: 'native-codex', name: 'Codex', cost: 'estimated' },
  { id: 'gemini-acp', name: 'Gemini CLI', cost: 'estimated' },
] as const;

export const HarnessId = z.enum(['native-claude', 'native-codex', 'gemini-acp']);

export function harnessName(id: string): string {
  return HARNESSES.find((h) => h.id === id)?.name ?? id;
}

export function threadTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!.replace(/\s+/g, ' ');
  return line.length > 64 ? `${line.slice(0, 63).trimEnd()}…` : line;
}
