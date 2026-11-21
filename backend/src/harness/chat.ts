// Un tour de chat sur le harnais OpenCode : le pendant de runChat de l'ancien
// moteur (internal-agent-run), avec le même contrat pour le front.
//
//   - Le message de la personne est déjà enregistré par le front dans
//     internal_agent_messages ; on le lit, on ne le reçoit pas.
//   - Réponse : { ok, run_id, queued } — le front suit le run (timeline) et
//     attend le message de l'agent, comme avant.
//   - Un message envoyé pendant un tour en cours n'ouvre pas de second run :
//     il entre dans la session en `steer` (pris en compte à la prochaine
//     étape) et la réponse est { ok, run_id, injected }.
//
// Une conversation garde UNE session OpenCode. La première fois, la session
// est amorcée avec les derniers échanges de la conversation, pour qu'un agent
// qui change de moteur ne perde pas le fil.

import { AGENT_ID, PROVIDER_ID, modelForRoute, profileModels, type AgentProfile } from "./agent-profile.ts";
import type { AgentState } from "./agent-plugin.ts";
import type { Bridge } from "./bridge.ts";
import type { Harness } from "./host.ts";
import type { HarnessAgent, HarnessStore } from "./store.ts";

/** Les agents FounderOS dans OpenCode (phase 2). Absent : l'agent par défaut
 *  d'OpenCode et le modèle de la configuration (phase 1, tests). */
export interface AgentSupport {
  state: AgentState;
  load: (agentId: string) => Promise<AgentProfile>;
  choose: (
    profile: AgentProfile, text: string, opts: { composer?: string | null; contextChars?: number },
  ) => Promise<{ model: string; tier: string; need: string | null }>;
}

export interface ChatDeps {
  harness: Harness;
  store: HarnessStore;
  bridge: Bridge;
  agents?: AgentSupport;
}

/** Le profil à jour de l'agent, et le modèle de ce tour (déclaré à l'instance au besoin). */
async function prepareAgent(agents: AgentSupport, agentId: string, text: string, composer: string | null | undefined, contextChars: number) {
  const control = agents.state.controls.get(agentId);
  const profile = control ? await control.refresh() : await agents.load(agentId);
  const choice = await agents.choose(profile, text, { composer, contextChars });
  const declared = profileModels(profile).some((m) => m.id === choice.model)
    || (agents.state.extraModels.get(agentId)?.has(choice.model) ?? false);
  if (!declared) {
    const set = agents.state.extraModels.get(agentId) ?? new Set<string>();
    set.add(choice.model);
    agents.state.extraModels.set(agentId, set);
    await control?.refresh();
  }
  return { profile, choice };
}

export interface ChatTurn {
  ok: true;
  run_id: string;
  queued?: true;
  injected?: true;
}

/** « fournisseur/modèle » → référence OpenCode ; null pour un alias (« @heavy ») ou une valeur vide. */
export function parseModelRef(value: string | null | undefined): { providerID: string; id: string } | null {
  const v = String(value ?? "").trim();
  if (!v || v.startsWith("@")) return null;
  const i = v.indexOf("/");
  if (i <= 0 || i === v.length - 1) return null;
  return { providerID: v.slice(0, i), id: v.slice(i + 1) };
}

/** Les échanges d'avant, en contexte du premier message d'une nouvelle session. */
export function seedText(earlier: Array<{ role: string; content: string }>, text: string): string {
  const lines = earlier
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .map((m) => `${m.role === "user" ? "Utilisateur" : "Toi"} : ${m.content.trim().slice(0, 1500)}`);
  if (!lines.length) return text;
  return [
    "[Contexte : les derniers échanges de cette conversation, avant que tu ne la reprennes. Ne les rejoue pas, sers-t'en pour répondre au nouveau message.]",
    ...lines,
    "",
    "[Nouveau message]",
    text,
  ].join("\n");
}

export async function startChatTurn(
  deps: ChatDeps,
  input: { agent: HarnessAgent; conversationId: string; model?: string | null },
): Promise<ChatTurn> {
  const { harness, store, bridge } = deps;
  const opencode = harness.opencode;
  const history = await store.recentMessages(input.conversationId, 13);
  const lastUserIndex = history.map((m) => m.role).lastIndexOf("user");
  const text = lastUserIndex >= 0 ? history[lastUserIndex].content : "";
  if (!text.trim()) throw new Error("aucun message de l'utilisateur dans cette conversation");

  // Un tour est déjà en cours : le message le pilote, sans second run.
  const active = await store.activeRun(input.conversationId);
  if (active) {
    await opencode.sessions.prompt({ sessionID: active.sessionId, text, delivery: "steer" });
    return { ok: true, run_id: active.runId, injected: true };
  }

  const conv = await store.conversation(input.conversationId, input.agent.id);
  if (!conv) throw new Error("conversation introuvable pour cet agent");

  // L'agent FounderOS : son profil à jour et le modèle de CE tour (palier,
  // critère, AgentPilot, ou le choix du composer). Sans support d'agent, le
  // modèle « fournisseur/modèle » du composer s'applique tel quel.
  const prepared = deps.agents
    ? await prepareAgent(deps.agents, input.agent.id, text, input.model, history.reduce((n, m) => n + m.content.length, 0))
    : null;
  const model = prepared
    ? { providerID: PROVIDER_ID, id: modelForRoute(prepared.profile, "standard") }
    : parseModelRef(input.model);

  let sessionId: string;
  let prompt = text;
  if (!conv.sessionId) {
    const directory = await harness.agentDir(input.agent.id);
    const session = await opencode.sessions.create({
      location: { directory },
      metadata: { workspace_id: input.agent.workspace_id, agent_id: input.agent.id, conversation_id: input.conversationId },
      ...(prepared ? { agent: AGENT_ID } : {}),
      ...(model ? { model } : {}),
    });
    sessionId = session.id;
    await store.setConversationSession(input.conversationId, sessionId);
    prompt = seedText(history.slice(0, Math.max(0, lastUserIndex)), text);
  } else {
    sessionId = conv.sessionId;
    if (model && !prepared) await opencode.session.switchModel({ sessionID: sessionId, model });
  }
  // Lu par le hook de l'instance quand la requête du tour part.
  if (prepared) deps.agents!.state.turnModels.set(sessionId, prepared.choice.model);

  const runId = await store.createRun({ agent: input.agent, conversationId: input.conversationId, sessionId, via: "chat" });
  if (prepared) {
    const c = prepared.choice;
    await store.insertEvent(runId, input.agent.id, "status", {
      message: `Moteur OpenCode · modèle ${c.model} · palier ${c.tier}${c.need ? ` · critère ${c.need}` : ""}.`,
    });
  }
  // Attaché AVANT le message : aucun événement du tour ne peut passer à côté.
  bridge.bind({
    runId, sessionId, agentId: input.agent.id, workspaceId: input.agent.workspace_id,
    projectId: input.agent.project_id, conversationId: input.conversationId,
  });
  await opencode.sessions.prompt({ sessionID: sessionId, text: prompt, metadata: { run_id: runId } });
  return { ok: true, run_id: runId, queued: true };
}
