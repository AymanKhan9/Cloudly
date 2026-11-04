import { ManageSelect } from "@/components/manage-nav";

// Settings pages. Their menu takes the sidebar's place (see components/app-shell.tsx).
export default function ManageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="manage">
      <ManageSelect />
      <div className="manage-body">{children}</div>
    </div>
  );
}
