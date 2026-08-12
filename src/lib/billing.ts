// Accès client au système d'offres et de quotas (migration 0194).
//
// Le catalogue vit en base, pas dans ce fichier : une grille tarifaire dupliquée
// dans le front finit toujours par mentir. On ne garde ici que la traduction des
// unités (crédits, Mo) et le vocabulaire des messages.

import { supabase } from "@/lib/supabase";

/** 1 000 crédits = 1 € de prix catalogue. Sert uniquement à afficher un ordre de
 *  grandeur en euros à côté d'un solde ; la facturation reste en crédits. */
export const CREDITS_PER_EUR = 1000;

export interface BillingPlan {
  code: string;
  name: string;
  tagline: string;
  price_cents_eur: number;
  annual_price_cents_eur: number | null;
  is_quote: boolean;
  included_credits: number;
  included_seats: number;
  extra_seat_cents_eur: number;
  limits: Record<string, number>;
  features: Record<string, boolean>;
  sort_order: number;
}

export interface CreditPack {
  code: string;
  name: string;
  credits: number;
  price_cents_eur: number;
  sort_order: number;
}

export interface ResourceUsage {
  used: number;
  limit: number;
  label: string;
}

export interface Entitlements {
  plan: {
    code: string;
    name: string;
    tagline: string;
    price_cents_eur: number;
    is_quote: boolean;
    limits: Record<string, number>;
    features: Record<string, boolean>;
    included_seats: number;
    overage_micro_eur_per_credit: number;
  };
  subscription: {
    status: string;
    period_start: string;
    period_end: string;
    seats: number;
    hard_blocked: boolean;
    byo_provider_keys: boolean;
    overage_enabled: boolean;
    overage_cap_credits: number;
    trial_ends_at: string | null;
  };
  credits: {
    included: number;
    used: number;
    topup: number;
    overage_used: number;
    remaining: number;
    percent: number;
  };
  counters: Record<string, number>;
  resources: Record<string, ResourceUsage>;
}

export interface UsageBreakdownRow {
  label: string;
  credits: number;
  quantity: number;
  events: number;
}

export async function fetchEntitlements(workspaceId: string): Promise<Entitlements> {
  const { data, error } = await supabase.rpc("billing_entitlements", { p_workspace: workspaceId });
  if (error) throw new Error(error.message);
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  return data as Entitlements;
}

export async function fetchPlans(): Promise<BillingPlan[]> {
  const { data, error } = await supabase
    .from("billing_plans")
    .select("*")
    .eq("is_active", true)
    .eq("is_public", true)
    .order("sort_order");
  if (error) throw new Error(error.message);
  return (data ?? []) as BillingPlan[];
}

export async function fetchCreditPacks(): Promise<CreditPack[]> {
  const { data, error } = await supabase
    .from("credit_packs").select("*").eq("is_active", true).order("sort_order");
  if (error) throw new Error(error.message);
  return (data ?? []) as CreditPack[];
}

export async function fetchUsageBreakdown(
  workspaceId: string,
  dimension: "provider" | "feature" | "agent" | "sku" = "provider",
  days = 30,
): Promise<UsageBreakdownRow[]> {
  const { data, error } = await supabase.rpc("billing_usage_breakdown", {
    p_workspace: workspaceId, p_dimension: dimension, p_days: days,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as UsageBreakdownRow[];
}

// ── Formatage ────────────────────────────────────────────────────────────────

export function formatCredits(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)} M`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)} k`;
  return v.toLocaleString("fr-FR");
}

export function formatPrice(cents: number): string {
  return cents === 0 ? "0 €" : `${(cents / 100).toLocaleString("fr-FR")} €`;
}

/** Les limites de stockage sont stockées en Mo ; au-delà du Go on affiche en Go. */
export function formatStorage(mb: number): string {
  if (mb < 0) return "illimité";
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} Go`;
  return `${Math.round(mb)} Mo`;
}

export function formatLimit(metric: string, value: number): string {
  if (value < 0) return "illimité";
  if (metric === "storage_mb") return formatStorage(value);
  return value.toLocaleString("fr-FR");
}

/** Un quota franchi doit se voir avant d'être atteint : 80 % = attention. */
export function usageTone(used: number, limit: number): "ok" | "warn" | "over" {
  if (limit < 0) return "ok";
  if (limit === 0) return used > 0 ? "over" : "ok";
  const pct = (used / limit) * 100;
  return pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok";
}

export const FEATURE_LABELS: Record<string, string> = {
  agent_runtime: "Exécution d'agents",
  governance_registry: "Registre de gouvernance IA",
  guardrails_runtime: "Guardrails appliqués en exécution",
  hitl_approvals: "Validations humaines (HITL)",
  audit_export: "Export d'audit",
  sso: "SSO",
  byo_keys: "Clés fournisseurs dédiées",
  white_label: "Marque blanche",
  priority_support: "Support prioritaire",
  dedicated_support: "Support dédié",
};

/** Ordre d'affichage des ressources : ce que le client regarde en premier. */
export const RESOURCE_ORDER = [
  "services", "agents", "seats", "storage_mb", "projects",
  "knowledge_collections", "scheduled_agents", "mcp_servers",
];
