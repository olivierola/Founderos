import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Server, Wrench, ShieldCheck, Activity, ArrowRight, Loader2,
  CheckCircle2, XCircle, Clock, AlertTriangle,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { useOpsUrl } from "./hooks";
import type { OpsJob, OpsServer } from "./types";

export function OpsOverviewPage() {
  const { projectId } = useCurrentContext();
  const url = useOpsUrl();

  const { data: servers, isLoading: loadingServers } = useQuery({
    queryKey: ["ops_servers_overview", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_servers")
        .select("id, name, environment, status, security_score, last_checked_at, ip_address")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as Pick<OpsServer, "id" | "name" | "environment" | "status" | "security_score" | "last_checked_at" | "ip_address">[];
    },
  });

  const { data: recentJobs } = useQuery({
    queryKey: ["ops_jobs_recent", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_jobs")
        .select("id, job_type, status, risk_level, created_at, finished_at, server_id")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(8);
      return (data ?? []) as Pick<OpsJob, "id" | "job_type" | "status" | "risk_level" | "created_at" | "finished_at" | "server_id">[];
    },
    refetchInterval: 5000,
  });

  // Unified deployments — external sync + FounderOS-driven. This makes the
  // Ops Overview the single source of truth for "what shipped recently".
  const { data: recentDeployments } = useQuery({
    queryKey: ["ops_overview_deployments", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("deployments")
        .select("id, provider, environment, state, url, sha, created_at_provider, created_at, source, ops_job_id")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(8);
      return (data ?? []) as Array<{
        id: string; provider: string; environment: string | null; state: string | null;
        url: string | null; sha: string | null;
        created_at_provider: string | null; created_at: string;
        source: string | null; ops_job_id: string | null;
      }>;
    },
    refetchInterval: 8000,
  });

  const { data: jobStats } = useQuery({
    queryKey: ["ops_jobs_stats", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      const [{ count: total }, { count: succeeded }, { count: failed }, { count: pending }] = await Promise.all([
        supabase.from("ops_jobs").select("id", { count: "exact", head: true }).eq("project_id", projectId!).gte("created_at", since),
        supabase.from("ops_jobs").select("id", { count: "exact", head: true }).eq("project_id", projectId!).eq("status", "succeeded").gte("created_at", since),
        supabase.from("ops_jobs").select("id", { count: "exact", head: true }).eq("project_id", projectId!).eq("status", "failed").gte("created_at", since),
        supabase.from("ops_jobs").select("id", { count: "exact", head: true }).eq("project_id", projectId!).in("status", ["awaiting_approval", "queued", "running"]),
      ]);
      return { total: total ?? 0, succeeded: succeeded ?? 0, failed: failed ?? 0, pending: pending ?? 0 };
    },
  });

  const { data: checkStats } = useQuery({
    queryKey: ["ops_check_stats", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const [{ count: passed }, { count: failed }] = await Promise.all([
        supabase.from("ops_check_runs").select("id", { count: "exact", head: true }).eq("project_id", projectId!).eq("status", "passed").gte("created_at", since),
        supabase.from("ops_check_runs").select("id", { count: "exact", head: true }).eq("project_id", projectId!).eq("status", "failed").gte("created_at", since),
      ]);
      return { passed: passed ?? 0, failed: failed ?? 0 };
    },
  });

  const avgSecurity = servers && servers.length > 0
    ? Math.round(servers.reduce((s, x) => s + (x.security_score ?? 0), 0) / servers.length)
    : null;

  const onlineCount = servers?.filter((s) => s.status === "online").length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ops Overview"
        description="Bird's-eye view of your infrastructure: servers, jobs, checks, and approvals waiting."
        actions={
          <Link to={url("/devops/servers")}>
            <Button size="sm" className="gap-1.5">
              <Server className="h-4 w-4" /> Manage servers
            </Button>
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          icon={Server}
          label="Servers online"
          value={loadingServers ? "—" : `${onlineCount} / ${servers?.length ?? 0}`}
          hint={servers?.length ? `${servers.length} registered` : "No server yet"}
          to={url("/devops/servers")}
        />
        <StatCard
          icon={ShieldCheck}
          label="Avg security score"
          value={avgSecurity != null ? `${avgSecurity}/100` : "—"}
          hint="Across all servers"
          tone={avgSecurity != null && avgSecurity < 70 ? "warn" : avgSecurity != null && avgSecurity >= 85 ? "good" : undefined}
        />
        <StatCard
          icon={Wrench}
          label="Jobs (7d)"
          value={jobStats?.total?.toString() ?? "—"}
          hint={`${jobStats?.succeeded ?? 0} ok · ${jobStats?.failed ?? 0} failed`}
          to={url("/devops/jobs")}
        />
        <StatCard
          icon={Activity}
          label="Checks (24h)"
          value={`${checkStats?.passed ?? 0} / ${(checkStats?.passed ?? 0) + (checkStats?.failed ?? 0)}`}
          hint={checkStats?.failed ? `${checkStats.failed} failing` : "All passing"}
          tone={checkStats?.failed ? "warn" : "good"}
          to={url("/devops/checks")}
        />
      </div>

      {(jobStats?.pending ?? 0) > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-center justify-between p-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <div>
                <div className="text-sm font-medium">{jobStats!.pending} job{jobStats!.pending > 1 ? "s" : ""} awaiting your attention</div>
                <div className="text-xs text-muted-foreground">Approvals pending, queued, or running.</div>
              </div>
            </div>
            <Link to={url("/devops/jobs")}>
              <Button size="sm" variant="outline" className="gap-1">
                Review <ArrowRight className="h-3 w-3" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Recent deployments</h3>
            <span className="text-[10px] text-muted-foreground">Unified · external syncs + FounderOS-driven</span>
          </div>
          {!recentDeployments || recentDeployments.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">No deployments tracked yet.</p>
          ) : (
            <div className="space-y-1">
              {recentDeployments.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm hover:bg-muted/40">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline" className="text-[10px] capitalize">{d.provider}</Badge>
                    <span className="truncate text-xs text-muted-foreground">{d.environment ?? "?"}</span>
                    {d.url && (
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-xs text-blue-500 hover:underline"
                      >
                        {d.url.replace(/^https?:\/\//, "")}
                      </a>
                    )}
                  </div>
                  <div className="ml-3 flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                    {d.source === "founderos_ops" && (
                      <Badge variant="outline" className="text-[9px] text-blue-500">ops</Badge>
                    )}
                    {d.state && (
                      <span className={cn(
                        "capitalize",
                        ["ready", "succeeded", "ok", "success"].includes(d.state.toLowerCase()) && "text-emerald-500",
                        ["error", "failed", "errored"].includes(d.state.toLowerCase()) && "text-destructive",
                        ["building", "queued", "pending"].includes(d.state.toLowerCase()) && "text-blue-500",
                      )}>{d.state}</span>
                    )}
                    <span>{new Date(d.created_at_provider ?? d.created_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Servers</h3>
              <Link to={url("/devops/servers")} className="text-xs text-muted-foreground hover:text-foreground">
                See all →
              </Link>
            </div>
            {loadingServers ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : !servers || servers.length === 0 ? (
              <EmptyServersHint />
            ) : (
              <div className="space-y-2">
                {servers.slice(0, 5).map((s) => (
                  <Link key={s.id} to={url(`/devops/servers/${s.id}`)} className="block">
                    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 hover:bg-muted/40">
                      <div className="flex min-w-0 items-center gap-2">
                        <ServerStatusDot status={s.status} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{s.name}</div>
                          <div className="truncate text-[11px] text-muted-foreground">{s.ip_address} · {s.environment}</div>
                        </div>
                      </div>
                      <div className="ml-3 text-right text-[11px] text-muted-foreground">
                        {s.security_score != null ? (
                          <span>{s.security_score}/100</span>
                        ) : (
                          <span>—</span>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Recent jobs</h3>
              <Link to={url("/devops/jobs")} className="text-xs text-muted-foreground hover:text-foreground">
                See all →
              </Link>
            </div>
            {!recentJobs || recentJobs.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">No jobs yet.</p>
            ) : (
              <div className="space-y-2">
                {recentJobs.map((j) => <JobRow key={j.id} job={j} />)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  to,
  tone,
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
  to?: string;
  tone?: "good" | "warn";
}) {
  const body = (
    <Card className={cn(
      to && "cursor-pointer transition-colors hover:border-foreground/30",
      tone === "warn" && "border-amber-500/30",
    )}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="h-3.5 w-3.5" /> {label}
        </div>
        <div className={cn(
          "mt-1 text-2xl font-semibold",
          tone === "warn" && "text-amber-500",
          tone === "good" && "text-emerald-500",
        )}>{value}</div>
        {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function ServerStatusDot({ status }: { status: OpsServer["status"] }) {
  const cls = {
    online: "bg-emerald-500",
    offline: "bg-muted-foreground",
    degraded: "bg-amber-500",
    provisioning: "bg-blue-500 animate-pulse",
    error: "bg-destructive",
    unknown: "bg-muted-foreground/50",
  }[status];
  return <span className={cn("h-2 w-2 rounded-full", cls)} />;
}

function JobRow({ job }: { job: Pick<OpsJob, "id" | "job_type" | "status" | "risk_level" | "created_at"> }) {
  const Icon = {
    succeeded: CheckCircle2,
    failed: XCircle,
    running: Loader2,
    queued: Clock,
    awaiting_approval: AlertTriangle,
    approved: Clock,
    draft: Clock,
    cancelled: XCircle,
    rolled_back: AlertTriangle,
  }[job.status];
  const color = {
    succeeded: "text-emerald-500",
    failed: "text-destructive",
    running: "text-blue-500",
    queued: "text-blue-500",
    awaiting_approval: "text-amber-500",
    approved: "text-blue-500",
    draft: "text-muted-foreground",
    cancelled: "text-muted-foreground",
    rolled_back: "text-orange-500",
  }[job.status];
  return (
    <div className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", color, job.status === "running" && "animate-spin")} />
        <span className="truncate font-medium">{job.job_type.replace(/_/g, " ")}</span>
      </div>
      <div className="ml-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant="outline" className="text-[10px] capitalize">{job.risk_level}</Badge>
        <span>{new Date(job.created_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
      </div>
    </div>
  );
}

function EmptyServersHint() {
  const url = useOpsUrl();
  return (
    <div className="rounded-md border border-dashed border-border p-6 text-center">
      <Server className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
      <p className="text-sm font-medium">No server connected</p>
      <p className="mt-1 text-xs text-muted-foreground">Connect a VPS to start generating infra and deploying.</p>
      <Link to={url("/devops/servers")}>
        <Button size="sm" className="mt-3 gap-1.5">
          <Server className="h-3.5 w-3.5" /> Add a server
        </Button>
      </Link>
    </div>
  );
}
