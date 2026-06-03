import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wallet, Brain, Activity, Repeat } from "lucide-react";
import { MetricCard } from "@/components/MetricCard";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { WidgetLoading, WidgetEmpty, WidgetSection, type ModuleWidgetProps } from "./shared";

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
  created_at: string;
}
interface LlmRow {
  id: string;
  estimated_cost_cents: number;
  created_at: string;
}

function monthlyCents(c: CostRow): number {
  if (c.recurrence !== "recurring") return 0;
  if (c.recurrence_interval === "year") return Math.round(c.amount_cents / 12);
  return c.amount_cents;
}

function useCosts(projectId: string, refreshKey?: number) {
  return useQuery({
    queryKey: ["cost_records", projectId, refreshKey ?? 0],
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
}
function useLlm(projectId: string, refreshKey?: number) {
  return useQuery({
    queryKey: ["llm_usage", projectId, refreshKey ?? 0],
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
}

function useStats(costs: CostRow[] | undefined, llm: LlmRow[] | undefined) {
  return useMemo(() => {
    const thirtyAgo = Date.now() - 30 * 86400_000;
    const list = costs ?? [];
    const total = list.reduce((s, c) => s + c.amount_cents, 0);
    const last30 = list.filter((c) => new Date(c.created_at).getTime() >= thirtyAgo).reduce((s, c) => s + c.amount_cents, 0);
    const mrc = list.reduce((s, c) => s + monthlyCents(c), 0);
    const llmTotal = (llm ?? []).reduce((s, l) => s + l.estimated_cost_cents, 0);
    const llm30 = (llm ?? []).filter((l) => new Date(l.created_at).getTime() >= thirtyAgo).reduce((s, l) => s + l.estimated_cost_cents, 0);
    return { total, last30, mrc, llmTotal, llm30 };
  }, [costs, llm]);
}

export function CostsMonthlyRecurringCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const costs = useCosts(projectId, refreshKey);
  const llm = useLlm(projectId, refreshKey);
  const stats = useStats(costs.data, llm.data);
  if (costs.isLoading) return <WidgetLoading />;
  return (
    <MetricCard
      label="Monthly recurring"
      value={formatCurrency(stats.mrc / 100, "EUR")}
      hint={`${formatCurrency((stats.mrc * 12) / 100, "EUR")}/yr`}
      icon={Repeat}
    />
  );
}

export function CostsTotalCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const costs = useCosts(projectId, refreshKey);
  const llm = useLlm(projectId, refreshKey);
  const stats = useStats(costs.data, llm.data);
  if (costs.isLoading) return <WidgetLoading />;
  return <MetricCard label="Total (recorded)" value={formatCurrency(stats.total / 100, "EUR")} icon={Wallet} />;
}

export function CostsLast30dCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const costs = useCosts(projectId, refreshKey);
  const llm = useLlm(projectId, refreshKey);
  const stats = useStats(costs.data, llm.data);
  if (costs.isLoading) return <WidgetLoading />;
  return <MetricCard label="Last 30 days" value={formatCurrency(stats.last30 / 100, "EUR")} icon={Activity} />;
}

export function CostsLlmCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const costs = useCosts(projectId, refreshKey);
  const llm = useLlm(projectId, refreshKey);
  const stats = useStats(costs.data, llm.data);
  if (llm.isLoading) return <WidgetLoading />;
  return (
    <MetricCard
      label="LLM cost (est.)"
      value={formatCurrency(stats.llmTotal / 100, "EUR")}
      hint={`${formatCurrency(stats.llm30 / 100, "EUR")} last 30d`}
      icon={Brain}
    />
  );
}

export function CostsByCategoryChart({ projectId, refreshKey }: ModuleWidgetProps) {
  const costs = useCosts(projectId, refreshKey);
  const llm = useLlm(projectId, refreshKey);
  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    (costs.data ?? []).forEach((c) => {
      const amount = c.recurrence === "recurring" ? monthlyCents(c) : c.amount_cents;
      m.set(c.category, (m.get(c.category) ?? 0) + amount);
    });
    const llmTotal = (llm.data ?? []).reduce((s, l) => s + l.estimated_cost_cents, 0);
    if (llmTotal > 0) m.set("ai", (m.get("ai") ?? 0) + llmTotal);
    const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    return entries.map(([cat, cents]) => ({ cat, cents, pct: (cents / max) * 100 }));
  }, [costs.data, llm.data]);
  if (costs.isLoading) return <WidgetLoading />;
  if (byCategory.length === 0) return <WidgetEmpty message="No expenses recorded." />;
  return (
    <WidgetSection title="Spend by category">
      <div className="space-y-3 overflow-auto">
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
      </div>
    </WidgetSection>
  );
}

export function CostsRecentExpensesTable({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data: costs, isLoading } = useCosts(projectId, refreshKey);
  if (isLoading) return <WidgetLoading />;
  if (!costs || costs.length === 0) return <WidgetEmpty message="No expenses recorded." />;
  return (
    <WidgetSection title="Recent expenses">
      <div className="h-full overflow-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-2 py-2">Provider</th>
              <th className="px-2 py-2">Category</th>
              <th className="px-2 py-2">Recurrence</th>
              <th className="px-2 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {costs.map((c) => (
              <tr key={c.id} className="hover:bg-secondary/40">
                <td className="px-2 py-2 font-medium">{c.provider}</td>
                <td className="px-2 py-2">
                  <Badge variant="outline">{c.category}</Badge>
                </td>
                <td className="px-2 py-2">
                  {c.recurrence === "recurring" ? (
                    <Badge variant="info" className="gap-1">
                      <Repeat className="h-3 w-3" /> {c.recurrence_interval === "year" ? "Yearly" : "Monthly"}
                    </Badge>
                  ) : (
                    <Badge variant="outline">One-off</Badge>
                  )}
                </td>
                <td className="px-2 py-2 text-right font-medium">
                  {formatCurrency(c.amount_cents / 100, c.currency.toUpperCase())}
                  {c.recurrence === "recurring" && (
                    <span className="ml-1 text-xs text-muted-foreground">/{c.recurrence_interval === "year" ? "yr" : "mo"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </WidgetSection>
  );
}
