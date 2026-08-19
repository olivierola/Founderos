import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
// Phosphor everywhere in this dashboard — one icon family, consistent weights
// (the app's Admin nav already uses it).
import {
  HouseIcon, RobotIcon, BrainIcon, GearSixIcon, ChartBarIcon, CalendarDotsIcon, FilesIcon,
  ChatsCircleIcon, GraphIcon, DatabaseIcon, SlidersIcon, SquaresFourIcon,
  SparkleIcon, WarningIcon, MagnifyingGlassIcon, PlusIcon, CheckIcon, CaretDownIcon,
  DotsThreeIcon, PencilSimpleIcon, TrashIcon, HashIcon, SidebarSimpleIcon, UsersThreeIcon, UserIcon,
  TargetIcon, GlobeIcon, FlowArrowIcon,
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
import {
  fetchServiceDashboards, createServiceDashboard, deleteServiceDashboard, fetchRooms, renameRoom, deleteRoom,
  createRoom, deleteEmptyRooms, DEFAULT_DASHBOARD_SETTINGS,
  type ServiceDashboard, type Room, type DashboardTabSlug,
} from "./model";
import { RoomView } from "./RoomView";
import { SidebarProfileFooter } from "./SidebarProfileFooter";
import { SidebarGetStarted } from "./SidebarGetStarted";
import {
  AgentsTab, SchedulesTab, WorkspaceMemoryTab, HomeTab, DashboardStatsTab, AgentDetailInDashboard,
  AgentConfigInDashboard,
} from "./ServiceDashboardTabs";
import { DashboardArtifactsPage } from "./RoomArtifacts";
import { DashboardMissionsTab } from "./RoomMissions";
import { ComposioCatalog } from "@/features/integrations/ComposioCatalog";
import { WorkflowsList } from "@/features/workflows/WorkflowsList";
import { WorkflowCanvas } from "@/features/workflows/WorkflowCanvas";
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
type RailKey = "home" | "agents" | "resources" | "settings";

const RAIL: { key: RailKey; label: string; icon: PhosphorIcon; tab: DashboardTabSlug | "settings" }[] = [
  { key: "home", label: "Home", icon: HouseIcon, tab: "home" },
  { key: "agents", label: "Agents", icon: RobotIcon, tab: "agents" },
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
  // Replaces the old "Activity" run feed — the whole service's statistics, the
  // feed included (see DashboardStatsTab).
  { slug: "dashboard", label: "Dashboard", icon: ChartBarIcon },
  { slug: "schedules", label: "Schedules", icon: CalendarDotsIcon },
  { slug: "artifacts", label: "Artifacts", icon: FilesIcon },
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
  const { workspaceSlug, projectSlug, dashboardId, tab, sub } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const navigate = useNavigate();
  const base = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;

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
  const isWorkflowCanvas = tab === "workflows" && !!sub;
  // Unknown tabs (old links, e.g. the retired /new-room) fall back to the
  // dashboard's landing page rather than rendering an empty content area.
  const KNOWN = ["home", "agents", "schedules", "dashboard", "missions", "memory", "artifacts", "connectors", "workflows", "settings"];
  const activeTab = isRoom ? "room"
    : isAgent ? "agent"
    : isAgentConfig ? "agent-config"
    : isPublicAgent ? "public"
    : (tab && KNOWN.includes(tab) ? tab : settings.landing);
  // Which rail entry lights up: agent pages belong to Agents, rooms and the
  // secondary tabs (missions/dashboard/schedules/artifacts) belong to Home, and
  // memory + connections + workflows share the merged Ressources section.
  const RESOURCE_TABS = ["memory", "connectors", "workflows"];
  const rail: RailKey = activeTab === "agents" || isAgent || isAgentConfig || isPublicAgent ? "agents"
    : RESOURCE_TABS.includes(activeTab) ? "resources"
    : activeTab === "settings" ? "settings"
    : "home";

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
  const panelTitle = rail === "home" ? "Home" : rail === "agents" ? "Agents" : rail === "resources" ? "Ressources" : "Settings";

  return (
    // The SaaS assistant lives here too: internal agents are configured through
    // it (see ToolSetupReminder), and this is now the only place an agent opens.
    <AssistantProvider>
    <div className="flex h-screen w-screen overflow-hidden bg-[hsl(var(--sd-ground))] text-foreground">
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
            {rail === "agents" && (
              <AgentsPanel
                base={base} dashboardId={dashboardId!}
                activeAgent={isAgent || isAgentConfig ? sub : undefined}
                activePublicAgent={isPublicAgent ? sub : undefined}
              />
            )}
            {rail === "resources" && (
              <ResourcesPanel
                base={base}
                activeTab={activeTab}
                activeSub={sub || (activeTab === "connectors" ? "space" : "graph")}
              />
            )}
            {rail === "settings" && <SettingsPanel base={base} active={(sub || "general") as DashboardSettingsSection} />}
          </div>

          {(rail === "home" || rail === "agents") && <SidebarGetStarted dashboardId={dashboardId!} />}
        </div>
      </aside>

      {/* ── Content ── */}
      <main className="relative min-w-0 flex-1 overflow-y-auto bg-background">
        {!current ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Dashboard introuvable.</div>
        ) : !workspaceId || !projectId ? (
          <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : isRoom ? (
          <RoomView dashboardId={dashboardId!} roomId={sub!} workspaceId={workspaceId} />
        ) : isWorkflowCanvas ? (
          <WorkflowCanvas workflowId={sub!} onBack={() => navigate(`${base}/workflows`)} />
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
            {activeTab === "dashboard" && <DashboardStatsTab dashboardId={dashboardId!} dashboardName={current.name} />}
            {activeTab === "missions" && (
              <DashboardMissionsTab dashboardId={dashboardId!} dashboardName={current.name} workspaceId={workspaceId} projectId={projectId} />
            )}
            {activeTab === "memory" && <WorkspaceMemoryTab workspaceId={workspaceId} dashboardId={dashboardId!} projectId={projectId} view={sub || "graph"} />}
            {activeTab === "artifacts" && <DashboardArtifactsPage workspaceId={workspaceId} projectId={projectId} />}
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

  const { data: rooms } = useQuery({
    queryKey: ["service_rooms", dashboardId],
    queryFn: () => fetchRooms(dashboardId),
  });

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

      <PanelSection
        label="Rooms"
        onAdd={newRoom}
        menu={[
          { label: "Nettoyer les rooms vides", onSelect: async () => {
            await deleteEmptyRooms(dashboardId);
            queryClient.invalidateQueries({ queryKey: ["service_rooms", dashboardId] });
          } },
          { label: "Paramètres des rooms", onSelect: () => navigate(`${base}/settings/rooms`) },
        ]}
      />
      <div className="space-y-0.5 px-2.5">
        {(rooms ?? []).length === 0
          ? <p className="px-2.5 py-1 text-[13px] text-muted-foreground">Nothing here.</p>
          : (rooms ?? []).map((r) => (
            <RoomRow key={r.id} r={r} active={activeTab === "room" && sub === r.id} base={base} dashboardId={dashboardId} />
          ))}
      </div>

      <PanelSection label="Messages" onAdd={() => navigate(`${base}/agents/new`)} />
      <div className="space-y-0.5 px-2.5">
        {dms.length === 0
          ? <p className="px-2.5 py-1 text-[13px] text-muted-foreground">Nothing here.</p>
          : dms.map((a) => (
            <PanelItem
              key={a.id} active={activeTab === "agent" && sub === a.id}
              onClick={() => navigate(`${base}/agent/${a.id}`)}
              leading={<AgentIdentity url={a.avatar_url} seed={a.name} size={18} rounded="rounded-md" />}
              label={a.name}
            />
          ))}
      </div>
    </>
  );
}

// ── Agents panel — the roster, grouped by folder (0161) like the page ────────
interface PanelAgent {
  id: string; name: string; avatar_url: string | null; accent_color: string | null;
  is_orchestrator: boolean; folder_id: string | null;
}

function AgentsPanel({ base, dashboardId, activeAgent, activePublicAgent }: {
  base: string; dashboardId: string; activeAgent?: string; activePublicAgent?: string;
}) {
  const navigate = useNavigate();
  const { data: agents } = useQuery({
    queryKey: ["sd_panel_agents", dashboardId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name, avatar_url, accent_color, is_orchestrator, folder_id")
        .eq("service_dashboard_id", dashboardId).eq("is_archived", false)
        .order("is_orchestrator", { ascending: false }).order("created_at", { ascending: true });
      return (data ?? []) as PanelAgent[];
    },
  });
  const { data: folders } = useQuery({
    queryKey: ["agent_folders", dashboardId],
    queryFn: () => fetchAgentFolders(dashboardId),
  });
  // Public (customer-facing) agents of this service — their own group, since
  // they answer to your customers rather than to the team, and their pages are
  // a different set (Playground / Knowledge / Widget / …).
  const { data: publics } = useQuery({
    queryKey: ["sd_panel_public_agents", dashboardId],
    queryFn: async () => {
      const { data } = await supabase.from("rag_agents")
        .select("id, name, accent_color, enabled")
        .eq("service_dashboard_id", dashboardId).order("created_at", { ascending: true });
      return (data ?? []) as { id: string; name: string; accent_color: string | null; enabled: boolean }[];
    },
  });

  const list = (agents ?? []).filter((a) => !a.is_orchestrator);
  const unfiled = list.filter((a) => !a.folder_id);
  const hasFolders = (folders ?? []).length > 0;

  return (
    <>
      {(folders ?? []).map((f) => (
        <AgentFolderGroup
          key={f.id} id={f.id} label={f.name} dot={f.color}
          agents={list.filter((a) => a.folder_id === f.id)}
          base={base} activeAgent={activeAgent}
        />
      ))}
      {(unfiled.length > 0 || !hasFolders) && (
        <AgentFolderGroup
          id="unfiled"
          label={hasFolders ? "Sans dossier" : "All agents"}
          agents={unfiled}
          base={base} activeAgent={activeAgent}
        />
      )}
      {(publics ?? []).length > 0 && (
        <>
          <div className="px-4 pb-1 pt-3 text-[13px] text-muted-foreground">Agents publics</div>
          <div className="mb-1 space-y-0.5 px-2.5">
            {(publics ?? []).map((a) => (
              <PanelItem
                key={a.id} active={activePublicAgent === a.id}
                onClick={() => navigate(`${base}/public/${a.id}`)}
                leading={
                  <span className="relative flex h-[18px] w-[18px] items-center justify-center rounded-md"
                    style={{ background: `${a.accent_color || "#001BB7"}26` }}>
                    <GlobeIcon weight="duotone" className="h-3 w-3" style={{ color: a.accent_color || "#001BB7" }} />
                    <span className={cn("absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-sidebar",
                      a.enabled ? "bg-emerald-500" : "bg-muted-foreground/50")} />
                  </span>
                }
                label={a.name}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function AgentFolderGroup({ id, label, dot, agents, base, activeAgent }: {
  id: string; label: string; dot?: string; agents: PanelAgent[];
  base: string; activeAgent?: string;
}) {
  const navigate = useNavigate();
  // Collapsed folders are remembered per dashboard-folder, so a long roster
  // stays folded the way you left it.
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(`sd-folder-${id}`) !== "0"; } catch { return true; }
  });
  const toggle = () => setOpen((v) => {
    const next = !v;
    try { localStorage.setItem(`sd-folder-${id}`, next ? "1" : "0"); } catch { /* noop */ }
    return next;
  });

  return (
    <>
      <button
        onClick={toggle}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {dot && <span className={cn("h-2 w-2 shrink-0 rounded-full", dot)} />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="text-[12px]">{agents.length}</span>
        <CaretDownIcon className={cn("h-3.5 w-3.5 shrink-0 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="mb-1 space-y-0.5 px-2.5">
          {agents.length === 0
            ? <p className="px-2.5 py-1 text-[13px] text-muted-foreground">Nothing here.</p>
            : agents.map((a) => (
              <PanelItem
                key={a.id} active={activeAgent === a.id} onClick={() => navigate(`${base}/agent/${a.id}`)}
                leading={
                  <span className="relative">
                    <AgentIdentity url={a.avatar_url} seed={a.name} size={18} rounded="rounded-md" />
                    <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-sidebar bg-emerald-500" />
                  </span>
                }
                label={a.name}
              />
            ))}
        </div>
      )}
    </>
  );
}

/** Memory, connections and workflows under one rail entry, grouped so the three
 *  subjects stay legible instead of becoming one flat list of six links. */
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

function PanelItem({ active, onClick, leading, label, tone }: {
  active: boolean; onClick: () => void; leading: React.ReactNode; label: string; tone?: "danger";
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] transition-colors",
        active ? (tone === "danger" ? "bg-destructive/10 font-medium text-destructive" : "bg-sidebar-accent font-medium text-foreground")
          : tone === "danger" ? "text-destructive/80 hover:bg-destructive/10"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-muted-foreground">{leading}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function PanelSection({ label, onAdd, menu }: {
  label: string; onAdd?: () => void; menu?: { label: string; onSelect: () => void }[];
}) {
  return (
    <div className="flex items-center gap-1 px-4 pb-1 pt-3">
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{label}</span>
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
                <SearchHit key={`d-${d.id}`} icon={FilesIcon} label={d.name} onClick={() => go(`${base}/artifacts`)} />
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
