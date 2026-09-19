import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowRightIcon, CheckCircleIcon, SparkleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { findDemoProjects, seedDemoProject, type DemoResult } from "./demoProject";

/**
 * Le bouton qui fabrique le projet de démonstration.
 *
 * Il vit DANS l'article plutôt que dans une page de réglages, parce que c'est
 * là qu'on se pose la question : au moment où on lit « suivez ce manuel avec de
 * vraies données ». Un bouton rangé ailleurs demanderait de retenir où il se
 * trouve pour un geste qu'on ne fera qu'une fois.
 *
 * Il dit ce qu'il a créé et où aller ensuite. Un semeur qui répond « c'est
 * fait » sans lien laisse le lecteur chercher dans une liste de projets ce
 * qu'il vient de fabriquer.
 */
export function DemoProjectCard() {
  const { user } = useAuth();
  const { workspaceId, projectId } = useCurrentContext();
  const { workspaceSlug, projectSlug, dashboardId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [result, setResult] = useState<DemoResult | null>(null);

  const base = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;

  const existing = useQuery({
    queryKey: ["demo_projects", dashboardId],
    queryFn: () => findDemoProjects(dashboardId!),
    enabled: !!dashboardId,
  });

  const seed = useMutation({
    mutationFn: () => seedDemoProject({
      workspaceId: workspaceId!,
      projectId: projectId!,
      dashboardId: dashboardId!,
      userId: user?.id ?? null,
    }),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ["pj_projects", dashboardId] });
      qc.invalidateQueries({ queryKey: ["demo_projects", dashboardId] });
    },
  });

  const ready = !!workspaceId && !!projectId && !!dashboardId;
  const already = (existing.data ?? []).length;

  if (result) {
    return (
      <div className="my-5 rounded-xl border border-emerald-500/30 bg-emerald-500/8 p-4">
        <div className="flex items-start gap-2.5">
          <CheckCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          <div className="min-w-0 flex-1">
            <p className="text-14 font-medium">
              Projet <span className="font-mono">{result.identifier}</span> créé.
            </p>
            <p className="mt-0.5 text-13 leading-relaxed text-muted-foreground">
              {result.counts.issues} work items, {result.counts.cycles} cycles,{" "}
              {result.counts.modules} modules, {result.counts.intake} demandes,{" "}
              {result.counts.pages} pages et {result.counts.stickies} notes.
            </p>
            <Button
              size="sm"
              className="mt-3 gap-1.5"
              onClick={() => navigate(`${base}/projects/${result.projectId}/issues`)}
            >
              Ouvrir le projet <ArrowRightIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="my-5 rounded-xl border border-border bg-muted/25 p-4">
      <div className="flex items-start gap-2.5">
        <SparkleIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-14 font-medium">Créer le projet de démonstration</p>
          <p className="mt-0.5 text-13 leading-relaxed text-muted-foreground">
            Un projet complet dans ce tableau de service, prêt à parcourir. La
            création prend quelques secondes.
          </p>

          {already > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-12 leading-snug text-amber-600">
              <WarningCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
              {already === 1
                ? "Un projet de démonstration existe déjà dans ce tableau."
                : `${already} projets de démonstration existent déjà dans ce tableau.`}
            </p>
          )}

          {seed.error && (
            <p className="mt-2 text-12 text-red-600">{(seed.error as Error).message}</p>
          )}

          <Button
            size="sm"
            className="mt-3"
            disabled={!ready || seed.isPending}
            onClick={() => seed.mutate()}
          >
            {seed.isPending ? "Création en cours…" : already ? "En créer un autre" : "Créer le projet"}
          </Button>
        </div>
      </div>
    </div>
  );
}
