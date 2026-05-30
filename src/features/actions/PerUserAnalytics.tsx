import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Loader2, User, Activity, CreditCard, Calendar, AlertCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { formatCurrency, cn } from "@/lib/utils";

interface Customer {
  id: string;
  email: string | null;
  name: string | null;
  external_id: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

interface Subscription {
  id: string;
  customer_id: string;
  status: string;
  amount_cents: number;
  billing_interval: string;
  started_at: string;
}

interface ActivityEvent {
  id: string;
  event_type: string;
  title: string;
  created_at: string;
  payload: Record<string, unknown> | null;
}

export function PerUserAnalyticsPage() {
  const { projectId } = useCurrentContext();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: customers, isLoading } = useQuery({
    queryKey: ["per_user_customers", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("id, email, name, external_id, created_at, metadata")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(500);
      return (data ?? []) as Customer[];
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers ?? [];
    return (customers ?? []).filter(
      (c) =>
        c.email?.toLowerCase().includes(q) ||
        c.name?.toLowerCase().includes(q) ||
        c.external_id?.toLowerCase().includes(q),
    );
  }, [customers, search]);

  const selected = filtered.find((c) => c.id === selectedId) ?? filtered[0] ?? null;

  // Fetch subscriptions for the selected user.
  const { data: subs } = useQuery({
    queryKey: ["per_user_subs", selected?.id],
    enabled: !!selected?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select("id, customer_id, status, amount_cents, billing_interval, started_at")
        .eq("project_id", projectId!)
        .eq("customer_id", selected!.id)
        .order("started_at", { ascending: false });
      return (data ?? []) as Subscription[];
    },
  });

  // Fetch recent activity logs tagged with this user (best-effort by email match).
  const { data: activity } = useQuery({
    queryKey: ["per_user_activity", selected?.id, selected?.email],
    enabled: !!selected,
    queryFn: async () => {
      const { data } = await supabase
        .from("activity_logs")
        .select("id, event_type, title, created_at, payload")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(50);
      return ((data ?? []) as ActivityEvent[]).filter((e) => {
        if (!selected?.email) return false;
        const payloadStr = JSON.stringify(e.payload ?? {}).toLowerCase();
        return payloadStr.includes(selected.email.toLowerCase());
      });
    },
  });

  const mrr = useMemo(() => {
    return (subs ?? [])
      .filter((s) => s.status === "active" || s.status === "trialing")
      .reduce(
        (sum, s) => sum + (s.billing_interval === "year" ? Math.round(s.amount_cents / 12) : s.amount_cents),
        0,
      );
  }, [subs]);

  const ltv = useMemo(() => {
    // Rough LTV: sum of payments visible (best-effort with subscriptions only).
    return (subs ?? []).reduce((sum, s) => sum + (s.amount_cents ?? 0), 0);
  }, [subs]);

  return (
    <div>
      <PageHeader
        title="Per-user analytics"
        description="Pick a user to inspect their plan, MRR, activity timeline and lifetime value."
      />

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading users…" />
      ) : (customers ?? []).length === 0 ? (
        <EmptyState
          icon={User}
          title="No users yet"
          description="Connect Stripe / your auth provider to sync customers."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
          {/* User list */}
          <Card className="lg:max-h-[calc(100vh-12rem)] lg:overflow-hidden">
            <CardContent className="flex h-full flex-col gap-2 p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search users…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8"
                />
              </div>
              <div className="flex-1 space-y-0.5 overflow-y-auto pr-1">
                {filtered.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      "flex w-full flex-col items-start rounded-md px-3 py-2 text-left transition-colors",
                      selected?.id === c.id
                        ? "bg-secondary text-foreground"
                        : "text-sidebar-foreground hover:bg-secondary/50",
                    )}
                  >
                    <span className="truncate text-sm font-medium">
                      {c.name || c.email || c.external_id || "Unknown"}
                    </span>
                    {c.email && c.name && (
                      <span className="truncate text-xs text-muted-foreground">{c.email}</span>
                    )}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="px-3 py-4 text-xs text-muted-foreground">No match.</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* User detail */}
          {selected ? (
            <div className="space-y-4">
              <Card>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-xl font-semibold">
                        {selected.name || selected.email || "Unknown user"}
                      </h2>
                      {selected.email && selected.name && (
                        <p className="text-sm text-muted-foreground">{selected.email}</p>
                      )}
                      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" /> Signed up{" "}
                        {new Date(selected.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    {selected.external_id && (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {selected.external_id}
                      </Badge>
                    )}
                  </div>

                  <div className="mt-5 grid grid-cols-3 gap-3">
                    <div className="rounded-md border border-border p-3">
                      <div className="text-xs text-muted-foreground">MRR</div>
                      <div className="mt-1 text-lg font-semibold tabular-nums">
                        {formatCurrency(mrr / 100)}
                      </div>
                    </div>
                    <div className="rounded-md border border-border p-3">
                      <div className="text-xs text-muted-foreground">LTV (so far)</div>
                      <div className="mt-1 text-lg font-semibold tabular-nums">
                        {formatCurrency(ltv / 100)}
                      </div>
                    </div>
                    <div className="rounded-md border border-border p-3">
                      <div className="text-xs text-muted-foreground">Subs</div>
                      <div className="mt-1 text-lg font-semibold tabular-nums">
                        {(subs ?? []).length}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center gap-2">
                    <CreditCard className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Subscriptions</span>
                  </div>
                  {(subs ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No subscription found.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="py-2">Status</th>
                          <th className="py-2">Interval</th>
                          <th className="py-2">Amount</th>
                          <th className="py-2">Started</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {subs!.map((s) => (
                          <tr key={s.id}>
                            <td className="py-2">
                              <Badge variant={s.status === "active" ? "success" : "outline"}>
                                {s.status}
                              </Badge>
                            </td>
                            <td className="py-2">{s.billing_interval}</td>
                            <td className="py-2 tabular-nums">
                              {formatCurrency(s.amount_cents / 100)}
                            </td>
                            <td className="py-2 text-muted-foreground">
                              {new Date(s.started_at).toLocaleDateString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Activity timeline</span>
                  </div>
                  {!activity || activity.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No activity events found for this user.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {activity.map((e) => (
                        <li
                          key={e.id}
                          className="flex items-start gap-2 border-l-2 border-border pl-3 text-sm"
                        >
                          <div className="flex-1">
                            <div className="font-medium">{e.title}</div>
                            <div className="text-xs text-muted-foreground">
                              {e.event_type} · {new Date(e.created_at).toLocaleString()}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : (
            <EmptyState icon={AlertCircle} title="Select a user" description="Pick a user from the list to see their analytics." />
          )}
        </div>
      )}
    </div>
  );
}
