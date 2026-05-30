import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Briefcase, BarChart3, FileText, Loader2, Download } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { formatCurrency, exportToCsv } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useLatestMetrics, useMetricsHistory, useStripeConnector } from "@/hooks/useFinance";
import { StripeGate } from "./StripeGate";

// --- Cohorts ----------------------------------------------------------------
export function CohortsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const connector = useStripeConnector(projectId);

  const { data: customers } = useQuery({
    queryKey: ["cohorts_customers", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("created_at_provider")
        .eq("project_id", projectId!);
      return data ?? [];
    },
  });

  const cohorts = useMemo(() => {
    const map = new Map<string, number>();
    (customers ?? []).forEach((c: any) => {
      if (!c.created_at_provider) return;
      const m = c.created_at_provider.slice(0, 7); // YYYY-MM
      map.set(m, (map.get(m) ?? 0) + 1);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  }, [customers]);

  if (!workspaceId || !projectId) return <PageHeader title="Cohorts" />;

  return (
    <div>
      <PageHeader title="Cohorts" description="Monthly signup cohorts based on Stripe customer creation date." />
      <StripeGate connectorPresent={!!connector.data} workspaceId={workspaceId} projectId={projectId}>
        {cohorts.length === 0 ? (
          <EmptyState icon={BarChart3} title="No cohort data" description="Sync Stripe to see cohorts." />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Signups by month</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {cohorts.map(([month, count]) => {
                  const max = Math.max(...cohorts.map((c) => c[1]));
                  const pct = (count / max) * 100;
                  return (
                    <div key={month} className="flex items-center gap-3">
                      <span className="w-20 text-xs text-muted-foreground">{month}</span>
                      <div className="flex-1">
                        <div className="h-6 rounded bg-secondary">
                          <div className="h-full rounded bg-primary/70 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <span className="w-12 text-right text-sm font-medium">{count}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </StripeGate>
    </div>
  );
}

// --- Forecasting ------------------------------------------------------------
export function ForecastingPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const connector = useStripeConnector(projectId);
  const latest = useLatestMetrics(projectId);
  const history = useMetricsHistory(projectId, 90);

  // User-tunable assumptions overlaid on top of the historical growth rate.
  const [horizon, setHorizon] = useState(12);
  const [acquisitionOverride, setAcquisitionOverride] = useState<number | null>(null);
  const [churnOverride, setChurnOverride] = useState<number | null>(null);

  // Compute the historical monthly growth rate from snapshots: average of
  // (next/prev - 1) across consecutive monthly samples.
  const observed = useMemo(() => {
    const snaps = (history.data ?? []) as Array<{ snapshot_date: string; metrics: { mrr_cents: number } }>;
    if (!snaps || snaps.length < 2) return null;
    const sorted = [...snaps].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    // Estimate growth between the first and last snapshot, normalised per month.
    const first = sorted[0].metrics.mrr_cents;
    const last = sorted[sorted.length - 1].metrics.mrr_cents;
    const days = Math.max(
      1,
      Math.round(
        (new Date(sorted[sorted.length - 1].snapshot_date).getTime() -
          new Date(sorted[0].snapshot_date).getTime()) /
          86400000,
      ),
    );
    const monthly = first > 0 ? Math.pow(last / first, 30 / days) - 1 : 0;
    return { growthMonthly: monthly, days, points: sorted.length };
  }, [history.data]);

  const scenarios = useMemo(() => {
    const m = latest.data?.metrics;
    if (!m) return null;
    const mrr = m.mrr_cents / 100;
    const churn = churnOverride ?? m.churn_rate_30d ?? 0;
    const acquisitionDelta =
      acquisitionOverride ??
      Math.max(0, (observed?.growthMonthly ?? 0) + churn); // gross growth net of churn
    const buildSeries = (g: number, c: number) => {
      const arr: { label: string; value: number }[] = [];
      let v = mrr;
      for (let i = 1; i <= horizon; i++) {
        v = Math.max(0, v * (1 - c) + v * g); // simple compounding
        arr.push({ label: `M+${i}`, value: v });
      }
      return arr;
    };
    return {
      currency: m.currency.toUpperCase(),
      currentMrr: mrr,
      observedGrowth: observed?.growthMonthly ?? 0,
      churn,
      base: { series: buildSeries(acquisitionDelta, churn), label: "Base" },
      best: { series: buildSeries(acquisitionDelta * 1.5, churn * 0.7), label: "Best" },
      worst: { series: buildSeries(acquisitionDelta * 0.5, churn * 1.3), label: "Worst" },
    };
  }, [latest.data, horizon, acquisitionOverride, churnOverride, observed]);

  if (!workspaceId || !projectId) return <PageHeader title="Forecasting" />;

  return (
    <div>
      <PageHeader
        title="Forecasting"
        description="Project MRR forward using historical growth, churn and tunable scenarios (best / base / worst)."
      />
      <StripeGate connectorPresent={!!connector.data} workspaceId={workspaceId} projectId={projectId}>
        {!scenarios ? (
          <EmptyState icon={TrendingUp} title="No metrics yet" description="Sync Stripe to enable forecasting." />
        ) : (
          <>
            {/* Tuners */}
            <Card className="mb-4">
              <CardContent className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Horizon (months)</label>
                  <input
                    type="number"
                    min={3}
                    max={36}
                    value={horizon}
                    onChange={(e) => setHorizon(Math.max(3, Math.min(36, Number(e.target.value) || 12)))}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Monthly acquisition growth (%) — auto if empty
                  </label>
                  <input
                    type="number"
                    step={0.1}
                    placeholder={`${((observed?.growthMonthly ?? 0) * 100).toFixed(1)} auto`}
                    value={acquisitionOverride != null ? acquisitionOverride * 100 : ""}
                    onChange={(e) =>
                      setAcquisitionOverride(e.target.value === "" ? null : Number(e.target.value) / 100)
                    }
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Monthly churn (%) — auto if empty
                  </label>
                  <input
                    type="number"
                    step={0.1}
                    placeholder={`${(scenarios.churn * 100).toFixed(1)} auto`}
                    value={churnOverride != null ? churnOverride * 100 : ""}
                    onChange={(e) =>
                      setChurnOverride(e.target.value === "" ? null : Number(e.target.value) / 100)
                    }
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Headline metrics */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <MetricCard label="Current MRR" value={formatCurrency(scenarios.currentMrr, scenarios.currency)} icon={TrendingUp} />
              <MetricCard
                label={`MRR at M+${horizon} (base)`}
                value={formatCurrency(scenarios.base.series[horizon - 1].value, scenarios.currency)}
                hint={`${(scenarios.churn * 100).toFixed(1)}% churn`}
              />
              <MetricCard
                label="Observed monthly growth"
                value={`${(scenarios.observedGrowth * 100).toFixed(1)}%`}
                hint={`${observed?.points ?? 0} snapshots`}
              />
            </div>

            {/* Multi-scenario chart */}
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>{horizon}-month MRR projection — 3 scenarios</CardTitle>
              </CardHeader>
              <CardContent>
                <ScenarioChart scenarios={scenarios} currency={scenarios.currency} />
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  <ScenarioLegend color="hsl(var(--accent-2))" label={`Best — ${formatCurrency(scenarios.best.series[horizon - 1].value, scenarios.currency)}`} />
                  <ScenarioLegend color="hsl(var(--primary-soft))" label={`Base — ${formatCurrency(scenarios.base.series[horizon - 1].value, scenarios.currency)}`} />
                  <ScenarioLegend color="hsl(var(--destructive))" label={`Worst — ${formatCurrency(scenarios.worst.series[horizon - 1].value, scenarios.currency)}`} />
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </StripeGate>
    </div>
  );
}

function ScenarioLegend({ color, label }: { color: string; label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function ScenarioChart({
  scenarios,
  currency,
}: {
  scenarios: { best: { series: { value: number }[] }; base: { series: { value: number }[] }; worst: { series: { value: number }[] } };
  currency: string;
}) {
  const all = [...scenarios.best.series, ...scenarios.base.series, ...scenarios.worst.series].map((p) => p.value);
  const max = Math.max(1, ...all);
  return (
    <div className="flex h-40 items-end gap-1">
      {scenarios.base.series.map((_, i) => {
        const h = (v: number) => Math.max(4, Math.round((v / max) * 150));
        const b = scenarios.best.series[i]!.value;
        const ba = scenarios.base.series[i]!.value;
        const w = scenarios.worst.series[i]!.value;
        return (
          <div
            key={i}
            className="relative flex-1"
            title={`M+${i + 1} — best ${formatCurrency(b, currency)} · base ${formatCurrency(ba, currency)} · worst ${formatCurrency(w, currency)}`}
          >
            <div className="absolute bottom-0 w-full rounded-t" style={{ height: h(b), background: "hsl(var(--accent-2) / 0.65)" }} />
            <div className="absolute bottom-0 w-full rounded-t" style={{ height: h(ba), background: "hsl(var(--primary-soft) / 0.85)" }} />
            <div className="absolute bottom-0 w-full rounded-t" style={{ height: h(w), background: "hsl(var(--destructive) / 0.55)" }} />
          </div>
        );
      })}
    </div>
  );
}

// --- Investor Metrics -------------------------------------------------------
export function InvestorMetricsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const connector = useStripeConnector(projectId);
  const latest = useLatestMetrics(projectId);
  const m = latest.data?.metrics;

  // Naive LTV: ARPU / churn (monthly)
  const ltvCents = m && m.churn_rate_30d > 0 ? Math.round(m.arpu_cents / m.churn_rate_30d) : null;

  if (!workspaceId || !projectId) return <PageHeader title="Investor Metrics" />;

  return (
    <div>
      <PageHeader title="Investor Metrics" description="Headline metrics for investor updates." />
      <StripeGate connectorPresent={!!connector.data} workspaceId={workspaceId} projectId={projectId}>
        {!m ? (
          <EmptyState icon={Briefcase} title="No metrics yet" />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard label="MRR" value={formatCurrency(m.mrr_cents / 100, m.currency.toUpperCase())} />
            <MetricCard label="ARR" value={formatCurrency(m.arr_cents / 100, m.currency.toUpperCase())} />
            <MetricCard label="ARPU" value={formatCurrency(m.arpu_cents / 100, m.currency.toUpperCase())} />
            <MetricCard label="Customers" value={String(m.customers)} />
            <MetricCard label="Active subs" value={String(m.active_subscriptions)} />
            <MetricCard
              label="Monthly churn"
              value={`${(m.churn_rate_30d * 100).toFixed(2)}%`}
              trend={m.churn_rate_30d > 0.05 ? "down" : "up"}
            />
            <MetricCard
              label="LTV (est.)"
              value={ltvCents ? formatCurrency(ltvCents / 100, m.currency.toUpperCase()) : "—"}
              hint="ARPU / churn"
            />
            <MetricCard
              label="Total revenue"
              value={formatCurrency(m.total_revenue_cents / 100, m.currency.toUpperCase())}
              hint="all time"
            />
            <MetricCard
              label="Last 30 days"
              value={formatCurrency(m.revenue_last_30d_cents / 100, m.currency.toUpperCase())}
            />
          </div>
        )}
      </StripeGate>
    </div>
  );
}

// --- Reports ----------------------------------------------------------------
export function FinanceReportsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const history = useMetricsHistory(projectId, 90);

  if (!workspaceId || !projectId) return <PageHeader title="Reports" />;

  function exportCsv() {
    const rows = (history.data ?? []).map((row) => ({
      date: row.snapshot_date,
      mrr: (row.metrics.mrr_cents / 100).toFixed(2),
      arr: (row.metrics.arr_cents / 100).toFixed(2),
      currency: row.metrics.currency,
      active_subscriptions: row.metrics.active_subscriptions,
      customers: row.metrics.customers,
      churn_rate_30d: row.metrics.churn_rate_30d,
    }));
    exportToCsv(rows, `finance-report-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        description="Historical daily snapshots of your finance metrics."
        actions={
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={!history.data || history.data.length === 0}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
        }
      />
      {history.isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !history.data || history.data.length === 0 ? (
        <EmptyState icon={FileText} title="No reports yet" description="Snapshots are generated daily after first sync." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3 text-right">MRR</th>
                  <th className="px-4 py-3 text-right">Active subs</th>
                  <th className="px-4 py-3 text-right">Customers</th>
                  <th className="px-4 py-3 text-right">Churn 30d</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[...history.data].reverse().map((row) => (
                  <tr key={row.snapshot_date}>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{row.snapshot_date}</td>
                    <td className="px-4 py-3 text-right font-medium">
                      {formatCurrency(row.metrics.mrr_cents / 100, row.metrics.currency.toUpperCase())}
                    </td>
                    <td className="px-4 py-3 text-right">{row.metrics.active_subscriptions}</td>
                    <td className="px-4 py-3 text-right">{row.metrics.customers}</td>
                    <td className="px-4 py-3 text-right">{(row.metrics.churn_rate_30d * 100).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
