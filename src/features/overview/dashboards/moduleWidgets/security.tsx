import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, AlertOctagon, ShieldAlert } from "lucide-react";
import { MetricCard } from "@/components/MetricCard";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { WidgetLoading, WidgetEmpty, WidgetSection, type ModuleWidgetProps } from "./shared";

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
  ai_analysis: { key_risks?: AiRisk[]; code_health_score?: number } | null;
  repositories: { full_name: string } | null;
}

function sevVariant(s: string): "destructive" | "warning" | "secondary" {
  if (s === "critical" || s === "high") return "destructive";
  if (s === "warning" || s === "medium") return "warning";
  return "secondary";
}

function useScans(projectId: string, refreshKey?: number) {
  return useQuery({
    queryKey: ["scan_security", projectId, refreshKey ?? 0],
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
}

function useAggregated(data: ScanResultRow[] | undefined) {
  return useMemo(() => {
    const findings: (ScanFinding & { repo: string | null })[] = [];
    const aiRisks: (AiRisk & { repo: string | null })[] = [];
    let score: number | null = null;
    (data ?? []).forEach((scan) => {
      const repo = scan.repositories?.full_name ?? null;
      (scan.security_findings ?? []).forEach((f) => findings.push({ ...f, repo }));
      (scan.ai_analysis?.key_risks ?? []).forEach((r) => aiRisks.push({ ...r, repo }));
      if (score === null && typeof scan.ai_analysis?.code_health_score === "number") score = scan.ai_analysis.code_health_score;
    });
    const all = [...findings, ...aiRisks];
    return {
      findings,
      aiRisks,
      score,
      counts: {
        total: all.length,
        critical: all.filter((x) => x.severity === "critical").length,
        high: all.filter((x) => x.severity === "high").length,
      },
    };
  }, [data]);
}

export function SecurityCodeHealthCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data, isLoading } = useScans(projectId, refreshKey);
  const agg = useAggregated(data);
  if (isLoading) return <WidgetLoading />;
  return (
    <MetricCard
      label="Code health"
      value={agg.score !== null ? `${agg.score}/100` : "—"}
      icon={ShieldCheck}
      trend={agg.score !== null && agg.score >= 70 ? "up" : "down"}
    />
  );
}

export function SecurityCriticalRisksCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data, isLoading } = useScans(projectId, refreshKey);
  const agg = useAggregated(data);
  if (isLoading) return <WidgetLoading />;
  return <MetricCard label="Critical risks" value={String(agg.counts.critical)} icon={AlertOctagon} trend={agg.counts.critical > 0 ? "down" : "flat"} />;
}

export function SecurityHighRisksCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data, isLoading } = useScans(projectId, refreshKey);
  const agg = useAggregated(data);
  if (isLoading) return <WidgetLoading />;
  return <MetricCard label="High risks" value={String(agg.counts.high)} icon={ShieldAlert} />;
}

export function SecurityStaticFindingsList({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data, isLoading } = useScans(projectId, refreshKey);
  const agg = useAggregated(data);
  if (isLoading) return <WidgetLoading />;
  if (agg.findings.length === 0) return <WidgetEmpty message="No static findings." />;
  return (
    <WidgetSection title={`Static findings (${agg.findings.length})`}>
      <div className="space-y-2 overflow-auto">
        {agg.findings.map((f, i) => (
          <div key={i} className="flex items-start gap-3 rounded-md border border-border p-2 text-sm">
            <Badge variant={sevVariant(f.severity)}>{f.severity}</Badge>
            <div className="flex-1">
              <div>{f.message}</div>
              {f.repo && <div className="mt-0.5 text-xs text-muted-foreground">{f.repo}</div>}
            </div>
          </div>
        ))}
      </div>
    </WidgetSection>
  );
}

export function SecurityAiRisksList({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data, isLoading } = useScans(projectId, refreshKey);
  const agg = useAggregated(data);
  if (isLoading) return <WidgetLoading />;
  if (agg.aiRisks.length === 0) return <WidgetEmpty message="No AI-detected risks." />;
  return (
    <WidgetSection title={`AI-detected risks (${agg.aiRisks.length})`}>
      <div className="space-y-2 overflow-auto">
        {agg.aiRisks.map((r, i) => (
          <div key={i} className="flex items-start gap-3 rounded-md border border-border p-2 text-sm">
            <Badge variant={sevVariant(r.severity)}>{r.severity}</Badge>
            <Badge variant="outline">{r.category}</Badge>
            <div className="flex-1">
              <div>{r.message}</div>
              {r.repo && <div className="mt-0.5 text-xs text-muted-foreground">{r.repo}</div>}
            </div>
          </div>
        ))}
      </div>
    </WidgetSection>
  );
}
