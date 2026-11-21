// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/tool-error-diagnosis.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// Comprendre pourquoi un outil a échoué, pour ajuster et continuer.
//
// Un résultat « ERROR: … » n'apprenait rien au modèle de plus que son texte
// brut, et le disjoncteur ne voyait que des compteurs : un outil en échec
// trois fois de suite recevait la même consigne, qu'il manque une clé d'API
// (seul l'humain peut agir), que l'URL soit fausse (le modèle peut corriger)
// ou que le fournisseur soit en rafale (attendre suffit). Ici, chaque échec
// reçoit une CAUSE et un AJUSTEMENT, en trois étages du moins cher au plus
// cher :
//
//   1. des règles déterministes sur le texte de l'erreur (gratuit, instantané,
//      incapable d'inventer) — elles tranchent la grande majorité des cas ;
//   2. Jev quand les règles ne reconnaissent rien (un choix typé parmi les
//      causes, une seconde) ;
//   3. un modèle léger quand le MÊME outil échoue encore après ça : il lit les
//      tentatives et dit ce qu'il faut changer à l'appel (voir
//      explainRepeatedFailure, appelé par le contrôleur, une fois par outil).
//
// Le diagnostic voyage avec le résultat : le modèle le lit au tour même de
// l'échec, et le contrôleur de boucle le lit pour choisir entre réessayer,
// changer d'approche, ou demander à l'humain.

import { callAi, safeParseJson } from "./ai.ts";
import { cheapModel, cheapProvider } from "./model-router.ts";
import { choice, judge, readChoice, type JudgeContext } from "./typesafe.ts";

export type ErrorCause =
  | "invalid_args" | "unknown_tool" | "not_connected" | "auth" | "permission" | "quota"
  | "not_found" | "rate_limit" | "too_large" | "timeout" | "network" | "server"
  | "conflict" | "bad_value" | "unsupported" | "guardrail" | "unknown";

export interface ToolErrorDiagnosis {
  cause: ErrorCause;
  /** Libellé court, en français. */
  label: string;
  /** Rejouer le MÊME appel a une vraie chance de réussir. */
  transient: boolean;
  /** Seul l'humain peut débloquer (accès, connexion, crédit, décision). */
  needsHuman: boolean;
  /** L'ajustement concret à faire. */
  advice: string;
  source: "rules" | "jev" | "llm";
}

interface CauseMeta { label: string; transient: boolean; needsHuman: boolean }

export const CAUSES: Record<ErrorCause, CauseMeta> = {
  invalid_args: { label: "arguments invalides", transient: false, needsHuman: false },
  unknown_tool: { label: "outil inexistant", transient: false, needsHuman: false },
  not_connected: { label: "application non connectée", transient: false, needsHuman: true },
  auth: { label: "authentification refusée", transient: false, needsHuman: true },
  permission: { label: "droits insuffisants", transient: false, needsHuman: true },
  quota: { label: "quota ou crédit épuisé", transient: false, needsHuman: true },
  not_found: { label: "cible introuvable", transient: false, needsHuman: false },
  rate_limit: { label: "limite de débit", transient: true, needsHuman: false },
  too_large: { label: "requête ou réponse trop volumineuse", transient: false, needsHuman: false },
  timeout: { label: "délai dépassé", transient: true, needsHuman: false },
  network: { label: "service injoignable", transient: true, needsHuman: false },
  server: { label: "panne du service distant", transient: true, needsHuman: false },
  conflict: { label: "conflit avec l'existant", transient: false, needsHuman: false },
  bad_value: { label: "valeur au mauvais format", transient: false, needsHuman: false },
  unsupported: { label: "opération non prise en charge", transient: false, needsHuman: false },
  guardrail: { label: "bloqué par un garde-fou", transient: false, needsHuman: false },
  unknown: { label: "cause non identifiée", transient: false, needsHuman: false },
};

/** Les règles, dans l'ordre : la première qui reconnaît le texte gagne. Les
 *  causes les plus spécifiques passent avant les plus génériques (« 401
 *  token expired » est une auth, pas une panne 4xx quelconque). */
const RULES: Array<{ cause: ErrorCause; re: RegExp }> = [
  { cause: "guardrail", re: /bloqu[ée]e? par le guardrail|r[ée]sultat bloqu[ée]|garde-fou/i },
  { cause: "invalid_args", re: /arguments? (invalides?|coup[ée]s)|n'a PAS été exécuté|JSON incomplet|pas un objet JSON valide|is required|required (field|param|argument|property)|missing (required )?(field|param|argument|property)|must (be|have) (a|an|one of|at least)|invalid (argument|parameter|input|params)|validation (error|failed)|\b422\b|unprocessable/i },
  { cause: "unknown_tool", re: /unknown tool|outil inconnu|no such tool|tool .{0,40} (not found|does not exist)|not a (valid|known) tool/i },
  { cause: "not_connected", re: /not connected|no (active )?connection|aucune connexion|n'est pas (encore )?connect|non connect[ée]|connect(ed)? account (not|missing)|integration (is )?not (set ?up|configured|enabled)|no credentials|missing credentials|credentials? (not|missing)|n'est pas configur|non configur/i },
  { cause: "quota", re: /\b402\b|quota (exceeded|dépassé|épuisé)|insufficient (balance|funds|credits?|quota)|payment required|credit balance|crédits? (épuisés?|insuffisants?)|billing/i },
  { cause: "auth", re: /\b401\b|unauthori[sz]ed|invalid (api[ _-]?)?(key|token)|(token|session) (has )?expired|expired (token|session)|authentication (failed|required|error)|non authentifi|bad credentials|invalid_grant/i },
  { cause: "permission", re: /\b403\b|forbidden|permission denied|access denied|acc[eè]s refus[ée]|not (allowed|permitted|authorized to)|insufficient (scope|permission|privileges)|EACCES|EPERM/i },
  { cause: "rate_limit", re: /\b429\b|rate.?limit|too many requests|throttl|slow down|retry after/i },
  { cause: "too_large", re: /\b413\b|too large|payload too|trop (long|volumineux|gros)|maximum (size|length|context)|exceeds? (the )?(limit|max|maximum)|too many (tokens|results|rows)|response size/i },
  { cause: "timeout", re: /timed? ?out|timeout|n'a pas répondu|ETIMEDOUT|deadline exceeded|\b504\b|\b408\b|pas de réponse en/i },
  { cause: "network", re: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|network (error|failure|unreachable)|unreachable|injoignable|socket hang up|getaddrinfo|dns (error|failure)/i },
  { cause: "server", re: /\b50[0-3]\b|\b529\b|internal server error|bad gateway|service unavailable|temporarily unavailable|overloaded|server error|upstream (error|failure)/i },
  { cause: "not_found", re: /\b404\b|not found|introuvable|does not exist|n'existe pas|no such (file|directory|record|resource)|ENOENT|unknown (id|record|resource|object)|aucun(e)? (fiche|enregistrement|objet) (trouv|ne correspond)/i },
  { cause: "conflict", re: /\b409\b|conflict|already exists|existe déjà|duplicate|déjà (pris|utilisé)/i },
  { cause: "bad_value", re: /invalid (url|email|date|format|id|uuid|value)|malformed|cannot parse|could not parse|parse error|syntax error|unexpected token|must be absolute|format (invalide|incorrect)/i },
  { cause: "unsupported", re: /not supported|unsupported|not implemented|non pris en charge|n'est pas disponible|not available (in|for|on)|method not allowed|\b405\b/i },
];

/** L'erreur d'un résultat d'outil, ou null si ce n'est pas un échec. */
export function isToolError(result: string): boolean {
  return /^\s*(ERROR|ERREUR)\b/.test(result);
}

/** La cible principale d'un appel, pour une consigne qui la nomme. */
function targetOf(args: Record<string, unknown>): string {
  for (const k of ["url", "path", "file", "file_path", "query", "id", "slug", "action", "command", "name"]) {
    const v = args?.[k];
    if (typeof v === "string" && v.trim()) return `${k}=${v.slice(0, 120)}`;
  }
  return "";
}

/** Ce que le schéma exige, résumé en une ligne (pour invalid_args). */
function schemaHint(schema: Record<string, unknown> | undefined): string {
  if (!schema || typeof schema !== "object") return "";
  const props = (schema.properties ?? {}) as Record<string, { type?: unknown; enum?: unknown[] }>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const fmt = (k: string) => {
    const p = props[k] ?? {};
    const t = Array.isArray(p.type) ? p.type.join("|") : String(p.type ?? "any");
    const e = Array.isArray(p.enum) && p.enum.length ? ` ∈ {${p.enum.slice(0, 8).map((x) => JSON.stringify(x)).join(", ")}}` : "";
    return `${k}: ${t}${e}`;
  };
  const req = required.map(fmt).join(", ");
  const opt = Object.keys(props).filter((k) => !required.includes(k)).slice(0, 8).map(fmt).join(", ");
  return [req ? `obligatoires : ${req}` : "", opt ? `facultatifs : ${opt}` : ""].filter(Boolean).join(" ; ");
}

function adviceFor(
  cause: ErrorCause, tool: string, args: Record<string, unknown>, schema?: Record<string, unknown>,
): string {
  const target = targetOf(args);
  const on = target ? ` (${target})` : "";
  switch (cause) {
    case "invalid_args": {
      const hint = schemaHint(schema);
      return `Corrige les arguments de ${tool} d'après son schéma${hint ? ` — ${hint}` : ""} — puis rappelle-le. Ne change pas d'outil pour ça.`;
    }
    case "unknown_tool":
      return "Cet outil n'existe pas dans ta boîte. Vérifie le nom exact dans ton inventaire, ou appelle need_tools(\"<ce que tu veux faire>\") pour charger le bon.";
    case "not_connected":
      return `L'application derrière ${tool} n'est pas connectée pour cet espace. Ne réessaie pas : demande à l'utilisateur (ask_user) de la connecter, ou fais sans elle et dis-le.`;
    case "auth":
      return `L'accès de ${tool} est refusé (clé ou jeton invalide ou expiré). Réessayer ne changera rien : signale-le à l'utilisateur (ask_user) avec le nom du service, et continue le reste du travail.`;
    case "permission":
      return `Le compte utilisé n'a pas les droits pour cette action${on}. Essaie une action en lecture seule ou une autre cible ; si l'action est indispensable, demande les droits à l'utilisateur (ask_user).`;
    case "quota":
      return "Le quota ou le crédit du service est épuisé. Ne réessaie pas : passe par une autre source si tu en as une, sinon signale-le à l'utilisateur.";
    case "not_found":
      return `La cible n'existe pas${on}. Ne la redemande pas telle quelle : retrouve d'abord le bon identifiant, chemin ou URL (recherche, liste, lecture du parent), puis rappelle ${tool} avec la valeur vérifiée.`;
    case "rate_limit":
      return `Le service limite le débit. Espace tes appels à ${tool} (un à la fois), regroupe ce qui peut l'être, ou passe à une autre source le temps que la limite retombe.`;
    case "too_large":
      return `La demande ou sa réponse est trop volumineuse. Découpe : pagine (limit/offset), filtre davantage, ou demande moins de champs à ${tool}.`;
    case "timeout":
      return `${tool} n'a pas répondu à temps. Réduis la portée de l'appel (moins de données, une page à la fois) ; pour une commande longue, lance-la en arrière-plan (run_background) puis relis son journal.`;
    case "network":
      return `Le service visé par ${tool} est injoignable${on}. Vérifie l'adresse ; si elle est juste, passe à une autre source et reviens-y plus tard.`;
    case "server":
      return `Le service distant est en panne passagère. Une nouvelle tentative plus tard peut passer ; en attendant, avance sur une autre étape ou une autre source.`;
    case "conflict":
      return `L'élément existe déjà ou a changé entre-temps${on}. Relis l'état actuel, puis mets à jour l'existant au lieu de le recréer.`;
    case "bad_value":
      return `Une valeur n'a pas le format attendu${on}. Corrige-la (URL absolue, date ISO, identifiant exact) et rappelle ${tool}.`;
    case "unsupported":
      return `${tool} ne sait pas faire cette opération. Cherche l'outil qui la fait dans ton inventaire (need_tools), ou procède autrement.`;
    case "guardrail":
      return "Un garde-fou de l'espace interdit cette action. Ne la contourne pas avec une variante : fais sans, ou explique à l'utilisateur pourquoi elle est nécessaire (ask_user).";
    default:
      return `Lis le message d'erreur : s'il désigne un paramètre, corrige-le ; sinon essaie une approche différente (autre outil, autre source) plutôt que le même appel.`;
  }
}

export function makeDiagnosis(
  cause: ErrorCause, tool: string, args: Record<string, unknown>,
  source: ToolErrorDiagnosis["source"], schema?: Record<string, unknown>,
): ToolErrorDiagnosis {
  const meta = CAUSES[cause];
  return { cause, label: meta.label, transient: meta.transient, needsHuman: meta.needsHuman, advice: adviceFor(cause, tool, args, schema), source };
}

/** Diagnostic par règles. `null` quand le résultat n'est pas une erreur. */
export function diagnoseToolError(
  tool: string, args: Record<string, unknown>, result: string, schema?: Record<string, unknown>,
): ToolErrorDiagnosis | null {
  if (!isToolError(result)) return null;
  // On lit le début et la fin : le verdict d'une erreur longue est souvent en bas.
  const text = result.length > 2400 ? `${result.slice(0, 1600)}\n${result.slice(-800)}` : result;
  const hit = RULES.find((r) => r.re.test(text));
  return makeDiagnosis(hit?.cause ?? "unknown", tool, args, "rules", schema);
}

/** Le diagnostic, ajouté à la fin du résultat (la fin survit à la troncature). */
export function withDiagnosis(result: string, d: ToolErrorDiagnosis): string {
  if (result.includes("[DIAGNOSTIC")) return result;
  return `${result}\n\n[DIAGNOSTIC du harnais] Cause probable : ${d.label}. Ajustement : ${d.advice}`;
}

/** Délai avant de rejouer AUTOMATIQUEMENT un appel en échec passager, ou null.
 *  Réservé aux outils sans effet (lecture idempotente) : rejouer un envoi dont
 *  l'effet est inconnu pourrait le doubler. Une seule fois. */
export function autoRetryDelayMs(d: ToolErrorDiagnosis, result: string, idempotent: boolean): number | null {
  if (!idempotent || !d.transient) return null;
  const after = /retry[- ]after[^\d]{0,12}(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(result);
  if (after) {
    const n = Number(after[1]);
    const ms = after[2]?.toLowerCase() === "ms" ? n : n * 1000;
    return ms <= 8_000 ? Math.max(250, ms) : null;
  }
  if (d.cause === "rate_limit") return 2_000;
  if (d.cause === "server") return 1_000;
  if (d.cause === "network") return 750;
  // Un délai dépassé a déjà coûté son délai : on ne le paie qu'une fois de plus
  // si c'est une lecture, et sans attendre.
  if (d.cause === "timeout") return 0;
  return null;
}

// ── Étage 2 : Jev, quand les règles ne reconnaissent rien ──────────────────

const JEV_CRITERIA: Record<Exclude<ErrorCause, "unknown" | "guardrail">, { what: string; not_for?: string; examples?: string[] }> = {
  invalid_args: { what: "L'appel est mal formé : paramètre manquant, en trop, de mauvais type ou hors des valeurs permises.", not_for: "Une valeur bien formée mais qui désigne une chose inexistante (not_found).", examples: ["field 'channel' is required", "limit must be an integer"] },
  unknown_tool: { what: "L'outil ou l'action appelé n'existe pas sous ce nom." },
  not_connected: { what: "L'application ou l'intégration n'est pas connectée ou configurée pour ce compte.", examples: ["No connected account for gmail"] },
  auth: { what: "Identifiants refusés : clé, jeton ou session invalide ou expiré.", not_for: "Un compte valide à qui il manque un droit (permission)." },
  permission: { what: "Le compte est reconnu mais n'a pas le droit de faire cette action." },
  quota: { what: "Quota, crédit ou forfait épuisé : il faut payer ou attendre longtemps." },
  not_found: { what: "La ressource visée (fichier, URL, fiche, identifiant) n'existe pas.", examples: ["Repository not found", "No contact with id 123"] },
  rate_limit: { what: "Trop d'appels en peu de temps ; attendre un peu suffit." },
  too_large: { what: "La demande ou la réponse dépasse une taille maximale." },
  timeout: { what: "Le service n'a pas répondu dans le délai." },
  network: { what: "Le service est injoignable : réseau, DNS, connexion refusée." },
  server: { what: "Erreur interne ou panne passagère du service distant." },
  conflict: { what: "L'action entre en conflit avec l'état actuel : l'élément existe déjà ou a changé." },
  bad_value: { what: "Une valeur a un format incorrect : URL, date, e-mail, identifiant mal écrit." },
  unsupported: { what: "Le service ne sait pas faire cette opération, ou pas avec ces options." },
};

/** Un choix typé parmi les causes, quand les règles n'ont rien reconnu. null :
 *  Jev éteint, indisponible, ou pas assez sûr — le diagnostic par règles reste. */
export async function judgeToolErrorCause(
  ctx: JudgeContext, tool: string, args: Record<string, unknown>, result: string, schema?: Record<string, unknown>,
): Promise<ToolErrorDiagnosis | null> {
  const verdict = await judge(ctx, "tool_error_diagnosis", {
    outil: tool,
    arguments: JSON.stringify(args ?? {}).slice(0, 600),
    erreur: result.slice(0, 1500),
  }, {
    cause: choice("Quelle est la cause de cet échec d'appel d'outil ?", JEV_CRITERIA),
  }, { subject: `erreur · ${tool}` }).catch(() => null);
  const c = verdict?.apply ? readChoice(verdict, "cause") : null;
  if (!c || c.confidence < verdict!.threshold || !(c.choice in CAUSES)) return null;
  return makeDiagnosis(c.choice as ErrorCause, tool, args, "jev", schema);
}

// ── Étage 3 : l'explication, quand le même outil échoue encore ─────────────

export interface FailedAttempt { args: Record<string, unknown>; error: string; cause?: ErrorCause }

/**
 * Pourquoi CET outil continue d'échouer, et quel appel tenter à la place.
 *
 * Un modèle léger lit les dernières tentatives (arguments et erreurs) et le
 * schéma, et rend une cause et une correction concrète. Appelé par le
 * contrôleur une seule fois par outil et par run : c'est le cas où le modèle
 * principal n'a pas su lire ses propres erreurs.
 */
export async function explainRepeatedFailure(input: {
  tool: string; schema?: Record<string, unknown>; attempts: FailedAttempt[]; goal: string;
}): Promise<{ cause: string; fix: string; giveUp: boolean } | null> {
  if (!input.attempts.length) return null;
  try {
    const res = await callAi({
      task: "json_extraction", provider: cheapProvider(), model: cheapModel(),
      jsonMode: true, maxTokens: 500, temperature: 0.1,
      systemPrompt: [
        "You debug an autonomous agent's failing tool calls. Read the attempts (arguments + error) and the tool's JSON schema.",
        "Find the ROOT cause (wrong argument shape, wrong id/path/url, missing access, service down, wrong tool for the job…) and the CONCRETE fix:",
        "the exact corrected arguments, or the other tool/approach to use. If only the user can unblock it (credentials, connection, a decision), say so and set give_up=true.",
        'Return STRICT JSON: {"cause":"one sentence, French","fix":"one or two sentences, French, concrete","give_up":true|false}',
      ].join("\n"),
      userPrompt: [
        `OBJECTIF DE L'AGENT : ${input.goal.slice(0, 600)}`,
        `OUTIL : ${input.tool}`,
        input.schema ? `SCHÉMA : ${JSON.stringify(input.schema).slice(0, 1500)}` : "",
        "TENTATIVES (de la plus ancienne à la plus récente) :",
        ...input.attempts.slice(-3).map((a, i) => `${i + 1}. args=${JSON.stringify(a.args).slice(0, 500)}\n   erreur=${a.error.slice(0, 600)}`),
      ].filter(Boolean).join("\n"),
    });
    const j = safeParseJson<{ cause?: string; fix?: string; give_up?: boolean }>(res.content);
    if (!j?.cause || !j?.fix) return null;
    return { cause: String(j.cause).slice(0, 300), fix: String(j.fix).slice(0, 500), giveUp: j.give_up === true };
  } catch {
    return null;
  }
}
