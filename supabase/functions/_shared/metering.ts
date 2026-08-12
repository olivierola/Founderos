// Métrage d'usage et contrôle de quota — la couche runtime du système de
// limitation (migration 0194).
//
// DEUX GESTES, TOUJOURS DANS CET ORDRE :
//   1. `assertCredits(...)` AVANT d'engager une dépense (démarrage de run, tour
//      d'agent, ingestion). Lève une QuotaError si le workspace n'a plus rien.
//   2. `meterLlm(...)` / `meterUnits(...)` APRÈS l'appel fournisseur, avec les
//      quantités réelles renvoyées par celui-ci.
//
// Le contrôle bloque, le métrage ne bloque jamais : une erreur de métrage est
// avalée (log) plutôt que de faire échouer un travail déjà payé chez le
// fournisseur. C'est un choix assumé — perdre une ligne de journal coûte moins
// cher que perdre le run du client.
//
// AJOUTER UN FOURNISSEUR : insérer ses tarifs dans `ai_provider_rates` puis
// appeler `meterUnits({ provider: "mistral", sku: model, unit: "token_in", ... })`.
// Aucun code de ce fichier n'est à modifier. Un fournisseur sans tarif tombe sur
// le joker global, volontairement sur-évalué : il sur-facture (visible) au lieu
// de creuser la marge (invisible).

import { createServiceClient } from "./supabase-admin.ts";
import { jsonResponse } from "./cors.ts";

/** Unités facturables. Toute nouvelle unité doit exister côté SQL
 *  (contrainte `ai_provider_rates.unit`) avant d'être utilisée ici. */
export type MeterUnit =
  | "token_in" | "token_out" | "token"
  | "request" | "second" | "minute"
  | "image" | "character" | "gb_month";

/** Ressources plafonnées par l'offre (hors crédits). */
export type LimitMetric =
  | "services" | "agents" | "seats" | "projects"
  | "knowledge_collections" | "mcp_servers" | "scheduled_agents" | "storage_mb";

export interface MeterScope {
  workspace_id?: string | null;
  project_id?: string | null;
  run_id?: string | null;
  agent_id?: string | null;
  user_id?: string | null;
  feature?: string | null;
  task?: string | null;
}

export interface MeterEntry extends MeterScope {
  provider: string;
  /** Modèle ou produit ('deepseek-chat', 'jina-embeddings-v3', 'flux-pro'). */
  sku?: string;
  unit: MeterUnit;
  quantity: number;
  /** false = mesuré mais non facturé (clés client, geste commercial). */
  billable?: boolean;
  metadata?: Record<string, unknown>;
  /** Clé de déduplication — protège des rejeux (tick redélivré, retry). */
  idempotency_key?: string;
}

export interface QuotaDecision {
  allowed: boolean;
  /** ok | overage | unlimited | byo_keys | unscoped
   *  | credits_exhausted | overage_capped | limit_reached | blocked | subscription_inactive */
  code: string;
  reason?: string;
  metric?: string;
  label?: string;
  usage?: number;
  limit?: number | null;
  remaining?: number | null;
  plan?: string;
  period_end?: string;
}

/** Levée quand le quota interdit la dépense. Portée jusqu'à la frontière HTTP,
 *  où `quotaErrorResponse` la traduit en 402 exploitable par l'UI. */
export class QuotaError extends Error {
  readonly decision: QuotaDecision;
  constructor(decision: QuotaDecision) {
    super(decision.reason ?? "Quota atteint");
    this.name = "QuotaError";
    this.decision = decision;
  }
}

export function isQuotaError(e: unknown): e is QuotaError {
  return e instanceof QuotaError || (e as { name?: string })?.name === "QuotaError";
}

/** 402 Payment Required : le front distingue « plus de crédits » d'une panne. */
export function quotaErrorResponse(e: QuotaError): Response {
  return jsonResponse(
    { error: e.decision.reason ?? "Quota atteint", code: e.decision.code, quota: e.decision },
    { status: 402 },
  );
}

// ── Cache de décision ────────────────────────────────────────────────────────
// Une boucle d'agent interroge le quota à chaque tour et un tour dure quelques
// secondes : sans cache, on paie un aller-retour DB pour une réponse qui n'a pas
// bougé. 15 s laisse au plus un tour se glisser après l'épuisement — la ligne de
// journal est écrite quand même, le compteur reste juste.
const QUOTA_TTL_MS = 15_000;
const quotaCache = new Map<string, { at: number; decision: QuotaDecision }>();

function cacheKey(ws: string, metric: string) {
  return `${ws}:${metric}`;
}

/** Invalide le cache d'un workspace (achat de pack, changement d'offre). */
export function invalidateQuota(workspaceId: string): void {
  for (const k of quotaCache.keys()) if (k.startsWith(`${workspaceId}:`)) quotaCache.delete(k);
}

/**
 * Le workspace peut-il engager cette dépense ?
 *
 * `amount` est facultatif et volontairement approximatif : on vérifie qu'il
 * reste de quoi travailler, pas qu'il reste exactement le coût du prochain
 * appel — celui-ci n'est connu qu'une fois le fournisseur répondu.
 */
export async function checkQuota(
  workspaceId: string | null | undefined,
  metric: "credits" | LimitMetric = "credits",
  amount = 0,
  opts: { fresh?: boolean } = {},
): Promise<QuotaDecision> {
  if (!workspaceId) return { allowed: true, code: "unscoped" };

  const key = cacheKey(workspaceId, metric);
  if (!opts.fresh && amount === 0) {
    const hit = quotaCache.get(key);
    if (hit && Date.now() - hit.at < QUOTA_TTL_MS) return hit.decision;
  }

  try {
    const admin = createServiceClient();
    const { data, error } = await admin.rpc("billing_check_quota", {
      p_workspace: workspaceId,
      p_metric: metric,
      p_amount: amount,
    });
    if (error) throw error;
    const decision = (data ?? { allowed: true, code: "ok" }) as QuotaDecision;
    if (amount === 0) quotaCache.set(key, { at: Date.now(), decision });
    return decision;
  } catch (err) {
    // Le contrôle de quota ne doit pas devenir un point de panne : si la base
    // ne répond pas, on laisse passer et on trace. Le journal, lui, rattrapera
    // la consommation réelle.
    console.warn("checkQuota failed (fail-open):", err instanceof Error ? err.message : String(err));
    return { allowed: true, code: "check_failed" };
  }
}

/** Variante bloquante : lève une QuotaError si la dépense est refusée. */
export async function assertQuota(
  workspaceId: string | null | undefined,
  metric: "credits" | LimitMetric = "credits",
  amount = 0,
  opts: { fresh?: boolean } = {},
): Promise<QuotaDecision> {
  const decision = await checkQuota(workspaceId, metric, amount, opts);
  if (!decision.allowed) throw new QuotaError(decision);
  return decision;
}

/**
 * Garde-fou d'entrée d'un travail IA : exige un minimum de crédits disponibles.
 * Démarrer un run avec 3 crédits restants produit un échec au deuxième tour et
 * un client mécontent — mieux vaut refuser proprement au départ.
 */
export async function assertCredits(
  workspaceId: string | null | undefined,
  opts: { minimum?: number; fresh?: boolean } = {},
): Promise<QuotaDecision> {
  return assertQuota(workspaceId, "credits", opts.minimum ?? 0, { fresh: opts.fresh });
}

export interface RunBudget {
  credits: number;
  cap: number | null;
  exceeded: boolean;
}

/**
 * Consommation d'un run face au plafond `max_run_credits` de l'offre.
 * Un agent qui boucle est le seul scénario capable de vider un forfait en une
 * nuit : ce plafond l'arrête même quand le solde global reste confortable.
 */
export async function checkRunBudget(runId: string | null | undefined): Promise<RunBudget> {
  if (!runId) return { credits: 0, cap: null, exceeded: false };
  try {
    const admin = createServiceClient();
    const { data, error } = await admin.rpc("billing_run_budget", { p_run_id: runId });
    if (error) throw error;
    return (data ?? { credits: 0, cap: null, exceeded: false }) as RunBudget;
  } catch (err) {
    console.warn("checkRunBudget failed:", err instanceof Error ? err.message : String(err));
    return { credits: 0, cap: null, exceeded: false };
  }
}

// ── Écriture ─────────────────────────────────────────────────────────────────

/** Enregistre une ou plusieurs consommations. Best-effort, jamais bloquant. */
export async function meterUnits(entries: MeterEntry | MeterEntry[]): Promise<void> {
  const list = (Array.isArray(entries) ? entries : [entries]).filter((e) => (e.quantity ?? 0) > 0);
  if (list.length === 0) return;
  const admin = createServiceClient();
  await Promise.all(
    list.map(async (e) => {
      try {
        const { error } = await admin.rpc("meter_ai_usage", {
          p_workspace: e.workspace_id ?? null,
          p_provider: e.provider,
          p_sku: e.sku ?? "",
          p_unit: e.unit,
          p_quantity: e.quantity,
          p_project: e.project_id ?? null,
          p_feature: e.feature ?? null,
          p_task: e.task ?? null,
          p_run_id: e.run_id ?? null,
          p_agent_id: e.agent_id ?? null,
          p_user_id: e.user_id ?? null,
          p_metadata: e.metadata ?? {},
          p_idempotency_key: e.idempotency_key ?? null,
          p_billable: e.billable ?? true,
        });
        if (error) throw error;
      } catch (err) {
        console.warn("meterUnits failed:", err instanceof Error ? err.message : String(err));
      }
    }),
  );
  if (list[0]?.workspace_id) invalidateQuota(list[0].workspace_id);
}

export interface MeterLlmInput extends MeterScope {
  provider: string;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  /** Endpoint auto-hébergé : facturé sur la grille `hosted`, pas celle du modèle. */
  custom?: boolean;
  billable?: boolean;
  metadata?: Record<string, unknown>;
  /** Base de la clé d'idempotence ; les deux lignes (entrée/sortie) la suffixent. */
  idempotency_key?: string;
}

/** Un appel LLM = deux lignes de journal (entrée et sortie n'ont pas le même
 *  tarif chez aucun fournisseur ; les fusionner rendrait la marge illisible). */
export async function meterLlm(input: MeterLlmInput): Promise<void> {
  const prompt = input.usage?.prompt_tokens ?? 0;
  const completion = input.usage?.completion_tokens ?? 0;
  if (prompt <= 0 && completion <= 0) return;

  const provider = input.custom ? "hosted" : input.provider;
  const base: MeterEntry = {
    workspace_id: input.workspace_id, project_id: input.project_id,
    run_id: input.run_id, agent_id: input.agent_id, user_id: input.user_id,
    feature: input.feature, task: input.task,
    provider, sku: input.model, unit: "token_in", quantity: prompt,
    billable: input.billable, metadata: { ...(input.metadata ?? {}), model: input.model },
  };

  await meterUnits([
    { ...base, unit: "token_in", quantity: prompt,
      idempotency_key: input.idempotency_key ? `${input.idempotency_key}:in` : undefined },
    { ...base, unit: "token_out", quantity: completion,
      idempotency_key: input.idempotency_key ? `${input.idempotency_key}:out` : undefined },
  ]);
}

/** Vectorisation / reranking / lecture web Jina — facturés au token. */
export async function meterJinaTokens(
  scope: MeterScope,
  sku: string,
  tokens: number,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await meterUnits({
    ...scope, provider: "jina", sku, unit: "token", quantity: tokens, metadata,
  });
}
