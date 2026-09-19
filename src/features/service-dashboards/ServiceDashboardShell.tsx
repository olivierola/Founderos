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
  DotsThreeIcon, PencilSimpleIcon, TrashIcon, HashIcon, SidebarSimpleIcon, UsersThreeIcon, UserIcon,
  TargetIcon, GlobeIcon, FlowArrowIcon, KanbanIcon, FlagIcon, EyeIcon,
  ArrowsClockwiseIcon, StackIcon, NotePencilIcon, ArchiveIcon, PushPinIcon, PackageIcon,
  PushPinSlashIcon, BookOpenIcon,
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
  type ServiceDashboard, type Room, type DashboardTabSlug,
} from "./model";
import { RoomView } from "./RoomView";
import { SidebarProfileFooter } from "./SidebarProfileFooter";
import { SidebarGetStarted } from "./GetStarted";
import { DocsPage, DocsPanel } from "./docs/DocsPage";
import {
  AgentsTab, SchedulesTab, WorkspaceMemoryTab, HomeTab, AgentDetailInDashboard,
  AgentConfigInDashboard,
} from "./ServiceDashboardTabs";
import { DashboardMissionsTab } from "./RoomMissions";
import { TrackerTab } from "@/features/tracker/TrackerTab";
import { fetchProjects as fetchTrackerProjects } from "@/features/tracker/model";
import { ProjectLogo } from "@/features/tracker/LogoPicker";
import { CreateWorkItemModal } from "@/features/tracker/CreateWorkItem";
import { ComposioCatalog } from "@/features/integrations/ComposioCatalog";
import { WorkflowsList } from "@/features/workflows/WorkflowsList";
import { WorkflowDocument } from "@/features/workflows/WorkflowDocument";
import { DashboardSettingsTab, DASHBOARD_SETTINGS_SECTIONS, type DashboardSettingsSection } from "./DashboardSettings";
import { CreateAgentPage } from "./CreateAgent";
import { PublicAgentInDashboard } from "./PublicAgentInDashboard";
import { fetchAgentFolders } from "./agentFolders";
import { DashboardTile } from "./dashboardIcons";
import { ThemeMenu } from "@/components/ThemeMenu";
import { AssistantProvider, useAssistant } from "@/lib/assistant-context";
import { AssistantPanel } from "@/features/ai-agent/AssistantPanel";

// ── Structure ────────────────────────────────────────────────────────────────
// Two rails, like the reference: a narrow icon rail holding the top-level
// sections, and a contextual panel showing that section's own navigation
// (Home → rooms & agent DMs, Agents → the roster, Memory → its views, Settings
// → its sections). The content is flush — no floating rounded panel.
type RailKey = "home" | "projects" | "resources" | "settings" | "docs";

const RAIL: { key: RailKey; label: string; icon: PhosphorIcon; tab: DashboardTabSlug | "settings" }[] = [
  // Le suivi de travail EN TÊTE : c'est le module principal du service, celui
  // où l'on passe la journée. Il porte l'accueil, les projets, les rooms et les
  // messages — c'est-à-dire le travail et ce qu'on en dit, au même endroit.
  { key: "projects", label: "Travail", icon: KanbanIcon, tab: "projects" },
  // Home reste, en second : sa page d'assistant et ses onglets secondaires
  // (missions, statistiques, planifications) n'ont pas disparu, ils ne sont
  // simplement plus la première chose qu'on voit.
  { key: "home", label: "Assistant", icon: HouseIcon, tab: "home" },
  // Memory + connections + workflows in one section: they are the three things
  // the workforce DRAWS ON rather than three separate destinations — what it
  // knows, what it can reach, and what fires around it. Two rail icons for the
  // first two only made you guess which one held a given setup step.
  { key: "resources", label: "Ressources", icon: DatabaseIcon, tab: "memory" },
];

// Tabs that live INSIDE the Home panel rather than on the rail.
const HOME_NAV: { slug: DashboardTabSlug | "dashboard" | "missions"; label: string; icon: PhosphorIcon }[] = [
  // Missions first: it is the board where the service's collective work lives,
  // and it is what people come back to between conversations.
  { slug: "missions", label: "Missions", icon: TargetIcon },
  { slug: "schedules", label: "Schedules", icon: CalendarDotsIcon },
];

// The Ressources panel, in three groups. Each entry carries the tab it routes
// to, so the merged section keeps the ORIGINAL urls — /memory/:view and
// /connectors/:scope still resolve, and every deep link that ever shipped keeps
// working. Only the rail merged; the routes did not.
const RESOURCE_GROUPS: {
  label: string;
  items: { tab: "memory" | "connectors" | "workflows"; key: string; label: string; icon: PhosphorIcon }[];
}[] = [
  {
    label: "Mémoire",
    items: [
      { tab: "memory", key: "graph", label: "Graph", icon: GraphIcon },
      { tab: "memory", key: "memories", label: "Memories", icon: BrainIcon },
      { tab: "memory", key: "sources", label: "Sources", icon: DatabaseIcon },
    ],
  },
  {
    // The scope separation is the whole point, so it lives in the navigation
    // rather than in a chip row: a shared account and someone's own mailbox are
    // not two filters of one list.
    label: "Connexions",
    items: [
      { tab: "connectors", key: "space", label: "Connexions de l'espace", icon: UsersThreeIcon },
      { tab: "connectors", key: "personal", label: "Mes connexions", icon: UserIcon },
    ],
  },
  {
    label: "Automatisations",
    items: [
      { tab: "workflows", key: "list", label: "Workflows", icon: FlowArrowIcon },
    ],
  },
];

const SETTINGS_ICONS: Record<string, PhosphorIcon> = {
  general: SlidersIcon, navigation: SquaresFourIcon, assistant: SparkleIcon,
  agents: RobotIcon, rooms: ChatsCircleIcon, danger: WarningIcon,
};

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

  const { data: dashboards } = useQuery({
    queryKey: ["service_dashboards", projectId],
    enabled: !!projectId,
    queryFn: () => fetchServiceDashboards(projectId!),
  });
  const current = (dashboards ?? []).find((d) => d.id === dashboardId) ?? null;
  const settings = current?.settings ?? DEFAULT_DASHBOARD_SETTINGS;
  const hidden = (slug: string) => settings.hidden_tabs.includes(slug as DashboardTabSlug);

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
  // Which rail entry lights up: agent pages belong to Agents, rooms and the
  // secondary tabs (missions/dashboard/schedules/artifacts) belong to Home, and
  // memory + connections + workflows share the merged Ressources section.
  const RESOURCE_TABS = ["memory", "connectors", "workflows"];
  // TOUT ce qui touche aux agents appartient au module de travail : le roster,
  // la fiche d'un agent, sa configuration, un agent public, et jusqu'à sa
  // création. C'était auparavant un rail séparé, ce qui posait la force de
  // travail à côté du travail — deux mondes parallèles entre lesquels il fallait
  // faire l'aller-retour pour savoir qui fait quoi.
  const rail: RailKey = activeTab === "projects" || activeTab === "agents"
    || activeTab === "room" || isAgent || isAgentConfig || isPublicAgent || isCreateAgent
    ? "projects"
    : RESOURCE_TABS.includes(activeTab) ? "resources"
    : activeTab === "settings" ? "settings"
    : activeTab === "docs" ? "docs"
    : "home";

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
  }, [activeTab, base, navigate]);

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
  const mainScrolls = !SELF_SCROLLING.includes(activeTab);

  // Panel (second sidebar) can be folded away; the rail always stays.
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

  const railItems = RAIL.filter((r) => r.key === "home" || !hidden(r.key));
  const panelTitle = rail === "home" ? "Assistant"
    : rail === "projects" ? "Travail"
    : rail === "resources" ? "Ressources"
    : rail === "docs" ? "Documentation" : "Settings";

  return (
    // The SaaS assistant lives here too: internal agents are configured through
    // it (see ToolSetupReminder), and this is now the only place an agent opens.
    <AssistantProvider>
    <div className="flex h-screen w-full overflow-hidden bg-[hsl(var(--sd-ground))] text-foreground">
      {/* ── Icon rail ── */}
      <aside className="flex h-full w-[60px] shrink-0 flex-col items-center gap-1.5 py-3">
        <DashboardSelector current={current} dashboards={dashboards ?? []} />
        <PanelToggleButton collapsed={collapsed} onToggle={toggleCollapsed} />
        <div className="mt-1.5 flex flex-1 flex-col items-center gap-1.5">
          {railItems.map((r) => (
            <RailButton
              key={r.key} icon={r.icon} label={r.label} active={rail === r.key}
              onClick={() => navigate(`${base}/${r.tab}`)}
            />
          ))}
          <RailButton
            icon={GearSixIcon} label="Paramètres du service" active={rail === "settings"}
            onClick={() => navigate(`${base}/settings`)}
          />
        </div>
        {/* Same picker as the Topbar's — this space has no navbar, so the
            theme (and the assistant) have to be reachable from the rail. */}
        <RailButton
          icon={BookOpenIcon} label="Documentation" active={rail === "docs"}
          onClick={() => navigate(`${base}/docs`)}
        />
        <AssistantRailButton />
        <ThemeMenu align="start" className="h-10 w-10 hover:bg-sidebar-accent/60" />
        <SidebarProfileFooter compact />
      </aside>

      {/* Panel + content float together as ONE rounded card laid on the ground
          (the rail keeps the ground colour behind it). */}
      <div className="flex min-w-0 flex-1 py-2 pr-2">
        <div className="flex min-w-0 flex-1 overflow-hidden rounded-2xl border border-border/60 bg-background shadow-sm">
      {/* ── Contextual panel ── */}
      <aside className={cn(
        // Its own tone, a shade off the content it sits next to.
        "h-full shrink-0 overflow-hidden border-r border-border/60 bg-[hsl(var(--sd-panel))] transition-[width] duration-300 ease-in-out",
        collapsed ? "w-0" : "w-[268px]",
      )}>
        <div className="flex h-full w-[268px] flex-col">
          <PanelHeader title={panelTitle} dashboardId={dashboardId!} base={base} onCollapse={toggleCollapsed} />

          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {rail === "home" && (
              <HomePanel base={base} dashboardId={dashboardId!} activeTab={activeTab} sub={sub} hidden={hidden}
                dashboardName={current?.name ?? "Service"} workspaceId={workspaceId} projectId={projectId} />
            )}
            {rail === "projects" && (
              <>
                <TrackerPanel
                  base={base} dashboardId={dashboardId!}
                  activeProjectId={sub} activeView={sub} activeSection={leaf}
                />
                {/* Pas de liste d'agents ici : l'onglet Agents la porte déjà,
                    avec ses dossiers et ses cartes. La répéter dans la barre
                    latérale ne donnait aucun accès nouveau — seulement deux
                    endroits à parcourir des yeux pour la même information, et
                    un panneau qu'il fallait faire défiler pour atteindre les
                    rooms. */}
                {/* Les rooms SOUS les projets, dans le même panneau. Une room
                    est une conversation sur du travail : devoir changer de rail
                    pour passer du board à ce qu'on en dit casse le fil. */}
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
                  // Agents : une troisième énumération de la même chose. Ils
                  // restent dans le panneau Assistant, où ils voisinent avec ce
                  // qui relève de la conversation.
                  showMessages={false}
                />
              </>
            )}
            {rail === "resources" && (
              <ResourcesPanel
                base={base}
                activeTab={activeTab}
                activeSub={sub || (activeTab === "connectors" ? "space" : "graph")}
              />
            )}
            {rail === "settings" && <SettingsPanel base={base} active={(sub || "general") as DashboardSettingsSection} />}
            {rail === "docs" && (
              <DocsPanel
                active={sub ?? null}
                onSelect={(slug) => navigate(slug ? `${base}/docs/${slug}` : `${base}/docs`)}
              />
            )}
          </div>

          {(rail === "home" || rail === "projects") && <SidebarGetStarted dashboardId={dashboardId!} />}
        </div>
      </aside>

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
            {activeTab === "home" && <HomeTab dashboardId={dashboardId!} dashboardName={current.name} workspaceId={workspaceId} projectId={projectId} />}
            {activeTab === "agents" && <AgentsTab dashboardId={dashboardId!} />}
            {activeTab === "schedules" && <SchedulesTab dashboardId={dashboardId!} workspaceId={workspaceId} projectId={projectId} />}
            {activeTab === "missions" && (
              <DashboardMissionsTab dashboardId={dashboardId!} dashboardName={current.name} workspaceId={workspaceId} projectId={projectId} />
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
            {activeTab === "memory" && <WorkspaceMemoryTab workspaceId={workspaceId} dashboardId={dashboardId!} projectId={projectId} view={sub || "graph"} />}
            {activeTab === "connectors" && (
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

// Opens the SaaS assistant from the rail — the configuration surface for the
// agents that live in this dashboard.
function AssistantRailButton() {
  const assistant = useAssistant();
  return (
    <button
      onClick={assistant.toggle}
      title="Assistant IA"
      aria-label="Assistant IA"
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
        assistant.open ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <ChatsCircleIcon weight="duotone" className="h-[18px] w-[18px]" />
    </button>
  );
}

// Folding the panel takes its header — and the header's fold button — with it,
// so the way back has to sit on the rail, the one column that never folds. Same
// corner as the button that folded it, so it reads as the same control.
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

function RailButton({ icon: Icon, label, active, onClick }: {
  icon: PhosphorIcon; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick} title={label} aria-label={label}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
        active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}

// Panel header — section title + a search affordance that expands inline.
function PanelHeader({ title, dashboardId, base, onCollapse }: {
  title: string; dashboardId: string; base: string; onCollapse: () => void;
}) {
  const [searching, setSearching] = useState(false);
  return (
    <div className="group/header px-4 pb-2 pt-3.5">
      <div className="flex items-center gap-1">
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight">{title}</h1>
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

// ── Home panel — the assistant, the secondary tabs, rooms and agent DMs ──────
function HomePanel({ base, dashboardId, activeTab, sub, hidden, dashboardName, workspaceId, projectId }: {
  base: string; dashboardId: string; activeTab: string; sub?: string;
  hidden: (slug: string) => boolean; dashboardName: string;
  workspaceId: string | null; projectId: string | null;
}) {
  const navigate = useNavigate();

  return (
    <>
      <nav className="space-y-0.5 px-2.5">
        <PanelItem
          active={activeTab === "home"}
          onClick={() => navigate(`${base}/home`)}
          leading={<HouseIcon className="h-4 w-4" />}
          label="Home"
        />
        {HOME_NAV.filter((n) => !hidden(n.slug)).map((n) => (
          <PanelItem
            key={n.slug} active={activeTab === n.slug} onClick={() => navigate(`${base}/${n.slug}`)}
            leading={<n.icon className="h-4 w-4" />} label={n.label}
          />
        ))}
      </nav>

      <div className="mx-4 my-3 border-t border-border/60" />

      <RoomsAndMessages
        base={base}
        dashboardId={dashboardId}
        activeTab={activeTab}
        sub={sub}
        dashboardName={dashboardName}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </>
  );
}

/**
 * Les rooms et les messages directs.
 *
 * Rendus à DEUX endroits : dans le panneau Home et dans celui du module de
 * suivi. C'est délibéré et ce n'est pas une duplication — une room est une
 * conversation sur du travail, et devoir changer de rail pour passer du board
 * à ce qu'on en dit casse le fil de la pensée.
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
 * l'autre leur mise en forme.
 */
function useCollapsed(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(key) !== "0"; } catch { return true; }
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


/** Memory, connections and workflows under one rail entry, grouped so the three
 *  subjects stay legible instead of becoming one flat list of six links. */
/**
 * Le panneau du rail Projets : la liste des projets de suivi.
 *
 * Il ne porte QUE la liste, pas les sections d'un projet (work items, cycles,
 * modules…) : celles-ci changent d'un projet à l'autre selon ce qu'il active,
 * et les remonter ici ferait un panneau dont le contenu se réorganise à chaque
 * changement de projet.
 */
/** Les destinations d'espace du suivi de travail, dans l'ordre de Plane. */
/**
 * Le premier niveau : ce qui est À MOI.
 *
 * Home, mes brouillons, ce qui m'est assigné, mes notes. Aucune de ces quatre
 * destinations ne dépend d'un projet, et c'est ce qui justifie qu'elles soient
 * au-dessus de tout le reste plutôt que rangées sous « Espace » — on y va pour
 * savoir quoi faire, pas pour consulter l'état d'un chantier.
 */
const TRACKER_PERSONAL: { slug: string; label: string; icon: PhosphorIcon }[] = [
  { slug: "projects", label: "Home", icon: HouseIcon },
  { slug: "drafts", label: "Brouillons", icon: PencilSimpleIcon },
  { slug: "my-work", label: "Votre travail", icon: UserIcon },
  { slug: "stickies", label: "Notes", icon: NotePencilIcon },
];

/** Le second niveau : ce qui est à TOUT LE MONDE. */
const TRACKER_NAV: { slug: string; label: string; icon: PhosphorIcon }[] = [
  { slug: "all-projects", label: "Projets", icon: KanbanIcon },
  { slug: "agents", label: "Agents", icon: RobotIcon },
  { slug: "initiatives", label: "Initiatives", icon: FlagIcon },
  { slug: "active-cycles", label: "Cycles", icon: ArrowsClockwiseIcon },
  { slug: "analytics", label: "Analytics", icon: ChartBarIcon },
  { slug: "views", label: "Vues", icon: EyeIcon },
  { slug: "archives", label: "Archives", icon: ArchiveIcon },
  { slug: "boards", label: "Tableaux de bord", icon: SquaresFourIcon },
  { slug: "workgraph", label: "Workgraph", icon: GraphIcon },
  { slug: "wiki", label: "Wiki", icon: FilesIcon },
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

function TrackerPanel({ base, dashboardId, activeProjectId, activeView, activeSection }: {
  base: string; dashboardId: string;
  activeProjectId?: string; activeView?: string; activeSection?: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: projects } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchTrackerProjects(dashboardId),
  });

  const { unpinned, toggle, isPinned } = useNavPins(dashboardId);
  // La personnalisation est un MODE, pas un écran de réglages : on veut voir la
  // barre changer sous ses doigts, et non deviner le résultat depuis une liste
  // de cases à cocher ailleurs.
  const [customizing, setCustomizing] = useState(false);
  const [creating, setCreating] = useState(false);
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
            leading={<n.icon className="h-4 w-4" />}
            label={n.label}
            trailing={customizing
              ? <PinToggle pinned={isPinned(n.slug)} onToggle={() => toggle(n.slug)} label={n.label} />
              : undefined}
          />
        ))}
    </nav>
  );

  return (
    <div>
      {/* Le bouton de création tient le haut de la barre, comme dans Plane :
          noter une tâche est le geste le plus fréquent du module, et le faire
          descendre au niveau des destinations le mettrait à égalité avec des
          liens qu'on clique dix fois moins souvent. */}
      <div className="px-2.5 pb-1">
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex h-8 w-full items-center gap-2 rounded-lg border border-sidebar-border/60 bg-sidebar-accent/70 px-2.5 text-[13.5px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <PlusIcon weight="bold" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">Nouveau work item</span>
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
          ? !activeProjectId && !onSpaceView
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
        (slug) => activeView === slug,
        (slug) => navigate(`${base}/projects/${slug}`),
      )}

      {customizing && (
        <p className="px-4 pb-1 pt-2 text-[12px] leading-snug text-muted-foreground">
          Décrochez ce que vous n'utilisez pas : la barre ne garde que vos épingles.
        </p>
      )}


      <PanelSection
        label="Projets"
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
            <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">Aucun projet.</p>
          )}
        </nav>
      )}

      {creating && (
        <CreateWorkItemModal
          dashboardId={dashboardId}
          // Le projet ouvert est pré-choisi : depuis un projet on crée pour lui
          // neuf fois sur dix, et depuis l'espace on choisit.
          projectId={activeProjectId ?? null}
          onClose={() => setCreating(false)}
          onCreated={() => qc.invalidateQueries({ queryKey: ["pj_issues"] })}
        />
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

  const SECTIONS: { slug: string; label: string; icon: PhosphorIcon }[] = [
    { slug: "overview", label: "Overview", icon: SquaresFourIcon },
    { slug: "issues", label: "Work items", icon: KanbanIcon },
    { slug: "cycles", label: "Cycles", icon: ArrowsClockwiseIcon },
    { slug: "modules", label: "Modules", icon: StackIcon },
    { slug: "views", label: "Views", icon: EyeIcon },
    { slug: "pages", label: "Pages", icon: FilesIcon },
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

function ResourcesPanel({ base, activeTab, activeSub }: {
  base: string; activeTab: string; activeSub: string;
}) {
  const navigate = useNavigate();
  return (
    <div className="space-y-3">
      {RESOURCE_GROUPS.map((g) => (
        <div key={g.label}>
          <div className="px-4 pb-1 text-[12px] text-muted-foreground">{g.label}</div>
          <nav className="space-y-0.5 px-2.5">
            {g.items.map((v) => (
              <PanelItem
                key={`${v.tab}/${v.key}`}
                active={activeTab === v.tab && (v.tab === "workflows" || activeSub === v.key)}
                onClick={() => navigate(v.tab === "workflows" ? `${base}/workflows` : `${base}/${v.tab}/${v.key}`)}
                leading={<v.icon className="h-4 w-4" />}
                label={v.label}
              />
            ))}
          </nav>
        </div>
      ))}
    </div>
  );
}

function SettingsPanel({ base, active }: { base: string; active: DashboardSettingsSection }) {
  const navigate = useNavigate();
  const main = DASHBOARD_SETTINGS_SECTIONS.filter((s) => s.key !== "danger");
  const danger = DASHBOARD_SETTINGS_SECTIONS.find((s) => s.key === "danger");
  return (
    <>
      <div className="px-4 pb-1 pt-1 text-[12px] text-muted-foreground">Service</div>
      <nav className="space-y-0.5 px-2.5">
        {main.map((s) => {
          const Icon = SETTINGS_ICONS[s.key] ?? SlidersIcon;
          return (
            <PanelItem
              key={s.key} active={active === s.key} onClick={() => navigate(`${base}/settings/${s.key}`)}
              leading={<Icon className="h-4 w-4" />} label={s.label}
            />
          );
        })}
      </nav>
      {danger && (
        <>
          <div className="px-4 pb-1 pt-3 text-[12px] text-muted-foreground">Danger</div>
          <nav className="space-y-0.5 px-2.5">
            <PanelItem
              active={active === "danger"} onClick={() => navigate(`${base}/settings/danger`)}
              leading={<WarningIcon className="h-4 w-4" />} label={danger.label} tone="danger"
            />
          </nav>
        </>
      )}
    </>
  );
}

function PanelItem({ active, onClick, leading, label, tone, trailing }: {
  active: boolean; onClick: () => void; leading: React.ReactNode; label: string; tone?: "danger";
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
        active ? (tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-sidebar-accent text-foreground")
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
        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-muted-foreground">{leading}</span>
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
    if (!confirm("Supprimer cette room et tous ses messages ?")) return;
    await deleteRoom(r.id);
    queryClient.invalidateQueries({ queryKey: ["service_rooms", dashboardId] });
    if (active) navigate(`${base}/home`);
  }

  return (
    <div className={cn("group flex items-center rounded-lg pr-1 transition-colors", active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60")}>
      <button
        onClick={() => navigate(`${base}/room/${r.id}`)}
        className={cn("flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left text-[13.5px]", active ? "font-medium text-foreground" : "text-sidebar-foreground")}
      >
        <HashIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
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

// Dashboard selector — the coloured tile at the top of the rail.
function DashboardSelector({ current, dashboards }: { current: ServiceDashboard | null; dashboards: ServiceDashboard[] }) {
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
    if (!confirm("Supprimer ce dashboard de service ? Les agents qu'il contient ne seront pas supprimés (juste dissociés).")) return;
    await deleteServiceDashboard(id);
    queryClient.invalidateQueries({ queryKey: ["service_dashboards", projectId] });
    navigate(`${base}/${dashboardLandingSlug("workforce")}`);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="rounded-xl transition-transform hover:scale-105" title={current?.name ?? "Dashboard"}>
            <DashboardTile icon={current?.icon} color={current?.color ?? "bg-indigo-500"} size={34} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="w-64 rounded-2xl p-1.5">
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
