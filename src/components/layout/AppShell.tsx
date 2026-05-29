import { Outlet, Navigate } from "react-router-dom";
import { PrimarySidebar } from "./PrimarySidebar";
import { SecondarySidebar } from "./SecondarySidebar";
import { Topbar } from "./Topbar";
import { useCurrentContext } from "@/hooks/useCurrentContext";

export function AppShell() {
  const { loading, notFound } = useCurrentContext();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading project…
      </div>
    );
  }

  // Invalid workspace/project slug in the URL → back to the org picker.
  if (notFound) {
    return <Navigate to="/orgs" replace />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <PrimarySidebar />
      <SecondarySidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto px-6 py-6 lg:px-12 xl:px-20">
          <div className="mx-auto w-full max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
