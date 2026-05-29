import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Users,
  Heart,
  AlertTriangle,
  TrendingDown,
  Filter,
  Search,
  Loader2,
  LayoutGrid,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface CustomerRow {
  id: string;
  external_id: string;
  email: string | null;
  name: string | null;
  created_at_provider: string | null;
}

interface SubRow {
  customer_external_id: string;
  status: string;
  plan_name: string | null;
  amount_cents: number;
  currency: string;
  canceled_at: string | null;
}

function useCustomers() {
  const { projectId } = useCurrentContext();
  const customers = useQuery({
    queryKey: ["customers_all", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("customers").select("*").eq("project_id", projectId!).limit(1000);
      return (data ?? []) as CustomerRow[];
    },
  });
  const subs = useQuery({
    queryKey: ["subs_all_users", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select("customer_external_id, status, plan_name, amount_cents, currency, canceled_at")
        .eq("project_id", projectId!);
      return (data ?? []) as SubRow[];
    },
  });
  return { customers: customers.data ?? [], subs: subs.data ?? [], loading: customers.isLoading };
}

function subMapByCustomer(subs: SubRow[]) {
  const m = new Map<string, SubRow>();
  subs.forEach((s) => {
    const ex = m.get(s.customer_external_id);
    if (!ex || (s.status === "active" && ex.status !== "active")) m.set(s.customer_external_id, s);
  });
  return m;
}

// --- Segments --------------------------------------------------------------
export function SegmentsPage() {
  const { customers, subs } = useCustomers();
  const map = useMemo(() => subMapByCustomer(subs), [subs]);

  const counts = useMemo(() => {
    const c = { paying: 0, trial: 0, churned: 0, free: 0 };
    customers.forEach((cu) => {
      const s = map.get(cu.external_id);
      if (!s) c.free++;
      else if (s.status === "trialing") c.trial++;
      else if (s.status === "active" || s.status === "past_due") c.paying++;
      else c.churned++;
    });
    return c;
  }, [customers, map]);

  return (
    <div>
      <PageHeader title="Segments" description="Customer segmentation based on Stripe subscription state." />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Paying" value={String(counts.paying)} icon={Heart} trend="up" />
        <MetricCard label="Trial" value={String(counts.trial)} icon={Filter} />
        <MetricCard label="Free / no plan" value={String(counts.free)} icon={Users} />
        <MetricCard label="Churned" value={String(counts.churned)} icon={TrendingDown} trend="down" />
      </div>
    </div>
  );
}

// --- User 360 -------------------------------------------------------------
export function User360Page() {
  const { customers, subs } = useCustomers();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return customers.slice(0, 25);
    const q = query.toLowerCase();
    return customers.filter(
      (c) =>
        (c.email ?? "").toLowerCase().includes(q) ||
        (c.name ?? "").toLowerCase().includes(q) ||
        c.external_id.toLowerCase().includes(q),
    ).slice(0, 25);
  }, [customers, query]);

  const selected = customers.find((c) => c.id === selectedId);
  const userSubs = selected ? subs.filter((s) => s.customer_external_id === selected.external_id) : [];

  return (
    <div>
      <PageHeader title="User 360" description="Single-pane view for any Stripe customer." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardContent className="p-4">
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search email or ID…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
              />
            </div>
            <ul className="max-h-96 space-y-1 overflow-y-auto">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setSelectedId(c.id)}
                    className={`w-full rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                      selectedId === c.id ? "bg-sidebar-accent" : "hover:bg-secondary"
                    }`}
                  >
                    <div className="truncate font-medium">{c.email ?? "—"}</div>
                    <div className="font-mono text-xs text-muted-foreground">{c.external_id}</div>
                  </button>
                </li>
              ))}
              {filtered.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No match.</p>}
            </ul>
          </CardContent>
        </Card>
        <div className="lg:col-span-2">
          {!selected ? (
            <EmptyState icon={Users} title="Pick a user" description="Select a customer on the left." />
          ) : (
            <Card>
              <CardContent className="space-y-4 p-5">
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Customer</div>
                  <div className="mt-1 text-lg font-semibold">{selected.email ?? "—"}</div>
                  <div className="font-mono text-xs text-muted-foreground">{selected.external_id}</div>
                </div>
                <div>
                  <div className="mb-2 text-xs uppercase text-muted-foreground">Subscriptions</div>
                  {userSubs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No subscription on this customer.</p>
                  ) : (
                    <ul className="space-y-2">
                      {userSubs.map((s, i) => (
                        <li key={i} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                          <span>{s.plan_name ?? "—"}</span>
                          <div className="flex items-center gap-2">
                            <Badge variant={s.status === "active" ? "success" : "secondary"}>{s.status}</Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatCurrency((s.amount_cents ?? 0) / 100, (s.currency ?? "eur").toUpperCase())}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// EngagementPage moved to ./Engagement.tsx (real product_events tracker)

// --- Health Scores -------------------------------------------------------
export function HealthScoresPage() {
  const { customers, subs } = useCustomers();
  const map = useMemo(() => subMapByCustomer(subs), [subs]);

  // Naive: paying=80, trial=60, no-sub=20, canceled=10
  const scored = useMemo(() => {
    return customers
      .map((c) => {
        const s = map.get(c.external_id);
        let score = 20;
        if (!s) score = 20;
        else if (s.status === "active") score = 80 + Math.min(20, Math.round((s.amount_cents ?? 0) / 5000));
        else if (s.status === "trialing") score = 55;
        else if (s.status === "past_due") score = 35;
        else score = 10;
        return { ...c, sub: s, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);
  }, [customers, map]);

  return (
    <div>
      <PageHeader
        title="Health Scores"
        description="Customer health score (paying + plan size). Replace with real product signals once PostHog is wired."
        actions={
          <ExportMenu
            rows={scored.map((c) => ({ email: c.email, plan: c.sub?.plan_name, score: c.score }))}
            filename="health-scores"
          />
        }
      />
      {scored.length === 0 ? (
        <EmptyState icon={Heart} title="No customers" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3 text-right">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {scored.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3">{c.email ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{c.sub?.plan_name ?? "—"}</td>
                    <td className="px-4 py-3 text-right">
                      <Badge variant={c.score >= 70 ? "success" : c.score >= 40 ? "warning" : "destructive"}>
                        {c.score}
                      </Badge>
                    </td>
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

// --- Churn Risk ---------------------------------------------------------
export function ChurnRiskPage() {
  const { customers, subs, loading } = useCustomers();
  const map = useMemo(() => subMapByCustomer(subs), [subs]);

  const atRisk = useMemo(() => {
    return customers
      .map((c) => {
        const s = map.get(c.external_id);
        let risk = "low";
        let reason = "";
        if (!s) {
          risk = "medium";
          reason = "No active subscription";
        } else if (s.status === "past_due") {
          risk = "high";
          reason = "Payment past due";
        } else if (s.status === "canceled") {
          risk = "high";
          reason = "Canceled";
        }
        return { ...c, sub: s, risk, reason };
      })
      .filter((c) => c.risk !== "low");
  }, [customers, map]);

  return (
    <div>
      <PageHeader
        title="Churn Risk"
        description="Customers showing signals of imminent churn."
        actions={
          <ExportMenu
            rows={atRisk.map((c) => ({
              email: c.email,
              plan: c.sub?.plan_name,
              reason: c.reason,
              risk: c.risk,
            }))}
            filename="churn-risk"
          />
        }
      />
      {loading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : atRisk.length === 0 ? (
        <EmptyState icon={AlertTriangle} title="No churn risk detected" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3 text-right">Risk</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {atRisk.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3">{c.email ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{c.sub?.plan_name ?? "—"}</td>
                    <td className="px-4 py-3 text-sm">{c.reason}</td>
                    <td className="px-4 py-3 text-right">
                      <Badge variant={c.risk === "high" ? "destructive" : "warning"}>{c.risk}</Badge>
                    </td>
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

// --- Cohorts & LTV ------------------------------------------------------
export function UserCohortsPage() {
  const { customers, subs, loading } = useCustomers();
  const map = useMemo(() => subMapByCustomer(subs), [subs]);
  const { projectId } = useCurrentContext();

  const { data: revenue } = useQuery({
    queryKey: ["revenue_cohort", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("revenue_records")
        .select("customer_external_id, amount_cents")
        .eq("project_id", projectId!);
      return (data ?? []) as { customer_external_id: string | null; amount_cents: number }[];
    },
  });

  const ltvByCustomer = useMemo(() => {
    const m = new Map<string, number>();
    (revenue ?? []).forEach((r) => {
      if (!r.customer_external_id) return;
      m.set(r.customer_external_id, (m.get(r.customer_external_id) ?? 0) + (r.amount_cents ?? 0));
    });
    return m;
  }, [revenue]);

  // Signup cohorts by month: total + still-active retention.
  const cohorts = useMemo(() => {
    const byMonth = new Map<string, { total: number; active: number; revenueCents: number }>();
    customers.forEach((c) => {
      const d = c.created_at_provider;
      if (!d) return;
      const key = d.slice(0, 7); // YYYY-MM
      const entry = byMonth.get(key) ?? { total: 0, active: 0, revenueCents: 0 };
      entry.total++;
      const s = map.get(c.external_id);
      if (s && ["active", "trialing", "past_due"].includes(s.status)) entry.active++;
      entry.revenueCents += ltvByCustomer.get(c.external_id) ?? 0;
      byMonth.set(key, entry);
    });
    return [...byMonth.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, 12)
      .map(([month, v]) => ({ month, ...v, retention: v.total ? (v.active / v.total) * 100 : 0 }));
  }, [customers, map, ltvByCustomer]);

  // LTV distribution buckets (€).
  const ltvBuckets = useMemo(() => {
    const edges = [0, 50, 100, 250, 500, 1000, Infinity];
    const labels = ["0–50", "50–100", "100–250", "250–500", "500–1k", "1k+"];
    const counts = new Array(labels.length).fill(0);
    [...ltvByCustomer.values()].forEach((cents) => {
      const eur = cents / 100;
      for (let i = 0; i < edges.length - 1; i++) {
        if (eur >= edges[i] && eur < edges[i + 1]) { counts[i]++; break; }
      }
    });
    const max = Math.max(1, ...counts);
    return labels.map((label, i) => ({ label, count: counts[i], pct: (counts[i] / max) * 100 }));
  }, [ltvByCustomer]);

  const totalLtv = [...ltvByCustomer.values()].reduce((a, b) => a + b, 0);
  const avgLtv = ltvByCustomer.size ? totalLtv / ltvByCustomer.size : 0;

  return (
    <div>
      <PageHeader
        title="Cohorts & LTV"
        description="Signup cohorts with retention and lifetime-value distribution across paying customers."
        actions={
          <ExportMenu
            rows={cohorts.map((c) => ({
              cohort: c.month,
              customers: c.total,
              still_active: c.active,
              retention_pct: c.retention.toFixed(1),
              revenue_eur: (c.revenueCents / 100).toFixed(2),
            }))}
            filename="cohorts"
          />
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Avg LTV" value={formatCurrency(avgLtv / 100, "EUR")} icon={Heart} />
        <MetricCard label="Total revenue" value={formatCurrency(totalLtv / 100, "EUR")} icon={TrendingDown} />
        <MetricCard label="Paying customers" value={String(ltvByCustomer.size)} icon={Users} />
      </div>

      {loading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : customers.length === 0 ? (
        <EmptyState icon={LayoutGrid} title="No customers" description="Sync your billing provider to populate cohorts." />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Cohort</th>
                    <th className="px-4 py-3 text-right">Customers</th>
                    <th className="px-4 py-3 text-right">Active</th>
                    <th className="px-4 py-3 text-right">Retention</th>
                    <th className="px-4 py-3 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {cohorts.map((c) => (
                    <tr key={c.month}>
                      <td className="px-4 py-3 font-medium">{c.month}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{c.total}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{c.active}</td>
                      <td className="px-4 py-3 text-right">
                        <Badge variant={c.retention >= 60 ? "success" : c.retention >= 30 ? "warning" : "destructive"}>
                          {c.retention.toFixed(0)}%
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(c.revenueCents / 100, "EUR")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <div className="mb-3 text-sm font-medium">LTV distribution (€)</div>
              <div className="space-y-2">
                {ltvBuckets.map((b) => (
                  <div key={b.label}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{b.label}</span>
                      <span className="tabular-nums">{b.count}</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${b.pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// --- Funnels -----------------------------------------------------------
export function FunnelsPage() {
  const { customers, subs } = useCustomers();
  const map = useMemo(() => subMapByCustomer(subs), [subs]);

  const total = customers.length;
  const withSub = customers.filter((c) => map.has(c.external_id)).length;
  const paying = customers.filter((c) => ["active", "past_due"].includes(map.get(c.external_id)?.status ?? "")).length;

  const steps = [
    { label: "Customers", count: total },
    { label: "Has subscription", count: withSub },
    { label: "Paying", count: paying },
  ];

  return (
    <div>
      <PageHeader title="Funnels" description="Conversion funnel from customer → subscription → paying." />
      {total === 0 ? (
        <EmptyState icon={TrendingDown} title="No customers" />
      ) : (
        <Card>
          <CardContent className="space-y-3 p-5">
            {steps.map((s, i) => {
              const pct = total > 0 ? (s.count / total) * 100 : 0;
              return (
                <div key={i}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span>{s.label}</span>
                    <span className="text-muted-foreground">
                      {s.count} · {pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
