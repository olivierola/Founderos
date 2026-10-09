// Ce que l'assistant sait FAIRE sur l'espace de travail, et pas seulement dire.
//
// Deux surfaces portent le nom « Assistant » : l'agent chef d'orchestre des
// rooms d'un service (internal_agents.is_orchestrator) et le panneau flottant
// (ai-agent-chat). Jusqu'ici, la première savait créer un agent nu et rien de
// plus ; la seconde savait régler un agent existant mais pas en créer un, et
// aucune des deux ne touchait au suivi de travail. Une demande comme « crée un
// agent SEO branché sur Search Console, donne-lui la skill d'audit et mets-le
// sur le projet Refonte » finissait en mode d'emploi.
//
// Ce module porte les deux outils qui comblent l'écart, manage_agents et
// manage_projects. Une seule implémentation, deux enveloppes :
// internal-agent-tools.ts et assistant-tools.ts ne font que les déclarer dans
// leur propre forme d'outil, pour que la même phrase produise les mêmes objets,
// avec les mêmes défauts que l'interface, quelle que soit la porte d'entrée.
//
// Les sorties sont du TEXTE court et lisible (comme tracker-actions.ts), sauf
// la fiche d'un agent, dont la structure imbriquée se lit mieux en JSON.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { describeIssueAssets } from "./tracker-actions.ts";

// ── Acteur ──────────────────────────────────────────────────────────────────

export type OpsRole = "owner" | "admin" | "member" | "viewer";
const ROLE_RANK: Record<OpsRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** Qui agit, pour le compte de qui, et d'où. */
export interface OpsActor {
  admin: SupabaseClient;
  workspaceId: string;
  /** Le projet founderos (pas un projet du suivi). */
  projectId: string;
  /** Le service depuis lequel on parle : défaut de toute création. */
  dashboardId: string | null;
  /** La room de la conversation, quand il y en a une. */
  roomId?: string | null;
  /** La personne pour le compte de qui l'assistant agit. */
  userId: string | null;
  /** Son rôle dans l'espace : il borne ce que l'assistant peut écrire. */
  role: OpsRole;
  /** L'agent assistant lui-même (signe les commentaires), null pour le panneau. */
  agentId: string | null;
  agentName?: string | null;
}

export interface UiBlock { component: string; props: Record<string, unknown> }
export interface OpsResult { text: string; ui?: UiBlock[] }

export async function resolveOpsRole(
  admin: SupabaseClient, workspaceId: string, userId: string | null,
): Promise<OpsRole> {
  if (!userId) return "viewer";
  const { data } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  const r = (data as { role?: string } | null)?.role ?? "";
  return (r in ROLE_RANK ? r : "viewer") as OpsRole;
}

const canWrite = (a: OpsActor) => ROLE_RANK[a.role] >= ROLE_RANK.member;

// ── Petits outils ───────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
}

/** Une liste, qu'on la reçoive en tableau ou en « a, b, c ». */
function strList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => typeof x === "object" && x
      ? str((x as Record<string, unknown>).name ?? (x as Record<string, unknown>).agent
        ?? (x as Record<string, unknown>).id ?? (x as Record<string, unknown>).slug)
      : str(x)).map((s) => s.trim()).filter(Boolean);
  }
  const s = str(v).trim();
  return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/** Un motif ilike sans les caractères qui cassent un filtre PostgREST `or`. */
function likeSafe(s: string): string {
  return s.replace(/[,()*%\\]/g, " ").trim();
}

const text = (t: string, ui?: UiBlock[]): OpsResult => (ui?.length ? { text: t, ui } : { text: t });

/** Une date AAAA-MM-JJ, ou null pour effacer, ou undefined quand rien n'est dit. */
function dateParam(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  const s = str(v).trim();
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}

/** Le chemin d'application d'un service, pour les cartes « Ouvrir ». */
const baseCache = new Map<string, string | null>();
export async function appBase(a: OpsActor, dashboardId: string | null): Promise<string | null> {
  if (!dashboardId) return null;
  const key = `${a.projectId}:${dashboardId}`;
  if (baseCache.has(key)) return baseCache.get(key)!;
  const [{ data: ws }, { data: proj }] = await Promise.all([
    a.admin.from("workspaces").select("slug").eq("id", a.workspaceId).maybeSingle(),
    a.admin.from("projects").select("slug").eq("id", a.projectId).maybeSingle(),
  ]);
  const w = (ws as { slug?: string } | null)?.slug;
  const p = (proj as { slug?: string } | null)?.slug;
  const base = w && p ? `/app/${w}/${p}/service/${dashboardId}` : null;
  baseCache.set(key, base);
  return base;
}

// ── Services ────────────────────────────────────────────────────────────────

interface ServiceRow { id: string; name: string; settings: Record<string, unknown> | null }

async function listServices(a: OpsActor): Promise<ServiceRow[]> {
  const { data } = await a.admin.from("service_dashboards")
    .select("id, name, settings").eq("project_id", a.projectId).order("created_at");
  return (data ?? []) as ServiceRow[];
}

/** Le service visé : nommé, sinon celui d'où l'on parle, sinon le seul qui existe. */
export async function resolveService(a: OpsActor, ref: string): Promise<ServiceRow | string> {
  const rows = await listServices(a);
  if (!rows.length) return "ERREUR : aucun service dans ce projet.";
  const want = ref.trim().toLowerCase();
  if (want) {
    const hit = rows.find((r) => r.id === ref.trim() || r.name.toLowerCase() === want)
      ?? rows.find((r) => r.name.toLowerCase().includes(want));
    return hit ?? `ERREUR : service « ${ref} » introuvable. Services : ${rows.map((r) => r.name).join(", ")}.`;
  }
  const here = rows.find((r) => r.id === a.dashboardId);
  if (here) return here;
  if (rows.length === 1) return rows[0];
  return `ERREUR : plusieurs services (${rows.map((r) => r.name).join(", ")}), précise lequel avec « service ».`;
}

interface AgentDefaults {
  model: string; sandbox_mode: string; max_steps: number;
  max_run_cost_usd: number; swarm_enabled: boolean; requires_approval: boolean;
}
// Miroir de DEFAULT_AGENT_DEFAULTS (src/features/service-dashboards/model.ts).
const DEFAULT_AGENT_DEFAULTS: AgentDefaults = {
  model: "deepseek", sandbox_mode: "cloud", max_steps: 8,
  max_run_cost_usd: 0.5, swarm_enabled: true, requires_approval: false,
};
function agentDefaultsOf(s: ServiceRow | null): AgentDefaults {
  const raw = ((s?.settings ?? {}) as { agent_defaults?: Partial<AgentDefaults> }).agent_defaults ?? {};
  return { ...DEFAULT_AGENT_DEFAULTS, ...raw };
}

// ── Règles de configuration des outils d'agent ──────────────────────────────
//
// « Ce qui manque » à un outil. Mêmes règles que
// src/features/internal-agents/toolSetup.ts (bandeau et badges de l'onglet
// Outils) : les garder en phase. assistant-tools.ts les importe d'ici.

export interface OpsToolRow {
  id: string;
  kind: string;
  name: string;
  description?: string | null;
  config: Record<string, unknown> | null;
  enabled: boolean | null;
  requires_approval: boolean | null;
}

/** Ce qu'il manque à cet outil, en clair, ou null quand il est prêt. */
export function agentToolIssue(kind: string, config: Record<string, unknown> | null | undefined): string | null {
  const cfg = config ?? {};
  switch (kind) {
    case "db_read":
      return Array.isArray(cfg.tables) && cfg.tables.length > 0
        ? null
        : "No allowed tables — the agent cannot read anything.";
    case "edge_function":
      return /^[a-z0-9-]+$/.test(str(cfg.slug)) ? null : "No function chosen — the tool is skipped at runtime.";
    case "custom":
      return /^https?:\/\//.test(str(cfg.webhook_url)) ? null : "No webhook URL — the tool is skipped at runtime.";
    case "connector_action":
      return str(cfg.provider) ? null : "No integration chosen — connect the service and select it.";
    case "composio_toolkit":
      return str(cfg.toolkit) ? null : "No Composio toolkit chosen — connect the app first.";
    case "rag_search":
      return Array.isArray(cfg.collection_ids) && cfg.collection_ids.length > 0
        ? null
        : "No knowledge collection attached — the agent searches an empty index.";
    case "vibe_code":
      return str(cfg.repository_id) ? null : "No repository pinned — the agent picks one itself if several exist.";
    case "testing":
      return str(cfg.suite_id) ? null : "No test suite pinned — the agent picks one itself.";
    case "security_scan":
      return str(cfg.target) ? null : "No target registered — declare the authorised scope before any scan.";
    case "custom_connector":
      return str(cfg.connector_id) ? null : "No internal tool chosen — attach one with manage_connectors attach.";
    default:
      return null;
  }
}

/** vibe_code/testing perdent seulement leur épingle ; les autres sont ignorés à l'exécution. */
export function isBlockingSetup(kind: string): boolean {
  return !["vibe_code", "testing"].includes(kind);
}

/** La forme de config attendue, par type. */
export const AGENT_TOOL_CONFIG_HINTS: Record<string, string> = {
  db_read: '{"tables": ["crm_records", "product_events"]} — whitelist of table names, project-scoped at runtime.',
  edge_function: '{"slug": "send-notification"} — a Supabase edge function slug (see options.edge_functions).',
  custom: '{"webhook_url": "https://…"} — the endpoint called with model-provided arguments.',
  connector_action: '{"provider": "slack"} — a connected integration (see options.connectors).',
  composio_toolkit: '{"toolkit": "gmail"} — a Composio toolkit slug the workspace has connected.',
  rag_search: '{"collection_ids": ["<uuid>", …]} — knowledge collections (see options.rag_collections).',
  vibe_code: '{"repository_id": "<uuid>", "actions": ["run","apply"]} — repo pin (see options.repositories); actions grant write powers ("apply" opens the PR, "merge_pr" merges).',
  testing: '{"suite_id": "<uuid>"} — the test suite to pin (see options.test_suites).',
  security_scan: '{"target": "https://app.example.com"} — the explicitly authorised scope.',
  simulation: '{"max_rounds": 8} — model calls per simulation; above 8 the cost climbs fast.',
  support: '{} — no config: the ResolveAI support queue of this project (requests received by public agents).',
  governance: '{} — no config: read-only PolicyGuard audit figures (risk levels, decisions, human validations).',
  leads: '{} — no config on the tool: the qualification grid, lead types and sales reps are shared by the project (LeadSense settings).',
  soc: '{} — no config on the tool: SentinelFlow sources, assets and rules are set in Admin → Gouvernance IA → SentinelFlow.',
  tracker: '{} — no config: the agent acts on the tracker projects it is crew of (manage_projects set_project_agents).',
  custom_connector: '{"connector_id": "<uuid>", "operations": ["…"], "credential_id": "<uuid>"} — an internal tool (0267). Do not write it by hand: use manage_connectors attach, which checks the service scope and the role.',
};

export const CONFIGURABLE_TOOL_KINDS = [
  "web_search", "web_fetch", "db_read", "rag_search", "edge_function",
  "vault_connector", "connector_action", "composio_toolkit", "crm", "support", "governance", "leads", "soc",
  "security_scan", "vibe_code", "testing", "simulation", "custom", "tracker",
];

/** Ce que fait chaque type, en une ligne, pour choisir sans deviner. */
const TOOL_KIND_PURPOSE: Record<string, string> = {
  web_search: "chercher sur le web",
  web_fetch: "lire une page web",
  db_read: "lire des tables de données du projet (liste blanche)",
  rag_search: "chercher dans des collections de connaissances",
  edge_function: "appeler une fonction interne (email, notification, workflow…)",
  vault_connector: "utiliser un identifiant du coffre",
  connector_action: "agir sur une intégration connectée nativement (Slack, HubSpot…)",
  composio_toolkit: "agir sur une app connectée via Composio (Gmail, Notion, GitHub…)",
  crm: "lire et écrire dans le CRM",
  support: "traiter la file du support",
  governance: "lire les chiffres d'audit de gouvernance",
  leads: "qualifier des leads (LeadSense)",
  soc: "surveillance sécurité (SentinelFlow)",
  security_scan: "scanner une cible autorisée",
  vibe_code: "coder dans un dépôt connecté",
  testing: "lancer des suites de tests E2E",
  simulation: "lancer des simulations de personas",
  custom: "appeler un webhook externe",
  tracker: "travailler dans le suivi de travail (projets où il est dans l'équipe)",
};

// Fonctions internes qu'on peut confier à un agent, miroir de
// EDGE_FUNCTION_CATALOGUE (src/features/internal-agents/InternalAgentDetail.tsx).
export const EDGE_FUNCTION_SLUGS = [
  "send-notification", "send-email", "send-bulk-email", "marketing-generate",
  "marketing-publish", "run-workflow", "analytics-query", "calculate-metrics", "daily-briefing",
];

export function describeAgentTool(t: OpsToolRow) {
  const issue = t.enabled === false ? null : agentToolIssue(t.kind, t.config);
  return {
    tool_id: t.id,
    kind: t.kind,
    name: t.name,
    enabled: t.enabled !== false,
    requires_approval: t.requires_approval === true,
    config: t.config ?? {},
    needs_setup: issue,
    blocking: issue ? isBlockingSetup(t.kind) : false,
    expects: AGENT_TOOL_CONFIG_HINTS[t.kind] ?? null,
  };
}

/** Un outil sans configuration propre : en avoir deux du même type ne sert à rien. */
const SINGLETON_KINDS = new Set([
  "web_search", "web_fetch", "crm", "support", "governance", "leads", "soc", "simulation", "tracker",
]);

// ── Agents : résolution ─────────────────────────────────────────────────────

interface AgentLite {
  id: string; name: string; role: string | null; description: string | null;
  service_dashboard_id: string | null; is_orchestrator: boolean | null; is_archived: boolean | null;
}
const AGENT_LITE = "id, name, role, description, service_dashboard_id, is_orchestrator, is_archived";

const SELF_WORDS = new Set(["toi", "toi-même", "assistant", "l'assistant", "self"]);

/** Un agent de l'espace par id, par nom exact, ou par nom partiel non ambigu. */
export async function findAgent(
  a: OpsActor, ref: string, opts: { includeArchived?: boolean } = {},
): Promise<AgentLite | string> {
  const r = ref.trim();
  if (!r) return "ERREUR : précise l'agent (son nom ou son agent_id).";
  if (a.agentId && SELF_WORDS.has(r.toLowerCase())) {
    const { data } = await a.admin.from("internal_agents").select(AGENT_LITE).eq("id", a.agentId).maybeSingle();
    if (data) return data as AgentLite;
  }
  let q = a.admin.from("internal_agents").select(AGENT_LITE).eq("workspace_id", a.workspaceId);
  if (!opts.includeArchived) q = q.eq("is_archived", false);
  if (UUID.test(r)) {
    const { data } = await q.eq("id", r).maybeSingle();
    return (data as AgentLite | null) ?? `ERREUR : aucun agent ${r} dans cet espace. Utilise action=list.`;
  }
  const { data } = await q.ilike("name", `%${likeSafe(r)}%`).limit(12);
  const rows = (data ?? []) as AgentLite[];
  const exact = rows.filter((x) => x.name.toLowerCase() === r.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  // Plusieurs homonymes : celui du service d'où l'on parle l'emporte.
  const local = (exact.length ? exact : rows).filter((x) => x.service_dashboard_id === a.dashboardId);
  if (local.length === 1) return local[0];
  if (!rows.length) return `ERREUR : aucun agent nommé « ${r} ». Utilise action=list pour voir les agents.`;
  return `ERREUR : plusieurs agents correspondent à « ${r} » : ${rows.map((x) => `${x.name} (${x.id})`).join(", ")}. Précise l'agent_id.`;
}

// ── Agents : capacités ──────────────────────────────────────────────────────

interface ConnectionRow {
  provider: string; status: string | null; scope: string | null;
  source: string | null; service_dashboard_id: string | null;
}

/** Les connexions qu'un agent de CE service peut utiliser : celles du service
 *  et celles du projet, jamais les connexions personnelles (0177). */
async function scopedConnections(a: OpsActor, dashboardId: string | null): Promise<ConnectionRow[]> {
  const { data } = await a.admin.from("connectors")
    .select("provider, status, scope, source, service_dashboard_id")
    .eq("project_id", a.projectId).limit(200);
  return ((data ?? []) as ConnectionRow[]).filter((c) => c.scope !== "personal"
    && (!c.service_dashboard_id || c.service_dashboard_id === dashboardId));
}

const isConnected = (c: ConnectionRow) => !c.status || ["connected", "active", "ok"].includes(c.status);

/** Donne à l'agent les connecteurs DÉJÀ connectés ; rend ceux qui restent à connecter. */
async function attachConnectors(
  a: OpsActor, agent: AgentLite, slugs: string[], requiresApproval: boolean,
): Promise<{ attached: string[]; already: string[]; missing: string[] }> {
  const out = { attached: [] as string[], already: [] as string[], missing: [] as string[] };
  if (!slugs.length) return out;
  const [conns, { data: tools }] = await Promise.all([
    scopedConnections(a, agent.service_dashboard_id ?? a.dashboardId),
    a.admin.from("internal_agent_tools").select("kind, config").eq("agent_id", agent.id),
  ]);
  const has = (slug: string) => ((tools ?? []) as Array<{ kind: string; config: Record<string, unknown> | null }>)
    .some((t) => ["connector_action", "composio_toolkit"].includes(t.kind)
      && String(t.config?.toolkit ?? t.config?.provider ?? "").toLowerCase() === slug);
  for (const raw of slugs) {
    const slug = raw.toLowerCase().trim();
    if (!/^[a-z0-9_.-]+$/.test(slug)) continue;
    if (has(slug)) { out.already.push(slug); continue; }
    const conn = conns.find((c) => c.provider.toLowerCase() === slug && isConnected(c));
    if (!conn) { out.missing.push(slug); continue; }
    const viaComposio = conn.source === "composio";
    const { error } = await a.admin.from("internal_agent_tools").insert({
      agent_id: agent.id,
      kind: viaComposio ? "composio_toolkit" : "connector_action",
      name: `Use ${slug}`,
      config: viaComposio ? { toolkit: slug } : { provider: slug },
      requires_approval: requiresApproval,
    });
    if (error) out.missing.push(slug); else out.attached.push(slug);
  }
  return out;
}

/** Les cartes « Connecter » : le flux de connexion tourne dans le navigateur, et
 *  la carte rattache le connecteur à l'agent dès qu'il revient connecté. */
function connectorCards(agentId: string | null, slugs: string[], reason?: string): UiBlock {
  return {
    component: "connectors",
    props: {
      agent_id: agentId,
      items: slugs.map((slug) => ({ slug, name: slug, reason: reason ?? "", status: "not_connected" })),
    },
  };
}

/** Des skills par id, slug ou nom exact ; rend aussi ce qui n'a rien donné. */
async function resolveSkills(a: OpsActor, refs: string[]): Promise<{ rows: Array<{ id: string; slug: string; name: string }>; unresolved: string[] }> {
  if (!refs.length) return { rows: [], unresolved: [] };
  const scope = `workspace_id.eq.${a.workspaceId},workspace_id.is.null`;
  const ids = refs.filter((r) => UUID.test(r));
  const others = refs.filter((r) => !UUID.test(r));
  const found: Array<{ id: string; slug: string; name: string }> = [];
  if (ids.length) {
    const { data } = await a.admin.from("agent_skills").select("id, slug, name").or(scope).in("id", ids);
    found.push(...((data ?? []) as typeof found));
  }
  if (others.length) {
    const { data } = await a.admin.from("agent_skills").select("id, slug, name").or(scope).in("slug", others);
    found.push(...((data ?? []) as typeof found));
    // Le nom plutôt que le slug : c'est ce que la personne a vu et dit.
    for (const r of others) {
      if (found.some((f) => f.slug === r)) continue;
      const { data: byName } = await a.admin.from("agent_skills").select("id, slug, name")
        .or(scope).ilike("name", likeSafe(r)).limit(2);
      if ((byName ?? []).length === 1) found.push((byName as typeof found)[0]);
    }
  }
  const unresolved = refs.filter((r) => !found.some((f) => f.id === r || f.slug === r || f.name.toLowerCase() === r.toLowerCase()));
  const uniq = [...new Map(found.map((f) => [f.id, f])).values()];
  return { rows: uniq, unresolved };
}

async function resolveMcpServers(a: OpsActor, refs: string[]): Promise<{ rows: Array<{ id: string; name: string }>; unresolved: string[] }> {
  if (!refs.length) return { rows: [], unresolved: [] };
  const { data } = await a.admin.from("mcp_servers").select("id, name").eq("workspace_id", a.workspaceId);
  const all = (data ?? []) as Array<{ id: string; name: string }>;
  const rows: typeof all = [];
  const unresolved: string[] = [];
  for (const r of refs) {
    const hit = all.find((s) => s.id === r || s.name.toLowerCase() === r.toLowerCase())
      ?? all.find((s) => s.name.toLowerCase().includes(r.toLowerCase()));
    if (hit) rows.push(hit); else unresolved.push(r);
  }
  return { rows: [...new Map(rows.map((x) => [x.id, x])).values()], unresolved };
}

/** Ajoute un agent à une room. Idempotent. */
async function addAgentToRoom(a: OpsActor, agentId: string, roomId: string): Promise<void> {
  await a.admin.from("service_room_agents").insert({ room_id: roomId, agent_id: agentId }).then(() => {}, () => {});
}

// ── manage_agents ───────────────────────────────────────────────────────────

const AGENT_READS = ["list", "get", "search_skills", "list_connections", "list_mcp_servers", "list_tool_kinds"];
const AGENT_WRITES = [
  "create", "update", "add_tool", "configure_tool", "remove_tool", "set_skills",
  "connect", "attach_mcp", "detach_mcp", "add_to_room", "archive", "restore",
];
export const AGENT_ACTIONS = [...AGENT_READS, ...AGENT_WRITES];

const AGENT_ALIASES: Record<string, string> = {
  list_agents: "list", get_agent: "get", get_agent_setup: "get", read: "get", show: "get",
  create_agent: "create", new: "create", update_agent: "update", update_profile: "update", edit: "update",
  add_agent_tool: "add_tool", configure_agent_tool: "configure_tool", delete_tool: "remove_tool",
  set_agent_skills: "set_skills", add_skills: "set_skills", search_agent_skills: "search_skills",
  attach_connectors: "connect", add_connectors: "connect", connect_apps: "connect",
  list_connectors: "list_connections", connections: "list_connections",
  list_mcp: "list_mcp_servers", add_mcp: "attach_mcp", remove_mcp: "detach_mcp",
  delete: "archive", archive_agent: "archive", unarchive: "restore",
};

/** Les paramètres par action, dits une fois, partagés par les deux enveloppes. */
const AGENT_PARAMS_DOC =
  "list: {search?, service?, include_archived?}. " +
  "get: {agent} → profil, prompt système, outils (needs_setup / expects), skills, MCP, et les valeurs disponibles (connexions, collections, dépôts…). " +
  "search_skills: {query, category?, limit?}. list_connections: {agent?, service?}. list_mcp_servers: {agent?}. list_tool_kinds: {}. " +
  "create: {name, role?, description?, instructions?, persona?, soul?, service?, connectors?: [slug], skills?: [slug|id|nom], " +
  "tools?: [{kind, name?, config?}], mcp_servers?: [nom|id], add_to_room?: bool (défaut vrai dans une room)}. " +
  "update: {agent, name?, description?, role?, persona?, instructions? (REMPLACE tout), append_instructions? (ajoute à la fin), " +
  "soul?, preferences?, service?, model?, temperature?, max_steps?, sandbox_mode?, swarm_enabled?, chat_enabled?, mission_enabled?}. " +
  "add_tool: {agent, kind, name?, config?, requires_approval?}. configure_tool: {tool_id, config?, replace?, enabled?, requires_approval?}. " +
  "remove_tool: {tool_id, confirm}. set_skills: {agent, activate?: [...], deactivate?: [...]}. " +
  "connect: {agent, connectors: [slug]} → rattache ceux déjà connectés, affiche une carte « Connecter » pour les autres. " +
  "attach_mcp / detach_mcp: {agent, servers: [nom|id]}. add_to_room: {agent, room?} (défaut : la room actuelle). " +
  "archive: {agent, confirm}. restore: {agent}. " +
  "« agent » = son nom ou son agent_id.";

export const AGENT_OPS_DESCRIPTION =
  "Administre les agents de l'espace : les lister, lire leur configuration, en CRÉER, et les configurer " +
  "(prompt système, connecteurs, skills, outils internes, serveurs MCP), les ajouter à une room, les archiver. " +
  "Lis avant d'écrire (list / get) et ne devine jamais un tool_id, une skill ou un serveur : utilise ce que " +
  "get et search_skills renvoient. remove_tool et archive exigent confirm=true, après accord explicite de la personne.";

/** Le schéma de l'outil, borné aux actions qu'une surface expose. */
export function agentOpsToolDef(name = "manage_agents", actions: string[] = AGENT_ACTIONS) {
  return {
    name,
    description: AGENT_OPS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions, description: "L'opération. Lectures : " + AGENT_READS.filter((x) => actions.includes(x)).join(", ") + "." },
        params: { type: "object", description: AGENT_PARAMS_DOC },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

export async function runAgentOps(
  a: OpsActor, rawAction: string, params: Record<string, unknown>,
): Promise<OpsResult> {
  const action = AGENT_ALIASES[rawAction] ?? rawAction;
  if (!AGENT_ACTIONS.includes(action)) {
    return text(`ERREUR : l'action « ${rawAction} » n'existe pas. Actions : ${AGENT_ACTIONS.join(", ")}.`);
  }
  if (AGENT_WRITES.includes(action) && !canWrite(a)) {
    return text(`ACCÈS REFUSÉ : la personne a le rôle « ${a.role} » dans cet espace, qui ne permet pas de modifier les agents. Dis-le-lui simplement.`);
  }
  const db = a.admin;
  const p = params ?? {};

  switch (action) {
    case "list": {
      let q = db.from("internal_agents").select(AGENT_LITE)
        .eq("workspace_id", a.workspaceId).eq("project_id", a.projectId);
      if (bool(p.include_archived) !== true) q = q.eq("is_archived", false);
      const search = likeSafe(str(p.search));
      if (search) q = q.or(`name.ilike.%${search}%,role.ilike.%${search}%,description.ilike.%${search}%`);
      if (str(p.service)) {
        const s = await resolveService(a, str(p.service));
        if (typeof s === "string") return text(s);
        q = q.eq("service_dashboard_id", s.id);
      }
      const { data } = await q.order("name").limit(80);
      const agents = (data ?? []) as AgentLite[];
      if (!agents.length) return text("Aucun agent ne correspond.");
      const ids = agents.map((x) => x.id);
      const [services, { data: tools }, { data: skills }] = await Promise.all([
        listServices(a),
        db.from("internal_agent_tools").select("agent_id, kind, config, enabled").in("agent_id", ids),
        db.from("agent_skill_activations").select("agent_id").in("agent_id", ids),
      ]);
      const svc = new Map(services.map((s) => [s.id, s.name]));
      return text(agents.map((x) => {
        const own = ((tools ?? []) as Array<{ agent_id: string; kind: string; config: Record<string, unknown> | null; enabled: boolean | null }>)
          .filter((t) => t.agent_id === x.id && t.enabled !== false);
        const pending = own.filter((t) => agentToolIssue(t.kind, t.config)).length;
        const nSkills = ((skills ?? []) as Array<{ agent_id: string }>).filter((s) => s.agent_id === x.id).length;
        return [
          `- ${x.name} (agent_id: ${x.id})`,
          x.service_dashboard_id ? `service: ${svc.get(x.service_dashboard_id) ?? "?"}` : null,
          x.role ? `rôle: ${x.role}` : null,
          `${own.length} outil(s)${pending ? `, ${pending} à configurer` : ""}`,
          `${nSkills} skill(s)`,
          x.is_orchestrator ? "assistant du service" : null,
          x.is_archived ? "archivé" : null,
        ].filter(Boolean).join(" · ");
      }).join("\n"));
    }

    case "get": {
      const ag = await findAgent(a, str(p.agent ?? p.agent_id ?? p.name), { includeArchived: true });
      if (typeof ag === "string") return text(ag);
      const dash = ag.service_dashboard_id ?? a.dashboardId;
      const [{ data: prof }, { data: toolRows }, { data: skillRows }, { data: mcpRows }, conns, { data: cols }, { data: repos }, { data: suites }, { data: servers }] = await Promise.all([
        db.from("internal_agents")
          .select("name, description, role, persona, instructions, soul, preferences, model, temperature, max_steps, sandbox_mode, swarm_enabled, chat_enabled, mission_enabled, is_orchestrator, is_archived, service_dashboard_id")
          .eq("id", ag.id).maybeSingle(),
        db.from("internal_agent_tools").select("id, kind, name, description, config, enabled, requires_approval")
          .eq("agent_id", ag.id).order("created_at", { ascending: true }),
        db.from("agent_skill_activations").select("skill_id, agent_skills(id, slug, name, category)").eq("agent_id", ag.id),
        db.from("agent_mcp_servers").select("server_id, mcp_servers(id, name, status)").eq("agent_id", ag.id),
        scopedConnections(a, dash),
        db.from("rag_collections").select("id, name").eq("project_id", a.projectId).limit(40),
        db.from("repositories").select("id, full_name").eq("project_id", a.projectId).limit(40),
        db.from("test_suites").select("id, name").eq("project_id", a.projectId).limit(40),
        db.from("mcp_servers").select("id, name, status").eq("workspace_id", a.workspaceId).limit(40),
      ]);
      const pr = (prof ?? {}) as Record<string, unknown>;
      const instructions = str(pr.instructions);
      const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
      return text(JSON.stringify({
        agent: { agent_id: ag.id, name: pr.name, service_dashboard_id: pr.service_dashboard_id ?? null, archived: pr.is_archived === true, is_assistant: pr.is_orchestrator === true },
        profile: {
          description: pr.description ?? null, role: pr.role ?? null, persona: pr.persona ?? null,
          instructions_length: instructions.length,
          instructions: instructions.slice(0, 4000),
          soul: str(pr.soul).slice(0, 800) || null,
          preferences: str(pr.preferences).slice(0, 800) || null,
        },
        runtime: {
          model: pr.model, temperature: pr.temperature, max_steps: pr.max_steps, sandbox_mode: pr.sandbox_mode,
          swarm_enabled: pr.swarm_enabled, chat_enabled: pr.chat_enabled, mission_enabled: pr.mission_enabled,
        },
        tools: ((toolRows ?? []) as OpsToolRow[]).map(describeAgentTool),
        skills: ((skillRows ?? []) as Array<Record<string, unknown>>).map((r) => {
          const s = one(r.agent_skills as { id?: string; slug?: string; name?: string; category?: string } | null);
          return { skill_id: s?.id ?? r.skill_id, slug: s?.slug, name: s?.name, category: s?.category };
        }),
        mcp_servers: ((mcpRows ?? []) as Array<Record<string, unknown>>).map((r) => {
          const s = one(r.mcp_servers as { id?: string; name?: string; status?: string } | null);
          return { server_id: s?.id ?? r.server_id, name: s?.name, status: s?.status ?? null };
        }),
        options: {
          connectors: conns.map((c) => ({ provider: c.provider, status: c.status, source: c.source })),
          rag_collections: cols ?? [],
          repositories: repos ?? [],
          test_suites: suites ?? [],
          edge_functions: EDGE_FUNCTION_SLUGS,
          mcp_servers: servers ?? [],
        },
        note: "Une liste d'options vide veut dire que la ressource n'existe pas encore : dis-le au lieu d'inventer un id.",
      }));
    }

    case "search_skills": {
      const q = likeSafe(str(p.query));
      const limit = Math.min(Math.max(Number(p.limit ?? 15) || 15, 1), 40);
      let sel = db.from("agent_skills")
        .select("id, slug, name, description, category")
        .or(`workspace_id.eq.${a.workspaceId},workspace_id.is.null`);
      if (q) sel = sel.or(`name.ilike.%${q}%,slug.ilike.%${q}%,description.ilike.%${q}%`);
      if (str(p.category)) sel = sel.eq("category", str(p.category));
      const { data, error } = await sel.limit(limit);
      if (error) return text(`ERREUR : recherche de skills impossible (${error.message}).`);
      if (!data?.length) return text("Aucune skill ne correspond. Essaie un mot plus large, ou propose d'en écrire une.");
      return text(((data ?? []) as Array<Record<string, unknown>>).map((s) =>
        `- ${s.name} (slug: ${s.slug}${s.category ? `, ${s.category}` : ""}) · ${str(s.description).slice(0, 140)}`).join("\n"));
    }

    case "list_connections": {
      let dash = a.dashboardId;
      let ag: AgentLite | null = null;
      if (str(p.agent)) {
        const f = await findAgent(a, str(p.agent));
        if (typeof f === "string") return text(f);
        ag = f; dash = f.service_dashboard_id ?? dash;
      } else if (str(p.service)) {
        const s = await resolveService(a, str(p.service));
        if (typeof s === "string") return text(s);
        dash = s.id;
      }
      const conns = await scopedConnections(a, dash);
      if (!conns.length) return text("Aucune connexion dans ce périmètre. Propose de connecter un service avec manage_agents connect (il affiche une carte « Connecter »).");
      let attached = new Set<string>();
      if (ag) {
        const { data } = await db.from("internal_agent_tools").select("kind, config").eq("agent_id", ag.id);
        attached = new Set(((data ?? []) as Array<{ kind: string; config: Record<string, unknown> | null }>)
          .filter((t) => ["connector_action", "composio_toolkit"].includes(t.kind))
          .map((t) => String(t.config?.toolkit ?? t.config?.provider ?? "").toLowerCase()));
      }
      return text(conns.map((c) => `- ${c.provider} · ${c.status ?? "?"} · ${c.source === "composio" ? "via Composio" : "natif"}`
        + (c.service_dashboard_id ? " · du service" : " · du projet")
        + (ag ? (attached.has(c.provider.toLowerCase()) ? " · déjà donné à l'agent" : " · pas encore donné") : "")).join("\n"));
    }

    case "list_mcp_servers": {
      const { data } = await db.from("mcp_servers").select("id, name, status, enabled, cached_tools").eq("workspace_id", a.workspaceId).limit(60);
      const rows = (data ?? []) as Array<{ id: string; name: string; status: string | null; enabled: boolean; cached_tools: unknown[] | null }>;
      if (!rows.length) return text("Aucun serveur MCP enregistré dans cet espace.");
      let attached = new Set<string>();
      if (str(p.agent)) {
        const f = await findAgent(a, str(p.agent));
        if (typeof f === "string") return text(f);
        const { data: at } = await db.from("agent_mcp_servers").select("server_id").eq("agent_id", f.id);
        attached = new Set(((at ?? []) as Array<{ server_id: string }>).map((x) => x.server_id));
      }
      return text(rows.map((s) => `- ${s.name} (id: ${s.id}) · ${s.status ?? "jamais testé"}${s.enabled ? "" : " · désactivé"}`
        + ` · ${Array.isArray(s.cached_tools) ? s.cached_tools.length : 0} outil(s)`
        + (attached.has(s.id) ? " · rattaché" : "")).join("\n"));
    }

    case "list_tool_kinds":
      return text(CONFIGURABLE_TOOL_KINDS.map((k) =>
        `- ${k} : ${TOOL_KIND_PURPOSE[k] ?? ""}${AGENT_TOOL_CONFIG_HINTS[k] ? ` · config ${AGENT_TOOL_CONFIG_HINTS[k]}` : " · sans config"}`).join("\n"));

    case "create": {
      const name = str(p.name).trim().slice(0, 120);
      if (!name) return text("ERREUR : name est requis.");
      const service = await resolveService(a, str(p.service));
      if (typeof service === "string") return text(service);

      // Une création rejouée (relance, réponse coupée) ne doit pas laisser deux
      // agents du même nom dans le même service.
      const { data: twin } = await db.from("internal_agents").select("id")
        .eq("service_dashboard_id", service.id).eq("is_archived", false).ilike("name", likeSafe(name)).limit(1).maybeSingle();
      if (twin) {
        return text(`ERREUR : un agent « ${name} » existe déjà dans ce service (agent_id: ${(twin as { id: string }).id}). Configure-le avec update / connect / set_skills au lieu d'en créer un second.`);
      }

      const defaults = agentDefaultsOf(service);
      const role = str(p.role).trim().slice(0, 200) || null;
      const { data: created, error } = await db.from("internal_agents").insert({
        workspace_id: a.workspaceId, project_id: a.projectId, service_dashboard_id: service.id,
        name, role,
        description: (str(p.description).trim() || role || "").slice(0, 280) || null,
        persona: str(p.persona).trim() || null,
        instructions: str(p.instructions).trim() || null,
        soul: str(p.soul).trim() || null,
        chat_enabled: true, mission_enabled: true,
        created_by: a.userId,
        // Les défauts du service (Réglages → Agents), comme la création à la main.
        model: defaults.model, sandbox_mode: defaults.sandbox_mode, max_steps: defaults.max_steps,
        max_run_cost_usd: defaults.max_run_cost_usd, swarm_enabled: defaults.swarm_enabled,
      }).select(AGENT_LITE).single();
      if (error || !created) return text(`ERREUR : création impossible (${error?.message ?? "inconnue"}).`);
      const ag = created as AgentLite;
      const notes: string[] = [`Agent « ${name} » créé dans le service ${service.name} (agent_id: ${ag.id}).`];
      const ui: UiBlock[] = [];

      // Outils internes demandés.
      const toolSpecs = Array.isArray(p.tools) ? (p.tools as Array<Record<string, unknown>>) : [];
      for (const spec of toolSpecs.slice(0, 12)) {
        const kind = str(spec?.kind);
        if (!CONFIGURABLE_TOOL_KINDS.includes(kind)) { notes.push(`Outil ignoré : type « ${kind} » inconnu.`); continue; }
        const config = (spec.config && typeof spec.config === "object" ? spec.config : {}) as Record<string, unknown>;
        const { error: tErr } = await db.from("internal_agent_tools").insert({
          agent_id: ag.id, kind, name: str(spec.name) || kind, config,
          requires_approval: kind === "edge_function" || kind === "custom" || defaults.requires_approval,
        });
        if (tErr) { notes.push(`Outil ${kind} non ajouté (${tErr.message}).`); continue; }
        const issue = agentToolIssue(kind, config);
        notes.push(`Outil ${kind} ajouté${issue ? `, mais incomplet : ${issue}` : "."}`);
      }

      const conn = await attachConnectors(a, ag, strList(p.connectors), defaults.requires_approval);
      if (conn.attached.length) notes.push(`Connecteurs rattachés : ${conn.attached.join(", ")}.`);
      if (conn.missing.length) {
        notes.push(`Pas encore connectés : ${conn.missing.join(", ")}. Une carte « Connecter » est affichée ; l'agent les reçoit dès la connexion faite.`);
        ui.push(connectorCards(ag.id, conn.missing, `Pour que ${name} puisse s'en servir.`));
      }

      const sk = await resolveSkills(a, strList(p.skills));
      if (sk.rows.length) {
        await db.from("agent_skill_activations")
          .upsert(sk.rows.map((s) => ({ agent_id: ag.id, skill_id: s.id })), { onConflict: "agent_id,skill_id" });
        notes.push(`Skills activées : ${sk.rows.map((s) => s.name).join(", ")}.`);
      }
      if (sk.unresolved.length) notes.push(`Skills introuvables : ${sk.unresolved.join(", ")} (cherche-les avec search_skills).`);

      const mcp = await resolveMcpServers(a, strList(p.mcp_servers));
      if (mcp.rows.length) {
        await db.from("agent_mcp_servers").upsert(mcp.rows.map((s) => ({ agent_id: ag.id, server_id: s.id })), { onConflict: "agent_id,server_id" });
        notes.push(`Serveurs MCP rattachés : ${mcp.rows.map((s) => s.name).join(", ")}.`);
      }
      if (mcp.unresolved.length) notes.push(`Serveurs MCP introuvables : ${mcp.unresolved.join(", ")}.`);

      if (a.roomId && bool(p.add_to_room) !== false) {
        await addAgentToRoom(a, ag.id, a.roomId);
        notes.push("Ajouté à cette room : on peut le mentionner avec @ dès maintenant.");
      }

      const base = await appBase(a, service.id);
      if (base) {
        ui.unshift({ component: "link_card", props: { title: `Ouvrir ${name}`, description: role ?? "Nouvel agent", url: `${base}/agent/${ag.id}` } });
      }
      notes.push("L'agent est au repos : il ne travaille que si on lui parle, qu'on lui confie une mission ou un work item.");
      return text(notes.join("\n"), ui);
    }

    case "update": {
      const ag = await findAgent(a, str(p.agent ?? p.agent_id), { includeArchived: true });
      if (typeof ag === "string") return text(ag);
      const patch: Record<string, unknown> = {};
      for (const k of ["name", "description", "role", "persona", "instructions", "soul", "preferences"]) {
        if (p[k] !== undefined && str(p[k]).trim()) patch[k] = str(p[k]).trim();
      }
      if (str(p.append_instructions).trim()) {
        const { data: cur } = await db.from("internal_agents").select("instructions").eq("id", ag.id).maybeSingle();
        const before = str((cur as { instructions?: string } | null)?.instructions);
        patch.instructions = [before.trim(), str(p.append_instructions).trim()].filter(Boolean).join("\n\n");
      }
      if (str(p.service)) {
        const s = await resolveService(a, str(p.service));
        if (typeof s === "string") return text(s);
        patch.service_dashboard_id = s.id;
      }
      if (str(p.model)) patch.model = str(p.model).slice(0, 80);
      if (typeof p.temperature === "number") patch.temperature = Math.min(Math.max(p.temperature, 0), 1);
      // Contrainte en base : 1 à 30.
      if (typeof p.max_steps === "number") patch.max_steps = Math.min(Math.max(Math.round(p.max_steps), 1), 30);
      if (["cloud", "runner", "sandbox", "hybrid"].includes(str(p.sandbox_mode))) patch.sandbox_mode = str(p.sandbox_mode);
      for (const k of ["swarm_enabled", "chat_enabled", "mission_enabled"]) {
        const b = bool(p[k]);
        if (b !== undefined) patch[k] = b;
      }
      if (!Object.keys(patch).length) return text("ERREUR : rien à modifier, passe au moins un champ.");
      patch.updated_at = new Date().toISOString();
      const { error } = await db.from("internal_agents").update(patch).eq("id", ag.id);
      if (error) return text(`ERREUR : ${error.message}`);
      return text(`${ag.name} mis à jour : ${Object.keys(patch).filter((k) => k !== "updated_at").join(", ")}.`);
    }

    case "add_tool": {
      const ag = await findAgent(a, str(p.agent ?? p.agent_id));
      if (typeof ag === "string") return text(ag);
      const kind = str(p.kind);
      if (!CONFIGURABLE_TOOL_KINDS.includes(kind)) {
        return text(`ERREUR : type « ${kind} » inconnu. Types : ${CONFIGURABLE_TOOL_KINDS.join(", ")}.`);
      }
      const config = (p.config && typeof p.config === "object" ? p.config : {}) as Record<string, unknown>;
      const { data: existing } = await db.from("internal_agent_tools").select("id, kind, config").eq("agent_id", ag.id).eq("kind", kind);
      const rows = (existing ?? []) as Array<{ id: string; config: Record<string, unknown> | null }>;
      const sameTarget = rows.find((t) => SINGLETON_KINDS.has(kind)
        || (kind === "connector_action" && str(t.config?.provider) && str(t.config?.provider) === str(config.provider))
        || (kind === "composio_toolkit" && str(t.config?.toolkit) && str(t.config?.toolkit) === str(config.toolkit)));
      if (sameTarget) {
        return text(`${ag.name} a déjà cet outil (tool_id: ${sameTarget.id}). Utilise configure_tool pour le modifier.`);
      }
      const { data, error } = await db.from("internal_agent_tools").insert({
        agent_id: ag.id, kind, name: str(p.name) || kind, config,
        requires_approval: bool(p.requires_approval) ?? (kind === "edge_function" || kind === "custom"),
      }).select("id").single();
      if (error) return text(`ERREUR : ${error.message}`);
      const issue = agentToolIssue(kind, config);
      return text(`Outil ${kind} ajouté à ${ag.name} (tool_id: ${(data as { id: string }).id}).`
        + (issue ? ` Encore incomplet : ${issue} Forme attendue : ${AGENT_TOOL_CONFIG_HINTS[kind] ?? "?"}` : ""));
    }

    case "configure_tool": {
      const toolId = str(p.tool_id);
      if (!toolId) return text("ERREUR : tool_id est requis (voir get).");
      const { data: tool } = await db.from("internal_agent_tools")
        .select("id, kind, name, config, agent_id").eq("id", toolId).maybeSingle();
      if (!tool) return text("ERREUR : outil introuvable. Appelle get pour avoir les tool_id.");
      const t = tool as { id: string; kind: string; name: string; config: Record<string, unknown> | null; agent_id: string };
      const { data: owner } = await db.from("internal_agents").select("name, workspace_id").eq("id", t.agent_id).maybeSingle();
      if ((owner as { workspace_id?: string } | null)?.workspace_id !== a.workspaceId) return text("ACCÈS REFUSÉ : cet outil appartient à un autre espace.");
      const patchCfg = (p.config && typeof p.config === "object" ? p.config : {}) as Record<string, unknown>;
      const nextConfig = bool(p.replace) === true ? patchCfg : { ...(t.config ?? {}), ...patchCfg };
      const update: Record<string, unknown> = { config: nextConfig };
      const en = bool(p.enabled); if (en !== undefined) update.enabled = en;
      const ra = bool(p.requires_approval); if (ra !== undefined) update.requires_approval = ra;
      const { error } = await db.from("internal_agent_tools").update(update).eq("id", toolId);
      if (error) return text(`ERREUR : ${error.message}`);
      const remaining = agentToolIssue(t.kind, nextConfig);
      return text(`${t.name} (${t.kind}) de ${(owner as { name?: string }).name ?? "l'agent"} enregistré.`
        + (remaining ? ` Encore incomplet : ${remaining}` : " Il est prêt."));
    }

    case "remove_tool": {
      const toolId = str(p.tool_id);
      if (!toolId) return text("ERREUR : tool_id est requis.");
      const { data: tool } = await db.from("internal_agent_tools").select("id, kind, name, agent_id").eq("id", toolId).maybeSingle();
      if (!tool) return text("ERREUR : outil introuvable.");
      const t = tool as { id: string; kind: string; name: string; agent_id: string };
      const { data: owner } = await db.from("internal_agents").select("name, workspace_id").eq("id", t.agent_id).maybeSingle();
      if ((owner as { workspace_id?: string } | null)?.workspace_id !== a.workspaceId) return text("ACCÈS REFUSÉ : cet outil appartient à un autre espace.");
      if (bool(p.confirm) !== true) {
        return text(`CONFIRMATION REQUISE : retirer « ${t.name} » (${t.kind}) de ${(owner as { name?: string }).name}. Demande l'accord de la personne, puis rappelle avec confirm=true.`);
      }
      const { error } = await db.from("internal_agent_tools").delete().eq("id", toolId);
      if (error) return text(`ERREUR : ${error.message}`);
      return text(`« ${t.name} » retiré de ${(owner as { name?: string }).name}.`);
    }

    case "set_skills": {
      const ag = await findAgent(a, str(p.agent ?? p.agent_id));
      if (typeof ag === "string") return text(ag);
      const add = await resolveSkills(a, strList(p.activate));
      const del = await resolveSkills(a, strList(p.deactivate));
      if (!add.rows.length && !del.rows.length) {
        return text(`ERREUR : aucune skill reconnue${[...add.unresolved, ...del.unresolved].length ? ` (${[...add.unresolved, ...del.unresolved].join(", ")})` : ""}. Cherche-les d'abord avec search_skills.`);
      }
      if (add.rows.length) {
        const { error } = await db.from("agent_skill_activations")
          .upsert(add.rows.map((s) => ({ agent_id: ag.id, skill_id: s.id })), { onConflict: "agent_id,skill_id" });
        if (error) return text(`ERREUR : ${error.message}`);
      }
      if (del.rows.length) {
        await db.from("agent_skill_activations").delete().eq("agent_id", ag.id).in("skill_id", del.rows.map((s) => s.id));
      }
      const unknown = [...add.unresolved, ...del.unresolved];
      return text([
        add.rows.length ? `Activées sur ${ag.name} : ${add.rows.map((s) => s.name).join(", ")}.` : null,
        del.rows.length ? `Retirées : ${del.rows.map((s) => s.name).join(", ")}.` : null,
        unknown.length ? `Introuvables : ${unknown.join(", ")}.` : null,
      ].filter(Boolean).join("\n"));
    }

    case "connect": {
      const ag = await findAgent(a, str(p.agent ?? p.agent_id));
      if (typeof ag === "string") return text(ag);
      const slugs = strList(p.connectors ?? p.providers ?? p.apps);
      if (!slugs.length) return text("ERREUR : connectors est requis (slugs, ex. [\"slack\", \"gmail\"]).");
      const service = (await listServices(a)).find((s) => s.id === (ag.service_dashboard_id ?? a.dashboardId)) ?? null;
      const res = await attachConnectors(a, ag, slugs, agentDefaultsOf(service).requires_approval);
      const lines = [
        res.attached.length ? `Rattachés à ${ag.name} : ${res.attached.join(", ")}.` : null,
        res.already.length ? `Il les avait déjà : ${res.already.join(", ")}.` : null,
        res.missing.length ? `À connecter d'abord : ${res.missing.join(", ")}. Les cartes « Connecter » sont affichées : un clic, et l'agent les reçoit automatiquement. Ne renvoie pas vers l'écran Intégrations.` : null,
      ].filter(Boolean);
      return text(lines.join("\n"), res.missing.length ? [connectorCards(ag.id, res.missing, `Pour ${ag.name}.`)] : undefined);
    }

    case "attach_mcp":
    case "detach_mcp": {
      const ag = await findAgent(a, str(p.agent ?? p.agent_id));
      if (typeof ag === "string") return text(ag);
      const res = await resolveMcpServers(a, strList(p.servers ?? p.server_ids ?? p.mcp_servers));
      if (!res.rows.length) return text(`ERREUR : aucun serveur MCP reconnu${res.unresolved.length ? ` (${res.unresolved.join(", ")})` : ""}. Voir list_mcp_servers.`);
      if (action === "attach_mcp") {
        const { error } = await db.from("agent_mcp_servers")
          .upsert(res.rows.map((s) => ({ agent_id: ag.id, server_id: s.id })), { onConflict: "agent_id,server_id" });
        if (error) return text(`ERREUR : ${error.message}`);
      } else {
        await db.from("agent_mcp_servers").delete().eq("agent_id", ag.id).in("server_id", res.rows.map((s) => s.id));
      }
      return text(`${action === "attach_mcp" ? "Rattachés à" : "Détachés de"} ${ag.name} : ${res.rows.map((s) => s.name).join(", ")}.`
        + (res.unresolved.length ? ` Introuvables : ${res.unresolved.join(", ")}.` : ""));
    }

    case "add_to_room": {
      const ag = await findAgent(a, str(p.agent ?? p.agent_id));
      if (typeof ag === "string") return text(ag);
      let roomId = a.roomId ?? null;
      const roomRef = str(p.room).trim();
      if (roomRef) {
        let q = db.from("service_rooms").select("id, title").eq("project_id", a.projectId);
        q = UUID.test(roomRef) ? q.eq("id", roomRef) : q.ilike("title", `%${likeSafe(roomRef)}%`);
        const { data } = await q.limit(2);
        const rows = (data ?? []) as Array<{ id: string; title: string }>;
        if (rows.length !== 1) return text(rows.length ? `ERREUR : plusieurs rooms correspondent : ${rows.map((r) => r.title).join(", ")}.` : `ERREUR : room « ${roomRef} » introuvable.`);
        roomId = rows[0].id;
      }
      if (!roomId) return text("ERREUR : précise la room (ici, il n'y en a pas d'ouverte).");
      await addAgentToRoom(a, ag.id, roomId);
      return text(`${ag.name} est dans la room : on peut le mentionner avec @.`);
    }

    case "archive":
    case "restore": {
      const ag = await findAgent(a, str(p.agent ?? p.agent_id), { includeArchived: true });
      if (typeof ag === "string") return text(ag);
      if (action === "archive") {
        if (ag.is_orchestrator) return text("ERREUR : l'assistant du service ne s'archive pas.");
        if (bool(p.confirm) !== true) {
          return text(`CONFIRMATION REQUISE : archiver ${ag.name} (il ne recevra plus de travail, ses missions planifiées s'arrêtent). Demande l'accord de la personne, puis rappelle avec confirm=true.`);
        }
      }
      const { error } = await db.from("internal_agents")
        .update({ is_archived: action === "archive", updated_at: new Date().toISOString() }).eq("id", ag.id);
      if (error) return text(`ERREUR : ${error.message}`);
      return text(action === "archive" ? `${ag.name} archivé (restaurable avec restore).` : `${ag.name} restauré.`);
    }
  }
  return text(`ERREUR : action « ${action} » non gérée.`);
}

// ── Suivi de travail : résolution ───────────────────────────────────────────
//
// L'assistant agit POUR une personne, pas pour lui-même : son périmètre est
// celui de la personne (tous les projets du suivi de ce projet founderos), et
// non l'équipe d'un projet comme pour un agent (pj_project_agents). Ce qu'il
// crée n'est pas assigné à lui-même, mais à qui on lui dit.

interface PjProjectRow {
  id: string; name: string; identifier: string; description: string | null;
  dashboard_id: string | null; workspace_id: string; project_id: string;
  start_date: string | null; target_date: string | null; lead_id: string | null;
}
const PJ_PROJECT_COLS = "id, name, identifier, description, dashboard_id, workspace_id, project_id, start_date, target_date, lead_id";

interface PjIssueRow {
  id: string; pj_project_id: string; workspace_id: string; sequence_id: number; name: string;
  priority: string; state_id: string | null; parent_id: string | null; start_date: string | null;
  target_date: string | null; completed_at: string | null; archived_at: string | null;
  agent_brief: string | null; agent_autorun: boolean | null; description_text: string | null;
}
const PJ_ISSUE_COLS = "id, pj_project_id, workspace_id, sequence_id, name, priority, state_id, parent_id, start_date, target_date, completed_at, archived_at, agent_brief, agent_autorun, description_text";

const PRIORITIES = ["urgent", "high", "medium", "low", "none"];
const PRIORITY_FR: Record<string, string> = {
  urgente: "urgent", urgent: "urgent", haute: "high", élevée: "high", high: "high",
  moyenne: "medium", normale: "medium", medium: "medium", basse: "low", faible: "low", low: "low",
  aucune: "none", none: "none",
};
const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"];
const STATE_GROUP_FR: Record<string, string> = {
  backlog: "backlog", "à faire": "unstarted", todo: "unstarted", unstarted: "unstarted",
  "en cours": "started", started: "started", "in progress": "started",
  "terminé": "completed", fini: "completed", done: "completed", completed: "completed",
  "annulé": "cancelled", cancelled: "cancelled", canceled: "cancelled",
};
const RELATION_TYPES = ["relates_to", "duplicate", "blocked_by", "blocks", "start_before", "start_after", "finish_before", "finish_after"];
const INVERSE_RELATION: Record<string, string> = {
  relates_to: "relates_to", duplicate: "duplicate", blocked_by: "blocks", blocks: "blocked_by",
  start_before: "start_after", start_after: "start_before", finish_before: "finish_after", finish_after: "finish_before",
};
const LABEL_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#64748b"];

function priorityParam(v: unknown): string | undefined {
  const s = str(v).trim().toLowerCase();
  if (!s) return undefined;
  return PRIORITY_FR[s] ?? (PRIORITIES.includes(s) ? s : undefined);
}

/** Les projets du suivi visibles d'ici : ceux de ce projet founderos. */
async function scopeProjects(a: OpsActor, dashboardId?: string | null): Promise<PjProjectRow[]> {
  let q = a.admin.from("pj_projects").select(PJ_PROJECT_COLS)
    .eq("project_id", a.projectId).is("archived_at", null);
  if (dashboardId) q = q.eq("dashboard_id", dashboardId);
  const { data } = await q.order("created_at").limit(100);
  return (data ?? []) as PjProjectRow[];
}

/** Un projet du suivi par id, identifiant (ABC) ou nom. */
async function findProject(a: OpsActor, ref: string): Promise<PjProjectRow | string> {
  const r = ref.trim();
  if (!r) return "ERREUR : précise le projet (nom, identifiant ou project_id). Voir list_projects.";
  const all = await scopeProjects(a);
  const hit = all.find((x) => x.id === r)
    ?? all.find((x) => x.identifier.toLowerCase() === r.toLowerCase())
    ?? all.find((x) => x.name.toLowerCase() === r.toLowerCase());
  if (hit) return hit;
  const partial = all.filter((x) => x.name.toLowerCase().includes(r.toLowerCase()));
  // Plusieurs projets proches : celui du service d'où l'on parle l'emporte.
  const local = partial.filter((x) => x.dashboard_id === a.dashboardId);
  if (partial.length === 1) return partial[0];
  if (local.length === 1) return local[0];
  if (!partial.length) {
    return `ERREUR : projet « ${r} » introuvable.${all.length ? ` Projets : ${all.map((x) => `${x.identifier} ${x.name}`).join(", ")}.` : " Aucun projet : crée-le avec create_project."}`;
  }
  return `ERREUR : plusieurs projets correspondent : ${partial.map((x) => `${x.identifier} ${x.name}`).join(", ")}.`;
}

async function projectById(a: OpsActor, id: string): Promise<PjProjectRow | null> {
  const { data } = await a.admin.from("pj_projects").select(PJ_PROJECT_COLS).eq("id", id).maybeSingle();
  const p = data as PjProjectRow | null;
  return p && p.project_id === a.projectId ? p : null;
}

const refOf = (p: PjProjectRow | { identifier: string }, i: { sequence_id: number }) => `${p.identifier}-${i.sequence_id}`;

/** Un work item par id, par référence (ABC-12) ou par titre. */
async function findIssue(a: OpsActor, ref: string): Promise<{ issue: PjIssueRow; project: PjProjectRow } | string> {
  const r = ref.trim();
  if (!r) return "ERREUR : précise le work item (référence ABC-12, issue_id ou titre).";
  const db = a.admin;
  if (UUID.test(r)) {
    const { data } = await db.from("pj_issues").select(PJ_ISSUE_COLS).eq("id", r).maybeSingle();
    if (!data) return `ERREUR : work item ${r} introuvable.`;
    const project = await projectById(a, (data as PjIssueRow).pj_project_id);
    return project ? { issue: data as PjIssueRow, project } : "ERREUR : ce work item est hors de ce projet.";
  }
  const m = /^([A-Za-z0-9]{1,12})-(\d+)$/.exec(r);
  if (m) {
    const projects = (await scopeProjects(a)).filter((x) => x.identifier.toUpperCase() === m[1].toUpperCase());
    for (const project of projects) {
      const { data } = await db.from("pj_issues").select(PJ_ISSUE_COLS)
        .eq("pj_project_id", project.id).eq("sequence_id", Number(m[2])).maybeSingle();
      if (data) return { issue: data as PjIssueRow, project };
    }
    return `ERREUR : aucun work item ${r.toUpperCase()}.`;
  }
  const projects = await scopeProjects(a);
  if (!projects.length) return "ERREUR : aucun projet dans le suivi.";
  const { data } = await db.from("pj_issues").select(PJ_ISSUE_COLS)
    .in("pj_project_id", projects.map((x) => x.id)).is("archived_at", null)
    .ilike("name", `%${likeSafe(r)}%`).limit(8);
  const rows = (data ?? []) as PjIssueRow[];
  const exact = rows.filter((x) => x.name.toLowerCase() === r.toLowerCase());
  const pick = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
  const byId = new Map(projects.map((x) => [x.id, x]));
  if (pick) return { issue: pick, project: byId.get(pick.pj_project_id)! };
  if (!rows.length) return `ERREUR : aucun work item ne correspond à « ${r} ».`;
  return `ERREUR : plusieurs work items correspondent : ${rows.map((x) => `${refOf(byId.get(x.pj_project_id)!, x)} « ${x.name} »`).join(", ")}. Donne la référence.`;
}

interface MemberRow { user_id: string; name: string | null; email: string | null }

/** Les membres de l'espace, avec leur nom et leur email, pour les assignations.
 *  Mémoïsé par acteur : un run qui liste puis assigne ne relit pas tout. */
const memberCache = new WeakMap<OpsActor, Promise<MemberRow[]>>();
function workspaceMembers(a: OpsActor): Promise<MemberRow[]> {
  let hit = memberCache.get(a);
  if (!hit) { hit = loadMembers(a); memberCache.set(a, hit); }
  return hit;
}
async function loadMembers(a: OpsActor): Promise<MemberRow[]> {
  const { data } = await a.admin.from("workspace_members").select("user_id").eq("workspace_id", a.workspaceId).limit(80);
  const ids = ((data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  if (!ids.length) return [];
  const { data: profs } = await a.admin.from("profiles").select("id, full_name").in("id", ids);
  const nameOf = new Map(((profs ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name]));
  // L'email n'est que dans auth.users : un nom absent ne doit pas rendre
  // quelqu'un inassignable.
  const emails = await Promise.all(ids.slice(0, 60).map(async (id) => {
    try {
      const { data: u } = await a.admin.auth.admin.getUserById(id);
      return u?.user?.email ?? null;
    } catch { return null; }
  }));
  return ids.map((id, i) => ({ user_id: id, name: nameOf.get(id) ?? null, email: emails[i] ?? null }));
}

async function resolveMembers(a: OpsActor, refs: string[]): Promise<{ ids: string[]; unresolved: string[] }> {
  if (!refs.length) return { ids: [], unresolved: [] };
  const members = await workspaceMembers(a);
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const raw of refs) {
    const r = raw.trim().toLowerCase();
    if (["moi", "me", "myself", "je"].includes(r) && a.userId) { ids.push(a.userId); continue; }
    const hit = members.find((m) => m.user_id === raw || (m.email ?? "").toLowerCase() === r)
      ?? members.find((m) => (m.name ?? "").toLowerCase() === r)
      ?? members.find((m) => (m.name ?? "").toLowerCase().includes(r) || (m.email ?? "").toLowerCase().startsWith(r));
    if (hit) ids.push(hit.user_id); else unresolved.push(raw);
  }
  return { ids: [...new Set(ids)], unresolved };
}

async function resolveAgentIds(a: OpsActor, refs: string[]): Promise<{ ids: string[]; names: string[]; errors: string[] }> {
  const out = { ids: [] as string[], names: [] as string[], errors: [] as string[] };
  for (const r of refs) {
    const ag = await findAgent(a, r);
    if (typeof ag === "string") out.errors.push(ag);
    else if (!out.ids.includes(ag.id)) { out.ids.push(ag.id); out.names.push(ag.name); }
  }
  return out;
}

interface StateRow { id: string; name: string; group: string; sequence: number; is_default: boolean | null }

async function projectStates(a: OpsActor, pjProjectId: string): Promise<StateRow[]> {
  const { data } = await a.admin.from("pj_states")
    .select("id, name, \"group\", sequence, is_default").eq("pj_project_id", pjProjectId).order("sequence");
  return (data ?? []) as StateRow[];
}

/** Les états qui ferment un item, terminé OU annulé. `completed_at` ne suffit
 *  pas : il n'est posé que pour « terminé », et un item annulé passait pour
 *  ouvert. */
async function closedStateIds(a: OpsActor, pjProjectIds: string[]): Promise<string[]> {
  if (!pjProjectIds.length) return [];
  const { data } = await a.admin.from("pj_states").select("id")
    .in("pj_project_id", pjProjectIds).in("group", ["completed", "cancelled"]);
  return ((data ?? []) as Array<{ id: string }>).map((s) => s.id);
}

/** Un état par id, par nom, ou par groupe (« terminé » = le premier état du groupe completed). */
function pickState(states: StateRow[], ref: unknown, group: unknown): StateRow | string | undefined {
  const r = str(ref).trim();
  if (r) {
    const hit = states.find((s) => s.id === r) ?? states.find((s) => s.name.toLowerCase() === r.toLowerCase());
    if (hit) return hit;
    const g = STATE_GROUP_FR[r.toLowerCase()];
    if (g) return states.find((s) => s.group === g) ?? `ERREUR : ce projet n'a pas d'état du groupe ${g}.`;
    return `ERREUR : état « ${r} » inconnu. États : ${states.map((s) => `${s.name} (${s.group})`).join(", ")}.`;
  }
  const gRaw = str(group).trim().toLowerCase();
  if (gRaw) {
    const g = STATE_GROUP_FR[gRaw] ?? gRaw;
    if (!STATE_GROUPS.includes(g)) return `ERREUR : state_group vaut ${STATE_GROUPS.join(", ")}.`;
    return states.find((s) => s.group === g) ?? `ERREUR : ce projet n'a pas d'état du groupe ${g}.`;
  }
  return undefined;
}

/** Des labels par nom ; ceux qui n'existent pas encore sont créés. */
async function resolveLabels(a: OpsActor, project: PjProjectRow, names: string[]): Promise<{ ids: string[]; created: string[] }> {
  if (!names.length) return { ids: [], created: [] };
  const { data } = await a.admin.from("pj_labels").select("id, name").eq("pj_project_id", project.id);
  const existing = (data ?? []) as Array<{ id: string; name: string }>;
  const ids: string[] = [];
  const created: string[] = [];
  for (const n of names) {
    const hit = existing.find((l) => l.id === n || l.name.toLowerCase() === n.toLowerCase());
    if (hit) { ids.push(hit.id); continue; }
    const { data: row, error } = await a.admin.from("pj_labels").insert({
      pj_project_id: project.id, workspace_id: project.workspace_id,
      name: n.slice(0, 60), color: LABEL_COLORS[(existing.length + created.length) % LABEL_COLORS.length],
    }).select("id, name").single();
    if (!error && row) {
      existing.push(row as { id: string; name: string });
      ids.push((row as { id: string }).id);
      created.push(n);
    }
  }
  return { ids: [...new Set(ids)], created };
}

/** Le chemin du projet dans l'application. */
async function projectUrl(a: OpsActor, p: PjProjectRow): Promise<string | null> {
  const base = await appBase(a, p.dashboard_id);
  return base ? `${base}/projects/${p.id}` : null;
}

/** Un work item en une ligne, avec qui le porte. */
async function describeIssues(a: OpsActor, project: PjProjectRow, rows: PjIssueRow[]): Promise<string> {
  if (!rows.length) return "Aucun work item.";
  const ids = rows.map((r) => r.id);
  const [states, { data: ag }, { data: as }, { data: lb }, members] = await Promise.all([
    projectStates(a, project.id),
    a.admin.from("pj_issue_agents").select("issue_id, internal_agents(name)").in("issue_id", ids),
    a.admin.from("pj_issue_assignees").select("issue_id, user_id").in("issue_id", ids),
    a.admin.from("pj_issue_labels").select("issue_id, pj_labels(name)").in("issue_id", ids),
    workspaceMembers(a),
  ]);
  const st = new Map<string, StateRow>(states.map((s) => [s.id, s] as [string, StateRow]));
  const memberName = new Map(members.map((m) => [m.user_id, m.name ?? m.email ?? m.user_id.slice(0, 8)]));
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v) as { name?: string } | null;
  return rows.map((r) => {
    const agents = ((ag ?? []) as Array<{ issue_id: string; internal_agents: unknown }>).filter((x) => x.issue_id === r.id).map((x) => one(x.internal_agents)?.name).filter(Boolean);
    const people = ((as ?? []) as Array<{ issue_id: string; user_id: string }>).filter((x) => x.issue_id === r.id).map((x) => memberName.get(x.user_id));
    const labels = ((lb ?? []) as Array<{ issue_id: string; pj_labels: unknown }>).filter((x) => x.issue_id === r.id).map((x) => one(x.pj_labels)?.name).filter(Boolean);
    const s = r.state_id ? st.get(r.state_id) : null;
    return [
      `- ${refOf(project, r)} « ${r.name} »`,
      s ? `état: ${s.name}` : null,
      r.priority && r.priority !== "none" ? `priorité: ${r.priority}` : null,
      r.target_date ? `échéance: ${r.target_date}` : null,
      agents.length ? `agents: ${agents.join(", ")}` : null,
      people.length ? `personnes: ${people.join(", ")}` : null,
      labels.length ? `labels: ${labels.join(", ")}` : null,
      r.agent_autorun ? "démarrage auto" : null,
      `(issue_id: ${r.id})`,
    ].filter(Boolean).join(" · ");
  }).join("\n");
}

interface IssueInput {
  name?: string; description?: string; priority?: unknown; state?: unknown; state_group?: unknown;
  start_date?: unknown; target_date?: unknown; parent?: string;
  labels?: string[]; agents?: string[]; members?: string[];
  agent_brief?: string; agent_autorun?: boolean;
}

function issueInputOf(p: Record<string, unknown>): IssueInput {
  return {
    name: str(p.name ?? p.title).trim(),
    description: p.description !== undefined ? str(p.description) : undefined,
    priority: p.priority, state: p.state ?? p.state_id, state_group: p.state_group,
    start_date: p.start_date, target_date: p.target_date ?? p.due_date,
    parent: str(p.parent ?? p.parent_id).trim() || undefined,
    labels: strList(p.labels),
    agents: strList(p.assign_agents ?? p.agents),
    members: strList(p.assign_members ?? p.members ?? p.assignees),
    agent_brief: p.agent_brief !== undefined ? str(p.agent_brief) : undefined,
    agent_autorun: bool(p.agent_autorun),
  };
}

/** Crée un work item complet : état, labels, assignations, parent, brief. */
async function createIssue(
  a: OpsActor, project: PjProjectRow, input: IssueInput, states: StateRow[],
): Promise<{ row: PjIssueRow; notes: string[] } | string> {
  if (!input.name) return "ERREUR : name est requis.";
  const notes: string[] = [];
  const picked = pickState(states, input.state, input.state_group);
  if (typeof picked === "string") return picked;
  const state = picked ?? states.find((s) => s.is_default) ?? states[0] ?? null;

  let parentId: string | null = null;
  if (input.parent) {
    const par = await findIssue(a, input.parent);
    if (typeof par === "string") return par;
    if (par.project.id !== project.id) return "ERREUR : le parent doit être dans le même projet.";
    parentId = par.issue.id;
  }
  const priority = priorityParam(input.priority) ?? "none";
  const { data, error } = await a.admin.from("pj_issues").insert({
    pj_project_id: project.id, workspace_id: project.workspace_id,
    name: input.name.slice(0, 255),
    description_text: input.description ?? "", description_html: input.description ?? "",
    priority, state_id: state?.id ?? null, parent_id: parentId,
    start_date: dateParam(input.start_date) ?? null, target_date: dateParam(input.target_date) ?? null,
    agent_brief: input.agent_brief?.trim() || null,
    agent_autorun: input.agent_autorun === true,
    sort_order: 65535,
    created_by: a.userId, updated_by: a.userId,
  }).select(PJ_ISSUE_COLS).single();
  if (error || !data) return `ERREUR : ${error?.message ?? "création impossible"}`;
  const row = data as PjIssueRow;

  const links = await applyIssueLinks(a, project, row, {
    addLabels: input.labels ?? [], addAgents: input.agents ?? [], addMembers: input.members ?? [],
  });
  notes.push(...links);
  return { row, notes };
}

/** Pose (ou retire) labels, agents et personnes sur un item. Rend ce qui s'est passé. */
async function applyIssueLinks(
  a: OpsActor, project: PjProjectRow, issue: PjIssueRow,
  ops: {
    addLabels?: string[]; removeLabels?: string[];
    addAgents?: string[]; removeAgents?: string[];
    addMembers?: string[]; removeMembers?: string[];
  },
): Promise<string[]> {
  const db = a.admin;
  const notes: string[] = [];
  if (ops.addLabels?.length) {
    const l = await resolveLabels(a, project, ops.addLabels);
    if (l.ids.length) {
      await db.from("pj_issue_labels").delete().eq("issue_id", issue.id).in("label_id", l.ids);
      await db.from("pj_issue_labels").insert(l.ids.map((label_id) => ({
        issue_id: issue.id, label_id, pj_project_id: project.id, workspace_id: project.workspace_id,
      })));
    }
    if (l.created.length) notes.push(`labels créés : ${l.created.join(", ")}`);
  }
  if (ops.removeLabels?.length) {
    const { data } = await db.from("pj_labels").select("id, name").eq("pj_project_id", project.id);
    const ids = ((data ?? []) as Array<{ id: string; name: string }>)
      .filter((x) => ops.removeLabels!.some((n) => n === x.id || n.toLowerCase() === x.name.toLowerCase())).map((x) => x.id);
    if (ids.length) await db.from("pj_issue_labels").delete().eq("issue_id", issue.id).in("label_id", ids);
  }
  if (ops.addAgents?.length) {
    const r = await resolveAgentIds(a, ops.addAgents);
    if (r.ids.length) {
      await db.from("pj_issue_agents").upsert(
        r.ids.map((agent_id) => ({ issue_id: issue.id, agent_id, workspace_id: project.workspace_id, assigned_by: a.userId })),
        { onConflict: "issue_id,agent_id", ignoreDuplicates: true },
      );
      notes.push(`confié à ${r.names.join(", ")}`);
    }
    notes.push(...r.errors);
  }
  if (ops.removeAgents?.length) {
    const r = await resolveAgentIds(a, ops.removeAgents);
    if (r.ids.length) await db.from("pj_issue_agents").delete().eq("issue_id", issue.id).in("agent_id", r.ids);
    notes.push(...r.errors);
  }
  if (ops.addMembers?.length) {
    const r = await resolveMembers(a, ops.addMembers);
    if (r.ids.length) {
      await db.from("pj_issue_assignees").delete().eq("issue_id", issue.id).in("user_id", r.ids);
      await db.from("pj_issue_assignees").insert(r.ids.map((user_id) => ({
        issue_id: issue.id, user_id, pj_project_id: project.id, workspace_id: project.workspace_id,
      })));
    }
    if (r.unresolved.length) notes.push(`personnes introuvables : ${r.unresolved.join(", ")}`);
  }
  if (ops.removeMembers?.length) {
    const r = await resolveMembers(a, ops.removeMembers);
    if (r.ids.length) await db.from("pj_issue_assignees").delete().eq("issue_id", issue.id).in("user_id", r.ids);
  }
  return notes;
}

/** Met un agent au travail sur un item : mission rattachée, assignation, réveil. */
async function launchAgentOnIssue(
  a: OpsActor, project: PjProjectRow, issue: PjIssueRow, agent: AgentLite,
  brief: string, acceptance: string, title: string,
): Promise<string> {
  // Un garde-fou de débit : lancer coûte, et un modèle en boucle pourrait
  // lancer le même lot dix fois.
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { count } = await a.admin.from("internal_agent_missions")
    .select("id", { count: "exact", head: true })
    .eq("pj_project_id", project.id).not("pj_issue_id", "is", null).gt("created_at", since);
  if ((count ?? 0) >= 15) return "ERREUR : plus de 15 lancements sur ce projet en dix minutes. Attends que les premiers avancent.";

  const { data: running } = await a.admin.from("internal_agent_missions")
    .select("id").eq("pj_issue_id", issue.id).eq("agent_id", agent.id).eq("status", "active").gt("created_at", since).limit(1);
  if ((running ?? []).length) return `${agent.name} vient déjà d'être lancé sur ${refOf(project, issue)}.`;

  const { data: mission, error } = await a.admin.from("internal_agent_missions").insert({
    agent_id: agent.id, workspace_id: project.workspace_id, project_id: project.project_id,
    pj_project_id: project.id, pj_issue_id: issue.id,
    title: title || issue.name,
    brief: brief || issue.agent_brief || issue.description_text || issue.name,
    acceptance_criteria: acceptance || null,
    status: "active", created_by: a.userId,
  }).select("id").single();
  if (error || !mission) return `ERREUR : ${error?.message ?? "mission non créée"}`;
  await a.admin.from("pj_issue_agents").upsert(
    { issue_id: issue.id, agent_id: agent.id, workspace_id: project.workspace_id, assigned_by: a.userId },
    { onConflict: "issue_id,agent_id", ignoreDuplicates: true },
  );
  // Le brief reste sur l'item : c'est lui que l'item montre, et que relira
  // l'agent s'il est relancé plus tard.
  if (brief && !issue.agent_brief) {
    await a.admin.from("pj_issues").update({ agent_brief: brief }).eq("id", issue.id);
  }
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (base && key) {
    // Sans attendre : un run dure des minutes. En cas d'échec de l'appel,
    // l'ordonnanceur reprend la mission active.
    fetch(`${base}/functions/v1/internal-agent-run`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "mission", mission_id: (mission as { id: string }).id }),
    }).catch(() => {});
  }
  return `${agent.name} est au travail sur ${refOf(project, issue)} « ${issue.name} » (mission ${(mission as { id: string }).id}). Son livrable sera rattaché à l'item.`;
}

/** Le texte d'une page (markdown) depuis ce que le modèle a écrit. */
function pageMarkdown(v: unknown): string {
  return str(v).replace(/\r\n/g, "\n").trim();
}

// ── manage_projects ─────────────────────────────────────────────────────────

const PROJECT_READS = [
  "list_projects", "get_project", "list_work_items", "get_work_item", "search",
  "list_pages", "get_page", "list_members", "agent_work",
];
const PROJECT_WRITES = [
  "create_project", "update_project", "set_project_agents", "create_state", "create_label",
  "create_work_item", "create_work_items", "update_work_item", "bulk_update", "break_down",
  "comment", "relate", "archive_work_item", "restore_work_item", "launch_agent",
  "create_page", "update_page",
];
export const PROJECT_ACTIONS = [...PROJECT_READS, ...PROJECT_WRITES];

const PROJECT_ALIASES: Record<string, string> = {
  list: "list_projects", projects: "list_projects", get: "get_project",
  list_issues: "list_work_items", get_issue: "get_work_item", issue: "get_work_item",
  create_issue: "create_work_item", create_task: "create_work_item", add_work_item: "create_work_item",
  create_issues: "create_work_items", create_tasks: "create_work_items", create_backlog: "create_work_items",
  update_issue: "update_work_item", update_task: "update_work_item", move: "update_work_item",
  assign: "update_work_item", assign_agent: "update_work_item", subtasks: "break_down", split: "break_down",
  add_comment: "comment", link: "relate", add_relation: "relate",
  archive: "archive_work_item", restore: "restore_work_item", run_agent: "launch_agent", start_agent: "launch_agent",
  set_crew: "set_project_agents", add_project_agents: "set_project_agents", members: "list_members",
  create_wiki_page: "create_page", write_page: "create_page", edit_page: "update_page",
};

const PROJECT_PARAMS_DOC =
  "« project » = nom, identifiant (ABC) ou project_id. « issue » = référence ABC-12, issue_id ou titre. " +
  "« agents » / « members » = noms (ou ids ; « moi » = la personne). " +
  "list_projects: {service?}. get_project: {project}. " +
  "list_work_items: {project, state_group?, priority?, agent?, member?, label?, parent?, include_done?, limit?}. " +
  "get_work_item: {issue}. search: {query}. list_pages: {project?} (sans projet : le wiki du service). get_page: {page}. " +
  "list_members: {} (personnes et agents assignables). agent_work: {agent}. " +
  "create_project: {name, identifier?, description?, service?, agents?: [nom], start_date?, target_date?}. " +
  "update_project: {project, name?, description?, start_date?, target_date?}. " +
  "set_project_agents: {project, agents: [nom], role?: contributor|observer, mode?: add|remove|replace}. " +
  "create_state: {project, name, group (backlog|unstarted|started|completed|cancelled), color?}. create_label: {project, name, color?}. " +
  "create_work_item: {project, name, description?, priority? (urgent|high|medium|low|none), state? (nom ou groupe), " +
  "labels?: [nom], assign_agents?: [nom], assign_members?: [nom], parent?, start_date?, target_date? (AAAA-MM-JJ), agent_brief?, agent_autorun?}. " +
  "create_work_items: {project, parent?, items: [mêmes champs que create_work_item]} (30 max). " +
  "update_work_item: {issue, name?, description?, priority?, state?, start_date?, target_date?, parent? (\"\" = retirer), " +
  "add_labels?, remove_labels?, add_agents?, remove_agents?, add_members?, remove_members?, agent_brief?, agent_autorun?}. " +
  "bulk_update: {issues: [ref], state?, priority?, add_agents?, add_labels?, target_date?}. " +
  "break_down: {issue, titles: [string], assign_agents?}. comment: {issue, body}. " +
  "relate: {issue, related, type (relates_to|blocks|blocked_by|duplicate|start_before|start_after|finish_before|finish_after)}. " +
  "archive_work_item / restore_work_item: {issue}. " +
  "launch_agent: {issue, agent, brief?, acceptance?} → met l'agent au travail MAINTENANT (consomme du budget). " +
  "create_page: {name, content (markdown), project?, parent?}. update_page: {page, name?, content?, append?}.";

export const PROJECT_OPS_DESCRIPTION =
  "Le suivi de travail (module Projets) : projets, work items, états, labels, équipes d'agents, commentaires, " +
  "relations, pages de wiki. Lis, crée, organise, assigne à des personnes ou à des agents, et mets un agent au " +
  "travail sur un item. Agis pour la personne qui te parle : ce que tu crées lui appartient. Pas de suppression, " +
  "on archive.";

export function projectOpsToolDef(name = "manage_projects", actions: string[] = PROJECT_ACTIONS) {
  return {
    name,
    description: PROJECT_OPS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions, description: "L'opération. Lectures : " + PROJECT_READS.filter((x) => actions.includes(x)).join(", ") + "." },
        params: { type: "object", description: PROJECT_PARAMS_DOC },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

export async function runProjectOps(
  a: OpsActor, rawAction: string, params: Record<string, unknown>,
): Promise<OpsResult> {
  const action = PROJECT_ALIASES[rawAction] ?? rawAction;
  if (!PROJECT_ACTIONS.includes(action)) {
    return text(`ERREUR : l'action « ${rawAction} » n'existe pas. Actions : ${PROJECT_ACTIONS.join(", ")}.`);
  }
  if (PROJECT_WRITES.includes(action) && !canWrite(a)) {
    return text(`ACCÈS REFUSÉ : la personne a le rôle « ${a.role} », qui ne permet pas de modifier le suivi de travail.`);
  }
  const db = a.admin;
  const p = params ?? {};

  switch (action) {
    case "list_projects": {
      let dash: string | null = null;
      if (str(p.service)) {
        const s = await resolveService(a, str(p.service));
        if (typeof s === "string") return text(s);
        dash = s.id;
      }
      const projects = await scopeProjects(a, dash);
      if (!projects.length) return text("Aucun projet dans le suivi. Propose d'en créer un (create_project).");
      const services = new Map((await listServices(a)).map((s) => [s.id, s.name]));
      const ids = projects.map((x) => x.id);
      const closed = await closedStateIds(a, ids);
      const [{ data: crew }, counts] = await Promise.all([
        db.from("pj_project_agents").select("pj_project_id, role, internal_agents(name)").in("pj_project_id", ids),
        Promise.all(projects.map(async (x) => {
          const live = () => db.from("pj_issues").select("id", { count: "exact", head: true })
            .eq("pj_project_id", x.id).is("archived_at", null).eq("is_draft", false);
          const [{ count: total }, { count: done }] = await Promise.all([
            live(),
            closed.length ? live().in("state_id", closed) : Promise.resolve({ count: 0 }),
          ]);
          return { id: x.id, total: total ?? 0, open: (total ?? 0) - (done ?? 0) };
        })),
      ]);
      const one = (v: unknown) => (Array.isArray(v) ? v[0] : v) as { name?: string } | null;
      return text(projects.map((x) => {
        const c = counts.find((k) => k.id === x.id);
        const team = ((crew ?? []) as Array<{ pj_project_id: string; internal_agents: unknown }>)
          .filter((r) => r.pj_project_id === x.id).map((r) => one(r.internal_agents)?.name).filter(Boolean);
        return [
          `- ${x.identifier} · ${x.name} (project_id: ${x.id})`,
          x.dashboard_id ? `service: ${services.get(x.dashboard_id) ?? "?"}` : null,
          c ? `${c.open} ouvert(s) / ${c.total}` : null,
          team.length ? `équipe: ${team.join(", ")}` : "aucun agent dans l'équipe",
        ].filter(Boolean).join(" · ");
      }).join("\n"));
    }

    case "get_project": {
      const project = await findProject(a, str(p.project ?? p.project_id));
      if (typeof project === "string") return text(project);
      const [states, { data: labels }, { data: crew }, { data: issues }] = await Promise.all([
        projectStates(a, project.id),
        db.from("pj_labels").select("id, name").eq("pj_project_id", project.id).order("sort_order"),
        db.from("pj_project_agents").select("role, agent_id, internal_agents(name)").eq("pj_project_id", project.id),
        db.from("pj_issues").select(PJ_ISSUE_COLS).eq("pj_project_id", project.id).is("archived_at", null).eq("is_draft", false)
          .order("updated_at", { ascending: false }).limit(1000),
      ]);
      const all = (issues ?? []) as PjIssueRow[];
      const groupOf = new Map<string, string>(states.map((s) => [s.id, s.group] as [string, string]));
      const byGroup: Record<string, number> = {};
      for (const i of all) {
        const g = groupOf.get(i.state_id ?? "") ?? "?";
        byGroup[g] = (byGroup[g] ?? 0) + 1;
      }
      const one = (v: unknown) => (Array.isArray(v) ? v[0] : v) as { name?: string } | null;
      const url = await projectUrl(a, project);
      const isClosed = (i: PjIssueRow) => ["completed", "cancelled"].includes(groupOf.get(i.state_id ?? "") ?? "");
      const recent = await describeIssues(a, project, all.filter((i) => !isClosed(i)).slice(0, 12));
      return text([
        `${project.identifier} · ${project.name} (project_id: ${project.id})`,
        project.description ? `Description : ${project.description.slice(0, 600)}` : null,
        project.start_date || project.target_date ? `Dates : ${project.start_date ?? "?"} → ${project.target_date ?? "?"}` : null,
        `Avancement : ${STATE_GROUPS.map((g) => `${g} ${byGroup[g] ?? 0}`).join(", ")} (${all.length} au total)`,
        `États : ${states.map((s) => `${s.name} [${s.group}]`).join(", ")}`,
        `Labels : ${((labels ?? []) as Array<{ name: string }>).map((l) => l.name).join(", ") || "aucun"}`,
        `Équipe d'agents : ${((crew ?? []) as Array<{ role: string; internal_agents: unknown }>).map((c) => `${one(c.internal_agents)?.name} (${c.role})`).join(", ") || "aucun"}`,
        url ? `Lien : ${url}` : null,
        `\nItems ouverts récents :\n${recent}`,
      ].filter(Boolean).join("\n"));
    }

    case "list_work_items": {
      const project = await findProject(a, str(p.project ?? p.project_id));
      if (typeof project === "string") return text(project);
      let q = db.from("pj_issues").select(PJ_ISSUE_COLS)
        .eq("pj_project_id", project.id).is("archived_at", null).eq("is_draft", false)
        .order("updated_at", { ascending: false }).limit(Math.min(Number(p.limit) || 40, 100));
      if (bool(p.include_done) !== true && !str(p.state_group)) {
        const closed = await closedStateIds(a, [project.id]);
        if (closed.length) q = q.or(`state_id.is.null,state_id.not.in.(${closed.join(",")})`);
      }
      const pr = priorityParam(p.priority);
      if (pr) q = q.eq("priority", pr);
      if (str(p.parent)) {
        const par = await findIssue(a, str(p.parent));
        if (typeof par === "string") return text(par);
        q = q.eq("parent_id", par.issue.id);
      }
      const { data } = await q;
      let rows = (data ?? []) as PjIssueRow[];
      if (str(p.state_group)) {
        const g = STATE_GROUP_FR[str(p.state_group).toLowerCase()] ?? str(p.state_group);
        const states = await projectStates(a, project.id);
        const ok = new Set(states.filter((s) => s.group === g).map((s) => s.id));
        rows = rows.filter((r) => ok.has(r.state_id ?? ""));
      }
      if (str(p.agent)) {
        const ag = await findAgent(a, str(p.agent));
        if (typeof ag === "string") return text(ag);
        const { data: links } = await db.from("pj_issue_agents").select("issue_id").eq("agent_id", ag.id);
        const ids = new Set(((links ?? []) as Array<{ issue_id: string }>).map((l) => l.issue_id));
        rows = rows.filter((r) => ids.has(r.id));
      }
      if (str(p.member)) {
        const m = await resolveMembers(a, [str(p.member)]);
        const { data: links } = m.ids.length
          ? await db.from("pj_issue_assignees").select("issue_id").in("user_id", m.ids)
          : { data: [] };
        const ids = new Set(((links ?? []) as Array<{ issue_id: string }>).map((l) => l.issue_id));
        rows = rows.filter((r) => ids.has(r.id));
      }
      if (str(p.label)) {
        const { data: lab } = await db.from("pj_labels").select("id").eq("pj_project_id", project.id).ilike("name", likeSafe(str(p.label)));
        const labIds = ((lab ?? []) as Array<{ id: string }>).map((l) => l.id);
        const { data: links } = labIds.length ? await db.from("pj_issue_labels").select("issue_id").in("label_id", labIds) : { data: [] };
        const ids = new Set(((links ?? []) as Array<{ issue_id: string }>).map((l) => l.issue_id));
        rows = rows.filter((r) => ids.has(r.id));
      }
      return text(rows.length ? await describeIssues(a, project, rows) : "Rien ne correspond.");
    }

    case "get_work_item": {
      const found = await findIssue(a, str(p.issue ?? p.issue_id ?? p.ref));
      if (typeof found === "string") return text(found);
      const { issue, project } = found;
      const [states, { data: children }, { data: rels }, { data: comments }, { data: missions }, resources, line] = await Promise.all([
        projectStates(a, project.id),
        db.from("pj_issues").select("id, sequence_id, name, completed_at").eq("parent_id", issue.id).is("archived_at", null).limit(40),
        db.from("pj_issue_relations").select("relation_type, related_id").eq("issue_id", issue.id),
        db.from("pj_issue_comments").select("comment_html, agent_name, actor_id, created_at").eq("issue_id", issue.id)
          .order("created_at", { ascending: false }).limit(8),
        db.from("internal_agent_missions").select("title, status, agent_id, internal_agents(name), created_at")
          .eq("pj_issue_id", issue.id).order("created_at", { ascending: false }).limit(5),
        describeIssueAssets(db, issue.id),
        describeIssues(a, project, [issue]),
      ]);
      const st = states.find((s) => s.id === issue.state_id);
      let parentLine: string | null = null;
      if (issue.parent_id) {
        const { data: par } = await db.from("pj_issues").select("sequence_id, name").eq("id", issue.parent_id).maybeSingle();
        if (par) parentLine = `Parent : ${refOf(project, par as { sequence_id: number })} « ${(par as { name: string }).name} »`;
      }
      const relIds = ((rels ?? []) as Array<{ related_id: string }>).map((r) => r.related_id);
      const { data: relRows } = relIds.length ? await db.from("pj_issues").select("id, sequence_id, name").in("id", relIds) : { data: [] };
      const relName = new Map(((relRows ?? []) as Array<{ id: string; sequence_id: number; name: string }>).map((r) => [r.id, `${refOf(project, r)} « ${r.name} »`]));
      const one = (v: unknown) => (Array.isArray(v) ? v[0] : v) as { name?: string } | null;
      return text([
        line,
        `Projet : ${project.identifier} · ${project.name}`,
        `État : ${st ? `${st.name} [${st.group}]` : "aucun"}${issue.completed_at ? " (terminé)" : ""}`,
        issue.start_date ? `Début : ${issue.start_date}` : null,
        parentLine,
        issue.description_text ? `\nDescription :\n${issue.description_text.slice(0, 2500)}` : null,
        issue.agent_brief ? `\nBrief pour l'agent :\n${issue.agent_brief.slice(0, 1500)}` : null,
        (children ?? []).length ? `\nSous-items :\n${((children ?? []) as Array<{ sequence_id: number; name: string; completed_at: string | null }>).map((c) => `- ${refOf(project, c)} « ${c.name} »${c.completed_at ? " (terminé)" : ""}`).join("\n")}` : null,
        (rels ?? []).length ? `\nRelations :\n${((rels ?? []) as Array<{ relation_type: string; related_id: string }>).map((r) => `- ${r.relation_type} ${relName.get(r.related_id) ?? r.related_id}`).join("\n")}` : null,
        resources ? `\nRessources :\n${resources}` : null,
        (missions ?? []).length ? `\nMissions d'agents :\n${((missions ?? []) as Array<Record<string, unknown>>).map((m) => `- ${one(m.internal_agents)?.name ?? "agent"} · ${m.status} · « ${m.title} »`).join("\n")}` : null,
        (comments ?? []).length ? `\nDerniers commentaires :\n${((comments ?? []) as Array<Record<string, unknown>>).reverse().map((c) => `- ${str(c.created_at).slice(0, 16).replace("T", " ")}${c.agent_name ? ` · ${c.agent_name}` : ""} : ${str(c.comment_html).replace(/<[^>]+>/g, "").slice(0, 300)}`).join("\n")}` : null,
      ].filter(Boolean).join("\n"));
    }

    case "search": {
      const query = str(p.query).trim();
      if (!query) return text("ERREUR : query est requis.");
      const projects = await scopeProjects(a);
      if (!projects.length) return text("Aucun projet dans le suivi.");
      const byId = new Map(projects.map((x) => [x.id, x]));
      const m = /^([A-Za-z0-9]{1,12})-(\d+)$/.exec(query);
      if (m) {
        const f = await findIssue(a, query);
        return text(typeof f === "string" ? f : await describeIssues(a, f.project, [f.issue]));
      }
      const { data } = await db.from("pj_issues").select(PJ_ISSUE_COLS)
        .in("pj_project_id", projects.map((x) => x.id)).is("archived_at", null)
        .or(`name.ilike.%${likeSafe(query)}%,description_text.ilike.%${likeSafe(query)}%`).limit(25);
      const rows = (data ?? []) as PjIssueRow[];
      const hitProjects = projects.filter((x) => x.name.toLowerCase().includes(query.toLowerCase()));
      const lines = rows.map((r) => `- ${refOf(byId.get(r.pj_project_id)!, r)} « ${r.name} » (issue_id: ${r.id})`);
      if (hitProjects.length) lines.unshift(...hitProjects.map((x) => `- projet ${x.identifier} · ${x.name} (project_id: ${x.id})`));
      return text(lines.join("\n") || "Aucun résultat.");
    }

    case "list_pages": {
      let q = db.from("pj_pages").select("id, name, pj_project_id, updated_at").is("archived_at", null);
      if (str(p.project)) {
        const project = await findProject(a, str(p.project));
        if (typeof project === "string") return text(project);
        q = q.eq("pj_project_id", project.id);
      } else {
        const s = await resolveService(a, str(p.service));
        if (typeof s === "string") return text(s);
        q = q.eq("dashboard_id", s.id).is("pj_project_id", null);
      }
      const { data } = await q.order("updated_at", { ascending: false }).limit(60);
      const rows = (data ?? []) as Array<{ id: string; name: string; updated_at: string }>;
      return text(rows.length
        ? rows.map((r) => `- ${r.name || "Sans titre"} (page_id: ${r.id}) · modifiée ${r.updated_at.slice(0, 10)}`).join("\n")
        : "Aucune page.");
    }

    case "get_page": {
      const page = await findPage(a, str(p.page ?? p.page_id));
      if (typeof page === "string") return text(page);
      return text(`${page.name || "Sans titre"} (page_id: ${page.id})\n\n${str(page.description_html).slice(0, 12000) || "(page vide)"}`);
    }

    case "list_members": {
      const [members, agents] = await Promise.all([
        workspaceMembers(a),
        db.from("internal_agents").select("id, name, role").eq("project_id", a.projectId).eq("is_archived", false).order("name").limit(80),
      ]);
      return text([
        "Personnes :",
        ...members.map((m) => `- ${m.name ?? m.email ?? m.user_id}${m.email && m.name ? ` (${m.email})` : ""}${m.user_id === a.userId ? " · c'est la personne qui te parle" : ""}`),
        "Agents :",
        ...((agents.data ?? []) as Array<{ id: string; name: string; role: string | null }>).map((x) => `- ${x.name}${x.role ? ` · ${x.role}` : ""}`),
      ].join("\n"));
    }

    case "agent_work": {
      const ag = await findAgent(a, str(p.agent));
      if (typeof ag === "string") return text(ag);
      const { data } = await db.rpc("pj_agent_work", { p_agent: ag.id });
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      if (!rows.length) return text(`Rien n'est confié à ${ag.name} dans le suivi.`);
      const open = rows.filter((r) => !r.completed_at);
      return text(`${ag.name} : ${open.length} item(s) ouvert(s), ${rows.length - open.length} terminé(s).\n`
        + open.map((r) => `- ${r.identifier}-${r.sequence_id} « ${r.name} » · état: ${r.state_name ?? "?"}${r.target_date ? ` · échéance: ${r.target_date}` : ""}`).join("\n"));
    }

    case "create_project": {
      const name = str(p.name).trim().slice(0, 120);
      if (!name) return text("ERREUR : name est requis.");
      const service = await resolveService(a, str(p.service));
      if (typeof service === "string") return text(service);
      const existing = await scopeProjects(a);
      const twin = existing.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.dashboard_id === service.id);
      if (twin) return text(`ERREUR : le projet « ${name} » existe déjà (${twin.identifier}, project_id: ${twin.id}).`);
      // L'identifiant est unique par projet founderos : on suffixe s'il est pris.
      let ident = (str(p.identifier).toUpperCase().replace(/[^A-Z0-9]/g, "") || deriveIdentifier(name)).slice(0, 10) || "PROJ";
      const taken = new Set(existing.map((x) => x.identifier));
      const { data: allIdents } = await db.from("pj_projects").select("identifier").eq("project_id", a.projectId);
      for (const r of (allIdents ?? []) as Array<{ identifier: string }>) taken.add(r.identifier);
      if (taken.has(ident)) {
        let n = 2;
        while (taken.has(`${ident.slice(0, 10)}${n}`)) n++;
        ident = `${ident.slice(0, 10)}${n}`;
      }
      const { data, error } = await db.from("pj_projects").insert({
        workspace_id: a.workspaceId, project_id: a.projectId, dashboard_id: service.id,
        name, identifier: ident, description: str(p.description).trim() || null,
        network: 2, logo_props: {}, created_by: a.userId,
        start_date: dateParam(p.start_date) ?? null, target_date: dateParam(p.target_date) ?? null,
      }).select(PJ_PROJECT_COLS).single();
      if (error || !data) return text(`ERREUR : ${error?.message ?? "création impossible"}`);
      const project = data as PjProjectRow;
      if (a.userId) {
        await db.from("pj_project_members").insert({
          pj_project_id: project.id, workspace_id: a.workspaceId, user_id: a.userId, role: 20,
        }).then(() => {}, () => {});
      }
      const notes = [`Projet ${project.identifier} « ${name} » créé dans ${service.name} (project_id: ${project.id}), avec les états par défaut.`];
      const crew = strList(p.agents);
      if (crew.length) {
        const r = await resolveAgentIds(a, crew);
        if (r.ids.length) {
          await db.from("pj_project_agents").insert(r.ids.map((agent_id) => ({
            pj_project_id: project.id, workspace_id: a.workspaceId, agent_id, role: "contributor",
          })));
          notes.push(`Équipe : ${r.names.join(", ")}.`);
        }
        notes.push(...r.errors);
      }
      const url = await projectUrl(a, project);
      return text(notes.join("\n"), url ? [{ component: "link_card", props: { title: `Ouvrir ${project.identifier} · ${name}`, description: "Projet du suivi de travail", url } }] : undefined);
    }

    case "update_project": {
      const project = await findProject(a, str(p.project ?? p.project_id));
      if (typeof project === "string") return text(project);
      const patch: Record<string, unknown> = {};
      if (str(p.name).trim()) patch.name = str(p.name).trim().slice(0, 120);
      if (p.description !== undefined) patch.description = str(p.description).trim() || null;
      const sd = dateParam(p.start_date); if (sd !== undefined) patch.start_date = sd;
      const td = dateParam(p.target_date); if (td !== undefined) patch.target_date = td;
      if (!Object.keys(patch).length) return text("ERREUR : rien à modifier.");
      patch.updated_at = new Date().toISOString();
      const { error } = await db.from("pj_projects").update(patch).eq("id", project.id);
      if (error) return text(`ERREUR : ${error.message}`);
      return text(`${project.identifier} mis à jour : ${Object.keys(patch).filter((k) => k !== "updated_at").join(", ")}.`);
    }

    case "set_project_agents": {
      const project = await findProject(a, str(p.project ?? p.project_id));
      if (typeof project === "string") return text(project);
      const role = str(p.role) === "observer" ? "observer" : "contributor";
      const mode = ["remove", "replace"].includes(str(p.mode)) ? str(p.mode) : "add";
      const r = await resolveAgentIds(a, strList(p.agents));
      if (!r.ids.length && mode !== "replace") return text(r.errors.join("\n") || "ERREUR : agents est requis.");
      if (mode === "replace") await db.from("pj_project_agents").delete().eq("pj_project_id", project.id);
      if (mode === "remove") {
        await db.from("pj_project_agents").delete().eq("pj_project_id", project.id).in("agent_id", r.ids);
      } else if (r.ids.length) {
        await db.from("pj_project_agents").delete().eq("pj_project_id", project.id).in("agent_id", r.ids);
        await db.from("pj_project_agents").insert(r.ids.map((agent_id) => ({
          pj_project_id: project.id, workspace_id: project.workspace_id, agent_id, role,
        })));
      }
      return text([
        mode === "remove"
          ? `Retirés de l'équipe de ${project.identifier} : ${r.names.join(", ")}.`
          : `Équipe de ${project.identifier}${mode === "replace" ? " remplacée" : ""} : ${r.names.join(", ") || "vide"} (${role}).`,
        mode !== "remove" && r.ids.length
          ? "Ils peuvent maintenant lire et faire avancer les items de ce projet ; ils ne démarrent seuls que sur les items en démarrage auto, ou si on les lance."
          : null,
        ...r.errors,
      ].filter(Boolean).join("\n"));
    }

    case "create_state": {
      const project = await findProject(a, str(p.project ?? p.project_id));
      if (typeof project === "string") return text(project);
      const name = str(p.name).trim();
      const group = STATE_GROUP_FR[str(p.group).toLowerCase()] ?? str(p.group);
      if (!name || !STATE_GROUPS.includes(group)) return text(`ERREUR : name et group (${STATE_GROUPS.join("|")}) sont requis.`);
      const states = await projectStates(a, project.id);
      if (states.some((s) => s.name.toLowerCase() === name.toLowerCase())) return text(`L'état « ${name} » existe déjà.`);
      const inGroup = states.filter((s) => s.group === group);
      const sequence = inGroup.length
        ? Math.max(...inGroup.map((s) => s.sequence)) + 1000
        : (STATE_GROUPS.indexOf(group) + 1) * 10000 + 5000;
      const { error } = await db.from("pj_states").insert({
        pj_project_id: project.id, workspace_id: project.workspace_id,
        name, color: str(p.color) || "#64748b", group, sequence,
      });
      if (error) return text(`ERREUR : ${error.message}`);
      return text(`État « ${name} » (${group}) ajouté à ${project.identifier}.`);
    }

    case "create_label": {
      const project = await findProject(a, str(p.project ?? p.project_id));
      if (typeof project === "string") return text(project);
      const name = str(p.name).trim();
      if (!name) return text("ERREUR : name est requis.");
      const { error } = await db.from("pj_labels").insert({
        pj_project_id: project.id, workspace_id: project.workspace_id, name: name.slice(0, 60),
        color: str(p.color) || LABEL_COLORS[name.length % LABEL_COLORS.length],
      });
      if (error) return text(/duplicate|unique/i.test(error.message) ? `Le label « ${name} » existe déjà.` : `ERREUR : ${error.message}`);
      return text(`Label « ${name} » ajouté à ${project.identifier}.`);
    }

    case "create_work_item": {
      const project = await findProject(a, str(p.project ?? p.project_id));
      if (typeof project === "string") return text(project);
      const states = await projectStates(a, project.id);
      const res = await createIssue(a, project, issueInputOf(p), states);
      if (typeof res === "string") return text(res);
      return text(`Créé : ${refOf(project, res.row)} « ${res.row.name} » (issue_id: ${res.row.id})${res.notes.length ? ` · ${res.notes.join(" · ")}` : ""}.`);
    }

    case "create_work_items": {
      const project = await findProject(a, str(p.project ?? p.project_id));
      if (typeof project === "string") return text(project);
      const items = Array.isArray(p.items) ? (p.items as unknown[]).slice(0, 30) : [];
      if (!items.length) return text("ERREUR : items est requis (liste d'objets {name, …}).");
      const states = await projectStates(a, project.id);
      const sharedParent = str(p.parent).trim() || undefined;
      const lines: string[] = [];
      for (const raw of items) {
        const it = (typeof raw === "string" ? { name: raw } : (raw ?? {})) as Record<string, unknown>;
        const input = issueInputOf(it);
        if (!input.parent && sharedParent) input.parent = sharedParent;
        const res = await createIssue(a, project, input, states);
        lines.push(typeof res === "string"
          ? `- « ${input.name || "?"} » : ${res}`
          : `- ${refOf(project, res.row)} « ${res.row.name} »${res.notes.length ? ` · ${res.notes.join(" · ")}` : ""}`);
      }
      return text(`${items.length} item(s) traités dans ${project.identifier} :\n${lines.join("\n")}`);
    }

    case "update_work_item":
    case "bulk_update": {
      const refs = action === "bulk_update" ? strList(p.issues ?? p.issue_ids).slice(0, 50) : [str(p.issue ?? p.issue_id ?? p.ref)];
      if (!refs.length || !refs[0]) return text("ERREUR : précise le ou les work items.");
      const out: string[] = [];
      for (const ref of refs) {
        const found = await findIssue(a, ref);
        if (typeof found === "string") { out.push(`- ${ref} : ${found}`); continue; }
        const { issue, project } = found;
        const patch: Record<string, unknown> = {};
        if (str(p.name).trim() && action === "update_work_item") patch.name = str(p.name).trim().slice(0, 255);
        if (p.description !== undefined && action === "update_work_item") {
          patch.description_text = str(p.description); patch.description_html = str(p.description);
        }
        const pr = priorityParam(p.priority); if (pr) patch.priority = pr;
        if (p.state !== undefined || p.state_id !== undefined || p.state_group !== undefined) {
          const st = pickState(await projectStates(a, project.id), p.state ?? p.state_id, p.state_group);
          if (typeof st === "string") { out.push(`- ${refOf(project, issue)} : ${st}`); continue; }
          if (st) patch.state_id = st.id;
        }
        const sd = dateParam(p.start_date); if (sd !== undefined) patch.start_date = sd;
        const td = dateParam(p.target_date ?? p.due_date); if (td !== undefined) patch.target_date = td;
        if (p.parent !== undefined && action === "update_work_item") {
          if (!str(p.parent).trim()) patch.parent_id = null;
          else {
            const par = await findIssue(a, str(p.parent));
            if (typeof par === "string") { out.push(`- ${refOf(project, issue)} : ${par}`); continue; }
            if (par.issue.id === issue.id) { out.push(`- ${refOf(project, issue)} : un item ne peut pas être son propre parent.`); continue; }
            patch.parent_id = par.issue.id;
          }
        }
        if (p.agent_brief !== undefined) patch.agent_brief = str(p.agent_brief).trim() || null;
        const ar = bool(p.agent_autorun); if (ar !== undefined) patch.agent_autorun = ar;
        if (Object.keys(patch).length) {
          patch.updated_at = new Date().toISOString();
          patch.updated_by = a.userId;
          const { error } = await db.from("pj_issues").update(patch).eq("id", issue.id);
          if (error) { out.push(`- ${refOf(project, issue)} : ERREUR ${error.message}`); continue; }
        }
        const notes = await applyIssueLinks(a, project, issue, {
          addLabels: strList(p.add_labels ?? p.labels), removeLabels: strList(p.remove_labels),
          addAgents: strList(p.add_agents ?? p.assign_agents), removeAgents: strList(p.remove_agents),
          addMembers: strList(p.add_members ?? p.assign_members), removeMembers: strList(p.remove_members),
        });
        const changed = Object.keys(patch).filter((k) => !["updated_at", "updated_by"].includes(k));
        out.push(`- ${refOf(project, issue)} « ${issue.name} » : ${[changed.length ? changed.join(", ") : null, ...notes].filter(Boolean).join(" · ") || "rien à changer"}`);
      }
      return text(out.join("\n"));
    }

    case "break_down": {
      const found = await findIssue(a, str(p.issue ?? p.issue_id));
      if (typeof found === "string") return text(found);
      const titles = strList(p.titles ?? p.items).slice(0, 25);
      if (!titles.length) return text("ERREUR : titles est requis (liste de sous-tâches).");
      const states = await projectStates(a, found.project.id);
      const agents = strList(p.assign_agents ?? p.agents);
      const lines: string[] = [];
      for (const name of titles) {
        const res = await createIssue(a, found.project, { name, parent: found.issue.id, agents }, states);
        lines.push(typeof res === "string" ? `- « ${name} » : ${res}` : `- ${refOf(found.project, res.row)} « ${res.row.name} »${res.notes.length ? ` · ${res.notes.join(" · ")}` : ""}`);
      }
      return text(`${refOf(found.project, found.issue)} découpé en ${titles.length} sous-item(s) :\n${lines.join("\n")}`);
    }

    case "comment": {
      const found = await findIssue(a, str(p.issue ?? p.issue_id));
      if (typeof found === "string") return text(found);
      const body = str(p.body ?? p.text).trim();
      if (!body) return text("ERREUR : body est requis.");
      // Signé par l'assistant, jamais au nom de la personne : un commentaire de
      // machine attribué à un humain est un faux.
      const { error } = await db.from("pj_issue_comments").insert({
        issue_id: found.issue.id, pj_project_id: found.project.id, workspace_id: found.project.workspace_id,
        agent_id: a.agentId, agent_name: a.agentName ?? "Assistant", actor_id: null,
        comment_html: body,
      });
      if (error) return text(`ERREUR : ${error.message}`);
      return text(`Commentaire publié sur ${refOf(found.project, found.issue)}.`);
    }

    case "relate": {
      const type = str(p.type ?? p.relation_type) || "relates_to";
      if (!RELATION_TYPES.includes(type)) return text(`ERREUR : type vaut ${RELATION_TYPES.join(", ")}.`);
      const [x, y] = await Promise.all([findIssue(a, str(p.issue)), findIssue(a, str(p.related))]);
      if (typeof x === "string") return text(x);
      if (typeof y === "string") return text(y);
      if (x.issue.id === y.issue.id) return text("ERREUR : un item ne se relie pas à lui-même.");
      const { error } = await db.from("pj_issue_relations").insert([
        { issue_id: x.issue.id, related_id: y.issue.id, workspace_id: x.project.workspace_id, relation_type: type, created_by: a.userId },
        { issue_id: y.issue.id, related_id: x.issue.id, workspace_id: y.project.workspace_id, relation_type: INVERSE_RELATION[type], created_by: a.userId },
      ]);
      if (error && !/duplicate|unique/i.test(error.message)) return text(`ERREUR : ${error.message}`);
      return text(`${refOf(x.project, x.issue)} ${type} ${refOf(y.project, y.issue)}.`);
    }

    case "archive_work_item":
    case "restore_work_item": {
      const found = await findIssue(a, str(p.issue ?? p.issue_id));
      if (typeof found === "string") return text(found);
      const { error } = await db.from("pj_issues")
        .update({ archived_at: action === "archive_work_item" ? new Date().toISOString() : null }).eq("id", found.issue.id);
      if (error) return text(`ERREUR : ${error.message}`);
      return text(`${refOf(found.project, found.issue)} ${action === "archive_work_item" ? "archivé (restaurable)" : "restauré"}.`);
    }

    case "launch_agent": {
      const found = await findIssue(a, str(p.issue ?? p.issue_id));
      if (typeof found === "string") return text(found);
      const ag = await findAgent(a, str(p.agent ?? p.agent_id));
      if (typeof ag === "string") return text(ag);
      return text(await launchAgentOnIssue(
        a, found.project, found.issue, ag,
        str(p.brief).trim(), str(p.acceptance ?? p.acceptance_criteria).trim(), str(p.title).trim(),
      ));
    }

    case "create_page": {
      const name = str(p.name ?? p.title).trim().slice(0, 200);
      if (!name) return text("ERREUR : name est requis.");
      let pjProjectId: string | null = null;
      let dashboardId: string | null = null;
      if (str(p.project)) {
        const project = await findProject(a, str(p.project));
        if (typeof project === "string") return text(project);
        pjProjectId = project.id;
      } else {
        const s = await resolveService(a, str(p.service));
        if (typeof s === "string") return text(s);
        dashboardId = s.id;
      }
      let parentId: string | null = null;
      if (str(p.parent)) {
        const par = await findPage(a, str(p.parent));
        if (typeof par === "string") return text(par);
        parentId = par.id;
      }
      const { data, error } = await db.from("pj_pages").insert({
        pj_project_id: pjProjectId, dashboard_id: dashboardId, parent_id: parentId,
        workspace_id: a.workspaceId, name,
        // L'éditeur relit le markdown quand il n'y a pas de version riche.
        description_html: pageMarkdown(p.content ?? p.body), description_rich: null,
        owned_by: a.userId, created_by: a.userId,
      }).select("id").single();
      if (error || !data) return text(`ERREUR : ${error?.message ?? "création impossible"}`);
      return text(`Page « ${name} » créée ${pjProjectId ? "dans le projet" : "dans le wiki du service"} (page_id: ${(data as { id: string }).id}).`);
    }

    case "update_page": {
      const page = await findPage(a, str(p.page ?? p.page_id));
      if (typeof page === "string") return text(page);
      const patch: Record<string, unknown> = {};
      if (str(p.name).trim()) patch.name = str(p.name).trim().slice(0, 200);
      if (p.content !== undefined || p.body !== undefined) {
        const md = pageMarkdown(p.content ?? p.body);
        patch.description_html = bool(p.append) === true ? [str(page.description_html).trim(), md].filter(Boolean).join("\n\n") : md;
        patch.description_rich = null;
      }
      if (!Object.keys(patch).length) return text("ERREUR : rien à modifier.");
      patch.updated_at = new Date().toISOString();
      const { error } = await db.from("pj_pages").update(patch).eq("id", page.id);
      if (error) return text(`ERREUR : ${error.message}`);
      return text(`Page « ${String(patch.name ?? page.name)} » mise à jour.`);
    }
  }
  return text(`ERREUR : action « ${action} » non gérée.`);
}

/** Une page du suivi (projet ou wiki) par id ou par titre, dans ce projet founderos. */
async function findPage(a: OpsActor, ref: string): Promise<{ id: string; name: string; description_html: string | null } | string> {
  const r = ref.trim();
  if (!r) return "ERREUR : précise la page (titre ou page_id).";
  const [projects, services] = await Promise.all([scopeProjects(a), listServices(a)]);
  const pjIds = projects.map((x) => x.id);
  const dashIds = services.map((s) => s.id);
  const inScope = (row: { pj_project_id: string | null; dashboard_id: string | null }) =>
    (row.pj_project_id && pjIds.includes(row.pj_project_id)) || (row.dashboard_id && dashIds.includes(row.dashboard_id));
  const cols = "id, name, description_html, pj_project_id, dashboard_id";
  if (UUID.test(r)) {
    const { data } = await a.admin.from("pj_pages").select(cols).eq("id", r).maybeSingle();
    const row = data as { id: string; name: string; description_html: string | null; pj_project_id: string | null; dashboard_id: string | null } | null;
    return row && inScope(row) ? row : `ERREUR : page ${r} introuvable.`;
  }
  const { data } = await a.admin.from("pj_pages").select(cols).eq("workspace_id", a.workspaceId)
    .is("archived_at", null).ilike("name", `%${likeSafe(r)}%`).limit(10);
  const rows = ((data ?? []) as Array<{ id: string; name: string; description_html: string | null; pj_project_id: string | null; dashboard_id: string | null }>).filter(inScope);
  const exact = rows.filter((x) => x.name.toLowerCase() === r.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return rows.length
    ? `ERREUR : plusieurs pages correspondent : ${rows.map((x) => `« ${x.name} » (${x.id})`).join(", ")}.`
    : `ERREUR : aucune page « ${r} ».`;
}

/** Miroir de deriveIdentifier (src/features/tracker/model.ts). */
function deriveIdentifier(name: string): string {
  const cleaned = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  const words = cleaned.split(/[^A-Z0-9]+/).filter(Boolean);
  if (!words.length) return "PROJ";
  const code = words.length === 1 ? words[0].slice(0, 5) : words.map((w) => w[0]).join("").slice(0, 5);
  return code.slice(0, 12) || "PROJ";
}

// ── Routage ─────────────────────────────────────────────────────────────────
//
// Dans une room, un message non adressé passe par le routeur, qui choisit entre
// « l'assistant répond », « un spécialiste s'en charge » et « c'est une
// mission ». Une demande d'administration (« crée un agent… », « ajoute Slack
// à Léa », « mets ABC-12 en cours ») n'a qu'un seul bon destinataire :
// l'assistant, le seul qui en a les outils. Laissée au routeur, elle partait
// chez un spécialiste qui ne pouvait rien en faire, ou faisait naître un agent
// nu par le raccourci « new_agents » pendant que l'assistant en créait un
// second, complet. On la reconnaît ici, avant tout appel de modèle.

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const ADMIN_VERB = "(?:cr[ée]{1,2}[rz]?|cr[ée]{1,2}s|ajout\\p{L}*|configur\\p{L}*|param[èe]tr\\p{L}*|branch\\p{L}*|connect\\p{L}*|donn\\p{L}*|retir\\p{L}*|enl[èe]v\\p{L}*|archiv\\p{L}*|renomm\\p{L}*|modifi\\p{L}*|assign\\p{L}*|confi[ae]\\p{L}*|d[ée]coup\\p{L}*|activ\\p{L}*|d[ée]sactiv\\p{L}*|install\\p{L}*|mets|met|mettre|passe[rz]?|set ?up|create|add|configure|assign)";
const ADMIN_OBJECT = "(?:agents?|nouvel agent|skills?|comp[ée]tences?|outils?|tools?|connecteurs?|int[ée]grations?|mcp|prompt|work ?items?|projets?|backlog|labels?|[ée]tiquettes?|sous-t[âa]ches?)";
const ADMIN_RE = new RegExp(`${L}${ADMIN_VERB}${R}[^.?!\\n]{0,60}${L}${ADMIN_OBJECT}${R}`, "iu");
const ISSUE_REF_RE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{0,11})-\d{1,6}(?![A-Za-z0-9])/g;

/** Les préfixes de références de work item cités (ABC-12 → ABC). « GPT-4 » en
 *  est un aussi : c'est l'appelant qui les confronte aux vrais identifiants. */
export function issueRefPrefixes(message: string): string[] {
  return [...new Set([...message.slice(0, 800).matchAll(ISSUE_REF_RE)].map((m) => m[1]))];
}

/** Ce message demande-t-il d'administrer l'espace (agents, suivi de travail) ?
 *  `knownIdentifiers` : les identifiants de projets du suivi, pour qu'une
 *  référence ABC-12 ne compte que si ABC existe. */
export function looksLikeWorkspaceAdmin(message: string, knownIdentifiers: string[] = []): boolean {
  const t = message.slice(0, 800);
  if (ADMIN_RE.test(t)) return true;
  const known = new Set(knownIdentifiers.map((x) => x.toUpperCase()));
  return issueRefPrefixes(t).some((p) => known.has(p));
}

// ── Doctrine ────────────────────────────────────────────────────────────────

/** Ce que l'assistant doit savoir pour s'en servir. Partagé par les deux surfaces. */
/** Le suivi de travail, dit une fois : les deux surfaces l'emploient tel quel. */
export const TRACKER_OPS_DOCTRINE = [
  "SUIVI DE TRAVAIL (manage_projects)",
  "- Trouve d'abord (list_projects, search, get_work_item) ; un item se désigne par sa référence ABC-12.",
  "- Fais-le en peu d'appels : create_work_items pour un backlog, break_down pour découper, avec labels, assignations et dates directement dedans.",
  "- Assigner un agent à un item ne le fait PAS travailler. launch_agent le met au travail tout de suite (ça consomme du budget) et agent_autorun=true l'autorise à démarrer seul : l'un comme l'autre seulement si on te le demande.",
  "- Pour qu'un agent puisse faire avancer les items d'un projet, mets-le dans l'équipe (set_project_agents) et donne-lui l'outil tracker (kind=tracker).",
  "- Pas de suppression : on archive.",
].join("\n");

/** Ce que l'assistant des rooms doit savoir pour s'en servir. */
export const ASSISTANT_OPS_DOCTRINE = [
  "## Tu administres l'espace de travail : tu FAIS, tu ne décris pas",
  "Deux outils : manage_agents (les agents) et manage_projects (le suivi de travail : projets, work items, pages). Une demande en langage naturel devient des appels, pas un mode d'emploi. « Allez dans Réglages… » est une mauvaise réponse quand tu peux le faire toi-même.",
  "",
  "AGENTS (manage_agents)",
  "- Lis avant d'écrire : list ou get. Ne devine jamais un tool_id, une skill ou un serveur MCP.",
  "- Créer : create avec un nom clair, un rôle en une ligne et des instructions opérationnelles (ce qu'il fait, avec quoi, comment il rend compte), et DANS LE MÊME APPEL ce qu'on t'a demandé de lui donner : connectors (slugs), skills (trouvées avec search_skills), tools, mcp_servers.",
  "- Configurer un agent, c'est son prompt système, ses connecteurs, ses skills et ses outils. Modèle, autonomie, sandbox : seulement si on te le demande explicitement.",
  "- Un service pas encore connecté : connect affiche une carte « Connecter » dans la conversation, et l'agent le reçoit automatiquement une fois connecté. Ne renvoie jamais vers l'écran Intégrations.",
  "- Retirer un outil ou archiver un agent : demande d'abord l'accord, puis rappelle avec confirm=true.",
  "",
  TRACKER_OPS_DOCTRINE,
  "",
  "Termine par ce qui a été fait, une ligne par objet, avec les références (ABC-12, nom de l'agent). Pas de récit des appels, pas de long tiret.",
].join("\n");
