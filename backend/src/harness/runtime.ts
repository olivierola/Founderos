// Le harnais en service dans ce processus : l'hôte, le magasin, le pont.
// Null tant qu'il n'est pas démarré (mode cloud, HARNESS_OPENCODE=0) : la
// route laisse alors tout passer vers l'ancien moteur.

import type { SupabaseClient } from "@supabase/supabase-js";
import { logLlmUsage } from "../edge/_shared/llm-tracking.ts";
import { assertCredits, assertQuota } from "../edge/_shared/metering.ts";
import { chooseTurnModel, loadAgentProfile } from "./agent-profile.ts";
import { agentPlugin, newAgentState } from "./agent-plugin.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import type { AgentSupport } from "./chat.ts";
import type { Harness, HarnessInstances } from "./host.ts";
import { supabaseStore, type HarnessStore, type UsageRow } from "./store.ts";

export interface HarnessRuntime {
  harness: Harness;
  store: HarnessStore;
  bridge: Bridge;
  serviceKey: string;
  /** L'utilisateur d'un jeton, ou null. */
  verifyUser: (token: string) => Promise<string | null>;
  /** Crédits et quota avant d'engager la dépense (lève une erreur de quota). */
  checkCredits: (workspaceId: string) => Promise<void>;
  /** Les agents FounderOS (prompt, modèles) : absent, l'agent par défaut d'OpenCode. */
  agents?: AgentSupport;
}

/**
 * Les agents FounderOS dans OpenCode : une instance par agent (la clé est
 * l'agent_id porté par les métadonnées de la session), configurée par son
 * plugin (agent-plugin.ts), et ce qu'il faut à un tour pour choisir son modèle.
 */
export function agentSupport(admin: SupabaseClient): { support: AgentSupport; instances: HarnessInstances } {
  const state = newAgentState();
  const load = (agentId: string) => loadAgentProfile(admin, agentId);
  return {
    support: {
      state, load,
      choose: (profile, text, opts) => chooseTurnModel(admin, profile, text, opts),
    },
    instances: {
      key: (session: { metadata?: unknown }) => {
        const id = (session.metadata as Record<string, unknown> | undefined)?.agent_id;
        return typeof id === "string" && id ? id : "default";
      },
      // Une session sans agent FounderOS garde l'agent par défaut d'OpenCode.
      configure: (key: string) => ({ plugins: key === "default" ? [] : [agentPlugin(key, () => load(key), state)] }),
    },
  };
}

let current: HarnessRuntime | null = null;

export const harnessRuntime = (): HarnessRuntime | null => current;

/** La consommation d'OpenCode, au même compteur que l'ancien moteur. */
export function usageToLlm(row: UsageRow): Promise<void> {
  return logLlmUsage({
    workspace_id: row.workspaceId,
    project_id: row.projectId,
    provider: row.provider || "opencode",
    model: row.model || "unknown",
    task: row.source === "step" ? "content_generation" : "summary",
    feature: "internal-agent-chat",
    usage: { prompt_tokens: row.promptTokens, completion_tokens: row.completionTokens },
    metadata: {
      run_id: row.runId, agent_id: row.agentId, harness: "opencode", source: row.source,
      cached_tokens: row.cachedTokens, ...(row.costUsd > 0 ? { billed_usd: Number(row.costUsd.toFixed(6)) } : {}),
    },
  });
}

/** Branche le magasin et le pont sur un hôte démarré. */
export function startRuntime(harness: Harness, admin: SupabaseClient, serviceKey: string, agents?: AgentSupport): HarnessRuntime {
  const store = supabaseStore(admin, usageToLlm);
  const bridge = startBridge(harness.opencode, store);
  current = {
    harness, store, bridge, serviceKey, agents,
    verifyUser: async (token) => {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
    // Le même seuil que l'ancien moteur : 60 crédits ≈ deux tours d'agent.
    checkCredits: async (workspaceId) => {
      await assertCredits(workspaceId, { minimum: 60 });
      await assertQuota(workspaceId, "concurrent_runs", 1, { fresh: true });
    },
  };
  return current;
}

export async function stopRuntime(): Promise<void> {
  const rt = current;
  current = null;
  await rt?.bridge.stop().catch(() => {});
}
