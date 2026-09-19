import { useState } from "react";
import {
  PulseIcon as Activity,
  WarningIcon as AlertTriangle,
  BookOpenIcon as BookOpen,
  CubeIcon as Boxes,
  CoinsIcon as Coins,
  GaugeIcon as Gauge,
  CircleNotchIcon as Loader2,
  UsersIcon as Users,
  WrenchIcon as Wrench,
  LightningIcon as Zap,
} from "@phosphor-icons/react";
import { EmptyState } from "@/components/EmptyState";
import {
  SectionCard, Empty, BarList, StatTile, KpiGrid,
} from "@/features/dashboard/hq/primitives";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import { PerformancePage } from "./PerformancePage";
import { AudiencePage } from "./AudiencePage";
import { useSequential, useOutcomeColors } from "./vizRamps";
import {
  describeAnalyticsError, fmtMs, measured, nf, pct, useAgentAnalytics,
  type AgentAnalytics as Data,
} from "./useAgentAnalytics";
import { cn } from "@/lib/utils";

// Onglet Analytics d'un agent public.
//
// Cinq pages : ce que l'agent produit (Performance), qui vient lui parler
// (Audience), et trois pages d'exploitation (outils, coûts, base). L'ancienne
// version comptait tout dans le navigateur sur 2 000 conversations maximum ;
// tout passe désormais par la RPC d'agrégation (migration 0217).

// Les cinq pages sont listées dans publicAgentSubtabs.ts : c'est la coque de
// l'agent public qui les dessine, dans la seconde barre de navigation.
export type Page = "performance" | "audience" | "tools" | "llm" | "knowledge";

const RANGES = [
  { days: 7, label: "7 jours" },
  { days: 30, label: "30 jours" },
  { days: 90, label: "90 jours" },
];

export function AgentAnalytics({ agentId, agentName, page = "performance" }: {
  agentId: string; agentName: string; page?: Page;
}) {
  const [days, setDays] = useState(30);
  const { data, isLoading, error } = useAgentAnalytics(agentId, days);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex items-center gap-0.5 rounded-xl border border-border bg-muted/40 p-0.5">
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)} aria-pressed={days === r.days}
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs transition-colors",
                days === r.days ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <EmptyState icon={Loader2} title="Chargement des statistiques…" />}
      {error && (
        <EmptyState
          icon={AlertTriangle}
          title="Statistiques indisponibles"
          description={describeAnalyticsError(error)}
        />
      )}

      {data && page === "performance" && <PerformancePage data={data} agentName={agentName} />}
      {data && page === "audience" && <AudiencePage data={data} />}
      {data && page === "tools" && <ToolsPage data={data} />}
      {data && page === "llm" && <LlmPage data={data} />}
      {data && page === "knowledge" && <KnowledgePage data={data} />}
    </div>
  );
}

// ── Outils ─────────────────────────────────────────────────────────────────
function ToolsPage({ data }: { data: Data }) {
  const cat = useCategorical();
  const outcome = useOutcomeColors();
  const calls = data.tools.reduce((s, t) => s + t.calls, 0);
  const errors = data.tools.reduce((s, t) => s + t.errors, 0);
  const weightedMs = data.tools.reduce((s, t) => s + (t.avg_ms ?? 0) * t.calls, 0);
  const errorRate = pct(errors, calls);

  if (calls === 0) {
    return (
      <EmptyState
        icon={Wrench}
        title="Aucun appel d'outil sur la période"
        description="Cet agent répond depuis sa base de connaissances. Dès qu'un serveur MCP est branché dans l'onglet E-commerce, ses appels, leurs latences et leurs échecs apparaissent ici."
      />
    );
  }

  return (
    <div className="space-y-4">
      <KpiGrid
        gridClass="grid-cols-2 md:grid-cols-4 xl:grid-cols-4"
        cards={[
          { key: "calls", label: "Appels d'outils", value: nf.format(calls), icon: Zap, accent: cat[0] },
          { key: "lat", label: "Latence moyenne", value: fmtMs(calls ? weightedMs / calls : null), icon: Gauge, accent: cat[4],
            sub: "pondérée par le nombre d'appels" },
          { key: "err", label: "Échecs", value: nf.format(errors), icon: AlertTriangle, accent: cat[7] },
          { key: "errrate", label: "Taux d'échec", value: errorRate == null ? "—" : `${errorRate}%`, icon: Activity, accent: cat[5] },
        ]}
      />
      <SectionCard title="Par outil" subtitle="Appels sur la période ; le liseré rouge marque la part en échec.">
        <BarList
          labelWidth="w-48"
          rows={data.tools.map((t) => ({
            key: t.tool_name,
            label: t.tool_name,
            value: t.calls,
            color: cat[0],
            overlay: t.errors > 0 ? { value: t.errors, color: outcome.unresolved, label: "Échecs" } : undefined,
            caption: `${nf.format(t.calls)} · ${fmtMs(t.avg_ms)}`,
          }))}
        />
      </SectionCard>
    </div>
  );
}

// ── Modèles & coûts ────────────────────────────────────────────────────────
function LlmPage({ data }: { data: Data }) {
  const cat = useCategorical();
  const cost = data.llm.cost_cents / 100;
  const conv = data.totals.total;
  return (
    <div className="space-y-4">
      <KpiGrid
        gridClass="grid-cols-2 md:grid-cols-4 xl:grid-cols-4"
        cards={[
          { key: "req", label: "Requêtes modèle", value: nf.format(data.llm.requests), icon: Zap, accent: cat[0] },
          { key: "tok", label: "Jetons consommés", value: nf.format(data.llm.tokens), icon: Boxes, accent: cat[6] },
          { key: "cost", label: "Coût fournisseur", value: cost ? `${cost.toFixed(2)} €` : "—", icon: Coins, accent: cat[1],
            sub: "hors marge de facturation" },
          { key: "unit", label: "Coût par conversation", value: conv ? `${(cost / conv).toFixed(4)} €` : "—", icon: Activity, accent: cat[4] },
        ]}
      />
      <p className="rounded-xl bg-muted/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        Ces coûts sont ceux facturés par les fournisseurs de modèles pour la fonctionnalité « agent public » du projet,
        toutes conversations confondues. La conversion en crédits et la marge appliquée au client se lisent dans
        Administration → Abonnements.
      </p>
    </div>
  );
}

// ── Base de connaissances ──────────────────────────────────────────────────
function KnowledgePage({ data }: { data: Data }) {
  const cat = useCategorical();
  const seq = useSequential();
  const kb = data.knowledge;
  const t = data.totals;
  const noKnowledge = data.reasons_unresolved.find((r) => r.reason === "no_knowledge")?.n ?? 0;
  const mes = measured(t);
  const coverage = pct(mes - noKnowledge, mes);

  return (
    <div className="space-y-4">
      <KpiGrid
        gridClass="grid-cols-2 md:grid-cols-4 xl:grid-cols-4"
        cards={[
          { key: "src", label: "Sources indexées", value: nf.format(kb.sources), icon: BookOpen, accent: cat[0],
            sub: `${nf.format(kb.ready)} prêtes` },
          { key: "chunks", label: "Fragments", value: nf.format(kb.chunks), icon: Boxes, accent: cat[6] },
          { key: "cov", label: "Couverture des questions", value: coverage == null ? "—" : `${coverage}%`, icon: Gauge, accent: cat[1],
            sub: "conversations où la base avait de quoi répondre" },
          { key: "gap", label: "Questions sans matière", value: nf.format(noKnowledge), icon: AlertTriangle, accent: cat[7],
            sub: "à documenter en priorité" },
        ]}
      />
      <SectionCard
        title="Questions les plus posées"
        subtitle="Le meilleur plan de rédaction pour la base : ce que les visiteurs demandent, par fréquence."
      >
        {data.questions.length === 0 ? (
          <Empty label="Aucune question sur la période." />
        ) : (
          <BarList
            labelWidth="w-72"
            rows={data.questions.map((q, i) => ({
              key: `${i}-${q.question}`,
              label: q.question,
              value: q.n,
              color: seq[2],
              caption: `${nf.format(q.n)}×`,
            }))}
          />
        )}
      </SectionCard>
      {kb.sources > kb.ready && (
        <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {kb.sources - kb.ready} source(s) ne sont pas encore indexées : l'agent ne peut pas répondre avec.
        </div>
      )}
      <StatTileRow t={t} />
    </div>
  );
}

function StatTileRow({ t }: { t: Data["totals"] }) {
  const cat = useCategorical();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatTile compact label="Conversations mesurées" value={nf.format(measured(t))} icon={Activity} accent={cat[0]} />
      <StatTile compact label="Réponses fondées" value={nf.format(t.resolved)} icon={BookOpen} accent={cat[1]} />
      <StatTile compact label="Appels d'outils" value={nf.format(t.tool_calls)} icon={Wrench} accent={cat[4]} />
    </div>
  );
}
