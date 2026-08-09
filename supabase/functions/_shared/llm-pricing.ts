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
  "llama-3.2-3b-preview": { inputCentsPerM: 4, outputCentsPerM: 6 },
  "llama-3.2-90b": { inputCentsPerM: 85, outputCentsPerM: 150 },
  "llama-3.1-405b": { inputCentsPerM: 200, outputCentsPerM: 300 },
  "mixtral-8x7b": { inputCentsPerM: 24, outputCentsPerM: 24 },
  "gemma2-9b": { inputCentsPerM: 20, outputCentsPerM: 20 },
  "qwen-2.5-coder-32b": { inputCentsPerM: 80, outputCentsPerM: 80 },
  "gpt-oss-20b": { inputCentsPerM: 40, outputCentsPerM: 40 },
  // DeepSeek
  "deepseek-chat": { inputCentsPerM: 25, outputCentsPerM: 100 },
  "deepseek-reasoner": { inputCentsPerM: 50, outputCentsPerM: 200 },
  "deepseek-v4": { inputCentsPerM: 30, outputCentsPerM: 120 },
};

const FALLBACK: ModelPrice = { inputCentsPerM: 50, outputCentsPerM: 100 };

/** Self-hosted / custom models (RunPod, aiops_providers cloud_endpoint, in-house
 *  checkpoints). No public rate table exists, so we charge a reasonable mid-range
 *  estimate instead of the zero the generic fallback used to imply for unknown
 *  providers. Overridable per row if the operator has a known price. */
const CUSTOM_FALLBACK: ModelPrice = { inputCentsPerM: 30, outputCentsPerM: 60 };

export interface EstimateOpts {
  /** Self-hosted / company-registered model → custom rate. */
  custom?: boolean;
}

export function estimateCostCents(
  model: string,
  promptTokens: number,
  completionTokens: number,
  opts?: EstimateOpts,
): number {
  const key = Object.keys(PRICING).find((k) => model.includes(k)) ?? "";
  const price = PRICING[key] ?? (opts?.custom ? CUSTOM_FALLBACK : FALLBACK);
  const inCents = (promptTokens / 1_000_000) * price.inputCentsPerM;
  const outCents = (completionTokens / 1_000_000) * price.outputCentsPerM;
  return Math.max(0, Math.round(inCents + outCents));
}

/** USD-per-1k-token rates for the run-local accumulator (cost_usd on
 *  internal_agent_runs). Mirrors the same tables as estimateCostCents. */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  opts?: EstimateOpts,
): number {
  const key = Object.keys(PRICING).find((k) => model.includes(k)) ?? "";
  const price = PRICING[key] ?? (opts?.custom ? CUSTOM_FALLBACK : FALLBACK);
  const inUsd = (promptTokens / 1_000_000) * price.inputCentsPerM / 100;
  const outUsd = (completionTokens / 1_000_000) * price.outputCentsPerM / 100;
  return Math.max(0, inUsd + outUsd);
}
