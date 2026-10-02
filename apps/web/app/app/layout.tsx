import { AppProvider } from "@/components/app-context";
import { AppChrome } from "@/components/app-chrome";
import { SessionsSidebar } from "@/components/sessions-sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <div className="app">
        <AppChrome />
        <div className="app-body">
          <SessionsSidebar />
          <main className="page">
            <div className="wrap">{children}</div>
          </main>
        </div>
      </div>
    </AppProvider>
  );
}
