import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck, AlertOctagon, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface ScanFinding {
  type: string;
  severity: "info" | "warning" | "medium" | "high" | "critical";
  message: string;
}

interface AiRisk {
  severity: "low" | "medium" | "high" | "critical";
  category: string;
  message: string;
}

interface ScanResultRow {
  id: string;
  created_at: string;
  security_findings: ScanFinding[];
  ai_analysis: {
    key_risks?: AiRisk[];
    code_health_score?: number;
  } | null;
  repositories: { full_name: string } | null;
}

function sevVariant(s: string): "destructive" | "warning" | "secondary" {
  if (s === "critical" || s === "high") return "destructive";
  if (s === "warning" || s === "medium") return "warning";
  return "secondary";
}

export function SecurityFindingsPage({ filter }: { filter?: "cve" | "secrets" | "all" }) {
  const { projectId } = useCurrentContext();

  const { data, isLoading } = useQuery({
    queryKey: ["scan_security", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("id, created_at, security_findings, ai_analysis, repositories(full_name)")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(20);
      return (data ?? []) as unknown as ScanResultRow[];
    },
  });

  const aggregated = useMemo(() => {
    if (!data)
      return {
        findings: [] as (ScanFinding & { repo: string | null })[],
        aiRisks: [] as (AiRisk & { repo: string | null })[],
        score: null as number | null,
      };
    const findings: (ScanFinding & { repo: string | null })[] = [];
    const aiRisks: (AiRisk & { repo: string | null })[] = [];
    let score: number | null = null;
    data.forEach((scan) => {
      const repo = scan.repositories?.full_name ?? null;
      (scan.security_findings ?? []).forEach((f) => findings.push({ ...f, repo }));
      (scan.ai_analysis?.key_risks ?? []).forEach((r) => aiRisks.push({ ...r, repo }));
      if (score === null && typeof scan.ai_analysis?.code_health_score === "number") {
        score = scan.ai_analysis.code_health_score;
      }
    });
    return { findings, aiRisks, score };
  }, [data]);

  const counts = useMemo(() => {
    const all = [...aggregated.findings, ...aggregated.aiRisks];
    return {
      total: all.length,
      critical: all.filter((x) => x.severity === "critical").length,
      high: all.filter((x) => x.severity === "high").length,
    };
  }, [aggregated]);

  const title =
    filter === "cve" ? "CVE Alerts" : filter === "secrets" ? "Secrets Detection" : "Security Overview";

  return (
    <div>
      <PageHeader
        title={title}
        description="Security findings detected by static scan and enriched by AI analysis."
        actions={
          <ExportMenu
            rows={[
              ...aggregated.findings.map((f) => ({
                severity: f.severity,
                category: f.type,
                message: f.message,
                source: "static" as const,
                repo: f.repo,
              })),
              ...aggregated.aiRisks.map((f) => ({
                severity: f.severity,
                category: f.category,
                message: f.message,
                source: "ai" as const,
                repo: f.repo,
              })),
            ]}
            filename="security-findings"
          />
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          label="Code health"
          value={aggregated.score !== null ? `${aggregated.score}/100` : "—"}
          icon={ShieldCheck}
          trend={aggregated.score !== null && aggregated.score >= 70 ? "up" : "down"}
        />
        <MetricCard label="Critical risks" value={String(counts.critical)} icon={AlertOctagon} trend={counts.critical > 0 ? "down" : "flat"} />
        <MetricCard label="High risks" value={String(counts.high)} icon={ShieldAlert} />
      </div>

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : counts.total === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No security findings"
          description="Run a scan from Code → Repositories. Static checks and AI risk analysis will populate this page."
        />
      ) : (
        <div className="space-y-6">
          {aggregated.findings.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Static findings ({aggregated.findings.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {aggregated.findings.map((f, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-md border border-border p-2 text-sm">
                    <Badge variant={sevVariant(f.severity)}>{f.severity}</Badge>
                    <div className="flex-1">
                      <div>{f.message}</div>
                      {(f as any).repo && <div className="mt-0.5 text-xs text-muted-foreground">{(f as any).repo}</div>}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          {aggregated.aiRisks.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>AI-detected risks ({aggregated.aiRisks.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {aggregated.aiRisks.map((r, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-md border border-border p-2 text-sm">
                    <Badge variant={sevVariant(r.severity)}>{r.severity}</Badge>
                    <Badge variant="outline">{r.category}</Badge>
                    <div className="flex-1">
                      <div>{r.message}</div>
                      {(r as any).repo && <div className="mt-0.5 text-xs text-muted-foreground">{(r as any).repo}</div>}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
