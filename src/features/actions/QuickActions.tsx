import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CreditCard,
  Ban,
  TicketPercent,
  KeyRound,
  XCircle,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { AdminActionModal, type AdminActionConfig } from "./AdminActionModal";

const ACTIONS: AdminActionConfig[] = [
  {
    action_type: "stripe.refund_charge",
    title: "Refund a Stripe charge",
    description: "Issue a full or partial refund. The refund cannot be undone.",
    risk: "high",
    typeToConfirm: "REFUND",
    fields: [
      { key: "charge_id", label: "Charge ID", placeholder: "ch_...", required: true },
      { key: "amount_cents", label: "Amount in cents (leave empty for full refund)", placeholder: "1500", type: "number" },
    ],
  },
  {
    action_type: "stripe.cancel_subscription",
    title: "Cancel a subscription",
    description: "Immediately cancels the subscription in Stripe.",
    risk: "high",
    typeToConfirm: "CANCEL",
    fields: [{ key: "subscription_id", label: "Subscription ID", placeholder: "sub_...", required: true }],
  },
  {
    action_type: "stripe.create_coupon",
    title: "Create a Stripe coupon",
    description: "Generate a coupon code usable on checkout.",
    risk: "medium",
    fields: [
      { key: "percent_off", label: "Percent off (1-100)", type: "number", placeholder: "20" },
      { key: "duration", label: "Duration (once / repeating / forever)", placeholder: "once" },
      { key: "id", label: "Custom code (optional)", placeholder: "LAUNCH20" },
    ],
  },
  {
    action_type: "user.reset_password",
    title: "Send password reset email",
    description: "Triggers a Supabase Auth password reset to the user's inbox.",
    risk: "medium",
    fields: [{ key: "email", label: "User email", placeholder: "user@example.com", required: true }],
  },
];

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "stripe.refund_charge": CreditCard,
  "stripe.cancel_subscription": XCircle,
  "stripe.create_coupon": TicketPercent,
  "user.reset_password": KeyRound,
};

export function QuickActionsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [active, setActive] = useState<AdminActionConfig | null>(null);

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

  if (!workspaceId || !projectId) return <PageHeader title="Quick Actions" />;

  return (
    <div>
      <PageHeader
        title="Quick Actions"
        description="Sensitive operations against your connected providers. All actions are logged and high-risk ones require confirmation."
        actions={
          <ExportMenu
            rows={(recent ?? []).map((r: any) => ({
              when: r.created_at,
              action: r.action_type,
              target: r.target_id,
              risk: r.risk_level,
              status: r.status,
            }))}
            filename="admin-actions"
          />
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {ACTIONS.map((a) => {
          const Icon = ICONS[a.action_type] ?? ShieldAlert;
          return (
            <Card key={a.action_type}>
              <CardContent className="flex items-start gap-3 p-4">
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${
                    a.risk === "high" || a.risk === "critical"
                      ? "bg-destructive/15 text-destructive"
                      : "bg-secondary"
                  }`}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{a.title}</span>
                    <Badge
                      variant={a.risk === "high" || a.risk === "critical" ? "destructive" : "warning"}
                    >
                      {a.risk}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{a.description}</p>
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => setActive(a)}>
                    Run action
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mt-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Recent admin actions
        </h2>
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
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{r.action_type}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {r.target_id ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={["high", "critical"].includes(r.risk_level) ? "destructive" : "warning"}>
                          {r.risk_level}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            r.status === "succeeded"
                              ? "success"
                              : r.status === "failed" || r.status === "rejected"
                                ? "destructive"
                                : "secondary"
                          }
                        >
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
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ["admin_actions_recent", projectId] })}
      />
    </div>
  );
}
