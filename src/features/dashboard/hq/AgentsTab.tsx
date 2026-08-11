// Par agent — the workforce ranked and compared. Everything here is per-agent:
// volume, reliability, spend, what it shipped, which tools it leaned on and how
// much it queried the knowledge base.
import { useMemo, useState } from "react";
import {
  Users, Bot, TrendingUp, DollarSign, Package, Wrench, BookOpen, Trophy,
  ArrowUpDown, Timer, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { fmtUsd, fmtDuration } from "../hqStats";
import type { HqView } from "./model";
import {
  SectionCard, Empty, KpiGrid, RateBar, Legend, useHqPalette, rateTone,
  fmtCompact, timeAgo, Pill,
} from "./primitives";

type SortKey = "runs" | "successRate" | "totalCost" | "deliverables" | "tools" | "searches";

export function AgentsTab({ view, onOpenAgent }: { view: HqView; onOpenAgent?: (id: string) => void }) {
  const { cat, status, greys } = useHqPalette();
  const [sort, setSort] = useState<SortKey>("runs");

  // Per-agent extras the productivity derivation doesn't carry.
  const extras = useMemo(() => {
    const map = new Map<string, { tokens: number; last: string | null; tools: number; toolErrors: number; topTool: string | null; searches: number }>();
    const get = (id: string) => {
      let v = map.get(id);
      if (!v) { v = { tokens: 0, last: null, tools: 0, toolErrors: 0, topTool: null, searches: 0 }; map.set(id, v); }
      return v;
    };
    for (const r of view.runs) {
      const v = get(r.agent_id);
      v.tokens += (Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0);
      if (!v.last || r.created_at > v.last) v.last = r.created_at;
    }
    for (const t of view.toolUsage.byAgent) {
      const v = get(t.agentId);
      v.tools = t.calls; v.toolErrors = t.errors; v.topTool = t.topTool;
    }
    for (const k of view.knowledge.byAgent) get(k.agentId).searches = k.searches;
    return map;
  }, [view.runs, view.toolUsage, view.knowledge]);

  const rows = useMemo(() => {
    const withExtras = view.productivity.map((p) => ({ ...p, extra: extras.get(p.agent.id) }));
    return [...withExtras].sort((a, b) => {
      switch (sort) {
        case "successRate": return (b.successRate ?? -1) - (a.successRate ?? -1);
        case "totalCost": return b.totalCost - a.totalCost;
        case "deliverables": return b.deliverables - a.deliverables;
        case "tools": return (b.extra?.tools ?? 0) - (a.extra?.tools ?? 0);
        case "searches": return (b.extra?.searches ?? 0) - (a.extra?.searches ?? 0);
        default: return b.runs - a.runs;
      }
    });
  }, [view.productivity, extras, sort]);

  const active = view.productivity.filter((r) => r.runs > 0);
  const podium = [...active].sort((a, b) => b.runs - a.runs).slice(0, 3);
  const best = [...active].filter((r) => r.successRate != null).sort((a, b) => (b.successRate ?? 0) - (a.successRate ?? 0))[0];
  const totalRuns = view.headline.runs;
  const maxRuns = Math.max(1, ...active.map((r) => r.runs));

  if (view.agents.length === 0) {
    return <Empty label="Aucun agent dans le périmètre." className="h-40" />;
  }

  return (
    <div className="space-y-4">
      <KpiGrid
        cards={[
          { key: "active", label: "Agents actifs", value: String(active.length), sub: `sur ${view.agents.length} agents`, icon: Users, accent: cat[0] },
          { key: "top", label: "Top agent", value: podium[0]?.agent.name ?? "—", sub: podium[0] ? `${podium[0].runs} runs` : "Aucun run", icon: Trophy, accent: cat[3] },
          { key: "best", label: "Meilleure fiabilité", value: best?.successRate != null ? `${best.successRate}%` : "—", sub: best?.agent.name, icon: TrendingUp, accent: cat[1], tone: rateTone(best?.successRate ?? null) },
          { key: "cost", label: "Coût moyen / run", value: totalRuns ? fmtUsd(view.headline.totalCost / totalRuns) : "—", sub: `${totalRuns} runs au total`, icon: DollarSign, accent: cat[6], delta: view.deltas.cost, deltaGood: "down" },
          { key: "ship", label: "Livrables / agent actif", value: active.length ? (view.outputs.total / active.length).toFixed(1) : "—", sub: `${view.outputs.total} au total`, icon: Package, accent: cat[4], delta: view.deltas.deliverables },
          { key: "tools", label: "Appels d'outils / agent", value: active.length ? Math.round(view.toolUsage.calls / active.length).toString() : "—", sub: `${view.toolUsage.distinctTools} outils distincts`, icon: Wrench, accent: cat[5], delta: view.deltas.toolCalls },
        ]}
      />

      {podium.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {podium.map((r, i) => {
            const e = extras.get(r.agent.id);
            return (
              <button key={r.agent.id} onClick={() => onOpenAgent?.(r.agent.id)}
                className={cn(
                  "relative overflow-hidden rounded-2xl border border-border/70 bg-card p-4 text-left shadow-sm transition-all",
                  onOpenAgent && "hover:-translate-y-0.5 hover:shadow-md",
                )}>
                <span aria-hidden className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full opacity-[0.16] blur-2xl" style={{ background: cat[i] }} />
                <div className="relative flex items-center gap-3">
                  <span className="relative">
                    <AgentIdentity url={r.agent.avatar_url} seed={r.agent.name} size={44} rounded="rounded-xl" />
                    <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white shadow" style={{ background: cat[i] }}>
                      {i + 1}
                    </span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{r.agent.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      <Pill tone="accent">{r.runs} runs</Pill>
                      {r.successRate != null && <Pill tone={r.successRate >= 70 ? "good" : r.successRate >= 40 ? "warn" : "bad"}>{r.successRate}% succès</Pill>}
                    </div>
                  </div>
                </div>
                <div className="relative mt-3 grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: "Coût", value: fmtUsd(r.totalCost) },
                    { label: "Livrables", value: String(r.deliverables) },
                    { label: "Outils", value: String(e?.tools ?? 0) },
                  ].map((m) => (
                    <div key={m.label} className="rounded-xl bg-muted/40 py-1.5">
                      <div className="truncate text-xs font-semibold tabular-nums">{m.value}</div>
                      <div className="text-[10px] text-muted-foreground">{m.label}</div>
                    </div>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Volume par agent" subtitle="Runs de la période, par issue" icon={<Zap className="h-3.5 w-3.5" />}>
          {active.length === 0 ? <Empty label="Aucun run sur la période." /> : (
            <>
              <div className="scrollbar-slim max-h-64 space-y-2 overflow-y-auto pr-1">
                {active.slice(0, 12).map((r) => {
                  const failed = r.runs - r.succeeded;
                  return (
                    <div key={r.agent.id} className="flex items-center gap-3">
                      <span className="flex w-32 shrink-0 items-center gap-1.5 truncate text-xs text-muted-foreground" title={r.agent.name}>
                        <AgentIdentity url={r.agent.avatar_url} seed={r.agent.name} size={16} rounded="rounded-md" />
                        <span className="truncate">{r.agent.name}</span>
                      </span>
                      <span className="flex h-2.5 flex-1 overflow-hidden rounded-full" style={{ background: greys.empty }}>
                        {r.succeeded > 0 && <span className="h-full ring-1 ring-card" style={{ width: `${(r.succeeded / maxRuns) * 100}%`, background: status.good }} />}
                        {failed > 0 && <span className="h-full ring-1 ring-card" style={{ width: `${(failed / maxRuns) * 100}%`, background: status.critical }} />}
                      </span>
                      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{r.runs} runs</span>
                    </div>
                  );
                })}
              </div>
              <Legend items={[
                { color: status.good, label: "Réussis" },
                { color: status.critical, label: "Échoués / en cours" },
              ]} />
            </>
          )}
        </SectionCard>

        <SectionCard title="Outil favori par agent" subtitle="L'outil le plus appelé, et le volume total" icon={<Wrench className="h-3.5 w-3.5" />}>
          {view.toolUsage.byAgent.length === 0 ? <Empty label="Aucun appel d'outil sur la période." /> : (
            <div className="scrollbar-slim max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {view.toolUsage.byAgent.slice(0, 12).map((a) => (
                <div key={a.agentId} className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-muted/20 px-2.5 py-1.5 text-xs">
                  <AgentIdentity url={view.agentById.get(a.agentId)?.avatar_url} seed={view.agentName(a.agentId)} size={20} rounded="rounded-md" />
                  <span className="w-24 shrink-0 truncate font-medium">{view.agentName(a.agentId)}</span>
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{a.topTool ?? "—"}</code>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{a.calls}</span>
                  {a.errors > 0 && <Pill tone="bad">{a.errors} err.</Pill>}
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Détail par agent"
        subtitle={`${active.length} agent(s) actif(s) · cliquez sur une colonne pour trier`}
        icon={<Bot className="h-3.5 w-3.5" />}
      >
        <div className="scrollbar-slim -mx-1 max-h-[480px] overflow-auto px-1">
          <table className="w-full min-w-[860px] text-xs">
            <thead className="sticky top-0 z-10 bg-card text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 pr-2">Agent</th>
                <SortableTh label="Runs" k="runs" sort={sort} onSort={setSort} />
                <SortableTh label="Succès" k="successRate" sort={sort} onSort={setSort} />
                <th className="px-2 py-2 text-right">Durée moy.</th>
                <SortableTh label="Coût" k="totalCost" sort={sort} onSort={setSort} />
                <th className="px-2 py-2 text-right">Tokens</th>
                <SortableTh label="Outils" k="tools" sort={sort} onSort={setSort} />
                <SortableTh label="Recherches" k="searches" sort={sort} onSort={setSort} />
                <SortableTh label="Livrables" k="deliverables" sort={sort} onSort={setSort} />
                <th className="px-2 py-2 text-right">Dernier run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((r) => (
                <tr key={r.agent.id} className="transition-colors hover:bg-muted/30">
                  <td className="py-2 pr-2">
                    <button onClick={() => onOpenAgent?.(r.agent.id)} className={cn("flex items-center gap-2 text-left", onOpenAgent && "hover:text-primary")} title={r.agent.name}>
                      <AgentIdentity url={r.agent.avatar_url} seed={r.agent.name} size={26} rounded="rounded-lg" />
                      <span className="max-w-[150px] truncate font-medium text-foreground">{r.agent.name}</span>
                      {r.pendingApprovals > 0 && <Pill tone="warn">{r.pendingApprovals}</Pill>}
                    </button>
                  </td>
                  <td className="px-2 py-2 text-right font-medium tabular-nums">{r.runs}</td>
                  <td className="px-2 py-2 text-right"><RateBar value={r.successRate} /></td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmtDuration(r.avgDurationSec != null ? r.avgDurationSec * 1000 : null)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmtUsd(r.totalCost)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmtCompact.format(r.extra?.tokens ?? 0)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                    {r.extra?.tools ?? 0}
                    {(r.extra?.toolErrors ?? 0) > 0 && <span className="ml-1 text-rose-600 dark:text-rose-400">({r.extra!.toolErrors})</span>}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{r.extra?.searches ?? 0}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{r.deliverables}</td>
                  <td className="px-2 py-2 text-right text-muted-foreground">{r.extra?.last ? timeAgo(r.extra.last) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <MiniStat icon={Timer} label="Durée moyenne d'un run" value={fmtDuration(view.headline.avgDurationSec != null ? view.headline.avgDurationSec * 1000 : null)} />
        <MiniStat icon={BookOpen} label="Recherches de connaissance" value={String(view.knowledge.searches)} sub={view.knowledge.hitRate != null ? `${view.knowledge.hitRate}% de réponses` : undefined} />
        <MiniStat icon={Wrench} label="Appels d'outils" value={String(view.toolUsage.calls)} sub={view.toolUsage.errorRate != null ? `${view.toolUsage.errorRate}% d'échec` : undefined} />
      </div>
    </div>
  );
}

function SortableTh({ label, k, sort, onSort }: { label: string; k: SortKey; sort: SortKey; onSort: (k: SortKey) => void }) {
  const active = sort === k;
  return (
    <th className="px-2 py-2 text-right">
      <button onClick={() => onSort(k)} className={cn("inline-flex items-center gap-1 transition-colors hover:text-foreground", active && "text-foreground")}>
        {label}<ArrowUpDown className={cn("h-3 w-3", active ? "opacity-100" : "opacity-40")} />
      </button>
    </th>
  );
}

function MiniStat({ icon: Icon, label, value, sub }: { icon: typeof Bot; label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-3.5 shadow-sm">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Icon className="h-4 w-4" /></span>
      <div className="min-w-0">
        <div className="truncate text-lg font-semibold tabular-nums leading-tight">{value}</div>
        <div className="truncate text-[11px] text-muted-foreground">{sub ?? label}</div>
      </div>
    </div>
  );
}
