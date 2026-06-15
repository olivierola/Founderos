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

export function routeAiRequest(task: AiTask): "groq" | "deepseek" {
  return GROQ_TASKS.includes(task) ? "groq" : "deepseek";
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
}

interface ChatResponse {
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}

const GROQ_MODEL = "llama-3.3-70b-versatile";
const DEEPSEEK_MODEL = "deepseek-chat";

export async function callAi(opts: CallOpts): Promise<{ content: string; provider: "groq" | "deepseek"; model: string; usage?: ChatResponse["usage"] }> {
  const provider = opts.provider ?? routeAiRequest(opts.task);
  const apiKey =
    provider === "groq" ? Deno.env.get("GROQ_API_KEY") : Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY is not configured`);

  const url =
    provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.deepseek.com/chat/completions";
  const model = opts.model ?? (provider === "groq" ? GROQ_MODEL : DEEPSEEK_MODEL);

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1500,
  };
  if (opts.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  // Simple retry with backoff for transient 5xx / 429
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? "";
      return { content, provider, model: json.model ?? model, usage: json.usage };
    }
    lastErr = `${res.status} ${await res.text()}`;
    if (res.status < 500 && res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`${provider} call failed: ${lastErr.slice(0, 300)}`);
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
}

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
  messages: ChatMessage[];
  tools: ToolDef[];
  executor: ToolExecutor;
  temperature?: number;
  maxTokens?: number;
  maxRounds?: number; // safety cap on tool-call iterations
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

export async function callAiWithTools(opts: ToolLoopOpts): Promise<ToolLoopResult> {
  const provider = opts.provider ?? "groq";
  const apiKey =
    provider === "groq" ? Deno.env.get("GROQ_API_KEY") : Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY is not configured`);
  const url = TOOL_ENDPOINTS[provider];
  const model = opts.model ?? (provider === "groq" ? GROQ_MODEL : DEEPSEEK_MODEL);

  const messages = [...opts.messages];
  const usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const maxRounds = opts.maxRounds ?? 6;
  let modelName = model;

  for (let round = 0; round < maxRounds; round++) {
    const json = await postChat(url, apiKey, {
      model,
      messages,
      tools: opts.tools,
      tool_choice: "auto",
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1500,
    });
    modelName = json.model ?? model;
    if (json.usage) {
      usageTotal.prompt_tokens += json.usage.prompt_tokens ?? 0;
      usageTotal.completion_tokens += json.usage.completion_tokens ?? 0;
      usageTotal.total_tokens += json.usage.total_tokens ?? 0;
    }

    const choice = json.choices?.[0]?.message;
    const calls = choice?.tool_calls ?? [];

    // No tool calls → final answer.
    if (!calls.length) {
      return {
        content: choice?.content ?? "",
        provider,
        model: modelName,
        usage: usageTotal,
        toolCalls,
      };
    }

    // Echo the assistant message that requested the tools, then run each tool
    // and append its result so the model can continue.
    messages.push({ role: "assistant", content: choice?.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* keep {} */ }
      toolCalls.push({ name: call.function.name, args });
      let result: string;
      try {
        result = await opts.executor(call.function.name, args);
      } catch (e) {
        result = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      // Cap tool output so a huge payload doesn't blow the context window.
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.length > 12000 ? result.slice(0, 12000) + "\n…(truncated)" : result,
      });
    }
  }

  // Ran out of rounds — ask once more without tools to force a final answer.
  const json = await postChat(url, apiKey, {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1500,
  });
  if (json.usage) {
    usageTotal.prompt_tokens += json.usage.prompt_tokens ?? 0;
    usageTotal.completion_tokens += json.usage.completion_tokens ?? 0;
    usageTotal.total_tokens += json.usage.total_tokens ?? 0;
  }
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    provider,
    model: json.model ?? modelName,
    usage: usageTotal,
    toolCalls,
  };
}

interface ToolChatResponse {
  choices: { message: ChatMessage }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}

// Groq/Llama sometimes emit a tool call as text — "<function=NAME>{json}" — and
// the API rejects it with 400 tool_use_failed, exposing the attempt in
// `failed_generation`. Recover it into a proper tool_calls response so the loop
// can run the tool instead of crashing the whole chat.
function recoverFailedToolCall(rawBody: string): ToolChatResponse | null {
  try {
    const err = JSON.parse(rawBody)?.error;
    if (!err || err.code !== "tool_use_failed" || !err.failed_generation) return null;
    const gen: string = err.failed_generation;
    const m = gen.match(/<function\s*=\s*([a-zA-Z0-9_-]+)\s*>([\s\S]*?)(?:<\/function>|$)/);
    if (!m) return null;
    const name = m[1];
    let argText = (m[2] || "").trim();
    // Trim anything after the JSON object closes.
    const start = argText.indexOf("{");
    if (start > 0) argText = argText.slice(start);
    let args = "{}";
    try { JSON.parse(argText); args = argText; } catch {
      // keep only up to the last closing brace
      const end = argText.lastIndexOf("}");
      if (end > 0) { const slice = argText.slice(0, end + 1); try { JSON.parse(slice); args = slice; } catch { /* give up */ } }
    }
    return {
      choices: [{ message: {
        role: "assistant", content: null,
        tool_calls: [{ id: `recovered_${Date.now()}`, type: "function", function: { name, arguments: args } }],
      } }],
      model: "recovered",
    } as ToolChatResponse;
  } catch { return null; }
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
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as ToolChatResponse;
    const text = await res.text();
    lastErr = `${res.status} ${text}`;
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
