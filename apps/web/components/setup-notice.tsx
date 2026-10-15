"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Info } from "@phosphor-icons/react";

/** A fresh instance can't sign anyone in yet; say so instead of failing at GitHub. */
export function SetupNotice() {
  const [needsSetup, setNeedsSetup] = useState(false);
  useEffect(() => {
    fetch("/api/setup/status")
      .then((r) => r.json())
      .then((s) => setNeedsSetup(Boolean(s.needsSetup)))
      .catch(() => {});
  }, []);
  if (!needsSetup) return null;
  return (
    <div className="notice" data-tone="warn" role="status">
      <Info size={16} weight="bold" />
      <span>
        This instance isn&apos;t set up yet.{" "}
        <Link href="/setup" style={{ fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 3 }}>
          Finish setup
        </Link>
      </span>
    </div>
  );
}
