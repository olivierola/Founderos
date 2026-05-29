import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { PieChart } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface AggRow {
  provider: string;
  total_cents: number;
  count: number;
  category: string;
}

export function CostsProvidersPage() {
  const { workspaceId, projectId } = useCurrentContext();

  const { data } = useQuery({
    queryKey: ["cost_records-all", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("cost_records")
        .select("provider, category, amount_cents, currency")
        .eq("project_id", projectId!);
      return data ?? [];
    },
  });

  const agg = useMemo(() => {
    const map = new Map<string, AggRow>();
    (data ?? []).forEach((r: any) => {
      const cur = map.get(r.provider) ?? { provider: r.provider, total_cents: 0, count: 0, category: r.category };
      cur.total_cents += r.amount_cents ?? 0;
      cur.count += 1;
      map.set(r.provider, cur);
    });
    return [...map.values()].sort((a, b) => b.total_cents - a.total_cents);
  }, [data]);

  const total = agg.reduce((s, r) => s + r.total_cents, 0);

  if (!workspaceId || !projectId) return <PageHeader title="By Provider" />;

  return (
    <div>
      <PageHeader title="By Provider" description="Cost breakdown across services." />

      {agg.length === 0 ? (
        <EmptyState icon={PieChart} title="No expenses yet" description="Record costs from the Overview tab." />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Provider distribution</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {agg.map((row) => {
              const pct = total > 0 ? (row.total_cents / total) * 100 : 0;
              return (
                <div key={row.provider}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium">{row.provider}</span>
                    <span className="text-muted-foreground">
                      {formatCurrency(row.total_cents / 100, "EUR")} · {pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
