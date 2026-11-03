import { test, expect } from "bun:test";
import { artifactType, framedHtml, HTML_ARTIFACT_CSP } from "../src/artifacts";

test("which files are artifacts", () => {
  expect(artifactType("chart.html")).toEqual({ kind: "html", mime: "text/html" });
  expect(artifactType("shots/after-home.PNG")).toEqual({ kind: "image", mime: "image/png" });
  expect(artifactType("flow.mmd")?.kind).toBe("mermaid");
  expect(artifactType("data.tsv")?.kind).toBe("csv");
  for (const bad of ["run.sh", "../x.png", "/abs.png", ".env.md", "a/.git/x.md", "a b.png", "a/b/c/d/e.png", "x".repeat(201) + ".md"]) {
    expect(artifactType(bad)).toBeNull();
  }
});

test("HTML gets its policy before anything of the agent's", () => {
  const page = framedHtml("<!DOCTYPE html><html><head><script>1</script></head></html>");
  expect(page.startsWith(`<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_CSP}">`)).toBe(true);
  expect(page.indexOf("Content-Security-Policy")).toBeLessThan(page.indexOf("<script>"));
  expect(framedHtml("<div>hi</div>").startsWith("<meta http-equiv")).toBe(true);
  expect(HTML_ARTIFACT_CSP).toContain("connect-src 'none'");
});
