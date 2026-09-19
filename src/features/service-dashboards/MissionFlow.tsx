import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CircleNotchIcon as Loader2,
  TargetIcon as Target,
  CaretDownIcon as ChevronDown,
  FileTextIcon as FileText,
  CheckCircleIcon as CheckCircle2,
  XCircleIcon as XCircle,
  ClockIcon as Clock,
  BrainIcon as Brain,
  WrenchIcon as Wrench,
  PulseIcon as Activity,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import {
  AiRoutingIndicator,
  AiRoutingIndicatorEmpty,
  AiRoutingMatch,
} from "@/components/ui/ai-routing-indicator";
import {
  fetchRoomMissions, fetchMissionTasks, fetchMissionEvents,
  MISSION_STATUS_META,
  type RoomMission, type RoomTask, type MissionEvent, type TaskStatus,
} from "./model";

// Live execution flow of the room's missions.
//
// The kanban answers "where does each card stand"; this answers the two
// questions a kanban cannot: WHY did this task go to this agent, and WHAT is
// that agent producing right now. Both are already recorded — the orchestrator
// writes its decisions to service_room_mission_events, and each dispatched task
// carries a run whose events stream as it works — they were just never surfaced
// where the conversation happens.

type Participant = { id: string; name: string; avatar_url: string | null; accent_color?: string | null };

const TASK_TONE: Record<TaskStatus, string> = {
  todo: "text-muted-foreground",
  in_progress: "text-sky-600 dark:text-sky-400",
  waiting: "text-sky-600/70 dark:text-sky-400/70",
  review: "text-amber-600 dark:text-amber-400",
  blocked: "text-red-600 dark:text-red-400",
  done: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  skipped: "text-muted-foreground",
};
const TASK_LABEL: Record<TaskStatus, string> = {
  todo: "en attente de dispatch", in_progress: "en cours", waiting: "attend une dépendance",
  review: "en revue", blocked: "bloquée", done: "terminée", failed: "échec", skipped: "ignorée",
};

/** Live = the mission is still moving, so everything under it must poll. */
const isLive = (m: RoomMission) => ["planning", "running"].includes(m.status);

export function MissionFlow({ roomId, participants }: { roomId: string; participants: Participant[] }) {
  const { data: missions, isLoading } = useQuery({
    queryKey: ["room_missions", roomId],
    queryFn: () => fetchRoomMissions(roomId),
    refetchInterval: (q) => ((q.state.data as RoomMission[] | undefined)?.some(isLive) ? 4000 : false),
  });

  // Newest first, but a live mission always outranks a finished one — the panel
  // is for watching work happen, not for browsing history.
  const ordered = useMemo(() => {
    const list = [...(missions ?? [])];
    return list.sort((a, b) => Number(isLive(b)) - Number(isLive(a)));
  }, [missions]);

  if (isLoading) {
    return <div className="flex items-center justify-center py-10"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  }
  if (ordered.length === 0) {
    return (
      <div className="px-4 py-6">
        <AiRoutingIndicatorEmpty>
          Aucune mission dans cette room. Demandez à l'assistant un travail qui
          demande plusieurs compétences — le routage et l'exécution s'afficheront ici.
        </AiRoutingIndicatorEmpty>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      {ordered.map((m, i) => (
        <MissionCard key={m.id} mission={m} participants={participants} defaultOpen={i === 0 && isLive(m)} />
      ))}
    </div>
  );
}

function MissionCard({ mission, participants, defaultOpen }: {
  mission: RoomMission; participants: Participant[]; defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const live = isLive(mission);
  const meta = MISSION_STATUS_META[mission.status];

  const { data: tasks } = useQuery({
    queryKey: ["mission_tasks", mission.id],
    enabled: open,
    queryFn: () => fetchMissionTasks(mission.id),
    refetchInterval: live && open ? 4000 : false,
  });
  const { data: events } = useQuery({
    queryKey: ["mission_events", mission.id],
    enabled: open,
    queryFn: () => fetchMissionEvents(mission.id),
    refetchInterval: live && open ? 5000 : false,
  });

  // Resolve every agent named by the mission, including ones the orchestrator
  // created on the fly (they are not room participants yet).
  const agentIds = useMemo(
    () => [...new Set([...(tasks ?? []).map((t) => t.agent_id), mission.orchestrator_agent_id].filter(Boolean))] as string[],
    [tasks, mission.orchestrator_agent_id],
  );
  const { data: extra } = useQuery({
    queryKey: ["flow_agents", agentIds.join(",")],
    enabled: agentIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("id, name, avatar_url, accent_color").in("id", agentIds);
      return (data ?? []) as Participant[];
    },
  });
  const byId = useMemo(() => {
    const m = new Map<string, Participant>();
    for (const a of [...participants, ...(extra ?? [])]) m.set(a.id, a);
    return m;
  }, [participants, extra]);

  const routing = (events ?? []).find((e) => e.kind === "routed");
  const orchestrator = mission.orchestrator_agent_id ? byId.get(mission.orchestrator_agent_id) : undefined;
  const running = (tasks ?? []).filter((t) => t.status === "in_progress");

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left"
      >
        <Target className={cn("mt-0.5 h-4 w-4 shrink-0", live ? "text-foreground/70" : "text-muted-foreground")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{mission.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn("rounded-full px-1.5", meta.tone)}>{meta.label}</span>
            <span>{mission.progress}%</span>
            {running.length > 0 && (
              <span className="inline-flex items-center gap-1 text-emerald-500">
                <Loader2 className="h-3 w-3 animate-spin" />{running.length} en cours
              </span>
            )}
          </span>
        </span>
        <ChevronDown className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border/60 p-3">
          {/* 1 — La décision de routage qui a créé la mission. */}
          <AiRoutingIndicator
            input={mission.objective || mission.title}
            matchedPattern={routing?.message}
            targetAgent={orchestrator ? `${orchestrator.name} → ${(tasks ?? []).length} tâche(s)` : undefined}
            isRouting={mission.status === "planning"}
          />

          {/* 2 — Le routage tâche par tâche : qui a hérité de quoi. */}
          {(tasks ?? []).length > 0 && (
            <section>
              <h4 className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Répartition
              </h4>
              <div className="space-y-1">
                {(tasks ?? []).map((t) => (
                  <AiRoutingMatch
                    key={t.id}
                    pattern={t.agent_id ? byId.get(t.agent_id)?.name ?? "Agent" : "non assignée"}
                    text={t.title}
                  />
                ))}
              </div>
            </section>
          )}

          {/* 3 — Ce que chaque agent produit, en direct. */}
          <section>
            <h4 className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Exécution
            </h4>
            <div className="space-y-1.5">
              {(tasks ?? []).map((t) => (
                <TaskRow key={t.id} task={t} agent={t.agent_id ? byId.get(t.agent_id) : undefined} tasks={tasks ?? []} />
              ))}
              {(tasks ?? []).length === 0 && (
                <p className="px-0.5 text-[11px] text-muted-foreground">Aucune tâche — l'assistant planifie encore.</p>
              )}
            </div>
          </section>

          {/* 4 — Le journal de l'orchestrateur, le plus récent en premier. */}
          {(events ?? []).length > 0 && <EventLog events={events ?? []} byId={byId} />}
        </div>
      )}
    </div>
  );
}

/** One task: its state, its agent, what it is waiting on, and — once it has a
 *  run — the live step feed of that run. */
function TaskRow({ task, agent, tasks }: { task: RoomTask; agent?: Participant; tasks: RoomTask[] }) {
  const [open, setOpen] = useState(false);
  const active = task.status === "in_progress";
  const blockers = task.depends_on
    .map((d) => tasks.find((x) => x.id === d))
    .filter((d): d is RoomTask => Boolean(d) && !["done", "skipped"].includes(d!.status));

  return (
    <div className="rounded-lg border border-border/50 bg-background/60">
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
      >
        <span className="mt-0.5 shrink-0">
          {active ? <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" />
            : task.status === "done" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            : task.status === "failed" ? <XCircle className="h-3.5 w-3.5 text-red-500" />
            : <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{task.title}</span>
          <span className="mt-0.5 flex items-center gap-1.5">
            {agent && <AgentIdentity url={agent.avatar_url} seed={agent.name} size={14} rounded="rounded-full" />}
            <span className={cn("truncate text-[10px]", TASK_TONE[task.status])}>
              {agent?.name ?? "non assignée"} · {TASK_LABEL[task.status]}
            </span>
          </span>
          {blockers.length > 0 && (
            <span className="mt-0.5 block truncate text-[10px] text-amber-600 dark:text-amber-400">
              attend : {blockers.map((b) => b.title).join(", ")}
            </span>
          )}
        </span>
        <ChevronDown className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-2 border-t border-border/50 px-2.5 py-2">
          {task.description && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Consigne</p>
              <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">{task.description}</p>
            </div>
          )}
          {task.run_id && <RunFeed runId={task.run_id} live={active} />}
          {task.result_summary && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Résultat</p>
              <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">{task.result_summary}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The live step feed of one task's run — what the agent is thinking, calling and
 * producing, right now. Deliberately the LAST few events only: this is a
 * side panel, not the full timeline (that lives in the mission's Exécution tab).
 */
function RunFeed({ runId, live }: { runId: string; live: boolean }) {
  const { data: events } = useQuery({
    queryKey: ["flow_run_events", runId],
    refetchInterval: live ? 2500 : false,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_run_events")
        .select("id, kind, payload, created_at")
        .eq("run_id", runId)
        .in("kind", ["status", "tool_call", "tool_result", "plan", "error"])
        .order("created_at", { ascending: false }).limit(8);
      return (data ?? []) as Array<{ id: string; kind: string; payload: Record<string, unknown>; created_at: string }>;
    },
  });
  const { data: deliverables } = useQuery({
    queryKey: ["flow_run_deliverables", runId],
    refetchInterval: live ? 4000 : false,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_deliverables")
        .select("id, name, kind").eq("run_id", runId).order("created_at", { ascending: false }).limit(5);
      return (data ?? []) as Array<{ id: string; name: string; kind: string }>;
    },
  });

  const rows = (events ?? []).slice().reverse();
  if (rows.length === 0 && (deliverables ?? []).length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {live ? "En direct" : "Dernières étapes"}
      </p>
      <ol className="space-y-1">
        {rows.map((e) => {
          const p = e.payload ?? {};
          const tool = String(p.tool ?? p.name ?? "");
          const text = String(p.message ?? p.preview ?? p.error ?? tool ?? e.kind);
          const Icon = e.kind === "tool_call" || e.kind === "tool_result" ? Wrench
            : e.kind === "error" ? XCircle
            : e.kind === "plan" ? Brain : Activity;
          return (
            <li key={e.id} className="flex items-start gap-1.5">
              <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", e.kind === "error" ? "text-red-500" : "text-muted-foreground/70")} />
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {tool && <code className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px]">{tool}</code>}
                {text.slice(0, 120)}
              </span>
            </li>
          );
        })}
      </ol>
      {(deliverables ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {(deliverables ?? []).map((d) => (
            <span key={d.id} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px]">
              <FileText className="h-3 w-3 text-primary" /> {d.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function EventLog({ events, byId }: { events: MissionEvent[]; byId: Map<string, Participant> }) {
  const recent = events.slice(-12).reverse();
  return (
    <section>
      <h4 className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Décisions de l'orchestrateur
      </h4>
      <ol className="space-y-1">
        {recent.map((e) => (
          <li key={e.id} className="flex items-start gap-1.5 px-0.5">
            <span className={cn(
              "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
              e.kind === "failed" ? "bg-red-500"
                : e.kind === "completed" || e.kind === "finished" ? "bg-emerald-500"
                : e.kind === "dispatched" ? "bg-sky-500" : "bg-muted-foreground/50",
            )} />
            <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
              {e.message}
              {e.agent_id && byId.get(e.agent_id) && (
                <span className="text-muted-foreground/70"> — {byId.get(e.agent_id)!.name}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
