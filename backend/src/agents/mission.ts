// La consigne d'une mission : son brief, ses critères d'acceptation, ses
// livrables attendus, le work item qu'elle sert (avec ses ressources), l'événement
// qui l'a déclenchée et les runs précédents de la même mission. Sortie telle
// quelle de runMission (ancien moteur), sans la boucle.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describeIssueAssets } from "../edge/_shared/tracker-actions.ts";

export interface MissionRow {
  id: string;
  title: string;
  brief: string | null;
  acceptance_criteria: string | null;
  expected_deliverables: unknown;
  schedule?: string | null;
  report_back_to_agent?: string | null;
  delegation_depth?: number | null;
  pj_issue_id?: string | null;
  pj_project_id?: string | null;
}

export const MISSION_COLUMNS =
  "id, title, brief, acceptance_criteria, expected_deliverables, schedule, report_back_to_agent, delegation_depth, pj_issue_id, pj_project_id";

/** Le texte de la tâche (titre et brief), pour la mémoire, les skills et le contrat. */
export const missionTaskText = (mission: Pick<MissionRow, "title" | "brief">) =>
  `${mission.title ?? ""}
${mission.brief ?? ""}`.trim();

export async function buildMissionPrompt(
  // deno-lint-ignore no-explicit-any
  admin: SupabaseClient | any,
  runId: string,
  run: { trigger_payload?: unknown },
  mission: MissionRow,
): Promise<string> {
  // Continuity for re-runs: the last runs of this mission — successes to build
  // on, failures so the agent doesn't retry an approach that already failed.
  const { data: prevRuns } = await admin
    .from("internal_agent_runs")
    .select("finished_at, status, final_output, error_message")
    .eq("mission_id", mission.id)
    .in("status", ["succeeded", "failed"])
    .neq("id", runId)
    .order("created_at", { ascending: false })
    .limit(3);
  let previousRunSection = "";
  if (prevRuns && prevRuns.length > 0) {
    const parts = (prevRuns as Array<{ finished_at: string | null; status: string; final_output: string | null; error_message: string | null }>).map((r) => {
      const head = `### ${r.status === "succeeded" ? "✅ Succès" : "❌ Échec"} — ${String(r.finished_at ?? "").slice(0, 16)}`;
      const err = r.status === "failed" ? `\nErreur: ${String(r.error_message ?? "inconnue").slice(0, 300)}` : "";
      const body = String(r.final_output ?? "").slice(0, 1200);
      return `${head}${err}${body ? `\n${body}` : ""}`;
    });
    previousRunSection = `\n## Previous runs of this mission (newest first)\nDo NOT redo what already succeeded; do NOT retry an approach that already failed the same way.\n${parts.join("\n\n")}\n`;
  }

  const deliverablesSpec = (Array.isArray(mission.expected_deliverables) ? mission.expected_deliverables : [])
    .map((d: { kind: string; name: string; description?: string }) =>
      `- ${d.kind}: ${d.name}${d.description ? ` — ${d.description}` : ""}`)
    .join("\n");

  // ── Le work item que sert cette mission (0235) ────────────────────────────
  //
  // Sans cette section, l'agent reçoit un brief hors-sol : il produit quelque
  // chose de correct et personne ne peut le relier à la demande. Avec elle, il
  // sait sur QUOI il travaille, peut relire l'état courant avec l'outil
  // tracker, commenter sa progression, et refermer l'item quand il a fini —
  // c'est cette boucle-là qui fait la différence entre un agent qui rend un
  // fichier et un agent qui fait avancer le travail.
  let workItemSection = "";
  if ((mission as { pj_issue_id?: string | null }).pj_issue_id) {
    const { data: issueRow } = await admin
      .from("pj_issues")
      .select("id, name, description_text, agent_brief, sequence_id, priority, target_date, pj_projects(identifier, name)")
      .eq("id", (mission as { pj_issue_id: string }).pj_issue_id)
      .maybeSingle();
    if (issueRow) {
      const i = issueRow as {
        id: string; name: string; description_text: string | null;
        agent_brief: string | null; sequence_id: number;
        priority: string | null; target_date: string | null;
        pj_projects?: { identifier?: string; name?: string } | null;
      };
      const ref = (i.pj_projects?.identifier ?? "ITEM") + "-" + i.sequence_id;
      // Le travail à faire, s'il n'est pas DÉJÀ dans le brief de la mission.
      // L'ordonnanceur l'y recopie en tête ; une mission lancée à la main depuis
      // la fiche ne l'a pas. Le répéter dans le premier cas ferait lire deux
      // fois la même commande, et le taire dans le second priverait l'agent de
      // la seule partie qui lui est adressée.
      const brief = (i.agent_brief ?? "").trim();
      const briefAlreadyGiven = !!brief && (mission.brief ?? "").includes(brief);
      // La MATIÈRE : les ressources rattachées à l'item. Sans elles, l'agent
      // sait quoi faire et pas sur quoi — il repart du web ou de son idée du
      // sujet, et rend un travail hors-sol qu'il faut jeter.
      const resources = await describeIssueAssets(admin, i.id);
      workItemSection = [
        "",
        "## Work item served by this mission",
        ref + " — " + i.name,
        "Project: " + (i.pj_projects?.name ?? ""),
        "Priority: " + (i.priority ?? "none") + (i.target_date ? " · due " + i.target_date : ""),
        "Issue id (pass this to the tracker tool): " + i.id,
        // TROIS champs, trois rôles : le nom dit de quoi il s'agit, la
        // description dit le contexte que l'équipe s'est écrit, le travail à
        // faire dit la commande. Un agent qui n'a que le titre invente sa
        // tâche ; un agent qui n'a que la commande la mène hors sujet.
        brief && !briefAlreadyGiven ? "\nWork to do (written for you):\n" + brief.slice(0, 4000) : "",
        i.description_text ? "\nDescription (context for the team):\n" + i.description_text.slice(0, 2000) : "",
        resources
          ? "\nResources attached to this item — this is the material you work ON.\n"
            + "Open them before anything else with the tracker tool (action=get_asset,\n"
            + "params={asset_id}); it returns the address and the content when there is one.\n"
            + resources.slice(0, 3000)
          : "",
        "",
        "This mission exists to move " + ref + " forward. The WORK TO DO is your",
        "instruction; the description is background. When they disagree, follow the",
        "work to do.",
        "",
        // Les gestes exacts, et non « mets l'état à jour » : un agent à qui l'on
        // dit quoi faire sans dire comment cherche l'identifiant de l'état,
        // se trompe de ligne, ou attend une approbation qui n'est pas requise.
        "Report progress on " + ref + " with the tracker tool — these writes on YOUR",
        "work item need no approval:",
        "  - when you reach a result: action=comment, params={issue_id, body} — say what",
        "    you produced and where it is;",
        "  - when the work to do is fully done: action=update_work_item,",
        "    params={issue_id, state_group: \"completed\"};",
        "  - if you are blocked and cannot finish: comment WHY and leave the state as it",
        "    is. Never mark it completed without the result, and never cancel it yourself.",
        "",
        "Every deliverable you save is attached to " + ref + " — that link is what makes",
        "your work verifiable, so do not answer a different question than the one above.",
        "",
      ].join("\n");
    }
  }

  // A run started by an event (0267) carries it: the brief says what to do when
  // it happens, this says WHAT happened. Without it, the collaborator would
  // know its standing instruction and not the case in front of it.
  const trigger = (run as { trigger_payload?: { provider?: string; event?: string; received_at?: string; data?: unknown } | null }).trigger_payload;
  let triggerSection = "";
  if (trigger) {
    let dataText = "";
    try { dataText = JSON.stringify(trigger.data ?? {}, null, 2).slice(0, 5000); } catch { dataText = String(trigger.data ?? ""); }
    triggerSection = [
      "",
      "## Événement déclencheur",
      `Source : ${trigger.provider === "founderos" ? "l'application (événement interne)" : trigger.provider} · ${trigger.event ?? "?"}`,
      trigger.received_at ? `Reçu : ${trigger.received_at}` : "",
      "Données de l'événement :",
      "```json",
      dataText,
      "```",
      "Traite CET événement selon le brief ci-dessus. S'il ne demande finalement rien (doublon, hors sujet, déjà traité), termine en le disant en une phrase, sans livrable.",
      "",
    ].filter((l) => l !== "").join("\n") + "\n";
  }

  const userPrompt = `# Mission: ${mission.title}

## Brief
${mission.brief ?? "(no brief provided)"}

${mission.acceptance_criteria ? `## Acceptance criteria\n${mission.acceptance_criteria}\n` : ""}
${deliverablesSpec ? `## Expected deliverables\n${deliverablesSpec}\n` : ""}${workItemSection}${triggerSection}${previousRunSection}
Execute this mission now. Use your tools to gather what you need, save each expected deliverable (document tool, action deliver), then write your final mission report.`;
  return userPrompt;
}
