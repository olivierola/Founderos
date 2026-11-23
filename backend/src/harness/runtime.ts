// Le harnais en service dans ce processus : l'hôte, le magasin, le pont, le
// cycle de vie des runs. C'est le seul moteur d'agents ; null tant qu'il n'est
// pas démarré (HARNESS_OPENCODE=0) : les runs répondent alors 503.

import type { SupabaseClient } from "@supabase/supabase-js";
import { logLlmUsage } from "../edge/_shared/llm-tracking.ts";
import { assertCredits, assertQuota } from "../edge/_shared/metering.ts";
import { chooseTurnModel, loadAgentProfile } from "./agent-profile.ts";
import { agentPlugin, newAgentState, type KitLoader } from "./agent-plugin.ts";
import { documentCollections, rpcSearchIndex, supabaseRpc } from "./toolkit/grep.ts";
import { toolCallScope, type Kit } from "./toolkit/plugin.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { guardToolCall, guardToolResult, loadAgentGuardrails } from "./guard.ts";
import { evalStubFor } from "../edge/_shared/eval-stubs.ts";
import { afterTool, beforeTool, researchFor } from "./research.ts";
import { createLifecycle } from "./lifecycle.ts";
import { createController } from "./controller.ts";
import { modelForRoute } from "./agent-profile.ts";
import { ephemeralPlugin } from "./ephemeral.ts";
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
  /** Le lancement d'un run (runs.ts, startAgentRun) ; remplaçable dans les tests de la route. */
  startRun?: (input: import("./runs.ts").AgentRunInput) => Promise<import("./chat.ts").ChatTurn>;
}

/**
 * Les agents FounderOS dans OpenCode : une instance par agent (la clé est
 * l'agent_id porté par les métadonnées de la session), configurée par son
 * plugin (agent-plugin.ts), et ce qu'il faut à un tour pour choisir son modèle.
 */
export function agentSupport(admin: SupabaseClient, opts: {
  /** L'outillage FounderOS par lots (toolkit/) ; faux : les outils natifs seulement. */
  kit?: boolean | ((agentId: string) => Promise<Kit | null>);
  skillsDir?: string;
  log?: (msg: string) => void;
} = {}): { support: AgentSupport; instances: HarnessInstances } {
  const state = newAgentState();
  const kitFor = (agentId: string): KitLoader | undefined =>
    typeof opts.kit === "function" ? () => (opts.kit as (id: string) => Promise<Kit | null>)(agentId)
    : opts.kit ? () => loadKit(agentId)
    : undefined;
  const load = (agentId: string) => loadAgentProfile(admin, agentId);
  return {
    support: {
      state, load,
      choose: (profile, text, opts) => chooseTurnModel(admin, profile, text, opts),
    },
    instances: {
      key: (session: { metadata?: unknown }) => {
        const meta = (session.metadata as Record<string, unknown> | undefined) ?? {};
        // Un tour éphémère (cockpit, widget, rédacteur…) : une instance par famille.
        if (typeof meta.ephemeral === "string" && meta.ephemeral) return `eph:${meta.ephemeral}`;
        const id = meta.agent_id;
        return typeof id === "string" && id ? id : "default";
      },
      // Une session sans agent FounderOS garde l'agent par défaut d'OpenCode.
      configure: (key: string) => ({
        plugins: key === "default" ? []
          : key.startsWith("eph:") ? [ephemeralPlugin(key.slice(4))]
          : [agentPlugin(key, () => load(key), state, { kit: kitFor(key), skillsDir: opts.skillsDir, log: opts.log })],
      }),
    },
  };
}

/**
 * L'outillage d'un agent : ses handlers, ses schémas (cachés compris) et ses
 * skills. Les schémas viennent d'un jeu monté sans run ; chaque APPEL, lui,
 * s'exécute dans le jeu de SON run (run, conversation, personne qui pilote le
 * tour), retrouvé par la session d'où part l'appel : les approbations, les
 * messages en ligne et la timeline des outils visent le bon run.
 */
export async function loadKit(agentId: string): Promise<Kit> {
  const { prepareAgentToolset } = await import("../agents/toolset.ts");
  const t = await prepareAgentToolset(agentId, { runId: null });
  type Toolset = Awaited<ReturnType<typeof prepareAgentToolset>>;
  const perRun = new Map<string, Promise<Toolset>>();
  // Les garde-fous de l'agent (espace, équipe, pools), relus au plus toutes les minutes.
  let guards: { at: number; rows: Promise<Awaited<ReturnType<typeof loadAgentGuardrails>>> } | null = null;
  const guardrails = () => {
    if (!guards || Date.now() - guards.at > 60_000) guards = { at: Date.now(), rows: loadAgentGuardrails(t.ctx.admin as never, t.agent) };
    return guards.rows;
  };
  const toolsetFor = (run: { runId: string; conversationId: string | null; actingUserId?: string | null }): Promise<Toolset> => {
    let p = perRun.get(run.runId);
    if (!p) {
      p = prepareAgentToolset(agentId, { runId: run.runId, conversationId: run.conversationId, actingUserId: run.actingUserId ?? null });
      p.catch(() => perRun.delete(run.runId));
      perRun.set(run.runId, p);
      // Les runs finis ne reviennent pas : on garde les plus récents.
      while (perRun.size > 32) perRun.delete(perRun.keys().next().value as string);
    }
    return p;
  };
  return {
    agentName: t.agent.name,
    isOrchestrator: !!t.agent.is_orchestrator,
    skills: t.skills,
    // L'index de recherche (0308), à la portée de l'agent : son espace, son projet, ses lignes privées.
    search: rpcSearchIndex(supabaseRpc(t.ctx.admin as never), {
      workspaceId: t.agent.workspace_id, projectId: t.agent.project_id ?? null, agentId: t.agent.id,
      // Les collections que search_knowledge lui ouvre (ses pools en mode pools) : rien de plus.
      collections: documentCollections(t.rows),
    }),
    legacy: {
      defs: t.allDefs.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })),
      run: async (name, args, signal) => {
        const scope = toolCallScope.getStore();
        const run = scope ? harnessRuntime()?.bridge.binding(scope.sessionID) ?? null : null;
        const set = run && run.agentId === agentId ? await toolsetFor(run) : t;
        // Une éval remplace certains outils par des réponses écrites d'avance (npm run eval).
        const stubbed = evalStubFor(agentId, name, args);
        if (stubbed != null) return stubbed;
        // La mémoire des recherches du run : doublon refusé, sujet récent servi depuis la mémoire.
        const research = run ? researchFor(run, t.ctx.admin as never) : null;
        const short = research ? await beforeTool(research, name, args).catch(() => null) : null;
        if (short != null) return short;
        // Les garde-fous avant l'appel (il ne part pas) et sur son résultat.
        const rows = await guardrails().catch(() => []);
        const runId = run?.runId ?? null;
        const refused = rows.length ? await guardToolCall(t.ctx.admin as never, t.agent, runId, rows, name, args) : null;
        if (refused) return refused;
        const out = String(await set.executor(name, args, { signal }));
        const checked = rows.length ? await guardToolResult(t.ctx.admin as never, t.agent, runId, rows, name, out) : out;
        return research ? afterTool(research, name, args, checked).catch(() => checked) : checked;
      },
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
  // Le contrôleur de boucle après chaque étape (controller.ts).
  const controller = createController({
    steer: async (sessionID, text) => { await harness.opencode.sessions.prompt({ sessionID, text, delivery: "steer" }); },
    interrupt: async (sessionID) => { await harness.opencode.session.interrupt({ sessionID }); },
    // Le palier lourd de l'agent pour la suite de la session.
    escalate: async (run) => {
      const profile = agents?.state.controls.get(run.agentId)?.profile();
      if (!profile) return null;
      const heavy = modelForRoute(profile, "heavy");
      if (agents!.state.turnModels.get(run.sessionId) === heavy) return null;
      agents!.state.turnModels.set(run.sessionId, heavy);
      return heavy;
    },
  });
  // La fin des runs (contrat, livrables, salle, mission, workflow…) : lifecycle.ts.
  const lifecycle = createLifecycle({
    prompt: async (sessionID, text) => { await harness.opencode.sessions.prompt({ sessionID, text }); },
    abortReason: controller.abortReason,
    forget: controller.forget,
  });
  const bridge = startBridge(harness.opencode, store, {
    settle: lifecycle.settle, question: lifecycle.question, overBudget: lifecycle.overBudget,
    afterStep: controller.afterStep,
  });
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
