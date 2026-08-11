// Proactivity — what an agent does that nobody asked for.
//
// The runtime already had the CHANNEL for initiative (propose_mission files a
// paused backlog mission that executes nothing until a human starts it). What
// it lacked was the REFLEX: one line of doctrine buried in the operating rules,
// no moment at which the agent is actually asked "what did you notice?", and a
// tool that wasn't even loaded by default. So initiative depended on the model
// spontaneously remembering — which it almost never did.
//
// This module supplies the two missing halves:
//
//   1. DOCTRINE (PROACTIVITY_DOCTRINE) — a real section of the system prompt.
//      It says what proactive means HERE, and just as importantly what it does
//      NOT mean, because an agent that widens its own scope mid-task is worse
//      than one that never proposes anything.
//
//   2. THE CLOSING REFLEX (reflectAndPropose) — at the end of a run that did
//      real work, one cheap call over what actually happened: is there a next
//      step that genuinely follows from this? Anything it finds is FILED, never
//      executed. The human decides.
//
// The whole thing is bounded by design. The failure mode we are avoiding is not
// "the agent proposes too little", it is an agent that turns every request into
// a pile of speculative busywork nobody asked for. Hence: a cap, a relevance
// bar, and a hard rule that a proposal never runs itself.

import { callAi, safeParseJson } from "./ai.ts";
import { cheapProvider } from "./model-router.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type Admin = SupabaseClient;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/**
 * The initiative section of the system prompt. Deliberately concrete: "be
 * proactive" alone produces either nothing or noise, so this names the four
 * things that count as legitimate initiative and the four that don't.
 */
export const PROACTIVITY_DOCTRINE = [
  "## Initiative — travaille comme un collègue, pas comme un distributeur",
  "On ne te dira jamais tout. Un bon collègue termine ce qu'on lui a demandé, PUIS signale ce qu'il a vu passer. Toi aussi.",
  "",
  "PENDANT la tâche — fais-le, ne demande pas la permission :",
  "- CE QUI DÉCOULE DIRECTEMENT de la demande fait partie de la demande. On te demande un rapport ? tu produis aussi le tableau de chiffres qui le soutient. On te demande de corriger un bug ? tu vérifies que le même bug n'est pas ailleurs. On te demande une analyse ? tu la sauves en livrable sans qu'on te le dise.",
  "- CORRIGE au passage ce qui est manifestement cassé et trivial à réparer dans ton périmètre — puis dis-le en une ligne dans ta réponse.",
  "- COMPLÈTE ce qui manque pour que ton travail SERVE : un rapport sans ses sources, un script sans son mode d'emploi, un tableau sans ses unités, c'est un travail à moitié fait.",
  "",
  "APRÈS la tâche — propose, n'exécute pas :",
  "- Ce que tu as remarqué et qui a de la VALEUR mais SORT du périmètre demandé → `propose_mission`. Ça crée une mission EN PAUSE dans le backlog : rien ne tourne tant qu'un humain ne l'a pas lancée. C'est ton seul canal d'initiative hors périmètre, et il est sûr — utilise-le vraiment.",
  "- Bons candidats : un risque que tu as vu (donnée fausse, faille, dépendance morte), un travail répétitif qui gagnerait à être automatisé/planifié, la suite logique évidente de ce qu'on vient de faire, une source de données manquante qui bloquera la prochaine fois.",
  "- Termine ta réponse par une section « Initiatives » quand tu en as déposé — une ligne chacune, avec la valeur attendue.",
  "",
  "CE QUI N'EST PAS DE L'INITIATIVE (ne le fais pas) :",
  "- Élargir ta tâche en cours parce que tu trouves ça intéressant. Le périmètre demandé reste le livrable.",
  "- Déclencher des effets de bord hors périmètre : envoyer un email, écrire chez un tiers, modifier des données qu'on ne t'a pas confiées.",
  "- Proposer du remplissage. Zéro proposition vaut mieux qu'une proposition tiède : ne dépose que ce que tu défendrais à l'oral.",
  "- Reposer une question à la place d'agir : si tu peux trancher raisonnablement, tranche et dis ce que tu as supposé.",
].join("\n");

/** Same idea, compressed, for the room orchestrator — it speaks for the whole
 *  service, so its initiative is about the SERVICE, not about one task. */
export const ORCHESTRATOR_PROACTIVITY = [
  "## Initiative (tu parles pour le service)",
  "- Quand la demande implique une suite évidente (un suivi, une récurrence, un livrable qui manque), PROPOSE-la explicitement en une phrase à la fin de ta réponse, et planifie-la si on te dit oui.",
  "- Si tu vois qu'un travail revient régulièrement, propose de le PLANIFIER (create_mission avec un `schedule`) plutôt que de le refaire à la main à chaque fois.",
  "- Si une mission se termine et qu'un enchaînement s'impose, dis-le dans le compte rendu — n'attends pas qu'on te le demande.",
  "- Ne lance jamais de travail de fond que personne n'a validé : proposer, oui ; exécuter hors demande, non.",
].join("\n");

// ---------------------------------------------------------------------------
// The closing reflex
// ---------------------------------------------------------------------------

export interface Proposal {
  title: string;
  brief: string;
  value: string;
}

/** Cap per run. Three is already generous: past that it stops being a signal
 *  and becomes a backlog the human has to triage. */
const MAX_PROPOSALS = 2;

/**
 * Look back over a finished run and file the follow-ups that genuinely follow
 * from it. Returns the proposals actually filed (possibly none — that is the
 * expected outcome most of the time).
 *
 * Best-effort throughout: this runs AFTER the user already has their answer, so
 * nothing here may fail the run or delay the reply.
 */
export async function reflectAndPropose(admin: Admin, opts: {
  agentId: string;
  workspaceId: string | null;
  projectId: string | null;
  /** What was asked. */
  goal: string;
  /** What the agent produced (its final report/answer). */
  output: string;
  /** Condensed trace of what it actually did — tool names are enough. */
  actions: string[];
  /** Proposals already filed DURING the run, so the reflex doesn't repeat them. */
  alreadyProposed?: string[];
}): Promise<Proposal[]> {
  if (!opts.workspaceId || !opts.projectId) return [];
  const goal = opts.goal.trim();
  const output = opts.output.trim();
  if (!goal || output.length < 120) return [];

  try {
    // What the backlog already holds — proposing the same thing every run is
    // the single fastest way to make people stop reading proposals.
    const { data: existing } = await admin.from("internal_agent_missions")
      .select("title").eq("project_id", opts.projectId)
      .in("status", ["paused", "active", "running"])
      .order("created_at", { ascending: false }).limit(25);
    const known = [
      ...((existing ?? []) as Array<{ title: string }>).map((m) => m.title),
      ...(opts.alreadyProposed ?? []),
    ];

    const system = [
      "Tu relis le travail que TU viens de terminer, et tu cherches UNIQUEMENT ce qui a de la valeur pour la suite.",
      "",
      "Retiens une piste seulement si elle vérifie TOUT :",
      "1. elle DÉCOULE de ce qui vient d'être fait (pas une idée générique sur le métier) ;",
      "2. elle apporte une valeur CONCRÈTE et vérifiable, que tu saurais défendre en une phrase ;",
      "3. elle n'est PAS déjà faite, ni déjà dans la liste des travaux existants ;",
      "4. un futur agent pourrait l'exécuter à partir du seul brief, sans cette conversation.",
      "",
      "Cas typiques qui passent la barre : un risque repéré en chemin, un travail manifestement répétitif à automatiser, l'étape suivante évidente, une donnée manquante qui bloquera la prochaine fois.",
      "",
      `RENVOIE LE PLUS SOUVENT UNE LISTE VIDE. C'est la bonne réponse quand le travail se suffit à lui-même — et c'est le cas le plus fréquent. Maximum ${MAX_PROPOSALS}.`,
      known.length ? `\nTRAVAUX DÉJÀ EXISTANTS (ne les repropose pas) :\n${known.map((t) => `- ${t}`).join("\n")}` : "",
      "",
      'JSON STRICT, sans prose ni fence : {"proposals":[{"title":"","brief":"","value":""}]}',
      "title : action courte. brief : quoi faire, avec assez de contexte pour être exécuté seul. value : une phrase.",
    ].filter(Boolean).join("\n");

    const res = await callAi({
      task: "classification",
      provider: cheapProvider(),
      jsonMode: true,
      maxTokens: 700,
      temperature: 0.3,
      systemPrompt: system,
      userPrompt: [
        `# Ce qui était demandé\n${goal.slice(0, 1500)}`,
        opts.actions.length ? `\n# Ce que j'ai fait\n${opts.actions.slice(0, 40).join(", ")}` : "",
        `\n# Ce que j'ai produit\n${output.slice(0, 4000)}`,
      ].filter(Boolean).join("\n"),
    });

    const parsed = safeParseJson<{ proposals?: Proposal[] }>(res.content);
    const raw = Array.isArray(parsed?.proposals) ? parsed!.proposals! : [];
    const seen = new Set(known.map((t) => t.toLowerCase().trim()));
    const proposals: Proposal[] = [];
    for (const p of raw) {
      const title = str(p?.title).trim().slice(0, 160);
      const brief = str(p?.brief).trim();
      if (!title || brief.length < 30) continue;
      if (seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      proposals.push({ title, brief: brief.slice(0, 4000), value: str(p?.value).trim().slice(0, 300) });
      if (proposals.length >= MAX_PROPOSALS) break;
    }
    if (proposals.length === 0) return [];

    const rows = proposals.map((p) => ({
      agent_id: opts.agentId,
      workspace_id: opts.workspaceId,
      project_id: opts.projectId,
      title: p.title,
      brief: `${p.brief}\n\n---\n💡 Repérée par l'agent en terminant un travail${p.value ? ` — Valeur attendue : ${p.value}` : ""}`,
      status: "paused",
      board_column: "backlog",
      delegated_by_agent: opts.agentId,
    }));
    const { error } = await admin.from("internal_agent_missions").insert(rows);
    if (error) return [];
    return proposals;
  } catch {
    return [];
  }
}

/** One markdown block appended to the agent's final answer so the human SEES
 *  the proposals instead of discovering them in a backlog later. */
export function proposalsFooter(proposals: Proposal[]): string {
  if (proposals.length === 0) return "";
  const lines = proposals.map((p) => `- **${p.title}** — ${p.value || "à évaluer"}`);
  return [
    "",
    "---",
    "**💡 Initiatives repérées** (déposées en pause dans le backlog — rien ne tourne sans votre feu vert) :",
    ...lines,
  ].join("\n");
}
