import {
  PRIORITIES, STATE_GROUPS,
  type Member, type PjCycle, type PjIssue, type PjLabel, type PjModule, type PjState,
  type Priority, type StateGroup,
} from "./model";

/**
 * Filtres, groupement et tri — repris de Plane, où ces trois réglages forment
 * un seul objet qu'on sauvegarde tel quel dans une vue.
 *
 * Le point important : rien de tout ça ne part au serveur. Un board tire les
 * items de son projet une fois, puis filtre, groupe et trie en mémoire. Faire
 * l'inverse (une requête par changement de filtre) rendrait chaque clic sur une
 * case à cocher aussi lent qu'un chargement de page, pour des volumes — quelques
 * milliers d'items par projet — que le navigateur traite sans transpirer.
 */

export type Layout = "list" | "kanban" | "calendar" | "spreadsheet" | "gantt";

export const LAYOUTS: { key: Layout; label: string }[] = [
  { key: "list", label: "Liste" },
  { key: "kanban", label: "Tableau" },
  { key: "calendar", label: "Calendrier" },
  { key: "spreadsheet", label: "Tableur" },
  { key: "gantt", label: "Gantt" },
];

export type GroupBy =
  | "state" | "state_group" | "priority" | "labels" | "assignees"
  | "cycle" | "module" | "created_by" | "target_date" | null;

export type OrderBy =
  | "manual" | "created_at" | "-created_at" | "updated_at" | "-updated_at"
  | "priority" | "target_date" | "-target_date" | "sequence_id" | "-sequence_id";

export const GROUP_BY_OPTIONS: { key: Exclude<GroupBy, null> | "none"; label: string }[] = [
  { key: "state", label: "État" },
  { key: "state_group", label: "Groupe d'état" },
  { key: "priority", label: "Priorité" },
  { key: "labels", label: "Labels" },
  { key: "assignees", label: "Assignés" },
  { key: "cycle", label: "Cycle" },
  { key: "module", label: "Module" },
  { key: "created_by", label: "Créé par" },
  { key: "target_date", label: "Échéance" },
  { key: "none", label: "Aucun" },
];

export const ORDER_BY_OPTIONS: { key: OrderBy; label: string }[] = [
  { key: "manual", label: "Manuel" },
  { key: "-created_at", label: "Créé le (récent)" },
  { key: "created_at", label: "Créé le (ancien)" },
  { key: "-updated_at", label: "Modifié le (récent)" },
  { key: "priority", label: "Priorité" },
  { key: "target_date", label: "Échéance" },
  { key: "sequence_id", label: "Référence" },
];

/** Ce que la barre de filtres a coché. Un tableau vide = pas de contrainte. */
export interface Filters {
  state: string[];
  state_group: StateGroup[];
  priority: Priority[];
  assignees: string[];
  /** Les agents assignés. Séparés des personnes, comme sur la fiche : « qui
   *  s'en occupe » ne se pose pas pareil selon que c'est un humain ou non. */
  agents: string[];
  created_by: string[];
  labels: string[];
  cycle: string[];
  module: string[];
  issue_type: string[];
  start_date: string[];
  target_date: string[];
  /** La recherche plein texte de la barre du haut. */
  query: string;
}

export interface DisplayFilters {
  layout: Layout;
  group_by: GroupBy;
  sub_group_by: GroupBy;
  order_by: OrderBy;
  /** Le filtre « rapide » de Plane : tout / actifs / backlog. */
  type: "all" | "active" | "backlog";
  /** Une sous-tâche s'affiche-t-elle à la racine de la liste ? */
  sub_issue: boolean;
  show_empty_groups: boolean;
}

export interface DisplayProperties {
  key: boolean;
  state: boolean;
  priority: boolean;
  assignee: boolean;
  labels: boolean;
  start_date: boolean;
  due_date: boolean;
  estimate: boolean;
  sub_issue_count: boolean;
  attachment_count: boolean;
  link: boolean;
  cycle: boolean;
  modules: boolean;
  created_on: boolean;
  updated_on: boolean;
}

export const EMPTY_FILTERS: Filters = {
  state: [], state_group: [], priority: [], assignees: [], agents: [], created_by: [],
  labels: [], cycle: [], module: [], issue_type: [], start_date: [], target_date: [],
  query: "",
};

export const DEFAULT_DISPLAY_FILTERS: DisplayFilters = {
  layout: "list",
  group_by: "state",
  sub_group_by: null,
  order_by: "manual",
  type: "all",
  sub_issue: true,
  show_empty_groups: true,
};

/**
 * Ce qu'une carte montre par défaut. Volontairement sobre : Plane affiche tout,
 * ce qui donne des cartes hautes où le titre se perd. On laisse les compteurs et
 * les dates de création à ceux qui vont les cocher.
 */
export const DEFAULT_DISPLAY_PROPERTIES: DisplayProperties = {
  key: true, state: true, priority: true, assignee: true, labels: true,
  start_date: false, due_date: true, estimate: false,
  sub_issue_count: true, attachment_count: true, link: false,
  cycle: false, modules: false, created_on: false, updated_on: false,
};

export const DISPLAY_PROPERTY_LABELS: Record<keyof DisplayProperties, string> = {
  key: "Référence", state: "État", priority: "Priorité", assignee: "Assignés",
  labels: "Labels", start_date: "Date de début", due_date: "Échéance",
  estimate: "Estimation", sub_issue_count: "Sous-tâches",
  attachment_count: "Pièces jointes", link: "Liens", cycle: "Cycle",
  modules: "Modules", created_on: "Créé le", updated_on: "Modifié le",
};

export function countActiveFilters(f: Filters): number {
  return (
    f.state.length + f.state_group.length + f.priority.length + f.assignees.length +
    (f.agents ?? []).length +
    f.created_by.length + f.labels.length + f.cycle.length + f.module.length +
    f.issue_type.length + f.start_date.length + f.target_date.length +
    (f.query.trim() ? 1 : 0)
  );
}

// ── Filtrage ────────────────────────────────────────────────────────────────

/**
 * Les jetons de date sont ceux de Plane (`last_week`, `today`…) plutôt que des
 * dates absolues : une vue sauvegardée « en retard » doit rester juste demain.
 */
function matchDateToken(value: string | null, token: string, today: Date): boolean {
  if (!value) return token === "none";
  const d = value.slice(0, 10);
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  const shift = (days: number) => {
    const dt = new Date(today);
    dt.setDate(dt.getDate() + days);
    return iso(dt);
  };
  switch (token) {
    case "today": return d === iso(today);
    case "yesterday": return d === shift(-1);
    case "tomorrow": return d === shift(1);
    case "this_week": return d >= shift(-7) && d <= iso(today);
    case "next_week": return d > iso(today) && d <= shift(7);
    case "next_month": return d > iso(today) && d <= shift(30);
    case "overdue": return d < iso(today);
    case "none": return false;
    default: return d === token; // date absolue
  }
}

export function applyFilters(
  issues: PjIssue[],
  filters: Filters,
  display: DisplayFilters,
  states: PjState[],
  today = new Date(),
): PjIssue[] {
  const groupOf = new Map(states.map((s) => [s.id, s.group]));
  const q = filters.query.trim().toLowerCase();

  return issues.filter((i) => {
    // Le filtre rapide passe avant les autres : c'est lui qui décide si le
    // backlog fait partie de la conversation.
    const g = i.state_id ? groupOf.get(i.state_id) : undefined;
    if (display.type === "active" && (g === "backlog" || g === "completed" || g === "cancelled")) return false;
    if (display.type === "backlog" && g !== "backlog") return false;

    // Une sous-tâche masquée ne disparaît pas du produit : elle reste visible
    // dans l'arbre de son parent, seulement pas à la racine de la liste.
    if (!display.sub_issue && i.parent_id) return false;

    if (filters.state.length && (!i.state_id || !filters.state.includes(i.state_id))) return false;
    if (filters.state_group.length && (!g || !filters.state_group.includes(g))) return false;
    if (filters.priority.length && !filters.priority.includes(i.priority)) return false;
    if (filters.issue_type.length && (!i.type_id || !filters.issue_type.includes(i.type_id))) return false;
    if (filters.created_by.length && (!i.created_by || !filters.created_by.includes(i.created_by))) return false;

    // Sur les champs multivalués, un item passe s'il porte AU MOINS une des
    // valeurs cochées. Exiger toutes les valeurs donnerait un filtre qui ne
    // renvoie presque jamais rien.
    if (filters.assignees.length) {
      const wantsNone = filters.assignees.includes("none");
      const hit = i.assignee_ids.some((a) => filters.assignees.includes(a));
      if (!hit && !(wantsNone && i.assignee_ids.length === 0)) return false;
    }
    // `?? []` : un filtre enregistré avant l'arrivée de ce champ ne le porte pas.
    const agentFilter = filters.agents ?? [];
    if (agentFilter.length) {
      const ids = i.agent_ids ?? [];
      const wantsNone = agentFilter.includes("none");
      const hit = ids.some((a) => agentFilter.includes(a));
      if (!hit && !(wantsNone && ids.length === 0)) return false;
    }
    if (filters.labels.length) {
      const wantsNone = filters.labels.includes("none");
      const hit = i.label_ids.some((l) => filters.labels.includes(l));
      if (!hit && !(wantsNone && i.label_ids.length === 0)) return false;
    }
    if (filters.cycle.length) {
      const wantsNone = filters.cycle.includes("none");
      if (!(i.cycle_id && filters.cycle.includes(i.cycle_id)) && !(wantsNone && !i.cycle_id)) return false;
    }
    if (filters.module.length) {
      const wantsNone = filters.module.includes("none");
      const hit = i.module_ids.some((m) => filters.module.includes(m));
      if (!hit && !(wantsNone && i.module_ids.length === 0)) return false;
    }

    if (filters.start_date.length &&
        !filters.start_date.some((t) => matchDateToken(i.start_date, t, today))) return false;
    if (filters.target_date.length &&
        !filters.target_date.some((t) => matchDateToken(i.target_date, t, today))) return false;

    if (q) {
      const hay = `${i.name} ${i.description_text} ${i.sequence_id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ── Tri ─────────────────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0, high: 1, medium: 2, low: 3, none: 4,
};

export function sortIssues(issues: PjIssue[], orderBy: OrderBy): PjIssue[] {
  const out = issues.slice();
  // Une date absente se range TOUJOURS en dernier, quel que soit le sens du
  // tri : « pas d'échéance » n'est pas une échéance très ancienne.
  const byDate = (a: string | null, b: string | null, dir: number) => {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? -dir : a > b ? dir : 0;
  };
  out.sort((a, b) => {
    switch (orderBy) {
      case "manual": return a.sort_order - b.sort_order;
      case "created_at": return a.created_at < b.created_at ? -1 : 1;
      case "-created_at": return a.created_at > b.created_at ? -1 : 1;
      case "updated_at": return a.updated_at < b.updated_at ? -1 : 1;
      case "-updated_at": return a.updated_at > b.updated_at ? -1 : 1;
      case "priority": return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      case "target_date": return byDate(a.target_date, b.target_date, 1);
      case "-target_date": return byDate(a.target_date, b.target_date, -1);
      case "sequence_id": return a.sequence_id - b.sequence_id;
      case "-sequence_id": return b.sequence_id - a.sequence_id;
      default: return 0;
    }
  });
  return out;
}

// ── Groupement ──────────────────────────────────────────────────────────────

export interface IssueGroup {
  key: string;
  label: string;
  color?: string;
  /** L'entité derrière le groupe, pour que l'en-tête puisse l'afficher. */
  payload?: PjState | PjLabel | Member | PjCycle | PjModule | null;
  issues: PjIssue[];
}

export interface GroupContext {
  states: PjState[];
  labels: PjLabel[];
  members: Member[];
  cycles: PjCycle[];
  modules: PjModule[];
}

const NONE = "__none__";

function memberLabel(m: Member | undefined, id: string): string {
  return m?.full_name || m?.email || id.slice(0, 8);
}

/**
 * Construit les colonnes/sections d'un board.
 *
 * Deux choses à savoir :
 *  - les groupes sont énumérés depuis le RÉFÉRENTIEL, pas depuis les items :
 *    une colonne « En cours » vide doit exister, sinon on ne peut rien y
 *    déposer, ce qui casse le kanban dès qu'une colonne se vide ;
 *  - sur un champ multivalué (labels, assignés, modules), un item apparaît dans
 *    chaque groupe auquel il appartient. C'est voulu, et c'est ce que fait
 *    Plane : le total des colonnes dépasse alors le nombre d'items.
 */
export function groupIssues(
  issues: PjIssue[], groupBy: GroupBy, ctx: GroupContext,
): IssueGroup[] {
  if (!groupBy) return [{ key: "all", label: "Tous les work items", issues }];

  const buckets = new Map<string, PjIssue[]>();
  const push = (k: string, i: PjIssue) => {
    const arr = buckets.get(k);
    if (arr) arr.push(i); else buckets.set(k, [i]);
  };

  for (const i of issues) {
    switch (groupBy) {
      case "state": push(i.state_id ?? NONE, i); break;
      case "state_group": {
        const g = ctx.states.find((s) => s.id === i.state_id)?.group;
        push(g ?? NONE, i);
        break;
      }
      case "priority": push(i.priority, i); break;
      case "created_by": push(i.created_by ?? NONE, i); break;
      case "cycle": push(i.cycle_id ?? NONE, i); break;
      case "target_date": push(i.target_date ?? NONE, i); break;
      case "labels":
        if (!i.label_ids.length) push(NONE, i);
        else i.label_ids.forEach((l) => push(l, i));
        break;
      case "assignees":
        if (!i.assignee_ids.length) push(NONE, i);
        else i.assignee_ids.forEach((a) => push(a, i));
        break;
      case "module":
        if (!i.module_ids.length) push(NONE, i);
        else i.module_ids.forEach((m) => push(m, i));
        break;
    }
  }

  const take = (key: string) => buckets.get(key) ?? [];
  const groups: IssueGroup[] = [];

  switch (groupBy) {
    case "state":
      for (const s of ctx.states) {
        groups.push({ key: s.id, label: s.name, color: s.color, payload: s, issues: take(s.id) });
      }
      break;
    case "state_group":
      for (const g of STATE_GROUPS) {
        groups.push({ key: g.key, label: g.label, color: g.color, issues: take(g.key) });
      }
      break;
    case "priority":
      for (const p of PRIORITIES) {
        groups.push({ key: p.key, label: p.label, color: p.color, issues: take(p.key) });
      }
      break;
    case "labels":
      for (const l of ctx.labels) {
        groups.push({ key: l.id, label: l.name, color: l.color, payload: l, issues: take(l.id) });
      }
      break;
    case "assignees":
      for (const m of ctx.members) {
        groups.push({ key: m.user_id, label: memberLabel(m, m.user_id), payload: m, issues: take(m.user_id) });
      }
      break;
    case "cycle":
      for (const c of ctx.cycles) {
        groups.push({ key: c.id, label: c.name, payload: c, issues: take(c.id) });
      }
      break;
    case "module":
      for (const m of ctx.modules) {
        groups.push({ key: m.id, label: m.name, payload: m, issues: take(m.id) });
      }
      break;
    case "created_by":
      for (const m of ctx.members) {
        groups.push({ key: m.user_id, label: memberLabel(m, m.user_id), payload: m, issues: take(m.user_id) });
      }
      break;
    case "target_date": {
      // Les dates ne viennent d'aucun référentiel : les groupes sont ceux
      // effectivement présents, du plus proche au plus lointain.
      const dates = [...buckets.keys()].filter((k) => k !== NONE).sort();
      for (const d of dates) {
        groups.push({ key: d, label: new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }), issues: take(d) });
      }
      break;
    }
  }

  // Le groupe « sans valeur » se pose en dernier, et seulement s'il contient
  // quelque chose : une colonne « Sans label » vide n'apprend rien.
  const none = take(NONE);
  if (none.length) {
    groups.push({ key: NONE, label: noneLabel(groupBy), issues: none });
  }
  return groups;
}

function noneLabel(groupBy: GroupBy): string {
  switch (groupBy) {
    case "assignees": return "Non assigné";
    case "labels": return "Sans label";
    case "cycle": return "Hors cycle";
    case "module": return "Hors module";
    case "target_date": return "Sans échéance";
    case "created_by": return "Auteur inconnu";
    default: return "Sans état";
  }
}

export const NONE_GROUP_KEY = NONE;

/**
 * Le pipeline complet, dans l'ordre où il doit tourner : filtrer, trier, puis
 * grouper. Trier après avoir groupé donnerait des colonnes ordonnées entre
 * elles mais pas à l'intérieur.
 */
export function buildBoard(input: {
  issues: PjIssue[];
  filters: Filters;
  display: DisplayFilters;
  ctx: GroupContext;
}): IssueGroup[] {
  const filtered = applyFilters(input.issues, input.filters, input.display, input.ctx.states);
  const sorted = sortIssues(filtered, input.display.order_by);
  const groups = groupIssues(sorted, input.display.group_by, input.ctx);
  return input.display.show_empty_groups ? groups : groups.filter((g) => g.issues.length > 0);
}

// ── Persistance locale ──────────────────────────────────────────────────────

/**
 * Les réglages d'affichage suivent la personne, pas la base : c'est une
 * préférence de poste de travail. On les garde par projet — quelqu'un qui
 * travaille en kanban sur un projet et en tableur sur un autre ne doit pas
 * rebasculer à chaque changement.
 */
export function loadDisplay(scopeKey: string): { display: DisplayFilters; properties: DisplayProperties } {
  try {
    const raw = localStorage.getItem(`tracker-display-${scopeKey}`);
    if (raw) {
      const parsed = JSON.parse(raw) as { display?: Partial<DisplayFilters>; properties?: Partial<DisplayProperties> };
      return {
        display: { ...DEFAULT_DISPLAY_FILTERS, ...(parsed.display ?? {}) },
        properties: { ...DEFAULT_DISPLAY_PROPERTIES, ...(parsed.properties ?? {}) },
      };
    }
  } catch {
    // Un stockage indisponible (navigation privée, quota) ne doit pas empêcher
    // le board de s'ouvrir sur ses réglages par défaut.
  }
  return { display: DEFAULT_DISPLAY_FILTERS, properties: DEFAULT_DISPLAY_PROPERTIES };
}

export function saveDisplay(
  scopeKey: string, display: DisplayFilters, properties: DisplayProperties,
): void {
  try {
    localStorage.setItem(`tracker-display-${scopeKey}`, JSON.stringify({ display, properties }));
  } catch {
    // Idem : perdre une préférence est sans gravité.
  }
}
