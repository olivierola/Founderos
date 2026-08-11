// Gouvernance — the human-in-the-loop record: what the agents asked permission
// for, who decided, how fast, and which tools concentrate the risk.
import {
  ShieldCheck, TrendingUp, CheckCircle2, XCircle, AlertTriangle, Timer, Wrench, Users,
} from "lucide-react";
import { AgentIdentity } from "@/components/AgentIdentity";
import type { HqView } from "./model";
import {
  SectionCard, Empty, KpiGrid, Donut, BarList, useHqPalette, rateTone, Pill,
} from "./primitives";

export function GovernanceTab({ view }: { view: HqView }) {
  const { cat, status } = useHqPalette();
  const s = view.approvalStats;

  const statusColors: Record<string, string> = {
    "Approuvées": status.good,
    "Rejetées": status.critical,
    "En attente": status.warning,
    "Échec d'exécution": status.serious,
  };

  return (
    <div className="space-y-4">
      <KpiGrid
        cards={[
          { key: "total", label: "Requêtes d'approbation", value: String(s.total), icon: ShieldCheck, accent: cat[0], curve: { name: "Requêtes par période", data: view.bucket(view.approvals, (a) => a.requested_at), labels: view.labels, fullLabels: view.fullLabels } },
          { key: "rate", label: "Taux d'approbation", value: s.approvalRate == null ? "—" : `${s.approvalRate}%`, icon: TrendingUp, accent: cat[1], tone: rateTone(s.approvalRate) },
          { key: "appr", label: "Approuvées", value: String(s.approved + s.executed), icon: CheckCircle2, accent: cat[1], curve: { name: "Approuvées par période", data: view.bucket(view.approvals, (a) => a.requested_at, (a) => a.status === "approved" || a.status === "executed"), labels: view.labels, fullLabels: view.fullLabels } },
          { key: "rej", label: "Rejetées", value: String(s.rejected), icon: XCircle, accent: cat[7], curve: { name: "Rejetées par période", data: view.bucket(view.approvals, (a) => a.requested_at, (a) => a.status === "rejected"), labels: view.labels, fullLabels: view.fullLabels } },
          { key: "pend", label: "En attente", value: String(s.pending), icon: AlertTriangle, accent: cat[3], tone: s.pending > 0 ? "text-amber-600 dark:text-amber-400" : undefined },
          { key: "dec", label: "Délai de décision", value: s.avgDecisionMin == null ? "—" : `${s.avgDecisionMin} min`, sub: "moyenne humaine", icon: Timer, accent: cat[4] },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Issue des requêtes" subtitle="Décisions humaines sur les actions sensibles" icon={<ShieldCheck className="h-3.5 w-3.5" />}>
          {s.byStatus.length === 0 ? <Empty label="Aucune requête sur la période." /> : (
            <Donut
              unit="requêtes"
              total={s.total}
              slices={s.byStatus}
              colors={s.byStatus.map((x) => statusColors[x.label] ?? cat[0])}
            />
          )}
        </SectionCard>

        <SectionCard title="Concentration du risque" subtitle="Requêtes par outil — la part rejetée en surimpression" icon={<Wrench className="h-3.5 w-3.5" />}>
          <BarList
            emptyLabel="Aucune requête."
            labelWidth="w-32"
            rows={s.byTool.slice(0, 9).map((t) => ({
              key: t.tool,
              label: t.tool,
              value: t.total,
              overlay: t.rejected > 0 ? { value: t.rejected, color: status.critical, label: "Rejetées" } : undefined,
              caption: `${t.total} · ${t.approved} ✓${t.pending > 0 ? ` · ${t.pending} …` : ""}`,
              color: cat[0],
            }))}
          />
        </SectionCard>
      </div>

      <SectionCard title="Par agent" subtitle="Qui demande le plus de validations" icon={<Users className="h-3.5 w-3.5" />}>
        {s.byAgent.length === 0 ? <Empty label="Aucune requête." /> : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {s.byAgent.slice(0, 9).map((a) => (
              <div key={a.agentId} className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-muted/20 px-2.5 py-2">
                <AgentIdentity url={view.agentById.get(a.agentId)?.avatar_url} seed={view.agentName(a.agentId)} size={26} rounded="rounded-lg" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{view.agentName(a.agentId)}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <Pill tone="good">{a.approved} ✓</Pill>
                    {a.rejected > 0 && <Pill tone="bad">{a.rejected} ✕</Pill>}
                    {a.pending > 0 && <Pill tone="warn">{a.pending} en attente</Pill>}
                  </div>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums">{a.total}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
