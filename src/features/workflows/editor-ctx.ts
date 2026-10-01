import type { Node } from "reactflow";
import type { Graph } from "./outline";
import type { WorkflowKind } from "./model";

// Ce que tout l'éditeur partage : le graphe, la façon d'écrire dedans, et de
// quoi remplir un sélecteur.
//
// Déclaré à part depuis qu'il y a DEUX vues sur le même workflow — le document
// et le graphe. Elles n'affichent pas la même chose, mais elles écrivent dans
// le même modèle, par la même fonction `apply` ; un second contexte pour la
// seconde vue aurait été un second modèle en germe.

export interface Ctx {
  graph: Graph;
  /**
   * Toute modification passe par une mise à jour FONCTIONNELLE.
   *
   * Poser une pastille dans une phrase crée un bloc PUIS écrit le texte qui le
   * mentionne, dans le même geste. Avec un `setGraph(objet)`, la seconde
   * écriture repartirait du graphe capturé avant la première et supprimerait le
   * bloc qu'on vient de créer.
   */
  apply: (fn: (g: Graph) => Graph) => void;
  agents: Array<{ id: string; name: string }>;
  collections: Array<{ id: string; name: string }>;
  agentName: Map<string, string>;
  workflowId: string;
  workspaceId: string | null;
  projectId: string | null;
  openBlock: string | null;
  setOpenBlock: (id: string | null) => void;
  /** Les intertitres — les seules cibles d'un « aller à ». */
  sections: Node[];
  /** Procédure ou automatisation. Décide des blocs offerts, de la façon dont une
   *  condition s'écrit, et de qui exécutera au déclenchement. */
  kind: WorkflowKind;
  /** Les variables que le workflow sait résoudre — déclarées dans un bloc
   *  « Variables », ou rangées par un bloc qui nomme sa sortie. Calculées une
   *  fois ici : chaque endroit qui les recalculait aurait fini par en connaître
   *  un jeu différent. */
  vars: string[];
}
