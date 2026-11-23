import { useQuery, useQueryClient } from "@tanstack/react-query";
import { callEdge } from "@/lib/edge";
import type { MachineCatalog } from "@/features/machines/api";

// Les agents embarqués d'un service (migration 0316, fonction embedded-agents) :
// un agent FounderOS empaqueté avec sa machine (un conteneur) pour tourner
// ailleurs, relié à FounderOS par une clé d'API. Les clés ne se lisent qu'une
// fois, à leur création ; ici, seulement leur préfixe.

export type Connectivity = "connected" | "intermittent" | "isolated";
export type LlmRoute = "founderos" | "direct";
export type SyncLevel = "full" | "summary" | "metadata";

export interface SeedFile { path: string; content: string }

export interface EmbeddedConfig {
  agent_id: string;
  connectivity: Connectivity;
  llm_route: LlmRoute;
  llm_base_url: string | null;
  llm_model: string | null;
  sync_level: SyncLevel;
  knowledge_snapshot: boolean;
  cpus: number;
  memory_mb: number;
  disk_mb: number;
  egress: string[];
  apt_packages: string[];
  pip_packages: string[];
  npm_packages: string[];
  seed_files: SeedFile[];
  shell_enabled: boolean;
  runtime_version: string;
  /** 0318 : les outils du catalogue installés dans le conteneur. */
  tools: string[];
  /** 0317 : le preset du catalogue choisi au départ (pour l'affichage). */
  machine_template: string | null;
}

export interface EmbeddedAgent {
  id: string;
  name: string;
  persona: string | null;
  avatar_url: string | null;
  avatar_style: string | null;
  accent_color: string | null;
  created_at: string;
}

export interface EmbeddedBuild {
  id: string;
  agent_id: string;
  version: number;
  manifest_sha: string;
  status: "exported" | "building" | "built" | "failed";
  image_ref: string | null;
  log: string | null;
  created_at: string;
}

export interface EmbeddedInstance {
  id: string;
  agent_id: string;
  name: string;
  status: "online" | "paused" | "stopped";
  container_ref: string | null;
  manifest_sha: string | null;
  version: number | null;
  info: Record<string, unknown>;
  last_seen_at: string | null;
  created_at: string;
}

export interface EmbeddedKey {
  id: string;
  agent_id: string;
  label: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface EmbeddedList {
  ok: boolean;
  agents: EmbeddedAgent[];
  configs: EmbeddedConfig[];
  builds: EmbeddedBuild[];
  instances: EmbeddedInstance[];
  keys: EmbeddedKey[];
  /** La construction et le lancement sur le Docker de cet hôte : possibles, sinon pourquoi. */
  local: { ok: boolean; reason?: string };
  founderos_url: string;
  catalog?: MachineCatalog;
}

const key = (dashboardId: string) => ["embedded_agents", dashboardId];

export function useEmbeddedAgents(dashboardId: string) {
  return useQuery({
    queryKey: key(dashboardId),
    queryFn: () => callEdge<EmbeddedList>("embedded-agents", { action: "list", dashboard_id: dashboardId }),
    // Les instances battent toutes les 15 s, les constructions prennent des minutes.
    refetchInterval: 10_000,
  });
}

export function useRefreshEmbedded(dashboardId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: key(dashboardId) });
}

type Res = { ok: boolean; error?: string };

export const embeddedApi = {
  create: (dashboardId: string, input: { name: string; persona?: string; instructions?: string; machine_template?: string; tools?: string[] }) =>
    callEdge<Res & { agent: { id: string; name: string } }>("embedded-agents", { action: "create", dashboard_id: dashboardId, ...input }),
  updateConfig: (agentId: string, patch: Partial<Omit<EmbeddedConfig, "agent_id">>) =>
    callEdge<Res>("embedded-agents", { action: "update_config", agent_id: agentId, ...patch }),
  export: (agentId: string) =>
    callEdge<Res & { build: EmbeddedBuild; filename: string; zip_base64: string }>("embedded-agents", { action: "export", agent_id: agentId }),
  createKey: (agentId: string, label: string) =>
    callEdge<Res & { key: string; row: EmbeddedKey }>("embedded-agents", { action: "create_key", agent_id: agentId, label }),
  revokeKey: (keyId: string) => callEdge<Res>("embedded-agents", { action: "revoke_key", key_id: keyId }),
  command: (agentId: string, command: "pause" | "resume" | "reload" | "stop", instanceId?: string) =>
    callEdge<Res>("embedded-agents", { action: "command", agent_id: agentId, command, ...(instanceId ? { instance_id: instanceId } : {}) }),
  runLocal: (agentId: string, instanceName: string) =>
    callEdge<Res & { build: EmbeddedBuild }>("embedded-agents", { action: "run_local", agent_id: agentId, instance_name: instanceName }),
  importJournal: (agentId: string, journal: string) =>
    callEdge<Res & { imported: { conversations: number; messages: number; runs: number; events: number; instance: string | null } }>(
      "embedded-agents", { action: "import_journal", agent_id: agentId, journal }),
  stopLocal: (instanceId: string, volumes: boolean) =>
    callEdge<Res>("embedded-agents", { action: "stop_local", instance_id: instanceId, volumes }),
};

/** Télécharge l'archive d'une version (le conteneur de l'agent). */
export function downloadBase64(filename: string, b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** En ligne : un battement de cœur il y a moins d'une minute. */
export const isLive = (i: EmbeddedInstance) =>
  i.status !== "stopped" && !!i.last_seen_at && Date.now() - Date.parse(i.last_seen_at) < 60_000;
