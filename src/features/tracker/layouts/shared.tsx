import { type ReactNode } from "react";
import {
  CalendarBlankIcon, LinkIcon, PaperclipIcon, TreeStructureIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { DisplayProperties } from "../filters";
import type { IssueGroup } from "../filters";
import {
  AssigneePicker, AssigneeStack, DatePicker, IssueKey, LabelChip, LabelPicker,
  MemberAvatar, PriorityIcon, PriorityPicker, StateIcon, StatePicker, formatDate, isOverdue,
} from "../pickers";
import { PRIORITIES } from "../model";
import { AgentStack } from "../AgentPicker";
import type { TrackerAgent } from "../model";
import type {
  Member, PjCycle, PjIssue, PjIssueType, PjLabel, PjModule, PjProject, PjState, Priority,
} from "../model";

/**
 * Ce que chaque layout reçoit. Un seul contrat pour les cinq : c'est ce qui
 * permet de basculer de la liste au kanban sans que l'écran hôte ait à savoir
 * lequel il affiche.
 *
 * Les mutations remontent (`onPatch`) au lieu d'être faites sur place : le
 * board tient une seule copie des items, et un layout qui écrirait directement
 * en base laisserait les quatre autres avec des données périmées.
 */
export interface LayoutProps {
  project: PjProject;
  groups: IssueGroup[];
  issues: PjIssue[];
  states: PjState[];
  labels: PjLabel[];
  members: Member[];
  cycles: PjCycle[];
  modules: PjModule[];
  /** Les types du projet, pour la pastille de nature en tête de ligne. */
  issueTypes: PjIssueType[];
  /** Les agents du service, pour montrer ceux qui portent un item. */
  agents?: TrackerAgent[];
  /** Les items sur lesquels un agent travaille à cet instant. */
  workingIssueIds?: Set<string>;
  properties: DisplayProperties;
  /** null quand la vue n'est pas groupée. */
  groupBy: string | null;
  onOpen: (issue: PjIssue) => void;
  onPatch: (id: string, patch: Partial<PjIssue>) => void;
  onSetAssignees: (id: string, ids: string[]) => void;
  onSetLabels: (id: string, ids: string[]) => void;
  /** Déposer une carte dans un groupe : le layout dit où, l'hôte écrit. */
  onMove: (issueId: string, groupKey: string, beforeId: string | null, afterId: string | null) => void;
  onCreate: (groupKey: string) => void;
  /**
   * Création au fil de la liste : un titre, et c'est tout.
   *
   * C'est le geste le plus fréquent de l'outil, et le faire passer par une
   * modale à six champs suffit à ce que les gens notent leurs tâches ailleurs.
   * La fiche complète reste à un clic pour ceux qui veulent la remplir.
   */
  onQuickCreate: (groupKey: string, title: string) => Promise<void>;
  /** Sélection multiple. Vide = aucune case n'est visible ailleurs qu'au survol. */
  selected: Set<string>;
  onToggleSelect: (issueId: string, shiftKey: boolean) => void;
}

/** La puce d'état d'une ligne : icône + nom, comme dans Plane. */
export function StateChip({ state }: { state: PjState | undefined }) {
  if (!state) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/70 px-2 py-0.5 text-11">
      <StateIcon group={state.group} color={state.color} className="h-3 w-3" />
      {state.name}
    </span>
  );
}

/**
 * La puce de priorité. Le libellé accompagne toujours le pictogramme : les
 * barres de signal se ressemblent d'un cran à l'autre, et « High » vs
 * « Medium » ne doit pas se jouer au comptage de barres.
 */
export function PriorityChip({ priority }: { priority: Priority }) {
  const meta = PRIORITIES.find((p) => p.key === priority);
  const urgent = priority === "urgent";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-11",
        urgent ? "border-red-500/50 text-red-600" : "border-border/70",
      )}
    >
      <PriorityIcon priority={priority} className="h-3 w-3" />
      {meta?.label}
    </span>
  );
}

/** Le compteur d'un en-tête de groupe, présent dans les cinq layouts. */
export function GroupCount({ n }: { n: number }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-11 font-medium text-muted-foreground">
      {n}
    </span>
  );
}

export function GroupHeading({
  group, icon, trailing, className,
}: { group: IssueGroup; icon?: ReactNode; trailing?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {icon ?? (group.color
        ? <span className="h-2.5 w-2.5 rounded-full" style={{ background: group.color }} />
        : null)}
      <span className="text-13 font-medium">{group.label}</span>
      <GroupCount n={group.issues.length} />
      {trailing}
    </div>
  );
}

/**
 * Les petits compteurs d'une carte (sous-tâches, pièces jointes, liens). Ils ne
 * s'affichent QUE s'ils sont non nuls : un « 0 » répété sur chaque ligne est du
 * bruit qui fait perdre le titre.
 */
export function IssueMeta({ issue, properties }: { issue: PjIssue; properties: DisplayProperties }) {
  const bits: ReactNode[] = [];
  if (properties.sub_issue_count && issue.sub_issue_count > 0) {
    bits.push(
      <span key="sub" className="flex items-center gap-1">
        <TreeStructureIcon className="h-3.5 w-3.5" />{issue.sub_issue_count}
      </span>,
    );
  }
  if (properties.attachment_count && issue.attachment_count > 0) {
    bits.push(
      <span key="att" className="flex items-center gap-1">
        <PaperclipIcon className="h-3.5 w-3.5" />{issue.attachment_count}
      </span>,
    );
  }
  if (properties.link && issue.link_count > 0) {
    bits.push(
      <span key="link" className="flex items-center gap-1">
        <LinkIcon className="h-3.5 w-3.5" />{issue.link_count}
      </span>,
    );
  }
  if (!bits.length) return null;
  return <div className="flex items-center gap-2 text-11 text-muted-foreground">{bits}</div>;
}

export function LabelRow({ ids, labels, max = 3 }: { ids: string[]; labels: PjLabel[]; max?: number }) {
  if (!ids.length) return null;
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((id) => {
        const l = labels.find((x) => x.id === id);
        return l ? <LabelChip key={id} label={l} /> : null;
      })}
      {rest > 0 && <span className="text-11 text-muted-foreground">+{rest}</span>}
    </div>
  );
}

/**
 * Les labels d'une ligne, à la façon de Plane : le nom quand il y en a UN,
 * « 3 labels » au-delà.
 *
 * Le repli n'est pas qu'une économie de place. Trois pastilles colorées côte à
 * côte sur chaque ligne d'une liste de cent créent un bruit visuel qui fait
 * perdre les titres ; un compteur neutre se lit sans se disputer l'attention,
 * et le détail reste à un clic dans la fiche.
 */
export function LabelSummary({ ids, labels }: { ids: string[]; labels: PjLabel[] }) {
  if (!ids.length) return null;
  if (ids.length === 1) {
    const l = labels.find((x) => x.id === ids[0]);
    if (!l) return null;
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/70 px-2 py-0.5 text-11">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: l.color }} />
        {l.name}
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-md border border-border/70 px-2 py-0.5 text-11 text-muted-foreground">
      {ids.length} labels
    </span>
  );
}

/** La pastille d'échéance : bordure + icône, comme dans Plane. Rouge seulement
 *  quand la date est dépassée — le seul cas qui demande une action. */
export function DateChip({ value, overdue }: { value: string | null; overdue?: boolean }) {
  if (!value) return null;
  return (
    <span className={cn(
      "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-11",
      overdue ? "border-red-500/50 text-red-600" : "border-border/70 text-muted-foreground",
    )}>
      <CalendarBlankIcon className="h-3 w-3" />
      {formatDate(value)}
    </span>
  );
}

/**
 * L'icône de type d'un work item (tâche, bug, amélioration, epic).
 *
 * C'est la première colonne de chaque ligne chez Plane, et elle porte une
 * information que ni l'état ni les labels ne donnent : la NATURE de la chose.
 * Faute de type renseigné, on ne met rien plutôt qu'un marqueur générique qui
 * ferait croire à un type par défaut.
 */
export function TypeIcon({ type }: { type: PjIssueType | undefined }) {
  if (!type) return <span className="h-4 w-4 shrink-0" />;
  return (
    <span
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-9 font-bold text-white"
      style={{ background: type.color }}
      title={type.name}
    >
      {type.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * La bande de contrôles d'un item, partagée par la ligne de liste et la carte
 * de kanban. Chaque contrôle écrit immédiatement — on modifie un board en
 * cliquant dedans, pas en ouvrant une fiche.
 */
export function IssueControls({
  issue, states, labels, members, properties, onPatch, onSetAssignees, onSetLabels, compact,
}: {
  issue: PjIssue; states: PjState[]; labels: PjLabel[]; members: Member[];
  properties: DisplayProperties;
  onPatch: (id: string, patch: Partial<PjIssue>) => void;
  onSetAssignees: (id: string, ids: string[]) => void;
  onSetLabels: (id: string, ids: string[]) => void;
  compact?: boolean;
}) {
  return (
    // stopPropagation : cliquer un sélecteur ne doit pas aussi ouvrir l'item.
    <div className="flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {properties.priority && (
        <PriorityPicker
          value={issue.priority}
          onChange={(p: Priority) => onPatch(issue.id, { priority: p })}
          compact={compact}
        />
      )}
      {properties.state && (
        <StatePicker
          states={states} value={issue.state_id}
          onChange={(id) => onPatch(issue.id, { state_id: id })}
          compact={compact}
        />
      )}
      {properties.due_date && (
        <DatePicker
          value={issue.target_date}
          onChange={(v) => onPatch(issue.id, { target_date: v })}
          placeholder="Échéance" compact={compact} min={issue.start_date}
        />
      )}
      {properties.start_date && (
        <DatePicker
          value={issue.start_date}
          onChange={(v) => onPatch(issue.id, { start_date: v })}
          placeholder="Début" compact={compact}
        />
      )}
      {properties.labels && (
        <LabelPicker
          labels={labels} value={issue.label_ids}
          onChange={(ids) => onSetLabels(issue.id, ids)} compact={compact}
        />
      )}
      {properties.assignee && (
        <AssigneePicker
          members={members} value={issue.assignee_ids}
          onChange={(ids) => onSetAssignees(issue.id, ids)} compact={compact}
        />
      )}
    </div>
  );
}

// Réexports fins : les layouts n'importent que `shared`, ce qui garde une seule
// porte d'entrée quand un contrôle change de forme.
export { AssigneeStack, IssueKey, MemberAvatar, PriorityIcon, StateIcon, isOverdue };

/**
 * Les agents d'un item, et le signe qu'ils y travaillent.
 *
 * Deux informations, et la seconde est celle qui manquait le plus : sur un
 * board, rien ne distinguait un item qu'une machine est en train de faire d'un
 * item que personne n'a touché. On relançait donc à la main des tâches déjà en
 * cours, ou l'on attendait sur des tâches que personne ne faisait.
 *
 * Le point PULSE pendant le travail, et c'est le seul élément animé de la
 * ligne : un mouvement dans une liste immobile attire l'œil exactement là où il
 * faut, alors qu'une couleur de plus se perdrait parmi les pastilles d'état et
 * de priorité.
 */
export function AgentWorkChip({
  issue, agents, working,
}: { issue: PjIssue; agents?: TrackerAgent[]; working: boolean }) {
  const ids = issue.agent_ids ?? [];
  if (!ids.length) return null;
  return (
    <span
      className="relative flex shrink-0 items-center"
      title={working ? "Un agent travaille sur cet item en ce moment" : "Confié à un agent"}
    >
      <AgentStack ids={ids} agents={agents ?? []} max={2} />
      {working && (
        <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
        </span>
      )}
    </span>
  );
}
