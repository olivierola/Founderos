// Helper: log LLM token usage + estimated cost into llm_usage.
// Best-effort — failures must never break the AI call itself.

import { createServiceClient } from "./supabase-admin.ts";
import { estimateCostCents } from "./llm-pricing.ts";

export interface LogLlmUsageInput {
  workspace_id?: string | null;
  project_id?: string | null;
  provider: string;
  model: string;
  task?: string;
  feature?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export async function logLlmUsage(input: LogLlmUsageInput): Promise<void> {
  try {
    const prompt = input.usage?.prompt_tokens ?? 0;
    const completion = input.usage?.completion_tokens ?? 0;
    const total = input.usage?.total_tokens ?? prompt + completion;
    const cost = estimateCostCents(input.model, prompt, completion);
    const admin = createServiceClient();
    await admin.from("llm_usage").insert({
      workspace_id: input.workspace_id ?? null,
      project_id: input.project_id ?? null,
      provider: input.provider,
      model: input.model,
      task: input.task ?? null,
      feature: input.feature ?? null,
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
      estimated_cost_cents: cost,
      currency: "eur",
      metadata: {},
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("logLlmUsage failed:", err instanceof Error ? err.message : String(err));
  }
}
