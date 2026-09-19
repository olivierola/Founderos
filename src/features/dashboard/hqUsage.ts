// HQ usage analytics — the three dimensions the run/approval tables alone can't
// answer: WHICH TOOLS the workforce actually uses, WHICH KNOWLEDGE it reaches
// for, and HOW EACH SERVICE performs.
//
// Everything is derived from data the runtime already writes:
//   · tool usage      internal_agent_run_events (kind tool_call / tool_result)
//   · knowledge       rag_collections + rag_sources + rag_collection_agents,
//                     crossed with the agents' rag_search grants and their
//                     search_knowledge calls
//   · services        service_dashboards × internal_agents.service_dashboard_id
import { supabase } from "@/lib/supabase";
import {
  runDurationSec, type HqAgent, type HqRun, type HqDeliverable, type HqApproval,
} from "./hqStats";

const pct = (a: number, b: number): number | null => (b === 0 ? null : Math.round((a / b) * 100));

// ══════════════════════════════════════════════════════════════ 1. tool usage

export interface HqToolEvent {
  run_id: string | null;
  agent_id: string;
  kind: "tool_call" | "tool_result";
  tool: string;
  /** Only meaningful on tool_result rows. */
  ok: boolean | null;
  created_at: string;
}

/** Lean projection: the previews a tool_result carries run to 1 000 chars each,
 *  and we only ever need the tool name + the ok flag. Falls back to the whole
 *  payload if the deployment's PostgREST rejects the JSON-path select. */
export async function fetchHqToolEvents(agentIds: string[], limit = 2500): Promise<HqToolEvent[]> {
  if (agentIds.length === 0) return [];
  const base = () => supabase
    .from("internal_agent_run_events")
    .select("run_id, agent_id, kind, created_at, tool:payload->>tool, ok:payload->ok")
    .in("agent_id", agentIds)
    .in("kind", ["tool_call", "tool_result"])
    .order("created_at", { ascending: false })
    .limit(limit);

  const { data, error } = await base();
  if (!error) return normaliseToolRows(data ?? []);

  const { data: raw } = await supabase
    .from("internal_agent_run_events")
    .select("run_id, agent_id, kind, created_at, payload")
    .in("agent_id", agentIds)
    .in("kind", ["tool_call", "tool_result"])
    .order("created_at", { ascending: false })
    .limit(limit);
  return normaliseToolRows((raw ?? []).map((r) => {
    const p = (r as { payload?: Record<string, unknown> }).payload ?? {};
    return { ...(r as object), tool: p.tool, ok: p.ok };
  }));
}

function normaliseToolRows(rows: unknown[]): HqToolEvent[] {
  const out: HqToolEvent[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const tool = typeof r.tool === "string" ? r.tool : "";
    if (!tool) continue; // events without a tool name carry nothing to count
    out.push({
      run_id: (r.run_id as string) ?? null,
      agent_id: String(r.agent_id ?? ""),
      kind: r.kind === "tool_result" ? "tool_result" : "tool_call",
      tool,
      ok: typeof r.ok === "boolean" ? r.ok : null,
      created_at: String(r.created_at ?? ""),
    });
  }
  return out;
}

/** Knowledge searches with their answer, used for the hit-rate. Small on
 *  purpose — it is the only place a 1 000-char preview is worth fetching. */
export async function fetchKnowledgeProbes(agentIds: string[], limit = 300): Promise<Array<{
  agent_id: string; created_at: string; hit: boolean;
}>> {
  if (agentIds.length === 0) return [];
  const { data, error } = await supabase
    .from("internal_agent_run_events")
    .select("agent_id, created_at, preview:payload->>preview")
    .in("agent_id", agentIds)
    .eq("kind", "tool_result")
    .filter("payload->>tool", "eq", "search_knowledge")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []).map((r) => {
    const preview = String((r as { preview?: string | null }).preview ?? "");
    return {
      agent_id: String((r as { agent_id: string }).agent_id),
      created_at: String((r as { created_at: string }).created_at),
      // searchKnowledge() answers this exact sentence when nothing matched.
      hit: preview.length > 0 && !preview.startsWith("No matching knowledge") && !preview.startsWith("ERROR"),
    };
  });
}

// ── Families ────────────────────────────────────────────────────────────────
// A flat list of 60+ tool names says nothing at a glance; grouped by what the
// tool is FOR, the same data reads as a capability profile of the workforce.
export type ToolFamilyKey =
  | "knowledge" | "web" | "data" | "delivery" | "exec" | "team" | "comm" | "security" | "integration";

export const TOOL_FAMILIES: { key: ToolFamilyKey; label: string }[] = [
  { key: "knowledge", label: "Connaissance & mémoire" },
  { key: "web", label: "Web & recherche" },
  { key: "data", label: "Données & CRM" },
  { key: "delivery", label: "Livrables" },
  { key: "exec", label: "Exécution & code" },
  { key: "team", label: "Orchestration" },
  { key: "comm", label: "Communication" },
  { key: "security", label: "Sécurité & tests" },
  { key: "integration", label: "Intégrations" },
];

const FAMILY_OF: Record<string, ToolFamilyKey> = {
  search_knowledge: "knowledge", search_memory: "knowledge", save_memory: "knowledge",
  team_memory: "knowledge", search_past_work: "knowledge", search_history: "knowledge",
  search_context: "knowledge", read_skill_file: "knowledge", use_skill: "knowledge",

  web_search: "web", deep_research: "web", read_url: "web", browse_web: "web",
  http_get: "web", http_request: "web", download_file: "web",

  query_table: "data", crm: "data", list_assets: "data",

  create_deliverable: "delivery", create_artifact: "delivery", update_artifact: "delivery",
  read_artifact: "delivery", list_artifacts: "delivery", report_section: "delivery",

  shell_exec: "exec", python_exec: "exec", nodejs_exec: "exec", jupyter_exec: "exec",
  file_read: "exec", file_write: "exec", file_edit: "exec", file_search: "exec",
  manage_files: "exec", list_files: "exec", list_processes: "exec", process_logs: "exec",
  process_stop: "exec", run_background: "exec", sandbox_browser: "exec", sandbox_env: "exec",
  machine_info: "exec", vibe_code: "exec",

  create_agent: "team", create_mission: "team", create_task: "team", delegate_mission: "team",
  move_mission: "team", list_missions: "team", list_team_agents: "team",
  spawn_parallel_agents: "team", propose_mission: "team", update_todos: "team",
  load_toolset: "team", need_tools: "team",

  say: "comm", ask_user: "comm", render_ui: "comm", send_email: "comm",
  send_message_to_agent: "comm",
  // Guider quelqu'un dans son propre écran est une conversation, pas une
  // navigation : ce que l'agent y produit est une phrase, pas une requête.
  guide_user: "comm", training: "comm",

  security_scan: "security", pentest_scope: "security", testing: "security", simulation: "security",

  list_connectors: "integration",
};

export function toolFamily(tool: string): ToolFamilyKey {
  const known = FAMILY_OF[tool];
  if (known) return known;
  if (tool.startsWith("mcp_")) return "integration";
  if (tool.startsWith("runner_")) return "web";
  if (tool.startsWith("sandbox_")) return "exec";
  return "integration"; // connector / composio / edge-function / custom tools
}

export const familyLabel = (key: ToolFamilyKey): string =>
  TOOL_FAMILIES.find((f) => f.key === key)?.label ?? key;

export interface ToolStat {
  tool: string;
  family: ToolFamilyKey;
  calls: number;
  ok: number;
  errors: number;
  /** null while no result was observed for this tool. */
  errorRate: number | null;
  agents: number;
  runs: number;
  lastUsedAt: string | null;
}

export interface ToolUsage {
  calls: number;
  ok: number;
  errors: number;
  errorRate: number | null;
  distinctTools: number;
  /** Tool calls per run that used at least one tool. */
  perRun: number | null;
  byTool: ToolStat[];
  byFamily: { key: ToolFamilyKey; label: string; calls: number; errors: number; tools: number }[];
  byAgent: { agentId: string; calls: number; errors: number; distinct: number; topTool: string | null }[];
  /** agentId × tool call counts — the heat-map cells. */
  matrix: Map<string, Map<string, number>>;
}

export function computeToolUsage(events: HqToolEvent[]): ToolUsage {
  const byTool = new Map<string, {
    calls: number; ok: number; errors: number; agents: Set<string>; runs: Set<string>; last: string | null;
  }>();
  const byAgent = new Map<string, { calls: number; errors: number; tools: Map<string, number> }>();
  const matrix = new Map<string, Map<string, number>>();
  const runsWithTools = new Set<string>();
  let calls = 0, ok = 0, errors = 0;

  for (const e of events) {
    const t = byTool.get(e.tool) ?? { calls: 0, ok: 0, errors: 0, agents: new Set<string>(), runs: new Set<string>(), last: null };
    t.agents.add(e.agent_id);
    if (e.run_id) t.runs.add(e.run_id);
    if (!t.last || e.created_at > t.last) t.last = e.created_at;

    const a = byAgent.get(e.agent_id) ?? { calls: 0, errors: 0, tools: new Map<string, number>() };

    if (e.kind === "tool_call") {
      t.calls++; calls++;
      a.calls++;
      a.tools.set(e.tool, (a.tools.get(e.tool) ?? 0) + 1);
      const row = matrix.get(e.agent_id) ?? new Map<string, number>();
      row.set(e.tool, (row.get(e.tool) ?? 0) + 1);
      matrix.set(e.agent_id, row);
      if (e.run_id) runsWithTools.add(e.run_id);
    } else if (e.ok === false) {
      t.errors++; errors++; a.errors++;
    } else if (e.ok === true) {
      t.ok++; ok++;
    }

    byTool.set(e.tool, t);
    byAgent.set(e.agent_id, a);
  }

  const tools: ToolStat[] = [...byTool.entries()].map(([tool, v]) => ({
    tool,
    family: toolFamily(tool),
    calls: v.calls,
    ok: v.ok,
    errors: v.errors,
    errorRate: v.ok + v.errors === 0 ? null : Math.round((v.errors / (v.ok + v.errors)) * 100),
    agents: v.agents.size,
    runs: v.runs.size,
    lastUsedAt: v.last,
  })).sort((x, y) => y.calls - x.calls || y.errors - x.errors);

  const famMap = new Map<ToolFamilyKey, { calls: number; errors: number; tools: number }>();
  for (const t of tools) {
    const f = famMap.get(t.family) ?? { calls: 0, errors: 0, tools: 0 };
    f.calls += t.calls; f.errors += t.errors; f.tools++;
    famMap.set(t.family, f);
  }

  return {
    calls,
    ok,
    errors,
    errorRate: ok + errors === 0 ? null : Math.round((errors / (ok + errors)) * 100),
    distinctTools: tools.length,
    perRun: runsWithTools.size ? +(calls / runsWithTools.size).toFixed(1) : null,
    byTool: tools,
    // Keep the declared family order (it is also the palette-slot order).
    byFamily: TOOL_FAMILIES
      .map((f) => ({ key: f.key, label: f.label, ...(famMap.get(f.key) ?? { calls: 0, errors: 0, tools: 0 }) }))
      .filter((f) => f.calls > 0 || f.errors > 0),
    byAgent: [...byAgent.entries()].map(([agentId, v]) => ({
      agentId,
      calls: v.calls,
      errors: v.errors,
      distinct: v.tools.size,
      topTool: [...v.tools.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    })).sort((a, b) => b.calls - a.calls),
    matrix,
  };
}

// ═════════════════════════════════════════════════════════════ 2. connaissance

export interface HqCollection {
  id: string; name: string; description: string | null; enabled: boolean; created_at: string;
}
export interface HqCollectionSource {
  id: string; collection_id: string | null; type: string; title: string;
  status: string; chunk_count: number | null; created_at: string;
}
export interface HqCollectionLink { collection_id: string; agent_kind: string; agent_id: string }
/** An internal agent's rag_search grant: which collections it may search. */
export interface HqRagGrant { agent_id: string; enabled: boolean; collectionIds: string[] }

export async function fetchHqCollections(projectId: string): Promise<HqCollection[]> {
  const { data } = await supabase
    .from("rag_collections")
    .select("id, name, description, enabled, created_at")
    .eq("project_id", projectId).order("created_at", { ascending: false });
  return (data ?? []) as HqCollection[];
}

export async function fetchHqCollectionSources(projectId: string, limit = 800): Promise<HqCollectionSource[]> {
  const { data } = await supabase
    .from("rag_sources")
    .select("id, collection_id, type, title, status, chunk_count, created_at")
    .eq("project_id", projectId).order("created_at", { ascending: false }).limit(limit);
  return (data ?? []) as HqCollectionSource[];
}

export async function fetchHqCollectionLinks(projectId: string): Promise<HqCollectionLink[]> {
  const { data } = await supabase
    .from("rag_collection_agents")
    .select("collection_id, agent_kind, agent_id")
    .eq("project_id", projectId);
  return (data ?? []) as HqCollectionLink[];
}

/** rag_search rows of the given agents — the grant that decides which
 *  collections each agent actually searches at runtime. */
export async function fetchHqRagGrants(agentIds: string[]): Promise<HqRagGrant[]> {
  if (agentIds.length === 0) return [];
  const { data } = await supabase
    .from("internal_agent_tools")
    .select("agent_id, enabled, config")
    .in("agent_id", agentIds).eq("kind", "rag_search");
  return (data ?? []).map((r) => {
    const cfg = (r as { config?: Record<string, unknown> }).config ?? {};
    const ids = Array.isArray(cfg.collection_ids) ? cfg.collection_ids.map(String) : [];
    return {
      agent_id: String((r as { agent_id: string }).agent_id),
      enabled: (r as { enabled?: boolean }).enabled !== false,
      collectionIds: ids,
    };
  });
}

export interface CollectionStat {
  collection: HqCollection;
  sources: number;
  ready: number;
  pending: number;
  failed: number;
  chunks: number;
  /** Internal agents whose rag_search grant names this collection. */
  agentIds: string[];
  /** Rows in rag_collection_agents (public RAG agents included). */
  linkedAgents: number;
  /** Searches run by the agents connected to it, over the period. Attributed
   *  through the grant — the runtime does not log which collection answered. */
  searches: number;
  lastIndexedAt: string | null;
}

export interface KnowledgeStats {
  collections: CollectionStat[];
  totalCollections: number;
  activeCollections: number;
  totalSources: number;
  totalChunks: number;
  failedSources: number;
  pendingSources: number;
  /** search_knowledge calls over the period. */
  searches: number;
  hits: number;
  misses: number;
  hitRate: number | null;
  /** Agents holding an enabled rag_search grant ÷ agents. */
  connectedAgents: number;
  coverage: number | null;
  /** Collections nobody is connected to — indexed for nothing. */
  orphanCollections: number;
  /** Agents that can search but are wired to no collection (project-wide fallback). */
  unscopedAgents: number;
  byAgent: { agentId: string; searches: number; collections: number }[];
}

export function computeKnowledge(
  collections: HqCollection[],
  sources: HqCollectionSource[],
  links: HqCollectionLink[],
  grants: HqRagGrant[],
  agents: HqAgent[],
  toolEvents: HqToolEvent[],
  probes: Array<{ agent_id: string; hit: boolean }>,
): KnowledgeStats {
  const searchesByAgent = new Map<string, number>();
  for (const e of toolEvents) {
    if (e.kind !== "tool_call" || e.tool !== "search_knowledge") continue;
    searchesByAgent.set(e.agent_id, (searchesByAgent.get(e.agent_id) ?? 0) + 1);
  }
  const searches = [...searchesByAgent.values()].reduce((s, n) => s + n, 0);

  // `agents` is the LIVE roster: an archived agent still owns rag_search rows,
  // and counting them would show access nobody has and a coverage above 100%.
  const live = new Set(agents.map((a) => a.id));
  const grantsByCollection = new Map<string, string[]>();
  for (const g of grants) {
    if (!g.enabled || !live.has(g.agent_id)) continue;
    for (const id of g.collectionIds) {
      const arr = grantsByCollection.get(id) ?? [];
      if (!arr.includes(g.agent_id)) arr.push(g.agent_id);
      grantsByCollection.set(id, arr);
    }
  }

  const stats: CollectionStat[] = collections.map((c) => {
    const mine = sources.filter((s) => s.collection_id === c.id);
    const agentIds = grantsByCollection.get(c.id) ?? [];
    return {
      collection: c,
      sources: mine.length,
      ready: mine.filter((s) => s.status === "ready").length,
      pending: mine.filter((s) => s.status === "pending" || s.status === "processing").length,
      failed: mine.filter((s) => s.status === "failed").length,
      chunks: mine.reduce((s, x) => s + (Number(x.chunk_count) || 0), 0),
      agentIds,
      linkedAgents: links.filter((l) => l.collection_id === c.id).length,
      searches: agentIds.reduce((s, id) => s + (searchesByAgent.get(id) ?? 0), 0),
      lastIndexedAt: mine.reduce<string | null>((acc, s) => (s.created_at > (acc ?? "") ? s.created_at : acc), null),
    };
  }).sort((a, b) => b.searches - a.searches || b.chunks - a.chunks);

  const hits = probes.filter((p) => p.hit).length;
  const misses = probes.length - hits;
  const enabledGrants = grants.filter((g) => g.enabled && live.has(g.agent_id));

  return {
    collections: stats,
    totalCollections: collections.length,
    activeCollections: collections.filter((c) => c.enabled).length,
    totalSources: sources.length,
    totalChunks: sources.reduce((s, x) => s + (Number(x.chunk_count) || 0), 0),
    failedSources: sources.filter((s) => s.status === "failed").length,
    pendingSources: sources.filter((s) => s.status === "pending" || s.status === "processing").length,
    searches,
    hits,
    misses,
    hitRate: probes.length ? Math.round((hits / probes.length) * 100) : null,
    connectedAgents: enabledGrants.length,
    coverage: pct(enabledGrants.length, live.size),
    orphanCollections: stats.filter((s) => s.agentIds.length === 0 && s.linkedAgents === 0).length,
    unscopedAgents: enabledGrants.filter((g) => g.collectionIds.length === 0).length,
    byAgent: [...searchesByAgent.entries()]
      .map(([agentId, n]) => ({
        agentId,
        searches: n,
        collections: grants.find((g) => g.agent_id === agentId)?.collectionIds.length ?? 0,
      }))
      .sort((a, b) => b.searches - a.searches),
  };
}

// ═══════════════════════════════════════════════════════════════ 3. services

export interface HqService {
  id: string; name: string; icon: string | null; color: string; position: number;
}

export async function fetchHqServices(projectId: string): Promise<HqService[]> {
  const { data } = await supabase
    .from("service_dashboards")
    .select("id, name, icon, color, position")
    .eq("project_id", projectId).order("position", { ascending: true });
  return (data ?? []) as HqService[];
}

export interface ServiceStat {
  /** null = the "no service" bucket (agents created outside a dashboard). */
  service: HqService | null;
  key: string;
  name: string;
  agents: number;
  activeAgents: number;
  runs: number;
  succeeded: number;
  failed: number;
  running: number;
  successRate: number | null;
  cost: number;
  tokens: number;
  actions: number;
  avgDurationSec: number | null;
  deliverables: number;
  pendingApprovals: number;
  toolCalls: number;
  toolErrors: number;
  knowledgeSearches: number;
  topAgent: { id: string; name: string; runs: number } | null;
  lastActivityAt: string | null;
}

export function computeServices(
  services: HqService[],
  agents: HqAgent[],
  runs: HqRun[],
  deliverables: HqDeliverable[],
  approvals: HqApproval[],
  toolEvents: HqToolEvent[],
): ServiceStat[] {
  const serviceOfAgent = new Map(agents.map((a) => [a.id, a.service_dashboard_id ?? ""]));
  const groups = new Map<string, ServiceStat>();

  const blank = (key: string, service: HqService | null): ServiceStat => ({
    service, key, name: service?.name ?? "Sans service",
    agents: 0, activeAgents: 0, runs: 0, succeeded: 0, failed: 0, running: 0, successRate: null,
    cost: 0, tokens: 0, actions: 0, avgDurationSec: null, deliverables: 0, pendingApprovals: 0,
    toolCalls: 0, toolErrors: 0, knowledgeSearches: 0, topAgent: null, lastActivityAt: null,
  });

  for (const s of services) groups.set(s.id, blank(s.id, s));
  const bucket = (agentId: string): ServiceStat | null => {
    const key = serviceOfAgent.get(agentId);
    if (key === undefined) return null; // run of an agent outside this project scope
    let g = groups.get(key);
    if (!g) { g = blank(key, null); groups.set(key, g); }
    return g;
  };

  const runsByAgent = new Map<string, number>();
  const durationsByKey = new Map<string, number[]>();

  for (const a of agents) {
    if (a.is_archived) continue;
    const g = bucket(a.id);
    if (!g) continue;
    g.agents++;
  }

  for (const r of runs) {
    const g = bucket(r.agent_id);
    if (!g) continue;
    g.runs++;
    if (r.status === "succeeded") g.succeeded++;
    else if (r.status === "failed") g.failed++;
    else if (r.status === "running" || r.status === "queued") g.running++;
    g.cost += Number(r.cost_usd) || 0;
    g.tokens += (Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0);
    g.actions += Number(r.action_count) || 0;
    if (!g.lastActivityAt || r.created_at > g.lastActivityAt) g.lastActivityAt = r.created_at;
    const d = runDurationSec(r);
    if (d != null) {
      const arr = durationsByKey.get(g.key) ?? [];
      arr.push(d);
      durationsByKey.set(g.key, arr);
    }
    runsByAgent.set(r.agent_id, (runsByAgent.get(r.agent_id) ?? 0) + 1);
  }

  for (const d of deliverables) { const g = bucket(d.agent_id); if (g) g.deliverables++; }
  for (const ap of approvals) { if (ap.status !== "pending") continue; const g = bucket(ap.agent_id); if (g) g.pendingApprovals++; }
  for (const e of toolEvents) {
    const g = bucket(e.agent_id);
    if (!g) continue;
    if (e.kind === "tool_call") {
      g.toolCalls++;
      if (e.tool === "search_knowledge") g.knowledgeSearches++;
    } else if (e.ok === false) g.toolErrors++;
  }

  for (const a of agents) {
    const n = runsByAgent.get(a.id) ?? 0;
    if (n === 0) continue;
    const g = bucket(a.id);
    if (!g) continue;
    g.activeAgents++;
    if (!g.topAgent || n > g.topAgent.runs) g.topAgent = { id: a.id, name: a.name, runs: n };
  }

  for (const g of groups.values()) {
    const ended = g.succeeded + g.failed;
    g.successRate = pct(g.succeeded, ended);
    const durs = durationsByKey.get(g.key) ?? [];
    g.avgDurationSec = durs.length ? Math.round(durs.reduce((s, d) => s + d, 0) / durs.length) : null;
  }

  // Services with no agent at all sink to the bottom — they are noise up top.
  return [...groups.values()].sort((a, b) => b.runs - a.runs || b.agents - a.agents);
}
