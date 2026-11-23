// Les tours d'un agent sur le harnais OpenCode : le pendant de runChat et de
// runMission de l'ancien moteur, avec le même contrat pour le front.
//
// Un tour de chat (startChatTurn) :
//   - Le message de la personne est déjà enregistré dans internal_agent_messages ;
//     on le lit, on ne le reçoit pas.
//   - Réponse : { ok, run_id, queued } — le front suit le run (timeline) et
//     attend le message de l'agent, comme avant.
//   - Un message envoyé pendant un tour en cours n'ouvre pas de second run : il
//     entre dans la session en `steer` (pris en compte à la prochaine étape) et
//     la réponse est { ok, run_id, injected }.
//   - Si l'agent attend une réponse à SA question (outil question), le message
//     est cette réponse : le formulaire est rempli et le même run reprend.
//
// Une conversation garde UNE session OpenCode. La première fois, la session est
// amorcée avec les derniers échanges de la conversation.
//
// Un tour hors conversation (startTaskRun : mission, salle, workflow, message
// d'un collègue) a sa propre session, le run déjà créé par l'appelant au besoin.

import { AGENT_ID, PROVIDER_ID, modelForRoute, profileModels, type AgentProfile } from "./agent-profile.ts";
import type { AgentState } from "./agent-plugin.ts";
import type { Bridge } from "./bridge.ts";
import type { Harness } from "./host.ts";
import type { HarnessAgent, HarnessStore, RunKind } from "./store.ts";

/** Les agents FounderOS dans OpenCode. Absent : l'agent par défaut d'OpenCode
 *  et le modèle de la configuration (tests du pont). */
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
  answered?: true;
}

/** Ce qu'un appelant ajoute à un tour : le contexte du run, son état métier, la personne qui le pilote. */
export interface TurnExtras {
  /** Le bloc <run_context> du run (mémoire, skills, mode…), ajouté au prompt de chaque requête. */
  runContext?: string;
  /** L'état métier du run (run_meta). */
  meta?: Record<string, unknown>;
  actingUserId?: string | null;
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

/** La réponse d'une personne à un formulaire : le premier champ reçoit le texte (ou l'option choisie). */
export function formAnswer(fields: Array<{ key: string; options?: string[]; multiple?: boolean }>, text: string): Record<string, string | string[]> {
  const f = fields[0];
  if (!f) return {};
  const t = text.trim();
  if (f.options?.length) {
    const hit = f.options.find((o) => o.toLowerCase() === t.toLowerCase());
    if (f.multiple) return { [f.key]: [hit ?? t] };
    return { [f.key]: hit ?? t };
  }
  return { [f.key]: t };
}

export async function startChatTurn(
  deps: ChatDeps,
  input: { agent: HarnessAgent; conversationId: string; model?: string | null } & TurnExtras,
): Promise<ChatTurn> {
  const { harness, store, bridge } = deps;
  const opencode = harness.opencode;
  const history = await store.recentMessages(input.conversationId, 13);
  const lastUserIndex = history.map((m) => m.role).lastIndexOf("user");
  const text = lastUserIndex >= 0 ? history[lastUserIndex].content : "";
  if (!text.trim()) throw new Error("aucun message de l'utilisateur dans cette conversation");

  // L'agent attendait la réponse à SA question : ce message l'est.
  const waiting = await store.pendingQuestion?.(input.conversationId);
  if (waiting) {
    await opencode.session.form.reply({ sessionID: waiting.sessionId, formID: waiting.formId, answer: formAnswer(waiting.fields, text) as never });
    await store.updateRun(waiting.runId, { status: "running", pending_question: null, finished_at: null });
    await store.insertEvent(waiting.runId, input.agent.id, "status", { message: "Réponse reçue : je reprends." });
    return { ok: true, run_id: waiting.runId, answered: true };
  }

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
  // Lu par les hooks de l'instance quand la requête du tour part.
  if (prepared) deps.agents!.state.turnModels.set(sessionId, prepared.choice.model);
  if (deps.agents && input.runContext) deps.agents.state.runContexts.set(sessionId, input.runContext);

  const meta = { kind: "chat" as RunKind, ...(input.meta ?? {}), ...(input.runContext ? { run_context: input.runContext } : {}) };
  const runId = await store.createRun({ agent: input.agent, conversationId: input.conversationId, sessionId, via: "chat", meta });
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
    actingUserId: input.actingUserId ?? null, kind: "chat", meta,
  });
  await opencode.sessions.prompt({ sessionID: sessionId, text: prompt, metadata: { run_id: runId } });
  return { ok: true, run_id: runId, queued: true };
}

/**
 * Un tour hors conversation : mission, salle, workflow, message d'un collègue.
 * Une session neuve par run ; sans personne pour répondre (`unattended`),
 * l'outil question est refusé à l'agent.
 */
export async function startTaskRun(
  deps: ChatDeps,
  input: {
    agent: HarnessAgent;
    kind: Exclude<RunKind, "chat">;
    /** Le run déjà créé par l'appelant (mission en file, salle, workflow) ; sinon un run neuf. */
    runId?: string | null;
    /** La consigne du tour (brief de mission, message de la salle, étape du workflow…). */
    text: string;
    model?: string | null;
    unattended?: boolean;
    via?: string;
  } & TurnExtras,
): Promise<ChatTurn> {
  const { harness, store, bridge } = deps;
  const opencode = harness.opencode;
  const prepared = deps.agents ? await prepareAgent(deps.agents, input.agent.id, input.text, input.model, input.text.length) : null;
  const model = prepared ? { providerID: PROVIDER_ID, id: modelForRoute(prepared.profile, "standard") } : parseModelRef(input.model);
  const directory = await harness.agentDir(input.agent.id);
  const session = await opencode.sessions.create({
    location: { directory },
    title: `${input.kind} ${input.runId ?? ""}`.trim(),
    metadata: { workspace_id: input.agent.workspace_id, agent_id: input.agent.id, kind: input.kind, ...(input.runId ? { run_id: input.runId } : {}) },
    ...(prepared ? { agent: AGENT_ID } : {}),
    ...(model ? { model } : {}),
    ...(input.unattended ? { permissions: [{ action: "question", resource: "*", effect: "deny" as const }] } : {}),
  });
  const sessionId = session.id;
  if (prepared) deps.agents!.state.turnModels.set(sessionId, prepared.choice.model);
  if (deps.agents && input.runContext) deps.agents.state.runContexts.set(sessionId, input.runContext);

  const meta = { kind: input.kind, ...(input.meta ?? {}), ...(input.runContext ? { run_context: input.runContext } : {}) };
  const runId = await store.createRun({
    agent: input.agent, conversationId: null, sessionId, via: input.via ?? input.kind, runId: input.runId ?? null, meta,
  });
  if (prepared) {
    const c = prepared.choice;
    await store.insertEvent(runId, input.agent.id, "status", {
      message: `Moteur OpenCode · ${input.kind} · modèle ${c.model} · palier ${c.tier}${c.need ? ` · critère ${c.need}` : ""}.`,
    });
  }
  bridge.bind({
    runId, sessionId, agentId: input.agent.id, workspaceId: input.agent.workspace_id,
    projectId: input.agent.project_id, conversationId: null, actingUserId: input.actingUserId ?? null,
    kind: input.kind, meta,
  });
  await opencode.sessions.prompt({ sessionID: sessionId, text: input.text, metadata: { run_id: runId } });
  return { ok: true, run_id: runId, queued: true };
}
