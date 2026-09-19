import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowCounterClockwiseIcon, ArrowsClockwiseIcon, CaretDownIcon, CheckIcon, RobotIcon,
  SquaresFourIcon, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import {
  DraggableWidgetGrid, type WidgetItem, type WidgetSize,
} from "@/components/ui/draggable-widget-grid";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useCategorical, useContextGreys } from "@/features/crm/overview/vizPalette";
import type { RangeKey } from "@/features/crm/overview/crmStats";
import type { HqView } from "@/features/dashboard/hq/model";
import { SegmentedControl } from "../ui";
import { formatRelative } from "../pickers";
import { BarChart, LollipopChart } from "./charts";
import { RadarChart, type RadarAxis } from "./RadarChart";
import { DataTable } from "./tabs";
import { AgentStatsPanel } from "./AgentStatsPanel";
import {
  AgentStatesWidget, LiveApprovalsWidget, LiveRunsWidget, LiveToolFeedWidget,
  RecentErrorsWidget, useLiveActivity,
} from "./liveWidgets";

/**
 * Les statistiques d'une force de travail, rendues avec les primitives du
 * module de suivi.
 *
 * UN SEUL rendu pour DEUX écrans : l'onglet « Agents » des analytics d'un
 * service, et le tableau de bord général de FounderOS. Ils regardent le même
 * genre d'objet à deux échelles — un service, puis tout l'espace — et leur
 * donner deux mises en page revenait à faire apprendre deux fois la même
 * lecture. C'est aussi, très concrètement, la seule façon d'éviter que les deux
 * divergent : la liste des sections de projet et le composeur d'accueil ont
 * chacun montré, dans ce dépôt, ce que coûte une seconde copie.
 *
 * Ce qui DIFFÈRE entre les deux appelants ne se devine pas ici, il se passe en
 * propriété : les filtres (un service a un périmètre projet, l'espace n'en a
 * pas), l'avertissement de filtrage, et la ventilation par service, qui n'a de
 * sens qu'au-dessus des services.
 *
 * Le composant ne CALCULE rien qu'il ne reçoive : la vue arrive déjà bâtie et
 * déjà filtrée. Deux appelants qui filtreraient chacun à leur façon après coup
 * finiraient par afficher des totaux qui ne s'additionnent pas.
 */

export const AGENT_STAT_RANGES: { key: RangeKey; label: string }[] = [
  { key: "30d", label: "30 jours" },
  { key: "90d", label: "90 jours" },
  { key: "12m", label: "12 mois" },
];

/** Un coût en dollars, à la précision qu'il mérite. Sous le centime, deux
 *  décimales affichent « 0,00 » pour un travail qui a bel et bien coûté. */
export function money(v: number): string {
  if (!v) return "$0";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function duration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

export function percent(v: number | null): string {
  return v == null ? "—" : `${Math.round(v)} %`;
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} k`;
  return `${(n / 1_000_000).toFixed(1)} M`;
}

export function AgentStats({
  view, range, onRangeChange, title = "Agents",
  filters, notice, onOpenAgent, onOpenService, showServices,
  onRefresh, isFetching, layoutKey,
}: {
  /**
   * Sous quelle clé mémoriser la disposition des widgets. Une par écran — le
   * tableau de bord général et l'onglet d'un service n'ont aucune raison
   * d'être rangés pareil : on ne regarde pas la même chose à deux échelles.
   */
  layoutKey: string;
  /** La vue HQ, déjà bâtie sur la fenêtre et les filtres de l'appelant. */
  view: HqView;
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
  title?: string;
  /** Les sélecteurs propres à l'appelant, posés à droite de la période. */
  filters?: ReactNode;
  /** Ce que le filtrage écarte, dit en clair. */
  notice?: ReactNode;
  onOpenAgent: (id: string) => void;
  onOpenService?: (id: string) => void;
  /** La ventilation par service — sans objet quand on EST dans un service. */
  showServices?: boolean;
  /** Relit les données. Sur un écran qui montre des exécutions EN COURS, une
   *  page figée jusqu'au prochain rechargement se lit comme une panne. */
  onRefresh?: () => void;
  isFetching?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [toolSearch, setToolSearch] = useState("");
  const [serviceSearch, setServiceSearch] = useState("");
  /** L'agent dont la fiche est ouverte à droite. */
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  const palette = useCategorical();
  const greys = useContextGreys();

  // La disposition des widgets, mémorisée par personne et par écran. Le mode
  // édition et la version servent à rejouer la grille après une réinitialisation :
  // elle gère son ordre elle-même après le montage, et ne relit ses `items` qu'à
  // un nouveau montage.
  // Le direct porte sur les agents de la vue — donc sur le périmètre choisi :
  // un service, ou l'espace entier.
  const liveIds = useMemo(() => view.agents.map((a) => a.id), [view.agents]);
  const live = useLiveActivity(liveIds);

  const [editing, setEditing] = useState(false);
  const [gridVersion, setGridVersion] = useState(0);
  const widgets = useMemo(() => loadLayout(layoutKey), [layoutKey, gridVersion]);
  const saveLayout = (items: WidgetItem[]) => storeLayout(layoutKey, items);
  const resetLayout = () => {
    clearLayout(layoutKey);
    setGridVersion((v) => v + 1);
  };

  const { headline, productivity, toolUsage, outputs, approvalStats, loopHealth, knowledge } = view;

  // Les agents les plus actifs, pas tous : au-delà d'une dizaine de barres, le
  // graphe cesse de comparer et se met à énumérer — ce que la table fait mieux.
  const topAgents = [...productivity].sort((a, b) => b.runs - a.runs).slice(0, 8);

  const runsByAgent = topAgents.map((p, i) => ({
    label: p.agent.name,
    value: p.runs,
    color: palette[i % palette.length],
  }));

  // Le taux de réussite EN REGARD du volume : un agent à 100 % sur deux
  // exécutions n'est pas un agent fiable, c'est un agent peu sollicité. Les
  // deux graphes se lisent donc ensemble, dans cet ordre.
  const successByAgent = topAgents
    .filter((p) => p.successRate != null)
    .map((p, i) => ({
      label: p.agent.name,
      value: p.successRate!,
      color: palette[i % palette.length],
    }));

  const familyBars = toolUsage.byFamily
    .filter((f) => f.calls > 0)
    .slice(0, 8)
    .map((f, i) => ({ label: f.label, value: f.calls, color: palette[i % palette.length] }));

  // L'activité dans le temps. Les exécutions et le coût sur DEUX graphes et non
  // deux axes d'un seul : un axe de droite en dollars et un axe de gauche en
  // unités se lisent mal ensemble, et l'œil finit par croire à une corrélation
  // que l'échelle a fabriquée.
  const runBars = view.series.map((p) => ({
    label: p.tick,
    value: p.runs,
    color: p.failed > 0 ? palette[3 % palette.length] : palette[0],
  }));
  const costBars = view.series.map((p) => ({
    label: p.tick,
    value: Number(p.costUsd.toFixed(4)),
    color: palette[1 % palette.length],
  }));

  // Six axes normalisés chacun sur SON maximum. Ce sont des ordres de grandeur
  // différents — des milliers d'appels d'outils contre quelques approbations —
  // et une échelle commune écraserait tout sauf un axe.
  const axes: RadarAxis[] = [
    { label: "Exécutions", value: headline.runs, max: Math.max(10, headline.runs) },
    { label: "Missions", value: view.missions.length, max: Math.max(5, view.missions.length) },
    { label: "Livrables", value: outputs.total, max: Math.max(5, outputs.total) },
    { label: "Outils", value: toolUsage.calls, max: Math.max(20, toolUsage.calls) },
    { label: "Approbations", value: approvalStats.total, max: Math.max(5, approvalStats.total) },
    { label: "Agents actifs", value: productivity.filter((p) => p.runs > 0).length, max: Math.max(3, view.agents.length) },
  ];

  const q = search.trim().toLowerCase();
  const agentRows = productivity
    .filter((p) => !q || p.agent.name.toLowerCase().includes(q))
    .sort((a, b) => b.runs - a.runs);

  const tq = toolSearch.trim().toLowerCase();
  const toolRows = toolUsage.byTool
    .filter((t) => !tq || t.tool.toLowerCase().includes(tq))
    .sort((a, b) => b.calls - a.calls);

  const sq = serviceSearch.trim().toLowerCase();
  const serviceRows = (view.services ?? [])
    .filter((s) => !sq || s.name.toLowerCase().includes(sq))
    .sort((a, b) => b.runs - a.runs);

  // ── Les widgets ───────────────────────────────────────────────────────
  //
  // 36 cellules exactement : divisible par 2, 3, 4 et 6. La grille pose alors un
  // pavage SANS TROU quel que soit le nombre de colonnes que la largeur lui
  // donne — sans quoi elle retombe sur un empilement qui étire les widgets pour
  // combler, et un chiffre se retrouve seul dans une case de deux de large.
  const renderWidget = (item: WidgetItem, size: WidgetSize): ReactNode => {
    switch (item.id) {
      case "k-runs":
        return (
          <Kpi
            label="Exécutions"
            value={String(headline.runs)}
            foot={[
              headline.ongoing > 0 && `${headline.ongoing} en cours`,
              headline.failed > 0 && `${headline.failed} en échec`,
              `${productivity.filter((x) => x.runs > 0).length} agent(s) actif(s)`,
            ]}
            tone={headline.failed > 0 ? "warn" : undefined}
          />
        );
      case "k-success":
        return (
          <Kpi
            label="Taux de réussite"
            value={percent(headline.successRate)}
            foot={[`${headline.succeeded} réussie(s) sur ${headline.runs}`]}
            tone={headline.successRate != null && headline.successRate < 60 ? "danger" : undefined}
          />
        );
      case "k-cost":
        return (
          <Kpi
            label="Coût"
            value={money(headline.totalCost)}
            foot={[
              `${money(headline.avgCost)} par exécution`,
              headline.totalTokens > 0 && `${compact(headline.totalTokens)} jetons`,
            ]}
          />
        );
      case "k-deliverables":
        return (
          <Kpi
            label="Livrables"
            value={String(outputs.total)}
            foot={outputs.byKind.slice(0, 3).map((k) => `${k.count} ${k.label.toLowerCase()}`)}
          />
        );
      case "k-tools":
        return (
          <Kpi
            label="Appels d'outils"
            value={compact(toolUsage.calls)}
            foot={[
              `${toolUsage.distinctTools} outil(s) distinct(s)`,
              toolUsage.errorRate != null && `${Math.round(toolUsage.errorRate)} % d'erreurs`,
            ]}
            tone={toolUsage.errorRate != null && toolUsage.errorRate > 10 ? "danger" : undefined}
          />
        );
      case "k-pending":
        return (
          <Kpi
            label="À valider"
            value={String(approvalStats.pending)}
            foot={[
              `${approvalStats.total} demande(s) sur la période`,
              approvalStats.avgDecisionMin != null
                && `décision en ${duration(approvalStats.avgDecisionMin * 60)}`,
            ]}
            // Une validation en attente est un agent ARRÊTÉ : c'est la seule
            // tuile qui appelle un geste, elle se voit donc de loin.
            tone={approvalStats.pending > 0 ? "warn" : undefined}
          />
        );
      case "c-runs-agent":
        return (
          <ChartWidget title="Exécutions par agent">
            {runsByAgent.length
              ? (h) => <BarChart data={runsByAgent} yLabel="Exécutions" xLabel="Agent" height={h} />
              : null}
          </ChartWidget>
        );
      case "c-runs-time":
        return (
          <ChartWidget title="Exécutions dans le temps">
            {runBars.some((b) => b.value > 0)
              ? (h) => <BarChart data={runBars} yLabel="Exécutions" xLabel="Période" height={h} />
              : null}
          </ChartWidget>
        );
      case "c-cost-time":
        return (
          <ChartWidget title="Coût dans le temps" hint={money(headline.totalCost)}>
            {costBars.some((b) => b.value > 0)
              ? (h) => <BarChart data={costBars} yLabel="Dollars" xLabel="Période" height={h} />
              : null}
          </ChartWidget>
        );
      case "c-success":
        return (
          <ChartWidget title="Réussite par agent" hint="à lire avec le volume">
            {successByAgent.length
              ? (h) => <LollipopChart data={successByAgent} yLabel="Réussite (%)" height={h} />
              : null}
          </ChartWidget>
        );
      case "c-families":
        return (
          <ChartWidget title="Outils par famille">
            {familyBars.length
              ? (h) => <BarChart data={familyBars} yLabel="Appels" xLabel="Famille" height={h} />
              : null}
          </ChartWidget>
        );
      case "c-radar":
        return (
          <ChartWidget title="Silhouette">
            {(h, w) => (
              <div className="flex h-full items-center justify-center">
                <RadarChart axes={axes} size={Math.max(120, Math.min(h, w))} />
              </div>
            )}
          </ChartWidget>
        );
      case "p-approvals":
        return (
          <PanelWidget title="Validations humaines">
            {approvalStats.total ? (
              <>
                <Row label="Demandées" value={approvalStats.total} />
                <Row label="En attente" value={approvalStats.pending} tone={approvalStats.pending > 0 ? "warn" : undefined} />
                <Row label="Accordées" value={approvalStats.approved + approvalStats.executed} />
                <Row label="Refusées" value={approvalStats.rejected} />
                <Row label="Taux d'accord" value={percent(approvalStats.approvalRate)} />
                <Row
                  label="Délai de décision"
                  value={approvalStats.avgDecisionMin == null ? "—" : duration(approvalStats.avgDecisionMin * 60)}
                />
              </>
            ) : <NoData compact />}
          </PanelWidget>
        );
      case "p-loop":
        return (
          <PanelWidget title="Santé de la boucle">
            {loopHealth.decisions ? (
              <>
                <Row label="Décisions" value={loopHealth.decisions} />
                <Row label="Replanifications" value={loopHealth.replans} tone={loopHealth.replans > 0 ? "warn" : undefined} />
                <Row label="Abandons" value={loopHealth.aborts} tone={loopHealth.aborts > 0 ? "danger" : undefined} />
                <Row label="Boucles détectées" value={loopHealth.loopsDetected} tone={loopHealth.loopsDetected > 0 ? "danger" : undefined} />
                <Row label="Stagnations" value={loopHealth.stagnationEvents} />
                <Row
                  label="Itérations moyennes"
                  value={loopHealth.avgIterations == null ? "—" : loopHealth.avgIterations.toFixed(1)}
                />
              </>
            ) : <NoData compact />}
          </PanelWidget>
        );
      case "p-knowledge":
        return (
          <PanelWidget title="Connaissance">
            {knowledge.totalCollections ? (
              <>
                <Row label="Collections" value={knowledge.totalCollections} />
                <Row label="Dont actives" value={knowledge.activeCollections} />
                <Row label="Sources" value={knowledge.totalSources} />
                <Row label="Sources en échec" value={knowledge.failedSources} tone={knowledge.failedSources > 0 ? "danger" : undefined} />
                <Row label="Recherches" value={knowledge.searches} />
                <Row
                  label="Taux de trouvaille"
                  value={percent(knowledge.hitRate)}
                  tone={knowledge.hitRate != null && knowledge.hitRate < 50 ? "warn" : undefined}
                />
              </>
            ) : <NoData compact />}
          </PanelWidget>
        );
      case "l-runs":
        return (
          <LiveRunsWidget
            runs={live.runs} events={live.events}
            agentById={view.agentById} connected={live.connected}
          />
        );
      case "l-tools":
        return (
          <LiveToolFeedWidget events={live.events} agentById={view.agentById} connected={live.connected} />
        );
      case "l-states":
        return (
          <AgentStatesWidget
            agents={view.agents} runs={live.runs} approvals={live.approvals}
            recent={live.recent} connected={live.connected}
          />
        );
      case "l-approvals":
        return (
          <LiveApprovalsWidget
            approvals={live.approvals} agentById={view.agentById}
            onDecided={live.refreshApprovals}
          />
        );
      case "l-errors":
        return (
          <RecentErrorsWidget
            recent={live.recent} events={live.events}
            agentById={view.agentById} connected={live.connected}
          />
        );
      default:
        void size;
        return null;
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-18 font-semibold tracking-tight">{title}</h2>

      {/* Les réglages qui changent CE QUE veulent dire les widgets, donc gardés
          juste au-dessus d'eux. */}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl value={range} onChange={onRangeChange} options={AGENT_STAT_RANGES} />
        {filters}
        {onRefresh && (
          <button
            type="button"
            title="Actualiser"
            onClick={onRefresh}
            disabled={isFetching}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <ArrowsClockwiseIcon className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          </button>
        )}

        <div className="flex-1" />

        {/* La réorganisation est un MODE, pas l'état par défaut. Des widgets
            toujours déplaçables captent le premier appui de la souris : on ne
            peut plus sélectionner un chiffre pour le copier, et un clic pour
            lire devient un glisser accidentel. */}
        {editing && (
          <button
            type="button"
            onClick={resetLayout}
            className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-12 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowCounterClockwiseIcon className="h-3.5 w-3.5" /> Réinitialiser
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-12 transition-colors",
            editing
              ? "border-primary/40 bg-primary/10 font-medium text-primary"
              : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {editing
            ? <><CheckIcon className="h-3.5 w-3.5" /> Terminé</>
            : <><SquaresFourIcon className="h-3.5 w-3.5" /> Personnaliser</>}
        </button>
      </div>

      {notice}

      {editing && (
        <p className="text-11 text-muted-foreground">
          Glissez les widgets pour les réorganiser — au clavier, Alt + flèches. La
          disposition est mémorisée pour vous seul.
        </p>
      )}

      <DraggableWidgetGrid
        key={gridVersion}
        items={widgets}
        onChange={saveLayout}
        renderItem={renderWidget}
        editable={editing}
        maxColumns={6}
        cellSize={220}
        gap={12}
        radius={16}
      />

      {/* Les TABLES restent sous la grille, en pleine largeur. Une table de
          huit colonnes, cherchable et exportable, n'a pas sa place dans une case
          carrée : elle y deviendrait défilante dans les deux sens, c'est-à-dire
          illisible. */}
      <section className="space-y-3 pt-2">
        <h3 className="text-13 font-medium">Par agent</h3>
        <DataTable
          rows={agentRows}
          filename="agents-analytics"
          search={search}
          onSearch={setSearch}
          empty="Aucun agent ne correspond à cette recherche."
          onRowClick={(r) => setOpenAgent(r.agent.id)}
          activeRow={(r) => r.agent.id === openAgent}
          columns={[
            {
              key: "agent",
              label: "Agent",
              render: (r) => (
                <span className="flex items-center gap-2">
                  <span
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-10"
                    style={{ background: `${r.agent.accent_color ?? "#6b7180"}22` }}
                  >
                    {r.agent.avatar_emoji ?? <RobotIcon className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 truncate font-medium">{r.agent.name}</span>
                </span>
              ),
              value: (r) => r.agent.name,
            },
            { key: "runs", label: "Exécutions", align: "right", render: (r) => r.runs, value: (r) => r.runs },
            {
              key: "rate", label: "Réussite", align: "right",
              render: (r) => percent(r.successRate), value: (r) => r.successRate ?? "",
            },
            {
              key: "cost", label: "Coût", align: "right",
              render: (r) => money(r.totalCost), value: (r) => r.totalCost.toFixed(4),
            },
            {
              key: "avgcost", label: "Coût moyen", align: "right",
              render: (r) => money(r.avgCost), value: (r) => r.avgCost.toFixed(4),
            },
            {
              key: "avg", label: "Durée moyenne", align: "right",
              render: (r) => duration(r.avgDurationSec), value: (r) => r.avgDurationSec ?? "",
            },
            { key: "actions", label: "Actions", align: "right", render: (r) => r.totalActions, value: (r) => r.totalActions },
            { key: "deliverables", label: "Livrables", align: "right", render: (r) => r.deliverables, value: (r) => r.deliverables },
            {
              key: "pending", label: "À valider", align: "right",
              render: (r) => (
                <span className={r.pendingApprovals > 0 ? "font-medium text-amber-600" : undefined}>
                  {r.pendingApprovals}
                </span>
              ),
              value: (r) => r.pendingApprovals,
            },
          ]}
        />
      </section>

      {showServices && serviceRows.length > 0 && (
        <section className="space-y-3 border-t border-border pt-6">
          <h3 className="text-13 font-medium">Par service</h3>
          <DataTable
            rows={serviceRows}
            filename="services-analytics"
            search={serviceSearch}
            onSearch={setServiceSearch}
            empty="Aucun service ne correspond à cette recherche."
            onRowClick={onOpenService
              ? (sv) => { if (sv.service) onOpenService(sv.service.id); }
              : undefined}
            columns={[
              {
                key: "name", label: "Service",
                render: (sv) => <span className="font-medium">{sv.name}</span>,
                value: (sv) => sv.name,
              },
              { key: "agents", label: "Agents", align: "right", render: (sv) => sv.agents, value: (sv) => sv.agents },
              {
                key: "active", label: "Dont actifs", align: "right",
                render: (sv) => sv.activeAgents, value: (sv) => sv.activeAgents,
              },
              { key: "runs", label: "Exécutions", align: "right", render: (sv) => sv.runs, value: (sv) => sv.runs },
              {
                key: "rate", label: "Réussite", align: "right",
                render: (sv) => percent(sv.successRate), value: (sv) => sv.successRate ?? "",
              },
              {
                key: "cost", label: "Coût", align: "right",
                render: (sv) => money(sv.cost), value: (sv) => sv.cost.toFixed(4),
              },
              {
                key: "tokens", label: "Jetons", align: "right",
                render: (sv) => compact(sv.tokens), value: (sv) => sv.tokens,
              },
            ]}
          />
        </section>
      )}

      <section className="space-y-3 border-t border-border pt-6">
        <h3 className="text-13 font-medium">Par outil</h3>
        <DataTable
          rows={toolRows}
          filename="outils-analytics"
          search={toolSearch}
          onSearch={setToolSearch}
          empty="Aucun outil n'a été appelé sur cette période."
          columns={[
            {
              key: "tool", label: "Outil",
              render: (t) => <span className="font-mono text-12">{t.tool}</span>,
              value: (t) => t.tool,
            },
            {
              key: "family", label: "Famille",
              render: (t) => (
                <span className="text-12 text-muted-foreground">
                  {toolUsage.byFamily.find((f) => f.key === t.family)?.label ?? t.family}
                </span>
              ),
              value: (t) => t.family,
            },
            { key: "calls", label: "Appels", align: "right", render: (t) => t.calls, value: (t) => t.calls },
            {
              key: "errors", label: "Erreurs", align: "right",
              render: (t) => <span className={t.errors > 0 ? "text-red-600" : undefined}>{t.errors}</span>,
              value: (t) => t.errors,
            },
            {
              key: "rate", label: "Taux d'erreur", align: "right",
              // Un outil sans résultat observé n'a pas un taux de 0 % : il n'en
              // a pas. Écrire « 0 % » lui donnerait un brevet de fiabilité que
              // rien ne fonde.
              render: (t) => percent(t.errorRate), value: (t) => t.errorRate ?? "",
            },
            { key: "agents", label: "Agents", align: "right", render: (t) => t.agents, value: (t) => t.agents },
            { key: "runs", label: "Exécutions", align: "right", render: (t) => t.runs, value: (t) => t.runs },
            {
              key: "last", label: "Dernier usage", align: "right",
              render: (t) => (
                <span className="text-12 text-muted-foreground">{formatRelative(t.lastUsedAt)}</span>
              ),
              value: (t) => t.lastUsedAt ?? "",
            },
          ]}
        />
      </section>

      {view.runs.length > 0 && (
        <p className="text-11 text-muted-foreground">
          Dernière exécution {formatRelative(view.runs[view.runs.length - 1]?.created_at ?? null)}.
          {outputs.perRun != null && (
            <span style={{ color: greys.context }}>
              {" "}· {outputs.perRun.toFixed(1)} livrable(s) par exécution réussie.
            </span>
          )}
        </p>
      )}

      {openAgent && (
        <AgentStatsPanel
          agentId={openAgent}
          view={view}
          onClose={() => setOpenAgent(null)}
          onOpenAgent={onOpenAgent}
        />
      )}
    </div>
  );
}

/**
 * Un sélecteur de filtre : un bouton qui DIT ce qu'il filtre, et une liste.
 *
 * Le bouton se teinte quand un filtre est posé, et porte alors la VALEUR
 * choisie plutôt que le nom du champ. Un bouton qui garde son libellé neutre
 * une fois réglé oblige à l'ouvrir pour savoir ce qu'on regarde — c'est ce
 * qu'on reprochait au bouton « Display » du board.
 */
export function FilterMenu({
  icon: Icon, allLabel, value, options, onChange, emptyHint,
}: {
  icon: PhosphorIcon;
  /** Le libellé quand rien n'est filtré. */
  allLabel: string;
  value: string | null;
  options: { id: string; label: string }[];
  onChange: (id: string | null) => void;
  emptyHint?: string;
}) {
  const current = options.find((o) => o.id === value) ?? null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 max-w-[220px] items-center gap-1.5 rounded-md border px-2.5 text-12 transition-colors",
            value
              ? "border-primary/40 bg-primary/10 font-medium text-primary"
              : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{current?.label ?? allLabel}</span>
          <CaretDownIcon className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-1" align="start">
        <div className="max-h-72 overflow-y-auto">
          <FilterOption active={!value} label={allLabel} onSelect={() => onChange(null)} />
          {options.map((o) => (
            <FilterOption
              key={o.id}
              active={value === o.id}
              label={o.label}
              onSelect={() => onChange(o.id)}
            />
          ))}
          {!options.length && emptyHint && (
            <p className="px-2 py-4 text-center text-11 leading-snug text-muted-foreground">
              {emptyHint}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FilterOption({
  active, label, onSelect,
}: { active: boolean; label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-12",
        active ? "bg-muted font-medium" : "hover:bg-muted",
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

// ── Les widgets ─────────────────────────────────────────────────────────────

/**
 * La disposition par défaut. Six chiffres d'abord — ce qu'on vient lire —, puis
 * les graphes qui les expliquent, puis les panneaux de santé.
 */
const DEFAULT_WIDGETS: WidgetItem[] = [
  { id: "k-runs", size: "sm", label: "Exécutions" },
  { id: "k-success", size: "sm", label: "Taux de réussite" },
  { id: "k-cost", size: "sm", label: "Coût" },
  { id: "k-deliverables", size: "sm", label: "Livrables" },
  { id: "k-tools", size: "sm", label: "Appels d'outils" },
  { id: "k-pending", size: "sm", label: "À valider" },
  { id: "l-runs", size: "lg", label: "En cours" },
  { id: "l-states", size: "wide", label: "États des agents" },
  { id: "l-tools", size: "tall", label: "Appels d'outils en direct" },
  { id: "l-approvals", size: "tall", label: "À valider maintenant" },
  { id: "c-runs-agent", size: "wide", label: "Exécutions par agent" },
  { id: "c-runs-time", size: "wide", label: "Exécutions dans le temps" },
  { id: "c-cost-time", size: "wide", label: "Coût dans le temps" },
  { id: "c-radar", size: "tall", label: "Silhouette" },
  { id: "p-approvals", size: "tall", label: "Validations humaines" },
  { id: "c-success", size: "wide", label: "Réussite par agent" },
  { id: "c-families", size: "wide", label: "Outils par famille" },
  { id: "l-errors", size: "tall", label: "Erreurs récentes" },
  { id: "p-loop", size: "tall", label: "Santé de la boucle" },
  { id: "p-knowledge", size: "tall", label: "Connaissance" },
];

const storageKeyOf = (key: string) => `founderos.agent-stats.layout.${key}`;

/**
 * La disposition enregistrée, RÉCONCILIÉE avec le catalogue courant.
 *
 * On ne stocke que l'ordre des identifiants, et l'on refait la liste à partir
 * du catalogue : un widget retiré du produit disparaît d'une disposition
 * ancienne au lieu d'y laisser une case vide, et un widget ajouté arrive en fin
 * de grille au lieu de rester invisible pour tous ceux qui avaient déjà rangé la
 * leur.
 *
 * Toute lecture est gardée : le stockage peut être bloqué (navigation privée,
 * réglage du navigateur), et la page doit alors s'afficher dans l'ordre par
 * défaut plutôt que de planter.
 */
function loadLayout(key: string): WidgetItem[] {
  let saved: string[] = [];
  try {
    const raw = window.localStorage.getItem(storageKeyOf(key));
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) saved = parsed.filter((x): x is string => typeof x === "string");
  } catch { /* ordre par défaut */ }

  const byId = new Map(DEFAULT_WIDGETS.map((w) => [w.id, w]));
  const kept = saved.map((id) => byId.get(id)).filter((w): w is WidgetItem => !!w);
  const keptIds = new Set(kept.map((w) => w.id));
  return [...kept, ...DEFAULT_WIDGETS.filter((w) => !keptIds.has(w.id))];
}

function storeLayout(key: string, items: WidgetItem[]) {
  try {
    window.localStorage.setItem(storageKeyOf(key), JSON.stringify(items.map((w) => w.id)));
  } catch { /* disposition non mémorisée, sans conséquence */ }
}

function clearLayout(key: string) {
  try { window.localStorage.removeItem(storageKeyOf(key)); } catch { /* rien */ }
}

/**
 * Un chiffre, et deux ou trois lignes pour le situer.
 *
 * Le pied donne l'ÉCHELLE : « 86 % » seul ne dit pas s'il s'agit de six
 * exécutions ou de six cents, et c'est pourtant toute la différence entre une
 * mesure et une anecdote.
 */
function Kpi({
  label, value, foot, tone,
}: {
  label: string;
  value: string;
  foot?: Array<string | false | null | undefined>;
  tone?: "warn" | "danger";
}) {
  const lines = (foot ?? []).filter((x): x is string => !!x);
  return (
    <div className="flex h-full flex-col p-4">
      <p className="text-11 font-medium uppercase tracking-wider text-tertiary">{label}</p>
      <p className={cn(
        "mt-auto text-32 font-semibold tabular-nums tracking-tight",
        tone === "warn" && "text-amber-600",
        tone === "danger" && "text-red-600",
      )}>
        {value}
      </p>
      {lines.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {lines.map((l) => (
            <p key={l} className="truncate text-11 text-muted-foreground">{l}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Un graphe qui prend exactement la place que le widget lui laisse.
 *
 * Les graphes du module attendent une hauteur en pixels ; un widget, lui, n'a
 * de hauteur qu'une fois posé dans la grille, et elle change avec la largeur de
 * la fenêtre. On mesure donc le corps du widget et on passe la mesure au
 * graphe — sans quoi un graphe de 250 px déborderait d'une case de 220, ou
 * flotterait en haut d'une case de 400.
 */
function ChartWidget({
  title, hint, children,
}: {
  title: string;
  hint?: string;
  /** null quand il n'y a rien à tracer sur la période. */
  children: ((height: number, width: number) => ReactNode) | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ h: 0, w: 0 });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setDims((d) => (Math.abs(d.h - r.height) < 1 && Math.abs(d.w - r.width) < 1
        ? d : { h: Math.floor(r.height), w: Math.floor(r.width) }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex items-baseline gap-2 pb-2">
        <h3 className="truncate text-13 font-medium">{title}</h3>
        {hint && <span className="truncate text-11 text-muted-foreground">{hint}</span>}
      </div>
      <div ref={box} className="min-h-0 flex-1">
        {children === null
          ? <NoData compact />
          : dims.h > 0 && children(dims.h, dims.w)}
      </div>
    </div>
  );
}

/** Un panneau de lignes chiffrées, qui défile si la case est trop courte. */
function PanelWidget({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col p-4">
      <h3 className="pb-2 text-13 font-medium">{title}</h3>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

// ── Petites pièces ──────────────────────────────────────────────────────────

/** Une ligne d'un panneau de chiffres : libellé à gauche, valeur à droite. */
function Row({
  label, value, tone,
}: { label: string; value: number | string; tone?: "warn" | "danger" }) {
  return (
    <div className="flex items-baseline justify-between border-b border-border/40 py-1.5 last:border-0">
      <span className="text-12 text-muted-foreground">{label}</span>
      <span className={cn(
        "text-13 font-medium tabular-nums",
        tone === "warn" && "text-amber-600",
        tone === "danger" && "text-red-600",
      )}>
        {value}
      </span>
    </div>
  );
}

function NoData({ compact: small }: { compact?: boolean }) {
  return (
    <p className={cn("text-center text-12 text-muted-foreground", small ? "py-6" : "py-12")}>
      Rien sur cette période.
    </p>
  );
}
