// Approx pricing per 1M tokens, in EUR cents. Updated 2026-Q1 public pricing.
// Used as a best-effort estimate for LLM cost tracking.

interface ModelPrice {
  inputCentsPerM: number;
  outputCentsPerM: number;
}

const PRICING: Record<string, ModelPrice> = {
  // Groq — generally free tier or very cheap; published rates approx.
  "llama-3.3-70b-versatile": { inputCentsPerM: 55, outputCentsPerM: 75 },
  "llama-3.1-8b-instant": { inputCentsPerM: 5, outputCentsPerM: 8 },
  // DeepSeek
  "deepseek-chat": { inputCentsPerM: 25, outputCentsPerM: 100 },
  "deepseek-reasoner": { inputCentsPerM: 50, outputCentsPerM: 200 },
};

const FALLBACK: ModelPrice = { inputCentsPerM: 50, outputCentsPerM: 100 };

export function estimateCostCents(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const key = Object.keys(PRICING).find((k) => model.includes(k)) ?? "";
  const price = PRICING[key] ?? FALLBACK;
  const inCents = (promptTokens / 1_000_000) * price.inputCentsPerM;
  const outCents = (completionTokens / 1_000_000) * price.outputCentsPerM;
  return Math.max(0, Math.round(inCents + outCents));
}
