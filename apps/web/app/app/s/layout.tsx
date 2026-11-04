import { SessionWorkspace } from "@/components/session-workspace";

// The workspace lives in the layout, so moving between sessions keeps every pane mounted.
export default function SessionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SessionWorkspace />
      {children}
    </>
  );
}
