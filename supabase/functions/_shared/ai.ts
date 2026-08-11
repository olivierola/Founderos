// AI router: Groq for fast / classification / JSON-extract, DeepSeek for deep code analysis.
// Per spec section 13. Both providers expose OpenAI-compatible REST endpoints.

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

/** A custom OpenAI-compatible chat endpoint (base URL ending at /v1). */
export interface EndpointOverride { baseUrl: string; apiKey?: string; model?: string }
const chatCompletionsUrl = (baseUrl: string) => `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

interface ChatResponse {
  choices: { message: { content: string }; finish_reason?: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}

const GROQ_MODEL = "llama-3.3-70b-versatile";
const DEEPSEEK_MODEL = "deepseek-chat";

export async function callAi(opts: CallOpts): Promise<{ content: string; provider: "groq" | "deepseek"; model: string; usage?: ChatResponse["usage"] }> {
  // Admin kill-switch: set LLM_GLOBAL_BLOCK=1 to immediately prevent any LLM calls.
  if (Deno.env.get("LLM_GLOBAL_BLOCK") === "1") {
    throw new Error("LLM calls are disabled by environment (LLM_GLOBAL_BLOCK=1)");
  }
  const provider = opts.provider ?? routeAiRequest(opts.task);
  const ep = opts.endpoint;
  const apiKey = ep ? (ep.apiKey ?? "") : (provider === "groq" ? Deno.env.get("GROQ_API_KEY") : Deno.env.get("DEEPSEEK_API_KEY"));
  if (!ep && !apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY is not configured`);

  const url = ep
    ? chatCompletionsUrl(ep.baseUrl)
    : provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.deepseek.com/chat/completions";
  const overrideModel = opts.model && opts.model !== "groq" && opts.model !== "deepseek" ? opts.model : undefined;
  const model = ep?.model ?? overrideModel ?? (provider === "groq" ? GROQ_MODEL : DEEPSEEK_MODEL);

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
  const json = opts.jsonMode
    ? await postChat(url, apiKey, body)
    : await completeChat(url, apiKey, body);
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

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
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
  /** Out-of-band notices (e.g. a detected incomplete/malformed tool call) so
   *  the caller can surface them in the run timeline. Best-effort. */
  onNotice?: (n: { type: "tool_error" | "info"; message: string; detail?: string }) => Promise<void>;
}

interface ToolLoopResult {
  content: string;
  provider: "groq" | "deepseek";
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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
const _compactCache = new WeakMap<ToolDef[], ToolDef[]>();
function compactToolDefs(tools: ToolDef[]): ToolDef[] {
  if (!Array.isArray(tools) || !tools.length) return tools;
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

// Guarantee OpenAI-compatible tool-call pairing right before sending: every
// assistant message with tool_calls must be immediately followed by one tool
// message per tool_call_id, and no orphan tool messages may exist. Upstream
// context trimming/compaction can otherwise strand a pair → the provider rejects
// the whole request with 400 "tool_calls must be followed by tool messages".
// Runs on EVERY send so no caller can produce an invalid sequence.
function ensureToolPairing(msgs: ChatMessage[]): ChatMessage[] {
  let dirty = false;
  const out: ChatMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const tc = (m as { tool_calls?: Array<{ id: string }> }).tool_calls;
    if (m.role === "assistant" && tc?.length) {
      const toolMsgs: ChatMessage[] = [];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === "tool") { toolMsgs.push(msgs[j]); j++; }
      const answered = new Set(toolMsgs.map((t) => (t as { tool_call_id?: string }).tool_call_id));
      if (tc.every((c) => answered.has(c.id))) {
        out.push(m, ...toolMsgs);
      } else {
        // Some responses are missing → drop the (unanswerable) tool_calls, keep text.
        out.push({ role: "assistant", content: m.content ?? "[appel d'outil omis]" } as ChatMessage);
        dirty = true;
      }
      i = j - 1; // consumed (or dropped) the tool messages
    } else if (m.role === "tool") {
      dirty = true; // orphan tool result (its calling assistant is gone) → drop
    } else {
      out.push(m);
    }
  }
  return dirty ? out : msgs;
}

// Keep more, and keep it longer, than we used to (5 × 350 chars). A research
// run reads pages worth thousands of characters and writes its report from
// them: a 350-char stub erased the figures three rounds after fetching them,
// and the agent re-searched what it had already found. Affordable now that an
// over-budget request compacts and fails over instead of dying (see
// chatWithinBudget) — the ceiling is enforced there, not by starving every run.
function shrinkOldToolResults(msgs: ChatMessage[], keepRecentTools = 8, stub = 700): ChatMessage[] {
  const toolPositions: number[] = [];
  for (let i = 0; i < msgs.length; i++) if (msgs[i].role === "tool") toolPositions.push(i);
  if (toolPositions.length <= keepRecentTools) return msgs;
  const cutoff = toolPositions[toolPositions.length - keepRecentTools];
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
  if (pass === 0) return shrinkOldToolResults(msgs, 2, 200);
  if (pass === 1) {
    return shrinkOldToolResults(msgs, 1, 120).map((m) =>
      m.role !== "system" && typeof m.content === "string" && m.content.length > 4000
        ? { ...m, content: truncateMiddle(m.content, 4000) }
        : m);
  }
  // Last resort: keep the brief (system + first user turn) and the tail, drop
  // the middle behind an explicit marker so the model knows history is missing.
  const base = shrinkOldToolResults(msgs, 1, 120);
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
}): Promise<BudgetedChat> {
  const budget = REQUEST_TOKEN_BUDGET[opts.provider];
  const deepseekKey = opts.pinned ? null : Deno.env.get("DEEPSEEK_API_KEY") ?? null;
  const canFailover = !opts.pinned && opts.provider === "groq" && !!deepseekKey;
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
        json: await completeChat(TOOL_ENDPOINTS.deepseek, deepseekKey!, opts.build(full, DEEPSEEK_MODEL)),
        provider: "deepseek",
        model: DEEPSEEK_MODEL,
      };
    }
  }

  let lastError: PayloadTooLargeError | null = null;
  for (let pass = 0; pass < 3; pass++) {
    try {
      return { json: await completeChat(opts.url, opts.apiKey ?? "", opts.build(msgs, opts.model)), provider: opts.provider, model: opts.model };
    } catch (e) {
      // Quota spent on this provider: squeezing cannot help and the reset is
      // half an hour away. Move the work, or say so plainly.
      if (e instanceof ProviderExhaustedError) {
        if (!canFailover) throw e;
        await opts.onNotice?.({
          type: "info",
          message: `Quota ${opts.provider} épuisé — bascule sur DeepSeek pour la suite du run.`,
        }).catch(() => {});
        return {
          json: await completeChat(TOOL_ENDPOINTS.deepseek, deepseekKey!, opts.build(msgs, DEEPSEEK_MODEL)),
          provider: "deepseek",
          model: DEEPSEEK_MODEL,
        };
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
    const json = await completeChat(TOOL_ENDPOINTS.deepseek, deepseekKey!, opts.build(msgs, DEEPSEEK_MODEL));
    return { json, provider: "deepseek", model: DEEPSEEK_MODEL };
  }
  throw lastError ?? new PayloadTooLargeError("le contexte dépasse la fenêtre du modèle", null, null);
}

export async function callAiWithTools(opts: ToolLoopOpts): Promise<ToolLoopResult> {
  // Admin kill-switch: set LLM_GLOBAL_BLOCK=1 to immediately prevent any LLM calls.
  if (Deno.env.get("LLM_GLOBAL_BLOCK") === "1") {
    throw new Error("LLM calls are disabled by environment (LLM_GLOBAL_BLOCK=1)");
  }
  const provider = opts.provider ?? "groq";
  const ep = opts.endpoint;
  const apiKey = ep ? (ep.apiKey ?? "") : (provider === "groq" ? Deno.env.get("GROQ_API_KEY") : Deno.env.get("DEEPSEEK_API_KEY"));
  if (!ep && !apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY is not configured`);
  const url = ep ? chatCompletionsUrl(ep.baseUrl) : TOOL_ENDPOINTS[provider];
  const model = ep?.model ?? opts.model ?? (provider === "groq" ? GROQ_MODEL : DEEPSEEK_MODEL);

  const messages = [...opts.messages];
  const usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const maxRounds = opts.maxRounds ?? 6;
  let modelName = model;
  let incompleteRetries = 0;

  // Produce the final user-facing answer. Sanitises leaked tool-call markup; and
  // if the model used tools but ended with an EMPTY reply (e.g. its last output
  // was a pure leaked tool-call block that sanitising removed), force one
  // no-tools "write your summary now" call so the user never gets "(no reply)".
  async function finalizeAnswer(rawContent: string | null | undefined): Promise<string> {
    let c = sanitizeLeakedToolCalls(rawContent ?? "");
    if (c || toolCalls.length === 0) return c;
    messages.push({
      role: "user",
      content: "You've finished using tools. Write your FINAL reply to the user now in markdown: a concise summary of what you did, the key results/findings, and any deliverables produced. Do NOT call any tools and do NOT output any tool-call markup.",
    });
    try {
      const sj = await completeChat(url, apiKey, { model, messages: ensureToolPairing(messages), temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens ?? 4000 });
      if (sj.usage) {
        usageTotal.prompt_tokens += sj.usage.prompt_tokens ?? 0;
        usageTotal.completion_tokens += sj.usage.completion_tokens ?? 0;
        usageTotal.total_tokens += sj.usage.total_tokens ?? 0;
      }
      c = sanitizeLeakedToolCalls(sj.choices?.[0]?.message?.content ?? "");
    } catch { /* keep fallback */ }
    return c || "Travail terminé — voir le détail des étapes et des livrables ci-dessus.";
  }

  const slimTools = compactToolDefs(opts.tools);
  // The provider may change mid-loop (an over-budget failover); usage and the
  // reported model must follow whatever actually answered.
  let activeProvider = provider;
  let activeUrl = url;
  let activeKey = apiKey;
  let activeModel = model;
  for (let round = 0; round < maxRounds; round++) {
    const sent = await chatWithinBudget({
      url: activeUrl, apiKey: activeKey, provider: activeProvider, model: activeModel, pinned: !!ep,
      messages,
      onNotice: opts.onNotice,
      build: (msgs, m) => ({
        model: m,
        messages: msgs,
        tools: slimTools,
        tool_choice: "auto",
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 4000,
      }),
    });
    if (sent.provider !== activeProvider) {
      activeProvider = sent.provider;
      activeUrl = TOOL_ENDPOINTS[sent.provider];
      activeKey = Deno.env.get(sent.provider === "groq" ? "GROQ_API_KEY" : "DEEPSEEK_API_KEY") ?? "";
      activeModel = sent.model;
    }
    const json = sent.json;
    modelName = json.model ?? activeModel;
    if (json.usage) {
      usageTotal.prompt_tokens += json.usage.prompt_tokens ?? 0;
      usageTotal.completion_tokens += json.usage.completion_tokens ?? 0;
      usageTotal.total_tokens += json.usage.total_tokens ?? 0;
    }

    const choice = json.choices?.[0]?.message;
    let calls = choice?.tool_calls ?? [];

    // Recover tool calls that leaked into the content as text. Some models
    // (DeepSeek's <｜｜DSML｜｜invoke> markers, Groq's <function=…>) emit tool
    // calls as plain text instead of proper tool_calls → parse and execute.
    if (!calls.length && choice?.content) {
      const recovered = parseEmbeddedToolCalls(choice.content);
      if (recovered.length) {
        calls = recovered.map((r, i) => ({
          id: `embedded_${round}_${i}`,
          type: "function",
          function: { name: r.name, arguments: JSON.stringify(r.args) },
        }));
      }
    }

    // No tool calls. Before treating this as the final answer, detect a
    // MALFORMED / INCOMPLETE tool call leaked into the content (e.g. a DSML or
    // <function=…> fragment truncated mid-call). These silently stall agents.
    // Surface it and ask the model to re-issue the call cleanly (bounded retry).
    if (!calls.length) {
      if (hasToolCallMarkers(choice?.content ?? "") && incompleteRetries < 2) {
        incompleteRetries++;
        if (opts.onNotice) {
          await opts.onNotice({
            type: "tool_error",
            message: "Incomplete tool call detected — asking the agent to re-issue it cleanly",
            detail: String(choice?.content ?? "").slice(0, 400),
          }).catch(() => {});
        }
        messages.push({ role: "assistant", content: choice?.content ?? "" });
        messages.push({
          role: "user",
          content:
            "Your previous message contained a PARTIAL or MALFORMED tool call that could not be executed (it looks truncated or used raw DSML/function-tag text). Re-issue it now as ONE complete, valid tool call via the proper tool-calling interface. Do not put any DSML, <function=…> or <invoke> markup in your text content.",
        });
        continue;
      }
      return {
        content: await finalizeAnswer(choice?.content),
        provider: activeProvider,
        model: modelName,
        usage: usageTotal,
        toolCalls,
      };
    }

    // Echo the assistant message that requested the tools, then run each tool
    // and append its result so the model can continue.
    // Fix Groq malformed tool calls: name sometimes contains args fused
    // e.g. 'http_get{"url":"..."}' → split into name='http_get', args={url:...}
    for (const call of calls) {
      const raw = call.function.name ?? "";
      const braceIdx = raw.indexOf("{");
      if (braceIdx > 0) {
        call.function.name = raw.slice(0, braceIdx);
        try {
          const embeddedArgs = JSON.parse(raw.slice(braceIdx));
          call.function.arguments = JSON.stringify({ ...embeddedArgs, ...JSON.parse(call.function.arguments || "{}") });
        } catch { /* keep original */ }
      }
    }
    messages.push({ role: "assistant", content: choice?.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* keep {} */ }
      toolCalls.push({ name: call.function.name, args });
      let result: string;
      try {
        result = await opts.executor(call.function.name, args);
      } catch (e) {
        // Control-flow signals (run cancelled, awaiting human input) must
        // unwind the whole loop, not be turned into a tool error string.
        const nm = (e as { name?: string } | null)?.name;
        if (nm === "RunCancelledError" || nm === "AwaitingInputError" || nm === "AwaitingApprovalError") throw e;
        result = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      // Cap tool output so a huge payload doesn't blow the context window.
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: truncateMiddle(result, TOOL_RESULT_CAP),
      });
    }
  }

  // Ran out of rounds. The model often tries ONE more tool call here, frequently
  // leaked as DSML text. Drain up to 2 more recovered calls so the agent doesn't
  // abandon work mid-flight, then force a clean (sanitized) final answer.
  for (let drain = 0; drain < 2; drain++) {
    const drained = await chatWithinBudget({
      url: activeUrl, apiKey: activeKey, provider: activeProvider, model: activeModel, pinned: !!ep,
      messages, onNotice: opts.onNotice,
      build: (msgs, m) => ({
        model: m, messages: msgs, tools: slimTools, tool_choice: "auto",
        temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens ?? 4000,
      }),
    });
    const dj = drained.json;
    if (dj.usage) {
      usageTotal.prompt_tokens += dj.usage.prompt_tokens ?? 0;
      usageTotal.completion_tokens += dj.usage.completion_tokens ?? 0;
      usageTotal.total_tokens += dj.usage.total_tokens ?? 0;
    }
    const dchoice = dj.choices?.[0]?.message;
    let dcalls = dchoice?.tool_calls ?? [];
    if (!dcalls.length && dchoice?.content) {
      const rec = parseEmbeddedToolCalls(dchoice.content);
      if (rec.length) {
        dcalls = rec.map((r, i) => ({ id: `drain_${drain}_${i}`, type: "function", function: { name: r.name, arguments: JSON.stringify(r.args) } }));
      }
    }
    if (!dcalls.length) {
      return { content: await finalizeAnswer(dchoice?.content), provider: activeProvider, model: dj.model ?? modelName, usage: usageTotal, toolCalls };
    }
    messages.push({ role: "assistant", content: dchoice?.content ?? null, tool_calls: dcalls });
    for (const call of dcalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* keep {} */ }
      toolCalls.push({ name: call.function.name, args });
      let result: string;
      try {
        result = await opts.executor(call.function.name, args);
      } catch (e) {
        const nm = (e as { name?: string } | null)?.name;
        if (nm === "RunCancelledError" || nm === "AwaitingInputError" || nm === "AwaitingApprovalError") throw e;
        result = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: truncateMiddle(result, TOOL_RESULT_CAP) });
    }
  }

  // Final answer, no tools.
  const closing = await chatWithinBudget({
    url: activeUrl, apiKey: activeKey, provider: activeProvider, model: activeModel, pinned: !!ep,
    messages, onNotice: opts.onNotice,
    build: (msgs, m) => ({
      model: m,
      messages: msgs,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 4000,
    }),
  });
  const json = closing.json;
  if (json.usage) {
    usageTotal.prompt_tokens += json.usage.prompt_tokens ?? 0;
    usageTotal.completion_tokens += json.usage.completion_tokens ?? 0;
    usageTotal.total_tokens += json.usage.total_tokens ?? 0;
  }
  return {
    content: await finalizeAnswer(json.choices?.[0]?.message?.content),
    provider: closing.provider,
    model: json.model ?? modelName,
    usage: usageTotal,
    toolCalls,
  };
}

interface ToolChatResponse {
  choices: { message: ChatMessage; finish_reason?: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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
}
export interface ToolRoundsResult {
  messages: ChatMessage[];
  finished: boolean;
  content: string;
  roundsRun: number;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Tool results in THIS tick that came back as errors — drives re-planning. */
  errorCount: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  provider: "groq" | "deepseek";
  model: string;
}

export async function runToolRounds(opts: ToolRoundsOpts): Promise<ToolRoundsResult> {
  if (Deno.env.get("LLM_GLOBAL_BLOCK") === "1") throw new Error("LLM calls are disabled (LLM_GLOBAL_BLOCK=1)");
  const provider = opts.provider ?? "deepseek";
  const ep = opts.endpoint;
  const apiKey = ep ? (ep.apiKey ?? "") : (provider === "groq" ? Deno.env.get("GROQ_API_KEY") : Deno.env.get("DEEPSEEK_API_KEY"));
  if (!ep && !apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY is not configured`);
  const url = ep ? chatCompletionsUrl(ep.baseUrl) : TOOL_ENDPOINTS[provider];
  const overrideModel = opts.model && opts.model !== "groq" && opts.model !== "deepseek" ? opts.model : undefined;
  const model = ep?.model ?? overrideModel ?? (provider === "groq" ? GROQ_MODEL : DEEPSEEK_MODEL);
  const messages = opts.messages;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let modelName = model;
  let incompleteRetries = 0;
  let roundsRun = 0;
  let errorCount = 0;

  const resolveTools = () => compactToolDefs(typeof opts.tools === "function" ? opts.tools() : opts.tools);
  // May switch mid-tick when the transcript outgrows the provider's allowance.
  let activeProvider = provider;
  let activeUrl = url;
  let activeKey = apiKey;
  let activeModel = model;
  for (let round = 0; round < opts.maxRounds; round++) {
    roundsRun++;
    // Order matters: the cached prefix is the transcript; ephemeral goes AFTER it.
    const ephemeral = opts.ephemeral?.() ?? [];
    const sent = await chatWithinBudget({
      url: activeUrl, apiKey: activeKey, provider: activeProvider, model: activeModel, pinned: !!ep,
      messages, onNotice: opts.onNotice,
      build: (msgs, m) => ({
        model: m,
        messages: [...msgs, ...ephemeral],
        tools: resolveTools(), tool_choice: "auto",
        temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens ?? 4000,
      }),
    });
    if (sent.provider !== activeProvider) {
      activeProvider = sent.provider;
      activeUrl = TOOL_ENDPOINTS[sent.provider];
      activeKey = Deno.env.get(sent.provider === "groq" ? "GROQ_API_KEY" : "DEEPSEEK_API_KEY") ?? "";
      activeModel = sent.model;
    }
    const json = sent.json;
    modelName = json.model ?? activeModel;
    if (json.usage) {
      usage.prompt_tokens += json.usage.prompt_tokens ?? 0;
      usage.completion_tokens += json.usage.completion_tokens ?? 0;
      usage.total_tokens += json.usage.total_tokens ?? 0;
    }
    const choice = json.choices?.[0]?.message;
    let calls = choice?.tool_calls ?? [];
    if (!calls.length && choice?.content) {
      const recovered = parseEmbeddedToolCalls(choice.content);
      if (recovered.length) calls = recovered.map((r, i) => ({ id: `embedded_${round}_${i}`, type: "function", function: { name: r.name, arguments: JSON.stringify(r.args) } }));
    }
    if (!calls.length) {
      if (hasToolCallMarkers(choice?.content ?? "") && incompleteRetries < 2) {
        incompleteRetries++;
        if (opts.onNotice) await opts.onNotice({ type: "tool_error", message: "Incomplete tool call detected — asking the agent to re-issue it cleanly", detail: String(choice?.content ?? "").slice(0, 400) }).catch(() => {});
        messages.push({ role: "assistant", content: choice?.content ?? "" });
        messages.push({ role: "user", content: "Your previous message contained a PARTIAL or MALFORMED tool call that could not be executed. Re-issue it now as ONE complete, valid tool call via the proper tool-calling interface. No DSML/function-tag markup in your text." });
        continue;
      }
      return { messages, finished: true, content: sanitizeLeakedToolCalls(choice?.content ?? ""), roundsRun, toolCalls, errorCount, usage, provider: activeProvider, model: modelName };
    }
    for (const call of calls) {
      const raw = call.function.name ?? "";
      const braceIdx = raw.indexOf("{");
      if (braceIdx > 0) {
        call.function.name = raw.slice(0, braceIdx);
        try { const ea = JSON.parse(raw.slice(braceIdx)); call.function.arguments = JSON.stringify({ ...ea, ...JSON.parse(call.function.arguments || "{}") }); } catch { /* keep */ }
      }
    }
    messages.push({ role: "assistant", content: choice?.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* {} */ }
      toolCalls.push({ name: call.function.name, args });
      let result: string;
      try {
        result = await opts.executor(call.function.name, args);
      } catch (e) {
        const nm = (e as { name?: string } | null)?.name;
        if (nm === "RunCancelledError" || nm === "AwaitingInputError" || nm === "AwaitingApprovalError") throw e;
        result = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (result.startsWith("ERROR")) errorCount++;
      messages.push({ role: "tool", tool_call_id: call.id, content: truncateMiddle(result, TOOL_RESULT_CAP) });
    }
  }
  // Tick budget exhausted without a final answer — resume on the next tick.
  return { messages, finished: false, content: "", roundsRun, toolCalls, errorCount, usage, provider: activeProvider, model: modelName };
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
  constructor(readonly provider: string, detail: string) {
    super(`provider ${provider} exhausted: ${detail.slice(0, 200)}`);
    this.name = "ProviderExhaustedError";
  }
}

/** A quota that resets in more than a minute is not something a run can wait
 *  out; a short burst limit still deserves the normal backoff. */
const QUOTA_RE = /tokens per day|TPD|requests per day|RPD|quota exceeded|insufficient_quota/i;
function exhaustedFrom(status: number, body: string): boolean {
  if (status !== 429) return false;
  if (QUOTA_RE.test(body)) return true;
  const wait = /try again in (\d+)m/i.exec(body);
  return !!wait && Number(wait[1]) >= 1;
}
function oversizeFrom(status: number, body: string): PayloadTooLargeError | null {
  if (status !== 413 && !(OVERSIZE_RE.test(body) && (status === 400 || status === 429))) return null;
  const m = /Limit\s+(\d+),\s*Requested\s+(\d+)/i.exec(body);
  return new PayloadTooLargeError(body, m ? Number(m[2]) : null, m ? Number(m[1]) : null);
}

async function postChat(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<ToolChatResponse> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      // No key → no header at all. A self-hosted endpoint (vLLM/Ollama on the
      // company network) is often unauthenticated, and some of them reject a
      // bare "Bearer " outright.
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as ToolChatResponse;
    const text = await res.text();
    lastErr = `${res.status} ${text}`;
    // Too big: surface it as its own failure so the caller can compact. Checked
    // before the 429 backoff below — a TPM rejection is reported as 429 by some
    // gateways, and sleeping does not make the payload any smaller.
    const oversize = oversizeFrom(res.status, text);
    if (oversize) throw oversize;
    // Recover a malformed tool call (Groq tool_use_failed) instead of failing.
    if (res.status === 400) {
      const recovered = recoverFailedToolCall(text);
      if (recovered) return recovered;
    }
    if (res.status < 500 && res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
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

async function completeChat(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  maxContinuations = 4,
): Promise<ToolChatResponse> {
  const json = await postChat(url, apiKey, body);
  const choice = json.choices?.[0];
  const hasToolCalls = (m?: ChatMessage) => Array.isArray(m?.tool_calls) && (m!.tool_calls!.length > 0);
  if (!choice || choice.finish_reason !== "length" || hasToolCalls(choice.message)) return json;

  const usage = {
    prompt_tokens: json.usage?.prompt_tokens ?? 0,
    completion_tokens: json.usage?.completion_tokens ?? 0,
    total_tokens: json.usage?.total_tokens ?? 0,
  };
  const baseMessages = (body.messages as ChatMessage[]) ?? [];
  let full = choice.message?.content ?? "";
  let lastFinish: string | undefined = choice.finish_reason;

  for (let i = 0; i < maxContinuations; i++) {
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
    const cont = await postChat(url, apiKey, contBody);
    const cc = cont.choices?.[0];
    usage.prompt_tokens += cont.usage?.prompt_tokens ?? 0;
    usage.completion_tokens += cont.usage?.completion_tokens ?? 0;
    usage.total_tokens += cont.usage?.total_tokens ?? 0;
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
