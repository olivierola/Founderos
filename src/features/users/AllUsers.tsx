import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Loader2, RefreshCw, MoreVertical, KeyRound, Database, CreditCard, Search, XCircle, RefreshCcw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { formatCurrency } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useCapabilities, providerLabel } from "@/hooks/useConnectors";
import { AdminActionModal, type AdminActionConfig } from "@/features/actions/AdminActionModal";

const RESET_PASSWORD_ACTION: AdminActionConfig = {
  action_type: "user.reset_password",
  title: "Send password reset",
  description: "Send a password reset email to this user.",
  risk: "low",
  fields: [{ key: "email", label: "Email", placeholder: "user@example.com" }],
};

function cancelSubConfig(provider: string): AdminActionConfig {
  return {
    action_type: `${provider}.cancel_subscription`,
    title: "Cancel this subscription",
    description: `Cancels the subscription in ${providerLabel(provider)}.`,
    risk: "high",
    typeToConfirm: "CANCEL",
    fields: [{ key: "subscription_id", label: "Subscription ID" }],
  };
}

function refundConfig(provider: string): AdminActionConfig | null {
  if (provider === "stripe") {
    return {
      action_type: "stripe.refund_invoice",
      title: "Refund latest invoice",
      description: "Refund the full amount of the latest charge on the invoice.",
      risk: "high",
      typeToConfirm: "REFUND",
      fields: [{ key: "invoice_id", label: "Invoice ID" }],
    };
  }
  if (provider === "lemonsqueezy") {
    return {
      action_type: "lemonsqueezy.refund_order",
      title: "Refund order",
      description: "Refund the Lemon Squeezy order.",
      risk: "high",
      typeToConfirm: "REFUND",
      fields: [{ key: "order_id", label: "Order ID" }],
    };
  }
  return null;
}

type Segment = "all" | "new_30d" | "churned" | "top_spenders";

type UserType = "signup" | "paying" | "both";
type FilterValue = "all" | "signup" | "paying" | "both" | "free";

interface MergedUser {
  key: string;
  email: string | null;
  name: string | null;
  plan: string | null;
  subStatus: string | null;
  subExternalId: string | null;
  customerExternalId: string | null;
  ltvCents: number;
  hasAuth: boolean;
  hasPaid: boolean;
  billingProvider: string | null;
  authProvider: string | null;
  joined: string | null;
}

export function AllUsersPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { users: usersConnector, billing } = useCapabilities(projectId);
  const queryClient = useQueryClient();
  const [activeAction, setActiveAction] = useState<AdminActionConfig | null>(null);
  const [initialValues, setInitialValues] = useState<Record<string, string | number>>({});
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [segment, setSegment] = useState<Segment>("all");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<MergedUser | null>(null);

  const billingProvider = billing?.provider ?? "stripe";

  const authProvider = usersConnector?.provider ?? null;
  const hasAuthSource = authProvider === "supabase";

  async function handleSync() {
    if (!workspaceId || !projectId) return;
    setSyncing(true);
    try {
      await callEdge("sync-stripe-data", { workspace_id: workspaceId, project_id: projectId });
      queryClient.invalidateQueries({ queryKey: ["customers", projectId] });
    } finally {
      setSyncing(false);
    }
  }

  const { data: authUsers } = useQuery({
    queryKey: ["auth_users_all", projectId],
    enabled: !!projectId && hasAuthSource,
    queryFn: async () => {
      try {
        const res = await callEdge<{ users: any[] }>("db-admin", {
          workspace_id: workspaceId,
          project_id: projectId,
          op: "list_users",
        });
        return res.users ?? [];
      } catch {
        return [];
      }
    },
  });

  const { data: customers, isLoading } = useQuery({
    queryKey: ["customers", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("id, external_id, email, name, created_at_provider, provider")
        .eq("project_id", projectId!)
        .order("created_at_provider", { ascending: false })
        .limit(500);
      return data ?? [];
    },
  });

  const { data: subs } = useQuery({
    queryKey: ["subscriptions_all", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select("external_id, customer_external_id, status, plan_name")
        .eq("project_id", projectId!);
      return (data ?? []) as {
        external_id: string;
        customer_external_id: string;
        status: string;
        plan_name: string | null;
      }[];
    },
  });

  // Revenue per customer → lifetime value
  const { data: revenue } = useQuery({
    queryKey: ["revenue_by_customer", projectId],
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

  // Recent product events for the user shown in the detail drawer.
  const { data: detailEvents, isLoading: detailEventsLoading } = useQuery({
    queryKey: ["user_events", projectId, detail?.email, detail?.customerExternalId],
    enabled: !!projectId && !!detail,
    queryFn: async () => {
      let q = supabase
        .from("product_events")
        .select("event_name, occurred_at, user_email, customer_external_id")
        .eq("project_id", projectId!)
        .order("occurred_at", { ascending: false })
        .limit(20);
      if (detail?.email) q = q.eq("user_email", detail.email);
      else if (detail?.customerExternalId) q = q.eq("customer_external_id", detail.customerExternalId);
      const { data } = await q;
      return (data ?? []) as { event_name: string; occurred_at: string; user_email: string | null; customer_external_id: string | null }[];
    },
  });

  const subByCustomer = useMemo(() => {
    const m = new Map<string, { external_id: string; status: string; plan_name: string | null }>();
    (subs ?? []).forEach((s) => {
      const ex = m.get(s.customer_external_id);
      if (!ex || (s.status === "active" && ex.status !== "active")) m.set(s.customer_external_id, s);
    });
    return m;
  }, [subs]);

  // Merge auth users + billing customers, de-duplicated by email.
  const merged = useMemo<MergedUser[]>(() => {
    const byEmail = new Map<string, MergedUser>();
    const upsert = (partial: Partial<MergedUser> & { key: string; emailKey: string }) => {
      const existing = byEmail.get(partial.emailKey);
      if (existing) {
        existing.hasAuth = existing.hasAuth || !!partial.hasAuth;
        existing.hasPaid = existing.hasPaid || !!partial.hasPaid;
        existing.name = existing.name ?? partial.name ?? null;
        existing.plan = existing.plan ?? partial.plan ?? null;
        existing.subStatus = existing.subStatus ?? partial.subStatus ?? null;
        existing.subExternalId = existing.subExternalId ?? partial.subExternalId ?? null;
        existing.customerExternalId = existing.customerExternalId ?? partial.customerExternalId ?? null;
        existing.ltvCents = existing.ltvCents || partial.ltvCents || 0;
        existing.billingProvider = existing.billingProvider ?? partial.billingProvider ?? null;
        existing.authProvider = existing.authProvider ?? partial.authProvider ?? null;
      } else {
        byEmail.set(partial.emailKey, {
          key: partial.key,
          email: partial.email ?? null,
          name: partial.name ?? null,
          plan: partial.plan ?? null,
          subStatus: partial.subStatus ?? null,
          subExternalId: partial.subExternalId ?? null,
          customerExternalId: partial.customerExternalId ?? null,
          ltvCents: partial.ltvCents ?? 0,
          hasAuth: !!partial.hasAuth,
          hasPaid: !!partial.hasPaid,
          billingProvider: partial.billingProvider ?? null,
          authProvider: partial.authProvider ?? null,
          joined: partial.joined ?? null,
        });
      }
    };

    (authUsers ?? []).forEach((u: any) =>
      upsert({
        key: u.id,
        emailKey: (u.email ?? u.id).toLowerCase(),
        email: u.email ?? null,
        hasAuth: true,
        authProvider,
        joined: u.created_at ?? null,
      }),
    );
    (customers ?? []).forEach((c: any) => {
      const sub = subByCustomer.get(c.external_id);
      const paying = sub ? ["active", "trialing", "past_due"].includes(sub.status) : false;
      const ltv = ltvByCustomer.get(c.external_id) ?? 0;
      upsert({
        key: c.external_id,
        emailKey: (c.email ?? c.external_id).toLowerCase(),
        email: c.email ?? null,
        name: c.name ?? null,
        plan: sub?.plan_name ?? null,
        subStatus: sub?.status ?? null,
        subExternalId: sub?.external_id ?? null,
        customerExternalId: c.external_id,
        ltvCents: ltv,
        hasPaid: paying || ltv > 0,
        billingProvider: c.provider ?? "stripe",
        joined: c.created_at_provider ?? null,
      });
    });

    return [...byEmail.values()].sort((a, b) => (b.joined ?? "").localeCompare(a.joined ?? ""));
  }, [authUsers, customers, subByCustomer, ltvByCustomer, authProvider]);

  function userType(u: MergedUser): UserType | "free" {
    if (u.hasAuth && u.hasPaid) return "both";
    if (u.hasPaid) return "paying";
    if (u.hasAuth) return "signup";
    return "free";
  }

  const thirtyAgoMs = Date.now() - 30 * 86400_000;
  const topSpenderFloor = useMemo(() => {
    const ltvs = merged.map((u) => u.ltvCents).filter((v) => v > 0).sort((a, b) => b - a);
    if (ltvs.length === 0) return Infinity;
    // top 20% threshold
    return ltvs[Math.floor(ltvs.length * 0.2)] ?? ltvs[0];
  }, [merged]);

  const filtered = useMemo(() => {
    let list = merged;
    if (filter !== "all") list = list.filter((u) => userType(u) === filter);
    if (segment === "new_30d") {
      list = list.filter((u) => u.joined && new Date(u.joined).getTime() >= thirtyAgoMs);
    } else if (segment === "churned") {
      list = list.filter((u) => u.subStatus === "canceled");
    } else if (segment === "top_spenders") {
      list = list.filter((u) => u.ltvCents > 0 && u.ltvCents >= topSpenderFloor);
    }
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((u) => (u.email ?? "").toLowerCase().includes(q) || (u.name ?? "").toLowerCase().includes(q));
    return list;
  }, [merged, filter, segment, search, thirtyAgoMs, topSpenderFloor]);

  const SEGMENTS: { value: Segment; label: string }[] = [
    { value: "all", label: "All" },
    { value: "new_30d", label: "New (30d)" },
    { value: "churned", label: "Churned" },
    { value: "top_spenders", label: "Top spenders" },
  ];

  const stats = useMemo(() => {
    let signups = 0, paying = 0, both = 0;
    merged.forEach((u) => {
      const t = userType(u);
      if (t === "paying") paying++;
      else if (t === "signup") signups++;
      else if (t === "both") { both++; paying++; signups++; }
    });
    return { total: merged.length, signups, paying, both };
  }, [merged]);

  const FILTERS: { value: FilterValue; label: string }[] = [
    { value: "all", label: "All" },
    { value: "signup", label: "Signed up (auth)" },
    { value: "paying", label: "Paying" },
    { value: "both", label: "Both" },
    { value: "free", label: "Free / no plan" },
  ];

  function typeBadge(u: MergedUser) {
    const t = userType(u);
    if (t === "both") return <Badge variant="info">signup + paying</Badge>;
    if (t === "paying") return <Badge variant="success">paying</Badge>;
    if (t === "signup") return <Badge variant="secondary">signed up</Badge>;
    return <Badge variant="outline">free</Badge>;
  }

  return (
    <div>
      <PageHeader
        title="All Users"
        description="Combined view of signed-up users (auth) and paying customers (billing)."
        actions={
          <div className="flex gap-2">
            <ExportMenu
              rows={merged.map((u) => ({
                email: u.email,
                name: u.name,
                type: userType(u),
                plan: u.plan,
                status: u.subStatus,
                joined: u.joined,
              }))}
              filename="users"
            />
            {billing && (
              <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
                {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sync customers
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <MetricCard label="Total users" value={String(stats.total)} icon={Users} />
        <MetricCard label="Signed up" value={String(stats.signups)} icon={Database} />
        <MetricCard label="Paying" value={String(stats.paying)} icon={CreditCard} />
        <MetricCard label="Signup + paying" value={String(stats.both)} />
      </div>

      {/* Search + segments + filter */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search email or name…"
            className="h-9 w-56 pl-8"
          />
        </div>
        <div className="flex gap-1.5">
          {SEGMENTS.map((s) => (
            <button
              key={s.value}
              onClick={() => setSegment(s.value)}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                segment === s.value ? "border-primary/40 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-secondary"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as FilterValue)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">{filtered.length} shown</span>
      </div>

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : merged.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No users yet"
          description="Connect Supabase Auth and/or a billing provider, then sync to populate this list."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3 text-right">LTV</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Joined</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((u) => (
                  <tr key={u.key} className="cursor-pointer hover:bg-secondary/40" onClick={() => setDetail(u)}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{u.email ?? "—"}</div>
                      {u.name && <div className="text-xs text-muted-foreground">{u.name}</div>}
                    </td>
                    <td className="px-4 py-3">{typeBadge(u)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{u.plan ?? "—"}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {u.ltvCents > 0 ? formatCurrency(u.ltvCents / 100, "EUR") : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {u.hasAuth && <Badge variant="outline">{providerLabel(u.authProvider ?? "auth")}</Badge>}
                        {u.hasPaid && <Badge variant="outline">{providerLabel(u.billingProvider ?? "stripe")}</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {u.joined ? new Date(u.joined).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={!u.email}
                            onClick={() => {
                              setInitialValues({ email: u.email ?? "" });
                              setActiveAction(RESET_PASSWORD_ACTION);
                            }}
                          >
                            <KeyRound className="h-4 w-4" /> Send password reset
                          </DropdownMenuItem>
                          {billing && u.subExternalId && (
                            <DropdownMenuItem
                              onClick={() => {
                                setInitialValues({ subscription_id: u.subExternalId ?? "" });
                                setActiveAction(cancelSubConfig(billingProvider));
                              }}
                            >
                              <XCircle className="h-4 w-4" /> Cancel subscription
                            </DropdownMenuItem>
                          )}
                          {billing && refundConfig(billingProvider) && u.hasPaid && (
                            <DropdownMenuItem
                              onClick={() => {
                                setInitialValues({});
                                setActiveAction(refundConfig(billingProvider)!);
                              }}
                            >
                              <RefreshCcw className="h-4 w-4" /> Refund…
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* User detail drawer */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {detail?.email ?? detail?.name ?? "User"}
              {detail && typeBadge(detail)}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">Name</div>
                  <div>{detail.name ?? "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Joined</div>
                  <div>{detail.joined ? new Date(detail.joined).toLocaleString() : "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Lifetime value</div>
                  <div className="font-semibold">{detail.ltvCents > 0 ? formatCurrency(detail.ltvCents / 100, "EUR") : "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Plan / status</div>
                  <div>{detail.plan ?? "—"}{detail.subStatus ? ` · ${detail.subStatus}` : ""}</div>
                </div>
                {detail.customerExternalId && (
                  <div className="col-span-2">
                    <div className="text-xs text-muted-foreground">Customer ID ({providerLabel(detail.billingProvider ?? "stripe")})</div>
                    <div className="font-mono text-xs">{detail.customerExternalId}</div>
                  </div>
                )}
                {detail.subExternalId && (
                  <div className="col-span-2">
                    <div className="text-xs text-muted-foreground">Subscription ID</div>
                    <div className="font-mono text-xs">{detail.subExternalId}</div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!detail.email}
                  onClick={() => {
                    setInitialValues({ email: detail.email ?? "" });
                    setActiveAction(RESET_PASSWORD_ACTION);
                    setDetail(null);
                  }}
                >
                  <KeyRound className="h-4 w-4" /> Password reset
                </Button>
                {billing && detail.subExternalId && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setInitialValues({ subscription_id: detail.subExternalId ?? "" });
                      setActiveAction(cancelSubConfig(billingProvider));
                      setDetail(null);
                    }}
                  >
                    <XCircle className="h-4 w-4" /> Cancel sub
                  </Button>
                )}
                {billing && refundConfig(billingProvider) && detail.hasPaid && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setInitialValues({});
                      setActiveAction(refundConfig(billingProvider)!);
                      setDetail(null);
                    }}
                  >
                    <RefreshCcw className="h-4 w-4" /> Refund
                  </Button>
                )}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">Recent events</span>
                  {detailEventsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                </div>
                {(detailEvents ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No tracked events for this user.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {(detailEvents ?? []).map((e, i) => (
                      <li key={i} className="flex items-center justify-between px-3 py-2 text-xs">
                        <span className="font-medium">{e.event_name}</span>
                        <span className="text-muted-foreground">{new Date(e.occurred_at).toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {workspaceId && projectId && (
        <AdminActionModal
          open={!!activeAction}
          onOpenChange={(o) => !o && setActiveAction(null)}
          action={activeAction}
          workspaceId={workspaceId}
          projectId={projectId}
          initialValues={initialValues}
        />
      )}
    </div>
  );
}
