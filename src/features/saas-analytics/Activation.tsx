// Activation — the dashboard surface for the Activation Engine.
//
// Reads the per-visitor activation_sessions and the proactive
// activation_interventions (both RLS-scoped to the workspace) and derives the
// headline metrics: average activation score, % of visitors activated, and the
// proactive intervention acceptance rate. This closes the loop opened by the
// rag-activation-tick / -feedback edge functions.
import { useMemo } from "react";
import {
  Sparkles,
  Gauge,
  Bot,
  CheckCircle2,
  Loader2,
  MousePointerClick,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface ActivationSession {
  id: string;
  visitor_id: string | null;
  external_user_id: string | null;
  user_email: string | null;
  activation_score: number;
  activated: boolean;
  conversation_turns: number;
  last_route: string | null;
  last_seen_at: string;
}

interface Intervention {
  id: string;
  trigger_type: string;
  route: string | null;
  message: string | null;
  outcome: "shown" | "accepted" | "dismissed" | "ignored";
  created_at: string;
}

const OUTCOME_TONE: Record<Intervention["outcome"], string> = {
  accepted: "text-emerald-400",
  dismissed: "text-red-400",
  ignored: "text-muted-foreground",
  shown: "text-amber-400",
};

const TRIGGER_LABEL: Record<string, string> = {
  idle: "Idle",
  rage_click: "Rage click",
  route_change: "New page",
  low_score: "Low score",
  feature_unused: "Unused feature",
  manual: "Manual",
};

function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function useActivationSessions() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["activation_sessions", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("activation_sessions")
        .select(
          "id, visitor_id, external_user_id, user_email, activation_score, activated, conversation_turns, last_route, last_seen_at",
        )
        .eq("project_id", projectId!)
        .order("last_seen_at", { ascending: false })
        .limit(500);
      return (data ?? []) as ActivationSession[];
    },
  });
}

function useInterventions() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["activation_interventions", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("activation_interventions")
        .select("id, trigger_type, route, message, outcome, created_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(200);
      return (data ?? []) as Intervention[];
    },
  });
}

export function ActivationPage() {
  const sessions = useActivationSessions();
  const interventions = useInterventions();

  const metrics = useMemo(() => {
    const s = sessions.data ?? [];
    const total = s.length;
    const activated = s.filter((x) => x.activated).length;
    const avgScore = total ? Math.round(s.reduce((a, x) => a + x.activation_score, 0) / total) : 0;

    const iv = interventions.data ?? [];
    const resolved = iv.filter((x) => x.outcome !== "shown");
    const accepted = iv.filter((x) => x.outcome === "accepted").length;
    const acceptanceRate = resolved.length ? Math.round((accepted / resolved.length) * 100) : 0;

    return {
      total,
      activated,
      activatedRate: total ? Math.round((activated / total) * 100) : 0,
      avgScore,
      interventionCount: iv.length,
      acceptanceRate,
    };
  }, [sessions.data, interventions.data]);

  const loading = sessions.isLoading || interventions.isLoading;
  const empty = !loading && (sessions.data?.length ?? 0) === 0 && (interventions.data?.length ?? 0) === 0;

  return (
    <div>
      <PageHeader
        title="Activation"
        description="Per-visitor activation scoring and the proactive agent interventions it drives — the live loop between your event stream and the in-product assistant."
      />

      {loading ? (
        <EmptyState icon={Loader2} title="Loading activation data…" />
      ) : empty ? (
        <EmptyState
          icon={Sparkles}
          title="No activation data yet"
          description="Enable the proactive widget (config.proactive) on a client app. Sessions and interventions appear here as visitors interact."
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Activated"
              value={`${metrics.activatedRate}%`}
              hint={`${metrics.activated}/${metrics.total} visitors`}
              icon={CheckCircle2}
              trend={metrics.activatedRate >= 40 ? "up" : metrics.activatedRate >= 20 ? "flat" : "down"}
            />
            <MetricCard
              label="Avg. activation score"
              value={String(metrics.avgScore)}
              hint="Weighted across active sessions"
              icon={Gauge}
            />
            <MetricCard
              label="Proactive interventions"
              value={String(metrics.interventionCount)}
              hint="Times the agent reached out"
              icon={Bot}
            />
            <MetricCard
              label="Acceptance rate"
              value={`${metrics.acceptanceRate}%`}
              hint="Of resolved interventions"
              icon={MousePointerClick}
              trend={metrics.acceptanceRate >= 40 ? "up" : metrics.acceptanceRate >= 20 ? "flat" : "down"}
            />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* ── Recent interventions ── */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Recent interventions</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {(interventions.data?.length ?? 0) === 0 ? (
                  <div className="p-5 text-sm text-muted-foreground">No interventions yet.</div>
                ) : (
                  <div className="divide-y divide-border">
                    {(interventions.data ?? []).slice(0, 12).map((iv) => (
                      <div key={iv.id} className="flex items-start gap-3 p-4">
                        <Badge variant="outline" className="mt-0.5 shrink-0 text-xs">
                          {TRIGGER_LABEL[iv.trigger_type] ?? iv.trigger_type}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{iv.message ?? "—"}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {iv.route ?? "—"} · {timeAgo(iv.created_at)}
                          </div>
                        </div>
                        <span className={`shrink-0 text-xs ${OUTCOME_TONE[iv.outcome]}`}>{iv.outcome}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ── Top sessions by score ── */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Sessions by activation score</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {(sessions.data?.length ?? 0) === 0 ? (
                  <div className="p-5 text-sm text-muted-foreground">No sessions yet.</div>
                ) : (
                  <div className="divide-y divide-border">
                    {[...(sessions.data ?? [])]
                      .sort((a, b) => b.activation_score - a.activation_score)
                      .slice(0, 12)
                      .map((s) => (
                        <div key={s.id} className="flex items-center gap-3 p-4">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm">
                              {s.user_email ?? s.external_user_id ?? s.visitor_id ?? "anonymous"}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {s.last_route ?? "—"} · {s.conversation_turns} turns · {timeAgo(s.last_seen_at)}
                            </div>
                          </div>
                          {s.activated && (
                            <Badge variant="outline" className="shrink-0 text-xs text-emerald-400">
                              activated
                            </Badge>
                          )}
                          <span className="shrink-0 text-sm font-semibold tabular-nums">{s.activation_score}</span>
                        </div>
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
