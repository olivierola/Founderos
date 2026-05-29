import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useMetricsHistory, useStripeConnector } from "@/hooks/useFinance";
import { StripeGate } from "./StripeGate";
import { formatCurrency } from "@/lib/utils";

export function MrrMovementPage() {
  const { workspaceId, projectId } = useCurrentContext();

  const connector = useStripeConnector(projectId);
  const history = useMetricsHistory(projectId, 30);

  if (!workspaceId || !projectId) return <PageHeader title="MRR Movement" />;

  const points = history.data ?? [];
  const max = Math.max(1, ...points.map((p) => p.metrics?.mrr_cents ?? 0));

  return (
    <div>
      <PageHeader
        title="MRR Movement"
        description="Daily MRR snapshots over the last 30 days. New / expansion / contraction / churn breakdown comes in V2."
      />
      <StripeGate connectorPresent={!!connector.data} workspaceId={workspaceId} projectId={projectId}>
        <Card>
          <CardHeader>
            <CardTitle>MRR (last {points.length || 0} snapshots)</CardTitle>
          </CardHeader>
          <CardContent>
            {points.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No snapshots yet. Trigger a sync, then come back tomorrow — snapshots are written daily.
              </p>
            ) : (
              <div className="flex h-44 items-end gap-1">
                {points.map((p) => {
                  const v = p.metrics?.mrr_cents ?? 0;
                  const h = Math.max(4, Math.round((v / max) * 160));
                  return (
                    <div key={p.snapshot_date} className="flex-1" title={`${p.snapshot_date} · ${formatCurrency(v / 100, (p.metrics?.currency ?? "eur").toUpperCase())}`}>
                      <div className="rounded-t bg-primary/60 transition-colors hover:bg-primary" style={{ height: `${h}px` }} />
                    </div>
                  );
                })}
              </div>
            )}
            {points.length > 0 && (
              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>{points[0]!.snapshot_date}</span>
                <span>{points[points.length - 1]!.snapshot_date}</span>
              </div>
            )}
          </CardContent>
        </Card>
      </StripeGate>
    </div>
  );
}
