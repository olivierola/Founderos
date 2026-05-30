import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ListChecks,
  Route,
  Workflow,
  BarChart3,
  Layers,
  Check,
  Code2,
  Loader2,
  Sparkles,
  Network,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { formatCompact, cn } from "@/lib/utils";
import { AgentPicker } from "./AgentPicker";
import { FlowEditor } from "./FlowEditor";

/* ============================================================ */
/*  Overview — landing page for /agent/onboarding                */
/* ============================================================ */

export function OnboardingOverviewPage() {
  const { workspaceId, projectId, workspace, project } = useCurrentContext();
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);

  const { data: agent } = useQuery({
    queryKey: ["onb_agent_meta", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_agents")
        .select("id, name, public_key, onboarding_enabled")
        .eq("id", agentId!)
        .maybeSingle();
      return data;
    },
  });

  // Whether the latest scan has an enriched semantic map for this project.
  const { data: enrichmentStatus } = useQuery({
    queryKey: ["onb_enrichment_status", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("id, app_structure, created_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const struct = (data?.app_structure ?? {}) as {
        pages?: unknown[];
        enriched?: { pages?: unknown[]; summary?: string };
        enriched_at?: string;
      };
      return {
        has_scan: !!data,
        scanned_pages: (struct.pages ?? []).length,
        has_enriched: !!struct.enriched,
        enriched_pages: (struct.enriched?.pages ?? []).length,
        enriched_summary: struct.enriched?.summary ?? null,
        enriched_at: struct.enriched_at ?? null,
        scan_result_id: data?.id ?? null,
      };
    },
  });

  async function enrich() {
    if (!workspaceId || !projectId) return;
    setEnriching(true);
    try {
      await callEdge("enrich-app-structure", {
        workspace_id: workspaceId,
        project_id: projectId,
      });
      await queryClient.invalidateQueries({ queryKey: ["onb_enrichment_status", projectId] });
    } catch (e) {
      alert("Enrichment failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setEnriching(false);
    }
  }

  const { data: counts } = useQuery({
    queryKey: ["onb_counts", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const flows = await supabase
        .from("rag_onboarding_flows")
        .select("kind", { count: "exact" })
        .eq("agent_id", agentId!);
      const runs = await supabase
        .from("rag_onboarding_runs")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agentId!);
      const flowList = (flows.data ?? []) as { kind: string }[];
      return {
        flows: flowList.filter((f) => f.kind === "flow").length,
        tours: flowList.filter((f) => f.kind === "tour").length,
        checklists: flowList.filter((f) => f.kind === "checklist").length,
        runs: runs.count ?? 0,
      };
    },
  });

  if (!workspaceId || !projectId) return <PageHeader title="Onboarding" />;

  return (
    <div>
      <PageHeader
        title="Onboarding"
        description="Design flows, tours and checklists that the RAG agent runs to onboard your SaaS users."
        actions={
          <AgentPicker
            projectId={projectId}
            selectedAgentId={agentId}
            onSelect={setAgentId}
          />
        }
      />

      {!agentId ? null : (
        <div className="space-y-4">
          {/* Status banner — onboarding is activated per-agent in the agent's Settings tab. */}
          {agent && (
            <Card className={agent.onboarding_enabled ? "" : "border-amber-500/40 bg-amber-500/5"}>
              <CardContent className="flex items-start justify-between gap-3 p-4 text-sm">
                <div>
                  <div className="font-medium">
                    {agent.onboarding_enabled
                      ? "Onboarding is active for this agent."
                      : "Onboarding is disabled for this agent."}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Onboarding is enabled per-agent — toggle it in the agent's Settings tab.
                  </div>
                </div>
                {agentId && workspace?.slug && project?.slug && (
                  <Link
                    to={`/app/${workspace.slug}/${project.slug}/agent/builder/${agentId}/settings`}
                    className="shrink-0"
                  >
                    <Button size="sm" variant="outline">
                      Open agent settings
                    </Button>
                  </Link>
                )}
              </CardContent>
            </Card>
          )}

          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiTile icon={Workflow} label="Flows" value={counts?.flows ?? 0} />
            <KpiTile icon={Route} label="Tours" value={counts?.tours ?? 0} />
            <KpiTile icon={ListChecks} label="Checklists" value={counts?.checklists ?? 0} />
            <KpiTile icon={Layers} label="Total runs" value={counts?.runs ?? 0} />
          </div>

          {/* App structure (semantic map for dynamic onboarding) */}
          <Card>
            <CardContent className="space-y-3 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <Network className="h-4 w-4" /> App structure
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    The agent uses an enriched map of your SaaS pages and actions to drive dynamic
                    onboarding. Run an enrichment after each new code scan.
                  </p>
                </div>
                <Button size="sm" onClick={enrich} disabled={enriching || !enrichmentStatus?.has_scan}>
                  {enriching ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {enrichmentStatus?.has_enriched ? "Re-enrich" : "Enrich now"}
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatTile
                  label="Scanned pages"
                  value={enrichmentStatus?.scanned_pages ?? 0}
                  hint={!enrichmentStatus?.has_scan ? "No scan yet" : undefined}
                />
                <StatTile
                  label="Enriched pages"
                  value={enrichmentStatus?.enriched_pages ?? 0}
                  hint={enrichmentStatus?.has_enriched ? "Ready for the agent" : "Not enriched yet"}
                />
                <StatTile
                  label="Last enrichment"
                  value={
                    enrichmentStatus?.enriched_at
                      ? new Date(enrichmentStatus.enriched_at).toLocaleDateString()
                      : "—"
                  }
                />
              </div>

              {enrichmentStatus?.enriched_summary && (
                <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs">
                  <span className="font-medium text-foreground">Summary: </span>
                  {enrichmentStatus.enriched_summary}
                </div>
              )}

              {!enrichmentStatus?.has_scan && (
                <p className="text-xs text-amber-400">
                  Run a code scan in <span className="font-mono">Code → Repositories</span> first.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Reminder: embed lives in the agent Widget tab */}
          <Card className="border-dashed">
            <CardContent className="flex items-start justify-between gap-3 p-4 text-xs text-muted-foreground">
              <p>
                The widget snippet that ships onboarding to your SaaS lives in the
                <span className="mx-1 font-medium text-foreground">agent's Widget tab</span>
                — open the agent and copy the embed code from there.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function KpiTile({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="text-2xl font-semibold tabular-nums">{formatCompact(value)}</div>
      </CardContent>
    </Card>
  );
}

/* ============================================================ */
/*  Flows tab                                                    */
/* ============================================================ */

export function OnboardingFlowsPage() {
  return (
    <KindPage
      kind="flow"
      title="Onboarding flows"
      description="Conversational sequences the agent plays when a trigger fires (signup, first login, etc.)."
      emptyTitle="No flow yet"
      emptyDescription="Create a flow and add steps for the agent to walk users through."
    />
  );
}

/* ============================================================ */
/*  Tours tab                                                    */
/* ============================================================ */

export function OnboardingToursPage() {
  return (
    <KindPage
      kind="tour"
      title="Guided tours"
      description="UI tours that highlight specific elements on specific pages. Steps include a route and a CSS selector."
      emptyTitle="No tour yet"
      emptyDescription="Tours let the agent point at concrete UI elements on a given page."
    />
  );
}

/* ============================================================ */
/*  Checklist tab                                                */
/* ============================================================ */

export function OnboardingChecklistPage() {
  return (
    <KindPage
      kind="checklist"
      title="Activation checklist"
      description="Tasks the user must complete to be considered activated. Auto-checks on the matching event."
      emptyTitle="No checklist yet"
      emptyDescription="Build the list of activation milestones — they tick off automatically when the matching event fires."
    />
  );
}

function KindPage({
  kind,
  title,
  description,
  emptyTitle,
  emptyDescription,
}: {
  kind: "flow" | "tour" | "checklist";
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const { workspaceId, projectId } = useCurrentContext();
  const [agentId, setAgentId] = useState<string | null>(null);

  return (
    <div>
      <PageHeader
        title={title}
        description={description}
        actions={
          projectId ? (
            <AgentPicker projectId={projectId} selectedAgentId={agentId} onSelect={setAgentId} />
          ) : null
        }
      />

      {workspaceId && projectId && agentId && (
        <FlowEditor
          agentId={agentId}
          workspaceId={workspaceId}
          projectId={projectId}
          kind={kind}
          emptyTitle={emptyTitle}
          emptyDescription={emptyDescription}
        />
      )}
    </div>
  );
}

/* ============================================================ */
/*  Analytics tab                                                */
/* ============================================================ */

interface RunRow {
  id: string;
  flow_id: string;
  status: string;
  current_step_position: number;
  started_at: string;
  last_activity_at: string;
  completed_at: string | null;
}

interface FlowRow {
  id: string;
  name: string;
  kind: string;
}

export function OnboardingAnalyticsPage() {
  const { projectId } = useCurrentContext();
  const [agentId, setAgentId] = useState<string | null>(null);

  const { data: flows } = useQuery({
    queryKey: ["onb_flows_for_analytics", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_onboarding_flows")
        .select("id, name, kind")
        .eq("agent_id", agentId!);
      return (data ?? []) as FlowRow[];
    },
  });

  const { data: runs } = useQuery({
    queryKey: ["onb_runs", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_onboarding_runs")
        .select("id, flow_id, status, current_step_position, started_at, last_activity_at, completed_at")
        .eq("agent_id", agentId!)
        .order("started_at", { ascending: false })
        .limit(500);
      return (data ?? []) as RunRow[];
    },
  });

  const byFlow = useMemo(() => {
    const m = new Map<string, { flow: FlowRow; total: number; completed: number; abandoned: number; inProgress: number; avgStep: number }>();
    (flows ?? []).forEach((f) => m.set(f.id, { flow: f, total: 0, completed: 0, abandoned: 0, inProgress: 0, avgStep: 0 }));
    (runs ?? []).forEach((r) => {
      const entry = m.get(r.flow_id);
      if (!entry) return;
      entry.total += 1;
      if (r.status === "completed") entry.completed += 1;
      else if (r.status === "abandoned") entry.abandoned += 1;
      else entry.inProgress += 1;
      entry.avgStep += r.current_step_position;
    });
    m.forEach((v) => {
      v.avgStep = v.total > 0 ? v.avgStep / v.total : 0;
    });
    return Array.from(m.values()).filter((v) => v.total > 0);
  }, [flows, runs]);

  const totals = useMemo(() => {
    return {
      total: runs?.length ?? 0,
      completed: (runs ?? []).filter((r) => r.status === "completed").length,
      abandoned: (runs ?? []).filter((r) => r.status === "abandoned").length,
      inProgress: (runs ?? []).filter((r) => r.status === "in_progress").length,
    };
  }, [runs]);

  return (
    <div>
      <PageHeader
        title="Onboarding analytics"
        description="Completion, drop-off and time-to-finish for each onboarding flow."
        actions={
          projectId ? <AgentPicker projectId={projectId} selectedAgentId={agentId} onSelect={setAgentId} /> : null
        }
      />

      {!agentId ? null : (
        <div className="space-y-4">
          {/* Totals */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiTile icon={Layers} label="Total runs" value={totals.total} />
            <KpiTile icon={Check} label="Completed" value={totals.completed} />
            <KpiTile icon={Route} label="In progress" value={totals.inProgress} />
            <KpiTile icon={BarChart3} label="Abandoned" value={totals.abandoned} />
          </div>

          {/* Per-flow performance */}
          {byFlow.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="No runs yet"
              description="Trigger an onboarding flow from the widget or via the API to see analytics here."
            />
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">Flow</th>
                      <th className="px-4 py-3 font-medium">Kind</th>
                      <th className="px-4 py-3 font-medium">Total</th>
                      <th className="px-4 py-3 font-medium">Completion</th>
                      <th className="px-4 py-3 font-medium">Avg step reached</th>
                      <th className="px-4 py-3 font-medium">Abandoned</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {byFlow.map((entry) => {
                      const compRate = entry.total > 0 ? entry.completed / entry.total : 0;
                      return (
                        <tr key={entry.flow.id} className="hover:bg-secondary/30">
                          <td className="px-4 py-3 font-medium">{entry.flow.name}</td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className="text-[10px] uppercase">{entry.flow.kind}</Badge>
                          </td>
                          <td className="px-4 py-3 tabular-nums">{entry.total}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary">
                                <div
                                  className={cn(
                                    "h-full rounded-full",
                                    compRate >= 0.5 ? "bg-[hsl(var(--accent-2))]" : "bg-amber-400",
                                  )}
                                  style={{ width: `${compRate * 100}%` }}
                                />
                              </div>
                              <span className="text-xs tabular-nums">{(compRate * 100).toFixed(0)}%</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                            {entry.avgStep.toFixed(1)}
                          </td>
                          <td className="px-4 py-3 tabular-nums">{entry.abandoned}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Recent runs */}
          {(runs ?? []).length > 0 && (
            <Card>
              <CardContent className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-medium">Recent runs</span>
                  <Badge variant="outline">{(runs ?? []).length} loaded</Badge>
                </div>
                <ul className="divide-y divide-border text-sm">
                  {(runs ?? []).slice(0, 15).map((r) => {
                    const flow = flows?.find((f) => f.id === r.flow_id);
                    return (
                      <li key={r.id} className="flex items-center justify-between py-2">
                        <div className="flex items-center gap-2">
                          <Code2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs">{flow?.name ?? r.flow_id}</span>
                          <Badge
                            variant={
                              r.status === "completed"
                                ? "success"
                                : r.status === "abandoned"
                                  ? "destructive"
                                  : "outline"
                            }
                            className="text-[10px]"
                          >
                            {r.status}
                          </Badge>
                        </div>
                        <span className="text-[11px] text-muted-foreground">
                          step {r.current_step_position} · {new Date(r.last_activity_at).toLocaleString()}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
