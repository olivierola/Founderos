import type { Member, PjCycle, PjIssue, PjLabel, PjModule, PjProject, PjState } from "./model";
import { PRIORITIES } from "./model";
import { memberName } from "./pickers";

/**
 * L'export CSV d'un board.
 *
 * Il exporte ce qui est AFFICHÉ — filtres et tri compris — et non tout le
 * projet. C'est la seule règle qui rende l'export prévisible : on filtre, on
 * regarde, on exporte ce qu'on regarde. Un export qui ignore les filtres oblige
 * à refaire le tri dans le tableur, ce qui est exactement le travail qu'on
 * venait d'éviter.
 *
 * Les identifiants sont résolus en NOMS. Un CSV plein d'UUID est illisible pour
 * la personne à qui on l'envoie, qui est précisément la raison d'exporter.
 */

const COLUMNS = [
  "Référence", "Titre", "État", "Priorité", "Assignés", "Labels",
  "Cycle", "Modules", "Début", "Échéance", "Terminé le", "Créé le",
] as const;

/**
 * Échappe une cellule pour le CSV. Guillemets doublés et champ encadré dès
 * qu'il contient un séparateur, un guillemet ou un saut de ligne — sans quoi un
 * titre contenant une virgule décale toute la ligne.
 */
function cell(value: string | null | undefined): string {
  const text = (value ?? "").replace(/\r?\n/g, " ").trim();
  return /[",;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function isoDate(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

export function issuesToCsv(input: {
  issues: PjIssue[];
  project: PjProject;
  states: PjState[];
  labels: PjLabel[];
  members: Member[];
  cycles: PjCycle[];
  modules: PjModule[];
}): string {
  const { issues, project, states, labels, members, cycles, modules } = input;

  const rows = issues.map((issue) => [
    `${project.identifier}-${issue.sequence_id}`,
    issue.name,
    states.find((s) => s.id === issue.state_id)?.name ?? "",
    PRIORITIES.find((p) => p.key === issue.priority)?.label ?? issue.priority,
    issue.assignee_ids
      .map((id) => memberName(members.find((m) => m.user_id === id)))
      .join(" · "),
    issue.label_ids
      .map((id) => labels.find((l) => l.id === id)?.name ?? "")
      .filter(Boolean)
      .join(" · "),
    cycles.find((c) => c.id === issue.cycle_id)?.name ?? "",
    issue.module_ids
      .map((id) => modules.find((m) => m.id === id)?.name ?? "")
      .filter(Boolean)
      .join(" · "),
    isoDate(issue.start_date),
    isoDate(issue.target_date),
    isoDate(issue.completed_at),
    isoDate(issue.created_at),
  ]);

  // Le point-virgule plutôt que la virgule : Excel en locale française lit un
  // CSV à virgules comme une seule colonne, et c'est le tableur qui ouvrira ce
  // fichier neuf fois sur dix.
  return [COLUMNS, ...rows].map((row) => row.map(cell).join(";")).join("\r\n");
}

/**
 * Déclenche le téléchargement. Le BOM UTF-8 en tête n'est pas superflu : sans
 * lui, Excel lit le fichier en ANSI et rend « Échéance » en « Ã‰chÃ©ance ».
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Libéré au tour suivant : révoquer immédiatement annulerait le
  // téléchargement dans certains navigateurs.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
