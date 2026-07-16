import { Wallet, Cloud, Server, Cpu } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Pill } from "../ui";
import { useProjectAgents, usd, HOSTING_META } from "./data";
import { useServersDb, useRealGovCosts } from "./db";

export function GovCostsPage() {
  const { data: agents } = useProjectAgents();
  const { servers } = useServersDb();
  // Real spend computed from internal_agent_runs + real server costs only.
  const { costs, loading } = useRealGovCosts(agents ?? [], servers);

  if (loading) return <PageSkeleton cards={3} rows={5} />;
  if (!costs) {
    return (
      <div className="space-y-6">
        <PageHeader title="Dépenses IA" description="Suivi des coûts par run, prompt et mission — dépense API réelle de vos runs + coût d'infrastructure des serveurs." />
        <EmptyState icon={Wallet} title="Aucune dépense pour l'instant" description="Les coûts apparaîtront ici dès que vos agents auront effectué des runs (dépense API réelle) ou que des serveurs seront provisionnés." />
      </div>
    );
  }

  const maxDaily = Math.max(...costs.daily.map((d) => d.usd));
  const maxAgent = Math.max(1, ...costs.byAgent.map((a) => a.usd));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dépenses IA"
        description="Suivi des coûts par run, prompt et mission — dépense API réelle de vos runs + coût d'infrastructure des serveurs."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Total (30 j)" value={usd(costs.totalUsd)} icon={Wallet} />
        <MetricCard label="Dépense API" value={usd(costs.apiUsd)} icon={Cloud} hint="fournisseurs LLM (tokens)" />
        <MetricCard label="Infrastructure" value={usd(costs.infraUsd)} icon={Server} hint="serveurs propriétaires / sandbox" />
      </div>

      {/* Dépense journalière — une série, une teinte ; la longueur encode. */}
      <Card className="p-5">
        <div className="mb-4 flex items-baseline justify-between">
          <span className="text-sm font-medium">Dépense journalière (14 j)</span>
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

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Coûts unitaires moyens */}
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

        {/* Par modèle — cloud vs propriétaire */}
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

      {/* Par agent */}
      <Card className="overflow-hidden">
        <div className="border-b border-border/60 px-5 py-3.5 text-sm font-medium">Dépense par agent</div>
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

      {/* Modèles locaux — à venir */}
      <Card className="flex items-start gap-3 border-dashed p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--accent-aqua)/0.25)] text-[hsl(var(--accent-teal))]">
          <Cpu className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            Modèles locaux
            <span className="rounded-full bg-[hsl(var(--accent-coral)/0.14)] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--primary-soft))]">Bientôt</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Déployez des modèles open-source sur vos propres serveurs pour réduire la dépense API — le coût d'infrastructure ci-dessus deviendra alors votre poste principal, entièrement maîtrisé.
          </p>
        </div>
      </Card>
    </div>
  );
}
