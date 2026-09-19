import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

// Lecture des stats d'un agent public. Tout est agrégé par la RPC
// `rag_agent_analytics` (migration 0217) : le navigateur ne rapatrie plus des
// milliers de conversations pour les recompter — ce que faisait l'ancien onglet,
// avec un `.limit(2000)` qui faisait silencieusement mentir les totaux dès
// qu'un agent marchait bien.

export interface Totals {
  total: number; involved: number; resolved: number; unresolved: number;
  escalated: number; abandoned: number; unknown_outcome: number;
  rated: number; rated_positive: number; rated_neutral: number; rated_negative: number;
  visitors: number; single_turn: number; messages: number; tool_calls: number;
  avg_first_ms: number | null; avg_duration_s: number | null; avg_rating: number | null;
}

export interface Previous {
  total: number; resolved: number; involved: number; rated: number;
  rated_positive: number; visitors: number;
}

export interface AgentAnalytics {
  days: number;
  since: string;
  totals: Totals;
  previous: Previous;
  daily: { day: string; conversations: number; visitors: number; messages: number; resolved: number }[];
  ratings: { score: number; n: number }[];
  reasons_positive: { reason: string; n: number }[];
  reasons_negative: { reason: string; n: number }[];
  reasons_unresolved: { reason: string; n: number }[];
  countries: { code: string; conversations: number; visitors: number }[];
  devices: { device: string; n: number }[];
  channels: { channel: string; n: number; resolved: number; involved: number }[];
  outcome_cx: { outcome: string; cx: "positive" | "neutral" | "negative" | "unrated"; n: number }[];
  referrers: { referrer: string; n: number }[];
  pages: { page: string; n: number }[];
  questions: { question: string; n: number }[];
  tools: { tool_name: string; calls: number; errors: number; avg_ms: number | null }[];
  llm: { requests: number; tokens: number; cost_cents: number };
  knowledge: { sources: number; ready: number; chunks: number };
}

export function useAgentAnalytics(agentId: string, days: number) {
  return useQuery({
    queryKey: ["rag_agent_analytics", agentId, days],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("rag_agent_analytics", {
        p_agent_id: agentId, p_days: days,
      });
      if (error) throw error;
      return data as unknown as AgentAnalytics;
    },
  });
}

/**
 * Message lisible pour une erreur de lecture des stats.
 *
 * Supabase ne rejette PAS une Error : PostgREST renvoie un objet nu
 * { message, details, hint, code }. Le passer à String() affichait
 * « [object Object] » à l'écran — le message le plus inutile de l'application,
 * et celui qui laissait croire à un bug du front alors que la base n'avait
 * simplement pas reçu la migration.
 */
export function describeAnalyticsError(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown; hint?: unknown; details?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  const code = typeof e?.code === "string" ? e.code : "";

  // La fonction d'agrégation manque : la base n'a pas encore reçu 0217.
  if (code === "PGRST202" || /rag_agent_analytics/.test(message)) {
    return "La migration 0217_public_agent_analytics n'est pas appliquée sur cette base : "
      + "la fonction d'agrégation rag_agent_analytics n'existe pas. "
      + "Poussez les migrations Supabase, puis rechargez la page.";
  }
  if (/Accès refusé/.test(message)) {
    return "Cet agent appartient à un autre espace de travail.";
  }

  const details = typeof e?.details === "string" ? e.details : "";
  const hint = typeof e?.hint === "string" ? e.hint : "";
  const head = message || details || String(error ?? "");
  if (!head) return "Erreur inconnue.";
  return head + (code ? ` (${code})` : "") + (hint ? ` — ${hint}` : "");
}

// ── Dérivés ────────────────────────────────────────────────────────────────
// Le dénominateur de tous les taux est le volume MESURÉ, pas le volume total :
// les conversations antérieures à la migration 0217 n'ont pas d'issue, et les
// compter comme des échecs ferait plonger un taux sans qu'aucun agent n'ait
// changé de comportement. L'écart est affiché à l'écran, jamais dissimulé.
export function measured(t: Totals): number {
  return Math.max(0, t.total - t.unknown_outcome);
}

export function pct(num: number, den: number): number | null {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 10;
}

/** Écart en POINTS entre deux taux (pas une variation relative : passer de 20 %
 *  à 25 % est « +5 pts », dire « +25 % » n'aiderait personne). */
export function pointsDelta(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null) return null;
  return Math.round((current - previous) * 10) / 10;
}

export function fmtDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

export function fmtMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export const nf = new Intl.NumberFormat("fr-FR");
