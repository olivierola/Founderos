import { useState } from "react";
import {
  RocketLaunchIcon as Rocket,
  PulseIcon as Activity,
  WarningIcon as AlertTriangle,
  HardDrivesIcon as Server,
  ClockCounterClockwiseIcon as History,
  BellRingingIcon as BellRing,
} from "@phosphor-icons/react";
import { RocketIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Pill, FormDialog, type FieldDef } from "../ui";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import {
  timeAgo,
  DEPLOY_ENV_META, DEPLOY_SURFACE_META, type FtEndpoint, type DeployEnv, type DeploySurface,
} from "./data";
import { useServersDb, useFtVersionsDb, useFtEndpointsDb } from "./db";

export function GovFtDeploymentPage() {
  const { servers } = useServersDb();
  const { versions } = useFtVersionsDb(servers);
  const { endpoints, deploy: deployDb, rollback } = useFtEndpointsDb(servers, versions);
  const [sel, setSel] = useState<FtEndpoint | null>(null);
  const [deploying, setDeploying] = useState(false);

  const ready = versions.filter((v) => v.status === "ready");
  const fields: FieldDef[] = [
    { key: "versionId", label: "Version à déployer", type: "select", options: ready.map((v) => ({ value: v.id, label: `${v.name} ${v.version} (${v.winRate}% win)` })) },
    { key: "serverId", label: "Serveur", type: "select", options: servers.map((s) => ({ value: s.id, label: s.name })), half: true },
    { key: "env", label: "Environnement", type: "select", options: DEPLOY_ENV_META, half: true },
    { key: "surface", label: "Exposer via", type: "select", options: DEPLOY_SURFACE_META, half: true },
    { key: "trafficPct", label: "Traffic %", type: "number", half: true, hint: "part du trafic servie (canary / A-B / blue-green)" },
    { key: "autoRollback", label: "Rollback automatique si les performances chutent", type: "checkbox" },
  ];

  const deploy = async (values: Record<string, unknown>) => {
    const v = ready.find((x) => x.id === values.versionId) ?? ready[0];
    if (!v) return;
    const env = (String(values.env) || "staging") as DeployEnv;
    await deployDb(v, {
      serverId: String(values.serverId || (servers[0]?.id ?? "")), env,
      surface: (String(values.surface) || "api") as DeploySurface,
      trafficPct: Number(values.trafficPct) || (env === "canary" ? 10 : env === "ab" || env === "bluegreen" ? 50 : 100),
      autoRollback: Boolean(values.autoRollback),
    });
  };

  const avgP95 = endpoints.length ? Math.round(endpoints.reduce((s, e) => s + e.p95Ms, 0) / endpoints.length) : 0;
  const firing = endpoints.reduce((s, e) => s + e.alerts.filter((a) => a.firing).length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Déploiement"
        description="Production, staging, testing, canary ou A/B avec répartition du trafic — et monitoring continu : erreurs, hallucinations, satisfaction, coût."
        actions={<Button onClick={() => setDeploying(true)} disabled={ready.length === 0}><Rocket className="mr-1.5 h-4 w-4" />Déployer</Button>}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Endpoints actifs" value={String(endpoints.length)} icon={Rocket} />
        <MetricCard label="Latence P95 moyenne" value={`${avgP95} ms`} icon={Activity} />
        <MetricCard label="Alertes actives" value={String(firing)} icon={AlertTriangle} hint="notifiées sur Slack" />
      </div>

      {endpoints.length === 0 ? (
        <EmptyState icon={Rocket} title="Aucun déploiement" description="Déployez une version prête depuis le bouton ci-dessus." />
      ) : (
        <div className="space-y-2">
          {endpoints.map((e) => {
            const server = servers.find((s) => s.id === e.serverId);
            const nFiring = e.alerts.filter((a) => a.firing).length;
            return (
              <Card key={e.id} className="cursor-pointer p-4 transition-colors hover:bg-muted/30" onClick={() => setSel(e)}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{e.versionName} {e.version}</span>
                  <Pill meta={DEPLOY_ENV_META[e.env]} />
                  <Pill meta={DEPLOY_SURFACE_META[e.surface]} className="px-1.5 py-0 text-[10px]" />
                  {e.status === "pending_approval" && <Pill meta={{ label: "En attente d'approbation", tone: "amber" }} />}
                  {e.status === "rolled_back" && <Pill meta={{ label: "Rolled back", tone: "slate" }} />}
                  {e.trafficPct < 100 && (
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{e.trafficPct}% du trafic</span>
                  )}
                  {nFiring > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] text-red-500">
                      <BellRing className="h-3 w-3" />{nFiring} alerte{nFiring > 1 ? "s" : ""}
                    </span>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Server className="h-3.5 w-3.5" />{server?.name ?? e.serverId}</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                  <div><div className="text-sm font-semibold tabular-nums">{e.reqPerMin}</div><div className="text-[10px] text-muted-foreground">req/min</div></div>
                  <div><div className="text-sm font-semibold tabular-nums">{e.p95Ms} ms</div><div className="text-[10px] text-muted-foreground">P95</div></div>
                  <div><div className={cn("text-sm font-semibold tabular-nums", e.errRatePct >= 2 && "text-red-500")}>{e.errRatePct}%</div><div className="text-[10px] text-muted-foreground">erreurs</div></div>
                  <div><div className={cn("text-sm font-semibold tabular-nums", e.hallucinationPct > 5 && "text-red-500")}>{e.hallucinationPct}%</div><div className="text-[10px] text-muted-foreground">hallucinations</div></div>
                  <div><div className="text-sm font-semibold tabular-nums">{e.satisfactionPct}%</div><div className="text-[10px] text-muted-foreground">satisfaction</div></div>
                  <div><div className="text-sm font-semibold tabular-nums">{e.tokensPerDay} M</div><div className="text-[10px] text-muted-foreground">tokens/jour</div></div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {sel && (() => {
        const server = servers.find((s) => s.id === sel.serverId);
        const maxReq = Math.max(1, ...sel.daily.map((d) => d.req));
        return (
          <DetailSheet
            onClose={() => setSel(null)}
            title={`${sel.versionName} ${sel.version}`}
            subtitle={`déployé ${timeAgo(sel.since)} · ${server?.name ?? sel.serverId}`}
            icon={<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--accent-teal)/0.14)] text-[hsl(var(--accent-teal))]"><RocketIcon weight="duotone" className="h-5 w-5" /></div>}
            actions={<Button size="sm" variant="outline" className="h-8" title="Revenir à la version précédente" disabled={sel.status === "rolled_back"} onClick={() => { void rollback(sel); setSel(null); }}><History className="mr-1.5 h-3.5 w-3.5" />Rollback</Button>}
          >
            <DetailSection title="Endpoint">
              <DetailRow label="Environnement"><Pill meta={DEPLOY_ENV_META[sel.env]} /></DetailRow>
              <DetailRow label="Exposé via"><Pill meta={DEPLOY_SURFACE_META[sel.surface]} /></DetailRow>
              <DetailRow label="Traffic">{sel.trafficPct}% du trafic</DetailRow>
              <DetailRow label="Rollback auto">{sel.autoRollback ? "Activé — bascule si les métriques chutent" : "Désactivé"}</DetailRow>
              <DetailRow label="Serveur">{server?.name ?? sel.serverId}{server ? ` · ${server.region}` : ""}</DetailRow>
              <DetailRow label="En service depuis">{new Date(sel.since).toLocaleString("fr-FR")}</DetailRow>
            </DetailSection>

            <DetailSection title="Monitoring">
              <DetailRow label="Trafic">{sel.reqPerMin} req/min</DetailRow>
              <DetailRow label="Latence P95">{sel.p95Ms} ms</DetailRow>
              <DetailRow label="Taux d'erreur"><span className={cn(sel.errRatePct >= 2 && "font-medium text-red-500")}>{sel.errRatePct}%</span></DetailRow>
              <DetailRow label="Hallucinations"><span className={cn(sel.hallucinationPct > 5 && "font-medium text-red-500")}>{sel.hallucinationPct}%</span></DetailRow>
              <DetailRow label="Satisfaction">{sel.satisfactionPct}%</DetailRow>
              <DetailRow label="Tokens / jour">{sel.tokensPerDay} M</DetailRow>
              <DetailRow label="Dérive"><span className={cn(sel.driftScore >= 3 && "font-medium text-amber-500")}>{sel.driftScore} / 10</span></DetailRow>
            </DetailSection>

            {sel.daily.length > 0 && (
              <DetailSection title="Requêtes / jour (14 j)">
                <div className="flex h-20 items-end gap-0.5 rounded-md border border-border bg-card p-2">
                  {sel.daily.map((d) => (
                    <div key={d.day} title={`${d.day} · ${d.req.toLocaleString("fr-FR")} req`} className="flex-1 rounded-t-[3px] bg-[hsl(var(--accent-teal))]" style={{ height: `${Math.max(4, (d.req / maxReq) * 100)}%` }} />
                  ))}
                </div>
              </DetailSection>
            )}

            {sel.alerts.length > 0 && <DetailSection title="Alertes → Slack">
              <div className="space-y-1.5">
                {sel.alerts.map((a) => (
                  <div key={a.rule} className={cn("flex items-center gap-2 rounded-md border p-2 text-xs", a.firing ? "border-red-500/40 bg-red-500/5" : "border-border/60")}>
                    <BellRing className={cn("h-3.5 w-3.5 shrink-0", a.firing ? "text-red-500" : "text-muted-foreground")} />
                    <span className="flex-1">{a.rule}</span>
                    <span className="text-muted-foreground">{a.channel}</span>
                    {a.firing && <Pill meta={{ label: "Déclenchée", tone: "red" }} className="px-1.5 py-0 text-[10px]" />}
                  </div>
                ))}
              </div>
            </DetailSection>}
          </DetailSheet>
        );
      })()}

      {deploying && (
        <FormDialog
          title="Déployer une version"
          fields={fields}
          initial={{ versionId: ready[0]?.id ?? "", serverId: servers[0]?.id ?? "", env: "canary", trafficPct: 10 }}
          submitLabel="Déployer"
          onClose={() => setDeploying(false)}
          onSubmit={deploy}
        />
      )}
    </div>
  );
}
