import { createContext, useContext, useState, useEffect } from "react";
import { Outlet, Navigate, useLocation } from "react-router-dom";
import { PrimarySidebar } from "./PrimarySidebar";
import { SecondarySidebar } from "./SecondarySidebar";
import { SubTabBar } from "./SubTabBar";
import { Topbar } from "./Topbar";
import { TopbarTabsProvider, useTopbarTabs } from "./TopbarTabs";
import { TopbarBreadcrumbProvider } from "./TopbarBreadcrumb";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { PermissionsProvider } from "@/lib/permissions";
import { AssistantProvider } from "@/lib/assistant-context";
import { AssistantPanel } from "@/features/ai-agent/AssistantPanel";
import { CoachHandoff } from "@/features/auth/CoachHandoff";
import { cn } from "@/lib/utils";
import { useLockDocumentScroll } from "@/hooks/useLockDocumentScroll";
import { useBrandTheme } from "@/hooks/useBrandTheme";
import { usePressFeedback } from "@/hooks/usePressFeedback";

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
  useLockDocumentScroll();
  // Chaque bouton s'enfonce sous le doigt (voir usePressFeedback).
  usePressFeedback();
  // La même DA que les tableaux de service : violet adouci, gris charbon.
  useBrandTheme();
  const { loading, notFound } = useCurrentContext();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [primaryExpanded, setPrimaryExpanded] = useState(false);
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
    <ShellNavContext.Provider value={{ mobileOpen, setMobileOpen, primaryExpanded, setPrimaryExpanded }}>
      <PermissionsProvider>
      <AssistantProvider>
      {/* La DA des tableaux de service (ServiceDashboardShell) : un FOND
          (--sd-ground) sur lequel la navigation est posée sans cadre, et le
          contenu sur une carte arrondie à côté. Plus de bandeau marine : il
          faisait de l'AI Workforce une autre application que les services
          qu'on ouvre depuis lui. L'assistant est dans la rangée du contenu : ouvert,
          il en prend la colonne de droite, comme dans un service. */}
      <div className="flex h-screen w-full overflow-hidden bg-[hsl(var(--sd-ground))] text-foreground">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopbarTabsProvider>
        <TopbarBreadcrumbProvider>
          <Topbar />

          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* Mobile drawer (fixed, above the content card). Les barres n'ont
                pas de fond propre : le tiroir porte celui de la coque. */}
            {mobileOpen && (
              <>
                <button
                  aria-label="Close menu"
                  onClick={() => setMobileOpen(false)}
                  className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
                />
                <div className="fixed inset-y-0 left-0 z-50 flex bg-[hsl(var(--sd-ground))] pt-2 shadow-xl md:hidden">
                  <PrimarySidebar />
                  <SecondarySidebar />
                </div>
              </>
            )}

            {/* Desktop sidebars — posées sur le fond, comme celle d'un service. */}
            <div className="hidden md:flex">
              <PrimarySidebar />
              <SecondarySidebar />
            </div>

            {/* Le contenu : UNE carte arrondie, sous la barre du haut, sans
                marge en haut — c'est la barre qui donne l'air. */}
            <div className="flex min-w-0 flex-1 gap-2 pb-2 pr-2 pl-2 md:pl-0">
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-background">
                {/* Page sub-tabs (e.g. agent Settings/Personnaliser sections) —
                    the top strip of the card. Empty when the page publishes none. */}
                <ContentSubTabs />
                {/* Pages that render a large interactive canvas need the full content
                    width with no horizontal padding and no max-width cap. The pages
                    themselves still scroll/lay out their inner content, so we just
                    relax the wrapper here. */}
                {isFullbleedRoute(pathname) ? (
                  <main className="flex flex-1 flex-col overflow-hidden bg-background">
                    <Outlet />
                  </main>
                ) : (
                  <main className="flex-1 overflow-y-auto bg-background px-3 py-4 sm:px-4 sm:py-6 lg:px-6">
                    <div className={cn("mx-auto w-full", isWideRoute(pathname) ? "max-w-[1600px]" : "max-w-6xl")}>
                      {/* SaaS Analytics renders its in-group pages as compact tabs,
                          aligned with the page content; null for other modules. */}
                      <SubTabBar />
                      <Outlet />
                    </div>
                  </main>
                )}
              </div>
              {/* L'assistant partage la zone de contenu : la page se divise,
                  rien ne la recouvre. */}
              <AssistantPanel variant="docked" />
            </div>
          </div>
        </TopbarBreadcrumbProvider>
        </TopbarTabsProvider>
        </div>

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
    // Les onglets d'une page, en tête de la carte — le même dessin que les
    // onglets de la barre d'un tableau de service (Live, agents ouverts).
    <div className="scrollbar-hide flex h-12 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 bg-background px-2.5 lg:px-4">
      {subTabs.tabs.map((t) => {
        const Icon = t.icon;
        const active = t.key === subTabs.activeKey;
        return (
          <button
            key={t.key}
            onClick={() => subTabs.onSelect(t.key)}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-colors",
              active
                ? "bg-muted/80 font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
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

/**
 * Les pages de tableau de bord, qui ont besoin de place pour leurs tables.
 *
 * Elles gardent le cadre commun — padding, défilement — mais pas le plafond de
 * largeur : 1152 px conviennent à un texte qu'on lit, pas à six tuiles, un
 * radar et des tables de huit colonnes, qui s'y retrouvent comprimées entre
 * deux marges vides.
 */
function isWideRoute(pathname: string): boolean {
  return /\/app\/[^/]+\/[^/]+\/hq(\/|$)/.test(pathname);
}

/** Pages that should render edge-to-edge inside the content area, without the
 *  default px-* / py-* and max-w-6xl wrapper. Add new routes here when they
 *  embed a large interactive canvas. */
function isFullbleedRoute(pathname: string): boolean {
  // Match /app/<ws>/<proj>/devops/infra/<id> and .../devops/workflows/<id>
  // — both render the architecture canvas inside the page.
  if (/\/app\/[^/]+\/[^/]+\/devops\/(infra|workflows)\/[^/]+/.test(pathname)) return true;
  // Agent artifact editors (document / spreadsheet / presentation) are full-bleed canvases.
  if (/\/app\/[^/]+\/[^/]+\/artifact\/(document|spreadsheet|presentation)\/[^/]+/.test(pathname)) return true;
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
  // Simulations — MiroFish-style two-pane full-screen workspace (now its own module).
  if (/\/app\/[^/]+\/[^/]+\/(pm|crm\/)?simulations(\/.*)?$/.test(pathname)) return true;
  // Outils IA: Test runs + Vibe Code are full-bleed workspaces; a repo DETAIL is
  // a full-bleed dotted canvas (the Dépôts LIST stays a normal padded page).
  if (/\/app\/[^/]+\/[^/]+\/test-runs(\/.*)?$/.test(pathname)) return true;
  if (/\/app\/[^/]+\/[^/]+\/vibe-code(\/.*)?$/.test(pathname)) return true;
  if (/\/app\/[^/]+\/[^/]+\/repos\/repo\/[^/]+/.test(pathname)) return true;
  // Module project detail view — sidebar + tabs.
  if (/\/app\/[^/]+\/[^/]+\/[^/]+\/project\/[^/]+/.test(pathname)) return true;
  return false;
}
