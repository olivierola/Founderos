// RunTimeline — live view of ONE agent run, anchored by run id (never "the
// latest run", which made timelines vanish or mix up).
//
// Two states, deliberately different in weight:
//
//   RUNNING — no card, no border, no spinner. One sentence saying what the
//   agent is doing, cross-fading as it changes, over the collapsed tool list:
//
//        Installe les dépendances du dépôt
//        🔧🔧🔧  3 outils utilisés                    ⌄
//
//   FINISHED — the recap unfolds: status line, checklist, success contract,
//   notices, and the same tool list. Still borderless; the run is part of the
//   conversation, not a widget sitting on top of it.
//
// Data: `internal_agent_runs.todos` (structured checklist) + run events keyed
// by event id (naturally deduped). Live via Supabase realtime with a polling
// fallback while the run is active; frozen and collapsible once finished.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircleIcon as CheckCircle2,
  XCircleIcon as XCircle,
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  CircleIcon as Circle,
  CheckCircleIcon as CircleCheck,
  WarningCircleIcon as CircleAlert,
  PlayIcon as Play,
  ChatIcon as MessageSquare,
  BrainIcon as BrainCircuit,
  TreeViewIcon as ListTree,
  ShieldCheckIcon as ShieldCheck,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { toolSummary, toolCategory, toolIntegrationName, orbStateForRun, type RunTodo, type RunEventRow } from "./runEventMeta";
import { AgentActivityOrb } from "./AgentActivityOrb";
import { ToolCallsSection, type ToolCallEntry } from "@/components/ui/tool-calls-section";
import { LiveActivity } from "./LiveActivity";

interface RunRow {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "awaiting_input";
  todos: RunTodo[];
  action_count: number;
  cost_usd: number;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  pending_question: { question?: string; options?: string[] } | null;
}

const ACTIVE_STATUSES = ["queued", "running"];

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// ── Loop engine (see supabase/functions/_shared/agent-loop.ts) ───────────────
// The run's success contract (typed checks derived from the goal), the last
// verification of it, and the controller's last decision.
interface ContractCheck { label: string; kind: string; required: boolean }
interface CheckResultRow {
  label: string; pass: boolean; skipped: boolean;
  required: boolean; deterministic: boolean; detail: string;
}
interface LoopState {
  action: string; reason: string; iteration: number;
  verdict: string | null; stagnant: number; rounds: string;
}

// One executed action = a tool_call paired with its following tool_result.
interface ActionItem {
  id: string;
  tool: string;
  summary: string;
  args: any;
  result?: string;
  ok?: boolean;
  at: string;
  todoId: string | null; // which todo was active when it ran
}

export function RunTimeline({
  runId,
  live = false,
  defaultOpen,
}: {
  runId: string;
  /** Hint that the run is (probably) in flight — enables tighter polling. */
  live?: boolean;
  defaultOpen?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<boolean | null>(defaultOpen ?? null);
  const [now, setNow] = useState(() => Date.now());
  // Unique per mount: the same runId may be shown by several messages (a run
  // posts multiple assistant messages), and Supabase throws if two channels
  // share a topic — so each instance gets its own channel name.
  const chanId = useRef(Math.random().toString(36).slice(2)).current;

  const { data: run } = useQuery({
    queryKey: ["run_row", runId],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_runs")
        .select("id, status, todos, action_count, cost_usd, started_at, finished_at, error_message, pending_question")
        .eq("id", runId)
        .maybeSingle();
      return (data ?? null) as RunRow | null;
    },
    refetchInterval: (q) => (ACTIVE_STATUSES.includes((q.state.data as RunRow | null)?.status ?? (live ? "running" : "x")) ? 2500 : false),
  });

  const isActive = ACTIVE_STATUSES.includes(run?.status ?? (live ? "running" : ""));
  const isOpen = open ?? isActive; // default: open while running, collapsed after

  const { data: events } = useQuery({
    queryKey: ["run_events", runId],
    enabled: isOpen || isActive,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_run_events")
        .select("id, run_id, kind, payload, created_at")
        .eq("run_id", runId)
        .order("created_at", { ascending: true })
        .limit(400);
      return (data ?? []) as RunEventRow[];
    },
    refetchInterval: isActive ? 2500 : false,
  });

  // Realtime: refresh on new events / run updates (polling above is the fallback).
  useEffect(() => {
    if (!isActive) return;
    const ch = supabase
      .channel(`run-${runId}-${chanId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "internal_agent_run_events", filter: `run_id=eq.${runId}` }, () => {
        qc.invalidateQueries({ queryKey: ["run_events", runId] });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "internal_agent_runs", filter: `id=eq.${runId}` }, () => {
        qc.invalidateQueries({ queryKey: ["run_row", runId] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [runId, isActive, qc]);

  // Live elapsed timer.
  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isActive]);

  // Build the action list: pair each tool_call with its result, and attribute
  // it to the todo that was active at that moment (todos snapshots as markers).
  const { actions, notices, contractChecks, checkResults, loopState } = useMemo(() => {
    const evs = events ?? [];
    const acts: ActionItem[] = [];
    const notes: Array<{ id: string; kind: string; text: string; at: string }> = [];
    // Loop engine: the run's success contract, its last verification and the
    // controller's last decision.
    let contract: ContractCheck[] = [];
    let checks: CheckResultRow[] = [];
    let loop: LoopState | null = null;
    let currentTodo: string | null = null;
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      const p = ev.payload ?? {};
      if (ev.kind === "todos") {
        const active = Array.isArray(p.todos) ? p.todos.find((t: RunTodo) => t.status === "active") : null;
        currentTodo = active?.id ?? currentTodo;
      } else if (ev.kind === "tool_call") {
        const tool = String(p.tool ?? p.name ?? "tool");
        // Find the matching result before the next tool_call.
        let result: string | undefined; let ok: boolean | undefined;
        for (let j = i + 1; j < evs.length; j++) {
          if (evs[j].kind === "tool_call") break;
          if (evs[j].kind === "tool_result" && (evs[j].payload?.tool ?? "") === tool) {
            result = String(evs[j].payload?.preview ?? "");
            ok = evs[j].payload?.ok !== false && !result.startsWith("ERROR");
            break;
          }
        }
        acts.push({ id: ev.id, tool, summary: toolSummary(tool, p.args ?? p.arguments ?? {}), args: p.args ?? {}, result, ok, at: ev.created_at, todoId: currentTodo });
      } else if (ev.kind === "error" || ev.kind === "tool_error") {
        notes.push({ id: ev.id, kind: "error", text: String(p.error ?? p.message ?? "error").slice(0, 300), at: ev.created_at });
      } else if (ev.kind === "status") {
        notes.push({ id: ev.id, kind: "status", text: String(p.message ?? "").slice(0, 200), at: ev.created_at });
      } else if (ev.kind === "question") {
        notes.push({ id: ev.id, kind: "question", text: String(p.question ?? "").slice(0, 300), at: ev.created_at });
      } else if (ev.kind === "loop") {
        if (p.phase === "contract") {
          contract = Array.isArray(p.checks) ? (p.checks as ContractCheck[]) : [];
        } else {
          // A controller iteration: keep the latest verdict + decision, and
          // surface anything that isn't "business as usual" as a notice.
          if (Array.isArray(p.checks)) checks = p.checks as CheckResultRow[];
          loop = {
            action: String(p.action ?? "continue"),
            reason: String(p.reason ?? ""),
            iteration: Number(p.iteration ?? 0),
            verdict: p.verdict ? String(p.verdict) : null,
            stagnant: Number(p.signals?.stagnant_ticks ?? 0),
            rounds: String(p.signals?.rounds ?? ""),
          };
          if (p.action && p.action !== "continue") {
            notes.push({ id: ev.id, kind: p.action === "abort" ? "error" : "status", text: String(p.reason ?? p.action), at: ev.created_at });
          }
        }
      }
    }
    return { actions: acts, notices: notes, contractChecks: contract, checkResults: checks, loopState: loop };
  }, [events]);

  const todos: RunTodo[] = Array.isArray(run?.todos) ? (run!.todos as RunTodo[]) : [];
  // Depth-first ordering of the (possibly nested) checklist; items with a
  // dangling/cyclic parent fall back to top level so nothing disappears.
  const orderedTodos = useMemo(() => {
    const ids = new Set(todos.map((t) => t.id));
    const byParent = new Map<string | undefined, RunTodo[]>();
    for (const t of todos) {
      const p = t.parent_id && ids.has(t.parent_id) && t.parent_id !== t.id ? t.parent_id : undefined;
      const arr = byParent.get(p) ?? [];
      arr.push(t);
      byParent.set(p, arr);
    }
    const out: Array<{ t: RunTodo; depth: number }> = [];
    const seen = new Set<string>();
    const walk = (p: string | undefined, depth: number) => {
      for (const t of byParent.get(p) ?? []) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push({ t, depth });
        if (depth < 3) walk(t.id, depth + 1);
      }
    };
    walk(undefined, 0);
    for (const t of todos) if (!seen.has(t.id)) out.push({ t, depth: 0 });
    return out;
  }, [todos]);
  const leafTodos = useMemo(() => {
    const parentIds = new Set(todos.filter((t) => t.parent_id).map((t) => t.parent_id));
    return todos.filter((t) => !parentIds.has(t.id));
  }, [todos]);
  const elapsedMs = run?.started_at
    ? (run.finished_at ? new Date(run.finished_at).getTime() : now) - new Date(run.started_at).getTime()
    : 0;

  const header = (() => {
    switch (run?.status) {
      case "succeeded": return { icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" />, label: "Terminé" };
      case "failed": return { icon: <XCircle className="h-4 w-4 text-destructive" />, label: "Échec" };
      case "cancelled": return { icon: <XCircle className="h-4 w-4 text-muted-foreground" />, label: "Annulé" };
      case "awaiting_input": return { icon: <MessageSquare className="h-4 w-4 text-amber-500" />, label: "Question posée" };
      // Reachable only before the run row loads: the running state renders
      // above, in the borderless live branch.
      default: return { icon: <Circle className="h-4 w-4 text-muted-foreground/50" />, label: "Exécution" };
    }
  })();

  const doneCount = leafTodos.filter((t) => t.status === "done").length;

  // Every executed call, in the shape ToolCallsSection reads. The category is
  // what picks the icon, so an integration call shows its real logo and an
  // internal capability shows its family glyph.
  const toolCalls: ToolCallEntry[] = useMemo(
    () => actions.map((a) => ({
      tool_name: a.tool,
      tool_category: toolCategory(a.tool),
      integration_name: toolIntegrationName(a.tool),
      message: a.summary,
      tool_call_id: a.id,
      inputs: a.args && Object.keys(a.args).length > 0 ? a.args : undefined,
      output: a.result || undefined,
    })),
    [actions],
  );

  // What the agent is doing *right now*. The newest signal wins: a status
  // message the agent wrote about itself beats the mechanical description of
  // its last call, which in turn beats the checklist item it is standing on.
  const activity = (() => {
    const lastNotice = [...notices].reverse().find((n) => n.kind === "status" && n.text.trim());
    const lastAction = actions.length > 0 ? actions[actions.length - 1] : null;
    const activeTodo = todos.find((t) => t.status === "active");
    if (lastNotice && lastAction) {
      return lastNotice.at >= lastAction.at ? lastNotice.text : lastAction.summary;
    }
    return lastNotice?.text || lastAction?.summary || activeTodo?.title || "Démarre…";
  })();

  // The orb animates the *kind* of work behind that sentence.
  const orbState = useMemo(() => {
    const evs = events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      if (["tool_call", "question", "loop", "todos"].includes(evs[i].kind)) return orbStateForRun(run?.status, evs[i]);
    }
    return orbStateForRun(run?.status, null);
  }, [events, run?.status]);

  // While it runs there is no chrome at all — the orb, the sentence and the tools.
  if (isActive) {
    return (
      <div className="text-sm">
        <div className="flex items-center gap-2">
          <AgentActivityOrb state={orbState} />
          <LiveActivity text={activity} className="min-w-0 flex-1" />
        </div>
        <ToolCallsSection
          toolCalls={toolCalls}
          className="-mt-0.5"
          summaryLabel={(n) => `${n} outil${n > 1 ? "s" : ""} utilisé${n > 1 ? "s" : ""}`}
        />
      </div>
    );
  }

  return (
    <div className="text-sm">
      {/* Header */}
      <button onClick={() => setOpen(!isOpen)} className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-muted/30">
        {header.icon}
        <span className="font-semibold">{header.label}</span>
        {elapsedMs > 0 && <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{fmtElapsed(elapsedMs)}</span>}
        {leafTodos.length > 0 && <span className="text-[11px] text-muted-foreground">· {doneCount}/{leafTodos.length} étapes</span>}
        {(run?.action_count ?? 0) > 0 && <span className="text-[11px] text-muted-foreground">· {run!.action_count} actions</span>}
        {(run?.cost_usd ?? 0) > 0 && <span className="text-[11px] font-mono text-muted-foreground">· ${Number(run!.cost_usd).toFixed(4)}</span>}
        <span className="ml-auto text-muted-foreground">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
      </button>

      {isOpen && (
        <div className="mt-1">
          {/* Failure banner */}
          {run?.status === "failed" && run.error_message && (
            <div className="mb-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-[12px] text-destructive">{run.error_message}</div>
          )}
          {/* Pending question */}
          {run?.status === "awaiting_input" && run.pending_question?.question && (
            <div className="mb-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-700 dark:text-amber-300">
              <span className="font-medium">Question : </span>{run.pending_question.question}
              <span className="ml-1 text-muted-foreground">↳ réponds dans le chat pour continuer.</span>
            </div>
          )}

          {/* Todo checklist */}
          {todos.length > 0 && (
            <div className="space-y-1 py-1.5">
              {orderedTodos.map(({ t, depth }) => (
                <div key={t.id} className="flex items-start gap-2" style={depth > 0 ? { marginLeft: depth * 18 } : undefined}>
                  {t.status === "done" ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    : t.status === "active" ? <Play className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/70" />
                    : t.status === "blocked" ? <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                    : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />}
                  <div className="min-w-0 flex-1">
                    <span className={cn(
                      "text-[13px] leading-snug",
                      t.status === "done" && "text-muted-foreground line-through decoration-muted-foreground/40",
                      t.status === "active" && "font-medium text-foreground",
                      t.status === "blocked" && "text-amber-600 dark:text-amber-400",
                      t.status === "pending" && "text-muted-foreground",
                    )}>{t.title}</span>
                    {t.note && <span className="ml-2 text-[11px] text-muted-foreground/70">— {t.note}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Success contract — what this run is verified against before it may
              finish. Grey while pending, then green/red once the loop's verify
              step has run. */}
          {(contractChecks.length > 0 || checkResults.length > 0) && (
            <div className="space-y-1 py-1.5">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className={cn("h-3.5 w-3.5", loopState?.verdict === "pass" ? "text-emerald-500" : loopState?.verdict === "fail" ? "text-amber-500" : "text-muted-foreground/60")} />
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Contrat de réussite</span>
                {loopState?.verdict === "pass" && <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">vérifié</span>}
                {loopState?.verdict === "fail" && <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">écarts à corriger</span>}
                {loopState?.rounds && <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">{loopState.rounds} rounds</span>}
              </div>
              {(checkResults.length > 0
                ? checkResults
                : contractChecks.map((c) => ({ label: c.label, pass: false, skipped: true, required: c.required, deterministic: c.kind !== "judge", detail: "en attente de vérification" }))
              ).map((c, i) => (
                <div key={`${c.label}-${i}`} className="flex items-start gap-2">
                  {checkResults.length === 0 || c.skipped
                    ? <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                    : c.pass
                    ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    : c.required
                    ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    : <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />}
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] leading-snug">{c.label}</span>
                    {c.detail && <span className="ml-2 text-[11px] text-muted-foreground/70">— {c.detail}</span>}
                  </div>
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 rounded px-1 text-[9px] font-semibold uppercase leading-tight",
                      c.deterministic ? "bg-sky-500/15 text-sky-600 dark:text-sky-400" : "bg-violet-500/15 text-violet-600 dark:text-violet-400",
                    )}
                    title={c.deterministic ? "Contrôle déterministe (mesuré, pas jugé)" : "Critère qualitatif évalué par un relecteur IA"}
                  >
                    {c.deterministic ? "auto" : "IA"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* What the agent actually did — same component as the live view, so
              a run reads the same way while it happens and afterwards. */}
          <div className="py-1">
            {actions.length === 0 && notices.length === 0 && (
              <div className="flex items-center gap-2 py-1 text-[12px] text-muted-foreground">
                <BrainCircuit className="h-3.5 w-3.5" /> Aucune action enregistrée.
              </div>
            )}
            <ToolCallsSection
              toolCalls={toolCalls}
              summaryLabel={(n) => `${n} outil${n > 1 ? "s" : ""} utilisé${n > 1 ? "s" : ""}`}
            />
            {/* Trailing notices (status / errors not tied to a call) */}
            {notices.slice(-3).map((n) => (
              <div key={n.id} className={cn(
                "flex items-start gap-1.5 pt-1 text-[11px]",
                n.kind === "error" ? "text-destructive" : n.kind === "question" ? "text-amber-500" : "text-muted-foreground",
              )}>
                <ListTree className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
                <span className="min-w-0 flex-1">{n.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
