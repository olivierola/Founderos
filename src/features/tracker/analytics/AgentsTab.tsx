import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { SuitcaseSimpleIcon, UserIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useHqData, useHqRefresh } from "@/features/dashboard/hq/useHqData";
import { buildHqView, type HqRawData } from "@/features/dashboard/hq/model";
import type { RangeKey } from "@/features/crm/overview/crmStats";
import { loadWorkspaceMembers, memberLabel } from "@/features/internal-agents/shared";
import { cn } from "@/lib/utils";
import { EmptyState } from "../ui";
import { DashboardIllustration } from "../illustrations";
import { AgentStats, FilterMenu } from "./AgentStats";
import { filterHqRaw, hasFilters } from "./agentStatsFilters";
import { fetchAgentAttribution, type PjProject } from "../model";

/**
 * Les statistiques d'agents À L'ÉCHELLE D'UN SERVICE.
 *
 * Ce fichier ne dessine rien : le rendu est celui d'`AgentStats`, partagé avec
 * le tableau de bord général. Ce qu'il porte en propre, c'est ce qui n'a de sens
 * qu'ici — le périmètre du service, et les deux filtres qui le découpent.
 *
 * ── Les deux filtres ────────────────────────────────────────────────────────
 *
 * PAR PROJET et PAR DEMANDEUR. Ils passent tous les deux par la MISSION, seul
 * objet qui sache à quoi un run se rattache (`pj_project_id` depuis 0235) et
 * qui l'a voulu (`created_by`, `triggered_by`).
 *
 * D'où une limite qu'il faut dire plutôt que masquer : un agent interrogé dans
 * une room travaille SANS mission, donc sans projet. Filtrer par projet exclut
 * forcément ces exécutions-là. Le compte des exclus est affiché sous les
 * filtres — un total qui rétrécit sans explication ferait douter des chiffres
 * bien plus qu'une note qui l'assume.
 */

export function AgentsAnalyticsTab({
  dashboardId, projects, scopeProjectId,
}: {
  dashboardId: string;
  /** Les projets du service, pour nommer le périmètre dans l'avertissement. */
  projects: PjProject[];
  /** Le projet choisi en haut de page, qui commande aussi cet onglet. */
  scopeProjectId: string | null;
}) {
  const { projectId } = useCurrentContext();
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const [range, setRange] = useState<RangeKey>("30d");
  const [actorId, setActorId] = useState<string | null>(null);

  const { raw, isLoading, isFetching, hasAgents } = useHqData(projectId, dashboardId);
  const refresh = useHqRefresh();
  const agentIds = useMemo(() => raw.agents.map((a) => a.id), [raw.agents]);

  const { data: attribution } = useQuery({
    queryKey: ["pj_agent_attribution", agentIds.join(",")],
    enabled: agentIds.length > 0,
    queryFn: () => fetchAgentAttribution(agentIds),
  });

  const workspaceId = projects[0]?.workspace_id ?? null;
  const { data: directory } = useQuery({
    queryKey: ["pj_ws_members", workspaceId],
    enabled: !!workspaceId,
    queryFn: () => loadWorkspaceMembers(workspaceId!),
  });

  // Le projet vient du sélecteur de la page, le demandeur du menu ci-dessous.
  const filters = { pjProjectId: scopeProjectId, actorId };
  const filtered = useMemo(
    () => filterHqRaw(raw, attribution, filters),
    [raw, attribution, scopeProjectId, actorId],
  );

  const view = useMemo(() => buildHqView(filtered, range), [filtered, range]);

  if (!projectId || isLoading) {
    return (
      <p className="py-16 text-center text-12 text-muted-foreground">Chargement des statistiques…</p>
    );
  }

  if (!hasAgents) {
    return (
      <EmptyState
        illustration={<DashboardIllustration className="w-full" />}
        title="Aucun agent dans ce service"
        hint="Les exécutions, les coûts, les outils et les livrables de vos agents apparaîtront ici dès qu'un agent aura travaillé."
      />
    );
  }

  const filtering = hasFilters(filters);
  const excluded = raw.runs.length - filtered.runs.length;
  const scopeName = projects.find((p) => p.id === scopeProjectId)?.name ?? null;
  const actorName = actorId
    ? memberLabel((directory ?? []).find((d) => d.user_id === actorId), actorId)
    : null;

  return (
    <AgentStats
      layoutKey={`service-${dashboardId}`}
      view={view}
      range={range}
      onRangeChange={setRange}
      onRefresh={refresh}
      isFetching={isFetching}
      onOpenAgent={(id) => navigate(
        `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}/agent/${id}`,
      )}
      filters={
        <FilterMenu
          icon={UserIcon}
          allLabel="Tous les demandeurs"
          value={actorId}
          onChange={setActorId}
          options={(attribution?.actorIds ?? []).map((id) => ({
            id,
            label: memberLabel((directory ?? []).find((d) => d.user_id === id), id),
          }))}
          emptyHint="Aucune mission n'a encore de demandeur enregistré."
        />
      }
      notice={filtering && excluded > 0 ? (
        // Ce que le filtre écarte, dit en clair. Un total qui rétrécit sans
        // explication fait douter des chiffres ; une note qui l'assume fait
        // comprendre le périmètre.
        <p className="flex items-start gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-11 leading-snug text-muted-foreground">
          <WarningCircleIcon className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span>
            {excluded} exécution(s) écartée(s) par le filtre
            {scopeName && <> « {scopeName} »</>}
            {actorName && <> · {actorName}</>}.
            {scopeProjectId && attribution?.unattributedRuns
              ? ` Dont ${attribution.unattributedRuns} sans mission : une conversation en room ne se rattache à aucun projet.`
              : ""}
          </span>
        </p>
      ) : undefined}
    />
  );
}
