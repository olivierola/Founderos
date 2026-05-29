import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface LlmRow {
  id: string;
  provider: string;
  model: string;
  task: string | null;
  feature: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_cents: number;
  created_at: string;
}

export function LlmCostsPage() {
  const { workspaceId, projectId } = useCurrentContext();

  const { data } = useQuery({
    queryKey: ["llm_usage_full", projectId],
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
    const byModel = new Map<string, { tokens: number; cents: number; calls: number }>();
    const byFeature = new Map<string, { tokens: number; cents: number; calls: number }>();
    let totalTokens = 0;
    let totalCents = 0;
    (data ?? []).forEach((r) => {
      const k = `${r.provider} · ${r.model ?? "?"}`;
      const m = byModel.get(k) ?? { tokens: 0, cents: 0, calls: 0 };
      m.tokens += r.total_tokens;
      m.cents += r.estimated_cost_cents;
      m.calls += 1;
      byModel.set(k, m);

      const fk = r.feature ?? "unknown";
      const f = byFeature.get(fk) ?? { tokens: 0, cents: 0, calls: 0 };
      f.tokens += r.total_tokens;
      f.cents += r.estimated_cost_cents;
      f.calls += 1;
      byFeature.set(fk, f);

      totalTokens += r.total_tokens;
      totalCents += r.estimated_cost_cents;
    });
    return {
      totalTokens,
      totalCents,
      byModel: [...byModel.entries()].sort((a, b) => b[1].cents - a[1].cents),
      byFeature: [...byFeature.entries()].sort((a, b) => b[1].cents - a[1].cents),
    };
  }, [data]);

  if (!workspaceId || !projectId) return <PageHeader title="LLM Costs" />;

  if (!data || data.length === 0) {
    return (
      <div>
        <PageHeader title="LLM Costs" description="Token usage and estimated spend per model/feature." />
        <EmptyState
          icon={Brain}
          title="No LLM calls yet"
          description="Run a code scan or use the AI Agent and usage will appear here."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="LLM Costs"
        description="Token usage and estimated spend per model/feature. Estimates use public pricing."
        actions={
          <ExportMenu
            rows={(data ?? []).map((r) => ({
              provider: r.provider,
              model: r.model,
              task: r.task,
              feature: r.feature,
              prompt_tokens: r.prompt_tokens,
              completion_tokens: r.completion_tokens,
              total_tokens: r.total_tokens,
              cost_eur: r.estimated_cost_cents / 100,
              created_at: r.created_at,
            }))}
            filename="llm-usage"
          />
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              Total spend (est.) <Brain className="h-4 w-4" />
            </div>
            <div className="mt-3 text-2xl font-semibold">{formatCurrency(stats.totalCents / 100, "EUR")}</div>
            <div className="mt-1 text-xs text-muted-foreground">{stats.totalTokens.toLocaleString()} tokens</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              Calls <Sparkles className="h-4 w-4" />
            </div>
            <div className="mt-3 text-2xl font-semibold">{data.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="text-sm text-muted-foreground">Avg cost / call</div>
            <div className="mt-3 text-2xl font-semibold">
              {formatCurrency(stats.totalCents / data.length / 100, "EUR")}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By model</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {stats.byModel.map(([model, m]) => (
              <div key={model} className="flex items-center justify-between text-sm">
                <span className="truncate">{model}</span>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{m.calls} calls</span>
                  <span>{m.tokens.toLocaleString()} tokens</span>
                  <span className="font-medium text-foreground">{formatCurrency(m.cents / 100, "EUR")}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By feature</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {stats.byFeature.map(([f, v]) => (
              <div key={f} className="flex items-center justify-between text-sm">
                <Badge variant="outline">{f}</Badge>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{v.calls} calls</span>
                  <span className="font-medium text-foreground">{formatCurrency(v.cents / 100, "EUR")}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
