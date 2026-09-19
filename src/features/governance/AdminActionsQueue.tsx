// Admin-actions approval queue — the missing UI half of the request_approval
// flow: execute-admin-action parks high-risk actions (Stripe refunds, user
// bans…) as admin_actions status 'pending'; this page lets an owner/admin
// approve (→ executes via admin-action-approve) or reject them.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircleIcon as CheckCircle2,
  XCircleIcon as XCircle,
  ClockIcon as Clock,
  CircleNotchIcon as Loader2,
  LightningIcon as Zap,
  ShieldWarningIcon as ShieldAlert,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { Pill } from "./ui";

type ActionStatus = "pending" | "approved" | "executing" | "succeeded" | "failed" | "rejected";
type RiskLevel = "low" | "medium" | "high" | "critical";

interface AdminAction {
  id: string;
  project_id: string | null;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  status: ActionStatus;
  risk_level: RiskLevel;
  requires_approval: boolean;
  error_message: string | null;
  executed_at: string | null;
  created_at: string;
}

const STATUS_META: Record<ActionStatus, { label: string; tone: "red" | "orange" | "amber" | "emerald" | "blue" | "violet" | "slate" | "cyan" }> = {
  pending: { label: "En attente", tone: "amber" },
  approved: { label: "Approuvée", tone: "blue" },
  executing: { label: "Exécution…", tone: "cyan" },
  succeeded: { label: "Exécutée", tone: "emerald" },
  failed: { label: "Échouée", tone: "red" },
  rejected: { label: "Rejetée", tone: "slate" },
};
const RISK_META: Record<RiskLevel, { label: string; tone: "red" | "orange" | "amber" | "emerald" | "blue" | "violet" | "slate" | "cyan" }> = {
  low: { label: "Risque faible", tone: "emerald" },
  medium: { label: "Risque moyen", tone: "amber" },
  high: { label: "Risque élevé", tone: "orange" },
  critical: { label: "Critique", tone: "red" },
};

export function AdminActionsQueuePage() {
  const { workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [deciding, setDeciding] = useState<string | null>(null);

  const { data: actions, isLoading } = useQuery({
    queryKey: ["admin_actions", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data, error } = await supabase.from("admin_actions")
        .select("id, project_id, action_type, target_type, target_id, payload, status, risk_level, requires_approval, error_message, executed_at, created_at")
        .eq("workspace_id", workspaceId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return (data ?? []) as AdminAction[];
    },
  });

  const stats = useMemo(() => {
    const all = actions ?? [];
    return {
      pending: all.filter((a) => a.status === "pending").length,
      succeeded: all.filter((a) => a.status === "succeeded").length,
      failed: all.filter((a) => a.status === "failed" || a.status === "rejected").length,
      total: all.length,
    };
  }, [actions]);

  const decide = async (a: AdminAction, decision: "approve" | "reject") => {
    const reason = decision === "reject" ? (prompt("Motif du rejet (optionnel) :") ?? "") : undefined;
    setDeciding(a.id);
    try {
      await callEdge("admin-action-approve", { workspace_id: workspaceId, action_id: a.id, decision, reason: reason || undefined });
    } catch (e) {
      alert(e instanceof Error ? e.message : "La décision a échoué");
    } finally {
      setDeciding(null);
      queryClient.invalidateQueries({ queryKey: ["admin_actions", workspaceId] });
    }
  };

  const pending = (actions ?? []).filter((a) => a.status === "pending");
  const history = (actions ?? []).filter((a) => a.status !== "pending");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Actions admin"
        description="Actions sensibles (remboursements, coupons, bannissements…) demandées par un agent ou un membre : approuvez pour exécuter, ou rejetez."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="En attente" value={String(stats.pending)} icon={Clock} />
        <MetricCard label="Exécutées" value={String(stats.succeeded)} icon={CheckCircle2} />
        <MetricCard label="Rejetées / échouées" value={String(stats.failed)} icon={XCircle} />
        <MetricCard label="Total" value={String(stats.total)} icon={Zap} />
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (actions ?? []).length === 0 ? (
        <EmptyState icon={ShieldAlert} title="Aucune action" description="Les actions sensibles soumises à approbation (via execute-admin-action) apparaîtront ici." />
      ) : (
        <div className="space-y-4">
          {pending.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">En attente ({pending.length})</h3>
              {pending.map((a) => (
                <Card key={a.id} className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">{a.action_type}</span>
                    <Pill meta={RISK_META[a.risk_level]} />
                    {a.target_type && <span className="text-xs text-muted-foreground">{a.target_type}{a.target_id ? ` · ${a.target_id}` : ""}</span>}
                    <span className="ml-auto text-[11px] text-muted-foreground">{new Date(a.created_at).toLocaleString()}</span>
                  </div>
                  {Object.keys(a.payload ?? {}).length > 0 && (
                    <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">{JSON.stringify(a.payload, null, 2)}</pre>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <Button size="sm" disabled={deciding === a.id} onClick={() => decide(a, "approve")}>
                      {deciding === a.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
                      Approuver & exécuter
                    </Button>
                    <Button size="sm" variant="outline" disabled={deciding === a.id} onClick={() => decide(a, "reject")}>
                      <XCircle className="mr-1.5 h-3.5 w-3.5" /> Rejeter
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {history.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Historique ({history.length})</h3>
              {history.map((a) => (
                <Card key={a.id} className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{a.action_type}</span>
                    <Pill meta={STATUS_META[a.status]} className="px-1.5 py-0 text-[10px]" />
                    <Pill meta={RISK_META[a.risk_level]} className="px-1.5 py-0 text-[10px]" />
                    {a.error_message && <span className="truncate text-[11px] text-destructive">{a.error_message}</span>}
                    <span className="ml-auto text-[11px] text-muted-foreground">{new Date(a.executed_at ?? a.created_at).toLocaleString()}</span>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
