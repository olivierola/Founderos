import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon, ArrowCounterClockwiseIcon, NotePencilIcon, PlusIcon, TrashIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { IssueKey, StateIcon, formatRelative } from "./pickers";
import { StickiesPage } from "./StickyBoard";
import { ArchiveIllustration, DraftIllustration } from "./illustrations";
import { EmptyState } from "./ui";
import {
  archiveIssue, deleteIssue, fetchArchivedIssues, fetchIssues, fetchProjects,
  fetchStates, updateIssue, type PjIssue, type PjProject,
} from "./model";

/**
 * Les écrans d'espace qui agrègent tous les projets d'un service.
 *
 * Ils existent parce que la question qu'ils posent ne se pose PAS au niveau
 * d'un projet : « où sont mes brouillons » et « qu'a-t-on archivé » traversent
 * les chantiers. La même page ouverte projet par projet obligerait à faire la
 * synthèse de tête.
 */

/** Charge un même écran pour chaque projet, puis fusionne. Les requêtes sont
 *  parallèles côté react-query : c'est le seul moyen d'agréger sans une vue SQL
 *  par question, et le volume reste petit (brouillons et archives sont rares). */
function useAcrossProjects<T>(
  dashboardId: string,
  key: string,
  loader: (project: PjProject) => Promise<T[]>,
) {
  const { data: projects } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchProjects(dashboardId),
  });

  const list = projects ?? [];
  const results = useQuery({
    queryKey: [key, dashboardId, list.map((p) => p.id).join(",")],
    enabled: list.length > 0,
    queryFn: async () => {
      const chunks = await Promise.all(
        list.map(async (p) => (await loader(p)).map((row) => ({ row, project: p }))),
      );
      return chunks.flat();
    },
  });

  return { rows: results.data ?? [], projects: list, isLoading: results.isLoading };
}

// ── Brouillons ──────────────────────────────────────────────────────────────

export function SpaceDraftsPage({ dashboardId }: { dashboardId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { rows } = useAcrossProjects(dashboardId, "pj_space_drafts", async (p) => {
    const all = await fetchIssues({ pjProjectId: p.id, includeDrafts: true });
    // Ses propres brouillons uniquement : celui d'un collègue n'est pas à nous,
    // et c'est toute la raison d'être d'un brouillon.
    return all.filter((i) => i.is_draft && i.created_by === user?.id);
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pj_space_drafts"] });
    qc.invalidateQueries({ queryKey: ["pj_issues"] });
  };

  return (
    <SpaceShell
      icon={NotePencilIcon}
      title="Brouillons"
      hint="Visibles de vous seul, comptés nulle part."
      empty={!rows.length}
      emptyLabel="Aucun brouillon"
      emptyHint="Un work item commencé puis laissé de côté atterrit ici. Il n'apparaît sur aucun board et ne compte nulle part tant qu'il n'est pas publié."
      illustration={<DraftIllustration className="w-full" />}
    >
      <ul className="rounded-lg border border-border/70">
        {rows.map(({ row, project }) => (
          <li key={row.id} className="flex items-center gap-2 border-b border-border/40 px-3 py-2.5 last:border-0">
            <IssueKey identifier={project.identifier} sequenceId={row.sequence_id} />
            <span className="min-w-0 flex-1 truncate text-13">
              {row.name || <span className="text-muted-foreground">Sans titre</span>}
            </span>
            <span className="shrink-0 text-11 text-muted-foreground">{project.name}</span>
            <span className="shrink-0 text-11 text-muted-foreground">
              {formatRelative(row.created_at)}
            </span>
            <Button
              size="sm" variant="outline" className="h-7 text-11"
              onClick={async () => { await updateIssue(row.id, { is_draft: false }, user?.id ?? null); refresh(); }}
            >
              Publier
            </Button>
            <button
              type="button"
              onClick={async () => { await deleteIssue(row.id); refresh(); }}
              className="rounded p-1 text-muted-foreground hover:text-red-600"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </SpaceShell>
  );
}

// ── Archives ────────────────────────────────────────────────────────────────

export function SpaceArchivesPage({ dashboardId }: { dashboardId: string }) {
  const qc = useQueryClient();
  const { rows, projects } = useAcrossProjects(
    dashboardId, "pj_space_archives", (p) => fetchArchivedIssues(p.id),
  );

  const { data: statesByProject } = useQuery({
    queryKey: ["pj_states_all", dashboardId, projects.map((p) => p.id).join(",")],
    enabled: projects.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        projects.map(async (p) => [p.id, await fetchStates(p.id)] as const),
      );
      return Object.fromEntries(entries);
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pj_space_archives"] });
    qc.invalidateQueries({ queryKey: ["pj_issues"] });
  };

  return (
    <SpaceShell
      icon={ArchiveIcon}
      title="Archives"
      hint="Retirés des boards et des compteurs, conservés avec leur historique."
      empty={!rows.length}
      emptyLabel="Rien n'est archivé"
      emptyHint="Archiver retire un work item des boards et des compteurs sans le supprimer : son journal reste, et il revient d'ici en un clic."
      illustration={<ArchiveIllustration className="w-full" />}
    >
      <ul className="rounded-lg border border-border/70">
        {rows.map(({ row, project }) => {
          const state = (statesByProject?.[project.id] ?? []).find((s) => s.id === row.state_id);
          return (
            <li key={row.id} className="flex items-center gap-2 border-b border-border/40 px-3 py-2.5 last:border-0">
              {state && <StateIcon group={state.group} color={state.color} />}
              <IssueKey identifier={project.identifier} sequenceId={row.sequence_id} />
              <span className="min-w-0 flex-1 truncate text-13 text-muted-foreground">{row.name}</span>
              <span className="shrink-0 text-11 text-muted-foreground">{project.name}</span>
              <span className="shrink-0 text-11 text-muted-foreground">
                {formatRelative(row.archived_at)}
              </span>
              <Button
                size="sm" variant="outline" className="h-7 gap-1 text-11"
                onClick={async () => { await archiveIssue(row.id, false); refresh(); }}
              >
                <ArrowCounterClockwiseIcon className="h-3.5 w-3.5" /> Restaurer
              </Button>
            </li>
          );
        })}
      </ul>
    </SpaceShell>
  );
}

// ── Notes ───────────────────────────────────────────────────────────────────

export function SpaceStickiesPage({
  dashboardId, workspaceId,
}: { dashboardId: string; workspaceId: string | null }) {
  // Pas d'enveloppe commune ici : le mur de notes porte SA barre du haut, avec
  // la recherche et le bouton d'ajout. Le passer dans la coquille des autres
  // destinations donnerait deux barres empilées, et le bouton principal se
  // retrouverait sous le titre au lieu d'être dedans.
  if (!workspaceId) return null;
  return <StickiesPage dashboardId={dashboardId} workspaceId={workspaceId} />;
}

// ── Enveloppe commune ───────────────────────────────────────────────────────

function SpaceShell({
  icon: Icon, title, hint, empty, emptyLabel, illustration, emptyHint, children, action,
}: {
  icon: typeof ArchiveIcon;
  title: string;
  hint: string;
  empty: boolean;
  emptyLabel: string;
  /** L'illustration de l'état vide. Sans elle, on retombe sur le pictogramme
   *  du titre — correct, mais moins parlant sur une page entière. */
  illustration?: React.ReactNode;
  /** La phrase qui dit à quoi sert l'écran, sous le titre de l'état vide. */
  emptyHint?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-14 font-medium">{title}</h2>
        <div className="flex-1" />
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-4xl">
          <p className="pb-3 text-11 text-muted-foreground">{hint}</p>
          {empty ? (
            <EmptyState
              illustration={illustration}
              icon={illustration ? undefined : <Icon className="h-5 w-5" />}
              title={emptyLabel}
              hint={emptyHint}
            />
          ) : children}
        </div>
      </div>
    </div>
  );
}
