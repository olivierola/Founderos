import type { BlockKind } from "./context";

// Les FAMILLES de blocs, telles qu'un menu les présente.
//
// Une liste plate de douze entrées oblige à tout lire pour trouver la bonne :
// l'œil ne sait pas où « Pause » se range par rapport à « Passation ». Groupés
// par ce qu'ils font — agir, trancher, confier, cadrer — les blocs se trouvent
// par élimination : on sait dans quelle famille chercher avant de lire un nom.
//
// Le regroupement est de la PRÉSENTATION, pas du langage : le rôle d'un bloc
// (action, cadrage, qualificatif) reste défini dans workflow-doc.ts. Un même
// bloc peut changer de famille selon l'écran — un outil est une action dans une
// automatisation, un cadrage qu'on accroche dans une procédure.

export type BlockGroupId = "act" | "logic" | "people" | "structure" | "attach" | "frame";

export interface BlockGroup {
  id: BlockGroupId;
  label: string;
  /** Une demi-phrase sous le titre du groupe, pour les familles dont le nom ne
   *  suffit pas à dire comment elles se branchent. */
  hint?: string;
  kinds: BlockKind[];
}

const GROUPS: Omit<BlockGroup, "kinds">[] = [
  { id: "act", label: "Agir" },
  { id: "logic", label: "Logique" },
  { id: "people", label: "Agents et humains" },
  { id: "structure", label: "Structure" },
  { id: "attach", label: "À accrocher", hint: "Vaut pour l'étape à laquelle on le relie" },
  { id: "frame", label: "Cadre", hint: "Vaut pour tout le workflow" },
];

/** L'ordre DANS un groupe : du plus courant au plus rare. */
const ORDER: BlockKind[] = [
  "step", "tool", "set", "wait",
  "decision", "judge", "loop",
  "handoff", "approval",
  "section", "stop",
  "context", "rule", "deliverable", "memory", "resource",
  "goal", "input", "variables", "example", "note",
];

function groupOf(kind: BlockKind, attachable: ReadonlySet<BlockKind>): BlockGroupId {
  if (attachable.has(kind)) return "attach";
  switch (kind) {
    case "decision": case "judge": case "loop": return "logic";
    case "handoff": case "approval": return "people";
    case "section": case "stop": return "structure";
    case "goal": case "input": case "variables": case "example": case "note": return "frame";
    case "context": case "rule": case "deliverable": case "memory": case "resource": return "attach";
    default: return "act";
  }
}

/** Range `kinds` en familles non vides, dans l'ordre de lecture du menu.
 *  `attachable` dit quels blocs, sur CET écran, s'accrochent à une étape
 *  plutôt que de s'enchaîner. */
export function groupKinds(kinds: BlockKind[], attachable: Iterable<BlockKind> = []): BlockGroup[] {
  const att = new Set(attachable);
  const unique = [...new Set(kinds)];
  const rank = (k: BlockKind) => { const i = ORDER.indexOf(k); return i < 0 ? ORDER.length : i; };
  return GROUPS
    .map((g) => ({
      ...g,
      kinds: unique.filter((k) => groupOf(k, att) === g.id).sort((a, b) => rank(a) - rank(b)),
    }))
    .filter((g) => g.kinds.length > 0);
}

/** Comparaison sans accents ni casse : « etape » doit trouver « Étape ». */
export const foldText = (v: string) =>
  v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
