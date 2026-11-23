
// Approx pricing per 1M tokens, in EUR cents. Updated 2026-Q1 public pricing.
// Used as a best-effort estimate for LLM cost tracking.

interface ModelPrice {
  inputCentsPerM: number;
  outputCentsPerM: number;
}

const PRICING: Record<string, ModelPrice> = {
  // Runware (identifiants AIR, éditeur:modèle@version). Relevés dans la doc
  // Runware le 14/11/2026 : gpt@5.4-mini, gpt@5-mini, gemini@3.5-flash et
  // minimax:m3 ; les autres sont des ordres de grandeur. Ce n'est que
  // l'estimation de secours : Runware renvoie le coût facturé de chaque appel,
  // et le runtime le préfère. Placés en tête — la recherche prend la PREMIÈRE
  // clé contenue dans l'identifiant, les variantes avant leur famille.
  "gpt@5.4-nano": { inputCentsPerM: 10, outputCentsPerM: 80 },
  "gpt@5.4-mini": { inputCentsPerM: 75, outputCentsPerM: 450 },
  "gpt@5-mini": { inputCentsPerM: 25, outputCentsPerM: 200 },
  "gpt@5-nano": { inputCentsPerM: 5, outputCentsPerM: 40 },
  "gpt@5": { inputCentsPerM: 125, outputCentsPerM: 1000 },
  "gpt@6": { inputCentsPerM: 125, outputCentsPerM: 1000 },
  "gemini@3.5-flash": { inputCentsPerM: 150, outputCentsPerM: 900 },
  "gemini@3": { inputCentsPerM: 50, outputCentsPerM: 300 },
  "deepseek:v4": { inputCentsPerM: 30, outputCentsPerM: 120 },
  "minimax:m3": { inputCentsPerM: 30, outputCentsPerM: 120 },
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
  // Remplaçant de llama-3.3-70b-versatile chez Groq (0,15 $ / 0,75 $ le million).
  "gpt-oss-120b": { inputCentsPerM: 14, outputCentsPerM: 69 },
  // Azure AI Foundry (GlobalStandard), aux tarifs publics OpenAI de la famille
  // GPT-5. L'ORDRE COMPTE : la recherche prend la première clé contenue dans
  // l'identifiant, donc les variantes passent avant « gpt-5 », qui couvre
  // gpt-5.6-terra et les autres déploiements de la famille.
  "gpt-5-nano": { inputCentsPerM: 5, outputCentsPerM: 37 },
  "gpt-5-mini": { inputCentsPerM: 23, outputCentsPerM: 184 },
  "gpt-5": { inputCentsPerM: 115, outputCentsPerM: 920 },
  "text-embedding-3-large": { inputCentsPerM: 12, outputCentsPerM: 0 },
  "text-embedding-3-small": { inputCentsPerM: 2, outputCentsPerM: 0 },
  // TypeSafe (Jev) — 42 $/milliard de tokens d'ENTRÉE, sortie gratuite. Soit
  // ~3,9 c€ le million : six fois moins que notre modèle le moins cher, et il
  // n'émet quasiment pas de sortie puisqu'il ne rédige pas.
  "jev": { inputCentsPerM: 4, outputCentsPerM: 0 },
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
  /** Part de l'entrée servie par le cache de préfixe du fournisseur. Azure
   *  (famille GPT-5) et DeepSeek la facturent un dixième du prix normal ; un
   *  long run renvoie le même préfixe à chaque tour, et l'ignorer surestimait
   *  son coût au point de le couper sur un budget qu'il ne dépassait pas. */
  cachedTokens?: number;
}

/** Prix d'un token d'entrée servi par le cache, rapporté au prix normal. */
const CACHED_INPUT_FACTOR = 0.1;

/** Les tokens d'entrée au prix plein, une fois le cache décompté. */
/** Un modèle gratuit d'OpenRouter (`…:free`, ou son routeur `openrouter/free`). */
export const isFreeModelId = (model: string): boolean => /:free$/.test(model) || model === "openrouter/free";

function billableInput(promptTokens: number, opts?: EstimateOpts): number {
  const cached = Math.min(Math.max(0, opts?.cachedTokens ?? 0), promptTokens);
  return promptTokens - cached + cached * CACHED_INPUT_FACTOR;
}

export function estimateCostCents(
  model: string,
  promptTokens: number,
  completionTokens: number,
  opts?: EstimateOpts,
): number {
  // Les modèles gratuits d'OpenRouter (connexion par défaut) ne coûtent rien.
  if (isFreeModelId(model)) return 0;
  const key = Object.keys(PRICING).find((k) => model.includes(k)) ?? "";
  const price = PRICING[key] ?? (opts?.custom ? CUSTOM_FALLBACK : FALLBACK);
  const inCents = (billableInput(promptTokens, opts) / 1_000_000) * price.inputCentsPerM;
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
  // Les modèles gratuits d'OpenRouter (connexion par défaut) ne coûtent rien.
  if (isFreeModelId(model)) return 0;
  const key = Object.keys(PRICING).find((k) => model.includes(k)) ?? "";
  const price = PRICING[key] ?? (opts?.custom ? CUSTOM_FALLBACK : FALLBACK);
  const inUsd = (billableInput(promptTokens, opts) / 1_000_000) * price.inputCentsPerM / 100;
  const outUsd = (completionTokens / 1_000_000) * price.outputCentsPerM / 100;
  return Math.max(0, inUsd + outUsd);
}
