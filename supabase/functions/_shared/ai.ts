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
  // Admin kill-switch: set LLM_GLOBAL_BLOCK=1 to immediately prevent any LLM calls.
  if (Deno.env.get("LLM_GLOBAL_BLOCK") === "1") {
    throw new Error("LLM calls are disabled by environment (LLM_GLOBAL_BLOCK=1)");
  }
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
  // Admin kill-switch: set LLM_GLOBAL_BLOCK=1 to immediately prevent any LLM calls.
  if (Deno.env.get("LLM_GLOBAL_BLOCK") === "1") {
    throw new Error("LLM calls are disabled by environment (LLM_GLOBAL_BLOCK=1)");
  }
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
    // Each parameter: `parameter name="P" …>VALUE</…parameter>`
    const paramRe = /parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)(?:<[^>]*\/\s*parameter\s*>|<\/[^>]*parameter>)/g;
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
