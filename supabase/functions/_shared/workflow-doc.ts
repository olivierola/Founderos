// The workflow LANGUAGE: what a block means, how blocks relate, and how the
// whole thing becomes the markdown playbook an agent executes.
//
// This module is deliberately DEPENDENCY-FREE — no React, no reactflow, no
// Supabase client, not even a type import. That is what lets the editor (which
// renders the canvas) and the edge runtime (where the assistant now BUILDS
// workflows on request) share one implementation instead of two.
//
// The alternative was a second compiler on the backend, which the engine's own
// header argues against at length and rightly: two copies of these rules would
// have to stay byte-identical through every change to the block vocabulary, and
// the failure mode of a divergence is a playbook silently missing its
// delegations and its scoped context. So there is one copy, and it lives where
// both sides can reach it.
//
// The PARSER (markdown → blocks) stays in the editor: only the editor round-
// trips a hand-edited document, and it needs the previous graph to preserve
// layout. Nothing on the backend has ever needed it.

// ── The graph, structurally ──────────────────────────────────────────────────
// Shaped like React Flow's nodes and edges because that is what the canvas
// stores, but declared here so this module needs no dependency to describe it.

export interface WfNode {
  id: string;
  /** The block kind — React Flow's `type` IS the kind. */
  type?: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
}

export interface WfEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface WfGraph { nodes: WfNode[]; edges: WfEdge[] }

/** The sections a good procedure is made of. */
export type BlockKind =
  | "trigger" | "input" | "goal" | "rule" | "context" | "resource" | "tool"
  | "section" | "step" | "decision" | "loop" | "handoff" | "approval"
  | "deliverable" | "memory" | "example";

/**
 * What a block IS, which decides how it may be wired and where it lands.
 *
 *   trigger    — the way in. Nothing precedes it.
 *   frame      — a document section: what the run needs, aims at, must produce.
 *   action     — something that HAPPENS, in order. Takes attachments on its left.
 *   qualifier  — something that QUALIFIES. Left global it becomes its own
 *                section; attached to an action it is printed inside it.
 */
export type BlockRole = "trigger" | "frame" | "action" | "qualifier";

export interface BlockDoc {
  role: BlockRole;
  /** What it becomes in the document. */
  compiles: string;
  /** Qualifiers only: the head of the callout inside the action it qualifies. */
  attachLabel?: string;
  /** The block's starting `data`, so a block can be created from its kind alone. */
  defaults: Record<string, unknown>;
}

/** The single source of truth for the block vocabulary. The editor's catalogue
 *  adds icons, colours and copy on top of these rows; it never redeclares them. */
export const BLOCK_DOC: Record<BlockKind, BlockDoc> = {
  trigger: { role: "trigger", compiles: "frontmatter", defaults: { label: "Déclencheur", mode: "manual", schedule: "0 9 * * 1", event: "" } },
  input: { role: "frame", compiles: "## Entrées", defaults: { label: "", body: "", params: [] } },
  goal: { role: "frame", compiles: "## Objectif", defaults: { label: "", body: "" } },
  example: { role: "frame", compiles: "## Exemples", defaults: { label: "", body: "" } },
  rule: { role: "qualifier", compiles: "## Règles", attachLabel: "Règle", defaults: { label: "", body: "" } },
  context: { role: "qualifier", compiles: "## Contexte", attachLabel: "Contexte", defaults: { label: "", body: "", refs: [], scope: "global" } },
  resource: { role: "qualifier", compiles: "## Ressources", attachLabel: "Ressource", defaults: { label: "", body: "" } },
  // Un outil, à deux niveaux de précision : une CAPACITÉ (« cherche sur le
  // web ») ou une ACTION nommée sur une app connectée (« hubspot →
  // list_deals »). La seconde est ce qui fait d'un workflow une automatisation :
  // l'agent ne choisit plus l'appel, il l'exécute.
  tool: { role: "qualifier", compiles: "## Outils à utiliser", attachLabel: "Outil imposé", defaults: { label: "", body: "", tool: "web_search", required: true, provider: "", action: "", args: {}, code: "", output_var: "" } },
  deliverable: { role: "qualifier", compiles: "## Livrables", attachLabel: "Produit", defaults: { label: "", body: "", format: "report" } },
  memory: { role: "qualifier", compiles: "## À mémoriser", attachLabel: "À mémoriser", defaults: { label: "", body: "", scope: "team" } },
  // Un intertitre dans la procédure. Il ne fait rien : il NOMME un passage, ce
  // qui donne enfin quelque chose à viser à une branche (« reprendre à … »)
  // quand deux chemins se rejoignent.
  section: { role: "action", compiles: "#### Titre", defaults: { label: "", body: "" } },
  step: { role: "action", compiles: "### n. Titre", defaults: { label: "", body: "", agent_id: null, refs: [], output_var: "" } },
  loop: { role: "action", compiles: "### Boucle", defaults: { label: "", body: "", mode: "foreach", over: "", until: "", max: 20 } },
  decision: { role: "action", compiles: "### Décision", defaults: { label: "", body: "" } },
  handoff: { role: "action", compiles: "### ➜ Passation", defaults: { label: "", body: "", agent_ids: [], mode: "sequential", expects: "", refs: [] } },
  approval: { role: "action", compiles: "### ⏸ Validation", defaults: { label: "", body: "" } },
};

export const BLOCK_KINDS = Object.keys(BLOCK_DOC) as BlockKind[];
export const isBlockKind = (v: unknown): v is BlockKind =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(BLOCK_DOC, v);
export const roleOf = (kind: string | undefined): BlockRole => BLOCK_DOC[(kind ?? "step") as BlockKind]?.role ?? "action";

// ── The attachment axis ──────────────────────────────────────────────────────
// Two relations, and the whole model is in the distinction. A FLOW edge runs
// top to bottom between actions: order. An ATTACHMENT runs from a qualifier's
// right port to an action's left port: "this context belongs to that step".
// Handle ids are how they are told apart, so a graph saved before the axis
// existed — every edge with a null handle — reads back as pure flow.

export const ATTACH_HANDLE = "attach";
export const APPLIES_HANDLE = "applies";

export const isAttachEdge = (e: { sourceHandle?: string | null; targetHandle?: string | null }): boolean =>
  e.targetHandle === ATTACH_HANDLE || e.sourceHandle === APPLIES_HANDLE;

export const flowEdges = <T extends { sourceHandle?: string | null; targetHandle?: string | null }>(edges: T[]): T[] =>
  edges.filter((e) => !isAttachEdge(e));
export const attachEdges = <T extends { sourceHandle?: string | null; targetHandle?: string | null }>(edges: T[]): T[] =>
  edges.filter(isAttachEdge);

/** Action id → the qualifier blocks attached to it, in the order they were drawn. */
export function attachmentsByTarget(nodes: WfNode[], edges: WfEdge[]): Map<string, WfNode[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, WfNode[]>();
  for (const e of attachEdges(edges)) {
    const q = byId.get(e.source);
    if (!q) continue;
    const list = out.get(e.target) ?? [];
    list.push(q);
    out.set(e.target, list);
  }
  return out;
}

/** The actions one qualifier applies to. Empty = it stays a global section. */
export function targetsOfQualifier(nodes: WfNode[], edges: WfEdge[], qualifierId: string): WfNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return attachEdges(edges)
    .filter((e) => e.source === qualifierId)
    .map((e) => byId.get(e.target))
    .filter(Boolean) as WfNode[];
}

/** True when this qualifier is scoped to at least one action — so it is printed
 *  inside that action instead of in the document's global section. */
export const isAttached = (edges: WfEdge[], nodeId: string): boolean =>
  attachEdges(edges).some((e) => e.source === nodeId);

// ── Inline blocks ────────────────────────────────────────────────────────────
// A qualifier attached to an action used to have exactly one place to land: a
// quoted callout ABOVE the action's text. That is fine for a rule that frames a
// whole step, and wrong for the case people actually write — « demande la
// commande {{le connecteur}} puis confirme au client ». Said above the
// sentence, the tool loses the position that gave it its meaning.
//
// So an action's body may carry a TOKEN naming one of its attached qualifiers.
// Where the token sits is where the qualifier is printed; a qualifier the body
// never names still gets its callout, as before. Nothing changes for an
// existing workflow: no token, no inlining.
//
// The token is deliberately unlike the anchors (`<!-- b:… -->`): anchors mark
// where a BLOCK starts, this marks a mention inside one.

const CHIP_RE = /\{\{b:([A-Za-z0-9_-]+)\}\}/g;

export const chipToken = (qualifierId: string) => `{{b:${qualifierId}}}`;

/** The qualifier ids an action's body mentions, in order of appearance. */
export function chipIdsIn(body: string): string[] {
  const out: string[] = [];
  for (const m of String(body ?? "").matchAll(CHIP_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The short, one-line form of a qualifier — what it reads like INSIDE a
 *  sentence. Necessarily terser than its callout: a paragraph of context
 *  dropped mid-sentence would break the instruction it is meant to situate,
 *  so a context that carries real text is mentioned here and detailed in its
 *  callout below. */
function inlineQualifier(q: WfNode): string {
  const kind = (q.type ?? "context") as BlockKind;
  const data = (q.data ?? {}) as Record<string, unknown>;
  const label = str(data.label).trim();
  const head = BLOCK_DOC[kind]?.attachLabel ?? "Cadrage";

  if (kind === "tool") {
    const call = toolCall(data);
    if (!call.text) return `**${head} (non choisi)**`;
    return `**${call.isAction ? "Exécute" : head} ${call.text}**`;
  }
  if (kind === "context") {
    const cols = (Array.isArray(data.refs) ? (data.refs as ContextRef[]) : [])
      .filter((r) => r.kind === "collection").map((r) => r.label);
    const where = cols.length ? cols.join(" · ") : label;
    return where ? `**${head} : ${where}**` : `**${head} ci-dessous**`;
  }
  if (kind === "deliverable") {
    return `**${head} : ${label || "livrable"} (${str(data.format) || "report"})**`;
  }
  return `**${head}${label ? ` : ${label}` : ""}**`;
}

/**
 * Replace every token in an action's body with its qualifier's inline form.
 *
 * A token naming a qualifier that is no longer attached (detached, or deleted)
 * is REMOVED rather than printed raw: `{{b:ctx-3}}` in the middle of an
 * instruction is the kind of leak an agent dutifully repeats to a customer.
 */
function inlineChips(body: string, byId: Map<string, WfNode>, attachedIds: Set<string>): string {
  if (!body.includes("{{b:")) return body;
  return body
    .replace(CHIP_RE, (_m, id: string) => {
      const q = byId.get(id);
      return q && attachedIds.has(id) ? inlineQualifier(q) : "";
    })
    // The removal leaves the double space the token used to sit between.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1");
}

// ── Readers over a block's `data` bag ────────────────────────────────────────

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

// ── Blocks → markdown ────────────────────────────────────────────────────────
// Every block is anchored in the document with an HTML comment. Without those
// anchors, editing the markdown would rebuild a fresh graph and destroy the
// canvas layout on every save.

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

export const anchor = (id: string) => `<!-- b:${id} -->`;

/**
 * The anchor of an ATTACHMENT — the qualifier, and the action it hangs off.
 *
 * An attached block prints only as a quoted callout inside its action, and the
 * parser drops generated callouts on purpose. Without a mark of its own it is
 * invisible in the document, and one save through the Document view DELETES it
 * from the graph along with its wiring.
 *
 * It is deliberately NOT a `b:` anchor: those set the id of the next block to
 * be read, which here would hand the step's own body to the context quoted
 * inside it. This one records a relation and nothing else.
 */
export const attachAnchor = (qualifierId: string, actionId: string) => `<!-- a:${qualifierId}>${actionId} -->`;

function readingOrder(g: WfGraph): WfNode[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out: WfNode[] = [];
  const seen = new Set<string>();
  // ONLY the flow edges carry order. An attachment says "this context belongs
  // to that step", not "this context comes before that step" — walking it as a
  // successor is what would drag a qualifier back into the procedure it was
  // just pulled out of.
  const flow = flowEdges(g.edges);

  const visit = (id: string) => {
    if (seen.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    seen.add(id);
    out.push(node);
    for (const e of flow.filter((x) => x.source === id)) visit(e.target);
  };

  const roots = g.nodes.filter((n) => n.type === "trigger" || !flow.some((e) => e.target === n.id));
  for (const r of roots) visit(r.id);
  for (const n of g.nodes) if (!seen.has(n.id)) out.push(n);
  return out;
}

function triggerLine(data: Record<string, unknown>): string {
  const mode = str(data.mode) || "manual";
  if (mode === "schedule") return `planifié (${str(data.schedule) || "cron non défini"})`;
  if (mode === "event") return `sur événement « ${str(data.event) || "non défini"} »`;
  if (mode === "webhook") return "sur appel webhook entrant";
  return "lancement manuel";
}

/**
 * Comment un bloc « outil » se nomme dans une instruction.
 *
 * Deux précisions possibles. Une CAPACITÉ dit quoi mobiliser et laisse l'agent
 * choisir l'appel. Une ACTION dit exactement quel appel faire sur quelle app —
 * c'est ce qui transforme une procédure en automatisation, et c'est aussi ce
 * qui la rend vérifiable : on relit le document et on sait ce qui sera exécuté.
 *
 * Le nom suit la règle du runtime (`use_<provider>`), sinon l'instruction
 * désignerait un outil que l'agent n'a pas dans sa boîte.
 */
/**
 * Les paramètres réellement transmis.
 *
 * L'éditeur laisse vivre une paire à moitié écrite — le temps de taper son nom,
 * la clé est vide. Elle ne doit jamais sortir d'ici : ni dans l'instruction que
 * lit un agent, ni dans l'appel que fait le moteur. Une valeur vide est écartée
 * pour la même raison qu'un champ vide ne l'est pas dans le formulaire : « non
 * transmis » et « transmis vide » sont deux choses différentes pour une API.
 */
export function cleanArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (!k.trim()) continue;
    if (v === "" || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Les outils qui EXÉCUTENT du code écrit dans le bloc.
 *
 * Ils sont à part parce qu'ils ne se règlent pas : les autres se choisissent
 * (« cherche sur le web »), ceux-là s'écrivent. Un champ « paramètres » n'aurait
 * aucun sens pour eux — le paramètre, c'est le programme.
 */
export const CODE_TOOLS: Record<string, { language: string; label: string }> = {
  python_exec: { language: "python", label: "Python" },
  nodejs_exec: { language: "javascript", label: "JavaScript" },
  shell_exec: { language: "bash", label: "Shell" },
};

export const codeToolOf = (data: Record<string, unknown> | null | undefined) =>
  CODE_TOOLS[str(data?.tool).trim()] ?? null;

/**
 * Le nom sous lequel le résultat d'un bloc est rangé — sa VARIABLE.
 *
 * Sans elle, une étape ne peut se référencer que par l'identifiant de son bloc
 * (`steps.tool-a1b2`), qui ne veut rien dire pour qui relit la procédure six
 * mois plus tard. Avec elle, l'étape suivante écrit `{{deals}}`.
 *
 * Normalisé, pas seulement validé : ce nom entre dans des gabarits, et un
 * espace ou un accent au milieu casserait la résolution sans rien dire.
 * `trigger` et `steps` sont refusés — ils désignent déjà autre chose dans le
 * contexte d'un run, et les laisser passer masquerait la donnée d'origine.
 */
export function outputVarOf(data: Record<string, unknown> | null | undefined): string {
  const raw = str(data?.output_var).trim();
  if (!raw) return "";
  const clean = raw
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!clean || /^\d/.test(clean)) return "";
  return clean === "trigger" || clean === "steps" ? "" : clean;
}

export function toolCall(data: Record<string, unknown> | null | undefined): { text: string; isAction: boolean } {
  const provider = str(data?.provider).trim();
  const action = str(data?.action).trim();
  if (provider && action) {
    const clean = cleanArgs(data?.args);
    const args = Object.keys(clean).length > 0 ? ` avec ${JSON.stringify(clean)}` : "";
    const tool = `use_${provider.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
    return { text: "`" + tool + "` → `" + action + "`" + args, isAction: true };
  }
  const tool = str(data?.tool).trim();
  return { text: tool ? "`" + tool + "`" : "", isAction: false };
}

const refsOf = (n: WfNode): ContextRef[] => (Array.isArray(n.data?.refs) ? (n.data.refs as ContextRef[]) : []);

/**
 * What a context block contributes to the document. A context block has ONE
 * source — written text, or collections — and the document must say which,
 * because the two are read very differently: written text is knowledge the
 * agent already has, collections are places it must go and look.
 *
 * The inactive source is left in the block but never printed. That is the point
 * of the switch: toggling it changes the document, not the stored block.
 */
function contextLines(n: WfNode): string[] {
  const data = (n.data ?? {}) as Record<string, unknown>;
  if (contextSourceOf(data) === "collections") {
    const cols = refsOf(n).filter((r) => r.kind === "collection");
    if (!cols.length) return [];
    return cols.map((r) => `- Collection de connaissances « ${r.label} » — à consulter avec \`rag_search\`.`);
  }
  const written = contextBodyOf(data).trim();
  return written ? [written] : [];
}

/**
 * The callout that turns a step into a SITUATED instruction: who takes it, and
 * with what knowledge. This is the whole reason workflows exist — instead of
 * one monolithic instruction file reloaded on every run, each part of the
 * procedure carries exactly the context it needs, and the assistant passes that
 * (and only that) when it delegates.
 *
 * `agentNames` resolves the stored id; an id that no longer resolves still
 * prints, so a deleted agent shows up as a problem to fix instead of silently
 * turning a delegated step into one the assistant does itself.
 */
function situationCallout(n: WfNode, agentNames: Map<string, string>): string[] {
  const out: string[] = [];
  const agentId = str(n.data?.agent_id);
  if (agentId) out.push(`> **Confier à :** ${agentNames.get(agentId) ?? `agent ${agentId.slice(0, 8)} (introuvable)`}`);
  const refs = refsOf(n);
  if (refs.length) {
    const labels = refs.map((r) => (r.kind === "collection" ? `collection « ${r.label} »` : `note « ${r.label || "sans titre"} »`));
    out.push(`> **Contexte à fournir :** ${labels.join(" · ")}`);
    // A free-text note IS the context, so it is inlined — there is nothing else
    // to look it up in.
    for (const r of refs.filter((x) => x.kind === "text" && x.body?.trim())) {
      out.push(">", `> _${r.label || "Note"}_ :`, ...r.body!.trim().split("\n").map((l) => `> ${l}`));
    }
  }
  if (out.length) out.push("");
  return out;
}

/**
 * What an ATTACHED qualifier contributes to the action it hangs off.
 *
 * This is the payoff of the attachment axis: a context wired to one step is
 * printed inside that step and nowhere else, so the assistant loads it at that
 * point in the procedure rather than swallowing every knowledge source before
 * it has read the first instruction. Same block, same text — a different place
 * in the document, decided by a line on the canvas.
 */
function attachmentLines(q: WfNode): string[] {
  const kind = (q.type ?? "context") as BlockKind;
  const data = (q.data ?? {}) as Record<string, unknown>;
  const label = str(data.label).trim();
  const body = str(data.body).trim();
  const head = BLOCK_DOC[kind]?.attachLabel ?? "Cadrage";
  const out: string[] = [];

  if (kind === "context") {
    const written = contextSourceOf(data) === "collections" ? "" : contextBodyOf(data).trim();
    const cols = refsOf(q).filter((r) => r.kind === "collection");
    const where = cols.length
      ? cols.map((r) => `collection « ${r.label} »`).join(" · ")
      : label || "connaissances ci-dessous";
    out.push(`> **${head} :** ${where}`);
    if (written) {
      out.push(">", ...written.split("\n").map((l) => `> ${l}`));
    }
    return out;
  }
  if (kind === "tool") {
    const call = toolCall(data);
    if (!call.text) return [];
    const heading = call.isAction ? "Action à exécuter" : head;
    const v = outputVarOf(data);
    const out: string[] = [
      `> **${heading} :** ${call.text}${data.required === false ? " (si besoin)" : ""}${body ? ` — ${body}` : ""}`,
    ];
    // Le code est cité TEL QUEL. Le paraphraser (« un script qui filtre les
    // doublons ») rendrait l'instruction inexécutable : ce qui est écrit ici
    // est ce qui doit tourner, au caractère près.
    const code = str(data.code).trim();
    const lang = codeToolOf(data);
    if (code && lang) {
      out.push(">", `> \`\`\`${lang.language}`);
      for (const line of code.split("\n")) out.push(`> ${line}`);
      out.push("> ```");
    }
    if (v) out.push(">", `> _Range le résultat dans \`${v}\` — les étapes suivantes y feront référence._`);
    return out;
  }
  if (kind === "deliverable") {
    const format = str(data.format) || "report";
    return [`> **${head} :** ${label || "livrable"} (${format})${body ? ` — ${body}` : ""}`];
  }
  if (kind === "memory") {
    const scope = str(data.scope) || "team";
    const where = scope === "personal" ? "pour toi seul" : scope === "workspace" ? "pour tout l'espace" : "pour l'équipe";
    return [`> **${head} :** ${[label, body].filter(Boolean).join(" — ") || "à retenir"} (${where}, via \`save_memory\`)`];
  }
  // rule, resource, and anything added later: title — body on one quoted line.
  const text = [label, body].filter(Boolean).join(" — ");
  return text ? [`> **${head} :** ${text}`] : [];
}

/**
 * Every qualifier wired into this action, rendered as its callout block — each
 * preceded by the anchor that keeps the relation alive through a round-trip.
 *
 * A qualifier the body MENTIONS inline is handled differently: it is printed
 * where the sentence puts it, and only its anchor is emitted here. Dropping the
 * anchor would lose the relation on the next round-trip; repeating the callout
 * would say the same thing twice, once in the sentence and once above it.
 */
function attachmentCallout(n: WfNode, attached: Map<string, WfNode[]>, inlined: Set<string>): string[] {
  const qs = attached.get(n.id) ?? [];
  if (!qs.length) return [];
  const out: string[] = [];
  for (const q of qs) {
    if (inlined.has(q.id)) {
      // Mentionné dans la phrase : sa forme courte y est déjà. Mais certaines
      // choses ne TIENNENT pas dans une phrase — un programme, le nom sous
      // lequel on range son résultat. Les omettre parce que le bloc est
      // mentionné ailleurs produirait une instruction qui parle d'un script
      // sans jamais le donner.
      out.push(attachAnchor(q.id, n.id), ...attachmentExtras(q));
      continue;
    }
    const lines = attachmentLines(q);
    if (!lines.length) continue;
    out.push(attachAnchor(q.id, n.id), ...lines);
  }
  if (out.length) out.push("");
  return out;
}

/** Ce qu'un qualifieur mentionné en ligne doit QUAND MÊME imprimer : ce que sa
 *  forme courte ne peut pas contenir. */
function attachmentExtras(q: WfNode): string[] {
  const data = (q.data ?? {}) as Record<string, unknown>;
  if ((q.type ?? "") !== "tool") return [];
  const out: string[] = [];
  const code = str(data.code).trim();
  const lang = codeToolOf(data);
  if (code && lang) {
    out.push(`> \`\`\`${lang.language}`);
    for (const line of code.split("\n")) out.push(`> ${line}`);
    out.push("> ```");
  }
  const v = outputVarOf(data);
  if (v) out.push(`> _Range le résultat dans \`${v}\`._`);
  return out;
}

export function compileWorkflow(
  wf: { name: string; description?: string | null },
  graph: WfGraph,
  /** agent id → name, for the delegation callouts. */
  agentNames: Map<string, string> = new Map(),
): string {
  const ordered = readingOrder(graph);
  const attached = attachmentsByTarget(graph.nodes, graph.edges);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // Per action: which of its qualifiers its own sentence names, and the body
  // with those mentions resolved. Computed once so the callout builder and the
  // body printer cannot disagree about who was already said.
  const inlinedOf = new Map<string, Set<string>>();
  const bodyOf = (n: WfNode): string => {
    const raw = str(n.data?.body).trim();
    const ids = new Set((attached.get(n.id) ?? []).map((q) => q.id));
    const used = new Set(chipIdsIn(raw).filter((id) => ids.has(id)));
    inlinedOf.set(n.id, used);
    return inlineChips(raw, byId, ids).trim();
  };
  const inlined = (n: WfNode) => inlinedOf.get(n.id) ?? new Set<string>();
  // A qualifier wired to an action is printed INSIDE it, so it must not also
  // print as a global section — the same rule twice, once as a heading and
  // once quoted under a step, reads as two different rules.
  const of = (k: BlockKind) => ordered.filter((n) => n.type === k && !isAttached(graph.edges, n.id));
  const body = (n: WfNode) => str(n.data?.body).trim();
  const title = (n: WfNode) => str(n.data?.label).trim();

  const out: string[] = [];
  const trigger = of("trigger")[0];

  out.push("---");
  out.push(`workflow: ${wf.name}`);
  out.push(`déclencheur: ${trigger ? triggerLine(trigger.data as Record<string, unknown>) : "lancement manuel"}`);
  out.push("---", "");
  out.push(`# ${wf.name}`, "");
  if (wf.description?.trim()) out.push(wf.description.trim(), "");

  const section = (heading: string, nodes: WfNode[], render: (n: WfNode) => string[]) => {
    if (nodes.length === 0) return;
    out.push(`## ${heading}`, "");
    for (const n of nodes) {
      out.push(anchor(n.id));
      out.push(...render(n));
      out.push("");
    }
  };

  // What the run needs before it can start. Printed before the objective on
  // purpose: an assistant that discovers a missing parameter halfway through has
  // already done work it may have to throw away.
  section("Entrées", of("input"), (n) => {
    const lines: string[] = [];
    if (title(n)) lines.push(`**${title(n)}**`);
    for (const p of paramsOf(n.data as Record<string, unknown>)) {
      if (!p.name?.trim()) continue;
      lines.push(`- \`${p.name.trim()}\`${p.required === false ? " (facultatif)" : ""}${p.description?.trim() ? ` — ${p.description.trim()}` : ""}`);
    }
    if (body(n)) lines.push("", body(n));
    if (lines.some((l) => l.startsWith("- `"))) {
      lines.push("", "_Si une entrée obligatoire manque au déclenchement, demande-la avec `ask_user` avant de commencer._");
    }
    return lines;
  });

  section("Objectif", of("goal"), (n) => [title(n) ? `**${title(n)}**` : "", body(n)].filter(Boolean));
  section("Règles", of("rule"), (n) => [`- ${[title(n), body(n)].filter(Boolean).join(" — ")}`]);

  // Only GLOBAL context blocks land in their own section. A context block
  // scoped to a branch is printed inside that branch, where it applies — a
  // procedure that dumps every knowledge source up front is exactly the
  // monolithic instruction file workflows exist to replace.
  section("Contexte", of("context").filter((n) => str(n.data?.scope) !== "local"), (n) => [
    ...(title(n) ? [`**${title(n)}**`] : []),
    ...contextLines(n),
  ]);

  section("Ressources à utiliser", of("resource"), (n) => [`- ${[title(n), body(n)].filter(Boolean).join(" — ")}`]);

  // Naming a tool is a CONSTRAINT, not a capability grant: the agent already
  // has its toolbox. What this section adds is "for this job, that one" — which
  // is how you stop an agent from answering a market question from memory when
  // the procedure says to go and look.
  section("Outils à utiliser", of("tool"), (n) => {
    const call = toolCall(n.data as Record<string, unknown>);
    if (!call.text) return [];
    const must = n.data?.required !== false;
    return [`- ${call.text}${must ? "" : " — si besoin"}${title(n) ? ` · ${title(n)}` : ""}${body(n) ? ` — ${body(n)}` : ""}`];
  });

  // The procedure keeps the reading order across step/decision/approval, so a
  // decision sits between the steps it separates — which is how a procedure is
  // actually read.
  const proc = ordered.filter((n) => ["section", "step", "decision", "loop", "approval", "handoff"].includes(n.type ?? "")
    || (n.type === "context" && str(n.data?.scope) === "local" && !isAttached(graph.edges, n.id)));
  if (proc.length) {
    out.push("## Procédure", "");
    let stepNo = 0;
    for (const n of proc) {
      out.push(anchor(n.id));
      if (n.type === "context") {
        // A branch-scoped context sits where it applies, so the assistant loads
        // it at that point and not before.
        const label = contextSourceOf(n.data as Record<string, unknown>) === "collections"
          ? refsOf(n).filter((r) => r.kind === "collection").map((r) => `collection « ${r.label} »`).join(" · ")
          : title(n);
        out.push(`> **Contexte pour la suite :** ${label || title(n) || "connaissances ci-dessous"}`);
        const lines = contextLines(n);
        if (lines.length) {
          out.push(">");
          out.push(...lines.join("\n").split("\n").map((l) => `> ${l}`));
        }
        out.push("");
      } else if (n.type === "section") {
        // Volontairement sans numéro : une section groupe des étapes, elle n en
        // est pas une, et la numérotation doit rester celle du travail à faire.
        out.push(`#### ${title(n) || "Section"}`, "");
        const b = bodyOf(n);
        if (b) out.push(b, "");
      } else if (n.type === "step") {
        stepNo += 1;
        const b = bodyOf(n);
        out.push(`### ${stepNo}. ${title(n) || "Étape"}`, "");
        out.push(...situationCallout(n, agentNames));
        out.push(...attachmentCallout(n, attached, inlined(n)));
        if (b) out.push(b, "");
        const v = outputVarOf(n.data as Record<string, unknown>);
        if (v) out.push(`**Résultat attendu :** range ce que produit cette étape dans \`${v}\`, et réutilise-le tel quel plus loin.`, "");
      } else if (n.type === "handoff") {
        // A handoff differs from a delegated step in one way that matters: it
        // states what comes BACK. A delegation with no return contract is how a
        // sub-agent hands over three paragraphs where a number was expected.
        const b = bodyOf(n);
        const ids = agentIdsOf(n.data as Record<string, unknown>);
        const who = ids.map((id) => agentNames.get(id) ?? `agent ${id.slice(0, 8)} (introuvable)`);
        const parallel = str(n.data?.mode) === "parallel" && ids.length > 1;
        out.push(`### ➜ Passation — ${title(n) || (who.join(", ") || "destinataire à définir")}`, "");
        out.push(`> **Confier à :** ${who.join(" · ") || "aucun agent choisi — à toi de le désigner"}`);
        out.push(`> **Mode :** ${parallel ? "en parallèle, les tâches sont indépendantes" : "l'un après l'autre"}`);
        if (str(n.data?.expects).trim()) out.push(`> **Ce qui doit revenir :** ${str(n.data?.expects).trim()}`);
        const extra = situationCallout(n, agentNames).filter((l) => !/^>\s*\*\*Confier à/.test(l));
        out.push(...extra.filter((l) => l.trim()));
        out.push(...attachmentCallout(n, attached, inlined(n)).filter((l) => l.trim()));
        out.push("");
        if (b) out.push(b, "");
        out.push(parallel
          ? "_Lance-les avec `spawn_parallel_agents`, une sous-tâche par destinataire, puis rassemble les retours._"
          : "_Délègue avec `delegate_mission`, et attends le retour avant de poursuivre._", "");
      } else if (n.type === "loop") {
        const b = bodyOf(n);
        const mode = str(n.data?.mode) || "foreach";
        const max = Number(n.data?.max) || 20;
        out.push(`### 🔁 Boucle — ${title(n) || (mode === "until" ? "jusqu'à" : "pour chaque")}`, "");
        out.push(...situationCallout(n, agentNames));
        out.push(...attachmentCallout(n, attached, inlined(n)));
        if (mode === "until") {
          out.push(`Répète les étapes ci-dessous **jusqu'à ce que** : ${str(n.data?.until) || "condition non définie"}.`);
        } else {
          out.push(`Répète les étapes ci-dessous **pour chaque** : ${str(n.data?.over) || "élément (liste non définie)"}.`);
          out.push("");
          out.push(`Si la liste dépasse une dizaine d'éléments, lance-les **en parallèle** avec \`spawn_parallel_agents\` (une sous-tâche par élément) plutôt qu'une par une.`);
        }
        // Without a written ceiling, a badly closed loop burns the whole run
        // budget — so the limit is part of the instruction, not a hidden guard.
        out.push("", `**Plafond : ${max} itérations.** Au-delà, arrête-toi et signale que la boucle n'a pas convergé.`);
        if (b) out.push("", b);
        // Name where each output leads, so "the steps below" is unambiguous.
        const leg = (handle: string, label: string) => {
          const targets = graph.edges
            .filter((e) => e.source === n.id && (e.sourceHandle ?? null) === handle)
            .map((e) => graph.nodes.find((x) => x.id === e.target)).filter(Boolean) as WfNode[];
          if (targets.length) out.push(`- **${label}** → ${targets.map((t) => title(t) || t.type).join(", ")}`);
        };
        out.push("");
        leg("body", "À répéter");
        leg("done", "Une fois terminé");
        out.push("");
      } else if (n.type === "decision") {
        const b = bodyOf(n);
        out.push(`### Décision — ${title(n) || "à trancher"}`, "");
        out.push(...attachmentCallout(n, attached, inlined(n)));
        if (b) out.push(b, "");
        const branch = (handle: string, label: string) => {
          const targets = graph.edges
            .filter((e) => e.source === n.id && (e.sourceHandle ?? null) === handle)
            .map((e) => graph.nodes.find((x) => x.id === e.target))
            .filter(Boolean) as WfNode[];
          if (targets.length) out.push(`- **${label}** → ${targets.map((t) => title(t) || t.type).join(", ")}`);
        };
        branch("true", "Si oui");
        branch("false", "Sinon");
        out.push("");
      } else {
        const b = bodyOf(n);
        out.push(`### ⏸ Validation humaine — ${title(n) || "à confirmer"}`, "");
        out.push(...attachmentCallout(n, attached, inlined(n)));
        out.push(b || "Demande la décision et attends la réponse avant de continuer.", "");
        out.push("_Utilise `ask_user` et n'enchaîne qu'une fois la réponse obtenue._", "");
      }
      void stepNo;
    }
  }

  section("Livrables attendus", of("deliverable"), (n) => {
    const format = str(n.data?.format) || "report";
    const lines = [`- **${title(n) || "Livrable"}** (${format})${body(n) ? ` — ${body(n)}` : ""}`];
    // A JSON deliverable is meant to be read by another program, so the shape is
    // part of the deliverable. Printed as a fence because "respect this schema"
    // in prose gets approximated; a fence gets copied.
    if (format === "json" && str(n.data?.schema).trim()) {
      lines.push("", "  Schéma exact attendu :", "", "```json", str(n.data?.schema).trim(), "```");
    }
    return lines;
  });

  // What must outlive the run. Without this, every run starts from the same
  // blank slate and re-learns what the previous one already found out.
  section("À mémoriser", of("memory"), (n) => {
    const scope = str(n.data?.scope) || "team";
    const where = scope === "personal" ? "pour toi seul" : scope === "workspace" ? "pour tout l'espace" : "pour l'équipe du service";
    return [
      `- **${title(n) || "À retenir"}** (${where})${body(n) ? ` — ${body(n)}` : ""}`,
      "",
      "  Enregistre-le avec `save_memory` avant de conclure, une seule fois, seulement si le run a produit un fait durable.",
    ];
  });

  section("Exemples", of("example"), (n) => [title(n) ? `**${title(n)}**` : "", body(n)].filter(Boolean));

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
