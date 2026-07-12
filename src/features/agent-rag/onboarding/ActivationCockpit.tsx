import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TrendingUp, Timer, Users, Target, FlaskConical, Gauge, Trophy, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useToast } from "@/components/ToastProvider";
import { cn } from "@/lib/utils";

interface GoalOpt { id: string; name: string; activation_event: string | null; holdout_pct: number }
interface RunRow {
  id: string; goal_id: string | null; status: string; current_step_position: number;
  is_holdout: boolean; started_at: string; activated_at: string | null;
  experiment_id: string | null; variant_label: string | null;
}
interface ExpRow {
  id: string; goal_id: string; name: string; hypothesis: string | null; status: string;
  uplift: number | null; started_at: string;
}

function pct(n: number): string { return `${(n * 100).toFixed(0)}%`; }
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} j`;
}

export function ActivationCockpitPage() {
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [goalId, setGoalId] = useState<string>("all");
  const [deciding, setDeciding] = useState<string | null>(null);

  async function decide(exp: ExpRow) {
    setDeciding(exp.id);
    try {
      const res = await callEdge<{ decided?: boolean; reason?: string; winner_label?: string; uplift?: number; error?: string }>(
        "onboarding-engine", { action: "decide", goal_id: exp.goal_id, experiment_id: exp.id },
      );
      if (res.error) toast.error(res.error);
      else if (res.decided) toast.success(`Variant ${res.winner_label} gagne (+${((res.uplift ?? 0) * 100).toFixed(0)} pts)`);
      else if (res.reason === "insufficient_sample") toast.info("Pas encore assez de runs pour décider (min 30/variant).");
      else if (res.reason === "not_significant") toast.info("Écart pas encore significatif (z < 1.96).");
      await queryClient.invalidateQueries({ queryKey: ["onb_cockpit_exp", projectId, goalId] });
      await queryClient.invalidateQueries({ queryKey: ["onb_cockpit_runs", projectId, goalId] });
    } catch (e) {
      toast.error("Échec : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDeciding(null);
    }
  }

  const { data: goals } = useQuery({
    queryKey: ["onb_cockpit_goals", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("onboarding_goals")
        .select("id, name, activation_event, holdout_pct")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as GoalOpt[];
    },
  });

  const { data: runs } = useQuery({
    queryKey: ["onb_cockpit_runs", projectId, goalId],
    enabled: !!projectId,
    queryFn: async () => {
      let q = supabase.from("rag_onboarding_runs")
        .select("id, goal_id, status, current_step_position, is_holdout, started_at, activated_at, experiment_id, variant_label")
        .eq("project_id", projectId!).not("goal_id", "is", null).limit(5000);
      if (goalId !== "all") q = q.eq("goal_id", goalId);
      const { data } = await q;
      return (data ?? []) as RunRow[];
    },
  });

  const { data: experiments } = useQuery({
    queryKey: ["onb_cockpit_exp", projectId, goalId],
    enabled: !!projectId,
    queryFn: async () => {
      let q = supabase.from("onboarding_experiments")
        .select("id, goal_id, name, hypothesis, status, uplift, started_at")
        .eq("project_id", projectId!).order("started_at", { ascending: false });
      if (goalId !== "all") q = q.eq("goal_id", goalId);
      const { data } = await q;
      return (data ?? []) as ExpRow[];
    },
  });

  const stats = useMemo(() => {
    const rs = runs ?? [];
    const treated = rs.filter((r) => !r.is_holdout);
    const holdout = rs.filter((r) => r.is_holdout);
    const rate = (arr: RunRow[]) => (arr.length ? arr.filter((r) => r.activated_at).length / arr.length : 0);
    const treatedRate = rate(treated);
    const holdoutRate = rate(holdout);
    const ttvMs = treated
      .filter((r) => r.activated_at)
      .map((r) => new Date(r.activated_at!).getTime() - new Date(r.started_at).getTime());
    // Funnel: how many runs reached each step index (treated only).
    const maxStep = treated.reduce((m, r) => Math.max(m, r.current_step_position), 0);
    const funnel: { step: number; reached: number }[] = [];
    for (let i = 0; i <= maxStep; i++) {
      funnel.push({ step: i, reached: treated.filter((r) => r.current_step_position >= i).length });
    }
    return {
      total: rs.length,
      treated: treated.length,
      holdout: holdout.length,
      treatedRate,
      holdoutRate,
      uplift: treatedRate - holdoutRate,
      ttv: fmtDuration(median(ttvMs)),
      funnel,
      hasHoldout: holdout.length > 0,
    };
  }, [runs]);

  // Per-experiment variant activation (A vs B) computed from the served runs.
  const variantRates = useMemo(() => {
    const rs = runs ?? [];
    const byExp = new Map<string, Map<string, { total: number; activated: number }>>();
    for (const r of rs) {
      if (!r.experiment_id || !r.variant_label) continue;
      const v = byExp.get(r.experiment_id) ?? new Map();
      const cell = v.get(r.variant_label) ?? { total: 0, activated: 0 };
      cell.total += 1;
      if (r.activated_at) cell.activated += 1;
      v.set(r.variant_label, cell);
      byExp.set(r.experiment_id, v);
    }
    return byExp;
  }, [runs]);

  if (!projectId) return <PageHeader title="Activation" />;

  return (
    <div>
      <PageHeader
        title="Cockpit d'activation"
        description="Taux d'activation, time-to-value et uplift causal (traités vs témoin holdout)."
        actions={
          <Select value={goalId} onValueChange={setGoalId}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous les objectifs</SelectItem>
              {(goals ?? []).map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
            </SelectContent>
          </Select>
        }
      />

      {stats.total === 0 ? (
        <EmptyState
          icon={Gauge}
          title="Pas encore de données d'activation"
          description="Dès que des utilisateurs traversent l'onboarding (widget), les runs apparaissent ici : taux d'activation, TTV et uplift."
        />
      ) : (
        <div className="space-y-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi icon={Users} label="Runs" value={stats.total} hint={`${stats.treated} traités · ${stats.holdout} témoin`} />
            <Kpi icon={Target} label="Taux d'activation" value={pct(stats.treatedRate)} tint="text-emerald-400" />
            <Kpi
              icon={TrendingUp}
              label="Uplift causal"
              value={stats.hasHoldout ? `${stats.uplift >= 0 ? "+" : ""}${pct(stats.uplift)}` : "—"}
              hint={stats.hasHoldout ? `vs ${pct(stats.holdoutRate)} témoin` : "activez un holdout"}
              tint={stats.uplift >= 0 ? "text-emerald-400" : "text-rose-400"}
            />
            <Kpi icon={Timer} label="Time-to-value (méd.)" value={stats.ttv} />
          </div>

          {/* Funnel */}
          <Card>
            <CardContent className="p-5">
              <h2 className="mb-3 text-sm font-semibold">Funnel d'activation</h2>
              {stats.funnel.length <= 1 ? (
                <p className="text-xs text-muted-foreground">Pas assez d'étapes traversées pour tracer le funnel.</p>
              ) : (
                <div className="space-y-1.5">
                  {stats.funnel.map((f) => {
                    const top = stats.funnel[0]!.reached || 1;
                    const w = (f.reached / top) * 100;
                    return (
                      <div key={f.step} className="flex items-center gap-3 text-xs">
                        <span className="w-14 shrink-0 text-muted-foreground">étape {f.step + 1}</span>
                        <div className="h-4 flex-1 overflow-hidden rounded bg-secondary">
                          <div className="h-full rounded bg-[hsl(var(--accent-2))]" style={{ width: `${w}%` }} />
                        </div>
                        <span className="w-16 shrink-0 text-right tabular-nums">{f.reached} · {w.toFixed(0)}%</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Experiments */}
          {(experiments ?? []).length > 0 && (
            <Card>
              <CardContent className="p-5">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><FlaskConical className="h-4 w-4" /> Expériences A/B</h2>
                <ul className="divide-y divide-border text-sm">
                  {(experiments ?? []).map((e) => {
                    const cells = variantRates.get(e.id);
                    const variants = cells
                      ? [...cells.entries()]
                          .map(([label, c]) => ({ label, rate: c.total ? c.activated / c.total : 0, total: c.total }))
                          .sort((a, b) => a.label.localeCompare(b.label))
                      : [];
                    const best = variants.reduce<null | typeof variants[number]>((m, v) => (!m || v.rate > m.rate ? v : m), null);
                    return (
                      <li key={e.id} className="py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium">{e.name}</div>
                            {e.hypothesis && <div className="line-clamp-1 text-xs text-muted-foreground">{e.hypothesis}</div>}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {e.status === "running" && (
                              <Button size="sm" variant="outline" onClick={() => decide(e)} disabled={deciding !== null}>
                                {deciding === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trophy className="h-3.5 w-3.5" />} Décider
                              </Button>
                            )}
                            {e.status === "decided" && e.uplift != null && (
                              <span className="text-xs tabular-nums text-emerald-400">+{pct(e.uplift)}</span>
                            )}
                            <Badge variant={e.status === "decided" ? "success" : "outline"} className="text-[10px]">{e.status}</Badge>
                          </div>
                        </div>
                        {variants.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            {variants.map((v) => (
                              <span
                                key={v.label}
                                className={cn(
                                  "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs tabular-nums",
                                  best && v.label === best.label && v.total > 0
                                    ? "border-emerald-500/40 text-emerald-400"
                                    : "border-border text-muted-foreground",
                                )}
                              >
                                <span className="font-medium">variant {v.label}</span>
                                {pct(v.rate)} <span className="opacity-60">· n={v.total}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function Kpi({ icon: Icon, label, value, hint, tint }: {
  icon: typeof Users; label: string; value: string | number; hint?: string; tint?: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-1.5 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className={cn("font-stat-number text-2xl font-semibold tabular-nums", tint)}>{value}</div>
        {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
