// Les dashboards d'agents (0301), côté navigateur : lecture, édition, et la
// mission qui les fait remplir. Le format des composants et les modèles sont
// partagés avec les agents (dashboard-spec.ts).

import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { firstOccurrenceLocal, toAlignment, type Cadence } from "@/features/service-dashboards/scheduleCadence";
import {
  findDashboardTemplate, nextLayout, WIDGET_META,
  type DashboardParameter, type WidgetConfig, type WidgetKind, type WidgetLayout,
} from "../../../supabase/functions/_shared/dashboard-spec";

export * from "../../../supabase/functions/_shared/dashboard-spec";

export type Refresh = "manual" | Cadence;

export const REFRESH_LABEL: Record<Refresh, string> = {
  manual: "À la demande",
  hourly: "Toutes les heures",
  daily: "Chaque jour",
  weekly: "Chaque semaine",
  monthly: "Chaque mois",
};

export interface AgentDashboard {
  id: string;
  workspace_id: string;
  project_id: string;
  service_dashboard_id: string | null;
  name: string;
  description: string | null;
  usage_context: string | null;
  agent_id: string | null;
  is_template: boolean;
  template_key: string | null;
  parameters: DashboardParameter[];
  refresh: Refresh;
  last_filled_at: string | null;
  last_summary: string | null;
  /** Épinglé à l'accueil du tableau de service (0302). */
  pinned?: boolean;
  created_at: string;
  updated_at: string;
}

export interface DashboardWidget {
  id: string;
  dashboard_id: string;
  workspace_id: string;
  kind: WidgetKind;
  title: string;
  instructions: string;
  sources: string[];
  config: WidgetConfig;
  layout: WidgetLayout;
  data: unknown;
  note: string | null;
  fill_status: "ok" | "no_data" | "error" | null;
  filled_at: string | null;
  /** L'état d'alerte calculé au remplissage (0302). */
  alert_level?: "ok" | "warn" | "critical" | null;
  alert_since?: string | null;
}

export interface DashboardSnapshot {
  id: string;
  run_id: string | null;
  status: "running" | "done" | "failed";
  summary: string | null;
  data: Record<string, { data: unknown; note: string | null; status: string }>;
  started_at: string;
  finished_at: string | null;
}

export async function fetchDashboards(serviceId: string): Promise<AgentDashboard[]> {
  const { data, error } = await supabase.from("agent_dashboards").select("*")
    .eq("service_dashboard_id", serviceId).order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as AgentDashboard[];
}

/** Les dashboards qu'un collaborateur remplit, tous services confondus. */
export async function fetchAgentDashboards(agentId: string): Promise<AgentDashboard[]> {
  const { data, error } = await supabase.from("agent_dashboards").select("*")
    .eq("agent_id", agentId).eq("is_template", false).order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as AgentDashboard[];
}

export async function fetchDashboard(id: string): Promise<{ dashboard: AgentDashboard; widgets: DashboardWidget[] } | null> {
  const [d, w] = await Promise.all([
    supabase.from("agent_dashboards").select("*").eq("id", id).maybeSingle(),
    supabase.from("agent_dashboard_widgets").select("*").eq("dashboard_id", id),
  ]);
  if (d.error) throw new Error(d.error.message);
  if (!d.data) return null;
  return { dashboard: d.data as AgentDashboard, widgets: (w.data ?? []) as DashboardWidget[] };
}

export async function fetchSnapshots(id: string): Promise<DashboardSnapshot[]> {
  const { data } = await supabase.from("agent_dashboard_snapshots")
    .select("id, run_id, status, summary, data, started_at, finished_at")
    .eq("dashboard_id", id).order("started_at", { ascending: false }).limit(30);
  return (data ?? []) as DashboardSnapshot[];
}

/** Le run de remplissage en cours, s'il y en a un. */
export async function fetchActiveFill(id: string): Promise<{ runId: string; status: string } | null> {
  const { data: m } = await supabase.from("internal_agent_missions").select("id").eq("dashboard_id", id).maybeSingle();
  if (!m) return null;
  const { data: r } = await supabase.from("internal_agent_runs").select("id, status, created_at")
    .eq("mission_id", (m as { id: string }).id).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const run = r as { id: string; status: string; created_at: string } | null;
  if (!run || !["queued", "running"].includes(run.status)) return null;
  // Un run « en cours » depuis plus de deux heures est un zombie.
  if (Date.now() - new Date(run.created_at).getTime() > 2 * 60 * 60 * 1000) return null;
  return { runId: run.id, status: run.status };
}

// ── Écritures ────────────────────────────────────────────────────────────────

interface Scope { workspaceId: string; projectId: string; serviceId: string; userId: string | null }

/** Un dashboard vide, depuis un modèle du catalogue, ou depuis un modèle enregistré. */
export async function createDashboard(scope: Scope, input: {
  name: string;
  templateKey?: string | null;
  fromDashboardId?: string | null;
  agentId?: string | null;
  parameters?: DashboardParameter[];
  isTemplate?: boolean;
}): Promise<string> {
  const tpl = input.templateKey ? findDashboardTemplate(input.templateKey) : undefined;
  let source: { description: string | null; usage_context: string | null; widgets: Array<Omit<DashboardWidget, "id" | "dashboard_id" | "workspace_id" | "data" | "note" | "fill_status" | "filled_at">> } | null = null;
  if (input.fromDashboardId) {
    const src = await fetchDashboard(input.fromDashboardId);
    if (src) source = { description: src.dashboard.description, usage_context: src.dashboard.usage_context, widgets: src.widgets };
  } else if (tpl) {
    source = {
      description: tpl.description ?? null, usage_context: tpl.usage_context ?? null,
      widgets: tpl.widgets.map((w) => ({ kind: w.kind, title: w.title, instructions: w.instructions, sources: w.sources ?? [], config: w.config ?? {}, layout: w.layout ?? nextLayout([], w.kind) })),
    };
  }
  const { data, error } = await supabase.from("agent_dashboards").insert({
    workspace_id: scope.workspaceId, project_id: scope.projectId, service_dashboard_id: scope.serviceId,
    name: input.name.trim() || "Nouveau dashboard",
    description: source?.description ?? null, usage_context: source?.usage_context ?? null,
    agent_id: input.agentId ?? null, template_key: tpl?.key ?? null,
    parameters: input.parameters ?? tpl?.parameters ?? [], is_template: !!input.isTemplate,
    created_by: scope.userId,
  }).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "Création impossible");
  const id = (data as { id: string }).id;
  if (source?.widgets.length) {
    const { error: we } = await supabase.from("agent_dashboard_widgets").insert(source.widgets.map((w) => ({
      dashboard_id: id, workspace_id: scope.workspaceId, kind: w.kind, title: w.title,
      instructions: w.instructions, sources: w.sources ?? [], config: w.config ?? {}, layout: w.layout,
    })));
    if (we) throw new Error(we.message);
  }
  return id;
}

export async function updateDashboard(id: string, patch: Partial<Pick<AgentDashboard, "name" | "description" | "usage_context" | "agent_id" | "parameters" | "refresh" | "pinned">>) {
  const { error } = await supabase.from("agent_dashboards").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteDashboard(id: string) {
  const { error } = await supabase.from("agent_dashboards").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function addWidget(d: AgentDashboard, kind: WidgetKind, existing: WidgetLayout[]): Promise<DashboardWidget> {
  const { data, error } = await supabase.from("agent_dashboard_widgets").insert({
    dashboard_id: d.id, workspace_id: d.workspace_id, kind, title: WIDGET_META[kind].label,
    instructions: "", sources: [], config: {}, layout: nextLayout(existing, kind),
  }).select("*").single();
  if (error || !data) throw new Error(error?.message ?? "Ajout impossible");
  return data as DashboardWidget;
}

export async function updateWidget(id: string, patch: Partial<Pick<DashboardWidget, "kind" | "title" | "instructions" | "sources" | "config" | "layout">>) {
  const extra = patch.kind ? { data: null, fill_status: null, note: null } : {};
  const { error } = await supabase.from("agent_dashboard_widgets").update({ ...patch, ...extra, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteWidget(id: string) {
  const { error } = await supabase.from("agent_dashboard_widgets").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function saveLayouts(items: Array<{ id: string; layout: WidgetLayout }>) {
  await Promise.all(items.map((it) => supabase.from("agent_dashboard_widgets").update({ layout: it.layout }).eq("id", it.id)));
}

// ── La mission de remplissage ────────────────────────────────────────────────

const missionBrief = (d: Pick<AgentDashboard, "id" | "name">) =>
  `Remplis le dashboard « ${d.name} » (dashboard_id: ${d.id}). Commence par dashboard(action="brief", dashboard_id="${d.id}") : il te donne le contexte d'utilisation, la méthode et chaque composant à remplir avec ses instructions. Remplis chaque composant avec dashboard(action="fill"), puis publie la synthèse avec dashboard(action="publish").`;

/** La cadence d'une mission, en heure locale (8 h pour les cadences au jour). */
function scheduleOf(refresh: Refresh) {
  if (refresh === "manual") {
    return { schedule: null, next_run_at: null, schedule_minute: null, schedule_hour: null, schedule_dow: null, schedule_dom: null };
  }
  const sel = { cadence: refresh, minute: 0, hour: 8, dow: 1, dom: 1 };
  const occ = firstOccurrenceLocal(sel);
  return { schedule: refresh, next_run_at: occ.toISOString(), ...toAlignment(sel, occ) };
}

/** La mission qui remplit ce dashboard, alignée sur son collaborateur et sa cadence. */
export async function syncMission(d: AgentDashboard, userId: string | null, opts: { create?: boolean } = {}): Promise<string | null> {
  const { data: existing } = await supabase.from("internal_agent_missions").select("id").eq("dashboard_id", d.id).maybeSingle();
  const id = (existing as { id: string } | null)?.id ?? null;
  if (!d.agent_id || d.is_template) {
    if (id) await supabase.from("internal_agent_missions").update({ schedule: null, next_run_at: null, status: "paused" }).eq("id", id);
    return null;
  }
  const fields = {
    title: `Dashboard · ${d.name}`.slice(0, 200),
    brief: missionBrief(d),
    acceptance_criteria: "Chaque composant du dashboard est rempli, ou marqué sans donnée avec la raison, et la synthèse est publiée.",
    agent_id: d.agent_id,
    status: "active",
    ...scheduleOf(d.refresh),
    updated_at: new Date().toISOString(),
  };
  if (id) {
    await supabase.from("internal_agent_missions").update(fields).eq("id", id);
    return id;
  }
  if (d.refresh === "manual" && !opts.create) return null;
  const { data, error } = await supabase.from("internal_agent_missions").insert({
    ...fields, dashboard_id: d.id, workspace_id: d.workspace_id, project_id: d.project_id,
    board_column: "todo", created_by: userId,
  }).select("id").single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

/** Fait remplir le dashboard maintenant. */
export async function refreshDashboard(d: AgentDashboard, userId: string | null): Promise<string> {
  if (!d.agent_id) throw new Error("Choisissez d'abord le collaborateur qui remplit ce dashboard.");
  const missionId = await syncMission(d, userId, { create: true });
  if (!missionId) throw new Error("La mission de remplissage n'a pas pu être créée.");
  const { data: run, error } = await supabase.from("internal_agent_runs").insert({
    mission_id: missionId, agent_id: d.agent_id, workspace_id: d.workspace_id, project_id: d.project_id,
    status: "queued", triggered_by: userId,
  }).select("id").single();
  if (error || !run) throw new Error(error?.message ?? "Le remplissage n'a pas pu démarrer.");
  const runId = (run as { id: string }).id;
  try { await callEdge("internal-agent-run", { agent_id: d.agent_id, mode: "mission", run_id: runId }); } catch { /* le planificateur le reprend */ }
  return runId;
}
