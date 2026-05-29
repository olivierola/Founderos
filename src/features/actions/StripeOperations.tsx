import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Receipt, XCircle, RefreshCcw, CreditCard, Settings2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useCapabilities, providerLabel } from "@/hooks/useConnectors";
import { AdminActionModal, type AdminActionConfig } from "./AdminActionModal";

// Per-provider action capabilities. Lemon Squeezy refunds orders, not invoices.
function cancelConfig(provider: string): AdminActionConfig {
  return {
    action_type: `${provider}.cancel_subscription`,
    title: `Cancel this subscription`,
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
      title: "Refund this invoice",
      description: "Refund the full amount of the latest charge on the invoice.",
      risk: "high",
      typeToConfirm: "REFUND",
      fields: [{ key: "invoice_id", label: "Invoice ID" }],
    };
  }
  if (provider === "lemonsqueezy") {
    return {
      action_type: "lemonsqueezy.refund_order",
      title: "Refund this order",
      description: "Refund the Lemon Squeezy order.",
      risk: "high",
      typeToConfirm: "REFUND",
      fields: [{ key: "order_id", label: "Order ID" }],
    };
  }
  return null; // Paddle refunds are handled in their dashboard for the MVP
}

export function StripeOperationsPage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const { billing, loading: capsLoading } = useCapabilities(projectId);
  const queryClient = useQueryClient();
  const [actionConfig, setActionConfig] = useState<AdminActionConfig | null>(null);
  const [initialValues, setInitialValues] = useState<Record<string, string>>({});

  const provider = billing?.provider ?? null;

  const { data: subs } = useQuery({
    queryKey: ["subscriptions_ops", projectId],
    enabled: !!projectId && !!provider,
    queryFn: async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select("external_id, status, plan_name, amount_cents, currency, current_period_end")
        .eq("project_id", projectId!)
        .in("status", ["active", "trialing", "past_due"])
        .order("started_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });

  const { data: invoices } = useQuery({
    queryKey: ["invoices_ops", projectId],
    enabled: !!projectId && !!provider,
    queryFn: async () => {
      const { data } = await supabase
        .from("invoices")
        .select("external_id, customer_external_id, amount_paid_cents, currency, status, paid_at")
        .eq("project_id", projectId!)
        .eq("status", "paid")
        .order("paid_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });

  function openCancel(subId: string) {
    if (!provider) return;
    setInitialValues({ subscription_id: subId });
    setActionConfig(cancelConfig(provider));
  }
  function openRefund(invId: string) {
    if (!provider) return;
    const cfg = refundConfig(provider);
    if (!cfg) return;
    setInitialValues(provider === "lemonsqueezy" ? { order_id: invId } : { invoice_id: invId });
    setActionConfig(cfg);
  }

  if (!workspaceId || !projectId) return <PageHeader title="Billing Operations" />;

  // No billing provider connected → adaptive guidance
  if (!capsLoading && !provider) {
    return (
      <div>
        <PageHeader title="Billing Operations" description="Manage subscriptions and refunds." />
        <EmptyState
          icon={CreditCard}
          title="No billing provider connected"
          description="Connect Stripe, Lemon Squeezy or Paddle in the catalog to manage subscriptions and refunds here."
          action={
            <Button onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/integrations/catalog`)}>
              <Settings2 className="h-4 w-4" /> Open catalog
            </Button>
          }
        />
      </div>
    );
  }

  const canRefund = provider ? !!refundConfig(provider) : false;

  return (
    <div>
      <PageHeader
        title="Billing Operations"
        description={`Manage subscriptions and refunds via ${provider ? providerLabel(provider) : "your billing provider"}. Every operation is logged.`}
        actions={provider && <Badge variant="info">{providerLabel(provider)}</Badge>}
      />

      <Card className="mb-6">
        <CardContent className="p-0">
          <div className="border-b border-border p-4 font-medium">Active subscriptions</div>
          {!subs || subs.length === 0 ? (
            <EmptyState icon={RefreshCcw} title="No active subscriptions" />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Next renewal</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {subs.map((s: any) => (
                  <tr key={s.external_id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{s.plan_name ?? "—"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{s.external_id}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={s.status === "active" ? "success" : "warning"}>{s.status}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      {formatCurrency((s.amount_cents ?? 0) / 100, (s.currency ?? "eur").toUpperCase())}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="outline" onClick={() => openCancel(s.external_id)}>
                        <XCircle className="h-3.5 w-3.5" /> Cancel
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border p-4 font-medium">
            Recent paid {provider === "lemonsqueezy" ? "orders" : "invoices"}
          </div>
          {!invoices || invoices.length === 0 ? (
            <EmptyState icon={Receipt} title="No paid invoices yet" />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">{provider === "lemonsqueezy" ? "Order" : "Invoice"}</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Paid</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invoices.map((i: any) => (
                  <tr key={i.external_id}>
                    <td className="px-4 py-3 font-mono text-xs">{i.external_id}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{i.customer_external_id}</td>
                    <td className="px-4 py-3">
                      {formatCurrency((i.amount_paid_cents ?? 0) / 100, (i.currency ?? "eur").toUpperCase())}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {i.paid_at ? new Date(i.paid_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canRefund ? (
                        <Button size="sm" variant="outline" onClick={() => openRefund(i.external_id)}>
                          <RefreshCcw className="h-3.5 w-3.5" /> Refund
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">via {providerLabel(provider!)} dashboard</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <AdminActionModal
        open={!!actionConfig}
        onOpenChange={(o) => !o && setActionConfig(null)}
        action={actionConfig}
        workspaceId={workspaceId}
        projectId={projectId}
        initialValues={initialValues}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["subscriptions_ops", projectId] });
          queryClient.invalidateQueries({ queryKey: ["invoices_ops", projectId] });
          queryClient.invalidateQueries({ queryKey: ["admin_actions_recent", projectId] });
        }}
      />
    </div>
  );
}
