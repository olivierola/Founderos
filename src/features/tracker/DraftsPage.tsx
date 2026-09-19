import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NotePencilIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { IssueKey, formatDate } from "./pickers";
import { deleteIssue, fetchIssues, updateIssue, type PjProject } from "./model";
import { DraftIllustration } from "./illustrations";
import { EmptyState } from "./ui";

/**
 * Les brouillons : les work items commencés et jamais publiés.
 *
 * Ils n'appartiennent qu'à leur auteur et n'apparaissent dans AUCUN board — ce
 * qui est tout l'intérêt : on peut noter une idée à moitié formulée sans
 * l'imposer à l'équipe ni fausser les compteurs du projet.
 */
export function DraftsPage({ project }: { project: PjProject }) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: drafts } = useQuery({
    queryKey: ["pj_drafts", project.id],
    queryFn: async () => {
      const rows = await fetchIssues({ pjProjectId: project.id, includeDrafts: true });
      // `includeDrafts` élargit la requête ; le filtre garde les brouillons ET
      // seulement les siens — un brouillon d'un collègue n'est pas à nous.
      return rows.filter((i) => i.is_draft && i.created_by === user?.id);
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pj_drafts", project.id] });
    qc.invalidateQueries({ queryKey: ["pj_issues"] });
  };

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-header shrink-0 flex-col justify-center px-4">
        <h2 className="text-14 font-medium">Brouillons</h2>
        <p className="text-11 text-muted-foreground">
          Visibles de vous seul, comptés nulle part.
        </p>
      </header>

      {!drafts?.length ? (
        <EmptyState
          illustration={<DraftIllustration className="w-full" />}
          title="Aucun brouillon"
          hint="Un work item commencé puis laissé de côté atterrit ici. Il n'apparaît sur aucun board et ne compte nulle part tant qu'il n'est pas publié."
        />
      ) : (
        <ul className="px-4 pb-4">
          {drafts.map((d) => (
            <li key={d.id} className="flex items-center gap-2 border-b border-border/40 py-2.5">
              <IssueKey identifier={project.identifier} sequenceId={d.sequence_id} />
              <span className="min-w-0 flex-1 truncate text-14">
                {d.name || <span className="text-muted-foreground">Sans titre</span>}
              </span>
              <span className="shrink-0 text-11 text-muted-foreground">
                {formatDate(d.created_at)}
              </span>
              <Button
                size="sm" variant="outline" className="h-7 text-12"
                onClick={async () => { await updateIssue(d.id, { is_draft: false }, user?.id ?? null); refresh(); }}
              >
                Publier
              </Button>
              <button
                type="button"
                onClick={async () => { await deleteIssue(d.id); refresh(); }}
                className="rounded p-1 text-muted-foreground hover:text-red-600"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
