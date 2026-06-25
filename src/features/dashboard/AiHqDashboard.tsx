import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot, Target, Package, ShieldCheck, Clock, CheckCircle, XCircle,
  TrendingUp, Activity, Users, FolderKanban, Loader2, ChevronRight,
  Zap, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { fetchModuleProjects } from "@/features/module-projects/moduleProjectModel";
import { MODULE_PROJECT_CONFIGS } from "@/lib/module-project-config";

interface Agent { id: string; name: string; description: string | null; avatar_emoji: string | null; accent_color: string | null; chat_enabled: boolean; mission_enabled: boolean; created_at: string }
interface Mission { id: string; agent_id: string; title: string; status: string; created_at: string }
interface Run { id: string; mission_id: string; status: string; created_at: string; finished_at: string | null }
interface Deliverable { id: string; run_id: string; kind: string; title: string; created_at: string }
interface Approval { id: string; agent_id: string; tool_name: string; reason: string | null; status: string; requested_at: string; action_kind: string; payload: any }

export function AiHqDashboard() {
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { projectId } = useCurrentContext();
  const [deciding, setDeciding] = useState<string | null>(null);

  const { data: agents, isLoading: loadingAgents } = useQuery({
    queryKey: ["hq_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("id, name, description, avatar_emoji, accent_color, chat_enabled, mission_enabled, created_at")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Agent[];
    },
  });

  const { data: missions } = useQuery({
    queryKey: ["hq_missions", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_missions").select("id, agent_id, title, status, created_at")
        .eq("project_id", projectId!).order("created_at", { ascending: false }).limit(50);
      return (data ?? []) as Mission[];
    },
  });

  const { data: recentRuns } = useQuery({
    queryKey: ["hq_runs", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_runs").select("id, mission_id, status, created_at, finished_at")
        .eq("project_id", projectId!).order("created_at", { ascending: false }).limit(30);
      return (data ?? []) as Run[];
    },
  });

  const { data: deliverables } = useQuery({
    queryKey: ["hq_deliverables", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_deliverables").select("id, run_id, kind, title, created_at")
        .eq("project_id", projectId!).order("created_at", { ascending: false }).limit(20);
      return (data ?? []) as Deliverable[];
    },
  });

  const { data: approvals } = useQuery({
    queryKey: ["hq_approvals", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_approvals")
        .select("id, agent_id, tool_name, reason, status, requested_at, action_kind, payload")
        .eq("project_id", projectId!).eq("status", "pending")
        .order("requested_at", { ascending: false });
      return (data ?? []) as Approval[];
    },
  });

  const { data: moduleProjects } = useQuery({
    queryKey: ["hq_module_projects", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("module_projects").select("id, module_slug, project_type, name, status")
        .eq("project_id", projectId!).neq("status", "archived").order("updated_at", { ascending: false }).limit(30);
      return (data ?? []) as Array<{ id: string; module_slug: string; project_type: string; name: string; status: string }>;
    },
  });

  const agentCount = (agents ?? []).length;
  const activeMissions = (missions ?? []).filter((m) => m.status === "active" || m.status === "running").length;
  const deliverableCount = (deliverables ?? []).length;
  const pendingApprovals = (approvals ?? []).length;
  const runningRuns = (recentRuns ?? []).filter((r) => r.status === "running").length;
  const agentById = Object.fromEntries((agents ?? []).map((a) => [a.id, a]));

  // Group module projects by module
  const deptGroups = Object.entries(
    (moduleProjects ?? []).reduce<Record<string, typeof moduleProjects>>((acc, mp) => {
      (acc[mp!.module_slug] ??= []).push(mp!);
      return acc;
    }, {})
  );

  if (loadingAgents) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6 px-6 py-6">
      {/* ── Header ── */}
      <div>
        <h1 className="text-xl font-bold">AI Headquarters</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your AI workforce at a glance — agents, missions, deliverables, and decisions.</p>
      </div>

      {/* ── KPI Bar ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard icon={Bot} label="Agents" value={agentCount} color="#8b5cf6" />
        <KpiCard icon={Target} label="Active Missions" value={activeMissions} color="#3b82f6" />
        <KpiCard icon={Zap} label="Running" value={runningRuns} color="#f59e0b" />
        <KpiCard icon={Package} label="Deliverables" value={deliverableCount} color="#10b981" />
        <KpiCard icon={ShieldCheck} label="Awaiting Approval" value={pendingApprovals} color={pendingApprovals > 0 ? "#ef4444" : "#6b7280"} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ── Agent Roster (2/3 width) ── */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-1.5"><Bot className="h-4 w-4 text-muted-foreground" /> AI Workforce</h2>
            <Button size="sm" variant="outline" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent`)}>
              <Users className="mr-1 h-3.5 w-3.5" /> Hire agent
            </Button>
          </div>

          {agentCount === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-12 text-center">
              <Bot className="mx-auto h-10 w-10 text-muted-foreground/30" />
              <p className="mt-3 text-sm text-muted-foreground">No agents hired yet. Hire your first AI team member.</p>
              <Button size="sm" className="mt-3" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent`)}>
                Hire an agent
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(agents ?? []).map((a) => {
                const agentMissions = (missions ?? []).filter((m) => m.agent_id === a.id);
                const active = agentMissions.filter((m) => m.status === "active" || m.status === "running").length;
                const completed = agentMissions.filter((m) => m.status === "completed").length;
                const hasApproval = (approvals ?? []).some((ap) => ap.agent_id === a.id);

                return (
                  <button key={a.id}
                    onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${a.id}/chat`)}
                    className="flex items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-md">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg" style={{ backgroundColor: (a.accent_color ?? "#6366f1") + "20" }}>
                      {a.avatar_emoji ?? "🤖"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold">{a.name}</span>
                        {hasApproval && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
                      </div>
                      {a.description && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{a.description}</p>}
                      <div className="mt-1.5 flex items-center gap-2 text-[10px]">
                        {active > 0 ? (
                          <span className="flex items-center gap-1 text-amber-500"><Activity className="h-3 w-3" /> {active} active</span>
                        ) : (
                          <span className="flex items-center gap-1 text-muted-foreground"><Clock className="h-3 w-3" /> Idle</span>
                        )}
                        {completed > 0 && <span className="flex items-center gap-1 text-emerald-500"><CheckCircle className="h-3 w-3" /> {completed} done</span>}
                      </div>
                    </div>
                    <ChevronRight className="mt-1 h-4 w-4 text-muted-foreground" />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Right column: Approvals + Activity ── */}
        <div className="space-y-4">
          {/* Approval Queue */}
          <div>
            <h2 className="mb-2 text-sm font-semibold flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" /> Approval Queue
              {pendingApprovals > 0 && <span className="rounded-full bg-destructive/15 px-1.5 py-0.5 text-[10px] font-bold text-destructive">{pendingApprovals}</span>}
            </h2>
            {pendingApprovals === 0 ? (
              <p className="rounded-lg border border-border px-3 py-4 text-center text-xs text-muted-foreground">No pending approvals</p>
            ) : (
              <div className="space-y-2">
                {(approvals ?? []).map((ap) => {
                  const agent = agentById[ap.agent_id];
                  const isDeciding = deciding === ap.id;
                  async function decide(decision: "approve" | "reject") {
                    setDeciding(ap.id);
                    try {
                      await callEdge("internal-agent-approve", { approval_id: ap.id, decision });
                      queryClient.invalidateQueries({ queryKey: ["hq_approvals"] });
                      queryClient.invalidateQueries({ queryKey: ["hq_runs"] });
                      queryClient.invalidateQueries({ queryKey: ["hq_deliverables"] });
                    } catch (e: any) {
                      alert(e?.message ?? "Failed");
                    } finally {
                      setDeciding(null);
                    }
                  }
                  return (
                    <div key={ap.id} className="rounded-xl border border-border bg-card p-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm"
                          style={{ backgroundColor: (agent?.accent_color ?? "#6366f1") + "20" }}>
                          {agent?.avatar_emoji ?? "🤖"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-xs">
                            <span className="font-semibold">{agent?.name ?? "Agent"}</span>
                            <span className="text-muted-foreground">wants to</span>
                            <span className="font-medium text-foreground">{ap.tool_name}</span>
                          </div>
                          {ap.reason && <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">{ap.reason}</p>}
                        </div>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(ap.requested_at)}</span>
                      </div>
                      <div className="mt-2.5 flex items-center gap-2">
                        <Button size="sm" className="h-7 flex-1 text-xs bg-emerald-600 hover:bg-emerald-700" disabled={isDeciding}
                          onClick={() => decide("approve")}>
                          {isDeciding ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle className="mr-1 h-3 w-3" />} Approve
                        </Button>
                        <Button size="sm" variant="destructive" className="h-7 flex-1 text-xs" disabled={isDeciding}
                          onClick={() => decide("reject")}>
                          <XCircle className="mr-1 h-3 w-3" /> Reject
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent Activity */}
          <div>
            <h2 className="mb-2 text-sm font-semibold flex items-center gap-1.5"><Activity className="h-4 w-4 text-muted-foreground" /> Recent Activity</h2>
            <div className="space-y-1">
              {(deliverables ?? []).slice(0, 8).map((d) => (
                <div key={d.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-secondary/40">
                  <Package className="h-3 w-3 shrink-0 text-emerald-500" />
                  <span className="truncate flex-1">{d.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(d.created_at)}</span>
                </div>
              ))}
              {(recentRuns ?? []).filter((r) => r.status === "completed" || r.status === "failed").slice(0, 4).map((r) => (
                <div key={r.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-secondary/40">
                  {r.status === "completed"
                    ? <CheckCircle className="h-3 w-3 shrink-0 text-emerald-500" />
                    : <XCircle className="h-3 w-3 shrink-0 text-destructive" />}
                  <span className="truncate flex-1">Run {r.status}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(r.created_at)}</span>
                </div>
              ))}
              {(deliverables ?? []).length === 0 && (recentRuns ?? []).length === 0 && (
                <p className="py-4 text-center text-xs text-muted-foreground">No activity yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Departments (active projects by module) ── */}
      {deptGroups.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold flex items-center gap-1.5"><FolderKanban className="h-4 w-4 text-muted-foreground" /> Departments</h2>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {deptGroups.map(([slug, projects]) => {
              const config = MODULE_PROJECT_CONFIGS[slug];
              return (
                <button key={slug}
                  onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/${slug}`)}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-left hover:bg-secondary/30">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{config?.label ?? slug}</div>
                    <div className="text-[11px] text-muted-foreground">{projects!.length} active project{projects!.length > 1 ? "s" : ""}</div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function KpiCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: number; color: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ backgroundColor: color + "20" }}>
          <Icon className="h-4 w-4" style={{ color }} />
        </div>
        <div>
          <div className="text-2xl font-bold">{value}</div>
          <div className="text-[11px] text-muted-foreground">{label}</div>
        </div>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000) return "now";
  if (d < 3600000) return `${Math.floor(d / 60000)}m`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h`;
  return `${Math.floor(d / 86400000)}d`;
}
