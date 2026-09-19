import { useMemo } from "react";
import {
  BellRingingIcon as BellRing,
  ChatsIcon as MessagesSquare,
  EnvelopeSimpleIcon as Mail,
  DeviceMobileIcon as Smartphone,
  PulseIcon as Activity,
  GaugeIcon as Gauge,
  ShieldWarningIcon as ShieldAlert,
  TrendUpIcon as TrendingUp,
  CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { usd, type FtEndpoint } from "./data";
import { useAlertRulesDb, useServersDb, useFtVersionsDb, useFtEndpointsDb } from "./db";

const driftStatus = (s: number): "ok" | "warning" | "critical" => (s >= 5 ? "critical" : s >= 3 ? "warning" : "ok");
const DRIFT_TONE: Record<"ok" | "warning" | "critical", string> = {
  ok: "text-emerald-500 bg-emerald-500/10", warning: "text-amber-500 bg-amber-500/10", critical: "text-red-500 bg-red-500/10",
};

/** Trafic agrégé jour par jour (req/jour) pour la courbe des 14 derniers jours. */
function useDailySeries(active: FtEndpoint[]): { day: string; req: number }[] {
  return useMemo(() => {
    const acc = new Map<string, number>();
    for (const e of active) for (const d of e.daily) acc.set(d.day, (acc.get(d.day) ?? 0) + d.req);
    return [...acc.entries()].map(([day, req]) => ({ day, req })).sort((a, b) => a.day.localeCompare(b.day));
  }, [active]);
}

export function GovFtMonitoringPage() {
  const { servers } = useServersDb();
  const { versions } = useFtVersionsDb(servers);
  const { endpoints, loading: endpointsLoading } = useFtEndpointsDb(servers, versions);
  const { rules, toggle } = useAlertRulesDb();

  const active = useMemo(() => endpoints.filter((e) => e.status === "active"), [endpoints]);

  // ── Live aggregates over active endpoints ─────────────────────────────────
  const agg = useMemo(() => {
    const n = Math.max(1, active.length);
    const totReq = active.reduce((s, e) => s + e.reqPerMin, 0);
    const w = (f: (e: FtEndpoint) => number) => active.reduce((s, e) => s + f(e) * (e.reqPerMin || 1), 0) / active.reduce((s, e) => s + (e.reqPerMin || 1), 0);
    return {
      reqPerMin: totReq,
      p95Ms: Math.round(w((e) => e.p95Ms)),
      errRatePct: Math.round(w((e) => e.errRatePct) * 10) / 10,
      hallucinationPct: Math.round(w((e) => e.hallucinationPct) * 10) / 10,
      satisfactionPct: Math.round(w((e) => e.satisfactionPct) * 10) / 10,
      tokensPerDay: Math.round(active.reduce((s, e) => s + e.tokensPerDay, 0) * 10) / 10,
      costDay: Math.round(active.reduce((s, e) => s + e.tokensPerDay * 0.3, 0) * 100) / 100,
      n,
    };
  }, [active]);

  const drifts = useMemo(
    () => active.map((e) => ({ id: e.id, name: `${e.versionName} ${e.version}`, score: e.driftScore, status: driftStatus(e.driftScore) }))
      .sort((a, b) => b.score - a.score),
    [active],
  );
  const worst = drifts[0] ?? null;

  // ── Alert rules: firing when a live endpoint violates the threshold ───────
  const firing = useMemo(() => {
    const violation = (rule: string) => {
      if (/hallucination/i.test(rule)) return active.some((e) => e.hallucinationPct > 5);
      if (/drift|dérive/i.test(rule)) return active.some((e) => e.driftScore > 5);
      if (/erreurs?\s*>/i.test(rule)) return active.some((e) => e.errRatePct > 2);
      if (/accuracy\s*</i.test(rule)) return active.some((e) => e.satisfactionPct < 90);
      return false;
    };
    return rules.map((r) => ({ ...r, firing: violation(r.rule) }));
  }, [rules, active]);

  const recommendation = useMemo(() => {
    if (active.length === 0) return null;
    const critical = active.find((e) => e.driftScore >= 5);
    if (critical) return `Dérive critique (${critical.driftScore}/10) détectée sur ${critical.versionName} ${critical.version} — ré-entraînez avec les données des 30 derniers jours (onglet Entraînements).`;
    const errors = active.find((e) => e.errRatePct > 2);
    if (errors) return `${errors.versionName} ${errors.version} dépasse 2% d'erreurs — le rollback automatique est ${errors.autoRollback ? "armé" : "désactivé"}.`;
    const badSat = active.find((e) => e.satisfactionPct < 90);
    if (badSat) return `Satisfaction sous 90% sur ${badSat.versionName} — pensez à relancer une évaluation LLM-judge.`;
    return null;
  }, [active]);

  const daily = useDailySeries(active);
  const maxReq = Math.max(...daily.map((d) => d.req), 1);

  if (endpointsLoading) return <PageSkeleton cards={4} rows={6} />;

  // Aucun modèle déployé → on garde l'état vide explicite (pas de mock).
  if (active.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Monitoring" description="Surveillance continue des modèles en production : trafic, qualité, dérives — avec alertes Slack, email et SMS." />
        <EmptyState
          icon={Activity}
          title="Aucune télémétrie de production"
          description="Déployez une version affinée (onglet Déploiement) pour voir ici le trafic, la qualité et les dérives en temps réel."
        />
        <AlertRules rules={rules} firing={[]} toggle={toggle} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Monitoring"
        description="Surveillance continue des modèles en production : trafic, qualité, dérives — avec alertes Slack, email et SMS."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Requêtes / min" value={String(agg.reqPerMin.toFixed(0))} icon={Activity} hint={`${agg.n} endpoint${agg.n > 1 ? "s" : ""} actif${agg.n > 1 ? "s" : ""}`} />
        <MetricCard label="Latence P95" value={`${agg.p95Ms} ms`} icon={Gauge} />
        <MetricCard label="Erreurs" value={`${agg.errRatePct}%`} icon={ShieldAlert} hint={firing.some((r) => r.rule.includes("Erreurs")) ? "seuil dépassé" : "sous le seuil"} />
        <MetricCard label="Hallucinations" value={`${agg.hallucinationPct}%`} icon={Activity} />
        <MetricCard label="Satisfaction" value={`${agg.satisfactionPct}%`} />
        <MetricCard label="Trafic / coût jour" value={`${agg.tokensPerDay.toFixed(1)} M · ${usd(agg.costDay)}`} icon={TrendingUp} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Trafic 14 j */}
        <Card className="p-5 lg:col-span-3">
          <div className="mb-3 text-sm font-medium">Trafic — 14 derniers jours (req/jour)</div>
          {daily.length === 0 ? (
            <p className="text-xs text-muted-foreground">Pas encore de données de trafic.</p>
          ) : (
            <div className="flex h-40 items-end gap-1.5">
              {daily.map((d) => (
                <div key={d.day} className="group relative flex flex-1 flex-col items-center justify-end" title={`${d.day} · ${d.req.toLocaleString("fr-FR")} req`}>
                  <div className="w-full rounded-t bg-[hsl(var(--accent-teal)/0.85)] transition-colors group-hover:bg-[hsl(var(--accent-teal))]" style={{ height: `${(d.req / maxReq) * 100}%` }} />
                  <span className="mt-1 text-[9px] text-muted-foreground">{d.day.slice(3)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Dérives */}
        <Card className="p-5 lg:col-span-2">
          <div className="mb-3 text-sm font-medium">Dérives par endpoint</div>
          {drifts.length === 0 ? (
            <p className="text-xs text-muted-foreground">Aucun endpoint actif.</p>
          ) : (
            <div className="space-y-2">
              {drifts.map((d) => (
                <div key={d.id} className="flex items-center gap-2 rounded-md border border-border/60 p-2">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", d.status === "critical" ? "bg-red-500" : d.status === "warning" ? "bg-amber-400" : "bg-emerald-500")} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{d.name}</span>
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", DRIFT_TONE[d.status])}>{d.score}/10</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {recommendation && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-600 dark:text-amber-400">
          <ShieldAlert className="mr-1.5 inline h-3.5 w-3.5" />{recommendation}
        </div>
      )}

      {worst && worst.status === "critical" && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-500">
          <span className="inline-flex items-center gap-1 font-medium"><Loader2 className="h-3.5 w-3.5 animate-spin" />{worst.name} : dérive critique, surveillance renforcée en cours.</span>
        </div>
      )}

      <AlertRules rules={rules} firing={firing} toggle={toggle} />
    </div>
  );
}

function AlertRules({ rules, firing, toggle }: {
  rules: ReturnType<typeof useAlertRulesDb>["rules"];
  firing: { rule: string; slack: boolean; email: boolean; sms: boolean; firing: boolean }[];
  toggle: (r: { id: string; rule: string; slack: boolean; email: boolean; sms: boolean }, ch: "slack" | "email" | "sms") => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3.5 text-sm font-medium">
        <BellRing className="h-4 w-4 text-muted-foreground" /> Règles d'alerte
        {firing.some((r) => r.firing) && (
          <span className="ml-auto rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-500">⚠ {firing.filter((r) => r.firing).length} déclenchée(s)</span>
        )}
      </div>
      {rules.length === 0 ? (
        <p className="px-5 py-4 text-xs text-muted-foreground">Aucune règle d'alerte configurée.</p>
      ) : (
        <div className="divide-y divide-border/60">
          {rules.map((a) => {
            const firingRule = firing.find((f) => f.rule === a.rule)?.firing ?? false;
            return (
              <div key={a.id} className={cn("flex flex-wrap items-center gap-3 px-5 py-3 text-sm", firingRule && "bg-red-500/5")}>
                <span className={cn("min-w-0 flex-1 font-medium", firingRule && "text-red-500")}>
                  {a.rule}
                  {firingRule && <span className="ml-2 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium">déclenchée</span>}
                </span>
                <button onClick={() => toggle(a, "slack")} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-secondary", a.slack ? "text-foreground" : "text-muted-foreground/40 line-through")}><MessagesSquare className="h-3.5 w-3.5" />Slack</button>
                <button onClick={() => toggle(a, "email")} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-secondary", a.email ? "text-foreground" : "text-muted-foreground/40 line-through")}><Mail className="h-3.5 w-3.5" />Email</button>
                <button onClick={() => toggle(a, "sms")} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-secondary", a.sms ? "text-foreground" : "text-muted-foreground/40 line-through")}><Smartphone className="h-3.5 w-3.5" />SMS</button>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
