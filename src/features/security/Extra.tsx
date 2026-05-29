import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { Scale, Loader2, RefreshCw, ShieldAlert, ShieldCheck, KeyRound, Bug, Gauge } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface LicenseResult { name: string; version: string; license: string | null; risk: string }

// --- License Audit (SPDX via npm registry) --------------------------------
export function LicenseAuditPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [results, setResults] = useState<LicenseResult[] | null>(null);
  const [summary, setSummary] = useState<{ total: number; copyleft: number; unknown: number; permissive: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    if (!workspaceId || !projectId) return;
    setScanning(true);
    setError(null);
    try {
      const res = await callEdge<{ results: LicenseResult[]; summary: typeof summary }>("security-license-scan", {
        workspace_id: workspaceId,
        project_id: projectId,
      });
      setResults(res.results ?? []);
      setSummary(res.summary ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  const sorted = useMemo(() => {
    const order: Record<string, number> = { copyleft: 0, unknown: 1, permissive: 2 };
    return [...(results ?? [])].sort((a, b) => (order[a.risk] ?? 3) - (order[b.risk] ?? 3));
  }, [results]);

  return (
    <div>
      <PageHeader
        title="License Audit"
        description="Resolve SPDX licenses for your dependencies from the npm registry and flag copyleft / unknown licenses."
        actions={
          <div className="flex gap-2">
            {results && (
              <ExportMenu
                rows={results.map((r) => ({ name: r.name, version: r.version, license: r.license, risk: r.risk }))}
                filename="licenses"
              />
            )}
            <Button size="sm" onClick={scan} disabled={scanning}>
              {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Scan licenses
            </Button>
          </div>
        }
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      {summary && (
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MetricCard label="Dependencies" value={String(summary.total)} icon={Scale} />
          <MetricCard label="Copyleft" value={String(summary.copyleft)} trend={summary.copyleft > 0 ? "down" : "flat"} />
          <MetricCard label="Unknown" value={String(summary.unknown)} />
          <MetricCard label="Permissive" value={String(summary.permissive)} />
        </div>
      )}
      {!results ? (
        <EmptyState
          icon={Scale}
          title="No license scan yet"
          description="Click 'Scan licenses' to resolve SPDX licenses for your scanned dependencies."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Package</th>
                  <th className="px-4 py-3">License</th>
                  <th className="px-4 py-3">Risk</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map((r) => (
                  <tr key={r.name}>
                    <td className="px-4 py-3 font-mono text-xs">{r.name}</td>
                    <td className="px-4 py-3">{r.license ?? <span className="text-muted-foreground">unknown</span>}</td>
                    <td className="px-4 py-3">
                      <Badge variant={r.risk === "copyleft" ? "destructive" : r.risk === "unknown" ? "warning" : "success"}>
                        {r.risk}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// --- Risk Score (aggregated dashboard) ------------------------------------
export function RiskScorePage() {
  const { projectId } = useCurrentContext();
  const { workspaceSlug, projectSlug } = useParams();

  const { data: vulns } = useQuery({
    queryKey: ["risk_vulns", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("vulnerabilities")
        .select("severity, status")
        .eq("project_id", projectId!)
        .eq("status", "open");
      return (data ?? []) as { severity: string; status: string }[];
    },
  });

  const { data: scan, isLoading } = useQuery({
    queryKey: ["risk_scan", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("env_vars, security_findings, ai_analysis")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as {
        env_vars: { key: string; sensitivity: string }[];
        security_findings: { severity: string }[];
        ai_analysis: { key_risks?: { severity: string }[]; code_health_score?: number } | null;
      } | null;
    },
  });

  const breakdown = useMemo(() => {
    const v = vulns ?? [];
    const crit = v.filter((x) => x.severity === "critical").length;
    const high = v.filter((x) => x.severity === "high").length;
    const med = v.filter((x) => x.severity === "medium").length;
    const exposedSecrets = (scan?.env_vars ?? []).filter(
      (e) => /^(VITE_|NEXT_PUBLIC_|PUBLIC_)/i.test(e.key) && /(SECRET|PRIVATE|SERVICE_ROLE|TOKEN|KEY)/i.test(e.key),
    ).length;
    const aiHigh = (scan?.ai_analysis?.key_risks ?? []).filter((r) => r.severity === "high" || r.severity === "critical").length;
    const staticHigh = (scan?.security_findings ?? []).filter((f) => f.severity === "high" || f.severity === "critical").length;

    // Penalty model → risk score (100 = safe).
    const penalty = crit * 15 + high * 8 + med * 3 + exposedSecrets * 12 + aiHigh * 5 + staticHigh * 4;
    const score = Math.max(0, 100 - penalty);
    return { crit, high, med, exposedSecrets, aiHigh, staticHigh, score };
  }, [vulns, scan]);

  const color = breakdown.score >= 75 ? "text-emerald-400" : breakdown.score >= 50 ? "text-amber-400" : "text-red-400";
  const base = `/app/${workspaceSlug}/${projectSlug}/security`;

  return (
    <div>
      <PageHeader title="Risk Score" description="Aggregated security posture across CVEs, secrets, licenses and AI analysis." />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardContent className="flex items-center justify-between p-6">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Security score</div>
                <div className={`mt-1 text-4xl font-semibold ${color}`}>{breakdown.score}<span className="text-lg text-muted-foreground">/100</span></div>
              </div>
              <Gauge className={`h-10 w-10 ${color}`} />
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <MetricCard label="Critical CVE" value={String(breakdown.crit)} icon={Bug} />
            <MetricCard label="High CVE" value={String(breakdown.high)} icon={Bug} />
            <MetricCard label="Medium CVE" value={String(breakdown.med)} />
            <MetricCard label="Exposed secrets" value={String(breakdown.exposedSecrets)} icon={KeyRound} />
            <MetricCard label="AI risks (high)" value={String(breakdown.aiHigh)} icon={ShieldAlert} />
            <MetricCard label="Static (high)" value={String(breakdown.staticHigh)} icon={ShieldCheck} />
          </div>

          <Card>
            <CardHeader><CardTitle>Improve your score</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Link to={`${base}/cve-alerts`}><Button variant="outline" size="sm"><Bug className="h-4 w-4" /> Fix CVEs</Button></Link>
              <Link to={`${base}/secrets-detection`}><Button variant="outline" size="sm"><KeyRound className="h-4 w-4" /> Review secrets</Button></Link>
              <Link to={`${base}/license-audit`}><Button variant="outline" size="sm"><Scale className="h-4 w-4" /> Audit licenses</Button></Link>
              <Link to={`${base}/compliance-watch`}><Button variant="outline" size="sm"><ShieldCheck className="h-4 w-4" /> Compliance</Button></Link>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ComplianceWatchPage moved to ./Compliance.tsx (interactive checklist)
