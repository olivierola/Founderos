import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layers, Loader2, TrendingUp, TrendingDown, Users as UsersIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { formatCurrency, formatCompact, cn } from "@/lib/utils";

interface Customer {
  id: string;
  email: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

interface Subscription {
  id: string;
  customer_id: string;
  status: string;
  amount_cents: number;
  billing_interval: string;
  plan_name: string | null;
  started_at: string;
  canceled_at: string | null;
}

type Dimension = "plan" | "billing_interval" | "month" | "status";

const DIMENSIONS: { value: Dimension; label: string }[] = [
  { value: "plan", label: "Plan" },
  { value: "billing_interval", label: "Billing" },
  { value: "month", label: "Signup month" },
  { value: "status", label: "Status" },
];

export function GroupAnalyticsPage() {
  const { projectId } = useCurrentContext();
  const [dimension, setDimension] = useState<Dimension>("plan");

  const { data: customers } = useQuery({
    queryKey: ["group_customers", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("id, email, created_at, metadata")
        .eq("project_id", projectId!);
      return (data ?? []) as Customer[];
    },
  });

  const { data: subs, isLoading } = useQuery({
    queryKey: ["group_subs", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select("id, customer_id, status, amount_cents, billing_interval, plan_name, started_at, canceled_at")
        .eq("project_id", projectId!);
      return (data ?? []) as Subscription[];
    },
  });

  const customerById = useMemo(() => {
    const m = new Map<string, Customer>();
    (customers ?? []).forEach((c) => m.set(c.id, c));
    return m;
  }, [customers]);

  const groups = useMemo(() => {
    if (!subs) return [];
    const map = new Map<string, { name: string; subs: Subscription[]; customers: Set<string> }>();
    subs.forEach((s) => {
      let key = "—";
      if (dimension === "plan") key = s.plan_name ?? "No plan";
      else if (dimension === "billing_interval") key = s.billing_interval ?? "n/a";
      else if (dimension === "status") key = s.status;
      else if (dimension === "month") {
        const c = customerById.get(s.customer_id);
        if (c) key = c.created_at.slice(0, 7);
      }
      const g = map.get(key) ?? { name: key, subs: [], customers: new Set<string>() };
      g.subs.push(s);
      g.customers.add(s.customer_id);
      map.set(key, g);
    });

    return Array.from(map.values())
      .map((g) => {
        const active = g.subs.filter((s) => s.status === "active" || s.status === "trialing");
        const mrr = active.reduce(
          (sum, s) =>
            sum + (s.billing_interval === "year" ? Math.round(s.amount_cents / 12) : s.amount_cents),
          0,
        );
        const churned = g.subs.filter((s) => s.canceled_at).length;
        const churnRate = g.subs.length > 0 ? churned / g.subs.length : 0;
        const arpu = active.length > 0 ? mrr / active.length : 0;
        return {
          name: g.name,
          users: g.customers.size,
          activeSubs: active.length,
          mrr,
          arpu,
          churnRate,
        };
      })
      .sort((a, b) => b.mrr - a.mrr);
  }, [subs, customerById, dimension]);

  const maxMrr = groups.reduce((m, g) => Math.max(m, g.mrr), 0);

  return (
    <div>
      <PageHeader
        title="Group analytics"
        description="Slice your user base by plan, billing interval, signup month or status — compare MRR, ARPU and churn between groups."
        actions={
          <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5 text-xs">
            {DIMENSIONS.map((d) => (
              <button
                key={d.value}
                onClick={() => setDimension(d.value)}
                className={cn(
                  "rounded px-2.5 py-1 transition-colors",
                  dimension === d.value
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
        }
      />

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : groups.length === 0 ? (
        <EmptyState icon={Layers} title="No data" description="Sync subscriptions to compare groups." />
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <Card key={g.name}>
              <CardContent className="space-y-3 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{g.name}</div>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <UsersIcon className="h-3 w-3" /> {formatCompact(g.users)} users
                      </span>
                      <span>{g.activeSubs} active subs</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-semibold tabular-nums">
                      {formatCurrency(g.mrr / 100)}
                    </div>
                    <div className="text-xs text-muted-foreground">MRR</div>
                  </div>
                </div>

                {/* MRR bar */}
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-[hsl(var(--primary-soft))]"
                    style={{ width: `${maxMrr > 0 ? (g.mrr / maxMrr) * 100 : 0}%` }}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 pt-1 text-xs">
                  <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                    <span className="text-muted-foreground">ARPU</span>
                    <span className="font-semibold tabular-nums">{formatCurrency(g.arpu / 100)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                    <span className="text-muted-foreground">Churn</span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 font-semibold tabular-nums",
                        g.churnRate > 0.1
                          ? "text-destructive"
                          : g.churnRate > 0.05
                            ? "text-amber-400"
                            : "text-[hsl(var(--accent-2))]",
                      )}
                    >
                      {g.churnRate > 0.05 ? (
                        <TrendingUp className="h-3 w-3" />
                      ) : (
                        <TrendingDown className="h-3 w-3" />
                      )}
                      {(g.churnRate * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
