import {
  FileBarChart, CheckCircle2, XCircle, AlertTriangle, Info, ChevronRight,
  Download, Lightbulb,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface RunReport {
  title: string;
  verdict: "pass" | "fail";
  summary: string;
  metrics: Array<{ label: string; value: string; tone?: "good" | "bad" | "neutral" }>;
  steps: Array<{ label: string; status: "ok" | "fail" | "info" }>;
  findings: Array<{ severity: "info" | "warning" | "critical"; title: string; detail?: string }>;
  recommendations: string[];
}

// ── Compact artifact card shown inline in the chat ──────────────────────────
export function ReportArtifactCard({ report, onOpen }: { report: RunReport; onOpen: () => void }) {
  const pass = report.verdict === "pass";
  const steps = report.steps?.length ?? 0;
  const findings = report.findings?.length ?? 0;
  return (
    <button
      onClick={onOpen}
      className="group w-full overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-foreground/30"
    >
      <div className="flex items-center gap-3 border-b border-border/60 bg-secondary/30 px-3 py-2.5">
        <div className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          pass ? "bg-emerald-500/15 text-emerald-500" : "bg-destructive/15 text-destructive",
        )}>
          <FileBarChart className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{report.title}</div>
          <div className="text-[11px] text-muted-foreground">Test report</div>
        </div>
        <Badge variant={pass ? "success" : "destructive"}>{pass ? "PASS" : "FAIL"}</Badge>
      </div>
      <div className="flex items-center gap-3 px-3 py-2 text-[11px] text-muted-foreground">
        <span>{steps} step{steps > 1 ? "s" : ""}</span>
        {findings > 0 && <><span>·</span><span>{findings} finding{findings > 1 ? "s" : ""}</span></>}
        <span className="ml-auto inline-flex items-center gap-1 text-primary opacity-0 transition-opacity group-hover:opacity-100">
          Open report <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </button>
  );
}

const SEVERITY = {
  info: { icon: Info, cls: "text-sky-500 border-sky-500/30 bg-sky-500/5" },
  warning: { icon: AlertTriangle, cls: "text-amber-500 border-amber-500/30 bg-amber-500/5" },
  critical: { icon: XCircle, cls: "text-destructive border-destructive/30 bg-destructive/5" },
} as const;

// ── Full designed report (in a dialog) ──────────────────────────────────────
export function ReportDialog({
  report, open, onOpenChange,
}: { report: RunReport | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  if (!report) return null;
  const pass = report.verdict === "pass";

  function exportJson() {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `test-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Simple step status bar chart (ok vs fail).
  const okCount = report.steps.filter((s) => s.status === "ok").length;
  const failCount = report.steps.filter((s) => s.status === "fail").length;
  const total = Math.max(report.steps.length, 1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <div className="max-h-[80vh] overflow-y-auto pr-1">
          {/* Header */}
          <div className="flex items-start gap-3">
            <div className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
              pass ? "bg-emerald-500/15 text-emerald-500" : "bg-destructive/15 text-destructive",
            )}>
              {pass ? <CheckCircle2 className="h-6 w-6" /> : <XCircle className="h-6 w-6" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{report.title}</h2>
                <Badge variant={pass ? "success" : "destructive"}>{pass ? "PASS" : "FAIL"}</Badge>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{report.summary}</p>
            </div>
            <Button size="sm" variant="outline" onClick={exportJson} className="shrink-0 gap-1.5">
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
          </div>

          {/* KPI metrics */}
          {report.metrics.length > 0 && (
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {report.metrics.map((m, i) => (
                <div key={i} className="rounded-xl border border-border bg-card/40 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{m.label}</div>
                  <div className={cn(
                    "mt-1 text-lg font-semibold",
                    m.tone === "good" && "text-emerald-500",
                    m.tone === "bad" && "text-destructive",
                  )}>
                    {m.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Step outcome chart */}
          {report.steps.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Step outcomes</div>
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-secondary">
                <div className="h-full bg-emerald-500" style={{ width: `${(okCount / total) * 100}%` }} />
                <div className="h-full bg-destructive" style={{ width: `${(failCount / total) * 100}%` }} />
              </div>
              <div className="mt-1 flex gap-4 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> {okCount} ok</span>
                {failCount > 0 && <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-destructive" /> {failCount} failed</span>}
              </div>
            </div>
          )}

          {/* Findings */}
          {report.findings.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Findings</div>
              <div className="space-y-2">
                {report.findings.map((f, i) => {
                  const sev = SEVERITY[f.severity] ?? SEVERITY.info;
                  const Icon = sev.icon;
                  return (
                    <div key={i} className={cn("flex items-start gap-2 rounded-lg border p-2.5", sev.cls)}>
                      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">{f.title}</div>
                        {f.detail && <p className="text-xs text-muted-foreground">{f.detail}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Steps */}
          {report.steps.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Steps</div>
              <ol className="space-y-1">
                {report.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    {s.status === "fail"
                      ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                      : s.status === "info"
                        ? <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />}
                    <span className="text-foreground/90">{s.label}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Recommendations */}
          {report.recommendations.length > 0 && (
            <div className="mt-5 rounded-xl border border-primary/20 bg-primary/5 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                <Lightbulb className="h-3.5 w-3.5" /> Recommendations
              </div>
              <ul className="space-y-1">
                {report.recommendations.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
