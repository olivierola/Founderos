// Santé du loop — the controller's own telemetry (loop run events): how often
// agents replan, stall, loop on themselves or give up, and what makes runs fail.
import { motion } from "framer-motion";
import {
  Activity, Repeat, RefreshCw, Clock, XCircle, TrendingUp, ListChecks, Bug, Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import type { HqView } from "./model";
import { SectionCard, Empty, KpiGrid, BarList, useHqPalette, Legend } from "./primitives";

const STAGNATION_LIMIT = 3;

export function LoopTab({ view }: { view: HqView }) {
  const { cat, status, greys } = useHqPalette();
  const h = view.loopHealth;
  const events = view.loopEvents;

  if (h.decisions === 0 && h.failureReasons.length === 0) {
    return <Empty label="Aucune donnée de contrôleur sur la période." className="h-40" />;
  }

  const finalActions = [
    { label: "Continue", value: h.continues, color: cat[0] },
    { label: "Finalise", value: h.finalizes, color: status.good },
    { label: "Replan", value: h.replans, color: status.warning },
    { label: "Abort", value: h.aborts, color: status.critical },
  ];
  const maxAction = Math.max(1, ...finalActions.map((a) => a.value));

  return (
    <div className="space-y-4">
      <KpiGrid
        gridClass="md:grid-cols-4 xl:grid-cols-8"
        cards={[
          { key: "dec", label: "Décisions", value: String(h.decisions), icon: Activity, accent: cat[0], curve: { name: "Décisions du contrôleur", data: view.bucket(events, (e) => e.created_at), labels: view.labels, fullLabels: view.fullLabels } },
          { key: "replans", label: "Replanifications", value: String(h.replans), icon: Repeat, accent: cat[3], tone: h.replans > 0 ? "text-amber-600 dark:text-amber-400" : undefined, curve: { name: "Replanifications", data: view.bucket(events, (e) => e.created_at, (e) => e.action === "replan"), labels: view.labels, fullLabels: view.fullLabels } },
          { key: "loops", label: "Boucles détectées", value: String(h.loopsDetected), icon: RefreshCw, accent: cat[7], tone: h.loopsDetected > 0 ? "text-rose-600 dark:text-rose-400" : undefined, curve: { name: "Boucles détectées", data: view.bucket(events, (e) => e.created_at, (e) => e.loopDetected), labels: view.labels, fullLabels: view.fullLabels } },
          { key: "stag", label: "Stagnations", value: String(h.stagnationEvents), icon: Clock, accent: cat[3], tone: h.stagnationEvents > 0 ? "text-amber-600 dark:text-amber-400" : undefined, curve: { name: "Stagnations", data: view.bucket(events, (e) => e.created_at, (e) => e.stagnantTicks >= STAGNATION_LIMIT), labels: view.labels, fullLabels: view.fullLabels } },
          { key: "aborts", label: "Abandons", value: String(h.aborts), icon: XCircle, accent: cat[7], tone: h.aborts > 0 ? "text-rose-600 dark:text-rose-400" : undefined, curve: { name: "Abandons", data: view.bucket(events, (e) => e.created_at, (e) => e.action === "abort"), labels: view.labels, fullLabels: view.fullLabels } },
          { key: "esc", label: "Escalades modèle", value: String(h.escalations), icon: TrendingUp, accent: cat[4], curve: { name: "Escalades", data: view.bucket(events, (e) => e.created_at, (e) => e.escalated), labels: view.labels, fullLabels: view.fullLabels } },
          { key: "iter", label: "Itérations moy.", value: h.avgIterations == null ? "—" : String(h.avgIterations), icon: ListChecks, accent: cat[1] },
          { key: "errors", label: "Erreurs signalées", value: String(h.errorsInSignals), icon: Bug, accent: cat[5], curve: { name: "Runs avec erreurs", data: view.bucket(events, (e) => e.created_at, (e) => e.errors > 0), labels: view.labels, fullLabels: view.fullLabels } },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard title="Issue des runs" subtitle="Dernière décision du contrôleur, par run" icon={<Repeat className="h-3.5 w-3.5" />}>
          {h.decisions === 0 ? <Empty label="Aucune donnée de loop." /> : (
            <>
              {/* Heights in px, not %: a percentage height inside an
                  auto-height flex column has no containing block to resolve
                  against, and the bars collapse. */}
              <div className="flex h-40 items-end gap-2">
                {finalActions.map((b) => (
                  <div key={b.label} className="flex flex-1 flex-col items-center justify-end gap-1.5">
                    <span className="text-sm font-bold tabular-nums">{b.value}</span>
                    <motion.div className="w-full rounded-t-md ring-1 ring-card" style={{ background: b.color }}
                      initial={{ height: 0 }} animate={{ height: Math.max(4, Math.round((b.value / maxAction) * 110)) }}
                      transition={{ type: "spring", bounce: 0.25, duration: 0.6 }} />
                    <span className="text-[10px] text-muted-foreground">{b.label}</span>
                  </div>
                ))}
              </div>
              <Legend items={finalActions.map((a) => ({ color: a.color, label: a.label }))} />
            </>
          )}
        </SectionCard>

        <SectionCard title="Par agent" subtitle="Décisions, replans et boucles" icon={<Users className="h-3.5 w-3.5" />}>
          {h.perAgent.length === 0 ? <Empty label="Aucune donnée de loop." /> : (
            <div className="scrollbar-slim max-h-40 space-y-1.5 overflow-y-auto pr-1">
              {h.perAgent.slice(0, 8).map((a) => (
                <div key={a.agentId} className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-2.5 py-1.5 text-[11px]">
                  <AgentIdentity url={view.agentById.get(a.agentId)?.avatar_url} seed={view.agentName(a.agentId)} size={18} rounded="rounded-md" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{view.agentName(a.agentId)}</span>
                  <span className="shrink-0 tabular-nums">{a.decisions} déc.</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{a.replans} repl.</span>
                  <span className={cn("shrink-0 tabular-nums", a.loopsDetected > 0 ? "font-medium text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
                    {a.loopsDetected} boucles
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Causes d'échec" subtitle="Première ligne du message d'erreur des runs échoués" icon={<Bug className="h-3.5 w-3.5" />}>
          <BarList
            emptyLabel="Aucun run échoué. 👌"
            labelWidth="w-40"
            rows={h.failureReasons.map((r) => ({
              key: r.label, label: r.label, value: r.count, caption: String(r.count), color: greys.context,
            }))}
          />
        </SectionCard>
      </div>
    </div>
  );
}
