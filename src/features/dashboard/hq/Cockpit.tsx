// The AI HQ cockpit — one data layer + one tabbed shell, rendered both by the
// project-wide AI Headquarters page and by a single service dashboard's own
// "Dashboard" tab (same components, agents scoped to that service).
import { useMemo, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2, RefreshCw, Zap, TrendingUp, DollarSign, Package, Wrench, ShieldCheck,
  LayoutDashboard, Building2, Users, BookOpen, Bug, Timer, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtUsd, fmtDuration, type RangeKey } from "../hqStats";
import { buildHqView, type HqRawData, type HqView } from "./model";
import { KpiGrid, RangePicker, Segmented, rateTone, useHqPalette, fmtCompact } from "./primitives";
import { OverviewTab } from "./OverviewTab";
import { ServicesTab } from "./ServicesTab";
import { AgentsTab } from "./AgentsTab";
import { ToolsTab } from "./ToolsTab";
import { KnowledgeTab } from "./KnowledgeTab";
import { GovernanceTab } from "./GovernanceTab";
import { LoopTab } from "./LoopTab";

export { useHqData, useHqRefresh } from "./useHqData";

// ─────────────────────────────────────────────────────────────────── shell

export type HqTabKey = "overview" | "services" | "agents" | "tools" | "knowledge" | "governance" | "loop";

const TABS: { key: HqTabKey; label: string; icon: LucideIcon }[] = [
  { key: "overview", label: "Vue d'ensemble", icon: LayoutDashboard },
  { key: "services", label: "Services", icon: Building2 },
  { key: "agents", label: "Agents", icon: Users },
  { key: "tools", label: "Outils", icon: Wrench },
  { key: "knowledge", label: "Connaissances", icon: BookOpen },
  { key: "governance", label: "Gouvernance", icon: ShieldCheck },
  { key: "loop", label: "Santé du loop", icon: Bug },
];

export function HqCockpit({
  raw, isLoading, isFetching, range, onRangeChange, onRefresh,
  hideServices, header, onOpenAgent, onOpenService, onOpenCollection, className,
}: {
  raw: HqRawData;
  isLoading?: boolean;
  isFetching?: boolean;
  range: RangeKey;
  onRangeChange: (r: RangeKey) => void;
  onRefresh?: () => void;
  /** Hidden when the cockpit is already scoped to a single service. */
  hideServices?: boolean;
  /** Title block rendered above the KPI band. */
  header?: ReactNode;
  onOpenAgent?: (id: string) => void;
  onOpenService?: (id: string) => void;
  onOpenCollection?: (id: string) => void;
  className?: string;
}) {
  const [tab, setTab] = useState<HqTabKey>("overview");
  const view = useMemo(() => buildHqView(raw, range), [raw, range]);
  const tabs = TABS.filter((t) => !(hideServices && t.key === "services"));
  const activeTab = tabs.some((t) => t.key === tab) ? tab : "overview";

  if (isLoading) {
    return (
      <div className={cn("flex h-64 items-center justify-center", className)}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        {header}
        <div className="ml-auto flex items-center gap-2">
          {onRefresh && (
            <button
              onClick={onRefresh}
              title="Rafraîchir les statistiques"
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            </button>
          )}
          <RangePicker value={range} onChange={onRangeChange} />
        </div>
      </div>

      <HeadlineBand view={view} />

      <Segmented
        layoutId="hq-cockpit-tab"
        value={activeTab}
        onChange={setTab}
        items={tabs.map((t) => ({
          ...t,
          badge: t.key === "governance" ? view.approvalStats.pending : undefined,
        }))}
      />

      <AnimatePresence mode="wait">
        <motion.div key={activeTab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18, ease: "easeOut" }}>
          {activeTab === "overview" && <OverviewTab view={view} onOpenAgent={onOpenAgent} />}
          {activeTab === "services" && <ServicesTab view={view} onOpenService={onOpenService} />}
          {activeTab === "agents" && <AgentsTab view={view} onOpenAgent={onOpenAgent} />}
          {activeTab === "tools" && <ToolsTab view={view} />}
          {activeTab === "knowledge" && <KnowledgeTab view={view} onOpenCollection={onOpenCollection} />}
          {activeTab === "governance" && <GovernanceTab view={view} />}
          {activeTab === "loop" && <LoopTab view={view} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** The six numbers that stay on screen whatever tab is open. */
function HeadlineBand({ view }: { view: HqView }) {
  const { cat } = useHqPalette();
  const h = view.headline;
  const { labels, fullLabels, series } = view;

  return (
    <KpiGrid
      cards={[
        {
          key: "runs", label: "Exécutions", value: String(h.runs),
          sub: `${h.ongoing} en cours`, icon: Zap, accent: cat[0],
          delta: view.deltas.runs, deltaGood: "none",
          curve: { name: "Runs par période", data: series.map((p) => p.runs), labels, fullLabels },
        },
        {
          key: "rate", label: "Taux de succès", value: h.successRate == null ? "—" : `${h.successRate}%`,
          sub: `${h.succeeded} réussis · ${h.failed} échoués`, icon: TrendingUp, accent: cat[1],
          tone: rateTone(h.successRate), delta: view.deltas.successRate, deltaGood: "up", deltaSuffix: " pts",
          curve: {
            name: "Taux de succès", labels, fullLabels,
            data: series.map((p) => (p.succeeded + p.failed ? Math.round((p.succeeded / (p.succeeded + p.failed)) * 100) : 0)),
            fmt: (v) => `${Math.round(v)}%`,
          },
        },
        {
          key: "cost", label: "Coût", value: fmtUsd(h.totalCost),
          sub: `${fmtUsd(h.avgCost)} / run · ${fmtCompact.format(h.totalTokens)} tokens`,
          icon: DollarSign, accent: cat[6], delta: view.deltas.cost, deltaGood: "down",
          curve: { name: "Coût par période", data: series.map((p) => p.costUsd), labels, fullLabels, fmt: fmtUsd },
        },
        {
          key: "outputs", label: "Livrables", value: String(view.outputs.total),
          sub: view.outputs.perRun != null ? `${view.outputs.perRun} par run réussi` : undefined,
          icon: Package, accent: cat[4], delta: view.deltas.deliverables, deltaGood: "up",
          curve: { name: "Livrables par période", data: view.bucket(view.deliverables, (d) => d.created_at), labels, fullLabels },
        },
        {
          key: "tools", label: "Appels d'outils", value: String(view.toolUsage.calls),
          sub: view.toolUsage.errorRate != null ? `${view.toolUsage.errorRate}% d'échec` : `${view.toolUsage.distinctTools} outils`,
          icon: Wrench, accent: cat[5], delta: view.deltas.toolCalls, deltaGood: "none",
          curve: { name: "Appels d'outils", data: view.bucket(view.toolEvents, (e) => e.created_at, (e) => e.kind === "tool_call"), labels, fullLabels },
        },
        {
          key: "dur", label: "Durée moyenne", value: fmtDuration(h.avgDurationSec != null ? h.avgDurationSec * 1000 : null),
          sub: `${view.knowledge.searches} recherches de connaissance`, icon: Timer, accent: cat[3],
          delta: view.deltas.duration, deltaGood: "down",
          curve: {
            name: "Durée moyenne des runs", labels, fullLabels,
            data: series.map((p) => p.avgDurationSec ?? 0), fmt: (v) => fmtDuration(v * 1000),
          },
        },
      ]}
    />
  );
}
