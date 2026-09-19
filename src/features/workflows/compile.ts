import type { Node, Edge } from "reactflow";
import {
  contextSourceOf, ATTACH_HANDLE, APPLIES_HANDLE,
} from "../../../supabase/functions/_shared/workflow-doc";
import type { BlockKind, WorkflowGraph } from "./model";

// Markdown → blocks. The other direction MOVED: `compileWorkflow` now lives in
// supabase/functions/_shared/workflow-doc.ts, so the editor and the edge runtime
// (where an assistant now builds workflows on request) render a playbook with
// one implementation rather than two that must stay byte-identical.
//
// The PARSER stays here on purpose: only the editor round-trips a hand-edited
// document, and it needs the previous graph to preserve the canvas layout.
// Nothing on the backend has ever needed it.
export { compileWorkflow } from "../../../supabase/functions/_shared/workflow-doc";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

const ANCHOR_RE = /^<!--\s*b:([A-Za-z0-9_-]+)\s*-->\s*$/;
/** The anchor of an ATTACHMENT — the qualifier, and the action it hangs off.
 *  Written by the compiler; read back here so a document edited by hand cannot
 *  silently delete an attached block along with its wiring. */
const ATTACH_ANCHOR_RE = /^<!--\s*a:([A-Za-z0-9_-]+)>([A-Za-z0-9_-]+)\s*-->\s*$/;

/** Which section heading a block kind lives under, for text written by hand
 *  with no anchor above it. */
const SECTION_KIND: Array<[RegExp, BlockKind]> = [
  [/^entr[ée]es?/i, "input"],
  [/^objectif/i, "goal"],
  [/^r[èe]gles?/i, "rule"],
  [/^contexte/i, "context"],
  [/^ressources?/i, "resource"],
  [/^outils?/i, "tool"],
  [/^proc[ée]dure/i, "step"],
  [/^livrables?/i, "deliverable"],
  [/^à m[ée]moriser/i, "memory"],
  [/^exemples?/i, "example"],
];

/** Lines the compiler GENERATES from structured fields. Reading them back would
 *  duplicate them into the body on every round-trip, so they are dropped and
 *  regenerated from the graph each time. */
const GENERATED_LINE = [
  /^>\s*\*\*(Confier à|Contexte à fournir|Contexte pour la suite|Mode|Ce qui doit revenir)\s*:/i,
  // Attachment callouts — one head per qualifier kind (see attachLabel in
  // nodes.tsx). Generated from the wiring, so reading them back would copy a
  // context into the body of the step it merely qualifies, and the quote would
  // grow a duplicate of itself on every save.
  /^>\s*\*\*(Contexte|Règle|Ressource|Outil imposé|À mémoriser|Produit|Cadrage)\s*:/i,
  /^_Utilise `ask_user`/,
  /^_Si une entrée obligatoire manque/,
  /^_(Lance-les|Délègue) /,
  /^\*\*Plafond\s*:/i,
  /^Répète les étapes ci-dessous/i,
  /^Si la liste dépasse une dizaine/i,
  /^-\s*\*\*(Si oui|Sinon|À répéter|Une fois terminé)\*\*/i,
  /^-\s*Collection de connaissances\s*«/i,
  // Input parameters, tool constraints, deliverables and memory entries are all
  // rendered from structured fields — reading their bullets back would turn a
  // list of parameters into a paragraph about parameters.
  /^-\s*`[a-z0-9_]+`/i,
  /^Sch[ée]ma exact attendu\s*:/i,
  /^Enregistre-le avec `save_memory`/,
];

/**
 * Read the document back into blocks.
 *
 * Anchors are the contract: an anchored section maps onto the block it names,
 * which is what preserves canvas positions and edges across a markdown edit. A
 * section written by hand with no anchor becomes a NEW block, filed under
 * whatever `## ` heading it sits in, and laid out automatically.
 *
 * `previous` is the graph as the canvas last knew it — positions and edges come
 * from there. Without it, a round-trip would relayout the whole canvas on every
 * save, which is the failure that makes dual editing unusable.
 */
export function parseWorkflow(md: string, previous: WorkflowGraph): WorkflowGraph {
  const prevById = new Map(previous.nodes.map((n) => [n.id, n]));
  const lines = (md ?? "").split("\n");

  let currentSection: BlockKind | null = null;
  let pendingId: string | null = null;

  type Draft = { id: string; kind: BlockKind; label: string; body: string[] };
  const drafts: Draft[] = [];
  /** Anchors present in the document. A block whose rendering is ENTIRELY
   *  structured (a context block is just its refs) produces no draft, and would
   *  otherwise be deleted from the graph by its own round-trip. Seeing its
   *  anchor is proof it is still there. */
  const seenAnchors = new Set<string>();
  /** Attachment relations read back from the document — see attachAnchor. */
  const attachments: Array<{ source: string; target: string }> = [];
  let cur: Draft | null = null;
  let seq = 0;
  const newId = (k: BlockKind) => `${k}-${Date.now().toString(36)}${(seq++).toString(36)}`;
  const flush = () => { if (cur) { drafts.push(cur); cur = null; } };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");

    // An attachment anchor is a RELATION, not a block boundary: it records the
    // wiring and leaves the draft being read alone. Flushing here would end the
    // step early and hand its remaining body to the context quoted inside it.
    const at = line.match(ATTACH_ANCHOR_RE);
    if (at) { seenAnchors.add(at[1]); attachments.push({ source: at[1], target: at[2] }); continue; }

    const a = line.match(ANCHOR_RE);
    if (a) { flush(); pendingId = a[1]; seenAnchors.add(a[1]); continue; }

    // Frontmatter and the H1 are generated, never parsed back.
    if (/^---\s*$/.test(line) || /^workflow:/i.test(line) || /^déclencheur:/i.test(line) || /^# /.test(line)) continue;

    // Only a heading from the document's OWN vocabulary ends a section. A
    // context or a goal is free-form markdown and routinely contains its own
    // `##` headings; treating those as section boundaries swallowed everything
    // under them, so a written context lost its body the first time it was
    // saved from the Document view.
    const h2 = line.match(/^##\s+(.*)$/);
    const named = h2 ? SECTION_KIND.find(([re]) => re.test(h2[1].trim()))?.[1] : undefined;
    if (h2 && named) {
      flush();
      currentSection = named;
      continue;
    }

    // Un intertitre de procédure. Lu AVANT `###` parce que la regex de `###`
    // matcherait aussi `####` et rangerait la section parmi les étapes.
    const h4 = line.match(/^####\s+(.*)$/);
    if (h4) {
      flush();
      drafts.push({ id: pendingId ?? newId("section"), kind: "section", label: h4[1].trim(), body: [] });
      pendingId = null;
      continue;
    }

    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      flush();
      const t = h3[1].trim();
      const kind: BlockKind = /^⏸|validation humaine/i.test(t) ? "approval"
        : /^🔁|^boucle/i.test(t) ? "loop"
        : /^➜|^passation/i.test(t) ? "handoff"
        : /^décision/i.test(t) ? "decision"
        : "step";
      const label = t
        .replace(/^[⏸🔁➜]\s*/, "")
        .replace(/^(validation humaine|décision|boucle|passation)\s*—\s*/i, "")
        .replace(/^\d+\.\s*/, "")
        .trim();
      cur = { id: pendingId ?? newId(kind), kind, label, body: [] };
      pendingId = null;
      continue;
    }

    // Structured fields are regenerated from the graph, never read back.
    if (GENERATED_LINE.some((re) => re.test(line.trim()))) continue;
    // A blockquote line that survived the filters is inlined context — it also
    // belongs to the structured side, so it is dropped rather than duplicated.
    if (/^>\s?/.test(line) && ["step", "loop", "handoff", "decision", "approval"].includes(cur?.kind ?? "")) continue;

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet && currentSection && ["rule", "resource", "deliverable", "memory"].includes(currentSection)) {
      flush();
      const text = bullet[1].replace(/\*\*/g, "").trim();
      const [label, ...rest] = text.split(" — ");
      drafts.push({
        id: pendingId ?? newId(currentSection),
        kind: currentSection,
        label: label.replace(/\s*\([^)]*\)\s*$/, "").trim(),
        body: rest.length ? [rest.join(" — ").trim()] : [],
      });
      pendingId = null;
      continue;
    }
    if (!line.trim()) { if (cur) cur.body.push(""); continue; }

    if (cur) { cur.body.push(line); continue; }
    // Sections written as free prose. `context` is here because a context block
    // in "Rédiger" mode IS its text — without this its section would parse back
    // to nothing and every edit made in the Document view would be discarded.
    // (A branch-scoped context is quoted inside the Procédure section and stays
    // read-only there, exactly like the step callouts around it.)
    if (currentSection && ["goal", "example", "context", "input"].includes(currentSection)) {
      cur = { id: pendingId ?? newId(currentSection), kind: currentSection, label: "", body: [line] };
      pendingId = null;
    }
  }
  flush();

  // Rebuild: an existing block keeps its position, a new one is stacked under
  // the lowest — which is where the canvas puts new blocks anyway.
  let nextY = previous.nodes.reduce((max, p) => Math.max(max, p.position?.y ?? 0), 60);
  const nodes: Node[] = drafts.map((d) => {
    const old = prevById.get(d.id);
    const position = old?.position ?? { x: 260, y: (nextY += 150) };
    // Sections without a heading print their title as a leading bold line, so
    // reading them back must lift it out again. Left in the body it is emitted
    // a second time on the next compile, and the title grows a copy of itself
    // on every round-trip. Only for drafts with no heading of their own — a
    // step's first bold line is genuine content.
    const body = [...d.body];
    let label = d.label;
    if (!label) {
      const first = body.findIndex((l) => l.trim());
      const bold = first >= 0 ? body[first].trim().match(/^\*\*(.+)\*\*$/) : null;
      if (bold) { label = bold[1].trim(); body.splice(0, first + 1); }
    }
    const data: Record<string, unknown> = {
      ...(old?.data ?? {}),
      label: label || str(old?.data?.label),
      body: body.join("\n").trim(),
    };
    // A context block pointing at collections prints no text at all, so the
    // document says nothing about the draft it may still hold — and silence is
    // not an instruction to erase it. Reading the document back would otherwise
    // destroy what switching the block back to "Rédiger" is supposed to return.
    if (d.kind === "context" && contextSourceOf(data) === "collections") {
      data.body = str(old?.data?.body);
    }
    return { id: d.id, type: d.kind, position, data } as Node;
  });

  // Blocks whose anchor is present but which produced no draft — a context
  // block is nothing but its structured refs — are carried over untouched.
  for (const p of previous.nodes) {
    if (seenAnchors.has(p.id) && !nodes.some((x) => x.id === p.id)) nodes.push(p);
  }

  // The trigger is never written in the body — carry it over untouched.
  const trigger = previous.nodes.find((p) => p.type === "trigger");
  if (trigger && !nodes.some((x) => x.id === trigger.id)) nodes.unshift(trigger);

  const kept = new Set(nodes.map((x) => x.id));
  // FLOW comes from the previous graph — the document never draws it. The
  // ATTACHMENTS come from the document, because that is where they are written:
  // deleting a callout by hand must actually detach the block, not have the
  // stored edge quietly put it back on the next compile.
  const edges: Edge[] = previous.edges
    .filter((e) => e.targetHandle !== ATTACH_HANDLE && e.sourceHandle !== APPLIES_HANDLE)
    .filter((e) => kept.has(e.source) && kept.has(e.target));
  for (const a of attachments) {
    if (!kept.has(a.source) || !kept.has(a.target)) continue;
    if (edges.some((e) => e.source === a.source && e.target === a.target && e.targetHandle === ATTACH_HANDLE)) continue;
    edges.push({
      id: `a-${a.source}-${a.target}`, source: a.source, target: a.target,
      sourceHandle: APPLIES_HANDLE, targetHandle: ATTACH_HANDLE,
    } as Edge);
  }
  return { nodes, edges };
}
