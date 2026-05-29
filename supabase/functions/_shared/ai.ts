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
}

interface ChatResponse {
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}

const GROQ_MODEL = "llama-3.3-70b-versatile";
const DEEPSEEK_MODEL = "deepseek-chat";

export async function callAi(opts: CallOpts): Promise<{ content: string; provider: "groq" | "deepseek"; model: string; usage?: ChatResponse["usage"] }> {
  const provider = routeAiRequest(opts.task);
  const apiKey =
    provider === "groq" ? Deno.env.get("GROQ_API_KEY") : Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey) throw new Error(`${provider.toUpperCase()}_API_KEY is not configured`);

  const url =
    provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.deepseek.com/chat/completions";
  const model = provider === "groq" ? GROQ_MODEL : DEEPSEEK_MODEL;

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
