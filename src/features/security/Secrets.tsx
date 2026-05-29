import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Loader2, ShieldAlert, ShieldCheck, EyeOff } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface EnvVar {
  key: string;
  detected_service: string | null;
  sensitivity: "public" | "secret";
}
interface Finding {
  type: string;
  severity: string;
  message: string;
}
interface ScanRow {
  id: string;
  created_at: string;
  env_vars: EnvVar[];
  security_findings: Finding[];
  repositories: { full_name: string } | null;
}

// A secret-looking var that is also browser-exposed (VITE_/NEXT_PUBLIC_/PUBLIC_) is critical.
function isExposedSecret(key: string) {
  return /^(VITE_|NEXT_PUBLIC_|PUBLIC_)/i.test(key) && /(SECRET|PRIVATE|SERVICE_ROLE|TOKEN|KEY|PASSWORD)/i.test(key);
}

export function SecretsDetectionPage() {
  const { projectId } = useCurrentContext();

  const { data, isLoading } = useQuery({
    queryKey: ["secrets_scan", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("id, created_at, env_vars, security_findings, repositories(full_name)")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(20);
      return (data ?? []) as unknown as ScanRow[];
    },
  });

  const { secrets, exposed, findings } = useMemo(() => {
    const secrets: { key: string; service: string | null; repo: string | null; exposed: boolean }[] = [];
    const findings: (Finding & { repo: string | null })[] = [];
    const seen = new Set<string>();
    (data ?? []).forEach((scan) => {
      const repo = scan.repositories?.full_name ?? null;
      (scan.env_vars ?? []).forEach((e) => {
        const exposed = isExposedSecret(e.key);
        if (e.sensitivity === "secret" || exposed) {
          const dedupe = `${repo}:${e.key}`;
          if (seen.has(dedupe)) return;
          seen.add(dedupe);
          secrets.push({ key: e.key, service: e.detected_service, repo, exposed });
        }
      });
      (scan.security_findings ?? []).forEach((f) => {
        if (/secret|env|expose|key|token/i.test(f.message) || /secret/i.test(f.type)) findings.push({ ...f, repo });
      });
    });
    const exposed = secrets.filter((s) => s.exposed);
    return { secrets, exposed, findings };
  }, [data]);

  return (
    <div>
      <PageHeader
        title="Secrets Detection"
        description="Sensitive environment variables found in your repositories, with browser-exposure checks."
        actions={
          <ExportMenu
            rows={secrets.map((s) => ({ key: s.key, service: s.service, repo: s.repo, exposed: s.exposed }))}
            filename="secrets"
          />
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Secret vars" value={String(secrets.length)} icon={KeyRound} />
        <MetricCard label="Browser-exposed" value={String(exposed.length)} icon={ShieldAlert} trend={exposed.length > 0 ? "down" : "flat"} />
        <MetricCard label="Related findings" value={String(findings.length)} icon={EyeOff} />
      </div>

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : secrets.length === 0 && findings.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No secrets detected"
          description="Run a scan from Code → Repositories. .env example files and detected secret vars appear here."
        />
      ) : (
        <div className="space-y-6">
          {exposed.length > 0 && (
            <Card className="border-destructive/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <ShieldAlert className="h-4 w-4" /> Browser-exposed secrets ({exposed.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  These are prefixed for client bundling yet look like secrets — move them to an Edge Function / server.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {exposed.map((s) => (
                    <Badge key={`${s.repo}:${s.key}`} variant="destructive">{s.key}</Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {secrets.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Secret variables ({secrets.length})</CardTitle></CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Variable</th>
                      <th className="px-4 py-3">Service</th>
                      <th className="px-4 py-3">Repository</th>
                      <th className="px-4 py-3">Exposure</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {secrets.map((s) => (
                      <tr key={`${s.repo}:${s.key}`}>
                        <td className="px-4 py-3 font-mono text-xs">{s.key}</td>
                        <td className="px-4 py-3 text-muted-foreground">{s.service ?? "—"}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{s.repo ?? "—"}</td>
                        <td className="px-4 py-3">
                          {s.exposed ? <Badge variant="destructive">exposed</Badge> : <Badge variant="secondary">server-side</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {findings.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Related findings ({findings.length})</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {findings.map((f, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-md border border-border p-2 text-sm">
                    <Badge variant={f.severity === "high" || f.severity === "critical" ? "destructive" : "warning"}>{f.severity}</Badge>
                    <span className="flex-1">{f.message}</span>
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
