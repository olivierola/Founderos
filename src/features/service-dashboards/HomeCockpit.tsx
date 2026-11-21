import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  TrayIcon, LightningIcon, WarningIcon, CheckCircleIcon, ArrowRightIcon, PushPinIcon,
  SquaresFourIcon, XCircleIcon, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { formatRelative } from "@/features/tracker/pickers";
import {
  applyParameters, fetchDashboards, type AgentDashboard, type DashboardWidget,
} from "@/features/agent-dashboards/api";
import { STATUS_META, WidgetBody } from "@/features/agent-dashboards/widgets";
import { InboxCard, KIND_ORDER, inboxKey, useCollaboratorInbox, type InboxItem } from "./CollaboratorInbox";
import { useLiteAgents, type LiteAgent } from "./live/teams";
import { ServiceOverview } from "./ServiceOverview";

/**
 * L'accueil du tableau de service : le cockpit.
 *
 * Il répond à « qu'est-ce qui m'attend, qu'est-ce qui se passe, est-ce que ça
 * marche » sans ouvrir une autre page : ce que les collaborateurs attendent
 * d'un humain, ceux qui travaillent en ce moment, les composants en alerte,
 * les dashboards épinglés et ce qui a changé depuis hier. Chaque ligne mène à
 * l'endroit où l'on agit.
 */

const DAY = 86_400_000;

interface RunRow {
  id: string; agent_id: string; status: string; mission_id: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; error_message: string | null;
}

interface AlertRow extends Pick<DashboardWidget, "id" | "dashboard_id" | "title" | "kind" | "alert_level" | "alert_since"> {}

function useServiceBase(dashboardId: string) {
  const { workspaceSlug, projectSlug } = useParams();
  return `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
}

export function HomeCockpit({ dashboardId, openKey, onOpenInbox, onOpenIssue }: {
  dashboardId: string;
  onOpenIssue?: (projectId: string, issueId: string) => void;
  /** The inbox item shown in the page's right panel, if any. */
  openKey?: string | null;
  /** Opens an inbox item in the right panel; without it, a card leads to « À valider ». */
  onOpenInbox?: (item: InboxItem) => void;
}) {
  const navigate = useNavigate();
  const base = useServiceBase(dashboardId);
  const go = (path: string) => navigate(`${base}/${path}`);

  const inboxRaw = useCollaboratorInbox(dashboardId).data;
  const inbox = useMemo(() => {
    const rank = (i: InboxItem) => KIND_ORDER.indexOf(i.kind);
    return [...(inboxRaw ?? [])].sort((a, b) => rank(a) - rank(b) || b.since.localeCompare(a.since));
  }, [inboxRaw]);
  const { data: agentsData } = useLiteAgents(dashboardId);
  const agents = useMemo(() => new Map((agentsData ?? []).map((a) => [a.id, a])), [agentsData]);
  const agentIds = (agentsData ?? []).map((a) => a.id);

  // Les runs des dernières 48 h : ceux en cours, et ce qui s'est terminé.
  const { data: runs } = useQuery({
    queryKey: ["sd_cockpit_runs", dashboardId, agentIds.join(",")],
    enabled: agentIds.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 2 * DAY).toISOString();
      const { data } = await supabase.from("internal_agent_runs")
        .select("id, agent_id, status, mission_id, created_at, started_at, finished_at, error_message")
        .in("agent_id", agentIds).is("parent_run_id", null).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(300);
      const rows = (data ?? []) as RunRow[];
      const mids = [...new Set(rows.map((r) => r.mission_id).filter(Boolean))] as string[];
      const titles = new Map<string, string>();
      if (mids.length) {
        const { data: ms } = await supabase.from("internal_agent_missions").select("id, title").in("id", mids);
        for (const m of (ms ?? []) as Array<{ id: string; title: string | null }>) titles.set(m.id, m.title ?? "");
      }
      return { rows, titles };
    },
  });

  const { data: dashboards } = useQuery({
    queryKey: ["agent_dashboards", dashboardId],
    queryFn: () => fetchDashboards(dashboardId),
  });
  const live = (dashboards ?? []).filter((d) => !d.is_template);
  const byDash = new Map(live.map((d) => [d.id, d]));
  const pinned = live.filter((d) => d.pinned);

  // Les composants en alerte (0302). Sans la colonne, pas d'alerte : rien ne casse.
  const { data: alerts } = useQuery({
    queryKey: ["sd_cockpit_alerts", dashboardId, live.map((d) => d.id).join(",")],
    enabled: live.length > 0,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("agent_dashboard_widgets")
        .select("id, dashboard_id, title, kind, alert_level, alert_since")
        .in("dashboard_id", live.map((d) => d.id)).in("alert_level", ["warn", "critical"]);
      if (error) return [] as AlertRow[];
      return ((data ?? []) as AlertRow[])
        .sort((a, b) => (a.alert_level === b.alert_level ? 0 : a.alert_level === "critical" ? -1 : 1));
    },
  });

  const { data: pinnedWidgets } = useQuery({
    queryKey: ["sd_cockpit_pinned", pinned.map((d) => `${d.id}:${d.last_filled_at}`).join(",")],
    enabled: pinned.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("agent_dashboard_widgets").select("*").in("dashboard_id", pinned.map((d) => d.id));
      return (data ?? []) as DashboardWidget[];
    },
  });

  const rows = runs?.rows ?? [];
  const running = rows.filter((r) => r.status === "running" || r.status === "queued");
  const doneDay = rows.filter((r) => r.status === "succeeded" && r.finished_at && Date.parse(r.finished_at) > Date.now() - DAY).length;

  // Ce qui a changé : les dashboards remplis et les runs terminés, mêlés par date.
  const changes = useMemo(() => {
    const since = Date.now() - 2 * DAY;
    const items: Array<{ key: string; at: string; icon: PhosphorIcon; tone: string; text: string; sub: string; onClick: () => void }> = [];
    for (const d of live) {
      if (!d.last_filled_at || Date.parse(d.last_filled_at) < since) continue;
      items.push({
        key: `d-${d.id}`, at: d.last_filled_at, icon: SquaresFourIcon, tone: "text-primary",
        text: applyParameters(d.name, d.parameters), sub: d.last_summary || "Dashboard mis à jour.",
        onClick: () => go(`dashboards/${d.id}`),
      });
    }
    for (const r of rows) {
      if (!r.finished_at || !["succeeded", "failed"].includes(r.status)) continue;
      const a = agents.get(r.agent_id);
      const title = (r.mission_id && runs?.titles.get(r.mission_id)) || "Conversation";
      items.push({
        key: `r-${r.id}`, at: r.finished_at,
        icon: r.status === "failed" ? XCircleIcon : CheckCircleIcon,
        tone: r.status === "failed" ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400",
        text: `${a?.name ?? "Un collaborateur"} · ${title}`,
        sub: r.status === "failed" ? (r.error_message?.slice(0, 140) || "Run en échec.") : "Terminé.",
        onClick: () => go(`agent/${r.agent_id}`),
      });
    }
    return items.sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.map((d) => d.last_filled_at).join(","), rows, agents]);

  return (
    <div className="space-y-6 pb-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatTile icon={TrayIcon} label="À valider" value={inbox.length} tone={inbox.length ? "amber" : undefined} onClick={() => go("projects/inbox")} />
        <StatTile icon={LightningIcon} label="En cours" value={running.length} onClick={() => go("agents")} />
        <StatTile icon={WarningIcon} label="Alertes" value={alerts?.length ?? 0} tone={alerts?.some((a) => a.alert_level === "critical") ? "red" : alerts?.length ? "amber" : undefined} onClick={() => go("dashboards")} />
        <StatTile icon={CheckCircleIcon} label="Terminés (24 h)" value={doneDay} onClick={() => go("projects/analytics")} />
      </div>

      <section>
        <SectionHead
          title="Vous attend"
          hint={inbox.length > 6 ? `6 sur ${inbox.length}` : undefined}
          action={inbox.length ? { label: "Tout voir", onClick: () => go("projects/inbox") } : undefined}
        />
        {inbox.length === 0 ? (
          <div className="rounded-md border border-border/70 bg-card"><Empty>Rien n'attend votre décision.</Empty></div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
            {inbox.slice(0, 6).map((it) => (
              <InboxCard
                key={inboxKey(it)}
                item={it}
                sbase={base}
                open={openKey === inboxKey(it)}
                onOpen={() => (onOpenInbox ? onOpenInbox(it) : go("projects/inbox"))}
              />
            ))}
          </ul>
        )}
      </section>

      <ServiceOverview dashboardId={dashboardId} onOpenIssue={onOpenIssue} />

      <div className="grid gap-x-2 gap-y-6 lg:grid-cols-2">
        <Block title="En ce moment" action={{ label: "L'équipe", onClick: () => go("agents") }}>
          {running.length === 0 ? <Empty>Aucun collaborateur ne travaille en ce moment.</Empty> : (
            <ul className="divide-y divide-border/60">
              {running.slice(0, 5).map((r) => {
                const a = agents.get(r.agent_id);
                return (
                  <Row
                    key={r.id}
                    onClick={() => go(`agent/${r.agent_id}`)}
                    lead={<AgentAvatar agent={a} />}
                    title={(r.mission_id && runs?.titles.get(r.mission_id)) || "Conversation"}
                    sub={`${a?.name ?? "Collaborateur"} · ${r.status === "queued" ? "en file" : "en cours"}`}
                    aside={formatRelative(r.started_at ?? r.created_at)}
                  />
                );
              })}
            </ul>
          )}
        </Block>

        <Block title="Ce qui a changé" hint="48 dernières heures">
          {changes.length === 0 ? <Empty>Rien de nouveau depuis deux jours.</Empty> : (
            <ul className="divide-y divide-border/60">
              {changes.map((c) => (
                <Row
                  key={c.key} onClick={c.onClick}
                  lead={<c.icon weight="fill" className={cn("ml-1 h-4 w-4", c.tone)} />}
                  title={c.text} sub={c.sub} aside={formatRelative(c.at)}
                />
              ))}
            </ul>
          )}
        </Block>
      </div>

      {(alerts?.length ?? 0) > 0 && (
        <Block title="Composants en alerte" action={{ label: "Dashboards", onClick: () => go("dashboards") }}>
          <ul className="divide-y divide-border/60">
            {alerts!.slice(0, 6).map((w) => {
              const d = byDash.get(w.dashboard_id);
              const meta = STATUS_META[w.alert_level === "critical" ? "critical" : "warn"];
              return (
                <Row
                  key={w.id}
                  onClick={() => go(`dashboards/${w.dashboard_id}`)}
                  lead={<span className={cn("ml-1.5 h-2.5 w-2.5 rounded-full", meta.dot)} />}
                  title={w.title}
                  sub={d ? applyParameters(d.name, d.parameters) : ""}
                  aside={<span className={cn("font-medium", meta.text)}>{meta.label}{w.alert_since ? ` · ${formatRelative(w.alert_since)}` : ""}</span>}
                />
              );
            })}
          </ul>
        </Block>
      )}

      <section>
        <SectionHead title="Mes dashboards" action={{ label: "Tous les dashboards", onClick: () => go("dashboards") }} />
        {pinned.length === 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-4 py-4 text-[13px] text-muted-foreground">
            <PushPinIcon className="h-4 w-4 shrink-0" />
            Épinglez un dashboard depuis son menu pour le suivre ici.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2">
            {pinned.map((d) => (
              <PinnedCard
                key={d.id} d={d}
                widgets={(pinnedWidgets ?? []).filter((w) => w.dashboard_id === d.id)}
                onOpen={() => go(`dashboards/${d.id}`)}
              />
            ))}
          </div>
        )}
      </section>

    </div>
  );
}

function StatTile({ icon: Icon, label, value, tone, onClick }: {
  icon: PhosphorIcon; label: string; value: number; tone?: "amber" | "red"; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col gap-2 rounded-md border border-border/70 bg-card px-3.5 py-3 text-left transition-colors hover:border-foreground/20"
    >
      <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </span>
      <span className={cn(
        "text-[26px] font-semibold leading-none tabular-nums tracking-tight",
        tone === "amber" && value > 0 && "text-amber-600 dark:text-amber-400",
        tone === "red" && value > 0 && "text-red-600 dark:text-red-400",
      )}>{value}</span>
    </button>
  );
}

function SectionHead({ title, hint, action }: { title: string; hint?: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
      <div className="flex-1" />
      {action && (
        <button onClick={action.onClick} className="flex items-center gap-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
          {action.label} <ArrowRightIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function Block({ title, hint, action, children }: {
  title: string; hint?: string; action?: { label: string; onClick: () => void }; children: React.ReactNode;
}) {
  return (
    <section>
      <SectionHead title={title} hint={hint} action={action} />
      <div className="rounded-md border border-border/70 bg-card px-1 py-1">{children}</div>
    </section>
  );
}

function Row({ lead, title, sub, aside, onClick }: {
  lead: React.ReactNode; title: string; sub?: string; aside?: React.ReactNode; onClick: () => void;
}) {
  return (
    <li>
      <button onClick={onClick} className="flex w-full items-center gap-3 rounded px-2.5 py-2 text-left transition-colors hover:bg-accent/40">
        <span className="flex w-6 shrink-0 items-center">{lead}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium">{title}</span>
          {sub && <span className="block truncate text-[12px] text-muted-foreground">{sub}</span>}
        </span>
        {aside && <span className="shrink-0 text-[12px] text-muted-foreground">{aside}</span>}
      </button>
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-5 text-center text-[13px] text-muted-foreground">{children}</p>;
}

function AgentAvatar({ agent }: { agent?: LiteAgent }) {
  return <AgentIdentity url={agent?.avatar_url ?? null} seed={agent?.name ?? "?"} size={22} rounded="rounded-md" interactive={false} />;
}

/** Un dashboard épinglé : ses trois premiers indicateurs, et sa dernière synthèse. */
function PinnedCard({ d, widgets, onOpen }: { d: AgentDashboard; widgets: DashboardWidget[]; onOpen: () => void }) {
  const tiles = widgets
    .filter((w) => (w.kind === "kpi" || w.kind === "gauge"))
    .sort((a, b) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0) || (a.layout?.x ?? 0) - (b.layout?.x ?? 0))
    .slice(0, 3);
  return (
    <button onClick={onOpen} className="flex flex-col gap-3 rounded-md border border-border/70 bg-card p-3.5 text-left transition-colors hover:border-foreground/20">
      <div className="flex items-center gap-2">
        <PushPinIcon weight="fill" className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{applyParameters(d.name, d.parameters)}</span>
        {d.last_filled_at && <span className="shrink-0 text-[12px] text-muted-foreground">{formatRelative(d.last_filled_at)}</span>}
      </div>
      {tiles.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {tiles.map((w) => (
            <div key={w.id} className="min-w-0 rounded bg-muted/40 px-2.5 py-2">
              <div className="truncate text-[11.5px] text-muted-foreground">{w.title}</div>
              <div className="pointer-events-none h-[64px] overflow-hidden">
                {w.data != null
                  ? <WidgetBody kind={w.kind} data={w.data} config={w.config ?? {}} />
                  : <span className="text-[12px] text-muted-foreground">Pas de donnée</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="line-clamp-2 text-[12.5px] text-muted-foreground">{d.last_summary || "Pas encore rempli."}</p>
    </button>
  );
}
