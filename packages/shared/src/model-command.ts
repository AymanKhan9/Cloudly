/**
 * "/model <name>" sets a session's model for every later turn; "/model default"
 * clears it. Returns undefined when the prompt isn't a model choice (a bare
 * "/model" just asks the agent which model it's on).
 */
export function modelCommand(prompt: string): string | null | undefined {
  const m = /^\/model\s+(\S+)\s*$/i.exec(prompt.trim());
  if (!m) return undefined;
  return m[1]!.toLowerCase() === "default" ? null : m[1]!;
}
