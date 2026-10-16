/**
 * L'ancien dashboard Admin a été fusionné dans AI Workforce : il est devenu le
 * module « Administration » (zone admin du rail, src/lib/navigation.ts), avec
 * ses trois sections au complet et ses adresses /admin/<onglet> inchangées. Le
 * module Gouvernance de la zone Control, qui en doublait une partie, a été
 * retiré : ses anciennes adresses redirigent ici.
 */

/** Onglet d'arrivée de l'administration (/admin/<slug>). */
export const ADMIN_LANDING = "organisation";

/** Anciennes adresses du module Gouvernance → leur onglet de l'Administration. */
export const LEGACY_GOVERNANCE_REDIRECTS: Record<string, string> = {
  guardrails: "admin/gov-guardrails",
  "agent-access": "admin/gov-access",
  prompts: "admin/gov-prompts",
  costs: "admin/gov-costs",
  "ops-incidents": "admin/gov-incidents",
  "ft-security": "admin/gov-security",
};
