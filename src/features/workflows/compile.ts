import type { Node, Edge } from "reactflow";
import { contextBodyOf, contextSourceOf, paramsOf, agentIdsOf } from "./context";
import type { ContextRef } from "./context";
import type { BlockKind, WorkflowGraph } from "./model";

// Blocks ⇄ markdown. The ONLY compiler: the backend deliberately has none, and
// reads `agent_workflows.document` as given. Two copies of these rules, one in
// a Deno bundle and one here, would have diverged on the first change — and the
// canvas already saves both faces on every edit, so the second copy would only
// ever have been a slower way to disagree with this one.
//
// The round-trip works because every block is anchored in the document with an
// HTML comment. Without those anchors, editing the markdown would rebuild a
// fresh graph and destroy the canvas layout on every save.

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

const anchor = (id: string) => `<!-- b:${id} -->`;
const ANCHOR_RE = /^<!--\s*b:([A-Za-z0-9_-]+)\s*-->\s*$/;

/**
 * The order the blocks are READ in. Edges carry sequence, not execution, so
 * this is a walk from the trigger following outgoing edges, depth first — so a
 * decision's branches stay together instead of interleaving.
 *
 * Blocks the walk never reaches are appended rather than dropped: an unlinked
 * block is someone's work in progress, and silently deleting it from the
 * document is the one behaviour nobody forgives.
 */
function readingOrder(g: WorkflowGraph): Node[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out: Node[] = [];
  const seen = new Set<string>();

  const visit = (id: string) => {
    if (seen.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    seen.add(id);
    out.push(node);
    for (const e of g.edges.filter((x) => x.source === id)) visit(e.target);
  };

  const roots = g.nodes.filter((n) => n.type === "trigger" || !g.edges.some((e) => e.target === n.id));
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

const refsOf = (n: Node): ContextRef[] => (Array.isArray(n.data?.refs) ? (n.data.refs as ContextRef[]) : []);

/**
 * What a context block contributes to the document. A context block has ONE
 * source — written text, or collections — and the document must say which,
 * because the two are read very differently: written text is knowledge the
 * agent already has, collections are places it must go and look.
 *
 * The inactive source is left in the block but never printed. That is the point
 * of the switch: toggling it changes the document, not the stored block.
 */
function contextLines(n: Node): string[] {
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
function situationCallout(n: Node, agentNames: Map<string, string>): string[] {
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

export function compileWorkflow(
  wf: { name: string; description?: string | null },
  graph: WorkflowGraph,
  /** agent id → name, for the delegation callouts. */
  agentNames: Map<string, string> = new Map(),
): string {
  const ordered = readingOrder(graph);
  const of = (k: BlockKind) => ordered.filter((n) => n.type === k);
  const body = (n: Node) => str(n.data?.body).trim();
  const title = (n: Node) => str(n.data?.label).trim();

  const out: string[] = [];
  const trigger = of("trigger")[0];

  out.push("---");
  out.push(`workflow: ${wf.name}`);
  out.push(`déclencheur: ${trigger ? triggerLine(trigger.data as Record<string, unknown>) : "lancement manuel"}`);
  out.push("---", "");
  out.push(`# ${wf.name}`, "");
  if (wf.description?.trim()) out.push(wf.description.trim(), "");

  const section = (heading: string, nodes: Node[], render: (n: Node) => string[]) => {
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
    const tool = str(n.data?.tool).trim();
    if (!tool) return [];
    const must = n.data?.required !== false;
    return [`- \`${tool}\`${must ? "" : " — si besoin"}${title(n) ? ` · ${title(n)}` : ""}${body(n) ? ` — ${body(n)}` : ""}`];
  });

  // The procedure keeps the reading order across step/decision/approval, so a
  // decision sits between the steps it separates — which is how a procedure is
  // actually read.
  const proc = ordered.filter((n) => ["step", "decision", "loop", "approval", "handoff"].includes(n.type ?? "")
    || (n.type === "context" && str(n.data?.scope) === "local"));
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
      } else if (n.type === "step") {
        stepNo += 1;
        out.push(`### ${stepNo}. ${title(n) || "Étape"}`, "");
        out.push(...situationCallout(n, agentNames));
        if (body(n)) out.push(body(n), "");
      } else if (n.type === "handoff") {
        // A handoff differs from a delegated step in one way that matters: it
        // states what comes BACK. A delegation with no return contract is how a
        // sub-agent hands over three paragraphs where a number was expected.
        const ids = agentIdsOf(n.data as Record<string, unknown>);
        const who = ids.map((id) => agentNames.get(id) ?? `agent ${id.slice(0, 8)} (introuvable)`);
        const parallel = str(n.data?.mode) === "parallel" && ids.length > 1;
        out.push(`### ➜ Passation — ${title(n) || (who.join(", ") || "destinataire à définir")}`, "");
        out.push(`> **Confier à :** ${who.join(" · ") || "aucun agent choisi — à toi de le désigner"}`);
        out.push(`> **Mode :** ${parallel ? "en parallèle, les tâches sont indépendantes" : "l'un après l'autre"}`);
        if (str(n.data?.expects).trim()) out.push(`> **Ce qui doit revenir :** ${str(n.data?.expects).trim()}`);
        const extra = situationCallout(n, agentNames).filter((l) => !/^>\s*\*\*Confier à/.test(l));
        out.push(...extra.filter((l) => l.trim()));
        out.push("");
        if (body(n)) out.push(body(n), "");
        out.push(parallel
          ? "_Lance-les avec `spawn_parallel_agents`, une sous-tâche par destinataire, puis rassemble les retours._"
          : "_Délègue avec `delegate_mission`, et attends le retour avant de poursuivre._", "");
      } else if (n.type === "loop") {
        const mode = str(n.data?.mode) || "foreach";
        const max = Number(n.data?.max) || 20;
        out.push(`### 🔁 Boucle — ${title(n) || (mode === "until" ? "jusqu'à" : "pour chaque")}`, "");
        out.push(...situationCallout(n, agentNames));
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
        if (body(n)) out.push("", body(n));
        // Name where each output leads, so "the steps below" is unambiguous.
        const leg = (handle: string, label: string) => {
          const targets = graph.edges
            .filter((e) => e.source === n.id && (e.sourceHandle ?? null) === handle)
            .map((e) => graph.nodes.find((x) => x.id === e.target)).filter(Boolean) as Node[];
          if (targets.length) out.push(`- **${label}** → ${targets.map((t) => title(t) || t.type).join(", ")}`);
        };
        out.push("");
        leg("body", "À répéter");
        leg("done", "Une fois terminé");
        out.push("");
      } else if (n.type === "decision") {
        out.push(`### Décision — ${title(n) || "à trancher"}`, "");
        if (body(n)) out.push(body(n), "");
        const branch = (handle: string, label: string) => {
          const targets = graph.edges
            .filter((e) => e.source === n.id && (e.sourceHandle ?? null) === handle)
            .map((e) => graph.nodes.find((x) => x.id === e.target))
            .filter(Boolean) as Node[];
          if (targets.length) out.push(`- **${label}** → ${targets.map((t) => title(t) || t.type).join(", ")}`);
        };
        branch("true", "Si oui");
        branch("false", "Sinon");
        out.push("");
      } else {
        out.push(`### ⏸ Validation humaine — ${title(n) || "à confirmer"}`, "");
        out.push(body(n) || "Demande la décision et attends la réponse avant de continuer.", "");
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
  let cur: Draft | null = null;
  let seq = 0;
  const newId = (k: BlockKind) => `${k}-${Date.now().toString(36)}${(seq++).toString(36)}`;
  const flush = () => { if (cur) { drafts.push(cur); cur = null; } };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");

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
    if (/^>\s?/.test(line) && (cur?.kind === "step" || cur?.kind === "loop" || cur?.kind === "handoff")) continue;

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
  const edges: Edge[] = previous.edges.filter((e) => kept.has(e.source) && kept.has(e.target));
  return { nodes, edges };
}
