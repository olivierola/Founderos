import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CircleNotchIcon as Loader2, XIcon as X } from "@phosphor-icons/react";
import {
  RobotIcon, PlusIcon, CalendarDotsIcon, CaretRightIcon,
  CheckCircleIcon, XCircleIcon, TargetIcon, PencilSimpleIcon, ArrowLeftIcon,
  GearSixIcon, LightningIcon, FileTextIcon, BrainIcon, FlowArrowIcon,
  ChartBarIcon, PlugsConnectedIcon, PlayIcon, PauseIcon, TrashIcon, ClockCountdownIcon,
  WarningIcon, CalendarBlankIcon, CalendarCheckIcon, ArrowsClockwiseIcon, TimerIcon,
  FolderPlusIcon, DotsThreeIcon, SparkleIcon, GlobeIcon, MonitorPlayIcon, TerminalWindowIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatisticsCard7 } from "@/components/ui/statistics-card-7";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useResizableWidth } from "@/hooks/useResizableWidth";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import { useAssistant } from "@/lib/assistant-context";
import {
  ChatTab, AgentMcpTab, SettingsTab, SkillsTab, AgentConnectorsTab, ToolsTab,
} from "@/features/internal-agents/InternalAgentDetail";
import { FloatingTabBar } from "./FloatingTabBar";
import { InstructionsEditor } from "@/features/internal-agents/InstructionsEditor";
import { AgentAutomationsTab } from "@/features/internal-agents/AgentAutomationsTab";
import { AgentTerminalPanel } from "@/features/internal-agents/AgentTerminalPanel";
import { AppTestPanel } from "@/features/ops/AppTestPanel";
import { type InternalAgent } from "@/features/internal-agents/shared";
import { type StudioKind } from "@/features/internal-agents/agentTemplates";

import { RoomLauncher } from "./RoomLauncher";
import { AssetsHub } from "./AssetsHub";
import { MemoryGraph } from "./MemoryGraph";
import { CatalogCard } from "./CatalogCard";
import { GetStartedCard } from "./GetStarted";
import {
  useComposioToolkits, useConnectorStatus, toolSlugsFromRows, resolveNeeds,
} from "./useToolkits";
import type { ComposioToolkit } from "@/features/integrations/ComposioCatalog";
import {
  fetchAgentFolders, createAgentFolder, renameAgentFolder, deleteAgentFolder, moveAgentToFolder,
  FOLDER_COLORS, type AgentFolder,
} from "./agentFolders";
import type { RangeKey } from "@/features/crm/overview/crmStats";
import { firstOccurrenceLocal, toAlignment, type Cadence, type Cadenced } from "./scheduleCadence";

// Agents scoped to this dashboard drive every other tab (rooms, schedules,
// activity, artifacts are all their conversations / missions / runs / outputs).
// select("*") on purpose: naming columns makes the WHOLE query 400 the day one
// of them isn't in the schema (internal_agents has grown through best-effort
// migrations — `requires_approval`, for one, isn't there). And the error is
// rethrown so a failed fetch surfaces as an error, never as "no agents".
export interface DashboardAgent {
  id: string; name: string; description: string | null;
  avatar_url: string | null; avatar_style: "avatar" | "orb" | null; accent_color: string | null;
  created_by: string | null; chat_enabled: boolean; mission_enabled: boolean;
  is_orchestrator: boolean; created_at: string; studio: StudioKind | null;
  swarm_enabled: boolean | null; model: string | null; sandbox_mode: string | null;
  /** Folder it is filed under (migration 0161), null when unfiled. */
  folder_id?: string | null;
  /** Only present on databases where the column was added. */
  requires_approval?: boolean | null;
}

export function useDashboardAgents(dashboardId: string) {
  const { projectId } = useCurrentContext();
  const own = useQuery({
    queryKey: ["sd_agents", dashboardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("internal_agents")
        .select("*")
        .eq("service_dashboard_id", dashboardId).eq("is_archived", false)
        .order("is_orchestrator", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as DashboardAgent[];
    },
  });

  // Le Rédacteur belongs to the PROJECT, not to one dashboard: he writes the
  // reports of every service, so he shows up in each of their rosters. Fetched
  // apart, and never rethrown — on a database where migration 0206 has not run
  // the column is missing, and that must cost his row, not the whole roster.
  const reporter = useQuery({
    queryKey: ["sd_reporter", projectId],
    enabled: !!projectId,
    retry: false,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents").select("*")
        .eq("project_id", projectId!).eq("system_role", "reporter").eq("is_archived", false)
        .limit(1);
      return (data ?? []) as DashboardAgent[];
    },
  });

  const merged = useMemo(() => {
    const base = own.data ?? [];
    const extra = (reporter.data ?? []).filter((r) => !base.some((b) => b.id === r.id));
    return [...base, ...extra];
  }, [own.data, reporter.data]);

  return { ...own, data: merged };
}

/** A customer-facing agent (rag_agents) filed under this service dashboard. */
export interface DashboardPublicAgent {
  id: string; name: string; description: string | null; enabled: boolean;
  accent_color: string | null; onboarding_enabled: boolean; created_at: string;
}

export function useDashboardPublicAgents(dashboardId: string) {
  return useQuery({
    queryKey: ["sd_public_agents", dashboardId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rag_agents")
        .select("id, name, description, enabled, accent_color, onboarding_enabled, created_at")
        .eq("service_dashboard_id", dashboardId)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as DashboardPublicAgent[];
    },
  });
}

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
function Centered() { return <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>; }
function Empty({ icon: Icon, title, hint }: { icon: PhosphorIcon; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border p-10 text-center">
      <Icon className="h-7 w-7 text-muted-foreground/50" />
      <div className="text-sm font-medium">{title}</div>
      {hint && <div className="max-w-sm text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

// ── Agents ───────────────────────────────────────────────────────────────────
// Creation itself lives in CreateAgent.tsx (…/agents/new) — this page only
// lists the roster and sends you there.
export function AgentsTab({ dashboardId }: { dashboardId: string }) {
  const { user } = useAuth();
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { workspaceId, projectId } = useCurrentContext();
  const { data: allAgents, isLoading, error } = useDashboardAgents(dashboardId);
  const agents = (allAgents ?? []).filter((a) => !a.is_orchestrator);
  // Agent pages live INSIDE the dashboard — a card opens the agent's tabs
  // (chat / missions / customize / …) here, not in the AI Workforce module.
  const sbase = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
  // Public (customer-facing) agents of this service — same roster page, own
  // section: they are configured here too (0195), through their builder tabs.
  const { data: publicAgents } = useDashboardPublicAgents(dashboardId);

  // Tool + skill counts for the whole roster in two queries, grouped client-side.
  const ids = (agents ?? []).map((a) => a.id);
  const { data: counts } = useQuery({
    queryKey: ["sd_agent_counts", dashboardId, ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const [tools, skills, work] = await Promise.all([
        supabase.from("internal_agent_tools").select("agent_id, kind, config").in("agent_id", ids),
        supabase.from("agent_skill_activations").select("agent_id").in("agent_id", ids),
        // Le travail QUI LUI EST CONFIÉ (0232). C'est ce qui manquait pour que
        // la fiche d'un agent dise autre chose que sa configuration : un agent
        // se juge à ce qu'il porte, pas au nombre d'outils qu'on lui a donnés.
        //
        // L'erreur n'est jamais relancée : sur une base où 0232 n'est pas
        // passée, la table n'existe pas, et cela doit coûter un badge — pas
        // tout le roster.
        supabase.from("pj_issue_agents").select("agent_id").in("agent_id", ids),
      ]);
      const map = new Map<string, { tools: number; skills: number; work: number; slugs: string[] }>();
      const row = (id: string) => {
        const cur = map.get(id) ?? { tools: 0, skills: 0, work: 0, slugs: [] as string[] };
        map.set(id, cur);
        return cur;
      };
      for (const r of (work.data ?? []) as Array<{ agent_id: string }>) row(r.agent_id).work += 1;
      for (const r of (tools.data ?? []) as Array<{ agent_id: string; kind: string; config: Record<string, unknown> | null }>) {
        const cur = row(r.agent_id);
        cur.tools += 1;
        for (const s of toolSlugsFromRows([r])) if (!cur.slugs.includes(s)) cur.slugs.push(s);
      }
      for (const r of (skills.data ?? []) as Array<{ agent_id: string }>) row(r.agent_id).skills += 1;
      return map;
    },
  });
  const countMap = counts ?? new Map<string, { tools: number; skills: number; work: number; slugs: string[] }>();

  // Composio catalogue + this project's connection status, fetched once for the
  // whole grid so each card can show which of its apps still need connecting.
  const { data: toolkits } = useComposioToolkits();
  const { data: connStatus } = useConnectorStatus(workspaceId, projectId);

  // ── Folders (0161) ──
  const { data: folders } = useQuery({
    queryKey: ["agent_folders", dashboardId],
    queryFn: () => fetchAgentFolders(dashboardId),
  });
  const [editing, setEditing] = useState<AgentFolder | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const unfiled = (agents ?? []).filter((a) => !a.folder_id);

  async function move(agentId: string, folderId: string | null) {
    await moveAgentToFolder(agentId, folderId);
    queryClient.invalidateQueries({ queryKey: ["sd_agents", dashboardId] });
  }

  return (
    <div className="min-h-full px-10 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 flex flex-wrap items-center gap-3">
          <h1 className="text-[30px] font-semibold tracking-tight">Agents</h1>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={() => setCreatingFolder(true)} className="rounded-full">
              <FolderPlusIcon className="mr-1.5 h-3.5 w-3.5" /> Dossier
            </Button>
            {/* One entry point, two kinds of worker: the create page carries the
                Build / Templates / Public switch itself. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="rounded-full bg-foreground px-5 text-background hover:bg-foreground/90">
                  Create agent
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 rounded-xl">
                <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Type d'agent</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => navigate(`${sbase}/agents/new`)}>
                  <RobotIcon className="mr-2 h-4 w-4" />
                  <span className="min-w-0">
                    <span className="block text-sm">Agent interne</span>
                    <span className="block text-[11px] text-muted-foreground">Travaille pour l'équipe de ce service.</span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate(`${sbase}/agents/new?type=public`)}>
                  <GlobeIcon className="mr-2 h-4 w-4" />
                  <span className="min-w-0">
                    <span className="block text-sm">Agent public</span>
                    <span className="block text-[11px] text-muted-foreground">Face client, nourri par une base de connaissances.</span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <FolderDialog
          open={creatingFolder || !!editing}
          folder={editing}
          onClose={() => { setCreatingFolder(false); setEditing(null); }}
          onSave={async (name, color) => {
            if (editing) await renameAgentFolder(editing.id, name, color);
            else if (workspaceId && projectId) await createAgentFolder(dashboardId, workspaceId, projectId, user?.id ?? null, { name, color });
            queryClient.invalidateQueries({ queryKey: ["agent_folders", dashboardId] });
          }}
          onDelete={editing ? async () => {
            await deleteAgentFolder(editing.id);
            queryClient.invalidateQueries({ queryKey: ["agent_folders", dashboardId] });
            queryClient.invalidateQueries({ queryKey: ["sd_agents", dashboardId] });
          } : undefined}
        />
        {isLoading ? <Centered />
          : error ? (
            <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-6 text-center">
              <WarningIcon className="mx-auto mb-2 h-6 w-6 text-destructive" />
              <div className="text-sm font-medium">Impossible de charger les agents</div>
              <div className="mt-1 text-xs text-muted-foreground">{error instanceof Error ? error.message : "Erreur inconnue"}</div>
            </div>
          )
          : (agents ?? []).length === 0 && (publicAgents ?? []).length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-10 text-center">
              <RobotIcon className="mx-auto mb-2 h-7 w-7 text-muted-foreground/60" />
              <div className="text-sm font-medium">Aucun agent dans ce service</div>
              <div className="mt-1 text-xs text-muted-foreground">Créez-en un ou partez d'un template.</div>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <Button size="sm" className="rounded-full" onClick={() => navigate(`${sbase}/agents/new`)}>
                  <PlusIcon className="mr-1.5 h-3.5 w-3.5" /> Agent interne
                </Button>
                <Button size="sm" variant="outline" className="rounded-full" onClick={() => navigate(`${sbase}/agents/new?type=public`)}>
                  <GlobeIcon className="mr-1.5 h-3.5 w-3.5" /> Agent public
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-12">
              {/* Folders first: with a dozen agents a flat grid stops being
                  readable. "Unfiled" only appears when something is unfiled. */}
              {(folders ?? []).map((f) => (
                <AgentGallery
                  key={f.id}
                  title={f.name}
                  dot={f.color}
                  agents={(agents ?? []).filter((a) => a.folder_id === f.id)}
                  counts={countMap}
                  folders={folders ?? []}
                  toolkits={toolkits}
                  connStatus={connStatus}
                  onOpen={(id) => navigate(`${sbase}/agent/${id}`)}
                  onMove={move}
                  onEditFolder={() => setEditing(f)}
                  emptyHint="Glissez des agents ici depuis le menu ⋯ d'une carte."
                />
              ))}
              {unfiled.length > 0 && (
                <AgentGallery
                  title={(folders ?? []).length > 0 ? "Sans dossier" : "All"}
                  agents={unfiled}
                  counts={countMap}
                  folders={folders ?? []}
                  toolkits={toolkits}
                  connStatus={connStatus}
                  onOpen={(id) => navigate(`${sbase}/agent/${id}`)}
                  onMove={move}
                />
              )}
              {(publicAgents ?? []).length > 0 && (
                <PublicAgentGallery
                  agents={publicAgents ?? []}
                  dashboardId={dashboardId}
                  onOpen={(id) => navigate(`${sbase}/public/${id}`)}
                />
              )}
            </div>
          )}
      </div>
    </div>
  );
}

// A titled gallery of catalogue cards — the agent's identity on its own plate,
// then its name, tool/skill counts, model + runtime pills and its created date.
function AgentGallery({ title, dot, agents, counts, folders, toolkits, connStatus, onOpen, onMove, onEditFolder, emptyHint }: {
  title: string;
  /** Tailwind bg class of the folder's colour dot, when this is a folder. */
  dot?: string;
  agents: DashboardAgent[];
  /** agentId → { tools, skills, work }, fetched once for the whole roster. */
  counts: Map<string, { tools: number; skills: number; work: number; slugs: string[] }>;
  /** Composio catalogue + connection status, to draw the app logos. */
  toolkits: ComposioToolkit[] | undefined;
  connStatus: Map<string, string> | undefined;
  folders: AgentFolder[];
  onOpen: (id: string) => void;
  onMove: (agentId: string, folderId: string | null) => void;
  onEditFolder?: () => void;
  emptyHint?: string;
}) {
  return (
    <section>
      <h2 className="mb-5 flex items-center gap-2 text-[19px] font-semibold tracking-tight">
        {dot && <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dot)} />}
        {title}
        <span className="text-[15px] font-normal text-muted-foreground">{agents.length}</span>
        {onEditFolder ? (
          <button onClick={onEditFolder} title="Renommer le dossier" className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <PencilSimpleIcon className="h-3.5 w-3.5" />
          </button>
        ) : <CaretRightIcon className="h-4 w-4 text-muted-foreground" />}
      </h2>
      {agents.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">{emptyHint ?? "Vide."}</p>
      ) : (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {agents.map((a) => {
          const c = counts.get(a.id);
          return (
            <CatalogCard
              key={a.id}
              className={cn(a.studio && "studio-border")}
              onClick={() => onOpen(a.id)}
              action={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      title="Déplacer"
                      className="rounded-lg border border-border/70 bg-background/90 p-1 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
                    >
                      <DotsThreeIcon className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="rounded-xl">
                    <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Déplacer vers</DropdownMenuLabel>
                    {folders.map((f) => (
                      <DropdownMenuItem key={f.id} disabled={a.folder_id === f.id} onSelect={() => onMove(a.id, f.id)}>
                        <span className={cn("mr-2 h-2.5 w-2.5 rounded-full", f.color)} /> {f.name}
                      </DropdownMenuItem>
                    ))}
                    {a.folder_id && (
                      <DropdownMenuItem onSelect={() => onMove(a.id, null)}>Retirer du dossier</DropdownMenuItem>
                    )}
                    {folders.length === 0 && (
                      <DropdownMenuItem disabled>Aucun dossier</DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              }
              glyph={<AgentIdentity style={a.avatar_style} url={a.avatar_url} seed={a.name} size={54} rounded="rounded-xl" />}
              name={a.name}
              tools={c?.tools ?? null}
              extras={c?.skills ?? null}
              tools_needed={resolveNeeds(c?.slugs ?? [], toolkits, connStatus)}
              badges={[
                // La charge D'ABORD : c'est la seule des trois qui change d'un
                // jour à l'autre, et la seule qui appelle une décision.
                ...(c?.work
                  ? [{
                    label: `${c.work} work item${c.work > 1 ? "s" : ""}`,
                    tone: "auth" as const,
                    title: "Travail assigné dans le suivi",
                  }]
                  : []),
                { label: a.model ?? "deepseek", tone: "auth", title: "Modèle" },
                { label: a.sandbox_mode ?? "cloud", tone: "key", title: "Environnement d'exécution" },
              ]}
              // No shield here: internal_agents has no requires_approval column,
              // so there is nothing real to show (templates carry their autonomy).
              meta={new Date(a.created_at).toISOString().slice(0, 10)}
            />
          );
        })}
      </div>
      )}
    </section>
  );
}

// The service's customer-facing agents. Their numbers are knowledge sources
// and conversations held (not tools/skills), so they get their own gallery
// rather than being squeezed into the internal cards' vocabulary.
function PublicAgentGallery({ agents, dashboardId, onOpen }: {
  agents: DashboardPublicAgent[];
  dashboardId: string;
  onOpen: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const ids = agents.map((a) => a.id);
  const { data: counts } = useQuery({
    queryKey: ["sd_public_agent_counts", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const out: Record<string, { sources: number; convos: number }> = {};
      await Promise.all(agents.map(async (a) => {
        const [s, c] = await Promise.all([
          supabase.from("rag_sources").select("id", { count: "exact", head: true }).eq("agent_id", a.id),
          supabase.from("rag_conversations").select("id", { count: "exact", head: true }).eq("agent_id", a.id),
        ]);
        out[a.id] = { sources: s.count ?? 0, convos: c.count ?? 0 };
      }));
      return out;
    },
  });

  // Deleting cascades to its sources, chunks and conversations (0016 FKs), so
  // it is confirmed by name rather than by a bare "are you sure".
  async function remove(a: DashboardPublicAgent) {
    if (!confirm(`Supprimer l'agent public « ${a.name} » ? Sa base de connaissances et ses conversations partent avec lui.`)) return;
    await supabase.from("rag_agents").delete().eq("id", a.id);
    queryClient.invalidateQueries({ queryKey: ["sd_public_agents", dashboardId] });
    queryClient.invalidateQueries({ queryKey: ["sd_panel_public_agents", dashboardId] });
  }

  return (
    <section>
      <h2 className="mb-5 flex items-center gap-2 text-[19px] font-semibold tracking-tight">
        Agents publics
        <span className="text-[15px] font-normal text-muted-foreground">{agents.length}</span>
        <CaretRightIcon className="h-4 w-4 text-muted-foreground" />
      </h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {agents.map((a) => {
          const color = a.accent_color || "#001BB7";
          const c = counts?.[a.id];
          return (
            <CatalogCard
              key={a.id}
              onClick={() => onOpen(a.id)}
              action={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      title="Actions"
                      className="rounded-lg border border-border/70 bg-background/90 p-1 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
                    >
                      <DotsThreeIcon className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="rounded-xl">
                    <DropdownMenuItem destructive onSelect={() => remove(a)}>
                      <TrashIcon className="mr-2 h-4 w-4" /> Supprimer
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
              glyph={
                // The plate sits on the card stage, which is near-black in both
                // themes — so the glyph has to be light in both. The agent
                // colour moves to the plate; a theme token here would go
                // dark-on-dark in light mode.
                <span
                  className="flex h-14 w-14 items-center justify-center rounded-xl ring-1 ring-white/10"
                  style={{ background: `${color}40` }}
                >
                  <GlobeIcon weight="duotone" className="h-7 w-7 text-white/85" />
                </span>
              }
              name={a.name}
              tools={c?.sources ?? null}
              extras={c?.convos ?? null}
              badges={[
                { label: "public", tone: "auth", title: "Agent public — face client" },
                { label: a.enabled ? "live" : "disabled", tone: "key", title: "État de publication" },
              ]}
              meta={new Date(a.created_at).toISOString().slice(0, 10)}
            />
          );
        })}
      </div>
    </section>
  );
}

// Create / rename / delete a folder. Deleting keeps its agents — they simply
// become unfiled (the FK is `on delete set null`).
function FolderDialog({ open, folder, onClose, onSave, onDelete }: {
  open: boolean;
  folder: AgentFolder | null;
  onClose: () => void;
  onSave: (name: string, color: string) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(FOLDER_COLORS[0]);
  const [busy, setBusy] = useState(false);

  useMemo(() => {
    setName(folder?.name ?? "");
    setColor(folder?.color ?? FOLDER_COLORS[0]);
  }, [folder?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await onSave(name, color); onClose(); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{folder ? "Renommer le dossier" : "Nouveau dossier"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="ex. Sécurité, Contenu, Support…" />
          <div className="flex flex-wrap gap-1.5">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c} type="button" onClick={() => setColor(c)}
                className={cn("h-6 w-6 rounded-full transition-all", c, color === c && "ring-2 ring-foreground ring-offset-2 ring-offset-background")}
              />
            ))}
          </div>
          <div className="flex items-center justify-end gap-2">
            {onDelete && (
              <Button
                variant="ghost" className="mr-auto text-destructive hover:text-destructive"
                onClick={async () => {
                  if (!confirm("Supprimer ce dossier ? Ses agents ne sont pas supprimés, ils sortent du dossier.")) return;
                  setBusy(true);
                  try { await onDelete(); onClose(); } finally { setBusy(false); }
                }}
              >
                <TrashIcon className="mr-1.5 h-3.5 w-3.5" /> Supprimer
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={save} disabled={busy || !name.trim()}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Enregistrer
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Agent detail, rendered INSIDE the dashboard ───────────────────────────────
// Clicking an agent card lands on its CHAT, which owns the whole area — nothing
// else shares this page. Configuration is a page of its own (AgentConfigInDashboard,
// …/agent-config/:id), reached from the gear here: the forms are a different kind
// of work from talking to the agent, and they need the room to breathe.
// This is the ONE dashboard-embedded entry point that gets this layout — the
// standalone AI Workforce page (/agent/internal/:id) keeps its full original tab
// set (Workspace/Collaboration/Channels + hubs) untouched.
// Five tabs, down from nine. The four that left were either not configuration
// (the Missions board — it belongs to the dashboard, not to a settings page —
// and Analytics) or a second door onto the same subject (MCP is a tool provider,
// so it lives with the tools; Memory is now a section of Général).
type AgentDetailTab = "settings" | "instructions" | "skills" | "connectors" | "automations";

// The leaf components behind these (SettingsTab, SkillsTab, …) are the exact
// same ones the standalone page uses — reused directly instead of through the
// Customize/Missions hub wrappers, so no nested sub-tab bar duplicates this
// page's own tab strip.
const AGENT_DETAIL_TABS: { key: AgentDetailTab; label: string; icon: any }[] = [
  { key: "settings", label: "Général", icon: GearSixIcon },
  { key: "instructions", label: "Fichiers", icon: FileTextIcon },
  { key: "skills", label: "Compétences", icon: LightningIcon },
  { key: "connectors", label: "Outils", icon: PlugsConnectedIcon },
  { key: "automations", label: "Automatisations", icon: FlowArrowIcon },
];

// Links written when this page had nine tabs (?t=missions, ?t=mcp, …) — each old
// slug resolves onto the tab that absorbed it, with the settings sub-section to
// open where there is one, so no bookmark lands on a tab that no longer exists.
const LEGACY_AGENT_TABS: Record<string, { tab: AgentDetailTab; section?: string }> = {
  missions: { tab: "settings" },
  mcp: { tab: "connectors" },
  tools: { tab: "connectors" },
  memory: { tab: "settings", section: "memory" },
  analytics: { tab: "settings", section: "usage" },
};

function resolveAgentTab(raw: string | null): { tab: AgentDetailTab; section?: string } | null {
  if (!raw) return null;
  if (AGENT_DETAIL_TABS.some((t) => t.key === raw)) return { tab: raw as AgentDetailTab };
  return LEGACY_AGENT_TABS[raw] ?? null;
}

function useDashboardAgent(agentId: string) {
  return useQuery({
    queryKey: ["sd_agent_full", agentId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("*").eq("id", agentId).maybeSingle();
      return data as InternalAgent | null;
    },
  });
}

export function AgentDetailInDashboard({ dashboardId, agentId }: { dashboardId: string; agentId: string }) {
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const navigate = useNavigate();
  const assistant = useAssistant();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const sbase = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
  const { data: agent, isLoading } = useDashboardAgent(agentId);
  // Two windows into the agent's machine, beside the conversation: the live
  // browser session while it tests an app, and its shell.
  const [side, setSide] = useState<"test" | "terminal" | null>(null);
  const [convoId, setConvoId] = useState<string | null>(null);
  const { width, startResize } = useResizableWidth("sd_agent_panel_width", 400, 300, 900);

  /** A command typed in the terminal is a message to the agent: it owns the
   *  runner, the browser doesn't. Same path as the composer (message + run). */
  async function askAgentToRun(command: string): Promise<string> {
    if (!convoId) return "Ouvre d'abord une session dans le chat.";
    const { error } = await supabase.from("internal_agent_messages").insert({
      conversation_id: convoId, agent_id: agentId, role: "user",
      content: `Exécute cette commande et rends-moi sa sortie : \`${command}\``,
    });
    if (error) throw error;
    await callEdge("internal-agent-run", { agent_id: agentId, mode: "chat", conversation_id: convoId });
    qc.invalidateQueries({ queryKey: ["internal_agent_messages", convoId] });
    return "→ demandé à l'agent dans la conversation.";
  }

  // Links written when the config lived here (…/agent/:id?t=skills) land on the
  // configuration page instead of silently showing the chat.
  const legacyTab = params.get("t");
  useEffect(() => {
    const target = resolveAgentTab(legacyTab);
    if (!target) return;
    navigate(
      `${sbase}/agent-config/${agentId}?t=${target.tab}${target.section ? `&s=${target.section}` : ""}`,
      { replace: true },
    );
  }, [legacyTab, agentId, sbase, navigate]);

  return (
    <div className="sd-agent-canvas relative flex h-full min-h-0">
      {/* No solid header — the agent identity (left) and the config entry
          (right) float over the chat via ChatTab's top row. */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {isLoading || !agent ? (
          <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <ChatTab
            agent={agent}
            workspaceId={workspaceId}
            projectId={projectId}
            onConversationChange={setConvoId}
            headerLeading={
              <div className="flex h-9 items-center gap-2 rounded-full border border-border/60 bg-background/70 px-2.5 shadow-sm backdrop-blur">
                <button onClick={() => navigate(`${sbase}/agents`)} className="rounded-full p-0.5 text-muted-foreground hover:text-foreground" title="Retour aux agents"><ArrowLeftIcon className="h-3.5 w-3.5" /></button>
                <AgentIdentity style={agent.avatar_style ?? "orb"} url={agent.avatar_url} seed={agent.name} size={22} rounded="rounded-full" />
                <span className="max-w-[160px] truncate text-xs font-semibold leading-tight">{agent.name}</span>
              </div>
            }
            headerTrailing={
              <div className="flex h-9 items-center gap-0.5 rounded-full border border-border/60 bg-background/70 px-1 shadow-sm backdrop-blur">
                {/* Watch the machine: the app it's testing, and its shell. */}
                <SidePanelToggle
                  icon={MonitorPlayIcon} title="Tester une app"
                  active={side === "test"} onClick={() => setSide((s) => (s === "test" ? null : "test"))}
                />
                <SidePanelToggle
                  icon={TerminalWindowIcon} title="Terminal de l'agent"
                  active={side === "terminal"} onClick={() => setSide((s) => (s === "terminal" ? null : "terminal"))}
                />
                {/* Conversational configuration: opens the assistant on this
                    agent's setup cards. The gear next to it is the manual path
                    — the configuration page and its forms. */}
                <button
                  onClick={() => assistant.ask({ agent: { id: agent.id, name: agent.name } })}
                  title="Configurer avec l'assistant"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <SparkleIcon weight="duotone" className="h-4 w-4" />
                </button>
                <button
                  onClick={() => navigate(`${sbase}/agent-config/${agent.id}`)}
                  title="Configuration de l'agent"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <GearSixIcon className="h-4 w-4" />
                </button>
              </div>
            }
          />
        )}
      </div>

      {/* Right zone: the agent's machine. Resizable, and it never covers the
          conversation — the two are watched together. */}
      {side && agent && (
        <aside className="relative hidden shrink-0 flex-col border-l border-border bg-card/40 lg:flex" style={{ width }}>
          <div
            onMouseDown={startResize}
            className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/40"
            title="Glisser pour redimensionner"
          />
          <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
            <SideTab active={side === "test"} onClick={() => setSide("test")} icon={MonitorPlayIcon} label="Test app" />
            <SideTab active={side === "terminal"} onClick={() => setSide("terminal")} icon={TerminalWindowIcon} label="Terminal" />
            <button
              onClick={() => setSide(null)} title="Fermer le panneau"
              className="ml-auto rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {side === "test" ? (
              <AppTestPanel
                workspaceId={workspaceId}
                projectId={projectId}
                onOpenInModule={(runId) => navigate(`/app/${workspaceSlug}/${projectSlug}/test-runs/live?run=${runId}`)}
              />
            ) : (
              <div className="h-full p-2">
                <AgentTerminalPanel agents={[{ id: agent.id, name: agent.name }]} onCommand={askAgentToRun} />
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

/** Round toggle in the chat's floating top row, lit while its panel is open. */
function SidePanelToggle({
  icon: Icon, title, active, onClick,
}: { icon: PhosphorIcon; title: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick} title={title}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-full transition-colors",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function SideTab({
  active, onClick, icon: Icon, label,
}: { active: boolean; onClick: () => void; icon: PhosphorIcon; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] transition-colors",
        active ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:bg-muted",
      )}
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
}

// ── Agent configuration — its own page ───────────────────────────────────────
// Everything you set up about an agent, in a page that owns the whole tab. No
// solid header: the identity (left), the tab bar (centre) and the assistant
// (right) FLOAT over the form, which runs full height behind them — the same
// language as the chat page next door. It used to be a floating side panel laid
// over the chat, a ~620px column that hid the conversation behind it.
export function AgentConfigInDashboard({ dashboardId, agentId }: { dashboardId: string; agentId: string }) {
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const assistant = useAssistant();
  const [params, setParams] = useSearchParams();
  const sbase = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
  const rawTab = params.get("t");
  const resolved = resolveAgentTab(rawTab);
  const tab = resolved?.tab ?? "settings";
  const [barHeight, setBarHeight] = useState(48);
  const { data: agent, isLoading } = useDashboardAgent(agentId);

  // A legacy slug (?t=memory, ?t=mcp…) is rewritten to its canonical tab — and to
  // the settings sub-section it became, which SettingsTab reads from ?s=.
  useEffect(() => {
    if (!rawTab || rawTab === tab) return;
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("t", tab);
      if (resolved?.section) n.set("s", resolved.section);
      return n;
    }, { replace: true });
  }, [rawTab, tab, resolved?.section, setParams]);

  if (isLoading || !agent) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Floating identity (left) + assistant (right). The tab bar sits between
          them, centred — five labelled tabs fit in that gap, which nine never
          did (they used to be icon-only for exactly that reason). */}
      <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start gap-2">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-2 py-1 shadow-sm backdrop-blur">
          <button
            onClick={() => navigate(`${sbase}/agent/${agent.id}`)}
            title="Retour à la conversation"
            className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="h-3.5 w-3.5" />
          </button>
          <AgentIdentity style={agent.avatar_style ?? "orb"} url={agent.avatar_url} seed={agent.name} size={20} rounded="rounded-full" />
          <span className="max-w-[160px] truncate text-xs font-semibold leading-tight">{agent.name}</span>
        </div>
        <button
          onClick={() => assistant.ask({ agent: { id: agent.id, name: agent.name } })}
          title="Configurer avec l'assistant"
          className="pointer-events-auto ml-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-background/70 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
        >
          <SparkleIcon weight="duotone" className="h-4 w-4" />
        </button>
      </div>

      <FloatingTabBar
        // Kept clear of the two floating pills it sits between (identity on the
        // left, assistant on the right) — past that width the bar wraps.
        className="max-w-[calc(100%-21rem)]"
        sections={AGENT_DETAIL_TABS}
        active={tab}
        onHeight={setBarHeight}
        onSelect={(k) => setParams((p) => {
          const n = new URLSearchParams(p);
          n.set("t", k);
          // A section pinned by a deep-link belongs to the tab that link opened.
          n.delete("s");
          return n;
        }, { replace: true })}
      />

      {/* The form scrolls under the floating bar, in a readable column rather
          than the full width of a wide screen. Its first row is offset by the
          bar's measured height — the bar wraps to two lines when narrow, so a
          fixed padding would either overlap it or leave a hole. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 pb-10" style={{ paddingTop: barHeight + 28 }}>
          {tab === "settings" && <SettingsTab agent={agent} embedded />}
          {tab === "instructions" && <InstructionsEditor agent={agent} />}
          {tab === "skills" && <SkillsTab agentId={agent.id} />}
          {/* One tab for everything the agent can reach: the apps connected to
              the project, its generic capabilities, and the MCP servers that
              bring their own tools. They were three separate doors onto the
              same question ("que sait-il faire ?"). */}
          {tab === "connectors" && (
            <div className="space-y-10">
              <AgentConnectorsTab agent={agent} />
              <div className="mx-auto max-w-5xl border-t border-border/60" />
              <ToolsTab agent={agent} variant="tools" />
              <div className="mx-auto max-w-5xl border-t border-border/60" />
              <AgentMcpTab agent={agent} />
            </div>
          )}
          {tab === "automations" && <AgentAutomationsTab agent={agent} />}
        </div>
      </div>
    </div>
  );
}

// ── Schedules (scheduled missions) ────────────────────────────────────────────
// Full scheduling system: create / edit / pause-resume / run-now / delete
// recurring agent missions. A schedule is an internal_agent_missions row with a
// cadence (hourly/daily/weekly/monthly) + UTC alignment (schedule_minute/hour/
// dow/dom); the internal-agent-scheduler fires it and advances next_run_at.
interface ScheduleRow {
  id: string; agent_id: string; title: string; brief: string | null;
  schedule: Cadence | null; schedule_minute: number | null; schedule_hour: number | null;
  schedule_dow: number | null; schedule_dom: number | null;
  status: string; next_run_at: string | null; last_run_at: string | null; board_column: string | null;
}

const CADENCE_META: Record<Cadence, { short: string; label: string; desc: string; icon: PhosphorIcon }> = {
  hourly: { short: "Horaire", label: "Toutes les heures", desc: "À chaque heure, à la minute choisie", icon: ArrowsClockwiseIcon },
  daily: { short: "Jour", label: "Chaque jour", desc: "Une fois par jour à l'heure choisie", icon: ClockCountdownIcon },
  weekly: { short: "Semaine", label: "Chaque semaine", desc: "Un jour précis de la semaine", icon: CalendarBlankIcon },
  monthly: { short: "Mois", label: "Chaque mois", desc: "Un jour précis du mois", icon: CalendarCheckIcon },
};
const DOW_LABELS = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
const pad2 = (n: number) => String(n).padStart(2, "0");

// Compact relative distance ("dans 3 h", "il y a 2 j") from an ISO instant.
function relTime(iso: string | null): string {
  if (!iso) return "—";
  const delta = new Date(iso).getTime() - Date.now();
  const past = delta < 0;
  const mins = Math.round(Math.abs(delta) / 60000);
  const wrap = (v: string) => (past ? `il y a ${v}` : `dans ${v}`);
  if (mins < 1) return past ? "à l'instant" : "imminent";
  if (mins < 60) return wrap(`${mins} min`);
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return wrap(`${hrs} h`);
  const days = Math.round(hrs / 24);
  if (days < 30) return wrap(`${days} j`);
  return wrap(`${Math.round(days / 30)} mois`);
}

// Human, local-time description derived from the concrete next_run_at instant.
function describeSchedule(m: ScheduleRow): string {
  const next = m.next_run_at ? new Date(m.next_run_at) : null;
  const hhmm = next ? `${pad2(next.getHours())}:${pad2(next.getMinutes())}` : "—";
  switch (m.schedule) {
    case "hourly": return `Toutes les heures à :${next ? pad2(next.getMinutes()) : "00"}`;
    case "daily": return `Chaque jour à ${hhmm}`;
    case "weekly": return `Chaque ${next ? DOW_LABELS[next.getDay()].toLowerCase() : "semaine"} à ${hhmm}`;
    case "monthly": return `Le ${next ? next.getDate() : 1} de chaque mois à ${hhmm}`;
    default: return "—";
  }
}

function selectionFromRow(m: ScheduleRow): Cadenced {
  const next = m.next_run_at ? new Date(m.next_run_at) : new Date();
  return {
    cadence: (m.schedule ?? "daily") as Cadence,
    minute: next.getMinutes(),
    hour: next.getHours(),
    dow: next.getDay(),
    dom: Math.min(next.getDate(), 28),
  };
}

export function SchedulesTab({ dashboardId, workspaceId, projectId }: {
  dashboardId: string; workspaceId: string; projectId: string;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: agents } = useDashboardAgents(dashboardId);
  const agentIds = (agents ?? []).map((a) => a.id);
  const agentById = new Map((agents ?? []).map((a) => [a.id, a]));
  const [editing, setEditing] = useState<ScheduleRow | "new" | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const { data: missions, isLoading } = useQuery({
    queryKey: ["sd_schedules", dashboardId, agentIds.join(",")],
    enabled: agentIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_missions")
        .select("id, agent_id, title, brief, schedule, schedule_minute, schedule_hour, schedule_dow, schedule_dom, status, next_run_at, last_run_at, board_column")
        .in("agent_id", agentIds)
        .not("schedule", "is", null).order("next_run_at", { ascending: true }).limit(100);
      return (data ?? []) as ScheduleRow[];
    },
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["sd_schedules", dashboardId] });

  async function toggleStatus(m: ScheduleRow) {
    const next = m.status === "active" ? "draft" : "active";
    await supabase.from("internal_agent_missions")
      .update({ status: next, next_run_at: next === "active" && !m.next_run_at ? new Date().toISOString() : m.next_run_at })
      .eq("id", m.id);
    invalidate();
  }
  async function remove(m: ScheduleRow) {
    if (!confirm(`Supprimer la planification « ${m.title} » ?`)) return;
    await supabase.from("internal_agent_missions").delete().eq("id", m.id);
    invalidate();
  }
  async function runNow(m: ScheduleRow) {
    setRunningId(m.id);
    try {
      const { data } = await supabase.from("internal_agent_runs")
        .insert({ mission_id: m.id, agent_id: m.agent_id, workspace_id: workspaceId, project_id: projectId, status: "queued", triggered_by: user?.id ?? null })
        .select("id").single();
      if (data) { try { await callEdge("internal-agent-run", { agent_id: m.agent_id, mode: "mission", run_id: data.id }); } catch { /* scheduler rescues */ } }
    } finally { setRunningId(null); }
  }

  if (agentIds.length === 0)
    return <div className="p-6"><Empty icon={CalendarDotsIcon} title="Aucun agent dans ce service" hint="Ajoutez d'abord un agent pour lui planifier des tâches récurrentes." /></div>;

  const rows = missions ?? [];
  const activeCount = rows.filter((m) => m.status === "active").length;
  const pausedCount = rows.length - activeCount;
  const nextUp = rows.filter((m) => m.status === "active" && m.next_run_at).sort((a, b) => (a.next_run_at! < b.next_run_at! ? -1 : 1))[0]?.next_run_at ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold"><ClockCountdownIcon className="h-5 w-5 text-amber-500" /> Planifications</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">Faites tourner des missions d'agents automatiquement, à la cadence de votre choix — rapports récurrents, veilles, nettoyages… L'agent exécute la mission et livre ses résultats.</p>
        </div>
        <Button onClick={() => setEditing("new")}><PlusIcon className="mr-1.5 h-4 w-4" /> Nouvelle planification</Button>
      </div>

      {/* Stat strip */}
      <StatisticsCard7
        cards={[
          {
            key: "active",
            title: "Actives",
            subtitle: "Se déclenchent à leur cadence",
            value: String(activeCount),
            valueClassName: activeCount > 0 ? "text-emerald-600 dark:text-emerald-400" : undefined,
            badge: rows.length > 0
              ? { text: `${Math.round((activeCount / rows.length) * 100)}%`, icon: PlayIcon, tone: activeCount > 0 ? "positive" : "neutral" }
              : undefined,
            subtext: (
              <span className="text-muted-foreground">
                sur {rows.length} planification{rows.length > 1 ? "s" : ""}
              </span>
            ),
          },
          {
            key: "paused",
            title: "En pause",
            subtitle: "Ne se déclencheront plus",
            value: String(pausedCount),
            badge: pausedCount > 0 ? { text: "à relancer", icon: PauseIcon, tone: "neutral" } : undefined,
            subtext: (
              <span className="text-muted-foreground">
                {pausedCount === 0 ? "tout tourne" : "reprise manuelle"}
              </span>
            ),
          },
          {
            key: "next",
            title: "Prochaine exécution",
            subtitle: nextUp ? "Échéance la plus proche" : "Aucune échéance",
            value: nextUp ? relTime(nextUp) : "—",
            valueClassName: nextUp ? "text-amber-600 dark:text-amber-400" : undefined,
            badge: nextUp ? { text: "planifiée", icon: TimerIcon, tone: "info" } : undefined,
            subtext: <span className="text-muted-foreground">{nextUp ? fmt(nextUp) : "Créez une planification"}</span>,
          },
        ]}
      />

      {isLoading ? <Centered /> : rows.length === 0 ? (
        <Empty icon={CalendarDotsIcon} title="Aucune tâche planifiée" hint="Créez une planification pour qu'un agent exécute une mission à intervalle régulier." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((m) => {
            const agent = agentById.get(m.agent_id);
            const paused = m.status !== "active";
            const missionOff = agent && !agent.mission_enabled;
            const CIcon = m.schedule ? CADENCE_META[m.schedule].icon : ClockCountdownIcon;
            return (
              <div key={m.id} className={cn("group flex flex-col rounded-2xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md", paused && "opacity-75")}>
                <div className="flex items-start gap-3">
                  <span className={cn("mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", paused ? "bg-muted text-muted-foreground" : "bg-amber-500/10 text-amber-500")}>
                    <CIcon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{m.title}</span>
                      <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", paused ? "bg-muted text-muted-foreground" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")}>
                        {paused ? "En pause" : "Actif"}
                      </span>
                    </div>
                    {m.brief && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{m.brief}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {agent && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-0.5 pr-2 text-[11px] text-foreground">
                          <AgentIdentity style={agent.avatar_style} url={agent.avatar_url} seed={agent.name} size={16} rounded="rounded-full" lightOrb /> {agent.name}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                        <CIcon className="h-3 w-3" /> {describeSchedule(m)}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconBtn title="Exécuter maintenant" onClick={() => runNow(m)} disabled={runningId === m.id}>
                      {runningId === m.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayIcon className="h-4 w-4" />}
                    </IconBtn>
                    <IconBtn title={paused ? "Reprendre" : "Mettre en pause"} onClick={() => toggleStatus(m)}>
                      {paused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
                    </IconBtn>
                    <IconBtn title="Modifier" onClick={() => setEditing(m)}><PencilSimpleIcon className="h-4 w-4" /></IconBtn>
                    <IconBtn title="Supprimer" onClick={() => remove(m)} danger><TrashIcon className="h-4 w-4" /></IconBtn>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-4 border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <TimerIcon className="h-3 w-3 text-amber-500" />
                    Prochain : <span className="font-medium text-foreground">{paused ? "en pause" : relTime(m.next_run_at)}</span>
                    {!paused && m.next_run_at && <span className="text-muted-foreground/70">· {fmt(m.next_run_at)}</span>}
                  </span>
                  {m.last_run_at && <span className="hidden sm:inline">Dernier : {relTime(m.last_run_at)}</span>}
                </div>

                {missionOff && (
                  <div className="mt-2 inline-flex items-center gap-1 self-start rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                    <WarningIcon className="h-3 w-3" /> Missions désactivées sur cet agent — activez-les dans ses réglages.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ScheduleEditor
          key={editing === "new" ? "new" : editing.id}
          existing={editing === "new" ? null : editing}
          agents={agents ?? []}
          workspaceId={workspaceId}
          projectId={projectId}
          onClose={() => setEditing(null)}
          onSaved={() => { invalidate(); setEditing(null); }}
        />
      )}
    </div>
  );
}

function IconBtn({ title, onClick, disabled, danger, children }: {
  title: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn("rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50",
        danger ? "hover:text-destructive" : "hover:text-foreground")}
    >
      {children}
    </button>
  );
}

type EditorAgent = { id: string; name: string; avatar_url: string | null; avatar_style: "avatar" | "orb" | null; mission_enabled: boolean };

function ScheduleEditor({ existing, agents, workspaceId, projectId, onClose, onSaved }: {
  existing: ScheduleRow | null;
  agents: EditorAgent[];
  workspaceId: string; projectId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const { user } = useAuth();
  const init: Cadenced = existing ? selectionFromRow(existing) : { cadence: "daily", minute: 0, hour: 9, dow: 1, dom: 1 };
  const [agentId, setAgentId] = useState(existing?.agent_id ?? agents[0]?.id ?? "");
  const [title, setTitle] = useState(existing?.title ?? "");
  const [brief, setBrief] = useState(existing?.brief ?? "");
  const [cadence, setCadence] = useState<Cadence>(init.cadence);
  const [minute, setMinute] = useState(init.minute);
  const [hour, setHour] = useState(init.hour);
  const [dow, setDow] = useState(init.dow);
  const [dom, setDom] = useState(init.dom);
  const [saving, setSaving] = useState(false);

  const sel: Cadenced = { cadence, minute, hour, dow, dom };
  const preview = firstOccurrenceLocal(sel);

  async function save() {
    if (!title.trim() || !agentId || saving) return;
    setSaving(true);
    try {
      const occ = firstOccurrenceLocal(sel);
      const align = toAlignment(sel, occ);
      const payload = {
        title: title.trim(),
        brief: brief.trim() || null,
        schedule: cadence,
        next_run_at: occ.toISOString(),
        ...align,
        updated_at: new Date().toISOString(),
      };
      if (existing) {
        await supabase.from("internal_agent_missions").update({ ...payload, agent_id: agentId, updated_by: user?.id ?? null }).eq("id", existing.id);
      } else {
        await supabase.from("internal_agent_missions").insert({
          ...payload,
          agent_id: agentId,
          workspace_id: workspaceId,
          project_id: projectId,
          status: "active",
          board_column: "todo",
          created_by: user?.id ?? null,
        });
      }
      onSaved();
    } finally { setSaving(false); }
  }

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = [0, 5, 10, 15, 20, 30, 45];
  const doms = Array.from({ length: 28 }, (_, i) => i + 1);
  const selectedAgent = agents.find((a) => a.id === agentId);
  const recap = describeSchedule({ schedule: cadence, next_run_at: preview.toISOString() } as ScheduleRow);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500"><ClockCountdownIcon className="h-4 w-4" /></span>
            {existing ? "Modifier la planification" : "Nouvelle planification"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* What */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Agent chargé de la mission">
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger><SelectValue placeholder="Choisir un agent" /></SelectTrigger>
                <SelectContent>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="flex items-center gap-2"><AgentIdentity style={a.avatar_style} url={a.avatar_url} seed={a.name} size={16} rounded="rounded-full" lightOrb /> {a.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Titre de la mission">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ex. Rapport quotidien des ventes" autoFocus />
            </Field>
          </div>
          {selectedAgent && !selectedAgent.mission_enabled && (
            <div className="-mt-1 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400">
              <WarningIcon className="h-3 w-3" /> Les missions sont désactivées sur cet agent — la planification ne se déclenchera pas tant qu'elles ne sont pas réactivées.
            </div>
          )}
          <Field label="Consigne (ce que l'agent doit faire à chaque exécution)">
            <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} placeholder="ex. Compile les ventes de la veille par canal, calcule l'évolution et publie un résumé…" />
          </Field>

          {/* Cadence cards */}
          <Field label="Fréquence">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(Object.keys(CADENCE_META) as Cadence[]).map((c) => {
                const meta = CADENCE_META[c];
                const active = cadence === c;
                return (
                  <button key={c} onClick={() => setCadence(c)}
                    className={cn("flex flex-col items-start gap-1 rounded-xl border p-2.5 text-left transition-colors",
                      active ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20" : "border-border hover:border-primary/30 hover:bg-muted/40")}>
                    <span className={cn("flex h-7 w-7 items-center justify-center rounded-lg", active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                      <meta.icon className="h-4 w-4" />
                    </span>
                    <span className={cn("text-xs font-medium", active ? "text-foreground" : "text-muted-foreground")}>{meta.short}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{CADENCE_META[cadence].desc}.</p>
          </Field>

          {/* When */}
          <Field label="Quand (heure locale)">
            <div className="flex flex-wrap items-center gap-2">
              {cadence === "weekly" && (
                <Select value={String(dow)} onValueChange={(v) => setDow(Number(v))}>
                  <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{DOW_LABELS.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}</SelectContent>
                </Select>
              )}
              {cadence === "monthly" && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Le</span>
                  <Select value={String(dom)} onValueChange={(v) => setDom(Number(v))}>
                    <SelectTrigger className="w-[80px]"><SelectValue /></SelectTrigger>
                    <SelectContent>{doms.map((d) => <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
                  </Select>
                </span>
              )}
              {cadence !== "hourly" && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">à</span>
                  <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
                    <SelectTrigger className="w-[84px]"><SelectValue /></SelectTrigger>
                    <SelectContent>{hours.map((h) => <SelectItem key={h} value={String(h)}>{pad2(h)}h</SelectItem>)}</SelectContent>
                  </Select>
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{cadence === "hourly" ? "à la minute" : "min"}</span>
                <Select value={String(minute)} onValueChange={(v) => setMinute(Number(v))}>
                  <SelectTrigger className="w-[84px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{minutes.map((mm) => <SelectItem key={mm} value={String(mm)}>:{pad2(mm)}</SelectItem>)}</SelectContent>
                </Select>
              </span>
            </div>
          </Field>

          {/* Recap */}
          <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3.5 py-3">
            <TimerIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 text-xs">
              <div className="font-medium text-foreground">{recap}</div>
              <div className="mt-0.5 text-muted-foreground">Première exécution {relTime(preview.toISOString())} · {preview.toLocaleString()}</div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={save} disabled={!title.trim() || !agentId || saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} {existing ? "Enregistrer" : "Créer la planification"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ── Dashboard (the service's own statistics) ──────────────────────────────────
// Replaces the old Activity feed (2026-08-10): a flat list of the last 50 runs
// answered "what happened" but never "how is this service doing". The HQ
// cockpit is rendered here on THIS dashboard's agents only — same components,
// same derivations as AI Headquarters, scoped to the service. The activity feed
// survives inside its "Vue d'ensemble" tab.
// ── Workspace memory — what the agents have learned about the team (facts,
// preferences, learnings, context), workspace-wide. Replaces the old Activity tab.
const MEM_LABEL: Record<string, string> = { fact: "Fait", preference: "Préférence", learning: "Appris", context: "Contexte" };
const MEM_STYLE: Record<string, string> = {
  fact: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  preference: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  learning: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  context: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};
interface MemoryRow { id: string; agent_id: string | null; kind: string; content: string; source: string; importance: number; is_pinned: boolean; created_at: string }

function useWorkspaceMemory(workspaceId: string, limit = 100) {
  return useQuery({
    queryKey: ["ws_memory", workspaceId, limit],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_memories")
        .select("id, agent_id, kind, content, source, importance, is_pinned, created_at")
        .eq("workspace_id", workspaceId)
        .order("is_pinned", { ascending: false }).order("created_at", { ascending: false }).limit(limit);
      return (data ?? []) as MemoryRow[];
    },
  });
}

// Workspace memory + Assets merged into one tab, toggled by a floating top-left
// switcher. Memory renders as a point-graph (clusters by kind + similarity links).
export function WorkspaceMemoryTab({ workspaceId, dashboardId, projectId, view = "graph" }: {
  workspaceId: string; dashboardId: string; projectId: string;
  /** Driven by the sidebar panel: graph | memories | sources. */
  view?: string;
}) {
  const { data: agents } = useDashboardAgents(dashboardId);
  const nameOf = new Map((agents ?? []).map((a) => [a.id, a.name]));
  const { data: mems, isLoading } = useWorkspaceMemory(workspaceId);

  // The memory graph should hold EVERYTHING about the service — not only what
  // agents remembered, but the assets available (repos, links, files, people,
  // tools, notes) and the artifacts they produced. Fetch those and map them to
  // graph nodes with their own kind (colour + filter chip in the graph).
  const agentIds = (agents ?? []).map((a) => a.id);
  const { data: extraNodes } = useQuery({
    queryKey: ["sd_graph_extra", dashboardId, projectId, agentIds.join(",")],
    queryFn: async () => {
      const [assetsRes, reposRes, delivRes] = await Promise.all([
        supabase.from("dashboard_assets").select("id, kind, label, created_at").eq("dashboard_id", dashboardId),
        supabase.from("repositories").select("id, full_name, name, created_at").eq("project_id", projectId),
        agentIds.length
          ? supabase.from("internal_agent_deliverables").select("id, agent_id, name, created_at").in("agent_id", agentIds).order("created_at", { ascending: false }).limit(100)
          : Promise.resolve({ data: [] as Array<{ id: string; agent_id: string; name: string; created_at: string }> }),
      ]);
      const rows: MemoryRow[] = [];
      for (const a of (assetsRes.data ?? []) as Array<{ id: string; kind: string; label: string; created_at: string }>) {
        if (a.kind === "agent") continue; // agents are their own nodes elsewhere
        rows.push({ id: `asset-${a.id}`, agent_id: null, kind: a.kind === "human" ? "person" : a.kind, content: a.label, source: "user", importance: 1, is_pinned: false, created_at: a.created_at });
      }
      for (const r of (reposRes.data ?? []) as Array<{ id: string; full_name: string | null; name: string; created_at: string }>) {
        rows.push({ id: `repo-${r.id}`, agent_id: null, kind: "repo", content: r.full_name ?? r.name, source: "user", importance: 1, is_pinned: false, created_at: r.created_at });
      }
      for (const d of (delivRes.data ?? []) as Array<{ id: string; agent_id: string; name: string; created_at: string }>) {
        rows.push({ id: `art-${d.id}`, agent_id: d.agent_id, kind: "artifact", content: d.name, source: "agent", importance: 1, is_pinned: false, created_at: d.created_at });
      }
      return rows;
    },
  });
  const graphNodes = useMemo(() => [...(mems ?? []), ...(extraNodes ?? [])], [mems, extraNodes]);

  // "Sources" is the assets hub; "Memories" the flat list; "Graph" the canvas.
  if (view === "sources") {
    return <div className="h-full"><AssetsHub dashboardId={dashboardId} workspaceId={workspaceId} projectId={projectId} /></div>;
  }
  if (isLoading) return <Centered />;

  if (view === "memories") {
    return (
      <div className="mx-auto max-w-3xl px-10 py-8">
        <h1 className="mb-8 text-[30px] font-semibold tracking-tight">Memories</h1>
        {(mems ?? []).length === 0 ? (
          <Empty icon={BrainIcon} title="This workspace's memory is empty." hint="Vos agents la remplissent au fil des conversations." />
        ) : (
          <div className="space-y-1.5">
            {(mems ?? []).map((m) => (
              <div key={m.id} className="flex items-start gap-3 rounded-xl border border-border/70 p-3">
                <span className={cn("mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium", MEM_STYLE[m.kind] ?? MEM_STYLE.fact)}>
                  {MEM_LABEL[m.kind] ?? m.kind}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{m.content}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {m.agent_id ? nameOf.get(m.agent_id) ?? "Agent" : "Workspace"} · {fmt(m.created_at)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full">
      {graphNodes.length === 0 ? (
        <div className="flex h-full items-center justify-center p-6">
          <Empty icon={BrainIcon} title="This workspace's memory is empty." hint="Mémoires, assets et artifacts arrivent au fil du travail." />
        </div>
      ) : (
        <MemoryGraph mems={graphNodes} agents={(agents ?? []).map((a) => ({ id: a.id, name: a.name, accentColor: (a as { accent_color?: string | null }).accent_color }))} />
      )}
    </div>
  );
}

// ── Home — the dashboard landing: a question, the composer that answers it,
// and the setup checklist. No animated ground, no orb: the page is the field.
export function HomeTab({ dashboardId, dashboardName, workspaceId, projectId }: {
  dashboardId: string; dashboardName: string; workspaceId: string; projectId: string;
}) {
  const { user } = useAuth();
  const firstName = ((user?.user_metadata?.name as string | undefined) || user?.email?.split("@")[0] || "there").split(" ")[0];
  const { data: agents } = useDashboardAgents(dashboardId);

  return (
    /* Flat ground: the page runs on the app's own surface — no shader field
       behind the copy, nothing moving under a text box. The column is centred;
       the copy inside it is not, so the eye starts on the same x as the
       composer's first character. */
    <div className="flex min-h-full flex-col justify-center px-6 py-16 text-foreground">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="text-[13px] text-muted-foreground">{dashboardName}</div>
        <h1 className="mt-1 text-[30px] font-medium leading-tight tracking-tight">
          Que voulez-vous faire, {firstName} ?
        </h1>

        {/* The way in: write, and the room is created around what you wrote. */}
        <RoomLauncher
          className="mt-7"
          dashboardId={dashboardId} dashboardName={dashboardName}
          workspaceId={workspaceId} projectId={projectId}
          agents={agents ?? []}
        />

        {/* The entry points, as steps: create an agent, plug your apps in,
            open a room, schedule the recurring work. Each one is ticked by
            real data, and the card leaves once they are all done. */}
        <GetStartedCard dashboardId={dashboardId} className="mt-9" />
      </div>
    </div>
  );
}

// ── Missions ("Task") — every open mission for a set of agents, unfiltered by
// schedule (unlike SchedulesTab, which only lists recurring ones). Used by the
// Room panel's "Task" tab, scoped to that room's participants.
export function MissionsList({ agentIds, nameOf }: { agentIds: string[]; nameOf: Map<string, string> }) {
  const { data: missions, isLoading } = useQuery({
    queryKey: ["sd_missions", agentIds.join(",")],
    enabled: agentIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_missions")
        .select("id, agent_id, title, status, schedule, next_run_at, board_column").in("agent_id", agentIds)
        .neq("status", "archived").order("created_at", { ascending: false }).limit(60);
      return (data ?? []) as Array<{ id: string; agent_id: string; title: string; status: string; schedule: string | null; next_run_at: string | null; board_column: string | null }>;
    },
  });
  if (agentIds.length === 0 || (!isLoading && (missions ?? []).length === 0))
    return <div className="p-6"><Empty icon={TargetIcon} title="Aucune tâche" hint="Les missions de cette room apparaîtront ici." /></div>;
  if (isLoading) return <Centered />;
  return (
    <div className="space-y-2 p-4">
      {(missions ?? []).map((m) => (
        <div key={m.id} className="flex items-center gap-2 rounded-xl border border-border bg-card/60 p-3">
          {m.status === "done" ? <CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-500" />
            : m.status === "failed" ? <XCircleIcon className="h-4 w-4 shrink-0 text-destructive" />
            : <TargetIcon className="h-4 w-4 shrink-0 text-blue-500" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{m.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {nameOf.get(m.agent_id)} · {m.status}{m.schedule ? <> · <code className="text-[11px]">{m.schedule}</code> · prochain : {fmt(m.next_run_at)}</> : null}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
