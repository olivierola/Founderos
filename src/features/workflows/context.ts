// Plain readers over a block's `data` bag, and the rules for interpreting it.
//
// Split out of model.ts and nodes.tsx on purpose: one talks to Supabase and the
// other renders React, and the compiler has no business pulling either into its
// import graph just to ask what a block contains.

/**
 * A piece of knowledge attached to the workflow, or to ONE block of it.
 *
 * Scoping is the whole point. A workflow is how you stop shipping one
 * monolithic instruction file on every run: the accounting procedure belongs in
 * the prompt of the agent doing the bank reconciliation, and nowhere else. A
 * block carries its own context, and the assistant passes exactly that when it
 * delegates the block.
 */
export interface ContextRef {
  kind: "collection" | "text";
  /** rag_collections.id when kind = "collection". */
  id?: string;
  /** Display name (collection) or the title of the note (text). */
  label: string;
  body?: string;
}

/**
 * Where a `context` block gets its knowledge. Either/or, on purpose: a context
 * block answers one question — "what should be known here" — and answering it
 * twice, half written by hand and half pulled from a collection, produced
 * documents where nobody could tell which half was authoritative.
 *
 * A step or a loop is different: it legitimately combines a collection with a
 * note written for that step alone, so those keep the mixed picker.
 */
export type ContextSourceKind = "write" | "collections";

/** The stored choice, or the one the block's existing content implies — blocks
 *  written before the switch existed must still open on the right editor. */
export function contextSourceOf(data: Record<string, unknown> | null | undefined): ContextSourceKind {
  const explicit = String(data?.source ?? "");
  if (explicit === "write" || explicit === "collections") return explicit;
  const refs = Array.isArray(data?.refs) ? (data.refs as ContextRef[]) : [];
  return refs.some((r) => r.kind === "collection") ? "collections" : "write";
}

/** The written text of a context block. Older blocks kept it in a free-text
 *  ref rather than in `body`; both are the same thing to a reader, so both are
 *  shown — and the first edit folds the legacy form into `body`. */
export function contextBodyOf(data: Record<string, unknown> | null | undefined): string {
  const body = String(data?.body ?? "");
  if (body.trim()) return body;
  const refs = Array.isArray(data?.refs) ? (data.refs as ContextRef[]) : [];
  return refs
    .filter((r) => r.kind === "text" && r.body?.trim())
    .map((r) => (r.label?.trim() ? `## ${r.label.trim()}\n\n${r.body!.trim()}` : r.body!.trim()))
    .join("\n\n");
}

/** A parameter a run needs before it can start. */
export interface InputParam { name: string; description?: string; required?: boolean }

export const paramsOf = (data: Record<string, unknown> | null | undefined): InputParam[] =>
  Array.isArray(data?.params) ? (data.params as InputParam[]).filter((p) => p && typeof p === "object") : [];

/** Recipients of a handoff. Several, unlike a step's single `agent_id` — a
 *  handoff is where a procedure fans out to a team. */
export const agentIdsOf = (data: Record<string, unknown> | null | undefined): string[] =>
  Array.isArray(data?.agent_ids) ? (data.agent_ids as unknown[]).map(String).filter(Boolean) : [];
