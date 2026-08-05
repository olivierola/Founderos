import { createContext, useContext, useState, useEffect } from "react";
import { Outlet, Navigate, useLocation } from "react-router-dom";
import { PrimarySidebar } from "./PrimarySidebar";
import { SecondarySidebar } from "./SecondarySidebar";
import { AdminSidebar } from "./AdminSidebar";
import { SubTabBar } from "./SubTabBar";
import { Topbar } from "./Topbar";
import { isAdminRoute } from "@/lib/admin-navigation";
import { TopbarTabsProvider, useTopbarTabs } from "./TopbarTabs";
import { TopbarBreadcrumbProvider } from "./TopbarBreadcrumb";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { PermissionsProvider } from "@/lib/permissions";
import { AssistantProvider } from "@/lib/assistant-context";
import { AssistantPanel } from "@/features/ai-agent/AssistantPanel";
import { cn } from "@/lib/utils";

interface ShellNavCtx {
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
  /** Primary (first) sidebar expanded to full width vs icon-rail. Toggled from
   *  both the Topbar panel button and the sidebar's own header button. */
  primaryExpanded: boolean;
  setPrimaryExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
}
const ShellNavContext = createContext<ShellNavCtx | null>(null);

export function useShellNav() {
  const ctx = useContext(ShellNavContext);
  if (!ctx) return { mobileOpen: false, setMobileOpen: () => {}, primaryExpanded: false, setPrimaryExpanded: () => {} };
  return ctx;
}

export function AppShell() {
  const { loading, notFound } = useCurrentContext();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [primaryExpanded, setPrimaryExpanded] = useState(false);
  const { pathname } = useLocation();
  const admin = isAdminRoute(pathname);

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
    <ShellNavContext.Provider value={{ mobileOpen, setMobileOpen, primaryExpanded, setPrimaryExpanded }}>
      <PermissionsProvider>
      <AssistantProvider>
      {/* Soft-black chrome. Outer is a ROW: the left column holds the topbar +
          content; the assistant is a full-height right rail so it reaches up to
          the navbar level (not just the content area). */}
      <div className="flex h-screen w-screen overflow-hidden bg-[#060608]">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopbarTabsProvider>
        <TopbarBreadcrumbProvider>
          <Topbar />

          <div className="flex flex-1 overflow-hidden bg-[#060608]">
            {/* Mobile drawer (fixed, above the rounded block) */}
            {mobileOpen && (
              <>
                <button
                  aria-label="Close menu"
                  onClick={() => setMobileOpen(false)}
                  className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
                />
                <div className="fixed inset-y-0 left-0 z-50 flex md:hidden">
                  {admin ? (
                    <AdminSidebar />
                  ) : (
                    <>
                      <PrimarySidebar />
                      <SecondarySidebar />
                    </>
                  )}
                </div>
              </>
            )}

            {/* Everything under the navbar is ONE rounded panel (sidebars +
                content) floating on the soft-black chrome — the "arrondi". */}
            <div className="flex flex-1 overflow-hidden rounded-t-2xl border-t border-white/10 bg-background">
              {/* Desktop sidebars — the Admin dashboard uses a single sidebar. */}
              <div className="hidden md:flex">
                {admin ? (
                  <AdminSidebar />
                ) : (
                  <>
                    <PrimarySidebar />
                    <SecondarySidebar />
                  </>
                )}
              </div>

              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {/* Page sub-tabs (e.g. agent Settings/Personnaliser sections) — a
                    light bar that starts after the sidebar, not a full-width dark
                    navbar strip. Empty when the page publishes none. */}
                <ContentSubTabs />
                {/* Pages that render a large interactive canvas need the full content
                    width with no horizontal padding and no max-width cap. The pages
                    themselves still scroll/lay out their inner content, so we just
                    relax the wrapper here. */}
                {isFullbleedRoute(pathname) ? (
                  <main className="flex flex-1 flex-col overflow-hidden bg-white dark:bg-background">
                    <Outlet />
                  </main>
                ) : (
                  <main className="flex-1 overflow-y-auto bg-white px-3 py-4 dark:bg-background sm:px-4 sm:py-6 lg:px-6">
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
          </div>
        </TopbarBreadcrumbProvider>
        </TopbarTabsProvider>
        </div>

        {/* Global assistant — full-height right rail, aligned to the navbar top,
            splitting the whole shell (topbar + content) when open. */}
        <AssistantPanel />
      </div>
      </AssistantProvider>
      </PermissionsProvider>
    </ShellNavContext.Provider>
  );
}

/** Page-published sub-tabs, rendered as a light bar at the top of the content
 *  column (after the sidebar) — not in the dark full-width navbar. Renders
 *  nothing when the current page has no sub-tabs. */
function ContentSubTabs() {
  const subTabs = useTopbarTabs();
  if (!subTabs || subTabs.tabs.length === 0) return null;
  return (
    <div className="scrollbar-hide flex h-14 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-3 lg:px-5">
      {subTabs.tabs.map((t) => {
        const Icon = t.icon;
        const active = t.key === subTabs.activeKey;
        return (
          <button
            key={t.key}
            onClick={() => subTabs.onSelect(t.key)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
              active
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            <span className="truncate">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Pages that should render edge-to-edge inside the content area, without the
 *  default px-* / py-* and max-w-6xl wrapper. Add new routes here when they
 *  embed a large interactive canvas. */
function isFullbleedRoute(pathname: string): boolean {
  // Match /app/<ws>/<proj>/devops/infra/<id> and .../devops/workflows/<id>
  // — both render the architecture canvas inside the page.
  if (/\/app\/[^/]+\/[^/]+\/devops\/(infra|workflows)\/[^/]+/.test(pathname)) return true;
  // Office editors (document / spreadsheet / presentation) are full-bleed canvases.
  if (/\/app\/[^/]+\/[^/]+\/office\/(document|spreadsheet|presentation)\/[^/]+/.test(pathname)) return true;
  // E2E Testing: tabbed workspace with a live app preview + agent chatbot.
  if (/\/app\/[^/]+\/[^/]+\/devops\/testing(\/.*)?$/.test(pathname)) return true;
  // Agent ecosystem: full-screen infinite collaboration canvas.
  if (/\/app\/[^/]+\/[^/]+\/agent\/ecosystem$/.test(pathname)) return true;
  // Internal agent detail — full-width chat (scrollbar at the screen edge).
  if (/\/app\/[^/]+\/[^/]+\/agent\/internal\/[^/]+/.test(pathname)) return true;
  // Knowledge collections — full-width folder grid + Document-AI extraction workspace.
  if (/\/app\/[^/]+\/[^/]+\/agent\/collections(\/.*)?$/.test(pathname)) return true;
  // Skill editor (agent/skills/new · agent/skills/<id>/edit) — full-width
  // multi-file authoring surface. The bare agent/skills library stays a normal
  // padded page like the other lists.
  if (/\/app\/[^/]+\/[^/]+\/agent\/skills\/[^/]+/.test(pathname)) return true;
  // Project Inbox: Slack-style full-width chatroom.
  if (/\/app\/[^/]+\/[^/]+\/pm\/inbox(\/.*)?$/.test(pathname)) return true;
  // Project Whiteboard canvas (open board) — full-screen collaborative canvas.
  if (/\/app\/[^/]+\/[^/]+\/pm\/whiteboard(\/.*)?$/.test(pathname)) return true;
  // Simulations — MiroFish-style two-pane full-screen workspace (now its own module).
  if (/\/app\/[^/]+\/[^/]+\/(pm|crm\/)?simulations(\/.*)?$/.test(pathname)) return true;
  // Outils IA: Test runs + Vibe Code are full-bleed workspaces; a repo DETAIL is
  // a full-bleed dotted canvas (the Dépôts LIST stays a normal padded page).
  if (/\/app\/[^/]+\/[^/]+\/test-runs(\/.*)?$/.test(pathname)) return true;
  if (/\/app\/[^/]+\/[^/]+\/vibe-code(\/.*)?$/.test(pathname)) return true;
  if (/\/app\/[^/]+\/[^/]+\/repos\/repo\/[^/]+/.test(pathname)) return true;
  // CRM full record view (crm/workspace/<obj>/<recordId>) — Attio-style.
  if (/\/app\/[^/]+\/[^/]+\/crm\/workspace\/[^/]+\/[^/]+/.test(pathname)) return true;
  // Module project detail view — sidebar + tabs, same pattern as CRM record view.
  if (/\/app\/[^/]+\/[^/]+\/[^/]+\/project\/[^/]+/.test(pathname)) return true;
  return false;
}
