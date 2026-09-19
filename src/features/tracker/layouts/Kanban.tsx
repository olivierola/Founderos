import { useRef, useState } from "react";
import { DotsThreeIcon, PlusIcon, UserIcon } from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  AgentWorkChip, AssigneeStack, DateChip, GroupCount, IssueKey, IssueMeta, LabelSummary,
  PriorityChip, StateIcon, TypeIcon, isOverdue, type LayoutProps,
} from "./shared";
import type { PjIssue } from "../model";
import { CheckMark } from "../ui";

/**
 * Le kanban : une colonne par groupe, des cartes qu'on déplace.
 *
 * Une carte tient en trois étages, dans cet ordre : sa référence, son titre,
 * ses propriétés. C'est l'ordre de lecture d'une carte qu'on survole en
 * cherchant quelque chose — on identifie, on lit, et on ne descend au troisième
 * étage que sur celle qui nous intéresse.
 *
 * Le menu d'actions n'apparaît qu'au survol de la carte. Sur une colonne de
 * vingt cartes, vingt boutons « … » permanents créent une colonne de bruit qui
 * concurrence les titres.
 */
export function KanbanLayout(props: LayoutProps) {
  const {
    groups, states, labels, members, issueTypes, properties, project,
    onOpen, onCreate, onQuickCreate, onMove, onPatch, onSetAssignees,
    selected, onToggleSelect, agents, workingIssueIds,
  } = props;

  const dragged = useRef<PjIssue | null>(null);
  const [overGroup, setOverGroup] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const endDrag = () => {
    dragged.current = null;
    setOverGroup(null);
    setDropIndex(null);
  };

  return (
    <div className="flex h-full gap-3 overflow-x-auto px-4 pb-4">
      {groups.map((group) => {
        const state = states.find((s) => s.id === group.key);
        const isOver = overGroup === group.key;

        return (
          <section
            key={group.key}
            className="flex h-full w-[320px] shrink-0 flex-col"
            onDragOver={(e) => {
              e.preventDefault();
              setOverGroup(group.key);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const issue = dragged.current;
              if (!issue) return;
              const index = dropIndex ?? group.issues.length;
              const before = group.issues[index - 1]?.id ?? null;
              const after = group.issues[index]?.id ?? null;
              onMove(issue.id, group.key, before, after);
              endDrag();
            }}
          >
            <header className="flex items-center gap-2 px-1 pb-2">
              {state
                ? <StateIcon group={state.group} color={state.color} />
                : group.color
                  ? <span className="h-2.5 w-2.5 rounded-full" style={{ background: group.color }} />
                  : null}
              <span className="min-w-0 flex-1 truncate text-13 font-medium">{group.label}</span>
              <GroupCount n={group.issues.length} />
              <button
                type="button"
                onClick={() => onCreate(group.key)}
                title="Nouveau work item"
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
            </header>

            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-2 transition-colors",
                // La colonne survolée s'éclaire pendant un glisser : c'est le
                // seul retour qui dit où la carte va atterrir.
                isOver ? "bg-muted/60" : "bg-muted/25",
              )}
            >
              {group.issues.map((issue, index) => (
                <KanbanCard
                  key={issue.id}
                  issue={issue}
                  identifier={project.identifier}
                  states={states}
                  labels={labels}
                  members={members}
                  issueTypes={issueTypes}
                  properties={properties}
                  selected={selected.has(issue.id)}
                  anySelected={selected.size > 0}
                  onToggleSelect={onToggleSelect}
                  onOpen={onOpen}
                  onPatch={onPatch}
                  onSetAssignees={onSetAssignees}
                  agents={agents}
                  workingIssueIds={workingIssueIds}
                  onDragStart={() => { dragged.current = issue; }}
                  onDragEnd={endDrag}
                  onDragOver={() => setDropIndex(index)}
                />
              ))}

              {!group.issues.length && (
                <p className="px-1 py-6 text-center text-11 text-muted-foreground">
                  Aucun work item.
                </p>
              )}

              {/* Le lien de création reste collé en bas de colonne : après avoir
                  fait défiler vingt cartes, remonter en haut pour en ajouter une
                  casse le geste. */}
              <QuickCreate groupKey={group.key} onSubmit={onQuickCreate} />
            </div>
          </section>
        );
      })}
    </div>
  );
}

type CardDeps = Pick<LayoutProps,
  "states" | "labels" | "members" | "issueTypes" | "properties" | "onOpen" | "onPatch" | "onSetAssignees"
  | "agents" | "workingIssueIds">;

function KanbanCard({
  issue, identifier, selected, anySelected, onToggleSelect,
  onDragStart, onDragEnd, onDragOver,
  states, labels, members, issueTypes, properties, onOpen, onPatch, onSetAssignees,
  agents, workingIssueIds,
}: {
  issue: PjIssue;
  identifier: string;
  selected: boolean;
  anySelected: boolean;
  onToggleSelect: (id: string, shiftKey: boolean) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
} & CardDeps) {
  const type = issueTypes.find((t) => t.id === issue.type_id);
  const state = states.find((s) => s.id === issue.state_id);
  const overdue = isOverdue(issue.target_date, issue.completed_at);

  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onClick={() => onOpen(issue)}
      className={cn(
        "group/card cursor-pointer rounded-lg border bg-card p-2.5 shadow-raised-100 transition-colors",
        selected ? "border-primary/60 bg-primary/5" : "border-border/70 hover:border-border",
      )}
    >
      {/* Étage 1 — identifier, et le menu qui se révèle au survol. */}
      <div className="relative flex items-center gap-2">
        <span
          onClick={(e) => { e.stopPropagation(); onToggleSelect(issue.id, e.shiftKey); }}
          className={cn(
            "transition-opacity",
            selected || anySelected ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
          )}
        >
          <CheckMark checked={selected} />
        </span>

        <TypeIcon type={type} />
        {properties.key && <IssueKey identifier={identifier} sequenceId={issue.sequence_id} />}

        <div className="flex-1" />

        <div
          onClick={(e) => e.stopPropagation()}
          className="opacity-0 transition-opacity group-hover/card:opacity-100 data-[open=true]:opacity-100"
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted">
                <DotsThreeIcon className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onOpen(issue)}>Ouvrir</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSetAssignees(issue.id, issue.assignee_ids)}>
                Assigner…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onPatch(issue.id, { archived_at: new Date().toISOString() })}
              >
                Archiver
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => navigator.clipboard?.writeText(`${identifier}-${issue.sequence_id}`)}
              >
                Copier la référence
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Étage 2 — le titre, sur deux lignes au plus. Tronquer à une seule
          rendrait indistinguables des titres qui commencent pareil. */}
      <p className={cn(
        "line-clamp-2 pt-1.5 text-13",
        issue.completed_at && "text-muted-foreground",
      )}>
        {issue.name}
      </p>

      {/* Étage 3 — les propriétés, en rangée qui passe à la ligne. */}
      <div className="flex flex-wrap items-center gap-1.5 pt-2">
        <AgentWorkChip issue={issue} agents={agents} working={!!workingIssueIds?.has(issue.id)} />
        {properties.assignee && (
          issue.assignee_ids.length
            ? <AssigneeStack ids={issue.assignee_ids} members={members} max={2} />
            : <UserIcon className="h-4 w-4 text-muted-foreground" />
        )}
        {properties.labels && <LabelSummary ids={issue.label_ids} labels={labels} />}
        {properties.due_date && <DateChip value={issue.target_date} overdue={overdue} />}
        {properties.priority && <PriorityChip priority={issue.priority} />}
        <IssueMeta issue={issue} properties={properties} />
        {properties.state && state && (
          <span className="ml-auto">
            <StateIcon group={state.group} color={state.color} />
          </span>
        )}
      </div>
    </article>
  );
}

/** La création en pied de colonne : un lien qui devient champ, et qui reste
 *  ouvert après validation pour enchaîner plusieurs cartes. */
function QuickCreate({
  groupKey, onSubmit,
}: { groupKey: string; onSubmit: (groupKey: string, title: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSubmit(groupKey, value);
      setTitle("");
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="sticky bottom-0 flex w-full items-center gap-1.5 rounded-md bg-muted/60 px-2 py-2 text-12 font-medium text-primary backdrop-blur hover:underline"
      >
        <PlusIcon className="h-3.5 w-3.5" /> Nouveau work item
      </button>
    );
  }

  return (
    <div className="sticky bottom-0 rounded-lg border border-border bg-card p-2 shadow-raised-200">
      <input
        autoFocus
        value={title}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") { if (title) setTitle(""); else setEditing(false); }
        }}
        onBlur={() => { if (!title.trim()) setEditing(false); }}
        placeholder="Titre du work item"
        className="w-full bg-transparent text-13 outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
