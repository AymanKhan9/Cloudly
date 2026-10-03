"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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
    <div className="alert" role="status">
      This instance isn't set up yet.&nbsp;
      <Link href="/setup" style={{ fontWeight: 600 }}>
        Finish setup
      </Link>
    </div>
  );
}
