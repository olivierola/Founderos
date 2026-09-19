import { IssueKey, StateIcon, type LayoutProps } from "./shared";
import {
  AssigneePicker, DatePicker, LabelPicker, PriorityPicker, StatePicker,
  CyclePicker, ModulePicker, formatDate,
} from "../pickers";
import type { DisplayProperties } from "../filters";
import type { PjIssue } from "../model";

/**
 * Le tableur : une ligne par item, une colonne par propriété affichée.
 *
 * C'est le layout de la saisie en série — remplir les échéances de trente items
 * à la suite. Il ignore donc le groupement (les colonnes ont un sens global) et
 * garde la première colonne figée : perdre le titre de la ligne en faisant
 * défiler vers la droite rendrait l'édition aveugle.
 */

type Column = {
  key: keyof DisplayProperties;
  label: string;
  width: number;
};

const COLUMNS: Column[] = [
  { key: "state", label: "État", width: 150 },
  { key: "priority", label: "Priorité", width: 130 },
  { key: "assignee", label: "Assignés", width: 160 },
  { key: "labels", label: "Labels", width: 180 },
  { key: "start_date", label: "Début", width: 120 },
  { key: "due_date", label: "Échéance", width: 120 },
  { key: "cycle", label: "Cycle", width: 150 },
  { key: "modules", label: "Modules", width: 150 },
  { key: "sub_issue_count", label: "Sous-tâches", width: 110 },
  { key: "attachment_count", label: "Pièces jointes", width: 120 },
  { key: "created_on", label: "Créé le", width: 120 },
  { key: "updated_on", label: "Modifié le", width: 120 },
];

export function SpreadsheetLayout(props: LayoutProps) {
  const {
    groups, states, labels, members, cycles, modules, properties, project,
    onOpen, onPatch, onSetAssignees, onSetLabels,
  } = props;

  // Le tableur aplatit les groupes : une même ligne ne doit pas apparaître deux
  // fois parce qu'elle porte deux labels.
  const seen = new Set<string>();
  const rows: PjIssue[] = [];
  for (const g of groups) {
    for (const i of g.issues) {
      if (!seen.has(i.id)) { seen.add(i.id); rows.push(i); }
    }
  }

  const columns = COLUMNS.filter((c) => properties[c.key]);

  return (
    <div className="h-full overflow-auto">
      <table className="w-max min-w-full border-separate border-spacing-0 text-14">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 w-[420px] border-b border-r border-border bg-background px-3 py-2 text-left text-12 font-medium text-muted-foreground">
              Work item
            </th>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width, minWidth: c.width }}
                className="sticky top-0 z-10 border-b border-r border-border/60 bg-background px-3 py-2 text-left text-12 font-medium text-muted-foreground"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((issue) => {
            const state = states.find((s) => s.id === issue.state_id);
            return (
              <tr key={issue.id} className="group">
                <td
                  className="sticky left-0 z-10 border-b border-r border-border bg-background px-3 py-1.5 group-hover:bg-muted/50"
                >
                  <button
                    type="button"
                    onClick={() => onOpen(issue)}
                    className="flex w-full items-center gap-2 text-left"
                  >
                    {state && <StateIcon group={state.group} color={state.color} />}
                    {properties.key && <IssueKey identifier={project.identifier} sequenceId={issue.sequence_id} />}
                    <span className="truncate">{issue.name}</span>
                  </button>
                </td>

                {columns.map((c) => (
                  <td
                    key={c.key}
                    className="border-b border-r border-border/60 px-2 py-1 group-hover:bg-muted/30"
                  >
                    <Cell
                      column={c.key}
                      issue={issue}
                      states={states} labels={labels} members={members}
                      cycles={cycles} modules={modules}
                      onPatch={onPatch}
                      onSetAssignees={onSetAssignees}
                      onSetLabels={onSetLabels}
                      onSetCycle={(id) => onPatch(issue.id, { cycle_id: id } as Partial<PjIssue>)}
                      onSetModules={(ids) => onPatch(issue.id, { module_ids: ids } as Partial<PjIssue>)}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colSpan={columns.length + 1} className="px-4 py-8 text-center text-14 text-muted-foreground">
                Aucun work item.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Cell({
  column, issue, states, labels, members, cycles, modules,
  onPatch, onSetAssignees, onSetLabels, onSetCycle, onSetModules,
}: {
  column: keyof DisplayProperties;
  issue: PjIssue;
  onSetCycle: (id: string | null) => void;
  onSetModules: (ids: string[]) => void;
} & Pick<LayoutProps, "states" | "labels" | "members" | "cycles" | "modules" | "onPatch" | "onSetAssignees" | "onSetLabels">) {
  switch (column) {
    case "state":
      return <StatePicker states={states} value={issue.state_id} onChange={(id) => onPatch(issue.id, { state_id: id })} />;
    case "priority":
      return <PriorityPicker value={issue.priority} onChange={(p) => onPatch(issue.id, { priority: p })} />;
    case "assignee":
      return <AssigneePicker members={members} value={issue.assignee_ids} onChange={(ids) => onSetAssignees(issue.id, ids)} />;
    case "labels":
      return <LabelPicker labels={labels} value={issue.label_ids} onChange={(ids) => onSetLabels(issue.id, ids)} />;
    case "start_date":
      return <DatePicker value={issue.start_date} onChange={(v) => onPatch(issue.id, { start_date: v })} placeholder="Début" />;
    case "due_date":
      return (
        <DatePicker
          value={issue.target_date}
          onChange={(v) => onPatch(issue.id, { target_date: v })}
          placeholder="Échéance"
          min={issue.start_date}
        />
      );
    case "cycle":
      return <CyclePicker cycles={cycles} value={issue.cycle_id} onChange={onSetCycle} />;
    case "modules":
      return <ModulePicker modules={modules} value={issue.module_ids} onChange={onSetModules} />;
    // Les compteurs et les horodatages sont en lecture seule : ils sont dérivés,
    // les rendre éditables serait mentir sur ce qu'ils décrivent.
    case "sub_issue_count":
      return <ReadOnly value={issue.sub_issue_count || "—"} />;
    case "attachment_count":
      return <ReadOnly value={issue.attachment_count || "—"} />;
    case "created_on":
      return <ReadOnly value={formatDate(issue.created_at)} />;
    case "updated_on":
      return <ReadOnly value={formatDate(issue.updated_at)} />;
    default:
      return null;
  }
}

function ReadOnly({ value }: { value: string | number }) {
  return <span className="px-1 text-12 text-muted-foreground">{value}</span>;
}
