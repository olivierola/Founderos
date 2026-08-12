// Helper: log LLM token usage + estimated cost into llm_usage.
// Best-effort — failures must never break the AI call itself.
//
// Deux écritures, deux usages : `llm_usage` reste la table d'OBSERVATION (Prompt
// Monitoring, coûts par feature, historique), et `usage_ledger` — alimenté ici
// via meterLlm — est le registre FACTURABLE (crédits, quotas, marge). Le
// branchement se fait à cet endroit unique pour que les ~15 appelants existants
// soient métrés sans les toucher un par un.

import { createServiceClient } from "./supabase-admin.ts";
import { estimateCostCents } from "./llm-pricing.ts";
import { meterLlm } from "./metering.ts";

export interface LogLlmUsageInput {
  workspace_id?: string | null;
  project_id?: string | null;
  provider: string;
  model: string;
  task?: string;
  feature?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** Self-hosted / company-registered model (no public rate) → custom estimate. */
  custom?: boolean;
  /**
   * false = observation seulement, pas de débit de crédits.
   *
   * À mettre sur les lignes de SYNTHÈSE : le runtime d'agent écrit une ligne par
   * tick (la dépense réelle) PUIS une ligne de total à la finalisation, pour que
   * le monitoring ait un enregistrement canonique par run. Facturer les deux
   * doublerait la note. `llm_usage` garde tout, `usage_ledger` ne prend que la
   * dépense réelle.
   */
  billable?: boolean;
  /** Free-form context — run_id / agent_id are indexed by Prompt Monitoring. */
  metadata?: Record<string, unknown>;
}

export async function logLlmUsage(input: LogLlmUsageInput): Promise<void> {
  try {
    const prompt = input.usage?.prompt_tokens ?? 0;
    const completion = input.usage?.completion_tokens ?? 0;
    const total = input.usage?.total_tokens ?? prompt + completion;
    const cost = estimateCostCents(input.model, prompt, completion, { custom: input.custom });
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
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("logLlmUsage failed:", err instanceof Error ? err.message : String(err));
  }

  // Facturation. Séparée du try ci-dessus : si l'observation échoue, le client
  // doit quand même être débité — et réciproquement.
  const meta = (input.metadata ?? {}) as Record<string, unknown>;
  const asUuid = (v: unknown) => (typeof v === "string" && v.length === 36 ? v : null);
  await meterLlm({
    workspace_id: input.workspace_id ?? null,
    project_id: input.project_id ?? null,
    run_id: asUuid(meta.run_id),
    agent_id: asUuid(meta.agent_id),
    provider: input.provider,
    model: input.model,
    usage: input.usage,
    custom: input.custom,
    billable: input.billable ?? true,
    feature: input.feature ?? null,
    task: input.task ?? null,
    metadata: meta,
    // Un tick d'agent peut être redélivré par le drainer : sans clé, le rejeu
    // débiterait deux fois. run_id + tick identifie l'appel de façon stable.
    idempotency_key:
      asUuid(meta.run_id) && meta.tick != null ? `run:${meta.run_id}:tick:${meta.tick}` : undefined,
  });
}
