import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Wrench, Loader2, CheckCircle2, XCircle, Clock, AlertTriangle,
  PlayCircle, RotateCcw, ChevronRight, Filter, X, ShieldAlert,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { JOB_TYPE_LABEL, RISK_COLOR } from "./types";
import type { OpsJob, OpsJobLog, OpsJobStatus } from "./types";

const STATUS_FILTERS: { value: OpsJobStatus | "all" | "open"; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "awaiting_approval", label: "Awaiting approval" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "all", label: "All" },
];

export function OpsJobsPage() {
  const { projectId } = useCurrentContext();
  const [filter, setFilter] = useState<OpsJobStatus | "all" | "open">("open");
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  const { data: jobs } = useQuery({
    queryKey: ["ops_jobs_list", projectId, filter],
    enabled: !!projectId,
    queryFn: async () => {
      let q = supabase
        .from("ops_jobs")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (filter === "open") {
        q = q.in("status", ["awaiting_approval", "queued", "running"]);
      } else if (filter !== "all") {
        q = q.eq("status", filter);
      }
      const { data } = await q;
      return (data ?? []) as OpsJob[];
    },
    refetchInterval: 3000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jobs & Audit"
        description="Every action performed by the Ops runner is a job. Approve, monitor, replay, rollback."
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <Filter className="h-3.5 w-3.5 text-muted-foreground" />
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              filter === f.value
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted-foreground/20",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!jobs || jobs.length === 0 ? (
        <EmptyState icon={Wrench} title="No job matches this filter" />
      ) : (
        <div className="space-y-2">
          {jobs.map((j) => <JobRow key={j.id} job={j} onOpen={() => setOpenJobId(j.id)} />)}
        </div>
      )}

      {openJobId && (
        <JobDrawer jobId={openJobId} onClose={() => setOpenJobId(null)} />
      )}
    </div>
  );
}

function JobRow({ job, onOpen }: { job: OpsJob; onOpen: () => void }) {
  const StatusIcon = {
    succeeded: CheckCircle2,
    failed: XCircle,
    running: Loader2,
    queued: Clock,
    awaiting_approval: AlertTriangle,
    approved: Clock,
    draft: Clock,
    cancelled: XCircle,
    rolled_back: RotateCcw,
  }[job.status];

  const statusColor = {
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

  const duration = job.started_at && job.finished_at
    ? Math.round((new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) / 1000)
    : null;

  return (
    <Card onClick={onOpen} className="cursor-pointer transition-colors hover:border-foreground/30">
      <CardContent className="flex items-center justify-between gap-3 p-3">
        <div className="flex min-w-0 items-center gap-3">
          <StatusIcon className={cn("h-4 w-4 shrink-0", statusColor, job.status === "running" && "animate-spin")} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{JOB_TYPE_LABEL[job.job_type]}</div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Badge variant="outline" className={cn("text-[10px] capitalize", RISK_COLOR[job.risk_level])}>
                {job.risk_level}
              </Badge>
              <span className="capitalize">{job.status.replace(/_/g, " ")}</span>
              {duration != null && <span>· {duration}s</span>}
              <span>· {new Date(job.created_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
            </div>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Job drawer — full detail with live logs + approve/cancel
// ============================================================================

function JobDrawer({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const logsEnd = useRef<HTMLDivElement>(null);

  const { data: job } = useQuery({
    queryKey: ["ops_job", jobId],
    queryFn: async () => {
      const { data } = await supabase.from("ops_jobs").select("*").eq("id", jobId).maybeSingle();
      return data as OpsJob | null;
    },
    refetchInterval: 2000,
  });

  const { data: logs } = useQuery({
    queryKey: ["ops_job_logs", jobId],
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_job_logs")
        .select("*")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true })
        .limit(2000);
      return (data ?? []) as OpsJobLog[];
    },
    refetchInterval: 2000,
  });

  useEffect(() => {
    if (logsEnd.current) logsEnd.current.scrollIntoView({ behavior: "smooth" });
  }, [logs?.length]);

  if (!job) return null;

  async function approve() {
    try {
      await callEdge("ops-approve-job", { job_id: jobId, decision: "approve" });
      queryClient.invalidateQueries({ queryKey: ["ops_job", jobId] });
      queryClient.invalidateQueries({ queryKey: ["ops_jobs_list"] });
    } catch (e: any) {
      alert("Could not approve: " + (e?.message ?? "edge not deployed"));
    }
  }

  async function cancel() {
    if (!confirm("Cancel this job?")) return;
    try {
      await callEdge("ops-approve-job", { job_id: jobId, decision: "cancel" });
      queryClient.invalidateQueries({ queryKey: ["ops_job", jobId] });
      queryClient.invalidateQueries({ queryKey: ["ops_jobs_list"] });
    } catch (e: any) {
      // Fallback: directly mark cancelled.
      await supabase.from("ops_jobs").update({ status: "cancelled" }).eq("id", jobId);
      queryClient.invalidateQueries({ queryKey: ["ops_job", jobId] });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-foreground/30 backdrop-blur-sm" onClick={onClose} />
      <div className="flex w-full max-w-3xl flex-col bg-background shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{JOB_TYPE_LABEL[job.job_type]}</h3>
            <p className="text-[11px] text-muted-foreground">
              {job.id.slice(0, 8)} · created {new Date(job.created_at).toLocaleString()}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>

        <div className="border-b border-border bg-muted/20 px-4 py-3">
          <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
            <Field label="Status" value={job.status.replace(/_/g, " ")} />
            <Field label="Risk" value={job.risk_level} colorClass={RISK_COLOR[job.risk_level]} />
            <Field label="Autonomy" value={job.autonomy_mode} />
            <Field label="Attempts" value={String(job.attempts)} />
          </div>

          {job.status === "awaiting_approval" && (
            <div className="mt-3 flex items-center justify-between rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-amber-500" />
                <span className="text-xs">Awaiting human approval before the runner picks it up.</span>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={cancel}>Cancel</Button>
                <Button size="sm" onClick={approve} className="gap-1">
                  <PlayCircle className="h-3.5 w-3.5" /> Approve & queue
                </Button>
              </div>
            </div>
          )}

          {job.status === "running" && (
            <div className="mt-2 text-xs text-muted-foreground">
              <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
              Picked up by <span className="font-mono">{job.runner_id ?? "unknown"}</span>
            </div>
          )}

          {job.error_message && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {job.error_message}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-black/90 p-3 font-mono text-[11px] text-emerald-200">
          {!logs || logs.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">No logs yet.</div>
          ) : (
            logs.map((l) => (
              <div key={l.id} className={cn(
                "flex gap-2 py-px",
                l.level === "error" && "text-rose-400",
                l.level === "warn" && "text-amber-300",
                l.level === "stderr" && "text-rose-300",
              )}>
                <span className="shrink-0 text-muted-foreground/60">{new Date(l.created_at).toISOString().slice(11, 19)}</span>
                {l.step && <span className="shrink-0 font-semibold text-blue-300">[{l.step}]</span>}
                <span className="whitespace-pre-wrap break-words">{l.message}</span>
              </div>
            ))
          )}
          <div ref={logsEnd} />
        </div>

        <div className="border-t border-border bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
          <details>
            <summary className="cursor-pointer">Input payload</summary>
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-background/60 p-2">{JSON.stringify(job.input, null, 2)}</pre>
          </details>
          {Object.keys(job.result ?? {}).length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer">Result</summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded bg-background/60 p-2">{JSON.stringify(job.result, null, 2)}</pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, colorClass }: { label: string; value: string; colorClass?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("font-medium capitalize", colorClass)}>{value}</div>
    </div>
  );
}
