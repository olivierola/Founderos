// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/team-handoff.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// La passation entre coéquipiers — le maillon qui manquait au travail de groupe.
//
// delegate_mission confie une mission avec un brief libre : le destinataire
// recommence souvent une partie du travail, faute de savoir ce qui est fait,
// et rien ne dit quand il a fini. Une passation est un PAQUET structuré :
//
//   objectif · ce qui est déjà fait · livrables joints · critères de fin
//   vérifiables · échéance
//
// Les critères de fin deviennent les `acceptance_criteria` de la mission du
// destinataire : son contrat de succès (agent-loop.ts, deriveContract) en est
// dérivé, et sa boucle ne se termine que quand ils sont vérifiés. La passation
// est donc vérifiée par la machine à l'arrivée, pas seulement décrite au départ.
//
// Module pur : testé sans base.

export interface TeamCfgLite {
  id: string;
  name: string;
  agent_ids: string[];
  lead_id: string | null;
  links?: Array<{ from: string; to: string; kind: string; when: string }>;
}

export interface HandoffPacket {
  to: string;
  objective: string;
  done: string;
  deliverables: string[];
  doneWhen: string[];
  deadline: string | null;
  reportBack: boolean;
}

const s = (v: unknown, max: number) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim().slice(0, max);
const items = (v: unknown, max = 8): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n+|;\s*/) : [])
    .map((x) => s(x, 400).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""))
    .filter(Boolean)
    .slice(0, max);

/** Les arguments du modèle → un paquet valide, ou le message d'erreur à lui rendre. */
export function normalizeHandoff(args: Record<string, unknown>): HandoffPacket | string {
  const to = s(args.to ?? args.to_agent ?? args.to_agent_id ?? args.teammate, 120);
  const objective = s(args.objective ?? args.goal ?? args.title, 600);
  const doneWhen = items(args.done_when ?? args.acceptance_criteria ?? args.criteria);
  if (!to) return "ERROR: « to » est requis : le prénom ou l'agent_id du coéquipier.";
  if (objective.length < 8) return "ERROR: « objective » est requis : ce que le coéquipier doit obtenir, en une phrase.";
  if (!doneWhen.length) {
    return "ERROR: « done_when » est requis : 1 à 5 critères de fin VÉRIFIABLES (un livrable nommé, un chiffre, un état). C'est ce qui permettra de vérifier son travail.";
  }
  const deadline = s(args.deadline ?? args.due, 40);
  return {
    to,
    objective,
    done: s(args.done ?? args.context ?? args.already_done, 3000),
    deliverables: items(args.deliverables ?? args.attachments, 10),
    doneWhen: doneWhen.slice(0, 5),
    deadline: deadline || null,
    reportBack: args.report_back !== false,
  };
}

/** Le coéquipier visé, dans MON équipe : par id, prénom exact, ou début de nom. */
export function teammateOf(
  teams: TeamCfgLite[], fromId: string, ref: string, names: Map<string, string>,
): { team: TeamCfgLite; agentId: string } | { error: string } {
  const mine = teams.find((t) => Array.isArray(t.agent_ids) && t.agent_ids.includes(fromId));
  if (!mine) return { error: "ERROR: tu n'es dans aucune équipe. Utilise delegate_mission pour confier du travail à un autre agent." };
  const mates = mine.agent_ids.filter((id) => id !== fromId);
  const want = ref.trim().toLowerCase();
  const hit = mates.find((id) => id === ref.trim())
    ?? mates.find((id) => (names.get(id) ?? "").toLowerCase() === want)
    ?? mates.find((id) => (names.get(id) ?? "").toLowerCase().startsWith(want));
  if (!hit) {
    const roster = mates.map((id) => `${names.get(id) ?? id} (${id})`).join(", ");
    return { error: `ERROR: « ${ref} » n'est pas dans ton équipe « ${mine.name} ». Coéquipiers : ${roster || "aucun"}.` };
  }
  return { team: mine, agentId: hit };
}

/** Le brief de la mission du destinataire : lisible sans contexte. */
export function formatHandoffBrief(p: HandoffPacket, fromName: string, teamName: string): string {
  return [
    `**Passation de ${fromName}** (équipe « ${teamName} »)`,
    "",
    `## Objectif\n${p.objective}`,
    p.done ? `\n## Déjà fait — ne le refais pas\n${p.done}` : "",
    p.deliverables.length ? `\n## Livrables joints\n${p.deliverables.map((d) => `- ${d}`).join("\n")}` : "",
    `\n## Critères de fin (vérifiés avant clôture)\n${p.doneWhen.map((d) => `- ${d}`).join("\n")}`,
    p.deadline ? `\n## Échéance\n${p.deadline}` : "",
    "",
    "Si un critère est flou ou impossible, pose UNE question précise à l'émetteur (send_message_to_agent) avant de commencer ; sinon exécute.",
  ].filter(Boolean).join("\n");
}
