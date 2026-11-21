import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeftIcon, ArrowRightIcon, PlusIcon, CaretDownIcon, XIcon, SidebarSimpleIcon,
  ArrowsOutSimpleIcon, ArrowsInSimpleIcon, RocketLaunchIcon, CubeIcon, GearSixIcon, ArrowSquareOutIcon,
  KanbanIcon, RobotIcon, ChatCircleDotsIcon,
} from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { AgentIdentity } from "@/components/AgentIdentity";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import { fetchProjects as fetchMissions, type PjProject } from "@/features/tracker/model";
import { ProjectLogo } from "@/features/tracker/LogoPicker";
import { useWorkbench, itemKey, parseItem } from "./workbench";
import { PANEL_META, OPENABLE, panelTabLabel } from "./WorkbenchPanel";
import { fetchRosterActivity } from "./ServiceDashboardTabs";
import { useCollaboratorInbox } from "./CollaboratorInbox";
import { useLiteAgents, type LiteAgent } from "./live/teams";
import { agentTabHref } from "./agentView";
import { ASSISTANT_NAV_SLOT_ID, useAssistant } from "@/lib/assistant-context";

// La barre du haut du tableau de service.
//
// Trois zones, alignées sur ce qu'il y a dessous :
//   · à gauche, au-dessus de la barre latérale : la marque, puis le sélecteur
//     de tableau ;
//   · au centre, au-dessus du contenu : l'historique, le Live Space épinglé,
//     puis les onglets OUVERTS — agents et missions mêlés, dans l'ordre qu'on
//     leur donne ;
//   · à droite, au-dessus du panneau : les onglets du panneau, de quoi y
//     ouvrir autre chose, et l'élargir.

type TabState = "working" | "waiting" | "error" | "idle";

const DOT: Record<TabState, { cls: string; label: string }> = {
  working: { cls: "bg-emerald-400", label: "au travail" },
  waiting: { cls: "bg-amber-400", label: "vous attend" },
  error: { cls: "bg-red-500", label: "en échec" },
  idle: { cls: "", label: "disponible" },
};

/** Ce que font les agents OUVERTS — rien que ceux-là, pour qu'une barre
 *  d'onglets ne sonde pas tout le service. */
function useTabStates(dashboardId: string, ids: string[]): Map<string, TabState> {
  const { data: activity } = useQuery({
    queryKey: ["sd_tab_activity", dashboardId, ids.join(",")],
    enabled: ids.length > 0,
    refetchInterval: 30_000,
    queryFn: () => fetchRosterActivity(ids),
  });
  const { data: inbox } = useCollaboratorInbox(dashboardId);
  const waiting = new Set((inbox ?? []).filter((i) => i.kind === "approval" || i.kind === "question").map((i) => i.agent_id));
  const out = new Map<string, TabState>();
  for (const id of ids) {
    const a = activity?.get(id);
    out.set(id, waiting.has(id) ? "waiting" : a?.live ? "working" : a?.lastStatus === "failed" ? "error" : "idle");
  }
  return out;
}

/** Un conteneur qui défile en largeur et s'estompe sur le bord qui cache
 *  encore des onglets — sans quoi rien ne dit qu'il y en a d'autres. */
function FadingScroller({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const count = Children.count(children);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Ne réécrire l'état que s'il change : sinon chaque mesure relancerait
    // un rendu, qui relancerait une mesure.
    const update = () => {
      const left = el.scrollLeft > 2;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setEdges((p) => (p.left === left && p.right === right ? p : { left, right }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    el.addEventListener("scroll", update, { passive: true });
    // La molette verticale fait défiler les onglets en largeur.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener("scroll", update); el.removeEventListener("wheel", onWheel); };
  }, [count]);
  const mask = edges.left || edges.right
    ? `linear-gradient(to right, ${edges.left ? "transparent, black 28px" : "black"}, ${edges.right ? "black calc(100% - 28px), transparent" : "black"})`
    : undefined;
  return (
    <div
      ref={ref}
      className={cn("scrollbar-hide flex min-w-0 items-center gap-0.5 overflow-x-auto", className)}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {children}
    </div>
  );
}

/** Un onglet ouvert, tel que la barre le montre. */
interface OpenTab {
  key: string;
  kind: "agent" | "mission";
  id: string;
  label: string;
  leading: ReactNode;
  href: string;
  active: boolean;
  state: TabState;
}

export function DashboardNavbar({ selector, leftWidth, collapsed, base, dashboardId, liveActive }: {
  selector: ReactNode;
  /** La largeur de la barre latérale, pour que la zone de gauche s'y aligne. */
  leftWidth: number;
  collapsed: boolean;
  base: string;
  dashboardId: string;
  /** Le Live Space est la page affichée. */
  liveActive: boolean;
}) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  useLocation(); // l'état de l'historique se relit à chaque navigation
  const wb = useWorkbench();
  const assistant = useAssistant();
  const { data: agents } = useLiteAgents(dashboardId);
  const { data: missions } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchMissions(dashboardId),
  });
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);

  const agentById = new Map((agents ?? []).map((a) => [a.id, a]));
  const missionById = new Map((missions ?? []).map((m) => [m.id, m]));
  const openItems = wb?.openItems ?? [];
  const openAgentIds = openItems.filter((k) => k.startsWith("agent:")).map((k) => k.slice(6));
  const states = useTabStates(dashboardId, openAgentIds);
  if (!wb) return null;

  // Un agent archivé, une mission supprimée : leur onglet disparaît sans trou.
  const tabs: OpenTab[] = openItems.flatMap((key): OpenTab[] => {
    const { kind, id } = parseItem(key);
    if (kind === "agent") {
      const a = agentById.get(id);
      if (!a) return [];
      return [{
        key, kind, id, label: a.name, href: agentTabHref(base, id),
        active: wb.activeAgentId === id, state: states.get(id) ?? "idle",
        leading: <AgentIdentity url={a.avatar_url} seed={a.name} size={18} rounded="rounded-md" interactive={false} />,
      }];
    }
    const m = missionById.get(id);
    if (!m) return [];
    return [{
      key, kind, id, label: m.name, href: `${base}/projects/${id}`,
      active: wb.activeMissionId === id, state: "idle",
      leading: (
        <span className="flex h-[18px] w-[18px] items-center justify-center rounded-md bg-muted/80">
          <ProjectLogo logo={m.logo_props} fallback={m.identifier} size={12} />
        </span>
      ),
    }];
  });
  const closedAgents = (agents ?? []).filter((a) => !openItems.includes(itemKey("agent", a.id)));
  const closedMissions = (missions ?? []).filter((m) => !openItems.includes(itemKey("mission", m.id)));

  // React Router range sa position dans `history.state.idx` : à 0, il n'y a
  // pas de page précédente DANS l'app, et « précédent » sortirait de l'app.
  const histIdx = (window.history.state as { idx?: number } | null)?.idx ?? 0;

  /** Fermer l'onglet affiché rend la main au voisin, comme un navigateur. */
  const leave = (closing: string[]) => {
    const shown = tabs.find((t) => t.active);
    if (!shown || !closing.includes(shown.key)) return;
    const remaining = tabs.filter((t) => !closing.includes(t.key));
    const i = tabs.findIndex((t) => t.key === shown.key);
    const next = remaining.find((_, j) => j >= i) ?? remaining[remaining.length - 1];
    navigate(next ? next.href : shown.kind === "mission" ? `${base}/projects` : `${base}/agents`);
  };
  const closeOne = (key: string) => { leave([key]); wb.closeItem(key); };

  return (
    <header className="flex h-12 shrink-0 select-none items-center pr-2">
      {/* ── Gauche : la marque, puis le tableau ── */}
      <div
        className={cn("flex h-full shrink-0 items-center", collapsed ? "justify-center" : "gap-1.5 pl-3 pr-2")}
        style={{ width: leftWidth }}
      >
        <button
          type="button" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}`)}
          title="Accueil Agent company" aria-label="Accueil Agent company"
          className={cn(
            "flex shrink-0 items-center justify-center rounded-lg text-foreground transition-opacity hover:opacity-75",
            collapsed ? "h-9 w-9" : "h-8 w-7",
          )}
        >
          <Logo size={collapsed ? 20 : 18} color="currentColor" />
        </button>
        {!collapsed && (
          <>
            <span className="text-[15px] font-light text-muted-foreground/50">/</span>
            <div className="min-w-0">{selector}</div>
          </>
        )}
      </div>

      {/* ── Centre : l'historique, le Live, puis les onglets ouverts ── */}
      <div className="flex h-full min-w-0 flex-1 items-center gap-1">
        {/* L'historique hors de la barre latérale : il agit sur le CONTENU,
            c'est au-dessus du contenu qu'on le cherche. */}
        <div className="flex shrink-0 items-center">
          {collapsed && <div className="mr-1">{selector}</div>}
          <NavIcon title="Précédent" disabled={histIdx <= 0} onClick={() => navigate(-1)}><ArrowLeftIcon className="h-4 w-4" /></NavIcon>
          <NavIcon title="Suivant" onClick={() => navigate(1)}><ArrowRightIcon className="h-4 w-4" /></NavIcon>
        </div>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-border/80" />

        <button
          type="button" onClick={() => navigate(`${base}/live`)}
          title="Live Space — vos agents au travail, en direct"
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-colors",
            liveActive ? "bg-muted/80 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          <span className="relative flex">
            <CubeIcon className="h-4 w-4" weight={liveActive ? "fill" : "regular"} />
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-red-500 ring-2 ring-[hsl(var(--sd-ground))]" />
          </span>
          Live
        </button>

        <FadingScroller>
          {tabs.map((t, i) => (
            <ItemTab
              key={t.key} tab={t}
              dragging={dragKey === t.key}
              dropMarker={dragKey !== null && dragKey !== t.key && dropBefore === t.key}
              onOpen={() => navigate(t.href)}
              onClose={() => closeOne(t.key)}
              onCloseOthers={() => { leave(tabs.filter((x) => x.key !== t.key).map((x) => x.key)); wb.closeOtherItems(t.key); }}
              onCloseRight={() => { leave(tabs.slice(i + 1).map((x) => x.key)); wb.closeItemsRight(t.key); }}
              canCloseRight={i < tabs.length - 1}
              canCloseOthers={tabs.length > 1}
              extra={t.kind === "agent" ? [
                { label: "Réglages de l'agent", icon: GearSixIcon, run: () => { navigate(t.href); wb.openTab("agent-settings"); } },
                { label: "Page de configuration", icon: ArrowSquareOutIcon, run: () => navigate(`${base}/agent-config/${t.id}`) },
              ] : [
                { label: "Work items", icon: KanbanIcon, run: () => navigate(`${base}/projects/${t.id}/issues`) },
                { label: "Équipage", icon: RobotIcon, run: () => navigate(`${base}/projects/${t.id}/crew`) },
              ]}
              onDragStart={() => setDragKey(t.key)}
              onDragOverTab={(before) => setDropBefore(before ? t.key : (tabs[i + 1]?.key ?? null))}
              onDragEnd={() => {
                if (dragKey && dropBefore !== undefined) wb.moveItem(dragKey, dropBefore);
                setDragKey(null); setDropBefore(undefined);
              }}
            />
          ))}
        </FadingScroller>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button" title="Ouvrir un onglet" aria-label="Ouvrir un onglet"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            >
              <PlusIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[70vh] w-64 overflow-y-auto rounded-xl p-1.5">
            <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">Agents</DropdownMenuLabel>
            {closedAgents.length === 0 && (
              <p className="px-2 pb-1 text-[12px] text-muted-foreground">Tous les agents sont ouverts.</p>
            )}
            {closedAgents.map((a) => (
              <DropdownMenuItem key={a.id} className="rounded-lg" onSelect={() => navigate(`${base}/agent/${a.id}`)}>
                <AgentIdentity url={a.avatar_url} seed={a.name} size={18} rounded="rounded-md" interactive={false} className="mr-2" />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">Missions</DropdownMenuLabel>
            {(missions ?? []).length === 0 && (
              <p className="px-2 pb-1 text-[12px] text-muted-foreground">Aucune mission pour l'instant.</p>
            )}
            {(missions ?? []).length > 0 && closedMissions.length === 0 && (
              <p className="px-2 pb-1 text-[12px] text-muted-foreground">Toutes les missions sont ouvertes.</p>
            )}
            {closedMissions.map((m: PjProject) => (
              <DropdownMenuItem key={m.id} className="rounded-lg" onSelect={() => navigate(`${base}/projects/${m.id}`)}>
                <span className="mr-2 flex h-[18px] w-[18px] items-center justify-center rounded-md bg-muted">
                  <ProjectLogo logo={m.logo_props} fallback={m.identifier} size={12} />
                </span>
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="rounded-lg" onSelect={() => navigate(`${base}/agents/new`)}>
              <RocketLaunchIcon className="mr-2 h-4 w-4" /> Déployer un nouvel agent
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {tabs.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button" title="Onglets ouverts" aria-label="Onglets ouverts"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              >
                <CaretDownIcon className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 rounded-xl p-1.5">
              <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">
                {tabs.length} onglets ouverts
              </DropdownMenuLabel>
              {tabs.map((t) => (
                <DropdownMenuItem key={t.key} className="rounded-lg" onSelect={() => navigate(t.href)}>
                  <span className="mr-2 flex">{t.leading}</span>
                  <span className={cn("min-w-0 flex-1 truncate", t.active && "font-medium")}>{t.label}</span>
                  {t.state !== "idle" && <span className={cn("h-1.5 w-1.5 rounded-full", DOT[t.state].cls)} title={DOT[t.state].label} />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="rounded-lg" onSelect={() => { leave(tabs.map((t) => t.key)); wb.closeAllItems(); }}>
                <XIcon className="mr-2 h-4 w-4" /> Fermer tous les onglets
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="min-w-2 flex-1" />

        {/* L'assistant : ouvert, il partage la zone de contenu et prend la
            colonne de droite — sa navigation est la zone de la barre au-dessus. */}
        {!assistant.open && (
          <button
            type="button" onClick={() => assistant.setOpen(true)}
            title="Ouvrir l'assistant" aria-label="Ouvrir l'assistant"
            className="mr-1 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border/70 px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground"
          >
            <ChatCircleDotsIcon className="h-4 w-4 text-[hsl(var(--primary-soft))]" weight="fill" />
            Assistant
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            // Le panneau et l'assistant se partagent la même colonne.
            if (assistant.open) { assistant.setOpen(false); wb.setPanelOpen(true); return; }
            wb.togglePanel();
          }}
          title={wb.panelOpen && !assistant.open ? "Masquer le panneau" : "Afficher le panneau"}
          aria-label={wb.panelOpen && !assistant.open ? "Masquer le panneau" : "Afficher le panneau"}
          aria-pressed={wb.panelOpen && !assistant.open}
          className={cn(
            "mr-1 hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors lg:flex",
            wb.panelOpen && !assistant.open ? "text-foreground hover:bg-muted/70" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
          )}
        >
          <SidebarSimpleIcon className="h-4 w-4 -scale-x-100" weight={wb.panelOpen && !assistant.open ? "fill" : "regular"} />
        </button>
      </div>

      {/* ── Droite : la navigation de l'assistant, quand il est ouvert ── */}
      {assistant.open && (
        <div id={ASSISTANT_NAV_SLOT_ID} className="ml-2 hidden h-full shrink-0 items-center lg:flex" style={{ width: assistant.width }} />
      )}

      {/* ── Droite : l'en-tête du panneau ── */}
      {wb.panelOpen && !assistant.open && (
        <div className="ml-2 hidden h-full shrink-0 items-center gap-1 lg:flex" style={{ width: wb.panelWidth }}>
          <FadingScroller className="flex-1">
            {wb.tabs.map((t) => {
              const Icon = PANEL_META[t.kind].icon;
              const active = wb.activeTab?.id === t.id;
              return (
                <div
                  key={t.id}
                  onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); wb.closeTab(t.id); } }}
                  className={cn(
                    "group/ptab flex h-8 shrink-0 items-center rounded-lg pl-2.5 pr-1 text-[13px] transition-colors",
                    active ? "bg-muted/80 text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <button type="button" onClick={() => wb.activateTab(t.id)} className="flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5 shrink-0" weight={active ? "fill" : "regular"} />
                    <span className={cn("max-w-[180px] truncate", active && "font-medium")}>{panelTabLabel(t)}</span>
                  </button>
                  <button
                    type="button" onClick={() => wb.closeTab(t.id)}
                    title="Fermer l'onglet" aria-label={`Fermer ${panelTabLabel(t)}`}
                    className={cn(
                      "ml-1 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-background/60 hover:text-foreground",
                      active ? "opacity-100" : "opacity-0 group-hover/ptab:opacity-100",
                    )}
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </FadingScroller>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button" title="Ouvrir dans le panneau" aria-label="Ouvrir dans le panneau"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60 rounded-xl p-1.5">
              <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">Ouvrir dans le panneau</DropdownMenuLabel>
              {OPENABLE.map((k) => {
                const meta = PANEL_META[k];
                const already = wb.tabs.some((t) => t.kind === k);
                return (
                  <DropdownMenuItem key={k} className="rounded-lg" onSelect={() => wb.openTab(k)}>
                    <meta.icon className="mr-2 h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                    {already && <span className="text-[11px] text-muted-foreground">ouvert</span>}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <NavIcon title={wb.wide ? "Réduire le panneau" : "Élargir le panneau"} onClick={wb.toggleWide}>
            {wb.wide ? <ArrowsInSimpleIcon className="h-4 w-4" /> : <ArrowsOutSimpleIcon className="h-4 w-4" />}
          </NavIcon>
        </div>
      )}
    </header>
  );
}

function ItemTab({
  tab, dragging, dropMarker, onOpen, onClose, onCloseOthers, onCloseRight,
  canCloseOthers, canCloseRight, extra, onDragStart, onDragOverTab, onDragEnd,
}: {
  tab: OpenTab; dragging: boolean; dropMarker: boolean;
  onOpen: () => void; onClose: () => void; onCloseOthers: () => void; onCloseRight: () => void;
  canCloseOthers: boolean; canCloseRight: boolean;
  /** Les raccourcis propres à ce genre d'onglet, en tête du menu contextuel. */
  extra: Array<{ label: string; icon: typeof GearSixIcon; run: () => void }>;
  onDragStart: () => void;
  /** `true` : on dépose AVANT cet onglet ; `false` : après. */
  onDragOverTab: (before: boolean) => void;
  onDragEnd: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          draggable
          onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", tab.key); onDragStart(); }}
          onDragOver={(e) => {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            onDragOverTab(e.clientX < r.left + r.width / 2);
          }}
          onDrop={(e) => e.preventDefault()}
          onDragEnd={onDragEnd}
          // Le clic du milieu ferme, comme dans un navigateur.
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
          title={tab.kind === "agent" ? `${tab.label} — ${DOT[tab.state].label}` : `Mission · ${tab.label}`}
          className={cn(
            "group/tab relative flex h-8 shrink-0 items-center rounded-lg pl-2 pr-1 text-[13px] transition-[background-color,color,opacity]",
            tab.active ? "bg-muted/80 text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            dragging && "opacity-40",
          )}
        >
          {dropMarker && <span className="absolute -left-[2px] top-1.5 h-5 w-0.5 rounded-full bg-primary" />}
          <button type="button" onClick={onOpen} className="flex min-w-0 items-center gap-2">
            <span className="relative flex shrink-0">
              {tab.leading}
              {tab.state !== "idle" && (
                <span className={cn(
                  "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-[hsl(var(--sd-ground))]",
                  DOT[tab.state].cls, tab.state === "working" && "animate-pulse",
                )} />
              )}
            </span>
            <span className={cn("max-w-[150px] truncate", tab.active && "font-medium")}>{tab.label}</span>
          </button>
          <button
            type="button" onClick={onClose}
            title="Fermer l'onglet" aria-label={`Fermer ${tab.label}`}
            className={cn(
              "ml-1 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-background/60 hover:text-foreground",
              tab.active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
            )}
          >
            <XIcon className="h-3 w-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56 rounded-xl p-1.5">
        {extra.map((x) => (
          <ContextMenuItem key={x.label} className="rounded-lg" onSelect={x.run}>
            <x.icon className="mr-2 h-4 w-4" /> {x.label}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem className="rounded-lg" onSelect={onClose}>
          <XIcon className="mr-2 h-4 w-4" /> Fermer
        </ContextMenuItem>
        <ContextMenuItem className="rounded-lg" disabled={!canCloseOthers} onSelect={onCloseOthers}>
          Fermer les autres onglets
        </ContextMenuItem>
        <ContextMenuItem className="rounded-lg" disabled={!canCloseRight} onSelect={onCloseRight}>
          Fermer les onglets à droite
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function NavIcon({ title, onClick, disabled, children }: {
  title: string; onClick: () => void; disabled?: boolean; children: ReactNode;
}) {
  return (
    <button
      type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}
