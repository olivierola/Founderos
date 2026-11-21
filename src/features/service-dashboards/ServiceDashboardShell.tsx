import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
// Phosphor everywhere in this dashboard — one icon family, consistent weights
// (the app's Admin nav already uses it).
import {
  HouseIcon, RobotIcon, BrainIcon, GearSixIcon, ChartBarIcon, CalendarDotsIcon, FilesIcon,
  ChatsCircleIcon, GraphIcon, DatabaseIcon, SlidersIcon, SquaresFourIcon,
  SparkleIcon, WarningIcon, MagnifyingGlassIcon, PlusIcon, CheckIcon, CaretDownIcon,
  DotsThreeIcon, PencilSimpleIcon, TrashIcon, HashIcon, SidebarSimpleIcon, UsersThreeIcon,
  TargetIcon, GlobeIcon, FlowArrowIcon, KanbanIcon, FlagIcon,
  NotePencilIcon, PushPinIcon, PackageIcon, CaretUpDownIcon, CubeIcon,
  PushPinSlashIcon, BookOpenIcon, TrayIcon, WrenchIcon, RocketLaunchIcon, PlugsConnectedIcon, StackIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AgentIdentity } from "@/components/AgentIdentity";
import { AgentOrb } from "@/components/AgentOrb";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { DASHBOARDS, dashboardLandingSlug } from "@/lib/navigation";
import { ADMIN_LANDING } from "@/lib/admin-navigation";
import { cn } from "@/lib/utils";
import { useLockDocumentScroll } from "@/hooks/useLockDocumentScroll";
import { useBrandTheme } from "@/hooks/useBrandTheme";
import { usePressFeedback } from "@/hooks/usePressFeedback";
import { rememberServiceDashboard } from "@/app/PlaneLanding";
import {
  fetchServiceDashboards, createServiceDashboard, deleteServiceDashboard, fetchRooms, renameRoom, deleteRoom,
  createRoom, deleteEmptyRooms, DEFAULT_DASHBOARD_SETTINGS,
  type ServiceDashboard, type Room,
} from "./model";
import { RoomView } from "./RoomView";
import { useCollaboratorInbox } from "./CollaboratorInbox";
import { SidebarProfileFooter } from "./SidebarProfileFooter";
import { SidebarGetStarted } from "./GetStarted";
import { DocsPage } from "./docs/DocsPage";
import {
  AgentsTab, WorkspaceMemoryTab, AgentDetailInDashboard,
  AgentConfigInDashboard,
} from "./ServiceDashboardTabs";
import { TrackerTab } from "@/features/tracker/TrackerTab";
import { fetchProjects as fetchTrackerProjects } from "@/features/tracker/model";
import { ProjectLogo } from "@/features/tracker/LogoPicker";
import { ComposioCatalog } from "@/features/integrations/ComposioCatalog";
import { CustomConnectorsPage } from "@/features/custom-connectors/CustomConnectorsPage";
import { PoolsTab } from "@/features/resource-pools/PoolsTab";
import { TeamzTab } from "@/features/teamz/TeamzTab";
import { WorkflowsList } from "@/features/workflows/WorkflowsList";
import { WorkflowDocument } from "@/features/workflows/WorkflowDocument";
import { DashboardSettingsTab, type DashboardSettingsSection } from "./DashboardSettings";
import { CreateAgentPage } from "./CreateAgent";
import { PublicAgentInDashboard } from "./PublicAgentInDashboard";
import { fetchAgentFolders } from "./agentFolders";
import { DashboardTile } from "./dashboardIcons";
import { ThemeMenu } from "@/components/ThemeMenu";
import { MachinesTab } from "@/features/machines/MachinesTab";
import { AssistantProvider, useAssistant } from "@/lib/assistant-context";
import { AssistantPanel } from "@/features/ai-agent/AssistantPanel";
import { useConfirm } from "@/components/ConfirmProvider";
import { WorkbenchProvider, useWorkbench } from "./workbench";
import { DashboardNavbar } from "./DashboardNavbar";
import { WorkbenchPanelBody } from "./WorkbenchPanel";
import { LiveSpaceTab } from "./live/LiveSpace";
import { DashboardsPage } from "@/features/agent-dashboards/DashboardsPage";
import { DashboardPage } from "@/features/agent-dashboards/DashboardPage";
import { useLiteAgents } from "./live/teams";
import { applyParameters as applyDashboardParameters, fetchDashboards as fetchServiceDashboardsList } from "@/features/agent-dashboards/api";
import { SECTIONS, MAIN_SECTIONS, SETTINGS_SECTION, itemActive, lastInSection, rememberInSection, sectionOf, type Section, type SectionKey } from "./navSections";

// ── Structure ────────────────────────────────────────────────────────────────
// UNE seule barre latérale. Elle a longtemps tenu sur deux colonnes — un rail
// d'icônes pour les grandes sections, un panneau contextuel pour la navigation
// de la section choisie — et il fallait deviner quel rail portait une page
// avant de la voir. Tout est désormais listé au même endroit : le travail
// (Intelligence Space) et ce sur quoi il s'appuie, puis les rooms. Les
// paramètres et la documentation sont dans le menu du profil, en bas.
// Repliée, elle se réduit à une bande étroite qui garde le sélecteur de
// tableau, de quoi la redéployer et le compte.
//
// L'espace « Assistant » (Home, Missions, Schedules, rooms, messages) a été
// retiré : l'Intelligence Space porte déjà le travail et les rooms, et les
// conversations avec un agent s'ouvrent depuis l'onglet Agents. Ses adresses
// redirigent vers l'Intelligence Space (voir plus bas).

export function ServiceDashboardPage() {
  // Même verrou que l'AppShell : cette coque est hors d'AppShell et doit donc
  // le poser elle-même.
  useLockDocumentScroll();
  // Chaque bouton s'enfonce sous le doigt (voir usePressFeedback).
  usePressFeedback();
  const { workspaceSlug, projectSlug, dashboardId, tab, sub, leaf } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const navigate = useNavigate();
  const base = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;

  // Le tableau ouvert devient la page d'arrivée de la prochaine visite : on
  // reprend où l'on en était (voir PlaneLanding).
  useEffect(() => {
    if (projectId && dashboardId) rememberServiceDashboard(projectId, dashboardId);
  }, [projectId, dashboardId]);

  // Le violet de marque et les gris charbon, le temps qu'on est ici — comme
  // dans l'AI Workforce (voir useBrandTheme).
  useBrandTheme();

  const { data: dashboards } = useQuery({
    queryKey: ["service_dashboards", projectId],
    enabled: !!projectId,
    queryFn: () => fetchServiceDashboards(projectId!),
  });
  const current = (dashboards ?? []).find((d) => d.id === dashboardId) ?? null;
  const settings = current?.settings ?? DEFAULT_DASHBOARD_SETTINGS;

  const isRoom = tab === "room" && !!sub;
  const isAgent = tab === "agent" && !!sub;
  // An agent's configuration is a page of its own, not a panel over its chat.
  const isAgentConfig = tab === "agent-config" && !!sub;
  // A public (customer-facing) agent's own pages — the builder that used to be
  // a separate module route (/agent/builder/:id/:tab), now hosted here.
  const isPublicAgent = tab === "public" && !!sub;
  const isCreateAgent = tab === "agents" && sub === "new";
  // /workflows/:id opens the canvas, which owns the whole content area.
  const isWorkflowEditor = tab === "workflows" && !!sub;
  // Unknown tabs (old links, e.g. the retired /new-room) fall back to the
  // dashboard's landing page rather than rendering an empty content area.
  const KNOWN = ["home", "agents", "dashboards", "live", "teamz", "schedules", "dashboard", "missions", "projects", "memory", "artifacts", "connectors", "pools", "workflows", "machines", "settings", "docs"];
  const activeTab = isRoom ? "room"
    : isAgent ? "agent"
    : isAgentConfig ? "agent-config"
    : isPublicAgent ? "public"
    : (tab && KNOWN.includes(tab) ? tab : settings.landing);

  // Une mission ouverte devient un onglet de la barre du haut, comme un agent.
  // `sub` porte aussi les vues du suivi (inbox, analytics…) : seule une
  // mission CONNUE compte — même requête que la barre latérale, même cache.
  const { data: missions } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    enabled: !!dashboardId,
    queryFn: () => fetchTrackerProjects(dashboardId!),
  });
  const activeMissionId = activeTab === "projects" && sub && (missions ?? []).some((m) => m.id === sub) ? sub : null;

  // Deux onglets ont déménagé dans le module de travail — le Dashboard vers ses
  // analytics, les Artefacts vers son Wiki.
  // où il est devenu l'onglet « Agents ». On REDIRIGE plutôt que de retirer le
  // slug de KNOWN : les liens déjà partagés continuent d'arriver quelque part,
  // et le réglage « page d'atterrissage » d'un service qui pointait dessus ne
  // laisse pas son propriétaire devant un écran vide.
  useEffect(() => {
    if (activeTab === "dashboard") navigate(`${base}/projects/analytics`, { replace: true });
    // Les artefacts ont rejoint le Wiki : mêmes documents, même endroit.
    if (activeTab === "artifacts") navigate(`${base}/projects/wiki`, { replace: true });
    // L'ancien espace Assistant : son travail et ses rooms sont dans l'Intelligence Space.
    if (activeTab === "home" || activeTab === "missions" || activeTab === "schedules") navigate(`${base}/projects`, { replace: true });
    // La liste Memories a quitté Ressources : ses souvenirs sont dans le graphe.
    if (activeTab === "memory" && sub === "memories") navigate(`${base}/memory/graph`, { replace: true });
  }, [activeTab, sub, base, navigate]);

  /**
   * QUI fait défiler : le contenu, ou son conteneur — jamais les deux.
   *
   * Deux familles d'écrans cohabitent ici, et elles ne se gouvernent pas
   * pareil :
   *
   *   · les pages en `min-h-full` (Assistant, Agents, Documentation, Workflows,
   *     Réglages) s'étirent avec leur contenu et comptent sur `<main>` pour
   *     défiler ;
   *   · les écrans en `h-full` (tout le module de travail, la mémoire, une
   *     room, la fiche d'un agent) se bornent à la hauteur disponible et
   *     portent LEUR PROPRE zone défilante à l'intérieur.
   *
   * Laisser `overflow-y-auto` sur `<main>` dans le second cas produit deux
   * conteneurs de défilement imbriqués — donc DEUX BARRES côte à côte, dont
   * l'extérieure ne fait glisser que quelques pixels de débordement résiduel.
   * C'est exactement ce qu'on voyait sur Analytics.
   *
   * On coupe donc le défilement de `<main>` pour cette seconde famille. La
   * liste est explicite plutôt que devinée : se tromper dans un sens donne une
   * barre en trop, dans l'autre une page qu'on ne peut plus faire défiler du
   * tout — le second défaut est bien plus grave, donc rien n'y entre sans
   * avoir été vérifié.
   */
  const SELF_SCROLLING = ["projects", "memory", "room", "agent", "agent-config", "public", "live"];
  // L'éditeur de workflow rejoint la seconde famille depuis qu'il porte une vue
  // graphe et une console ancrée en bas : les deux ont besoin d'une hauteur
  // bornée, qu'un conteneur qui s'étire avec son contenu ne donne jamais. La
  // LISTE des workflows, elle, coule toujours normalement — d'où le test sur
  // l'éditeur et pas sur l'onglet.
  const mainScrolls = !SELF_SCROLLING.includes(activeTab) && !isWorkflowEditor;

  // La section de la page ouverte. Hors sections (réglages, documentation),
  // le panneau garde la dernière section vue.
  const activeSection = sectionOf(activeTab, sub);
  const [panelSection, setPanelSection] = useState<SectionKey>(activeSection ?? "accueil");
  useEffect(() => {
    if (!activeSection || !dashboardId) return;
    setPanelSection(activeSection);
    // Revenir sur une section rouvre la dernière page qu'on y a vue.
    const path = [activeTab, sub, leaf].filter(Boolean).join("/");
    rememberInSection(dashboardId, activeSection, path);
  }, [activeSection, activeTab, sub, leaf, dashboardId]);

  // The sidebar folds down to a narrow strip — never to nothing, or there would
  // be no way back.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("sd-sidebar-collapsed") === "1"; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed((v) => {
    const next = !v;
    try { localStorage.setItem("sd-sidebar-collapsed", next ? "1" : "0"); } catch { /* noop */ }
    return next;
  });
  useEffect(() => {
    let untouched = true;
    try { untouched = localStorage.getItem("sd-sidebar-collapsed") === null; } catch { /* noop */ }
    if (untouched && settings.sidebar_collapsed) setCollapsed(true);
  }, [current?.id, settings.sidebar_collapsed]);

  // No skin of its own: the person's theme (ThemeProvider) already paints
  // <html>, so a service dashboard looks like the rest of their app. A
  // per-service override would drift out of step the moment they changed the
  // theme somewhere else.

  return (
    // The SaaS assistant lives here too: internal agents are configured through
    // it (see ToolSetupReminder), and this is now the only place an agent opens.
    <AssistantProvider>
    <WorkbenchProvider dashboardId={dashboardId!} activeAgentId={isAgent || isAgentConfig ? sub! : null} activeMissionId={activeMissionId}>
    <div className="flex h-screen w-full flex-col overflow-hidden bg-[hsl(var(--sd-ground))] text-foreground">
      {/* ── Navbar : sélecteur, agents ouverts, en-tête du panneau ── */}
      <DashboardNavbar
        selector={<DashboardSelector current={current} dashboards={dashboards ?? []} label={collapsed ? undefined : (current?.name ?? "Dashboard")} />}
        leftWidth={collapsed ? 52 : 296}
        collapsed={collapsed}
        base={base}
        dashboardId={dashboardId!}
        liveActive={activeTab === "live"}
      />

      <div className="flex min-h-0 flex-1">
      {/* ── Navigation : le rail des sections, puis le panneau de la section ── */}
      <aside className={cn(
        // Ni fond ni bordure : la barre EST le fond, et seul le contenu est
        // posé dessus.
        "flex h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out",
        collapsed ? "w-[52px]" : "w-[296px]",
      )}>
        <SectionRail
          dashboardId={dashboardId!} base={base}
          active={activeSection}
          panelOpen={!collapsed}
          onTogglePanel={toggleCollapsed}
        />
        {!collapsed && (
          <SectionPanel
            section={activeSection ?? panelSection}
            base={base} dashboardId={dashboardId!}
            tab={activeTab} sub={sub} leaf={leaf}
            onCollapse={toggleCollapsed}
            dashboardName={current?.name ?? ""}
            workspaceId={workspaceId} projectId={projectId}
          />
        )}
      </aside>

      {/* Le contenu, puis le panneau de droite : deux surfaces posées sur le
          fond, côte à côte. Sous la barre du haut, sans marge en haut — c'est
          elle qui donne l'air. */}
      <div className="flex min-w-0 flex-1 gap-2 pb-2 pr-2">
        <div className="flex min-w-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-background">

      {/* ── Content ── */}
      <main className={cn(
        "relative min-w-0 flex-1 bg-background",
        mainScrolls ? "overflow-y-auto" : "overflow-hidden",
      )}>
        {!current ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Dashboard introuvable.</div>
        ) : !workspaceId || !projectId ? (
          <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : isRoom ? (
          <RoomView dashboardId={dashboardId!} roomId={sub!} workspaceId={workspaceId} />
        ) : isWorkflowEditor ? (
          <WorkflowDocument workflowId={sub!} onBack={() => navigate(`${base}/workflows`)} />
        ) : isAgent ? (
          <AgentDetailInDashboard dashboardId={dashboardId!} agentId={sub!} />
        ) : isAgentConfig ? (
          <AgentConfigInDashboard dashboardId={dashboardId!} agentId={sub!} />
        ) : isPublicAgent ? (
          <PublicAgentInDashboard dashboardId={dashboardId!} agentId={sub!} />
        ) : isCreateAgent ? (
          <CreateAgentPage dashboardId={dashboardId!} workspaceId={workspaceId} projectId={projectId} />
        ) : (
          <>
            {activeTab === "agents" && <AgentsTab dashboardId={dashboardId!} />}
            {activeTab === "dashboards" && (sub
              ? <DashboardPage key={sub} serviceId={dashboardId!} dashboardId={sub} sbase={base} />
              : <DashboardsPage serviceId={dashboardId!} workspaceId={workspaceId} projectId={projectId} sbase={base} />)}
            {/* Le Live Space : les agents dans leurs locaux, en direct. Plein
                cadre, comme le canevas des workflows. */}
            {activeTab === "teamz" && <TeamzTab dashboardId={dashboardId!} dashboardName={current.name} />}
            {activeTab === "live" && (
              <LiveSpaceTab dashboardId={dashboardId!} dashboardName={current.name} workspaceId={workspaceId} projectId={projectId} />
            )}
            {activeTab === "projects" && (
              <TrackerTab
                dashboardId={dashboardId!} workspaceId={workspaceId} projectId={projectId}
                selectedProjectId={sub ?? null}
                section={leaf ?? null}
                onSelectProject={(id) => navigate(id ? `${base}/projects/${id}` : `${base}/projects`)}
                onSelectSection={(s) => navigate(`${base}/projects/${sub}/${s}`)}
              />
            )}
            {activeTab === "memory" && (
              <WorkspaceMemoryTab
                workspaceId={workspaceId} dashboardId={dashboardId!} projectId={projectId} view={sub || "graph"}
                part={leaf ?? null}
                onPart={(p) => navigate(p ? `${base}/memory/graph/${p}` : `${base}/memory/graph`)}
              />
            )}
            {/* La passerelle de ressources (0291) : /pools, /pools/:poolId,
                /pools/registre, /pools/coherence. */}
            {activeTab === "pools" && (
              <PoolsTab dashboardId={dashboardId!} base={`${base}/pools`} sub={sub ?? null} />
            )}
            {activeTab === "connectors" && (
              <ToolsTabs active={sub === "internal" ? "internal" : "space"} onSelect={(t) => navigate(`${base}/connectors/${t}`)} />
            )}
            {activeTab === "connectors" && sub === "internal" && <CustomConnectorsPage serviceDashboardId={dashboardId!} />}
            {activeTab === "connectors" && sub !== "internal" && (
              <ComposioCatalog serviceDashboardId={dashboardId!} scope={sub === "personal" ? "personal" : "dashboard"} />
            )}
            {/* The list pads itself; the canvas must be FULL-BLEED — a dotted
                infinite surface inside a padded box reads as a widget, not as a
                workspace. `sub` is the workflow id. */}
            {activeTab === "workflows" && !sub && (
              <WorkflowsList
                dashboardId={dashboardId!} workspaceId={workspaceId} projectId={projectId}
                onOpen={(id) => navigate(`${base}/workflows/${id}`)}
              />
            )}
            {activeTab === "machines" && <MachinesTab dashboardId={dashboardId!} base={base} sub={sub ?? null} />}
            {activeTab === "docs" && (
              <DocsPage
                article={sub ?? null}
                onSelect={(slug) => navigate(slug ? `${base}/docs/${slug}` : `${base}/docs`)}
              />
            )}
            {activeTab === "settings" && (
              <DashboardSettingsTab
                dashboard={current} workspaceId={workspaceId} projectId={projectId}
                section={(sub || "general") as DashboardSettingsSection}
                onSection={(s) => navigate(`${base}/settings/${s}`)}
              />
            )}
          </>
        )}

      </main>
        </div>
        <WorkbenchSide />
        {/* L'assistant ouvert depuis la barre du haut : il partage la zone de
            contenu, comme le panneau de droite qu'il remplace le temps qu'il
            est ouvert ; son en-tête est dans la barre, au-dessus de lui. */}
        <AssistantPanel variant="docked" />
      </div>
      </div>
    </div>
    </WorkbenchProvider>
    </AssistantProvider>
  );
}

/** Tools : les applications et les outils customisés, deux onglets d'une même page. */
function ToolsTabs({ active, onSelect }: { active: "space" | "internal"; onSelect: (t: "space" | "internal") => void }) {
  return (
    <div className="sticky top-0 z-10 flex gap-1 border-b border-border/60 bg-background px-6 pt-3">
      {([["space", "Applications"], ["internal", "Outils customisés"]] as const).map(([k, label]) => (
        <button
          key={k} type="button" onClick={() => onSelect(k)}
          className={cn(
            "-mb-px border-b-2 px-3 pb-2 text-sm transition-colors",
            active === k ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Le panneau de droite : sa largeur est celle de l'en-tête qui le coiffe dans
 *  la barre du haut, et sa poignée gauche le redimensionne. Masqué sous `lg` —
 *  à côté d'un contenu déjà étroit, il n'y aurait plus rien de lisible. */
function WorkbenchSide() {
  const wb = useWorkbench();
  const assistant = useAssistant();
  // L'assistant ouvert prend la place du panneau : une seule colonne à droite.
  if (!wb?.panelOpen || assistant.open) return null;
  return (
    <aside
      className="relative hidden shrink-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-[hsl(var(--sd-panel))] lg:flex"
      style={{ width: wb.panelWidth }}
    >
      {!wb.wide && (
        <div
          onMouseDown={wb.startResize}
          className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/30"
          title="Glisser pour redimensionner"
        />
      )}
      <div className="min-h-0 flex-1">
        <WorkbenchPanelBody />
      </div>
    </aside>
  );
}

// En-tête de la barre latérale : la recherche, toujours visible, et de quoi
// replier la barre. Le sélecteur de tableau a rejoint la barre du haut.
function PanelHeader({ dashboardId, base, onCollapse }: {
  dashboardId: string; base: string; onCollapse: () => void;
}) {
  return (
    <div className="flex items-center gap-1 px-2.5 pb-2 pt-1">
      <div className="min-w-0 flex-1"><SidebarSearch dashboardId={dashboardId} base={base} /></div>
      <button
        onClick={onCollapse} title="Replier le panneau" aria-label="Replier le panneau"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
      >
        <SidebarSimpleIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * Les rooms et les messages directs.
 *
 * Rendus dans la barre latérale, sous les projets : une room est une
 * conversation sur du travail, et la ranger ailleurs que le board casse le fil
 * de la pensée.
 */
function RoomsAndMessages({
  base, dashboardId, activeTab, sub, dashboardName, workspaceId, projectId,
  showMessages = true,
}: {
  base: string; dashboardId: string; activeTab: string; sub?: string;
  dashboardName: string; workspaceId: string | null; projectId: string | null;
  /** Les messages directs avec les agents. Coupés là où l'onglet Agents les
   *  liste déjà, pour ne pas énumérer trois fois la même chose. */
  showMessages?: boolean;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data: agents } = useQuery({
    queryKey: ["sd_panel_agents", dashboardId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name, avatar_url, accent_color, is_orchestrator")
        .eq("service_dashboard_id", dashboardId).eq("is_archived", false)
        .order("is_orchestrator", { ascending: false }).order("created_at", { ascending: true });
      return (data ?? []) as Array<{ id: string; name: string; avatar_url: string | null; accent_color: string | null; is_orchestrator: boolean }>;
    },
  });
  const dms = (agents ?? []).filter((a) => !a.is_orchestrator);
  const [roomsOpen, toggleRooms] = useCollapsed(`sd-panel-rooms-${dashboardId}`);
  const [dmsOpen, toggleDms] = useCollapsed(`sd-panel-dms-${dashboardId}`);

  const { data: rooms } = useQuery({
    queryKey: ["service_rooms", dashboardId],
    queryFn: () => fetchRooms(dashboardId),
  });

  // Une section repliée garde la ligne où l'on se trouve : perdre le
  // surlignage de sa position est ce qui fait qu'une barre repliée paraît
  // cassée.
  const visibleRooms = roomsOpen
    ? (rooms ?? [])
    : (rooms ?? []).filter((r) => activeTab === "room" && sub === r.id);
  const visibleDms = dmsOpen ? dms : dms.filter((a) => activeTab === "agent" && sub === a.id);

  async function newRoom() {
    if (!user || !workspaceId || !projectId || creating) return;
    setCreating(true);
    try {
      const id = await createRoom({ id: dashboardId, name: dashboardName }, workspaceId, projectId, user.id, "Nouvelle room");
      queryClient.invalidateQueries({ queryKey: ["service_rooms", dashboardId] });
      if (id) navigate(`${base}/room/${id}`);
    } finally { setCreating(false); }
  }

  return (
    <>
      <PanelSection
        label="Rooms"
        open={roomsOpen}
        onToggle={toggleRooms}
        count={(rooms ?? []).length}
        onAdd={newRoom}
        menu={[
          { label: "Nettoyer les rooms vides", onSelect: async () => {
            await deleteEmptyRooms(dashboardId);
            queryClient.invalidateQueries({ queryKey: ["service_rooms", dashboardId] });
          } },
          { label: "Paramètres des rooms", onSelect: () => navigate(`${base}/settings/rooms`) },
        ]}
      />
      {(roomsOpen || visibleRooms.length > 0) && (
        <div className="space-y-0.5 px-2.5">
          {visibleRooms.length === 0
            ? <p className="px-2.5 py-1 text-[13px] text-muted-foreground">Nothing here.</p>
            : visibleRooms.map((r) => (
              <RoomRow key={r.id} r={r} active={activeTab === "room" && sub === r.id} base={base} dashboardId={dashboardId} />
            ))}
        </div>
      )}

      {showMessages && (
        <PanelSection
          label="Messages"
          open={dmsOpen}
          onToggle={toggleDms}
          count={dms.length}
          onAdd={() => navigate(`${base}/agents/new`)}
        />
      )}
      {showMessages && (dmsOpen || visibleDms.length > 0) && (
        <div className="space-y-0.5 px-2.5">
          {visibleDms.length === 0
            ? <p className="px-2.5 py-1 text-[13px] text-muted-foreground">Nothing here.</p>
            : visibleDms.map((a) => (
              <PanelItem
                key={a.id} active={activeTab === "agent" && sub === a.id}
                onClick={() => navigate(`${base}/agent/${a.id}`)}
                leading={<AgentIdentity url={a.avatar_url} seed={a.name} size={18} rounded="rounded-md" />}
                label={a.name}
              />
            ))}
        </div>
      )}
    </>
  );
}

/**
 * L'état replié d'une section de la barre latérale, retenu par navigateur.
 *
 * Il est persisté parce qu'une section qu'on replie est une section dont on ne
 * veut plus : la rouvrir à chaque chargement annulerait le geste. La clé porte
 * l'identifiant du tableau, pour que deux services n'imposent pas l'un à
 * l'autre leur mise en forme. `defaultOpen` vaut pour qui n'a encore rien
 * choisi : les paramètres et la documentation partent repliés, on n'y va pas
 * tous les jours.
 */
function useCollapsed(key: string, defaultOpen = true): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? defaultOpen : saved !== "0";
    } catch { return defaultOpen; }
  });
  const toggle = () => setOpen((v) => {
    const next = !v;
    try { localStorage.setItem(key, next ? "1" : "0"); } catch { /* navigation privée */ }
    return next;
  });
  return [open, toggle];
}

// Le panneau du roster a été retiré : l'onglet Agents porte déjà la liste,
// avec ses dossiers et ses cartes. Deux énumérations de la même chose ne
// donnaient aucun accès nouveau, seulement un panneau plus long à parcourir
// avant d'atteindre les rooms.


/**
 * Un projet dans la sidebar. Ouvert, il déplie SES sections — c'est la
 * structure de Plane, et elle vaut mieux qu'une barre d'onglets flottante pour
 * une raison précise : les sections d'un projet et la liste des projets sont la
 * même navigation. Les séparer en deux barres oblige à retenir laquelle porte
 * quoi, et à faire deux gestes pour passer d'un Work items à un autre.
 */
function ProjectNavItem({
  project, base, open, activeSection, onOpen,
}: {
  project: { id: string; name: string; identifier: string; logo_props?: Record<string, unknown> };
  base: string;
  open: boolean;
  activeSection?: string;
  onOpen: () => void;
}) {

  const navigate = useNavigate();

  // Cycles, Modules, Views et Pages ont quitté la barre : Livrables porte déjà
  // ce que le projet produit, et les trois autres découpaient un travail que
  // les work items suffisent à suivre.
  const SECTIONS: { slug: string; label: string; icon: PhosphorIcon }[] = [
    // Le cadrage par l'équipe d'agents (0295) : brief, concertation, plan.
    { slug: "kickoff", label: "Cadrage", icon: FlagIcon },
    { slug: "overview", label: "Overview", icon: SquaresFourIcon },
    { slug: "issues", label: "Work items", icon: KanbanIcon },
    // Qui porte le projet, puis ce qui en sort. Les deux sont ici et pas
    // seulement dans le menu de l'en-tête : cette liste EST la navigation du
    // projet, et une section qui n'y figure pas n'existe pas pour qui ne
    // pense pas à ouvrir un menu à trois points.
    { slug: "crew", label: "Équipage", icon: UsersThreeIcon },
    { slug: "deliverables", label: "Livrables", icon: PackageIcon },
  ];

  return (
    <>
      <PanelItem
        active={open && !activeSection}
        onClick={onOpen}
        leading={
          // L'emoji quand il existe, le préfixe sinon : sur quinze projets aux
          // noms qui commencent pareil, c'est lui qu'on repère au coin de l'œil.
          <ProjectLogo logo={project.logo_props} fallback={project.identifier} size={14} />
        }
        label={project.name}
      />
      {open && (
        // Le retrait aligne les sections sous le nom du projet : sans lui, elles
        // se lisent comme des destinations d'espace, au même rang que Projets.
        <div className="space-y-0.5 pl-4">
          {SECTIONS.map((s) => (
            <PanelItem
              key={s.slug}
              active={activeSection === s.slug}
              onClick={() => navigate(`${base}/projects/${project.id}/${s.slug}`)}
              leading={<s.icon className="h-4 w-4" />}
              label={s.label}
            />
          ))}
        </div>
      )}
    </>
  );
}

function PanelItem({ active, onClick, leading, label, tone, trailing }: {
  active: boolean; onClick: () => void; leading: React.ReactNode; label: React.ReactNode; tone?: "danger";
  /** Une action propre à la ligne (épingler, par exemple), à sa droite. */
  trailing?: React.ReactNode;
}) {
  // Le conteneur est un div, pas un bouton : imbriquer l'action d'épinglage
  // DANS le bouton de navigation donnerait un bouton dans un bouton — HTML
  // invalide, et un clic sur l'épingle qui navigue quand même.
  return (
    <div
      className={cn(
        "group/nav flex w-full items-center gap-2.5 rounded-lg pl-2.5 transition-colors",
        trailing ? "pr-1" : "pr-2.5",
        // La ligne active porte le violet de marque : un voile, et l'icône en
        // couleur pleine. Le gris d'avant se confondait avec le survol.
        active ? (tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-primary/15 text-foreground")
          : tone === "danger" ? "text-destructive/80 hover:bg-destructive/10"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <button
        onClick={onClick}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 py-1.5 text-left text-[13.5px]",
          active && "font-medium",
        )}
      >
        <span className={cn(
          "flex h-[18px] w-[18px] shrink-0 items-center justify-center",
          active && tone !== "danger" ? "text-primary" : "text-muted-foreground",
        )}>{leading}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      {trailing}
    </div>
  );
}

function PanelSection({ label, onAdd, menu, open, onToggle, count }: {
  label: string; onAdd?: () => void; menu?: { label: string; onSelect: () => void }[];
  /** Pass both to make the header fold its list; the count then shows while
   *  folded, so a collapsed section still says how much is under it. */
  open?: boolean; onToggle?: () => void; count?: number;
}) {
  return (
    <div className="flex items-center gap-1 px-4 pb-1.5 pt-6">
      {onToggle ? (
        <button
          onClick={onToggle}
          aria-expanded={open}
          title={open ? `Replier · ${label}` : `Déplier · ${label}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <CaretDownIcon className={cn("h-3.5 w-3.5 shrink-0 transition-transform", !open && "-rotate-90")} />
          <span className="min-w-0 truncate text-[11.5px] uppercase">{label}</span>
          {count != null && count > 0 && <CountChip n={count} />}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
          <span className="min-w-0 truncate text-[11.5px] uppercase">{label}</span>
          {count != null && count > 0 && <CountChip n={count} />}
        </span>
      )}
      {onAdd && (
        <button onClick={onAdd} title={`Ajouter · ${label}`} className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground">
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      )}
      {menu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground">
              <DotsThreeIcon className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="rounded-xl">
            {menu.map((m) => (
              <DropdownMenuItem key={m.label} onSelect={() => m.onSelect()}>{m.label}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** Le compte d'une section (« MENU 3 ») : une pastille grise, chiffres alignés. */
function CountChip({ n }: { n: number }) {
  return (
    <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-muted px-1 text-[10.5px] font-medium tabular-nums text-muted-foreground">
      {n > 99 ? "99+" : n}
    </span>
  );
}

// A recent-room row with a hover ⋯ menu to rename or delete the room.
function RoomRow({ r, active, base, dashboardId }: { r: Room; active: boolean; base: string; dashboardId: string }) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(r.title || "");

  async function doRename() {
    await renameRoom(r.id, name);
    queryClient.invalidateQueries({ queryKey: ["service_rooms", dashboardId] });
    setRenaming(false);
  }
  async function doDelete() {
    if (!(await confirm("Supprimer cette room et tous ses messages ?"))) return;
    await deleteRoom(r.id);
    queryClient.invalidateQueries({ queryKey: ["service_rooms", dashboardId] });
    if (active) navigate(`${base}/home`);
  }

  return (
    <div className={cn("group flex items-center rounded-lg pr-1 transition-colors", active ? "bg-primary/15" : "hover:bg-sidebar-accent/60")}>
      <button
        onClick={() => navigate(`${base}/room/${r.id}`)}
        className={cn("flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left text-[13.5px]", active ? "font-medium text-foreground" : "text-sidebar-foreground")}
      >
        <HashIcon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
        <span className="min-w-0 flex-1 truncate">{r.title || "Sans titre"}</span>
      </button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            onClick={(e) => e.stopPropagation()}
            className={cn("shrink-0 rounded p-1 text-muted-foreground transition-opacity hover:bg-background/60 hover:text-foreground", menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
            aria-label="Options de la room"
          >
            <DotsThreeIcon className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="rounded-xl">
          <DropdownMenuItem onSelect={() => { setName(r.title || ""); setRenaming(true); }}><PencilSimpleIcon className="mr-2 h-3.5 w-3.5" /> Renommer</DropdownMenuItem>
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => doDelete()}><TrashIcon className="mr-2 h-3.5 w-3.5" /> Supprimer</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Renommer la room</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doRename(); }} placeholder="Nom de la room" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRenaming(false)}>Annuler</Button>
              <Button onClick={doRename} disabled={!name.trim()}>Enregistrer</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Dashboard selector — the coloured tile at the top of the sidebar. Unfolded,
// the name sits next to it and opens the same menu; folded, the tile alone.
function DashboardSelector({ current, dashboards, label }: {
  current: ServiceDashboard | null; dashboards: ServiceDashboard[]; label?: string;
}) {
  const confirm = useConfirm();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const base = `/app/${workspaceSlug}/${projectSlug}`;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!name.trim() || !workspaceId || !projectId) return;
    setSaving(true);
    try {
      const d = await createServiceDashboard(workspaceId, projectId, user?.id ?? null, { name });
      queryClient.invalidateQueries({ queryKey: ["service_dashboards", projectId] });
      setCreating(false); setName("");
      if (d) navigate(`${base}/service/${d.id}`);
    } finally { setSaving(false); }
  }
  async function remove(id: string) {
    if (!(await confirm("Supprimer ce dashboard de service ? Les collaborateurs qu'il contient ne seront pas supprimés (juste dissociés)."))) return;
    await deleteServiceDashboard(id);
    queryClient.invalidateQueries({ queryKey: ["service_dashboards", projectId] });
    navigate(`${base}/${dashboardLandingSlug("workforce")}`);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {label ? (
            <button
              className="-ml-1 flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-muted/60"
              title={current?.name ?? "Dashboard"}
            >
              <DashboardTile icon={current?.icon} color={current?.color ?? "bg-indigo-500"} size={22} />
              <span className="min-w-0 truncate text-[14px] font-semibold tracking-tight">{label}</span>
              <CaretUpDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          ) : (
            <button className="rounded-lg transition-transform hover:scale-105" title={current?.name ?? "Dashboard"}>
              <DashboardTile icon={current?.icon} color={current?.color ?? "bg-indigo-500"} size={28} />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="bottom" className="w-64 rounded-2xl p-1.5">
          <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Dashboards produit</DropdownMenuLabel>
          {DASHBOARDS.map((d) => {
            const Icon = d.icon;
            return (
              <DropdownMenuItem key={d.id} className="rounded-xl" onSelect={() => navigate(`${base}/${dashboardLandingSlug(d.id)}`)}>
                <span className={cn("mr-2 flex h-6 w-6 items-center justify-center rounded-md text-white", d.color)}><Icon weight="fill" className="h-3.5 w-3.5" /></span>
                {d.label}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Services</DropdownMenuLabel>
          {dashboards.map((d) => (
            <DropdownMenuItem key={d.id} className={cn("group rounded-xl", current?.id === d.id && "bg-accent")} onSelect={() => navigate(`${base}/service/${d.id}`)}>
              <DashboardTile icon={d.icon} color={d.color} size={24} className="mr-2" />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              {current?.id === d.id && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-primary" />}
              <span onClick={(e) => { e.stopPropagation(); remove(d.id); }} className="ml-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"><TrashIcon className="h-3.5 w-3.5" /></span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem className="rounded-xl text-primary" onSelect={(e) => { e.preventDefault(); setCreating(true); }}>
            <PlusIcon className="mr-2 h-4 w-4" /> Nouveau dashboard de service
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem className="rounded-xl" onSelect={() => navigate(`${base}/admin/${ADMIN_LANDING}`)}>
            <span className="mr-2 flex h-6 w-6 items-center justify-center rounded-md bg-muted text-muted-foreground"><GearSixIcon className="h-3.5 w-3.5" /></span>
            Admin
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Nouveau dashboard de service</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="ex. Marketing, Support, Finance…" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreating(false)}>Annuler</Button>
              <Button onClick={create} disabled={!name.trim() || saving}>{saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Créer</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Sidebar search — results drop down inline. Searches agents, rooms, artifacts.
function SidebarSearch({ dashboardId, base }: { dashboardId: string; base: string }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  const { data: agents } = useQuery({
    queryKey: ["sd_search_agents", dashboardId],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents").select("id, name")
        .eq("service_dashboard_id", dashboardId).eq("is_archived", false);
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
  });
  const agentIds = (agents ?? []).map((a) => a.id);
  const term = q.trim();

  const { data: hits, isLoading } = useQuery({
    queryKey: ["sd_sidebar_search", dashboardId, agentIds.join(","), term],
    enabled: agentIds.length > 0 && term.length >= 2,
    queryFn: async () => {
      const like = `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      const [rooms, arts] = await Promise.all([
        supabase.from("service_rooms").select("id, title").eq("dashboard_id", dashboardId).ilike("title", like).limit(8),
        supabase.from("internal_agent_deliverables").select("id, agent_id, name").in("agent_id", agentIds).ilike("name", like).limit(8),
      ]);
      return {
        agents: (agents ?? []).filter((a) => a.name.toLowerCase().includes(term.toLowerCase())).slice(0, 8),
        rooms: (rooms.data ?? []) as Array<{ id: string; title: string | null }>,
        arts: (arts.data ?? []) as Array<{ id: string; agent_id: string; name: string }>,
      };
    },
  });

  const total = (hits?.agents.length ?? 0) + (hits?.rooms.length ?? 0) + (hits?.arts.length ?? 0);
  const go = (path: string) => { navigate(path); setOpen(false); setQ(""); };

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-sidebar-accent/40 px-2.5 transition-colors focus-within:border-primary/40">
        <MagnifyingGlassIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Rechercher"
          className="h-9 min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-muted-foreground/70 focus:outline-none"
        />
      </div>

      {open && term.length >= 2 && (
        <div className="absolute inset-x-0 top-full z-40 mt-1.5 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Recherche…</div>
          ) : total === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">Aucun résultat.</div>
          ) : (
            <>
              {(hits?.agents ?? []).map((a) => (
                <SearchHit key={`a-${a.id}`} icon={RobotIcon} label={a.name} onClick={() => go(`${base}/agent/${a.id}`)} />
              ))}
              {(hits?.rooms ?? []).map((r) => (
                <SearchHit key={`r-${r.id}`} icon={ChatsCircleIcon} label={r.title || "Sans titre"} onClick={() => go(`${base}/room/${r.id}`)} />
              ))}
              {(hits?.arts ?? []).map((d) => (
                <SearchHit key={`d-${d.id}`} icon={FilesIcon} label={d.name} onClick={() => go(`${base}/projects/wiki`)} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SearchHit({ icon: Icon, label, onClick }: { icon: PhosphorIcon; label: string; onClick: () => void }) {
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-sidebar-accent"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

// La navigation en deux barres (18/11/2026).
//
// Un RAIL étroit porte les cinq sections (navSections.ts) ; le PANNEAU à côté
// porte ce qu'il y a dans la section ouverte : ses pages, puis ce qui lui est
// propre (les collaborateurs, les missions et les rooms, les dashboards
// épinglés). Replier masque le panneau ; le rail reste.

function SectionRail({ dashboardId, base, active, panelOpen, onTogglePanel }: {
  dashboardId: string; base: string; active: SectionKey | null; panelOpen: boolean; onTogglePanel: () => void;
}) {
  const navigate = useNavigate();
  const inboxCount = useCollaboratorInbox(dashboardId).data?.length ?? 0;
  const go = (s: Section) => navigate(`${base}/${lastInSection(dashboardId, s.key) ?? s.items[0].path}`);
  return (
    <div className="flex h-full w-[52px] shrink-0 flex-col items-center gap-1.5 pb-3 pt-1">
      <button
        onClick={onTogglePanel}
        title={panelOpen ? "Replier le panneau" : "Déployer le panneau"}
        aria-label={panelOpen ? "Replier le panneau" : "Déployer le panneau"}
        aria-expanded={panelOpen}
        className="mb-2 mt-1.5 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
      >
        <SidebarSimpleIcon className={cn("h-[18px] w-[18px] transition-transform", !panelOpen && "-scale-x-100")} />
      </button>
      {MAIN_SECTIONS.map((s) => (
        <RailButton key={s.key} section={s} on={active === s.key} onClick={() => go(s)}
          dot={s.key === "accueil" && inboxCount > 0 ? `${inboxCount} en attente` : undefined} />
      ))}
      <div className="flex-1" />
      <RailButton section={SETTINGS_SECTION} on={active === "parametres"} onClick={() => go(SETTINGS_SECTION)} />
      <ThemeMenu align="start" className="h-9 w-9 hover:bg-sidebar-accent/60" />
      <SidebarProfileFooter compact />
    </div>
  );
}

function RailButton({ section: s, on, onClick, dot }: { section: Section; on: boolean; onClick: () => void; dot?: string }) {
  return (
    <button
      onClick={onClick}
      title={`${s.label} · ${s.question}`}
      aria-label={s.label}
      aria-current={on ? "page" : undefined}
      className={cn(
        "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
        on ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <s.icon weight={on ? "duotone" : "regular"} className={cn("h-[19px] w-[19px]", on && "text-primary")} />
      {dot && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-500" title={dot} />}
    </button>
  );
}

const SECTION_ACTION: Partial<Record<SectionKey, { label: string; icon: PhosphorIcon; path: string }>> = {
  equipe: { label: "Déployer un collaborateur", icon: RocketLaunchIcon, path: "agents/new" },
  pilotage: { label: "Nouveau dashboard", icon: PlusIcon, path: "dashboards?new=1" },
  ressources: { label: "Connecter un outil", icon: PlugsConnectedIcon, path: "connectors" },
  machines: { label: "Ajouter une machine", icon: PlusIcon, path: "machines?new=1" },
};

function SectionPanel({ section, base, dashboardId, tab, sub, leaf, onCollapse, dashboardName, workspaceId, projectId }: {
  section: SectionKey; base: string; dashboardId: string; tab: string; sub?: string; leaf?: string;
  onCollapse: () => void; dashboardName: string; workspaceId: string | null; projectId: string | null;
}) {
  const navigate = useNavigate();
  const s = SECTIONS.find((x) => x.key === section) ?? SECTIONS[0];
  const inboxCount = useCollaboratorInbox(dashboardId).data?.length ?? 0;
  const action = SECTION_ACTION[s.key];

  return (
    <div className="flex h-full w-[244px] flex-col pt-1">
      <PanelHeader dashboardId={dashboardId} base={base} onCollapse={onCollapse} />
      <div className="px-4 pb-2 pt-1">
        <div className="text-[15px] font-semibold tracking-tight">{s.label}</div>
        <div className="text-[12px] text-muted-foreground">{s.question}{s.key === "parametres" ? "" : " ?"}</div>
      </div>
      {action && (
        <div className="px-2.5 pb-1.5">
          <button
            type="button"
            onClick={() => navigate(`${base}/${action.path}`)}
            className="flex h-9 w-full items-center gap-2 rounded-lg bg-primary px-3 text-[13.5px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            <action.icon weight="bold" className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{action.label}</span>
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2 scrollbar-hide">
        <nav className="space-y-0.5 px-2.5 pt-1">
          {s.items.map((it) => (
            <PanelItem
              key={it.path}
              active={itemActive(it, tab, sub)}
              onClick={() => navigate(`${base}/${it.path}`)}
              leading={<it.icon className="h-4 w-4" />}
              label={it.label}
              trailing={it.badge === "inbox" && inboxCount > 0 ? (
                <span className="mr-1.5 min-w-[20px] rounded-full bg-amber-500/15 px-1.5 text-center text-[11px] font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                  {inboxCount > 99 ? "99+" : inboxCount}
                </span>
              ) : undefined}
            />
          ))}
        </nav>

        {s.key === "equipe" && (
          <TeamList base={base} dashboardId={dashboardId} activeAgentId={tab === "agent" || tab === "agent-config" ? sub : undefined} />
        )}
        {s.key === "travail" && (
          <>
            <MissionList base={base} dashboardId={dashboardId} activeProjectId={tab === "projects" ? sub : undefined} activeSection={tab === "projects" ? leaf : undefined} />
            <div className="mx-4 mt-5 border-t border-sidebar-border/60" />
            <RoomsAndMessages
              base={base} dashboardId={dashboardId} activeTab={tab} sub={sub}
              dashboardName={dashboardName} workspaceId={workspaceId} projectId={projectId} showMessages={false}
            />
          </>
        )}
        {s.key === "pilotage" && <PanelDashboards base={base} dashboardId={dashboardId} activeId={tab === "dashboards" ? sub : undefined} />}
      </div>
      <SidebarGetStarted dashboardId={dashboardId} />
    </div>
  );
}

/** Équipe : les collaborateurs du service, une ligne chacun. */
function TeamList({ base, dashboardId, activeAgentId }: { base: string; dashboardId: string; activeAgentId?: string }) {
  const navigate = useNavigate();
  const { data: agents } = useLiteAgents(dashboardId);
  const [open, toggle] = useCollapsed(`sd-panel-team-${dashboardId}`);
  const list = (agents ?? []).filter((a) => !a.is_orchestrator);
  const visible = open ? list : list.filter((a) => a.id === activeAgentId);
  return (
    <>
      <PanelSection label="Collaborateurs" open={open} onToggle={toggle} count={list.length} />
      <nav className="space-y-0.5 px-2.5">
        {visible.map((a) => (
          <PanelItem
            key={a.id}
            active={activeAgentId === a.id}
            onClick={() => navigate(`${base}/agent/${a.id}`)}
            leading={<AgentIdentity url={a.avatar_url} seed={a.name} size={18} rounded="rounded-md" />}
            label={a.name}
          />
        ))}
        {open && !list.length && <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">Aucun collaborateur.</p>}
      </nav>
    </>
  );
}

/** Travail : les missions du tracker, chacune dépliable sur ses sections. */
function MissionList({ base, dashboardId, activeProjectId, activeSection }: {
  base: string; dashboardId: string; activeProjectId?: string; activeSection?: string;
}) {
  const navigate = useNavigate();
  const [open, toggle] = useCollapsed(`sd-panel-missions-${dashboardId}`);
  const { data: projects } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchTrackerProjects(dashboardId),
  });
  const list = projects ?? [];
  const visible = open ? list : list.filter((p) => p.id === activeProjectId);
  return (
    <>
      <PanelSection label="Missions en cours" open={open} onToggle={toggle} count={list.length} />
      <nav className="space-y-0.5 px-2.5">
        {visible.map((p) => (
          <ProjectNavItem
            key={p.id} project={p} base={base}
            open={activeProjectId === p.id}
            activeSection={activeSection}
            onOpen={() => navigate(`${base}/projects/${p.id}`)}
          />
        ))}
        {open && !list.length && <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">Aucune mission.</p>}
      </nav>
    </>
  );
}

/** Pilotage : les dashboards épinglés à l'accueil, puis les plus récents. */
function PanelDashboards({ base, dashboardId, activeId }: { base: string; dashboardId: string; activeId?: string }) {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["agent_dashboards", dashboardId],
    queryFn: () => fetchServiceDashboardsList(dashboardId),
  });
  const live = (data ?? []).filter((d) => !d.is_template);
  const pinned = live.filter((d) => d.pinned);
  const recent = live.filter((d) => !d.pinned).slice(0, 6);
  const row = (d: (typeof live)[number]) => (
    <PanelItem
      key={d.id}
      active={activeId === d.id}
      onClick={() => navigate(`${base}/dashboards/${d.id}`)}
      leading={d.pinned ? <PushPinIcon weight="fill" className="h-3.5 w-3.5" /> : <SquaresFourIcon className="h-3.5 w-3.5" />}
      label={applyDashboardParameters(d.name, d.parameters)}
    />
  );
  return (
    <>
      {pinned.length > 0 && (
        <>
          <PanelSection label="Épinglés à l'accueil" count={pinned.length} />
          <nav className="space-y-0.5 px-2.5">{pinned.map(row)}</nav>
        </>
      )}
      {recent.length > 0 && (
        <>
          <PanelSection label="Récents" count={recent.length} />
          <nav className="space-y-0.5 px-2.5">{recent.map(row)}</nav>
        </>
      )}
    </>
  );
}
