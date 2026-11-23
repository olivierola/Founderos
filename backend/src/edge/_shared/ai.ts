import { Deno } from "../../compat/index.ts";

// AI router: Groq for fast / classification / JSON-extract, DeepSeek for deep code analysis.
// Per spec section 13. Both providers expose OpenAI-compatible REST endpoints.
// A deployment can pin every call to one gateway instead (LLM_UPSTREAM=litellm
// or azure, see llm-upstream.ts): routing and failover then stop.

import {
  adaptChatBody, isModelAlias, LIGHT_MODEL, llmAuthHeaders, pinnedUpstream, refreshLlmAuthHeaders, resolveModelAlias,
  stripCacheControl, upstreamModelFor, type ModelRoutes,
} from "./llm-upstream.ts";
import { GROQ_MODEL_ID } from "./model-router.ts";
import { repairToolArgs, resolveToolName } from "./tool-arg-repair.ts";

export type AiTask =
  | "summary"
  | "classification"
  | "json_extraction"
  | "chat_simple"
  | "daily_briefing"
  | "alert_explanation"
  | "code_analysis"
  | "architecture_reasoning"
  | "security_review"
  | "dependency_risk"
  | "refactor_suggestion"
  | "sql_review"
  | "content_generation"
  | "marketing_advice";

const GROQ_TASKS: AiTask[] = [
  "summary",
  "classification",
  "json_extraction",
  "chat_simple",
  "daily_briefing",
  "alert_explanation",
  "content_generation",
  "marketing_advice",
  // For now the code scan analysis runs on Groq too (faster, no DeepSeek dependency).
  "code_analysis",
];

/** La route de modèle d'une tâche, quand elle en a une (voir ModelRoutes dans
 *  llm-upstream) : le code au modèle de code, le raisonnement d'architecture
 *  au lourd. Les autres prennent le modèle courant. */
const TASK_ROUTES: Partial<Record<AiTask, string>> = {
  code_analysis: "@code|standard",
  refactor_suggestion: "@code|standard",
  sql_review: "@code|standard",
  security_review: "@code|heavy",
  dependency_risk: "@code|standard",
  architecture_reasoning: "@heavy",
};

/** Everything runs on DeepSeek while Groq is out of the rotation (see
 *  model-router's GROQ_ENABLED). GROQ_TASKS above is kept as the routing table
 *  to restore, not as a live decision. */
export function routeAiRequest(_task: AiTask): "groq" | "deepseek" {
  return "deepseek";
}

interface CallOpts {
  task: AiTask;
  systemPrompt: string;
  userPrompt: string;
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Override the model for this call (e.g. a stronger reasoning model). */
  model?: string;
  /** Force a specific provider, bypassing task-based routing. */
  provider?: "groq" | "deepseek";
  /** Route to a custom OpenAI-compatible endpoint (e.g. a self-hosted RunPod
   *  model) instead of the provider's default URL/key. `provider` is still used
   *  only for cost labelling. */
  endpoint?: EndpointOverride;
}

/** A custom OpenAI-compatible chat endpoint (base URL ending at /v1). `routes`
 *  are its models per tier/criterion (aiops_providers.config.model_routes): an
 *  alias request (`@code|heavy`) resolves against them, `model` being the
 *  fallback. */
export interface EndpointOverride { baseUrl: string; apiKey?: string; model?: string; routes?: ModelRoutes }

/** The model an endpoint answers a request with: the route an alias names
 *  when the endpoint has routes, its own model otherwise. */
function endpointModel(ep: EndpointOverride | undefined, requested?: string): string | undefined {
  if (!ep) return undefined;
  if (ep.routes && requested && isModelAlias(requested)) return resolveModelAlias(requested, ep.routes, ep.model) ?? ep.model;
  return ep.model;
}
const chatCompletionsUrl = (baseUrl: string) => `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

/** The deployment's pinned upstream as an endpoint, when there is one. Treated
 *  like any custom endpoint downstream (`pinned`: no squeeze-to-Groq budget, no
 *  cross-provider failover); its credentials are added by postChat. */
function pinnedEndpoint(requestedModel?: string): EndpointOverride | undefined {
  const up = pinnedUpstream();
  return up ? { baseUrl: up.baseUrl, model: upstreamModelFor(up, requestedModel) } : undefined;
}

interface ChatResponse {
  choices: { message: { content: string }; finish_reason?: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}

// Un seul identifiant Groq pour tout le code : celui du routeur. Le doublon
// codé ici a survécu à l'arrêt de llama-3.3-70b-versatile chez Groq.
const GROQ_MODEL = GROQ_MODEL_ID;
const DEEPSEEK_MODEL = "deepseek-chat";

/** Un modèle demandé qu'on peut envoyer tel quel. Les alias de fournisseur et
 *  celui du palier léger n'en sont pas : sans passerelle imposée, le
 *  fournisseur garde son modèle par défaut. */
function concreteModel(model?: string): string | undefined {
  // Une route (`@light`, `@code|heavy`…) n'est pas un modèle : sans passerelle
  // ni connecteur pour la traduire, le fournisseur garde son modèle par défaut.
  return model && model !== "groq" && model !== "deepseek" && model !== LIGHT_MODEL && !isModelAlias(model) ? model : undefined;
}

export async function callAi(opts: CallOpts): Promise<{ content: string; provider: "groq" | "deepseek"; model: string; usage?: ChatResponse["usage"] }> {
  // Admin kill-switch: set LLM_GLOBAL_BLOCK=1 to immediately prevent any LLM calls.
  if (Deno.env.get("LLM_GLOBAL_BLOCK") === "1") {
    throw new Error("LLM calls are disabled by environment (LLM_GLOBAL_BLOCK=1)");
  }
  const provider = opts.provider ?? routeAiRequest(opts.task);
  // Sans modèle imposé, la TÂCHE choisit sa route : une analyse de code va au
  // modèle de code du connecteur s'il en a un. Sans passerelle ni connecteur
  // pour la traduire, la route est ignorée (concreteModel).
  const requested = opts.model ?? TASK_ROUTES[opts.task];
  const ep = opts.endpoint ?? pinnedEndpoint(requested);
  const apiKey = ep ? (ep.apiKey ?? "") : (provider === "groq" ? Deno.env.get("GROQ_API_KEY") : Deno.env.get("DEEPSEEK_API_KEY"));
  if (!ep && !apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY is not configured`);

  const url = ep
    ? chatCompletionsUrl(ep.baseUrl)
    : provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.deepseek.com/chat/completions";
  const model = endpointModel(ep, requested) ?? concreteModel(requested) ?? (provider === "groq" ? GROQ_MODEL : DEEPSEEK_MODEL);

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1500,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  // Plain text goes through completeChat so a max_tokens cut-off
  // (finish_reason==="length") is transparently continued and stitched. jsonMode
  // can't be safely stitched across continuations, so it stays single-shot.
  // Both reuse postChat's retry/backoff + malformed-call recovery.
  const send = (u: string, k: string, b: Record<string, unknown>) =>
    (opts.jsonMode ? postChat(u, k, b, { registered: !!opts.endpoint }) : completeChat(u, k, b, { registered: !!opts.endpoint }));

  let json: ToolChatResponse;
  try {
    json = await send(url, apiKey ?? "", body);
  } catch (e) {
    // Ces appels-là sont des one-shot courts (résumés, classements, briefings) :
    // ils tiennent sans effort dans la fenêtre de Groq. Quand le compte DeepSeek
    // est à sec, les laisser mourir arrêterait la moitié du produit — briefing
    // quotidien, génération marketing, extraction — pour une raison qui n'a rien
    // à voir avec eux.
    const groqKey = Deno.env.get("GROQ_API_KEY");
    if (!(e instanceof ProviderExhaustedError) || ep || provider !== "deepseek" || !groqKey) throw e;
    json = await send(TOOL_ENDPOINTS.groq, groqKey, { ...body, model: GROQ_MODEL });
    const fallbackContent = json.choices?.[0]?.message?.content ?? "";
    return { content: fallbackContent, provider: "groq", model: json.model ?? GROQ_MODEL, usage: json.usage };
  }
  const content = json.choices?.[0]?.message?.content ?? "";
  return { content, provider, model: json.model ?? model, usage: json.usage };
}

// ---------------------------------------------------------------------------
// Tool-calling loop (OpenAI-compatible). Used by the assistant agent so it can
// query project data, read the web, search RAG, and emit artifacts.
// ---------------------------------------------------------------------------

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON schema
  };
  /** The description carries a REQUIRED output contract (a JSON schema, an enum,
   *  a format the model must reproduce exactly). compactToolDefs must never
   *  truncate it — a half-sent schema is worse than no schema, because the model
   *  is still told to follow one. Stripped before the request leaves. */
  incompressible?: boolean;
}

/** Truncate the MIDDLE, keeping both ends. A tool result carries its verdict at
 *  the end as often as at the start (exit codes, stack traces, totals), so
 *  head-only truncation silently drops the answer. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  return `${s.slice(0, head)}\n…[${s.length - max} caractères coupés au milieu]…\n${s.slice(-tail)}`;
}

/** Max size of a single tool result carried into the transcript. Tools that can
 *  emit more declare a `compress` (see internal-agent-tools.ts) that shrinks
 *  their own output deterministically under this cap; anything else gets the
 *  generic middle-cut below. */
export const TOOL_RESULT_CAP = 12_000;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** Ce que l'exécution d'UN appel reçoit en plus de ses arguments. `signal`
 *  s'interrompt quand le tour doit s'arrêter (échéance, annulation) : un outil
 *  qui l'écoute s'arrête proprement, les autres sont abandonnés après le délai
 *  d'arrêt coopératif (COOPERATIVE_STOP_MS). */
export interface ToolCallContext { signal?: AbortSignal; callId?: string }

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  call?: ToolCallContext,
) => Promise<string>;

const TOOL_ENDPOINTS = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
} as const;

/** Le résultat posé à la place d'un résultat d'outil qui n'est jamais arrivé. */
export const MISSING_TOOL_RESULT =
  "ERROR: aucun résultat pour cet appel — il a été interrompu (worker arrêté, contexte coupé ou annulation). Son effet est INCONNU : vérifie l'état avant de le relancer.";

/**
 * L'invariant de l'API : chaque message assistant porteur d'appels d'outils est
 * suivi, immédiatement, d'un message `tool` par appel — et aucun message `tool`
 * n'existe sans son appel. Une compaction, une coupe de contexte ou un tick
 * interrompu peuvent casser une paire, et le fournisseur refuse alors TOUTE la
 * requête (400 « tool_calls must be followed by tool messages »).
 *
 * Un appel sans résultat reçoit un résultat d'erreur SYNTHÉTIQUE, comme le fait
 * yieldMissingToolResultBlocks (superharness). On supprimait l'appel avant :
 * dans un groupe de quatre lectures dont une seule manquait, les trois
 * résultats obtenus partaient avec lui, et le modèle ne savait plus qu'il avait
 * tenté quoi que ce soit — il le refaisait. Les résultats orphelins, eux,
 * restent retirés : sans leur appel, ils ne disent rien d'exploitable.
 *
 * Rend le tableau d'origine quand il est déjà valide (rien n'est copié).
 */
export function repairToolPairing(
  msgs: ChatMessage[],
  /** Le résultat connu d'un appel dont le message a été perdu (registre des
   *  appels, voir CallLedger) ; sans lui, le résultat synthétique d'erreur. */
  recovered?: (callId: string) => string | undefined,
): ChatMessage[] {
  let dirty = false;
  const out: ChatMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const tc = m.role === "assistant" ? m.tool_calls : undefined;
    if (tc?.length) {
      const toolMsgs: ChatMessage[] = [];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === "tool") { toolMsgs.push(msgs[j]); j++; }
      const byId = new Map<string, ChatMessage>();
      for (const t of toolMsgs) if (t.tool_call_id && !byId.has(t.tool_call_id)) byId.set(t.tool_call_id, t);
      const complete = toolMsgs.length === tc.length && tc.every((c) => byId.has(c.id));
      out.push(m);
      if (complete) {
        out.push(...toolMsgs);
      } else {
        dirty = true;
        for (const c of tc) {
          out.push(byId.get(c.id) ?? { role: "tool", tool_call_id: c.id, content: recovered?.(c.id) ?? MISSING_TOOL_RESULT });
          byId.delete(c.id); // un id répété dans les appels n'est répondu qu'une fois
        }
      }
      i = j - 1; // les messages tool du groupe sont consommés
    } else if (m.role === "tool") {
      dirty = true; // résultat orphelin : son appel a disparu
    } else {
      out.push(m);
    }
  }
  return dirty ? out : msgs;
}

const ensureToolPairing = repairToolPairing;

// Keep more, and keep it longer, than we used to (5 × 350 chars). A research
// run reads pages worth thousands of characters and writes its report from
// them: a 350-char stub erased the figures three rounds after fetching them,
// and the agent re-searched what it had already found. Affordable now that an
// over-budget request compacts and fails over instead of dying (see
// chatWithinBudget) — the ceiling is enforced there, not by starving every run.
//
// The cut moves in STEPS, not one result at a time (superharness: never change
// a byte already sent). Cutting "everything but the last 8" re-stubs one more
// result on every round, and the first changed byte is where the provider's
// prefix cache stops: the last ~8 results were re-billed in full each round.
// Snapped to multiples of `step`, the stubbed span — hence the cached prefix —
// changes once every `step` results; between two steps only the new round is
// uncached. The cost is up to `step - 1` extra full results, mostly served from
// cache. The over-budget passes use step 1: there, size wins over cache.
const MICROCOMPACT_STEP = 6;
export function shrinkOldToolResults(msgs: ChatMessage[], keepRecentTools = 6, stub = 700, step = MICROCOMPACT_STEP): ChatMessage[] {
  const toolPositions: number[] = [];
  for (let i = 0; i < msgs.length; i++) if (msgs[i].role === "tool") toolPositions.push(i);
  const excess = toolPositions.length - keepRecentTools;
  const cut = excess > 0 ? Math.floor(excess / Math.max(1, step)) * Math.max(1, step) : 0;
  if (cut <= 0) return msgs;
  const cutoff = toolPositions[cut];
  return msgs.map((m, i) =>
    (m.role === "tool" && i < cutoff && (m.content?.length ?? 0) > stub)
      ? { ...m, content: truncateMiddle(m.content as string, stub) }
      : m,
  );
}

// ── Over-budget recovery ─────────────────────────────────────────────────────
// A transcript that no longer fits is squeezed in escalating passes rather than
// abandoned. Each pass keeps the system prompt and the most recent exchanges —
// what the model needs to act next — and sacrifices the middle, which is where
// re-readable detail (old tool payloads) lives.

/** Rough token count. Deliberately pessimistic (3.4 chars/token instead of the
 *  usual 4) so the pre-flight guard fires slightly early rather than late. */
function estimateTokens(body: unknown): number {
  return Math.ceil(JSON.stringify(body).length / 3.4);
}

/** What one request may weigh, per provider. Groq's on-demand tier caps tokens
 *  PER MINUTE (12k on the free plan) and rejects anything above it outright, so
 *  in practice that is a per-request ceiling; DeepSeek has a 64k window. */
const REQUEST_TOKEN_BUDGET: Record<"groq" | "deepseek", number> = {
  groq: 10_000,
  deepseek: 48_000,
};

/** Squeeze pass `n` of the transcript. Pairing is re-established by the caller. */
function squeeze(msgs: ChatMessage[], pass: number): ChatMessage[] {
  if (pass === 0) return shrinkOldToolResults(msgs, 2, 200, 1);
  if (pass === 1) {
    return shrinkOldToolResults(msgs, 1, 120, 1).map((m) =>
      m.role !== "system" && typeof m.content === "string" && m.content.length > 4000
        ? { ...m, content: truncateMiddle(m.content, 4000) }
        : m);
  }
  // Last resort: keep the brief (system + first user turn) and the tail, drop
  // the middle behind an explicit marker so the model knows history is missing.
  const base = shrinkOldToolResults(msgs, 1, 120, 1);
  const head: ChatMessage[] = [];
  let i = 0;
  while (i < base.length && (base[i].role === "system" || head.length < 2)) { head.push(base[i]); i++; }
  const tail = base.slice(-8);
  if (head.length + tail.length >= base.length) return base;
  return [
    ...head,
    { role: "user", content: `[${base.length - head.length - tail.length} messages intermédiaires coupés — contexte trop long pour le modèle. Appuie-toi sur ce qui suit.]` } as ChatMessage,
    ...tail,
  ];
}

interface BudgetedChat {
  json: ToolChatResponse;
  /** Provider actually used — a failover swaps it. */
  provider: "groq" | "deepseek";
  model: string;
}

/**
 * Send a chat request, compacting (then failing over) when the provider says it
 * is too large.
 *
 * `build` is called with the messages to send, so every retry rebuilds the body
 * with the same tools/params around a smaller transcript.
 */
async function chatWithinBudget(opts: {
  url: string; apiKey: string | undefined; provider: "groq" | "deepseek"; model: string;
  /** Set for a custom endpoint — no failover then: the caller pinned a host. */
  pinned: boolean;
  messages: ChatMessage[];
  build: (msgs: ChatMessage[], model: string) => Record<string, unknown>;
  onNotice?: (n: { type: "tool_error" | "info"; message: string; detail?: string }) => Promise<void>;
  /** Échéance dure de chaque requête (voir postChat). */
  deadlineAt?: number;
  stats?: HarnessStats;
  /** Un connecteur enregistré par l'espace (AI Ops) : voir assertAllowedLlmUrl. */
  registered?: boolean;
  /** La réponse en flux (voir StreamSink). */
  stream?: StreamSink;
  onRetry?: SendOpts["onRetry"];
  /** Rempli avec la taille (caractères) du corps réellement envoyé : avec les
   *  tokens facturés, il donne le vrai taux du modèle (context-checkpoint). */
  sent?: { chars: number };
}): Promise<BudgetedChat> {
  const budget = REQUEST_TOKEN_BUDGET[opts.provider];
  const sendOpts: SendOpts = { deadlineAt: opts.deadlineAt, stats: opts.stats, registered: opts.registered, stream: opts.stream, onRetry: opts.onRetry };
  const chat = (u: string, k: string, b: Record<string, unknown>) => {
    if (opts.sent) opts.sent.chars = JSON.stringify(b).length;
    return completeChat(u, k, b, sendOpts);
  };
  const deepseekKey = opts.pinned ? null : Deno.env.get("DEEPSEEK_API_KEY") ?? null;
  const groqKey = opts.pinned ? null : Deno.env.get("GROQ_API_KEY") ?? null;
  const canFailover = !opts.pinned && opts.provider === "groq" && !!deepseekKey;
  // La bascule inverse n'existait pas : DeepSeek portait tout le trafic (voir
  // routeAiRequest), et le jour où son compte tombe à sec, TOUS les agents
  // s'arrêtent d'un coup. Groq ne remplace pas DeepSeek — sa fenêtre est cinq
  // fois plus étroite — mais un run qui continue en écrivant moins vaut mieux
  // qu'un run qui meurt sur un 402.
  const canFallBackToGroq = !opts.pinned && opts.provider === "deepseek" && !!groqKey;
  let msgs = ensureToolPairing(shrinkOldToolResults(opts.messages));

  // Pre-flight: a body we can already see is over budget is squeezed before the
  // round trip, so the common case costs no failed request at all.
  if (!opts.pinned) {
    for (let pass = 0; pass < 3 && estimateTokens(opts.build(msgs, opts.model)) > budget; pass++) {
      msgs = ensureToolPairing(squeeze(msgs, pass));
    }
    // Still over after squeezing? Don't mutilate the transcript to fit a narrow
    // tier — move the work to the provider that has room, keeping the context
    // the agent needs. (Groq's 12k-TPM on-demand tier cannot hold an agent
    // transcript plus its toolset; DeepSeek's 64k window can.)
    if (canFailover && estimateTokens(opts.build(msgs, opts.model)) > budget) {
      const full = ensureToolPairing(shrinkOldToolResults(opts.messages));
      await opts.onNotice?.({
        type: "info",
        message: "Bascule sur DeepSeek : le contexte dépasse le quota de tokens de Groq.",
      }).catch(() => {});
      return {
        json: await chat(TOOL_ENDPOINTS.deepseek, deepseekKey!, opts.build(full, DEEPSEEK_MODEL)),
        provider: "deepseek",
        model: DEEPSEEK_MODEL,
      };
    }
  }

  let lastError: PayloadTooLargeError | null = null;
  for (let pass = 0; pass < 3; pass++) {
    try {
      return { json: await chat(opts.url, opts.apiKey ?? "", opts.build(msgs, opts.model)), provider: opts.provider, model: opts.model };
    } catch (e) {
      // Quota spent on this provider: squeezing cannot help and the reset is
      // half an hour away. Move the work, or say so plainly.
      if (e instanceof ProviderExhaustedError) {
        if (canFailover) {
          await opts.onNotice?.({
            type: "info",
            message: `Quota ${opts.provider} épuisé — bascule sur DeepSeek pour la suite du run.`,
          }).catch(() => {});
          return {
            json: await chat(TOOL_ENDPOINTS.deepseek, deepseekKey!, opts.build(msgs, DEEPSEEK_MODEL)),
            provider: "deepseek",
            model: DEEPSEEK_MODEL,
          };
        }
        if (canFallBackToGroq) {
          // Groq tient 10k tokens là où DeepSeek en tient 48k : envoyer le
          // transcrit tel quel se ferait refuser aussitôt. On le comprime
          // d'abord au budget de la destination — l'agent perd du contexte
          // ancien, il ne perd pas son run.
          let small = msgs;
          for (let pass = 0; pass < 3 && estimateTokens(opts.build(small, GROQ_MODEL)) > REQUEST_TOKEN_BUDGET.groq; pass++) {
            small = ensureToolPairing(squeeze(small, pass));
          }
          await opts.onNotice?.({
            type: "info",
            message: e.kind === "unfunded"
              ? "Crédits DeepSeek épuisés — bascule sur gpt-oss-120b (Groq) pour la suite du run. Rechargez le compte DeepSeek."
              : "Quota DeepSeek épuisé — bascule sur gpt-oss-120b (Groq) pour la suite du run.",
            detail: "Fenêtre plus étroite : le contexte le plus ancien a été compacté.",
          }).catch(() => {});
          return {
            json: await chat(TOOL_ENDPOINTS.groq, groqKey!, opts.build(small, GROQ_MODEL)),
            provider: "groq",
            model: GROQ_MODEL,
          };
        }
        throw e;
      }
      if (!(e instanceof PayloadTooLargeError)) throw e;
      lastError = e;
      msgs = ensureToolPairing(squeeze(msgs, pass));
      await opts.onNotice?.({
        type: "info",
        message: `Contexte trop long pour ${opts.model} — compaction et nouvelle tentative.`,
        detail: e.limit ? `limite ${e.limit} tokens, demandé ${e.requested}` : undefined,
      }).catch(() => {});
    }
  }

  // The provider refused even the squeezed transcript — move it, rather than
  // failing a run over a rate tier.
  if (canFailover) {
    await opts.onNotice?.({
      type: "info",
      message: "Bascule sur DeepSeek : la requête dépasse le quota de tokens de Groq.",
      detail: lastError?.limit ? `Groq : limite ${lastError.limit} tokens/min, demandé ${lastError.requested}` : undefined,
    }).catch(() => {});
    const json = await chat(TOOL_ENDPOINTS.deepseek, deepseekKey!, opts.build(msgs, DEEPSEEK_MODEL));
    return { json, provider: "deepseek", model: DEEPSEEK_MODEL };
  }
  throw lastError ?? new PayloadTooLargeError("le contexte dépasse la fenêtre du modèle", null, null);
}

// ---------------------------------------------------------------------------
// Briques communes des deux boucles d'outils (callAiWithTools, runToolRounds).
//
// Elles étaient écrites deux fois, à la main, et avaient déjà divergé : la
// réparation des noms soudés à leurs arguments n'existait pas dans la vidange
// de fin de boucle, et la réponse finale forcée repartait vers le fournisseur
// INITIAL même après une bascule. Une seule version maintenant.
// ---------------------------------------------------------------------------

type ToolCall = NonNullable<ChatMessage["tool_calls"]>[number];

/** Consommation cumulée d'une boucle. `cached_tokens` : la part de l'entrée
 *  servie par le cache de préfixe du fournisseur (Azure, DeepSeek), facturée
 *  une fraction du prix — sans elle, le coût d'un long run est surestimé et
 *  son budget coupe trop tôt. */
export interface LoopUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  /** Le coût FACTURÉ, quand le fournisseur le donne (Runware : `usage.cost`,
   *  en dollars). Ne vaut que si `unpriced_calls` est à zéro : un seul appel
   *  sans coût rendrait la somme fausse, l'estimation reprend alors la main. */
  reported_cost_usd: number;
  /** Appels dont la réponse n'a pas dit ce qu'ils coûtaient. */
  unpriced_calls: number;
}

/**
 * Ce que le harnais a dû rattraper pendant une boucle — l'équivalent des
 * événements que superharness journalise à chaque reprise. Sans ces compteurs,
 * un fournisseur qui renvoie un 503 une fois sur dix ou des outils qui
 * dépassent le temps du tick ne se voyaient qu'à la fin, quand un run échouait.
 * Mutés en place par les briques qui reprennent (postChat, runOneTool…).
 */
export interface HarnessStats {
  /** Nouvelles tentatives d'appel de modèle (panne, rafale, coupure réseau). */
  retries: number;
  /** Requêtes de modèle coupées faute de réponse dans le délai. */
  request_timeouts: number;
  /** Appels d'outil coupés par la limite de sortie, relancés avec plus de place. */
  output_escalations: number;
  /** `max_tokens` réduit pour tenir dans la fenêtre au lieu de compacter. */
  output_fits: number;
  /** Outils abandonnés à l'échéance du tick. */
  tool_timeouts: number;
  /** Appels refusés avant exécution : arguments contraires au schéma. */
  invalid_args: number;
  /** Appels dont les arguments ont été RÉPARÉS d'après le schéma (tool-arg-repair). */
  args_repaired: number;
  /** Appels à un nom d'outil inconnu, redirigés vers l'outil voulu. */
  tools_aliased: number;
  /** Tours servis en streaming. */
  streamed_rounds: number;
  /** Appels d'outil lancés PENDANT le flux, avant la fin de la réponse. */
  early_tools: number;
  /** Flux coupés après le début de la réponse : le tour garde ce qui était arrivé. */
  stream_interruptions: number;
  /** Outils arrêtés : signal d'arrêt envoyé, puis abandon après le délai coopératif. */
  tool_stops: number;
}

/**
 * Les arguments d'un appel, ou la raison pour laquelle on ne peut pas s'en
 * servir. Avant, un JSON illisible devenait `{}` et l'outil partait sans ses
 * paramètres : il échouait sur « champ manquant », et le modèle ne savait
 * jamais que c'était SON appel qui était cassé. Le cas typique : un livrable
 * long dont l'argument `content` est coupé net par la limite de sortie
 * (`finish_reason: length`).
 */
export function parseToolArgs(
  raw: string | undefined,
  truncated = false,
): { args: Record<string, unknown>; error?: undefined } | { args?: undefined; error: string } {
  const text = (raw ?? "").trim();
  if (!text) return { args: {} };
  try {
    let v = JSON.parse(text);
    // Un objet encodé deux fois ("{\"q\":\"x\"}") : la racine est une chaîne
    // qui contient l'objet. Réparé ici, comme le fait tool-input-repair.
    if (typeof v === "string" && /^\s*\{/.test(v)) v = JSON.parse(v);
    if (v && typeof v === "object" && !Array.isArray(v)) return { args: v as Record<string, unknown> };
  } catch { /* traité ci-dessous */ }
  return {
    error: truncated
      ? "ERROR: les arguments de cet appel ont été coupés par la limite de sortie du modèle (JSON incomplet) — l'outil n'a PAS été exécuté. Refais l'appel avec un contenu plus court : découpe un long texte en plusieurs appels (report_section section par section, puis create_deliverable)."
      : "ERROR: les arguments de cet appel ne sont pas un objet JSON valide — l'outil n'a PAS été exécuté. Refais l'appel avec un objet JSON correct ({\"param\": valeur}).",
  };
}

interface ToolChatResponse {
  choices: { message: ChatMessage; finish_reason?: string }[];
  usage?: {
    prompt_tokens: number; completion_tokens: number; total_tokens: number;
    /** OpenAI / Azure : la part de l'entrée servie par le cache de préfixe. */
    prompt_tokens_details?: { cached_tokens?: number };
    /** DeepSeek : la même information, sous son nom. */
    prompt_cache_hit_tokens?: number;
    /** Runware : le coût facturé de l'appel, en dollars. */
    cost?: number;
  };
  model: string;
}

// Groq/Llama sometimes emit a tool call as text — "<function=NAME>{json}" — and
// the API rejects it with 400 tool_use_failed, exposing the attempt in
// `failed_generation`. Recover it into a proper tool_calls response so the loop
// can run the tool instead of crashing the whole chat.
function recoverFailedToolCall(rawBody: string): ToolChatResponse | null {
  try {
    const err = JSON.parse(rawBody)?.error;
    if (!err) return null;

    // Pattern: "attempted to call tool 'toolName{args}' which was not in request.tools"
    // The model fused the tool name with its arguments.
    if (err.message && /which was not in request\.tools/.test(err.message)) {
      const m = err.message.match(/call tool '([a-zA-Z_]+)(\{[\s\S]*?\})'/);
      if (m) {
        const name = m[1];
        const args = m[2];
        return {
          choices: [{ message: {
            role: "assistant", content: null,
            tool_calls: [{ id: `recovered_${Date.now()}`, type: "function", function: { name, arguments: args } }],
          } }],
          usage: undefined,
          model: "recovered",
        };
      }
    }

    if (err.code !== "tool_use_failed" || !err.failed_generation) return null;
    let gen: string = err.failed_generation;
    // Some providers double-escape the failed generation (\" instead of "). If
    // there are no real quotes but plenty of escaped ones, unescape first.
    if (!gen.includes('"') && gen.includes('\\"')) {
      gen = gen.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
    }

    // Find the function name from any of the shapes the models emit:
    //   <function=NAME>{...}</function>
    //   <function=NAME>{...}
    //   {"name":"NAME","arguments":{...}}  (sometimes wrapped in <function>…)
    let name: string | null = null;
    let argText = "";

    const tag = gen.match(/<function\s*=\s*([a-zA-Z0-9_-]+)\s*>([\s\S]*?)(?:<\/function>|$)/);
    if (tag) {
      name = tag[1];
      argText = tag[2] || "";
    } else {
      const nameMatch = gen.match(/"name"\s*:\s*"([a-zA-Z0-9_-]+)"/);
      if (nameMatch) {
        name = nameMatch[1];
        const argMatch = gen.match(/"(?:arguments|parameters)"\s*:\s*(\{[\s\S]*)/);
        argText = argMatch ? argMatch[1] : gen;
      }
    }
    if (!name) return null;

    // Isolate the first balanced JSON object in argText.
    const args = extractFirstJsonObject(argText) ?? "{}";

    return {
      choices: [{ message: {
        role: "assistant", content: null,
        tool_calls: [{ id: `recovered_${Date.now()}`, type: "function", function: { name, arguments: args } }],
      } }],
      model: "recovered",
    } as ToolChatResponse;
  } catch { return null; }
}

// Pull the first syntactically-valid {...} object out of an arbitrary string by
// scanning for balanced braces (handles trailing junk like </function>).
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try { JSON.parse(slice); return slice; } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * The provider refused the request because it is too big — either for the
 * model's context window, or (Groq's on-demand tier) for the per-minute token
 * allowance, which rejects the WHOLE call rather than queueing it.
 *
 * Typed, because the answer is never "retry the same payload": the caller has
 * to shrink the transcript, and failing that switch to a provider with room.
 * Retrying blind is what turned a 15k-token prompt into a 12-minute run that
 * died as "worker timed out".
 */
export class PayloadTooLargeError extends Error {
  readonly requested: number | null;
  readonly limit: number | null;
  constructor(detail: string, requested: number | null, limit: number | null) {
    super(`payload too large: ${detail.slice(0, 200)}`);
    this.name = "PayloadTooLargeError";
    this.requested = requested;
    this.limit = limit;
  }
}

/** Providers word this a dozen ways; match the meaning, not one vendor's text. */
const OVERSIZE_RE = /request too large|reduce your message size|too many tokens|maximum context length|context[_ ]length[_ ]exceeded|prompt is too long|tokens per minute/i;

/**
 * The provider will not serve this request for a while — a daily or minute
 * token quota is spent. Distinct from PayloadTooLargeError: shrinking changes
 * nothing, and distinct from a transient 429, because the wait is measured in
 * tens of minutes. The only useful answer is another provider.
 */
export class ProviderExhaustedError extends Error {
  constructor(readonly provider: string, detail: string, readonly kind: "quota" | "unfunded" = "quota") {
    // Deux causes, deux phrases : un quota se rouvre tout seul, un compte à sec
    // demande une carte bancaire. Les confondre ferait attendre un utilisateur
    // devant un compteur qui ne repartira jamais.
    super(
      kind === "unfunded"
        ? `Les crédits ${provider} sont épuisés. Rechargez le compte chez le fournisseur, ou choisissez l'autre modèle dans le sélecteur du composer. Détail : ${detail.slice(0, 200)}`
        : `provider ${provider} exhausted: ${detail.slice(0, 200)}`,
    );
    this.name = "ProviderExhaustedError";
  }
}

/** A quota that resets in more than a minute is not something a run can wait
 *  out; a short burst limit still deserves the normal backoff. */
const QUOTA_RE = /tokens per day|TPD|requests per day|RPD|quota exceeded|insufficient_quota/i;

/** Le compte n'a plus d'argent — DeepSeek répond 402 « Insufficient Balance »,
 *  les passerelles compatibles OpenAI répondent 429 `insufficient_quota` ou
 *  402. Aucun de ces cas ne se répare en attendant ni en compactant. */
const UNFUNDED_RE = /insufficient balance|insufficient_quota|insufficient funds|payment required|billing|not enough credit|credit balance is too low/i;

function exhaustedFrom(status: number, body: string): "quota" | "unfunded" | null {
  if (status === 402 || (UNFUNDED_RE.test(body) && (status === 400 || status === 402 || status === 403 || status === 429))) {
    return "unfunded";
  }
  if (status !== 429) return null;
  if (QUOTA_RE.test(body)) return "quota";
  const wait = /try again in (\d+)m/i.exec(body);
  return wait && Number(wait[1]) >= 1 ? "quota" : null;
}

/** Le nom du fournisseur tel qu'un humain le lira, déduit de l'URL : postChat
 *  ne connaît qu'un endpoint, et une erreur qui dit « provider unknown » ne
 *  vaut pas mieux que pas d'erreur du tout. */
function providerFromUrl(url: string): string {
  if (url.includes("deepseek")) return "DeepSeek";
  if (url.includes("groq")) return "Groq";
  if (url.includes("runware")) return "Runware";
  if (url.includes("openrouter")) return "OpenRouter";
  try { return new URL(url).host; } catch { return "le fournisseur"; }
}
function oversizeFrom(status: number, body: string): PayloadTooLargeError | null {
  if (status !== 413 && !(OVERSIZE_RE.test(body) && (status === 400 || status === 429))) return null;
  const m = /Limit\s+(\d+),\s*Requested\s+(\d+)/i.exec(body);
  return new PayloadTooLargeError(body, m ? Number(m[2]) : null, m ? Number(m[1]) : null);
}

// ── Nouvelles tentatives (withRetry, superharness) ─────────────────────────
//
// Trois essais à 0,5 s puis 1 s, sans aléa, sans lire Retry-After, et aucune
// relance sur une coupure réseau (fetch levait, l'erreur remontait telle quelle
// et le tick partait en « erreur passagère » pour trois minutes). Surtout, AUCUN
// délai : une requête qui ne répondait jamais tenait jusqu'à ce que le runtime
// tue le worker à 150 s, avec tout le tick.

/** Ce qu'il faut au moins devant soi pour qu'une tentative vaille la peine. */
const MIN_ATTEMPT_MS = 5_000;
/** Plafond d'une attente entre deux tentatives : au-delà, ce n'est plus une
 *  rafale mais un quota, et le tick a mieux à faire que dormir. */
const MAX_RETRY_WAIT_MS = 60_000;
/** Plancher du plafond de sortie quand on le réduit pour tenir dans la fenêtre. */
const MIN_OUTPUT_TOKENS = 3_000;

const envNumber = (key: string, fallback: number): number => {
  const raw = (Deno.env.get(key) ?? "").trim();
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** Le plus long délai qu'un minuteur accepte (au-delà, Node le ramène à 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;

export interface SendOpts {
  /** Epoch ms : une tentative en vol est coupée à cette heure, aucune nouvelle
   *  ne part s'il ne reste pas MIN_ATTEMPT_MS, et on ne dort jamais au-delà. */
  deadlineAt?: number;
  /** Compteurs de reprise de la boucle appelante (relances, délais…). */
  stats?: HarnessStats;
  /** L'appel vise le connecteur que l'espace a choisi pour l'agent (AI Ops). */
  registered?: boolean;
  /** La réponse en flux (SSE) : le texte au fil de l'eau, et chaque appel
   *  d'outil dès qu'il est complet. Absent : réponse d'un bloc, comme avant. */
  stream?: StreamSink;
  /** Le hook model.retry (harness-hooks.ts) : peut refuser une nouvelle
   *  tentative ou changer son délai. */
  onRetry?: (e: { attempt: number; status: number | null; error: string; delayMs: number }) => { retry: boolean; delayMs: number };
}

// ── Le flux (SSE) ────────────────────────────────────────────────────────────
//
// La réponse arrive token par token au lieu d'un bloc : le texte s'affiche au
// fil de l'eau, et surtout chaque appel d'outil est rendu DÈS qu'il est complet
// — un appel l'est quand le suivant commence, ou quand la réponse finit — pour
// que l'outil parte pendant que le modèle écrit encore la suite.
//
// La réponse assemblée a exactement la forme d'une réponse d'un bloc : tout ce
// qui est au-dessus (compaction, relance de sortie, suite d'un texte coupé)
// ne voit pas la différence.
//
// Un flux coupé APRÈS avoir rendu quelque chose (du texte, un appel lancé) n'est
// jamais rejoué : des outils tournent peut-être déjà. La réponse partielle est
// rendue avec `finish_reason: "interrupted"` et ne garde que les appels complets.
// Coupé AVANT : c'est une panne comme une autre, rejouée par postChat.

export interface StreamSink {
  /** Le texte de la réponse depuis son début (cumulé, pas le seul delta). */
  onText?: (text: string) => void;
  /** Un appel d'outil complet (ses arguments sont un JSON valide). */
  onToolCall?: (call: ToolCall) => void;
}

/** Le streaming, sauf LLM_STREAM=0. */
export const streamingEnabled = (): boolean => (Deno.env.get("LLM_STREAM") ?? "").trim() !== "0";

/** Silence maximal entre deux morceaux d'un flux avant de le tenir pour mort. */
const STREAM_IDLE_MS = Number(Deno.env.get("LLM_STREAM_IDLE_MS")) || 90_000;

class StreamBrokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamBrokenError";
  }
}

interface StreamedChat {
  json: ToolChatResponse;
  /** Quelque chose a été rendu à l'appelant (texte ou appel d'outil). */
  emitted: boolean;
}

/** Lit une réponse SSE de chat (format OpenAI) et l'assemble. */
async function readChatStream(
  body: ReadableStream<Uint8Array>,
  sink: StreamSink,
  ctl: AbortController,
  idleMs = STREAM_IDLE_MS,
): Promise<StreamedChat> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let model = "";
  let finish: string | undefined;
  let usage: ToolChatResponse["usage"];
  const calls: ToolCall[] = [];
  const emitted = new Set<number>();
  /** Les appels dont l'identifiant vient du fournisseur (pas d'un repli local). */
  const providerIds = new Set<number>();
  let textEmitted = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort("idle"), idleMs);
  };
  const emitUpTo = (end: number) => {
    for (let i = 0; i < Math.min(end, calls.length); i++) {
      const c = calls[i];
      if (!c || emitted.has(i) || !c.function.name) continue;
      if (parseToolArgs(c.function.arguments).error !== undefined) continue;
      emitted.add(i);
      try { sink.onToolCall?.(c); } catch { /* un consommateur en erreur n'arrête pas le flux */ }
    }
  };
  const anyEmitted = () => textEmitted || emitted.size > 0;
  const assemble = (finishReason: string | undefined): ToolChatResponse => {
    // Interrompu : seuls les appels COMPLETS (déjà rendus) sont gardés.
    const kept = finishReason === "interrupted" ? calls.filter((_, i) => emitted.has(i)) : calls.filter(Boolean);
    const message: ChatMessage = { role: "assistant", content: content || null, ...(kept.length ? { tool_calls: kept } : {}) };
    return { choices: [{ message, finish_reason: finishReason }], usage, model };
  };

  const handle = (data: string) => {
    let obj: Record<string, any>;
    try { obj = JSON.parse(data); } catch { return; }
    if (obj.error) throw new StreamBrokenError(`flux en erreur : ${String(obj.error?.message ?? JSON.stringify(obj.error)).slice(0, 300)}`);
    if (typeof obj.model === "string" && !model) model = obj.model;
    if (obj.usage) usage = obj.usage;
    const ch = obj.choices?.[0];
    if (!ch) return;
    const d = ch.delta ?? ch.message ?? {};
    if (typeof d.content === "string" && d.content) {
      content += d.content;
      textEmitted = true;
      try { sink.onText?.(content); } catch { /* idem */ }
    }
    for (const tc of (Array.isArray(d.tool_calls) ? d.tool_calls : [])) {
      // Sans `index` (certains fournisseurs) : un nouvel identifiant ouvre un
      // nouvel appel, sinon le morceau continue le dernier.
      let idx: number;
      if (Number.isInteger(tc.index)) idx = tc.index;
      else {
        const last = calls.length - 1;
        idx = last < 0 ? 0 : tc.id && providerIds.has(last) && calls[last].id !== tc.id ? last + 1 : last;
      }
      // Un nouvel appel commence : tous ceux d'avant sont complets.
      if (idx > 0) emitUpTo(idx);
      let cur = calls[idx];
      if (!cur) {
        cur = { id: tc.id || `call_${idx}_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: "", arguments: "" } };
        calls[idx] = cur;
        if (tc.id) providerIds.add(idx);
      } else if (tc.id && !providerIds.has(idx)) {
        cur.id = tc.id;
        providerIds.add(idx);
      }
      const fname = tc.function?.name;
      if (typeof fname === "string" && fname) {
        if (!cur.function.name) cur.function.name = fname;
        else if (fname !== cur.function.name) cur.function.name += fname;
      }
      if (typeof tc.function?.arguments === "string") cur.function.arguments += tc.function.arguments;
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  };

  armIdle();
  try {
    let over = false;
    while (!over) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") { buf = ""; over = true; break; }
        handle(data);
      }
    }
    if (over) await reader.cancel().catch(() => {});
    if (buf.trim().startsWith("data:")) {
      const data = buf.trim().slice(5).trim();
      if (data && data !== "[DONE]") handle(data);
    }
  } catch (e) {
    if (anyEmitted()) {
      emitUpTo(calls.length);
      return { json: assemble("interrupted"), emitted: true };
    }
    throw e instanceof StreamBrokenError ? e : new StreamBrokenError(
      ctl.signal.aborted ? `flux coupé (${String(ctl.signal.reason ?? "délai")})` : `flux coupé : ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(idle);
    try { reader.releaseLock(); } catch { /* déjà relâché */ }
  }
  // Fin normale : les appels restants sont complets — sauf le dernier d'une
  // réponse coupée par la limite (`length`), que parseToolArgs refusera.
  emitUpTo(calls.length);
  return { json: assemble(finish ?? (calls.length ? "tool_calls" : "stop")), emitted: anyEmitted() };
}

/**
 * Le délai avant la tentative n° `attempt` (1 = première relance). Le serveur a
 * le dernier mot : `retry-after-ms` (Azure, OpenAI), puis `retry-after` en
 * secondes ou en date HTTP. Sinon 500 ms × 2^(n-1), plafonné à 32 s, plus 0 à
 * 25 % d'aléa pour que des runs relancés ensemble ne retombent pas ensemble.
 */
export function retryDelayMs(attempt: number, headers?: Headers | null): number {
  const ms = Number(headers?.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const ra = headers?.get("retry-after");
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s) && s >= 0) return s * 1000;
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const base = Math.min(envNumber("LLM_RETRY_BASE_MS", 500) * 2 ** Math.max(0, attempt - 1), 32_000);
  return base + Math.random() * 0.25 * base;
}

/** Une réponse en erreur qui vaut une nouvelle tentative. Le serveur décide
 *  quand il le dit (`x-should-retry`) ; sinon : délai dépassé (408), conflit
 *  (409), rafale (429 — les quotas longs sont filtrés avant), panne (5xx). */
export function isRetryableStatus(status: number, headers?: Headers | null): boolean {
  const hint = headers?.get("x-should-retry");
  if (hint === "true") return true;
  if (hint === "false") return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * La fenêtre est dépassée de PEU : l'entrée tient, c'est la sortie demandée qui
 * déborde. Inutile de compacter le transcrit — on réduit `max_tokens` à ce qui
 * reste (fenêtre − entrée − 1000), si ça laisse au moins MIN_OUTPUT_TOKENS.
 * Formats reconnus : OpenAI / Azure (« maximum context length is N tokens …
 * (X in the messages, Y in the completion) ») et Anthropic (« input length and
 * `max_tokens` exceed context limit: X + Y > N »). Modifie `body` en place.
 */
export function fitOutputBudget(body: Record<string, unknown>, errorText: string): boolean {
  let limit = 0;
  let input = 0;
  const openai = /maximum context length is (\d+) tokens[\s\S]*?\((\d+) in the messages/i.exec(errorText);
  const anthropic = /exceed context limit:\s*(\d+)\s*\+\s*\d+\s*>\s*(\d+)/i.exec(errorText);
  if (openai) { limit = Number(openai[1]); input = Number(openai[2]); }
  else if (anthropic) { input = Number(anthropic[1]); limit = Number(anthropic[2]); }
  else return false;
  const key = "max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens" in body ? "max_tokens" : null;
  if (!key) return false;
  const available = limit - input - 1000;
  const current = Number(body[key]);
  if (!(available >= MIN_OUTPUT_TOKENS) || (Number.isFinite(current) && current <= available)) return false;
  body[key] = available;
  return true;
}

class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`pas de réponse en ${Math.round(timeoutMs / 1000)} s (requête coupée)`);
    this.name = "RequestTimeoutError";
  }
}

/** Une requête HTTP dont la réponse (corps compris) doit être là à temps.
 *  Avec un `sink`, une réponse SSE est lue en flux (readChatStream) ; une
 *  réponse JSON (fournisseur qui ignore `stream`) est lue d'un bloc. */
async function fetchTextWithin(
  url: string, init: RequestInit, timeoutMs: number, sink?: StreamSink,
): Promise<{ status: number; ok: boolean; headers: Headers; text: string; streamed?: StreamedChat }> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = Number.isFinite(timeoutMs) && timeoutMs < MAX_TIMER_MS
    ? setTimeout(() => { timedOut = true; ctrl.abort("timeout"); }, timeoutMs)
    : undefined;
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (sink && res.ok && res.body && /text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
      const streamed = await readChatStream(res.body, sink, ctrl);
      return { status: res.status, ok: true, headers: res.headers, text: "", streamed };
    }
    const text = await res.text();
    return { status: res.status, ok: res.ok, headers: res.headers, text };
  } catch (e) {
    if (timedOut) throw new RequestTimeoutError(timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function postChat(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  opts: SendOpts = {},
): Promise<ToolChatResponse> {
  let lastErr = "";
  // Every chat request of this module leaves through here, so this is where a
  // pinned deployment refuses any other host (llmAuthHeaders throws) and where
  // the body is adapted to Azure's dialect.
  // No key → no header at all. A self-hosted endpoint (vLLM/Ollama on the
  // company network) is often unauthenticated, and some of them reject a bare
  // "Bearer " outright.
  let authHeaders = await llmAuthHeaders(url, apiKey, { registered: opts.registered });
  const adapted = adaptChatBody(url, body);
  // Le flux est demandé seulement quand quelqu'un le lit. `include_usage` : le
  // dernier morceau porte la consommation, sans laquelle le coût du tour et la
  // mesure du contexte seraient perdus.
  let sink = opts.stream && streamingEnabled() ? opts.stream : undefined;
  if (sink) {
    adapted.stream = true;
    adapted.stream_options = { include_usage: true };
  }
  let payload = JSON.stringify(adapted);
  let streamRefused = false;
  const maxRetries = envNumber("LLM_MAX_RETRIES", 4);
  // Long par défaut : hors tick (appels annexes, génération d'un long texte),
  // une réponse lente mais légitime ne doit pas être coupée. Dans un tick,
  // c'est l'échéance (opts.deadlineAt) qui borne, bien avant.
  const requestTimeout = envNumber("LLM_REQUEST_TIMEOUT_MS", 180_000);
  let authRefreshed = false;
  let outputFitted = false;
  let cacheStripped = false;
  let timeouts = 0;
  const timeLeft = () => (opts.deadlineAt != null ? opts.deadlineAt - Date.now() : Infinity);
  /** Attend avant la tentative suivante ; faux s'il n'y a plus le temps. */
  let lastStatus: number | null = null;
  const backoff = async (attempt: number, headers: Headers | null): Promise<boolean> => {
    let wait = retryDelayMs(attempt, headers);
    // Le hook model.retry a le dernier mot sur « encore ? » et « dans combien ? ».
    if (opts.onRetry) {
      const d = opts.onRetry({ attempt, status: lastStatus, error: lastErr.slice(0, 300), delayMs: wait });
      if (!d.retry) return false;
      wait = d.delayMs;
    }
    if (wait > MAX_RETRY_WAIT_MS || wait + MIN_ATTEMPT_MS > timeLeft()) return false;
    await new Promise((r) => setTimeout(r, wait));
    if (opts.stats) opts.stats.retries++;
    return true;
  };

  for (let attempt = 1; ; attempt++) {
    const left = timeLeft();
    if (attempt > 1 && left < MIN_ATTEMPT_MS) break;
    let res: Awaited<ReturnType<typeof fetchTextWithin>>;
    try {
      res = await fetchTextWithin(url, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: payload,
        // Le délai réglé, borné par l'échéance — sans descendre sous
        // MIN_ATTEMPT_MS à cause d'elle : une tentative qui part a sa chance.
      }, Math.min(requestTimeout > 0 ? requestTimeout : Infinity, Math.max(MIN_ATTEMPT_MS, left)), sink);
    } catch (e) {
      lastStatus = null;
      // Coupure réseau, connexion réutilisée morte, ou requête coupée faute de
      // réponse : la même requête a toutes les chances de passer au 2e essai.
      // Une requête coupée pour délai n'est relancée qu'une fois : un serveur
      // bloqué se débloque au 2e essai, une génération simplement trop longue
      // pour le délai ne passera pas mieux au 5e.
      lastErr = e instanceof Error ? e.message : String(e);
      if (e instanceof RequestTimeoutError && opts.stats) opts.stats.request_timeouts++;
      if (e instanceof RequestTimeoutError && ++timeouts >= 2) break;
      if (attempt > maxRetries || !(await backoff(attempt, null))) break;
      continue;
    }
    if (res.ok && res.streamed) {
      if (opts.stats) opts.stats.streamed_rounds++;
      if (res.streamed.json.choices?.[0]?.finish_reason === "interrupted" && opts.stats) opts.stats.stream_interruptions++;
      return res.streamed.json;
    }
    if (res.ok) {
      try {
        return JSON.parse(res.text) as ToolChatResponse;
      } catch {
        lastErr = `${res.status} réponse illisible : ${res.text.slice(0, 120)}`;
        if (attempt > maxRetries || !(await backoff(attempt, res.headers))) break;
        continue;
      }
    }
    const text = res.text;
    lastErr = `${res.status} ${text}`;
    lastStatus = res.status;
    // Le flux refusé (fournisseur ou passerelle qui ne le prend pas) : la même
    // requête, d'un bloc, une fois. Le flux est un confort, jamais une condition.
    if (sink && !streamRefused && res.status === 400 && /stream/i.test(text)) {
      streamRefused = true;
      sink = undefined;
      delete adapted.stream;
      delete adapted.stream_options;
      payload = JSON.stringify(adapted);
      continue;
    }
    // La sortie demandée déborde la fenêtre, pas l'entrée : réduire max_tokens
    // suffit, une fois — avant d'y voir un contexte trop gros à compacter.
    if (!outputFitted && res.status === 400 && fitOutputBudget(adapted, text)) {
      outputFitted = true;
      if (opts.stats) opts.stats.output_fits++;
      payload = JSON.stringify(adapted);
      continue;
    }
    // Un point de cache refusé (modèle de repli, passerelle stricte) : on le
    // retire et on renvoie la même requête, une fois — le cache est une
    // économie, jamais une condition.
    if (!cacheStripped && res.status === 400 && /cache_control/i.test(text) && stripCacheControl(adapted)) {
      cacheStripped = true;
      payload = JSON.stringify(adapted);
      continue;
    }
    // Too big: surface it as its own failure so the caller can compact. Checked
    // before the 429 backoff below — a TPM rejection is reported as 429 by some
    // gateways, and sleeping does not make the payload any smaller.
    const oversize = oversizeFrom(res.status, text);
    if (oversize) throw oversize;
    // Compte à sec, ou quota journalier consommé : ni l'attente ni la
    // compaction n'y changent quoi que ce soit, et le seul geste utile est de
    // changer de fournisseur — ou de le dire. `exhaustedFrom` existait depuis
    // le début mais n'était appelée nulle part : la bascule prévue plus haut
    // (chatWithinBudget) ne pouvait donc jamais se déclencher, et un compte
    // épuisé remontait en « tool chat failed: 402 {...} » au milieu d'un run.
    const exhausted = exhaustedFrom(res.status, text);
    if (exhausted) throw new ProviderExhaustedError(providerFromUrl(url), text, exhausted);
    // Recover a malformed tool call (Groq tool_use_failed) instead of failing.
    if (res.status === 400) {
      const recovered = recoverFailedToolCall(text);
      if (recovered) return recovered;
    }
    // Jeton Entra révoqué ou expiré avant l'heure : on en redemande un, une fois.
    if (res.status === 401 && !authRefreshed) {
      authRefreshed = true;
      const fresh = await refreshLlmAuthHeaders(url, apiKey).catch(() => null);
      if (fresh) { authHeaders = fresh; continue; }
    }
    if (!isRetryableStatus(res.status, res.headers)) break;
    if (attempt > maxRetries || !(await backoff(attempt, res.headers))) break;
  }
  throw new Error(`tool chat failed: ${lastErr.slice(0, 300)}`);
}

// Continue a completion that was cut off at max_tokens. Models signal this with
// finish_reason==="length"; without continuation the agent silently hands back a
// half-written answer (the "ne génère pas complètement / ne continue pas" bug).
// We only stitch a truncated PLAIN-TEXT answer — a truncated tool call is left to
// the caller's malformed-tool-call recovery, since a half JSON arguments blob
// can't be concatenated. The caller's `messages` array is never mutated: the
// "continue" nudges live only in a local copy, and the returned response carries
// the fully stitched content in choices[0].message.content.
const CONTINUE_NUDGE =
  "Continue exactly where you left off. Do NOT repeat any text already written, do NOT restart, and do NOT add a preface — just carry on writing until the answer is complete.";

/** Ce qu'une suite de texte doit avoir devant elle pour être lancée. */
const MIN_CONTINUATION_MS = 15_000;

async function completeChat(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  opts: SendOpts & { maxContinuations?: number } = {},
): Promise<ToolChatResponse> {
  const json = await postChat(url, apiKey, body, opts);
  const choice = json.choices?.[0];
  const hasToolCalls = (m?: ChatMessage) => Array.isArray(m?.tool_calls) && (m!.tool_calls!.length > 0);
  if (!choice || choice.finish_reason !== "length" || hasToolCalls(choice.message)) return json;

  const usage: NonNullable<ToolChatResponse["usage"]> & { prompt_tokens_details: { cached_tokens: number } } = {
    prompt_tokens: json.usage?.prompt_tokens ?? 0,
    completion_tokens: json.usage?.completion_tokens ?? 0,
    total_tokens: json.usage?.total_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: json.usage?.prompt_tokens_details?.cached_tokens ?? json.usage?.prompt_cache_hit_tokens ?? 0 },
    // Le coût facturé n'a de sens que s'il est donné pour CHAQUE morceau.
    cost: json.usage?.cost,
  };
  const baseMessages = (body.messages as ChatMessage[]) ?? [];
  let full = choice.message?.content ?? "";
  let lastFinish: string | undefined = choice.finish_reason;

  for (let i = 0; i < (opts.maxContinuations ?? 4); i++) {
    // Une suite qui n'a pas le temps de finir ne fait que risquer le tout :
    // on rend le texte déjà écrit, marqué coupé (finish_reason "length").
    if (opts.deadlineAt != null && opts.deadlineAt - Date.now() < MIN_CONTINUATION_MS) break;
    // Drop tools during a text continuation so the model just finishes writing
    // instead of restarting into a tool call.
    const contBody = {
      ...body,
      tools: undefined,
      tool_choice: undefined,
      messages: [
        ...baseMessages,
        { role: "assistant", content: full },
        { role: "user", content: CONTINUE_NUDGE },
      ],
    };
    let cont: ToolChatResponse;
    // Le flux de la suite s'affiche à la suite du texte déjà écrit.
    const already = full;
    const contOpts: SendOpts = opts.stream?.onText
      ? { ...opts, stream: { onText: (t) => opts.stream!.onText!(already + t) } }
      : { ...opts, stream: undefined };
    try {
      cont = await postChat(url, apiKey, contBody, contOpts);
    } catch (e) {
      // La première partie est déjà payée et lisible : une suite qui échoue ne
      // doit pas la jeter. Seules les erreurs typées (contexte trop gros, compte
      // à sec) remontent, l'appelant sait en faire quelque chose.
      if (e instanceof PayloadTooLargeError || e instanceof ProviderExhaustedError) throw e;
      break;
    }
    const cc = cont.choices?.[0];
    usage.prompt_tokens += cont.usage?.prompt_tokens ?? 0;
    usage.completion_tokens += cont.usage?.completion_tokens ?? 0;
    usage.total_tokens += cont.usage?.total_tokens ?? 0;
    usage.prompt_tokens_details.cached_tokens += cont.usage?.prompt_tokens_details?.cached_tokens ?? cont.usage?.prompt_cache_hit_tokens ?? 0;
    usage.cost = usage.cost != null && cont.usage?.cost != null ? usage.cost + cont.usage.cost : undefined;
    full += cc?.message?.content ?? "";
    lastFinish = cc?.finish_reason;
    if (lastFinish !== "length") break;
  }

  return {
    choices: [{ message: { ...(choice.message as ChatMessage), content: full }, finish_reason: lastFinish }],
    usage,
    model: json.model,
  };
}

export function safeParseJson<T>(raw: string): T | null {
  // Models sometimes wrap JSON in ```json ... ``` even with response_format.
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1]!.trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
