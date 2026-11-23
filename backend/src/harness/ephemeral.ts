// Les tours « éphémères » sur le harnais : une boucle d'outils qui n'est pas un
// agent FounderOS — l'assistant du cockpit, le widget public, le rédacteur des
// rapports, vibe-code. Ils remplacent callAiWithTools / runToolRounds de
// l'ancien moteur, avec la même forme d'appel : un prompt système, un
// historique, des outils (définitions JSON et un exécuteur), un modèle.
//
// Une instance OpenCode par famille (clé « eph:<famille> », voir runtime.ts) :
//   - le fournisseur « founderos » : la connexion par défaut de la plateforme ;
//   - un agent « eph », sans prompt propre : celui de CHAQUE session est posé à
//     chaque requête (hook context), avec ses seuls outils et leurs schémas ;
//   - les outils de la famille, enregistrés par nom à la première demande
//     (rechargés quand un nouvel outil apparaît) ; l'exécution part vers
//     l'exécuteur de la session qui appelle.
//
// Une session par tour : créée, attendue (fin d'exécution), puis supprimée.

import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { primaryModel, resolveModelAlias, routeAlias } from "../edge/_shared/llm-upstream.ts";
import { logLlmUsage } from "../edge/_shared/llm-tracking.ts";
import { PROVIDER_ID, platformConnection } from "./agent-profile.ts";
import type { Harness } from "./host.ts";

export const EPHEMERAL_AGENT = "eph";

export interface EphemeralTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface EphemeralInput {
  /** La famille : une instance OpenCode chacune (cockpit, rag, reporter, vibe…). */
  family: string;
  system: string;
  /** L'historique, du plus ancien au plus récent ; le dernier est le message à traiter. */
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  tools?: EphemeralTool[];
  executor?: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Un modèle précis ; sinon celui du palier sur la connexion de la plateforme. */
  model?: string | null;
  tier?: "light" | "standard" | "heavy";
  /** Plafond d'étapes (tours de modèle). */
  maxSteps?: number;
  timeoutMs?: number;
  onNotice?: (message: string) => void;
  /** Comptage de la consommation. */
  usage?: { workspaceId: string | null; projectId: string | null; feature: string; metadata?: Record<string, unknown> };
}

export interface EphemeralResult {
  content: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
  provider: string;
  costUsd: number;
}

interface SessionSpec {
  system: string;
  tools: Map<string, EphemeralTool>;
  executor?: EphemeralInput["executor"];
  model: string;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

interface FamilyState {
  names: Set<string>;
  models: Set<string>;
  reload?: () => Promise<void>;
}

const sessions = new Map<string, SessionSpec>();
const families = new Map<string, FamilyState>();
const familyOf = (f: string) => {
  let s = families.get(f);
  if (!s) families.set(f, (s = { names: new Set(), models: new Set() }));
  return s;
};

const LooseInput = Schema.Record(Schema.String, Schema.Unknown);

/** Le plugin d'une famille de tours éphémères. */
export function ephemeralPlugin(family: string) {
  return Plugin.define({
    id: `founderos-ephemeral-${family}`,
    setup: async (ctx) => {
      const fam = familyOf(family);
      const link = await platformConnection();
      const declared = new Set<string>();
      const declareModels = (ids: string[]) => { for (const id of ids) if (id) declared.add(id); };
      declareModels(Object.values(link.routes).map((v) => primaryModel(String(v))));

      await ctx.provider.transform((editor) => {
        const c = link.connection;
        editor.update(PROVIDER_ID, (p) => {
          p.name = "FounderOS";
          p.activation = "enabled";
          p.package = "@opencode/ai/providers/openai-compatible";
          p.settings = { baseURL: c.baseURL, ...(c.apiKey ? { apiKey: c.apiKey } : {}) };
          if (Object.keys(c.headers).length) p.headers = { ...c.headers };
          if (c.openrouter) p.body = { usage: { include: true } };
        });
        for (const id of [...declared, ...fam.models]) {
          editor.models.update(PROVIDER_ID, id, (model) => {
            model.name = id;
            model.limit = { context: 128_000, output: 16_000 };
          });
        }
      });

      await ctx.agent.transform((editor) => {
        for (const a of editor.list()) if (a.id !== EPHEMERAL_AGENT) editor.remove(a.id);
        editor.update(EPHEMERAL_AGENT, (a) => {
          a.name = EPHEMERAL_AGENT as typeof a.name;
          a.description = `Tour éphémère FounderOS (${family})`;
          a.mode = "primary";
          a.hidden = false;
          a.system = "";
          a.model = { providerID: PROVIDER_ID, id: primaryModel(String(link.routes.standard)) } as typeof a.model;
          a.permissions = [
            { action: "*", resource: "*", effect: "allow" },
            { action: "shell", resource: "*", effect: "deny" },
            { action: "external_directory", resource: "*", effect: "deny" },
            { action: "execute", resource: "*", effect: "deny" },
            { action: "question", resource: "*", effect: "deny" },
            { action: "subagent", resource: "*", effect: "deny" },
            { action: "skill", resource: "*", effect: "deny" },
          ] as typeof a.permissions;
        });
        editor.default(EPHEMERAL_AGENT);
      });

      await ctx.tool.transform((editor) => {
        for (const name of fam.names) {
          editor.add({
            name,
            options: { codemode: false },
            description: name,
            input: LooseInput,
            execute: async (input: Record<string, unknown>, c) => {
              const spec = sessions.get(c.sessionID);
              if (!spec?.executor || !spec.tools.has(name)) return { content: `ERROR: ${name} n'est pas un outil de ce tour.` };
              const args = (input ?? {}) as Record<string, unknown>;
              spec.calls.push({ name, args });
              try {
                return { content: String(await spec.executor(name, args)) };
              } catch (e) {
                return { content: `ERROR: ${e instanceof Error ? e.message : String(e)}` };
              }
            },
          });
        }
      });
      fam.reload = async () => { await ctx.tool.reload(); await ctx.provider.reload(); };

      // Chaque requête : le prompt de la session, ses seuls outils, leurs schémas.
      await ctx.session.hook("context", (event) => {
        const spec = sessions.get(event.sessionID);
        if (!spec) return;
        for (const name of Object.keys(event.tools)) {
          if (!spec.tools.has(name)) delete event.tools[name];
        }
        for (const [name, t] of spec.tools) {
          if (event.tools[name]) event.tools[name] = { description: t.description, input: t.parameters as never };
        }
        event.system.push({ type: "text", text: spec.system });
      });

      await ctx.session.hook("experimental.model.resolve", (event) => {
        const spec = sessions.get(event.sessionID);
        if (!spec || event.model.providerID !== PROVIDER_ID) return;
        event.model = { ...event.model, id: spec.model } as typeof event.model;
      });
      return () => { fam.reload = undefined; };
    },
  });
}

/** Le texte de l'historique avant le dernier message, en contexte de celui-ci. */
function promptText(messages: EphemeralInput["messages"]): string {
  const convo = messages.filter((m) => m.role !== "system" && m.content.trim());
  const last = convo.pop();
  const before = convo.map((m) => `${m.role === "user" ? "Utilisateur" : "Toi"} : ${m.content.trim().slice(0, 4000)}`);
  const text = last?.content ?? "";
  if (!before.length) return text;
  return ["[Les échanges précédents, pour le contexte]", ...before, "", "[Message à traiter]", text].join("\n");
}

/** Un tour éphémère : jusqu'à la fin de l'exécution, puis la session est supprimée. */
export async function runEphemeral(harness: Harness, input: EphemeralInput): Promise<EphemeralResult> {
  const opencode = harness.opencode;
  const fam = familyOf(input.family);
  const tools = new Map((input.tools ?? []).map((t) => [t.name, t]));
  const fresh = [...tools.keys()].filter((n) => !fam.names.has(n));
  for (const n of fresh) fam.names.add(n);

  const link = await platformConnection();
  const model = input.model?.trim() && !input.model.startsWith("@")
    ? input.model.trim()
    : primaryModel(resolveModelAlias(routeAlias(input.tier ?? "standard", null), link.routes, link.routes.standard) ?? link.routes.standard);
  const extraSystem = input.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const spec: SessionSpec = {
    system: [input.system, extraSystem].filter((x) => x && x.trim()).join("\n\n"),
    tools, executor: input.executor, model, calls: [],
  };
  // Un nouvel outil, ou un modèle pas encore déclaré : l'instance relit ses définitions.
  const newModel = !fam.models.has(model);
  fam.models.add(model);
  if (fresh.length || newModel) await fam.reload?.().catch(() => {});

  const directory = await harness.agentDir(`ephemeral-${input.family}`);
  const session = await opencode.sessions.create({
    location: { directory },
    title: `${input.family} ${new Date().toISOString()}`,
    metadata: { ephemeral: input.family },
    agent: EPHEMERAL_AGENT,
    model: { providerID: PROVIDER_ID, id: model },
    permissions: [{ action: "question", resource: "*", effect: "deny" }],
  });
  sessions.set(session.id, spec);

  const texts = new Map<string, string[]>();
  let lastAssistant: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let provider = "";
  let failure: string | null = null;
  let steps = 0;

  const stream = opencode.events.subscribe();
  const done = (async () => {
    for await (const raw of stream) {
      const ev = raw as { type: string; data?: Record<string, any> };
      const d = ev.data ?? {};
      if (d.sessionID !== session.id) continue;
      if (ev.type === "session.step.started" && d.model) provider = String(d.model.providerID ?? "");
      if (ev.type === "session.text.ended") {
        const key = String(d.assistantMessageID ?? "");
        texts.set(key, [...(texts.get(key) ?? []), String(d.text ?? "")]);
        lastAssistant = key;
      }
      if (ev.type === "session.step.ended" || ev.type === "session.step.failed") {
        steps++;
        const t = d.tokens ?? {};
        tokensIn += Number(t.input) || 0;
        tokensOut += (Number(t.output) || 0) + (Number(t.reasoning) || 0);
        cost += Number(d.cost) || 0;
        if (input.maxSteps && steps >= input.maxSteps) await opencode.session.interrupt({ sessionID: session.id }).catch(() => {});
      }
      if (ev.type === "session.retry.scheduled") input.onNotice?.(`Nouvelle tentative : ${String(d.error?.message ?? "").slice(0, 200)}`);
      if (ev.type === "session.execution.succeeded") return;
      if (ev.type === "session.execution.failed") { failure = String(d.error?.message ?? "échec de l'exécution"); return; }
      if (ev.type === "session.execution.interrupted") return;
    }
  })();

  const timeout = input.timeoutMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await opencode.sessions.prompt({ sessionID: session.id, text: promptText(input.messages) });
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          failure = failure ?? "délai dépassé";
          void opencode.session.interrupt({ sessionID: session.id }).catch(() => {});
          resolve();
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    sessions.delete(session.id);
    await (stream as unknown as { return?: () => Promise<unknown> }).return?.().catch(() => {});
    void opencode.session.remove({ sessionID: session.id }).catch(() => {});
  }

  const content = (lastAssistant ? texts.get(lastAssistant) ?? [] : []).join("\n\n").trim();
  if (failure && !content) throw new Error(failure);
  const result: EphemeralResult = {
    content,
    toolCalls: spec.calls,
    usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut, total_tokens: tokensIn + tokensOut },
    model, provider: provider || "openrouter", costUsd: Number(cost.toFixed(6)),
  };
  if (input.usage) {
    await logLlmUsage({
      workspace_id: input.usage.workspaceId, project_id: input.usage.projectId,
      provider: result.provider, model, task: "chat_simple", feature: input.usage.feature,
      usage: result.usage,
      metadata: { harness: "opencode", ephemeral: input.family, ...(cost > 0 ? { billed_usd: result.costUsd } : {}), ...(input.usage.metadata ?? {}) },
    }).catch(() => {});
  }
  return result;
}

/** Le harnais du processus, pour un tour éphémère. */
export async function ephemeral(input: EphemeralInput): Promise<EphemeralResult> {
  const { harnessRuntime } = await import("./runtime.ts");
  const rt = harnessRuntime();
  if (!rt) throw new Error("le moteur d'agents (harnais OpenCode) n'est pas démarré");
  return runEphemeral(rt.harness, input);
}

/**
 * La même forme d'appel que callAiWithTools (ancien moteur), sur le harnais :
 * les appelants passent leurs messages, leurs définitions d'outils
 * ({ type: "function", function: { name, description, parameters } }) et leur
 * exécuteur, et reçoivent { content, provider, model, usage, toolCalls }.
 */
export async function callToolLoop(family: string, opts: {
  messages: Array<{ role: string; content?: string | null }>;
  tools?: Array<{ function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
  executor?: (name: string, args: Record<string, unknown>) => Promise<string>;
  model?: string | null;
  tier?: "light" | "standard" | "heavy";
  maxRounds?: number;
  timeoutMs?: number;
  onNotice?: (n: { type: "tool_error" | "info"; message: string; detail?: string }) => unknown;
  usage?: EphemeralInput["usage"];
}): Promise<EphemeralResult> {
  const system = opts.messages.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n\n");
  const messages = opts.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content ?? "") }));
  return ephemeral({
    family, system, messages,
    tools: (opts.tools ?? []).map((t) => ({
      name: t.function.name, description: t.function.description ?? t.function.name,
      parameters: t.function.parameters ?? { type: "object", properties: {} },
    })),
    executor: opts.executor,
    model: opts.model ?? null,
    tier: opts.tier,
    // Un tour d'outils de l'ancienne boucle ≈ une étape de modèle ; une marge pour la réponse finale.
    maxSteps: opts.maxRounds ? opts.maxRounds + 1 : undefined,
    timeoutMs: opts.timeoutMs,
    onNotice: opts.onNotice ? (message) => { void opts.onNotice!({ type: "info", message }); } : undefined,
    usage: opts.usage,
  });
}
