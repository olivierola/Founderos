import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useLatestMetrics, useStripeConnector } from "@/hooks/useFinance";
import { StripeGate } from "./StripeGate";
import {
  FinanceMrrCard,
  FinanceArrCard,
  FinanceArpuCard,
  FinanceActiveSubsCard,
  FinanceTotalRevenueCard,
  FinanceRevenue30dCard,
  FinanceFailedPaymentsCard,
  FinanceRecentRevenueTable,
} from "@/features/overview/dashboards/moduleWidgets/finance";

export function RevenuePage() {
  const { workspaceId, projectId } = useCurrentContext();

  const connector = useStripeConnector(projectId);
  const latest = useLatestMetrics(projectId);
  const m = latest.data?.metrics;

  if (!workspaceId || !projectId) {
    return (
      <div>
        <PageHeader title="Revenue" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Revenue" description="MRR, ARR, ARPU and revenue movement from Stripe." />
      <StripeGate connectorPresent={!!connector.data} workspaceId={workspaceId} projectId={projectId}>
        {!m ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              No metrics snapshot yet. Click <strong className="text-foreground">Sync from Stripe</strong> above to
              fetch your data.
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <FinanceMrrCard workspaceId={workspaceId} projectId={projectId} />
              <FinanceArrCard workspaceId={workspaceId} projectId={projectId} />
              <FinanceArpuCard workspaceId={workspaceId} projectId={projectId} />
              <FinanceActiveSubsCard workspaceId={workspaceId} projectId={projectId} />
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <FinanceTotalRevenueCard workspaceId={workspaceId} projectId={projectId} />
              <FinanceRevenue30dCard workspaceId={workspaceId} projectId={projectId} />
              <FinanceFailedPaymentsCard workspaceId={workspaceId} projectId={projectId} />
            </div>

            <Card className="mt-6">
              <CardContent className="p-5">
                <FinanceRecentRevenueTable workspaceId={workspaceId} projectId={projectId} />
              </CardContent>
            </Card>
          </>
        )}
      </StripeGate>
    </div>
  );
}
