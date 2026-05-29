import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, MoreVertical, KeyRound } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useStripeConnector } from "@/hooks/useFinance";
import { AdminActionModal, type AdminActionConfig } from "@/features/actions/AdminActionModal";
import { StripeGate } from "./StripeGate";

const RESET_PASSWORD_ACTION: AdminActionConfig = {
  action_type: "user.reset_password",
  title: "Send password reset",
  description: "Send a password reset email to this customer.",
  risk: "low",
  fields: [{ key: "email", label: "Email", placeholder: "customer@example.com" }],
};

export function CustomersPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [activeAction, setActiveAction] = useState<AdminActionConfig | null>(null);
  const [initialValues, setInitialValues] = useState<Record<string, string | number>>({});

  const connector = useStripeConnector(projectId);
  const { data: customers } = useQuery({
    queryKey: ["customers", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at_provider", { ascending: false })
        .limit(100);
      return data ?? [];
    },
  });

  if (!workspaceId || !projectId) return <PageHeader title="Customers" />;

  return (
    <div>
      <PageHeader
        title="Customers"
        description="Stripe customers attached to this project."
        actions={
          <ExportMenu
            rows={(customers ?? []).map((c: any) => ({
              email: c.email,
              name: c.name,
              external_id: c.external_id,
              joined: c.created_at_provider,
            }))}
            filename="customers"
          />
        }
      />
      <StripeGate connectorPresent={!!connector.data} workspaceId={workspaceId} projectId={projectId}>
        {!customers || customers.length === 0 ? (
          <EmptyState icon={Users} title="No customers" description="Sync Stripe to import customers." />
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Stripe ID</th>
                    <th className="px-4 py-3">Joined</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {customers.map((c: any) => (
                    <tr key={c.id}>
                      <td className="px-4 py-3 font-medium">{c.email ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{c.name ?? "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{c.external_id}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {c.created_at_provider ? new Date(c.created_at_provider).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={!c.email}
                              onClick={() => {
                                setInitialValues({ email: c.email });
                                setActiveAction(RESET_PASSWORD_ACTION);
                              }}
                            >
                              <KeyRound className="h-4 w-4" /> Send password reset
                            </DropdownMenuItem>
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
