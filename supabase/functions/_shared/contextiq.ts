// ContextIQ — le filtre de contexte, avant que le modèle ne réponde.
//
// La recherche vectorielle sait rapprocher un SUJET ; elle ne sait pas dire si
// un passage RÉPOND, si deux passages se contredisent, ni si l'ensemble suffit.
// Un agent qui reçoit six passages hors sujet répond quand même — avec
// l'assurance de quelqu'un qui cite une source. ContextIQ fait les quatre
// jugements qui manquent, en Jev, autour de la recherche :
//
//   1. quelles COLLECTIONS interroger (agents internes, plusieurs collections)
//   2. quels PASSAGES garder (note 0-3 par passage — l'ancien `rag_rerank`)
//   3. l'ensemble gardé COUVRE-t-il la question, et se CONTREDIT-il
//   4. couverture faible → on ÉLARGIT (toutes les collections, plus de
//      passages) puis, si ça ne suffit toujours pas, on le DIT à l'appelant
//      (agent public : « ne devine pas » ; agent interne : « va chercher ailleurs »)
//
// Un seul réglage pour tout : l'usage `rag_rerank` de typesafe_settings. Même
// contrat que le reste du jugement rapide — éteint, en shadow ou en panne, on
// rend exactement la sélection d'avant (les N premiers par similarité), et
// l'évaluation n'ajoute aucune consigne au prompt.
//
// Chaque évaluation est écrite dans `contextiq_assessments` : les questions à
// faible couverture sont la liste des TROUS de la base documentaire — c'est ce
// que l'écran ContextIQ montre en premier.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  judge, score, noul, choice, readScore, readNoul, readChoice, ranked, qid,
  type Judgement,
} from "./typesafe.ts";

type Admin = SupabaseClient;

export interface Passage {
  id: string;
  content: string;
  similarity: number;
  /** Collection (agents internes) ou source (agents publics) d'origine. */
  collection_id?: string | null;
  source_id?: string | null;
}

/** Couverture : 0 aucune · 1 partielle · 2 suffisante · 3 complète. */
export type Coverage = 0 | 1 | 2 | 3;

export const COVERAGE_LABEL: Record<Coverage, string> = {
  0: "aucune", 1: "partielle", 2: "suffisante", 3: "complète",
};

export interface Assessment {
  kept: Passage[];
  /** Note 0-3 de chaque passage évalué (id → note). Vide si rien n'a tourné. */
  notes: Record<string, number>;
  coverage: Coverage | null;
  /** Probabilité que deux passages gardés se contredisent. */
  contradiction: number | null;
  /** La réponse a-t-elle été appliquée (mode `on`, jugement rendu). */
  applied: boolean;
  mode: "off" | "shadow" | "on";
  latencyMs: number;
}

export interface CiqContext {
  admin: Admin;
  workspaceId: string;
  projectId?: string | null;
  runId?: string | null;
}

// ── 1. Le choix des collections ──────────────────────────────────────────────

/**
 * Parmi les collections d'un agent, lesquelles valent d'être interrogées.
 *
 * Une collection « Juridique » interrogée pour une question de tarif ne coûte
 * pas qu'une requête : elle remonte des passages qui se ressemblent en surface
 * et qui passeront devant les bons. Rend `null` quand il n'y a rien à trancher
 * (≤ 1 collection), quand l'usage n'est pas `on`, ou quand le modèle hésite —
 * l'appelant garde alors toutes les collections.
 */
export async function pickCollections(
  ctx: CiqContext,
  question: string,
  collections: Array<{ id: string; name: string; description?: string | null }>,
): Promise<string[] | null> {
  if (collections.length <= 1) return null;
  const byKey = new Map<string, string>();
  const criteria: Record<string, { what: string }> = {};
  for (const c of collections.slice(0, 60)) {
    const key = qid(`c_${c.name}_${c.id.slice(0, 6)}`);
    byKey.set(key, c.id);
    criteria[key] = { what: `${c.name}${c.description ? ` — ${c.description.slice(0, 300)}` : ""}` };
  }
  const verdict = await judge(
    ctx, "rag_rerank",
    { question: question.slice(0, 800) },
    { collection: choice("Quelle collection de documents contient le plus probablement la réponse à cette question ?", criteria) },
    { subject: `choix parmi ${byKey.size} collections` },
  );
  if (!verdict?.apply) return null;
  const answer = readChoice(verdict, "collection");
  if (!answer || answer.confidence < 0.5) return null;
  // On garde les collections jusqu'à 85 % de la masse : une question à cheval
  // sur deux collections doit les garder toutes les deux.
  const out: string[] = [];
  let mass = 0;
  for (const { key, p } of ranked(answer)) {
    const id = byKey.get(key);
    if (!id) continue;
    out.push(id);
    mass += p;
    if (mass >= 0.85 || out.length >= 3) break;
  }
  return out.length ? out : null;
}

// ── 2 et 3. Tri des passages, puis couverture et contradiction ───────────────

// Quatre niveaux décrits comme des SITUATIONS — « panne contournable » donne
// quelque chose à comparer, « moyennement grave » ne donne rien. Ce barème est
// celui de l'ancien rerank de rag-chat, mesuré tel quel : on n'y touche pas.
const PASSAGE_LEVELS = [
  {
    summary: "Hors sujet : ce passage ne parle pas de ce qui est demandé.",
    signals: ["aucun terme de la question", "autre produit, autre page, autre sujet"],
  },
  {
    summary: "Même domaine, mais il ne répond pas : on y reconnaît le sujet sans y trouver la réponse.",
    signals: ["parle du bon produit mais d'un autre aspect", "généralités, introduction, sommaire"],
  },
  {
    summary: "Utile : il contient une partie de la réponse, ou de quoi la construire.",
    signals: ["un chiffre, une condition, une étape de la réponse", "il faudrait le compléter"],
  },
  {
    summary: "Décisif : à lui seul il répond à la question posée.",
    signals: ["la phrase exacte qui répond", "le tarif, le délai ou la règle demandés"],
  },
];

const COVERAGE_LEVELS = [
  {
    summary: "Aucune réponse : rien dans ces extraits ne permet de répondre.",
    signals: ["les extraits parlent d'autre chose", "il faudrait inventer pour répondre"],
  },
  {
    summary: "Réponse partielle : des éléments, mais il manque le point principal demandé.",
    signals: ["le sujet est traité mais pas le cas précis", "il manque le chiffre, la date ou la condition demandés"],
  },
  {
    summary: "Réponse suffisante : on peut répondre sans rien inventer, même si un détail secondaire manque.",
    signals: ["le point demandé est écrit", "seules des précisions annexes manquent"],
  },
  {
    summary: "Réponse complète : un extrait répond directement et entièrement à la question.",
    signals: ["la phrase exacte qui répond", "toutes les conditions du cas sont couvertes"],
  },
];

/**
 * Noter les passages, garder les utiles, puis juger l'ensemble gardé.
 *
 * Deux appels et pas un : les notes par passage sont des questions AUTONOMES
 * (le passage dans l'énoncé), mesurées ainsi le 21/09. Mettre les douze
 * passages dans l'état commun pour une seule passe ferait baisser la précision
 * de chaque note — Jev lit moins bien quand l'état grossit de hors-sujet. Le
 * second appel ne porte que sur ce qui a été GARDÉ, c'est-à-dire sur ce que le
 * modèle génératif lira vraiment.
 */
export async function assessPassages(
  ctx: CiqContext,
  question: string,
  passages: Passage[],
  opts: { keep: number; evaluate?: number; subject?: string },
): Promise<Assessment> {
  const head = passages.slice(0, opts.keep);
  const base: Assessment = {
    kept: head, notes: {}, coverage: null, contradiction: null,
    applied: false, mode: "off", latencyMs: 0,
  };
  if (passages.length === 0) return base;

  const pool = passages.slice(0, opts.evaluate ?? passages.length);
  const questions: Record<string, ReturnType<typeof score>> = {};
  pool.forEach((p, i) => {
    questions[`p${i}`] = score({ passage: p.content.slice(0, 1200) }, PASSAGE_LEVELS);
  });

  let rerank: Judgement | null = null;
  try {
    rerank = pool.length > 1
      ? await judge(ctx, "rag_rerank", { question: question.slice(0, 800) }, questions,
          { subject: opts.subject ?? `${pool.length} passage(s)` })
      : null;
  } catch { rerank = null; }

  const notes: Record<string, number> = {};
  pool.forEach((p, i) => {
    const s = readScore(rerank, `p${i}`)?.score;
    if (s != null) notes[p.id] = s;
  });

  let kept = head;
  if (rerank?.apply) {
    const picked = pool
      .map((p) => ({ p, note: notes[p.id] ?? -1 }))
      .filter((x) => x.note >= rerank!.threshold)
      .sort((a, b) => b.note - a.note || b.p.similarity - a.p.similarity)
      .slice(0, opts.keep)
      .map((x) => x.p);
    // Tout jeter n'est pas un tri : un contexte vide ferait répondre « je n'ai
    // pas l'information » à une question qui avait une réponse.
    if (picked.length) kept = picked;
  }

  // L'appel d'ensemble tourne aussi en shadow : c'est lui qui remplit la liste
  // des trous documentaires, et elle a de la valeur avant toute bascule.
  let whole: Judgement | null = null;
  const mode = rerank?.mode ?? "off";
  if (mode !== "off" && kept.length > 0) {
    try {
      whole = await judge(
        ctx, "rag_rerank",
        {
          question: question.slice(0, 800),
          extraits: kept.map((p, i) => `[${i + 1}] ${p.content.slice(0, 900)}`).join("\n\n"),
        },
        {
          couverture: score("Ces extraits permettent-ils de répondre à la question ?", COVERAGE_LEVELS),
          // Phrasé pour que haut = oui : haut = il y a une contradiction.
          contradiction: noul(
            "Deux extraits donnent-ils des informations incompatibles sur le même point ?",
            {
              true: {
                what: "Deux extraits affirment des choses qui ne peuvent pas être vraies en même temps : deux prix, deux délais, deux dates ou deux procédures différents pour le même cas.",
                examples: ["[1] livraison en 48 h / [3] livraison sous 5 jours ouvrés", "[2] résiliation sans frais / [4] frais de résiliation de 30 €"],
              },
              false: {
                what: "Les extraits se complètent, se répètent, ou parlent de cas différents (autre offre, autre pays, ancienne version datée explicitement).",
              },
            },
          ),
        },
        { subject: `ensemble de ${kept.length} extrait(s)` },
      );
    } catch { whole = null; }
  }

  const cov = readScore(whole, "couverture")?.score;
  return {
    kept,
    notes,
    coverage: cov != null && cov >= 0 && cov <= 3 ? (cov as Coverage) : null,
    contradiction: readNoul(whole, "contradiction"),
    applied: !!rerank?.apply,
    mode,
    latencyMs: (rerank?.latencyMs ?? 0) + (whole?.latencyMs ?? 0),
  };
}

/** Faut-il élargir la recherche ? Seulement quand le jugement est APPLIQUÉ :
 *  en shadow, on observe, on ne change pas ce que l'agent reçoit. */
export const needsDeeperSearch = (a: Assessment): boolean =>
  a.applied && a.coverage != null && a.coverage <= 1;

/** Seuil au-delà duquel on signale une contradiction au modèle. Relevé : la
 *  signaler à tort fait hésiter une réponse juste. */
export const CONTRADICTION_THRESHOLD = 0.7;

/**
 * La consigne à ajouter au prompt, ou `""`. Rien en shadow : l'évaluation ne
 * doit pas changer la réponse tant qu'on n'a pas décidé de s'y fier.
 */
export function promptNote(a: Assessment): string {
  if (!a.applied) return "";
  const lines: string[] = [];
  if (a.coverage != null && a.coverage <= 1) {
    lines.push(a.coverage === 0
      ? "The context below does NOT contain the answer. Say plainly that you don't have this information — do not guess, do not answer from general knowledge."
      : "The context below only PARTIALLY answers the question. Answer what it supports, and say explicitly which part you cannot confirm.");
  }
  if ((a.contradiction ?? 0) >= CONTRADICTION_THRESHOLD) {
    lines.push("Some passages in the context contradict each other. Do not silently pick one: state the discrepancy and, if relevant, which source seems more specific or recent.");
  }
  return lines.join("\n");
}

// ── Le journal ───────────────────────────────────────────────────────────────

export async function recordAssessment(ctx: CiqContext, row: {
  surface: "public_agent" | "internal_agent";
  agentId?: string | null;
  conversationId?: string | null;
  question: string;
  assessment: Assessment;
  retrieved: number;
  collectionIds?: string[];
  widened?: boolean;
}): Promise<void> {
  const a = row.assessment;
  if (a.mode === "off") return;
  try {
    await ctx.admin.from("contextiq_assessments").insert({
      workspace_id: ctx.workspaceId,
      project_id: ctx.projectId ?? null,
      surface: row.surface,
      agent_id: row.agentId ?? null,
      run_id: ctx.runId ?? null,
      conversation_id: row.conversationId ?? null,
      question: row.question.slice(0, 1000),
      mode: a.mode,
      applied: a.applied,
      retrieved: row.retrieved,
      kept: a.kept.length,
      coverage: a.coverage,
      contradiction: a.contradiction,
      widened: !!row.widened,
      collection_ids: row.collectionIds ?? [],
      passages: a.kept.map((p) => ({
        id: p.id, note: a.notes[p.id] ?? null, similarity: Number(p.similarity.toFixed(3)),
        collection_id: p.collection_id ?? null, source_id: p.source_id ?? null,
        excerpt: p.content.slice(0, 240),
      })),
      latency_ms: a.latencyMs,
    });
  } catch { /* le journal ne doit jamais faire échouer une réponse */ }
}
