import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { DocsNav } from "@/components/docs-nav";

export const metadata: Metadata = {
  title: { template: "%s · Cloudly docs", default: "Cloudly docs" },
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="landing">
      <SiteHeader current="docs" />
      <div className="wrap docs">
        <DocsNav />
        {children}
      </div>
    </div>
  );
}
