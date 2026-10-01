// Le jugement rapide — TypeSafe (Jev), branché partout, actif nulle part.
//
// Jev est un modèle « System One » : on lui donne un ÉTAT et des QUESTIONS
// typées, il rend des réponses typées avec leur probabilité, en une seule passe.
// Il n'écrit pas de texte. Il ne remplace donc aucun de nos appels génératifs :
// il décide AUTOUR d'eux — quelle skill charger, quel agent est le bon, ce run
// est-il fini, ce passage est-il pertinent, ce message est-il dangereux.
//
// Trois primitives, mélangeables dans un seul appel :
//   choice — une option parmi N (255 max), avec la distribution complète
//   score  — une note sur un barème de 2 à 10 niveaux
//   noul   — « est-ce vrai ? », un nombre entre 0 et 1
//
// ── Les trois règles de ce module ───────────────────────────────────────────
//
// 1. IL NE LÈVE JAMAIS. Un appel qui échoue, qui traîne, ou une clé absente
//    rendent `null`, et l'appelant garde son comportement d'avant. Aucun de ces
//    jugements n'est indispensable : ils améliorent une décision que le code
//    sait déjà prendre.
// 2. IL NE DÉCIDE RIEN SANS QU'ON LE LUI DEMANDE. Chaque usage a son réglage
//    (`off` / `shadow` / `on`, table `typesafe_settings`). En `shadow`, l'appel
//    est fait et journalisé mais la réponse n'est pas utilisée — c'est ce qui
//    permet de comparer sur des données réelles avant de basculer.
// 3. IL JOURNALISE TOUT. `typesafe_judgements` garde la question, les
//    probabilités, la confiance, la latence et le coût. Sans ce journal, le
//    mode shadow ne servirait à rien et un jugement qui bloque un message ne
//    serait pas défendable devant la gouvernance.
//
// Pas de SDK : le SDK officiel vise Node 20+, on tourne sur Deno, et l'API HTTP
// tient en quinze lignes. Une dépendance de moins à suivre.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { logLlmUsage } from "./llm-tracking.ts";

type Admin = SupabaseClient;

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
/** Un jugement qui dépasse ça n'en est plus un : on repart sur le chemin
 *  d'avant plutôt que de faire attendre un run pour une opinion. */
const TIMEOUT_MS = 6_000;

// ── Les usages ───────────────────────────────────────────────────────────────

export type TypesafeFeature =
  /** Garde-fous sémantiques (prompt, appel d'outil, résultat, message public). */
  | "guardrails"
  /** Quelles skills entrent dans le prompt de ce tour. */
  | "skill_ranking"
  /** Quels schémas d'outils sont envoyés ce tour-ci. */
  | "tool_ranking"
  /** Quel agent prend le travail (routage d'une room, recherche d'équipier). */
  | "agent_choice"
  /** Le contrat de réussite est-il réellement rempli — fin de run. */
  | "run_end"
  /** Ce tour a-t-il besoin d'aller chercher, ou la réponse est-elle déjà là. */
  | "search_decision"
  /** Les passages récupérés valent-ils d'être donnés au modèle. */
  | "rag_rerank"
  /** Cette action est-elle plus risquée que ne le dit la liste statique. */
  | "approval_risk"
  /** Le bloc « Condition jugée » d'un workflow. */
  | "workflow_judge"
  /** Quel élément de la page cliquer / remplir, dans le navigateur piloté. */
  | "browser_target"
  /** AgentPilot — le modèle de raisonnement se justifie-t-il pour cette tâche. */
  | "model_choice"
  /** AgentPilot — l'agent tourne-t-il en rond sous des formes différentes. */
  | "loop_watch"
  /** AgentPilot — le blocage dépend-il d'une chose que seul l'humain peut donner. */
  | "human_escalation"
  /** ResolveAI — intention, urgence et besoin d'un humain pour un message reçu par un agent public. */
  | "support_triage"
  /** PolicyGuard — le niveau de risque d'une action avant son exécution. */
  | "policy_guard"
  /** LeadSense — type, critères, urgence et commercial d'un prospect. */
  | "lead_scoring"
  /** SentinelFlow — catégorie, situation, avis faux positif, escalade et procédure d'une alerte de sécurité. */
  | "soc_triage";

export type TypesafeMode = "off" | "shadow" | "on";

export interface FeatureConfig {
  mode: TypesafeMode;
  /** Le seuil propre à l'usage — ce qu'il signifie est écrit sur chaque site
   *  d'appel (probabilité de danger, confiance minimale, note minimale…). */
  threshold: number;
}

export interface FeatureMeta {
  feature: TypesafeFeature;
  label: string;
  /** Ce que ça change, concrètement, quand on passe en `on`. */
  effect: string;
  /** Ce que le seuil règle. Vide quand l'usage n'en a pas besoin. */
  thresholdLabel: string;
  defaultThreshold: number;
}

/**
 * Le catalogue, partagé avec l'écran de réglages.
 *
 * Les seuils par défaut sont volontairement PRUDENTS : la documentation de
 * TypeSafe recommande d'agir seul au-dessus de 0,9, de demander confirmation
 * entre les deux et de passer la main sous 0,5 — et de relever le seuil dès que
 * l'action est destructrice. On part au-dessus de ces valeurs partout où une
 * erreur coûte quelque chose.
 */
export const TYPESAFE_FEATURES: FeatureMeta[] = [
  {
    feature: "guardrails",
    label: "Garde-fous sémantiques",
    effect: "Les règles de la Gouvernance sont évaluées par le sens, pas seulement par leur expression régulière. Un blocage exige la probabilité ci-contre.",
    thresholdLabel: "Probabilité minimale pour bloquer",
    defaultThreshold: 0.75,
  },
  {
    feature: "skill_ranking",
    label: "Choix des skills",
    effect: "Les skills envoyées dans le prompt sont classées par le modèle plutôt que par correspondance de mots.",
    thresholdLabel: "Probabilité minimale pour remonter une skill",
    defaultThreshold: 0.05,
  },
  {
    feature: "tool_ranking",
    label: "Choix des outils",
    effect: "La famille d'outils utile à la tâche est choisie, et ses schémas passent devant les autres.",
    thresholdLabel: "Confiance minimale pour appliquer le choix",
    defaultThreshold: 0.5,
  },
  {
    feature: "agent_choice",
    label: "Choix de l'agent",
    effect: "Le routage d'une room tranche « je réponds / je passe à X » sans appel de modèle génératif quand il est sûr ; la recherche d'équipier est classée par pertinence.",
    thresholdLabel: "Confiance minimale pour trancher seul",
    defaultThreshold: 0.8,
  },
  {
    feature: "run_end",
    label: "Fin de run",
    effect: "La vérification du contrat de réussite (chaque critère est-il rempli) se fait en un appel typé au lieu d'un appel de modèle génératif.",
    thresholdLabel: "Probabilité minimale pour déclarer un critère rempli",
    defaultThreshold: 0.6,
  },
  {
    feature: "search_decision",
    label: "Décision de recherche",
    effect: "Le tour dit s'il faut aller chercher (web, base de connaissances) ou si la réponse est déjà dans le contexte.",
    thresholdLabel: "Probabilité au-delà de laquelle on considère qu'il faut chercher",
    defaultThreshold: 0.6,
  },
  {
    feature: "rag_rerank",
    label: "ContextIQ — filtre de contexte RAG",
    effect: "Les passages récupérés sont notés et les inutiles écartés ; la couverture de la question et les contradictions sont jugées, et une couverture faible élargit la recherche ou fait dire « je ne sais pas ».",
    thresholdLabel: "Note minimale (0-3) pour garder un passage",
    defaultThreshold: 1,
  },
  {
    feature: "approval_risk",
    label: "Risque d'une action",
    effect: "Une action jugée irréversible passe en approbation même si elle n'est pas dans la liste des écritures connues. N'enlève JAMAIS une approbation existante.",
    thresholdLabel: "Probabilité d'irréversibilité qui déclenche l'approbation",
    // Bas EXPRÈS : ici, l'erreur qui coûte cher est de RATER une action
    // destructrice, pas d'en faire valider une de trop. La documentation de
    // TypeSafe dit la règle — on relève le seuil quand agir sur un faux oui
    // coûte cher, on le baisse quand manquer un vrai oui coûte cher.
    defaultThreshold: 0.5,
  },
  {
    feature: "browser_target",
    label: "Ciblage dans le navigateur",
    effect: "L'agent peut dire ce qu'il veut atteindre (« le bouton qui valide la commande ») et l'élément est choisi dans la page par le modèle, au lieu de faire un aller-retour génératif avec toute la liste des éléments.",
    thresholdLabel: "Confiance minimale pour agir sur l'élément choisi",
    // Haut : un clic au mauvais endroit dans le navigateur de quelqu'un est
    // une action réelle, immédiate, et souvent irréversible.
    defaultThreshold: 0.75,
  },
  {
    feature: "workflow_judge",
    label: "Condition jugée (workflows)",
    effect: "Active le bloc « Condition jugée » dans les automatisations : une question en français tranchée par le modèle, avec sa probabilité journalisée.",
    thresholdLabel: "Probabilité au-delà de laquelle la condition est vraie",
    defaultThreshold: 0.6,
  },
  {
    feature: "model_choice",
    label: "AgentPilot — choix du modèle",
    effect: "Le modèle de raisonnement n'est pris que quand la tâche l'exige vraiment (analyse, diagnostic, plan sous contraintes), au lieu d'une liste de mots-clés.",
    thresholdLabel: "Probabilité minimale pour prendre le modèle de raisonnement",
    defaultThreshold: 0.7,
  },
  {
    feature: "loop_watch",
    label: "AgentPilot — boucles déguisées",
    effect: "Une boucle de reformulations (la même recherche sous cinq formes) déclenche la replanification, comme une boucle d'appels identiques.",
    thresholdLabel: "Probabilité minimale pour déclarer une boucle",
    // Haut : une fausse boucle coûte une replanification ET le modèle lourd.
    defaultThreshold: 0.75,
  },
  {
    feature: "human_escalation",
    label: "AgentPilot — escalade vers l'humain",
    effect: "Quand un blocage dépend d'un accès, d'un document ou d'une décision de l'utilisateur, l'agent pose la question au lieu de replanifier dans le vide.",
    thresholdLabel: "Probabilité minimale pour poser la question",
    defaultThreshold: 0.7,
  },
  {
    feature: "support_triage",
    label: "ResolveAI — tri des demandes",
    effect: "Chaque message reçu par un agent public est classé (intention, urgence, besoin d'une personne) ; une demande qui relève de l'équipe reçoit une réponse prudente et entre dans la file « Demandes » avec son échéance.",
    thresholdLabel: "Probabilité minimale pour confier la demande à l'équipe",
    // Bas : laisser l'agent répondre seul à une demande de remboursement coûte
    // plus cher que d'en confier une de trop à l'équipe.
    defaultThreshold: 0.55,
  },
  {
    feature: "policy_guard",
    label: "PolicyGuard — risque des actions",
    effect: "Chaque action d'écriture d'un agent reçoit un niveau de risque (0 lecture → 3 irréversible), confronté à la grille de son équipe : approbation, refus, ou plafond de l'autopilote. Ne retire jamais une approbation existante.",
    thresholdLabel: "",
    defaultThreshold: 0.5,
  },
  {
    feature: "lead_scoring",
    label: "LeadSense — qualification",
    effect: "L'outil lead_sense des agents internes qualifie un prospect sur la grille de l'entreprise (type, critères, score, rang, prospect chaud, commercial). Éteint, l'outil refuse de noter plutôt que de deviner.",
    thresholdLabel: "Probabilité minimale pour déclarer un prospect chaud",
    defaultThreshold: 0.6,
  },
  {
    feature: "soc_triage",
    label: "SentinelFlow — triage des alertes",
    effect: "Chaque alerte de sécurité reçue est classée (catégorie, situation réelle, procédure) et les cas urgents sont escaladés. Un faux positif n'est jamais décidé par le modèle : seulement par des critères vérifiables.",
    thresholdLabel: "Probabilité minimale pour escalader à un analyste",
    defaultThreshold: 0.7,
  },
];

const META = new Map(TYPESAFE_FEATURES.map((f) => [f.feature, f]));

export const defaultConfig = (feature: TypesafeFeature): FeatureConfig => ({
  mode: "off",
  threshold: META.get(feature)?.defaultThreshold ?? 0.7,
});

// ── Les réglages, lus une fois par minute ────────────────────────────────────

interface CachedConfig { at: number; features: Record<string, FeatureConfig> }
const cache = new Map<string, CachedConfig>();
const CACHE_MS = 60_000;

/** Les réglages d'un espace de travail. Mis en cache dans l'isolat : un run
 *  fait des dizaines de jugements, et relire la table à chaque fois coûterait
 *  plus cher que l'appel qu'on cherche à économiser. */
export async function loadTypesafeConfig(
  admin: Admin, workspaceId: string,
): Promise<Record<string, FeatureConfig>> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.features;
  let features: Record<string, FeatureConfig> = {};
  try {
    const { data } = await admin.from("typesafe_settings")
      .select("features").eq("workspace_id", workspaceId).maybeSingle();
    const raw = (data as { features?: Record<string, unknown> } | null)?.features ?? {};
    for (const [k, v] of Object.entries(raw)) {
      const row = (v ?? {}) as Partial<FeatureConfig>;
      const mode = row.mode === "on" || row.mode === "shadow" ? row.mode : "off";
      const threshold = Number(row.threshold);
      features[k] = {
        mode,
        threshold: Number.isFinite(threshold) ? threshold : (META.get(k as TypesafeFeature)?.defaultThreshold ?? 0.7),
      };
    }
  } catch {
    // Pas de table, pas de droits, pas de réseau : tout est éteint. Une panne
    // de réglages ne doit pas allumer un jugement automatique.
    features = {};
  }
  cache.set(workspaceId, { at: Date.now(), features });
  return features;
}

/** Vide le cache d'un espace — appelé après une écriture des réglages pour que
 *  « j'ai éteint ça » se voie tout de suite et pas dans une minute. */
export function forgetTypesafeConfig(workspaceId?: string) {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

export const hasTypesafeKey = (): boolean => !!Deno.env.get("TYPESAFE_API_KEY");

// ── Les questions ────────────────────────────────────────────────────────────

export type Entry = string | Record<string, unknown> | unknown[] | null;

/**
 * Un critère, sous sa forme courte ou sa forme DÉTAILLÉE.
 *
 * La documentation de TypeSafe est explicite : les descriptions sont
 * facultatives, et ce sont elles qui font la différence dès que deux options se
 * ressemblent. Trois champs y suffisent — ce que l'option couvre, ce qu'elle ne
 * couvre PAS (qui appartient à la voisine), et des exemples.
 *
 * Le `not_for` compte autant que le `what` : « répondre » et « router » se
 * confondent tant qu'on n'a pas dit ce qui appartient à l'autre.
 */
export interface Criterion {
  /** Ce que l'option couvre. */
  what: string;
  /** Ce qui appartient à une option voisine. */
  not_for?: string;
  /** Des entrées typiques, telles qu'on les rencontre vraiment. */
  examples?: string[];
}

/** Un niveau de barème : une SITUATION à reconnaître, jamais un degré abstrait.
 *  « Panne contournable » donne quelque chose à comparer ; « moyennement
 *  grave » ne donne rien. */
export interface Level {
  summary: string;
  /** Les indices qui trahissent ce niveau. */
  signals?: string[];
}

export type ChoiceCriterion = string | Criterion | null;
export type NoulCriterion = string | { what: string; examples?: string[] };

export interface ChoiceQuestion {
  type: "choice";
  instructions: Entry;
  criteria: Record<string, ChoiceCriterion>;
}
export interface ScoreQuestion {
  type: "score";
  instructions: Entry;
  criteria: Array<string | Level>;
}
export interface NoulQuestion {
  type: "noul";
  instructions: Entry;
  criteria?: { true?: NoulCriterion; false?: NoulCriterion };
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export const choice = (instructions: Entry, criteria: Record<string, ChoiceCriterion>): ChoiceQuestion =>
  ({ type: "choice", instructions, criteria });
export const score = (instructions: Entry, criteria: Array<string | Level>): ScoreQuestion =>
  ({ type: "score", instructions, criteria });
export const noul = (
  instructions: Entry,
  criteria?: { true?: NoulCriterion; false?: NoulCriterion },
): NoulQuestion => ({ type: "noul", instructions, criteria });

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface NoulAnswer { type: "noul"; noul: number }
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

// ── L'appel ──────────────────────────────────────────────────────────────────

export interface JudgeContext {
  admin: Admin;
  workspaceId: string;
  projectId?: string | null;
  /** Le run concerné, quand il y en a un — c'est ce qui relie un jugement à ce
   *  qu'il jugeait quand on relit le journal. */
  runId?: string | null;
}

export interface Judgement {
  answers: Record<string, Answer>;
  /** VRAI seulement en mode `on`. En `shadow`, l'appelant doit ignorer les
   *  réponses : elles ne sont là que pour être comparées plus tard. */
  apply: boolean;
  threshold: number;
  mode: TypesafeMode;
  latencyMs: number;
}

/** Coût en centimes d'euro. 42 $/milliard de tokens d'entrée, sortie gratuite —
 *  soit ~3,9 c€ le million, contre 25 pour notre modèle le moins cher. */
export const typesafeCostCents = (inputTokens: number): number =>
  (inputTokens / 1_000_000) * 3.9;

/**
 * Poser des questions, obtenir des réponses typées — ou `null`.
 *
 * `null` veut dire « garde ton comportement d'avant », et il n'y a jamais à
 * traiter ce cas autrement : usage éteint, clé absente, API lente, API en
 * erreur, réponse mal formée, tout retombe là.
 */
export async function judge(
  ctx: JudgeContext,
  feature: TypesafeFeature,
  state: Entry,
  questions: Record<string, Question>,
  opts: { subject?: string } = {},
): Promise<Judgement | null> {
  const key = Deno.env.get("TYPESAFE_API_KEY");
  if (!key) return null;
  if (Object.keys(questions).length === 0) return null;

  const cfg = (await loadTypesafeConfig(ctx.admin, ctx.workspaceId))[feature] ?? defaultConfig(feature);
  if (cfg.mode === "off") return null;

  const started = Date.now();
  let answers: Record<string, Answer> | null = null;
  let usage: { input_tokens?: number } = {};
  let model = MODEL;
  let error: string | null = null;

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const json = await res.json() as {
        answers?: Record<string, Answer>; usage?: { input_tokens?: number }; model?: string;
      };
      answers = json.answers ?? null;
      usage = json.usage ?? {};
      model = json.model ?? MODEL;
    } else {
      // 429 (quota) et 529 (surcharge) sont passagers, mais on ne réessaie PAS
      // ici : ce jugement est optionnel, et faire attendre un run une seconde
      // de plus pour une opinion coûte plus que de s'en passer.
      error = `HTTP ${res.status}`;
    }
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 200) : "erreur réseau";
  }

  const latencyMs = Date.now() - started;
  const apply = cfg.mode === "on" && !!answers;

  // Journalisé dans tous les cas, y compris en erreur : « l'API n'a pas répondu
  // trois fois sur dix » est exactement ce qu'on veut savoir avant de basculer
  // un usage en `on`.
  void logJudgement(ctx, {
    feature, mode: cfg.mode, applied: apply, subject: opts.subject ?? null,
    questions, answers, model, latencyMs,
    inputTokens: Number(usage.input_tokens) || 0, error,
  });

  if (!answers) return null;
  return { answers, apply, threshold: cfg.threshold, mode: cfg.mode, latencyMs };
}

async function logJudgement(ctx: JudgeContext, row: {
  feature: string; mode: TypesafeMode; applied: boolean; subject: string | null;
  questions: Record<string, Question>; answers: Record<string, Answer> | null;
  model: string; latencyMs: number; inputTokens: number; error: string | null;
}): Promise<void> {
  try {
    await ctx.admin.from("typesafe_judgements").insert({
      workspace_id: ctx.workspaceId,
      project_id: ctx.projectId ?? null,
      feature: row.feature,
      mode: row.mode,
      applied: row.applied,
      run_id: ctx.runId ?? null,
      subject: row.subject?.slice(0, 300) ?? null,
      // Les questions sont tronquées : un classement de 120 skills est un objet
      // de plusieurs kilo-octets, et le relire n'apprend rien de plus que son
      // résumé. Les RÉPONSES, elles, sont gardées entières — c'est ce qu'on
      // vient comparer.
      questions: clipQuestions(row.questions),
      answers: row.answers,
      confidence: overallConfidence(row.answers),
      model: row.model,
      latency_ms: row.latencyMs,
      input_tokens: row.inputTokens,
      cost_cents: Number(typesafeCostCents(row.inputTokens).toFixed(4)),
      error: row.error,
    });
  } catch { /* un journal qui échoue ne doit pas faire échouer le jugement */ }

  // La dépense part AUSSI dans le compteur commun, sous le nom du modèle : les
  // crédits d'un espace doivent dire la vérité, et un jugement en mode
  // observation est une dépense réelle même s'il ne change rien au produit.
  // Le modèle « jev » porte son tarif dans llm-pricing (42 $/milliard en
  // entrée, sortie gratuite).
  if (row.inputTokens > 0) {
    void logLlmUsage({
      workspace_id: ctx.workspaceId,
      project_id: ctx.projectId ?? null,
      provider: "typesafe",
      model: row.model,
      task: "classification",
      feature: `typesafe:${row.feature}`,
      usage: { prompt_tokens: row.inputTokens, completion_tokens: 0, total_tokens: row.inputTokens },
      metadata: { mode: row.mode, applied: row.applied },
    });
  }
}

function clipQuestions(questions: Record<string, Question>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    const instructions = typeof q.instructions === "string"
      ? q.instructions.slice(0, 400)
      : q.instructions;
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      out[id] = { type: q.type, instructions, options: keys.length, sample: keys.slice(0, 12) };
    } else if (q.type === "score") {
      out[id] = { type: q.type, instructions, levels: q.criteria.length };
    } else {
      out[id] = { type: q.type, instructions };
    }
  }
  return out;
}

/** La confiance la plus BASSE de la fournée — c'est elle qui décide si on peut
 *  agir, une réponse sûre ne rattrapant pas une réponse hésitante. */
function overallConfidence(answers: Record<string, Answer> | null): number | null {
  if (!answers) return null;
  const values: number[] = [];
  for (const a of Object.values(answers)) {
    if (a.type === "choice" || a.type === "score") values.push(Number(a.confidence) || 0);
  }
  return values.length ? Number(Math.min(...values).toFixed(3)) : null;
}

// ── Lectures ─────────────────────────────────────────────────────────────────
// Les réponses arrivent en `Record<string, Answer>` non typé côté appelant :
// ces trois lecteurs évitent que chaque site refasse ses propres gardes.

export function readNoul(j: Judgement | null, id: string): number | null {
  const a = j?.answers?.[id];
  return a && a.type === "noul" && Number.isFinite(a.noul) ? a.noul : null;
}

export function readChoice(j: Judgement | null, id: string): ChoiceAnswer | null {
  const a = j?.answers?.[id];
  return a && a.type === "choice" ? a : null;
}

export function readScore(j: Judgement | null, id: string): ScoreAnswer | null {
  const a = j?.answers?.[id];
  return a && a.type === "score" ? a : null;
}

/** Les options d'un `choice`, de la plus probable à la moins probable. Un
 *  classement complet en un seul appel : c'est ce qui rend le tri de 120 skills
 *  aussi cher qu'une seule question. */
export function ranked(a: ChoiceAnswer | null): Array<{ key: string; p: number }> {
  if (!a?.probabilities) return [];
  return Object.entries(a.probabilities)
    .map(([key, p]) => ({ key, p: Number(p) || 0 }))
    .sort((x, y) => y.p - x.p);
}

/** Un identifiant de question sûr : l'API les veut en clés d'objet, et nos
 *  slugs de skills ou noms d'outils contiennent tirets et points. */
export const qid = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "q";
