import { createContext, useContext, useState, useEffect } from "react";
import { Outlet, Navigate, useLocation } from "react-router-dom";
import { PrimarySidebar } from "./PrimarySidebar";
import { SecondarySidebar } from "./SecondarySidebar";
import { SubTabBar } from "./SubTabBar";
import { Topbar } from "./Topbar";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { PermissionsProvider } from "@/lib/permissions";

interface ShellNavCtx {
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
}
const ShellNavContext = createContext<ShellNavCtx | null>(null);

export function useShellNav() {
  const ctx = useContext(ShellNavContext);
  if (!ctx) return { mobileOpen: false, setMobileOpen: () => {} };
  return ctx;
}

export function AppShell() {
  const { loading, notFound } = useCurrentContext();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading project…
      </div>
    );
  }

  if (notFound) {
    return <Navigate to="/orgs" replace />;
  }

  return (
    <ShellNavContext.Provider value={{ mobileOpen, setMobileOpen }}>
      <PermissionsProvider>
      <div className="flex h-screen w-screen overflow-hidden bg-background">
        {/* Desktop sidebars */}
        <div className="hidden md:flex">
          <PrimarySidebar />
          <SecondarySidebar />
        </div>

        {/* Mobile drawer */}
        {mobileOpen && (
          <>
            <button
              aria-label="Close menu"
              onClick={() => setMobileOpen(false)}
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
            />
            <div className="fixed inset-y-0 left-0 z-50 flex md:hidden">
              <PrimarySidebar />
              <SecondarySidebar />
            </div>
          </>
        )}

        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar />
          {/* Pages that render a large interactive canvas need the full content
              width with no horizontal padding and no max-width cap. The pages
              themselves still scroll/lay out their inner content, so we just
              relax the wrapper here. */}
          {isFullbleedRoute(pathname) ? (
            <main className="flex flex-1 flex-col overflow-hidden">
              <Outlet />
            </main>
          ) : (
            <main className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 lg:px-12 xl:px-20">
              <div className="mx-auto w-full max-w-6xl">
                {/* SaaS Analytics renders its in-group pages as compact tabs,
                    aligned with the page content; null for other modules. */}
                <SubTabBar />
                <Outlet />
              </div>
            </main>
          )}
        </div>
      </div>
      </PermissionsProvider>
    </ShellNavContext.Provider>
  );
}

/** Pages that should render edge-to-edge inside the content area, without the
 *  default px-* / py-* and max-w-6xl wrapper. Add new routes here when they
 *  embed a large interactive canvas. */
function isFullbleedRoute(pathname: string): boolean {
  // Match /app/<ws>/<proj>/devops/infra/<id> and .../devops/workflows/<id>
  // — both render the architecture canvas inside the page.
  return /\/app\/[^/]+\/[^/]+\/devops\/(infra|workflows)\/[^/]+/.test(pathname);
}
