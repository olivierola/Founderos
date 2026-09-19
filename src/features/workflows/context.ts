// Readers over a block's `data` bag — MOVED to the shared workflow language.
//
// They now live in supabase/functions/_shared/workflow-doc.ts, next to the
// compiler that uses them, because the edge runtime needs the same readers to
// build workflows on an agent's request. This file stays as the import path the
// editor already uses everywhere.

export {
  contextSourceOf, contextBodyOf, paramsOf, agentIdsOf,
  // Les jetons de bloc en ligne : le compilateur les résout, l’éditeur les pose.
  chipToken, chipIdsIn, cleanArgs,
  // Le code et les variables : mêmes règles des deux côtés, sinon l’éditeur
  // accepterait un nom que le moteur refuse.
  CODE_TOOLS, codeToolOf, outputVarOf,
} from "../../../supabase/functions/_shared/workflow-doc";
export type {
  BlockKind, BlockRole, ContextRef, ContextSourceKind, InputParam,
} from "../../../supabase/functions/_shared/workflow-doc";
