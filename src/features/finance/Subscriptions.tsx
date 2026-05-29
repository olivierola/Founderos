import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Repeat, MoreVertical, XCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useStripeConnector } from "@/hooks/useFinance";
import { AdminActionModal, type AdminActionConfig } from "@/features/actions/AdminActionModal";
import { StripeGate } from "./StripeGate";

function statusVariant(s: string): "success" | "warning" | "destructive" | "secondary" {
  if (["active", "trialing"].includes(s)) return "success";
  if (["past_due", "unpaid"].includes(s)) return "warning";
  if (["canceled", "incomplete_expired"].includes(s)) return "destructive";
  return "secondary";
}

const CANCEL_SUBSCRIPTION_ACTION: AdminActionConfig = {
  action_type: "stripe.cancel_subscription",
  title: "Cancel subscription",
  description: "Immediately cancel this Stripe subscription. This cannot be undone.",
  risk: "high",
  typeToConfirm: "CANCEL",
  fields: [{ key: "subscription_id", label: "Subscription ID", placeholder: "sub_..." }],
};

export function SubscriptionsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [activeAction, setActiveAction] = useState<AdminActionConfig | null>(null);
  const [initialValues, setInitialValues] = useState<Record<string, string | number>>({});

  const connector = useStripeConnector(projectId);
  const { data: subs } = useQuery({
    queryKey: ["subscriptions", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("project_id", projectId!)
        .order("started_at", { ascending: false })
        .limit(100);
      return data ?? [];
    },
  });

  if (!workspaceId || !projectId) return <PageHeader title="Subscriptions" />;

  return (
    <div>
      <PageHeader
        title="Subscriptions"
        description="Active and past subscriptions from Stripe."
        actions={
          <ExportMenu
            rows={(subs ?? []).map((s: any) => ({
              plan: s.plan_name,
              status: s.status,
              customer: s.customer_external_id,
              amount_eur: (s.amount_cents ?? 0) / 100,
              currency: s.currency,
              interval: s.interval,
              renews: s.current_period_end,
            }))}
            filename="subscriptions"
          />
        }
      />
      <StripeGate connectorPresent={!!connector.data} workspaceId={workspaceId} projectId={projectId}>
        {!subs || subs.length === 0 ? (
          <EmptyState icon={Repeat} title="No subscriptions" />
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Plan</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Next renewal</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {subs.map((s: any) => (
                    <tr key={s.id}>
                      <td className="px-4 py-3 font-medium">{s.plan_name ?? "—"}</td>
                      <td className="px-4 py-3">
                        <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{s.customer_external_id}</td>
                      <td className="px-4 py-3">
                        {formatCurrency((s.amount_cents ?? 0) / 100, (s.currency ?? "eur").toUpperCase())}
                        {s.interval && <span className="text-xs text-muted-foreground"> /{s.interval}</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {["active", "trialing", "past_due"].includes(s.status) && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                destructive
                                onClick={() => {
                                  setInitialValues({ subscription_id: s.external_id });
                                  setActiveAction(CANCEL_SUBSCRIPTION_ACTION);
                                }}
                              >
                                <XCircle className="h-4 w-4" /> Cancel subscription
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </StripeGate>
      <AdminActionModal
        open={!!activeAction}
        onOpenChange={(o) => !o && setActiveAction(null)}
        action={activeAction}
        workspaceId={workspaceId}
        projectId={projectId}
        initialValues={initialValues}
      />
    </div>
  );
}
