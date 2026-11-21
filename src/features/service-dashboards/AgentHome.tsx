import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowRightIcon, CaretDownIcon, CaretRightIcon, ChatCircleDotsIcon, SparkleIcon,
  ListChecksIcon, TrayIcon, TimerIcon, CoinsIcon, CaretDoubleRightIcon, SquaresFourIcon,
  CircleNotchIcon as Loader2, CheckIcon, XIcon, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { callEdge } from "@/lib/edge";
import { useToast } from "@/components/ToastProvider";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { RunTimeline } from "@/features/internal-agents/RunTimeline";
import { DetailSheet } from "@/features/governance/aiops/DetailSheet";
import { toolIcon, toolIntegrationName, toolSummary, type RunTodo } from "@/features/internal-agents/runEventMeta";
import { type InternalAgent } from "@/features/internal-agents/shared";
import { formatRelative } from "@/features/tracker/pickers";
import { fetchTasks, KIND_META, type TaskCard } from "./AgentTasksPanel";
import { useCollaboratorInbox, approvalLabel, KIND_META as INBOX_META, KIND_ORDER as INBOX_ORDER, type InboxItem } from "./CollaboratorInbox";
import { AUTONOMY_META, type AutonomyLevel } from "./AgentAutonomyTab";
import { useWorkbench } from "./workbench";
import { agentChatHref, agentDashboardsHref, rememberAgentView } from "./agentView";

/**
 * Le tableau de bord d'un collaborateur : ce qu'ouvre sa carte.
 *
 *   · le bandeau : ce qu'il fait en ce moment, ses chiffres du jour, l'entrée
 *     de son chat ;
 *   · quatre indicateurs : son plan en cours, ce qui vous attend, son temps de
 *     travail et son coût ;
 *   · son activité des dernières 24 h et ses tâches ;
 *   · l'historique de ses runs : calendrier, tendances, tableau dépliable,
 *     répartition et configuration.
 *
 * Une seule teinte pour les grandeurs (le violet de l'app, du clair au
 * foncé) ; le vert, l'ambre et le rouge ne disent que l'état.
 */

// ── Données ──────────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  mission_id: string | null;
  conversation_id: string | null;
  triggered_via: string | null;
  action_count: number | null;
  cost_usd: number | null;
  error_message: string | null;
}

type RunKind = "chat" | "mission" | "schedule" | "event" | "other";
type Filter = "all" | "chat" | "mission" | "schedule";

const KIND_LABEL: Record<RunKind, string> = {
  chat: "Conversation", mission: "Mission", schedule: "Planifié", event: "Événement", other: "API",
};
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "Tous" },
  { key: "chat", label: "Conversations" },
  { key: "mission", label: "Missions" },
  { key: "schedule", label: "Planifiés" },
];

function kindOf(r: Pick<RunRow, "triggered_via" | "conversation_id" | "mission_id">): RunKind {
  if (r.triggered_via === "schedule") return "schedule";
  if (r.triggered_via === "event") return "event";
  if (r.conversation_id) return "chat";
  if (r.mission_id) return "mission";
  return "other";
}

const DAY = 24 * 60 * 60 * 1000;
const HEAT_WEEKS = 26;
// Un run « en cours » depuis des heures est un zombie que le réconciliateur
// n'a pas encore balayé : le montrer « en cours » serait faux.
const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
const isLive = (r: Pick<RunRow, "status" | "created_at">) => (r.status === "running" || r.status === "queued")
  && Date.now() - new Date(r.created_at).getTime() < LIVE_WINDOW_MS;

const RUN_STATUS: Record<string, { label: string; pill: string }> = {
  running: { label: "En cours", pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  queued: { label: "En file", pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  succeeded: { label: "Terminé", pill: "bg-muted text-muted-foreground" },
  failed: { label: "Échec", pill: "bg-red-500/10 text-red-700 dark:text-red-400" },
  awaiting_input: { label: "Attend", pill: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  cancelled: { label: "Annulé", pill: "bg-muted text-muted-foreground" },
  stale: { label: "Interrompu", pill: "bg-muted text-muted-foreground" },
};

const TOOL_LABEL: Record<string, string> = {
  send_email: "E-mail", web_search: "Recherche web", deep_research: "Recherche approfondie",
  read_url: "Lecture de page", http_get: "Requête HTTP", http_request: "Requête HTTP", browse_web: "Navigation",
  file_write: "Fichier écrit", file_edit: "Fichier modifié", file_read: "Fichier lu", list_files: "Fichiers",
  shell_exec: "Commande", python_exec: "Python", nodejs_exec: "Node.js", jupyter_exec: "Jupyter",
  create_deliverable: "Livrable", create_artifact: "Document", publish_artifact: "Publication", update_artifact: "Document",
  save_memory: "Mémoire", search_memory: "Mémoire", knowledge_search: "Connaissances", search_knowledge: "Connaissances",
  create_mission: "Mission", delegate_mission: "Délégation", spawn_parallel_agents: "Sous-agents",
  send_message_to_agent: "Message à un agent", handoff_to_teammate: "Relais", ask_user: "Question",
  crm: "CRM", tracker: "Suivi", generate_image: "Image", generate_pdf: "PDF", run_automation: "Automatisation",
  vibe_code: "Code", security_scan: "Analyse de sécurité", query_table: "Données",
};
/** Le travail interne du run : il ne dit rien à la personne qui regarde. */
const HIDDEN_TOOLS = new Set(["update_todos", "say", "load_toolset", "need_tools", "use_skill", "read_tool_output", "search_context"]);

function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? toolIntegrationName(name) ?? name.replace(/^use_|^mcp_/, "").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

const nf = (n: number) => n.toLocaleString("fr-FR");
const money = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0).replace(".", ",")}`;
const hours = (ms: number) => (ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1).replace(".", ",")} h`);
const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayLabel = (t: number) => new Date(t).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const runDuration = (r: RunRow) => {
  const end = r.finished_at ? new Date(r.finished_at).getTime() : isLive(r) ? Date.now() : null;
  return end == null ? null : Math.max(0, end - new Date(r.started_at ?? r.created_at).getTime());
};

function useAgentRow(agentId: string) {
  return useQuery({
    queryKey: ["sd_agent_full", agentId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("*").eq("id", agentId).maybeSingle();
      return data as (InternalAgent & { model?: string | null; autonomy_level?: AutonomyLevel | null; max_run_cost_usd?: number | null }) | null;
    },
  });
}

async function fetchHistory(agentId: string): Promise<RunRow[]> {
  const since = new Date(dayStart(Date.now()) - (HEAT_WEEKS * 7 + 7) * DAY).toISOString();
  const { data, error } = await supabase.from("internal_agent_runs")
    .select("id, status, created_at, started_at, finished_at, mission_id, conversation_id, triggered_via, action_count, cost_usd, error_message")
    .eq("agent_id", agentId).is("parent_run_id", null).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(5000);
  if (error) throw new Error(error.message);
  return (data ?? []) as RunRow[];
}

// ── Info-bulle des graphiques ────────────────────────────────────────────────

interface Tip { x: number; y: number; value: string; label: string }

function useTip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: React.PointerEvent | React.FocusEvent, value: string, label: string) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const t = (e.target as Element).getBoundingClientRect();
    const x = "clientX" in e ? e.clientX : t.left + t.width / 2;
    setTip({ x: x - box.left, y: t.top - box.top, value, label });
  };
  return { ref, tip, show, hide: () => setTip(null) };
}

function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md"
      style={{ left: tip.x, top: tip.y - 8 }}
    >
      <div className="text-[12px] font-semibold">{tip.value}</div>
      <div className="text-[11px] text-muted-foreground">{tip.label}</div>
    </div>
  );
}

// ── La page ──────────────────────────────────────────────────────────────────

export function AgentHome({ dashboardId, agentId }: { dashboardId: string; agentId: string }) {
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const wb = useWorkbench();
  const sbase = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
  const { data: agent, isLoading } = useAgentRow(agentId);

  useEffect(() => {
    rememberAgentView(agentId, "home");
    wb?.setConversationId(null);
  }, [agentId, wb?.setConversationId]);

  const { data: history } = useQuery({
    queryKey: ["agent_home_history", agentId],
    queryFn: () => fetchHistory(agentId),
    refetchInterval: (q) => ((q.state.data ?? []).some(isLive) ? 5_000 : 30_000),
  });
  const { data: total } = useQuery({
    queryKey: ["agent_home_total", agentId],
    queryFn: async () => {
      const { count } = await supabase.from("internal_agent_runs")
        .select("id", { count: "exact", head: true }).eq("agent_id", agentId).is("parent_run_id", null);
      return count ?? 0;
    },
    refetchInterval: 60_000,
  });
  const { data: tasks } = useQuery({
    queryKey: ["agent_tasks", agentId],
    queryFn: () => fetchTasks(agentId),
    refetchInterval: (q) => ((q.state.data ?? []).some((c) => c.section === "live") ? 5_000 : 20_000),
  });
  const liveRun = (history ?? []).find(isLive) ?? null;
  const { data: plan } = useQuery({
    queryKey: ["agent_home_plan", liveRun?.id],
    enabled: !!liveRun,
    refetchInterval: 5_000,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_runs").select("todos").eq("id", liveRun!.id).maybeSingle();
      return ((data as { todos?: RunTodo[] | null } | null)?.todos ?? []).filter((t) => !t.parent_id);
    },
  });
  // Les dashboards que cet agent remplit (0301) : leur nombre et le dernier
  // remplissage, pour la carte qui les ouvre.
  const { data: dashStats } = useQuery({
    queryKey: ["agent_home_dashboards", agentId],
    queryFn: async () => {
      const { data } = await supabase.from("agent_dashboards").select("id, last_filled_at")
        .eq("agent_id", agentId).eq("is_template", false).limit(500);
      const rows = (data ?? []) as Array<{ id: string; last_filled_at: string | null }>;
      const last = rows.map((r) => r.last_filled_at).filter((x): x is string => !!x).sort().pop() ?? null;
      return { count: rows.length, last };
    },
  });
  const { data: lastConversation } = useQuery({
    queryKey: ["agent_home_last_conversation", agentId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_conversations")
        .select("id, updated_at").eq("agent_id", agentId).is("channel_id", null)
        .order("updated_at", { ascending: false }).limit(1).maybeSingle();
      return data as { id: string; updated_at: string } | null;
    },
  });
  const { data: inbox } = useCollaboratorInbox(dashboardId);
  const waiting = (inbox ?? []).filter((i) => i.agent_id === agentId && (i.kind === "approval" || i.kind === "question")).length;

  const stats = useMemo(() => {
    const runs = history ?? [];
    const now = Date.now();
    const today = dayStart(now);
    const week = runs.filter((r) => new Date(r.created_at).getTime() >= today - 6 * DAY);
    const todayRuns = runs.filter((r) => new Date(r.created_at).getTime() >= today);
    const days = Array.from({ length: 7 }, (_, i) => today - (6 - i) * DAY);
    const perDay = days.map((d) => week.filter((r) => dayStart(new Date(r.created_at).getTime()) === d));
    const ok = week.filter((r) => r.status === "succeeded").length;
    const failed = week.filter((r) => r.status === "failed").length;
    const durations = week.map(runDuration).filter((d): d is number => d != null);
    const cost = week.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
    const byKind = new Map<RunKind, number>();
    for (const r of week) byKind.set(kindOf(r), (byKind.get(kindOf(r)) ?? 0) + 1);
    return {
      today: todayRuns.length,
      todayDone: todayRuns.filter((r) => r.status === "succeeded" || r.status === "failed").length,
      todayLive: todayRuns.filter(isLive).length,
      days,
      perDayCount: perDay.map((l) => l.length),
      perDayRate: perDay.map((l) => {
        const done = l.filter((r) => r.status === "succeeded" || r.status === "failed");
        return done.length ? Math.round((l.filter((r) => r.status === "succeeded").length / done.length) * 100) : 0;
      }),
      weekCount: week.length,
      ok, failed,
      rate: ok + failed > 0 ? Math.round((ok / (ok + failed)) * 100) : null,
      work: durations.reduce((s, d) => s + d, 0),
      avgWork: durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : 0,
      cost,
      avgCost: week.length ? cost / week.length : 0,
      byKind,
    };
  }, [history]);

  if (isLoading || !agent) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const openSettings = () => (wb ? wb.openTab("agent-settings") : navigate(`${sbase}/agent-config/${agent.id}`));
  const liveTasks = (tasks ?? []).filter((t) => t.section === "live");
  const planDone = (plan ?? []).filter((t) => t.status === "done").length;
  const planTotal = (plan ?? []).length;
  const budget = Number(agent.max_run_cost_usd) || 0;

  return (
    <div className="ah-root h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1760px] space-y-5 px-4 pb-10 pt-5 lg:px-5">
        {/* ── Le bandeau ── */}
        {/* Un fond uni, teinté par l'accent du thème : le violet de la
            marque, le bleu roi de Jet… très assombri pour porter du texte blanc. */}
        <section
          className="ah-hero grid items-center gap-6 overflow-hidden rounded-3xl p-6 text-white"
          style={{
            background: "color-mix(in oklab, hsl(var(--primary)) 28%, #09090f)",
          }}
        >
          {/* L'agent lui-même, en grand, à gauche : son avatar 3D posé sur une
              ombre portée. */}
          <div className="ah-avatar relative h-[180px] items-center justify-center">
            <span
              aria-hidden
              className="absolute bottom-2 h-5 w-32 rounded-[50%]"
              style={{ background: "radial-gradient(closest-side, rgb(0 0 0 / 0.5), transparent)" }}
            />
            <span className="relative -translate-y-2">
              <AgentIdentity
                style={agent.avatar_style ?? "orb"} url={agent.avatar_url} seed={agent.name} size={150} rounded="rounded-[2rem]"
                state={liveRun ? "working" : "default"}
              />
            </span>
          </div>

          <div className="flex min-w-0 items-center">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[11px] font-medium uppercase tracking-wide">
                <span className={cn("h-1.5 w-1.5 rounded-full", liveRun ? "animate-pulse bg-emerald-400" : "bg-white/50")} />
                Agent · {liveRun ? "En direct" : "Disponible"}
              </span>
              <h1 className="mt-2.5 truncate text-[22px] font-semibold tracking-tight">
                {liveTasks.length > 0
                  ? `${agent.name} travaille sur ${liveTasks.length} tâche${liveTasks.length > 1 ? "s" : ""} en ce moment`
                  : waiting > 0 ? `${agent.name} attend votre feu vert`
                  : `${agent.name} est disponible`}
              </h1>
              <div className="mt-3 flex flex-wrap gap-2">
                {liveTasks.slice(0, 3).map((t) => (
                  <span key={t.key} className="max-w-[260px] truncate rounded-full border border-white/20 px-3 py-1 text-[12px] text-white/85">{t.title}</span>
                ))}
                {waiting > 0 && (
                  <button
                    onClick={() => navigate(`${sbase}/projects/inbox`)}
                    className="rounded-full border border-amber-300/40 bg-amber-400/10 px-3 py-1 text-[12px] text-amber-200 transition-colors hover:bg-amber-400/20"
                  >
                    {waiting} demande{waiting > 1 ? "s" : ""} vous attend{waiting > 1 ? "ent" : ""}
                  </button>
                )}
                {liveTasks.length === 0 && waiting === 0 && agent.description && (
                  <span className="max-w-[520px] truncate text-[13px] text-white/60">{agent.description}</span>
                )}
              </div>
            </div>
          </div>

          <div className="ah-tiles grid gap-3">
            <HeroTile
              label="Runs aujourd'hui" value={nf(stats.today)}
              sub={`${stats.todayDone} terminé${stats.todayDone > 1 ? "s" : ""} · ${stats.todayLive} en cours`}
              bars={stats.perDayCount} days={stats.days} unit={(v) => `${nf(v)} run${v > 1 ? "s" : ""}`}
            />
            <HeroTile
              label="Réussite" value={stats.rate == null ? "–" : `${stats.rate} %`}
              sub={`${stats.ok} réussi${stats.ok > 1 ? "s" : ""} · ${stats.failed} échec${stats.failed > 1 ? "s" : ""}`}
              bars={stats.perDayRate} days={stats.days} unit={(v) => `${v} % de réussite`}
            />
            {/* Deux portes, l'une sous l'autre : le chat, puis les dashboards
                que l'agent remplit. */}
            <div className="flex flex-col gap-3">
              <button
                onClick={() => navigate(agentChatHref(sbase, agent.id))}
                className="group flex flex-1 items-center gap-3 rounded-2xl bg-white px-4 py-3 text-left text-zinc-900 transition-colors hover:bg-white/90"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]">
                  <ChatCircleDotsIcon weight="duotone" className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">Discuter avec {agent.name}</span>
                  <span className="block truncate text-[12px] opacity-60">
                    {lastConversation ? `Dernier échange ${formatRelative(lastConversation.updated_at)}` : "Première conversation"}
                  </span>
                </span>
                <ArrowRightIcon className="h-4 w-4 shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />
              </button>
              <button
                onClick={() => navigate(agentDashboardsHref(sbase, agent.id))}
                className="group flex flex-1 items-center gap-3 rounded-2xl bg-white/[0.07] px-4 py-3 text-left ring-1 ring-inset ring-white/10 transition-colors hover:bg-white/[0.12]"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10">
                  <SquaresFourIcon weight="duotone" className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">
                    Dashboards{dashStats?.count ? ` · ${dashStats.count}` : ""}
                  </span>
                  <span className="block truncate text-[12px] text-white/60">
                    {!dashStats?.count ? "Aucun dashboard pour l'instant"
                      : dashStats.last ? `Dernier rempli ${formatRelative(dashStats.last)}` : "Jamais remplis"}
                  </span>
                </span>
                <ArrowRightIcon className="h-4 w-4 shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />
              </button>
            </div>
          </div>
        </section>

        {/* ── Les indicateurs, l'activité et les tâches ; à droite, ce qui
            attend une décision, dans la colonne de la répartition des runs. ── */}
        <div className="ah-main grid gap-5">
        <div className="min-w-0 space-y-5">
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))]">
          <KpiCard
            icon={ListChecksIcon} label="Plan en cours"
            value={planTotal ? `${planDone}/${planTotal}` : "–"}
            sub={liveRun ? (liveTasks[0]?.title ?? "Run en cours") : "Aucun run en cours"}
            meter={planTotal ? { label: "Étapes faites", pct: Math.round((planDone / planTotal) * 100) } : undefined}
            footer={planTotal ? undefined : "Le plan s'affiche dès qu'un run démarre"}
          />
          <KpiCard
            icon={TrayIcon} label="Vous attend" value={nf(waiting)}
            sub="autorisations et questions"
            action={waiting > 0 ? { label: "Ouvrir « À valider »", onClick: () => navigate(`${sbase}/projects/inbox`) } : undefined}
            footer={waiting > 0 ? undefined : "Rien en attente"}
          />
          <KpiCard
            icon={TimerIcon} label="Temps de travail" value={stats.work ? hours(stats.work) : "–"}
            sub={stats.avgWork ? `≈ ${hours(stats.avgWork)} par run` : "sur 7 jours"}
            meter={stats.weekCount ? { label: "Runs aboutis", pct: Math.round((stats.ok / stats.weekCount) * 100) } : undefined}
            footer={stats.weekCount ? undefined : "Aucun run cette semaine"}
          />
          <KpiCard
            icon={CoinsIcon} label="Coût sur 7 jours" value={money(stats.cost)}
            sub={stats.weekCount ? `≈ ${money(stats.avgCost)} par run` : "aucun run"}
            meter={budget > 0 && stats.weekCount ? { label: "Du plafond par run", pct: Math.min(100, Math.round((stats.avgCost / budget) * 100)), tone: stats.avgCost > budget * 0.8 ? "warn" : "accent" } : undefined}
            footer={budget > 0 ? undefined : "Sans plafond par run"}
          />
        </div>

        {/* ── Activité et tâches ── */}
        <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr))]">
          <ActivityCard history={history ?? []} />
          <TasksCard tasks={tasks} sbase={sbase} agentId={agent.id} />
        </div>
        </div>
        <PendingCard items={(inbox ?? []).filter((i) => i.agent_id === agent.id)} dashboardId={dashboardId} sbase={sbase} />
        </div>

        {/* ── Les runs ── */}
        <RunsSection
          history={history ?? []} total={total ?? null} agent={agent} sbase={sbase}
          byKind={stats.byKind} weekCount={stats.weekCount} onSettings={openSettings}
        />
      </div>
    </div>
  );
}

/** Ce que l'agent attend d'un humain : une autorisation se décide ici, le
 *  reste (question, échec, proposition) s'ouvre dans « À valider ». */
function PendingCard({ items, dashboardId, sbase }: { items: InboxItem[]; dashboardId: string; sbase: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const sorted = [...items].sort((a, b) => INBOX_ORDER.indexOf(a.kind) - INBOX_ORDER.indexOf(b.kind) || b.since.localeCompare(a.since));
  const approvals = items.filter((i) => i.kind === "approval").length;
  const inboxHref = `${sbase}/projects/inbox`;

  const decide = async (item: InboxItem, decision: "approve" | "reject") => {
    setBusy(item.ref_id);
    try {
      const res = await callEdge<{ ok?: boolean; detail?: string }>("internal-agent-approve", { approval_id: item.ref_id, decision, source: "inbox" });
      qc.setQueryData<InboxItem[]>(["sd_inbox", dashboardId], (old) => (old ?? []).filter((x) => !(x.kind === item.kind && x.ref_id === item.ref_id)));
      if (decision === "reject") toast.info("Refusé", `${item.agent_name} en sera informé.`);
      else if (res?.ok === false) toast.error("Autorisé, mais l'exécution a échoué", res.detail?.slice(0, 200));
      else toast.success("Autorisé et exécuté");
    } catch (e) {
      toast.error("Action impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ["sd_inbox", dashboardId] });
    }
  };

  const sub = items.length
    ? `${items.length} en attente${approvals ? ` · ${approvals} autorisation${approvals > 1 ? "s" : ""}` : ""}`
    : "Rien à décider";

  return (
    <section className="ah-pending flex min-h-0 flex-col rounded-2xl border border-border bg-card">
      <CardHeader title="Demandes en attente" sub={sub} />
      {sorted.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-10 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <CheckIcon weight="bold" className="h-4 w-4" />
          </span>
          <p className="text-[13px] text-muted-foreground">Aucune autorisation ni question en attente.</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4 pt-3 scrollbar-hide">
          {sorted.map((item) => {
            const meta = INBOX_META[item.kind];
            const title = item.kind === "approval" ? approvalLabel(item) : (item.title || meta.label);
            const pending = busy === item.ref_id;
            return (
              <li key={`${item.kind}:${item.ref_id}`} className="rounded-xl border border-border/70 p-3">
                <div className="flex items-center gap-2">
                  <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium", meta.tone)}>
                    <meta.icon className="h-3 w-3" /> {meta.label}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{formatRelative(item.since)}</span>
                </div>
                <div className="mt-2 line-clamp-2 text-[13px] font-medium">{title}</div>
                {item.body && item.kind !== "approval" && (
                  <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{item.body}</p>
                )}
                <div className="mt-2.5 flex items-center gap-1.5">
                  {item.kind === "approval" ? (
                    <>
                      <button
                        disabled={pending}
                        onClick={() => decide(item, "approve")}
                        className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                      >
                        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckIcon weight="bold" className="h-3 w-3" />} Autoriser
                      </button>
                      <button
                        disabled={pending}
                        onClick={() => decide(item, "reject")}
                        className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        <XIcon weight="bold" className="h-3 w-3" /> Refuser
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => navigate(inboxHref)}
                      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
                    >
                      {item.kind === "question" ? "Répondre" : "Ouvrir"} <ArrowRightIcon className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {sorted.length > 0 && (
        <button
          onClick={() => navigate(inboxHref)}
          className="flex items-center justify-center gap-1 border-t border-border/70 py-2.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Tout voir dans « À valider » <ArrowRightIcon className="h-3 w-3" />
        </button>
      )}
    </section>
  );
}

// ── Morceaux ─────────────────────────────────────────────────────────────────

/** Une tuile du bandeau : la valeur, et sept barres pour les sept derniers jours. */
function HeroTile({ label, value, sub, bars, days, unit }: {
  label: string; value: string; sub: string; bars: number[]; days: number[]; unit: (v: number) => string;
}) {
  const { ref, tip, show, hide } = useTip();
  const max = Math.max(1, ...bars);
  return (
    <div ref={ref} className="relative flex flex-col justify-between rounded-2xl bg-white/[0.07] p-4 ring-1 ring-inset ring-white/10">
      <span className="text-[12px] text-white/70">{label}</span>
      <span className="mt-3 flex items-end justify-between gap-3">
        <span className="whitespace-nowrap text-[26px] font-semibold leading-none tracking-tight">{value}</span>
        <span className="flex h-9 items-end gap-[3px]" onPointerLeave={hide}>
          {bars.map((v, i) => (
            <span
              key={i}
              onPointerMove={(e) => show(e, unit(v), dayLabel(days[i]))}
              className="flex h-full w-[9px] items-end"
            >
              <span
                className={cn("block w-full rounded-t-[3px]", i === bars.length - 1 ? "bg-white" : "bg-white/40")}
                style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
              />
            </span>
          ))}
        </span>
      </span>
      <span className="mt-2.5 truncate text-[11px] text-white/55">{sub}</span>
      <TipBox tip={tip} />
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, sub, meter, action, footer }: {
  icon: PhosphorIcon; label: string; value: string; sub: string;
  meter?: { label: string; pct: number; tone?: "accent" | "warn" };
  action?: { label: string; onClick: () => void };
  footer?: string;
}) {
  return (
    <section className="flex flex-col rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-[13px] text-muted-foreground">{label}</span>
      </div>
      <div className="mt-4 whitespace-nowrap text-[30px] font-semibold leading-none tracking-tight">{value}</div>
      <div className="mt-1.5 truncate text-[12px] text-muted-foreground">{sub}</div>
      <div className="mt-auto pt-4">
        {meter ? (
          <>
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <span className="min-w-0 truncate font-medium">{meter.label}</span>
              <span className="shrink-0 whitespace-nowrap font-medium tabular-nums">{meter.pct} %</span>
            </div>
            <div className={cn("mt-1.5 h-2 overflow-hidden rounded-full", meter.tone === "warn" ? "bg-amber-500/15" : "bg-primary/15")}>
              <div
                className={cn("h-full rounded-full", meter.tone === "warn" ? "bg-amber-500" : "bg-primary")}
                style={{ width: `${Math.max(meter.pct > 0 ? 3 : 0, meter.pct)}%` }}
              />
            </div>
          </>
        ) : action ? (
          <button onClick={action.onClick} className="flex items-center gap-1 text-[12px] font-medium text-primary hover:underline">
            {action.label} <ArrowRightIcon className="h-3 w-3" />
          </button>
        ) : (
          <span className="text-[12px] text-muted-foreground/80">{footer}</span>
        )}
      </div>
    </section>
  );
}

function CardHeader({ title, sub, live, children }: { title: string; sub?: string; live?: boolean; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-5 pt-5">
      <div className="min-w-0 flex-1">
        <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
        {sub && (
          <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
            {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />}
            {sub}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Activité des dernières 24 h ──────────────────────────────────────────────

interface EventRow { id: string; run_id: string; kind: string; payload: Record<string, unknown> | null; created_at: string }

function ActivityCard({ history }: { history: RunRow[] }) {
  const [all, setAll] = useState(false);
  const ids = useMemo(() => history.filter((r) => Date.now() - new Date(r.created_at).getTime() < DAY).slice(0, 40).map((r) => r.id), [history]);
  const live = history.some(isLive);
  const { data, isLoading } = useQuery({
    queryKey: ["agent_home_activity", ids.join(",")],
    enabled: ids.length > 0,
    refetchInterval: live ? 5_000 : 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("internal_agent_run_events")
        .select("id, run_id, kind, payload, created_at")
        .in("run_id", ids).in("kind", ["tool_call", "error"])
        .order("created_at", { ascending: false }).limit(80);
      if (error) throw new Error(error.message);
      return ((data ?? []) as EventRow[]).filter((e) => e.kind === "error" || !HIDDEN_TOOLS.has(String(e.payload?.tool ?? "")));
    },
  });
  const events = data ?? [];
  const shown = all ? events.slice(0, 40) : events.slice(0, 6);
  return (
    <section className="flex flex-col rounded-2xl border border-border bg-card">
      <CardHeader title="Activité" sub={`${live ? "En direct · " : ""}dernières 24 h`} live={live}>
        {events.length > 6 && (
          <button
            onClick={() => setAll((v) => !v)}
            className="rounded-full border border-border px-4 py-1.5 text-[13px] font-medium transition-colors hover:bg-muted"
          >
            {all ? "Réduire" : "Tout voir"}
          </button>
        )}
      </CardHeader>
      <div className="mt-3 flex-1 px-5 pb-3">
        {isLoading && ids.length > 0 ? (
          <div className="flex justify-center py-10"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : !shown.length ? (
          <p className="py-10 text-center text-[13px] text-muted-foreground">Aucune action ces dernières 24 h.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {shown.map((e) => {
              const tool = typeof e.payload?.tool === "string" ? e.payload.tool : null;
              const error = e.kind === "error";
              const detail = error ? String(e.payload?.error ?? e.payload?.message ?? "").split("\n")[0] : tool ? toolSummary(tool, e.payload?.args) : "";
              return (
                <li key={e.id} className="flex gap-3.5 py-3.5">
                  <span className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground",
                    error && "border-red-500/20 bg-red-500/5 text-red-600 dark:text-red-400",
                  )}>
                    {tool ? toolIcon(tool) : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-[13px]">
                      <span className="font-semibold">{error ? "Erreur" : tool ? toolLabel(tool) : "Action"}</span>
                      {detail && <span className="text-foreground/80"> {detail}</span>}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 text-[12px] text-muted-foreground">
                      <SparkleIcon weight="fill" className="h-3 w-3 text-primary/70" /> Agent · {formatRelative(e.created_at)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

// ── Tâches ──────────────────────────────────────────────────────────────────

type TaskTab = "now" | "todo" | "done";
const TASK_TABS: Array<{ key: TaskTab; label: string }> = [
  { key: "now", label: "En cours" },
  { key: "todo", label: "À faire" },
  { key: "done", label: "Terminées" },
];
const tabOf = (t: TaskCard): TaskTab => (t.section === "live" || t.section === "waiting" ? "now" : t.section === "done" ? "done" : "todo");

const TONE_BAR: Record<TaskCard["status"]["tone"], string> = {
  live: "bg-emerald-500", waiting: "bg-amber-500", todo: "bg-primary/60", done: "bg-muted-foreground/30", failed: "bg-red-500",
};
const TONE_PILL: Record<TaskCard["status"]["tone"], string> = {
  live: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  waiting: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  todo: "bg-primary/10 text-primary",
  done: "bg-muted text-muted-foreground",
  failed: "bg-red-500/10 text-red-700 dark:text-red-400",
};

function TasksCard({ tasks, sbase, agentId }: { tasks: TaskCard[] | undefined; sbase: string; agentId: string }) {
  const navigate = useNavigate();
  const list = tasks ?? [];
  const counts = { now: 0, todo: 0, done: 0 } as Record<TaskTab, number>;
  for (const t of list) counts[tabOf(t)]++;
  const [tab, setTab] = useState<TaskTab | null>(null);
  const active: TaskTab = tab ?? (counts.now ? "now" : counts.todo ? "todo" : "done");
  const [openRun, setOpenRun] = useState<OpenRun | null>(null);
  const rows = list.filter((t) => tabOf(t) === active).slice(0, 12);

  const open = (t: TaskCard) => {
    const o = t.open;
    if (o.type === "conversation") navigate(agentChatHref(sbase, agentId, o.id));
    else if (o.type === "issue") navigate(`${sbase}/projects/${o.projectId}/issues?issue=${o.issueId}`);
    else if (o.type === "room") navigate(`${sbase}/room/${o.roomId}`);
    else if (o.type === "inbox") navigate(`${sbase}/projects/inbox`);
    else if (o.runId) setOpenRun({ runId: o.runId, live: o.live, title: t.title, subtitle: t.subtitle ?? KIND_META[t.kind].label });
  };

  return (
    <section className="flex flex-col rounded-2xl border border-border bg-card">
      <CardHeader title="Tâches" sub={`${counts.now} en cours · ${counts.todo} à faire`} />
      <div className="mx-5 mt-4 grid grid-cols-3 gap-1 rounded-full bg-muted/70 p-1">
        {TASK_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex items-center justify-center gap-2 rounded-full px-3 py-1.5 text-[13px] transition-colors",
              active === t.key ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label} <span className="text-[12px] text-muted-foreground">{counts[t.key]}</span>
          </button>
        ))}
      </div>
      <div className="flex-1 px-5 pb-3 pt-2">
        {!tasks ? (
          <div className="flex justify-center py-10"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : !rows.length ? (
          <p className="py-10 text-center text-[13px] text-muted-foreground">Rien ici pour l'instant.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {rows.map((t) => {
              const at = new Date(t.at);
              const sameDay = dayStart(at.getTime()) === dayStart(Date.now());
              const run = t.open.type === "run" ? t.open : null;
              const selected = !!run?.runId && openRun?.runId === run.runId;
              return (
                <li key={t.key}>
                  <button
                    onClick={() => open(t)}
                    className={cn("-mx-2 flex w-[calc(100%+1rem)] items-stretch gap-4 rounded-lg px-2 py-3.5 text-left transition-colors hover:bg-muted/40", selected && "bg-muted/60")}
                  >
                    <span className="w-14 shrink-0 pt-0.5 text-right">
                      <span className="block text-[15px] font-semibold tabular-nums">
                        {sameDay ? at.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : at.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">{KIND_META[t.kind].label.split(" ")[0]}</span>
                    </span>
                    <span className={cn("w-[3px] shrink-0 rounded-full", TONE_BAR[t.status.tone])} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold">{t.title}</span>
                      {t.subtitle && <span className="block truncate text-[13px] text-foreground/75">{t.subtitle}</span>}
                      {t.progress && (
                        <span className="mt-1 block text-[12px] text-muted-foreground">{t.progress.done}/{t.progress.total} étapes</span>
                      )}
                    </span>
                    <span className={cn("h-fit shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-medium", TONE_PILL[t.status.tone])}>
                      {t.status.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {openRun && <RunSheet run={openRun} sbase={sbase} agentId={agentId} onClose={() => setOpenRun(null)} />}
    </section>
  );
}

// ── Le détail d'un run, dans un panneau à droite ────────────────────────────
// Ouvrir un run en place étirait la carte et décalait toute la grille : le
// panneau garde le tableau de bord immobile et se ferme par Échap.

interface OpenRun { runId: string; live: boolean; title: string; subtitle?: string; conversationId?: string | null }

function RunSheet({ run, sbase, agentId, onClose }: { run: OpenRun; sbase: string; agentId: string; onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <DetailSheet
      onClose={onClose}
      title={run.title}
      subtitle={run.subtitle}
      storageKey="agent.run.width"
      defaultWidth={640}
      actions={run.conversationId ? (
        <button
          onClick={() => navigate(agentChatHref(sbase, agentId, run.conversationId))}
          className="shrink-0 rounded-full border border-border px-3 py-1 text-[12px] font-medium hover:bg-muted"
        >
          Ouvrir la conversation
        </button>
      ) : undefined}
    >
      <RunTimeline key={run.runId} runId={run.runId} live={run.live} defaultOpen />
    </DetailSheet>
  );
}

// ── Les runs ────────────────────────────────────────────────────────────────

function RunsSection({ history, total, agent, sbase, byKind, weekCount, onSettings }: {
  history: RunRow[];
  total: number | null;
  agent: { id: string; model?: string | null; autonomy_level?: AutonomyLevel | null; max_run_cost_usd?: number | null };
  sbase: string;
  byKind: Map<RunKind, number>;
  weekCount: number;
  onSettings: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const runs = useMemo(() => history.filter((r) => filter === "all" || kindOf(r) === filter), [history, filter]);

  return (
    <div className="space-y-5">
    <div className="ah-runs grid gap-5">
      <div className="min-w-0">
        <section className="h-full rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-start gap-3">
            <div>
              <div className="text-[13px] text-muted-foreground">Runs</div>
              <div className="mt-1 text-[30px] font-semibold leading-none tracking-tight">{total == null ? "–" : nf(total)}</div>
            </div>
            <div className="ml-auto flex rounded-full bg-muted/70 p-1">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    "rounded-full px-3 py-1 text-[13px] transition-colors",
                    filter === f.key ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <Heatmap runs={runs} />
          <div className="mt-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr))]">
            <TrendTile label="Dernière heure" runs={runs} span={60 * 60 * 1000} buckets={12} />
            <TrendTile label="Dernières 24 h" runs={runs} span={DAY} buckets={24} />
            <TrendTile label="7 derniers jours" runs={runs} span={7 * DAY} buckets={14} />
          </div>
        </section>
      </div>

      <div className="space-y-5">
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-[13px] text-muted-foreground">Répartition sur 7 jours</h2>
          <div className="mt-4 space-y-4">
            {(Object.keys(KIND_LABEL) as RunKind[])
              .filter((k) => (byKind.get(k) ?? 0) > 0 || k === "chat" || k === "mission" || k === "schedule")
              .map((k) => {
                const n = byKind.get(k) ?? 0;
                const pct = weekCount ? Math.round((n / weekCount) * 100) : 0;
                return (
                  <div key={k}>
                    <div className="flex items-center justify-between text-[13px]">
                      <span className="font-medium">{KIND_LABEL[k]}{k === "schedule" ? "s" : k === "chat" ? "s" : k === "mission" ? "s" : ""}</span>
                      <span className="tabular-nums text-muted-foreground">{pct} %</span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-primary/15">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${pct > 0 ? Math.max(3, pct) : 0}%` }} />
                    </div>
                    <div className="mt-1 text-[12px] text-muted-foreground">{nf(n)} run{n > 1 ? "s" : ""}</div>
                  </div>
                );
              })}
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-[13px] text-muted-foreground">Configuration</h2>
          <div className="mt-3 rounded-xl border border-border bg-background/60 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold">{agent.model || "Modèle par défaut"}</div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">
                  Autonomie : {AUTONOMY_META[(agent.autonomy_level ?? "assisted") as AutonomyLevel]?.label ?? "assistée"}
                </div>
              </div>
              <span className="shrink-0 text-[13px] font-medium tabular-nums">
                {Number(agent.max_run_cost_usd) > 0 ? `${money(Number(agent.max_run_cost_usd))} / run` : "Sans plafond"}
              </span>
            </div>
            <button
              onClick={onSettings}
              className="mt-4 rounded-full border border-border bg-card px-4 py-1.5 text-[13px] font-medium transition-colors hover:bg-muted"
            >
              Régler
            </button>
          </div>
        </section>
      </div>
    </div>
    {/* Le tableau prend toute la largeur : ses colonnes ont besoin de place. */}
    <RunsTable runs={runs} sbase={sbase} agentId={agent.id} />
    </div>
  );
}

/** Le calendrier des runs : une colonne par semaine, une ligne par jour. */
function Heatmap({ runs }: { runs: RunRow[] }) {
  const { ref, tip, show, hide } = useTip();
  const { weeks, max, months } = useMemo(() => {
    const today = dayStart(Date.now());
    const monday = today - ((new Date(today).getDay() + 6) % 7) * DAY;
    const start = monday - (HEAT_WEEKS - 1) * 7 * DAY;
    const counts = new Map<number, number>();
    for (const r of runs) {
      const d = dayStart(new Date(r.created_at).getTime());
      if (d >= start) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const weeks = Array.from({ length: HEAT_WEEKS }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => {
        const t = start + (w * 7 + d) * DAY;
        return { t, n: counts.get(t) ?? 0, future: t > today };
      }));
    const months = weeks.map((w, i) => {
      const m = new Date(w[0].t).getMonth();
      return i === 0 || new Date(weeks[i - 1][0].t).getMonth() !== m
        ? new Date(w[0].t).toLocaleDateString("fr-FR", { month: "short" })
        : "";
    });
    return { weeks, max: Math.max(0, ...[...counts.values()]), months };
  }, [runs]);

  // Cinq marches d'une seule teinte, du clair au foncé ; zéro reste neutre.
  const level = (n: number) => (n === 0 || max === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((n / max) * 4))));
  const STEP = ["bg-muted", "bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"];
  const DAYS = ["Lun", "", "Mer", "", "Ven", "", ""];

  return (
    <div ref={ref} className="relative mt-5 overflow-x-auto rounded-xl border border-border bg-background/60 p-4 scrollbar-hide">
      <div className="inline-flex min-w-full flex-col">
        <div className="ml-8 grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${HEAT_WEEKS}, minmax(12px, 1fr))` }}>
          {months.map((m, i) => <span key={i} className="h-4 text-[11px] text-muted-foreground">{m}</span>)}
        </div>
        <div className="mt-1 flex gap-[3px]" onPointerLeave={hide}>
          <div className="grid w-8 shrink-0 grid-rows-7 gap-[3px]">
            {DAYS.map((d, i) => <span key={i} className="flex items-center text-[11px] text-muted-foreground">{d}</span>)}
          </div>
          <div className="grid flex-1 gap-[3px]" style={{ gridTemplateColumns: `repeat(${HEAT_WEEKS}, minmax(12px, 1fr))` }}>
            {weeks.map((w, wi) => (
              <div key={wi} className="grid grid-rows-7 gap-[3px]">
                {w.map((c) => (
                  <span
                    key={c.t}
                    aria-label={c.future ? undefined : `${dayLabel(c.t)} : ${c.n} run${c.n > 1 ? "s" : ""}`}
                    onPointerMove={c.future ? undefined : (e) => show(e, `${nf(c.n)} run${c.n > 1 ? "s" : ""}`, dayLabel(c.t))}
                    className={cn(
                      "aspect-square w-full rounded-[3px] transition-[filter]",
                      c.future ? "bg-transparent" : STEP[level(c.n)],
                      !c.future && "hover:brightness-110 hover:ring-1 hover:ring-foreground/30",
                    )}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          Moins
          {STEP.map((s) => <span key={s} className={cn("h-3 w-3 rounded-[3px]", s)} />)}
          Plus
        </div>
      </div>
      <TipBox tip={tip} />
    </div>
  );
}

/** Les runs réussis sur une fenêtre, et leur courbe. */
function TrendTile({ label, runs, span, buckets }: { label: string; runs: RunRow[]; span: number; buckets: number }) {
  const { ref, tip, show, hide } = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const { series, total, starts } = useMemo(() => {
    const now = Date.now();
    const size = span / buckets;
    const from = now - span;
    const series = new Array<number>(buckets).fill(0);
    let total = 0;
    for (const r of runs) {
      if (r.status !== "succeeded") continue;
      const t = new Date(r.finished_at ?? r.created_at).getTime();
      if (t < from || t > now) continue;
      series[Math.min(buckets - 1, Math.floor((t - from) / size))]++;
      total++;
    }
    return { series, total, starts: series.map((_, i) => from + i * size) };
  }, [runs, span, buckets]);

  const W = 120, H = 44, P = 5;
  const max = Math.max(1, ...series);
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, buckets - 1);
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const line = series.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(buckets - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`;
  const when = (t: number) => (span <= DAY
    ? new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : new Date(t).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" }));

  return (
    <div ref={ref} className="relative flex items-center gap-3 rounded-xl border border-border p-4">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-muted-foreground">{label}</div>
        <div className="mt-1 text-[24px] font-semibold leading-tight tracking-tight">{nf(total)}</div>
        <div className="text-[12px] text-muted-foreground">réussi{total > 1 ? "s" : ""}</div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`} className="h-12 w-[132px] shrink-0 overflow-visible text-primary"
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const step = (W - 2 * P) / Math.max(1, buckets - 1);
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.max(0, Math.min(buckets - 1, Math.round((px - P) / step)));
          setHover(i);
          show(e, `${series[i]} réussi${series[i] > 1 ? "s" : ""}`, when(starts[i]));
        }}
        onPointerLeave={() => { setHover(null); hide(); }}
      >
        <path d={area} fill="currentColor" opacity={0.1} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={P - 2} y2={H - P} stroke="hsl(var(--border))" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover)} cy={y(series[hover])} r={4} fill="currentColor" stroke="hsl(var(--card))" strokeWidth={2} />
          </>
        )}
        {hover == null && (
          <circle cx={x(buckets - 1)} cy={y(series[buckets - 1])} r={4} fill="currentColor" stroke="hsl(var(--card))" strokeWidth={2} />
        )}
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

/** Les runs, en tableau : déclencheur, lancement, outils, statut, durée. */
function RunsTable({ runs, sbase, agentId }: { runs: RunRow[]; sbase: string; agentId: string }) {
  const [open, setOpen] = useState<OpenRun | null>(null);
  const [limit, setLimit] = useState(10);
  const shown = runs.slice(0, limit);
  const ids = shown.map((r) => r.id);

  const { data: extra } = useQuery({
    queryKey: ["agent_home_runs_extra", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const mids = [...new Set(shown.map((r) => r.mission_id).filter(Boolean))] as string[];
      const cids = [...new Set(shown.map((r) => r.conversation_id).filter(Boolean))] as string[];
      const none = Promise.resolve({ data: [] as unknown[] });
      const [ms, cs, ev] = await Promise.all([
        mids.length ? supabase.from("internal_agent_missions").select("id, title").in("id", mids) : none,
        cids.length ? supabase.from("internal_agent_conversations").select("id, title, channel_id").in("id", cids) : none,
        supabase.from("internal_agent_run_events").select("run_id, payload").in("run_id", ids).eq("kind", "tool_call").limit(1000),
      ]);
      const title = new Map<string, string>();
      for (const m of (ms.data ?? []) as Array<{ id: string; title: string | null }>) if (m.title) title.set(m.id, m.title);
      for (const c of (cs.data ?? []) as Array<{ id: string; title: string | null; channel_id: string | null }>) {
        // Un fil de messagerie s'appelle « slack:C123:main » : un identifiant, pas un titre.
        if (c.title && !c.channel_id) title.set(c.id, c.title);
      }
      const tools = new Map<string, Map<string, number>>();
      for (const e of (ev.data ?? []) as Array<{ run_id: string; payload: { tool?: string } | null }>) {
        const t = e.payload?.tool;
        if (!t || HIDDEN_TOOLS.has(t)) continue;
        const m = tools.get(e.run_id) ?? new Map<string, number>();
        m.set(t, (m.get(t) ?? 0) + 1);
        tools.set(e.run_id, m);
      }
      return { title, tools };
    },
  });

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,1.4fr)_110px_80px_28px] items-center gap-3 border-b border-border px-5 py-3 text-[12px] font-medium text-muted-foreground">
        <span>Déclencheur</span><span>Lancé</span><span>Outils</span><span>Statut</span><span>Durée</span><span />
      </div>
      {!shown.length ? (
        <p className="px-5 py-10 text-center text-[13px] text-muted-foreground">Aucun run pour ce filtre.</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {shown.map((r) => {
            const live = isLive(r);
            const stale = !live && (r.status === "running" || r.status === "queued");
            const s = RUN_STATUS[stale ? "stale" : r.status] ?? { label: r.status, pill: "bg-muted text-muted-foreground" };
            const kind = kindOf(r);
            const t = extra?.title.get(r.mission_id ?? "") ?? extra?.title.get(r.conversation_id ?? "");
            const tools = [...(extra?.tools.get(r.id)?.entries() ?? [])].sort((a, b) => b[1] - a[1]);
            const d = runDuration(r);
            const isOpen = open?.runId === r.id;
            return (
              <li key={r.id}>
                <button
                  onClick={() => setOpen({
                    runId: r.id, live, title: t ?? KIND_LABEL[kind], conversationId: r.conversation_id,
                    subtitle: `${KIND_LABEL[kind]} · ${new Date(r.created_at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`,
                  })}
                  className={cn(
                    "grid w-full grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,1.4fr)_110px_80px_28px] items-center gap-3 px-5 py-3 text-left text-[13px] transition-colors hover:bg-muted/40",
                    isOpen && "bg-muted/60",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{t ?? KIND_LABEL[kind]}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">{KIND_LABEL[kind]}</span>
                  </span>
                  <span className="truncate text-muted-foreground">
                    {new Date(r.created_at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    {tools.length ? (
                      <>
                        <CaretDoubleRightIcon className="h-3 w-3 shrink-0" />
                        <span className="truncate text-foreground/80">{toolLabel(tools[0][0])}</span>
                        {tools.length > 1 && <span className="shrink-0 text-[12px]">+{tools.length - 1}</span>}
                      </>
                    ) : <span>–</span>}
                  </span>
                  <span>
                    <span className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 status-mono", s.pill)}>
                      {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
                      {s.label}
                    </span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">{d == null ? "–" : d < 60_000 ? "< 1 min" : hours(d)}</span>
                  <CaretRightIcon className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {runs.length > limit && (
        <div className="border-t border-border px-5 py-3 text-center">
          <button onClick={() => setLimit((l) => l + 15)} className="text-[13px] font-medium text-primary hover:underline">Afficher plus</button>
        </div>
      )}
      {open && <RunSheet run={open} sbase={sbase} agentId={agentId} onClose={() => setOpen(null)} />}
    </section>
  );
}
