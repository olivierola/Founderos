import { useMemo } from "react";
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
  const history = useMetricsHistory(projectId, 30);

  const projection = useMemo(() => {
    const m = latest.data?.metrics;
    if (!m) return null;
    const mrr = m.mrr_cents / 100;
    const churn = m.churn_rate_30d;
    // Naive linear projection: MRR_(t+1) = MRR_t * (1 - churn) + assumed_new
    // For MVP, just project current MRR forward with churn.
    const months: { label: string; value: number }[] = [];
    let v = mrr;
    for (let i = 1; i <= 12; i++) {
      v = v * (1 - churn);
      months.push({ label: `M+${i}`, value: Math.max(0, v) });
    }
    return {
      currency: m.currency.toUpperCase(),
      currentMrr: mrr,
      mrr12m: months[months.length - 1]!.value,
      annualizedAtCurrent: mrr * 12,
      months,
      churn,
    };
  }, [latest.data]);

  if (!workspaceId || !projectId) return <PageHeader title="Forecasting" />;

  return (
    <div>
      <PageHeader
        title="Forecasting"
        description="Naive 12-month MRR projection assuming current churn and no new acquisition."
      />
      <StripeGate connectorPresent={!!connector.data} workspaceId={workspaceId} projectId={projectId}>
        {!projection ? (
          <EmptyState icon={TrendingUp} title="No metrics yet" description="Sync Stripe to enable forecasting." />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <MetricCard
                label="Current MRR"
                value={formatCurrency(projection.currentMrr, projection.currency)}
                icon={TrendingUp}
              />
              <MetricCard
                label="MRR in 12 months (no growth)"
                value={formatCurrency(projection.mrr12m, projection.currency)}
                hint={`${(projection.churn * 100).toFixed(1)}% monthly churn`}
              />
              <MetricCard
                label="Annualized at current"
                value={formatCurrency(projection.annualizedAtCurrent, projection.currency)}
              />
            </div>

            <Card className="mt-6">
              <CardHeader>
                <CardTitle>12-month MRR projection</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex h-32 items-end gap-1">
                  {projection.months.map((m, i) => {
                    const max = projection.months[0]!.value || 1;
                    const h = Math.max(4, Math.round((m.value / max) * 120));
                    return (
                      <div key={i} className="flex-1" title={`${m.label}: ${formatCurrency(m.value, projection.currency)}`}>
                        <div className="rounded-t bg-primary/60" style={{ height: `${h}px` }} />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Naive projection — does not account for new acquisition. {history.data?.length ?? 0} historical snapshots available.
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </StripeGate>
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
