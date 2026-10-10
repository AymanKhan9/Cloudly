import { test, expect } from "bun:test";
import { SANDBOX_PRESETS, presetBlock, sandboxToolsLabel, BASE_TOOLS_LABEL } from "../src/sandbox";

const rust = SANDBOX_PRESETS.find((p) => p.id === "rust")!;

test("the agent is told what's installed", () => {
  expect(sandboxToolsLabel("")).toBe(BASE_TOOLS_LABEL);
  expect(sandboxToolsLabel(presetBlock(rust))).toBe(`${BASE_TOOLS_LABEL}, Rust (rustc, cargo)`);
  expect(sandboxToolsLabel(`apt-get install -y jq\n\n${presetBlock(rust)}`)).toContain("custom setup script");
});
