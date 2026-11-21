// Le catalogue d'outils d'un agent FounderOS sur OpenCode (docs/harness-opencode/03).
//
// L'ancien moteur exposait jusqu'à 105 outils fixes, plus un par connecteur,
// action Composio ou outil MCP. Beaucoup faisaient presque la même chose (six
// façons d'aller chercher du contexte), et tout montrer d'un coup saturait le
// modèle. Ici :
//
//   - un NOYAU toujours visible, de quelques outils : open_lot, build_context,
//     context_page, remember, et les outils natifs d'OpenCode pour planifier,
//     demander, déléguer à un spécialiste et charger un skill ;
//   - des LOTS, fermés par défaut : le modèle en ouvre un (open_lot), ne voit que
//     ses outils, en choisit un, ou ouvre un autre lot (un seul lot à la fois) ;
//   - des outils REGROUPÉS : un outil par famille, avec un paramètre `action`
//     (ou `type`), chaque valeur décrite. Derrière, les handlers de l'ancien
//     moteur, inchangés (prepareAgentToolset).
//
// Ce module est pur : il construit les outils à partir des schémas de l'ancien
// jeu d'outils, sans rien savoir d'OpenCode ni de la base.

/** Un outil de l'ancien moteur, tel que buildInternalToolset le décrit. */
export interface LegacyDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** L'ancien jeu d'outils d'un agent : ses schémas et son exécuteur. */
export interface LegacyToolset {
  defs: LegacyDef[];
  run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

export type LotId = "web" | "livrables" | "execution" | "equipe" | "applications" | "metier" | "admin" | "fichiers";

export interface LotSpec {
  id: LotId;
  /** Une ligne : ce qu'on y trouve, pour choisir sans ouvrir. */
  summary: string;
}

export const LOTS: LotSpec[] = [
  { id: "web", summary: "chercher sur le web, lire une page, recherche approfondie, appel HTTP, navigateur" },
  { id: "livrables", summary: "documents, artefacts, rapports, PDF, images, interface dans le chat" },
  { id: "applications", summary: "applications connectées (CRM, e-mail, Slack, MCP, automatisations, dashboards)" },
  { id: "metier", summary: "produits FounderOS de l'agent (tickets, code, prospects, support, sécurité, tests)" },
  { id: "equipe", summary: "collègues agents, délégation, missions, tâches, workflows" },
  { id: "execution", summary: "exécuter du code et des commandes sur une machine distante, processus, environnement" },
  { id: "fichiers", summary: "fichiers du dossier de travail de l'agent (lire, écrire, modifier, chercher)" },
  { id: "admin", summary: "administrer l'espace : agents, projets, connecteurs, équipes, dashboards" },
];

/** Une valeur d'`action` d'un outil regroupé : l'ancien outil qui la sert. */
interface ActionRoute {
  /** Les anciens noms, dans l'ordre de préférence (le premier présent sert). */
  legacy: string[];
  /** Des arguments imposés (team_memory → action=search, etc.). */
  fixed?: Record<string, unknown>;
  /** Quand l'ancien outil a lui aussi un paramètre `action` : le nom à lui rendre. */
  innerAction?: string;
}

interface FacadeSpec {
  name: string;
  lot: LotId;
  summary: string;
  /** `action` en général ; `type` pour generate. */
  key: string;
  actions: Record<string, ActionRoute>;
}

/** Un monde d'exécution distant : le préfixe des anciens outils en mode hybride. */
const WORLDS = ["runner", "sandbox", "team"] as const;

/**
 * Les outils regroupés. Chaque action renvoie à un outil de l'ancien moteur ;
 * une action dont aucun outil n'existe chez cet agent disparaît du schéma.
 */
const FACADES: FacadeSpec[] = [
  {
    name: "web", lot: "web", key: "action",
    summary: "Le web : chercher, lire une page, faire une recherche approfondie, télécharger, appeler une API HTTP.",
    actions: {
      search: { legacy: ["web_search"] },
      read: { legacy: ["read_url"] },
      research: { legacy: ["deep_research"] },
      download: { legacy: ["download_file"] },
      get: { legacy: ["http_get"] },
      request: { legacy: ["http_request"] },
    },
  },
  {
    name: "browser", lot: "web", key: "action",
    summary: "Piloter un navigateur : celui du runner, de la sandbox, ou celui de l'utilisateur.",
    actions: {
      runner: { legacy: ["browse_web"] },
      sandbox: { legacy: ["sandbox_browser"] },
      user: { legacy: ["user_browser"] },
    },
  },
  {
    name: "document", lot: "livrables", key: "action",
    summary: "Les livrables et artefacts : créer, compléter, relire, lister, lier, publier.",
    actions: {
      deliver: { legacy: ["create_deliverable"] },
      section: { legacy: ["report_section"] },
      create: { legacy: ["create_artifact"] },
      update: { legacy: ["update_artifact"] },
      add_block: { legacy: ["add_block"] },
      publish: { legacy: ["publish_artifact"] },
      read: { legacy: ["read_artifact"] },
      list: { legacy: ["list_artifacts"] },
      assets: { legacy: ["list_assets"] },
      link: { legacy: ["link_artifact"] },
    },
  },
  {
    name: "report", lot: "livrables", key: "action",
    summary: "Confier une matière brute au rédacteur, qui rend un rapport publié.",
    actions: { request: { legacy: ["request_report"] } },
  },
  {
    name: "generate", lot: "livrables", key: "type",
    summary: "Générer un fichier : un PDF mis en page, ou une image.",
    actions: { pdf: { legacy: ["generate_pdf"] }, image: { legacy: ["generate_image"] } },
  },
  {
    name: "interface", lot: "livrables", key: "action",
    summary: "Afficher dans le chat : un bloc d'interface, un guidage dans l'application, la page ouverte du navigateur.",
    actions: {
      render: { legacy: ["render_ui"] },
      guide: { legacy: ["guide_user"] },
      page: { legacy: ["page_assist"] },
    },
  },
  {
    name: "run_code", lot: "execution", key: "language",
    summary: "Exécuter du code ou une commande sur une machine distante (runner, sandbox ou machine d'équipe).",
    actions: {
      shell: { legacy: ["shell_exec", "team_shell"] },
      python: { legacy: ["python_exec"] },
      node: { legacy: ["nodejs_exec"] },
      jupyter: { legacy: ["jupyter_exec"] },
    },
  },
  {
    name: "remote_files", lot: "execution", key: "action",
    summary: "Les fichiers d'une machine distante.",
    actions: {
      read: { legacy: ["file_read"] },
      write: { legacy: ["file_write"] },
      edit: { legacy: ["file_edit"] },
      list: { legacy: ["list_files"] },
      search: { legacy: ["file_search"] },
      manage: { legacy: ["manage_files", "team_files"] },
      folders: { legacy: ["team_folders"] },
    },
  },
  {
    name: "process", lot: "execution", key: "action",
    summary: "Les processus longs d'une machine distante.",
    actions: {
      start: { legacy: ["run_background"] },
      list: { legacy: ["list_processes"] },
      logs: { legacy: ["process_logs"] },
      stop: { legacy: ["process_stop"] },
      jobs: { legacy: ["team_jobs"] },
    },
  },
  {
    name: "machine", lot: "execution", key: "action",
    summary: "La machine distante elle-même : état, environnement, installation de paquets, navigateur d'équipe.",
    actions: {
      info: { legacy: ["machine_info"] },
      env: { legacy: ["sandbox_env"] },
      install: { legacy: ["team_install"] },
      browser: { legacy: ["team_browser"] },
    },
  },
  {
    name: "team", lot: "equipe", key: "action",
    summary: "Les collègues agents : les lister, leur écrire, leur déléguer, leur passer la main.",
    actions: {
      list: { legacy: ["list_team_agents"] },
      message: { legacy: ["send_message_to_agent"] },
      delegate: { legacy: ["delegate_mission"] },
      handoff: { legacy: ["handoff_to_teammate"] },
    },
  },
  {
    name: "mission", lot: "equipe", key: "action",
    summary: "Le travail planifié : missions, tâches, propositions, workflows, nouveaux agents.",
    actions: {
      create: { legacy: ["create_mission"] },
      list: { legacy: ["list_missions"] },
      move: { legacy: ["move_mission"] },
      propose: { legacy: ["propose_mission"] },
      task: { legacy: ["create_task"] },
      workflow: { legacy: ["create_workflow"] },
      new_agent: { legacy: ["create_agent"] },
    },
  },
  {
    name: "workflow", lot: "equipe", key: "action",
    summary: "Construire un workflow pas à pas : le créer, le configurer, ajouter des blocs, les relier, l'activer.",
    actions: {
      list: { legacy: ["workflow_list"] },
      create: { legacy: ["workflow_create"] },
      configure: { legacy: ["workflow_configure"] },
      add_block: { legacy: ["workflow_add_block"] },
      link: { legacy: ["workflow_link"] },
      activate: { legacy: ["workflow_activate"] },
    },
  },
  {
    name: "admin", lot: "admin", key: "target",
    summary: "Administrer l'espace pour la personne qui parle (lis avant d'écrire).",
    actions: {
      agents: { legacy: ["manage_agents"] },
      projects: { legacy: ["manage_projects"] },
      connectors: { legacy: ["manage_connectors"] },
      teams: { legacy: ["manage_teams"] },
      dashboards: { legacy: ["manage_dashboards"] },
    },
  },
];

/** Les produits métier : un outil chacun, tel quel, dans le lot « metier ». */
const PRODUCT_TOOLS = [
  "tracker", "vibe_code", "lead_sense", "support_desk", "sentinel", "security_scan",
  "pentest_scope", "testing", "simulation", "training", "policy_audit",
];

/**
 * Les applications : intégrations natives, connecteurs internes, Composio, MCP,
 * automatisations. Elles passent toutes par UN outil `apps` (lister, décrire,
 * appeler) : le modèle choisit l'application, puis l'opération.
 */
const APP_TOOLS_FIXED = ["crm", "send_email", "run_automation", "dashboard", "list_connectors"];
const isAppTool = (name: string) =>
  APP_TOOLS_FIXED.includes(name) || /^(mcp_|ext_|composio_|app_|custom_)/.test(name);

/**
 * Ce que l'ancien moteur avait et qui disparaît : le noyau OpenCode le fait
 * (todowrite, question, skill, subagent, webfetch, sorties persistées), ou un
 * outil regroupé le couvre (build_context, remember).
 */
export const RETIRED = new Set([
  "load_toolset", "need_tools", "list_skills", "use_skill", "read_skill_file", "use_procedure",
  "update_todos", "ask_user", "say", "spawn_parallel_agents", "message_subagent", "read_tool_output",
  // → build_context
  "search_context", "search_history", "search_memory", "search_past_work", "search_knowledge",
  "knowledge_search", "recall_findings", "company_objectives", "explore_company_graph", "query_table",
  "my_resources",
  // → remember
  "save_memory", "remember_preference", "knowledge_save", "team_memory",
]);

// ── Le contexte : build_context ──────────────────────────────────────────────

export interface ContextTypeSpec {
  id: string;
  /** Ce que contient ce type, pour que le modèle choisisse sans se tromper. */
  description: string;
  /** Les appels aux anciens outils qui lisent ce type. */
  calls(query: string, opts: { limit: number; filter?: Record<string, unknown> }): Array<{ tool: string; args: Record<string, unknown> }>;
}

export const CONTEXT_TYPES: ContextTypeSpec[] = [
  {
    id: "conversation",
    description: "les étapes et résultats d'outils plus anciens de CE travail (ce que la compaction a retiré)",
    calls: (query, o) => [{ tool: "search_history", args: { query, limit: o.limit } }],
  },
  {
    id: "memory",
    description: "ta mémoire durable : faits appris, préférences des personnes, décisions passées",
    calls: (query) => [{ tool: "search_memory", args: { query } }],
  },
  {
    id: "team",
    description: "la mémoire partagée de ton équipe d'agents",
    calls: (query) => [{ tool: "team_memory", args: { action: "search", query } }],
  },
  {
    id: "past_work",
    description: "les livrables et résultats de tes travaux précédents",
    calls: (query, o) => [{ tool: "search_past_work", args: { query, limit: Math.min(o.limit, 10) } }],
  },
  {
    id: "findings",
    description: "les trouvailles notées pendant ce travail (sources, chiffres, citations)",
    calls: (query, o) => [{ tool: "recall_findings", args: { query, limit: Math.min(o.limit, 15) } }],
  },
  {
    id: "documents",
    description: "les documents de la base de connaissances du projet (passages, recherche sémantique)",
    calls: (query, o) => [{
      tool: "search_knowledge",
      args: { query, limit: Math.min(o.limit, 10), ...(o.filter?.collection_id ? { collection_id: o.filter.collection_id } : {}) },
    }],
  },
  {
    id: "facts",
    description: "le graphe de connaissances : entités (clients, produits, personnes) et faits reliés",
    calls: (query, o) => [{ tool: "knowledge_search", args: { query, limit: Math.min(o.limit, 20), ...(o.filter?.kind ? { kind: o.filter.kind } : {}) } }],
  },
  {
    id: "company",
    description: "l'entreprise : objectifs, priorités, organisation et liens entre équipes",
    calls: (query, o) => [
      { tool: "company_objectives", args: { action: "list" } },
      { tool: "explore_company_graph", args: query ? { action: "search", query, limit: Math.min(o.limit * 2, 60) } : { action: "overview" } },
    ],
  },
  {
    id: "artifacts",
    description: "les artefacts et documents déjà produits dans ce projet",
    calls: (query, o) => [{ tool: "list_artifacts", args: { query, limit: Math.min(o.limit * 2, 40) } }],
  },
  {
    id: "resources",
    description: "ce que tu as à disposition : applications, collections, automatisations, skills",
    calls: (query) => [{ tool: "my_resources", args: query ? { query } : {} }],
  },
  {
    id: "table",
    description: "des lignes d'une table du projet, en lecture seule ; filter = { table, columns?, filters?, order_by? }",
    calls: (_query, o) => [{ tool: "query_table", args: { ...(o.filter ?? {}), limit: Math.min(o.limit * 3, 100) } }],
  },
];

/** remember : une seule écriture de mémoire, quatre destinations. */
export const MEMORY_KINDS: Record<string, { legacy: string; description: string; args(a: Record<string, unknown>): Record<string, unknown> | string }> = {
  fact: {
    legacy: "save_memory", description: "un fait durable pour toi : une décision, un identifiant, une leçon (content, importance 1-5)",
    args: (a) => (a.content ? { content: a.content, ...(a.importance != null ? { importance: a.importance } : {}) } : "content est requis."),
  },
  preference: {
    legacy: "remember_preference", description: "une préférence de la personne avec qui tu parles (content ; topic, replaces, remove)",
    args: (a) => (a.content
      ? { text: a.content, ...(a.topic ? { topic: a.topic } : {}), ...(a.replaces ? { replaces: a.replaces } : {}), ...(a.remove ? { op: "remove" } : {}) }
      : "content est requis."),
  },
  team: {
    legacy: "team_memory", description: "une connaissance utile à toute ton équipe d'agents (content)",
    args: (a) => (a.content ? { action: "add", content: a.content } : "content est requis."),
  },
  knowledge: {
    legacy: "knowledge_save", description: "des entités et leurs faits pour le graphe de connaissances partagé de l'espace (entities, relations)",
    args: (a) => (Array.isArray(a.entities) && a.entities.length
      ? { entities: a.entities, ...(a.relations ? { relations: a.relations } : {}) }
      : "entities est requis : [{ name, kind, facts: [{ statement }] }]."),
  },
};

// ── Construction ─────────────────────────────────────────────────────────────

/** Un outil prêt à être enregistré dans OpenCode. */
export interface KitTool {
  name: string;
  /** null : le noyau, toujours visible. */
  lot: LotId | null;
  description: string;
  /** Le schéma JSON montré au modèle. */
  input: Record<string, unknown>;
  run(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

type JsonObject = Record<string, any>;

const firstSentence = (s: string, max = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  const m = t.match(/^(.{12,}?[.!?])\s/);
  const out = m ? m[1] : t;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
};

/** Le nom effectif d'un ancien outil : tel quel, ou préfixé par son monde (mode hybride). */
function resolveLegacy(names: string[], have: Map<string, LegacyDef>, world?: string): string | null {
  if (world) {
    for (const n of names) {
      if (have.has(`${world}_${n}`)) return `${world}_${n}`;
      if (n.startsWith(`${world}_`) && have.has(n)) return n;
    }
  }
  for (const n of names) {
    if (have.has(n)) return n;
    for (const w of WORLDS) if (have.has(`${w}_${n}`)) return `${w}_${n}`;
  }
  return null;
}

/** L'agent a-t-il plusieurs machines pour ces outils (runner_, sandbox_, team_) ? */
const worldsOf = (names: string[], have: Map<string, LegacyDef>) => new Set(
  names.flatMap((n) => WORLDS.filter((w) => have.has(`${w}_${n}`) || (n.startsWith(`${w}_`) && have.has(n)))),
);

/**
 * Un outil regroupé : `key` choisit l'action, les autres propriétés sont l'union
 * de celles des anciens outils (la description dit à quelle action chacune sert).
 */
function buildFacade(spec: FacadeSpec, legacy: LegacyToolset, have: Map<string, LegacyDef>): KitTool | null {
  const live = Object.entries(spec.actions)
    .map(([action, route]) => ({ action, route, def: (() => { const n = resolveLegacy(route.legacy, have); return n ? have.get(n)! : null; })() }))
    .filter((a): a is { action: string; route: ActionRoute; def: LegacyDef } => !!a.def);
  if (!live.length) return null;

  const props: JsonObject = {};
  const usedBy = new Map<string, string[]>();
  const required = new Map<string, string[]>();
  const hasWorlds = worldsOf(live.flatMap((a) => a.route.legacy), have).size > 1;
  for (const { action, def } of live) {
    const p = (def.parameters as JsonObject)?.properties ?? {};
    for (const [k, v] of Object.entries(p)) {
      // Le paramètre `action` d'un ancien outil devient `operation`.
      const name = k === spec.key || k === "action" ? "operation" : k;
      if (!props[name]) props[name] = { ...(v as JsonObject) };
      usedBy.set(name, [...(usedBy.get(name) ?? []), action]);
    }
    required.set(action, ((def.parameters as JsonObject)?.required ?? []).map((k: string) => (k === spec.key || k === "action" ? "operation" : k)));
  }
  for (const [name, actions] of usedBy) {
    if (actions.length === live.length) continue;
    const d = props[name].description ? `${props[name].description} ` : "";
    props[name].description = `${d}(${spec.key} = ${actions.join(" | ")})`;
  }
  const actionDoc = live.map(({ action, def }) => {
    const req = required.get(action)!;
    return `- ${action} : ${firstSentence(def.description)}${req.length ? ` Requis : ${req.join(", ")}.` : ""}`;
  }).join("\n");
  const input: JsonObject = {
    type: "object",
    properties: {
      [spec.key]: { type: "string", enum: live.map((a) => a.action), description: `Ce que tu fais.` },
      ...(hasWorlds ? { world: { type: "string", enum: [...WORLDS], description: "La machine (si l'agent en a plusieurs)." } } : {}),
      ...props,
    },
    required: [spec.key],
    additionalProperties: false,
  };

  return {
    name: spec.name,
    lot: spec.lot,
    description: `${spec.summary}\n${actionDoc}`,
    input,
    run: async (args, signal) => {
      const action = String(args[spec.key] ?? "");
      const entry = live.find((a) => a.action === action);
      if (!entry) return `ERROR: ${spec.key} « ${action} » inconnu. Valeurs : ${live.map((a) => a.action).join(", ")}.`;
      const world = typeof args.world === "string" ? args.world : undefined;
      const target = resolveLegacy(entry.route.legacy, have, world)!;
      const rest: JsonObject = {};
      for (const [k, v] of Object.entries(args)) {
        if (k === spec.key || k === "world") continue;
        rest[k === "operation" ? "action" : k] = v;
      }
      const missing = (required.get(action) ?? []).filter((k) => rest[k === "operation" ? "action" : k] == null);
      if (missing.length) return `ERROR: ${spec.key}=${action} demande : ${missing.join(", ")}.`;
      return legacy.run(target, { ...rest, ...(entry.route.fixed ?? {}) }, signal);
    },
  };
}

/** Le lot « applications » : lister, décrire, appeler — un outil pour toutes. */
function buildApps(legacy: LegacyToolset, have: Map<string, LegacyDef>): KitTool | null {
  const apps = [...have.values()].filter((d) => isAppTool(d.name));
  if (!apps.length) return null;
  return {
    name: "apps",
    lot: "applications",
    description:
      "Les applications connectées de l'agent. Procède en trois temps : action=list (les applications, une ligne chacune), " +
      "action=describe avec app (le schéma complet de ses paramètres), puis action=call avec app et params.",
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "describe", "call"] },
        app: { type: "string", description: "Le nom de l'application, tel que list le donne (describe, call)." },
        filter: { type: "string", description: "list : un mot pour filtrer (ex. slack, crm)." },
        params: { type: "object", description: "call : les paramètres, selon le schéma que describe a rendu." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    run: async (args, signal) => {
      const action = String(args.action ?? "");
      if (action === "list") {
        const f = typeof args.filter === "string" ? args.filter.toLowerCase() : "";
        const rows = apps.filter((a) => !f || `${a.name} ${a.description}`.toLowerCase().includes(f));
        return rows.length
          ? `<apps count="${rows.length}">\n${rows.map((a) => `- ${a.name} : ${firstSentence(a.description, 140)}`).join("\n")}\n</apps>`
          : `Aucune application ne correspond à « ${f} ».`;
      }
      const app = apps.find((a) => a.name === args.app);
      if (!app) return `ERROR: application « ${String(args.app ?? "")} » inconnue. Appelle d'abord action=list.`;
      if (action === "describe") {
        return `<app name="${app.name}">\n${app.description}\n<params>${JSON.stringify(app.parameters)}</params>\n</app>`;
      }
      if (action === "call") {
        const params = (args.params && typeof args.params === "object" ? args.params : {}) as JsonObject;
        const req: string[] = (app.parameters as JsonObject)?.required ?? [];
        const missing = req.filter((k) => params[k] == null);
        if (missing.length) return `ERROR: ${app.name} demande : ${missing.join(", ")}. Relis son schéma (action=describe).`;
        return legacy.run(app.name, params, signal);
      }
      return "ERROR: action = list | describe | call.";
    },
  };
}

/** Les outils d'un agent : les regroupés, ses produits métier, ses applications. */
export function buildKitTools(legacy: LegacyToolset, opts: { isOrchestrator?: boolean } = {}): KitTool[] {
  const have = new Map(legacy.defs.map((d) => [d.name, d]));
  const out: KitTool[] = [];
  for (const spec of FACADES) {
    if (spec.lot === "admin" && !opts.isOrchestrator) continue;
    const t = buildFacade(spec, legacy, have);
    if (t) out.push(t);
  }
  for (const name of PRODUCT_TOOLS) {
    const d = have.get(name);
    if (!d) continue;
    out.push({
      name: d.name, lot: "metier", description: d.description, input: d.parameters,
      run: (args, signal) => legacy.run(d.name, args, signal),
    });
  }
  const apps = buildApps(legacy, have);
  if (apps) out.push(apps);
  return out;
}

/**
 * Les anciens outils qu'aucun outil du nouveau catalogue ne sert : signalés au
 * démarrage pour qu'un outil ajouté à l'ancien moteur ne disparaisse pas en silence.
 */
export function uncovered(legacy: LegacyToolset): string[] {
  const covered = new Set<string>(RETIRED);
  for (const s of FACADES) for (const r of Object.values(s.actions)) for (const n of r.legacy) covered.add(n);
  for (const n of PRODUCT_TOOLS) covered.add(n);
  return legacy.defs
    .map((d) => d.name)
    .filter((n) => !covered.has(n) && !covered.has(n.replace(/^(runner|sandbox|team)_/, "")) && !isAppTool(n));
}
