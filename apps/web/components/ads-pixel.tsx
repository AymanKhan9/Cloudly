"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { track, trackCustom, trackInstallCopy } from "@/lib/ads-pixel";

/** page_viewed on every route (including client-side navigations), GitHub link clicks, and install command copies. */
export function PageViews() {
  const path = usePathname();
  useEffect(() => {
    track("measure", "page_viewed", { type: "contents", contents: [{ id: path, name: path, content_type: "page" }] });
  }, [path]);

  useEffect(() => {
    const click = (e: MouseEvent) => {
      if ((e.target as Element).closest?.('a[href*="github.com"]')) trackCustom("github_clicked");
    };
    const copy = () => trackInstallCopy(document.getSelection()?.toString() ?? "");
    document.addEventListener("click", click);
    document.addEventListener("auxclick", click); // middle-click / open in new tab
    document.addEventListener("copy", copy);
    return () => {
      document.removeEventListener("click", click);
      document.removeEventListener("auxclick", click);
      document.removeEventListener("copy", copy);
    };
  }, []);
  return null;
}
