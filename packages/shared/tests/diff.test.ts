import { test, expect } from "bun:test";
import { parseDiff, lineInDiff, parseFindings } from "../src/diff";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import x from "x";
-const a = 1;
+const a = 2;
+const b = 3;
 export { a };
 // end
diff --git a/new.md b/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+# New
+text
\\ No newline at end of file
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/a.txt b/b.txt
similarity index 100%
rename from a.txt
rename to b.txt
diff --git a/img.png b/img.png
index 5555555..6666666 100644
Binary files a/img.png and b/img.png differ
`;

test("a git diff splits into files, with line numbers on both sides", () => {
  const files = parseDiff(DIFF);
  expect(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary])).toEqual([
    ["src/app.ts", "modified", 2, 1, false],
    ["new.md", "added", 2, 0, false],
    ["old.txt", "deleted", 0, 1, false],
    ["b.txt", "renamed", 0, 0, false],
    ["img.png", "modified", 0, 0, true],
  ]);
  const lines = files[0]!.hunks[0]!.lines;
  expect(lines[1]).toEqual({ type: "del", text: "const a = 1;", oldLine: 2 });
  expect(lines[2]).toEqual({ type: "add", text: "const a = 2;", newLine: 2 });
  expect(lines[4]).toEqual({ type: "context", text: "export { a };", oldLine: 3, newLine: 4 });
  expect(files[3]!.oldPath).toBe("a.txt");

  expect(lineInDiff(files, "src/app.ts", 3)).toBe(true);
  expect(lineInDiff(files, "src/app.ts", 5)).toBe(true); // context counts
  expect(lineInDiff(files, "src/app.ts", 40)).toBe(false);
  expect(lineInDiff(files, "nope.ts", 1)).toBe(false);
});

test("a reviewer's findings are checked, normalised and capped", () => {
  const { summary, findings } = parseFindings({
    summary: "Two problems.",
    findings: [
      { file: "/workspace/src/app.ts", line: "3", severity: "Critical", title: "Off by one", body: "b" },
      { file: "./README.md", severity: "style", title: "Typo" },
      { severity: "whatever", title: "Consider a cache", line: -4 },
      { title: "" },
      "not an object",
      { file: "x", title: "t".repeat(500), severity: "nit", body: 42 },
    ],
  });
  expect(summary).toBe("Two problems.");
  expect(findings.map((f) => [f.file, f.line, f.severity, f.title.length])).toEqual([
    ["src/app.ts", 3, "blocking", 10],
    ["README.md", null, "nit", 4],
    [null, null, "suggestion", 16],
  ]);
  expect(parseFindings([{ title: "a", severity: "nit" }]).findings).toHaveLength(1);
  expect(parseFindings("nonsense").findings).toEqual([]);
  expect(parseFindings({ findings: Array.from({ length: 80 }, () => ({ title: "x", severity: "nit" })) }).findings).toHaveLength(50);
});

test("the Changes tab's feedback becomes one turn", async () => {
  const { feedbackPrompt } = await import("../src/diff");
  expect(feedbackPrompt({ findings: [{ file: "a.ts", line: 2, title: "Bug", body: "x" }] })).toBe("Fix this finding\n\n1. **Bug** (`a.ts:2`)\n   x");
  const both = feedbackPrompt({ note: "Please be careful.", findings: [{ file: null, line: null, title: "General", body: "" }], comments: [{ file: "b.ts", line: 9, body: "Why?\nExplain." }] });
  expect(both).toBe("Address my comments on the changes\n\nPlease be careful.\n\n1. **General**\n\nComments on lines of the change:\n\n- `b.ts:9`: Why?\n   Explain.");
});
