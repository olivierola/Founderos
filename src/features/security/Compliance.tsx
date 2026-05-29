import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileBadge, Check, Circle, Minus, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

type Framework = "gdpr" | "soc2" | "iso27001" | "hipaa";
type Status = "pending" | "in_progress" | "satisfied" | "not_applicable";

interface Control {
  framework: Framework;
  key: string;
  label: string;
}

const CONTROLS: Control[] = [
  { framework: "gdpr", key: "gdpr.records_processing", label: "Maintain a Record of Processing Activities" },
  { framework: "gdpr", key: "gdpr.dpa", label: "Data Processing Agreements with subprocessors" },
  { framework: "gdpr", key: "gdpr.right_to_erase", label: "Right to erasure workflow" },
  { framework: "gdpr", key: "gdpr.data_export", label: "Data portability / export endpoint" },
  { framework: "gdpr", key: "gdpr.breach_72h", label: "Breach notification process under 72h" },
  { framework: "soc2", key: "soc2.access_control", label: "Role-based access control" },
  { framework: "soc2", key: "soc2.audit_log", label: "Immutable audit log for admin actions" },
  { framework: "soc2", key: "soc2.encryption_rest", label: "Encryption at rest for credentials" },
  { framework: "soc2", key: "soc2.encryption_transit", label: "TLS for all data in transit" },
  { framework: "soc2", key: "soc2.backups", label: "Automated, tested backups" },
  { framework: "soc2", key: "soc2.vuln_mgmt", label: "Vulnerability management process" },
  { framework: "iso27001", key: "iso.asset_inventory", label: "Asset inventory maintained" },
  { framework: "iso27001", key: "iso.supplier_review", label: "Supplier security review" },
  { framework: "iso27001", key: "iso.bc_plan", label: "Business continuity plan documented" },
  { framework: "hipaa", key: "hipaa.baa", label: "Business Associate Agreement in place" },
  { framework: "hipaa", key: "hipaa.phi_audit", label: "PHI access audit trail" },
];

const STATUS_ORDER: Status[] = ["pending", "in_progress", "satisfied", "not_applicable"];

// Controls automatically satisfied by the FounderOS platform itself.
const AUTO_SATISFIED = new Set<string>([
  "soc2:soc2.audit_log",
  "soc2:soc2.encryption_rest",
  "soc2:soc2.encryption_transit",
  "soc2:soc2.access_control",
  "gdpr:gdpr.data_export",
]);

export function ComplianceWatchPage() {
  const { workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Framework | "all">("all");

  const { data: stored } = useQuery({
    queryKey: ["compliance", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("compliance_controls")
        .select("*")
        .eq("workspace_id", workspaceId!);
      const byKey = new Map<string, { status: Status; evidence: string | null }>();
      (data ?? []).forEach((r: any) => byKey.set(`${r.framework}:${r.control_key}`, { status: r.status, evidence: r.evidence }));
      return byKey;
    },
  });

  // Effective status: auto-satisfied controls override stored/pending unless explicitly marked not_applicable.
  function effectiveStatus(c: Control): Status {
    const key = `${c.framework}:${c.key}`;
    const stored2 = stored?.get(key)?.status;
    if (stored2 === "not_applicable") return "not_applicable";
    if (AUTO_SATISFIED.has(key)) return "satisfied";
    return stored2 ?? "pending";
  }

  async function setStatus(c: Control, status: Status) {
    if (!workspaceId) return;
    await supabase
      .from("compliance_controls")
      .upsert(
        { workspace_id: workspaceId, framework: c.framework, control_key: c.key, status, updated_at: new Date().toISOString() },
        { onConflict: "workspace_id,framework,control_key" },
      );
    queryClient.invalidateQueries({ queryKey: ["compliance", workspaceId] });
  }

  const visible = filter === "all" ? CONTROLS : CONTROLS.filter((c) => c.framework === filter);

  const scores = useMemo(() => {
    const out: Record<Framework, { total: number; satisfied: number }> = {
      gdpr: { total: 0, satisfied: 0 },
      soc2: { total: 0, satisfied: 0 },
      iso27001: { total: 0, satisfied: 0 },
      hipaa: { total: 0, satisfied: 0 },
    };
    CONTROLS.forEach((c) => {
      out[c.framework].total++;
      if (effectiveStatus(c) === "satisfied") out[c.framework].satisfied++;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);

  return (
    <div>
      <PageHeader
        title="Compliance Watch"
        description="Track your readiness against common security & privacy frameworks. Mark each control to compute a live score."
      />

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {(["gdpr", "soc2", "iso27001", "hipaa"] as Framework[]).map((f) => {
          const s = scores[f];
          const pct = s.total > 0 ? Math.round((s.satisfied / s.total) * 100) : 0;
          return <MetricCard key={f} label={f.toUpperCase()} value={`${pct}%`} hint={`${s.satisfied}/${s.total}`} />;
        })}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["all", "gdpr", "soc2", "iso27001", "hipaa"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            onClick={() => setFilter(f)}
          >
            {f.toUpperCase()}
          </Button>
        ))}
      </div>

      <div className="space-y-2">
        {visible.map((c) => {
          const key = `${c.framework}:${c.key}`;
          const auto = AUTO_SATISFIED.has(key);
          const current = effectiveStatus(c);
          return (
            <Card key={c.key}>
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{c.framework.toUpperCase()}</Badge>
                  <span className="text-sm">{c.label}</span>
                  {auto && <Badge variant="success">auto</Badge>}
                </div>
                {auto ? (
                  <span className="flex items-center gap-1 text-xs text-emerald-400">
                    <Check className="h-3.5 w-3.5" /> satisfied by platform
                  </span>
                ) : (
                  <div className="flex items-center gap-1">
                    {STATUS_ORDER.map((s) => {
                      const Icon =
                        s === "satisfied" ? Check : s === "in_progress" ? Loader2 : s === "not_applicable" ? Minus : Circle;
                      return (
                        <Button
                          key={s}
                          size="sm"
                          variant={current === s ? "default" : "ghost"}
                          onClick={() => setStatus(c, s)}
                          title={s}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </Button>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileBadge className="h-4 w-4" /> Why some controls are auto-satisfied
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>FounderOS satisfies these controls for you, out of the box:</p>
          <p>• <code className="text-foreground">soc2.audit_log</code> — every admin action is logged in activity_logs.</p>
          <p>• <code className="text-foreground">soc2.encryption_rest</code> — credentials are AES-GCM 256 encrypted at rest.</p>
          <p>• <code className="text-foreground">soc2.encryption_transit</code> — all traffic over TLS.</p>
          <p>• <code className="text-foreground">soc2.access_control</code> — RLS + owner/admin/member/viewer roles.</p>
          <p>• <code className="text-foreground">gdpr.data_export</code> — JSON export available in Settings → Data &amp; Privacy.</p>
        </CardContent>
      </Card>
    </div>
  );
}
