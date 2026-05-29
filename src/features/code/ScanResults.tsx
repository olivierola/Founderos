import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ScanLine, Loader2, Package, Lock, Box, ShieldAlert, Sparkles, Lightbulb, Gauge, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ServiceBadge } from "@/components/ServiceBadge";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface ScanResultRow {
  id: string;
  created_at: string;
  summary: {
    project_type?: string;
    detected_frontend?: { framework?: string | null; ui?: string[]; language?: string };
    backend_framework?: string | null;
    total_dependencies?: number;
    manifests_found?: string[];
  };
  dependencies: { name: string; version: string; category: string; risk: string }[];
  env_vars: { key: string; detected_service: string | null; sensitivity: string }[];
  services: { service: string; category: string }[];
  security_findings: { type: string; severity: string; message: string }[];
  ai_analysis: AiAnalysis | null;
  repositories: { full_name: string } | null;
}

interface AiRisk {
  severity: "low" | "medium" | "high" | "critical";
  category: string;
  message: string;
}

interface AiRecommendation {
  title: string;
  category: string;
  explanation: string;
  estimated_savings?: number | null;
}

interface AiAnalysis {
  status?: "pending" | string;
  project_type?: string;
  stack_summary?: string;
  key_risks?: AiRisk[];
  recommendations?: AiRecommendation[];
  code_health_score?: number;
  _meta?: { provider?: string; model?: string };
}

export function ScanResultsPage() {
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [deleteScan, setDeleteScan] = useState<{ id: string; label: string } | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);

  async function cancelJob(jobId: string) {
    setActionError(null);
    const { error } = await supabase.from("scan_jobs").delete().eq("id", jobId);
    if (error) {
      setActionError(`Could not remove job: ${error.message}`);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["scan-jobs-pending", projectId] });
    queryClient.invalidateQueries({ queryKey: ["scan-results", projectId] });
  }

  async function deleteScanResult(id: string) {
    const { error } = await supabase.from("scan_results").delete().eq("id", id);
    if (error) throw new Error(error.message);
    queryClient.invalidateQueries({ queryKey: ["scan-results", projectId] });
  }

  const { data, isLoading } = useQuery({
    queryKey: ["scan-results", projectId],
    enabled: !!projectId,
    refetchInterval: 5_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("*, repositories(full_name)")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(10);
      return (data ?? []) as unknown as ScanResultRow[];
    },
  });

  const { data: pendingJobs } = useQuery({
    queryKey: ["scan-jobs-pending", projectId],
    enabled: !!projectId,
    refetchInterval: 3_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_jobs")
        .select("*, repositories(full_name)")
        .eq("project_id", projectId!)
        .in("status", ["pending", "running", "failed"])
        .order("created_at", { ascending: false })
        .limit(5);
      return data ?? [];
    },
  });

  return (
    <div>
      <PageHeader title="Scan Results" description="Latest static analysis runs for your repositories." />

      {actionError && <p className="mb-3 text-sm text-destructive">{actionError}</p>}

      {pendingJobs && pendingJobs.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Active jobs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendingJobs.map((j: any) => (
              <div key={j.id} className="flex items-center justify-between gap-2 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  {j.status === "running" || j.status === "pending" ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  ) : (
                    <ShieldAlert className="h-3 w-3 shrink-0 text-destructive" />
                  )}
                  <span className="truncate">{j.repositories?.full_name}</span>
                  <Badge variant={j.status === "failed" ? "destructive" : "secondary"}>{j.status}</Badge>
                  {j.progress?.step && <span className="text-xs text-muted-foreground">· {j.progress.step}</span>}
                </div>
                <div className="flex items-center gap-2">
                  {j.error_message && <span className="truncate text-xs text-destructive">{j.error_message}</span>}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    title={j.status === "failed" ? "Remove job" : "Cancel & remove job"}
                    onClick={() => cancelJob(j.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading scan results…" />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={ScanLine}
          title="No scans yet"
          description="Connect GitHub and run your first scan from the Repositories tab."
        />
      ) : (
        <div className="space-y-6">
          {data.map((scan) => (
            <Card key={scan.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span className="truncate">{scan.repositories?.full_name ?? "—"}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs font-normal text-muted-foreground">
                      {new Date(scan.created_at).toLocaleString()}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      title="Delete this scan result"
                      onClick={() =>
                        setDeleteScan({ id: scan.id, label: scan.repositories?.full_name ?? "this scan" })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                  <Stat label="Project type" value={scan.summary?.project_type ?? "unknown"} />
                  <Stat label="Frontend" value={scan.summary?.detected_frontend?.framework ?? "—"} />
                  <Stat label="Backend" value={scan.summary?.backend_framework ?? "—"} />
                  <Stat label="Dependencies" value={String(scan.summary?.total_dependencies ?? scan.dependencies.length)} />
                </div>

                <Section title="Detected services" icon={Box}>
                  {scan.services.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No third-party services detected.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {scan.services.map((s) => (
                        <ServiceBadge key={s.service} service={s.service} category={s.category} />
                      ))}
                    </div>
                  )}
                </Section>

                <Section title={`Dependencies (${scan.dependencies.length})`} icon={Package}>
                  <div className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                    {scan.dependencies.slice(0, 30).map((d) => (
                      <div key={d.name} className="flex items-center justify-between rounded-md border border-border px-2 py-1">
                        <span className="truncate">{d.name}</span>
                        <span className="text-muted-foreground">{d.version}</span>
                      </div>
                    ))}
                  </div>
                  {scan.dependencies.length > 30 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      …and {scan.dependencies.length - 30} more
                    </p>
                  )}
                </Section>

                <Section title={`Environment variables (${scan.env_vars.length})`} icon={Lock}>
                  {scan.env_vars.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No env example file detected.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      {scan.env_vars.map((e) => (
                        <Badge key={e.key} variant={e.sensitivity === "secret" ? "destructive" : "outline"}>
                          {e.key}
                        </Badge>
                      ))}
                    </div>
                  )}
                </Section>

                {scan.security_findings.length > 0 && (
                  <Section title="Static recommendations" icon={ShieldAlert}>
                    <ul className="space-y-2">
                      {scan.security_findings.map((f, i) => (
                        <li key={i} className="flex items-start gap-2 rounded-md border border-border p-2 text-sm">
                          <Badge variant={f.severity === "high" ? "destructive" : "warning"}>{f.severity}</Badge>
                          <span>{f.message}</span>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}

                <AiAnalysisBlock analysis={scan.ai_analysis} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteScan}
        onOpenChange={(o) => !o && setDeleteScan(null)}
        title="Delete scan result"
        description={`Permanently delete the scan result for ${deleteScan?.label}? The repository and its history are not affected.`}
        confirmText="Delete scan"
        onConfirm={async () => {
          if (deleteScan) await deleteScanResult(deleteScan.id);
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

function severityVariant(sev: string): "destructive" | "warning" | "secondary" {
  if (sev === "critical" || sev === "high") return "destructive";
  if (sev === "medium") return "warning";
  return "secondary";
}

function AiAnalysisBlock({ analysis }: { analysis: AiAnalysis | null }) {
  if (!analysis || Object.keys(analysis).length === 0) return null;
  const isPending = analysis.status === "pending" || (!analysis.stack_summary && !analysis._meta);
  if (isPending) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/20 p-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        AI analysis in progress (DeepSeek)…
      </div>
    );
  }
  return (
    <div className="rounded-md border border-primary/20 bg-primary/5 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-primary" /> AI analysis
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {analysis._meta?.provider && <Badge variant="outline">{analysis._meta.provider}</Badge>}
          {typeof analysis.code_health_score === "number" && (
            <span className="flex items-center gap-1">
              <Gauge className="h-3 w-3" /> {analysis.code_health_score}/100
            </span>
          )}
        </div>
      </div>

      {analysis.stack_summary && (
        <p className="mb-3 text-sm text-foreground/90">{analysis.stack_summary}</p>
      )}

      {analysis.key_risks && analysis.key_risks.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Key risks
          </div>
          <ul className="space-y-1.5">
            {analysis.key_risks.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Badge variant={severityVariant(r.severity)}>{r.severity}</Badge>
                <span className="text-xs text-muted-foreground">{r.category}</span>
                <span className="flex-1">{r.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.recommendations && analysis.recommendations.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Recommendations
          </div>
          <ul className="space-y-2">
            {analysis.recommendations.map((rec, i) => (
              <li key={i} className="flex items-start gap-2 rounded-md border border-border bg-background/40 p-2">
                <Lightbulb className="mt-0.5 h-4 w-4 text-amber-400" />
                <div className="flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{rec.title}</span>
                    <Badge variant="outline">{rec.category}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{rec.explanation}</div>
                  {typeof rec.estimated_savings === "number" && rec.estimated_savings > 0 && (
                    <div className="mt-1 text-xs text-emerald-400">~€{rec.estimated_savings}/mo savings</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </div>
      {children}
    </div>
  );
}
