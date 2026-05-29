import { CreditCard, Loader2, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { callEdge } from "@/lib/edge";

interface SyncResult {
  ok: boolean;
  counts?: { customers: number; subscriptions: number; invoices: number; charges: number };
  warnings?: string[];
}

interface StripeGateProps {
  connectorPresent: boolean;
  workspaceId: string;
  projectId: string;
  children: ReactNode;
}

export function StripeGate({ connectorPresent, workspaceId, projectId, children }: StripeGateProps) {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    setResult(null);
    try {
      const res = await callEdge<SyncResult>("sync-stripe-data", {
        workspace_id: workspaceId,
        project_id: projectId,
      });
      setResult(res);
      // metrics are computed asynchronously by calculate-metrics; give it a beat then refetch.
      await new Promise((r) => setTimeout(r, 1200));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["metrics-latest", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["metrics-history", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["customers", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["subscriptions", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["revenue-recent", projectId] }),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  if (!connectorPresent) {
    return (
      <EmptyState
        icon={CreditCard}
        title="Stripe not connected"
        description="Connect Stripe from Integrations → Catalog to start syncing revenue, subscriptions and customers."
      />
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-end gap-3">
        {result?.ok && result.counts && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Synced {result.counts.customers} customers · {result.counts.subscriptions} subs ·{" "}
            {result.counts.invoices} invoices
          </span>
        )}
        <Button size="sm" variant="outline" onClick={handleSync} disabled={syncing}>
          {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Sync from Stripe
        </Button>
      </div>

      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      {result?.warnings && result.warnings.length > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">Some resources were skipped (key permissions):</div>
            <ul className="mt-1 space-y-0.5">
              {result.warnings.map((w, i) => (
                <li key={i} className="font-mono">{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {children}
    </div>
  );
}
