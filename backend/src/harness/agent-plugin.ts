// Le plugin d'un agent FounderOS dans OpenCode (docs/harness-opencode, phase 2).
//
// Chaque agent a SA propre instance OpenCode (clé d'instance = agent_id, voir
// host.ts) et ce plugin la configure :
//   - un fournisseur « founderos » compatible OpenAI : son connecteur, ou la
//     connexion de la plateforme, avec ses modèles et leurs replis ;
//   - un agent « founderos », par défaut, avec le prompt système FounderOS,
//     son budget d'étapes et ses permissions ;
//   - le modèle de chaque requête (hook experimental.model.resolve) : celui
//     que le tour a choisi pour le travail de l'agent, le palier léger pour
//     les titres et la compaction.
//
// Le profil est relu au début de chaque tour (refresh) : un prompt ou des
// modèles changés dans l'application s'appliquent sans redémarrer.

import { Plugin } from "@opencode/plugin";
import { AGENT_ID, PROVIDER_ID, modelForRoute, profileModels, type AgentProfile } from "./agent-profile.ts";

/**
 * Les permissions d'un agent FounderOS, tant que les approbations (phase 4) et
 * l'exécution isolée (phase 6) n'existent pas : tout ce qui reste dans son
 * dossier de travail est permis ; le shell et l'accès hors du dossier sont
 * REFUSÉS — en mode local, ils toucheraient la machine qui héberge le backend.
 */
export const AGENT_PERMISSIONS = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
] as const;

/** Ce qu'un tour peut demander à l'instance de son agent, une fois construite. */
export interface AgentControl {
  profile(): AgentProfile;
  /** Relit le profil (prompt, modèles) et l'applique à l'instance. */
  refresh(): Promise<AgentProfile>;
}

/**
 * L'état partagé entre les tours (chat.ts) et les instances d'agents.
 *
 * Une instance n'est construite qu'à la première opération qui en a besoin
 * (le premier message d'une session), pas à la création de la session : le
 * modèle choisi pour un tour est donc posé ICI avant le message, et lu par le
 * hook quand la requête part.
 */
export interface AgentState {
  /** Le modèle du travail de l'agent, par session, jusqu'au tour suivant. */
  turnModels: Map<string, string>;
  /** Les modèles demandés hors des routes (le composer), par agent. */
  extraModels: Map<string, Set<string>>;
  /** Les instances construites, par agent. */
  controls: Map<string, AgentControl>;
}

export const newAgentState = (): AgentState => ({ turnModels: new Map(), extraModels: new Map(), controls: new Map() });

export function agentPlugin(
  agentId: string,
  load: () => Promise<AgentProfile>,
  state: AgentState,
) {
  return Plugin.define({
    id: "founderos-agent",
    setup: async (ctx) => {
      let profile = await load();
      const extra = (): string[] => [...(state.extraModels.get(agentId) ?? [])];

      await ctx.provider.transform((editor) => {
        const c = profile.connection;
        editor.update(PROVIDER_ID, (p) => {
          p.name = "FounderOS";
          p.activation = "enabled";
          p.package = "@opencode/ai/providers/openai-compatible";
          p.settings = { baseURL: c.baseURL, ...(c.apiKey ? { apiKey: c.apiKey } : {}) };
          if (Object.keys(c.headers).length) p.headers = { ...c.headers };
          // OpenRouter : le coût réel de chaque appel revient avec la réponse.
          if (c.openrouter) p.body = { usage: { include: true } };
        });
        const models = [...profileModels(profile), ...extra().map((id) => ({ id, fallbacks: [] as string[] }))];
        for (const m of models) {
          editor.models.update(PROVIDER_ID, m.id, (model) => {
            model.name = m.id;
            // Une fenêtre prudente tant qu'on ne lit pas le catalogue du
            // fournisseur : la compaction se déclenche avant le refus.
            model.limit = { context: 128_000, output: 16_000 };
            if (m.fallbacks.length > 1) model.body = { models: m.fallbacks };
          });
        }
      });

      await ctx.agent.transform((editor) => {
        editor.update(AGENT_ID, (a) => {
          a.name = profile.agent.name as typeof a.name;
          a.description = `Agent FounderOS ${profile.agent.name}`;
          a.mode = "primary";
          a.hidden = false;
          a.system = profile.system;
          if (profile.steps) a.steps = profile.steps as typeof a.steps;
          a.model = { providerID: PROVIDER_ID, id: modelForRoute(profile, "standard") } as typeof a.model;
          a.permissions = AGENT_PERMISSIONS.map((r) => ({ ...r })) as typeof a.permissions;
        });
        editor.default(AGENT_ID);
      });

      // Le modèle de chaque requête : le travail de l'agent prend celui du
      // tour ; un titre ou une compaction prend le palier léger.
      await ctx.session.hook("experimental.model.resolve", (event) => {
        if (event.model.providerID !== PROVIDER_ID) return;
        const id = event.kind === "primary"
          ? state.turnModels.get(event.sessionID) ?? event.model.id
          : modelForRoute(profile, "light");
        event.model = { ...event.model, id } as typeof event.model;
      });

      state.controls.set(agentId, {
        profile: () => profile,
        refresh: async () => {
          profile = await load();
          await ctx.provider.reload();
          await ctx.agent.reload();
          return profile;
        },
      });
      return () => { state.controls.delete(agentId); };
    },
  });
}
