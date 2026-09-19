import { supabase } from "@/lib/supabase";
import { loadWorkspaceMembers } from "@/features/internal-agents/shared";
import { callEdge } from "@/lib/edge";

/**
 * Couche d'accès au suivi de travail (schéma `pj_*`, migration 0221), calquée
 * sur le modèle de Plane.
 *
 * Un principe traverse tout ce fichier : les listes se lisent en UNE requête.
 * Un board affiche couramment 200 items, chacun avec ses assignés et ses
 * labels ; aller les chercher item par item, c'est 400 requêtes et un écran qui
 * se peuple par à-coups. On tire donc les tables de liaison en bloc et on
 * recolle en mémoire (voir `attachRelations`).
 */

export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";
export type Priority = "urgent" | "high" | "medium" | "low" | "none";

/**
 * L'ordre est celui de Plane : c'est celui dans lequel un board se lit.
 *
 * Les couleurs sont celles de Plane (`--txt-icon-states-*` de propel), et elles
 * ne sont pas les teintes saturées qu'on choisirait spontanément. Backlog et
 * « à faire » sont deux GRIS — l'un un peu plus clair que l'autre — parce que
 * du travail qui n'a pas commencé ne mérite pas de couleur : sur un board de
 * cent lignes, colorer les deux tiers inertes noie les deux seuls états qui
 * demandent une action. Seuls « en cours » (ambre) et « terminé » (vert)
 * portent une vraie teinte.
 */
export const STATE_GROUPS: { key: StateGroup; label: string; color: string }[] = [
  { key: "backlog", label: "Backlog", color: "#8b8f99" },
  { key: "unstarted", label: "À faire", color: "#6b7180" },
  { key: "started", label: "En cours", color: "#eda100" },
  { key: "completed", label: "Terminé", color: "#3e9b4f" },
  { key: "cancelled", label: "Annulé", color: "#8c8fa4" },
];

/** Urgent d'abord : une file de priorités se lit du plus brûlant au reste. */
export const PRIORITIES: { key: Priority; label: string; color: string }[] = [
  { key: "urgent", label: "Urgent", color: "#dc2626" },
  { key: "high", label: "Haute", color: "#ea580c" },
  { key: "medium", label: "Moyenne", color: "#d97706" },
  { key: "low", label: "Basse", color: "#2563eb" },
  { key: "none", label: "Aucune", color: "#9ca3af" },
];

export const RELATION_TYPES = [
  "relates_to", "duplicate", "blocked_by", "blocks",
  "start_before", "start_after", "finish_before", "finish_after",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * Poser « A bloque B » doit écrire « B est bloqué par A ». Sans cette table de
 * symétries, l'item d'en face ignorerait la relation jusqu'à ce que quelqu'un
 * pense à la saisir des deux côtés.
 */
export const INVERSE_RELATION: Record<RelationType, RelationType> = {
  relates_to: "relates_to",
  duplicate: "duplicate",
  blocked_by: "blocks",
  blocks: "blocked_by",
  start_before: "start_after",
  start_after: "start_before",
  finish_before: "finish_after",
  finish_after: "finish_before",
};

export const RELATION_LABEL: Record<RelationType, string> = {
  relates_to: "En rapport avec",
  duplicate: "Doublon de",
  blocked_by: "Bloqué par",
  blocks: "Bloque",
  start_before: "Démarre avant",
  start_after: "Démarre après",
  finish_before: "Finit avant",
  finish_after: "Finit après",
};

// ── Types ───────────────────────────────────────────────────────────────────

export interface PjProject {
  id: string;
  workspace_id: string;
  project_id: string;
  dashboard_id: string | null;
  name: string;
  identifier: string;
  description: string | null;
  /** Format Plane : `{ in_use: "emoji", emoji: { value: "🚀" } }`. Volontairement
   *  ouvert — Plane y range aussi des icônes, et un type fermé casserait à la
   *  première valeur importée qu'on n'avait pas prévue. */
  logo_props: Record<string, unknown>;
  cover_image: string | null;
  network: 0 | 2;
  lead_id: string | null;
  start_date: string | null;
  target_date: string | null;
  cycle_view: boolean;
  module_view: boolean;
  issue_views_view: boolean;
  page_view: boolean;
  intake_view: boolean;
  archived_at: string | null;
  /** Entretien automatique (0222). 0 = jamais ; sinon un délai en mois. */
  archive_in: number;
  close_in: number;
  /** Santé déclarée (0224). Null tant que personne ne s'est prononcé — ce qui
   *  n'est pas la même chose que « on track ». */
  health: "on_track" | "at_risk" | "off_track" | null;
  health_updated_at: string | null;
  /** Le document de l'Overview (arbre Plate, 0230). `description` en est le
   *  rendu texte : recherche et cartes projet lisent celui-là. */
  description_rich: unknown;
  enforce_transitions: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PjState {
  id: string;
  pj_project_id: string;
  workspace_id: string;
  name: string;
  description: string;
  color: string;
  group: StateGroup;
  sequence: number;
  is_default: boolean;
  is_triage: boolean;
}

export interface PjLabel {
  id: string;
  pj_project_id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  color: string;
  sort_order: number;
}

export interface PjEstimatePoint {
  id: string;
  estimate_id: string;
  key: number;
  value: string;
  sort_order: number;
}

export interface PjEstimate {
  id: string;
  pj_project_id: string;
  name: string;
  description: string;
  type: "points" | "categories" | "time";
  is_active: boolean;
  points?: PjEstimatePoint[];
}

export interface PjIssueType {
  id: string;
  pj_project_id: string;
  name: string;
  description: string;
  logo_props: Record<string, unknown>;
  /** Ajoutés en 0223 : sans eux un type ne se distingue pas d'un label. */
  color: string;
  icon: string;
  is_active: boolean;
  is_default: boolean;
  sort_order: number;
}

export interface PjIssue {
  /**
   * Le travail à faire, adressé à l'AGENT (0242).
   *
   * Séparé de la description, qui s'adresse à l'équipe. L'une dit le contexte,
   * l'autre la commande ; les confondre obligerait soit à écrire une
   * description en langage d'instructions, soit à laisser l'agent deviner sa
   * tâche dans un texte qui ne lui est pas destiné.
   */
  agent_brief?: string | null;
  /** L'autorisation de démarrer seul, à l'échéance de la planification. */
  agent_autorun?: boolean;
  agent_last_run_at?: string | null;
  id: string;
  pj_project_id: string;
  workspace_id: string;
  sequence_id: number;
  name: string;
  description_html: string;
  description_text: string;
  priority: Priority;
  state_id: string | null;
  parent_id: string | null;
  estimate_point_id: string | null;
  type_id: string | null;
  start_date: string | null;
  target_date: string | null;
  completed_at: string | null;
  sort_order: number;
  is_draft: boolean;
  /** Marque un epic : un work item qui en porte d'autres (0224). */
  is_epic: boolean;
  archived_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;

  /** Recollés en mémoire par `attachRelations`, jamais lus colonne par colonne. */
  assignee_ids: string[];
  /** Les agents assignés (0232), lus à côté des personnes. */
  agent_ids: string[];
  label_ids: string[];
  cycle_id: string | null;
  module_ids: string[];
  sub_issue_count: number;
  attachment_count: number;
  link_count: number;
}

export interface PjCycle {
  id: string;
  pj_project_id: string;
  workspace_id: string;
  name: string;
  description: string;
  start_date: string | null;
  end_date: string | null;
  owned_by: string | null;
  sort_order: number;
  progress_snapshot: Record<string, unknown>;
  archived_at: string | null;
  created_at: string;
}

/** Le statut d'un module est DÉCLARÉ, contrairement à la phase d'un cycle qui se
 *  déduit de ses dates : un module peut être en pause sans que ses dates le
 *  disent. */
export type ModuleStatus =
  | "backlog" | "planned" | "in-progress" | "paused" | "completed" | "cancelled";

export interface PjModule {
  id: string;
  pj_project_id: string;
  workspace_id: string;
  name: string;
  description: string;
  status: ModuleStatus;
  start_date: string | null;
  target_date: string | null;
  lead_id: string | null;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
}

export interface PjView {
  id: string;
  pj_project_id: string | null;
  dashboard_id: string | null;
  workspace_id: string;
  name: string;
  description: string;
  logo_props: Record<string, unknown>;
  filters: Record<string, unknown>;
  display_filters: Record<string, unknown>;
  display_properties: Record<string, unknown>;
  access: 0 | 1;
  owned_by: string | null;
  sort_order: number;
}

export interface PjPage {
  /** La source de l'éditeur riche (0228) ; `description_html` en est le rendu,
   *  qui sert aux exports et à la recherche mais jamais à recharger l'éditeur. */
  description_rich?: unknown[] | null;
  description_text?: string | null;
  id: string;
  pj_project_id: string | null;
  dashboard_id: string | null;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  description_html: string;
  color: string | null;
  logo_props: Record<string, unknown>;
  access: 0 | 1;
  owned_by: string | null;
  is_locked: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PjComment {
  id: string;
  issue_id: string;
  actor_id: string | null;
  comment_html: string;
  agent_id: string | null;
  agent_name: string | null;
  edited_at: string | null;
  created_at: string;
}

export interface PjActivity {
  id: number;
  issue_id: string;
  actor_id: string | null;
  verb: "created" | "updated" | "deleted";
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  comment: string;
  created_at: string;
}

export interface PjRelation {
  id: string;
  issue_id: string;
  related_id: string;
  relation_type: RelationType;
}

export interface PjAttachment {
  id: string;
  issue_id: string;
  storage_path: string;
  name: string;
  size_bytes: number;
  mime_type: string | null;
  created_by: string | null;
  created_at: string;
}

export interface PjIntakeItem {
  id: string;
  pj_project_id: string;
  issue_id: string;
  status: -2 | -1 | 0 | 1 | 2;
  snoozed_till: string | null;
  duplicate_to: string | null;
  source: string;
  created_at: string;
}

export interface Member {
  user_id: string;
  full_name: string | null;
  email: string | null;
}

// ── Projets ─────────────────────────────────────────────────────────────────

/**
 * `*` et non la liste des colonnes, délibérément.
 *
 * Le schéma grandit par migrations successives (0221 → 0224), et une base où
 * la dernière n'est pas encore appliquée n'a pas `health` ni
 * `enforce_transitions`. Nommer les colonnes fait alors répondre 400 à la
 * requête ENTIÈRE : plus de projets, donc plus rien du tout — un onglet vide
 * pour une colonne manquante. Avec `*`, les champs absents arrivent
 * `undefined` et l'écran fonctionne en mode dégradé, ce qui est le
 * comportement voulu. (Même raisonnement que `useDashboardAgents`.)
 */
const PROJECT_COLS = "*";

export async function fetchProjects(dashboardId: string): Promise<PjProject[]> {
  const { data, error } = await supabase
    .from("pj_projects").select(PROJECT_COLS)
    .eq("dashboard_id", dashboardId)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PjProject[];
}

export async function fetchProject(id: string): Promise<PjProject | null> {
  const { data } = await supabase.from("pj_projects").select(PROJECT_COLS).eq("id", id).maybeSingle();
  return (data as PjProject) ?? null;
}

/**
 * L'identifiant est dérivé du nom quand l'utilisateur ne le saisit pas : lui
 * demander un code court AVANT de l'avoir laissé nommer son projet, c'est une
 * question à laquelle personne ne sait répondre.
 */
export function deriveIdentifier(name: string): string {
  const cleaned = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  const words = cleaned.split(/[^A-Z0-9]+/).filter(Boolean);
  if (!words.length) return "PROJ";
  const code = words.length === 1 ? words[0].slice(0, 5) : words.map((w) => w[0]).join("").slice(0, 5);
  return code.slice(0, 12) || "PROJ";
}

export async function createProject(input: {
  workspaceId: string; projectId: string; dashboardId: string;
  name: string; identifier: string; description?: string;
  logo_props?: Record<string, unknown>;
  /** 2 = ouvert à l'espace (défaut), 0 = privé. Valeurs de Plane. */
  network?: 0 | 2;
  createdBy: string | null;
}): Promise<PjProject> {
  const { data, error } = await supabase.from("pj_projects").insert({
    workspace_id: input.workspaceId,
    project_id: input.projectId,
    dashboard_id: input.dashboardId,
    name: input.name,
    identifier: input.identifier,
    description: input.description ?? null,
    logo_props: input.logo_props ?? {},
    network: input.network ?? 2,
    created_by: input.createdBy,
  }).select(PROJECT_COLS).single();
  if (error) throw new Error(error.message);
  // Le créateur est membre de son projet : sans cette ligne il n'apparaît pas
  // dans son propre sélecteur d'assignés.
  if (input.createdBy) {
    await supabase.from("pj_project_members").insert({
      pj_project_id: (data as PjProject).id, workspace_id: input.workspaceId,
      user_id: input.createdBy, role: 20,
    });
  }
  return data as PjProject;
}

export async function updateProject(id: string, patch: Partial<PjProject>): Promise<void> {
  const { error } = await supabase.from("pj_projects")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from("pj_projects").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Référentiels du projet ──────────────────────────────────────────────────

export async function fetchStates(pjProjectId: string): Promise<PjState[]> {
  const { data, error } = await supabase
    .from("pj_states")
    .select("id, pj_project_id, workspace_id, name, description, color, group, sequence, is_default, is_triage")
    .eq("pj_project_id", pjProjectId).order("sequence", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PjState[];
}

export async function fetchLabels(pjProjectId: string): Promise<PjLabel[]> {
  const { data, error } = await supabase
    .from("pj_labels").select("id, pj_project_id, workspace_id, parent_id, name, color, sort_order")
    .eq("pj_project_id", pjProjectId).order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PjLabel[];
}

export async function fetchEstimates(pjProjectId: string): Promise<PjEstimate[]> {
  const { data } = await supabase
    .from("pj_estimates")
    .select("id, pj_project_id, name, description, type, is_active, points:pj_estimate_points(id, estimate_id, key, value, sort_order)")
    .eq("pj_project_id", pjProjectId);
  return ((data ?? []) as PjEstimate[]).map((e) => ({
    ...e, points: (e.points ?? []).slice().sort((a, b) => a.key - b.key),
  }));
}

export async function fetchIssueTypes(pjProjectId: string): Promise<PjIssueType[]> {
  const { data } = await supabase
    .from("pj_issue_types")
    .select("id, pj_project_id, name, description, logo_props, color, icon, is_active, is_default, sort_order")
    .eq("pj_project_id", pjProjectId).eq("is_active", true).order("sort_order");
  return (data ?? []) as PjIssueType[];
}

/**
 * Les membres de l'espace, pour les sélecteurs d'assignés. On réutilise le
 * chargeur existant plutôt que de reposer la même jointure : elle a une
 * subtilité (le nom de la contrainte dans l'alias `profiles!…`) qu'il vaut
 * mieux ne corriger qu'à un seul endroit le jour où il change.
 */
export async function fetchMembers(workspaceId: string): Promise<Member[]> {
  const rows = await loadWorkspaceMembers(workspaceId);
  return rows.map((r) => ({ user_id: r.user_id, full_name: r.full_name, email: r.email }));
}

export async function createState(input: {
  pjProjectId: string; workspaceId: string; name: string; color: string; group: StateGroup;
}): Promise<void> {
  // La séquence place le nouvel état à la fin de SON groupe, pas à la fin de la
  // liste : un « En revue » créé après « Terminé » doit se ranger avant lui.
  const existing = await fetchStates(input.pjProjectId);
  const groupIndex = STATE_GROUPS.findIndex((g) => g.key === input.group);
  const inGroup = existing.filter((s) => s.group === input.group);
  const sequence = inGroup.length
    ? Math.max(...inGroup.map((s) => s.sequence)) + 1000
    : (groupIndex + 1) * 10000 + 5000;
  const { error } = await supabase.from("pj_states").insert({
    pj_project_id: input.pjProjectId, workspace_id: input.workspaceId,
    name: input.name, color: input.color, group: input.group, sequence,
  });
  if (error) throw new Error(error.message);
}

export async function updateState(id: string, patch: Partial<PjState>): Promise<void> {
  const { error } = await supabase.from("pj_states").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteState(id: string): Promise<void> {
  const { error } = await supabase.from("pj_states").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function createLabel(input: {
  pjProjectId: string; workspaceId: string; name: string; color: string;
}): Promise<PjLabel> {
  const { data, error } = await supabase.from("pj_labels").insert({
    pj_project_id: input.pjProjectId, workspace_id: input.workspaceId,
    name: input.name, color: input.color,
  }).select("id, pj_project_id, workspace_id, parent_id, name, color, sort_order").single();
  if (error) throw new Error(error.message);
  return data as PjLabel;
}

export async function updateLabel(id: string, patch: Partial<PjLabel>): Promise<void> {
  const { error } = await supabase.from("pj_labels").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteLabel(id: string): Promise<void> {
  const { error } = await supabase.from("pj_labels").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Work items ──────────────────────────────────────────────────────────────

const ISSUE_COLS =
  // `*` : `is_epic` n'existe qu'après 0224, et nommer les colonnes ferait
  // répondre 400 à la requête entière sur une base où elle n'est pas appliquée.
  "*";

type RawIssue = Omit<PjIssue,
  "assignee_ids" | "label_ids" | "cycle_id" | "module_ids" | "sub_issue_count" | "attachment_count" | "link_count">;

/**
 * Recolle les liaisons d'un lot d'items en 5 requêtes constantes, quel que soit
 * le nombre d'items. C'est ce qui permet à un board de 300 cartes de s'afficher
 * d'un coup plutôt que ligne à ligne.
 */
async function attachRelations(rows: RawIssue[]): Promise<PjIssue[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  const [assignees, agents, labels, cycles, modules, children, attachments] = await Promise.all([
    supabase.from("pj_issue_assignees").select("issue_id, user_id").in("issue_id", ids),
    // Les agents voyagent AVEC les personnes, dans le même aller-retour : les
    // charger à part doublerait le nombre de requêtes d'un board pour une
    // information qui s'affiche sur la même ligne.
    supabase.from("pj_issue_agents").select("issue_id, agent_id").in("issue_id", ids),
    supabase.from("pj_issue_labels").select("issue_id, label_id").in("issue_id", ids),
    supabase.from("pj_cycle_issues").select("issue_id, cycle_id").in("issue_id", ids),
    supabase.from("pj_module_issues").select("issue_id, module_id").in("issue_id", ids),
    supabase.from("pj_issues").select("parent_id").in("parent_id", ids),
    supabase.from("pj_issue_attachments").select("issue_id").in("issue_id", ids),
  ]);

  const group = <T, K extends keyof T>(rowsIn: T[] | null, key: K, val: keyof T) => {
    const map = new Map<string, string[]>();
    for (const r of rowsIn ?? []) {
      const k = String(r[key]);
      const arr = map.get(k);
      if (arr) arr.push(String(r[val])); else map.set(k, [String(r[val])]);
    }
    return map;
  };

  const byAssignee = group(assignees.data as Array<{ issue_id: string; user_id: string }> | null, "issue_id", "user_id");
  const byAgent = group(agents.data as Array<{ issue_id: string; agent_id: string }> | null, "issue_id", "agent_id");
  const byLabel = group(labels.data as Array<{ issue_id: string; label_id: string }> | null, "issue_id", "label_id");
  const byModule = group(modules.data as Array<{ issue_id: string; module_id: string }> | null, "issue_id", "module_id");
  const cycleOf = new Map((cycles.data ?? []).map((r: { issue_id: string; cycle_id: string }) => [r.issue_id, r.cycle_id]));

  const childCount = new Map<string, number>();
  for (const r of (children.data ?? []) as Array<{ parent_id: string | null }>) {
    if (r.parent_id) childCount.set(r.parent_id, (childCount.get(r.parent_id) ?? 0) + 1);
  }
  const attachCount = new Map<string, number>();
  for (const r of (attachments.data ?? []) as Array<{ issue_id: string }>) {
    attachCount.set(r.issue_id, (attachCount.get(r.issue_id) ?? 0) + 1);
  }

  return rows.map((r) => ({
    ...r,
    assignee_ids: byAssignee.get(r.id) ?? [],
    agent_ids: byAgent.get(r.id) ?? [],
    label_ids: byLabel.get(r.id) ?? [],
    cycle_id: cycleOf.get(r.id) ?? null,
    module_ids: byModule.get(r.id) ?? [],
    sub_issue_count: childCount.get(r.id) ?? 0,
    attachment_count: attachCount.get(r.id) ?? 0,
    link_count: 0,
  }));
}

export interface IssueScope {
  pjProjectId: string;
  /** Restreint aux items d'un cycle / d'un module / de la file d'intake. */
  cycleId?: string;
  moduleId?: string;
  intake?: boolean;
  includeArchived?: boolean;
  includeDrafts?: boolean;
  /** Les sous-tâches d'un item donné, pour l'arbre du panneau de détail. */
  parentId?: string;
  /** Ne renvoyer QUE les epics. Par défaut ils sont exclus : ils ont leur
   *  propre onglet, et les mêler aux work items compterait leur avancement
   *  deux fois. */
  onlyEpics?: boolean;
}

export async function fetchIssues(scope: IssueScope): Promise<PjIssue[]> {
  let ids: string[] | null = null;

  // Cycle et module passent par leur table de liaison : filtrer côté client
  // ferait tirer tout le projet pour n'en afficher qu'une itération.
  if (scope.cycleId) {
    const { data } = await supabase.from("pj_cycle_issues").select("issue_id").eq("cycle_id", scope.cycleId);
    ids = (data ?? []).map((r: { issue_id: string }) => r.issue_id);
  }
  if (scope.moduleId) {
    const { data } = await supabase.from("pj_module_issues").select("issue_id").eq("module_id", scope.moduleId);
    const modIds = (data ?? []).map((r: { issue_id: string }) => r.issue_id);
    ids = ids ? ids.filter((i) => modIds.includes(i)) : modIds;
  }
  if (ids && !ids.length) return [];

  let q = supabase.from("pj_issues").select(ISSUE_COLS).eq("pj_project_id", scope.pjProjectId);
  if (ids) q = q.in("id", ids);
  if (!scope.includeArchived) q = q.is("archived_at", null);
  if (!scope.includeDrafts) q = q.eq("is_draft", false);
  if (scope.parentId !== undefined) q = q.eq("parent_id", scope.parentId);

  const { data, error } = await q.order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);

  // Les epics ont leur propre onglet : les laisser dans la liste des work items
  // mélangerait deux niveaux et compterait leur avancement deux fois. Le filtre
  // est côté client et non en `.eq("is_epic", false)` parce que la colonne
  // n'existe qu'après 0224 — absente, la valeur est `undefined`, donc fausse, et
  // tout s'affiche comme avant plutôt que de faire échouer la requête.
  const wantEpics = scope.onlyEpics === true;
  const rows = ((data ?? []) as RawIssue[]).filter((r) => Boolean(r.is_epic) === wantEpics);
  return attachRelations(rows);
}

export async function fetchIssue(id: string): Promise<PjIssue | null> {
  const { data } = await supabase.from("pj_issues").select(ISSUE_COLS).eq("id", id).maybeSingle();
  if (!data) return null;
  const [full] = await attachRelations([data as RawIssue]);
  return full ?? null;
}

export interface CreateIssueInput {
  pjProjectId: string;
  workspaceId: string;
  name: string;
  description_html?: string;
  description_text?: string;
  priority?: Priority;
  state_id?: string | null;
  parent_id?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  estimate_point_id?: string | null;
  type_id?: string | null;
  assignee_ids?: string[];
  label_ids?: string[];
  cycle_id?: string | null;
  module_ids?: string[];
  is_draft?: boolean;
  /** Un epic est un work item marqué, pas une entité à part (0224). */
  is_epic?: boolean;
  sort_order?: number;
  createdBy: string | null;
}

export async function createIssue(input: CreateIssueInput): Promise<PjIssue> {
  // Sans état explicite, on prend celui marqué par défaut. Un item créé sans
  // état n'apparaîtrait dans aucune colonne d'un board groupé par état.
  let stateId = input.state_id ?? null;
  if (!stateId) {
    const { data } = await supabase.from("pj_states").select("id")
      .eq("pj_project_id", input.pjProjectId).eq("is_default", true).maybeSingle();
    stateId = (data as { id: string } | null)?.id ?? null;
  }

  const { data, error } = await supabase.from("pj_issues").insert({
    pj_project_id: input.pjProjectId,
    workspace_id: input.workspaceId,
    name: input.name,
    description_html: input.description_html ?? "",
    description_text: input.description_text ?? "",
    priority: input.priority ?? "none",
    state_id: stateId,
    parent_id: input.parent_id ?? null,
    start_date: input.start_date ?? null,
    target_date: input.target_date ?? null,
    estimate_point_id: input.estimate_point_id ?? null,
    type_id: input.type_id ?? null,
    is_draft: input.is_draft ?? false,
    is_epic: input.is_epic ?? false,
    sort_order: input.sort_order ?? 65535,
    created_by: input.createdBy,
    updated_by: input.createdBy,
  }).select(ISSUE_COLS).single();
  if (error) throw new Error(error.message);

  // Aucune écriture d'activité ici : depuis la migration 0222, un trigger
  // journalise la création et chaque liaison posée ci-dessous. Les émettre
  // aussi depuis le client produirait deux lignes pour un seul évènement.
  const issue = data as RawIssue;
  await Promise.all([
    setAssignees(issue.id, input.pjProjectId, input.workspaceId, input.assignee_ids ?? []),
    setLabels(issue.id, input.pjProjectId, input.workspaceId, input.label_ids ?? []),
    input.cycle_id ? setIssueCycle(issue.id, input.workspaceId, input.cycle_id) : Promise.resolve(),
    setIssueModules(issue.id, input.workspaceId, input.module_ids ?? []),
  ]);

  const [full] = await attachRelations([issue]);
  return full;
}

export async function updateIssue(
  id: string,
  patch: Partial<Omit<PjIssue, "assignee_ids" | "label_ids" | "cycle_id" | "module_ids">>,
  actorId?: string | null,
): Promise<void> {
  const { error } = await supabase.from("pj_issues")
    .update({ ...patch, updated_by: actorId ?? null, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteIssue(id: string): Promise<void> {
  const { error } = await supabase.from("pj_issues").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function archiveIssue(id: string, archived: boolean): Promise<void> {
  await supabase.from("pj_issues")
    .update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id);
}

/**
 * Remplace intégralement une liaison n-n. L'écriture différentielle (calculer
 * ajouts et retraits) serait plus économe, mais elle laisse passer des états
 * incohérents dès que deux onglets modifient le même item ; ici le résultat est
 * exactement ce que l'écran affiche.
 */
async function replaceLinks(
  table: string, issueId: string, rows: Record<string, unknown>[],
): Promise<void> {
  await supabase.from(table).delete().eq("issue_id", issueId);
  if (rows.length) await supabase.from(table).insert(rows);
}

export async function setAssignees(
  issueId: string, pjProjectId: string, workspaceId: string, userIds: string[],
): Promise<void> {
  await replaceLinks("pj_issue_assignees", issueId, userIds.map((user_id) => ({
    issue_id: issueId, pj_project_id: pjProjectId, workspace_id: workspaceId, user_id,
  })));
}

// ── Agents ──────────────────────────────────────────────────────────────────
//
// Un agent s'assigne comme une personne. C'est le point de tout le dispositif :
// tant que le travail d'un agent restait dans un fil de conversation, personne
// ne pouvait dire ce qu'il portait ni où il en était. Sur le board, il apparaît
// à côté des humains, sur la même ligne, avec le même vocabulaire.

export interface TrackerAgent {
  id: string;
  name: string;
  /** Le tableau de service auquel il est rattaché, s'il y en a un. */
  service_dashboard_id?: string | null;
  avatar_emoji: string | null;
  /** Le portrait généré. C'est lui que porte la plupart des agents : la
   *  création du produit ne renseigne pas d'emoji. */
  avatar_url: string | null;
  accent_color: string | null;
}

/**
 * Les agents du service, ceux qu'on peut mettre sur du travail.
 *
 * Le filtre est is_archived, PAS status. La distinction a son importance :
 * la création d'agent du produit n'écrit pas de statut, donc tout agent cree
 * normalement reste en « draft ». Filtrer sur « active » vidait la liste de
 * tous les agents existants — la seule chose que ce filtre excluait, c'était
 * l'intégralité du contenu.
 *
 * is_archived est le drapeau que le reste de l'application emploie, et il dit
 * la bonne chose : un agent archivé ne reçoit plus de travail, un brouillon si
 * — c'est même souvent en lui confiant une tâche qu'on finit de le régler.
 */
export async function fetchTrackerAgents(
  dashboardId: string | null,
  workspaceId?: string | null,
): Promise<TrackerAgent[]> {
  // `status` est volontairement absent : `internal_agents` n'a pas cette
  // colonne. Le `status text` de la migration 0025 appartient à
  // `internal_agent_missions`, déclarée juste après dans le même fichier — et
  // la demander ici faisait échouer la requête ENTIÈRE, ce qui explique le
  // sélecteur d'agents obstinément vide. Le cycle de vie se lit sur
  // `is_archived`, plus bas.
  const COLS = "id, name, avatar_emoji, avatar_url, accent_color, service_dashboard_id";

  if (dashboardId) {
    const { data, error } = await supabase.from("internal_agents")
      .select(COLS)
      .eq("service_dashboard_id", dashboardId)
      .eq("is_archived", false)
      .order("name");
    if (error) throw new Error(error.message);
    if (data?.length) return data as TrackerAgent[];
  }

  // REPLI : TOUS les agents du workspace, quel que soit leur tableau.
  //
  // Le premier repli ne rattrapait que les agents SANS tableau, ce qui laissait
  // passer le cas le plus courant : des agents rattachés à un AUTRE tableau que
  // celui d'où l'on regarde. Le résultat était le pire des messages — « aucun
  // agent dans ce service » à quelqu'un qui en voit dix dans son roster, ce qui
  // fait douter de ses yeux plutôt que de la requête.
  //
  // Montrer large et laisser choisir vaut mieux que masquer juste : un agent
  // qu'on n'aurait pas dû proposer se voit au moment de l'assigner, un agent
  // introuvable ne se voit jamais.
  const ws = workspaceId ?? await (async () => {
    if (!dashboardId) return null;
    const { data } = await supabase.from("service_dashboards")
      .select("workspace_id").eq("id", dashboardId).maybeSingle();
    return (data as { workspace_id?: string } | null)?.workspace_id ?? null;
  })();
  if (!ws) return [];

  const { data: all, error: wsError } = await supabase.from("internal_agents")
    .select(COLS)
    .eq("workspace_id", ws)
    .eq("is_archived", false)
    .order("name");
  if (wsError) throw new Error(wsError.message);
  return (all ?? []) as TrackerAgent[];
}

/**
 * Confie PLUSIEURS work items à un agent, en une écriture.
 *
 * On AJOUTE l'agent, on ne remplace pas les assignés existants : confier une
 * série de tâches à une machine ne doit pas en retirer silencieusement la
 * personne qui les suivait. Un item déjà confié à cet agent est ignoré plutôt
 * que de faire échouer tout le lot sur la contrainte d'unicité.
 */
export async function bulkAssignAgent(input: {
  issueIds: string[]; agentId: string; workspaceId: string; assignedBy: string | null;
}): Promise<void> {
  if (!input.issueIds.length) return;
  const { error } = await supabase.from("pj_issue_agents").upsert(
    input.issueIds.map((issue_id) => ({
      issue_id, agent_id: input.agentId,
      workspace_id: input.workspaceId, assigned_by: input.assignedBy,
    })),
    { onConflict: "issue_id,agent_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
}

export async function setIssueAgents(
  issueId: string, workspaceId: string, agentIds: string[], assignedBy: string | null,
): Promise<void> {
  await replaceLinks("pj_issue_agents", issueId, agentIds.map((agent_id) => ({
    issue_id: issueId, workspace_id: workspaceId, agent_id, assigned_by: assignedBy,
  })));
}

/** Le périmètre d'un agent : les projets où il a le droit d'agir. */
export async function fetchProjectAgents(pjProjectId: string): Promise<
  Array<{ agent_id: string; role: string }>
> {
  const { data } = await supabase.from("pj_project_agents")
    .select("agent_id, role").eq("pj_project_id", pjProjectId);
  return (data ?? []) as Array<{ agent_id: string; role: string }>;
}

export async function setProjectAgents(
  pjProjectId: string, workspaceId: string,
  entries: Array<{ agent_id: string; role: "contributor" | "observer" }>,
): Promise<void> {
  await supabase.from("pj_project_agents").delete().eq("pj_project_id", pjProjectId);
  if (!entries.length) return;
  await supabase.from("pj_project_agents").insert(
    entries.map((e) => ({
      pj_project_id: pjProjectId, workspace_id: workspaceId,
      agent_id: e.agent_id, role: e.role,
    })),
  );
}

/** La file de travail d'un agent (0232). */
export async function fetchAgentWork(agentId: string): Promise<MyWorkRow[]> {
  const { data } = await supabase.rpc("pj_agent_work", { p_agent: agentId });
  return (data ?? []) as MyWorkRow[];
}

export async function setLabels(
  issueId: string, pjProjectId: string, workspaceId: string, labelIds: string[],
): Promise<void> {
  await replaceLinks("pj_issue_labels", issueId, labelIds.map((label_id) => ({
    issue_id: issueId, pj_project_id: pjProjectId, workspace_id: workspaceId, label_id,
  })));
}

export async function setIssueCycle(
  issueId: string, workspaceId: string, cycleId: string | null,
): Promise<void> {
  await supabase.from("pj_cycle_issues").delete().eq("issue_id", issueId);
  if (cycleId) {
    await supabase.from("pj_cycle_issues").insert({ issue_id: issueId, cycle_id: cycleId, workspace_id: workspaceId });
  }
}

export async function setIssueModules(
  issueId: string, workspaceId: string, moduleIds: string[],
): Promise<void> {
  await replaceLinks("pj_module_issues", issueId, moduleIds.map((module_id) => ({
    issue_id: issueId, module_id, workspace_id: workspaceId,
  })));
}

// ── Relations, commentaires, activité, pièces jointes ────────────────────────

export async function fetchRelations(issueId: string): Promise<PjRelation[]> {
  const { data } = await supabase.from("pj_issue_relations")
    .select("id, issue_id, related_id, relation_type").eq("issue_id", issueId);
  return (data ?? []) as PjRelation[];
}

export async function addRelation(input: {
  issueId: string; relatedId: string; workspaceId: string;
  type: RelationType; createdBy: string | null;
}): Promise<void> {
  const { error } = await supabase.from("pj_issue_relations").insert([
    {
      issue_id: input.issueId, related_id: input.relatedId, workspace_id: input.workspaceId,
      relation_type: input.type, created_by: input.createdBy,
    },
    // Le miroir, sans quoi l'item d'en face ignore la relation.
    {
      issue_id: input.relatedId, related_id: input.issueId, workspace_id: input.workspaceId,
      relation_type: INVERSE_RELATION[input.type], created_by: input.createdBy,
    },
  ]);
  if (error) throw new Error(error.message);
}

export async function removeRelation(issueId: string, relatedId: string): Promise<void> {
  // Les deux sens partent ensemble : n'en retirer qu'un laisserait une relation
  // visible d'un seul côté, ce qui est pire que pas de relation du tout.
  await supabase.from("pj_issue_relations").delete().eq("issue_id", issueId).eq("related_id", relatedId);
  await supabase.from("pj_issue_relations").delete().eq("issue_id", relatedId).eq("related_id", issueId);
}

export async function fetchComments(issueId: string): Promise<PjComment[]> {
  const { data } = await supabase.from("pj_issue_comments")
    .select("id, issue_id, actor_id, comment_html, agent_id, agent_name, edited_at, created_at")
    .eq("issue_id", issueId).order("created_at", { ascending: true });
  return (data ?? []) as PjComment[];
}

export async function addComment(input: {
  issueId: string; pjProjectId: string; workspaceId: string;
  actorId: string | null; html: string;
}): Promise<void> {
  const { error } = await supabase.from("pj_issue_comments").insert({
    issue_id: input.issueId, pj_project_id: input.pjProjectId,
    workspace_id: input.workspaceId, actor_id: input.actorId, comment_html: input.html,
  });
  if (error) throw new Error(error.message);
}

export async function updateComment(id: string, html: string): Promise<void> {
  await supabase.from("pj_issue_comments")
    .update({ comment_html: html, edited_at: new Date().toISOString() }).eq("id", id);
}

export async function deleteComment(id: string): Promise<void> {
  await supabase.from("pj_issue_comments").delete().eq("id", id);
}

export async function fetchActivity(issueId: string): Promise<PjActivity[]> {
  const { data } = await supabase.from("pj_issue_activity")
    .select("id, issue_id, actor_id, verb, field, old_value, new_value, comment, created_at")
    .eq("issue_id", issueId).order("created_at", { ascending: true });
  return (data ?? []) as PjActivity[];
}

/**
 * Écrit une ligne de journal que la base ne peut PAS déduire seule — un
 * contexte métier, une action d'agent, une étape d'import.
 *
 * Les changements de champs, eux, ne passent plus par ici : depuis 0222 ils
 * sont journalisés par trigger, ce qui est la seule façon d'obtenir un journal
 * exhaustif (le client oublie, un import n'émet rien, un onglet fermé perd sa
 * ligne).
 */
export async function logActivity(input: {
  issueId: string; pjProjectId: string; workspaceId: string; actorId: string | null;
  comment: string;
}): Promise<void> {
  await supabase.from("pj_issue_activity").insert({
    issue_id: input.issueId, pj_project_id: input.pjProjectId, workspace_id: input.workspaceId,
    actor_id: input.actorId, verb: "updated", comment: input.comment, source: "app",
  });
}

export async function fetchAttachments(issueId: string): Promise<PjAttachment[]> {
  const { data } = await supabase.from("pj_issue_attachments")
    .select("id, issue_id, storage_path, name, size_bytes, mime_type, created_by, created_at")
    .eq("issue_id", issueId).order("created_at", { ascending: false });
  return (data ?? []) as PjAttachment[];
}

// ── Cycles ──────────────────────────────────────────────────────────────────

const CYCLE_COLS =
  "id, pj_project_id, workspace_id, name, description, start_date, end_date, owned_by, sort_order, progress_snapshot, archived_at, created_at";

export async function fetchCycles(pjProjectId: string): Promise<PjCycle[]> {
  const { data, error } = await supabase.from("pj_cycles").select(CYCLE_COLS)
    .eq("pj_project_id", pjProjectId).is("archived_at", null)
    .order("start_date", { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as PjCycle[];
}

export async function createCycle(input: {
  pjProjectId: string; workspaceId: string; name: string;
  start_date?: string | null; end_date?: string | null; description?: string;
  createdBy: string | null;
}): Promise<PjCycle> {
  const { data, error } = await supabase.from("pj_cycles").insert({
    pj_project_id: input.pjProjectId, workspace_id: input.workspaceId, name: input.name,
    description: input.description ?? "", start_date: input.start_date ?? null,
    end_date: input.end_date ?? null, owned_by: input.createdBy, created_by: input.createdBy,
  }).select(CYCLE_COLS).single();
  if (error) throw new Error(error.message);
  return data as PjCycle;
}

export async function updateCycle(id: string, patch: Partial<PjCycle>): Promise<void> {
  const { error } = await supabase.from("pj_cycles")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteCycle(id: string): Promise<void> {
  await supabase.from("pj_cycles").delete().eq("id", id);
}

/**
 * Un cycle est passé / en cours / à venir selon ses dates, jamais selon un
 * champ de statut : un statut saisi à la main finit toujours par mentir sur un
 * sprint que personne n'a pensé à clore.
 */
export function cyclePhase(c: PjCycle, today = new Date()): "draft" | "upcoming" | "current" | "completed" {
  if (!c.start_date || !c.end_date) return "draft";
  const d = today.toISOString().slice(0, 10);
  if (d < c.start_date) return "upcoming";
  if (d > c.end_date) return "completed";
  return "current";
}

// ── Modules ─────────────────────────────────────────────────────────────────

const MODULE_COLS =
  "id, pj_project_id, workspace_id, name, description, status, start_date, target_date, lead_id, sort_order, archived_at, created_at";

export async function fetchModules(pjProjectId: string): Promise<PjModule[]> {
  const { data, error } = await supabase.from("pj_modules").select(MODULE_COLS)
    .eq("pj_project_id", pjProjectId).is("archived_at", null).order("sort_order");
  if (error) throw new Error(error.message);
  return (data ?? []) as PjModule[];
}

export async function createModule(input: {
  pjProjectId: string; workspaceId: string; name: string; description?: string;
  status?: PjModule["status"]; start_date?: string | null; target_date?: string | null;
  lead_id?: string | null; createdBy: string | null;
}): Promise<PjModule> {
  const { data, error } = await supabase.from("pj_modules").insert({
    pj_project_id: input.pjProjectId, workspace_id: input.workspaceId, name: input.name,
    description: input.description ?? "", status: input.status ?? "planned",
    start_date: input.start_date ?? null, target_date: input.target_date ?? null,
    lead_id: input.lead_id ?? null, created_by: input.createdBy,
  }).select(MODULE_COLS).single();
  if (error) throw new Error(error.message);
  return data as PjModule;
}

export async function updateModule(id: string, patch: Partial<PjModule>): Promise<void> {
  const { error } = await supabase.from("pj_modules")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteModule(id: string): Promise<void> {
  await supabase.from("pj_modules").delete().eq("id", id);
}

// ── Vues sauvegardées ───────────────────────────────────────────────────────

const VIEW_COLS =
  "id, pj_project_id, dashboard_id, workspace_id, name, description, logo_props, filters, display_filters, display_properties, access, owned_by, sort_order";

export async function fetchViews(pjProjectId: string): Promise<PjView[]> {
  const { data } = await supabase.from("pj_views").select(VIEW_COLS)
    .eq("pj_project_id", pjProjectId).order("sort_order");
  return (data ?? []) as PjView[];
}

/**
 * Toutes les vues d'un service, tous projets confondus.
 *
 * La page Vues de l'espace ne peut pas interroger projet par projet : sur
 * quinze projets, ce serait quinze allers-retours pour dresser une liste qu'on
 * ne fait que survoler. On passe donc par les identifiants des projets du
 * dashboard, en une requête.
 */
export async function fetchSpaceViews(dashboardId: string): Promise<PjView[]> {
  const { data: projects } = await supabase.from("pj_projects").select("id")
    .eq("dashboard_id", dashboardId).is("archived_at", null);
  const ids = (projects ?? []).map((p) => (p as { id: string }).id);

  // Les vues rattachées AU DASHBOARD, sans projet, comptent aussi : ce sont
  // celles qui portent sur tout le service. Un `or` couvre les deux cas en une
  // seule requête plutôt qu'en deux fusionnées à la main.
  const q = supabase.from("pj_views").select(VIEW_COLS).order("sort_order");
  const { data } = ids.length
    ? await q.or(`dashboard_id.eq.${dashboardId},pj_project_id.in.(${ids.join(",")})`)
    : await q.eq("dashboard_id", dashboardId);

  return (data ?? []) as PjView[];
}

export async function createView(input: {
  pjProjectId: string; workspaceId: string; name: string; description?: string;
  filters: Record<string, unknown>; display_filters: Record<string, unknown>;
  display_properties: Record<string, unknown>; access?: 0 | 1; ownedBy: string | null;
}): Promise<PjView> {
  const { data, error } = await supabase.from("pj_views").insert({
    pj_project_id: input.pjProjectId, workspace_id: input.workspaceId, name: input.name,
    description: input.description ?? "", filters: input.filters,
    display_filters: input.display_filters, display_properties: input.display_properties,
    access: input.access ?? 1, owned_by: input.ownedBy,
  }).select(VIEW_COLS).single();
  if (error) throw new Error(error.message);
  return data as PjView;
}

export async function updateView(id: string, patch: Partial<PjView>): Promise<void> {
  const { error } = await supabase.from("pj_views")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteView(id: string): Promise<void> {
  await supabase.from("pj_views").delete().eq("id", id);
}

// ── Analytics (migration 0227) ──────────────────────────────────────────────

export interface AnalyticsRow {
  pj_project_id: string; project_name: string; identifier: string;
  logo_props: Record<string, unknown>; health: Health | null; lead_id: string | null;
  members: number; issues: number; epics: number; completed: number; overdue: number;
  cycles: number; modules: number; pages: number; views: number; intake: number;
}

/** Une seule requête pour les six onglets : ils somment ou détaillent la même
 *  ligne, ce qui évite deux comptages qui finiraient par diverger. */
export async function fetchAnalytics(dashboardId: string): Promise<AnalyticsRow[]> {
  const { data, error } = await supabase.rpc("pj_analytics", { p_dashboard: dashboardId });
  if (error) throw new Error(error.message);
  return (data ?? []) as AnalyticsRow[];
}

export interface AnalyticsCycle {
  cycle_id: string; name: string; project_name: string;
  project_logo: Record<string, unknown>; lead_id: string | null;
  start_date: string | null; end_date: string | null;
  total: number; completed: number; percent: number;
  phase: "draft" | "upcoming" | "current" | "completed";
}

export async function fetchAnalyticsCycles(dashboardId: string): Promise<AnalyticsCycle[]> {
  const { data, error } = await supabase.rpc("pj_analytics_cycles", { p_dashboard: dashboardId });
  if (error) throw new Error(error.message);
  return (data ?? []) as AnalyticsCycle[];
}

export interface AnalyticsModule {
  module_id: string; name: string; project_name: string;
  project_logo: Record<string, unknown>; lead_id: string | null;
  start_date: string | null; target_date: string | null;
  total: number; completed: number; percent: number; status: ModuleStatus;
}

export async function fetchAnalyticsModules(dashboardId: string): Promise<AnalyticsModule[]> {
  const { data, error } = await supabase.rpc("pj_analytics_modules", { p_dashboard: dashboardId });
  if (error) throw new Error(error.message);
  return (data ?? []) as AnalyticsModule[];
}

export interface AnalyticsMember {
  user_id: string | null; assigned: number; completed: number; overdue: number;
}

export async function fetchAnalyticsMembers(dashboardId: string): Promise<AnalyticsMember[]> {
  const { data, error } = await supabase.rpc("pj_analytics_members", { p_dashboard: dashboardId });
  if (error) throw new Error(error.message);
  return (data ?? []) as AnalyticsMember[];
}

// ── Accueil : liens rapides et widgets (migration 0226) ─────────────────────

export interface PjQuickLink {
  id: string; title: string; url: string; sort_order: number; created_at: string;
}

export async function fetchQuickLinks(dashboardId: string): Promise<PjQuickLink[]> {
  const { data } = await supabase.from("pj_quick_links")
    .select("id, title, url, sort_order, created_at")
    .eq("dashboard_id", dashboardId).order("sort_order");
  return (data ?? []) as PjQuickLink[];
}

export async function createQuickLink(input: {
  workspaceId: string; dashboardId: string; title: string; url: string; createdBy: string | null;
}): Promise<void> {
  const { error } = await supabase.from("pj_quick_links").insert({
    workspace_id: input.workspaceId, dashboard_id: input.dashboardId,
    title: input.title, url: input.url, created_by: input.createdBy,
  });
  if (error) throw new Error(error.message);
}

export async function deleteQuickLink(id: string): Promise<void> {
  await supabase.from("pj_quick_links").delete().eq("id", id);
}

export type HomeWidget = "ai" | "quicklinks" | "recents" | "stickies" | "my_work";

export const HOME_WIDGETS: { key: HomeWidget; label: string; hint: string }[] = [
  { key: "ai", label: "Assistant", hint: "Poser une question sur le service" },
  { key: "quicklinks", label: "Liens rapides", hint: "Les adresses de l'équipe" },
  { key: "recents", label: "Récents", hint: "Ce que vous avez ouvert" },
  { key: "my_work", label: "Votre travail", hint: "Ce qui vous est assigné" },
  { key: "stickies", label: "Notes", hint: "Votre bloc-notes" },
];

const DEFAULT_WIDGETS: HomeWidget[] = ["ai", "quicklinks", "recents", "stickies", "my_work"];

export async function fetchHomeWidgets(dashboardId: string): Promise<HomeWidget[]> {
  const { data } = await supabase.from("pj_home_prefs")
    .select("widgets").eq("dashboard_id", dashboardId).maybeSingle();
  // Pas de ligne = jamais personnalisé : on rend la composition par défaut
  // plutôt qu'un accueil vide.
  return ((data as { widgets: HomeWidget[] } | null)?.widgets ?? DEFAULT_WIDGETS);
}

export async function saveHomeWidgets(input: {
  workspaceId: string; dashboardId: string; userId: string; widgets: HomeWidget[];
}): Promise<void> {
  const { error } = await supabase.from("pj_home_prefs").upsert({
    workspace_id: input.workspaceId, dashboard_id: input.dashboardId,
    user_id: input.userId, widgets: input.widgets,
    updated_at: new Date().toISOString(),
  }, { onConflict: "dashboard_id,user_id" });
  if (error) throw new Error(error.message);
}

// ── Jetons d'API ────────────────────────────────────────────────────────────

export interface PjApiToken {
  id: string; label: string; token_prefix: string;
  last_used_at: string | null; expires_at: string | null; created_at: string;
}

export async function fetchApiTokens(): Promise<PjApiToken[]> {
  // Aucun filtre sur user_id : la policy « own api tokens » s'en charge, et
  // ajouter la condition ici laisserait croire qu'elle est ce qui protège.
  const { data } = await supabase.from("pj_api_tokens")
    .select("id, label, token_prefix, last_used_at, expires_at, created_at")
    .order("created_at", { ascending: false });
  return (data ?? []) as PjApiToken[];
}

/**
 * Génère un jeton et n'enregistre que son EMPREINTE.
 *
 * Le secret est produit par `crypto.getRandomValues` — 32 octets, source
 * cryptographique — et non par `Math.random()`, dont la sortie est prédictible
 * à partir de quelques tirages. Il n'existe qu'ici, dans la valeur retournée :
 * la base ne reçoit qu'un SHA-256, de sorte qu'un dump ne livre aucune clé
 * utilisable.
 */
export async function createApiToken(input: {
  workspaceId: string; userId: string; label: string;
}): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = `pj_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const { error } = await supabase.from("pj_api_tokens").insert({
    workspace_id: input.workspaceId, user_id: input.userId, label: input.label,
    token_hash: hash,
    // Le préfixe en clair sert à reconnaître un jeton dans un journal et à
    // révoquer le bon sans avoir à tous les révoquer.
    token_prefix: secret.slice(0, 11),
  });
  if (error) throw new Error(error.message);

  return secret;
}

export async function deleteApiToken(id: string): Promise<void> {
  await supabase.from("pj_api_tokens").delete().eq("id", id);
}

// ── Membres du projet ───────────────────────────────────────────────────────

/**
 * Les rôles reprennent les valeurs de Plane (5/15/20) pour que les exports
 * restent lisibles des deux côtés. Ils filtrent l'INTERFACE, jamais la base :
 * la RLS s'appuie sur l'appartenance à l'espace, et un rôle qu'on croirait
 * protecteur sans qu'il le soit serait pire que pas de rôle du tout.
 */
export const PROJECT_ROLES: { key: number; label: string; hint: string }[] = [
  { key: 5, label: "Invité", hint: "Lecture seule" },
  { key: 15, label: "Membre", hint: "Crée et modifie" },
  { key: 20, label: "Admin", hint: "Pilote le projet et ses réglages" },
];

export interface PjProjectMember {
  id: string; pj_project_id: string; user_id: string; role: number;
}

export async function fetchProjectMembers(pjProjectId: string): Promise<PjProjectMember[]> {
  const { data } = await supabase.from("pj_project_members")
    .select("id, pj_project_id, user_id, role")
    .eq("pj_project_id", pjProjectId).order("sort_order");
  return (data ?? []) as PjProjectMember[];
}

export async function addProjectMember(input: {
  pjProjectId: string; workspaceId: string; userId: string; role?: number;
}): Promise<void> {
  const { error } = await supabase.from("pj_project_members").insert({
    pj_project_id: input.pjProjectId, workspace_id: input.workspaceId,
    user_id: input.userId, role: input.role ?? 15,
  });
  if (error) throw new Error(error.message);
}

export async function setProjectMemberRole(id: string, role: number): Promise<void> {
  await supabase.from("pj_project_members").update({ role }).eq("id", id);
}

export async function removeProjectMember(id: string): Promise<void> {
  await supabase.from("pj_project_members").delete().eq("id", id);
}

// ── Estimations : écriture ──────────────────────────────────────────────────
// (la lecture est plus haut, `fetchEstimates`, qui embarque déjà ses points)

export type EstimateType = PjEstimate["type"];

export async function createEstimate(input: {
  pjProjectId: string; workspaceId: string; name: string;
  type: EstimateType; values: string[];
}): Promise<void> {
  const { data, error } = await supabase.from("pj_estimates").insert({
    pj_project_id: input.pjProjectId, workspace_id: input.workspaceId,
    name: input.name, type: input.type,
    // Inactive à la création : activer, c'est changer l'unité de tout le
    // projet, et ça ne doit pas arriver comme effet de bord d'une création.
    is_active: false,
  }).select("id").single();
  if (error) throw new Error(error.message);

  const estimateId = (data as { id: string }).id;
  await supabase.from("pj_estimate_points").insert(
    input.values.map((value, i) => ({
      estimate_id: estimateId, workspace_id: input.workspaceId,
      key: i, value, sort_order: (i + 1) * 1000,
    })),
  );
}

/** Activer une échelle désactive les autres : le total doit rester lisible. */
export async function setEstimateActive(pjProjectId: string, estimateId: string): Promise<void> {
  await supabase.from("pj_estimates").update({ is_active: false }).eq("pj_project_id", pjProjectId);
  await supabase.from("pj_estimates").update({ is_active: true }).eq("id", estimateId);
}

export async function deleteEstimate(id: string): Promise<void> {
  await supabase.from("pj_estimates").delete().eq("id", id);
}

// ── Pages ───────────────────────────────────────────────────────────────────

// `*` : `description_rich` et `description_text` n'existent qu'après 0228, et
// nommer les colonnes ferait répondre 400 à la requête entière sans elles.
const PAGE_COLS = "*";

export async function fetchPages(pjProjectId: string): Promise<PjPage[]> {
  const { data } = await supabase.from("pj_pages").select(PAGE_COLS)
    .eq("pj_project_id", pjProjectId).is("archived_at", null)
    .order("updated_at", { ascending: false });
  return (data ?? []) as PjPage[];
}

/**
 * Les pages du SERVICE, par opposition à celles d'un projet.
 *
 * La distinction porte tout le wiki : une page de projet documente ce projet et
 * disparaît avec lui ; une décision d'architecture ou un runbook doivent lui
 * survivre. D'où `pj_project_id is null` — la page appartient au dashboard,
 * pas à un chantier.
 */
export async function fetchWikiPages(dashboardId: string): Promise<PjPage[]> {
  const { data } = await supabase.from("pj_pages").select(PAGE_COLS)
    .eq("dashboard_id", dashboardId).is("pj_project_id", null).is("archived_at", null)
    .order("updated_at", { ascending: false });
  return (data ?? []) as PjPage[];
}

export async function createPage(input: {
  pjProjectId?: string | null; dashboardId?: string | null; parentId?: string | null;
  workspaceId: string; name: string; ownedBy: string | null;
}): Promise<PjPage> {
  const { data, error } = await supabase.from("pj_pages").insert({
    pj_project_id: input.pjProjectId ?? null,
    dashboard_id: input.dashboardId ?? null,
    parent_id: input.parentId ?? null,
    workspace_id: input.workspaceId,
    name: input.name, owned_by: input.ownedBy, created_by: input.ownedBy,
  }).select(PAGE_COLS).single();
  if (error) throw new Error(error.message);
  return data as PjPage;
}

export async function updatePage(id: string, patch: Partial<PjPage>): Promise<void> {
  const { error } = await supabase.from("pj_pages")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deletePage(id: string): Promise<void> {
  await supabase.from("pj_pages").delete().eq("id", id);
}

// ── Intake ──────────────────────────────────────────────────────────────────

export async function fetchIntake(pjProjectId: string): Promise<PjIntakeItem[]> {
  const { data } = await supabase.from("pj_intake_issues")
    .select("id, pj_project_id, issue_id, status, snoozed_till, duplicate_to, source, created_at")
    .eq("pj_project_id", pjProjectId).order("created_at", { ascending: false });
  return (data ?? []) as PjIntakeItem[];
}

/**
 * Les portes d'entrée d'une demande. Elles ne changent rien au traitement —
 * c'est bien le point de l'intake, avoir UNE file quelle que soit l'origine —
 * mais elles restent affichées : une demande arrivée par formulaire et une
 * remontée par mail ne se lisent pas avec la même attente de contexte.
 */
export const INTAKE_SOURCES: { key: string; label: string }[] = [
  { key: "in-app", label: "In-App" },
  { key: "email", label: "Mail" },
  { key: "forms", label: "Formulaire" },
];

/**
 * Le second paramètre accepte la date de veille directement : repousser une
 * demande est le seul cas où le statut et une date changent ensemble, et les
 * séparer laisserait passer une veille sans échéance — c'est-à-dire un oubli.
 */
export async function setIntakeStatus(
  id: string,
  status: PjIntakeItem["status"],
  snoozedTill?: string | null,
  extra?: { duplicate_to?: string | null },
): Promise<void> {
  await supabase.from("pj_intake_issues").update({
    status,
    snoozed_till: status === 0 ? (snoozedTill ?? null) : null,
    ...extra,
    updated_at: new Date().toISOString(),
  }).eq("id", id);
}

/**
 * Consigner une demande à la main. Le work item est créé SANS état : c'est ce
 * qui le tient hors des boards et des compteurs tant qu'il n'est pas accepté.
 */
export async function createIntakeItem(input: {
  pjProjectId: string; workspaceId: string; name: string;
  description_html?: string; source: string; createdBy: string | null;
}): Promise<void> {
  const { data, error } = await supabase.from("pj_issues").insert({
    pj_project_id: input.pjProjectId,
    workspace_id: input.workspaceId,
    name: input.name,
    description_html: input.description_html ?? "",
    // Le texte plat alimente la recherche : le laisser vide rendrait la
    // demande introuvable par son contenu.
    description_text: (input.description_html ?? "").replace(/<[^>]*>/g, " ").trim(),
    state_id: null,
    created_by: input.createdBy,
  }).select("id").single();
  if (error) throw new Error(error.message);

  const { error: intakeError } = await supabase.from("pj_intake_issues").insert({
    pj_project_id: input.pjProjectId,
    workspace_id: input.workspaceId,
    issue_id: (data as { id: string }).id,
    source: input.source,
    created_by: input.createdBy,
  });
  if (intakeError) throw new Error(intakeError.message);
}

// ── Archivage des cycles et des modules ─────────────────────────────────────
//
// Un cycle terminé et un module livré encombrent les listes autant qu'un work
// item clos : au bout d'un an, la page Cycles compte cinquante entrées dont
// deux servent encore. Les archiver les retire des listes et des sélecteurs
// sans toucher aux work items qu'ils portaient — c'est ce qui distingue
// l'archivage de la suppression, qui, elle, dénouerait tous les rattachements.

export async function archiveCycle(id: string, archived = true): Promise<void> {
  const { error } = await supabase.from("pj_cycles")
    .update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function archiveModule(id: string, archived = true): Promise<void> {
  const { error } = await supabase.from("pj_modules")
    .update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function fetchArchivedCycles(pjProjectId: string): Promise<PjCycle[]> {
  const { data } = await supabase.from("pj_cycles").select(CYCLE_COLS)
    .eq("pj_project_id", pjProjectId).not("archived_at", "is", null)
    .order("archived_at", { ascending: false });
  return (data ?? []) as PjCycle[];
}

export async function fetchArchivedModules(pjProjectId: string): Promise<PjModule[]> {
  const { data } = await supabase.from("pj_modules").select(MODULE_COLS)
    .eq("pj_project_id", pjProjectId).not("archived_at", "is", null)
    .order("archived_at", { ascending: false });
  return (data ?? []) as PjModule[];
}

// ── Favoris ─────────────────────────────────────────────────────────────────

export async function fetchFavorites(workspaceId: string, userId: string) {
  const { data } = await supabase.from("pj_favorites")
    .select("id, entity_type, entity_id").eq("workspace_id", workspaceId).eq("user_id", userId);
  return (data ?? []) as Array<{ id: string; entity_type: string; entity_id: string }>;
}

export async function toggleFavorite(input: {
  workspaceId: string; userId: string; entityType: string; entityId: string; on: boolean;
}): Promise<void> {
  if (input.on) {
    await supabase.from("pj_favorites").insert({
      workspace_id: input.workspaceId, user_id: input.userId,
      entity_type: input.entityType, entity_id: input.entityId,
    });
  } else {
    await supabase.from("pj_favorites").delete()
      .eq("user_id", input.userId).eq("entity_type", input.entityType).eq("entity_id", input.entityId);
  }
}

// ── Ce que le serveur calcule (migration 0222) ──────────────────────────────

export interface Progress {
  total: number; backlog: number; unstarted: number; started: number;
  completed: number; cancelled: number; overdue: number;
}

/**
 * L'avancement d'un périmètre, calculé en base.
 *
 * À n'utiliser QUE quand les items ne sont pas déjà chargés : sur un écran qui
 * les affiche, les recompter côté serveur ajoute un aller-retour pour un
 * résultat que le navigateur a déjà sous la main.
 */
export async function fetchProgress(
  pjProjectId: string, opts?: { cycleId?: string; moduleId?: string },
): Promise<Progress | null> {
  const { data, error } = await supabase.rpc("pj_progress", {
    p_project: pjProjectId,
    p_cycle: opts?.cycleId ?? null,
    p_module: opts?.moduleId ?? null,
  });
  if (error) throw new Error(error.message);
  return ((data ?? [])[0] as Progress) ?? null;
}

export interface BurndownPoint { day: string; remaining: number; completed: number }

export async function fetchBurndown(cycleId: string): Promise<BurndownPoint[]> {
  const { data, error } = await supabase.rpc("pj_burndown", { p_cycle: cycleId });
  if (error) throw new Error(error.message);
  return (data ?? []) as BurndownPoint[];
}

export interface SearchHit {
  kind: "issue" | "cycle" | "module" | "page";
  id: string; pj_project_id: string; title: string; subtitle: string; rank: number;
}

export async function searchTracker(
  dashboardId: string, query: string, limit = 20,
): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const { data, error } = await supabase.rpc("pj_search", {
    p_dashboard: dashboardId, p_query: query.trim(), p_limit: limit,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as SearchHit[];
}

/** Bascule un lot d'items en une transaction : cinquante écritures séparées
 *  laisseraient la moitié de la sélection à l'ancien état si le réseau lâche. */
export async function bulkUpdate(input: {
  issueIds: string[];
  state_id?: string | null;
  priority?: Priority | null;
  cycle_id?: string | null;
  target_date?: string | null;
}): Promise<number> {
  const { data, error } = await supabase.rpc("pj_bulk_update", {
    p_issues: input.issueIds,
    p_state: input.state_id ?? null,
    p_priority: input.priority ?? null,
    p_cycle: input.cycle_id ?? null,
    p_target_date: input.target_date ?? null,
  });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}

// ── Notifications ───────────────────────────────────────────────────────────

export interface PjNotification {
  id: number;
  issue_id: string;
  actor_id: string | null;
  kind: "assigned" | "mentioned" | "commented" | "state" | "subscribed" | "approval";
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

export async function fetchNotifications(unreadOnly = false): Promise<PjNotification[]> {
  let q = supabase.from("pj_notifications")
    .select("id, issue_id, actor_id, kind, title, body, read_at, created_at")
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  if (unreadOnly) q = q.is("read_at", null);
  const { data } = await q;
  return (data ?? []) as PjNotification[];
}

export async function markNotificationsRead(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await supabase.from("pj_notifications")
    .update({ read_at: new Date().toISOString() }).in("id", ids);
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export interface PjWebhook {
  id: string;
  workspace_id: string;
  dashboard_id: string | null;
  url: string;
  secret: string;
  events: string[];
  is_active: boolean;
  created_at: string;
}

export const WEBHOOK_EVENTS = [
  "issues.insert", "issues.update", "issues.delete",
] as const;

export async function fetchWebhooks(dashboardId: string): Promise<PjWebhook[]> {
  const { data } = await supabase.from("pj_webhooks")
    .select("id, workspace_id, dashboard_id, url, secret, events, is_active, created_at")
    .eq("dashboard_id", dashboardId)
    .order("created_at", { ascending: false });
  return (data ?? []) as PjWebhook[];
}

export async function createWebhook(input: {
  workspaceId: string; dashboardId: string; url: string; events: string[]; createdBy: string | null;
}): Promise<void> {
  const { error } = await supabase.from("pj_webhooks").insert({
    workspace_id: input.workspaceId, dashboard_id: input.dashboardId,
    url: input.url, events: input.events, created_by: input.createdBy,
  });
  if (error) throw new Error(error.message);
}

export async function updateWebhook(id: string, patch: Partial<PjWebhook>): Promise<void> {
  await supabase.from("pj_webhooks").update(patch).eq("id", id);
}

export async function deleteWebhook(id: string): Promise<void> {
  await supabase.from("pj_webhooks").delete().eq("id", id);
}

export interface PjDelivery {
  id: number; event: string; status: "pending" | "sent" | "failed";
  attempts: number; last_error: string | null; created_at: string; sent_at: string | null;
}

export async function fetchDeliveries(webhookId: string): Promise<PjDelivery[]> {
  const { data } = await supabase.from("pj_webhook_deliveries")
    .select("id, event, status, attempts, last_error, created_at, sent_at")
    .eq("webhook_id", webhookId)
    .order("created_at", { ascending: false })
    .limit(25);
  return (data ?? []) as PjDelivery[];
}

// ── Pièces jointes ──────────────────────────────────────────────────────────

const ATTACHMENT_BUCKET = "pj-attachments";

/**
 * Le chemin de stockage porte le projet et l'item : un bucket plat rendrait
 * impossible de retrouver — ou de purger — les fichiers d'un projet supprimé.
 * Le préfixe aléatoire évite qu'un même nom de fichier en écrase un autre.
 */
export async function uploadAttachment(input: {
  file: File; issueId: string; pjProjectId: string; workspaceId: string; userId: string | null;
}): Promise<PjAttachment> {
  const path = `${input.pjProjectId}/${input.issueId}/${crypto.randomUUID()}-${input.file.name}`;
  const { error: upErr } = await supabase.storage
    .from(ATTACHMENT_BUCKET).upload(path, input.file, { upsert: false });
  if (upErr) throw new Error(upErr.message);

  const { data, error } = await supabase.from("pj_issue_attachments").insert({
    issue_id: input.issueId, pj_project_id: input.pjProjectId, workspace_id: input.workspaceId,
    storage_path: path, name: input.file.name, size_bytes: input.file.size,
    mime_type: input.file.type || null, created_by: input.userId,
  }).select("id, issue_id, storage_path, name, size_bytes, mime_type, created_by, created_at").single();
  if (error) throw new Error(error.message);
  return data as PjAttachment;
}

export function attachmentUrl(storagePath: string): string {
  return supabase.storage.from(ATTACHMENT_BUCKET).getPublicUrl(storagePath).data.publicUrl;
}

export async function deleteAttachment(id: string, storagePath: string): Promise<void> {
  // Le fichier part d'abord : supprimer la ligne en premier laisserait un objet
  // orphelin que plus rien ne référence, donc que personne ne nettoiera.
  await supabase.storage.from(ATTACHMENT_BUCKET).remove([storagePath]);
  await supabase.from("pj_issue_attachments").delete().eq("id", id);
}

// ── Initiatives (migration 0223) ────────────────────────────────────────────

export interface PjInitiative {
  id: string;
  workspace_id: string;
  dashboard_id: string | null;
  name: string;
  description: string;
  logo_props: Record<string, unknown>;
  status: "planned" | "active" | "paused" | "completed" | "cancelled";
  lead_id: string | null;
  start_date: string | null;
  target_date: string | null;
  sort_order: number;
  archived_at: string | null;
  /** Santé déclarée (0224), null tant que personne ne s'est prononcé. */
  health: Health | null;
  health_updated_at: string | null;
  created_at: string;
}

export interface InitiativeProgress {
  total: number; completed: number; started: number; overdue: number; projects: number;
}

/** `*` pour la même raison que PROJECT_COLS : `health` n'existe qu'après 0224. */
const INITIATIVE_COLS = "*";

export async function fetchInitiatives(dashboardId: string): Promise<PjInitiative[]> {
  const { data, error } = await supabase.from("pj_initiatives").select(INITIATIVE_COLS)
    .eq("dashboard_id", dashboardId).is("archived_at", null).order("sort_order");
  if (error) throw new Error(error.message);
  return (data ?? []) as PjInitiative[];
}

export async function createInitiative(input: {
  workspaceId: string; dashboardId: string; name: string; description?: string;
  status?: PjInitiative["status"]; start_date?: string | null; target_date?: string | null;
  createdBy: string | null;
}): Promise<PjInitiative> {
  const { data, error } = await supabase.from("pj_initiatives").insert({
    workspace_id: input.workspaceId, dashboard_id: input.dashboardId,
    name: input.name, description: input.description ?? "",
    status: input.status ?? "active",
    start_date: input.start_date ?? null, target_date: input.target_date ?? null,
    created_by: input.createdBy, lead_id: input.createdBy,
  }).select(INITIATIVE_COLS).single();
  if (error) throw new Error(error.message);
  return data as PjInitiative;
}

export async function updateInitiative(id: string, patch: Partial<PjInitiative>): Promise<void> {
  const { error } = await supabase.from("pj_initiatives")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteInitiative(id: string): Promise<void> {
  await supabase.from("pj_initiatives").delete().eq("id", id);
}

export async function fetchInitiativeProjects(initiativeId: string): Promise<string[]> {
  const { data } = await supabase.from("pj_initiative_projects")
    .select("pj_project_id").eq("initiative_id", initiativeId);
  return (data ?? []).map((r: { pj_project_id: string }) => r.pj_project_id);
}

export async function setInitiativeProjects(
  initiativeId: string, workspaceId: string, projectIds: string[],
): Promise<void> {
  await supabase.from("pj_initiative_projects").delete().eq("initiative_id", initiativeId);
  if (projectIds.length) {
    await supabase.from("pj_initiative_projects").insert(
      projectIds.map((pj_project_id) => ({
        initiative_id: initiativeId, pj_project_id, workspace_id: workspaceId,
      })),
    );
  }
}

export async function fetchInitiativeProgress(id: string): Promise<InitiativeProgress | null> {
  const { data, error } = await supabase.rpc("pj_initiative_progress", { p_initiative: id });
  if (error) throw new Error(error.message);
  return ((data ?? [])[0] as InitiativeProgress) ?? null;
}

// ── Votre travail ───────────────────────────────────────────────────────────

export interface MyWorkRow {
  issue_id: string; pj_project_id: string; project_name: string; identifier: string;
  sequence_id: number; name: string; priority: Priority;
  state_name: string | null; state_group: StateGroup | null; state_color: string | null;
  target_date: string | null; completed_at: string | null;
}

export async function fetchMyWork(dashboardId: string): Promise<MyWorkRow[]> {
  const { data, error } = await supabase.rpc("pj_my_work", { p_dashboard: dashboardId });
  if (error) throw new Error(error.message);
  return (data ?? []) as MyWorkRow[];
}

// ── Stickies ────────────────────────────────────────────────────────────────

export interface PjSticky {
  id: string; content: string; color: string; sort_order: number; created_at: string;
}

/**
 * Les fonds des notes.
 *
 * Ce sont des teintes SOURDES et non des couleurs vives : une note porte du
 * texte blanc sur toute sa surface, et un jaune saturé rendrait ce texte
 * illisible. Chacune tient autour de 32 % de luminosité, ce qui garantit le
 * contraste quel que soit le fond de page — clair ou sombre.
 */
export const STICKY_COLORS = [
  "#4b4d52", // gris
  "#7a4a3e", // pêche
  "#7c3d5c", // rose
  "#8a5426", // orange
  "#2f6144", // vert
  "#2b5a70", // bleu clair
  "#2f4478", // bleu profond
  "#4a4160", // violet
];

export async function fetchStickies(dashboardId: string): Promise<PjSticky[]> {
  const { data } = await supabase.from("pj_stickies")
    .select("id, content, color, sort_order, created_at")
    .eq("dashboard_id", dashboardId).order("sort_order");
  return (data ?? []) as PjSticky[];
}

export async function createSticky(input: {
  workspaceId: string; dashboardId: string; userId: string; color?: string;
}): Promise<PjSticky> {
  const { data, error } = await supabase.from("pj_stickies").insert({
    workspace_id: input.workspaceId, dashboard_id: input.dashboardId,
    user_id: input.userId, color: input.color ?? STICKY_COLORS[0],
  }).select("id, content, color, sort_order, created_at").single();
  if (error) throw new Error(error.message);
  return data as PjSticky;
}

export async function updateSticky(id: string, patch: Partial<PjSticky>): Promise<void> {
  await supabase.from("pj_stickies")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

export async function deleteSticky(id: string): Promise<void> {
  await supabase.from("pj_stickies").delete().eq("id", id);
}

// ── Visites récentes ────────────────────────────────────────────────────────

export interface RecentVisit {
  entity_type: "project" | "issue" | "cycle" | "module" | "page" | "initiative";
  entity_id: string;
  visited_at: string;
}

export async function touchVisit(input: {
  workspaceId: string; dashboardId: string; type: RecentVisit["entity_type"]; entityId: string;
}): Promise<void> {
  // Jamais bloquant : rater une trace de navigation ne doit pas empêcher
  // d'ouvrir la page qu'on vient de demander.
  await supabase.rpc("pj_touch_visit", {
    p_workspace: input.workspaceId, p_dashboard: input.dashboardId,
    p_type: input.type, p_entity: input.entityId,
  });
}

export async function fetchRecentVisits(dashboardId: string, limit = 10): Promise<RecentVisit[]> {
  const { data } = await supabase.from("pj_recent_visits")
    .select("entity_type, entity_id, visited_at")
    .eq("dashboard_id", dashboardId)
    .order("visited_at", { ascending: false }).limit(limit);
  return (data ?? []) as RecentVisit[];
}

/**
 * Une visite récente AVEC de quoi l'afficher.
 *
 * La table ne garde qu'un type et un identifiant : c'est ce qu'il faut pour
 * écrire vite à chaque navigation, mais pas pour dresser une liste lisible.
 * Sans cette résolution, l'accueil affiche des morceaux d'UUID — c'est-à-dire
 * une liste de rien.
 */
export interface RecentEntry extends RecentVisit {
  title: string;
  /** Le préfixe du projet et le numéro, quand l'objet en a un. */
  identifier: string | null;
  sequence_id: number | null;
  /** Le projet d'accueil, pour pouvoir ouvrir la fiche. */
  project_id: string | null;
  state_group: StateGroup | null;
  state_color: string | null;
  priority: Priority | null;
  logo_props: Record<string, unknown> | null;
}

export async function fetchRecentEntries(dashboardId: string, limit = 20): Promise<RecentEntry[]> {
  const visits = await fetchRecentVisits(dashboardId, limit);
  if (!visits.length) return [];

  const ids = (type: RecentVisit["entity_type"]) =>
    visits.filter((v) => v.entity_type === type).map((v) => v.entity_id);

  // Une requête par TYPE, pas une par ligne : vingt visites de work items
  // feraient vingt allers-retours pour une liste qu'on ne fait que survoler.
  const table = async (name: string, list: string[]) => {
    if (!list.length) return [] as Record<string, unknown>[];
    const { data } = await supabase.from(name).select("*").in("id", list);
    return (data ?? []) as Record<string, unknown>[];
  };

  const [projects, issues, pages, cycles, modules, initiatives] = await Promise.all([
    table("pj_projects", ids("project")),
    table("pj_issues", ids("issue")),
    table("pj_pages", ids("page")),
    table("pj_cycles", ids("cycle")),
    table("pj_modules", ids("module")),
    table("pj_initiatives", ids("initiative")),
  ]);

  // Les états ne servent qu'aux work items, et seulement à ceux rencontrés.
  const stateIds = [...new Set(issues.map((i) => i.state_id).filter(Boolean))] as string[];
  const states = await table("pj_states", stateIds);
  const stateById = new Map(states.map((st) => [st.id as string, st]));

  // Le préfixe du projet vient de la table des projets, y compris pour un work
  // item dont le projet n'a pas été visité : sans lui la référence perd son
  // sens (« -7 » ne désigne rien).
  const projectIds = [...new Set([
    ...issues.map((i) => i.pj_project_id),
    ...pages.map((i) => i.pj_project_id),
    ...cycles.map((i) => i.pj_project_id),
    ...modules.map((i) => i.pj_project_id),
  ].filter(Boolean))] as string[];
  const extra = await table("pj_projects", projectIds.filter((id) => !projects.some((p) => p.id === id)));
  const projectById = new Map([...projects, ...extra].map((p) => [p.id as string, p]));

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...projects, ...issues, ...pages, ...cycles, ...modules, ...initiatives]) {
    byId.set(row.id as string, row);
  }

  const out: RecentEntry[] = [];
  for (const v of visits) {
    const row = byId.get(v.entity_id);
    // Un objet supprimé depuis la visite : on saute la ligne plutôt que
    // d'afficher un lien mort.
    if (!row) continue;

    const project = v.entity_type === "project"
      ? row
      : projectById.get(row.pj_project_id as string) ?? null;
    const state = v.entity_type === "issue" ? stateById.get(row.state_id as string) ?? null : null;

    out.push({
      ...v,
      title: (row.name as string) ?? "Sans titre",
      identifier: (project?.identifier as string) ?? null,
      sequence_id: v.entity_type === "issue" ? (row.sequence_id as number) ?? null : null,
      project_id: v.entity_type === "project"
        ? (row.id as string)
        : ((row.pj_project_id as string) ?? null),
      state_group: (state?.group as StateGroup) ?? null,
      state_color: (state?.color as string) ?? null,
      priority: v.entity_type === "issue" ? ((row.priority as Priority) ?? null) : null,
      logo_props: (row.logo_props as Record<string, unknown>) ?? null,
    });
  }
  return out;
}

// ── Dashboards composables ──────────────────────────────────────────────────

export interface PjDashboard {
  id: string; workspace_id: string; dashboard_id: string | null;
  name: string; description: string; owned_by: string | null; access: 0 | 1;
}

export type WidgetKind =
  | "count" | "distribution" | "progress" | "burndown" | "issue_list" | "overdue";

export interface PjWidget {
  id: string;
  pj_dashboard_id: string;
  kind: WidgetKind;
  title: string;
  config: { projectId?: string; dimension?: string; cycleId?: string; limit?: number };
  x: number; y: number; w: number; h: number;
}

export async function fetchDashboards(dashboardId: string): Promise<PjDashboard[]> {
  const { data } = await supabase.from("pj_dashboards")
    .select("id, workspace_id, dashboard_id, name, description, owned_by, access")
    .eq("dashboard_id", dashboardId).order("created_at");
  return (data ?? []) as PjDashboard[];
}

export async function createDashboard(input: {
  workspaceId: string; dashboardId: string; name: string; ownedBy: string | null;
  /** 1 = partagé (défaut), 0 = privé. */
  access?: 0 | 1;
}): Promise<PjDashboard> {
  const { data, error } = await supabase.from("pj_dashboards").insert({
    workspace_id: input.workspaceId, dashboard_id: input.dashboardId,
    name: input.name, owned_by: input.ownedBy, access: input.access ?? 1,
  }).select("id, workspace_id, dashboard_id, name, description, owned_by, access").single();
  if (error) throw new Error(error.message);
  return data as PjDashboard;
}

export async function deleteDashboard(id: string): Promise<void> {
  await supabase.from("pj_dashboards").delete().eq("id", id);
}

export async function fetchWidgets(pjDashboardId: string): Promise<PjWidget[]> {
  const { data } = await supabase.from("pj_dashboard_widgets")
    .select("id, pj_dashboard_id, kind, title, config, x, y, w, h")
    .eq("pj_dashboard_id", pjDashboardId).order("y").order("x");
  return (data ?? []) as PjWidget[];
}

export async function createWidget(input: {
  pjDashboardId: string; workspaceId: string; kind: WidgetKind; title: string;
  config: PjWidget["config"];
  /** La place dans la grille. Sans elle, la carte se pose en 0,0 et recouvre
   *  celles qui y sont déjà. */
  x?: number; y?: number; w?: number; h?: number;
}): Promise<void> {
  const { error } = await supabase.from("pj_dashboard_widgets").insert({
    pj_dashboard_id: input.pjDashboardId, workspace_id: input.workspaceId,
    kind: input.kind, title: input.title, config: input.config,
    x: input.x ?? 0, y: input.y ?? 0, w: input.w ?? 4, h: input.h ?? 4,
  });
  if (error) throw new Error(error.message);
}

export async function deleteWidget(id: string): Promise<void> {
  await supabase.from("pj_dashboard_widgets").delete().eq("id", id);
}

export async function updateWidget(id: string, patch: Partial<PjWidget>): Promise<void> {
  const { error } = await supabase.from("pj_dashboard_widgets").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

/**
 * Enregistre les positions de la grille en un seul aller-retour.
 *
 * Un déplacement fait bouger plusieurs cartes à la fois — pousser une carte
 * décale ses voisines — et une écriture par carte laisserait une grille à
 * moitié rangée si le réseau lâche au milieu. `upsert` sur la clé primaire
 * plutôt que N `update` : c'est le seul moyen d'obtenir un envoi unique avec
 * PostgREST.
 */
export async function saveWidgetLayout(
  items: { id: string; x: number; y: number; w: number; h: number }[],
): Promise<void> {
  if (!items.length) return;
  const { error } = await supabase.from("pj_dashboard_widgets").upsert(items);
  if (error) throw new Error(error.message);
}

export async function renameDashboard(id: string, name: string): Promise<void> {
  await supabase.from("pj_dashboards")
    .update({ name, updated_at: new Date().toISOString() }).eq("id", id);
}

// ── Types de work item ──────────────────────────────────────────────────────

export async function createIssueType(input: {
  pjProjectId: string; workspaceId: string; name: string; color: string; icon: string;
}): Promise<void> {
  const { error } = await supabase.from("pj_issue_types").insert({
    pj_project_id: input.pjProjectId, workspace_id: input.workspaceId,
    name: input.name, color: input.color, icon: input.icon,
  });
  if (error) throw new Error(error.message);
}

export async function updateIssueType(id: string, patch: Partial<PjIssueType>): Promise<void> {
  await supabase.from("pj_issue_types").update(patch).eq("id", id);
}

export async function deleteIssueType(id: string): Promise<void> {
  await supabase.from("pj_issue_types").delete().eq("id", id);
}

// ── Santé et points d'étape (migration 0224) ────────────────────────────────

export type Health = "on_track" | "at_risk" | "off_track";

export const HEALTH: { key: Health; label: string; color: string }[] = [
  { key: "on_track", label: "On track", color: "#16a34a" },
  { key: "at_risk", label: "At risk", color: "#eda100" },
  { key: "off_track", label: "Off track", color: "#e34948" },
];

export interface PjStatusUpdate {
  id: string;
  pj_project_id: string | null;
  initiative_id: string | null;
  health: Health;
  title: string;
  body: string;
  actor_id: string | null;
  created_at: string;
}

const UPDATE_COLS =
  "id, pj_project_id, initiative_id, health, title, body, actor_id, created_at";

export async function fetchStatusUpdates(
  scope: { projectId?: string; initiativeId?: string },
): Promise<PjStatusUpdate[]> {
  let q = supabase.from("pj_status_updates").select(UPDATE_COLS)
    .order("created_at", { ascending: false }).limit(50);
  if (scope.projectId) q = q.eq("pj_project_id", scope.projectId);
  if (scope.initiativeId) q = q.eq("initiative_id", scope.initiativeId);
  const { data } = await q;
  return (data ?? []) as PjStatusUpdate[];
}

export async function addStatusUpdate(input: {
  workspaceId: string; projectId?: string; initiativeId?: string;
  health: Health; title: string; body: string; actorId: string | null;
}): Promise<void> {
  const { error } = await supabase.from("pj_status_updates").insert({
    workspace_id: input.workspaceId,
    pj_project_id: input.projectId ?? null,
    initiative_id: input.initiativeId ?? null,
    health: input.health, title: input.title, body: input.body,
    actor_id: input.actorId,
  });
  if (error) throw new Error(error.message);
}

export async function deleteStatusUpdate(id: string): Promise<void> {
  await supabase.from("pj_status_updates").delete().eq("id", id);
}

// ── Epics ───────────────────────────────────────────────────────────────────

export async function fetchEpics(pjProjectId: string): Promise<PjIssue[]> {
  // Passe par `fetchIssues` pour hériter du filtre résilient : sur une base sans
  // 0224, `.eq("is_epic", true)` ferait échouer la requête au lieu de rendre
  // une liste vide.
  return fetchIssues({ pjProjectId, onlyEpics: true });
}

export async function fetchEpicChildren(epicId: string): Promise<PjIssue[]> {
  const { data: links } = await supabase.from("pj_epic_issues")
    .select("issue_id").eq("epic_id", epicId);
  const ids = (links ?? []).map((r: { issue_id: string }) => r.issue_id);
  if (!ids.length) return [];
  const { data } = await supabase.from("pj_issues").select(ISSUE_COLS).in("id", ids);
  return attachRelations((data ?? []) as RawIssue[]);
}

export async function setEpicChildren(
  epicId: string, workspaceId: string, issueIds: string[],
): Promise<void> {
  await supabase.from("pj_epic_issues").delete().eq("epic_id", epicId);
  if (issueIds.length) {
    await supabase.from("pj_epic_issues").insert(
      issueIds.map((issue_id) => ({ epic_id: epicId, issue_id, workspace_id: workspaceId })),
    );
  }
}

// ── Teamspaces ──────────────────────────────────────────────────────────────

export interface PjTeamspace {
  id: string; workspace_id: string; dashboard_id: string | null;
  name: string; description: string; lead_id: string | null; created_at: string;
}

export async function fetchTeamspaces(dashboardId: string): Promise<PjTeamspace[]> {
  const { data } = await supabase.from("pj_teamspaces")
    .select("id, workspace_id, dashboard_id, name, description, lead_id, created_at")
    .eq("dashboard_id", dashboardId).order("created_at");
  return (data ?? []) as PjTeamspace[];
}

export async function createTeamspace(input: {
  workspaceId: string; dashboardId: string; name: string; createdBy: string | null;
}): Promise<void> {
  const { error } = await supabase.from("pj_teamspaces").insert({
    workspace_id: input.workspaceId, dashboard_id: input.dashboardId,
    name: input.name, lead_id: input.createdBy, created_by: input.createdBy,
  });
  if (error) throw new Error(error.message);
}

export async function deleteTeamspace(id: string): Promise<void> {
  await supabase.from("pj_teamspaces").delete().eq("id", id);
}

export async function setTeamspaceProjects(
  teamspaceId: string, workspaceId: string, projectIds: string[],
): Promise<void> {
  await supabase.from("pj_teamspace_projects").delete().eq("teamspace_id", teamspaceId);
  if (projectIds.length) {
    await supabase.from("pj_teamspace_projects").insert(
      projectIds.map((pj_project_id) => ({
        teamspace_id: teamspaceId, pj_project_id, workspace_id: workspaceId,
      })),
    );
  }
}

export async function fetchTeamspaceProjects(teamspaceId: string): Promise<string[]> {
  const { data } = await supabase.from("pj_teamspace_projects")
    .select("pj_project_id").eq("teamspace_id", teamspaceId);
  return (data ?? []).map((r: { pj_project_id: string }) => r.pj_project_id);
}

// ── Liens externes ──────────────────────────────────────────────────────────

export interface PjLink {
  id: string; issue_id: string | null; initiative_id: string | null;
  url: string; title: string; created_at: string;
}

export async function fetchLinks(
  scope: { issueId?: string; initiativeId?: string },
): Promise<PjLink[]> {
  let q = supabase.from("pj_links").select("id, issue_id, initiative_id, url, title, created_at")
    .order("created_at", { ascending: false });
  if (scope.issueId) q = q.eq("issue_id", scope.issueId);
  if (scope.initiativeId) q = q.eq("initiative_id", scope.initiativeId);
  const { data } = await q;
  return (data ?? []) as PjLink[];
}

export async function addLink(input: {
  workspaceId: string; issueId?: string; initiativeId?: string;
  url: string; title?: string; createdBy: string | null;
}): Promise<void> {
  const { error } = await supabase.from("pj_links").insert({
    workspace_id: input.workspaceId,
    issue_id: input.issueId ?? null, initiative_id: input.initiativeId ?? null,
    url: input.url, title: input.title ?? "", created_by: input.createdBy,
  });
  if (error) throw new Error(error.message);
}

export async function deleteLink(id: string): Promise<void> {
  await supabase.from("pj_links").delete().eq("id", id);
}

// ── Workgraph ───────────────────────────────────────────────────────────────

/** Les sept familles cartographiées (0231). */
export type GraphKind =
  | "initiative" | "project" | "epic" | "cycle" | "module" | "page" | "issue"
  | "sticky" | "agent" | "member";

export interface GraphNode {
  node_kind: GraphKind;
  node_id: string;
  label: string;
  sub_label: string;
  health: Health | null;
  status: string | null;
  lead_id: string | null;
  percent: number;
  parent_id: string | null;
  /**
   * Les rattachements AUTRES que le parent (0232).
   *
   * C'est ce qui fait du graphe un réseau et non un arbre : un work item est
   * dans un cycle ET dans deux modules, un agent travaille sur cinq items, une
   * personne en porte douze. Un seul parent ne peut pas dire ça.
   */
  link_ids: string[] | null;
}

export async function fetchWorkgraph(
  dashboardId: string,
  options?: { kinds?: GraphKind[]; issueLimit?: number },
): Promise<GraphNode[]> {
  // Le filtre part au SERVEUR : rapatrier mille work items pour n'en dessiner
  // que les epics ferait payer la bande passante d'une vue qu'on ne regarde
  // pas. C'est aussi ce qui permet de garder une borne haute sur les items
  // sans amputer les autres familles.
  const { data, error } = await supabase.rpc("pj_workgraph", {
    p_dashboard: dashboardId,
    p_kinds: options?.kinds ?? null,
    p_issue_limit: options?.issueLimit ?? 300,
  });

  if (!error) return (data ?? []) as GraphNode[];

  // REPLI sur l'ancienne signature.
  //
  // PostgREST résout une fonction par le NOM ET les arguments nommés. Sur une
  // base où la migration qui ajoute `p_kinds` n'est pas encore passée, l'appel
  // à trois arguments ne trouve aucune fonction et échoue — et le graphe se
  // vide entièrement, en affichant « rien à cartographier » à quelqu'un dont
  // l'espace est plein. Le message est alors doublement faux : il n'y a pas
  // rien, et ce n'est pas la carte qui est en cause.
  //
  // On retente donc avec le seul argument que toutes les versions connaissent.
  // Le filtrage par famille se fait alors côté client, ce qui coûte de la bande
  // passante mais rend un graphe juste plutôt qu'un écran vide.
  const legacy = await supabase.rpc("pj_workgraph", { p_dashboard: dashboardId });
  if (legacy.error) throw new Error(error.message);

  const rows = (legacy.data ?? []) as GraphNode[];
  return options?.kinds ? rows.filter((r) => options.kinds!.includes(r.node_kind)) : rows;
}

// ── Règles de transition ────────────────────────────────────────────────────

export interface PjTransition { id: string; from_state_id: string; to_state_id: string }

export async function fetchTransitions(pjProjectId: string): Promise<PjTransition[]> {
  const { data } = await supabase.from("pj_state_transitions")
    .select("id, from_state_id, to_state_id").eq("pj_project_id", pjProjectId);
  return (data ?? []) as PjTransition[];
}

export async function setTransition(input: {
  pjProjectId: string; workspaceId: string; from: string; to: string; on: boolean;
}): Promise<void> {
  if (input.on) {
    await supabase.from("pj_state_transitions").insert({
      pj_project_id: input.pjProjectId, workspace_id: input.workspaceId,
      from_state_id: input.from, to_state_id: input.to,
    });
  } else {
    await supabase.from("pj_state_transitions").delete()
      .eq("from_state_id", input.from).eq("to_state_id", input.to);
  }
}

// ── Archives ────────────────────────────────────────────────────────────────

export async function fetchArchivedIssues(pjProjectId: string): Promise<PjIssue[]> {
  const { data } = await supabase.from("pj_issues").select(ISSUE_COLS)
    .eq("pj_project_id", pjProjectId).not("archived_at", "is", null)
    .order("archived_at", { ascending: false });
  return attachRelations((data ?? []) as RawIssue[]);
}

// ── Rang de tri ─────────────────────────────────────────────────────────────

/**
 * Le rang d'une carte déposée entre `before` et `after`. On vise le milieu :
 * c'est ce qui permet de réordonner en écrivant une seule ligne. Quand les deux
 * voisins sont trop proches pour qu'un float les sépare, l'appelant renumérote
 * la colonne — cas qui n'arrive qu'après des milliers d'insertions au même
 * endroit.
 */
export function rankBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 65535;
  if (before == null) return (after as number) - 10000;
  if (after == null) return before + 10000;
  return (before + after) / 2;
}

// ── Équipage d'un projet ────────────────────────────────────────────────────
//
// Un projet porte deux familles de membres, et le produit les traite du même
// vocabulaire : on met quelqu'un — humain ou machine — sur un projet, on lui
// confie du travail, et ce qu'il en sort revient s'y accrocher.
//
// Les personnes passent par `pj_project_members` (0221, rôles 5/15/20), les
// agents par `pj_project_agents` (0232). Deux tables et non une : un membre
// référence `auth.users`, un agent `internal_agents`, et une colonne polymorphe
// perdrait la contrainte d'intégrité — la seule chose qui garantit qu'un
// assigné existe vraiment.

/** La charge de chaque agent sur ce projet (0235). */
export async function fetchProjectAgentLoad(
  pjProjectId: string,
): Promise<Map<string, { open: number; done: number }>> {
  const { data } = await supabase.rpc("pj_project_agent_load", { p_project: pjProjectId });
  const rows = (data ?? []) as Array<{ agent_id: string; open_count: number; done_count: number }>;
  return new Map(rows.map((r) => [r.agent_id, { open: r.open_count, done: r.done_count }]));
}

/**
 * La charge de chaque PERSONNE sur ce projet.
 *
 * Calculée ici et non en base, contrairement à celle des agents : les deux
 * tables qu'il faut croiser sont déjà lues par le board, la volumétrie est
 * celle d'un projet — quelques centaines de lignes — et une fonction SQL de
 * plus pour une somme se paierait à chaque migration. Le jour où un projet
 * dépasse le millier d'items, ce calcul rejoindra `pj_project_agent_load`.
 */
export async function fetchProjectMemberLoad(
  pjProjectId: string,
): Promise<Map<string, { open: number; done: number }>> {
  const { data: issues } = await supabase.from("pj_issues")
    .select("id, completed_at")
    .eq("pj_project_id", pjProjectId)
    .is("archived_at", null);
  const rows = (issues ?? []) as Array<{ id: string; completed_at: string | null }>;
  if (!rows.length) return new Map();

  const done = new Set(rows.filter((r) => r.completed_at).map((r) => r.id));
  const { data: links } = await supabase.from("pj_issue_assignees")
    .select("issue_id, user_id")
    .in("issue_id", rows.map((r) => r.id));

  const load = new Map<string, { open: number; done: number }>();
  for (const l of (links ?? []) as Array<{ issue_id: string; user_id: string }>) {
    const cur = load.get(l.user_id) ?? { open: 0, done: 0 };
    if (done.has(l.issue_id)) cur.done += 1; else cur.open += 1;
    load.set(l.user_id, cur);
  }
  return load;
}


// ── Attribution du travail des agents ───────────────────────────────────────
//
// À qui, et à quoi, rattacher une exécution d'agent.
//
// Les statistiques d'agents (`internal_agent_runs`) et le suivi de travail
// (`pj_*`) sont deux mondes que rien ne joignait : un run savait quel agent
// l'avait produit, jamais pour quel projet ni à la demande de qui. On pouvait
// donc dire « cet agent a coûté 12 $ » et jamais « ce projet a coûté 12 $ »,
// qui est pourtant la question qu'on se pose en fin de mois.
//
// Le chaînon est la MISSION : depuis 0235 elle porte `pj_project_id` et
// `pj_issue_id`, et le run pend à la mission. D'où cette lecture en deux temps,
// qui remonte le fil run → mission → projet.
//
// Ce que ce lien N'A PAS : les runs de conversation. Un agent interrogé dans
// une room travaille sans mission, donc sans projet. Ils ne sont pas perdus —
// ils sont INATTRIBUABLES, ce qui n'est pas la même chose et doit se dire à
// l'écran plutôt que se rattraper par une approximation.

export interface AgentAttribution {
  /** missionId → ce à quoi la mission se rattache. */
  missions: Map<string, { pjProjectId: string | null; pjIssueId: string | null; createdBy: string | null }>;
  /** runId → qui l'a déclenché. */
  runActor: Map<string, string | null>;
  /** Les personnes apparues comme demandeur, dédupliquées. */
  actorIds: string[];
  /** Combien de runs ne se rattachent à aucune mission (donc à aucun projet). */
  unattributedRuns: number;
}

export async function fetchAgentAttribution(agentIds: string[]): Promise<AgentAttribution> {
  const empty: AgentAttribution = {
    missions: new Map(), runActor: new Map(), actorIds: [], unattributedRuns: 0,
  };
  if (!agentIds.length) return empty;

  const [missionRes, runRes] = await Promise.all([
    supabase.from("internal_agent_missions")
      .select("id, pj_project_id, pj_issue_id, created_by")
      .in("agent_id", agentIds),
    supabase.from("internal_agent_runs")
      .select("id, mission_id, triggered_by")
      .in("agent_id", agentIds)
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);

  const missions = new Map<string, { pjProjectId: string | null; pjIssueId: string | null; createdBy: string | null }>();
  const actors = new Set<string>();

  for (const m of (missionRes.data ?? []) as Array<{
    id: string; pj_project_id: string | null; pj_issue_id: string | null; created_by: string | null;
  }>) {
    missions.set(m.id, {
      pjProjectId: m.pj_project_id, pjIssueId: m.pj_issue_id, createdBy: m.created_by,
    });
    if (m.created_by) actors.add(m.created_by);
  }

  const runActor = new Map<string, string | null>();
  let unattributedRuns = 0;
  for (const r of (runRes.data ?? []) as Array<{
    id: string; mission_id: string | null; triggered_by: string | null;
  }>) {
    runActor.set(r.id, r.triggered_by);
    if (r.triggered_by) actors.add(r.triggered_by);
    if (!r.mission_id) unattributedRuns += 1;
  }

  return { missions, runActor, actorIds: [...actors], unattributedRuns };
}

// ── Missions et preuves ─────────────────────────────────────────────────────

export interface ProjectDeliverable {
  id: string;
  kind: string;
  name: string;
  content: string | null;
  file_url: string | null;
  created_at: string;
  agent_id: string | null;
  agent_name: string | null;
  mission_id: string | null;
  mission_title: string | null;
  issue_id: string | null;
  issue_name: string | null;
  issue_ref: string | null;
  run_id: string | null;
  run_status: string | null;
  run_cost_usd: number | null;
  run_seconds: number | null;
}

export async function fetchProjectDeliverables(pjProjectId: string): Promise<ProjectDeliverable[]> {
  const { data, error } = await supabase.rpc("pj_project_deliverables", { p_project: pjProjectId });
  if (error) throw new Error(error.message);
  return (data ?? []) as ProjectDeliverable[];
}

/**
 * Confie un work item à un agent, sous forme de mission exécutable.
 *
 * Trois écritures et un appel, dans cet ordre précis :
 *
 *   1. la MISSION porte le brief — ce qu'il y a à faire, à quoi on reconnaîtra
 *      que c'est fait, et ce qu'on attend en sortie. Elle est rattachée au work
 *      item, ce qui transformera le livrable en preuve ;
 *   2. le RUN est la tentative d'exécution, créé en file d'attente ;
 *   3. l'agent est assigné au work item s'il ne l'était pas — sans quoi le
 *      board montrerait un item que personne ne porte pendant qu'une machine
 *      travaille dessus ;
 *   4. le worker est réveillé. L'appel est SANS ATTENTE de résultat : un run
 *      dure des minutes, et bloquer l'interface dessus la rendrait inutilisable.
 *      S'il échoue, le run reste en file et sera repris.
 */
export async function assignMission(input: {
  agentId: string;
  issue: PjIssue;
  project: PjProject;
  title: string;
  brief: string;
  acceptanceCriteria: string;
  createdBy: string | null;
}): Promise<{ missionId: string; runId: string }> {
  const { data: mission, error: mErr } = await supabase
    .from("internal_agent_missions")
    .insert({
      agent_id: input.agentId,
      workspace_id: input.project.workspace_id,
      project_id: input.project.project_id,
      pj_project_id: input.project.id,
      pj_issue_id: input.issue.id,
      title: input.title,
      brief: input.brief,
      acceptance_criteria: input.acceptanceCriteria,
      status: "active",
      created_by: input.createdBy,
    })
    .select("id").single();
  if (mErr) throw new Error(mErr.message);

  const missionId = (mission as { id: string }).id;

  const { data: run, error: rErr } = await supabase
    .from("internal_agent_runs")
    .insert({
      mission_id: missionId,
      agent_id: input.agentId,
      workspace_id: input.project.workspace_id,
      project_id: input.project.project_id,
      status: "queued",
      triggered_by: input.createdBy,
    })
    .select("id").single();
  if (rErr) throw new Error(rErr.message);

  const runId = (run as { id: string }).id;

  // Doublon sans conséquence : l'agent peut déjà être assigné.
  await supabase.from("pj_issue_agents").insert({
    issue_id: input.issue.id,
    agent_id: input.agentId,
    workspace_id: input.project.workspace_id,
    assigned_by: input.createdBy,
  });

  // Le worker, réveillé SANS ATTENTE de résultat : un run dure des minutes, et
  // bloquer l'interface dessus la rendrait inutilisable. En cas d'échec de
  // l'appel, le run reste en file — l'ordonnanceur le reprendra, ce qui rend
  // cette ligne accélératrice et non indispensable.
  void callEdge("internal-agent-run", {
    agent_id: input.agentId, mode: "mission", run_id: runId,
  }).catch(() => { /* l'ordonnanceur rattrape */ });

  return { missionId, runId };
}

/**
 * Les actions qu'un agent ne peut pas faire sans qu'on l'y autorise, sur CET
 * item.
 *
 * Elles n'apparaissaient nulle part dans le module. Une demande d'autorisation
 * s'affichait dans le chat de l'agent et dans les rooms — c'est-à-dire là où
 * quelqu'un regarde quand il a lui-même lancé la machine. Un agent planifié qui
 * travaille la nuit demandait donc une autorisation à une pièce vide : le run
 * attendait, l'ordonnanceur le déclarait mort au bout de trente minutes, et
 * trois nuits plus tard le disjoncteur coupait l'item. Personne n'avait rien vu
 * passer, et l'item semblait simplement ne « pas marcher ».
 *
 * On les lit ici par le chemin inverse du reste : approbation → run → mission →
 * work item.
 */
export interface IssueApproval {
  id: string;
  agent_id: string | null;
  tool_name: string;
  action_kind: string;
  reason: string | null;
  payload: Record<string, unknown>;
  requested_at: string;
}

export async function fetchIssueApprovals(missionIds: string[]): Promise<IssueApproval[]> {
  if (!missionIds.length) return [];
  // Les runs de ces missions d'abord : `internal_agent_approvals` porte
  // `mission_id`, mais il est nullable et les écritures d'outil ne le
  // renseignent pas toujours — le run, lui, est toujours là.
  const { data: runs } = await supabase.from("internal_agent_runs")
    .select("id").in("mission_id", missionIds);
  const runIds = (runs ?? []).map((r) => (r as { id: string }).id);
  if (!runIds.length) return [];

  const { data, error } = await supabase.from("internal_agent_approvals")
    .select("id, agent_id, tool_name, action_kind, reason, payload, requested_at")
    .in("run_id", runIds)
    .eq("status", "pending")
    .order("requested_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as IssueApproval[];
}

/**
 * Les work items d'un projet sur lesquels un agent travaille en ce moment.
 *
 * Deux lectures et non une jointure imbriquée : ce fichier a déjà payé un
 * embed `!inner` qui, sur un refus RLS, renvoyait une liste vide au lieu d'une
 * erreur — c'est-à-dire « aucun agent ne travaille » quand la vérité était « on
 * ne peut pas savoir ».
 */
export async function fetchWorkingIssueIds(pjProjectId: string): Promise<Set<string>> {
  const { data: missions } = await supabase.from("internal_agent_missions")
    .select("id, pj_issue_id")
    .eq("pj_project_id", pjProjectId)
    .not("pj_issue_id", "is", null);
  const rows = (missions ?? []) as Array<{ id: string; pj_issue_id: string }>;
  if (!rows.length) return new Set();

  const { data: runs } = await supabase.from("internal_agent_runs")
    .select("mission_id")
    .in("mission_id", rows.map((m) => m.id))
    .in("status", ["queued", "running"]);
  const active = new Set((runs ?? []).map((r) => (r as { mission_id: string }).mission_id));
  return new Set(rows.filter((m) => active.has(m.id)).map((m) => m.pj_issue_id));
}

export interface AttentionItem {
  kind: "approval" | "stalled";
  /** L'approbation pour « approval », l'item pour « stalled ». */
  ref_id: string;
  issue_id: string;
  pj_project_id: string;
  issue_ref: string;
  issue_name: string;
  agent_id: string | null;
  agent_name: string | null;
  /** L'action demandée, ou la dernière erreur. */
  detail: string | null;
  reason: string | null;
  since: string;
}

/** Ce qui attend une décision humaine dans tout le service (0248). */
export async function fetchAttentionQueue(dashboardId: string): Promise<AttentionItem[]> {
  const { data, error } = await supabase.rpc("pj_attention_queue", { p_dashboard: dashboardId });
  if (error) throw new Error(error.message);
  return (data ?? []) as AttentionItem[];
}

export async function decideApproval(
  approvalId: string, decision: "approve" | "reject",
): Promise<void> {
  await callEdge("internal-agent-approve", { approval_id: approvalId, decision });
}

/**
 * Ce que les agents ont produit sur UN work item, rangé par mission.
 *
 * La page Livrables d'un projet montre déjà tout, avec la preuve. Mais c'est la
 * fiche de l'item qu'on ouvre pour savoir où en est un sujet, et y lire « mission
 * aboutie » sans voir ce qui a été produit obligeait à changer d'écran pour la
 * seule chose qu'on voulait vérifier.
 */
export async function fetchIssueDeliverables(missionIds: string[]): Promise<Array<{
  id: string; mission_id: string; name: string; kind: string;
  content: string | null; file_url: string | null; created_at: string;
}>> {
  if (!missionIds.length) return [];
  const { data, error } = await supabase.from("internal_agent_deliverables")
    .select("id, mission_id, name, kind, content, file_url, created_at")
    .in("mission_id", missionIds)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{
    id: string; mission_id: string; name: string; kind: string;
    content: string | null; file_url: string | null; created_at: string;
  }>;
}

/** Les missions d'un work item, avec l'état de leur dernière tentative. */
export async function fetchIssueMissions(issueId: string): Promise<Array<{
  id: string; title: string; status: string; created_at: string;
  agent_id: string | null; run_status: string | null; run_id: string | null;
}>> {
  const { data } = await supabase.from("internal_agent_missions")
    .select("id, title, status, created_at, agent_id")
    .eq("pj_issue_id", issueId)
    .order("created_at", { ascending: false });
  const missions = (data ?? []) as Array<{
    id: string; title: string; status: string; created_at: string; agent_id: string | null;
  }>;
  if (!missions.length) return [];

  const { data: runs } = await supabase.from("internal_agent_runs")
    .select("id, mission_id, status, created_at")
    .in("mission_id", missions.map((m) => m.id))
    .order("created_at", { ascending: false });

  // La DERNIÈRE tentative fait foi : une mission relancée trois fois se juge à
  // son dernier essai, pas au premier.
  const latest = new Map<string, { id: string; status: string }>();
  for (const r of (runs ?? []) as Array<{ id: string; mission_id: string; status: string }>) {
    if (!latest.has(r.mission_id)) latest.set(r.mission_id, { id: r.id, status: r.status });
  }

  return missions.map((m) => ({
    ...m,
    run_id: latest.get(m.id)?.id ?? null,
    run_status: latest.get(m.id)?.status ?? null,
  }));
}
