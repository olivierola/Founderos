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
  NotePencilIcon, PushPinIcon, PackageIcon,
  PushPinSlashIcon, BookOpenIcon, TrayIcon, WrenchIcon, RocketLaunchIcon, PlugsConnectedIcon,
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
import { WorkflowsList } from "@/features/workflows/WorkflowsList";
import { WorkflowDocument } from "@/features/workflows/WorkflowDocument";
import { DashboardSettingsTab, type DashboardSettingsSection } from "./DashboardSettings";
import { CreateAgentPage } from "./CreateAgent";
import { PublicAgentInDashboard } from "./PublicAgentInDashboard";
import { fetchAgentFolders } from "./agentFolders";
import { DashboardTile } from "./dashboardIcons";
import { ThemeMenu } from "@/components/ThemeMenu";
import { AssistantProvider, useAssistant } from "@/lib/assistant-context";
import { AssistantPanel } from "@/features/ai-agent/AssistantPanel";
import { useConfirm } from "@/components/ConfirmProvider";

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
  const { workspaceSlug, projectSlug, dashboardId, tab, sub, leaf } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const navigate = useNavigate();
  const base = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;

  // Le tableau ouvert devient la page d'arrivée de la prochaine visite : on
  // reprend où l'on en était (voir PlaneLanding).
  useEffect(() => {
    if (projectId && dashboardId) rememberServiceDashboard(projectId, dashboardId);
  }, [projectId, dashboardId]);

  // Le violet de marque, le temps qu'on est ici (voir `.sd-brand` dans
  // globals.css). Sur <html> et pas sur la coque : menus et dialogues sont
  // rendus en portail, hors de son sous-arbre, et resteraient bleus.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("sd-brand");
    return () => root.classList.remove("sd-brand");
  }, []);

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
  const KNOWN = ["home", "agents", "schedules", "dashboard", "missions", "projects", "memory", "artifacts", "connectors", "workflows", "settings", "docs"];
  const activeTab = isRoom ? "room"
    : isAgent ? "agent"
    : isAgentConfig ? "agent-config"
    : isPublicAgent ? "public"
    : (tab && KNOWN.includes(tab) ? tab : settings.landing);

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
  const SELF_SCROLLING = ["projects", "memory", "room", "agent", "agent-config", "public"];
  // L'éditeur de workflow rejoint la seconde famille depuis qu'il porte une vue
  // graphe et une console ancrée en bas : les deux ont besoin d'une hauteur
  // bornée, qu'un conteneur qui s'étire avec son contenu ne donne jamais. La
  // LISTE des workflows, elle, coule toujours normalement — d'où le test sur
  // l'éditeur et pas sur l'onglet.
  const mainScrolls = !SELF_SCROLLING.includes(activeTab) && !isWorkflowEditor;

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
    <div className="flex h-screen w-full overflow-hidden bg-[hsl(var(--sd-ground))] text-foreground">
      {/* ── Sidebar ── */}
      <aside className={cn(
        // Ni fond ni bordure : la barre EST le fond, et seul le contenu est
        // posé dessus. Une teinte propre en ferait une deuxième surface à côté
        // de la carte, et l'œil ne saurait plus laquelle est la page.
        "h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out",
        collapsed ? "w-[60px]" : "w-[300px]",
      )}>
        {collapsed ? (
          // Repliée : le sélecteur de tableau, de quoi redéployer la barre, et
          // ce qui doit rester à portée sans elle — l'assistant, le thème, le
          // compte. Ce tableau n'a pas de navbar pour les porter à sa place.
          <div className="flex h-full w-[60px] flex-col items-center gap-1.5 pb-3 pt-5">
            <DashboardSelector current={current} dashboards={dashboards ?? []} />
            <PanelToggleButton collapsed onToggle={toggleCollapsed} />
            <div className="flex-1" />
            <AssistantButton />
            <ThemeMenu align="start" className="h-10 w-10 hover:bg-sidebar-accent/60" />
            <SidebarProfileFooter compact />
          </div>
        ) : (
        // Le retrait latéral et la marge du haut écartent la navigation des
        // bords de l'écran : posée sur le fond, sans cadre, elle a besoin d'air
        // pour ne pas paraître collée.
        <div className="flex h-full w-[300px] flex-col px-2 pt-3">
          <PanelHeader
            brand={<DashboardSelector current={current} dashboards={dashboards ?? []} label="Intelligence Space" />}
            dashboardId={dashboardId!} base={base} onCollapse={toggleCollapsed}
          />

          {/* Défile sans barre : posée sur le fond, sans cadre, la navigation
              n'a pas de bord où une barre de défilement se lirait comme une
              limite — elle faisait une rayure grise au milieu du fond. */}
          <div className="min-h-0 flex-1 overflow-y-auto pb-2 scrollbar-hide">
            <TrackerPanel
              base={base} dashboardId={dashboardId!}
              // Les vues et projets du tracker vivent sous /projects : hors de
              // là, `sub` est une room, une section de réglages… et ne doit
              // rien allumer ici.
              activeProjectId={activeTab === "projects" ? sub : undefined}
              activeView={activeTab === "projects" ? sub : undefined}
              activeSection={activeTab === "projects" ? leaf : undefined}
              activeTab={activeTab}
              activeSub={sub || (activeTab === "connectors" ? "space" : activeTab === "memory" ? "graph" : undefined)}
            />
            {/* Pas de liste d'collaborateurs ici : l'onglet Agents la porte déjà,
                avec ses dossiers et ses cartes. La répéter dans la barre
                latérale ne donnait aucun accès nouveau — seulement deux
                endroits à parcourir des yeux pour la même information, et
                un panneau qu'il fallait faire défiler pour atteindre les
                rooms. */}
            {/* Les rooms SOUS les projets. Une room est une conversation sur
                du travail : la ranger ailleurs que le board casse le fil. */}
            <div className="mx-4 mt-6 border-t border-sidebar-border/60" />
            <RoomsAndMessages
              base={base}
              dashboardId={dashboardId!}
              activeTab={activeTab}
              sub={sub}
              dashboardName={current?.name ?? ""}
              workspaceId={workspaceId}
              projectId={projectId}
              // Les messages directs listent les MÊMES agents que l'onglet
              // Agents : une troisième énumération de la même chose.
              showMessages={false}
            />

            {/* Paramètres et Documentation ne sont plus listés ici : on y va
                rarement, ils vivent dans le menu du profil (en bas), et chacune
                de leurs pages porte sa propre navigation. */}
          </div>

          <SidebarGetStarted dashboardId={dashboardId!} />
          <div className="flex items-center gap-1 border-t border-border/60 p-2">
            <SidebarProfileFooter />
            <AssistantButton className="h-8 w-8 rounded-lg" />
            <ThemeMenu align="end" className="hover:bg-sidebar-accent/60" />
          </div>
        </div>
        )}
      </aside>

      {/* The content alone floats as a rounded card laid on the ground. */}
      <div className="flex min-w-0 flex-1 py-3 pr-3">
        <div className="flex min-w-0 flex-1 overflow-hidden rounded-2xl border border-border/60 bg-background shadow-sm">

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
                onPart={(p) => navigate(p ? `${base}/memory/sources/${p}` : `${base}/memory/sources`)}
              />
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

        {/* Assistant launcher — the floating orb in the mockups' bottom-right. */}
        {current && workspaceId && projectId && !isRoom && (
          <AssistantLauncher base={base} dashboard={{ id: dashboardId!, name: current.name }} workspaceId={workspaceId} projectId={projectId} />
        )}
      </main>
        </div>
      </div>

      {/* Floating full-height assistant, same panel as the main dashboard. */}
      <AssistantPanel />
    </div>
    </AssistantProvider>
  );
}

// Opens the SaaS assistant from the sidebar's foot — the configuration surface
// for the agents that live in this dashboard.
function AssistantButton({ className }: { className?: string }) {
  const assistant = useAssistant();
  return (
    <button
      onClick={assistant.toggle}
      title="Assistant IA"
      aria-label="Assistant IA"
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors",
        assistant.open ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
        className,
      )}
    >
      <ChatsCircleIcon weight="duotone" className="h-[18px] w-[18px]" />
    </button>
  );
}

// Folding the sidebar takes its header — and the header's fold button — with
// it, so the way back sits in the narrow strip it folds down to. Same corner as
// the button that folded it, so it reads as the same control.
function PanelToggleButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Déployer le panneau" : "Replier le panneau";
  return (
    <button
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      className="mt-1.5 flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
    >
      <SidebarSimpleIcon className={cn("h-[18px] w-[18px] transition-transform", collapsed && "-scale-x-100")} />
    </button>
  );
}

// Sidebar header — the dashboard's logo and name (its switcher), plus a search
// affordance that expands inline.
function PanelHeader({ brand, dashboardId, base, onCollapse }: {
  brand: React.ReactNode; dashboardId: string; base: string; onCollapse: () => void;
}) {
  const [searching, setSearching] = useState(false);
  return (
    <div className="group/header px-4 pb-2 pt-3.5">
      <div className="flex items-center gap-1">
        {brand}
        <button
          onClick={() => setSearching((v) => !v)} title="Rechercher"
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
        >
          <MagnifyingGlassIcon className="h-4 w-4" />
        </button>
        <button
          onClick={onCollapse} title="Replier le panneau"
          className="rounded-lg p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-sidebar-accent/60 hover:text-foreground group-hover/header:opacity-100"
        >
          <SidebarSimpleIcon className="h-4 w-4" />
        </button>
      </div>
      {searching && <div className="pt-2"><SidebarSearch dashboardId={dashboardId} base={base} /></div>}
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


/** Les destinations d'espace du suivi de travail, dans l'ordre de Plane. */
/**
 * Le premier niveau : ce qui est À MOI.
 *
 * Home, ce qui attend ma validation, mes notes. Aucune de ces destinations ne
 * dépend d'un projet, et c'est ce qui justifie qu'elles soient au-dessus de
 * tout le reste plutôt que rangées sous « Espace » — on y va pour savoir quoi
 * faire, pas pour consulter l'état d'un chantier.
 *
 * Brouillons et Votre travail ont quitté la barre, comme Vues, Archives et
 * Wiki sous « Espace » : leurs pages existent toujours à leur adresse, elles ne
 * méritaient simplement pas une ligne permanente.
 */
const TRACKER_PERSONAL: { slug: string; label: string; icon: PhosphorIcon }[] = [
  { slug: "projects", label: "Home", icon: HouseIcon },
  // Juste sous l'accueil : c'est la question qu'on se pose en arrivant, « est-ce
  // qu'un collaborateur attend quelque chose de moi ? ».
  { slug: "inbox", label: "À valider", icon: TrayIcon },
  { slug: "stickies", label: "Notes", icon: NotePencilIcon },
];

/** Le second niveau : ce qui est à TOUT LE MONDE. Dans la barre, un projet du
 *  tracker s'appelle une MISSION — le slug et les tables gardent « project ».
 *
 *  La force de travail en tête, puis ce qu'on lui confie et ce qui tourne
 *  autour, et enfin ce sur quoi elle s'appuie — ce qu'elle sait (Graph,
 *  Sources) et ce qu'elle atteint (Applications, Outils internes). Ces quatre
 *  derniers formaient une section « Ressources » à part ; une section de plus
 *  pour quatre lignes obligeait surtout à se demander où chercher.
 *
 *  `at` sort une entrée du tracker : ces pages vivent à leur adresse
 *  d'origine (/workflows, /memory/:vue, /connectors/:portée), pas sous
 *  /projects, si bien que chaque lien déjà partagé continue de répondre. C'est
 *  leur onglet — et leur vue, quand il en a plusieurs — qui les allume.
 *  « Mes connexions » n'y figure plus ; sa page répond toujours à
 *  /connectors/personal. */
const TRACKER_NAV: {
  slug: string; label: string; icon: PhosphorIcon;
  at?: { tab: string; sub?: string };
}[] = [
  { slug: "agents", label: "Super Intelligence", icon: RobotIcon },
  { slug: "all-projects", label: "Missions", icon: KanbanIcon },
  { slug: "workflows", label: "Workflows", icon: FlowArrowIcon, at: { tab: "workflows" } },
  { slug: "analytics", label: "Analytics", icon: ChartBarIcon },
  { slug: "boards", label: "Tableaux de bord", icon: SquaresFourIcon },
  { slug: "workgraph", label: "Workgraph", icon: GraphIcon },
  { slug: "graph", label: "Graph", icon: GraphIcon, at: { tab: "memory", sub: "graph" } },
  // Sources porte deux parties : les éléments du service, et le RAG
  // (collections vectorisées, /memory/sources/rag).
  { slug: "sources", label: "Sources", icon: DatabaseIcon, at: { tab: "memory", sub: "sources" } },
  // Les applications branchées sur l'espace (Composio), partagées par tous.
  { slug: "applications", label: "Applications", icon: PlugsConnectedIcon, at: { tab: "connectors", sub: "space" } },
  // Les outils hébergés par l'entreprise (Argo CD, Vault, Grafana…), hors
  // Composio : connecteurs décrits à la main, relais, journal d'accès (0267).
  { slug: "internal-tools", label: "Outils internes", icon: WrenchIcon, at: { tab: "connectors", sub: "internal" } },
];

/**
 * Les épingles de la navigation du tracker.
 *
 * On enregistre les slugs DÉCROCHÉS, pas les épinglés. C'est le seul sens qui
 * survit à l'ajout d'une destination : un nouvel onglet apparaît chez tout le
 * monde au lieu de rester invisible pour qui a personnalisé sa barre un jour.
 */
function useNavPins(dashboardId: string) {
  const key = `pj-nav-unpinned:${dashboardId}`;
  const [unpinned, setUnpinned] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      // Navigation privée, stockage bloqué : tout reste épinglé.
      return [];
    }
  });

  const toggle = (slug: string) => {
    setUnpinned((prev) => {
      const next = prev.includes(slug) ? prev.filter((v) => v !== slug) : [...prev, slug];
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* idem */ }
      return next;
    });
  };

  return { unpinned, toggle, isPinned: (slug: string) => !unpinned.includes(slug) };
}

/** L'épingle d'une ligne, visible seulement en mode personnalisation. */
function PinToggle({ pinned, onToggle, label }: {
  pinned: boolean; onToggle: () => void; label: string;
}) {
  return (
    <button
      type="button"
      title={pinned ? `Retirer de la barre · ${label}` : `Épingler · ${label}`}
      onClick={onToggle}
      className={cn(
        "shrink-0 rounded p-1 transition-colors hover:bg-sidebar-accent",
        pinned ? "text-foreground" : "text-muted-foreground/60 hover:text-foreground",
      )}
    >
      {pinned
        ? <PushPinIcon weight="fill" className="h-3.5 w-3.5" />
        : <PushPinSlashIcon className="h-3.5 w-3.5" />}
    </button>
  );
}

function TrackerPanel({ base, dashboardId, activeProjectId, activeView, activeSection, activeTab, activeSub }: {
  base: string; dashboardId: string;
  activeProjectId?: string; activeView?: string; activeSection?: string;
  /** L'onglet ouvert, et sa vue. Hors du tracker, « Home » s'allumerait sur
   *  toutes les autres pages — rooms, réglages… ; et les entrées qui ne sont
   *  pas des vues du tracker (Workflows, Graph, Applications…) s'allument sur
   *  leur propre onglet. */
  activeTab: string;
  activeSub?: string;
}) {
  const navigate = useNavigate();
  const inTracker = activeTab === "projects";
  const atOf = (slug: string) => TRACKER_NAV.find((n) => n.slug === slug)?.at;
  const { data: projects } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchTrackerProjects(dashboardId),
  });

  const { unpinned, toggle, isPinned } = useNavPins(dashboardId);
  const inboxCount = useCollaboratorInbox(dashboardId).data?.length ?? 0;
  // La personnalisation est un MODE, pas un écran de réglages : on veut voir la
  // barre changer sous ses doigts, et non deviner le résultat depuis une liste
  // de cases à cocher ailleurs.
  const [customizing, setCustomizing] = useState(false);
  const [openPersonal, setOpenPersonal] = useState(true);
  const [openSpace, setOpenSpace] = useState(true);
  const [openProjects, setOpenProjects] = useState(true);

  // `sub` porte soit une destination d'espace, soit un identifiant de projet.
  // Les distinguer par la liste des slugs connus évite d'introduire un
  // deuxième segment d'URL pour une différence que l'utilisateur ne voit pas.
  const known = [...TRACKER_PERSONAL, ...TRACKER_NAV].map((n) => n.slug);
  const onSpaceView = activeView ? known.includes(activeView) : false;

  const renderNav = (
    items: { slug: string; label: string; icon: PhosphorIcon }[],
    isActive: (slug: string) => boolean,
    go: (slug: string) => void,
  ) => (
    <nav className="space-y-0.5 px-2.5">
      {items
        // Hors personnalisation, les décrochés disparaissent : c'est tout
        // l'intérêt du geste. Pendant, ils restent là, sinon on décrocherait un
        // onglet sans plus jamais pouvoir le retrouver.
        .filter((n) => customizing || isPinned(n.slug))
        .map((n) => (
          <PanelItem
            key={n.slug}
            active={isActive(n.slug)}
            onClick={() => go(n.slug)}
            leading={n.slug === "agents"
              ? <span className="sd-rainbow-icon"><n.icon weight="fill" className="h-4 w-4" /></span>
              : <n.icon className="h-4 w-4" />}
            label={n.slug === "agents" ? <span className="sd-rainbow-text">{n.label}</span> : n.label}
            trailing={customizing
              ? <PinToggle pinned={isPinned(n.slug)} onToggle={() => toggle(n.slug)} label={n.label} />
              : n.slug === "inbox" && inboxCount > 0
                ? (
                  <span
                    className="mr-1.5 min-w-[20px] rounded-full bg-amber-500/15 px-1.5 text-center text-[11px] font-semibold tabular-nums text-amber-700 dark:text-amber-400"
                    title={`${inboxCount} élément${inboxCount > 1 ? "s" : ""} en attente`}
                  >
                    {inboxCount > 99 ? "99+" : inboxCount}
                  </span>
                )
                : undefined}
          />
        ))}
    </nav>
  );

  return (
    <div>
      {/* Le bouton du haut déploie un collaborateur : c'est l'entrée de
          l'Intelligence Space. Créer un work item reste à portée sur le board
          des work items, là où on le range. */}
      {/* En violet de marque : c'est l'action principale de l'espace, la seule
          de la barre qui porte la couleur pleine. */}
      <div className="px-2.5 pb-1">
        <button
          type="button"
          onClick={() => navigate(`${base}/agents/new`)}
          className="flex h-9 w-full items-center gap-2 rounded-lg bg-primary px-3 text-[13.5px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
        >
          <RocketLaunchIcon weight="bold" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">Deploy collaborator</span>
        </button>
      </div>

      <PanelSection
        label="Personnel"
        open={openPersonal}
        onToggle={() => setOpenPersonal((v) => !v)}
        count={TRACKER_PERSONAL.filter((n) => isPinned(n.slug)).length}
      />
      {openPersonal && renderNav(
        TRACKER_PERSONAL,
        (slug) => (slug === "projects"
          // « Home » est aussi la destination par défaut : sans projet ouvert
          // ni vue d'espace, c'est lui qui doit s'allumer.
          ? inTracker && !activeProjectId && !onSpaceView
          : activeView === slug),
        (slug) => navigate(`${base}/projects${slug === "projects" ? "" : `/${slug}`}`),
      )}


      <PanelSection
        label="Espace"
        open={openSpace}
        onToggle={() => setOpenSpace((v) => !v)}
        count={TRACKER_NAV.filter((n) => isPinned(n.slug)).length}
        menu={[
          {
            label: customizing ? "Terminer la personnalisation" : "Personnaliser la navigation",
            onSelect: () => setCustomizing((v) => !v),
          },
          ...(unpinned.length
            ? [{
              label: `Tout réafficher (${unpinned.length})`,
              onSelect: () => unpinned.forEach((slug) => toggle(slug)),
            }]
            : []),
        ]}
      />
      {openSpace && renderNav(
        TRACKER_NAV,
        (slug) => {
          const at = atOf(slug);
          return at ? activeTab === at.tab && (!at.sub || activeSub === at.sub) : activeView === slug;
        },
        (slug) => {
          const at = atOf(slug);
          navigate(at ? `${base}/${at.tab}${at.sub ? `/${at.sub}` : ""}` : `${base}/projects/${slug}`);
        },
      )}

      {customizing && (
        <p className="px-4 pb-1 pt-2 text-[12px] leading-snug text-muted-foreground">
          Décrochez ce que vous n'utilisez pas : la barre ne garde que vos épingles.
        </p>
      )}


      <PanelSection
        label="Missions"
        open={openProjects}
        onToggle={() => setOpenProjects((v) => !v)}
        count={projects?.length ?? 0}
      />
      {openProjects && (
        <nav className="space-y-0.5 px-2.5">
          {(projects ?? []).map((p) => (
            <ProjectNavItem
              key={p.id}
              project={p}
              base={base}
              open={activeProjectId === p.id}
              activeSection={activeSection}
              onOpen={() => navigate(`${base}/projects/${p.id}`)}
            />
          ))}
          {!projects?.length && (
            <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">Aucune mission.</p>
          )}
        </nav>
      )}
    </div>
  );
}

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
          <span className="min-w-0 truncate">{label}</span>
          {!open && count != null && <span className="shrink-0 text-[12px] tabular-nums">{count}</span>}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{label}</span>
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

// Floating assistant button (bottom-right in every mockup) — starts a room.
function AssistantLauncher({ base, dashboard, workspaceId, projectId }: {
  base: string; dashboard: { id: string; name: string }; workspaceId: string; projectId: string;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <button
      title="Parler à l'assistant"
      disabled={busy}
      onClick={async () => {
        if (!user) return;
        setBusy(true);
        try {
          const id = await createRoom(dashboard, workspaceId, projectId, user.id, "Nouvelle room");
          queryClient.invalidateQueries({ queryKey: ["service_rooms", dashboard.id] });
          if (id) navigate(`${base}/room/${id}`);
        } finally { setBusy(false); }
      }}
      className="fixed bottom-5 right-5 z-30 rounded-full p-1 shadow-lg transition-transform hover:scale-105 disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /> : <AgentOrb size={30} />}
    </button>
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
              className="-ml-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-sidebar-accent/60"
              title={current?.name ?? "Dashboard"}
            >
              <DashboardTile icon={current?.icon} color={current?.color ?? "bg-indigo-500"} size={26} />
              <span className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight">{label}</span>
            </button>
          ) : (
            <button className="rounded-xl transition-transform hover:scale-105" title={current?.name ?? "Dashboard"}>
              <DashboardTile icon={current?.icon} color={current?.color ?? "bg-indigo-500"} size={34} />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side={label ? "bottom" : "right"} className="w-64 rounded-2xl p-1.5">
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
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-sidebar-accent/40 px-2.5 focus-within:border-border">
        <MagnifyingGlassIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Rechercher…"
          className="h-8 flex-1 bg-transparent text-[13px] placeholder:text-muted-foreground/70 focus:outline-none"
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
