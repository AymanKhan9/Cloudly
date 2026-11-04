import { ManageNav } from "@/components/manage-nav";

// Settings, split into pages with their own menu, and the pages that used to sit in the sidebar.
export default function ManageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="manage">
      <ManageNav />
      <div className="manage-body">{children}</div>
    </div>
  );
}
