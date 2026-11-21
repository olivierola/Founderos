// La passerelle de ressources, à l'exécution (migration 0291).
//
// Un agent qui a au moins un pool est en MODE POOLS : il n'atteint que l'union
// de ses pools, et rien d'autre. Ce module calcule cette union (PoolScope) et
// l'applique à chaque porte par laquelle un agent reçoit ses moyens :
//
//   · ses lignes d'outils (internal_agent_tools)   → applyPoolToToolRows
//   · ses serveurs MCP et leurs outils              → limitMcpServers
//   · ses outils customisés et leurs opérations     → allowsCustomOperation
//   · les actions d'une app Composio                → allowsComposioAction
//   · les actions d'un connecteur maison (0293)     → allowsAppAction
//   · ses compétences et ses collections            → scope.skills / scope.knowledge
//   · les guardrails du pool (ils s'AJOUTENT à ceux de l'espace)
//   · les agents qu'il peut solliciter (A2A)        → allowsPeer, peerAccepts
//   · les workflows qu'il exécute ou dont il reçoit du travail → workflowViolations
//
// Depuis 0310, il n'y a plus de mode granulaire : un agent sans pool a un
// scope VIDE (les outils de base seulement), et ce qu'on lui donne directement
// est versé dans son pool personnel par la base. Seule une base sans 0291
// (table absente) renvoie null, et l'appelant laisse passer. Une panne de
// lecture FERME l'accès : un mode strict qui retomberait en grand ouvert sur
// une erreur ne serait pas strict.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

/** « Toute la source » ou une sélection d'outils. */
export type Grant = Set<string> | "all";

export interface PoolScope {
  agentId: string;
  poolIds: string[];
  poolNames: string[];
  /** Familles d'outils intégrées (types d'internal_agent_tools). */
  builtin: Set<string>;
  /** server_id → outils. */
  mcp: Map<string, Grant>;
  /** toolkit (minuscules) → actions (MAJUSCULES). */
  composio: Map<string, Grant>;
  /** connector_id → noms d'opérations. */
  custom: Map<string, Grant>;
  /** Connecteurs maison (0293) : fournisseur (minuscules) → actions (minuscules). */
  apps: Map<string, Grant>;
  knowledge: Set<string>;
  skills: Set<string>;
  guardrails: Set<string>;
  /** Procédures ET automatisations (la cohérence les traite ensemble). */
  workflows: Set<string>;
  /** Les deux natures, séparées : l'une se lit et se suit, l'autre se lance. */
  procedures: Set<string>;
  automations: Set<string>;
  agents: Set<string>;
}

export interface RegistryItem {
  id: string;
  kind: string;
  source: string;
  source_id: string;
  item_key: string;
  status: string;
  metadata?: Record<string, unknown> | null;
}

/** La forme d'une ligne internal_agent_tools (AgentToolRow). */
export interface ToolRowLike {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  requires_approval: boolean;
}

/** Les familles intégrées qu'un pool suffit à ouvrir : elles marchent sans
 *  configuration. Les autres (db_read, edge_function, connector_action,
 *  vault_connector, custom) exigent aussi la ligne configurée de l'agent. */
export const SELF_SUFFICIENT_BUILTINS = new Set([
  "web_search", "web_fetch", "tracker", "crm", "support", "governance", "leads",
  "soc", "security_scan", "vibe_code", "testing", "simulation",
]);

const BUILTIN_LABELS: Record<string, string> = {
  web_search: "Recherche web", web_fetch: "Lecture de pages web", tracker: "Suivi du travail",
  crm: "CRM", support: "Support", governance: "Gouvernance", leads: "LeadSense", soc: "SOC",
  security_scan: "Scans de sécurité", vibe_code: "Vibe Code", testing: "Tests applicatifs",
  simulation: "Simulations",
};

export function emptyScope(agentId: string, poolIds: string[] = [], poolNames: string[] = []): PoolScope {
  return {
    agentId, poolIds, poolNames,
    builtin: new Set(), mcp: new Map(), composio: new Map(), custom: new Map(), apps: new Map(),
    knowledge: new Set(), skills: new Set(), guardrails: new Set(), workflows: new Set(),
    procedures: new Set(), automations: new Set(), agents: new Set(),
  };
}

function widen(m: Map<string, Grant>, key: string, tool?: string): void {
  const cur = m.get(key);
  if (cur === "all") return;
  if (!tool) { m.set(key, "all"); return; }
  const set = cur ?? new Set<string>();
  set.add(tool);
  m.set(key, set);
}

/** L'union des ressources ACTIVES des pools d'un agent. Une ressource
 *  indisponible ou disparue n'ouvre rien. */
export function scopeFromItems(
  agentId: string,
  pools: Array<{ id: string; name: string }>,
  items: RegistryItem[],
): PoolScope {
  const scope = emptyScope(agentId, pools.map((p) => p.id), pools.map((p) => p.name));
  for (const it of items) {
    if (!it || it.status !== "active") continue;
    const tool = it.kind === "tool" ? it.item_key : undefined;
    switch (it.source) {
      case "mcp": widen(scope.mcp, it.source_id, tool); break;
      case "composio": {
        const tk = String(it.metadata?.toolkit ?? "").toLowerCase();
        if (tk) widen(scope.composio, tk, tool?.toUpperCase());
        break;
      }
      case "custom_connector": widen(scope.custom, it.source_id, tool); break;
      case "app_connector": {
        const provider = String(it.metadata?.provider ?? "").toLowerCase();
        if (provider) widen(scope.apps, provider, tool?.toLowerCase());
        break;
      }
      case "builtin": if (it.item_key) scope.builtin.add(it.item_key); break;
      case "rag": scope.knowledge.add(it.source_id); break;
      case "skill": scope.skills.add(it.source_id); break;
      case "guardrail": scope.guardrails.add(it.source_id); break;
      case "workflow":
        scope.workflows.add(it.source_id);
        (it.kind === "automation" ? scope.automations : scope.procedures).add(it.source_id);
        break;
      // Se contenir soi-même n'ouvre rien : on ne se sollicite pas.
      case "agent": if (it.source_id !== agentId) scope.agents.add(it.source_id); break;
    }
  }
  return scope;
}

// ── Lecture, mémoïsée quelques secondes ─────────────────────────────────────
// Un tick lit les pools par quatre portes (outils, compétences, MCP,
// connecteurs) : une seule lecture les sert toutes.
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { at: number; value: Promise<PoolScope | null> }>();

/** Oublie ce qu'on sait d'un agent (tests, ou après une modification). */
export function forgetPoolScope(agentId?: string): void {
  if (agentId) cache.delete(agentId); else cache.clear();
}

export function loadPoolScope(admin: SupabaseClient, agentId: string): Promise<PoolScope | null> {
  const hit = cache.get(agentId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = readPoolScope(admin, agentId);
  cache.set(agentId, { at: Date.now(), value });
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
  }
  return value;
}

/** Une jointure plusieurs-à-un arrive en objet ; le typage de supabase-js la
 *  voit en tableau. Les deux formes sont acceptées. */
function embedded<T>(v: unknown): T | null {
  if (Array.isArray(v)) return (v[0] ?? null) as T | null;
  return (v ?? null) as T | null;
}

async function readPoolScope(admin: SupabaseClient, agentId: string): Promise<PoolScope | null> {
  const { data: links, error } = await admin.from("agent_resource_pools")
    .select("pool_id, pool:resource_pools(id, name)").eq("agent_id", agentId);
  // Les ressources ne se donnent plus que par les pools (0310) : un agent sans
  // pool n'atteint rien au-delà des outils de base, et une lecture en échec
  // ferme l'accès. Seule une base sans 0291 (la table n'existe pas) garde
  // l'ancien comportement.
  if (error) {
    if (/does not exist|relation .* not found|42P01/i.test(`${error.code ?? ""} ${error.message}`)) return null;
    console.error(`[resource-pools] pools de ${agentId} illisibles : ${error.message} — accès fermé`);
    return emptyScope(agentId);
  }
  if (!links || links.length === 0) return emptyScope(agentId);
  const pools = (links as unknown as Array<{ pool_id: string; pool: unknown }>)
    .map((l) => ({ id: l.pool_id, name: embedded<{ name: string }>(l.pool)?.name ?? l.pool_id.slice(0, 8) }));
  const { data: rows, error: itemsErr } = await admin.from("resource_pool_items")
    .select("registry:resource_registry(id, kind, source, source_id, item_key, status, metadata)")
    .in("pool_id", pools.map((p) => p.id));
  if (itemsErr) {
    console.error(`[resource-pools] lecture des pools de ${agentId} impossible : ${itemsErr.message} — accès fermé`);
    return emptyScope(agentId, pools.map((p) => p.id), pools.map((p) => p.name));
  }
  const items = ((rows ?? []) as unknown as Array<{ registry: unknown }>)
    .map((r) => embedded<RegistryItem>(r.registry)).filter((r): r is RegistryItem => !!r);
  return scopeFromItems(agentId, pools, items);
}

// ── L'inventaire, tel que l'agent le découvre ───────────────────────────────
// Le PoolScope dit ce qui est OUVERT (des identifiants, pour les portes).
// L'inventaire dit ce qui est LÀ, avec de quoi s'en servir : noms,
// descriptions, risque, état, et les pools qui le donnent. Il montre aussi ce
// qui est indisponible : un agent qui ne voit pas qu'un outil de son pool est
// coupé le cherche, ou conclut qu'il n'existe pas.

export interface PoolResource {
  id: string;
  kind: string;
  source: string;
  source_id: string;
  item_key: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  risk: string;
  status: string;
  metadata: Record<string, unknown>;
  /** Les pools qui la donnent (noms). */
  pools: string[];
  /** false : un outil qui vient avec sa source, donnée entière. */
  direct: boolean;
}

export interface PoolInventory {
  pools: Array<{ id: string; name: string; description: string | null }>;
  items: PoolResource[];
  /** Les sources des outils donnés un par un, pour les nommer. */
  parents: Map<string, { name: string; source_id: string; status: string; metadata: Record<string, unknown> }>;
}

const INVENTORY_COLS = "id, kind, source, source_id, item_key, parent_id, name, description, risk, status, metadata";

type RegistryRowFull = Omit<PoolResource, "pools" | "direct" | "metadata"> & { metadata?: Record<string, unknown> | null };

export async function loadPoolInventory(admin: SupabaseClient, scope: PoolScope): Promise<PoolInventory> {
  const parents: PoolInventory["parents"] = new Map();
  if (!scope.poolIds.length) return { pools: [], items: [], parents };
  const [poolsRes, itemsRes] = await Promise.all([
    admin.from("resource_pools").select("id, name, description").in("id", scope.poolIds),
    admin.from("resource_pool_items").select(`pool_id, registry:resource_registry(${INVENTORY_COLS})`).in("pool_id", scope.poolIds),
  ]);
  if (itemsRes.error) throw new Error(`lecture des pools impossible : ${itemsRes.error.message}`);
  const poolRows = ((poolsRes.data ?? []) as Array<{ id: string; name: string; description: string | null }>);
  const nameOf = new Map(poolRows.map((p) => [p.id, p.name]));
  scope.poolIds.forEach((id, i) => { if (!nameOf.has(id)) nameOf.set(id, scope.poolNames[i] ?? id.slice(0, 8)); });

  const byId = new Map<string, PoolResource>();
  for (const r of (itemsRes.data ?? []) as Array<{ pool_id: string; registry: unknown }>) {
    const reg = embedded<RegistryRowFull>(r.registry);
    if (!reg) continue;
    const pool = nameOf.get(r.pool_id) ?? r.pool_id.slice(0, 8);
    const cur = byId.get(reg.id);
    if (cur) {
      if (!cur.pools.includes(pool)) cur.pools.push(pool);
      continue;
    }
    byId.set(reg.id, { ...reg, metadata: reg.metadata ?? {}, pools: [pool], direct: true });
  }

  // Une source donnée entière : ses outils, pour que l'agent les voie un à un.
  // Une famille intégrée n'a pas d'enfants (item_key porte la famille).
  const whole = [...byId.values()].filter((r) => r.kind === "toolset" && r.item_key === "");
  // Un outil donné seul : sa source, pour le nommer (« pods_list » de quel serveur ?).
  const orphanParents = [...new Set([...byId.values()]
    .filter((r) => r.kind === "tool" && r.parent_id && !byId.has(r.parent_id))
    .map((r) => r.parent_id as string))];
  const [kidsRes, parentsRes] = await Promise.all([
    whole.length
      ? admin.from("resource_registry").select(INVENTORY_COLS).in("parent_id", whole.map((w) => w.id)).neq("status", "removed")
      : Promise.resolve({ data: [] as unknown[] }),
    orphanParents.length
      ? admin.from("resource_registry").select("id, name, source_id, status, metadata").in("id", orphanParents)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);
  for (const k of (kidsRes.data ?? []) as RegistryRowFull[]) {
    if (byId.has(k.id)) continue;
    const parent = k.parent_id ? byId.get(k.parent_id) : undefined;
    byId.set(k.id, { ...k, metadata: k.metadata ?? {}, pools: parent ? [...parent.pools] : [], direct: false });
  }
  for (const p of (parentsRes.data ?? []) as Array<{ id: string; name: string; source_id: string; status: string; metadata?: Record<string, unknown> | null }>) {
    parents.set(p.id, { name: p.name, source_id: p.source_id, status: p.status, metadata: p.metadata ?? {} });
  }
  for (const w of whole) parents.set(w.id, { name: w.name, source_id: w.source_id, status: w.status, metadata: w.metadata });

  return {
    pools: scope.poolIds.map((id) => {
      const row = poolRows.find((p) => p.id === id);
      return { id, name: nameOf.get(id) ?? id.slice(0, 8), description: row?.description ?? null };
    }),
    items: [...byId.values()],
    parents,
  };
}

// ── Les portes ──────────────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Les lignes d'outils d'un agent en mode pools.
 *
 * Une ligne survit si le pool couvre ce qu'elle ouvre ; une ligne désactivée
 * est ignorée. Ce que le pool donne et que l'agent n'a pas en ligne est
 * synthétisé (id `pool:…`) : c'est tout l'intérêt de donner en une fois. Une
 * famille qui exige une configuration n'est jamais synthétisée — le pool en
 * fixe seulement la limite.
 */
export function applyPoolToToolRows<T extends ToolRowLike>(rows: T[], scope: PoolScope): ToolRowLike[] {
  const out: ToolRowLike[] = [];
  const seenKinds = new Set<string>();
  const seenToolkits = new Set<string>();
  const seenConnectors = new Set<string>();
  const seenApps = new Set<string>();
  let hasRag = false;
  for (const r of rows) {
    if (!r.enabled) continue;
    const cfg = (r.config ?? {}) as Record<string, unknown>;
    switch (r.kind) {
      case "composio_toolkit": {
        const tk = str(cfg.toolkit).toLowerCase();
        if (!tk || !scope.composio.has(tk) || seenToolkits.has(tk)) continue;
        seenToolkits.add(tk);
        out.push(r);
        break;
      }
      case "connector_action": {
        // Un connecteur maison : l'app elle-même dans un pool (0293), ou, pour
        // un pool d'avant, la famille « connector_action » qui en fixait la
        // limite sur la ligne configurée.
        const provider = str(cfg.provider).toLowerCase();
        if (!provider || seenApps.has(provider) || !(scope.apps.has(provider) || scope.builtin.has("connector_action"))) continue;
        seenApps.add(provider);
        out.push(r);
        break;
      }
      case "custom_connector": {
        const cid = str(cfg.connector_id);
        if (!cid || !scope.custom.has(cid) || seenConnectors.has(cid)) continue;
        seenConnectors.add(cid);
        out.push(r);
        break;
      }
      case "rag_search": {
        if (scope.knowledge.size === 0) continue;
        const ids = strArray(cfg.collection_ids);
        // Une liste vide voulait dire « tout le projet » : en mode pools, c'est
        // « tout ce que le pool donne ».
        const kept = ids.length ? ids.filter((id) => scope.knowledge.has(id)) : [...scope.knowledge];
        if (!kept.length) continue;
        hasRag = true;
        out.push({ ...r, config: { ...cfg, collection_ids: kept } });
        break;
      }
      default: {
        if (!scope.builtin.has(r.kind)) continue;
        seenKinds.add(r.kind);
        out.push(r);
      }
    }
  }
  const synth = (id: string, kind: string, name: string, config: Record<string, unknown>): ToolRowLike =>
    ({ id, kind, name, description: null, config, enabled: true, requires_approval: false });
  for (const k of [...scope.builtin].sort()) {
    if (SELF_SUFFICIENT_BUILTINS.has(k) && !seenKinds.has(k)) out.push(synth(`pool:builtin:${k}`, k, BUILTIN_LABELS[k] ?? k, {}));
  }
  for (const tk of [...scope.composio.keys()].sort()) {
    if (!seenToolkits.has(tk)) out.push(synth(`pool:composio:${tk}`, "composio_toolkit", `Use ${tk}`, { toolkit: tk }));
  }
  for (const cid of [...scope.custom.keys()].sort()) {
    if (!seenConnectors.has(cid)) out.push(synth(`pool:custom:${cid}`, "custom_connector", "Outil customisé", { connector_id: cid }));
  }
  // Un connecteur maison n'a besoin d'aucune configuration sur l'agent : la clé
  // est sur la connexion du projet. Le pool suffit à le donner.
  for (const provider of [...scope.apps.keys()].sort()) {
    if (!seenApps.has(provider)) out.push(synth(`pool:app:${provider}`, "connector_action", `Use ${provider}`, { provider }));
  }
  if (!hasRag && scope.knowledge.size > 0) {
    out.push(synth("pool:rag", "rag_search", "Recherche dans les connaissances", { collection_ids: [...scope.knowledge].sort() }));
  }
  return out;
}

/** Les serveurs MCP du pool, limités aux outils accordés. */
export function limitMcpServers<T extends { id: string; tools: Array<{ name: string }> }>(servers: T[], scope: PoolScope): T[] {
  const out: T[] = [];
  for (const s of servers) {
    const grant = scope.mcp.get(s.id);
    if (!grant) continue;
    out.push(grant === "all" ? s : { ...s, tools: s.tools.filter((t) => grant.has(t.name)) });
  }
  return out;
}

const allows = (grant: Grant | undefined, item: string) => !!grant && (grant === "all" || grant.has(item));

export function allowsComposioAction(scope: PoolScope, toolkit: string, action: string): boolean {
  return allows(scope.composio.get(toolkit.toLowerCase()), action.toUpperCase());
}

/** Les actions accordées d'une app, ou null si toute l'app l'est. */
export function allowedComposioActions(scope: PoolScope, toolkit: string): string[] | null {
  const grant = scope.composio.get(toolkit.toLowerCase());
  if (!grant) return [];
  return grant === "all" ? null : [...grant].sort();
}

/**
 * Les actions d'un connecteur maison que les pools ouvrent : null = toutes,
 * [] = aucune. Un pool d'avant 0293 qui donne la famille « connector_action »
 * ouvre toutes les actions des connecteurs configurés sur l'agent.
 */
export function allowedAppActions(scope: PoolScope, provider: string): string[] | null {
  const grant = scope.apps.get(provider.toLowerCase());
  if (grant) return grant === "all" ? null : [...grant].sort();
  return scope.builtin.has("connector_action") ? null : [];
}

export function allowsAppAction(scope: PoolScope, provider: string, action: string): boolean {
  const only = allowedAppActions(scope, provider);
  return only === null || only.includes(action.toLowerCase());
}

export function allowsCustomOperation(scope: PoolScope, connectorId: string, operation: string): boolean {
  return allows(scope.custom.get(connectorId), operation);
}

/** Les opérations accordées d'un outil customisé, ou null si toutes. */
export function allowedCustomOperations(scope: PoolScope, connectorId: string): Set<string> | null {
  const grant = scope.custom.get(connectorId);
  if (!grant) return new Set();
  return grant === "all" ? null : grant;
}

export function allowsPeer(scope: PoolScope, peerId: string): boolean {
  return scope.agents.has(peerId);
}

/**
 * L'A2A réciproque : un collègue en mode pools qui n'a pas `fromAgentId` dans
 * ses pools ne pourrait ni lui répondre ni lui rendre compte. Un collègue sans
 * pool accepte tout le monde, comme avant.
 */
export async function peerAccepts(admin: SupabaseClient, peerId: string, fromAgentId: string): Promise<boolean> {
  const peer = await loadPoolScope(admin, peerId);
  return !peer || peer.agents.has(fromAgentId);
}

/** Le refus, toujours sur le même modèle : ce qui sort, et quoi faire. */
export function poolRefusal(scope: PoolScope, what: string): string {
  const pools = scope.poolNames.length ? scope.poolNames.map((n) => `« ${n} »`).join(", ") : "aucun";
  return `ERROR: ${what} — hors des ressources de cet agent (pools : ${pools}). ` +
    "Ne contourne pas : fais sans, ou demande à un humain d'ajouter la ressource à l'un de tes pools.";
}

// ── Les workflows ───────────────────────────────────────────────────────────

export interface WorkflowRefs {
  agentIds: string[];
  mcp: Array<{ server_id: string; tools: string[] }>;
  apps: Array<{ provider: string; action: string }>;
  collectionIds: string[];
}

/** Ce qu'un graphe de workflow fait intervenir. Même lecture que la fonction
 *  SQL resource_workflow_refs (0291) — les deux doivent rester d'accord. */
export function workflowRefsOf(blocks: unknown): WorkflowRefs {
  const nodes = Array.isArray((blocks as { nodes?: unknown })?.nodes) ? (blocks as { nodes: unknown[] }).nodes : [];
  const agentIds = new Set<string>();
  const mcp: WorkflowRefs["mcp"] = [];
  const apps = new Map<string, { provider: string; action: string }>();
  const collectionIds = new Set<string>();
  for (const raw of nodes) {
    const n = (raw ?? {}) as { type?: unknown; data?: Record<string, unknown> };
    const d = (n.data ?? {}) as Record<string, unknown>;
    if (n.type === "step" && str(d.agent_id)) agentIds.add(str(d.agent_id));
    if (n.type === "handoff") for (const a of strArray(d.agent_ids)) if (a) agentIds.add(a);
    if (n.type === "tool") {
      if (str(d.tool) === "mcp" && Array.isArray(d.mcp)) {
        for (const m of d.mcp as Array<Record<string, unknown>>) {
          const sid = str(m?.server_id);
          if (sid) mcp.push({ server_id: sid, tools: strArray(m.tools) });
        }
      } else if (str(d.provider)) {
        const provider = str(d.provider).toLowerCase();
        const action = str(d.action).toUpperCase();
        apps.set(`${provider}:${action}`, { provider, action });
      }
    }
    if (Array.isArray(d.refs)) {
      for (const r of d.refs as Array<Record<string, unknown>>) {
        if (r?.kind === "collection" && str(r.id)) collectionIds.add(str(r.id));
      }
    }
  }
  return { agentIds: [...agentIds].sort(), mcp, apps: [...apps.values()], collectionIds: [...collectionIds].sort() };
}

/**
 * Ce qu'un workflow ferait sortir des pools de l'agent qui l'exécute (ou qui en
 * reçoit le travail). Vide = rien. `names` traduit les identifiants pour le
 * message, quand l'appelant les connaît.
 */
export function workflowViolations(
  scope: PoolScope,
  workflow: { id: string; name: string },
  refs: WorkflowRefs,
  names: { agents?: Map<string, string>; servers?: Map<string, string> } = {},
): string[] {
  const out: string[] = [];
  if (!scope.workflows.has(workflow.id)) {
    out.push(`le workflow « ${workflow.name} » n'est pas dans ses pools`);
    return out;
  }
  for (const a of refs.agentIds) {
    if (a !== scope.agentId && !scope.agents.has(a)) out.push(`il fait intervenir « ${names.agents?.get(a) ?? a.slice(0, 8)} », absent de ses pools`);
  }
  for (const m of refs.mcp) {
    const grant = scope.mcp.get(m.server_id);
    const label = names.servers?.get(m.server_id) ?? m.server_id.slice(0, 8);
    if (!grant) out.push(`il utilise le serveur MCP « ${label} », absent de ses pools`);
    else if (grant !== "all") {
      if (!m.tools.length) out.push(`il utilise tout le serveur MCP « ${label} », dont ses pools n'ouvrent qu'une partie`);
      else {
        const missing = m.tools.filter((t) => !grant.has(t));
        if (missing.length) out.push(`il utilise ${missing.join(", ")} sur « ${label} », hors de ses pools`);
      }
    }
  }
  // Une app d'un bloc Outil est branchée via Composio ou en connecteur maison
  // (automation-engine choisit la porte) : l'une ou l'autre dans les pools
  // suffit. Ici, pas de repli sur la famille « connector_action » : un
  // workflow nomme une app précise, le pool doit la nommer aussi.
  for (const a of refs.apps) {
    const app = scope.apps.get(a.provider);
    if (!scope.composio.has(a.provider) && !app) out.push(`il utilise l'app « ${a.provider} », absente de ses pools`);
    else if (a.action && !allowsComposioAction(scope, a.provider, a.action) && !allows(app, a.action.toLowerCase())) {
      out.push(`il utilise ${a.action} (${a.provider}), hors de ses pools`);
    }
  }
  for (const c of refs.collectionIds) {
    if (!scope.knowledge.has(c)) out.push(`il consulte une collection (${c.slice(0, 8)}) absente de ses pools`);
  }
  return out;
}

/**
 * L'erreur qu'un workflow lève face aux pools d'un agent, ou null.
 *
 *   · `execute` — l'agent EXÉCUTE le workflow (l'assistant d'un service et sa
 *     procédure) : le workflow doit être dans ses pools, et tout ce qu'il fait
 *     intervenir aussi.
 *   · `receive` — l'agent REÇOIT du travail du workflow (une passation) : le
 *     workflow doit être dans ses pools ; le reste ne le concerne pas.
 */
export async function workflowPoolError(
  admin: SupabaseClient,
  agent: { id: string; name: string },
  wf: { id: string; name: string; blocks: unknown },
  mode: "execute" | "receive",
): Promise<string | null> {
  const scope = await loadPoolScope(admin, agent.id);
  if (!scope) return null;
  if (mode === "receive") {
    return scope.workflows.has(wf.id) ? null
      : `« ${agent.name} » est en mode pools et le workflow « ${wf.name} » n'est pas dans ses pools : il ne lui confie pas de travail. Ajoutez-le à l'un de ses pools.`;
  }
  const v = await namedWorkflowViolations(admin, scope, wf);
  return v.length
    ? `« ${agent.name} » est en mode pools : ${v.join(" ; ")}. Ajoutez ces ressources à l'un de ses pools, ou retirez-les du workflow.`
    : null;
}

/** workflowViolations, avec les noms des agents et des serveurs lus en base :
 *  le message parle de « Léa » et d'« openshift-prd », pas d'identifiants. */
export async function namedWorkflowViolations(
  admin: SupabaseClient,
  scope: PoolScope,
  wf: { id: string; name: string; blocks: unknown },
): Promise<string[]> {
  const refs = workflowRefsOf(wf.blocks);
  const agents = new Map<string, string>();
  const servers = new Map<string, string>();
  await Promise.all([
    refs.agentIds.length
      ? admin.from("internal_agents").select("id, name").in("id", refs.agentIds).then(({ data }) => {
        for (const r of (data ?? []) as Array<{ id: string; name: string }>) agents.set(r.id, r.name);
      })
      : null,
    refs.mcp.length
      ? admin.from("mcp_servers").select("id, name").in("id", refs.mcp.map((m) => m.server_id)).then(({ data }) => {
        for (const r of (data ?? []) as Array<{ id: string; name: string }>) servers.set(r.id, r.name);
      })
      : null,
  ]);
  return workflowViolations(scope, wf, refs, { agents, servers });
}
