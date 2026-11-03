// Artifacts: what an agent makes for the user to look at rather than commit
// (a chart, a diagram, a report, a mockup, a screenshot). The agent writes them
// to /artifacts; each file is kept per session by name, a new version whenever
// a turn changes it, and shown in the turn that made it.

export type ArtifactKind = "html" | "svg" | "image" | "markdown" | "mermaid" | "csv" | "pdf" | "text";

const BY_EXT: Record<string, { kind: ArtifactKind; mime: string }> = {
  html: { kind: "html", mime: "text/html" },
  htm: { kind: "html", mime: "text/html" },
  svg: { kind: "svg", mime: "image/svg+xml" },
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  md: { kind: "markdown", mime: "text/markdown" },
  markdown: { kind: "markdown", mime: "text/markdown" },
  mmd: { kind: "mermaid", mime: "text/plain" },
  mermaid: { kind: "mermaid", mime: "text/plain" },
  csv: { kind: "csv", mime: "text/csv" },
  tsv: { kind: "csv", mime: "text/tab-separated-values" },
  pdf: { kind: "pdf", mime: "application/pdf" },
  txt: { kind: "text", mime: "text/plain" },
  json: { kind: "text", mime: "application/json" },
};

export const ARTIFACT_LIMITS = {
  /** New versions one turn can add. */
  perTurn: 20,
  fileBytes: 10 * 1024 * 1024,
  turnBytes: 25 * 1024 * 1024,
};

/** A name under /artifacts that Cloudly keeps: a plain path with a known extension. */
export function artifactType(name: string): { kind: ArtifactKind; mime: string } | null {
  if (name.length > 200 || !/^[\w.-]+(\/[\w.-]+){0,3}$/.test(name) || name.split("/").some((p) => p.startsWith("."))) return null;
  const ext = name.split(".").pop()!.toLowerCase();
  return BY_EXT[ext] ?? null;
}

export const ARTIFACT_EXTENSIONS = Object.keys(BY_EXT);

/** Kinds shown as text (read with the content's text) rather than bytes. */
export const TEXT_KINDS: ArtifactKind[] = ["html", "markdown", "mermaid", "csv", "text"];

/**
 * An HTML artifact runs in an iframe with an opaque origin (sandbox without
 * allow-same-origin), so it can't touch Cloudly. This policy, put in its head,
 * also keeps it from loading anything but the usual chart and font CDNs and from
 * calling out (no fetch, no forms).
 */
export const HTML_ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://cdn.tailwindcss.com",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
].join("; ");

/** The HTML as it goes into the frame: the policy first, before anything of the agent's can run. */
export function framedHtml(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_CSP}">`;
  const base = '<base target="_blank">';
  // At the very start, so it's in force before anything of the agent's (a meta
  // policy only covers what comes after it). After a doctype, so the page keeps standards mode.
  return /^\s*<!doctype/i.test(html) ? html.replace(/^\s*<!doctype[^>]*>/i, (d) => `${d}${meta}${base}`) : `${meta}${base}${html}`;
}

/** The lines the agent is told about /artifacts. */
export const ARTIFACTS_RULE =
  "- To show the user something visual or a document (a chart, a diagram, a report, a table of results, a mockup, a screenshot), write it to /artifacts: .html (a self-contained page; scripts from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com are allowed, nothing else can be fetched), .svg, .png/.jpg, .md, .mmd (Mermaid), .csv or .pdf. Each file appears in this conversation; writing the same name again later makes a new version. It isn't committed. In your reply, name the file rather than repeating its contents.";
