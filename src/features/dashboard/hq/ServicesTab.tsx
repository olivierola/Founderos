// Par service — the same numbers as the rest of the cockpit, but cut by the
// service dashboard each agent belongs to (internal_agents.service_dashboard_id).
// Agents created outside any dashboard land in a "Sans service" bucket, which is
// itself a finding worth surfacing.
import {
  Building2, Bot, Zap, DollarSign, TrendingUp, Package, ShieldCheck, Wrench,
  BookOpen, ChevronRight, Timer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DashboardTile } from "@/features/service-dashboards/dashboardIcons";
import { foldToSlots } from "@/features/crm/overview/vizPalette";
import { fmtUsd, fmtDuration } from "../hqStats";
import type { ServiceStat } from "../hqUsage";
import type { HqView } from "./model";
import {
  SectionCard, Empty, KpiGrid, Legend, Donut, RateBar, useHqPalette, rateTone,
  fmtCompact, timeAgo, Pill,
} from "./primitives";

export function ServicesTab({ view, onOpenService }: {
  view: HqView; onOpenService?: (serviceId: string) => void;
}) {
  const { cat, status, greys } = useHqPalette();
  const services = view.services;
  const withAgents = services.filter((s) => s.agents > 0 || s.runs > 0);
  const busiest = [...services].sort((a, b) => b.runs - a.runs)[0];
  const priciest = [...services].sort((a, b) => b.cost - a.cost)[0];
  const unassigned = services.find((s) => s.service === null);
  const totalCost = services.reduce((s, x) => s + x.cost, 0);

  if (services.length === 0) {
    return <Empty label="Aucun service. Créez un dashboard de service pour répartir vos agents." className="h-40" />;
  }

  const maxRuns = Math.max(1, ...services.map((s) => s.runs));

  return (
    <div className="space-y-4">
      <KpiGrid
        gridClass="md:grid-cols-3 xl:grid-cols-5"
        cards={[
          { key: "count", label: "Services", value: String(services.filter((s) => s.service).length), sub: `${withAgents.length} avec de l'activité`, icon: Building2, accent: cat[0] },
          { key: "busiest", label: "Service le plus actif", value: busiest && busiest.runs > 0 ? busiest.name : "—", sub: busiest && busiest.runs > 0 ? `${busiest.runs} runs` : "Aucun run", icon: Zap, accent: cat[1] },
          { key: "cost", label: "Service le plus coûteux", value: priciest && priciest.cost > 0 ? priciest.name : "—", sub: priciest && priciest.cost > 0 ? fmtUsd(priciest.cost) : "Aucune dépense", icon: DollarSign, accent: cat[6] },
          { key: "agents", label: "Agents répartis", value: String(services.reduce((s, x) => s + (x.service ? x.agents : 0), 0)), sub: `${unassigned?.agents ?? 0} hors service`, icon: Bot, accent: cat[4] },
          { key: "pending", label: "Approbations en attente", value: String(services.reduce((s, x) => s + x.pendingApprovals, 0)), icon: ShieldCheck, accent: cat[3], tone: services.some((s) => s.pendingApprovals > 0) ? "text-amber-600 dark:text-amber-400" : undefined },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SectionCard className="lg:col-span-2" title="Charge par service" subtitle="Runs de la période, par issue"
          icon={<Building2 className="h-3.5 w-3.5" />}>
          {services.every((s) => s.runs === 0) ? <Empty label="Aucun run sur la période." /> : (
            <>
              <div className="space-y-2.5">
                {services.filter((s) => s.runs > 0).map((s) => (
                  <div key={s.key} className="flex items-center gap-3">
                    <span className="flex w-36 shrink-0 items-center gap-1.5 truncate text-xs text-muted-foreground" title={s.name}>
                      {s.service
                        ? <DashboardTile icon={s.service.icon} color={s.service.color} size={16} />
                        : <span className="h-4 w-4 shrink-0 rounded-md bg-muted" />}
                      <span className="truncate">{s.name}</span>
                    </span>
                    <span className="flex h-3 flex-1 overflow-hidden rounded-full" style={{ background: greys.empty }}>
                      {([
                        ["succeeded", s.succeeded, status.good],
                        ["failed", s.failed, status.critical],
                        ["ongoing", s.running, greys.context],
                      ] as const).map(([k, v, color]) => v > 0 && (
                        <span key={k} className="h-full ring-1 ring-card" style={{ width: `${(v / maxRuns) * 100}%`, background: color }} />
                      ))}
                    </span>
                    <span className="w-28 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                      {s.runs} runs · {s.successRate == null ? "—" : `${s.successRate}%`}
                    </span>
                  </div>
                ))}
              </div>
              <Legend items={[
                { color: status.good, label: "Réussis" },
                { color: status.critical, label: "Échoués" },
                { color: greys.context, label: "En cours" },
              ]} />
            </>
          )}
        </SectionCard>

        <SectionCard title="Coût par service" subtitle={`${fmtUsd(totalCost)} sur la période`} icon={<DollarSign className="h-3.5 w-3.5" />}>
          <Donut
            unit="USD"
            total={Math.round(totalCost * 100) / 100}
            slices={foldToSlots(
              services.filter((s) => s.cost > 0).map((s) => ({ label: s.name, count: Math.round(s.cost * 100) / 100 })),
            ).map((s) => ({ label: s.label, value: s.count }))}
          />
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {services.map((s) => (
          <ServiceCard key={s.key} stat={s} onOpen={s.service && onOpenService ? () => onOpenService(s.service!.id) : undefined} />
        ))}
      </div>

      <SectionCard title="Comparatif détaillé" subtitle="Tous les indicateurs, service par service" icon={<TrendingUp className="h-3.5 w-3.5" />}>
        <div className="scrollbar-slim -mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[820px] text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 pr-2">Service</th>
                <th className="px-2 py-2 text-right">Agents</th>
                <th className="px-2 py-2 text-right">Runs</th>
                <th className="px-2 py-2 text-right">Succès</th>
                <th className="px-2 py-2 text-right">Durée moy.</th>
                <th className="px-2 py-2 text-right">Coût</th>
                <th className="px-2 py-2 text-right">Tokens</th>
                <th className="px-2 py-2 text-right">Outils</th>
                <th className="px-2 py-2 text-right">Connaissance</th>
                <th className="px-2 py-2 text-right">Livrables</th>
                <th className="px-2 py-2 text-right">En attente</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {services.map((s) => (
                <tr key={s.key} className={cn("transition-colors hover:bg-muted/30", onOpenService && s.service && "cursor-pointer")}
                  onClick={s.service && onOpenService ? () => onOpenService(s.service!.id) : undefined}>
                  <td className="py-2 pr-2">
                    <span className="flex items-center gap-2">
                      {s.service ? <DashboardTile icon={s.service.icon} color={s.service.color} size={20} /> : <span className="h-5 w-5 rounded-md bg-muted" />}
                      <span className="max-w-[160px] truncate font-medium text-foreground">{s.name}</span>
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{s.activeAgents}/{s.agents}</td>
                  <td className="px-2 py-2 text-right font-medium tabular-nums">{s.runs}</td>
                  <td className="px-2 py-2 text-right"><RateBar value={s.successRate} /></td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmtDuration(s.avgDurationSec != null ? s.avgDurationSec * 1000 : null)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmtUsd(s.cost)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmtCompact.format(s.tokens)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{s.toolCalls}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{s.knowledgeSearches}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{s.deliverables}</td>
                  <td className="px-2 py-2 text-right">
                    {s.pendingApprovals > 0
                      ? <span className="font-medium tabular-nums text-amber-600 dark:text-amber-400">{s.pendingApprovals}</span>
                      : <span className="tabular-nums text-muted-foreground">0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function ServiceCard({ stat, onOpen }: { stat: ServiceStat; onOpen?: () => void }) {
  const { status } = useHqPalette();
  const s = stat;
  const rate = s.successRate;
  return (
    <div
      onClick={onOpen}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={onOpen ? (e) => { if (e.key === "Enter") onOpen(); } : undefined}
      className={cn(
        "group relative overflow-hidden rounded-2xl border border-border/70 bg-card p-4 shadow-sm transition-all",
        onOpen && "cursor-pointer hover:-translate-y-0.5 hover:border-border hover:shadow-md",
      )}
    >
      <div className="flex items-start gap-3">
        {s.service
          ? <DashboardTile icon={s.service.icon} color={s.service.color} size={38} />
          : <span className="flex h-[38px] w-[38px] items-center justify-center rounded-xl bg-muted text-muted-foreground"><Bot className="h-4 w-4" /></span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{s.name}</span>
            {s.pendingApprovals > 0 && <Pill tone="warn">{s.pendingApprovals} à valider</Pill>}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {s.agents} agent{s.agents > 1 ? "s" : ""} · {s.activeAgents} actif{s.activeAgents > 1 ? "s" : ""}
            {s.lastActivityAt && <> · vu il y a {timeAgo(s.lastActivityAt)}</>}
          </p>
        </div>
        {onOpen && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
        <Metric icon={Zap} label="Runs" value={String(s.runs)} />
        <Metric icon={TrendingUp} label="Succès" value={rate == null ? "—" : `${rate}%`} tone={rateTone(rate)} />
        <Metric icon={DollarSign} label="Coût" value={fmtUsd(s.cost)} />
        <Metric icon={Timer} label="Durée moy." value={fmtDuration(s.avgDurationSec != null ? s.avgDurationSec * 1000 : null)} />
        <Metric icon={Wrench} label="Appels d'outils" value={String(s.toolCalls)} sub={s.toolErrors > 0 ? `${s.toolErrors} erreurs` : undefined} />
        <Metric icon={BookOpen} label="Recherches" value={String(s.knowledgeSearches)} />
        <Metric icon={Package} label="Livrables" value={String(s.deliverables)} />
        <Metric icon={Bot} label="Top agent" value={s.topAgent?.name ?? "—"} sub={s.topAgent ? `${s.topAgent.runs} runs` : undefined} />
      </div>

      {rate != null && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full transition-all"
            style={{ width: `${rate}%`, background: rate >= 70 ? status.good : rate >= 40 ? status.warning : status.critical }} />
        </div>
      )}
    </div>
  );
}

function Metric({ icon: Icon, label, value, sub, tone }: {
  icon: typeof Bot; label: string; value: string; sub?: string; tone?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
      <span className="shrink-0 text-right">
        <span className={cn("block max-w-[92px] truncate font-medium tabular-nums text-foreground", tone)}>{value}</span>
        {sub && <span className="block text-[10px] text-muted-foreground">{sub}</span>}
      </span>
    </div>
  );
}
