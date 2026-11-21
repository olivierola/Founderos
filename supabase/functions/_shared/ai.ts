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

interface ToolLoopOpts {
  provider?: "groq" | "deepseek";
  model?: string;            // override the provider's default model
  /** Route to a custom OpenAI-compatible endpoint (self-hosted RunPod model). */
  endpoint?: EndpointOverride;
  messages: ChatMessage[];
  tools: ToolDef[];
  executor: ToolExecutor;
  temperature?: number;
  maxTokens?: number;
  maxRounds?: number; // safety cap on tool-call iterations
  /** Epoch ms after which no new round starts: the loop stops calling tools and
   *  writes its answer from what it has. For callers running inside a bounded
   *  worker (sub-agents) — a result delivered short beats a result killed with
   *  the worker, whose spend is lost entirely. */
  deadlineAt?: number;
  /** Epoch ms : rien de ce que la boucle lance ne tourne au-delà. Une requête
   *  de modèle est coupée (et relancée seulement s'il reste du temps), un outil
   *  est abandonné avec un résultat d'erreur. Voir ToolRoundsOpts. */
  hardDeadlineAt?: number;
  /** Out-of-band notices (e.g. a detected incomplete/malformed tool call) so
   *  the caller can surface them in the run timeline. Best-effort. */
  onNotice?: (n: { type: "tool_error" | "info"; message: string; detail?: string }) => Promise<void>;
  /** Les outils qui peuvent tourner en parallèle (voir executeToolCalls). */
  parallelSafe?: ParallelSafe;
}

interface ToolLoopResult {
  /** Ce que le harnais a dû rattraper (relances, délais, arguments refusés…). */
  harness: HarnessStats;
  content: string;
  provider: "groq" | "deepseek";
  model: string;
  usage: LoopUsage;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

const TOOL_ENDPOINTS = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
} as const;

// Bound context growth on long runs: keep the most recent tool results in full
// but truncate OLDER ones to a short stub. We never drop messages, so message
// order and the assistant↔tool pairing required by the function-calling API are
// preserved. Applied to the payload sent each round (the stored history keeps
// full results).
// Trim tool SCHEMAS before sending them — they're re-sent on EVERY round, so a
// long description × ~40 tools is a large recurring input cost. The system
// prompt's capability tree already teaches usage, so the schema only needs a
// terse description + params. Enums/required are preserved (the API needs them).
//
// Ce raccourcissement est MESURÉ (AGENT_TOOL_DESC_MODE, voir toolDescVariant) :
// une description coupée à 140 caractères économise des tokens à chaque tour,
// mais peut coûter des appels mal choisis ou mal formés. En mode « full », les
// schémas partent tels quels (seul le marqueur `incompressible` est retiré).
export type ToolDescMode = "compact" | "full";

/**
 * La variante de descriptions d'un run : `AGENT_TOOL_DESC_MODE` = compact |
 * full | ab (défaut : ab). En « ab », la moitié des runs (empreinte stable de
 * leur identifiant) reçoit les descriptions complètes : les compteurs du
 * harnais (arguments refusés, réparés, erreurs d'outil, tours) se comparent
 * ensuite par variante dans llm_usage.metadata.harness.tool_desc.
 */
export function toolDescVariant(runKey: string): ToolDescMode {
  const mode = (Deno.env.get("AGENT_TOOL_DESC_MODE") ?? "ab").trim().toLowerCase();
  if (mode === "compact" || mode === "full") return mode;
  let h = 2166136261;
  for (let i = 0; i < runKey.length; i++) h = Math.imul(h ^ runKey.charCodeAt(i), 16777619);
  return (h >>> 0) % 2 === 0 ? "compact" : "full";
}

const _compactCache = new WeakMap<ToolDef[], ToolDef[]>();
const _fullCache = new WeakMap<ToolDef[], ToolDef[]>();
function compactToolDefs(tools: ToolDef[], mode: ToolDescMode = "compact"): ToolDef[] {
  if (!Array.isArray(tools) || !tools.length) return tools;
  if (mode === "full") {
    const hit = _fullCache.get(tools);
    if (hit) return hit;
    const out = tools.map((t) => {
      const { incompressible: _i, ...rest } = t as ToolDef;
      return rest as ToolDef;
    });
    _fullCache.set(tools, out);
    return out;
  }
  const cached = _compactCache.get(tools);
  if (cached) return cached;
  const trim = (s: string | undefined, n: number) => {
    const c = (s ?? "").replace(/\s+/g, " ").trim();
    return c.length > n ? c.slice(0, n - 1).trimEnd() + "…" : c;
  };
  const out = tools.map((t) => {
    // `incompressible` is OUR marker, not part of the wire format — strip it here
    // (this is the last hop before the request body) and skip trimming entirely
    // for those tools, schema and parameter descriptions alike.
    const { incompressible, ...rest } = t as ToolDef;
    const fn = (rest as any).function ?? {};
    const params = fn.parameters as { properties?: Record<string, any> } | undefined;
    let properties = params?.properties;
    if (properties && typeof properties === "object" && !incompressible) {
      const np: Record<string, any> = {};
      for (const [k, v] of Object.entries(properties)) {
        const vv = { ...(v as any) };
        if (typeof vv.description === "string") vv.description = trim(vv.description, 80);
        np[k] = vv;
      }
      properties = np;
    }
    if (incompressible) return { ...rest } as ToolDef;
    return {
      ...rest,
      function: { ...fn, description: trim(fn.description, 140), parameters: properties ? { ...params, properties } : params },
    } as ToolDef;
  });
  _compactCache.set(tools, out);
  return out;
}

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

const newUsage = (): LoopUsage => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, reported_cost_usd: 0, unpriced_calls: 0 });

function addUsage(total: LoopUsage, u: ToolChatResponse["usage"] | undefined): void {
  if (!u) { total.unpriced_calls++; return; }
  total.prompt_tokens += u.prompt_tokens ?? 0;
  total.completion_tokens += u.completion_tokens ?? 0;
  total.total_tokens += u.total_tokens ?? 0;
  total.cached_tokens += u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const cost = Number(u.cost);
  if (u.cost != null && Number.isFinite(cost) && cost >= 0) total.reported_cost_usd += cost;
  else total.unpriced_calls++;
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

export const newHarnessStats = (): HarnessStats => ({
  retries: 0, request_timeouts: 0, output_escalations: 0, output_fits: 0, tool_timeouts: 0, invalid_args: 0,
  args_repaired: 0, tools_aliased: 0, streamed_rounds: 0, early_tools: 0, stream_interruptions: 0, tool_stops: 0,
});

/** Additionne des compteurs (ceux d'un tick à ceux du run, par exemple). */
export function addHarnessStats(into: HarnessStats, from: Partial<HarnessStats> | undefined): HarnessStats {
  if (!from) return into;
  for (const k of Object.keys(into) as Array<keyof HarnessStats>) into[k] += Number(from[k]) || 0;
  return into;
}

/** Le coût d'une boucle tel que le fournisseur l'a facturé, ou null s'il ne
 *  l'a pas dit pour chaque appel. */
export function reportedCostUsd(u: LoopUsage | undefined): number | null {
  return u && u.unpriced_calls === 0 && u.reported_cost_usd > 0 ? u.reported_cost_usd : null;
}

/** Les appels d'outil d'une réponse : les vrais, sinon ceux qui ont fui dans le
 *  texte (le DSML de DeepSeek, le <function=…> de Groq). Un nom soudé à ses
 *  arguments (`http_get{"url":…}`, chez Groq) est recousu. */
function toolCallsOf(message: ChatMessage | undefined, tag: string): ToolCall[] {
  let calls: ToolCall[] = message?.tool_calls ?? [];
  if (!calls.length && message?.content) {
    calls = parseEmbeddedToolCalls(message.content).map((r, i) => ({
      id: `${tag}_${i}`,
      type: "function" as const,
      function: { name: r.name, arguments: JSON.stringify(r.args) },
    }));
  }
  for (const call of calls) {
    const raw = call.function.name ?? "";
    const braceIdx = raw.indexOf("{");
    if (braceIdx > 0) {
      call.function.name = raw.slice(0, braceIdx);
      try {
        const embedded = JSON.parse(raw.slice(braceIdx));
        call.function.arguments = JSON.stringify({ ...embedded, ...JSON.parse(call.function.arguments || "{}") });
      } catch { /* garder l'original */ }
    }
  }
  return calls;
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

/** Dit si un outil peut tourner en même temps que ses voisins : il ne fait que
 *  lire, et ne partage aucun état (pas de navigateur, pas de toolset modifié). */
export type ParallelSafe = (name: string) => boolean;

/** Lectures simultanées au plus, dans un même tour. */
const PARALLEL_TOOL_LIMIT = 4;

const CONTROL_FLOW_ERRORS = new Set(["RunCancelledError", "AwaitingInputError", "AwaitingApprovalError"]);

/** Ce qu'un outil reçoit au moins quand il part juste avant l'échéance. */
const MIN_TOOL_MS = 1_000;

/**
 * Ce que le schéma d'un outil permet de refuser AVANT de l'exécuter
 * (validateInput, superharness) : un paramètre obligatoire absent, une valeur
 * hors de son enum. Volontairement étroit — pas de contrôle de type : un outil
 * qui reçoit "5" pour un nombre le convertit, et le refuser coûterait un tour
 * pour rien. Ce qui est vérifié ici ferait échouer l'outil de toute façon, mais
 * avec un message propre à chaque outil, ou pas de message du tout (une
 * recherche lancée sur `undefined`). Rend la liste des problèmes, vide si rien.
 */
export function validateToolArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): string[] {
  if (!schema || typeof schema !== "object") return [];
  const props = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, { enum?: unknown[] } | undefined>;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === "string") : [];
  const issues: string[] = [];
  for (const k of required) {
    if (args[k] === undefined || args[k] === null) issues.push(`« ${k} » est obligatoire`);
  }
  for (const [k, v] of Object.entries(args)) {
    // Après réparation (tool-arg-repair), un nombre ou un booléen encore écrit
    // autrement n'a pas pu être compris : l'outil échouerait de toute façon.
    // Les chaînes restent tolérantes (un nombre là où un texte est attendu passe).
    const t = (props[k] as { type?: unknown } | undefined)?.type;
    if ((t === "number" || t === "integer") && v !== null && v !== undefined && typeof v !== "number" && !(typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))) {
      issues.push(`« ${k} » doit être un nombre (reçu ${JSON.stringify(v).slice(0, 60)})`);
      continue;
    }
    if (t === "boolean" && v !== null && v !== undefined && typeof v !== "boolean" && !/^(true|false)$/i.test(String(v))) {
      issues.push(`« ${k} » doit valoir true ou false (reçu ${JSON.stringify(v).slice(0, 60)})`);
      continue;
    }
    const allowed = props[k]?.enum;
    if (!Array.isArray(allowed) || allowed.length === 0 || v === undefined || v === null || typeof v === "object") continue;
    const norm = (x: unknown) => String(x).trim().toLowerCase();
    if (!allowed.some((e) => norm(e) === norm(v))) {
      issues.push(`« ${k} » doit valoir l'une de ces valeurs : ${allowed.slice(0, 12).map((e) => JSON.stringify(e)).join(", ")} (reçu ${JSON.stringify(v).slice(0, 60)})`);
    }
  }
  return issues;
}

/** Le schéma des paramètres d'un outil, d'après la liste envoyée au modèle. */
export type ToolSchemaLookup = (name: string) => Record<string, unknown> | undefined;

export function schemaLookup(tools: ToolDef[]): ToolSchemaLookup {
  const byName = new Map<string, Record<string, unknown>>();
  for (const t of tools) {
    const fn = (t as { function?: { name?: string; parameters?: Record<string, unknown> } }).function;
    if (fn?.name && fn.parameters) byName.set(fn.name, fn.parameters);
  }
  return (name) => byName.get(name);
}

/** Les noms d'outils d'une liste, pour reconnaître un appel à un nom inconnu. */
export function toolNames(tools: ToolDef[]): Set<string> {
  return new Set(tools.map((t) => (t as { function?: { name?: string } }).function?.name ?? "").filter(Boolean));
}

/** Ce qu'un outil a encore devant lui quand le signal d'arrêt part, avant
 *  d'être abandonné (OpenCode : COOPERATIVE_STOP, 5 s). */
export const COOPERATIVE_STOP_MS = 5_000;

/** Un run arrêté par l'utilisateur, levé par la boucle elle-même. */
class LoopCancelledError extends Error {
  constructor() {
    super("Run cancelled by user");
    this.name = "RunCancelledError";
  }
}

interface PreparedCall {
  parsed: ReturnType<typeof parseToolArgs>;
  /** Dit au modèle ce qui a été corrigé de son appel (un nom inconnu). */
  note?: string;
}

/**
 * Prépare un appel avant de l'exécuter, d'après tool-input-repair (OpenCode) :
 * un nom qui n'existe pas mais désigne clairement un outil de la boîte est
 * redirigé, et les arguments sont réparés d'après le schéma. L'appel est
 * corrigé EN PLACE dans le transcrit : le modèle relit sa demande telle
 * qu'elle a été exécutée, et apprend la bonne forme.
 */
function prepareCall(
  call: ToolCall,
  parsed: ReturnType<typeof parseToolArgs>,
  limits: { schemaOf?: ToolSchemaLookup; known?: (name: string) => boolean; stats?: HarnessStats },
): PreparedCall {
  if (parsed.error !== undefined) return { parsed };
  let note: string | undefined;
  const asked = call.function.name;
  if (limits.known) {
    const resolved = resolveToolName(asked, limits.known);
    if (resolved) {
      call.function.name = resolved;
      if (limits.stats) limits.stats.tools_aliased++;
      note = `[« ${asked} » n'existe pas dans ta boîte : l'appel a été exécuté avec « ${resolved} ». Utilise ce nom la prochaine fois.]\n`;
    }
  }
  const fixed = repairToolArgs(parsed.args, limits.schemaOf?.(call.function.name));
  if (fixed.repairs.length) {
    if (limits.stats) limits.stats.args_repaired++;
    call.function.arguments = JSON.stringify(fixed.args);
    return { parsed: { args: fixed.args }, note };
  }
  return { parsed, note };
}

async function runOneTool(
  executor: ToolExecutor,
  name: string,
  parsed: ReturnType<typeof parseToolArgs>,
  limits: {
    schemaOf?: ToolSchemaLookup; deadlineAt?: number; stats?: HarnessStats;
    /** Juste avant l'exécution, une fois les arguments acceptés : c'est là que
     *  le registre note le départ d'un appel à effet. */
    onStart?: () => Promise<void>;
    /** L'arrêt du tour (annulation) : relayé à l'outil, puis abandon après
     *  COOPERATIVE_STOP_MS s'il ne s'est pas arrêté de lui-même. */
    stop?: AbortSignal;
    callId?: string;
  } = {},
): Promise<string> {
  if (parsed.error !== undefined) return parsed.error;
  const issues = validateToolArgs(limits.schemaOf?.(name), parsed.args);
  if (issues.length) {
    if (limits.stats) limits.stats.invalid_args++;
    return `ERROR: arguments invalides pour ${name} — ${issues.join(" ; ")}. L'outil n'a PAS été exécuté : corrige les arguments et rappelle-le.`;
  }
  if (limits.onStart) await limits.onStart().catch(() => {});
  // Le signal de CET appel : coupé par l'arrêt du tour, ou juste avant
  // l'échéance — l'outil qui l'écoute a encore COOPERATIVE_STOP_MS pour
  // s'arrêter proprement (et rendre ce qu'il a) avant d'être abandonné.
  const ctl = new AbortController();
  const onStop = () => ctl.abort(limits.stop?.reason ?? "stop");
  if (limits.stop?.aborted) onStop();
  else limits.stop?.addEventListener("abort", onStop, { once: true });
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  try {
    const run = executor(name, parsed.args, { signal: ctl.signal, callId: limits.callId });
    if (limits.deadlineAt == null && !limits.stop) return await run;
    // Un outil qui ne rend pas la main avant l'échéance du tick l'emmènerait
    // avec lui : le worker est tué, et tout le tour en cours est perdu. On
    // l'abandonne à l'échéance, avec un résultat d'erreur que le modèle lit au
    // tour suivant — comme une erreur d'outil, jamais comme une panne de boucle.
    // Son exécution continue en arrière-plan : son rejet ne doit jamais
    // remonter sans gestionnaire.
    run.catch(() => {});
    const abandoned = new Promise<string>((resolve) => {
      if (limits.deadlineAt != null) {
        const waitMs = Math.max(MIN_TOOL_MS, limits.deadlineAt - Date.now());
        // Le signal part COOPERATIVE_STOP_MS avant l'abandon (jamais avant le
        // départ de l'outil) : l'échéance dure reste l'heure où plus rien ne
        // tourne.
        timers.push(setTimeout(() => ctl.abort("deadline"), Math.max(0, waitMs - COOPERATIVE_STOP_MS)));
        timers.push(setTimeout(() => {
          if (limits.stats) { limits.stats.tool_timeouts++; limits.stats.tool_stops++; }
          resolve(
            `ERROR: « ${name} » n'a pas répondu avant la fin du temps du tick (${Math.round(waitMs / 1000)} s) — l'appel a été abandonné. ` +
            "Son effet est INCONNU (il a pu aboutir en arrière-plan) : vérifie l'état avant de le relancer, et découpe le travail " +
            "(une commande longue part en arrière-plan avec run_background, une grosse requête se pagine).",
          );
        }, waitMs));
      }
      // L'arrêt demandé (annulation) : délai coopératif, puis abandon.
      const graceThenAbandon = () => {
        if (ctl.signal.reason === "deadline") return;
        timers.push(setTimeout(() => {
          if (limits.stats) limits.stats.tool_stops++;
          resolve(`ERROR: « ${name} » interrompu : le run a été arrêté pendant l'appel. Son effet est INCONNU.`);
        }, COOPERATIVE_STOP_MS));
      };
      if (ctl.signal.aborted) graceThenAbandon();
      else ctl.signal.addEventListener("abort", graceThenAbandon, { once: true });
    });
    return await Promise.race([run, abandoned]);
  } catch (e) {
    // Les signaux de contrôle (run annulé, attente d'un humain) remontent toute
    // la boucle ; le reste devient le résultat d'erreur de l'outil.
    if (CONTROL_FLOW_ERRORS.has((e as { name?: string } | null)?.name ?? "")) throw e;
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    for (const t of timers) clearTimeout(t);
    limits.stop?.removeEventListener("abort", onStop);
  }
}

/**
 * Exécute les appels d'une réponse et livre chaque résultat à `onResult`, DANS
 * L'ORDRE des appels — l'API exige un message `tool` par appel, dans l'ordre.
 *
 * Les appels consécutifs qui ne font que lire partent ensemble (quatre au
 * plus) : trois `web_search` et deux `read_url` demandés d'un coup coûtaient
 * la somme de leurs latences, dans un tick qui n'a que deux minutes. Tout le
 * reste (une écriture, un appel qui attend un humain, un outil à état) passe
 * seul, à son tour, comme avant. Les résultats d'un groupe sont livrés avant
 * que le groupe suivant ne parte : un signal de contrôle levé plus loin ne fait
 * pas perdre ce qui a déjà été exécuté.
 */
export async function executeToolCalls(
  calls: ToolCall[],
  executor: ToolExecutor,
  opts: {
    truncated?: boolean;
    parallelSafe?: ParallelSafe;
    /** Les schémas envoyés au modèle ce tour : un appel qui les enfreint est
     *  refusé avant exécution (validateToolArgs). */
    schemaOf?: ToolSchemaLookup;
    /** Échéance dure : un outil encore en cours est abandonné (runOneTool). */
    deadlineAt?: number;
    stats?: HarnessStats;
    /** Le registre des appels à effet (voir CallLedger). */
    ledger?: CallLedger;
    /** Les appels que le registre suit. Par défaut : tout ce qui n'est pas une
     *  lecture parallélisable. */
    effectful?: (name: string) => boolean;
    /** Les noms connus (toute la boîte, pas seulement les schémas du tour) :
     *  un nom inconnu qui en désigne un clairement est redirigé. */
    known?: (name: string) => boolean;
  },
  onResult: (call: ToolCall, args: Record<string, unknown>, result: string) => void,
): Promise<void> {
  // Préparés d'abord : un nom redirigé change ce qui est parallélisable.
  const parsed = calls.map((c) => prepareCall(c, parseToolArgs(c.function.arguments, opts.truncated), opts));
  const safe = (k: number) => !!opts.parallelSafe && parsed[k].parsed.error === undefined && opts.parallelSafe(calls[k].function.name);
  const effectful = opts.effectful ?? ((name: string) => !opts.parallelSafe?.(name));
  const ledger = opts.ledger;
  const run = async (c: ToolCall, prep: PreparedCall): Promise<string> => {
    const p = prep.parsed;
    const tracked = !!ledger && effectful(c.function.name);
    let started = false;
    const out = await runOneTool(executor, c.function.name, p, {
      schemaOf: opts.schemaOf, deadlineAt: opts.deadlineAt, stats: opts.stats, callId: c.id,
      onStart: tracked
        ? async () => { started = true; await ledger!.started({ id: c.id, name: c.function.name, args: p.args ?? {} }); }
        : undefined,
    });
    if (started) await ledger!.settled({ id: c.id, name: c.function.name }, out).catch(() => {});
    return prep.note ? `${out}\n\n${prep.note.trim()}` : out;
  };
  let i = 0;
  while (i < calls.length) {
    let j = i + 1;
    if (safe(i)) while (j < calls.length && j - i < PARALLEL_TOOL_LIMIT && safe(j)) j++;
    const group = calls.slice(i, j);
    const settled = await Promise.allSettled(group.map((c, k) => run(c, parsed[i + k])));
    for (let k = 0; k < settled.length; k++) {
      const s = settled[k];
      if (s.status === "rejected") throw s.reason;
      onResult(group[k], parsed[i + k].parsed.args ?? {}, s.value);
    }
    i = j;
  }
}

// ── L'ordonnanceur d'outils : tout en parallèle, par couloirs ───────────────
//
// D'après OpenCode : chaque appel part DÈS qu'il est complet dans le flux, et
// tous tournent ensemble. Un modèle qui émet plusieurs appels dans une même
// réponse ne connaît le résultat d'aucun : il les tient pour indépendants.
//
// Deux limites que l'original n'a pas besoin de connaître ici :
//   - les COULOIRS : des appels qui partagent un état (une seule session de
//     navigateur, l'état du run qu'on relit puis réécrit, un même monde
//     d'exécution) passent l'un après l'autre, dans l'ordre d'émission ; les
//     couloirs différents, et les appels sans couloir, tournent ensemble ;
//   - le DERNIER passage : un appel qui suspend le run pour un humain
//     (ask_user) attend que tous les autres aient fini, pour que leurs
//     résultats soient dans le transcrit quand le run se met en pause.
//
// Un signal de contrôle (pause, annulation) arrête les départs : ce qui tourne
// finit (ou s'arrête au signal), ce qui n'est pas parti reçoit un résultat
// « non exécuté », et le signal remonte une fois tous les résultats livrés.

/** Le couloir d'un outil, ou null : il tourne librement. */
export type ToolLane = (name: string) => string | null;

/** Appels simultanés au plus, par tour. */
const DEFAULT_TOOL_CONCURRENCY = Number(Deno.env.get("AGENT_TOOL_CONCURRENCY")) || 8;

const NOT_STARTED_RESULT =
  "ERROR: non exécuté — le tour s'est arrêté (pause ou annulation) avant le départ de cet appel. Relance-le si tu en as encore besoin.";

type Settled =
  | { kind: "done"; args: Record<string, unknown>; result: string }
  | { kind: "control"; error: unknown }
  | { kind: "skipped" };

export interface SchedulerOpts {
  executor: ToolExecutor;
  lane: ToolLane;
  /** Les appels qui ne partent qu'une fois tous les autres finis (ask_user). */
  runLast?: (name: string) => boolean;
  schemaOf?: ToolSchemaLookup;
  known?: (name: string) => boolean;
  deadlineAt?: number;
  stats?: HarnessStats;
  ledger?: CallLedger;
  effectful: (name: string) => boolean;
  maxConcurrency?: number;
  /** Interrogé pendant l'attente des outils : vrai = arrêt coopératif. */
  isCancelled?: () => Promise<boolean>;
}

export class ToolScheduler {
  private readonly runs = new Map<string, Promise<Settled>>();
  private readonly laneTails = new Map<string, Promise<unknown>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  /** Le signal de contrôle qui a arrêté les départs. */
  private halted: unknown = null;
  private readonly stopCtl = new AbortController();
  private readonly limit: number;
  constructor(private readonly opts: SchedulerOpts) {
    this.limit = Math.max(1, opts.maxConcurrency ?? DEFAULT_TOOL_CONCURRENCY);
  }

  has(id: string): boolean { return this.runs.has(id); }
  get started(): number { return this.runs.size; }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) { this.active++; return; }
    await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
  }
  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  /**
   * Lance un appel (une seule fois par identifiant). `gate` est ce qu'il doit
   * attendre avant de partir : la sauvegarde du transcrit pour un appel à
   * effet lancé pendant le flux.
   */
  start(call: ToolCall, gate?: Promise<unknown>, truncated = false): void {
    if (this.runs.has(call.id)) return;
    const prep = prepareCall(call, parseToolArgs(call.function.arguments, truncated), this.opts);
    const name = call.function.name;
    const laneKey = prep.parsed.error === undefined ? this.opts.lane(name) : null;
    const before = laneKey ? (this.laneTails.get(laneKey) ?? Promise.resolve()) : Promise.resolve();
    const p = (async (): Promise<Settled> => {
      await before.catch(() => {});
      if (gate) await gate.catch(() => {});
      if (this.halted) return { kind: "skipped" };
      await this.acquire();
      try {
        if (this.halted) return { kind: "skipped" };
        const out = await this.exec(call, prep);
        return { kind: "done", args: prep.parsed.args ?? {}, result: prep.note ? `${out}\n\n${prep.note.trim()}` : out };
      } catch (e) {
        if (!this.halted) this.halted = e;
        return { kind: "control", error: e };
      } finally {
        this.release();
      }
    })();
    if (laneKey) this.laneTails.set(laneKey, p);
    this.runs.set(call.id, p);
  }

  private async exec(call: ToolCall, prep: PreparedCall): Promise<string> {
    const o = this.opts;
    const name = call.function.name;
    const p = prep.parsed;
    const tracked = !!o.ledger && o.effectful(name);
    let started = false;
    const out = await runOneTool(o.executor, name, p, {
      schemaOf: o.schemaOf, deadlineAt: o.deadlineAt, stats: o.stats, stop: this.stopCtl.signal, callId: call.id,
      onStart: tracked
        ? async () => { started = true; await o.ledger!.started({ id: call.id, name, args: p.args ?? {} }); }
        : undefined,
    });
    if (started) await o.ledger!.settled({ id: call.id, name }, out).catch(() => {});
    return out;
  }

  /** Attend des appels en interrogeant l'annulation toutes les 2 s. */
  private async awaitAll(ids: string[]): Promise<void> {
    const all = Promise.all(ids.map((id) => this.runs.get(id)!));
    if (!this.opts.isCancelled) { await all; return; }
    let done = false;
    void all.finally(() => { done = true; });
    while (!done) {
      await Promise.race([all, new Promise((r) => setTimeout(r, 2_000))]);
      if (done || this.stopCtl.signal.aborted) continue;
      if (await this.opts.isCancelled().catch(() => false)) {
        if (!this.halted) this.halted = new LoopCancelledError();
        this.stopCtl.abort("cancelled");
      }
    }
  }

  /**
   * Lance ce qui ne l'est pas encore, attend tout, et livre les résultats
   * DANS L'ORDRE des appels (l'API exige un message `tool` par appel, dans
   * l'ordre). Relance le signal de contrôle une fois tout livré.
   */
  async settle(
    calls: ToolCall[],
    onResult: (call: ToolCall, args: Record<string, unknown>, result: string) => void,
    truncated = false,
  ): Promise<void> {
    const isLast = (c: ToolCall) => !!this.opts.runLast?.(c.function.name);
    const first = calls.filter((c) => !isLast(c));
    const last = calls.filter(isLast);
    for (const c of first) this.start(c, undefined, truncated);
    await this.awaitAll(first.map((c) => c.id));
    for (const c of last) this.start(c, undefined, truncated);
    await this.awaitAll(last.map((c) => c.id));
    for (const c of calls) {
      const s = await this.runs.get(c.id)!;
      if (s.kind === "done") onResult(c, s.args, s.result);
      else if (s.kind === "skipped") onResult(c, {}, NOT_STARTED_RESULT);
      // « control » : l'appel qui a levé le signal reste sans résultat — la
      // reprise (registre, ou MISSING_TOOL_RESULT) dira ce qu'il en est.
    }
    if (this.halted) throw this.halted;
  }
}

/**
 * Le registre des appels à effet (reprise exacte, d'après eve).
 *
 * Le transcrit est sauvegardé après chaque tour ; un worker tué PENDANT un tour
 * perdait pourtant la trace de ce que ce tour avait lancé, et la relivraison du
 * tick laissait le modèle refaire l'envoi, la publication, l'écriture. Le
 * registre note le départ d'un appel avant qu'il ne s'exécute, puis son
 * résultat. À la reprise, un appel dont le résultat a été perdu reçoit le
 * résultat enregistré (il a abouti) ou un avertissement daté (il a démarré,
 * son effet est inconnu) — jamais une nouvelle exécution à l'aveugle.
 *
 * Une écriture du registre qui échoue n'arrête rien : l'appel part, et la
 * reprise retombe sur MISSING_TOOL_RESULT, comme avant.
 */
export interface CallLedger {
  started(call: { id: string; name: string; args: Record<string, unknown> }): Promise<void>;
  settled(call: { id: string; name: string }, result: string): Promise<void>;
}

const MALFORMED_CALL_NUDGE =
  "Your previous message contained a PARTIAL or MALFORMED tool call that could not be executed (it looks truncated or used raw DSML/function-tag text). Re-issue it now as ONE complete, valid tool call via the proper tool-calling interface. Do not put any DSML, <function=…> or <invoke> markup in your text content.";

/** L'endpoint d'une boucle et la bascule de fournisseur en cours de route. */
function loopEndpoint(opts: { provider?: "groq" | "deepseek"; endpoint?: EndpointOverride; model?: string }, fallback: "groq" | "deepseek") {
  const provider = opts.provider ?? fallback;
  const ep = opts.endpoint ?? pinnedEndpoint(opts.model);
  const apiKey = ep ? (ep.apiKey ?? "") : (provider === "groq" ? Deno.env.get("GROQ_API_KEY") : Deno.env.get("DEEPSEEK_API_KEY"));
  if (!ep && !apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY is not configured`);
  const state = {
    pinned: !!ep,
    /** Le connecteur de l'agent (AI Ops), pas la passerelle imposée. */
    registered: !!opts.endpoint,
    provider,
    url: ep ? chatCompletionsUrl(ep.baseUrl) : TOOL_ENDPOINTS[provider],
    apiKey: apiKey as string | undefined,
    model: endpointModel(ep, opts.model) ?? concreteModel(opts.model) ?? (provider === "groq" ? GROQ_MODEL : DEEPSEEK_MODEL),
    /** Le modèle qui a réellement répondu (le fournisseur le précise). */
    answeredBy: "",
  };
  state.answeredBy = state.model;
  /** Suivre ce qui a réellement répondu : une bascule pour budget change de
   *  fournisseur, et la suite de la boucle doit y rester. */
  const adopt = (sent: BudgetedChat, usage: LoopUsage) => {
    if (sent.provider !== state.provider) {
      state.provider = sent.provider;
      state.url = TOOL_ENDPOINTS[sent.provider];
      state.apiKey = Deno.env.get(sent.provider === "groq" ? "GROQ_API_KEY" : "DEEPSEEK_API_KEY") ?? "";
      state.model = sent.model;
    }
    state.answeredBy = sent.json.model ?? state.model;
    addUsage(usage, sent.json.usage);
  };
  return { state, adopt };
}

/** Plafond de sortie de la relance d'un appel d'outil coupé (AGENT_ESCALATED_MAX_TOKENS). */
function escalatedMaxTokens(base: number): number {
  const configured = Number(Deno.env.get("AGENT_ESCALATED_MAX_TOKENS"));
  return Math.max(base, Number.isFinite(configured) && configured > 0 ? configured : 24_000);
}

/**
 * Envoie un tour, et le relance UNE fois avec un plafond de sortie plus haut
 * quand la réponse s'est arrêtée sur la limite (`finish_reason: length`) au
 * milieu d'un appel d'outil — ses arguments JSON sont alors incomplets
 * (superharness : 8k → 64k, une fois, avant toute autre récupération).
 *
 * Sans ça, l'outil n'était pas exécuté, le modèle recevait « arguments coupés,
 * découpe ton contenu », et payait un tour de plus pour réécrire en morceaux un
 * livrable que la même requête aurait fini avec un peu plus de place.
 *
 * La relance réécrit tout depuis le début : elle n'a lieu que si l'échéance
 * laisse le temps d'environ deux fois la réponse coupée. Sinon, le chemin
 * d'avant (l'erreur explicite au modèle) reste en place. La réponse coupée est
 * comptée dans la consommation : elle a été facturée.
 */
async function sendWithOutputEscalation(
  send: (maxTokens: number) => Promise<BudgetedChat>,
  base: number,
  account: (wasted: BudgetedChat) => void,
  opts: {
    deadlineAt?: number; onNotice?: ToolLoopOpts["onNotice"]; stats?: HarnessStats;
    /** Des appels de cette réponse sont déjà partis (flux) : la réécrire les
     *  ferait repartir. Pas de relance, le chemin d'avant s'applique. */
    dispatched?: () => boolean;
  },
): Promise<BudgetedChat> {
  const startedAt = Date.now();
  const sent = await send(base);
  const choice = sent.json.choices?.[0];
  if (choice?.finish_reason !== "length") return sent;
  if (opts.dispatched?.()) return sent;
  const calls = choice.message?.tool_calls ?? [];
  if (!calls.some((c) => parseToolArgs(c.function?.arguments).error !== undefined)) return sent;
  const target = escalatedMaxTokens(base);
  if (target <= base) return sent;
  const took = Date.now() - startedAt;
  if (opts.deadlineAt != null && Date.now() + 2 * took + MIN_ATTEMPT_MS > opts.deadlineAt) return sent;
  account(sent);
  if (opts.stats) opts.stats.output_escalations++;
  await opts.onNotice?.({
    type: "info",
    message: `Appel d'outil coupé par la limite de sortie (${base} tokens) — même requête relancée avec ${target}.`,
  }).catch(() => {});
  return await send(target);
}

export async function callAiWithTools(opts: ToolLoopOpts): Promise<ToolLoopResult> {
  // Admin kill-switch: set LLM_GLOBAL_BLOCK=1 to immediately prevent any LLM calls.
  if (Deno.env.get("LLM_GLOBAL_BLOCK") === "1") {
    throw new Error("LLM calls are disabled by environment (LLM_GLOBAL_BLOCK=1)");
  }
  const { state: ep, adopt } = loopEndpoint(opts, "groq");
  const messages = [...opts.messages];
  const usageTotal = newUsage();
  const harness = newHarnessStats();
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const maxRounds = opts.maxRounds ?? 6;
  let incompleteRetries = 0;
  const result = (content: string): ToolLoopResult =>
    ({ content, provider: ep.provider, model: ep.answeredBy, usage: usageTotal, toolCalls, harness });

  // Produce the final user-facing answer. Sanitises leaked tool-call markup; and
  // if the model used tools but ended with an EMPTY reply (e.g. its last output
  // was a pure leaked tool-call block that sanitising removed), force one
  // no-tools "write your summary now" call so the user never gets "(no reply)".
  // Sent to whatever answers NOW — after a failover, not the provider that failed.
  async function finalizeAnswer(rawContent: string | null | undefined): Promise<string> {
    let c = sanitizeLeakedToolCalls(rawContent ?? "");
    if (c || toolCalls.length === 0) return c;
    messages.push({
      role: "user",
      content: "You've finished using tools. Write your FINAL reply to the user now in markdown: a concise summary of what you did, the key results/findings, and any deliverables produced. Do NOT call any tools and do NOT output any tool-call markup.",
    });
    try {
      const sj = await completeChat(ep.url, ep.apiKey ?? "", { model: ep.model, messages: ensureToolPairing(messages), temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens ?? 4000 }, { deadlineAt: opts.hardDeadlineAt, stats: harness, registered: ep.registered });
      addUsage(usageTotal, sj.usage);
      c = sanitizeLeakedToolCalls(sj.choices?.[0]?.message?.content ?? "");
    } catch { /* keep fallback */ }
    return c || "Travail terminé — voir le détail des étapes et des livrables ci-dessus.";
  }

  const slimTools = compactToolDefs(opts.tools);
  const schemaOf = schemaLookup(slimTools);
  const baseMaxTokens = opts.maxTokens ?? 4000;
  const sendWith = (withTools: boolean, maxTokens: number) => chatWithinBudget({
    url: ep.url, apiKey: ep.apiKey, provider: ep.provider, model: ep.model, pinned: ep.pinned, registered: ep.registered,
    messages, onNotice: opts.onNotice, deadlineAt: opts.hardDeadlineAt, stats: harness,
    build: (msgs, m) => ({
      model: m,
      messages: msgs,
      ...(withTools ? { tools: slimTools, tool_choice: "auto" } : {}),
      temperature: opts.temperature ?? 0.3,
      max_tokens: maxTokens,
    }),
  });
  const send = (withTools: boolean) => withTools
    ? sendWithOutputEscalation((n) => sendWith(true, n), baseMaxTokens, (wasted) => adopt(wasted, usageTotal),
      { deadlineAt: opts.hardDeadlineAt ?? opts.deadlineAt, onNotice: opts.onNotice, stats: harness })
    : sendWith(false, baseMaxTokens);
  /** Echo the assistant message that requested the tools, then run them and
   *  append each result so the model can continue. */
  const runCalls = async (sent: BudgetedChat, calls: ToolCall[]) => {
    const choice = sent.json.choices?.[0];
    messages.push({ role: "assistant", content: choice?.message?.content ?? null, tool_calls: calls });
    await executeToolCalls(calls, opts.executor, {
      truncated: choice?.finish_reason === "length", parallelSafe: opts.parallelSafe,
      schemaOf, deadlineAt: opts.hardDeadlineAt, stats: harness,
    },
      (call, args, out) => {
        toolCalls.push({ name: call.function.name, args });
        // Cap tool output so a huge payload doesn't blow the context window.
        messages.push({ role: "tool", tool_call_id: call.id, content: truncateMiddle(out, TOOL_RESULT_CAP) });
      });
  };
  const outOfTime = () => opts.deadlineAt != null && Date.now() >= opts.deadlineAt;
  const stopForTime = async (): Promise<ToolLoopResult> => {
    await opts.onNotice?.({ type: "info", message: "Budget de temps atteint — synthèse de ce qui a déjà été trouvé." }).catch(() => {});
    return result(await finalizeAnswer(""));
  };

  for (let round = 0; round < maxRounds; round++) {
    if (round > 0 && outOfTime()) return await stopForTime();
    const sent = await send(true);
    adopt(sent, usageTotal);
    const message = sent.json.choices?.[0]?.message;
    const calls = toolCallsOf(message, `embedded_${round}`);

    // No tool calls. Before treating this as the final answer, detect a
    // MALFORMED / INCOMPLETE tool call leaked into the content (e.g. a DSML or
    // <function=…> fragment truncated mid-call). These silently stall agents.
    // Surface it and ask the model to re-issue the call cleanly (bounded retry).
    if (!calls.length) {
      if (hasToolCallMarkers(message?.content ?? "") && incompleteRetries < 2) {
        incompleteRetries++;
        await opts.onNotice?.({
          type: "tool_error",
          message: "Incomplete tool call detected — asking the agent to re-issue it cleanly",
          detail: String(message?.content ?? "").slice(0, 400),
        }).catch(() => {});
        messages.push({ role: "assistant", content: message?.content ?? "" });
        messages.push({ role: "user", content: MALFORMED_CALL_NUDGE });
        continue;
      }
      return result(await finalizeAnswer(message?.content));
    }
    await runCalls(sent, calls);
  }

  // Ran out of rounds. The model often tries ONE more tool call here, frequently
  // leaked as DSML text. Drain up to 2 more recovered calls so the agent doesn't
  // abandon work mid-flight, then force a clean (sanitized) final answer.
  for (let drain = 0; drain < 2; drain++) {
    if (outOfTime()) return await stopForTime();
    const drained = await send(true);
    adopt(drained, usageTotal);
    const message = drained.json.choices?.[0]?.message;
    const calls = toolCallsOf(message, `drain_${drain}`);
    if (!calls.length) return result(await finalizeAnswer(message?.content));
    await runCalls(drained, calls);
  }

  // Final answer, no tools.
  const closing = await send(false);
  adopt(closing, usageTotal);
  return result(await finalizeAnswer(closing.json.choices?.[0]?.message?.content));
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

// ---------------------------------------------------------------------------
// RESUMABLE tool loop — runs a BOUNDED number of rounds against an existing
// `messages` array and RETURNS the updated array + whether it finished. Used by
// the tick-based mission runtime: each tick runs a few rounds, persists the
// returned messages, and re-enqueues itself until `finished`. Control-flow
// errors (RunCancelled / AwaitingInput) propagate to the caller.
// ---------------------------------------------------------------------------
export interface ToolRoundsOpts {
  provider?: "groq" | "deepseek";
  model?: string;
  /** Route to a custom OpenAI-compatible endpoint (self-hosted RunPod model). */
  endpoint?: EndpointOverride;
  messages: ChatMessage[];
  /** A THUNK re-evaluated every round, so a tool can widen the exposed toolset
   *  mid-loop (need_tools / load_toolset) and the next round sees it. A plain
   *  array still works and is simply constant. */
  tools: ToolDef[] | (() => ToolDef[]);
  /** Optional first-call tool requirement for an explicit connected-app request. */
  toolChoice?: { type: "function"; function: { name: string } };
  executor: ToolExecutor;
  temperature?: number;
  maxTokens?: number;
  maxRounds: number; // budget for THIS tick
  /** Messages appended AT SEND TIME, after the transcript, and never stored.
   *  This is how situational context (the FOCUS recap) reaches the model without
   *  being written into `messages` — writing it in and pulling it back out on the
   *  next tick mutates the middle of the transcript, which invalidates the
   *  provider's prefix cache for everything after it. Appended last, it costs its
   *  own tokens each round but invalidates nothing. */
  ephemeral?: () => ChatMessage[];
  onNotice?: ToolLoopOpts["onNotice"];
  /** Epoch ms. Un tour ne démarre que s'il peut finir avant : on l'estime à la
   *  durée du tour le plus lent de cet appel (10 s au moins). Le premier tour
   *  part toujours, sinon un tick en retard ne ferait jamais rien. Le runtime
   *  tue le worker vers 150 s, et un tick tué perdait TOUT ce qu'il avait fait. */
  deadlineAt?: number;
  /** Epoch ms : au-delà, plus rien de ce tick ne tourne. `deadlineAt` dit quand
   *  ne plus COMMENCER un tour ; celle-ci dit quand tout doit être rendu : une
   *  requête de modèle encore en vol est coupée (et relancée seulement s'il
   *  reste du temps), un outil est abandonné avec une erreur que le modèle lira.
   *  Sans elle, une requête ou un outil bloqué tenait jusqu'à ce que le runtime
   *  tue le worker, et le tick entier était perdu. */
  hardDeadlineAt?: number;
  /** Appelée après chaque tour qui a exécuté des outils, avec la consommation
   *  cumulée. Le runtime y enregistre le transcrit : un worker tué ne perd plus
   *  que le tour en cours, et ne rejoue pas les actions des tours précédents.
   *  Une erreur ici n'arrête jamais la boucle. */
  onRoundEnd?: (progress: { roundsRun: number; usage: LoopUsage; provider: "groq" | "deepseek"; model: string }) => Promise<void>;
  /** Appelée quand le modèle a demandé au moins un appel à effet (`effectful`),
   *  APRÈS l'ajout de sa demande au transcrit et AVANT toute exécution. Le
   *  runtime y enregistre le transcrit : si le worker meurt pendant l'appel, la
   *  reprise sait qu'il a été demandé, au lieu de rappeler le modèle comme si de
   *  rien n'était. Une erreur ici n'arrête jamais la boucle. */
  onBeforeTools?: (progress: { roundsRun: number; usage: LoopUsage; provider: "groq" | "deepseek"; model: string }) => Promise<void>;
  /** Le registre des appels à effet (voir CallLedger). */
  ledger?: CallLedger;
  /** Ce qui compte comme appel à effet. Par défaut : tout ce qui n'est pas une
   *  lecture parallélisable (`parallelSafe`). */
  effectful?: (name: string) => boolean;
  parallelSafe?: ParallelSafe;
  /** Les couloirs d'exécution (ToolScheduler). Fournis : tous les appels d'un
   *  tour partent ensemble, dès leur arrivée dans le flux, sauf ceux d'un même
   *  couloir qui passent dans l'ordre. Absents : l'exécution d'avant (lectures
   *  groupées, le reste un par un). */
  lane?: ToolLane;
  /** Les appels qui attendent la fin de tous les autres (ask_user). */
  runLast?: (name: string) => boolean;
  /** Appels simultanés au plus (défaut AGENT_TOOL_CONCURRENCY, 8). */
  maxConcurrency?: number;
  /** Interrogé pendant l'attente des outils : vrai = arrêt coopératif du tour
   *  (signal aux outils, abandon après COOPERATIVE_STOP_MS), puis le run
   *  s'arrête comme annulé. */
  isCancelled?: () => Promise<boolean>;
  /** Toute la boîte, pas seulement les schémas du tour : la réparation et la
   *  validation des arguments, et la redirection d'un nom inconnu, s'appuient
   *  dessus (un outil différé reste appelable). */
  allTools?: ToolDef[] | (() => ToolDef[]);
  /** Réponse en flux (défaut : oui, sauf LLM_STREAM=0). */
  stream?: boolean;
  /** Le texte de la réponse au fil de l'eau (cumulé). Appelé souvent :
   *  l'appelant le limite lui-même s'il l'écrit quelque part. */
  onDelta?: (text: string) => void;
  /** Descriptions d'outils envoyées : coupées (défaut) ou complètes. */
  toolDescriptions?: ToolDescMode;
  /** Le hook model.retry (harness-hooks.ts). */
  onRetry?: SendOpts["onRetry"];
}
export interface ToolRoundsResult {
  messages: ChatMessage[];
  finished: boolean;
  /** Arrêté avant `maxRounds` parce que le tour suivant n'aurait pas fini à temps. */
  stoppedForTime?: boolean;
  content: string;
  roundsRun: number;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Tool results in THIS tick that came back as errors — drives re-planning. */
  errorCount: number;
  usage: LoopUsage;
  /** Ce que le harnais a dû rattraper pendant ce tick. */
  harness: HarnessStats;
  provider: "groq" | "deepseek";
  model: string;
  /** Le dernier tour mesuré : tokens facturés et taille de ce qui a été envoyé
   *  (voir PromptMeasure, context-checkpoint.ts). */
  measure?: { tokens: number; bodyChars: number; msgChars: number };
}

/** Durée qu'on prête à un tour avant d'en avoir mesuré un. */
const MIN_ROUND_MS = 10_000;

export async function runToolRounds(opts: ToolRoundsOpts): Promise<ToolRoundsResult> {
  if (Deno.env.get("LLM_GLOBAL_BLOCK") === "1") throw new Error("LLM calls are disabled (LLM_GLOBAL_BLOCK=1)");
  const { state: ep, adopt } = loopEndpoint(opts, "deepseek");
  const messages = opts.messages;
  const usage = newUsage();
  const harness = newHarnessStats();
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let pendingToolChoice = opts.toolChoice;
  let forcedChoiceRetries = 0;
  let incompleteRetries = 0;
  let interruptedRetries = 0;
  let roundsRun = 0;
  let errorCount = 0;
  let slowestRound = 0;
  let measure: ToolRoundsResult["measure"];
  const result = (finished: boolean, content: string, extra: Partial<ToolRoundsResult> = {}): ToolRoundsResult =>
    ({ messages, finished, content, roundsRun, toolCalls, errorCount, usage, harness, provider: ep.provider, model: ep.answeredBy, measure, ...extra });

  const descMode = opts.toolDescriptions ?? "compact";
  const resolveTools = () => compactToolDefs(typeof opts.tools === "function" ? opts.tools() : opts.tools, descMode);
  const effectful = opts.effectful ?? ((name: string) => !opts.parallelSafe?.(name));
  const streamOn = opts.stream ?? streamingEnabled();
  for (let round = 0; round < opts.maxRounds; round++) {
    if (round > 0 && opts.deadlineAt != null && Date.now() + Math.max(slowestRound, MIN_ROUND_MS) > opts.deadlineAt) {
      return result(false, "", { stoppedForTime: true });
    }
    const startedAt = Date.now();
    roundsRun++;
    // Order matters: the cached prefix is the transcript; ephemeral goes AFTER it.
    const ephemeral = opts.ephemeral?.() ?? [];
    // One toolset per round: what the model is shown is also what its calls are
    // checked against (and a squeeze retry re-sends the same schemas).
    const roundTools = resolveTools();
    // La boîte entière (outils différés compris) pour réparer, valider et
    // reconnaître un nom : un outil dont le schéma n'est pas parti ce tour
    // reste appelable, et son appel se répare comme les autres.
    const everyTool = opts.allTools ? (typeof opts.allTools === "function" ? opts.allTools() : opts.allTools) : null;
    const roundSchema = schemaLookup(roundTools);
    const allSchema = everyTool ? schemaLookup(everyTool) : null;
    const schemaOf: ToolSchemaLookup = (n) => roundSchema(n) ?? allSchema?.(n);
    const names = toolNames(roundTools);
    if (everyTool) for (const n of toolNames(everyTool)) names.add(n);
    const known = (n: string) => names.has(n);
    const progress = () => ({ roundsRun, usage, provider: ep.provider, model: ep.answeredBy });

    const scheduler = opts.lane
      ? new ToolScheduler({
        executor: opts.executor, lane: opts.lane, runLast: opts.runLast, schemaOf, known,
        deadlineAt: opts.hardDeadlineAt, stats: harness, ledger: opts.ledger, effectful,
        maxConcurrency: opts.maxConcurrency, isCancelled: opts.isCancelled,
      })
      : null;

    // ── Le flux : texte au fil de l'eau, outils lancés dès qu'ils sont complets.
    // Un appel À EFFET ne part qu'une fois sa demande SAUVEGARDÉE : la réponse
    // en cours entre dans le transcrit (message provisoire, complété à la fin
    // du flux) et le transcrit est enregistré avant son départ. Un worker tué
    // pendant l'appel laisse ainsi une demande que la reprise retrouve (registre
    // des appels), au lieu d'un modèle qui la referait sans le savoir.
    let provisional: ChatMessage | null = null;
    const arrived: ToolCall[] = [];
    let textSoFar = "";
    let saved: Promise<unknown> = Promise.resolve();
    const sink: StreamSink | undefined = streamOn && (opts.onDelta || scheduler)
      ? {
        onText: (t) => {
          textSoFar = t;
          try { opts.onDelta?.(t); } catch { /* l'affichage ne casse jamais le tour */ }
        },
        onToolCall: scheduler
          ? (call) => {
            arrived.push(call);
            if (effectful(call.function.name) && opts.onBeforeTools) {
              if (!provisional) {
                provisional = { role: "assistant", content: textSoFar || null, tool_calls: arrived };
                messages.push(provisional);
              } else {
                provisional.content = textSoFar || null;
              }
              saved = saved.then(() => opts.onBeforeTools!(progress()).catch(() => {}));
              scheduler.start(call, saved);
            } else {
              scheduler.start(call);
            }
            harness.early_tools++;
          }
          : undefined,
      }
      : undefined;

    const msgChars = JSON.stringify(messages).length;
    const sentSize = { chars: 0 };
    const sent = await sendWithOutputEscalation(
      (maxTokens) => chatWithinBudget({
        url: ep.url, apiKey: ep.apiKey, provider: ep.provider, model: ep.model, pinned: ep.pinned, registered: ep.registered,
        messages, onNotice: opts.onNotice, deadlineAt: opts.hardDeadlineAt, stats: harness,
        stream: sink, onRetry: opts.onRetry, sent: sentSize,
        build: (msgs, m) => ({
          model: m,
          messages: [...msgs, ...ephemeral],
          tools: roundTools, tool_choice: pendingToolChoice ?? "auto",
          temperature: opts.temperature ?? 0.3, max_tokens: maxTokens,
        }),
      }),
      opts.maxTokens ?? 4000,
      (wasted) => adopt(wasted, usage),
      { deadlineAt: opts.hardDeadlineAt ?? opts.deadlineAt, onNotice: opts.onNotice, stats: harness, dispatched: () => arrived.length > 0 },
    );
    adopt(sent, usage);
    // La mesure du tour : ce que le fournisseur a compté, rapporté à ce qui a
    // réellement été envoyé (transcrit compacté, outils, récapitulatif).
    const billed = Number(sent.json.usage?.prompt_tokens) || 0;
    if (billed > 0 && sentSize.chars > 0) measure = { tokens: billed, bodyChars: sentSize.chars, msgChars };
    const choice = sent.json.choices?.[0];
    const message = choice?.message;
    const interrupted = choice?.finish_reason === "interrupted";
    const calls = toolCallsOf(message, `embedded_${round}`);
    if (!calls.length) {
      // Un flux coupé qui n'avait rendu que du texte : rien n'est parti, le tour
      // peut être rejoué une fois plutôt que de rendre une réponse tronquée.
      if (interrupted && interruptedRetries < 1) {
        interruptedRetries++;
        await opts.onNotice?.({ type: "info", message: "Réponse en flux coupée avant la fin — tour rejoué." }).catch(() => {});
        continue;
      }
      if (pendingToolChoice && forcedChoiceRetries < 1) {
        forcedChoiceRetries++;
        messages.push({ role: "assistant", content: message?.content ?? "" });
        messages.push({
          role: "user",
          content: `Tu dois appeler l'outil ${pendingToolChoice.function.name} maintenant pour répondre à la demande explicite. Ne prétends pas que cet outil ou ses actions n'existent pas.`,
        });
        continue;
      }
      if (hasToolCallMarkers(message?.content ?? "") && incompleteRetries < 2) {
        incompleteRetries++;
        await opts.onNotice?.({ type: "tool_error", message: "Incomplete tool call detected — asking the agent to re-issue it cleanly", detail: String(message?.content ?? "").slice(0, 400) }).catch(() => {});
        messages.push({ role: "assistant", content: message?.content ?? "" });
        messages.push({ role: "user", content: MALFORMED_CALL_NUDGE });
        continue;
      }
      return result(true, sanitizeLeakedToolCalls(message?.content ?? ""));
    }
    // La demande d'appels entre dans le transcrit (le message provisoire du
    // flux est complété : son texte final et tous ses appels, embarqués compris).
    if (provisional) {
      (provisional as ChatMessage).content = message?.content ?? null;
      (provisional as ChatMessage).tool_calls = calls;
    } else {
      messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: calls });
    }
    // Les appels à effet qui ne sont pas déjà partis : transcrit sauvegardé avant.
    if (opts.onBeforeTools && calls.some((c) => effectful(c.function.name) && !scheduler?.has(c.id))) {
      await saved;
      await opts.onBeforeTools(progress()).catch(() => {});
    }
    const onResult = (call: ToolCall, args: Record<string, unknown>, out: string) => {
      toolCalls.push({ name: call.function.name, args });
      if (out.startsWith("ERROR")) errorCount++;
      messages.push({ role: "tool", tool_call_id: call.id, content: truncateMiddle(out, TOOL_RESULT_CAP) });
    };
    const truncated = choice?.finish_reason === "length";
    if (scheduler) {
      await scheduler.settle(calls, onResult, truncated);
    } else {
      await executeToolCalls(calls, opts.executor, {
        truncated, parallelSafe: opts.parallelSafe,
        schemaOf, known, deadlineAt: opts.hardDeadlineAt, stats: harness,
        ledger: opts.ledger, effectful,
      }, onResult);
    }
    pendingToolChoice = undefined;
    slowestRound = Math.max(slowestRound, Date.now() - startedAt);
    await opts.onRoundEnd?.(progress()).catch(() => {});
  }
  // Tick budget exhausted without a final answer — resume on the next tick.
  return result(false, "");
}

// Heuristic: does this content carry the tell-tale markers of a tool call the
// model tried (and failed) to emit as text? Used to catch INCOMPLETE/truncated
// tool calls that parseEmbeddedToolCalls couldn't fully recover, so the loop can
// ask the model to re-issue them instead of silently stalling. Kept specific to
// avoid false positives on normal prose/code.
export function hasToolCallMarkers(content: string): boolean {
  if (!content) return false;
  return /｜｜DSML｜｜|<｜tool▁call|<\s*function\s*=|<\s*invoke\s+name\s*=|<\s*tool_call\b|<\s*tool_calls\b/i.test(content);
}

// Strip any leaked tool-call markup (DeepSeek DSML / <function=…> / dangling
// invoke·parameter tags) from content destined for the USER, so a leak never
// surfaces as raw markup in the reply.
export function sanitizeLeakedToolCalls(content: string): string {
  if (!content) return content;
  let c = content;
  // Whole closed tool_calls / function blocks.
  c = c.replace(/<[^>]*\btool_calls\b[\s\S]*?<[^>]*\/[^>]*\btool_calls\b\s*>/gi, "");
  c = c.replace(/<function\s*=\s*[a-zA-Z0-9_-]+\s*>[\s\S]*?<\/function>/gi, "");
  // Dangling / unclosed fragments: cut from the first leaked open marker to end.
  c = c.replace(/<[^>]*\b(?:tool_calls|invoke)\b[\s\S]*$/i, "");
  c = c.replace(/<function\s*=\s*[a-zA-Z0-9_-]+\s*>[\s\S]*$/i, "");
  c = c.replace(/｜｜DSML｜｜/g, "");
  return c.trim();
}

// Parse tool calls that a model emitted as plain TEXT in its content instead of
// proper tool_calls. Handles two leaked formats:
//   1. DeepSeek DSML/XML:  <…invoke name="TOOL">…<…parameter name="P" …>VALUE</…parameter>…</…invoke>
//   2. Groq function tag:  <function=TOOL>{json}</function>
// Returns parsed { name, args } pairs (empty if none / not a leaked tool call).
export function parseEmbeddedToolCalls(content: string): Array<{ name: string; args: Record<string, unknown> }> {
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  if (!content || (!content.includes("invoke name=") && !content.includes("<function="))) return out;

  // Format 1: XML-style invoke/parameter blocks (DeepSeek <｜｜DSML｜｜…> and similar).
  // Match each `invoke name="TOOL"` … up to the matching closing invoke (or end).
  const invokeRe = /invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)(?:<[^>]*\/\s*invoke\s*>|<\/[^>]*invoke>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(content))) {
    const name = m[1].trim();
    const body = m[2];
    const args: Record<string, unknown> = {};
    // Each parameter: `parameter name="P" …>VALUE</…parameter>`. The closing tag
    // is optional so we still recover a TRUNCATED final parameter (the model ran
    // out of tokens mid-file-write): capture up to the next param/invoke tag or end.
    const paramRe = /parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)(?:<[^>]*\/\s*parameter\s*>|<\/[^>]*parameter>|(?=<[^>]*parameter\s+name)|(?=<[^>]*\/\s*invoke)|$)/g;
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(body))) {
      const key = p[1].trim();
      let val: string = p[2];
      // Trim a single leading/trailing newline that the format usually adds.
      val = val.replace(/^\r?\n/, "").replace(/\r?\n\s*$/, "");
      // Coerce JSON-looking values; otherwise keep as string.
      const t = val.trim();
      if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
        try { args[key] = JSON.parse(t); continue; } catch { /* keep string */ }
      }
      if (t === "true" || t === "false") { args[key] = t === "true"; continue; }
      if (t !== "" && !isNaN(Number(t)) && /^-?\d+(\.\d+)?$/.test(t)) { args[key] = Number(t); continue; }
      args[key] = val;
    }
    if (name) out.push({ name, args });
  }
  if (out.length) return out;

  // Format 2: <function=TOOL>{json}</function>
  const fnRe = /<function\s*=\s*([a-zA-Z0-9_-]+)\s*>([\s\S]*?)(?:<\/function>|$)/g;
  while ((m = fnRe.exec(content))) {
    const name = m[1].trim();
    const jsonStr = extractFirstJsonObject(m[2]) ?? "{}";
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(jsonStr); } catch { /* keep {} */ }
    if (name) out.push({ name, args });
  }
  return out;
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
