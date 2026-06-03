import { useQuery } from "@tanstack/react-query";
import { TrendingUp, DollarSign, Wallet, Users, Activity, AlertCircle } from "lucide-react";
import { MetricCard } from "@/components/MetricCard";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useLatestMetrics, useMetricsHistory } from "@/hooks/useFinance";
import { WidgetLoading, WidgetEmpty, WidgetSection, type ModuleWidgetProps } from "./shared";

function fromCents(cents: number, currency: string) {
  return formatCurrency((cents ?? 0) / 100, (currency ?? "eur").toUpperCase());
}

/* ---------------- Revenue KPIs (each its own widget) ---------------- */

export function FinanceMrrCard({ projectId }: ModuleWidgetProps) {
  const latest = useLatestMetrics(projectId);
  const m = latest.data?.metrics;
  if (latest.isLoading) return <WidgetLoading />;
  if (!m) return <WidgetEmpty message="No metrics snapshot yet." />;
  return <MetricCard label="MRR" value={fromCents(m.mrr_cents, m.currency)} icon={TrendingUp} trend="up" />;
}

export function FinanceArrCard({ projectId }: ModuleWidgetProps) {
  const latest = useLatestMetrics(projectId);
  const m = latest.data?.metrics;
  if (latest.isLoading) return <WidgetLoading />;
  if (!m) return <WidgetEmpty message="No metrics snapshot yet." />;
  return <MetricCard label="ARR" value={fromCents(m.arr_cents, m.currency)} icon={DollarSign} />;
}

export function FinanceArpuCard({ projectId }: ModuleWidgetProps) {
  const latest = useLatestMetrics(projectId);
  const m = latest.data?.metrics;
  if (latest.isLoading) return <WidgetLoading />;
  if (!m) return <WidgetEmpty message="No metrics snapshot yet." />;
  return <MetricCard label="ARPU" value={fromCents(m.arpu_cents, m.currency)} icon={Wallet} />;
}

export function FinanceActiveSubsCard({ projectId }: ModuleWidgetProps) {
  const latest = useLatestMetrics(projectId);
  const m = latest.data?.metrics;
  if (latest.isLoading) return <WidgetLoading />;
  if (!m) return <WidgetEmpty message="No metrics snapshot yet." />;
  return (
    <MetricCard
      label="Active subscriptions"
      value={String(m.active_subscriptions)}
      hint={`${m.paying_subscriptions} paying`}
      icon={Users}
    />
  );
}

export function FinanceTotalRevenueCard({ projectId }: ModuleWidgetProps) {
  const latest = useLatestMetrics(projectId);
  const m = latest.data?.metrics;
  if (latest.isLoading) return <WidgetLoading />;
  if (!m) return <WidgetEmpty message="No metrics snapshot yet." />;
  return <MetricCard label="Total revenue" value={fromCents(m.total_revenue_cents, m.currency)} hint="all time" icon={Activity} />;
}

export function FinanceRevenue30dCard({ projectId }: ModuleWidgetProps) {
  const latest = useLatestMetrics(projectId);
  const m = latest.data?.metrics;
  if (latest.isLoading) return <WidgetLoading />;
  if (!m) return <WidgetEmpty message="No metrics snapshot yet." />;
  return (
    <MetricCard
      label="Last 30 days"
      value={fromCents(m.revenue_last_30d_cents, m.currency)}
      hint={`${m.canceled_last_30d} canceled`}
      icon={Activity}
    />
  );
}

export function FinanceFailedPaymentsCard({ projectId }: ModuleWidgetProps) {
  const latest = useLatestMetrics(projectId);
  const m = latest.data?.metrics;
  if (latest.isLoading) return <WidgetLoading />;
  if (!m) return <WidgetEmpty message="No metrics snapshot yet." />;
  return (
    <MetricCard
      label="Failed payments"
      value={String(m.failed_payments)}
      trend={m.failed_payments > 0 ? "down" : "flat"}
      icon={AlertCircle}
    />
  );
}

/* ---------------- MRR movement chart (from MrrMovement page) ---------------- */

export function FinanceMrrMovementChart({ projectId }: ModuleWidgetProps) {
  const history = useMetricsHistory(projectId, 30);
  if (history.isLoading) return <WidgetLoading />;
  const points = history.data ?? [];
  if (points.length === 0) return <WidgetEmpty message="No snapshots yet." />;
  const max = Math.max(1, ...points.map((p) => p.metrics?.mrr_cents ?? 0));
  return (
    <WidgetSection title={`MRR (last ${points.length} snapshots)`}>
      <div className="flex h-full flex-col">
        <div className="flex flex-1 items-end gap-1">
          {points.map((p) => {
            const v = p.metrics?.mrr_cents ?? 0;
            const h = Math.max(4, Math.round((v / max) * 100));
            return (
              <div
                key={p.snapshot_date}
                className="flex-1"
                title={`${p.snapshot_date} · ${fromCents(v, p.metrics?.currency ?? "eur")}`}
              >
                <div className="rounded-t bg-primary/60 transition-colors hover:bg-primary" style={{ height: `${h}%` }} />
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{points[0]!.snapshot_date}</span>
          <span>{points[points.length - 1]!.snapshot_date}</span>
        </div>
      </div>
    </WidgetSection>
  );
}

/* ---------------- Recent revenue events table (from Revenue page) ---------------- */

export function FinanceRecentRevenueTable({ projectId, refreshKey }: ModuleWidgetProps) {
  const latest = useLatestMetrics(projectId);
  const m = latest.data?.metrics;
  const { data: recent, isLoading } = useQuery({
    queryKey: ["revenue-recent", projectId, refreshKey ?? 0],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("revenue_records")
        .select("*")
        .eq("project_id", projectId!)
        .order("occurred_at", { ascending: false })
        .limit(10);
      return data ?? [];
    },
  });
  if (isLoading) return <WidgetLoading />;
  if (!recent || recent.length === 0) return <WidgetEmpty message="No revenue records yet." />;
  return (
    <WidgetSection title="Recent revenue events">
      <div className="h-full overflow-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="py-2">Date</th>
              <th className="py-2">Type</th>
              <th className="py-2">Customer</th>
              <th className="py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {recent.map((r: any) => (
              <tr key={r.id}>
                <td className="py-2 text-muted-foreground">
                  {r.occurred_at ? new Date(r.occurred_at).toLocaleString() : "—"}
                </td>
                <td className="py-2">
                  <Badge variant={r.type === "refund" ? "destructive" : "secondary"}>{r.type}</Badge>
                </td>
                <td className="py-2 text-xs text-muted-foreground">{r.customer_external_id ?? "—"}</td>
                <td className="py-2 text-right font-medium">{fromCents(r.amount_cents, r.currency ?? m?.currency ?? "eur")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </WidgetSection>
  );
}

/* ---------------- Customers table (from Customers page) ---------------- */

export function FinanceCustomersTable({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data: customers, isLoading } = useQuery({
    queryKey: ["customers", projectId, refreshKey ?? 0],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at_provider", { ascending: false })
        .limit(100);
      return data ?? [];
    },
  });
  if (isLoading) return <WidgetLoading />;
  if (!customers || customers.length === 0) return <WidgetEmpty message="No customers." />;
  return (
    <WidgetSection title="Customers">
      <div className="h-full overflow-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-2 py-2">Email</th>
              <th className="px-2 py-2">Name</th>
              <th className="px-2 py-2">Stripe ID</th>
              <th className="px-2 py-2">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {customers.map((c: any) => (
              <tr key={c.id}>
                <td className="px-2 py-2 font-medium">{c.email ?? "—"}</td>
                <td className="px-2 py-2 text-muted-foreground">{c.name ?? "—"}</td>
                <td className="px-2 py-2 font-mono text-xs text-muted-foreground">{c.external_id}</td>
                <td className="px-2 py-2 text-xs text-muted-foreground">
                  {c.created_at_provider ? new Date(c.created_at_provider).toLocaleDateString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </WidgetSection>
  );
}
