"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";

export const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/AymanKhan9/Cloudly/main/install.sh | sh";

export function InstallCard() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="install">
      <code className="mono">
        <span className="prompt">$</span>
        {INSTALL_COMMAND}
      </code>
      <button type="button" className="btn btn-signal" onClick={copy} aria-label="Copy install command">
        {copied ? <CheckIcon /> : <CopyIcon />}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
