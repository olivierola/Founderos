// Agent health over the last 24 h — the alert that was missing.
//
// The run telemetry already existed (hqStats, AI Ops), but nothing SAID when
// things went wrong: 22 sub-agents died "worker timed out, 0 actions" over
// three weeks without anyone noticing. This strip reads the project's runs of
// the last day and speaks up: failure rate, the causes grouped, runs stuck in
// "running" (tomorrow's zombies) and the average cost of a run.
//
// Quiet when healthy (one muted line), amber past WARN_RATE or with stuck
// runs, red past BAD_RATE.
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircleIcon as CheckCircle2,
  WarningIcon as AlertTriangle,
  XCircleIcon as XCircle,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

const WINDOW_H = 24;
const STUCK_MIN = 15;
const WARN_RATE = 0.1;
const BAD_RATE = 0.25;

interface Row {
  status: string;
  error_message: string | null;
  cost_usd: number | null;
  started_at: string | null;
  created_at: string;
}

/** One cause per failure: the first line of the error, trimmed — so twenty
 *  "worker timed out" read as ONE cause × 20, not twenty rows. */
function causeOf(msg: string | null): string {
  const first = (msg ?? "").split("\n")[0].trim();
  if (!first) return "Sans message d'erreur";
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

const fmtUsd = (n: number) => `${n < 0.01 ? n.toFixed(4) : n.toFixed(3)} $`;

export function AgentHealthAlert({ projectId }: { projectId: string | null | undefined }) {
  const { data: rows } = useQuery({
    queryKey: ["agent_health_24h", projectId],
    enabled: !!projectId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - WINDOW_H * 3600_000).toISOString();
      const { data } = await supabase
        .from("internal_agent_runs")
        .select("status, error_message, cost_usd, started_at, created_at")
        .eq("project_id", projectId!)
        .gte("created_at", since)
        .limit(2000);
      return (data ?? []) as Row[];
    },
  });

  if (!rows || rows.length === 0) return null;

  const failed = rows.filter((r) => r.status === "failed");
  const succeeded = rows.filter((r) => r.status === "succeeded").length;
  const ended = failed.length + succeeded;
  const rate = ended ? failed.length / ended : 0;
  const stuckBefore = Date.now() - STUCK_MIN * 60_000;
  const stuck = rows.filter((r) => r.status === "running" && new Date(r.started_at ?? r.created_at).getTime() < stuckBefore).length;
  const finished = rows.filter((r) => r.status === "succeeded" || r.status === "failed");
  const avgCost = finished.length ? finished.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0) / finished.length : 0;

  const causes = [...failed.reduce((m, r) => m.set(causeOf(r.error_message), (m.get(causeOf(r.error_message)) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  const level: "ok" | "warn" | "bad" = rate >= BAD_RATE ? "bad" : rate >= WARN_RATE || stuck > 0 ? "warn" : "ok";
  const pct = `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)} %`;

  if (level === "ok") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border/60 bg-card px-4 py-2.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" weight="fill" /> Agents en bonne santé
        </span>
        <span>{ended} runs terminés en {WINDOW_H} h · {failed.length} échec{failed.length > 1 ? "s" : ""} ({pct})</span>
        <span>· coût moyen {fmtUsd(avgCost)} / run</span>
      </div>
    );
  }

  const bad = level === "bad";
  return (
    <div
      role="alert"
      className={cn(
        "rounded-xl border px-4 py-3",
        bad ? "border-destructive/40 bg-destructive/[0.06]" : "border-amber-500/40 bg-amber-500/[0.06]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className={cn("flex items-center gap-1.5 font-semibold", bad ? "text-destructive" : "text-amber-600 dark:text-amber-400")}>
          {bad ? <XCircle className="h-4 w-4" weight="fill" /> : <AlertTriangle className="h-4 w-4" weight="fill" />}
          {bad ? "Des agents échouent" : "Santé des agents à surveiller"}
        </span>
        <span className="text-xs text-muted-foreground">
          {failed.length} échec{failed.length > 1 ? "s" : ""} sur {ended} runs terminés en {WINDOW_H} h ({pct})
          {stuck > 0 && <> · <strong className="font-medium text-foreground">{stuck} bloqué{stuck > 1 ? "s" : ""}</strong> depuis plus de {STUCK_MIN} min</>}
          {" "}· coût moyen {fmtUsd(avgCost)} / run
        </span>
      </div>
      {causes.length > 0 && (
        <ul className="mt-2 space-y-1">
          {causes.map(([cause, n]) => (
            <li key={cause} className="flex items-baseline gap-2 text-xs">
              <span className="w-8 shrink-0 text-right font-mono tabular-nums text-muted-foreground">×{n}</span>
              <span className="min-w-0 truncate text-foreground/90" title={cause}>{cause}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
