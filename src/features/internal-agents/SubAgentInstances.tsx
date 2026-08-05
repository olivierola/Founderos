import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X, CheckCircle2, XCircle, GitBranchPlus, Boxes } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { RunTimeline } from "./RunTimeline";

interface ChildRun {
  id: string;
  label: string | null;
  status: string;
  action_count: number | null;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

const ACTIVE = ["queued", "running"];

/**
 * Live row of ephemeral sub-agent instance cards spawned by a parent run
 * (spawn_parallel_agents). Each card opens that sub-agent's execution flow in a
 * right-side drawer. Renders nothing until the parent actually fans out, and the
 * cards persist afterwards as the trace of what each sub-agent did.
 */
export function SubAgentInstances({ parentRunId }: { parentRunId: string }) {
  const qc = useQueryClient();
  const [openChild, setOpenChild] = useState<string | null>(null);
  // Unique per mount: the same parentRunId can be rendered by several messages
  // (a run now posts multiple assistant messages), and Supabase throws if two
  // channels share a topic — so give each instance its own channel name.
  const chanId = useRef(Math.random().toString(36).slice(2)).current;

  const { data: children } = useQuery({
    queryKey: ["subagent_runs", parentRunId],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_runs")
        .select("id, label, status, action_count, started_at, finished_at, error_message")
        .eq("parent_run_id", parentRunId)
        .eq("run_kind", "subagent")
        .order("created_at", { ascending: true });
      return (data ?? []) as ChildRun[];
    },
    refetchInterval: (q) =>
      ((q.state.data as ChildRun[] | undefined)?.some((c) => ACTIVE.includes(c.status)) ? 2000 : false),
  });

  const anyActive = (children ?? []).some((c) => ACTIVE.includes(c.status));

  // Realtime: cards appear/scale/finish as child rows are inserted/updated.
  useEffect(() => {
    const ch = supabase
      .channel(`subruns-${parentRunId}-${chanId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "internal_agent_runs", filter: `parent_run_id=eq.${parentRunId}` },
        () => qc.invalidateQueries({ queryKey: ["subagent_runs", parentRunId] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [parentRunId, qc]);

  if (!children || children.length === 0) return null;

  return (
    <div className="my-2 rounded-xl border border-border/60 bg-muted/30 p-2.5">
      <div className="mb-2 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
        <Boxes className="h-3.5 w-3.5" />
        Sous-agents en parallèle
        <span className="rounded bg-secondary/60 px-1.5 py-0.5 tabular-nums">{children.length}</span>
        {anyActive && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {children.map((c) => {
          const active = ACTIVE.includes(c.status);
          const ok = c.status === "succeeded";
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setOpenChild(c.id)}
              title={c.error_message ?? c.label ?? undefined}
              className={cn(
                "group flex w-44 shrink-0 flex-col gap-1 rounded-lg border p-2 text-left transition-all hover:shadow-sm",
                active ? "border-primary/40 bg-card shadow-sm" : ok ? "border-border bg-card/60" : "border-destructive/40 bg-card/60",
                !active && "opacity-80 hover:opacity-100",
              )}
            >
              <div className="flex items-center gap-1.5">
                {active ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                ) : ok ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                )}
                <span className="truncate text-xs font-medium">{c.label || "sous-tâche"}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{active ? "en cours" : ok ? "terminé" : "échec"}</span>
                <span className="tabular-nums">· {c.action_count ?? 0} actions</span>
              </div>
            </button>
          );
        })}
      </div>

      {openChild && <SubAgentFlowDrawer runId={openChild} onClose={() => setOpenChild(null)} />}
    </div>
  );
}

// Right-side drawer ("zone à droite") showing a single sub-agent's live flow.
function SubAgentFlowDrawer({ runId, onClose }: { runId: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-background/50 backdrop-blur-sm animate-in fade-in" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 flex w-[min(480px,92vw)] flex-col border-l border-border bg-background shadow-2xl duration-200 animate-in slide-in-from-right">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="flex items-center gap-2 text-sm font-medium">
            <GitBranchPlus className="h-4 w-4" /> Flow du sous-agent
          </span>
          <button
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Fermer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <RunTimeline runId={runId} live defaultOpen />
        </div>
      </div>
    </div>
  );
}
