import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChatCircleIcon, ClockCounterClockwiseIcon, DotsThreeIcon, LinkSimpleIcon,
  PaperclipIcon, PlusIcon, TrashIcon, TreeStructureIcon, XIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { TextAreaField, TextField } from "./ui";
import { AgentPicker } from "./AgentPicker";
import { IssueMissions } from "./IssueMissions";
import { CommentComposer } from "./CommentComposer";
import { AgentAvatar } from "./AgentPicker";
import { Select } from "./ui";
import {
  AssigneePicker, CyclePicker, DatePicker, IssueKey, LABEL_COLORS, LabelPicker, MemberAvatar,
  ModulePicker, PriorityPicker, StateIcon, StatePicker, formatDate, memberName,
} from "./pickers";
import {
  RELATION_LABEL, RELATION_TYPES, attachmentUrl,
  addComment, addRelation, createIssue, createLabel, deleteAttachment, deleteComment, deleteIssue,
  fetchActivity, fetchAttachments, fetchComments, fetchIssues, fetchRelations,
  removeRelation, setAssignees, setIssueCycle, setIssueModules, setLabels,
  setIssueAgents, updateIssue, uploadAttachment, assignMission, fetchTrackerAgents,
  type Member, type PjCycle, type PjIssue, type PjLabel, type PjModule,
  type PjProject, type PjState, type RelationType,
} from "./model";

/**
 * La partie gauche de la barre d'un work item : son état et sa référence.
 *
 * Elle est exportée parce que le peek porte sa propre barre : c'est le même
 * repère qu'il faut y retrouver, pas une variante.
 */
export function IssuePeekLead({
  issue, project, states,
}: { issue: PjIssue; project: PjProject; states: PjState[] }) {
  const state = states.find((s) => s.id === issue.state_id);
  return (
    <>
      {state && <StateIcon group={state.group} color={state.color} />}
      <IssueKey identifier={project.identifier} sequenceId={issue.sequence_id} />
    </>
  );
}

/** Les actions de la barre : copier le lien, archiver, supprimer. */
export function IssuePeekActions({
  issue, onClose, onChanged,
}: { issue: PjIssue; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const archive = async () => {
    await updateIssue(issue.id, { archived_at: new Date().toISOString() }, user?.id ?? null);
    onChanged();
    onClose();
  };
  return (
    <>
      <button
        type="button"
        title="Copier le lien"
        onClick={() => navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}?issue=${issue.id}`)}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <LinkSimpleIcon className="h-4 w-4" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <DotsThreeIcon className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={archive}>Archiver</DropdownMenuItem>
          <DropdownMenuItem
            className="text-red-600"
            onClick={async () => { await deleteIssue(issue.id); onClose(); onChanged(); }}
          >
            <TrashIcon className="h-4 w-4" /> Supprimer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/**
 * La fiche d'un work item, ouverte par-dessus le board (le « peek » de Plane).
 *
 * Elle se superpose au lieu de naviguer, exprès : on ouvre un item pour vérifier
 * un détail et on revient à sa liste, et une navigation ferait perdre le
 * défilement, les filtres et la position dans la colonne à chaque aller-retour.
 *
 * Chaque champ écrit immédiatement et invalide le board — il n'y a pas de
 * brouillon local à synchroniser, donc rien à perdre en fermant.
 */
export function IssueDetailPanel({
  issue, project, states, labels, members, cycles, modules,
  onClose, onChanged, onOpenIssue, dashboardId, embedded = false,
}: {
  issue: PjIssue;
  project: PjProject;
  states: PjState[];
  labels: PjLabel[];
  members: Member[];
  cycles: PjCycle[];
  modules: PjModule[];
  onClose: () => void;
  onChanged: () => void;
  onOpenIssue: (i: PjIssue) => void;
  /** Le tableau de service ouvert, pour proposer SES agents. */
  dashboardId?: string | null;
  /**
   * Posée dans une enveloppe qui porte déjà sa barre du haut (le peek).
   * On y renonce alors à la nôtre : deux barres empilées donneraient deux
   * croix, deux références, et l'utilisateur ne saurait pas laquelle ferme
   * quoi.
   */
  embedded?: boolean;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState(issue.name);
  const [description, setDescription] = useState(issue.description_text);
  const [tab, setTab] = useState<"comments" | "activity">("comments");

  // Rouvrir sur un autre item doit recharger les champs : sans ça, le titre
  // resterait celui de l'item précédent.
  useEffect(() => {
    setName(issue.name);
    setDescription(issue.description_text);
  }, [issue.id, issue.name, issue.description_text]);

  const invalidate = () => {
    onChanged();
    qc.invalidateQueries({ queryKey: ["pj_issue_children", issue.id] });
  };

  // Pas de journalisation ici : le trigger de 0222 voit le UPDATE et écrit la
  // ligne, en traduisant les identifiants en noms — ce que le client ne peut
  // pas faire sans recharger les référentiels à chaque modification.
  const patch = useMutation({
    mutationFn: (p: Partial<PjIssue>) => updateIssue(issue.id, p, user?.id ?? null),
    onSuccess: invalidate,
  });

  const { data: children } = useQuery({
    queryKey: ["pj_issue_children", issue.id],
    queryFn: () => fetchIssues({ pjProjectId: project.id, parentId: issue.id }),
  });

  const { data: relations } = useQuery({
    queryKey: ["pj_issue_relations", issue.id],
    queryFn: () => fetchRelations(issue.id),
  });

  return (
    <aside className={cn(
      "flex h-full w-full flex-col bg-background",
      !embedded && "max-w-[720px] border-l border-border shadow-xl",
    )}>
      {!embedded && (
        <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-muted" title="Fermer">
            <XIcon className="h-4 w-4" />
          </button>
          <IssuePeekLead issue={issue} project={project} states={states} />
          <div className="flex-1" />
          <IssuePeekActions issue={issue} onClose={onClose} onChanged={onChanged} />
        </header>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 px-5 py-4">
          {/* Le titre s'édite sur place, et n'écrit qu'à la sortie du champ :
              enregistrer à chaque frappe produirait une ligne d'activité par
              lettre tapée. */}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (name.trim() && name !== issue.name) patch.mutate({ name: name.trim() }); }}
            className="w-full bg-transparent text-xl font-medium outline-none"
            placeholder="Titre du work item"
          />

          <TextAreaField
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => {
              if (description !== issue.description_text) {
                patch.mutate({ description_text: description, description_html: description });
              }
            }}
            placeholder="Ajoutez une description…"
            // Elle GRANDIT avec le texte, et n'a pas de poignée de
            // redimensionnement. La poignée est un aveu : elle dit « le champ
            // ne sait pas quelle taille il lui faut, débrouillez-vous ». Ici la
            // description occupe exactement ce qu'elle occupe, et la fiche
            // défile — ce qu'elle fait déjà pour le reste.
            autoResize
            mode="transparent"
            className="min-h-[120px] text-14"
          />

          <PropertyGrid
            issue={issue} states={states} labels={labels} members={members}
            cycles={cycles} modules={modules} project={project}
            dashboardId={dashboardId ?? project.dashboard_id}
            onPatch={(p) => patch.mutate(p)}
            onChanged={invalidate}
          />

          <SubIssues
            parent={issue} project={project} children={children ?? []}
            states={states} onOpenIssue={onOpenIssue} onChanged={invalidate}
          />

          <Relations
            issue={issue} project={project} relations={relations ?? []}
            states={states} onOpenIssue={onOpenIssue} onChanged={invalidate}
          />

          {/* Les missions AVANT les pièces jointes : ce qu'on a confié à une
              machine se relit plus souvent qu'un fichier déposé, et la question
              « est-ce que ça tourne ? » ne doit pas demander de faire défiler. */}
          <IssueMissions
            issue={issue} project={project}
            dashboardId={dashboardId ?? project.dashboard_id}
            onPatch={(p) => patch.mutate(p)}
          />

          <Attachments issue={issue} project={project} />
        </div>

        <div className="border-t border-border">
          <div className="flex gap-1 px-5 pt-3">
            <TabButton active={tab === "comments"} onClick={() => setTab("comments")} icon={<ChatCircleIcon className="h-4 w-4" />}>
              Commentaires
            </TabButton>
            <TabButton active={tab === "activity"} onClick={() => setTab("activity")} icon={<ClockCounterClockwiseIcon className="h-4 w-4" />}>
              Activité
            </TabButton>
          </div>
          <div className="px-5 pb-6 pt-3">
            {tab === "comments"
              ? <Comments issue={issue} project={project} members={members} />
              : <Activity issue={issue} members={members} />}
          </div>
        </div>
      </div>
    </aside>
  );
}

function TabButton({
  active, onClick, icon, children,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-12 transition-colors",
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon} {children}
    </button>
  );
}

// ── Propriétés ──────────────────────────────────────────────────────────────

function PropertyGrid({
  issue, project, states, labels, members, cycles, modules, dashboardId,
  onPatch, onChanged,
}: {
  issue: PjIssue; project: PjProject; states: PjState[]; labels: PjLabel[];
  members: Member[]; cycles: PjCycle[]; modules: PjModule[];
  dashboardId?: string | null;
  onPatch: (p: Partial<PjIssue>) => void;
  onChanged: () => void;
}) {
  const { user } = useAuth();

  const rows: { label: string; control: React.ReactNode }[] = [
    {
      label: "État",
      control: <StatePicker states={states} value={issue.state_id} onChange={(id) => onPatch({ state_id: id })} />,
    },
    {
      label: "Priorité",
      control: <PriorityPicker value={issue.priority} onChange={(p) => onPatch({ priority: p })} />,
    },
    {
      label: "Assignés",
      control: (
        <AssigneePicker
          members={members} value={issue.assignee_ids}
          onChange={async (ids) => {
            await setAssignees(issue.id, project.id, project.workspace_id, ids);
            onChanged();
          }}
        />
      ),
    },
    {
      // Juste APRÈS les personnes, jamais fondu avec elles : la ligne doit
      // dire d'un coup d'œil si c'est une machine ou quelqu'un qui s'en
      // occupe. Les deux ne se relancent pas de la même façon.
      label: "Agents",
      control: (
        <AgentPicker
          dashboardId={dashboardId ?? project.dashboard_id ?? ""}
          workspaceId={project.workspace_id}
          pjProjectId={project.id}
          value={issue.agent_ids}
          onChange={async (ids) => {
            await setIssueAgents(issue.id, project.workspace_id, ids, user?.id ?? null);
            onChanged();
          }}
        />
      ),
    },
    {
      label: "Labels",
      control: (
        <LabelPicker
          labels={labels} value={issue.label_ids}
          // Créer sans quitter le champ. Un projet neuf n'a AUCUN label : sans
          // cette voie, le sélecteur s'ouvrait sur une liste vide et la seule
          // issue était d'aller dans les réglages — c'est-à-dire de perdre le
          // fil, et en pratique de ne pas mettre de label du tout.
          onCreate={async (name) => {
            const created = await createLabel({
              pjProjectId: project.id,
              workspaceId: project.workspace_id,
              name,
              color: LABEL_COLORS[labels.length % LABEL_COLORS.length],
            });
            onChanged();
            return created;
          }}
          onChange={async (ids) => {
            await setLabels(issue.id, project.id, project.workspace_id, ids);
            onChanged();
          }}
        />
      ),
    },
    {
      label: "Début",
      control: <DatePicker value={issue.start_date} onChange={(v) => onPatch({ start_date: v })} placeholder="Début" />,
    },
    {
      label: "Échéance",
      control: (
        <DatePicker
          value={issue.target_date} onChange={(v) => onPatch({ target_date: v })}
          placeholder="Échéance" min={issue.start_date}
        />
      ),
    },
    {
      label: "Cycle",
      control: (
        <CyclePicker
          cycles={cycles} value={issue.cycle_id}
          onChange={async (id) => { await setIssueCycle(issue.id, project.workspace_id, id); onChanged(); }}
        />
      ),
    },
    {
      label: "Modules",
      control: (
        <ModulePicker
          modules={modules} value={issue.module_ids}
          onChange={async (ids) => { await setIssueModules(issue.id, project.workspace_id, ids); onChanged(); }}
        />
      ),
    },
  ];

  return (
    <div className="space-y-1.5 rounded-lg border border-border/60 p-3">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[110px_1fr] items-center gap-2">
          <span className="text-12 text-muted-foreground">{r.label}</span>
          <div className="flex min-w-0">{r.control}</div>
        </div>
      ))}
    </div>
  );
}

// ── Sous-tâches ─────────────────────────────────────────────────────────────

function SubIssues({
  parent, project, children, states, onOpenIssue, onChanged,
}: {
  parent: PjIssue; project: PjProject; children: PjIssue[]; states: PjState[];
  onOpenIssue: (i: PjIssue) => void; onChanged: () => void;
}) {
  const { user } = useAuth();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  // La progression d'un parent se lit sur ses enfants terminés : c'est le seul
  // chiffre qui dit si une tâche découpée avance vraiment.
  const done = children.filter((c) => {
    const s = states.find((x) => x.id === c.state_id);
    return s?.group === "completed";
  }).length;

  const submit = async () => {
    if (!title.trim()) return;
    await createIssue({
      pjProjectId: project.id, workspaceId: project.workspace_id,
      name: title.trim(), parent_id: parent.id, createdBy: user?.id ?? null,
    });
    setTitle("");
    setAdding(false);
    onChanged();
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <TreeStructureIcon className="h-4 w-4 text-muted-foreground" />
        <span className="text-12 font-medium">Sous-tâches</span>
        {children.length > 0 && (
          <span className="text-11 text-muted-foreground">{done}/{children.length}</span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>

      {children.map((c) => {
        const s = states.find((x) => x.id === c.state_id);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onOpenIssue(c)}
            className="flex w-full items-center gap-2 rounded border border-border/50 px-2 py-1.5 text-left text-13 hover:bg-muted/50"
          >
            {s && <StateIcon group={s.group} color={s.color} className="h-3.5 w-3.5" />}
            <IssueKey identifier={project.identifier} sequenceId={c.sequence_id} />
            <span className="flex-1 truncate">{c.name}</span>
          </button>
        );
      })}

      {adding && (
        <div className="flex gap-2">
          <TextField
            autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setAdding(false); }}
            placeholder="Titre de la sous-tâche" className="h-8 text-14"
          />
          <Button size="sm" onClick={submit}>Ajouter</Button>
        </div>
      )}
    </section>
  );
}

// ── Relations ───────────────────────────────────────────────────────────────

function Relations({
  issue, project, relations, states, onOpenIssue, onChanged,
}: {
  issue: PjIssue; project: PjProject; relations: { id: string; related_id: string; relation_type: RelationType }[];
  states: PjState[]; onOpenIssue: (i: PjIssue) => void; onChanged: () => void;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<RelationType>("relates_to");

  const { data: candidates } = useQuery({
    queryKey: ["pj_issues_all", project.id],
    queryFn: () => fetchIssues({ pjProjectId: project.id }),
  });

  const byId = useMemo(
    () => new Map((candidates ?? []).map((i) => [i.id, i])),
    [candidates],
  );

  const grouped = useMemo(() => {
    const map = new Map<RelationType, string[]>();
    for (const r of relations) {
      const arr = map.get(r.relation_type);
      if (arr) arr.push(r.related_id); else map.set(r.relation_type, [r.related_id]);
    }
    return map;
  }, [relations]);

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <LinkSimpleIcon className="h-4 w-4 text-muted-foreground" />
        <span className="text-12 font-medium">Relations</span>
        <div className="flex-1" />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <PlusIcon className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="end">
            <div className="border-b p-2">
              <Select
                size="xs"
                value={type}
                onChange={(v) => setType(v as RelationType)}
                options={RELATION_TYPES.map((t) => ({ key: t, label: RELATION_LABEL[t] }))}
              />
            </div>
            <Command>
              <CommandInput placeholder="Chercher un work item…" />
              <CommandList>
                <CommandEmpty>Aucun work item.</CommandEmpty>
                <CommandGroup>
                  {(candidates ?? [])
                    .filter((c) => c.id !== issue.id)
                    .map((c) => (
                      <CommandItem
                        key={c.id}
                        value={`${project.identifier}-${c.sequence_id} ${c.name}`}
                        onSelect={async () => {
                          await addRelation({
                            issueId: issue.id, relatedId: c.id, workspaceId: project.workspace_id,
                            type, createdBy: user?.id ?? null,
                          });
                          setOpen(false);
                          onChanged();
                        }}
                      >
                        <IssueKey identifier={project.identifier} sequenceId={c.sequence_id} />
                        <span className="flex-1 truncate">{c.name}</span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {[...grouped.entries()].map(([relType, ids]) => (
        <div key={relType} className="space-y-1">
          <p className="text-11 text-muted-foreground">{RELATION_LABEL[relType]}</p>
          {ids.map((id) => {
            const target = byId.get(id);
            if (!target) return null;
            const s = states.find((x) => x.id === target.state_id);
            return (
              <div key={id} className="flex items-center gap-2 rounded border border-border/50 px-2 py-1.5 text-13">
                {s && <StateIcon group={s.group} color={s.color} className="h-3.5 w-3.5" />}
                <button type="button" onClick={() => onOpenIssue(target)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <IssueKey identifier={project.identifier} sequenceId={target.sequence_id} />
                  <span className="truncate">{target.name}</span>
                </button>
                <button
                  type="button"
                  onClick={async () => { await removeRelation(issue.id, id); onChanged(); }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      ))}

      {!relations.length && <p className="text-12 text-muted-foreground">Aucune relation.</p>}
    </section>
  );
}

// ── Pièces jointes ──────────────────────────────────────────────────────────

function Attachments({ issue, project }: { issue: PjIssue; project: PjProject }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: files } = useQuery({
    queryKey: ["pj_attachments", issue.id],
    queryFn: () => fetchAttachments(issue.id),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_attachments", issue.id] });

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setError(null);
    try {
      // En série et non en parallèle : un envoi groupé de dix fichiers sature
      // la connexion et fait échouer les derniers sans qu'on sache lesquels.
      for (const file of Array.from(list)) {
        await uploadAttachment({
          file, issueId: issue.id, pjProjectId: project.id,
          workspaceId: project.workspace_id, userId: user?.id ?? null,
        });
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "L'envoi a échoué.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <PaperclipIcon className="h-4 w-4 text-muted-foreground" />
        <span className="text-12 font-medium">Pièces jointes</span>
        <div className="flex-1" />
        <label className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <PlusIcon className="h-4 w-4" />
          <input
            type="file" multiple hidden disabled={busy}
            onChange={(e) => { upload(e.target.files); e.target.value = ""; }}
          />
        </label>
      </div>

      {busy && <p className="text-11 text-muted-foreground">Envoi en cours…</p>}
      {error && <p className="text-11 text-red-600">{error}</p>}

      {(files ?? []).map((f) => (
        <div key={f.id} className="flex items-center gap-2 rounded border border-border/50 px-2 py-1.5 text-13">
          <a
            href={attachmentUrl(f.storage_path)}
            target="_blank" rel="noreferrer"
            className="min-w-0 flex-1 truncate hover:underline"
          >
            {f.name}
          </a>
          <span className="shrink-0 text-11 text-muted-foreground">
            {Math.max(1, Math.round(f.size_bytes / 1024))} Ko
          </span>
          <button
            type="button"
            onClick={async () => { await deleteAttachment(f.id, f.storage_path); refresh(); }}
            className="text-muted-foreground hover:text-red-600"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      {!files?.length && !busy && (
        <p className="text-12 text-muted-foreground">Aucune pièce jointe.</p>
      )}
    </section>
  );
}

// ── Commentaires et activité ────────────────────────────────────────────────

function Comments({ issue, project, members }: { issue: PjIssue; project: PjProject; members: Member[] }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [launchError, setLaunchError] = useState<string | null>(null);

  const { data: comments } = useQuery({
    queryKey: ["pj_comments", issue.id],
    queryFn: () => fetchComments(issue.id),
    // Tant qu'un agent est en train de répondre, le fil se relit seul : sa
    // réponse arrive par la base, pas par ce client, et l'attendre derrière un
    // rechargement manuel ferait croire qu'il n'a rien dit.
    refetchInterval: (q) => {
      const last = (q.state.data ?? []).at(-1);
      return last && !last.agent_id && Date.now() - new Date(last.created_at).getTime() < 15 * 60_000
        ? 10_000 : false;
    },
  });

  // Les agents, pour mettre un visage sur leurs commentaires. Sans avatar, un
  // commentaire de machine ressemble à celui d'un membre inconnu, et c'est
  // précisément la distinction qu'on veut voir au premier coup d'œil.
  const { data: agents } = useQuery({
    queryKey: ["pj_tracker_agents", project.dashboard_id, project.workspace_id],
    queryFn: () => fetchTrackerAgents(project.dashboard_id, project.workspace_id),
  });

  const submit = async (text: string, agentIds: string[]) => {
    setLaunchError(null);
    await addComment({
      issueId: issue.id, pjProjectId: project.id, workspaceId: project.workspace_id,
      actorId: user?.id ?? null, html: text,
    });
    qc.invalidateQueries({ queryKey: ["pj_comments", issue.id] });

    // Le commentaire est publié AVANT que les agents ne partent : si un
    // lancement échoue, la demande reste écrite dans le fil, et on peut la
    // relancer sans la réécrire.
    for (const agentId of agentIds) {
      try {
        await assignMission({
          agentId, issue, project,
          title: `Réponse à un commentaire — ${issue.name}`.slice(0, 200),
          brief: `Un membre de l'équipe vous a mentionné dans la discussion de ce work item :

« ${text} »

Répondez-lui en commentaire sur ce même item, avec ce que vous avez fait ou trouvé.`,
          acceptanceCriteria: "",
          createdBy: user?.id ?? null,
        });
      } catch (e) {
        setLaunchError(e instanceof Error ? e.message : String(e));
      }
    }
    if (agentIds.length) {
      qc.invalidateQueries({ queryKey: ["pj_issue_missions", issue.id] });
      qc.invalidateQueries({ queryKey: ["pj_comments", issue.id] });
    }
  };

  return (
    <div className="space-y-3">
      {(comments ?? []).map((c) => {
        const author = members.find((m) => m.user_id === c.actor_id);
        const agent = c.agent_id ? (agents ?? []).find((a) => a.id === c.agent_id) : undefined;
        return (
          <div key={c.id} className="flex gap-2.5">
            {c.agent_id
              ? <AgentAvatar agent={agent} size={24} />
              : <MemberAvatar member={author} size={24} />}
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-12">
                <span className="font-medium">{c.agent_name ?? agent?.name ?? memberName(author)}</span>
                {c.agent_id && (
                  <span className="rounded bg-primary/10 px-1 text-10 font-medium text-primary">agent</span>
                )}
                <span className="text-muted-foreground">{formatDate(c.created_at)}</span>
                {c.edited_at && <span className="text-muted-foreground">(modifié)</span>}
                {c.actor_id === user?.id && (
                  <button
                    type="button"
                    onClick={async () => {
                      await deleteComment(c.id);
                      qc.invalidateQueries({ queryKey: ["pj_comments", issue.id] });
                    }}
                    className="ml-auto text-muted-foreground hover:text-red-600"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </p>
              <p className="whitespace-pre-wrap text-13">{c.comment_html}</p>
            </div>
          </div>
        );
      })}

      <CommentComposer project={project} onSubmit={submit} />
      {launchError && (
        <p className="text-11 text-red-600">
          Le commentaire est publié, mais un agent n&apos;a pas pu être lancé : {launchError}
        </p>
      )}
    </div>
  );
}

function Activity({ issue, members }: { issue: PjIssue; members: Member[] }) {
  const { data: activity } = useQuery({
    queryKey: ["pj_activity", issue.id],
    queryFn: () => fetchActivity(issue.id),
  });

  if (!activity?.length) return <p className="text-12 text-muted-foreground">Aucune activité.</p>;

  return (
    <ol className="space-y-2">
      {activity.map((a) => {
        const actor = members.find((m) => m.user_id === a.actor_id);
        return (
          <li key={a.id} className="flex items-start gap-2 text-12 text-muted-foreground">
            <MemberAvatar member={actor} size={18} />
            <span className="flex-1">
              <span className="font-medium text-foreground">{memberName(actor)}</span>{" "}
              {a.comment || describe(a.field, a.new_value)}
            </span>
            <span className="shrink-0">{formatDate(a.created_at)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Une phrase lisible à partir d'un champ modifié, faute de mieux. */
function describe(field: string | null, value: string | null): string {
  if (!field) return "a modifié le work item";
  const names: Record<string, string> = {
    name: "le titre", state_id: "l'état", priority: "la priorité",
    target_date: "l'échéance", start_date: "la date de début",
    description_text: "la description", archived_at: "l'archivage",
  };
  return `a modifié ${names[field] ?? field}${value ? ` → ${value}` : ""}`;
}
