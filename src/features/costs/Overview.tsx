import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Wallet, Brain, Activity, Repeat, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { AddCostDialog } from "./AddCostDialog";

interface CostRow {
  id: string;
  provider: string;
  category: string;
  amount_cents: number;
  currency: string;
  period_start: string | null;
  source: string;
  recurrence: "one_off" | "recurring";
  recurrence_interval: "month" | "year" | null;
  note: string | null;
  created_at: string;
}

// Normalize a recurring cost to its monthly amount in cents.
function monthlyCents(c: CostRow): number {
  if (c.recurrence !== "recurring") return 0;
  if (c.recurrence_interval === "year") return Math.round(c.amount_cents / 12);
  return c.amount_cents; // monthly (default)
}

interface LlmRow {
  id: string;
  provider: string;
  model: string;
  estimated_cost_cents: number;
  total_tokens: number;
  created_at: string;
}

export function CostsOverviewPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [addOpen, setAddOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: costs } = useQuery({
    queryKey: ["cost_records", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("cost_records")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(100);
      return (data ?? []) as CostRow[];
    },
  });

  const { data: llm } = useQuery({
    queryKey: ["llm_usage", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("llm_usage")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(500);
      return (data ?? []) as LlmRow[];
    },
  });

  const stats = useMemo(() => {
    const thirtyAgo = Date.now() - 30 * 86400_000;
    const list = costs ?? [];
    const total = list.reduce((s, c) => s + c.amount_cents, 0);
    const last30 = list
      .filter((c) => new Date(c.created_at).getTime() >= thirtyAgo)
      .reduce((s, c) => s + c.amount_cents, 0);
    // Monthly recurring cost: sum of recurring entries normalized to /month.
    const mrc = list.reduce((s, c) => s + monthlyCents(c), 0);
    const llmTotal = (llm ?? []).reduce((s, l) => s + l.estimated_cost_cents, 0);
    const llm30 = (llm ?? [])
      .filter((l) => new Date(l.created_at).getTime() >= thirtyAgo)
      .reduce((s, l) => s + l.estimated_cost_cents, 0);
    return { total, last30, mrc, llmTotal, llm30 };
  }, [costs, llm]);

  // Spend grouped by category (one-off + monthly-normalized recurring + LLM).
  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    (costs ?? []).forEach((c) => {
      const amount = c.recurrence === "recurring" ? monthlyCents(c) : c.amount_cents;
      m.set(c.category, (m.get(c.category) ?? 0) + amount);
    });
    const llmTotal = (llm ?? []).reduce((s, l) => s + l.estimated_cost_cents, 0);
    if (llmTotal > 0) m.set("ai", (m.get("ai") ?? 0) + llmTotal);
    const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    return entries.map(([cat, cents]) => ({ cat, cents, pct: (cents / max) * 100 }));
  }, [costs, llm]);

  async function deleteCost(id: string) {
    await supabase.from("cost_records").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["cost_records", projectId] });
  }

  if (!workspaceId || !projectId) return <PageHeader title="Costs Overview" />;

  return (
    <div>
      <PageHeader
        title="Costs Overview"
        description="Track infra, AI and SaaS expenses across providers."
        actions={
          <div className="flex gap-2">
            <ExportMenu
              rows={(costs ?? []).map((c) => ({
                provider: c.provider,
                category: c.category,
                recurrence: c.recurrence,
                interval: c.recurrence_interval ?? "",
                amount_eur: c.amount_cents / 100,
                currency: c.currency,
                source: c.source,
                created_at: c.created_at,
              }))}
              filename="costs"
            />
            <Button onClick={() => setAddOpen(true)} size="sm">
              <Plus className="h-4 w-4" /> Add cost
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Monthly recurring"
          value={formatCurrency(stats.mrc / 100, "EUR")}
          hint={`${formatCurrency((stats.mrc * 12) / 100, "EUR")}/yr`}
          icon={Repeat}
        />
        <MetricCard label="Total (recorded)" value={formatCurrency(stats.total / 100, "EUR")} icon={Wallet} />
        <MetricCard label="Last 30 days" value={formatCurrency(stats.last30 / 100, "EUR")} icon={Activity} />
        <MetricCard
          label="LLM cost (est.)"
          value={formatCurrency(stats.llmTotal / 100, "EUR")}
          hint={`${formatCurrency(stats.llm30 / 100, "EUR")} last 30d`}
          icon={Brain}
        />
      </div>

      {byCategory.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Spend by category</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {byCategory.map((b) => (
              <div key={b.cat}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="capitalize">{b.cat}</span>
                  <span className="text-muted-foreground">{formatCurrency(b.cents / 100, "EUR")}</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-secondary">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${b.pct}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent expenses</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!costs || costs.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title="No expenses recorded"
              description="Add costs manually for providers whose API doesn't expose billing yet."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Recurrence</th>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {costs.map((c) => (
                  <tr key={c.id} className="hover:bg-secondary/40">
                    <td className="px-4 py-3 font-medium">{c.provider}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">{c.category}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      {c.recurrence === "recurring" ? (
                        <Badge variant="info" className="gap-1">
                          <Repeat className="h-3 w-3" /> {c.recurrence_interval === "year" ? "Yearly" : "Monthly"}
                        </Badge>
                      ) : (
                        <Badge variant="outline">One-off</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {c.period_start ?? new Date(c.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <Badge variant={c.source === "manual" ? "secondary" : "success"}>{c.source}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      {formatCurrency(c.amount_cents / 100, c.currency.toUpperCase())}
                      {c.recurrence === "recurring" && (
                        <span className="ml-1 text-xs text-muted-foreground">/{c.recurrence_interval === "year" ? "yr" : "mo"}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteCost(c.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <AddCostDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        workspaceId={workspaceId}
        projectId={projectId}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ["cost_records", projectId] })}
      />
    </div>
  );
}
