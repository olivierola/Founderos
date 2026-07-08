import { useMemo, useState } from "react";
import { Coins, Cpu, TrendingUp, Calculator } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { Pill, Field } from "../ui";
import {
  forecastMonthly, forecastToday, costShares, usd, timeAgo,
  GPU_RATE_PER_HOUR, FT_COST_KIND_META, type FtCostKind, type FtCostEntry,
} from "./data";
import { useServersDb, useFtJobsDb, useFtEndpointsDb, useFtVersionsDb } from "./db";

export function GovFtCostsPage() {
  const { projectId } = useCurrentContext();
  const { servers } = useServersDb();
  const { jobs } = useFtJobsDb(servers);
  const { versions } = useFtVersionsDb(servers);
  const { endpoints } = useFtEndpointsDb(servers, versions);
  // Real cost ledger: training from real jobs, storage/serving from real
  // servers, inference estimated from active endpoints' traffic.
  const entries = useMemo<FtCostEntry[]>(() => {
    const training = jobs.filter((j) => j.gpuHours > 0).map((j) => ({
      id: `t_${j.id}`, label: j.name, kind: "training" as const, gpuHours: j.gpuHours, usd: j.costUsd, ts: j.startedAt,
    }));
    const storage = servers.map((s) => ({
      id: `s_${s.id}`, label: `${s.name} — infra 30 j`, kind: "storage" as const, gpuHours: 0,
      usd: Math.round(s.costPerDay * 30 * 100) / 100, ts: new Date().toISOString(),
    }));
    const inference = endpoints.filter((e) => e.status === "active").map((e) => {
      const h = Math.round(((e.reqPerMin || 1) * 0.4) * 10) / 10;
      return { id: `i_${e.id}`, label: `${e.versionName} ${e.version} — serving`, kind: "inference" as const, gpuHours: h, usd: Math.round(h * GPU_RATE_PER_HOUR * 100) / 100, ts: e.since };
    });
    return [...training, ...storage, ...inference].sort((a, b) => b.ts.localeCompare(a.ts));
  }, [jobs, servers, endpoints]);

  const totalH = entries.reduce((s, e) => s + e.gpuHours, 0);
  const { current, forecast } = forecastMonthly(entries);
  const { today, eom } = forecastToday(entries);
  const shares = useMemo(() => (projectId ? costShares(entries, projectId) : null), [entries, projectId]);

  const byKind = useMemo(() => {
    const kinds: FtCostKind[] = ["training", "inference", "storage", "api"];
    const sums = kinds.map((k) => ({ kind: k, usd: Math.round(entries.filter((e) => e.kind === k).reduce((s, e) => s + e.usd, 0) * 100) / 100 }));
    const max = Math.max(1, ...sums.map((s) => s.usd));
    return { sums, max };
  }, [entries]);

  // Estimateur : lignes × époques → tokens → GPU·h → $.
  const [rows, setRows] = useState(5000);
  const [epochs, setEpochs] = useState(3);
  const [avgTokens, setAvgTokens] = useState(600);
  const est = useMemo(() => {
    const tokens = rows * avgTokens * epochs;
    const gpuH = Math.max(0.2, Math.round((tokens / 2_600_000) * 10) / 10); // ~2.6M tokens / GPU·h (LoRA 30B)
    return { tokens, gpuH, cost: Math.round(gpuH * GPU_RATE_PER_HOUR * 100) / 100 };
  }, [rows, epochs, avgTokens]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Coûts"
        description="Dashboard financier du fine-tuning : GPU, API, stockage — entraînement vs inférence, avec prévision mensuelle et estimateur."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Total (30 j)" value={usd(current)} icon={Coins} />
        <MetricCard label="Heures GPU" value={totalH.toFixed(1)} icon={Cpu} hint={`au tarif ${usd(GPU_RATE_PER_HOUR)} / GPU·h`} />
        <MetricCard label="Prévision mensuelle" value={usd(forecast)} icon={TrendingUp} delta="+12% vs mois courant" trend="up" />
      </div>

      {/* Aujourd'hui → fin de mois */}
      <Card className="flex flex-wrap items-center gap-6 p-5">
        <div>
          <div className="text-xs text-muted-foreground">Aujourd'hui</div>
          <div className="font-stat-number text-2xl font-semibold tabular-nums tracking-tight">{usd(today)}</div>
        </div>
        <div className="text-2xl text-muted-foreground">→</div>
        <div>
          <div className="text-xs text-muted-foreground">Fin du mois (projection)</div>
          <div className="font-stat-number text-2xl font-semibold tabular-nums tracking-tight text-[hsl(var(--accent-teal))]">{usd(eom)}</div>
        </div>
        <p className="ml-auto max-w-xs text-[11px] text-muted-foreground">
          Projection au rythme de dépense courant — entraînements planifiés non inclus (utilisez l'estimateur ci-dessous).
        </p>
      </Card>

      {/* Répartition par catégorie */}
      <Card className="p-5">
        <div className="mb-4 text-sm font-medium">Répartition par catégorie</div>
        <div className="space-y-3">
          {byKind.sums.map((s) => (
            <div key={s.kind}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <Pill meta={FT_COST_KIND_META[s.kind]} className="px-1.5 py-0 text-[10px]" />
                <span className="font-medium tabular-nums">{usd(s.usd)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-[hsl(var(--accent-teal))]" style={{ width: `${(s.usd / byKind.max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Estimateur */}
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium">
            <Calculator className="h-4 w-4 text-muted-foreground" /> Estimer un job
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Exemples"><Input type="number" value={rows} onChange={(e) => setRows(Number(e.target.value) || 0)} /></Field>
            <Field label="Époques"><Input type="number" value={epochs} onChange={(e) => setEpochs(Number(e.target.value) || 1)} /></Field>
            <Field label="Tokens / exemple"><Input type="number" value={avgTokens} onChange={(e) => setAvgTokens(Number(e.target.value) || 100)} /></Field>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 text-center">
            <div><div className="text-sm font-semibold tabular-nums">{(est.tokens / 1_000_000).toFixed(1)} M</div><div className="text-[10px] text-muted-foreground">tokens vus</div></div>
            <div><div className="text-sm font-semibold tabular-nums">{est.gpuH} h</div><div className="text-[10px] text-muted-foreground">GPU estimées</div></div>
            <div><div className="font-stat-number text-lg font-semibold tabular-nums text-[hsl(var(--accent-teal))]">{usd(est.cost)}</div><div className="text-[10px] text-muted-foreground">coût estimé</div></div>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Hypothèse : LoRA sur modèle ~30B, ~2,6 M tokens traités par GPU·h. Le Full FT coûte 3–5× plus.
          </p>
        </Card>

        {/* Historique */}
        <Card className="overflow-hidden">
          <div className="border-b border-border/60 px-5 py-3.5 text-sm font-medium">Historique</div>
          <div className="scrollbar-slim max-h-[340px] divide-y divide-border/60 overflow-y-auto">
            {entries.map((e) => (
              <div key={e.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{e.label}</span>
                <Pill meta={FT_COST_KIND_META[e.kind]} className="px-1.5 py-0 text-[10px]" />
                <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">{e.gpuHours > 0 ? `${e.gpuHours} h` : "—"}</span>
                <span className="w-16 shrink-0 text-right text-xs font-medium">{usd(e.usd)}</span>
                <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">{timeAgo(e.ts)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Ventilation par département / agent / utilisateur */}
      {shares && (
        <div className="grid gap-4 lg:grid-cols-3">
          {([["Par département", shares.byDepartment], ["Par agent", shares.byAgent], ["Par utilisateur", shares.byUser]] as const).map(([title, list]) => (
            <Card key={title} className="p-5">
              <div className="mb-3 text-sm font-medium">{title}</div>
              <div className="space-y-2.5">
                {list.map((s) => (
                  <div key={s.label}>
                    <div className="mb-0.5 flex justify-between text-xs">
                      <span className="truncate text-muted-foreground">{s.label}</span>
                      <span className="shrink-0 tabular-nums font-medium">{usd(s.usd)} · {s.pct}%</span>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-[hsl(var(--accent-teal))]" style={{ width: `${s.pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
