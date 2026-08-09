// RunTimeline — Claude-Code-style live view of ONE agent run, anchored by
// run id (never "the latest run", which made timelines vanish or mix up).
//
//   ┌ ⟳ En cours · 2m 14s · 12 actions · $0.0210            [replier] ┐
//   │ ✓ Cloner le dépôt                                                │
//   │ ▶ Installer les dépendances                                      │
//   │ ○ Lancer l'app                                                   │
//   │ ─────────────────────────────────────────────                    │
//   │ ⏺ $ git clone https://github.com/…                               │
//   │   ⎿ Cloning into 'deploy-demo'…                                  │
//   └──────────────────────────────────────────────────────────────────┘
//
// Data: `internal_agent_runs.todos` (structured checklist) + run events keyed
// by event id (naturally deduped). Live via Supabase realtime with a polling
// fallback while the run is active; frozen and collapsible once finished.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, CheckCircle2, XCircle, ChevronDown, ChevronRight, Circle,
  CircleCheck, CircleAlert, Play, MessageSquare, BrainCircuit, ListTree, ShieldCheck,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { toolSummary, toolEnv, type RunTodo, type RunEventRow } from "./runEventMeta";

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

  // Auto-scroll the action stream while live.
  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isActive && streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [events, isActive]);

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
      default: return { icon: <Loader2 className="h-4 w-4 animate-spin text-blue-500" />, label: "En cours" };
    }
  })();

  const doneCount = leafTodos.filter((t) => t.status === "done").length;

  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card text-sm", isActive ? "border-blue-500/30" : "border-border")}>
      {/* Header */}
      <button onClick={() => setOpen(!isOpen)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left hover:bg-muted/30">
        {header.icon}
        <span className="font-semibold">{header.label}</span>
        {elapsedMs > 0 && <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{fmtElapsed(elapsedMs)}</span>}
        {leafTodos.length > 0 && <span className="text-[11px] text-muted-foreground">· {doneCount}/{leafTodos.length} étapes</span>}
        {(run?.action_count ?? 0) > 0 && <span className="text-[11px] text-muted-foreground">· {run!.action_count} actions</span>}
        {(run?.cost_usd ?? 0) > 0 && <span className="text-[11px] font-mono text-muted-foreground">· ${Number(run!.cost_usd).toFixed(4)}</span>}
        <span className="ml-auto text-muted-foreground">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
      </button>

      {isOpen && (
        <div className="border-t border-border/60">
          {/* Failure banner */}
          {run?.status === "failed" && run.error_message && (
            <div className="border-b border-destructive/20 bg-destructive/10 px-3.5 py-2 text-[12px] text-destructive">{run.error_message}</div>
          )}
          {/* Pending question */}
          {run?.status === "awaiting_input" && run.pending_question?.question && (
            <div className="border-b border-amber-500/20 bg-amber-500/10 px-3.5 py-2 text-[12px] text-amber-700 dark:text-amber-300">
              <span className="font-medium">Question : </span>{run.pending_question.question}
              <span className="ml-1 text-muted-foreground">↳ réponds dans le chat pour continuer.</span>
            </div>
          )}

          {/* Todo checklist */}
          {todos.length > 0 && (
            <div className="space-y-1 border-b border-border/60 px-3.5 py-2.5">
              {orderedTodos.map(({ t, depth }) => (
                <div key={t.id} className="flex items-start gap-2" style={depth > 0 ? { marginLeft: depth * 18 } : undefined}>
                  {t.status === "done" ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    : t.status === "active" ? <Play className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500", isActive && "animate-pulse")} />
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
            <div className="space-y-1 border-b border-border/60 px-3.5 py-2.5">
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

          {/* Action stream (Claude-Code-style ⏺ / ⎿ lines) */}
          <div ref={streamRef} className="scrollbar-slim max-h-72 space-y-1 overflow-y-auto px-3.5 py-2.5">
            {actions.length === 0 && notices.length === 0 && (
              <div className="flex items-center gap-2 py-1 text-[12px] text-blue-400">
                <BrainCircuit className="h-3.5 w-3.5" /> {isActive ? "Réflexion — plan en préparation…" : "Aucune action enregistrée."}
              </div>
            )}
            {actions.map((a) => <ActionLine key={a.id} action={a} />)}
            {/* Trailing notices (status / errors not tied to a call) */}
            {notices.slice(-3).map((n) => (
              <div key={n.id} className={cn(
                "flex items-start gap-1.5 text-[11px]",
                n.kind === "error" ? "text-destructive" : n.kind === "question" ? "text-amber-500" : "text-muted-foreground",
              )}>
                <ListTree className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
                <span className="min-w-0 flex-1">{n.text}</span>
              </div>
            ))}
            {isActive && actions.length > 0 && (
              <div className="flex items-center gap-2 pt-0.5 text-[12px] text-blue-400">
                <Loader2 className="h-3 w-3 animate-spin" /> …
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ActionLine({ action }: { action: ActionItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasResult = action.result != null && action.result !== "";
  const failed = action.ok === false;
  const resultLines = (action.result ?? "").split("\n");
  const preview = resultLines.slice(0, 3).join("\n");
  const truncated = resultLines.length > 3 || (action.result ?? "").length > 300;

  return (
    <div className="group">
      <button
        onClick={() => hasResult && setExpanded(!expanded)}
        className={cn("flex w-full items-start gap-1.5 text-left", hasResult && "cursor-pointer")}
      >
        <span className={cn("mt-[3px] text-[10px] leading-none", failed ? "text-destructive" : action.ok ? "text-emerald-500" : "text-blue-400")}>⏺</span>
        {(() => {
          // Hybrid agents namespace tools (runner_* / sandbox_*) — show which world
          // each call ran in. Single-world agents have plain names → no badge.
          const env = toolEnv(action.tool);
          if (!env) return null;
          return (
            <span
              className={cn(
                "mt-[2px] shrink-0 rounded px-1 text-[9px] font-semibold uppercase leading-tight",
                env === "runner"
                  ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
                  : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
              )}
              title={env === "runner" ? "Ran on the runner (real machine)" : "Ran in the sandbox (container)"}
            >
              {env === "runner" ? "RUN" : "SBX"}
            </span>
          );
        })()}
        <span className={cn("min-w-0 flex-1 truncate font-mono text-[12px]", failed ? "text-destructive" : "text-foreground/90")} title={action.summary}>
          {action.summary}
        </span>
      </button>
      {hasResult && (
        <div className="flex items-start gap-1.5 pl-0.5">
          <span className="select-none font-mono text-[10px] text-muted-foreground/50">⎿</span>
          <pre
            onClick={() => setExpanded(!expanded)}
            className={cn(
              "min-w-0 flex-1 cursor-pointer whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed",
              failed ? "text-destructive/80" : "text-muted-foreground",
              expanded ? "max-h-64 overflow-y-auto scrollbar-slim" : "",
            )}
          >{expanded ? (action.result ?? "").slice(0, 6000) : preview}{!expanded && truncated ? " …" : ""}</pre>
        </div>
      )}
    </div>
  );
}
