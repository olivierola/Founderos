import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeftIcon, ArrowSquareOutIcon, ChatCircleIcon, CalendarDotsIcon, TargetIcon, KanbanIcon,
  HashIcon, LightbulbIcon, PlayIcon, LightningIcon, CircleNotchIcon as Loader2,
  FlagIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { RunTimeline } from "@/features/internal-agents/RunTimeline";
import { SubAgentInstances } from "@/features/internal-agents/SubAgentInstances";
import { type RunTodo } from "@/features/internal-agents/runEventMeta";
import { formatRelative } from "@/features/tracker/pickers";

/**
 * « Tâches » : sur quoi le collaborateur travaille, en direct.
 *
 * Une carte par unité de travail, quelle que soit sa source : une conversation
 * en cours, une mission (planifiée, ponctuelle, proposée), un work item qui lui
 * est confié, une tâche de room. Rangées par ce qu'elles demandent : ce qui
 * tourne, ce qui vous attend, ce qui reste à faire, ce qui vient de finir.
 * Chaque carte s'ouvre là où le travail vit : la conversation dans le chat d'à
 * côté, l'exécution d'une mission en direct ici même, le work item dans son
 * board, la tâche dans sa room.
 */

type Section = "live" | "waiting" | "todo" | "listening" | "done";
type Kind = "conversation" | "scheduled" | "mission" | "proposal" | "work_item" | "room_task" | "trigger" | "goal";

interface TaskCard {
  key: string;
  kind: Kind;
  section: Section;
  title: string;
  status: { label: string; tone: "live" | "waiting" | "todo" | "done" | "failed" };
  subtitle?: string;
  /** Plan progress of the live run, when it has one. */
  progress?: { done: number; total: number };
  at: string;
  open:
    | { type: "conversation"; id: string }
    | { type: "run"; runId: string | null; missionId: string; live: boolean }
    | { type: "issue"; projectId: string; issueId: string }
    | { type: "room"; roomId: string }
    | { type: "inbox" };
}

const KIND_META: Record<Kind, { label: string; icon: PhosphorIcon }> = {
  conversation: { label: "Conversation", icon: ChatCircleIcon },
  scheduled: { label: "Mission planifiée", icon: CalendarDotsIcon },
  mission: { label: "Mission", icon: TargetIcon },
  proposal: { label: "Proposition", icon: LightbulbIcon },
  work_item: { label: "Work item", icon: KanbanIcon },
  room_task: { label: "Tâche de room", icon: HashIcon },
  trigger: { label: "Déclencheur", icon: LightningIcon },
  goal: { label: "Objectif", icon: FlagIcon },
};

const TONE: Record<TaskCard["status"]["tone"], string> = {
  live: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  waiting: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  todo: "bg-muted text-muted-foreground",
  done: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  failed: "bg-red-500/10 text-red-700 dark:text-red-400",
};

const SECTIONS: { key: Section; label: string }[] = [
  { key: "live", label: "En cours" },
  { key: "waiting", label: "Vous attend" },
  { key: "todo", label: "À faire" },
  // Standing triggers (0268) and goal watches (0269): not work to do, work
  // that will come.
  { key: "listening", label: "En veille" },
  { key: "done", label: "Terminé récemment" },
];

// Same rule as the roster: a run "running" for hours is a zombie.
const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

interface Run {
  id: string; status: string; created_at: string; finished_at: string | null;
  mission_id: string | null; conversation_id: string | null; todos: RunTodo[] | null;
  error_message: string | null; triggered_via: string | null;
}

function progressOf(todos: RunTodo[] | null | undefined) {
  const top = (todos ?? []).filter((t) => !t.parent_id);
  if (!top.length) return undefined;
  return { done: top.filter((t) => t.status === "done").length, total: top.length };
}
const activeTodo = (todos: RunTodo[] | null | undefined) => (todos ?? []).find((t) => t.status === "active")?.title;

function relFuture(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (mins <= 1) return "imminente";
  if (mins < 60) return `dans ${mins} min`;
  const h = Math.round(mins / 60);
  return h < 24 ? `dans ${h} h` : `dans ${Math.round(h / 24)} j`;
}

async function fetchTasks(agentId: string): Promise<TaskCard[]> {
  const since = new Date(Date.now() - RECENT_MS).toISOString();
  const [runsQ, missionsQ, linksQ, roomTasksQ, approvalsQ, triggersQ, goalsQ] = await Promise.all([
    supabase.from("internal_agent_runs")
      .select("id, status, created_at, finished_at, mission_id, conversation_id, todos, error_message, triggered_via")
      .eq("agent_id", agentId).is("parent_run_id", null).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(80),
    supabase.from("internal_agent_missions")
      .select("id, title, status, board_column, schedule, next_run_at, pj_issue_id, pj_project_id, created_at, updated_at")
      .eq("agent_id", agentId).neq("status", "archived")
      .order("updated_at", { ascending: false }).limit(60),
    supabase.from("pj_issue_agents").select("issue_id").eq("agent_id", agentId).limit(100),
    supabase.from("service_room_tasks")
      .select("id, mission_id, title, status, run_id, started_at, finished_at, updated_at")
      .eq("agent_id", agentId).order("updated_at", { ascending: false }).limit(40),
    supabase.from("internal_agent_approvals").select("run_id, conversation_id").eq("agent_id", agentId).eq("status", "pending"),
    supabase.from("agent_workflow_triggers").select("mission_id, label, status, last_event_at").eq("agent_id", agentId),
    supabase.from("company_objectives").select("watch_mission_id, title, status, current_value, target_value, unit, measured_at").eq("owner_agent_id", agentId).not("watch_mission_id", "is", null),
  ]);
  if (runsQ.error) throw new Error(runsQ.error.message);
  const runs = (runsQ.data ?? []) as Run[];
  const missions = (missionsQ.data ?? []) as Array<{
    id: string; title: string; status: string; board_column: string | null; schedule: string | null;
    next_run_at: string | null; pj_issue_id: string | null; pj_project_id: string | null; created_at: string; updated_at: string;
  }>;
  const roomTasks = (roomTasksQ.data ?? []) as Array<{
    id: string; mission_id: string; title: string; status: string; run_id: string | null;
    started_at: string | null; finished_at: string | null; updated_at: string;
  }>;
  const waitingRuns = new Set(((approvalsQ.data ?? []) as Array<{ run_id: string | null }>).map((a) => a.run_id).filter(Boolean) as string[]);
  const waitingConvos = new Set(((approvalsQ.data ?? []) as Array<{ conversation_id: string | null }>).map((a) => a.conversation_id).filter(Boolean) as string[]);

  // Names for what the rows only point at.
  const convoIds = [...new Set(runs.map((r) => r.conversation_id).filter(Boolean))] as string[];
  const issueIds = [...new Set([
    ...((linksQ.data ?? []) as Array<{ issue_id: string }>).map((l) => l.issue_id),
    ...missions.map((m) => m.pj_issue_id).filter(Boolean) as string[],
  ])];
  const roomMissionIds = [...new Set(roomTasks.map((t) => t.mission_id))];
  const none = Promise.resolve({ data: [] as unknown[] });
  const [convosQ, issuesQ, roomMissionsQ] = await Promise.all([
    convoIds.length ? supabase.from("internal_agent_conversations").select("id, title").in("id", convoIds) : none,
    issueIds.length ? supabase.from("pj_issues").select("id, name, sequence_id, pj_project_id, state_id, completed_at, archived_at, updated_at").in("id", issueIds) : none,
    roomMissionIds.length ? supabase.from("service_room_missions").select("id, room_id, title").in("id", roomMissionIds) : none,
  ]);
  const convoTitle = new Map(((convosQ.data ?? []) as Array<{ id: string; title: string | null }>).map((c) => [c.id, c.title]));
  const issues = (issuesQ.data ?? []) as Array<{
    id: string; name: string; sequence_id: number; pj_project_id: string; state_id: string | null;
    completed_at: string | null; archived_at: string | null; updated_at: string;
  }>;
  const roomMission = new Map(((roomMissionsQ.data ?? []) as Array<{ id: string; room_id: string; title: string }>).map((m) => [m.id, m]));
  const stateIds = [...new Set(issues.map((i) => i.state_id).filter(Boolean))] as string[];
  const projectIds = [...new Set(issues.map((i) => i.pj_project_id))];
  const [statesQ, projectsQ] = await Promise.all([
    stateIds.length ? supabase.from("pj_states").select("id, name, group").in("id", stateIds) : none,
    projectIds.length ? supabase.from("pj_projects").select("id, identifier").in("id", projectIds) : none,
  ]);
  const stateOf = new Map(((statesQ.data ?? []) as Array<{ id: string; name: string; group: string }>).map((s) => [s.id, s]));
  const identOf = new Map(((projectsQ.data ?? []) as Array<{ id: string; identifier: string }>).map((p) => [p.id, p.identifier]));

  const now = Date.now();
  const isLive = (r: Run) => (r.status === "running" || r.status === "queued") && now - new Date(r.created_at).getTime() < LIVE_WINDOW_MS;
  const cards: TaskCard[] = [];

  // ── Conversations: the latest run of each.
  const seenConvo = new Set<string>();
  for (const r of runs) {
    if (!r.conversation_id || seenConvo.has(r.conversation_id)) continue;
    seenConvo.add(r.conversation_id);
    const title = convoTitle.get(r.conversation_id) || "Conversation";
    const base = { key: `c:${r.conversation_id}`, kind: "conversation" as const, title, at: r.finished_at ?? r.created_at,
      open: { type: "conversation" as const, id: r.conversation_id } };
    if (isLive(r)) {
      cards.push({ ...base, section: waitingConvos.has(r.conversation_id) ? "waiting" : "live",
        status: waitingConvos.has(r.conversation_id) ? { label: "Autorisation demandée", tone: "waiting" } : { label: "En cours", tone: "live" },
        subtitle: activeTodo(r.todos), progress: progressOf(r.todos) });
    } else if (r.status === "awaiting_input") {
      cards.push({ ...base, section: "waiting", status: { label: "Question posée", tone: "waiting" } });
    } else if (now - new Date(base.at).getTime() < 48 * 60 * 60 * 1000) {
      cards.push({ ...base, section: "done",
        status: r.status === "failed" ? { label: "Échec", tone: "failed" } : { label: "Terminée", tone: "done" },
        subtitle: r.status === "failed" ? (r.error_message ?? "").split("\n")[0] : undefined });
    }
  }

  // ── Missions, with their latest run.
  const lastRunOf = new Map<string, Run>();
  for (const r of runs) if (r.mission_id && !lastRunOf.has(r.mission_id)) lastRunOf.set(r.mission_id, r);
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const issueWithMission = new Set<string>();
  // A trigger's mission (0268) is a standing listener, not a one-off task.
  const triggerOf = new Map(((triggersQ.data ?? []) as Array<{ mission_id: string | null; label: string | null; status: string; last_event_at: string | null }>)
    .filter((t) => t.mission_id).map((t) => [t.mission_id!, t]));
  // A goal watch (0269): a scheduled mission whose point is a result to hold.
  const goalOf = new Map(((goalsQ.data ?? []) as Array<{
    watch_mission_id: string; title: string; status: string; current_value: number | null;
    target_value: number | null; unit: string | null; measured_at: string | null;
  }>).map((g) => [g.watch_mission_id, g]));
  for (const m of missions) {
    const run = lastRunOf.get(m.id);
    const goal = goalOf.get(m.id);
    if (goal && !(run && (isLive(run) || run.status === "awaiting_input"))) {
      const unit = goal.unit ? ` ${goal.unit}` : "";
      cards.push({
        key: `m:${m.id}`, kind: "goal", section: "listening", title: goal.title,
        status: goal.measured_at == null ? { label: "Jamais mesuré", tone: "todo" }
          : goal.status === "at_risk" ? { label: "En écart", tone: "waiting" } : { label: "Tenu", tone: "done" },
        subtitle: [
          goal.current_value != null ? `${goal.current_value}${unit} / ${goal.target_value ?? "?"}${unit}` : "",
          m.next_run_at ? `prochaine mesure ${relFuture(m.next_run_at)}` : "",
        ].filter(Boolean).join(" · ") || undefined,
        at: goal.measured_at ?? m.updated_at,
        open: { type: "run", runId: run?.id ?? null, missionId: m.id, live: false },
      });
      continue;
    }
    const issue = m.pj_issue_id ? issueById.get(m.pj_issue_id) : undefined;
    if (issue) issueWithMission.add(issue.id);
    const trig = triggerOf.get(m.id);
    const proposal = m.status === "paused" && m.board_column === "backlog";
    const scheduled = !!m.schedule && m.status === "active";
    const kind: Kind = trig ? "trigger" : issue ? "work_item" : proposal ? "proposal" : scheduled ? "scheduled" : "mission";
    const title = issue ? issue.name : (trig?.label || m.title);
    const issueKey = issue ? `${identOf.get(issue.pj_project_id) ?? "?"}-${issue.sequence_id}` : undefined;
    const open: TaskCard["open"] = issue
      ? { type: "issue", projectId: issue.pj_project_id, issueId: issue.id }
      : proposal ? { type: "inbox" }
      : { type: "run", runId: run?.id ?? null, missionId: m.id, live: !!run && isLive(run) };
    const base = { key: `m:${m.id}`, kind, title, open, at: run?.finished_at ?? run?.created_at ?? m.updated_at };
    if (trig && !(run && (isLive(run) || run.status === "awaiting_input"))) {
      // Between two events it listens: say so, with what the last one gave.
      cards.push({ ...base, section: "listening",
        status: trig.status === "active" ? { label: "À l'écoute", tone: "todo" }
          : trig.status === "error" ? { label: "Erreur", tone: "failed" }
          : { label: trig.status === "paused" ? "En pause" : "En attente", tone: "waiting" },
        subtitle: run
          ? `Dernière réaction : ${run.status === "failed" ? "échec" : "terminée"}`
          : trig.last_event_at ? undefined : "Aucun événement reçu",
        at: trig.last_event_at ?? base.at });
      continue;
    }
    if (run && isLive(run)) {
      cards.push({ ...base, section: waitingRuns.has(run.id) ? "waiting" : "live",
        status: waitingRuns.has(run.id) ? { label: "Autorisation demandée", tone: "waiting" } : { label: "En cours", tone: "live" },
        subtitle: activeTodo(run.todos) ?? issueKey, progress: progressOf(run.todos) });
    } else if (run?.status === "awaiting_input") {
      cards.push({ ...base, section: "waiting", status: { label: "Question posée", tone: "waiting" }, subtitle: issueKey });
    } else if (proposal) {
      cards.push({ ...base, section: "waiting", status: { label: "À lancer", tone: "waiting" }, at: m.created_at });
    } else if (scheduled) {
      cards.push({ ...base, section: "todo",
        status: run?.status === "failed" ? { label: "Dernière en échec", tone: "failed" } : { label: "Planifiée", tone: "todo" },
        subtitle: m.next_run_at ? `Prochaine exécution ${relFuture(m.next_run_at)}` : undefined, at: m.next_run_at ?? base.at });
    } else if (run && (run.status === "succeeded" || run.status === "failed")) {
      if (issue && !issue.completed_at && !issue.archived_at) {
        cards.push({ ...base, section: "todo", status: { label: stateOf.get(issue.state_id ?? "")?.name ?? "À faire", tone: run.status === "failed" ? "failed" : "todo" }, subtitle: issueKey });
      } else if (now - new Date(base.at).getTime() < RECENT_MS) {
        cards.push({ ...base, section: "done",
          status: run.status === "failed" ? { label: "Échec", tone: "failed" } : { label: "Terminée", tone: "done" },
          subtitle: run.status === "failed" ? (run.error_message ?? "").split("\n")[0] : issueKey });
      }
    } else if (m.status === "active" || m.status === "draft") {
      cards.push({ ...base, section: "todo", status: { label: m.status === "draft" ? "Brouillon" : "À faire", tone: "todo" }, subtitle: issueKey });
    }
  }

  // ── Work items handed to it, with no mission yet.
  for (const i of issues) {
    if (issueWithMission.has(i.id) || i.archived_at) continue;
    const st = stateOf.get(i.state_id ?? "");
    const key = `${identOf.get(i.pj_project_id) ?? "?"}-${i.sequence_id}`;
    const open = { type: "issue" as const, projectId: i.pj_project_id, issueId: i.id };
    if (i.completed_at || st?.group === "completed" || st?.group === "cancelled") {
      if (now - new Date(i.completed_at ?? i.updated_at).getTime() < RECENT_MS) {
        cards.push({ key: `i:${i.id}`, kind: "work_item", section: "done", title: i.name, subtitle: key,
          status: { label: st?.name ?? "Terminé", tone: "done" }, at: i.completed_at ?? i.updated_at, open });
      }
    } else {
      cards.push({ key: `i:${i.id}`, kind: "work_item", section: "todo", title: i.name, subtitle: key,
        status: { label: st?.name ?? "À faire", tone: "todo" }, at: i.updated_at, open });
    }
  }

  // ── Room tasks.
  for (const t of roomTasks) {
    const rm = roomMission.get(t.mission_id);
    if (!rm) continue;
    const open = { type: "room" as const, roomId: rm.room_id };
    const base = { key: `t:${t.id}`, kind: "room_task" as const, title: t.title, subtitle: rm.title, open, at: t.finished_at ?? t.started_at ?? t.updated_at };
    if (t.status === "in_progress") cards.push({ ...base, section: "live", status: { label: "En cours", tone: "live" } });
    else if (t.status === "review" || t.status === "waiting" || t.status === "blocked") {
      cards.push({ ...base, section: t.status === "review" ? "waiting" : "todo",
        status: { label: t.status === "review" ? "À relire" : t.status === "blocked" ? "Bloquée" : "En attente", tone: t.status === "blocked" ? "failed" : t.status === "review" ? "waiting" : "todo" } });
    } else if (t.status === "todo") cards.push({ ...base, section: "todo", status: { label: "À faire", tone: "todo" } });
    else if (now - new Date(base.at).getTime() < RECENT_MS) {
      cards.push({ ...base, section: "done", status: t.status === "failed" ? { label: "Échec", tone: "failed" } : { label: t.status === "skipped" ? "Ignorée" : "Terminée", tone: t.status === "failed" ? "failed" : "done" } });
    }
  }

  return cards.sort((a, b) => b.at.localeCompare(a.at));
}

export function AgentTasksPanel({ agentId, agentName, sbase, activeConversationId }: {
  agentId: string;
  agentName: string;
  sbase: string;
  /** The conversation open in the chat next door, highlighted here. */
  activeConversationId: string | null;
}) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<TaskCard | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["agent_tasks", agentId],
    queryFn: () => fetchTasks(agentId),
    // Faster while something runs: the cards are the live view.
    refetchInterval: (q) => ((q.state.data ?? []).some((c) => c.section === "live") ? 5_000 : 20_000),
  });
  const cards = data ?? [];
  const bySection = useMemo(() => {
    const m = new Map<Section, TaskCard[]>();
    for (const c of cards) m.set(c.section, [...(m.get(c.section) ?? []), c]);
    return m;
  }, [cards]);

  function open(c: TaskCard) {
    const o = c.open;
    if (o.type === "conversation") navigate(`${sbase}/agent/${agentId}?c=${o.id}`, { replace: true });
    else if (o.type === "issue") navigate(`${sbase}/projects/${o.projectId}/issues?issue=${o.issueId}`);
    else if (o.type === "room") navigate(`${sbase}/room/${o.roomId}`);
    else if (o.type === "inbox") navigate(`${sbase}/projects/inbox`);
    else setDetail(c);
  }

  if (detail && detail.open.type === "run") {
    // Re-read the card from the live list, so its status keeps moving.
    const current = cards.find((c) => c.key === detail.key) ?? detail;
    return <RunDetail card={current} agentId={agentId} onBack={() => setDetail(null)} />;
  }

  const counts = SECTIONS.map((s) => ({ ...s, n: bySection.get(s.key)?.length ?? 0 }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pb-2 pt-3">
        <div className="text-13 font-medium">Sur quoi {agentName} travaille</div>
        <div className="mt-0.5 text-11 text-muted-foreground">
          {counts.filter((c) => c.key !== "done").map((c) => `${c.n} ${c.label.toLowerCase()}`).join(" · ")}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : error ? (
          <p className="py-8 text-center text-12 text-destructive">{error instanceof Error ? error.message : "Erreur de chargement"}</p>
        ) : !cards.length ? (
          <p className="mt-6 rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-12 text-muted-foreground">
            Rien en cours ni à faire. Confiez-lui une tâche dans le chat, un work item ou une mission planifiée.
          </p>
        ) : (
          SECTIONS.map((s) => {
            const list = (bySection.get(s.key) ?? []).slice(0, s.key === "done" ? 8 : 30);
            if (!list.length) return null;
            return (
              <section key={s.key} className="mt-3">
                <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {s.key === "live" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />}
                  {s.label} <span className="font-normal">{bySection.get(s.key)?.length}</span>
                </h4>
                <ul className="space-y-1.5">
                  {list.map((c) => (
                    <li key={c.key}>
                      <TaskCardView
                        card={c}
                        active={c.open.type === "conversation" && c.open.id === activeConversationId}
                        onClick={() => open(c)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

function TaskCardView({ card, active, onClick }: { card: TaskCard; active: boolean; onClick: () => void }) {
  const k = KIND_META[card.kind];
  const leavesPage = card.open.type === "issue" || card.open.type === "room" || card.open.type === "inbox";
  return (
    <button
      type="button" onClick={onClick}
      className={cn(
        "group w-full rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-muted/40",
        active ? "border-primary/40 ring-1 ring-primary/20" : "border-border/70",
        card.section === "live" && "border-emerald-500/30",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <k.icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{k.label}</span>
        <span className={cn("ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-medium", TONE[card.status.tone])}>
          {card.status.tone === "live" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />}
          {card.status.label}
        </span>
      </div>
      <div className="mt-1 flex items-start gap-1">
        <span className="line-clamp-2 min-w-0 flex-1 text-13 font-medium leading-snug">{card.title}</span>
        {leavesPage && <ArrowSquareOutIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}
      </div>
      {card.progress && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.round((card.progress.done / card.progress.total) * 100)}%` }} />
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{card.progress.done}/{card.progress.total}</span>
        </div>
      )}
      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        {card.subtitle && <span className="min-w-0 flex-1 truncate">{card.subtitle}</span>}
        <span className="ml-auto shrink-0">{formatRelative(card.at)}</span>
      </div>
    </button>
  );
}

/** A mission's latest run, live, without leaving the collaborator's page. */
function RunDetail({ card, agentId, onBack }: { card: TaskCard; agentId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const [starting, setStarting] = useState(false);
  const o = card.open.type === "run" ? card.open : null;

  async function runNow() {
    if (!o) return;
    setStarting(true);
    try {
      const { data: m } = await supabase.from("internal_agent_missions").select("workspace_id, project_id").eq("id", o.missionId).maybeSingle();
      const { data: run, error } = await supabase.from("internal_agent_runs").insert({
        mission_id: o.missionId, agent_id: agentId,
        workspace_id: (m as { workspace_id?: string } | null)?.workspace_id, project_id: (m as { project_id?: string } | null)?.project_id,
        status: "queued", triggered_by: user?.id ?? null,
      }).select("id").single();
      if (error || !run) throw new Error(error?.message ?? "Exécution impossible à créer");
      try { await callEdge("internal-agent-run", { agent_id: agentId, mode: "mission", run_id: run.id }); } catch { /* the scheduler rescues it */ }
      qc.invalidateQueries({ queryKey: ["agent_tasks", agentId] });
      toast.success("Mission lancée");
    } catch (e) {
      toast.error("Lancement impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-2.5">
        <button type="button" onClick={onBack} title="Retour aux tâches" className="mt-0.5 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-13 font-medium leading-snug">{card.title}</div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium", TONE[card.status.tone])}>{card.status.label}</span>
            {card.subtitle && <span className="truncate">{card.subtitle}</span>}
          </div>
        </div>
        {!o?.live && (
          <Button size="sm" variant="outline" className="h-7 shrink-0 text-12" disabled={starting} onClick={() => void runNow()}>
            {starting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <PlayIcon className="mr-1 h-3.5 w-3.5" />} Lancer
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {o?.runId ? (
          <div className="space-y-3">
            <RunTimeline key={o.runId} runId={o.runId} live={o.live} defaultOpen />
            <SubAgentInstances parentRunId={o.runId} />
          </div>
        ) : (
          <p className="py-8 text-center text-12 text-muted-foreground">Cette mission n'a pas encore tourné cette semaine.</p>
        )}
      </div>
    </div>
  );
}
