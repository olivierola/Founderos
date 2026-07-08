import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { aiopsTabPath } from "@/lib/navigation";
import { Activity, BellRing, Lightbulb, ArrowRight, MessagesSquare, Mail, Smartphone } from "lucide-react";
import { ChartLineUpIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { Pill } from "../ui";
import { genMonitoring, DRIFT_META, usd } from "./data";
import { useAlertRulesDb } from "./db";

function Tile({ label, value, alarm }: { label: string; value: string; alarm?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("font-stat-number mt-1 text-lg font-semibold tabular-nums tracking-tight", alarm && "text-red-500")}>{value}</div>
    </div>
  );
}

export function GovFtMonitoringPage() {
  const { projectId } = useCurrentContext();
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const navigate = useNavigate();
  const mon = useMemo(() => (projectId ? genMonitoring(projectId) : null), [projectId]);
  const { rules, toggle } = useAlertRulesDb();
  if (!mon) return <p className="text-sm text-muted-foreground">Chargement…</p>;

  const t = mon.tiles;
  const minAcc = Math.min(...mon.accuracyTrend), maxAcc = Math.max(...mon.accuracyTrend);
  const lastAcc = mon.accuracyTrend[mon.accuracyTrend.length - 1];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Monitoring"
        description="Surveillance continue des modèles en production : trafic, qualité, dérives — avec alertes Slack, email et SMS."
      />

      {/* 8 tuiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <Tile label="Requêtes" value={`${t.reqPerMin}/min`} />
        <Tile label="Temps moyen" value={`${t.avgMs} ms`} />
        <Tile label="Erreurs" value={`${t.errPct}%`} alarm={t.errPct >= 2} />
        <Tile label="Hallucinations" value={`${t.hallucPct}%`} alarm={t.hallucPct > 5} />
        <Tile label="Satisfaction" value={`${t.satisfactionPct}%`} />
        <Tile label="Coût / jour" value={usd(t.costDay)} />
        <Tile label="GPU" value={`${t.gpuPct}%`} alarm={t.gpuPct >= 85} />
        <Tile label="Mémoire" value={`${t.memPct}%`} alarm={t.memPct >= 85} />
      </div>

      {/* Recommandation (dérive détectée → re-fine-tuning) */}
      {mon.recommendation && (
        <Card className="flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="flex-1">
            <div className="text-sm font-medium">Recommandation</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{mon.recommendation}</p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => navigate(aiopsTabPath(workspaceSlug, projectSlug, "ops-finetuning"))}>
            Ré-entraîner <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Accuracy 14 j — une série, une teinte */}
        <Card className="p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="flex items-center gap-2 text-sm font-medium"><ChartLineUpIcon weight="duotone" className="h-4 w-4 text-[hsl(var(--accent-teal))]" />Accuracy (14 j)</span>
            <span className={cn("text-sm font-semibold tabular-nums", lastAcc < 90 ? "text-red-500" : "text-emerald-500")}>{lastAcc}%</span>
          </div>
          <div className="flex h-24 items-end gap-1">
            {mon.accuracyTrend.map((v, i) => (
              <div key={i} className="group relative flex h-full flex-1 flex-col justify-end">
                <div
                  className={cn("rounded-t-[3px]", v < 90 ? "bg-red-500/80" : "bg-[hsl(var(--accent-teal))]")}
                  style={{ height: `${((v - minAcc + 1) / (maxAcc - minAcc + 1)) * 100}%` }}
                />
                <div className="pointer-events-none absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-1.5 py-0.5 text-[10px] shadow-md group-hover:block">
                  J-{13 - i} · {v}%
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">Seuil d'alerte : 90% — les jours sous le seuil sont en rouge.</p>
        </Card>

        {/* Dérives */}
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Activity className="h-4 w-4 text-muted-foreground" />Détection de dérive</div>
          <div className="space-y-3">
            {mon.drifts.map((d) => (
              <div key={d.kind}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium">{DRIFT_META[d.kind].label}</span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-muted-foreground">{d.score}/10</span>
                    <Pill meta={d.status === "ok" ? { label: "OK", tone: "emerald" } : d.status === "warning" ? { label: "À surveiller", tone: "amber" } : { label: "Critique", tone: "red" }} className="px-1.5 py-0 text-[10px]" />
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", d.status === "ok" ? "bg-[hsl(var(--accent-teal))]" : d.status === "warning" ? "bg-amber-500" : "bg-red-500")}
                    style={{ width: `${(d.score / 10) * 100}%` }}
                  />
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{DRIFT_META[d.kind].desc}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Alertes multicanales */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3.5 text-sm font-medium">
          <BellRing className="h-4 w-4 text-muted-foreground" /> Règles d'alerte
        </div>
        <div className="divide-y divide-border/60">
          {rules.map((a) => {
            const firing = mon.alertRules.find((x) => x.rule === a.rule)?.firing ?? false;
            return (
              <div key={a.id} className={cn("flex flex-wrap items-center gap-3 px-5 py-3 text-sm", firing && "bg-red-500/5")}>
                <span className="min-w-0 flex-1 font-medium">{a.rule}</span>
                {/* Channels are persisted — click to toggle where the alert notifies. */}
                <button onClick={() => toggle(a, "slack")} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-secondary", a.slack ? "text-foreground" : "text-muted-foreground/40 line-through")}><MessagesSquare className="h-3.5 w-3.5" />Slack</button>
                <button onClick={() => toggle(a, "email")} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-secondary", a.email ? "text-foreground" : "text-muted-foreground/40 line-through")}><Mail className="h-3.5 w-3.5" />Email</button>
                <button onClick={() => toggle(a, "sms")} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-secondary", a.sms ? "text-foreground" : "text-muted-foreground/40 line-through")}><Smartphone className="h-3.5 w-3.5" />SMS</button>
                {firing && <Pill meta={{ label: "Déclenchée", tone: "red" }} className="px-1.5 py-0 text-[10px]" />}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
