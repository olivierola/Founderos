import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router-dom";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { fetchServiceDashboards } from "@/features/service-dashboards/model";

/**
 * La page d'arrivée de l'application : le module de travail (Plane).
 *
 * C'est là qu'on passe la journée — le travail, les agents qui le font, les
 * rooms où l'on en parle. Arriver ailleurs obligeait à un clic de plus à chaque
 * ouverture, pour aller au seul endroit où l'on comptait se rendre.
 *
 * Plane vit DANS un tableau de service. Lequel ouvrir :
 *   1. le dernier visité, s'il existe encore — on reprend où l'on en était ;
 *   2. sinon le premier, dans l'ordre choisi par l'équipe ;
 *   3. sinon, aucun tableau n'existe encore : on tombe sur le tableau de bord
 *      général, d'où l'on en crée un. Un module de travail sans service n'a
 *      nulle part où vivre.
 */

const LAST_KEY = (projectId: string) => `founderos.last-service-dashboard.${projectId}`;

/** Mémorise le tableau ouvert, pour y revenir à la prochaine arrivée. */
export function rememberServiceDashboard(projectId: string, dashboardId: string) {
  try { window.localStorage.setItem(LAST_KEY(projectId), dashboardId); } catch { /* sans conséquence */ }
}

function lastServiceDashboard(projectId: string): string | null {
  try { return window.localStorage.getItem(LAST_KEY(projectId)); } catch { return null; }
}

export function PlaneLanding() {
  const { workspaceSlug, projectSlug } = useParams();
  const { projectId } = useCurrentContext();

  const { data: dashboards, isLoading } = useQuery({
    queryKey: ["service_dashboards_landing", projectId],
    enabled: !!projectId,
    queryFn: () => fetchServiceDashboards(projectId!),
  });

  if (!projectId || isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const list = dashboards ?? [];
  if (!list.length) return <Navigate to="hq" replace />;

  const last = lastServiceDashboard(projectId);
  const target = list.find((d) => d.id === last) ?? list[0];
  return (
    <Navigate
      to={`/app/${workspaceSlug}/${projectSlug}/service/${target.id}/projects`}
      replace
    />
  );
}
