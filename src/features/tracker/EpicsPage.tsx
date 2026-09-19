import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CaretDownIcon, CaretRightIcon, PlusIcon, StackIcon, TrashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { IssueKey, PriorityIcon, StateIcon, formatDate } from "./pickers";
import { Modal, TextField } from "./ui";
import { ModuleIllustration } from "./illustrations";
import { EmptyState } from "./ui";
import {
  createIssue, deleteIssue, fetchEpicChildren, fetchEpics, fetchIssues, fetchStates,
  setEpicChildren, type PjIssue, type PjProject,
} from "./model";

/**
 * Les epics : un work item qui en porte d'autres.
 *
 * Ce n'est PAS un module. Un module regroupe des items d'un même projet pour
 * organiser le travail ; un epic est une chose à livrer, avec son propre état,
 * ses commentaires et son journal — et il peut porter des items d'AUTRES
 * projets, ce que `parent_id` ne sait pas représenter (un parent appartient au
 * même projet et porte sa numérotation).
 *
 * D'où le choix de 0224 : un epic est un `pj_issues` marqué `is_epic`, pas une
 * table à part. Il hérite gratuitement des états, labels, commentaires et du
 * journal — trois mois de fonctionnalités qu'une table dédiée aurait fallu
 * réécrire.
 */
export function EpicsPage({ project }: { project: PjProject }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const { data: epics } = useQuery({
    queryKey: ["pj_epics", project.id],
    queryFn: () => fetchEpics(project.id),
  });
  const { data: states } = useQuery({
    queryKey: ["pj_states", project.id],
    queryFn: () => fetchStates(project.id),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pj_epics", project.id] });
    qc.invalidateQueries({ queryKey: ["pj_issues"] });
  };

  const { user } = useAuth();

  const create = async () => {
    if (!name.trim()) return;
    await createIssue({
      pjProjectId: project.id, workspaceId: project.workspace_id,
      name: name.trim(), is_epic: true, createdBy: user?.id ?? null,
    });
    setName("");
    setCreating(false);
    refresh();
  };

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-header shrink-0 items-center gap-2 px-4">
        <div className="flex-1">
          <h2 className="text-14 font-medium">Epics</h2>
          <p className="text-11 text-muted-foreground">
            Une chose à livrer, qui porte des work items — y compris d&apos;autres projets.
          </p>
        </div>
        <Button size="sm" className="h-8" onClick={() => setCreating(true)}>
          <PlusIcon className="mr-1 h-4 w-4" /> Nouvel epic
        </Button>
      </header>

      {creating && (
        <div className="flex gap-2 px-4 pb-3">
          <TextField
            autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
              if (e.key === "Escape") { setName(""); setCreating(false); }
            }}
            placeholder="Titre de l'epic" className="h-8 flex-1 text-14"
          />
          <Button size="sm" onClick={create} disabled={!name.trim()}>Créer</Button>
        </div>
      )}

      {!epics?.length ? (
        <EmptyState
          illustration={<ModuleIllustration className="w-full" />}
          title="Aucun epic"
          hint="Un epic regroupe des work items qui poursuivent le même but et dépassent un cycle. C'est ce qui permet de suivre « la refonte du paiement » sans lire trente tickets."
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <PlusIcon className="mr-1 h-4 w-4" /> Créer un epic
            </Button>
          }
        />
      ) : (
        <div className="space-y-2 px-4 pb-4">
          {epics.map((e) => (
            <EpicCard
              key={e.id} epic={e} project={project} states={states ?? []} onChanged={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EpicCard({
  epic, project, states, onChanged,
}: {
  epic: PjIssue; project: PjProject;
  states: Awaited<ReturnType<typeof fetchStates>>;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);

  const { data: children } = useQuery({
    queryKey: ["pj_epic_children", epic.id],
    queryFn: () => fetchEpicChildren(epic.id),
  });

  const kids = children ?? [];
  const done = kids.filter((k) => k.completed_at).length;
  const percent = kids.length ? Math.round((done / kids.length) * 100) : 0;
  const state = states.find((s) => s.id === epic.state_id);

  return (
    <article className="rounded-lg border border-border/70 p-3">
      <div className="flex items-center gap-2">
        <button
          type="button" onClick={() => setOpen((v) => !v)}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted"
        >
          {open ? <CaretDownIcon className="h-3 w-3" /> : <CaretRightIcon className="h-3 w-3" />}
        </button>
        <StackIcon className="h-4 w-4 text-violet-500" />
        <IssueKey identifier={project.identifier} sequenceId={epic.sequence_id} />
        <span className="min-w-0 flex-1 truncate text-13 font-medium">{epic.name}</span>
        {state && <StateIcon group={state.group} color={state.color} />}
        <PriorityIcon priority={epic.priority} />
        <span className="shrink-0 text-11 tabular-nums text-muted-foreground">
          {done}/{kids.length}
        </span>
        <button
          type="button" onClick={() => setPicking(true)} title="Rattacher des work items"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={async () => { await deleteIssue(epic.id); onChanged(); }}
          className="rounded p-1 text-muted-foreground hover:text-red-600"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-violet-500" style={{ width: `${percent}%` }} />
      </div>

      {open && (
        <ul className="space-y-1 pt-2.5">
          {kids.map((k) => {
            const s = states.find((x) => x.id === k.state_id);
            return (
              <li key={k.id} className="flex items-center gap-2 rounded px-1 py-1 text-13 hover:bg-muted/50">
                {s && <StateIcon group={s.group} color={s.color} className="h-3.5 w-3.5" />}
                <IssueKey identifier={project.identifier} sequenceId={k.sequence_id} />
                <span className={cn("min-w-0 flex-1 truncate", k.completed_at && "text-muted-foreground line-through")}>
                  {k.name}
                </span>
                {k.target_date && (
                  <span className="shrink-0 text-11 text-muted-foreground">
                    {formatDate(k.target_date)}
                  </span>
                )}
              </li>
            );
          })}
          {!kids.length && (
            <li className="px-1 text-11 text-muted-foreground">
              Aucun work item rattaché.
            </li>
          )}
        </ul>
      )}

      {picking && (
        <EpicChildrenDialog
          epic={epic} project={project} selected={kids.map((k) => k.id)}
          onClose={() => setPicking(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["pj_epic_children", epic.id] });
            onChanged();
          }}
        />
      )}
    </article>
  );
}

function EpicChildrenDialog({
  epic, project, selected, onClose, onSaved,
}: {
  epic: PjIssue; project: PjProject; selected: string[];
  onClose: () => void; onSaved: () => void;
}) {
  const [ids, setIds] = useState<string[]>(selected);
  const [query, setQuery] = useState("");

  const { data: issues } = useQuery({
    queryKey: ["pj_issues", { pjProjectId: project.id }],
    queryFn: () => fetchIssues({ pjProjectId: project.id }),
  });

  // Un epic ne se rattache pas à lui-même, et les autres epics non plus : un
  // epic dans un epic donnerait un arbre dont l'avancement se compterait deux
  // fois.
  const candidates = useMemo(() => {
    const list = (issues ?? []).filter((i) => i.id !== epic.id && !i.is_epic);
    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter((i) =>
      i.name.toLowerCase().includes(q) || String(i.sequence_id).includes(q));
  }, [issues, epic.id, query]);

  const toggle = (id: string) =>
    setIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <Modal
      open
      onClose={onClose}
      title={"Work items de l&apos;epic"}
      size="lg"
      footer={<>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button
            onClick={async () => {
              await setEpicChildren(epic.id, project.workspace_id, ids);
              onSaved();
              onClose();
            }}
          >
            Enregistrer
          </Button>
        </>}
    >
        <TextField
          autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrer…" className="h-8 text-14"
        />
        <div className="max-h-[340px] space-y-1 overflow-y-auto">
          {candidates.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => toggle(i.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left",
                ids.includes(i.id) ? "bg-primary/10" : "hover:bg-muted",
              )}
            >
              <IssueKey identifier={project.identifier} sequenceId={i.sequence_id} />
              <span className="min-w-0 flex-1 truncate text-14">{i.name}</span>
            </button>
          ))}
          {!candidates.length && (
            <p className="px-2 py-3 text-12 text-muted-foreground">Aucun work item.</p>
          )}
        </div>
    </Modal>
  );
}
