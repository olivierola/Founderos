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
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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

type SegmentField = "status" | "plan" | "mrr" | "ltv" | "created_days";
type SegmentOp = "=" | "!=" | ">" | "<" | ">=" | "<=" | "in";

interface SegmentRule {
  id: string;
  field: SegmentField;
  op: SegmentOp;
  value: string;
}

interface SegmentDef {
  id: string;
  name: string;
  rules: SegmentRule[];
}

const SEG_FIELDS: { value: SegmentField; label: string; ops: SegmentOp[] }[] = [
  { value: "status", label: "Subscription status", ops: ["=", "!="] },
  { value: "plan", label: "Plan name", ops: ["=", "!=", "in"] },
  { value: "mrr", label: "MRR (€)", ops: [">", "<", ">=", "<="] },
  { value: "ltv", label: "LTV (€)", ops: [">", "<", ">=", "<="] },
  { value: "created_days", label: "Signed up (days ago)", ops: [">", "<", ">=", "<="] },
];

const SEG_STORAGE = "founderos.user-segments";

function loadSegments(): SegmentDef[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEG_STORAGE) ?? "null");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveSegments(segs: SegmentDef[]) {
  try {
    localStorage.setItem(SEG_STORAGE, JSON.stringify(segs));
  } catch {
    /* ignore */
  }
}

function ruleMatches(rule: SegmentRule, ctx: { status?: string; plan?: string; mrr: number; ltv: number; createdDays: number }) {
  const left =
    rule.field === "status"
      ? ctx.status ?? ""
      : rule.field === "plan"
        ? ctx.plan ?? ""
        : rule.field === "mrr"
          ? ctx.mrr
          : rule.field === "ltv"
            ? ctx.ltv
            : ctx.createdDays;
  const right: string | number = typeof left === "number" ? Number(rule.value) : rule.value;
  switch (rule.op) {
    case "=": return String(left) === String(right);
    case "!=": return String(left) !== String(right);
    case ">": return Number(left) > Number(right);
    case "<": return Number(left) < Number(right);
    case ">=": return Number(left) >= Number(right);
    case "<=": return Number(left) <= Number(right);
    case "in": return rule.value.split(",").map((s) => s.trim()).includes(String(left));
  }
}

function evaluateSegment(seg: SegmentDef, customers: CustomerRow[], subs: SubRow[]): number {
  const subBy = subMapByCustomer(subs);
  // Sum LTV proxy = sum of past sub amounts per customer.
  const ltvBy = new Map<string, number>();
  subs.forEach((s) => {
    ltvBy.set(s.customer_external_id, (ltvBy.get(s.customer_external_id) ?? 0) + (s.amount_cents ?? 0));
  });
  return customers.filter((c) => {
    const s = subBy.get(c.external_id);
    const monthly = s
      ? Math.round((s.amount_cents ?? 0) / 100)
      : 0;
    const ctx = {
      status: s?.status,
      plan: s?.plan_name ?? undefined,
      mrr: monthly,
      ltv: Math.round((ltvBy.get(c.external_id) ?? 0) / 100),
      createdDays: c.created_at_provider
        ? Math.floor((Date.now() - new Date(c.created_at_provider).getTime()) / 86400000)
        : 9999,
    };
    return seg.rules.every((r) => ruleMatches(r, ctx));
  }).length;
}

export function SegmentsPage() {
  const { customers, subs, loading } = useCustomers();
  const [segments, setSegments] = useState<SegmentDef[]>(() => loadSegments());
  const [editing, setEditing] = useState<SegmentDef | null>(null);

  function persist(next: SegmentDef[]) {
    setSegments(next);
    saveSegments(next);
  }

  function newSegment() {
    setEditing({ id: Math.random().toString(36).slice(2), name: "New segment", rules: [] });
  }
  function save() {
    if (!editing) return;
    const existing = segments.findIndex((s) => s.id === editing.id);
    const next = existing >= 0 ? segments.map((s) => (s.id === editing.id ? editing : s)) : [...segments, editing];
    persist(next);
    setEditing(null);
  }
  function remove(id: string) {
    persist(segments.filter((s) => s.id !== id));
  }

  // Aggregate quick counters as a baseline.
  const subMap = useMemo(() => subMapByCustomer(subs), [subs]);
  const counts = useMemo(() => {
    const c = { paying: 0, trial: 0, churned: 0, free: 0 };
    customers.forEach((cu) => {
      const s = subMap.get(cu.external_id);
      if (!s) c.free++;
      else if (s.status === "trialing") c.trial++;
      else if (s.status === "active" || s.status === "past_due") c.paying++;
      else c.churned++;
    });
    return c;
  }, [customers, subMap]);

  return (
    <div>
      <PageHeader
        title="Segments"
        description="Build dynamic customer segments by composing rules on subscription, plan, MRR, LTV and tenure."
        actions={<Button size="sm" onClick={newSegment}><Plus className="h-4 w-4" /> New segment</Button>}
      />

      {/* Baseline metrics */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Paying" value={String(counts.paying)} icon={Heart} trend="up" />
        <MetricCard label="Trial" value={String(counts.trial)} icon={Filter} />
        <MetricCard label="Free / no plan" value={String(counts.free)} icon={Users} />
        <MetricCard label="Churned" value={String(counts.churned)} icon={TrendingDown} trend="down" />
      </div>

      {/* Saved segments */}
      {loading ? (
        <EmptyState icon={Loader2} title="Loading customers…" />
      ) : segments.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="No segments yet"
          description="Create your first segment to group customers by your own criteria."
          action={<Button onClick={newSegment}><Plus className="h-4 w-4" /> Create segment</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {segments.map((seg) => {
            const size = evaluateSegment(seg, customers, subs);
            const pct = customers.length > 0 ? (size / customers.length) * 100 : 0;
            return (
              <Card key={seg.id}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">{seg.name}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {seg.rules.length} rule{seg.rules.length === 1 ? "" : "s"}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(seg)} title="Edit">
                        <Filter className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(seg.id)} title="Delete">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-end justify-between">
                    <div className="text-2xl font-semibold tabular-nums">{size}</div>
                    <div className="text-xs text-muted-foreground">
                      {pct.toFixed(1)}% of base
                    </div>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-[hsl(var(--primary-soft))]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="space-y-1">
                    {seg.rules.map((r) => (
                      <Badge key={r.id} variant="outline" className="mr-1 font-mono text-[10px]">
                        {r.field} {r.op} {r.value || "?"}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Editor dialog */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-lg">
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold">Segment editor</h3>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Name</label>
                <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Rules (AND)</label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        rules: [
                          ...editing.rules,
                          {
                            id: Math.random().toString(36).slice(2),
                            field: "status",
                            op: "=",
                            value: "active",
                          },
                        ],
                      })
                    }
                  >
                    <Plus className="h-3.5 w-3.5" /> Rule
                  </Button>
                </div>
                {editing.rules.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                    Add at least one rule.
                  </p>
                ) : (
                  editing.rules.map((r) => {
                    const fieldDef = SEG_FIELDS.find((f) => f.value === r.field)!;
                    return (
                      <div key={r.id} className="grid grid-cols-[1fr_70px_1fr_32px] gap-1.5">
                        <select
                          value={r.field}
                          onChange={(e) => {
                            const nextField = e.target.value as SegmentField;
                            const allowedOps = SEG_FIELDS.find((f) => f.value === nextField)!.ops;
                            setEditing({
                              ...editing,
                              rules: editing.rules.map((x) =>
                                x.id === r.id
                                  ? { ...x, field: nextField, op: allowedOps.includes(x.op) ? x.op : allowedOps[0] }
                                  : x,
                              ),
                            });
                          }}
                          className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                        >
                          {SEG_FIELDS.map((f) => (
                            <option key={f.value} value={f.value}>{f.label}</option>
                          ))}
                        </select>
                        <select
                          value={r.op}
                          onChange={(e) =>
                            setEditing({
                              ...editing,
                              rules: editing.rules.map((x) =>
                                x.id === r.id ? { ...x, op: e.target.value as SegmentOp } : x,
                              ),
                            })
                          }
                          className="h-9 rounded-md border border-input bg-background px-1.5 text-xs font-mono"
                        >
                          {fieldDef.ops.map((op) => <option key={op} value={op}>{op}</option>)}
                        </select>
                        <Input
                          value={r.value}
                          onChange={(e) =>
                            setEditing({
                              ...editing,
                              rules: editing.rules.map((x) =>
                                x.id === r.id ? { ...x, value: e.target.value } : x,
                              ),
                            })
                          }
                          placeholder={r.field === "status" ? "active" : r.field === "plan" ? "pro" : "0"}
                          className="h-9 font-mono text-xs"
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setEditing({ ...editing, rules: editing.rules.filter((x) => x.id !== r.id) })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="flex items-center justify-between border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">
                  Matches:{" "}
                  <span className="font-semibold text-foreground">
                    {evaluateSegment(editing, customers, subs)}
                  </span>{" "}
                  / {customers.length}
                </p>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                  <Button size="sm" onClick={save}>Save segment</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
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
