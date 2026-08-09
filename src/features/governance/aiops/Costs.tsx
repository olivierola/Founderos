import { useMemo, useState, useEffect } from "react";
import { Wallet, Cloud, Server, Cpu, Gauge, Receipt } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Pill } from "../ui";
import { useProjectAgents, usd, timeAgo, HOSTING_META, type PrivateServer } from "./data";
import { useServersDb, useRealGovCosts, useInfraCostLedger, useProjectBudgetDb } from "./db";
import { useCostReconciler } from "./infra";

export function GovCostsPage() {
  const { data: agents } = useProjectAgents();
  const { servers } = useServersDb();
  const { costs, loading } = useRealGovCosts(agents ?? [], servers);
  const { entries: ledger } = useInfraCostLedger();
  const { budget, save: saveBudget } = useProjectBudgetDb();
  // Persist real billing segments every minute while paid pods run; the ledger
  // rows then stream back through realtime.
  useCostReconciler(servers);

  // Live ticker: the "open" billing segment (since last reconcile) is computed
  // client-side so the gauge and per-server costs move in real time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const liveInfra = useMemo(() => {
    let live = 0;
    for (const s of servers) {
      live += s.accruedCostUsd;
      if (s.runningSince && (s.status === "online" || s.status === "degraded") && s.hourlyUsd > 0) {
        live += (Math.max(0, now - new Date(s.runningSince).getTime()) / 3_600_000) * s.hourlyUsd;
      }
    }
    return live;
  }, [servers, now]);

  if (loading) return <PageSkeleton cards={3} rows={5} />;

  // ── Budget: dépense = API (runs) + infra facturée (ledger, 30 j) + estimate
  // seed + segment ouvert en cours.
  const apiUsd = costs?.apiUsd ?? 0;
  const ledger30d = ledger
    .filter((e) => now - new Date(e.createdAt).getTime() < 30 * 86_400_000)
    .reduce((s, e) => s + e.usd, 0);
  const seedEst = servers.reduce((s, x) => s + (x.source === "seed" ? x.costPerDay : 0), 0) * 30;
  const spend = apiUsd + ledger30d + seedEst + liveInfra;
  const budgetPct = budget.monthlyUsd > 0 ? Math.min(100, (spend / budget.monthlyUsd) * 100) : 0;
  const overAlert = budgetPct >= budget.alertPct;
  const openTotal = servers.reduce((s, x) => s + (x.hourlyUsd > 0 ? x.hourlyUsd : 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dépenses IA"
        description="Coûts réels : facturation API des runs (tokens) + segments de facturation des pods infra, consolidés en direct."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Total" value={usd(spend)} icon={Wallet} hint="API + infra, en direct" />
        <MetricCard label="Dépense API" value={usd(costs?.apiUsd ?? 0)} icon={Cloud} hint="fournisseurs LLM (tokens)" />
        <MetricCard label="Infrastructure" value={usd(liveInfra)} icon={Server} hint="pods facturés, segment ouvert inclus" />
        <MetricCard label="Budget mensuel" value={usd(budget.monthlyUsd)} icon={Gauge} hint={`${Math.round(budgetPct)}% utilisé`} />
      </div>

      {/* Budget projet + alerte de dépassement */}
      <BudgetCard
        spend={spend}
        monthlyUsd={budget.monthlyUsd}
        alertPct={budget.alertPct}
        budgetPct={budgetPct}
        overAlert={overAlert}
        saving={saveBudget}
      />

      {!costs && (
        <div className="rounded-lg border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
          Aucun run d'agent pour l'instant — la dépense API s'affichera ici dès la première exécution. Le suivi infra ci-dessous fonctionne déjà.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Infra réelle, serveur par serveur */}
        <Card className="p-5">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium">Infrastructure réelle</span>
            <span className="text-[11px] text-muted-foreground">+ {usd(openTotal)} / h en cours</span>
          </div>
          <p className="mb-4 text-[11px] text-muted-foreground">
            Segments de facturation écrits par le pod (hours × tarif horaire) — mis à jour en direct.
          </p>
          <div className="space-y-3">
            {servers.filter((s) => s.source !== "seed" || s.costPerDay > 0).map((s) => <ServerCostRow key={s.id} s={s} now={now} />)}
            {servers.length === 0 && <p className="text-xs text-muted-foreground">Aucun serveur provisionné.</p>}
          </div>
        </Card>

        {/* Ledger des segments */}
        <Card className="flex max-h-[26rem] flex-col overflow-hidden">
          <div className="border-b border-border/60 px-5 py-3.5 text-sm font-medium">Derniers segments facturés</div>
          {ledger.length === 0 ? (
            <div className="p-5">
              <EmptyState icon={Receipt} title="Aucun segment" description="Les segments apparaissent dès qu'un pod loué a été facturé (reconcil cost ~1 min)." />
            </div>
          ) : (
            <div className="scrollbar-slim divide-y divide-border/60 overflow-auto">
              {ledger.slice(0, 12).map((e) => (
                <div key={e.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{e.serverName}</span>
                      <Pill meta={{ label: e.kind === "training" ? "entraînement" : "inférence", tone: e.kind === "training" ? "violet" : "emerald" }} className="px-1.5 py-0 text-[10px]" />
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {e.hours.toFixed(2)} h · {new Date(e.periodStart).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                      {" → "}
                      {new Date(e.periodEnd).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                      <span className="mx-1 text-border">·</span>{timeAgo(e.createdAt)}
                    </div>
                  </div>
                  <div className="shrink-0 font-medium tabular-nums">{usd(e.usd)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {costs && (
        <>
          {(() => { const maxDaily = Math.max(...costs.daily.map((d) => d.usd)); return (
            <Card className="p-5">
              <div className="mb-4 flex items-baseline justify-between">
                <span className="text-sm font-medium">Dépense API journalière (14 j)</span>
                <span className="text-xs text-muted-foreground">max {usd(maxDaily)}</span>
              </div>
              <div className="flex h-32 items-end gap-1">
                {costs.daily.map((d) => (
                  <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end">
                    <div
                      className="rounded-t-[4px] bg-[hsl(var(--accent-teal))] transition-opacity group-hover:opacity-80"
                      style={{ height: `${Math.max(4, (d.usd / maxDaily) * 100)}%` }}
                    />
                    <div className="pointer-events-none absolute -top-8 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] shadow-md group-hover:block">
                      <span className="text-muted-foreground">{d.day}</span> · <span className="font-medium">{usd(d.usd)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                <span>{costs.daily[0]?.day}</span>
                <span>{costs.daily[costs.daily.length - 1]?.day}</span>
              </div>
            </Card>
          ); })()}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-4 text-sm font-medium">Coûts unitaires moyens</div>
              <div className="grid grid-cols-2 gap-3">
                {costs.byBucket.map((b) => (
                  <div key={b.label} className="rounded-lg border border-border/60 bg-muted/20 p-3">
                    <div className="text-xs text-muted-foreground">{b.label}</div>
                    <div className="mt-1 text-lg font-semibold tracking-tight">{usd(b.usd)}</div>
                    <div className="text-[11px] text-muted-foreground">{b.hint}</div>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-5">
              <div className="mb-4 text-sm font-medium">Dépense par modèle</div>
              <div className="space-y-3">
                {costs.byModel.map((m) => (
                  <div key={m.model}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-foreground">{m.label}</span>
                        <Pill meta={HOSTING_META[m.hosting]} className="px-1.5 py-0 text-[10px]" />
                      </span>
                      <span className="shrink-0 font-medium text-foreground">{usd(m.usd)}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={m.hosting === "cloud" ? "h-full rounded-full bg-[hsl(var(--accent-teal))]" : "h-full rounded-full bg-violet-500/70"}
                        style={{ width: `${(m.usd / costs.byModel[0].usd) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Cloud = facturation API (tokens) · Propriétaire = quote-part du coût serveur.
              </p>
            </Card>
          </div>

          {(() => { const maxAgent = Math.max(1, ...costs.byAgent.map((a) => a.usd)); return (
            <Card className="overflow-hidden">
              <div className="border-b border-border/60 px-5 py-3.5 text-sm font-medium">Dépense API par agent</div>
              <div className="divide-y divide-border/60">
                {costs.byAgent.map((a) => (
                  <div key={a.agentId} className="flex items-center gap-4 px-5 py-3 text-sm">
                    <div className="w-40 truncate font-medium">{a.name}</div>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-[hsl(var(--accent-teal))]" style={{ width: `${(a.usd / maxAgent) * 100}%` }} />
                    </div>
                    <div className="w-16 text-right text-xs text-muted-foreground">{a.runs} runs</div>
                    <div className="w-20 text-right font-medium">{usd(a.usd)}</div>
                  </div>
                ))}
              </div>
            </Card>
          ); })()}
        </>
      )}

      <Card className="flex items-start gap-3 border-dashed p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--accent-aqua)/0.25)] text-[hsl(var(--accent-teal))]">
          <Cpu className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            Modèles self-hosted
            <span className="rounded-full bg-[hsl(var(--accent-coral)/0.14)] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--primary-soft))]">Suivi</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Les modèles servis via vos propres endpoints (aiops_providers, RunPod) sont facturés au tarif maison (30¢ / 60¢ par M de tokens) et apparaissent en <span className="font-medium text-foreground">self-hosted</span> dans la dépense par modèle et le monitoring des prompts.
          </p>
        </div>
      </Card>
    </div>
  );
}

/** Budget mensuel : montant + seuil d'alerte, jauge de consommation en direct. */
function BudgetCard(props: {
  spend: number; monthlyUsd: number; alertPct: number; budgetPct: number; overAlert: boolean;
  saving: (b: { monthlyUsd: number; alertPct: number }) => Promise<void>;
}) {
  const [monthly, setMonthly] = useState(String(props.monthlyUsd));
  const [alertPct, setAlertPct] = useState(String(props.alertPct));
  const [saving, setSaving] = useState(false);
  const dirty = Number(monthly) !== props.monthlyUsd || Number(alertPct) !== props.alertPct;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-sm font-medium">Budget mensuel</span>
            {props.overAlert && (
              <Pill meta={{ label: `Seuil d'alerte atteint (${props.alertPct}%)`, tone: "amber" }} className="px-2 py-0.5 text-[11px]" />
            )}
          </div>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
            <div
              className={props.budgetPct >= 100 ? "h-full rounded-full bg-red-500" : props.overAlert ? "h-full rounded-full bg-amber-500" : "h-full rounded-full bg-[hsl(var(--accent-teal))]"}
              style={{ width: `${Math.max(2, props.budgetPct)}%` }}
            />
          </div>
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            {usd(props.spend)} dépensés · <span className="tabular-nums">{props.budgetPct.toFixed(1)}%</span> du budget · {usd(Math.max(0, props.monthlyUsd - props.spend))} restants
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">Budget ($/mois)</span>
            <Input type="number" min={0} value={monthly} onChange={(e) => setMonthly(e.target.value)} className="h-8 w-28" />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">Alerte à (%)</span>
            <Input type="number" min={1} max={100} value={alertPct} onChange={(e) => setAlertPct(e.target.value)} className="h-8 w-20" />
          </label>
          <Button
            size="sm" disabled={!dirty || saving}
            onClick={async () => { setSaving(true); try { await props.saving({ monthlyUsd: Number(monthly) || 0, alertPct: Math.min(100, Number(alertPct) || 100) }); } finally { setSaving(false); } }}
          >
            {saving ? "…" : "Enregistrer"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** Coût réel d'un serveur : total facturé + segment en cours qui défile. */
function ServerCostRow({ s, now }: { s: PrivateServer; now: number }) {
  const open = s.runningSince && (s.status === "online" || s.status === "degraded")
    ? (Math.max(0, now - new Date(s.runningSince).getTime()) / 3_600_000) * s.hourlyUsd
    : 0;
  const total = s.accruedCostUsd + open;
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{s.name}</span>
            <Pill meta={{ label: s.source === "runpod" ? "Loué · RunPod" : "Seed", tone: s.source === "runpod" ? "violet" : "slate" }} className="px-1.5 py-0 text-[10px]" />
            <Pill meta={s.status === "online" ? { label: "En ligne", tone: "emerald" } : s.status === "degraded" ? { label: "Dégradé", tone: "amber" } : { label: "Hors ligne", tone: "red" }} className="px-1.5 py-0 text-[10px]" />
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{s.gpu}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold tabular-nums">{usd(total)}</div>
          <div className="text-[11px] text-muted-foreground">
            {s.hourlyUsd > 0 ? `${usd(s.hourlyUsd)} / h` : `${usd(s.costPerDay)} / j`}
          </div>
        </div>
      </div>
      {(s.source === "runpod" || s.hourlyUsd > 0) && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Facturé : <span className="tabular-nums">{s.accruedHours.toFixed(1)} h</span></span>
          <span className="text-border">·</span>
          {s.runningSince && s.hourlyUsd > 0
            ? <span className="tabular-nums">segment en cours : {open > 0.005 ? usd(open) : "…"}</span>
            : <span>segment fermé</span>}
        </div>
      )}
    </div>
  );
}
