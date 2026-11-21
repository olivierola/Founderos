// Le choix des outils par Jev (TypeSafe) : quelles mains pour CETTE étape.
//
// Les schémas d'outils sont renvoyés à chaque tour, et sur un agent large
// (connecteurs, serveurs MCP, deux mondes d'exécution) ils pèsent plus que le
// transcrit. La sélection lexicale (prompt-compiler) devine leur utilité aux
// mots partagés avec la tâche : « relance le client Acme » ne partage aucun mot
// avec `hubspot_create_task`, et l'outil qu'il fallait partait en queue.
//
// Jev lit la tâche et la liste des outils, et rend en UN appel une
// probabilité pour chacun (un `choice` jusqu'à 255 options, distribution
// complète). Ce n'est pas un filtre : la probabilité est MÊLÉE au score
// lexical, pondérée par la confiance du jugement — un jugement sûr de lui
// mène, un jugement hésitant ne fait que départager. Aucun outil n'est retiré
// de la boîte (l'index du prompt les nomme tous, need_tools rouvre tout) :
// le pire cas reste un tour de plus, jamais une capacité perdue.
//
// Le jugement est mis en cache par tâche : tant que l'étape en cours ne change
// pas, on ne repose pas la question (ni son coût, ni sa seconde).

import type { ToolDef } from "./ai.ts";
import { stableHash } from "./prompt-compiler.ts";
import { choice, judge, qid, readChoice, type Criterion, type JudgeContext } from "./typesafe.ts";

/** L'API ne prend pas plus d'options par question. */
export const MAX_RANKED_TOOLS = 255;

export interface ToolRanking {
  /** Probabilité d'utilité par nom d'outil (somme ≈ 1 sur les outils classés). */
  probs: Record<string, number>;
  /** Confiance du jugement, 0..1 : le poids qu'on lui donne face au lexical. */
  confidence: number;
  /** L'empreinte de la tâche jugée : même empreinte, même classement. */
  taskHash: string;
  at: number;
}

/** Ce qu'un outil couvre, en une phrase : le début de sa description. */
export function toolCriterion(def: ToolDef): Criterion {
  const raw = String(def.function?.description ?? "").replace(/\s+/g, " ").trim();
  const firstSentence = raw.split(/(?<=[.!?])\s/)[0] ?? raw;
  const what = (firstSentence.length >= 40 ? firstSentence : raw).slice(0, 240) || def.function.name.replace(/_/g, " ");
  return { what };
}

export const taskHashOf = (task: string) => stableHash(task.trim().toLowerCase().slice(0, 2000));

/** Un classement encore valable pour cette tâche (même étape, moins de 30 min). */
export function reusableRanking(prev: unknown, task: string, maxAgeMs = 30 * 60_000): ToolRanking | null {
  const r = prev as ToolRanking | null;
  if (!r || typeof r !== "object" || !r.probs || r.taskHash !== taskHashOf(task)) return null;
  if (!Number.isFinite(r.at) || Date.now() - r.at > maxAgeMs) return null;
  return r;
}

/** Ce qu'on garde d'un classement entre deux ticks : les 80 premiers outils. */
export function compactRanking(r: ToolRanking): ToolRanking {
  const top = Object.entries(r.probs).sort((a, b) => b[1] - a[1]).slice(0, 80);
  return { ...r, probs: Object.fromEntries(top.map(([k, p]) => [k, Number(p.toFixed(4))])) };
}

/**
 * Le classement des outils par Jev, ou null (usage éteint, en observation,
 * clé absente, API lente ou en erreur) — l'appelant garde alors le lexical.
 *
 * `candidates` sont les outils à classer (sans les épinglés, envoyés de toute
 * façon). Au-delà de 255, l'appelant les a déjà pré-ordonnés : on garde la
 * tête de liste.
 */
export async function rankToolsWithJev(
  ctx: JudgeContext,
  task: string,
  candidates: ToolDef[],
  opts: { recentTools?: string[]; step?: string | null } = {},
): Promise<ToolRanking | null> {
  const list = candidates.slice(0, MAX_RANKED_TOOLS);
  if (list.length < 2 || !task.trim()) return null;

  const byKey = new Map<string, string>();
  const criteria: Record<string, Criterion> = {};
  for (const d of list) {
    const name = d.function?.name;
    if (!name) continue;
    let key = qid(name);
    while (byKey.has(key)) key += "_";
    byKey.set(key, name);
    criteria[key] = toolCriterion(d);
  }
  if (byKey.size < 2) return null;

  const verdict = await judge(ctx, "tool_ranking", {
    tache: task.slice(0, 2000),
    ...(opts.step ? { etape_en_cours: opts.step.slice(0, 300) } : {}),
    ...(opts.recentTools?.length ? { outils_deja_utilises: opts.recentTools.slice(-12) } : {}),
  }, {
    outil: choice(
      "Quel outil faut-il appeler MAINTENANT pour faire avancer cette étape ? Juge sur ce que l'outil FAIT, pas sur les mots qu'il partage avec la tâche.",
      criteria,
    ),
  }, { subject: `outils · ${task.slice(0, 80)}` }).catch(() => null);

  if (!verdict?.apply) return null;
  const answer = readChoice(verdict, "outil");
  if (!answer?.probabilities) return null;

  const probs: Record<string, number> = {};
  for (const [key, p] of Object.entries(answer.probabilities)) {
    const name = byKey.get(key);
    const v = Number(p);
    if (name && Number.isFinite(v) && v > 0) probs[name] = v;
  }
  if (Object.keys(probs).length === 0) return null;
  // Sous le seuil de l'usage, le jugement ne mène plus : son poids tombe à la
  // moitié de sa confiance, il départage seulement.
  const confidence = Math.max(0, Math.min(1, Number(answer.confidence) || 0));
  const weight = confidence >= verdict.threshold ? confidence : confidence / 2;
  return { probs, confidence: weight, taskHash: taskHashOf(task), at: Date.now() };
}
