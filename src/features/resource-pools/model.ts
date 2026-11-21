// La passerelle de ressources (migration 0291) côté interface : le registre,
// les pools, leur attribution aux agents, et la cohérence.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";

export type RegistryKind = "toolset" | "tool" | "knowledge" | "skill" | "guardrail" | "automation" | "procedure" | "agent";
export type RegistrySource = "mcp" | "composio" | "app_connector" | "custom_connector" | "builtin" | "rag" | "skill" | "guardrail" | "workflow" | "agent";

export interface RegistryItem {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  service_dashboard_id: string | null;
  kind: RegistryKind;
  source: RegistrySource;
  source_id: string;
  item_key: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  risk: "read" | "write" | "destructive" | "unknown";
  status: "active" | "unavailable" | "removed";
  metadata: Record<string, unknown>;
  synced_at: string;
}

export interface Pool {
  id: string;
  workspace_id: string;
  project_id: string;
  service_dashboard_id: string | null;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  items: Array<{ registry_id: string }>;
  agents: Array<{ agent_id: string }>;
}

export interface Issue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  pool_id: string | null;
  registry_id: string | null;
  agent_id: string | null;
}

export interface PoolAgent {
  id: string;
  name: string;
  service_dashboard_id: string | null;
  avatar_url: string | null;
  is_orchestrator: boolean | null;
}

/** Les familles de ressources, dans l'ordre où on les présente. */
export type Family = "tools" | "knowledge" | "skills" | "guardrails" | "workflows" | "agents";
export const FAMILIES: Array<{ key: Family; label: string; hint: string }> = [
  { key: "tools", label: "Outils", hint: "Serveurs MCP, apps Composio, connecteurs, outils customisés, capacités intégrées — une source entière ou certains de ses outils et actions." },
  { key: "knowledge", label: "Connaissances", hint: "Les collections RAG que l'agent peut interroger." },
  { key: "skills", label: "Compétences", hint: "Les savoir-faire chargés à la demande." },
  { key: "guardrails", label: "Guardrails", hint: "Des règles qui s'appliquent EN PLUS de celles de l'espace — un pool n'en retire jamais." },
  { key: "workflows", label: "Workflows", hint: "Les procédures et automatisations que l'agent exécute ou dont il reçoit du travail." },
  { key: "agents", label: "Agents (A2A)", hint: "Les collègues que l'agent peut solliciter. Entre agents en mode pools, l'accès doit être réciproque." },
];

export function familyOf(r: Pick<RegistryItem, "kind">): Family {
  switch (r.kind) {
    case "toolset": case "tool": return "tools";
    case "knowledge": return "knowledge";
    case "skill": return "skills";
    case "guardrail": return "guardrails";
    case "automation": case "procedure": return "workflows";
    case "agent": return "agents";
  }
}

export const SOURCE_LABEL: Record<RegistrySource, string> = {
  mcp: "Serveur MCP", composio: "App", app_connector: "Connecteur", custom_connector: "Outil customisé", builtin: "Capacité intégrée",
  rag: "Collection", skill: "Compétence", guardrail: "Guardrail", workflow: "Workflow", agent: "Agent",
};

export function kindLabel(r: Pick<RegistryItem, "kind" | "source">): string {
  if (r.kind === "tool") return "Outil";
  if (r.kind === "procedure") return "Procédure";
  if (r.kind === "automation") return "Automatisation";
  return SOURCE_LABEL[r.source];
}

/** Ce qu'une ressource réservée à un service peut rejoindre. Un agent et un
 *  workflow traversent les services (même règle que le trigger de 0291). */
export function fitsPool(r: RegistryItem, pool: Pick<Pool, "service_dashboard_id">): boolean {
  if (r.kind === "agent" || r.kind === "automation" || r.kind === "procedure") return true;
  return !r.service_dashboard_id || r.service_dashboard_id === pool.service_dashboard_id;
}

/** Le message d'une exception de 0291, sans son code technique en tête. */
export function cleanDbError(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  return msg.replace(/^resource_[a-z_]+:\s*/i, "");
}

export const qk = {
  registry: (projectId: string | null) => ["resource_registry", projectId] as const,
  pools: (projectId: string | null) => ["resource_pools", projectId] as const,
  poolIssues: (poolId: string) => ["resource_pool_issues", poolId] as const,
  agentIssues: (agentId: string) => ["agent_resource_issues", agentId] as const,
  report: (projectId: string | null) => ["resource_coherence_report", projectId] as const,
  agents: (projectId: string | null) => ["resource_pool_agents", projectId] as const,
};

// ── Lectures ────────────────────────────────────────────────────────────────

const REGISTRY_PAGE_SIZE = 500;

export function useRegistry(projectId: string | null) {
  return useQuery({
    queryKey: qk.registry(projectId),
    enabled: !!projectId,
    queryFn: async () => {
      const rows: RegistryItem[] = [];
      for (let from = 0; ; from += REGISTRY_PAGE_SIZE) {
        const { data, error } = await supabase.rpc("resource_registry_for_project", { p_project: projectId })
          .range(from, from + REGISTRY_PAGE_SIZE - 1);
        if (error) throw new Error(error.message);
        const page = (data ?? []) as RegistryItem[];
        rows.push(...page);
        if (page.length < REGISTRY_PAGE_SIZE) return rows;
      }
    },
  });
}

export function usePools(projectId: string | null) {
  return useQuery({
    queryKey: qk.pools(projectId),
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase.from("resource_pools")
        .select("*, items:resource_pool_items(registry_id), agents:agent_resource_pools(agent_id)")
        .eq("project_id", projectId!).order("name");
      if (error) throw new Error(error.message);
      return (data ?? []) as Pool[];
    },
  });
}

export function usePoolIssues(poolId: string | null) {
  return useQuery({
    queryKey: qk.poolIssues(poolId ?? ""),
    enabled: !!poolId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("resource_pool_issues", { p_pool: poolId });
      if (error) throw new Error(error.message);
      return (data ?? []) as Issue[];
    },
  });
}

export function useAgentIssues(agentId: string | null) {
  return useQuery({
    queryKey: qk.agentIssues(agentId ?? ""),
    enabled: !!agentId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("agent_resource_issues", { p_agent: agentId });
      if (error) throw new Error(error.message);
      return (data ?? []) as Issue[];
    },
  });
}

export function useCoherenceReport(projectId: string | null) {
  return useQuery({
    queryKey: qk.report(projectId),
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("resource_coherence_report", { p_project: projectId });
      if (error) throw new Error(error.message);
      return (data ?? []) as Issue[];
    },
  });
}

export function useProjectAgents(projectId: string | null) {
  return useQuery({
    queryKey: qk.agents(projectId),
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase.from("internal_agents")
        .select("id, name, service_dashboard_id, avatar_url, is_orchestrator")
        .eq("project_id", projectId!).eq("is_archived", false).order("name");
      if (error) throw new Error(error.message);
      return (data ?? []) as PoolAgent[];
    },
  });
}

// ── Écritures ───────────────────────────────────────────────────────────────

export async function createPool(input: {
  workspaceId: string; projectId: string; serviceDashboardId: string | null; name: string; description?: string | null; createdBy: string | null;
}): Promise<string> {
  const { data, error } = await supabase.from("resource_pools").insert({
    workspace_id: input.workspaceId, project_id: input.projectId, service_dashboard_id: input.serviceDashboardId,
    name: input.name.trim(), description: input.description?.trim() || null, created_by: input.createdBy,
  }).select("id").single();
  if (error) throw new Error(error.code === "23505" ? "Un pool porte déjà ce nom dans ce projet." : error.message);
  return (data as { id: string }).id;
}

export async function updatePool(id: string, patch: Partial<Pick<Pool, "name" | "description">>) {
  const { error } = await supabase.from("resource_pools").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.code === "23505" ? "Un pool porte déjà ce nom dans ce projet." : error.message);
}

export async function deletePool(id: string) {
  const { error } = await supabase.from("resource_pools").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function addPoolItems(poolId: string, registryIds: string[], userId: string | null) {
  if (!registryIds.length) return;
  const { error } = await supabase.from("resource_pool_items")
    .insert(registryIds.map((registry_id) => ({ pool_id: poolId, registry_id, added_by: userId })));
  if (error) throw new Error(cleanDbError(error));
}

export async function removePoolItem(poolId: string, registryId: string) {
  const { error } = await supabase.from("resource_pool_items").delete().eq("pool_id", poolId).eq("registry_id", registryId);
  if (error) throw new Error(error.message);
}

export async function assignPool(agentId: string, poolId: string, userId: string | null) {
  const { error } = await supabase.from("agent_resource_pools").insert({ agent_id: agentId, pool_id: poolId, assigned_by: userId });
  if (error) throw new Error(cleanDbError(error));
}

export async function unassignPool(agentId: string, poolId: string) {
  const { error } = await supabase.from("agent_resource_pools").delete().eq("agent_id", agentId).eq("pool_id", poolId);
  if (error) throw new Error(error.message);
}

/** Avant de resynchroniser : les actions de chaque app Composio connectée du
 *  projet, pour qu'elles entrent au registre une à une (0293). Rend le nombre
 *  d'apps découvertes ; une panne de Composio n'empêche pas la resynchronisation. */
export async function discoverProjectApps(workspaceId: string, projectId: string): Promise<{ apps: number; failed: number }> {
  try {
    const res = await callEdge<{ report?: Array<{ error?: string }> }>("composio-action", { workspace_id: workspaceId, project_id: projectId, discover_all: true });
    const report = res?.report ?? [];
    return { apps: report.filter((r) => !r.error).length, failed: report.filter((r) => r.error).length };
  } catch {
    return { apps: 0, failed: 1 };
  }
}

export async function rebuildRegistry(projectId: string): Promise<number> {
  const { data, error } = await supabase.rpc("resource_registry_rebuild", { p_project: projectId });
  if (error) throw new Error(cleanDbError(error));
  return Number(data ?? 0);
}

export async function poolFromAgent(agentId: string): Promise<{ pool_id: string; name: string; assigned: boolean; errors: string[] }> {
  const { data, error } = await supabase.rpc("resource_pool_from_agent", { p_agent: agentId, p_name: null, p_assign: true });
  if (error) throw new Error(cleanDbError(error));
  return data as { pool_id: string; name: string; assigned: boolean; errors: string[] };
}
