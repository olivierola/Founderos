import type { HqRawData } from "@/features/dashboard/hq/model";
import type { AgentAttribution } from "../model";

/**
 * Le filtrage des statistiques d'agents, en un seul endroit.
 *
 * Trois découpes, et elles ne passent pas par le même chemin :
 *
 *   · PAR SERVICE — se lit sur l'agent (`service_dashboard_id`). C'est la seule
 *     des trois qui ne dépende pas de l'attribution : un agent appartient à un
 *     service, qu'il ait travaillé sur une mission ou dans une conversation.
 *   · PAR PROJET et PAR DEMANDEUR — passent par la MISSION, seul objet qui
 *     sache à quoi un run se rattache (`pj_project_id`, 0235) et qui l'a voulu
 *     (`created_by`, `triggered_by`).
 *
 * D'où une limite qu'il faut dire plutôt que masquer : un agent interrogé dans
 * une room travaille SANS mission, donc sans projet. Filtrer par projet exclut
 * forcément ces exécutions-là — ce n'est pas une perte, c'est la seule réponse
 * honnête à « qu'a coûté ce projet ? ».
 *
 * Le filtrage porte sur les données BRUTES, avant que la vue ne soit bâtie.
 * `buildHqView` calcule une trentaine d'agrégats à partir des mêmes tableaux ;
 * les filtrer un par un en aval donnerait immanquablement un graphe qui a
 * oublié le filtre — le genre d'écart qu'on ne repère qu'en additionnant deux
 * colonnes à la main.
 */

export interface AgentStatsFilters {
  /** Le tableau de service auquel l'agent appartient. */
  serviceId?: string | null;
  /** Le projet de suivi que la mission sert. */
  pjProjectId?: string | null;
  /** La personne qui a demandé le travail. */
  actorId?: string | null;
}

export function hasFilters(f: AgentStatsFilters): boolean {
  return !!f.serviceId || !!f.pjProjectId || !!f.actorId;
}

export function filterHqRaw(
  raw: HqRawData,
  attribution: AgentAttribution | undefined,
  f: AgentStatsFilters,
): HqRawData {
  if (!hasFilters(f)) return raw;

  // Le service se résout sans l'attribution — on peut donc le filtrer même
  // quand celle-ci n'est pas encore chargée, plutôt que de rendre la page
  // insensible au réglage pendant une seconde.
  const agents = f.serviceId
    ? raw.agents.filter((a) => a.service_dashboard_id === f.serviceId)
    : raw.agents;
  const agentIds = new Set(agents.map((a) => a.id));

  const needsAttribution = !!f.pjProjectId || !!f.actorId;
  if (needsAttribution && !attribution) {
    // Sans attribution, on n'applique que ce qu'on sait appliquer. Rendre des
    // chiffres non filtrés serait pire : ils seraient JUSTES pour un périmètre
    // que l'écran n'affiche plus.
    return narrowToAgents(raw, agents, agentIds);
  }

  const missionOk = (missionId: string | null): boolean => {
    if (!missionId) return false;
    const m = attribution!.missions.get(missionId);
    if (!m) return false;
    if (f.pjProjectId && m.pjProjectId !== f.pjProjectId) return false;
    if (f.actorId && m.createdBy !== f.actorId) return false;
    return true;
  };

  const runOk = (r: { id: string; agent_id: string; mission_id: string | null }): boolean => {
    if (f.serviceId && !agentIds.has(r.agent_id)) return false;
    // Le projet ne se lit QUE par la mission : un run sans mission n'est
    // rattachable à rien, et le garder gonflerait le total du projet avec du
    // travail qui n'est pas le sien.
    if (f.pjProjectId) return missionOk(r.mission_id);
    // Sans filtre projet, le demandeur peut venir du run lui-même — c'est le
    // cas d'une exécution lancée à la main depuis la fiche d'un agent.
    if (f.actorId) {
      return attribution!.runActor.get(r.id) === f.actorId || missionOk(r.mission_id);
    }
    return true;
  };

  const runs = raw.runs.filter(runOk);
  const runIds = new Set(runs.map((r) => r.id));

  return {
    ...raw,
    agents,
    runs,
    missions: raw.missions.filter(
      (m) => (!f.serviceId || agentIds.has(m.agent_id))
        && (!needsAttribution || missionOk(m.id)),
    ),
    // Tout ce qui pend à un run suit son run. Une approbation ou un livrable
    // sans run rattaché disparaît du décompte filtré, ce qui est correct : on ne
    // peut pas affirmer qu'il appartient au périmètre regardé.
    deliverables: raw.deliverables.filter((d) => d.run_id && runIds.has(d.run_id)),
    approvals: raw.approvals.filter((a) => a.run_id && runIds.has(a.run_id)),
    loopEvents: raw.loopEvents.filter((e) => runIds.has(e.run_id)),
    toolEvents: raw.toolEvents.filter((e) => e.run_id && runIds.has(e.run_id)),
  };
}

/** Le cas « service seul » : tout se déduit de l'appartenance de l'agent. */
function narrowToAgents(
  raw: HqRawData,
  agents: HqRawData["agents"],
  agentIds: Set<string>,
): HqRawData {
  const runs = raw.runs.filter((r) => agentIds.has(r.agent_id));
  const runIds = new Set(runs.map((r) => r.id));
  return {
    ...raw,
    agents,
    runs,
    missions: raw.missions.filter((m) => agentIds.has(m.agent_id)),
    deliverables: raw.deliverables.filter((d) => agentIds.has(d.agent_id)),
    approvals: raw.approvals.filter((a) => agentIds.has(a.agent_id)),
    loopEvents: raw.loopEvents.filter((e) => runIds.has(e.run_id)),
    toolEvents: raw.toolEvents.filter((e) => agentIds.has(e.agent_id)),
  };
}
