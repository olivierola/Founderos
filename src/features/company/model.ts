// La couche Entreprise — types et accès aux données (migrations 0212 → 0215).
//
// Ce module est le seul endroit qui connaît la forme des tables company_*. Les
// quatre écrans (Contexte, Objectifs, Graphe, ROI) s'appuient dessus, et les
// agents lisent exactement les mêmes lignes côté serveur — c'est voulu : une
// entreprise décrite dans l'UI et une entreprise vue par les agents qui
// divergent, c'est la panne qu'on ne diagnostique jamais.
import { supabase } from "@/lib/supabase";

// ── Profil ──────────────────────────────────────────────────────────────────

export interface CompanyProfile {
  project_id: string;
  workspace_id: string;
  legal_name: string | null;
  activity: string | null;
  mission: string | null;
  market: string | null;
  icp: string | null;
  value_prop: string | null;
  differentiators: string | null;
  stage: string | null;
  team_size: number | null;
  geographies: string[];
  languages: string[];
  tone: string | null;
  constraints: string | null;
  non_negotiables: string | null;
  updated_at: string;
}

/** Les champs du profil, dans l'ordre où on les demande à un humain : d'abord
 *  ce qu'il sait dire sans réfléchir, ensuite ce qui demande un arbitrage. Un
 *  formulaire qui ouvre sur « quels sont vos différenciateurs ? » ne se remplit
 *  pas. */
export const PROFILE_FIELDS: Array<{
  key: keyof CompanyProfile;
  label: string;
  placeholder: string;
  help?: string;
  long?: boolean;
}> = [
  { key: "legal_name", label: "Nom", placeholder: "Le nom sous lequel on vous connaît" },
  { key: "activity", label: "Activité", placeholder: "Ce que vous faites, en une phrase", long: true },
  { key: "mission", label: "Raison d'être", placeholder: "Pourquoi vous le faites", long: true },
  { key: "market", label: "Marché", placeholder: "Sur quel marché vous opérez", long: true },
  {
    key: "icp", label: "Client type", placeholder: "À qui vous vendez, précisément", long: true,
    help: "C'est le champ que vos agents utilisent le plus : il décide du ton, des exemples et des priorités.",
  },
  { key: "value_prop", label: "Proposition de valeur", placeholder: "Ce que vous promettez", long: true },
  { key: "differentiators", label: "Ce qui vous distingue", placeholder: "Ce que les autres ne font pas", long: true },
  {
    key: "tone", label: "Ton", placeholder: "Direct, chaleureux, technique, sobre…", long: true,
    help: "Opposable : tout ce que vos agents écrivent doit sonner comme ça.",
  },
  { key: "constraints", label: "Contraintes", placeholder: "Budget, délais, réglementation, capacité…", long: true },
  {
    key: "non_negotiables", label: "Non négociable", placeholder: "Une par ligne : ce qu'un agent ne doit JAMAIS faire", long: true,
    help: "Ce champ n'est pas une information, c'est une règle : il est envoyé au même rang que les règles de sécurité.",
  },
];

export const STAGES = ["idée", "amorçage", "croissance", "établie"] as const;

export async function fetchCompanyProfile(projectId: string): Promise<CompanyProfile | null> {
  const { data } = await supabase.from("company_profile").select("*").eq("project_id", projectId).maybeSingle();
  return (data as CompanyProfile | null) ?? null;
}

export async function saveCompanyProfile(
  projectId: string, workspaceId: string, userId: string | null, patch: Partial<CompanyProfile>,
) {
  const { error } = await supabase.from("company_profile").upsert({
    project_id: projectId, workspace_id: workspaceId,
    ...patch, updated_at: new Date().toISOString(), updated_by: userId,
  }, { onConflict: "project_id" });
  if (error) throw error;
}

/** Combien du profil est réellement rempli. Sert l'écran, pas la base : un
 *  pourcentage rend visible qu'un profil à moitié écrit est un contexte à
 *  moitié utile — et donne envie de finir. */
export function profileCompletion(p: CompanyProfile | null): { filled: number; total: number; pct: number } {
  const total = PROFILE_FIELDS.length;
  if (!p) return { filled: 0, total, pct: 0 };
  const filled = PROFILE_FIELDS.filter((f) => String(p[f.key] ?? "").trim().length > 0).length;
  return { filled, total, pct: Math.round((filled / total) * 100) };
}

// ── Objectifs ───────────────────────────────────────────────────────────────

export type ObjectiveStatus = "draft" | "active" | "at_risk" | "done" | "abandoned";
export type ObjectiveDirection = "increase" | "decrease" | "maintain";

export interface CompanyObjective {
  id: string;
  workspace_id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  detail: string | null;
  metric: string | null;
  unit: string | null;
  baseline_value: number | null;
  target_value: number | null;
  current_value: number | null;
  direction: ObjectiveDirection;
  period_start: string | null;
  period_end: string | null;
  status: ObjectiveStatus;
  priority: number;
  owner_dashboard_id: string | null;
  owner_agent_id: string | null;
  measured_at: string | null;
  measured_by: "user" | "agent" | null;
  measured_note: string | null;
}

export const OBJECTIVE_STATUS_LABEL: Record<ObjectiveStatus, string> = {
  draft: "Brouillon", active: "En cours", at_risk: "En risque", done: "Atteint", abandoned: "Abandonné",
};

export async function fetchObjectives(projectId: string): Promise<CompanyObjective[]> {
  const { data } = await supabase.from("company_objectives").select("*")
    .eq("project_id", projectId)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  return (data ?? []) as CompanyObjective[];
}

export async function upsertObjective(row: Partial<CompanyObjective> & { workspace_id: string; project_id: string; title: string }) {
  const { data, error } = await supabase.from("company_objectives")
    .upsert({ ...row, updated_at: new Date().toISOString() })
    .select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function deleteObjective(id: string) {
  const { error } = await supabase.from("company_objectives").delete().eq("id", id);
  if (error) throw error;
}

/** Avancement en %, ou null si l'objectif n'est pas mesuré. Même règle que
 *  côté serveur (company-context.ts) — deux calculs différents pour le même
 *  chiffre, c'est une incohérence qu'on finit toujours par payer. */
export function objectiveProgress(o: CompanyObjective): number | null {
  if (o.target_value == null || o.current_value == null) return null;
  const base = o.baseline_value ?? 0;
  if (o.direction === "maintain") return o.current_value >= o.target_value ? 100 : null;
  const span = o.target_value - base;
  if (span === 0) return o.current_value === o.target_value ? 100 : null;
  return Math.max(0, Math.min(999, Math.round(((o.current_value - base) / span) * 100)));
}

/** L'arbre, dans l'ordre d'affichage (profondeur d'abord). Un objectif dont le
 *  parent a disparu remonte à la racine plutôt que de s'évaporer. */
export function objectiveTree(all: CompanyObjective[]): Array<{ o: CompanyObjective; depth: number }> {
  const byParent = new Map<string | null, CompanyObjective[]>();
  const ids = new Set(all.map((o) => o.id));
  for (const o of all) {
    const key = o.parent_id && ids.has(o.parent_id) ? o.parent_id : null;
    const bucket = byParent.get(key);
    if (bucket) bucket.push(o);
    else byParent.set(key, [o]);
  }
  const out: Array<{ o: CompanyObjective; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const o of byParent.get(parent) ?? []) {
      out.push({ o, depth });
      if (depth < 4) walk(o.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// ── Graphe ──────────────────────────────────────────────────────────────────

export type GraphKind =
  | "company" | "objective" | "service" | "agent" | "room"
  | "mission" | "deliverable" | "connector" | "collection" | "asset";

export interface GraphNode {
  id: string;
  kind: GraphKind;
  label: string | null;
  sublabel: string | null;
  status: string | null;
  ref_id: string;
  dashboard_id: string | null;
  created_at: string;
}

export interface GraphEdge {
  source_id: string;
  target_id: string;
  relation: string;
}

export async function fetchCompanyGraph(projectId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const [{ data: nodes }, { data: edges }] = await Promise.all([
    supabase.from("company_graph_nodes").select("id, kind, label, sublabel, status, ref_id, dashboard_id, created_at")
      .eq("project_id", projectId).limit(1200),
    supabase.from("company_graph_edges").select("source_id, target_id, relation")
      .eq("project_id", projectId).limit(3000),
  ]);
  return { nodes: (nodes ?? []) as GraphNode[], edges: (edges ?? []) as GraphEdge[] };
}

// ── ROI ─────────────────────────────────────────────────────────────────────

export interface RoiSettings {
  project_id: string;
  workspace_id: string;
  default_hourly_rate_eur: number;
  credit_price_eur: number;
  currency: string;
}

export type ValueRuleScope = "agent" | "service" | "deliverable_kind" | "default";

export interface ValueRule {
  id: string;
  workspace_id: string;
  project_id: string;
  label: string;
  scope: ValueRuleScope;
  match_value: string | null;
  minutes_saved: number;
  hourly_rate_eur: number | null;
  revenue_influenced_eur: number;
  active: boolean;
  note: string | null;
}

export interface ValueEvent {
  deliverable_id: string;
  deliverable_name: string;
  deliverable_kind: string;
  occurred_at: string;
  agent_id: string | null;
  agent_name: string | null;
  dashboard_id: string | null;
  rule_id: string | null;
  rule_label: string | null;
  rule_scope: ValueRuleScope | null;
  minutes_saved: number;
  hours_value_eur: number;
  revenue_influenced_eur: number;
  value_eur: number;
}

export interface SpendDay {
  day: string;
  credits: number;
  spend_eur: number;
}

export async function fetchRoi(projectId: string, sinceIso: string) {
  const [{ data: settings }, { data: rules }, { data: events }, { data: spend }] = await Promise.all([
    supabase.from("company_roi_settings").select("*").eq("project_id", projectId).maybeSingle(),
    supabase.from("company_value_rules").select("*").eq("project_id", projectId).order("scope"),
    supabase.from("company_value_events").select("*")
      .eq("project_id", projectId).gte("occurred_at", sinceIso)
      .order("occurred_at", { ascending: false }).limit(500),
    supabase.from("company_ai_spend_daily").select("day, credits, spend_eur")
      .eq("project_id", projectId).gte("day", sinceIso.slice(0, 10))
      .order("day", { ascending: true }),
  ]);
  return {
    settings: (settings as RoiSettings | null) ?? null,
    rules: (rules ?? []) as ValueRule[],
    events: (events ?? []) as ValueEvent[],
    spend: (spend ?? []) as SpendDay[],
  };
}

export async function saveRoiSettings(projectId: string, workspaceId: string, patch: Partial<RoiSettings>) {
  const { error } = await supabase.from("company_roi_settings").upsert({
    project_id: projectId, workspace_id: workspaceId, ...patch, updated_at: new Date().toISOString(),
  }, { onConflict: "project_id" });
  if (error) throw error;
}

export async function upsertValueRule(row: Partial<ValueRule> & { workspace_id: string; project_id: string; label: string }) {
  const { error } = await supabase.from("company_value_rules")
    .upsert({ ...row, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function deleteValueRule(id: string) {
  const { error } = await supabase.from("company_value_rules").delete().eq("id", id);
  if (error) throw error;
}

/** Le calcul du ROI, en un endroit. Volontairement transparent : chaque nombre
 *  affiché doit pouvoir se retracer jusqu'à la règle et au livrable qui l'ont
 *  produit, sinon personne n'y croit. */
export function summariseRoi(events: ValueEvent[], spend: SpendDay[]) {
  const value = events.reduce((n, e) => n + Number(e.value_eur ?? 0), 0);
  const hours = events.reduce((n, e) => n + Number(e.minutes_saved ?? 0), 0) / 60;
  const revenue = events.reduce((n, e) => n + Number(e.revenue_influenced_eur ?? 0), 0);
  const cost = spend.reduce((n, d) => n + Number(d.spend_eur ?? 0), 0);
  const credits = spend.reduce((n, d) => n + Number(d.credits ?? 0), 0);
  const unpriced = events.filter((e) => !e.rule_id).length;
  return {
    value, hours, revenue, cost, credits, unpriced,
    net: value - cost,
    // Un ROI sans dépense n'est pas « infini », il n'est pas calculable — et
    // afficher ∞ le premier jour décrédibilise tout l'écran.
    ratio: cost > 0 ? value / cost : null,
    events: events.length,
  };
}

export const eur = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
