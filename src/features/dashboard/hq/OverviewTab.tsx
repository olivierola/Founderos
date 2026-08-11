// Vue d'ensemble — what the workforce did over the period: run volume by
// outcome, spend, what came out of it, and the two live queues (approvals to
// decide, latest activity).
import { useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import {
  Zap, DollarSign, Package, Activity, ShieldCheck, CheckCircle2, XCircle, Loader2,
  Bot, Target, Clock, ChevronRight, AlertTriangle, Radio,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { foldToSlots } from "@/features/crm/overview/vizPalette";
import { fmtUsd, deliverableLabel, type HqApproval } from "../hqStats";
import type { HqView } from "./model";
import { useHqRefresh } from "./useHqData";
import {
  SectionCard, Empty, Legend, Donut, BarList, useHqPalette, chartAxis, chartTooltip,
  timeAgo, Pill,
} from "./primitives";

export function OverviewTab({ view, onOpenAgent }: { view: HqView; onOpenAgent?: (id: string) => void }) {
  const { cat, status, greys } = useHqPalette();
  const { series, headline, outputs, sources } = view;

  const runRows = series.map((p) => ({
    tick: p.tick, full: p.full,
    succeeded: p.succeeded, failed: p.failed, ongoing: p.ongoing,
    cost: p.costUsd, cumCost: p.cumCostUsd,
  }));
  const hasRuns = headline.runs > 0;

  return (
    <div className="space-y-4">
      {/* Two measures of different scale = two charts. A single panel with a
          second y-axis for the cost was lying about the correlation. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <SectionCard
          className="xl:col-span-2"
          title="Exécutions par période"
          subtitle={`${headline.runs} runs · ${headline.succeeded} réussis · ${headline.failed} échoués · ${headline.ongoing} en cours`}
          icon={<Zap className="h-3.5 w-3.5" />}
        >
          {!hasRuns ? <Empty label="Aucun run sur la période." className="h-56" /> : (
            <>
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={runRows} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
                    <XAxis dataKey="tick" {...chartAxis} />
                    <YAxis width={36} {...chartAxis} allowDecimals={false} />
                    <Tooltip {...chartTooltip}
                      labelFormatter={(_, p) => (p?.[0]?.payload as { full?: string } | undefined)?.full ?? ""} />
                    {/* 2px surface gap between stacked segments. */}
                    <Bar dataKey="succeeded" name="Réussis" stackId="r" fill={status.good} maxBarSize={26} stroke="hsl(var(--card))" strokeWidth={1.5} />
                    <Bar dataKey="failed" name="Échoués" stackId="r" fill={status.critical} maxBarSize={26} stroke="hsl(var(--card))" strokeWidth={1.5} />
                    <Bar dataKey="ongoing" name="En cours" stackId="r" fill={greys.context} radius={[4, 4, 0, 0]} maxBarSize={26} stroke="hsl(var(--card))" strokeWidth={1.5} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Legend items={[
                { color: status.good, label: "Réussis", value: String(headline.succeeded) },
                { color: status.critical, label: "Échoués", value: String(headline.failed) },
                { color: greys.context, label: "En cours", value: String(headline.ongoing) },
              ]} />
            </>
          )}
        </SectionCard>

        <SectionCard title="Coût cumulé" subtitle={`${fmtUsd(headline.totalCost)} sur la période · ${fmtUsd(headline.avgCost)} par run`}
          icon={<DollarSign className="h-3.5 w-3.5" />}>
          {!hasRuns ? <Empty label="Aucune dépense sur la période." className="h-56" /> : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={runRows} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
                  <defs>
                    <linearGradient id="hq-cost" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={cat[6]} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={cat[6]} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" vertical={false} />
                  <XAxis dataKey="tick" {...chartAxis} />
                  <YAxis width={46} {...chartAxis} tickFormatter={(v: number) => fmtUsd(v)} />
                  <Tooltip {...chartTooltip}
                    formatter={(v) => [fmtUsd(Number(v) || 0), "Coût cumulé"]}
                    labelFormatter={(_, p) => (p?.[0]?.payload as { full?: string } | undefined)?.full ?? ""} />
                  <Area type="monotone" dataKey="cumCost" name="Coût cumulé" stroke={cat[6]} strokeWidth={2}
                    fill="url(#hq-cost)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard title="Origine des runs" subtitle="Qui déclenche le travail" icon={<Radio className="h-3.5 w-3.5" />}>
          <Donut
            slices={foldToSlots(sources.map((s) => ({ label: s.label, count: s.value }))).map((s) => ({ label: s.label, value: s.count }))}
            total={sources.reduce((s, x) => s + x.value, 0)}
            unit="runs"
          />
        </SectionCard>

        <SectionCard title="Livrables produits" subtitle={outputs.perRun != null ? `${outputs.total} livrables · ${outputs.perRun} par run réussi` : `${outputs.total} livrables`}
          icon={<Package className="h-3.5 w-3.5" />}>
          <BarList
            emptyLabel="Aucun livrable sur la période."
            rows={foldToSlots(outputs.byKind.map((k) => ({ label: k.label, count: k.count }))).map((k, i) => ({
              key: k.label, label: k.label, value: k.count, caption: String(k.count), color: cat[Math.min(i, cat.length - 1)],
            }))}
            labelWidth="w-24"
          />
        </SectionCard>

        <SectionCard title="Missions les plus chargées" subtitle={`${view.funnel.scheduled} planifiée(s) · ${view.funnel.perMission.length} mission(s)`}
          icon={<Target className="h-3.5 w-3.5" />}>
          {view.funnel.perMission.length === 0 ? <Empty label="Aucune mission." /> : (
            <div className="scrollbar-slim max-h-52 space-y-1.5 overflow-y-auto pr-1">
              {view.funnel.perMission.slice(0, 7).map((m, i) => (
                <div key={m.id} className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-muted/20 px-2.5 py-1.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-card text-[10px] font-bold shadow-sm">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{m.title}</span>
                  <Pill tone={m.status === "active" ? "good" : "muted"}>{m.status}</Pill>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{m.runs}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <WorkforceRoster view={view} onOpenAgent={onOpenAgent} />
        </div>
        <div className="space-y-4">
          <ApprovalQueue view={view} />
          <ActivityFeed view={view} />
        </div>
      </div>
    </div>
  );
}

// ── Roster ───────────────────────────────────────────────────────────────────

function WorkforceRoster({ view, onOpenAgent }: { view: HqView; onOpenAgent?: (id: string) => void }) {
  const { status } = useHqPalette();
  const rows = view.productivity;

  return (
    <SectionCard title="Force de travail" subtitle={`${view.agents.length} agent(s) · ${rows.filter((r) => r.runs > 0).length} actif(s) sur la période`}
      icon={<Bot className="h-3.5 w-3.5" />}>
      {view.agents.length === 0 ? <Empty label="Aucun agent. Créez votre premier agent pour voir des statistiques ici." /> : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {rows.slice(0, 8).map((r) => {
            const searches = view.knowledge.byAgent.find((k) => k.agentId === r.agent.id)?.searches ?? 0;
            const tools = view.toolUsage.byAgent.find((t) => t.agentId === r.agent.id)?.calls ?? 0;
            return (
              <button key={r.agent.id} onClick={() => onOpenAgent?.(r.agent.id)}
                className={cn(
                  "flex items-start gap-3 rounded-xl border border-border/70 bg-card p-3 text-left transition-all",
                  onOpenAgent && "hover:-translate-y-0.5 hover:border-border hover:shadow-md",
                )}>
                <AgentIdentity url={r.agent.avatar_url} seed={r.agent.name} size={38} rounded="rounded-xl" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">{r.agent.name}</span>
                    {r.pendingApprovals > 0 && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-muted-foreground">
                    {r.runs > 0 ? (
                      <>
                        <span className="tabular-nums">{r.runs} runs</span>
                        {r.successRate != null && (
                          <span className="font-medium tabular-nums" style={{ color: r.successRate >= 70 ? status.good : r.successRate >= 40 ? status.warning : status.critical }}>
                            {r.successRate}%
                          </span>
                        )}
                        {r.deliverables > 0 && <span className="tabular-nums">{r.deliverables} livrables</span>}
                        {tools > 0 && <span className="tabular-nums">{tools} outils</span>}
                        {searches > 0 && <span className="tabular-nums">{searches} recherches</span>}
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> Inactif sur la période</span>
                    )}
                  </div>
                </div>
                {onOpenAgent && <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />}
              </button>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// ── Approvals ────────────────────────────────────────────────────────────────

export function ApprovalQueue({ view }: { view: HqView }) {
  const refresh = useHqRefresh();
  const [deciding, setDeciding] = useState<string | null>(null);
  const pending = view.approvals.filter((a) => a.status === "pending");

  async function decide(ap: HqApproval, decision: "approve" | "reject") {
    setDeciding(ap.id);
    try {
      await callEdge("internal-agent-approve", { approval_id: ap.id, decision });
      // The decision moves the approval AND resumes the run, which may ship a
      // deliverable — refresh the whole cockpit rather than three of its keys.
      refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Échec de la décision");
    } finally {
      setDeciding(null);
    }
  }

  return (
    <SectionCard
      title="File d'approbation"
      subtitle={view.approvalStats.avgDecisionMin != null ? `Décision moyenne : ${view.approvalStats.avgDecisionMin} min` : "Actions sensibles en attente"}
      icon={<ShieldCheck className="h-3.5 w-3.5" />}
      right={pending.length > 0 ? <Pill tone="bad">{pending.length}</Pill> : undefined}
    >
      {pending.length === 0 ? <Empty label="Rien à décider." className="h-16" /> : (
        <div className="scrollbar-slim max-h-72 space-y-2 overflow-y-auto pr-1">
          {pending.map((ap) => {
            const agent = view.agentById.get(ap.agent_id);
            const busy = deciding === ap.id;
            return (
              <div key={ap.id} className="rounded-xl border border-border/70 bg-muted/20 p-2.5">
                <div className="flex items-center gap-2">
                  <AgentIdentity url={agent?.avatar_url} seed={agent?.name ?? "Agent"} size={26} rounded="rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">
                      <span className="font-semibold">{agent?.name ?? "Agent"}</span>
                      <span className="text-muted-foreground"> veut exécuter </span>
                      <code className="rounded bg-muted px-1 text-[10px]">{ap.tool_name}</code>
                    </div>
                    {ap.reason && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{ap.reason}</p>}
                  </div>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(ap.requested_at)}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" className="h-7 flex-1 bg-emerald-600 text-xs hover:bg-emerald-700" disabled={busy} onClick={() => decide(ap, "approve")}>
                    {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />} Approuver
                  </Button>
                  <Button size="sm" variant="destructive" className="h-7 flex-1 text-xs" disabled={busy} onClick={() => decide(ap, "reject")}>
                    <XCircle className="mr-1 h-3 w-3" /> Rejeter
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// ── Activity ─────────────────────────────────────────────────────────────────

type FeedItem = { id: string; at: string; kind: "deliverable" | "run" | "approval"; ok?: boolean; label: string; agentId: string };

export function ActivityFeed({ view, limit = 14 }: { view: HqView; limit?: number }) {
  const { status } = useHqPalette();
  const items: FeedItem[] = [
    ...view.deliverables.map((d) => ({ id: `d${d.id}`, at: d.created_at, kind: "deliverable" as const, label: d.name || deliverableLabel(d.kind), agentId: d.agent_id })),
    ...view.runs
      .filter((r) => r.status === "succeeded" || r.status === "failed")
      .map((r) => ({
        id: `r${r.id}`, at: r.finished_at ?? r.created_at, kind: "run" as const, ok: r.status === "succeeded",
        label: r.label || (r.status === "succeeded" ? "Run terminé" : r.error_message?.split("\n")[0] || "Run en échec"),
        agentId: r.agent_id,
      })),
    ...view.approvals
      .filter((a) => a.status !== "pending" && a.decided_at)
      .map((a) => ({ id: `a${a.id}`, at: a.decided_at!, kind: "approval" as const, ok: a.status !== "rejected", label: `${a.tool_name} ${a.status === "rejected" ? "rejeté" : "approuvé"}`, agentId: a.agent_id })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);

  return (
    <SectionCard title="Activité récente" subtitle="Livrables, fins de run et décisions" icon={<Activity className="h-3.5 w-3.5" />}>
      {items.length === 0 ? <Empty label="Aucune activité sur la période." className="h-16" /> : (
        <div className="scrollbar-slim max-h-80 space-y-0.5 overflow-y-auto pr-1">
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs transition-colors hover:bg-muted/40">
              <span className="shrink-0" style={{ color: it.kind === "deliverable" ? status.good : it.ok ? status.good : status.critical }}>
                {it.kind === "deliverable" ? <Package className="h-3.5 w-3.5" />
                  : it.kind === "approval" ? <ShieldCheck className="h-3.5 w-3.5" />
                  : it.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{it.label}</span>
                <span className="block truncate text-[10px] text-muted-foreground">{view.agentName(it.agentId)}</span>
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(it.at)}</span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
