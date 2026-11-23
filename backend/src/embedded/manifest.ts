// Le manifeste d'un agent embarqué : tout ce que son conteneur doit savoir pour
// travailler, figé à la construction et identifié par son empreinte. Aucun
// secret : ni clé de modèle, ni jeton de connecteur. Les outils de la plateforme
// passent par la passerelle, avec la clé d'API de l'instance.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadActivatedSkills, prepareAgentToolset } from "../agents/context.ts";
import { loadAgentProfile } from "../harness/agent-profile.ts";
import { documentCollections } from "../harness/toolkit/grep.ts";

export interface SeedFile { path: string; content: string }

export interface EmbeddedConfig {
  agent_id: string;
  workspace_id: string;
  project_id: string;
  service_dashboard_id: string | null;
  connectivity: "connected" | "intermittent" | "isolated";
  llm_route: "founderos" | "direct";
  llm_base_url: string | null;
  llm_model: string | null;
  sync_level: "full" | "summary" | "metadata";
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
}

export interface EmbeddedManifest {
  manifest_version: 1;
  runtime_version: string;
  agent: Record<string, unknown> & { id: string; name: string; workspace_id: string; project_id: string };
  /** Le prompt de l'agent ; « Tes outils » y est remplacé par le guide du toolkit dans le conteneur. */
  system: string;
  steps?: number;
  routes: Record<string, string>;
  llm: { route: "founderos" | "direct"; base_url: string | null; model: string | null; openrouter: boolean };
  connectivity: EmbeddedConfig["connectivity"];
  sync_level: EmbeddedConfig["sync_level"];
  knowledge: { snapshot: boolean; collections: string[] | null };
  machine: {
    cpus: number; memory_mb: number; disk_mb: number; egress: string[]; shell: boolean;
    apt: string[]; pip: string[]; npm: string[]; seed_files: string[];
  };
  skills: Array<{ slug: string; name: string; description: string | null; category: string | null; instructions: string | null; tools: string[] | null }>;
  /** Les outils de la plateforme ouverts à l'agent (par ses pools), servis par la passerelle. */
  tools: string[];
  pools: string[];
}

export const CONFIG_COLUMNS =
  "agent_id, workspace_id, project_id, service_dashboard_id, connectivity, llm_route, llm_base_url, llm_model, sync_level, " +
  "knowledge_snapshot, cpus, memory_mb, disk_mb, egress, apt_packages, pip_packages, npm_packages, seed_files, shell_enabled, runtime_version";

/** Les outils qui ne passent pas la passerelle : la machine d'équipe (le conteneur est sa machine). */
export const LOCAL_ONLY = /^team_(shell|files|folders|jobs|install|browser)$/;

const AGENT_FIELDS = [
  "id", "name", "persona", "instructions", "soul", "preferences", "autonomy_level", "collaboration_enabled",
  "max_steps", "max_run_cost_usd", "workspace_id", "project_id", "service_dashboard_id", "is_orchestrator", "model_routes",
  "swarm_enabled",
] as const;

/** Une représentation stable (clés triées) : la même configuration donne la même empreinte. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}

export const manifestSha = (m: EmbeddedManifest) => createHash("sha256").update(JSON.stringify(stable(m))).digest("hex");

export async function loadConfig(admin: SupabaseClient, agentId: string): Promise<EmbeddedConfig | null> {
  const { data } = await admin.from("embedded_agent_configs").select(CONFIG_COLUMNS).eq("agent_id", agentId).maybeSingle();
  if (!data) return null;
  const c = data as unknown as EmbeddedConfig;
  return { ...c, cpus: Number(c.cpus), seed_files: Array.isArray(c.seed_files) ? c.seed_files : [] };
}

/** Le manifeste de l'agent tel qu'il est maintenant (profil, pools, skills, réglages de l'empaquetage). */
export async function compileManifest(admin: SupabaseClient, agentId: string): Promise<{ manifest: EmbeddedManifest; sha: string; config: EmbeddedConfig }> {
  const config = await loadConfig(admin, agentId);
  if (!config) throw new Error("cet agent n'est pas un agent embarqué");
  const [profile, toolset, skills, pools] = await Promise.all([
    loadAgentProfile(admin, agentId, { connection: config.llm_route === "direct" ? "optional" : "required" }),
    prepareAgentToolset(agentId, { runId: null }),
    loadActivatedSkills(admin as never, agentId).catch(() => []),
    admin.from("agent_resource_pools").select("resource_pools(name)").eq("agent_id", agentId),
  ]);
  const agent = Object.fromEntries(AGENT_FIELDS.map((k) => [k, (profile.agent as unknown as Record<string, unknown>)[k] ?? null])) as EmbeddedManifest["agent"];
  const manifest: EmbeddedManifest = {
    manifest_version: 1,
    runtime_version: config.runtime_version,
    agent,
    system: profile.system,
    ...(profile.steps ? { steps: profile.steps } : {}),
    routes: config.llm_route === "direct" && config.llm_model ? { standard: config.llm_model } : profile.routes,
    llm: {
      route: config.llm_route,
      base_url: config.llm_route === "direct" ? config.llm_base_url : null,
      model: config.llm_model,
      openrouter: config.llm_route === "founderos" && profile.connection.openrouter,
    },
    connectivity: config.connectivity,
    sync_level: config.sync_level,
    knowledge: { snapshot: config.knowledge_snapshot, collections: documentCollections(toolset.rows) },
    machine: {
      cpus: config.cpus, memory_mb: config.memory_mb, disk_mb: config.disk_mb, egress: config.egress ?? [],
      shell: config.shell_enabled, apt: config.apt_packages ?? [], pip: config.pip_packages ?? [], npm: config.npm_packages ?? [],
      seed_files: config.seed_files.map((f) => f.path),
    },
    skills: (skills as Array<Record<string, unknown>>).map((s) => ({
      slug: String(s.slug), name: String(s.name), description: (s.description as string | null) ?? null,
      category: (s.category as string | null) ?? null, instructions: (s.instructions as string | null) ?? null,
      tools: (s.tools as string[] | null) ?? null,
    })),
    tools: toolset.allDefs.map((d) => d.name).filter((n) => !LOCAL_ONLY.test(n)).sort(),
    pools: ((pools.data ?? []) as Array<{ resource_pools?: { name?: string } | null }>).map((p) => String(p.resource_pools?.name ?? "")).filter(Boolean).sort(),
  };
  return { manifest, sha: manifestSha(manifest), config };
}
