import { SiteHeader } from "@/components/site-header";

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="landing">
      <SiteHeader />
      <main className="wrap page-narrow">{children}</main>
    </div>
  );
}
