import { useState } from "react";
import { Sparkles, Loader2, TrendingUp, AlertTriangle, ListChecks } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface Briefing {
  headline?: string;
  highlights?: { label: string; value: string }[];
  wins?: string[];
  risks?: string[];
  next_actions?: string[];
}

export function DailyBriefingPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Briefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ provider?: string; model?: string } | null>(null);

  async function generate() {
    if (!workspaceId || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await callEdge<{ briefing: Briefing; _meta: { provider: string; model: string } }>(
        "daily-briefing",
        { workspace_id: workspaceId, project_id: projectId },
      );
      setData(res.briefing);
      setMeta(res._meta);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Daily Briefing"
        description="AI-generated synthesis of your SaaS state."
        actions={
          <Button onClick={generate} disabled={loading} size="sm">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Generate
          </Button>
        }
      />

      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      {!data ? (
        <EmptyState
          icon={Sparkles}
          title="No briefing yet"
          description="Generate a fresh briefing summarising metrics, scans, alerts and recent activity."
        />
      ) : (
        <div className="space-y-4">
          {data.headline && (
            <Card>
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-lg font-medium leading-snug">{data.headline}</p>
                  {meta && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {meta.provider} · {meta.model}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {data.highlights && data.highlights.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Highlights</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {data.highlights.map((h, i) => (
                    <div key={i} className="rounded-lg border border-border bg-background/40 p-3">
                      <div className="text-xs text-muted-foreground">{h.label}</div>
                      <div className="mt-1 text-base font-semibold">{h.value}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <ListSection icon={TrendingUp} title="Wins" items={data.wins} variant="emerald" />
            <ListSection icon={AlertTriangle} title="Risks" items={data.risks} variant="amber" />
            <ListSection icon={ListChecks} title="Next actions" items={data.next_actions} variant="primary" />
          </div>
        </div>
      )}
    </div>
  );
}

function ListSection({
  icon: Icon,
  title,
  items,
  variant,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  items?: string[];
  variant: "emerald" | "amber" | "primary";
}) {
  const color =
    variant === "emerald" ? "text-emerald-400" : variant === "amber" ? "text-amber-400" : "text-primary";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${color}`} /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!items || items.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {items.map((it, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className={color}>→</span>
                <span>{it}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
