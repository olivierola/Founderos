import {
  ATTACH_HANDLE, APPLIES_HANDLE, roleOf, attachmentsByTarget, targetsOfQualifier,
  isAttachEdge, flowEdges, attachEdges, isAttached,
} from "../../../supabase/functions/_shared/workflow-doc";
import type { BlockRole } from "../../../supabase/functions/_shared/workflow-doc";

// Deux relations, et tout le modèle tient dans la distinction.
//
//   FLOW        d'une action à la suivante. L'ordre d'exécution — dans le
//               document, c'est simplement « la ligne d'après ».
//   ATTACHEMENT d'un bloc de cadrage vers une action : « ce contexte, cette
//               règle, cet outil valent POUR CETTE ÉTAPE ». Dans le document,
//               c'est la pastille posée dans la phrase.
//
// La moitié de ce qu'une procédure dit n'est pas une séquence : un contexte,
// une règle, un outil imposé n'ARRIVENT pas, ils QUALIFIENT ce qui arrive. Les
// exprimer comme une séquence faisait mentir le modèle (« charge le contexte,
// PUIS fais l'étape », comme si le contexte était une étape).
//
// Un attachement est plusieurs-à-un dans les deux sens, exprès : une étape
// prend autant de cadrages qu'il lui en faut, et un même bloc de contexte
// s'applique à plusieurs étapes sans être dupliqué.
//
// Tout est identifié par les handles, donc un graphe enregistré avant que cet
// axe existe — toutes ses arêtes en `targetHandle: null` — se relit comme du
// flux pur. Aucune migration.
//
// Le vocabulaire et les relations vivent dans le langage partagé, pour que le
// runtime edge construise les mêmes graphes que l'éditeur. Ce module est le
// chemin d'import de l'éditeur, rien de plus.
export {
  ATTACH_HANDLE, APPLIES_HANDLE, roleOf,
  attachmentsByTarget, targetsOfQualifier, isAttachEdge, flowEdges, attachEdges, isAttached,
};
export type { BlockRole };
