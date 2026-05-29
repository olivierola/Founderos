import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck, AlertOctagon, Loader2, RefreshCw, ExternalLink, Check } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

export interface Vuln {
  id: string;
  package_name: string;
  package_version: string | null;
  vuln_id: string;
  aliases: string[] | null;
  severity: "unknown" | "low" | "medium" | "high" | "critical";
  cvss: number | null;
  summary: string | null;
  fixed_version: string | null;
  reference_url: string | null;
  source: string;
  status: "open" | "ignored" | "fixed";
  detected_at: string;
}

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

function sevVariant(s: string): "destructive" | "warning" | "secondary" {
  if (s === "critical" || s === "high") return "destructive";
  if (s === "medium") return "warning";
  return "secondary";
}

export function CveAlertsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sevFilter, setSevFilter] = useState<string>("all");

  const { data: vulns, isLoading } = useQuery({
    queryKey: ["vulnerabilities", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("vulnerabilities")
        .select("*")
        .eq("project_id", projectId!)
        .order("detected_at", { ascending: false })
        .limit(500);
      return (data ?? []) as Vuln[];
    },
  });

  async function scan() {
    if (!workspaceId || !projectId) return;
    setScanning(true);
    setError(null);
    try {
      await callEdge("security-vuln-scan", { workspace_id: workspaceId, project_id: projectId });
      queryClient.invalidateQueries({ queryKey: ["vulnerabilities", projectId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  async function setStatus(id: string, status: Vuln["status"]) {
    await supabase.from("vulnerabilities").update({ status }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["vulnerabilities", projectId] });
  }

  const open = useMemo(() => (vulns ?? []).filter((v) => v.status === "open"), [vulns]);
  const counts = useMemo(() => ({
    critical: open.filter((v) => v.severity === "critical").length,
    high: open.filter((v) => v.severity === "high").length,
    medium: open.filter((v) => v.severity === "medium").length,
    total: open.length,
  }), [open]);

  const filtered = useMemo(() => {
    const list = sevFilter === "all" ? (vulns ?? []) : (vulns ?? []).filter((v) => v.severity === sevFilter);
    return [...list].sort((a, b) => (SEV_ORDER[a.severity] ?? 5) - (SEV_ORDER[b.severity] ?? 5));
  }, [vulns, sevFilter]);

  return (
    <div>
      <PageHeader
        title="CVE Alerts"
        description="Real vulnerabilities for your dependencies, sourced from OSV.dev (and Snyk if connected)."
        actions={
          <div className="flex gap-2">
            <ExportMenu
              rows={(vulns ?? []).map((v) => ({
                package: v.package_name,
                version: v.package_version,
                id: v.vuln_id,
                severity: v.severity,
                cvss: v.cvss,
                fixed_in: v.fixed_version,
                status: v.status,
              }))}
              filename="cve-alerts"
            />
            <Button size="sm" onClick={scan} disabled={scanning}>
              {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Scan vulnerabilities
            </Button>
          </div>
        }
      />

      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MetricCard label="Open issues" value={String(counts.total)} icon={ShieldAlert} />
        <MetricCard label="Critical" value={String(counts.critical)} icon={AlertOctagon} trend={counts.critical > 0 ? "down" : "flat"} />
        <MetricCard label="High" value={String(counts.high)} icon={ShieldAlert} />
        <MetricCard label="Medium" value={String(counts.medium)} icon={ShieldCheck} />
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {["all", "critical", "high", "medium", "low", "unknown"].map((s) => (
          <button
            key={s}
            onClick={() => setSevFilter(s)}
            className={`rounded-md border px-2.5 py-1 text-xs capitalize transition-colors ${
              sevFilter === s ? "border-primary/40 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-secondary"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : (vulns ?? []).length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No vulnerabilities recorded"
          description="Run a code scan first, then click 'Scan vulnerabilities' to check your dependencies against OSV.dev."
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="None at this severity" />
      ) : (
        <div className="space-y-2">
          {filtered.map((v) => (
            <Card key={v.id} className={v.status !== "open" ? "opacity-60" : ""}>
              <CardContent className="flex items-start gap-3 p-3">
                <Badge variant={sevVariant(v.severity)}>{v.severity}{v.cvss ? ` ${v.cvss}` : ""}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{v.package_name}</span>
                    <span className="text-xs text-muted-foreground">{v.package_version}</span>
                    <Badge variant="outline">{v.vuln_id}</Badge>
                    {v.fixed_version && <Badge variant="success">fix: {v.fixed_version}</Badge>}
                  </div>
                  {v.summary && <p className="mt-1 text-sm text-muted-foreground">{v.summary}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {v.reference_url && (
                    <a href={v.reference_url} target="_blank" rel="noreferrer">
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="View advisory">
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </a>
                  )}
                  {v.status === "open" ? (
                    <Button size="sm" variant="ghost" onClick={() => setStatus(v.id, "ignored")} title="Ignore">Ignore</Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setStatus(v.id, "open")} title="Reopen">
                      <Check className="h-4 w-4" /> reopen
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
