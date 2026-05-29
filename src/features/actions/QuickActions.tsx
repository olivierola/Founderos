import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CreditCard, TicketPercent, KeyRound, XCircle, Loader2, ShieldAlert, Search,
  PauseCircle, PlayCircle, Wallet, Ban, Gift, RotateCcw, User as UserIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useCapabilities, providerLabel } from "@/hooks/useConnectors";
import { AdminActionModal, type AdminActionConfig } from "./AdminActionModal";

interface Customer {
  external_id: string;
  email: string | null;
  name: string | null;
  provider: string;
}
interface Subscription {
  external_id: string;
  customer_external_id: string;
  status: string;
  plan_name: string | null;
  amount_cents: number;
  currency: string;
}

// --- General (non-contextual) actions, still useful as a quick palette ---
function generalActions(billingProvider: string | null): AdminActionConfig[] {
  const out: AdminActionConfig[] = [];
  if (billingProvider === "stripe") {
    out.push({
      action_type: "stripe.create_coupon",
      title: "Create a coupon",
      description: "Generate a discount code usable at checkout.",
      risk: "medium",
      fields: [
        { key: "percent_off", label: "Percent off (1-100)", type: "number", placeholder: "20" },
        { key: "duration", label: "Duration (once / repeating / forever)", placeholder: "once" },
        { key: "id", label: "Custom code (optional)", placeholder: "LAUNCH20" },
      ],
    });
  }
  out.push({
    action_type: "user.reset_password",
    title: "Send password reset",
    description: "Trigger a password reset email to any user.",
    risk: "medium",
    fields: [{ key: "email", label: "User email", placeholder: "user@example.com", required: true }],
  });
  return out;
}

// --- Contextual actions for a selected customer + subscription ---
function contextualActions(
  provider: string,
  customer: Customer,
  sub: Subscription | undefined,
): { cfg: AdminActionConfig; icon: any; values: Record<string, string> }[] {
  const list: { cfg: AdminActionConfig; icon: any; values: Record<string, string> }[] = [];
  const p = provider || "stripe";

  if (sub && ["active", "trialing", "past_due"].includes(sub.status)) {
    list.push({
      icon: XCircle,
      values: { subscription_id: sub.external_id },
      cfg: {
        action_type: `${p}.cancel_subscription`,
        title: "Cancel subscription",
        description: `Cancel ${sub.plan_name ?? "the subscription"} for ${customer.email ?? customer.external_id}.`,
        risk: "high",
        typeToConfirm: "CANCEL",
        fields: [{ key: "subscription_id", label: "Subscription ID", required: true }],
      },
    });
    if (p === "stripe") {
      list.push({
        icon: PauseCircle,
        values: { subscription_id: sub.external_id },
        cfg: {
          action_type: "stripe.pause_subscription",
          title: "Pause subscription",
          description: "Pause invoicing without cancelling (collection voided).",
          risk: "medium",
          fields: [{ key: "subscription_id", label: "Subscription ID", required: true }],
        },
      });
      list.push({
        icon: Gift,
        values: { subscription_id: sub.external_id },
        cfg: {
          action_type: "stripe.apply_coupon",
          title: "Apply a coupon",
          description: "Attach an existing coupon to this subscription (e.g. winback).",
          risk: "medium",
          fields: [
            { key: "subscription_id", label: "Subscription ID", required: true },
            { key: "coupon_id", label: "Coupon ID", placeholder: "WINBACK20", required: true },
          ],
        },
      });
    }
  } else if (sub && p === "stripe") {
    list.push({
      icon: PlayCircle,
      values: { subscription_id: sub.external_id },
      cfg: {
        action_type: "stripe.resume_subscription",
        title: "Resume subscription",
        description: "Resume a paused subscription.",
        risk: "medium",
        fields: [{ key: "subscription_id", label: "Subscription ID", required: true }],
      },
    });
  }

  if (p === "stripe") {
    list.push({
      icon: Wallet,
      values: { customer_id: customer.external_id },
      cfg: {
        action_type: "stripe.add_credit",
        title: "Add account credit",
        description: `Add a credit to ${customer.email ?? customer.external_id}'s balance.`,
        risk: "high",
        typeToConfirm: "CREDIT",
        fields: [
          { key: "customer_id", label: "Customer ID", required: true },
          { key: "amount_cents", label: "Amount in cents", type: "number", placeholder: "1000", required: true },
        ],
      },
    });
    list.push({
      icon: RotateCcw,
      values: {},
      cfg: {
        action_type: "stripe.refund_charge",
        title: "Refund a charge",
        description: "Refund a charge for this customer (paste the charge ID).",
        risk: "high",
        typeToConfirm: "REFUND",
        fields: [
          { key: "charge_id", label: "Charge ID", placeholder: "ch_...", required: true },
          { key: "amount_cents", label: "Amount in cents (empty = full)", type: "number" },
        ],
      },
    });
  }

  // Trial extension when applicable.
  if (sub && sub.status === "trialing" && p === "stripe") {
    list.push({
      icon: PlayCircle,
      values: { subscription_id: sub.external_id, days: "7" },
      cfg: {
        action_type: "stripe.extend_trial",
        title: "Extend trial",
        description: "Give this customer extra trial days.",
        risk: "medium",
        fields: [
          { key: "subscription_id", label: "Subscription ID", required: true },
          { key: "days", label: "Extra days", type: "number", placeholder: "7" },
        ],
      },
    });
  }

  if (p === "stripe") {
    list.push({
      icon: RotateCcw,
      values: {},
      cfg: {
        action_type: "stripe.retry_payment",
        title: "Retry failed payment",
        description: "Re-attempt collection on an open/past-due invoice (dunning).",
        risk: "medium",
        fields: [{ key: "invoice_id", label: "Invoice ID", placeholder: "in_...", required: true }],
      },
    });
  }

  if (customer.email) {
    list.push({
      icon: KeyRound,
      values: { email: customer.email },
      cfg: {
        action_type: "user.reset_password",
        title: "Send password reset",
        description: `Email a reset link to ${customer.email}.`,
        risk: "medium",
        fields: [{ key: "email", label: "Email", required: true }],
      },
    });
    list.push({
      icon: Wallet,
      values: { email: customer.email },
      cfg: {
        action_type: "user.export_data",
        title: "Export customer data (GDPR)",
        description: `Gather all stored data for ${customer.email}.`,
        risk: "low",
        fields: [{ key: "email", label: "Email", required: true }],
      },
    });
    list.push({
      icon: Gift,
      values: { target_email: customer.email },
      cfg: {
        action_type: "feature.grant",
        title: "Grant a feature flag",
        description: `Enable a feature for ${customer.email}.`,
        risk: "low",
        fields: [
          { key: "flag_key", label: "Feature key", placeholder: "beta_dashboard", required: true },
          { key: "target_email", label: "Target email", required: true },
        ],
      },
    });
  }

  return list;
}

// Project-wide ops & maintenance actions (no specific customer needed).
function opsActions(): { cfg: AdminActionConfig; icon: any }[] {
  return [
    {
      icon: RotateCcw,
      cfg: {
        action_type: "ops.resync_billing",
        title: "Re-sync billing data",
        description: "Pull the latest customers, subscriptions and invoices from your billing provider.",
        risk: "low",
        fields: [],
      },
    },
    {
      icon: RotateCcw,
      cfg: {
        action_type: "ops.recalc_metrics",
        title: "Recalculate metrics",
        description: "Recompute MRR/ARR/LTV and refresh the latest snapshot.",
        risk: "low",
        fields: [],
      },
    },
    {
      icon: ShieldAlert,
      cfg: {
        action_type: "ops.create_alert",
        title: "Create an alert",
        description: "Raise a manual alert visible in Overview → Alerts.",
        risk: "low",
        fields: [
          { key: "title", label: "Title", required: true },
          { key: "message", label: "Message" },
          { key: "severity", label: "Severity (info/warning/high/critical)", placeholder: "warning" },
        ],
      },
    },
    {
      icon: Gift,
      cfg: {
        action_type: "ops.create_announcement",
        title: "Post an announcement",
        description: "Publish an in-app announcement for your users.",
        risk: "medium",
        fields: [
          { key: "title", label: "Title", required: true },
          { key: "body", label: "Body" },
          { key: "level", label: "Level (info/success/warning/critical)", placeholder: "info" },
        ],
      },
    },
  ];
}

export function QuickActionsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { billing } = useCapabilities(projectId);
  const queryClient = useQueryClient();
  const [active, setActive] = useState<AdminActionConfig | null>(null);
  const [initialValues, setInitialValues] = useState<Record<string, string | number>>({});
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Customer | null>(null);

  const billingProvider = billing?.provider ?? null;

  const { data: customers } = useQuery({
    queryKey: ["actions_customers", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("external_id, email, name, provider")
        .eq("project_id", projectId!)
        .order("created_at_provider", { ascending: false })
        .limit(500);
      return (data ?? []) as Customer[];
    },
  });

  const { data: subs } = useQuery({
    queryKey: ["actions_subs", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select("external_id, customer_external_id, status, plan_name, amount_cents, currency")
        .eq("project_id", projectId!);
      return (data ?? []) as Subscription[];
    },
  });

  const subByCustomer = useMemo(() => {
    const m = new Map<string, Subscription>();
    (subs ?? []).forEach((s) => {
      const ex = m.get(s.customer_external_id);
      if (!ex || (s.status === "active" && ex.status !== "active")) m.set(s.customer_external_id, s);
    });
    return m;
  }, [subs]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return (customers ?? []).slice(0, 8);
    return (customers ?? [])
      .filter((c) => (c.email ?? "").toLowerCase().includes(q) || (c.name ?? "").toLowerCase().includes(q) || c.external_id.toLowerCase().includes(q))
      .slice(0, 8);
  }, [customers, search]);

  const { data: recent } = useQuery({
    queryKey: ["admin_actions_recent", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("admin_actions")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(10);
      return data ?? [];
    },
  });

  function run(cfg: AdminActionConfig, values: Record<string, string> = {}) {
    setInitialValues(values);
    setActive(cfg);
  }

  if (!workspaceId || !projectId) return <PageHeader title="Quick Actions" />;

  const selectedSub = selected ? subByCustomer.get(selected.external_id) : undefined;
  const ctxActions = selected ? contextualActions(billingProvider ?? "stripe", selected, selectedSub) : [];
  const general = generalActions(billingProvider);

  return (
    <div>
      <PageHeader
        title="Actions Center"
        description="Run sensitive operations on a specific customer or subscription. Actions adapt to your connected providers and are fully logged."
        actions={
          <ExportMenu
            rows={(recent ?? []).map((r: any) => ({ when: r.created_at, action: r.action_type, target: r.target_id, risk: r.risk_level, status: r.status }))}
            filename="admin-actions"
          />
        }
      />

      {!billingProvider && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          <ShieldAlert className="h-4 w-4 shrink-0" /> No billing provider connected — only user actions are available. Connect Stripe/Lemon Squeezy in the Catalog.
        </div>
      )}

      {/* Customer picker */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a customer by email, name or ID…" className="pl-8" />
          </div>
          {matches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No customers. Sync your billing provider from Finance.</p>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {matches.map((c) => {
                const sub = subByCustomer.get(c.external_id);
                const on = selected?.external_id === c.external_id;
                return (
                  <button
                    key={c.external_id}
                    onClick={() => setSelected(c)}
                    className={`flex items-center gap-2 rounded-md border p-2.5 text-left transition-colors ${on ? "border-primary/50 bg-primary/10" : "border-border hover:bg-secondary"}`}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary">
                      <UserIcon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{c.email ?? c.name ?? c.external_id}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {sub ? `${sub.plan_name ?? "plan"} · ${sub.status}` : "no subscription"}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Contextual actions */}
      {selected && (
        <div className="mb-8">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-medium">Actions for {selected.email ?? selected.external_id}</h2>
            {selectedSub && (
              <Badge variant="outline">
                {selectedSub.plan_name ?? "plan"} · {formatCurrency(selectedSub.amount_cents / 100, (selectedSub.currency ?? "eur").toUpperCase())} · {selectedSub.status}
              </Badge>
            )}
            {billingProvider && <Badge variant="secondary">{providerLabel(billingProvider)}</Badge>}
          </div>
          {/* Smart suggestion: churned customer → propose a winback coupon */}
          {selectedSub && selectedSub.status === "canceled" && billingProvider === "stripe" && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
              <Gift className="h-4 w-4 shrink-0 text-primary" />
              <span className="flex-1">This customer churned. Offer a winback discount to bring them back?</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  run(
                    {
                      action_type: "stripe.create_coupon",
                      title: "Create winback coupon",
                      description: "Generate a discount to win back this churned customer.",
                      risk: "medium",
                      fields: [
                        { key: "percent_off", label: "Percent off", type: "number" },
                        { key: "duration", label: "Duration", placeholder: "repeating" },
                        { key: "id", label: "Code", placeholder: "WINBACK25" },
                      ],
                    },
                    { percent_off: "25", duration: "repeating", id: "WINBACK25" },
                  )
                }
              >
                Create winback coupon
              </Button>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {ctxActions.map(({ cfg, icon: Icon, values }) => (
              <ActionCard key={cfg.action_type} cfg={cfg} Icon={Icon} onRun={() => run(cfg, values)} />
            ))}
          </div>
        </div>
      )}

      {/* General actions */}
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">General actions</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {general.map((cfg) => (
          <ActionCard
            key={cfg.action_type}
            cfg={cfg}
            Icon={cfg.action_type.includes("coupon") ? TicketPercent : cfg.action_type.includes("password") ? KeyRound : CreditCard}
            onRun={() => run(cfg)}
          />
        ))}
      </div>

      {/* Ops & maintenance */}
      <h2 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ops &amp; maintenance</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {opsActions().map(({ cfg, icon: Icon }) => (
          <ActionCard key={cfg.action_type} cfg={cfg} Icon={Icon} onRun={() => run(cfg)} />
        ))}
      </div>

      {/* Recent */}
      <div className="mt-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent admin actions</h2>
        {!recent || recent.length === 0 ? (
          <EmptyState icon={Ban} title="No admin actions yet" />
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3">Action</th>
                    <th className="px-4 py-3">Target</th>
                    <th className="px-4 py-3">Risk</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recent.map((r: any) => (
                    <tr key={r.id}>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                      <td className="px-4 py-3 font-mono text-xs">{r.action_type}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{r.target_id ?? "—"}</td>
                      <td className="px-4 py-3"><Badge variant={["high", "critical"].includes(r.risk_level) ? "destructive" : "warning"}>{r.risk_level}</Badge></td>
                      <td className="px-4 py-3">
                        <Badge variant={r.status === "succeeded" ? "success" : r.status === "failed" || r.status === "rejected" ? "destructive" : "secondary"}>
                          {r.status}
                          {r.status === "executing" && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
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

      <AdminActionModal
        open={!!active}
        onOpenChange={(o) => !o && setActive(null)}
        action={active}
        workspaceId={workspaceId}
        projectId={projectId}
        initialValues={initialValues}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ["admin_actions_recent", projectId] })}
      />
    </div>
  );
}

function ActionCard({ cfg, Icon, onRun }: { cfg: AdminActionConfig; Icon: any; onRun: () => void }) {
  const high = cfg.risk === "high" || cfg.risk === "critical";
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${high ? "bg-destructive/15 text-destructive" : "bg-secondary"}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{cfg.title}</span>
            <Badge variant={high ? "destructive" : "warning"}>{cfg.risk}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{cfg.description}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={onRun}>Run action</Button>
        </div>
      </CardContent>
    </Card>
  );
}
