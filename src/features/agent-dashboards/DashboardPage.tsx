import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import {
  ArrowLeftIcon, ArrowsClockwiseIcon, CheckIcon, ClockCounterClockwiseIcon, CopyIcon, CornersOutIcon, DotsSixVerticalIcon,
  DotsThreeIcon, GearSixIcon, InfoIcon, PencilSimpleIcon, PlusIcon, SparkleIcon, TableIcon, TrashIcon, XIcon,
  CircleNotchIcon as Loader2, ChartLineIcon, ChartBarIcon, ChartDonutIcon, GaugeIcon, HashIcon,
  WarningIcon, TextAlignLeftIcon, ChartLineUpIcon, BookmarkSimpleIcon, PushPinIcon, PushPinSlashIcon,
  ChatCircleDotsIcon, PlugsConnectedIcon, PaperPlaneRightIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import { PAGE_PAD, PAGE_TITLE } from "@/components/PageHeader";
import { formatRelative } from "@/features/tracker/pickers";
import { useLiteAgents, type LiteAgent } from "@/features/service-dashboards/live/teams";
import { agentAskHref } from "@/features/service-dashboards/agentView";
import {
  addWidget, applyParameters, createDashboard, deleteDashboard, deleteWidget, fetchActiveFill, fetchDashboard, fetchSnapshots,
  refreshDashboard, REFRESH_LABEL, saveLayouts, statusOf, syncMission, updateDashboard, updateWidget, WIDGET_KINDS, WIDGET_META,
  type AgentDashboard, type DashboardParameter, type DashboardWidget, type Refresh, type Status, type WidgetConfig, type WidgetKind,
} from "./api";
import { DataTable, STATUS_META, WidgetBody } from "./widgets";

const ResponsiveGrid = WidthProvider(Responsive);
const COLS = 12;
const ROW_H = 68;

export const KIND_ICON: Record<WidgetKind, PhosphorIcon> = {
  kpi: HashIcon, gauge: GaugeIcon, line: ChartLineIcon, area: ChartLineUpIcon, bar: ChartBarIcon,
  donut: ChartDonutIcon, table: TableIcon, alerts: WarningIcon, text: TextAlignLeftIcon,
};

/**
 * Un dashboard d'agent : sa lecture, et son édition.
 *
 * En lecture, les composants se remplissent en direct pendant que le
 * collaborateur travaille ; chacun dit d'où vient sa valeur et quand. On
 * remonte l'historique des remplissages. En édition, on place les composants
 * sur la grille et on écrit, pour chacun, les instructions que l'agent suit.
 */
export function DashboardPage({ serviceId, dashboardId, sbase }: { serviceId: string; dashboardId: string; sbase: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const { data: agents } = useLiteAgents(serviceId);
  const key = ["agent_dashboard", dashboardId];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => fetchDashboard(dashboardId) });
  const { data: active } = useQuery({
    queryKey: ["agent_dashboard_fill", dashboardId],
    queryFn: () => fetchActiveFill(dashboardId),
    refetchInterval: (q) => (q.state.data ? 4_000 : 20_000),
  });
  const { data: snapshots } = useQuery({
    queryKey: ["agent_dashboard_snapshots", dashboardId],
    queryFn: () => fetchSnapshots(dashboardId),
    refetchInterval: active ? 6_000 : false,
  });
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState<DashboardWidget | null>(null);
  const [starting, setStarting] = useState(false);

  // Le direct : chaque composant déposé par l'agent apparaît aussitôt.
  useEffect(() => {
    const ch = supabase.channel(`agent-dashboard-${dashboardId}-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_dashboard_widgets", filter: `dashboard_id=eq.${dashboardId}` },
        () => { void qc.invalidateQueries({ queryKey: key }); })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId]);
  // Filet du direct : pendant un remplissage, on relit aussi.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { void qc.invalidateQueries({ queryKey: key }); }, 5_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const dashboard = data?.dashboard;
  const widgets = data?.widgets ?? [];
  const agent = (agents ?? []).find((a) => a.id === dashboard?.agent_id) ?? null;
  const snapshot = snapshotId ? (snapshots ?? []).find((s) => s.id === snapshotId) ?? null : null;
  const params = dashboard?.parameters ?? [];
  const sel = widgets.find((w) => w.id === selected) ?? null;

  const layout: Layout[] = useMemo(() => widgets.map((w) => ({
    i: w.id, x: w.layout?.x ?? 0, y: w.layout?.y ?? 0, w: w.layout?.w ?? 4, h: w.layout?.h ?? 2, minW: 2, minH: 2,
  })), [widgets]);

  if (isLoading) return <div className="flex h-60 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!dashboard) return <div className="p-10 text-center text-[13px] text-muted-foreground">Dashboard introuvable.</div>;

  const refresh = async () => {
    setStarting(true);
    try {
      await refreshDashboard(dashboard, user?.id ?? null);
      setSnapshotId(null);
      toast.success("Remplissage lancé", agent ? `${agent.name} collecte les données.` : undefined);
      await qc.invalidateQueries({ queryKey: ["agent_dashboard_fill", dashboardId] });
    } catch (e) {
      toast.error("Remplissage impossible", e instanceof Error ? e.message : String(e));
    } finally { setStarting(false); }
  };

  const add = async (kind: WidgetKind) => {
    try {
      const w = await addWidget(dashboard, kind, widgets.map((x) => x.layout));
      await qc.invalidateQueries({ queryKey: key });
      setSelected(w.id);
    } catch (e) { toast.error("Ajout impossible", e instanceof Error ? e.message : String(e)); }
  };

  const onLayout = (l: Layout[]) => {
    if (!editing) return;
    const changed = l.filter((it) => {
      const w = widgets.find((x) => x.id === it.i);
      return w && (w.layout?.x !== it.x || w.layout?.y !== it.y || w.layout?.w !== it.w || w.layout?.h !== it.h);
    });
    if (!changed.length) return;
    qc.setQueryData(key, { dashboard, widgets: widgets.map((w) => {
      const it = l.find((x) => x.i === w.id);
      return it ? { ...w, layout: { x: it.x, y: it.y, w: it.w, h: it.h } } : w;
    }) });
    void saveLayouts(changed.map((it) => ({ id: it.i, layout: { x: it.x, y: it.y, w: it.w, h: it.h } })));
  };

  const saveAsTemplate = async () => {
    try {
      const id = await createDashboard(
        { workspaceId: dashboard.workspace_id, projectId: dashboard.project_id, serviceId, userId: user?.id ?? null },
        { name: `${dashboard.name} (modèle)`, fromDashboardId: dashboard.id, parameters: params.map((p) => ({ ...p, value: "" })), isTemplate: true },
      );
      await updateDashboard(id, { description: dashboard.description, usage_context: dashboard.usage_context });
      toast.success("Modèle enregistré", "Il apparaît dans les modèles de la page Dashboards.");
    } catch (e) { toast.error("Enregistrement impossible", e instanceof Error ? e.message : String(e)); }
  };

  const duplicate = async () => {
    try {
      const id = await createDashboard(
        { workspaceId: dashboard.workspace_id, projectId: dashboard.project_id, serviceId, userId: user?.id ?? null },
        { name: `${dashboard.name} (copie)`, fromDashboardId: dashboard.id, agentId: dashboard.agent_id, parameters: params },
      );
      await updateDashboard(id, { description: dashboard.description, usage_context: dashboard.usage_context });
      navigate(`${sbase}/dashboards/${id}`);
    } catch (e) { toast.error("Duplication impossible", e instanceof Error ? e.message : String(e)); }
  };

  const togglePin = async () => {
    try {
      await updateDashboard(dashboard.id, { pinned: !dashboard.pinned });
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ["agent_dashboards", serviceId] });
      toast.success(dashboard.pinned ? "Retiré de l'accueil" : "Épinglé à l'accueil");
    } catch (e) { toast.error("Épingle impossible", e instanceof Error ? e.message : String(e)); }
  };

  const remove = async () => {
    if (!(await confirm({ title: `Supprimer « ${dashboard.name} » ?`, description: "Ses composants et son historique seront supprimés.", confirmText: "Supprimer", destructive: true }))) return;
    await deleteDashboard(dashboard.id);
    await qc.invalidateQueries({ queryKey: ["agent_dashboards", serviceId] });
    navigate(`${sbase}/dashboards`);
  };

  return (
    <div className="min-h-full">
      <div className={cn(PAGE_PAD, "pb-12")}>
        {/* ── En-tête ── */}
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => navigate(`${sbase}/dashboards`)} className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Tous les dashboards">
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <h1 className={cn(PAGE_TITLE, "truncate")}>
              {applyParameters(dashboard.name, params)}
              {dashboard.is_template && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 align-middle text-[11px] font-medium text-muted-foreground">Modèle</span>}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
              {agent ? (
                <button
                  onClick={() => navigate(`${sbase}/agent/${agent.id}`)}
                  title={`Le tableau de bord de ${agent.name}`}
                  className="inline-flex items-center gap-1.5 rounded-md hover:text-foreground hover:underline"
                >
                  <AgentIdentity url={agent.avatar_url} seed={agent.name} size={16} rounded="rounded-md" interactive={false} />
                  {agent.name}
                </button>
              ) : !dashboard.is_template && <span className="text-amber-700 dark:text-amber-400">Aucun collaborateur ne le remplit</span>}
              <span>{REFRESH_LABEL[dashboard.refresh]}</span>
              <span>{dashboard.last_filled_at ? `Rempli ${formatRelative(dashboard.last_filled_at)}` : "Jamais rempli"}</span>
              {params.filter((p) => p.value).map((p) => (
                <span key={p.key} className="rounded-md bg-muted px-1.5 py-0.5 text-foreground/80">{p.label || p.key} : {p.value}</span>
              ))}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {!editing && (snapshots ?? []).length > 0 && (
              <Select value={snapshotId ?? "now"} onValueChange={(v) => setSnapshotId(v === "now" ? null : v)}>
                <SelectTrigger className="h-9 w-[200px] rounded-md text-[13px]">
                  <ClockCounterClockwiseIcon className="mr-1.5 h-4 w-4 text-muted-foreground" /><SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="now">Valeurs actuelles</SelectItem>
                  {(snapshots ?? []).filter((s) => s.status === "done").map((s) => (
                    <SelectItem key={s.id} value={s.id}>{new Date(s.finished_at ?? s.started_at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {!dashboard.is_template && (
              <Button onClick={refresh} disabled={starting || !!active} className="rounded-md">
                {active || starting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ArrowsClockwiseIcon className="mr-1.5 h-4 w-4" />}
                {active ? "Remplissage en cours" : "Actualiser"}
              </Button>
            )}
            <Button variant={editing ? "default" : "outline"} className="rounded-md" onClick={() => { setEditing((v) => !v); setSelected(null); setSnapshotId(null); }}>
              {editing ? <><CheckIcon className="mr-1.5 h-4 w-4" /> Terminer</> : <><PencilSimpleIcon className="mr-1.5 h-4 w-4" /> Modifier</>}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-muted hover:text-foreground"><DotsThreeIcon className="h-4 w-4" /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 rounded-xl">
                {!dashboard.is_template && (
                  <DropdownMenuItem onSelect={() => void togglePin()}>
                    {dashboard.pinned
                      ? <><PushPinSlashIcon className="mr-2 h-4 w-4" /> Retirer de l'accueil</>
                      : <><PushPinIcon className="mr-2 h-4 w-4" /> Épingler à l'accueil</>}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setSettings(true)}><GearSixIcon className="mr-2 h-4 w-4" /> Réglages</DropdownMenuItem>
                {!dashboard.is_template && <DropdownMenuItem onSelect={() => void saveAsTemplate()}><BookmarkSimpleIcon className="mr-2 h-4 w-4" /> Enregistrer comme modèle</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => void duplicate()}><CopyIcon className="mr-2 h-4 w-4" /> Dupliquer</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void remove()} className="text-red-600"><TrashIcon className="mr-2 h-4 w-4" /> Supprimer</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* ── La lecture de l'agent ── */}
        {!editing && (snapshot?.summary ?? dashboard.last_summary) && (
          <div className="mt-5 flex gap-3 rounded-2xl border border-border bg-card p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><SparkleIcon weight="fill" className="h-4 w-4" /></span>
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-muted-foreground">
                Lecture {agent ? `de ${agent.name}` : "de l'agent"}
                {snapshot ? ` · ${new Date(snapshot.finished_at ?? snapshot.started_at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : dashboard.last_filled_at ? ` · ${formatRelative(dashboard.last_filled_at)}` : ""}
              </div>
              <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed">{snapshot?.summary ?? dashboard.last_summary}</p>
            </div>
          </div>
        )}

        {/* ── Contexte d'utilisation, en édition ── */}
        {editing && (
          <div className="mt-5 flex flex-wrap items-center gap-2 rounded-2xl border border-dashed border-border p-3">
            <span className="mr-1 text-[12px] font-medium text-muted-foreground">Ajouter</span>
            {WIDGET_KINDS.map((k) => {
              const Icon = KIND_ICON[k];
              return (
                <button key={k} onClick={() => void add(k)} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] hover:bg-muted">
                  <Icon className="h-3.5 w-3.5" /> {WIDGET_META[k].label}
                </button>
              );
            })}
            <button onClick={() => setSettings(true)} className="ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground">
              <GearSixIcon className="h-3.5 w-3.5" /> Contexte et réglages
            </button>
          </div>
        )}

        <div className={cn("mt-4 grid gap-5", editing && sel && "xl:grid-cols-[minmax(0,1fr)_380px]")}>
          <div className="min-w-0">
            {!widgets.length ? (
              <div className="rounded-2xl border border-dashed border-border p-12 text-center">
                <p className="text-[14px] font-medium">Ce dashboard est vide</p>
                <p className="mt-1 text-[13px] text-muted-foreground">Ajoutez des composants, puis dites à l'agent comment remplir chacun.</p>
                {!editing && <Button className="mt-4 rounded-md" onClick={() => setEditing(true)}><PencilSimpleIcon className="mr-1.5 h-4 w-4" /> Modifier</Button>}
              </div>
            ) : (
              <ResponsiveGrid
                className="-mx-2"
                layouts={{ lg: layout, md: layout, sm: layout, xs: layout, xxs: layout }}
                breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
                cols={{ lg: COLS, md: COLS, sm: 6, xs: 2, xxs: 1 }}
                rowHeight={ROW_H}
                margin={[16, 16]}
                isDraggable={editing}
                isResizable={editing}
                draggableHandle=".drag-handle"
                onLayoutChange={(l) => onLayout(l)}
                compactType="vertical"
              >
                {widgets.map((w) => (
                  <div key={w.id}>
                    <WidgetCard
                      widget={w} params={params} editing={editing} selected={selected === w.id}
                      snapshot={snapshot ? snapshot.data[w.id] ?? null : undefined}
                      filling={!!active}
                      onSelect={() => setSelected(w.id)}
                      onFullscreen={() => setFullscreen(w)}
                      agent={dashboard.is_template ? null : agent}
                      dashboardName={applyParameters(dashboard.name, params)}
                      sbase={sbase}
                      onChooseAgent={() => setSettings(true)}
                    />
                  </div>
                ))}
              </ResponsiveGrid>
            )}
          </div>
          {editing && sel && (
            <Inspector key={sel.id} widget={sel} params={params} onClose={() => setSelected(null)}
              onSaved={() => void qc.invalidateQueries({ queryKey: key })}
              onDelete={async () => { await deleteWidget(sel.id); setSelected(null); await qc.invalidateQueries({ queryKey: key }); }} />
          )}
        </div>
      </div>

      <SettingsDialog open={settings} onClose={() => setSettings(false)} dashboard={dashboard} agents={agents ?? []}
        onSaved={async (next) => {
          await qc.invalidateQueries({ queryKey: key });
          await qc.invalidateQueries({ queryKey: ["agent_dashboards", serviceId] });
          try { await syncMission(next, user?.id ?? null); } catch (e) { toast.error("Cadence non enregistrée", e instanceof Error ? e.message : String(e)); }
        }} />

      <Dialog open={!!fullscreen} onOpenChange={(o) => !o && setFullscreen(null)}>
        <DialogContent className="max-w-6xl overflow-x-hidden scrollbar-hide">
          {fullscreen && (
            <>
              <DialogHeader><DialogTitle>{applyParameters(fullscreen.title, params)}</DialogTitle></DialogHeader>
              <div className="h-[60vh] min-w-0">
                {(snapshot ? snapshot.data[fullscreen.id]?.data : fullscreen.data) != null
                  ? <WidgetBody kind={fullscreen.kind} data={snapshot ? snapshot.data[fullscreen.id]?.data : fullscreen.data} config={fullscreen.config ?? {}} />
                  : <p className="text-[13px] text-muted-foreground">Pas encore de données.</p>}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Un composant ─────────────────────────────────────────────────────────────

function WidgetCard({ widget: w, params, editing, selected, snapshot, filling, onSelect, onFullscreen, agent, dashboardName, sbase, onChooseAgent }: {
  widget: DashboardWidget; params: DashboardParameter[]; editing: boolean; selected: boolean;
  agent: LiteAgent | null; dashboardName: string; sbase: string; onChooseAgent: () => void;
  /** undefined : valeurs actuelles ; null : rien dans cet instantané. */
  snapshot: { data: unknown; note: string | null; status: string } | null | undefined;
  filling: boolean;
  onSelect: () => void; onFullscreen: () => void;
}) {
  const [showData, setShowData] = useState(false);
  const data = snapshot === undefined ? w.data : snapshot?.data ?? null;
  const note = snapshot === undefined ? w.note : snapshot?.note ?? null;
  const fillStatus = snapshot === undefined ? w.fill_status : (snapshot?.status as DashboardWidget["fill_status"]) ?? null;
  const Icon = KIND_ICON[w.kind];
  const value = data && (w.kind === "kpi" || w.kind === "gauge") ? (data as { value?: unknown; status?: Status }) : null;
  const st = value ? statusOf(typeof value.value === "number" ? value.value : null, w.config, value.status) : undefined;
  const chart = w.kind === "line" || w.kind === "area" || w.kind === "bar" || w.kind === "donut";
  // L'état d'alerte enregistré au remplissage (0302) vaut pour les valeurs
  // actuelles ; un instantané garde l'état recalculé de ses propres valeurs.
  const stored = snapshot === undefined && w.alert_level && w.alert_level !== "ok" ? w.alert_level : undefined;
  const level = stored ?? (st && st !== "ok" ? st : undefined);
  const title = applyParameters(w.title, params) || WIDGET_META[w.kind].label;

  return (
    <section
      onClick={editing ? onSelect : undefined}
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-2xl border bg-card",
        selected ? "border-primary ring-2 ring-primary/20" : "border-border",
        editing && "cursor-pointer",
        level === "critical" && !editing && "border-red-500/40",
        level === "warn" && !editing && "border-amber-500/40",
      )}
    >
      <header className="flex shrink-0 items-center gap-2 px-4 pt-3.5">
        {editing && <DotsSixVerticalIcon className="drag-handle h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />}
        {editing && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted-foreground">{title}</h3>
        {level && !editing && (
          <span
            className={cn("inline-flex shrink-0 items-center gap-1 text-[11px] font-medium", STATUS_META[level].text)}
            title={w.alert_since && stored ? `Depuis ${formatRelative(w.alert_since)}` : undefined}
          >
            <span className={cn("h-2 w-2 rounded-full", STATUS_META[level].dot)} />{STATUS_META[level].label}
          </span>
        )}
        {!editing && (
          <div className="flex shrink-0 items-center gap-0.5">
            {chart && data != null && (
              <IconBtn title={showData ? "Graphique" : "Données"} onClick={() => setShowData((v) => !v)} active={showData}>
                <TableIcon className="h-3.5 w-3.5" />
              </IconBtn>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <button title="Instructions et source" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><InfoIcon className="h-3.5 w-3.5" /></button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 rounded-xl text-[12px]">
                <div className="font-medium">Instructions à l'agent</div>
                <p className="mt-1 whitespace-pre-line text-muted-foreground">{applyParameters(w.instructions, params) || "Aucune."}</p>
                {w.sources?.length > 0 && <p className="mt-2 text-muted-foreground"><span className="font-medium text-foreground">Sources : </span>{w.sources.join(", ")}</p>}
                {note && <><div className="mt-3 font-medium">Note de l'agent</div><p className="mt-1 text-muted-foreground">{note}</p></>}
                {w.filled_at && <p className="mt-3 text-[11px] text-muted-foreground">Rempli {formatRelative(w.filled_at)}</p>}
              </PopoverContent>
            </Popover>
            {agent && <AskAgent agent={agent} widgetTitle={title} dashboardName={dashboardName} data={data} sbase={sbase} />}
            <IconBtn title="Plein écran" onClick={onFullscreen}><CornersOutIcon className="h-3.5 w-3.5" /></IconBtn>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 px-4 pb-3 pt-2.5">
        {fillStatus === "no_data" && !editing && (
          <NoDataDiagnosis note={note} sources={w.sources ?? []} agent={agent} sbase={sbase} onChooseAgent={onChooseAgent} />
        )}
        {data == null ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            {filling && !snapshot ? (
              <><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /><span className="mt-2 text-[12px] text-muted-foreground">L'agent remplit ce composant</span></>
            ) : (
              <>
                <Icon className="h-5 w-5 text-muted-foreground/50" />
                <span className="mt-2 text-[12px] text-muted-foreground">{editing ? (w.instructions ? applyParameters(w.instructions, params).slice(0, 120) : "Cliquez pour écrire les instructions") : "En attente du premier remplissage"}</span>
              </>
            )}
          </div>
        ) : showData ? (
          <DataTable kind={w.kind} data={data} />
        ) : (
          <div className={cn("h-full", fillStatus === "no_data" && "opacity-50")}>
            <WidgetBody kind={w.kind} data={data} config={w.config ?? {}} />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * « Pas de donnée », et pourquoi. L'agent dit ce qui lui a manqué (sa note) ;
 * on montre en face ce que le composant attend (ses sources) et les deux
 * gestes qui réparent : vérifier les connexions du collaborateur, ou lui en
 * confier un s'il n'y en a pas.
 */
function NoDataDiagnosis({ note, sources, agent, sbase, onChooseAgent }: {
  note: string | null; sources: string[]; agent: LiteAgent | null; sbase: string; onChooseAgent: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="mb-2 rounded-lg bg-muted px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate" title={note ?? undefined}>Pas de donnée{note ? ` : ${note}` : ""}</span>
        <Popover>
          <PopoverTrigger asChild>
            <button className="shrink-0 font-medium text-foreground/80 underline-offset-2 hover:underline">Pourquoi ?</button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 rounded-xl text-[12px]">
            <div className="font-medium">Ce qui a manqué</div>
            <p className="mt-1 text-muted-foreground">{note || "L'agent n'a pas laissé d'explication."}</p>
            {sources.length > 0 && (
              <>
                <div className="mt-3 font-medium">Ce que le composant attend</div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {sources.map((src) => <span key={src} className="rounded-md bg-muted px-1.5 py-0.5 text-foreground/80">{src}</span>)}
                </div>
              </>
            )}
            <div className="mt-3 flex flex-col gap-1.5">
              {agent ? (
                <Button size="sm" variant="outline" className="h-8 justify-start rounded-lg text-[12px]"
                  onClick={() => navigate(`${sbase}/agent-config/${agent.id}?t=connectors`)}>
                  <PlugsConnectedIcon className="mr-1.5 h-3.5 w-3.5" /> Vérifier les connexions de {agent.name}
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-8 justify-start rounded-lg text-[12px]" onClick={onChooseAgent}>
                  <GearSixIcon className="mr-1.5 h-3.5 w-3.5" /> Confier le dashboard à un collaborateur
                </Button>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

/** Poser une question au collaborateur sur un composant : elle part dans son chat, avec le contexte. */
function AskAgent({ agent, widgetTitle, dashboardName, data, sbase }: {
  agent: LiteAgent; widgetTitle: string; dashboardName: string; data: unknown; sbase: string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const send = () => {
    const text = q.trim();
    if (!text) return;
    const value = data == null ? "" : JSON.stringify(data);
    const context = `À propos du composant « ${widgetTitle} » du dashboard « ${dashboardName} »${value && value.length <= 600 ? ` (valeur affichée : ${value})` : ""} :`;
    setOpen(false);
    navigate(agentAskHref(sbase, agent.id, `${context}\n\n${text}`));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button title={`Demander à ${agent.name}`} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ChatCircleDotsIcon className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-xl p-3">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium">
          <AgentIdentity url={agent.avatar_url} seed={agent.name} size={18} rounded="rounded-md" interactive={false} />
          Demander à {agent.name}
        </div>
        <Textarea
          autoFocus rows={3} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={`Pourquoi « ${widgetTitle} » a bougé ?`}
          className="resize-none text-[13px]"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">Le composant est joint à la question.</span>
          <Button size="sm" className="h-8 rounded-md" disabled={!q.trim()} onClick={send}>
            <PaperPlaneRightIcon className="mr-1.5 h-3.5 w-3.5" /> Envoyer
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function IconBtn({ title, onClick, active, children }: { title: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick} className={cn("rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground", active && "bg-muted text-foreground")}>
      {children}
    </button>
  );
}

// ── L'inspecteur d'un composant ──────────────────────────────────────────────

function Inspector({ widget, params, onClose, onSaved, onDelete }: {
  widget: DashboardWidget; params: DashboardParameter[]; onClose: () => void; onSaved: () => void; onDelete: () => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<WidgetKind>(widget.kind);
  const [title, setTitle] = useState(widget.title);
  const [instructions, setInstructions] = useState(widget.instructions);
  const [sources, setSources] = useState((widget.sources ?? []).join(", "));
  const [config, setConfig] = useState<WidgetConfig>(widget.config ?? {});
  const [saving, setSaving] = useState(false);
  const dirty = kind !== widget.kind || title !== widget.title || instructions !== widget.instructions
    || sources !== (widget.sources ?? []).join(", ") || JSON.stringify(config) !== JSON.stringify(widget.config ?? {});
  const t = config.thresholds ?? {};
  const setT = (patch: Partial<NonNullable<WidgetConfig["thresholds"]>>) => setConfig((c) => ({ ...c, thresholds: { ...(c.thresholds ?? {}), ...patch } }));
  const numOrNull = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v.replace(",", "."))) ? null : Number(v.replace(",", ".")));

  const save = async () => {
    setSaving(true);
    try {
      await updateWidget(widget.id, {
        ...(kind !== widget.kind ? { kind } : {}),
        title: title.trim(), instructions: instructions.trim(),
        sources: sources.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8), config,
      });
      onSaved();
    } catch (e) { toast.error("Enregistrement impossible", e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  return (
    <aside className="h-fit space-y-4 rounded-2xl border border-border bg-card p-5 xl:sticky xl:top-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Composant</h2>
        <button onClick={onClose} className="rounded-full p-1 text-muted-foreground hover:bg-muted"><XIcon className="h-4 w-4" /></button>
      </div>
      <Field label="Type">
        <Select value={kind} onValueChange={(v) => setKind(v as WidgetKind)}>
          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
          <SelectContent>{WIDGET_KINDS.map((k) => <SelectItem key={k} value={k}>{WIDGET_META[k].label}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field label="Titre"><Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-9" /></Field>
      <Field label="Instructions à l'agent" hint="Quoi afficher, avec quelle source, quel calcul, sur quelle période.">
        <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={6} className="text-[13px]"
          placeholder="Ex. : utilisation CPU moyenne du cluster sur 5 min, en %, depuis Prometheus. trend : 24 dernières heures." />
        {params.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {params.map((p) => (
              <button key={p.key} type="button" onClick={() => setInstructions((s) => `${s}{{${p.key}}}`)}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground">{`{{${p.key}}}`}</button>
            ))}
          </div>
        )}
      </Field>
      <Field label="Sources suggérées" hint="Outils, connecteurs ou serveurs MCP, séparés par des virgules.">
        <Input value={sources} onChange={(e) => setSources(e.target.value)} className="h-9" placeholder="prometheus, grafana" />
      </Field>
      {kind !== "text" && kind !== "alerts" && kind !== "table" && kind !== "donut" && (
        <Field label="Unité"><Input value={config.unit ?? ""} onChange={(e) => setConfig((c) => ({ ...c, unit: e.target.value || undefined }))} className="h-9" placeholder="%" /></Field>
      )}
      {(kind === "kpi" || kind === "gauge") && (
        <Field label="Seuils" hint="L'état passe à « Attention » puis « Critique ».">
          <div className="grid grid-cols-[1fr_1fr] gap-2">
            <Input value={t.warn ?? ""} onChange={(e) => setT({ warn: numOrNull(e.target.value) })} className="h-9" placeholder="Attention" />
            <Input value={t.critical ?? ""} onChange={(e) => setT({ critical: numOrNull(e.target.value) })} className="h-9" placeholder="Critique" />
          </div>
          <Select value={t.direction ?? "above"} onValueChange={(v) => setT({ direction: v as "above" | "below" })}>
            <SelectTrigger className="mt-2 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="above">Alerter au-dessus</SelectItem>
              <SelectItem value="below">Alerter en dessous</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}
      {kind === "gauge" && (
        <Field label="Valeur pleine"><Input value={config.max ?? ""} onChange={(e) => setConfig((c) => ({ ...c, max: numOrNull(e.target.value) ?? undefined }))} className="h-9" placeholder="100" /></Field>
      )}
      {kind === "bar" && (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={!!config.stacked} onChange={(e) => setConfig((c) => ({ ...c, stacked: e.target.checked }))} /> Barres empilées
        </label>
      )}
      <div className="rounded-xl bg-muted/50 p-3 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">Format rendu par l'agent : </span>{WIDGET_META[kind].format}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button onClick={() => void save()} disabled={!dirty || saving} className="rounded-full">
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckIcon className="mr-1.5 h-4 w-4" />} Enregistrer
        </Button>
        <Button variant="ghost" onClick={onDelete} className="ml-auto rounded-md text-red-600 hover:text-red-600"><TrashIcon className="mr-1.5 h-4 w-4" /> Retirer</Button>
      </div>
    </aside>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[12px] font-medium">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

// ── Les réglages du dashboard ────────────────────────────────────────────────

function SettingsDialog({ open, onClose, dashboard, agents, onSaved }: {
  open: boolean; onClose: () => void; dashboard: AgentDashboard;
  agents: Array<{ id: string; name: string; avatar_url: string | null }>;
  onSaved: (next: AgentDashboard) => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState(dashboard.name);
  const [description, setDescription] = useState(dashboard.description ?? "");
  const [usage, setUsage] = useState(dashboard.usage_context ?? "");
  const [agentId, setAgentId] = useState(dashboard.agent_id ?? "none");
  const [refresh, setRefresh] = useState<Refresh>(dashboard.refresh);
  const [params, setParams] = useState<DashboardParameter[]>(dashboard.parameters ?? []);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(dashboard.name); setDescription(dashboard.description ?? ""); setUsage(dashboard.usage_context ?? "");
    setAgentId(dashboard.agent_id ?? "none"); setRefresh(dashboard.refresh); setParams(dashboard.parameters ?? []);
  }, [open, dashboard]);

  const save = async () => {
    setSaving(true);
    try {
      const patch = {
        name: name.trim() || dashboard.name, description: description.trim() || null, usage_context: usage.trim() || null,
        agent_id: agentId === "none" ? null : agentId, refresh,
        parameters: params.filter((p) => p.key.trim()).map((p) => ({ key: p.key.trim().replace(/\s+/g, "_"), label: p.label.trim() || p.key.trim(), value: p.value?.trim() ?? "" })),
      };
      await updateDashboard(dashboard.id, patch);
      await onSaved({ ...dashboard, ...patch });
      onClose();
    } catch (e) { toast.error("Enregistrement impossible", e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto overflow-x-hidden scrollbar-hide">
        <DialogHeader><DialogTitle>Réglages du dashboard</DialogTitle></DialogHeader>
        <div className="min-w-0 space-y-4">
          <Field label="Nom"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ce que montre ce dashboard" /></Field>
          <Field label="Contexte d'utilisation" hint="Qui le lit, quand, pour décider quoi. L'agent s'en sert pour choisir ses sources et écrire sa synthèse.">
            <Textarea value={usage} onChange={(e) => setUsage(e.target.value)} rows={4}
              placeholder="Ex. : lu par l'équipe SRE au point du matin et pendant un incident, pour savoir ce qui sature et quelles alertes traiter d'abord." />
          </Field>
          {!dashboard.is_template && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Rempli par">
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Personne</SelectItem>
                    {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Actualisation">
                <Select value={refresh} onValueChange={(v) => setRefresh(v as Refresh)}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>{(Object.keys(REFRESH_LABEL) as Refresh[]).map((r) => <SelectItem key={r} value={r}>{REFRESH_LABEL[r]}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            </div>
          )}
          <Field label="Paramètres" hint="Des variables à citer dans les instructions avec {{clé}} : un même dashboard sert pour plusieurs périmètres.">
            <div className="space-y-2">
              {params.map((p, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
                  <Input value={p.key} onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="clé" className="h-9 font-mono text-[12px]" />
                  <Input value={p.label} onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="Libellé" className="h-9" />
                  <Input value={p.value ?? ""} onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="Valeur" className="h-9" />
                  <button onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))} className="rounded-md px-2 text-muted-foreground hover:bg-muted"><XIcon className="h-4 w-4" /></button>
                </div>
              ))}
              <button onClick={() => setParams((ps) => [...ps, { key: "", label: "", value: "" }])} className="inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:underline">
                <PlusIcon className="h-3.5 w-3.5" /> Ajouter un paramètre
              </button>
            </div>
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={() => void save()} disabled={saving}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Enregistrer</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

