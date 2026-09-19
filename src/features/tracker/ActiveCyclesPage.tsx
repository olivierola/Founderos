import { useQuery } from "@tanstack/react-query";
import { ArrowsClockwiseIcon, WarningIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { formatDate } from "./pickers";
import { CycleIllustration } from "./illustrations";
import { EmptyState } from "./ui";
import {
  cyclePhase, fetchCycles, fetchProgress, fetchProjects,
  type PjCycle, type PjProject,
} from "./model";

/**
 * Les cycles en cours de TOUS les projets du service.
 *
 * La question à laquelle elle répond n'existe qu'à ce niveau : les itérations
 * courantes tiennent-elles ? Chaque projet la connaît pour lui-même, mais
 * personne ne voit l'ensemble — or c'est là qu'on repère la sprint qui décroche
 * pendant que les autres avancent.
 *
 * Les jours restants sont affichés à côté de l'avancement, et c'est le
 * rapprochement des deux qui informe : 60 % à mi-parcours est sain, 60 % à deux
 * jours de la fin ne l'est pas. Un pourcentage seul ne dit ni l'un ni l'autre.
 */
export function ActiveCyclesPage({
  dashboardId, onOpenProject,
}: { dashboardId: string; onOpenProject: (id: string) => void }) {
  const { data: projects } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchProjects(dashboardId),
  });

  const list = (projects ?? []).filter((p) => p.cycle_view);

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <header className="pb-3">
        <h2 className="text-14 font-medium">Cycles en cours</h2>
        <p className="text-11 text-muted-foreground">
          Les itérations actives de tous les projets, comparables entre elles.
        </p>
      </header>

      {!list.length ? (
        <EmptyState
          illustration={<CycleIllustration className="w-full" />}
          title="Aucun cycle en cours"
          hint="Un cycle borne une itération dans le temps : on décide ce qui y entre, et la date de fin ne bouge plus. Ouvrez-en un depuis un projet."
        />
      ) : (
        <div className="space-y-2">
          {list.map((p) => (
            <ProjectCycles key={p.id} project={p} onOpen={() => onOpenProject(p.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCycles({ project, onOpen }: { project: PjProject; onOpen: () => void }) {
  const { data: cycles } = useQuery({
    queryKey: ["pj_cycles", project.id],
    queryFn: () => fetchCycles(project.id),
  });

  const current = (cycles ?? []).filter((c) => cyclePhase(c) === "current");
  if (!current.length) return null;

  return (
    <div className="rounded-lg border border-border/70 p-3">
      <button type="button" onClick={onOpen} className="flex items-center gap-2 text-left">
        <span className="font-mono text-10 text-muted-foreground">{project.identifier}</span>
        <span className="text-13 font-medium hover:underline">{project.name}</span>
      </button>

      <div className="space-y-2 pt-2">
        {current.map((c) => <CycleRow key={c.id} cycle={c} projectId={project.id} />)}
      </div>
    </div>
  );
}

function CycleRow({ cycle, projectId }: { cycle: PjCycle; projectId: string }) {
  const { data: progress } = useQuery({
    queryKey: ["pj_progress", projectId, cycle.id],
    queryFn: () => fetchProgress(projectId, { cycleId: cycle.id }),
  });

  const total = progress?.total ?? 0;
  const done = progress?.completed ?? 0;
  const percent = total ? Math.round((done / total) * 100) : 0;

  // Les jours restants ET la part de temps écoulée : c'est l'écart entre le
  // temps consommé et le travail fait qui signale un cycle en difficulté.
  const now = Date.now();
  const start = cycle.start_date ? new Date(cycle.start_date).getTime() : null;
  const end = cycle.end_date ? new Date(cycle.end_date).getTime() : null;
  const daysLeft = end ? Math.max(0, Math.ceil((end - now) / 86_400_000)) : null;
  const elapsed = start && end && end > start
    ? Math.min(100, Math.max(0, Math.round(((now - start) / (end - start)) * 100)))
    : null;
  const behind = elapsed !== null && elapsed - percent >= 20;

  return (
    <div className="rounded border border-border/50 p-2.5">
      <div className="flex items-center gap-2">
        <ArrowsClockwiseIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-13">{cycle.name}</span>
        {behind && (
          <span className="flex shrink-0 items-center gap-1 inline-flex h-5 items-center rounded-full bg-amber-500/15 px-2 text-11 font-medium leading-none text-amber-600">
            <WarningIcon className="h-3 w-3" /> En retard sur le temps
          </span>
        )}
        <span className="shrink-0 text-11 text-muted-foreground">
          {daysLeft !== null ? `${daysLeft} j restants` : formatDate(cycle.end_date)}
        </span>
      </div>

      <div className="relative mt-2 h-1.5 rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", behind ? "bg-amber-500" : "bg-emerald-600")}
          style={{ width: `${percent}%` }}
        />
        {/* Le repère du temps écoulé, posé SUR la barre : c'est la comparaison
            visuelle immédiate entre « où on devrait être » et « où on est ». */}
        {elapsed !== null && (
          <span
            className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-foreground/50"
            style={{ left: `${elapsed}%` }}
            title={`${elapsed}% du temps écoulé`}
          />
        )}
      </div>

      <p className="pt-1 text-11 text-muted-foreground">
        {done}/{total} terminés · {percent}%
        {elapsed !== null ? ` · ${elapsed}% du temps écoulé` : ""}
      </p>
    </div>
  );
}
