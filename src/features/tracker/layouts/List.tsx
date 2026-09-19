import { useMemo, useState } from "react";
import { CaretDownIcon, CaretRightIcon, DotsThreeIcon, PlusIcon, UserIcon } from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  AgentWorkChip, AssigneeStack, DateChip, GroupCount, IssueKey, IssueMeta, LabelSummary,
  PriorityChip, StateChip, StateIcon, TypeIcon, isOverdue, type LayoutProps,
} from "./shared";
import type { PjIssue } from "../model";
import { CheckMark } from "../ui";

/**
 * La liste : des sections empilées, une par groupe, chacune repliable.
 *
 * L'agencement d'une ligne reprend celui de Plane, et l'ordre n'est pas
 * arbitraire — il va du plus stable au plus volatil, de gauche à droite : la
 * nature de la chose, sa référence, son titre, puis ses labels, son échéance,
 * son état, sa priorité, qui la porte. On lit les trois premières colonnes en
 * balayant, et on ne s'arrête à droite que sur la ligne qui nous intéresse.
 *
 * Les métadonnées sont TOUJOURS visibles, jamais révélées au survol : une
 * échéance qu'il faut aller chercher avec la souris n'est pas une information,
 * c'est une devinette.
 */
export function ListLayout(props: LayoutProps) {
  const {
    groups, states, labels, members, issueTypes, properties,
    onOpen, onCreate, onQuickCreate, onPatch, onSetAssignees,
    selected, onToggleSelect, agents, workingIssueIds,
  } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col">
      {groups.map((group) => {
        const isOpen = !collapsed.has(group.key);
        const state = states.find((s) => s.id === group.key);
        const tree = nestChildren(group.issues);

        return (
          <section key={group.key}>
            <header className="sticky top-0 z-[1] flex items-center justify-between bg-muted/50 px-4 py-1.5 backdrop-blur">
              <button type="button" onClick={() => toggle(group.key)} className="flex items-center gap-2 text-left">
                {isOpen ? <CaretDownIcon className="h-3 w-3" /> : <CaretRightIcon className="h-3 w-3" />}
                {state
                  ? <StateIcon group={state.group} color={state.color} />
                  : group.color
                    ? <span className="h-2.5 w-2.5 rounded-full" style={{ background: group.color }} />
                    : null}
                <span className="text-13 font-medium">{group.label}</span>
                <GroupCount n={group.issues.length} />
              </button>
              <button
                type="button"
                onClick={() => onCreate(group.key)}
                className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                title="Nouveau work item"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
            </header>

            {isOpen && (
              <div>
                {tree.map((node) => (
                  <ListBranch
                    key={`${group.key}-${node.issue.id}`}
                    node={node} depth={0}
                    identifier={props.project.identifier}
                    states={states} labels={labels} members={members} issueTypes={issueTypes}
                    properties={properties}
                    onOpen={onOpen} onPatch={onPatch} onSetAssignees={onSetAssignees}
                    selected={selected} onToggleSelect={onToggleSelect}
                    agents={agents} workingIssueIds={workingIssueIds}
                  />
                ))}
                <QuickCreateRow
                  groupKey={group.key}
                  onSubmit={(title) => onQuickCreate(group.key, title)}
                />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * La ligne « + New work item » en pied de groupe.
 *
 * Elle se transforme en champ au clic et RESTE ouverte après validation : on
 * saisit rarement une seule tâche, et refermer le champ à chaque entrée oblige
 * à recliquer entre chaque, ce qui casse la saisie en rafale.
 */
function QuickCreateRow({
  groupKey, onSubmit,
}: { groupKey: string; onSubmit: (title: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSubmit(value);
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
        className="flex w-full items-center gap-2 border-b border-border/40 px-4 py-2 text-left text-13 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      >
        <PlusIcon className="h-4 w-4" /> New work item
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 border-b border-border/40 px-4 py-1.5">
      <PlusIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <input
        autoFocus
        value={title}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          // Échap ne ferme que si le champ est vide : sinon on perdrait une
          // saisie en cours sur une touche pressée par réflexe.
          if (e.key === "Escape") { if (title) setTitle(""); else setEditing(false); }
        }}
        onBlur={() => { if (!title.trim()) setEditing(false); }}
        placeholder={`Titre du work item (${groupKey === "__none__" ? "sans état" : "Entrée pour créer"})`}
        className="flex-1 bg-transparent py-1 text-13 outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

interface Node { issue: PjIssue; children: Node[] }

/**
 * Range les sous-tâches sous leur parent QUAND il est présent dans le même
 * groupe. Une sous-tâche dont le parent est ailleurs (autre état, filtré)
 * reste à la racine : la masquer parce que son parent ne passe pas le filtre
 * ferait disparaître du travail réel de la liste.
 */
function nestChildren(issues: PjIssue[]): Node[] {
  const present = new Set(issues.map((i) => i.id));
  const nodes = new Map<string, Node>(issues.map((i) => [i.id, { issue: i, children: [] }]));
  const roots: Node[] = [];

  for (const issue of issues) {
    const node = nodes.get(issue.id)!;
    if (issue.parent_id && present.has(issue.parent_id)) {
      nodes.get(issue.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

type RowDeps = Pick<LayoutProps,
  "states" | "labels" | "members" | "issueTypes" | "properties" | "onOpen" | "onPatch"
  | "onSetAssignees" | "selected" | "onToggleSelect" | "agents" | "workingIssueIds">;

function ListBranch({
  node, depth, identifier, ...deps
}: { node: Node; depth: number; identifier: string } & RowDeps) {
  return (
    <>
      <ListRow issue={node.issue} depth={depth} identifier={identifier} {...deps} />
      {node.children.map((child) => (
        <ListBranch key={child.issue.id} node={child} depth={depth + 1} identifier={identifier} {...deps} />
      ))}
    </>
  );
}

function ListRow({
  issue, depth, identifier, states, labels, members, issueTypes, properties,
  onOpen, onPatch, onSetAssignees, selected, onToggleSelect, agents, workingIssueIds,
}: { issue: PjIssue; depth: number; identifier: string } & RowDeps) {
  const type = useMemo(
    () => issueTypes.find((t) => t.id === issue.type_id),
    [issueTypes, issue.type_id],
  );
  const state = states.find((s) => s.id === issue.state_id);
  const overdue = isOverdue(issue.target_date, issue.completed_at);
  const isSelected = selected.has(issue.id);
  // La case n'apparaît qu'au survol tant que rien n'est coché : une colonne de
  // cases vides sur chaque ligne alourdit une liste qu'on ne fait que lire.
  const showCheckbox = isSelected || selected.size > 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(issue)}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(issue); }}
      className={cn(
        "group flex cursor-pointer items-center gap-3 border-b border-border/40 py-2 pr-3 text-14 hover:bg-muted/40",
        isSelected && "bg-primary/5",
      )}
      // Le retrait porte la hiérarchie. Il est appliqué en padding plutôt qu'en
      // marge pour que la zone cliquable reste pleine largeur : une ligne dont
      // le début n'est pas cliquable donne l'impression d'un clic raté.
      style={{ paddingLeft: 16 + depth * 28 }}
    >
      <span
        onClick={(e) => { e.stopPropagation(); onToggleSelect(issue.id, e.shiftKey); }}
        className={cn(
          "shrink-0 transition-opacity",
          showCheckbox ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <CheckMark checked={isSelected} />
      </span>

      <TypeIcon type={type} />
      {properties.key && <IssueKey identifier={identifier} sequenceId={issue.sequence_id} />}

      <span className={cn("min-w-0 flex-1 truncate", issue.completed_at && "text-muted-foreground")}>
        {issue.name}
      </span>

      <IssueMeta issue={issue} properties={properties} />
      {properties.labels && <LabelSummary ids={issue.label_ids} labels={labels} />}
      {properties.due_date && <DateChip value={issue.target_date} overdue={overdue} />}
      {properties.state && <StateChip state={state} />}
      {properties.priority && <PriorityChip priority={issue.priority} />}

      <AgentWorkChip issue={issue} agents={agents} working={!!workingIssueIds?.has(issue.id)} />

      {properties.assignee && (
        <span className="flex w-6 shrink-0 justify-center" onClick={(e) => e.stopPropagation()}>
          {issue.assignee_ids.length
            ? <AssigneeStack ids={issue.assignee_ids} members={members} max={2} />
            : <UserIcon className="h-4 w-4 text-muted-foreground" />}
        </span>
      )}

      <div onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <DotsThreeIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onOpen(issue)}>Ouvrir</DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onSetAssignees(issue.id, issue.assignee_ids)}
            >
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
  );
}
