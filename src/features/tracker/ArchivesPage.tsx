import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowCounterClockwiseIcon, ArrowsClockwiseIcon, StackIcon, TrashIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { IssueKey, StateIcon, formatDate } from "./pickers";
import { ArchiveIllustration, CycleIllustration, ModuleIllustration } from "./illustrations";
import { EmptyState, Tabs } from "./ui";
import {
  archiveCycle, archiveIssue, archiveModule, deleteCycle, deleteIssue, deleteModule,
  fetchArchivedCycles, fetchArchivedIssues, fetchArchivedModules, fetchStates,
  type PjProject,
} from "./model";

/**
 * Les archives : ce qui a été retiré de la vue sans être détruit.
 *
 * La distinction compte. Archiver, c'est dire « ce n'est plus d'actualité » —
 * l'objet sort des listes et des compteurs mais reste consultable et
 * restaurable. Supprimer, c'est perdre le journal, les commentaires et les
 * décisions qui allaient avec. Les confondre, comme le font les outils qui
 * n'offrent que la corbeille, pousse les gens à ne rien nettoyer du tout.
 *
 * Les trois onglets suivent les trois objets qu'on archive — work items,
 * cycles, modules. Ils n'apparaissent que si le projet utilise la
 * fonctionnalité : proposer un onglet Cycles à un projet qui les a désactivés
 * afficherait une page vide qui ne peut jamais se remplir.
 */

type Tab = "issues" | "cycles" | "modules";

export function ArchivesPage({ project }: { project: PjProject }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("issues");

  const { data: issues } = useQuery({
    queryKey: ["pj_archived_issues", project.id],
    queryFn: () => fetchArchivedIssues(project.id),
  });
  const { data: cycles } = useQuery({
    queryKey: ["pj_archived_cycles", project.id],
    queryFn: () => fetchArchivedCycles(project.id),
    enabled: project.cycle_view,
  });
  const { data: modules } = useQuery({
    queryKey: ["pj_archived_modules", project.id],
    queryFn: () => fetchArchivedModules(project.id),
    enabled: project.module_view,
  });
  const { data: states } = useQuery({
    queryKey: ["pj_states", project.id],
    queryFn: () => fetchStates(project.id),
  });

  const refresh = () => {
    // On invalide LARGE : restaurer un cycle le fait réapparaître dans la page
    // Cycles, dans le sélecteur de la fiche d'un work item et dans les
    // analytics. N'invalider que la liste d'ici laisserait les trois autres
    // afficher un état d'avant la restauration.
    for (const key of [
      "pj_archived_issues", "pj_archived_cycles", "pj_archived_modules",
      "pj_issues", "pj_cycles", "pj_modules",
    ]) qc.invalidateQueries({ queryKey: [key] });
  };

  const tabs = [
    { key: "issues" as const, label: "Work items", count: issues?.length ?? 0, show: true },
    { key: "cycles" as const, label: "Cycles", count: cycles?.length ?? 0, show: project.cycle_view },
    { key: "modules" as const, label: "Modules", count: modules?.length ?? 0, show: project.module_view },
  ].filter((t) => t.show);

  // Le projet peut avoir désactivé l'onglet ouvert entre-temps : on retombe sur
  // le premier disponible plutôt que d'afficher une page qui ne répond plus.
  const active = tabs.some((t) => t.key === tab) ? tab : "issues";

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-header shrink-0 items-center gap-3 border-b border-border px-4">
        <Tabs
          value={active}
          onChange={setTab}
          options={tabs.map(({ key, label, count }) => ({ key, label, count }))}
        />
        <p className="hidden text-11 text-tertiary lg:block">
          Retirés des listes et des compteurs, conservés avec leur historique.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {active === "issues" && (
          !issues?.length ? (
            <ArchiveEmpty
              illustration={<ArchiveIllustration className="w-full" />}
              title="Aucun work item archivé"
              hint="Archiver retire un work item des boards et des compteurs sans le supprimer : son journal et ses commentaires restent, et il revient d'ici en un clic."
              where="Depuis un board, ouvrez un work item puis « Archiver » dans son menu."
            />
          ) : (
            <ul className="px-4 pb-4">
              {issues.map((i) => {
                const s = (states ?? []).find((x) => x.id === i.state_id);
                return (
                  <ArchivedRow
                    key={i.id}
                    leading={s ? <StateIcon group={s.group} color={s.color} /> : null}
                    label={i.name}
                    reference={<IssueKey identifier={project.identifier} sequenceId={i.sequence_id} />}
                    archivedAt={i.archived_at}
                    onRestore={async () => { await archiveIssue(i.id, false); refresh(); }}
                    onDelete={async () => { await deleteIssue(i.id); refresh(); }}
                  />
                );
              })}
            </ul>
          )
        )}

        {active === "cycles" && (
          !cycles?.length ? (
            <ArchiveEmpty
              illustration={<CycleIllustration className="w-full" />}
              title="Aucun cycle archivé"
              hint="Un cycle archivé quitte la page Cycles et les sélecteurs sans détacher les work items qu'il portait — son bilan reste juste."
              where="Depuis la page Cycles, menu « … » d'un cycle terminé, puis « Archiver »."
            />
          ) : (
            <ul className="px-4 pb-4">
              {cycles.map((c) => (
                <ArchivedRow
                  key={c.id}
                  leading={<ArrowsClockwiseIcon className="h-4 w-4 text-tertiary" />}
                  label={c.name}
                  reference={
                    c.start_date && c.end_date ? (
                      <span className="shrink-0 text-11 text-tertiary">
                        {formatDate(c.start_date)} → {formatDate(c.end_date)}
                      </span>
                    ) : null
                  }
                  archivedAt={c.archived_at}
                  onRestore={async () => { await archiveCycle(c.id, false); refresh(); }}
                  onDelete={async () => { await deleteCycle(c.id); refresh(); }}
                />
              ))}
            </ul>
          )
        )}

        {active === "modules" && (
          !modules?.length ? (
            <ArchiveEmpty
              illustration={<ModuleIllustration className="w-full" />}
              title="Aucun module archivé"
              hint="Un module archivé disparaît des listes et des filtres. Les work items qui lui étaient rattachés restent sur leurs boards."
              where="Depuis la page Modules, menu « … » d'un module livré, puis « Archiver »."
            />
          ) : (
            <ul className="px-4 pb-4">
              {modules.map((m) => (
                <ArchivedRow
                  key={m.id}
                  leading={<StackIcon className="h-4 w-4 text-tertiary" />}
                  label={m.name}
                  reference={null}
                  archivedAt={m.archived_at}
                  onRestore={async () => { await archiveModule(m.id, false); refresh(); }}
                  onDelete={async () => { await deleteModule(m.id); refresh(); }}
                />
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
}

/**
 * L'état vide d'un onglet d'archive.
 *
 * Il porte une troisième ligne que les autres écrans n'ont pas : OÙ archiver.
 * C'est le seul état vide du produit qu'on ne peut pas remplir depuis la page
 * où on le lit — l'archivage se fait ailleurs, sur l'objet lui-même. Un bouton
 * « Archiver » ici n'aurait rien à archiver, et son absence, sans explication,
 * laisse devant une page dont on ne sait pas quoi faire.
 */
function ArchiveEmpty({
  illustration, title, hint, where,
}: {
  illustration: React.ReactNode;
  title: string;
  hint: string;
  where: string;
}) {
  return (
    <EmptyState
      illustration={illustration}
      title={title}
      hint={hint}
      action={
        <span className="rounded-md bg-muted px-3 py-1.5 text-11 text-tertiary">
          {where}
        </span>
      }
    />
  );
}

/**
 * Une ligne d'archive.
 *
 * Restaurer est un BOUTON, supprimer une icône discrète. Les deux gestes sont
 * inverses mais pas symétriques : l'un est réversible et courant, l'autre est
 * définitif et rare, et leur donner le même poids visuel finirait par faire
 * cliquer sur le mauvais.
 */
function ArchivedRow({
  leading, reference, label, archivedAt, onRestore, onDelete,
}: {
  leading: React.ReactNode;
  reference: React.ReactNode;
  label: string;
  archivedAt: string | null;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="group flex items-center gap-2 border-b border-border/40 py-2.5">
      {leading}
      {reference}
      <span className="min-w-0 flex-1 truncate text-14 text-secondary">{label}</span>
      <span className="shrink-0 text-11 text-tertiary">
        Archivé le {formatDate(archivedAt)}
      </span>

      <Button
        size="sm" variant="outline" className="h-7 gap-1 text-12"
        onClick={onRestore}
      >
        <ArrowCounterClockwiseIcon className="h-3.5 w-3.5" /> Restaurer
      </Button>

      {/* Une confirmation SUR PLACE plutôt qu'une modale : la question est
          courte, la réponse est immédiate, et une boîte de dialogue pour
          « êtes-vous sûr » sur une ligne de liste est une interruption
          disproportionnée. */}
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md bg-red-600 px-2 py-1 text-11 font-medium text-white hover:bg-red-700"
          >
            Supprimer
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-md px-2 py-1 text-11 text-tertiary hover:bg-muted hover:text-foreground"
          >
            Annuler
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          title="Supprimer définitivement"
          className="shrink-0 rounded p-1 text-tertiary opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      )}
    </li>
  );
}
