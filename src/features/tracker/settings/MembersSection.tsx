import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MemberAvatar, memberName } from "../pickers";
import {
  PROJECT_ROLES, addProjectMember, fetchMembers, fetchProjectMembers,
  removeProjectMember, setProjectMemberRole, updateProject, type PjProject,
} from "../model";

/**
 * Les membres du projet.
 *
 * Ils ne pilotent PAS l'accès aux données — la RLS s'appuie sur l'appartenance
 * à l'espace, et un rôle projet qu'on croirait protecteur alors qu'il ne l'est
 * pas serait pire que pas de rôle du tout. Ce que cette table sert : qui
 * apparaît dans les sélecteurs d'assigné, et qui peut piloter le projet dans
 * l'interface. La distinction est écrite ici pour que personne ne s'en remette
 * à ces rôles pour cloisonner des données sensibles.
 */
export function MembersSection({
  project, onChanged,
}: { project: PjProject; onChanged: () => void }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const { data: members } = useQuery({
    queryKey: ["pj_project_members", project.id],
    queryFn: () => fetchProjectMembers(project.id),
  });
  const { data: workspaceMembers } = useQuery({
    queryKey: ["pj_members", project.workspace_id],
    queryFn: () => fetchMembers(project.workspace_id),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_project_members", project.id] });

  const rows = (members ?? []).map((m) => ({
    ...m,
    profile: (workspaceMembers ?? []).find((w) => w.user_id === m.user_id),
  }));

  const candidates = (workspaceMembers ?? []).filter(
    (w) => !(members ?? []).some((m) => m.user_id === w.user_id),
  );

  return (
    <section className="space-y-2">
      <h3 className="text-14 font-medium">Membres</h3>
      <p className="text-11 text-muted-foreground">
        Qui apparaît dans les sélecteurs d&apos;assigné et qui pilote le projet.
        L&apos;accès aux données, lui, reste porté par l&apos;appartenance à l&apos;espace.
      </p>

      <div className="rounded-lg border border-border/70">
        {rows.map((m) => (
          <div key={m.id} className="flex items-center gap-2 border-b border-border/40 px-3 py-2 last:border-0">
            <MemberAvatar member={m.profile} />
            <span className="min-w-0 flex-1 truncate text-13">{memberName(m.profile)}</span>

            {/* Le responsable du projet est marqué ici plutôt que dans une
                section à part : c'est un membre avec un rôle, pas une notion
                distincte. */}
            {project.lead_id === m.user_id && (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-10 text-primary">
                Responsable
              </span>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded border border-border px-2 py-0.5 text-11 text-muted-foreground hover:bg-muted">
                  {PROJECT_ROLES.find((r) => r.key === m.role)?.label ?? m.role}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {PROJECT_ROLES.map((r) => (
                  <DropdownMenuItem
                    key={r.key}
                    onClick={async () => { await setProjectMemberRole(m.id, r.key); refresh(); }}
                  >
                    <span>
                      <span className="block">{r.label}</span>
                      <span className="block text-10 text-muted-foreground">{r.hint}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
                {project.lead_id !== m.user_id && (
                  <DropdownMenuItem
                    onClick={async () => {
                      await updateProject(project.id, { lead_id: m.user_id });
                      onChanged();
                    }}
                  >
                    Désigner responsable
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              type="button"
              onClick={async () => { await removeProjectMember(m.id); refresh(); }}
              className="rounded p-1 text-muted-foreground hover:text-red-600"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </div>
        ))}

        {!adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={!candidates.length}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-13 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" />
            {candidates.length ? "Ajouter un membre" : "Tout l'espace est déjà membre"}
          </button>
        ) : (
          <div className="max-h-56 overflow-y-auto p-1">
            {candidates.map((c) => (
              <button
                key={c.user_id}
                type="button"
                onClick={async () => {
                  await addProjectMember({
                    pjProjectId: project.id, workspaceId: project.workspace_id, userId: c.user_id,
                  });
                  setAdding(false);
                  refresh();
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
              >
                <MemberAvatar member={c} />
                <span className="min-w-0 flex-1 truncate text-13">{memberName(c)}</span>
              </button>
            ))}
            <Button
              size="sm" variant="ghost" className="mt-1 w-full"
              onClick={() => setAdding(false)}
            >
              Annuler
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
