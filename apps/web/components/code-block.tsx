"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";

/** A docs code block with a copy button. */
export function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <pre ref={ref} {...props} />
      <button
        type="button"
        className="icon-btn"
        aria-label={copied ? "Copied" : "Copy code"}
        onClick={async () => {
          await navigator.clipboard.writeText(ref.current?.innerText.trimEnd() ?? "").catch(() => {});
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={15} weight="bold" /> : <Copy size={15} />}
      </button>
    </div>
  );
}
