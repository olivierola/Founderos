import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck, ShieldAlert, Plus, Loader2, Trash2, Globe, Play, Lock, Unlock,
  AlertTriangle, AlertOctagon, Info, CheckCircle2, ChevronDown,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

interface Target {
  id: string; target: string; label: string | null;
  consent_active: boolean; consented_at: string | null; consent_note: string | null;
  created_at: string;
}
interface Scan {
  id: string; target_host: string; mode: "passive" | "active"; scan_type: string;
  status: "queued" | "running" | "completed" | "failed" | "blocked";
  error_message: string | null; created_at: string;
}
interface Finding {
  id: string; scan_id: string; severity: "info" | "low" | "medium" | "high" | "critical";
  title: string; detail: string | null; remediation: string | null; evidence: Record<string, unknown>;
}

const PASSIVE = [
  { type: "headers", label: "Security headers" },
  { type: "tls", label: "TLS / HTTPS" },
  { type: "exposure", label: "Exposed files" },
];
const ACTIVE = [
  { type: "port_scan", label: "Port scan" },
  { type: "surface", label: "Attack surface" },
];

const SEV: Record<Finding["severity"], { variant: "secondary" | "warning" | "destructive" | "outline"; icon: any }> = {
  info: { variant: "outline", icon: Info },
  low: { variant: "secondary", icon: Info },
  medium: { variant: "warning", icon: AlertTriangle },
  high: { variant: "destructive", icon: AlertTriangle },
  critical: { variant: "destructive", icon: AlertOctagon },
};

export function SecurityScansPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [newTarget, setNewTarget] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const targets = useQuery({
    queryKey: ["sec_targets", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("security_scan_targets")
        .select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Target[];
    },
  });

  const scans = useQuery({
    queryKey: ["sec_scans", projectId],
    enabled: !!projectId,
    refetchInterval: 5000,
    queryFn: async () => {
      const { data } = await supabase.from("security_scans")
        .select("id, target_host, mode, scan_type, status, error_message, created_at")
        .eq("project_id", projectId!).order("created_at", { ascending: false }).limit(50);
      return (data ?? []) as Scan[];
    },
  });

  async function addTarget() {
    if (!workspaceId || !projectId || !user || !newTarget.trim()) return;
    setBusy("add");
    try {
      await supabase.from("security_scan_targets").insert({
        workspace_id: workspaceId, project_id: projectId, created_by: user.id, target: newTarget.trim(),
      });
      setNewTarget(""); setAddOpen(false);
      queryClient.invalidateQueries({ queryKey: ["sec_targets", projectId] });
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function toggleConsent(t: Target) {
    if (!user) return;
    const enabling = !t.consent_active;
    if (enabling && !confirm(
      `Authorise ACTIVE security scanning of "${t.target}"?\n\nBy enabling this you confirm you own or are explicitly authorised to scan this target. Active scans probe ports & surface (non-destructive) — never exploitation.`,
    )) return;
    setBusy(t.id);
    try {
      await supabase.from("security_scan_targets").update({
        consent_active: enabling,
        consented_by: enabling ? user.id : null,
        consented_at: enabling ? new Date().toISOString() : null,
        consent_note: enabling ? "Owner/authorised — confirmed in UI" : null,
      }).eq("id", t.id);
      queryClient.invalidateQueries({ queryKey: ["sec_targets", projectId] });
    } finally { setBusy(null); }
  }

  async function runScan(t: Target, scan_type: string) {
    if (!workspaceId || !projectId) return;
    setBusy(`${t.id}:${scan_type}`);
    try {
      await callEdge("security-scan", { workspace_id: workspaceId, project_id: projectId, target: t.target, scan_type });
      queryClient.invalidateQueries({ queryKey: ["sec_scans", projectId] });
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function removeTarget(id: string) {
    if (!confirm("Remove this target and its scans?")) return;
    await supabase.from("security_scan_targets").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sec_targets", projectId] });
  }

  if (!projectId) return <PageHeader title="Scans & Pentest" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Scans & Pentest"
        description="Defensive checks run instantly. Active scans (ports & surface) require you to authorise the target first — detection and proof of exposure only, never exploitation."
        actions={<Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add target</Button>}
      />

      {(targets.data ?? []).length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No targets yet"
          description="Add a domain or URL you own to run security scans against it."
          action={<Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add a target</Button>}
        />
      ) : (
        <div className="space-y-3">
          {(targets.data ?? []).map((t) => (
            <Card key={t.id}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{t.target}</span>
                      {t.consent_active ? (
                        <Badge variant="success" className="gap-1"><Unlock className="h-3 w-3" /> active authorised</Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1"><Lock className="h-3 w-3" /> passive only</Badge>
                      )}
                    </div>
                    {t.consent_active && t.consented_at && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">Consent recorded {new Date(t.consented_at).toLocaleString()}</p>
                    )}
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => removeTarget(t.id)} title="Remove target">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                {/* Passive scans — always available */}
                <div className="mt-3">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Defensive (instant)</div>
                  <div className="flex flex-wrap gap-1.5">
                    {PASSIVE.map((p) => (
                      <Button key={p.type} size="sm" variant="outline" disabled={busy === `${t.id}:${p.type}`} onClick={() => runScan(t, p.type)}>
                        {busy === `${t.id}:${p.type}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} {p.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Active scans — consent-gated */}
                <div className="mt-3">
                  <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Active (consent required)
                    <button onClick={() => toggleConsent(t)} disabled={busy === t.id}
                      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 normal-case",
                        t.consent_active ? "border-emerald-500/40 text-emerald-500" : "border-border text-muted-foreground hover:text-foreground")}>
                      {busy === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : t.consent_active ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                      {t.consent_active ? "Authorised — revoke" : "Authorise active scans"}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ACTIVE.map((a) => (
                      <Button key={a.type} size="sm" variant="outline"
                        disabled={!t.consent_active || busy === `${t.id}:${a.type}`}
                        onClick={() => runScan(t, a.type)}
                        title={t.consent_active ? "" : "Authorise the target first"}>
                        {busy === `${t.id}:${a.type}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />} {a.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Recent scans + findings */}
      {(scans.data ?? []).length > 0 && (
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent scans</h2>
          <div className="space-y-2">
            {(scans.data ?? []).map((s) => <ScanRow key={s.id} scan={s} projectId={projectId} />)}
          </div>
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add a scan target</DialogTitle></DialogHeader>
          <p className="-mt-1 text-sm text-muted-foreground">A domain or URL. Passive checks work immediately; active scanning needs your authorisation per target.</p>
          <Input value={newTarget} onChange={(e) => setNewTarget(e.target.value)} placeholder="app.example.com" autoFocus />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={addTarget} disabled={busy === "add" || !newTarget.trim()}>
              {busy === "add" && <Loader2 className="h-4 w-4 animate-spin" />} Add
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ScanRow({ scan, projectId }: { scan: Scan; projectId: string }) {
  const [open, setOpen] = useState(false);
  const findings = useQuery({
    queryKey: ["sec_findings", scan.id],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase.from("security_scan_findings")
        .select("*").eq("scan_id", scan.id)
        .order("severity", { ascending: false });
      return (data ?? []) as Finding[];
    },
  });
  const statusVariant = scan.status === "completed" ? "success" : scan.status === "failed" ? "destructive" : scan.status === "blocked" ? "destructive" : "warning";
  return (
    <Card>
      <CardContent className="p-3">
        <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
          <span className="font-mono text-xs">{scan.scan_type}</span>
          <Badge variant={scan.mode === "active" ? "warning" : "outline"} className="text-[10px]">{scan.mode}</Badge>
          <span className="truncate text-xs text-muted-foreground">{scan.target_host}</span>
          <Badge variant={statusVariant} className="ml-auto">{scan.status}</Badge>
          <span className="text-[10px] text-muted-foreground">{new Date(scan.created_at).toLocaleTimeString()}</span>
        </button>
        {scan.status === "blocked" && scan.error_message && (
          <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{scan.error_message}</p>
        )}
        {open && (
          <div className="mt-2 space-y-1.5">
            {findings.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading findings…</p>
            ) : (findings.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No findings recorded.</p>
            ) : (
              (findings.data ?? []).map((f) => {
                const sev = SEV[f.severity] ?? SEV.info;
                const Icon = sev.icon;
                return (
                  <div key={f.id} className="rounded-md border border-border p-2.5">
                    <div className="flex items-center gap-2">
                      <Icon className={cn("h-3.5 w-3.5", f.severity === "critical" || f.severity === "high" ? "text-destructive" : f.severity === "medium" ? "text-amber-500" : "text-muted-foreground")} />
                      <span className="text-sm font-medium">{f.title}</span>
                      <Badge variant={sev.variant} className="ml-auto text-[10px]">{f.severity}</Badge>
                    </div>
                    {f.detail && <p className="mt-1 text-xs text-muted-foreground">{f.detail}</p>}
                    {f.remediation && (
                      <p className="mt-1 text-xs"><span className="font-medium text-emerald-500">Fix: </span><span className="text-muted-foreground">{f.remediation}</span></p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
