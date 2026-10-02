import { test, expect } from "bun:test";
import { formatTranscript } from "../src/transcript";

test("a first message goes through unchanged", () => {
  expect(formatTranscript([], "hello")).toBe("hello");
});

test("follow-ups carry the earlier conversation and the new message last", () => {
  const out = formatTranscript([{ prompt: "make a.txt", reply: "Done, made a.txt" }], "now add a line");
  expect(out).toContain("User: make a.txt");
  expect(out).toContain("You: Done, made a.txt");
  expect(out.trim().endsWith("now add a line")).toBe(true);
});

test("only the most recent turns and a bounded reply length are kept", () => {
  const prior = Array.from({ length: 12 }, (_, i) => ({ prompt: `p${i}`, reply: "x".repeat(5000) }));
  const out = formatTranscript(prior, "next");
  expect(out).not.toContain("User: p3");
  expect(out).toContain("User: p11");
  expect(out.length).toBeLessThan(8 * 3200 + 1000);
});
