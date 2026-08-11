// Outils — what the workforce actually *does*, read from the tool_call /
// tool_result events the runtime writes for every action. Grouped by capability
// family, then per tool, then crossed with the agents that call them.
import { useMemo, useState } from "react";
import {
  Wrench, Layers, AlertTriangle, Repeat, Grid3x3, ShieldCheck, Activity, Boxes,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { foldToSlots } from "@/features/crm/overview/vizPalette";
import { familyLabel, TOOL_FAMILIES, type ToolFamilyKey } from "../hqUsage";
import type { HqView } from "./model";
import {
  SectionCard, Empty, KpiGrid, BarList, Donut, HeatGrid, useHqPalette,
  timeAgo, Pill, Segmented,
} from "./primitives";

const FRAGILE_MIN_CALLS = 3;
const FRAGILE_ERROR_RATE = 25;

export function ToolsTab({ view }: { view: HqView }) {
  const { cat, status } = useHqPalette();
  const usage = view.toolUsage;
  const [family, setFamily] = useState<ToolFamilyKey | "all">("all");

  const tools = useMemo(
    () => (family === "all" ? usage.byTool : usage.byTool.filter((t) => t.family === family)),
    [usage.byTool, family],
  );

  const fragile = usage.byTool.filter((t) => (t.ok + t.errors) >= FRAGILE_MIN_CALLS && (t.errorRate ?? 0) >= FRAGILE_ERROR_RATE);
  const topFamily = usage.byFamily[0];
  const gated = view.approvalStats.byTool;

  // The heat map stays readable at ~10 columns; beyond that the cells shrink
  // below the label. Take the most-used tools and the most-active agents.
  const heatTools = tools.slice(0, 10);
  const heatAgents = usage.byAgent.slice(0, 12);

  if (usage.calls === 0 && usage.errors === 0) {
    return <Empty label="Aucun appel d'outil enregistré sur la période." className="h-40" />;
  }

  return (
    <div className="space-y-4">
      <KpiGrid
        cards={[
          { key: "calls", label: "Appels d'outils", value: String(usage.calls), icon: Wrench, accent: cat[0], delta: view.deltas.toolCalls, curve: { name: "Appels d'outils", data: view.bucket(view.toolEvents, (e) => e.created_at, (e) => e.kind === "tool_call"), labels: view.labels, fullLabels: view.fullLabels } },
          { key: "distinct", label: "Outils distincts", value: String(usage.distinctTools), sub: `${usage.byFamily.length} familles`, icon: Boxes, accent: cat[1] },
          { key: "perrun", label: "Appels par run", value: usage.perRun == null ? "—" : String(usage.perRun), icon: Repeat, accent: cat[4] },
          { key: "err", label: "Taux d'échec", value: usage.errorRate == null ? "—" : `${usage.errorRate}%`, sub: `${usage.errors} erreurs`, icon: AlertTriangle, accent: cat[7], tone: (usage.errorRate ?? 0) > 20 ? "text-rose-600 dark:text-rose-400" : undefined, curve: { name: "Erreurs d'outil", data: view.bucket(view.toolEvents, (e) => e.created_at, (e) => e.kind === "tool_result" && e.ok === false), labels: view.labels, fullLabels: view.fullLabels } },
          { key: "fam", label: "Famille dominante", value: topFamily?.label ?? "—", sub: topFamily ? `${topFamily.calls} appels` : undefined, icon: Layers, accent: cat[3] },
          { key: "fragile", label: "Outils fragiles", value: String(fragile.length), sub: `≥ ${FRAGILE_ERROR_RATE}% d'échec`, icon: ShieldCheck, accent: cat[5], tone: fragile.length > 0 ? "text-amber-600 dark:text-amber-400" : undefined },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Par famille de capacité" subtitle="Ce que la force de travail sait faire, en volume" icon={<Layers className="h-3.5 w-3.5" />}>
          <Donut
            unit="appels"
            total={usage.calls}
            slices={foldToSlots(usage.byFamily.map((f) => ({ label: f.label, count: f.calls })))
              .map((f) => ({ label: f.label, value: f.count }))}
          />
        </SectionCard>

        <SectionCard title="Outils fragiles" subtitle={`Au moins ${FRAGILE_MIN_CALLS} résultats et ${FRAGILE_ERROR_RATE}% d'échec`} icon={<AlertTriangle className="h-3.5 w-3.5" />}>
          {fragile.length === 0 ? <Empty label="Aucun outil en échec répété. 👌" /> : (
            <BarList
              labelWidth="w-36"
              rows={fragile.slice(0, 8).map((t) => ({
                key: t.tool,
                label: t.tool,
                value: t.ok + t.errors,
                overlay: { value: t.errors, color: status.critical, label: "Erreurs" },
                caption: `${t.errorRate}% · ${t.errors}/${t.ok + t.errors}`,
                color: status.warning,
              }))}
            />
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Catalogue d'usage"
        subtitle={`${tools.length} outil(s) ${family === "all" ? "toutes familles" : `· ${familyLabel(family)}`}`}
        icon={<Wrench className="h-3.5 w-3.5" />}
        right={
          <Segmented
            layoutId="hq-tool-family"
            className="max-w-[520px]"
            value={family}
            onChange={setFamily}
            items={[
              { key: "all" as const, label: "Toutes" },
              ...TOOL_FAMILIES.filter((f) => usage.byFamily.some((u) => u.key === f.key)).map((f) => ({ key: f.key, label: f.label })),
            ]}
          />
        }
      >
        {tools.length === 0 ? <Empty label="Aucun outil dans cette famille." /> : (
          <div className="scrollbar-slim -mx-1 max-h-[420px] overflow-auto px-1">
            <table className="w-full min-w-[680px] text-xs">
              <thead className="sticky top-0 z-10 bg-card text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-2">Outil</th>
                  <th className="px-2 py-2">Famille</th>
                  <th className="px-2 py-2 text-right">Appels</th>
                  <th className="px-2 py-2">Fiabilité</th>
                  <th className="px-2 py-2 text-right">Agents</th>
                  <th className="px-2 py-2 text-right">Runs</th>
                  <th className="px-2 py-2 text-right">Dernier usage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {tools.map((t) => {
                  const results = t.ok + t.errors;
                  const okShare = results ? (t.ok / results) * 100 : 0;
                  return (
                    <tr key={t.tool} className="transition-colors hover:bg-muted/30">
                      <td className="py-2 pr-2">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground">{t.tool}</code>
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">{familyLabel(t.family)}</td>
                      <td className="px-2 py-2 text-right font-medium tabular-nums">{t.calls}</td>
                      <td className="px-2 py-2">
                        {results === 0 ? <span className="text-muted-foreground">—</span> : (
                          <span className="flex items-center gap-2">
                            <span className="flex h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                              <span className="h-full" style={{ width: `${okShare}%`, background: status.good }} />
                              <span className="h-full" style={{ width: `${100 - okShare}%`, background: status.critical }} />
                            </span>
                            <span className={cn("tabular-nums", t.errors > 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
                              {t.errors > 0 ? `${t.errors} err.` : "OK"}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{t.agents}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{t.runs}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground">{timeAgo(t.lastUsedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Qui utilise quoi"
        subtitle="Nombre d'appels par agent et par outil — plus la case est foncée, plus l'outil est sollicité"
        icon={<Grid3x3 className="h-3.5 w-3.5" />}
      >
        <HeatGrid
          rowLabel="Agent"
          hue={cat[0]}
          emptyLabel="Pas assez d'appels pour croiser agents et outils."
          rows={heatAgents.map((a) => ({
            key: a.agentId,
            label: view.agentName(a.agentId),
            node: (
              <span className="flex items-center gap-1.5">
                <AgentIdentity url={view.agentById.get(a.agentId)?.avatar_url} seed={view.agentName(a.agentId)} size={18} rounded="rounded-md" />
                <span className="max-w-[120px] truncate">{view.agentName(a.agentId)}</span>
              </span>
            ),
          }))}
          cols={heatTools.map((t) => ({ key: t.tool, label: t.tool }))}
          valueOf={(agentId, tool) => usage.matrix.get(agentId)?.get(tool) ?? 0}
        />
      </SectionCard>

      {gated.length > 0 && (
        <SectionCard title="Outils sous validation humaine" subtitle="Actions sensibles passées par la file d'approbation" icon={<ShieldCheck className="h-3.5 w-3.5" />}>
          <div className="flex flex-wrap gap-2">
            {gated.slice(0, 12).map((t) => (
              <span key={t.tool} className="inline-flex items-center gap-1.5 rounded-xl border border-border/70 bg-muted/30 px-2 py-1 text-[11px]">
                <code className="text-[10px] font-medium text-foreground">{t.tool}</code>
                <Pill tone="good">{t.approved} ✓</Pill>
                {t.rejected > 0 && <Pill tone="bad">{t.rejected} ✕</Pill>}
                {t.pending > 0 && <Pill tone="warn">{t.pending} …</Pill>}
              </span>
            ))}
          </div>
        </SectionCard>
      )}

      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
        <Activity className="h-3.5 w-3.5 shrink-0" />
        Chiffres calculés sur les évènements <code className="mx-1 rounded bg-muted px-1">tool_call</code> /
        <code className="mx-1 rounded bg-muted px-1">tool_result</code> des runs de la période. Un outil bloqué par un
        guardrail compte comme un échec.
      </div>
    </div>
  );
}
