import { useState } from "react";
import { Lightbulb, Loader2, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface Insight {
  title: string;
  severity: "info" | "warning" | "critical";
  category: string;
  explanation: string;
  recommendations: string[];
  estimated_savings_eur: number | null;
}

interface OptimizationResponse {
  ok: boolean;
  summary: {
    total_cost_eur: number;
    costs_by_provider: Array<{ provider: string; eur: number }>;
    llm_by_model: Array<{ model: string; tokens: number; eur: number }>;
    llm_calls: number;
  };
  insights: Insight[];
  _meta?: { provider: string; model: string };
}

function sevVariant(s: string): "secondary" | "warning" | "destructive" {
  if (s === "critical") return "destructive";
  if (s === "warning") return "warning";
  return "secondary";
}

export function OptimizationPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OptimizationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    if (!workspaceId || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await callEdge<OptimizationResponse>("ai-cost-optimization", {
        workspace_id: workspaceId,
        project_id: projectId,
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  if (!workspaceId || !projectId) return <PageHeader title="Optimization" />;

  return (
    <div>
      <PageHeader
        title="Optimization"
        description="AI-generated savings ideas based on your recorded costs and LLM usage."
        actions={
          <Button onClick={handleRun} disabled={loading} size="sm">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Run analysis
          </Button>
        }
      />

      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      {!result ? (
        <EmptyState
          icon={Lightbulb}
          title="No analysis yet"
          description="Click Run analysis to get AI-generated optimization insights based on your last 30 days of activity."
        />
      ) : (
        <>
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Summary (last 30 days)</span>
                {result._meta && (
                  <Badge variant="outline">
                    {result._meta.provider} · {result._meta.model}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-background/40 p-3">
                <div className="text-xs uppercase text-muted-foreground">Total cost</div>
                <div className="mt-1 text-lg font-semibold">€{result.summary.total_cost_eur.toFixed(2)}</div>
              </div>
              <div className="rounded-lg border border-border bg-background/40 p-3">
                <div className="text-xs uppercase text-muted-foreground">LLM calls</div>
                <div className="mt-1 text-lg font-semibold">{result.summary.llm_calls}</div>
              </div>
              <div className="rounded-lg border border-border bg-background/40 p-3">
                <div className="text-xs uppercase text-muted-foreground">Providers tracked</div>
                <div className="mt-1 text-lg font-semibold">{result.summary.costs_by_provider.length}</div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-3">
            {(result.insights ?? []).map((insight, i) => (
              <Card key={i}>
                <CardContent className="p-5">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Lightbulb className="h-4 w-4 text-amber-400" />
                      <span className="font-medium">{insight.title}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={sevVariant(insight.severity)}>{insight.severity}</Badge>
                      <Badge variant="outline">{insight.category}</Badge>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">{insight.explanation}</p>
                  {insight.recommendations && insight.recommendations.length > 0 && (
                    <ul className="mt-3 space-y-1 text-sm">
                      {insight.recommendations.map((rec, j) => (
                        <li key={j} className="flex items-start gap-2">
                          <span className="text-primary">→</span>
                          <span>{rec}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {typeof insight.estimated_savings_eur === "number" && insight.estimated_savings_eur > 0 && (
                    <div className="mt-3 inline-flex rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-400">
                      ~€{insight.estimated_savings_eur}/mo potential savings
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
