import { useQuery } from "@tanstack/react-query";
import { DollarSign, TrendingUp, Users, AlertCircle, Wallet, Activity } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useLatestMetrics, useStripeConnector } from "@/hooks/useFinance";
import { StripeGate } from "./StripeGate";

function fromCents(cents: number, currency: string) {
  return formatCurrency(cents / 100, currency.toUpperCase());
}

export function RevenuePage() {
  const { workspaceId, projectId } = useCurrentContext();

  const connector = useStripeConnector(projectId);
  const latest = useLatestMetrics(projectId);
  const m = latest.data?.metrics;

  const { data: recent } = useQuery({
    queryKey: ["revenue-recent", projectId],
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

  if (!workspaceId || !projectId) {
    return (
      <div>
        <PageHeader title="Revenue" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Revenue" description="MRR, ARR, ARPU and revenue movement from Stripe." />
      <StripeGate connectorPresent={!!connector.data} workspaceId={workspaceId} projectId={projectId}>
        {!m ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              No metrics snapshot yet. Click <strong className="text-foreground">Sync from Stripe</strong> above to
              fetch your data.
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="MRR" value={fromCents(m.mrr_cents, m.currency)} icon={TrendingUp} trend="up" />
              <MetricCard label="ARR" value={fromCents(m.arr_cents, m.currency)} icon={DollarSign} />
              <MetricCard label="ARPU" value={fromCents(m.arpu_cents, m.currency)} icon={Wallet} />
              <MetricCard
                label="Active subscriptions"
                value={String(m.active_subscriptions)}
                hint={`${m.paying_subscriptions} paying`}
                icon={Users}
              />
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <MetricCard
                label="Total revenue"
                value={fromCents(m.total_revenue_cents, m.currency)}
                hint="all time"
                icon={Activity}
              />
              <MetricCard
                label="Last 30 days"
                value={fromCents(m.revenue_last_30d_cents, m.currency)}
                hint={`${m.canceled_last_30d} canceled`}
                icon={Activity}
              />
              <MetricCard
                label="Failed payments"
                value={String(m.failed_payments)}
                trend={m.failed_payments > 0 ? "down" : "flat"}
                icon={AlertCircle}
              />
            </div>

            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Recent revenue events</CardTitle>
              </CardHeader>
              <CardContent>
                {!recent || recent.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No revenue records yet.</p>
                ) : (
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
                          <td className="py-2 text-right font-medium">
                            {fromCents(r.amount_cents, r.currency ?? m.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </StripeGate>
    </div>
  );
}
