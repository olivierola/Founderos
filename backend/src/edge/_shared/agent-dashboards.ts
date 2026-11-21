// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/agent-dashboards.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { Deno, FUNCTIONS_URL } from "../../compat/index.ts";

// Les dashboards d'agents (0301), côté serveur : l'outil que les collaborateurs
// utilisent pour les remplir, la mission qui les relance, et l'outil de
// l'assistant qui les crée sur demande. Le format des composants et les
// modèles sont dans dashboard-spec.ts, partagé avec le navigateur.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildDashboardBrief, DASHBOARD_TEMPLATES, findDashboardTemplate, isWidgetKind, nextLayout, normalizeWidgetData, statusOf,
  WIDGET_KINDS, WIDGET_META,
  type BriefWidget, type DashboardParameter, type Status, type WidgetConfig, type WidgetKind, type WidgetLayout,
} from "./dashboard-spec.ts";
import { findAgent, resolveService, type OpsActor, type OpsResult } from "./assistant-ops.ts";

export interface DashboardRow {
  id: string; workspace_id: string; project_id: string; service_dashboard_id: string | null;
  name: string; description: string | null; usage_context: string | null; agent_id: string | null;
  is_template: boolean; template_key: string | null; parameters: DashboardParameter[] | null;
  refresh: Refresh; last_filled_at: string | null; last_summary: string | null;
}
export interface WidgetRow extends BriefWidget {
  dashboard_id: string; layout: WidgetLayout | null; note: string | null; fill_status: string | null;
  alert_level?: Status | null;
}

/** L’état d’alerte d’un composant rempli (0302) : seuils d’un KPI ou d’une jauge,
 *  sévérité la plus haute d’une liste d’alertes, pire ligne d’un tableau. */
export function alertLevelOf(kind: WidgetKind, data: unknown, config: WidgetConfig | null | undefined): Status | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (kind === "kpi" || kind === "gauge") {
    return statusOf(typeof d.value === "number" ? d.value : null, config ?? undefined, d.status as Status | undefined) ?? null;
  }
  const worst = (levels: unknown[]) => levels.includes("critical") ? "critical" : levels.includes("warn") ? "warn" : "ok";
  if (kind === "alerts" && Array.isArray(d.items)) return worst(d.items.map((i) => (i as { severity?: string }).severity)) as Status;
  if (kind === "table" && Array.isArray(d.rows)) {
    const l = d.rows.map((r) => (r as { _status?: string })._status).filter(Boolean);
    return l.length ? worst(l) as Status : null;
  }
  return null;
}
export type Refresh = "manual" | "hourly" | "daily" | "weekly" | "monthly";
export const REFRESH_VALUES: Refresh[] = ["manual", "hourly", "daily", "weekly", "monthly"];

const DASH_COLS = "id, workspace_id, project_id, service_dashboard_id, name, description, usage_context, agent_id, is_template, template_key, parameters, refresh, last_filled_at, last_summary";
const WIDGET_COLS = "*";

/** Les dashboards qu'un collaborateur remplit : l'outil `dashboard` ne lui est donné que s'il en a. */
export async function loadAgentDashboards(admin: SupabaseClient, agentId: string): Promise<Array<{ id: string; name: string }>> {
  const { data } = await admin.from("agent_dashboards").select("id, name")
    .eq("agent_id", agentId).eq("is_template", false).order("updated_at", { ascending: false }).limit(30)
    .then((r) => r, () => ({ data: null }));
  return ((data ?? []) as Array<{ id: string; name: string }>);
}

const byLayout = (a: WidgetRow, b: WidgetRow) =>
  ((a.layout?.y ?? 0) - (b.layout?.y ?? 0)) || ((a.layout?.x ?? 0) - (b.layout?.x ?? 0));

async function loadDashboard(admin: SupabaseClient, id: string): Promise<{ d: DashboardRow; widgets: WidgetRow[] } | null> {
  const [{ data: d }, { data: w }] = await Promise.all([
    admin.from("agent_dashboards").select(DASH_COLS).eq("id", id).maybeSingle(),
    admin.from("agent_dashboard_widgets").select(WIDGET_COLS).eq("dashboard_id", id),
  ]);
  if (!d) return null;
  return { d: d as DashboardRow, widgets: ((w ?? []) as WidgetRow[]).sort(byLayout) };
}

// ── La mission de remplissage ────────────────────────────────────────────────

/** Ce que la mission dit à l'agent : la consigne complète vient de l'outil, à jour. */
export function dashboardMissionBrief(d: { id: string; name: string }): string {
  return `Remplis le dashboard « ${d.name} » (dashboard_id: ${d.id}). Commence par dashboard(action="brief", dashboard_id="${d.id}") : il te donne le contexte d'utilisation, la méthode et chaque composant à remplir avec ses instructions. Remplis chaque composant avec dashboard(action="fill"), puis publie la synthèse avec dashboard(action="publish").`;
}

/** La prochaine échéance d'une cadence, en UTC (7 h pour les cadences au jour). */
export function scheduleFields(refresh: Refresh, now = new Date()) {
  if (refresh === "manual") return { schedule: null, next_run_at: null, schedule_minute: null, schedule_hour: null, schedule_dow: null, schedule_dom: null };
  const d = new Date(now);
  d.setUTCSeconds(0, 0);
  if (refresh === "hourly") {
    d.setUTCMinutes(0);
    d.setUTCHours(d.getUTCHours() + 1);
    return { schedule: "hourly", next_run_at: d.toISOString(), schedule_minute: 0, schedule_hour: null, schedule_dow: null, schedule_dom: null };
  }
  d.setUTCHours(7, 0);
  if (refresh === "daily") {
    if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
    return { schedule: "daily", next_run_at: d.toISOString(), schedule_minute: 0, schedule_hour: 7, schedule_dow: null, schedule_dom: null };
  }
  if (refresh === "weekly") {
    let delta = (1 - d.getUTCDay() + 7) % 7; // le lundi
    if (delta === 0 && d <= now) delta = 7;
    d.setUTCDate(d.getUTCDate() + delta);
    return { schedule: "weekly", next_run_at: d.toISOString(), schedule_minute: 0, schedule_hour: 7, schedule_dow: 1, schedule_dom: null };
  }
  d.setUTCDate(1);
  if (d <= now) d.setUTCMonth(d.getUTCMonth() + 1, 1);
  return { schedule: "monthly", next_run_at: d.toISOString(), schedule_minute: 0, schedule_hour: 7, schedule_dow: null, schedule_dom: 1 };
}

/** La mission qui remplit ce dashboard, créée ou remise à jour (agent, cadence, consigne). */
export async function ensureDashboardMission(admin: SupabaseClient, d: DashboardRow, userId: string | null): Promise<string | null> {
  if (!d.agent_id || d.is_template) return null;
  const fields = {
    title: `Dashboard · ${d.name}`.slice(0, 200),
    brief: dashboardMissionBrief(d),
    acceptance_criteria: "Chaque composant du dashboard est rempli, ou marqué sans donnée avec la raison, et la synthèse est publiée.",
    agent_id: d.agent_id,
    ...scheduleFields(d.refresh),
    updated_at: new Date().toISOString(),
  };
  const { data: existing } = await admin.from("internal_agent_missions").select("id").eq("dashboard_id", d.id).maybeSingle();
  if (existing) {
    await admin.from("internal_agent_missions").update({ ...fields, status: "active" }).eq("id", (existing as { id: string }).id);
    return (existing as { id: string }).id;
  }
  const { data: created } = await admin.from("internal_agent_missions").insert({
    ...fields, dashboard_id: d.id, workspace_id: d.workspace_id, project_id: d.project_id,
    status: "active", board_column: "todo", created_by: userId,
  }).select("id").single();
  return (created as { id: string } | null)?.id ?? null;
}

/** Lance un remplissage tout de suite. Rend l'id du run, ou la raison. */
export async function startDashboardFill(admin: SupabaseClient, d: DashboardRow, userId: string | null): Promise<{ runId: string } | { error: string }> {
  if (!d.agent_id) return { error: "Aucun collaborateur n'est chargé de ce dashboard." };
  const missionId = await ensureDashboardMission(admin, d, userId);
  if (!missionId) return { error: "La mission de remplissage n'a pas pu être créée." };
  const { data: run, error } = await admin.from("internal_agent_runs").insert({
    mission_id: missionId, agent_id: d.agent_id, workspace_id: d.workspace_id, project_id: d.project_id,
    status: "queued", triggered_by: userId,
  }).select("id").single();
  if (error || !run) return { error: error?.message ?? "Le run n'a pas pu être créé." };
  const runId = (run as { id: string }).id;
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (base && key) {
    await fetch(`${FUNCTIONS_URL}/functions/v1/internal-agent-run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: d.agent_id, mode: "mission", run_id: runId }),
    }).catch(() => {});
  }
  return { runId };
}

// ── L'outil des collaborateurs ───────────────────────────────────────────────

export function dashboardToolDef(dashboards: Array<{ id: string; name: string }>) {
  return {
    name: "dashboard",
    description:
      "Remplir les dashboards qui te sont confiés. action=brief : la consigne complète (contexte d'utilisation, méthode, chaque composant avec ses instructions et son format) — appelle-le en premier. "
      + "action=fill : dépose les données d'un composant (widget_id, data au format du composant, note sur la source), ou status=no_data avec la raison. "
      + "action=publish : termine le remplissage avec une synthèse (summary). action=read : relis les valeurs actuelles. "
      + `Tes dashboards : ${dashboards.map((d) => `« ${d.name} » (${d.id})`).join(", ")}.`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["brief", "fill", "publish", "read"] },
        dashboard_id: { type: "string" },
        widget_id: { type: "string", description: "fill : le composant." },
        data: { type: "object", description: "fill : les données, au format du composant donné par brief." },
        status: { type: "string", enum: ["ok", "no_data", "error"], description: "fill : no_data quand la donnée est introuvable." },
        note: { type: "string", description: "fill : d'où vient la donnée, comment elle est calculée, ou pourquoi elle manque." },
        summary: { type: "string", description: "publish : ce qui a changé, les anomalies, les actions à mener." },
      },
      required: ["action", "dashboard_id"],
      additionalProperties: false,
    },
  };
}

export async function runDashboardTool(
  ctx: { admin: SupabaseClient; agentId: string; runId: string | null },
  args: Record<string, unknown>,
): Promise<string> {
  const action = String(args.action ?? "");
  const id = String(args.dashboard_id ?? "").trim();
  const loaded = id ? await loadDashboard(ctx.admin, id) : null;
  if (!loaded) return `ERROR: dashboard ${id || "?"} introuvable.`;
  const { d, widgets } = loaded;
  if (d.agent_id !== ctx.agentId) return `ERROR: le dashboard « ${d.name} » n'est pas confié à ce collaborateur.`;

  // L'instantané de ce remplissage : un par run, créé à la première action.
  const snapshot = async (): Promise<{ id: string; data: Record<string, unknown> } | null> => {
    if (!ctx.runId) return null;
    const { data: found } = await ctx.admin.from("agent_dashboard_snapshots").select("id, data")
      .eq("dashboard_id", d.id).eq("run_id", ctx.runId).maybeSingle();
    if (found) return found as { id: string; data: Record<string, unknown> };
    const { data: made } = await ctx.admin.from("agent_dashboard_snapshots")
      .insert({ dashboard_id: d.id, workspace_id: d.workspace_id, run_id: ctx.runId, status: "running" })
      .select("id, data").single();
    return (made as { id: string; data: Record<string, unknown> } | null);
  };

  if (action === "brief") {
    await snapshot();
    if (!widgets.length) return `Le dashboard « ${d.name} » n'a aucun composant : rien à remplir. Dis-le simplement.`;
    return buildDashboardBrief(d, widgets, d.last_summary);
  }

  if (action === "read") {
    if (!widgets.length) return "Aucun composant.";
    return widgets.map((w) => `[${w.id}] ${WIDGET_META[w.kind].label} « ${w.title} » : ${w.data == null ? "jamais rempli" : JSON.stringify(w.data).slice(0, 400)}${w.filled_at ? ` (${w.filled_at.slice(0, 16).replace("T", " ")})` : ""}`).join("\n");
  }

  if (action === "fill") {
    const w = widgets.find((x) => x.id === String(args.widget_id ?? "").trim());
    if (!w) return `ERROR: composant ${String(args.widget_id ?? "?")} introuvable dans ce dashboard. Composants : ${widgets.map((x) => `${x.id} (${x.title})`).join(", ")}.`;
    const note = args.note == null ? null : String(args.note).slice(0, 600);
    const now = new Date().toISOString();
    const st = args.status === "no_data" || args.status === "error" ? String(args.status) : "ok";
    let data: unknown = undefined;
    if (st === "ok") {
      const n = normalizeWidgetData(w.kind, args.data);
      if ("error" in n) return `ERROR: ${n.error} Rien n'a été enregistré : corrige data et rappelle fill.`;
      data = n.data;
    }
    const patch: Record<string, unknown> = { note, fill_status: st, filled_at: now, updated_at: now };
    if (data !== undefined) patch.data = data;
    // L’état d’alerte (0302) : sans la colonne, le remplissage passe quand même.
    const level = data !== undefined ? alertLevelOf(w.kind, data, w.config) : null;
    const alert = data !== undefined
      ? { alert_level: level, alert_since: level && level !== (w.alert_level ?? null) ? now : level ? undefined : null }
      : {};
    let { error } = await ctx.admin.from("agent_dashboard_widgets").update({ ...patch, ...alert }).eq("id", w.id);
    if (error && /alert_/i.test(error.message)) ({ error } = await ctx.admin.from("agent_dashboard_widgets").update(patch).eq("id", w.id));
    if (error) return `ERROR: ${error.message}`;
    const snap = await snapshot();
    if (snap) {
      await ctx.admin.from("agent_dashboard_snapshots")
        .update({ data: { ...(snap.data ?? {}), [w.id]: { data: data ?? null, note, status: st } } })
        .eq("id", snap.id).then(() => {}, () => {});
    }
    const left = widgets.filter((x) => x.id !== w.id && !(snap?.data ?? {})[x.id]).map((x) => x.title);
    return `« ${w.title} » ${st === "ok" ? "rempli" : "marqué sans donnée"}.${left.length ? ` Reste : ${left.slice(0, 12).join(", ")}.` : " Tous les composants sont remplis : publie la synthèse."}`;
  }

  if (action === "publish") {
    const summary = String(args.summary ?? "").trim().slice(0, 3000);
    const snap = await snapshot();
    const now = new Date().toISOString();
    if (snap) {
      await ctx.admin.from("agent_dashboard_snapshots")
        .update({ status: "done", summary: summary || null, finished_at: now }).eq("id", snap.id);
    }
    await ctx.admin.from("agent_dashboards")
      .update({ last_filled_at: now, last_summary: summary || null, updated_at: now }).eq("id", d.id);
    const filled = Object.keys(snap?.data ?? {}).length;
    return `Dashboard « ${d.name} » publié : ${filled}/${widgets.length} composants remplis pendant ce run.`;
  }

  return `ERROR: action « ${action} » inconnue. Actions : brief, fill, publish, read.`;
}

// ── L'outil de l'assistant ───────────────────────────────────────────────────

const DASH_ACTIONS = ["list", "templates", "create", "update", "add_widget", "update_widget", "remove_widget", "refresh", "read"] as const;
const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

export function dashboardOpsToolDef(name = "manage_dashboards") {
  return {
    name,
    description:
      "Créer et gérer les dashboards d'agents : des tableaux de KPI, jauges, courbes, barres, anneaux, tableaux, alertes et textes, que un collaborateur remplit avec ses outils selon les instructions de chaque composant. "
      + "list : les dashboards. templates : les modèles prêts à l'emploi. create : un dashboard depuis un modèle (template) ou depuis une description complète (widgets). "
      + "update : nom, description, contexte d'utilisation, collaborateur, cadence, paramètres. add_widget / update_widget / remove_widget : les composants. refresh : le faire remplir maintenant. read : ses valeurs actuelles. "
      + "Quand l'utilisateur décrit un dashboard, conçois-le toi-même : 4 à 10 composants, chacun avec des instructions précises (quoi, quelle source, quel calcul, quelle période) et un contexte d'utilisation qui dit qui le lit et pour décider quoi.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...DASH_ACTIONS] },
        params: {
          type: "object",
          description:
            "dashboard_id (update, add_widget, update_widget, remove_widget, refresh, read) ; widget_id (update_widget, remove_widget) ; "
            + "template (clé d'un modèle) ; name, description, usage_context, agent (nom ou id du collaborateur qui remplit), service, "
            + `refresh (${REFRESH_VALUES.join("|")}), parameters [{key,label,value}], pinned (update : épingler à l'accueil du service) ; `
            + `widgets [{kind (${WIDGET_KINDS.join("|")}), title, instructions, sources [..], config {unit, thresholds {warn, critical, direction above|below}, max}, w (1-12), h (1-6)}] ; `
            + "pour add_widget/update_widget : les champs d'un widget à plat ; run_now (create) : le remplir tout de suite.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

function widgetFrom(raw: Record<string, unknown>, existing: WidgetLayout[]): { kind: WidgetKind; title: string; instructions: string; sources: string[]; config: WidgetConfig; layout: WidgetLayout } | string {
  const kind = String(raw.kind ?? "").trim();
  if (!isWidgetKind(kind)) return `ERREUR : kind « ${kind} » inconnu. Types : ${WIDGET_KINDS.join(", ")}.`;
  const base = (raw.layout && typeof raw.layout === "object" ? raw.layout : nextLayout(existing, kind)) as WidgetLayout;
  const w = Math.min(12, Math.max(1, Number(raw.w) || base.w || WIDGET_META[kind].size.w));
  const h = Math.min(8, Math.max(1, Number(raw.h) || base.h || WIDGET_META[kind].size.h));
  return {
    kind,
    title: String(raw.title ?? WIDGET_META[kind].label).slice(0, 120),
    instructions: String(raw.instructions ?? "").slice(0, 2000),
    sources: Array.isArray(raw.sources) ? raw.sources.map(String).slice(0, 8) : [],
    config: (raw.config && typeof raw.config === "object" ? raw.config : {}) as WidgetConfig,
    layout: { x: Math.min(12 - w, Math.max(0, Number(base.x) || 0)), y: Math.max(0, Number(base.y) || 0), w, h },
  };
}

const dashLink = (d: { id: string; service_dashboard_id: string | null }) =>
  d.service_dashboard_id ? `(ouvrir : onglet Dashboards du service, dashboard_id ${d.id})` : `(dashboard_id ${d.id})`;

export async function runDashboardOps(actor: OpsActor, action: string, p: Record<string, unknown>): Promise<OpsResult> {
  const a = actor.admin;
  if (action === "templates") {
    return { text: DASHBOARD_TEMPLATES.map((t) => `- ${t.key} : ${t.name} (${t.category}) · ${t.tagline} · ${t.widgets.length} composants${t.parameters?.length ? ` · paramètres : ${t.parameters.map((x) => x.key).join(", ")}` : ""}`).join("\n") };
  }
  if (action === "list") {
    const { data } = await a.from("agent_dashboards").select("id, name, agent_id, refresh, last_filled_at, is_template, service_dashboard_id")
      .eq("project_id", actor.projectId).order("updated_at", { ascending: false }).limit(50);
    const rows = (data ?? []) as Array<{ id: string; name: string; agent_id: string | null; refresh: string; last_filled_at: string | null; is_template: boolean }>;
    if (!rows.length) return { text: "Aucun dashboard dans ce projet. Propose d'en créer un (action=create) ou montre les modèles (action=templates)." };
    return { text: rows.map((r) => `- ${r.name}${r.is_template ? " (modèle)" : ""} · id ${r.id} · ${r.agent_id ? `rempli par l'agent ${r.agent_id}` : "aucun collaborateur"} · ${r.refresh} · ${r.last_filled_at ? `rempli le ${r.last_filled_at.slice(0, 16).replace("T", " ")}` : "jamais rempli"}`).join("\n") };
  }
  if (!(DASH_ACTIONS as readonly string[]).includes(action)) {
    return { text: `ERREUR : l'action « ${action} » n'existe pas. Actions : ${DASH_ACTIONS.join(", ")}.` };
  }
  if (action !== "read" && ROLE_RANK[actor.role] < ROLE_RANK.member) {
    return { text: `ACCÈS REFUSÉ : le rôle « ${actor.role} » ne permet pas de modifier les dashboards.` };
  }

  const resolveAgentId = async (ref: unknown): Promise<string | null | { error: string }> => {
    if (ref == null || String(ref).trim() === "") return null;
    const ag = await findAgent(actor, String(ref));
    return typeof ag === "string" ? { error: ag } : ag.id;
  };

  if (action === "create") {
    const tpl = p.template ? findDashboardTemplate(String(p.template)) : undefined;
    if (p.template && !tpl) return { text: `ERREUR : modèle « ${String(p.template)} » inconnu. Utilise action=templates.` };
    const name = String(p.name ?? tpl?.name ?? "").trim();
    if (!name) return { text: "ERREUR : donne un nom (name) au dashboard." };
    const svc = await resolveService(actor, String(p.service ?? ""));
    if (typeof svc === "string") return { text: svc };
    const agentId = await resolveAgentId(p.agent);
    if (agentId && typeof agentId === "object") return { text: agentId.error };
    const refresh = REFRESH_VALUES.includes(String(p.refresh) as Refresh) ? String(p.refresh) as Refresh : "manual";
    const params = Array.isArray(p.parameters) ? (p.parameters as DashboardParameter[]) : tpl?.parameters ?? [];
    const { data: made, error } = await a.from("agent_dashboards").insert({
      workspace_id: actor.workspaceId, project_id: actor.projectId, service_dashboard_id: svc.id,
      name: name.slice(0, 160), description: String(p.description ?? tpl?.description ?? "").slice(0, 2000) || null,
      usage_context: String(p.usage_context ?? tpl?.usage_context ?? "").slice(0, 3000) || null,
      agent_id: agentId, template_key: tpl?.key ?? null, parameters: params, refresh, created_by: actor.userId,
    }).select(DASH_COLS).single();
    if (error || !made) return { text: `ERREUR : ${error?.message ?? "création impossible"}` };
    const d = made as DashboardRow;
    const specs = Array.isArray(p.widgets) && p.widgets.length ? p.widgets as Array<Record<string, unknown>> : (tpl?.widgets ?? []) as unknown as Array<Record<string, unknown>>;
    const layouts: WidgetLayout[] = [];
    const rows = [];
    for (const raw of specs.slice(0, 24)) {
      const w = widgetFrom(raw, layouts);
      if (typeof w === "string") return { text: w };
      layouts.push(w.layout);
      rows.push({ ...w, dashboard_id: d.id, workspace_id: d.workspace_id });
    }
    if (rows.length) await a.from("agent_dashboard_widgets").insert(rows);
    if (d.agent_id && d.refresh !== "manual") await ensureDashboardMission(a, d, actor.userId);
    let started = "";
    if (p.run_now && d.agent_id) {
      const r = await startDashboardFill(a, d, actor.userId);
      started = "error" in r ? ` Remplissage non lancé : ${r.error}` : " Remplissage lancé.";
    }
    return {
      text: `Dashboard « ${d.name} » créé avec ${rows.length} composants ${dashLink(d)}.${d.agent_id ? "" : " Aucun collaborateur ne le remplit encore : propose d'en choisir un (action=update, agent)."}${started}`,
      ui: [{ component: "dashboard_card", props: { dashboard_id: d.id, service_id: d.service_dashboard_id, name: d.name, widgets: rows.length } }],
    };
  }

  const id = String(p.dashboard_id ?? p.id ?? "").trim();
  const loaded = id ? await loadDashboard(a, id) : null;
  if (!loaded || loaded.d.project_id !== actor.projectId) return { text: `ERREUR : dashboard ${id || "?"} introuvable dans ce projet. Utilise action=list.` };
  const { d, widgets } = loaded;

  if (action === "read") {
    if (!widgets.length) return { text: `« ${d.name} » n'a aucun composant.` };
    return { text: [
      `« ${d.name} » · ${d.last_filled_at ? `rempli le ${d.last_filled_at.slice(0, 16).replace("T", " ")}` : "jamais rempli"}`,
      d.last_summary ? `Synthèse : ${d.last_summary}` : "",
      ...widgets.map((w) => `- [${w.id}] ${WIDGET_META[w.kind].label} « ${w.title} » : ${w.data == null ? "vide" : JSON.stringify(w.data).slice(0, 300)}`),
    ].filter(Boolean).join("\n") };
  }

  if (action === "refresh") {
    const r = await startDashboardFill(a, d, actor.userId);
    return { text: "error" in r ? `ERREUR : ${r.error}` : `Remplissage de « ${d.name} » lancé (run ${r.runId}). Les composants se remplissent au fil de l'eau.` };
  }

  if (action === "update") {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of ["name", "description", "usage_context"] as const) if (p[k] != null) patch[k] = String(p[k]).slice(0, k === "name" ? 160 : 3000);
    if (p.refresh != null) {
      if (!REFRESH_VALUES.includes(String(p.refresh) as Refresh)) return { text: `ERREUR : refresh doit valoir ${REFRESH_VALUES.join(", ")}.` };
      patch.refresh = String(p.refresh);
    }
    if (p.parameters != null) patch.parameters = p.parameters;
    if (p.pinned != null) patch.pinned = p.pinned === true || p.pinned === "true";
    if (p.agent !== undefined) {
      const ag = await resolveAgentId(p.agent);
      if (ag && typeof ag === "object") return { text: ag.error };
      patch.agent_id = ag;
    }
    const { data: upd, error } = await a.from("agent_dashboards").update(patch).eq("id", d.id).select(DASH_COLS).single();
    if (error || !upd) return { text: `ERREUR : ${error?.message ?? "mise à jour impossible"}` };
    const nd = upd as DashboardRow;
    const { data: mission } = await a.from("internal_agent_missions").select("id").eq("dashboard_id", d.id).maybeSingle();
    if (nd.agent_id && (nd.refresh !== "manual" || mission)) await ensureDashboardMission(a, nd, actor.userId);
    return { text: `« ${nd.name} » mis à jour.` };
  }

  if (action === "add_widget") {
    const w = widgetFrom(p, widgets.map((x) => x.layout ?? { x: 0, y: 0, w: 1, h: 1 }));
    if (typeof w === "string") return { text: w };
    const { data: made, error } = await a.from("agent_dashboard_widgets").insert({ ...w, dashboard_id: d.id, workspace_id: d.workspace_id }).select("id").single();
    if (error) return { text: `ERREUR : ${error.message}` };
    return { text: `Composant « ${w.title} » ajouté (widget_id ${(made as { id: string }).id}).` };
  }

  const w = widgets.find((x) => x.id === String(p.widget_id ?? "").trim());
  if (!w) return { text: `ERREUR : composant ${String(p.widget_id ?? "?")} introuvable. Composants : ${widgets.map((x) => `${x.id} (${x.title})`).join(", ")}.` };

  if (action === "remove_widget") {
    await a.from("agent_dashboard_widgets").delete().eq("id", w.id);
    return { text: `Composant « ${w.title} » retiré.` };
  }

  // update_widget
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (p.title != null) patch.title = String(p.title).slice(0, 120);
  if (p.instructions != null) patch.instructions = String(p.instructions).slice(0, 2000);
  if (Array.isArray(p.sources)) patch.sources = p.sources.map(String).slice(0, 8);
  if (p.config && typeof p.config === "object") patch.config = p.config;
  if (p.kind != null) {
    if (!isWidgetKind(p.kind)) return { text: `ERREUR : kind inconnu. Types : ${WIDGET_KINDS.join(", ")}.` };
    patch.kind = p.kind;
    patch.data = null;
  }
  if (p.w != null || p.h != null) {
    const l = w.layout ?? { x: 0, y: 0, w: 4, h: 2 };
    patch.layout = { ...l, w: Math.min(12, Math.max(1, Number(p.w) || l.w)), h: Math.min(8, Math.max(1, Number(p.h) || l.h)) };
  }
  await a.from("agent_dashboard_widgets").update(patch).eq("id", w.id);
  return { text: `Composant « ${String(patch.title ?? w.title)} » mis à jour.` };
}
