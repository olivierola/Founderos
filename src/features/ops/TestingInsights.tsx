import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Clock, ChevronRight, Activity } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { RUN_TONE, type RunStatus } from "./TestingPage";

interface RunRow {
  id: string;
  case_id: string;
  status: RunStatus;
  app_url: string;
  current_url: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function useRuns(limit = 200) {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["test_runs_all", projectId, limit],
    enabled: !!projectId,
    refetchInterval: 8000,
    queryFn: async () => {
      const { data } = await supabase
        .from("test_runs")
        .select("id, case_id, status, app_url, current_url, error_message, created_at, started_at, finished_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(limit);
      return (data ?? []) as RunRow[];
    },
  });
}

function durationMs(r: RunRow): number | null {
  if (!r.started_at || !r.finished_at) return null;
  return new Date(r.finished_at).getTime() - new Date(r.started_at).getTime();
}
function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── Analytics: success rate, volume, durations ──────────────────────────────
export function AnalyticsTab() {
  const runs = useRuns();
  const stats = useMemo(() => {
    const all = runs.data ?? [];
    const terminal = all.filter((r) => ["passed", "failed", "error", "cancelled"].includes(r.status));
    const passed = all.filter((r) => r.status === "passed").length;
    const failed = all.filter((r) => ["failed", "error"].includes(r.status)).length;
    const durations = all.map(durationMs).filter((d): d is number => d != null);
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    const rate = terminal.length ? (passed / terminal.length) * 100 : 0;
    return { total: all.length, passed, failed, rate, avg, running: all.filter((r) => !["passed", "failed", "error", "cancelled"].includes(r.status)).length };
  }, [runs.data]);

  if (runs.isLoading) return <EmptyState icon={Activity} title="Loading…" />;
  if ((runs.data ?? []).length === 0) return <EmptyState icon={Activity} title="No runs yet" description="Run a test to see analytics." />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Pass rate" value={`${stats.rate.toFixed(0)}%`} icon={CheckCircle2} hint={`${stats.passed} passed`} />
        <MetricCard label="Failures" value={String(stats.failed)} icon={XCircle} hint="failed or errored" />
        <MetricCard label="Total runs" value={String(stats.total)} icon={Activity} hint={`${stats.running} active`} />
        <MetricCard label="Avg duration" value={fmtDuration(stats.avg)} icon={Clock} hint="start → finish" />
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent outcomes</div>
          <div className="flex flex-wrap gap-1.5">
            {(runs.data ?? []).slice(0, 60).map((r) => {
              const tone = RUN_TONE[r.status];
              return (
                <span
                  key={r.id}
                  title={`${tone.label} · ${new Date(r.created_at).toLocaleString()}`}
                  className={
                    "h-4 w-4 rounded-sm " +
                    (r.status === "passed" ? "bg-emerald-500/70"
                      : ["failed", "error"].includes(r.status) ? "bg-destructive/70"
                      : r.status === "cancelled" ? "bg-muted"
                      : "bg-amber-500/60")
                  }
                />
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Reports: a sortable table of runs, click to open ────────────────────────
export function ReportsTab({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const runs = useRuns();
  if (runs.isLoading) return <EmptyState icon={Clock} title="Loading…" />;
  if ((runs.data ?? []).length === 0) return <EmptyState icon={Clock} title="No runs to report" />;

  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">App</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(runs.data ?? []).map((r) => {
              const tone = RUN_TONE[r.status];
              return (
                <tr key={r.id} className="cursor-pointer hover:bg-secondary/50" onClick={() => onOpenRun(r.id)}>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 max-w-[260px] truncate text-xs text-muted-foreground">{r.current_url ?? r.app_url}</td>
                  <td className="px-4 py-3"><Badge variant={tone.variant}>{tone.label}</Badge></td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmtDuration(durationMs(r))}</td>
                  <td className="px-4 py-3 text-right"><ChevronRight className="inline h-4 w-4 text-muted-foreground" /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ── Observability: detailed step-by-step trace of a run ─────────────────────
interface StepRow {
  id: string; idx: number; actor: string; kind: string; label: string | null;
  payload: Record<string, unknown>; screenshot_url: string | null; created_at: string;
}
export function ObservabilityTab({ runId, onOpenRun }: { runId: string | null; onOpenRun: (id: string) => void }) {
  const { projectId } = useCurrentContext();
  const recent = useRuns(20);

  const steps = useQuery({
    queryKey: ["obs_run_steps", runId],
    enabled: !!runId,
    refetchInterval: 3000,
    queryFn: async () => {
      const { data } = await supabase
        .from("test_run_steps").select("*").eq("run_id", runId!).order("idx", { ascending: true });
      return (data ?? []) as StepRow[];
    },
  });

  if (!runId) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Pick a run to inspect its full trace.</p>
        {(recent.data ?? []).map((r) => {
          const tone = RUN_TONE[r.status];
          return (
            <button key={r.id} onClick={() => onOpenRun(r.id)} className="flex w-full items-center gap-3 rounded-lg border border-border p-2.5 text-left hover:bg-secondary">
              <Badge variant={tone.variant}>{tone.label}</Badge>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{r.app_url}</span>
              <span className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Run trace</div>
      {(steps.data ?? []).length === 0 ? (
        <EmptyState icon={Activity} title="No steps yet" />
      ) : (
        (steps.data ?? []).map((s) => (
          <div key={s.id} className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-mono text-muted-foreground">#{s.idx}</span>
              <span className="font-medium capitalize">{s.kind.replace("_", " ")}</span>
              <span className="rounded bg-secondary px-1.5 text-[10px] uppercase text-muted-foreground">{s.actor}</span>
              <span className="ml-auto text-muted-foreground">{new Date(s.created_at).toLocaleTimeString()}</span>
            </div>
            {s.label && <p className="mt-1 text-sm">{s.label}</p>}
            {s.payload && Object.keys(s.payload).length > 0 && (
              <pre className="mt-2 max-h-32 overflow-auto rounded border border-border bg-background p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                {JSON.stringify(s.payload, null, 2).slice(0, 1500)}
              </pre>
            )}
            {s.screenshot_url && (
              <img src={s.screenshot_url} alt="" className="mt-2 max-h-48 rounded border border-border" />
            )}
          </div>
        ))
      )}
    </div>
  );
}
