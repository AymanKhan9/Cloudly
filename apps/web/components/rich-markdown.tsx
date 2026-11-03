"use client";

import { isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import { CodeBlock } from "./code-block";

// How an agent's text reads: GitHub-style Markdown (tables, task lists),
// highlighted code with a copy button, Mermaid diagrams and math. No raw HTML.
// Images only from Cloudly itself (an artifact) or inline data: an agent's
// reply can't make the browser fetch a URL of its choosing.

const SAFE_IMAGE = /^(\/api\/artifacts\/[\w-]+\/content|\/api\/shared\/[\w-]+\/content|data:image\/(png|jpe?g|gif|webp);)/i;

let mermaidReady: Promise<typeof import("mermaid")["default"]> | null = null;
function loadMermaid(dark: boolean) {
  mermaidReady ??= import("mermaid").then((m) => m.default);
  return mermaidReady.then((mermaid) => {
    // strict: no scripts or click handlers in the diagram, labels sanitized.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "inherit" });
    return mermaid;
  });
}

const isDark = () =>
  typeof document !== "undefined" &&
  (document.documentElement.dataset.theme === "dark" ||
    (document.documentElement.dataset.theme !== "light" && window.matchMedia?.("(prefers-color-scheme: dark)").matches));

/** A Mermaid diagram, drawn in the browser; the source if it doesn't parse. */
export function MermaidDiagram({ code }: { code: string }) {
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadMermaid(isDark())
      .then((m) => m.render(id, code))
      .then((r) => live && setSvg(r.svg))
      .catch((err: Error) => {
        // Mermaid leaves its error drawing in the page.
        document.getElementById(`d${id}`)?.remove();
        if (live) setFailed(err?.message?.split("\n")[0] ?? "Couldn't draw it");
      });
    return () => {
      live = false;
    };
  }, [code, id]);
  if (failed) {
    return (
      <div className="mermaid-failed">
        <span className="dim">Diagram didn&apos;t draw: {failed}</span>
        <CodeBlock>{code}</CodeBlock>
      </div>
    );
  }
  if (!svg) return <div className="mermaid-diagram skeleton" style={{ height: 120 }} aria-busy="true" />;
  // Mermaid's own sanitizer (securityLevel strict) cleans the SVG it returns.
  return <div className="mermaid-diagram" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

const baseComponents: Components = {
  pre({ children, node: _node, ...props }) {
    const code = Array.isArray(children) ? children[0] : children;
    const className = isValidElement(code) ? String((code.props as { className?: string }).className ?? "") : "";
    if (/\blanguage-mermaid\b/.test(className)) return <MermaidDiagram code={textOf(code).trimEnd()} />;
    return <CodeBlock {...props}>{children}</CodeBlock>;
  },
  a({ node: _node, href, children, ...props }) {
    const external = href && /^https?:/i.test(href);
    return (
      <a href={href} {...props} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}>
        {children}
      </a>
    );
  },
  table({ node: _node, ...props }) {
    return (
      <div className="md-table">
        <table {...props} />
      </div>
    );
  },
};

/**
 * `resolveImage` maps an image's src to one Cloudly serves (a report's
 * `![](chart.png)` to the session's chart.png artifact); anything else isn't loaded.
 */
export function RichMarkdown({ children, resolveImage }: { children: string; resolveImage?: (src: string) => string | null }) {
  const components: Components = {
    ...baseComponents,
    img({ node: _node, src, alt }) {
      const raw = typeof src === "string" ? src : "";
      const url = SAFE_IMAGE.test(raw) ? raw : resolveImage?.(raw) ?? null;
      if (url && SAFE_IMAGE.test(url)) return <img src={url} alt={alt ?? ""} className="md-image" loading="lazy" />;
      return <span className="dim">[image: {alt || raw || "not shown"}]</span>;
    },
  };
  return (
    <Markdown
      remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }], [rehypeHighlight, { detect: false, plainText: ["mermaid", "text", "txt"] }]]}
      components={components}
    >
      {children}
    </Markdown>
  );
}
