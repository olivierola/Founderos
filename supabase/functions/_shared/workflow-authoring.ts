import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  BLOCK_DOC, BLOCK_KINDS, isBlockKind, roleOf, compileWorkflow,
  attachmentsByTarget, targetsOfQualifier, flowEdges, isAttachEdge,
  ATTACH_HANDLE, APPLIES_HANDLE, codeToolOf, outputVarOf,
  type BlockKind, type WfGraph, type WfNode, type WfEdge,
} from "./workflow-doc.ts";
import { isAutomationBlock, testsOf } from "./automation-engine.ts";

/** Les deux natures. Elles ne se construisent pas pareil et ne s exécutent pas
 *  pareil, donc chaque outil d écriture doit savoir laquelle il manipule —
 *  sinon l assistant fabrique une automatisation pleine de consignes rédigées
 *  que le moteur sautera en silence. */
export type WfKind = "procedure" | "automation";
const kindOf = (v: unknown): WfKind => (String(v ?? "") === "automation" ? "automation" : "procedure");

// Building a workflow, from the agent's side.
//
// Until now an assistant asked for a procedure could only WRITE it — a markdown
// document that the canvas parsed back into a stack of unlinked blocks the first
// time a human opened it. The graph was never really built: no branches, no
// attachments, nothing wired. Here the assistant builds the real thing, block by
// block, and every call keeps the two faces of a workflow in sync — the graph
// AND the compiled playbook — because the runtime refuses to launch a workflow
// whose document is empty, and rightly so.
//
// The rules of the canvas are enforced here too, and they are the same rules:
// this module and the editor share one workflow language (workflow-doc.ts), so
// what an agent assembles is exactly what a human sees and can then edit by
// hand. A tool that produced graphs the editor could not open would be worse
// than no tool at all.

type Admin = SupabaseClient;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

export interface WorkflowRow {
  id: string;
  workspace_id: string;
  project_id: string;
  service_dashboard_id: string | null;
  name: string;
  description: string | null;
  status: string;
  kind?: string | null;
  blocks: WfGraph;
  document: string;
}

const emptyGraph = (): WfGraph => ({ nodes: [], edges: [] });

export function normalizeGraph(g: unknown): WfGraph {
  const raw = (g ?? {}) as Partial<WfGraph>;
  return {
    nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw.edges) ? raw.edges : [],
  };
}

/**
 * Where a new block lands.
 *
 * Not cosmetic: the canvas is how a human reads the procedure afterwards, and a
 * pile of blocks at the same coordinates is unreadable. Actions go down the
 * spine; qualifiers sit to the LEFT of what they qualify, which is the side
 * their port is on, so the attachment edge is a short horizontal tie rather
 * than a line crossing the whole graph.
 */
function placeBlock(graph: WfGraph, kind: BlockKind, attachTo?: WfNode | null): { x: number; y: number } {
  const role = roleOf(kind);
  if (role === "qualifier" && attachTo?.position) {
    const siblings = (attachmentsByTarget(graph.nodes, graph.edges).get(attachTo.id) ?? []).length;
    return { x: attachTo.position.x - 300, y: attachTo.position.y + siblings * 120 };
  }
  const lowest = graph.nodes.reduce((max, n) => Math.max(max, n.position?.y ?? 0), 40);
  return { x: role === "qualifier" ? -40 : 260, y: lowest + 150 };
}

const newId = (kind: string) => `${kind}-${Math.random().toString(36).slice(2, 8)}`;

/** The last block of the flow — what a new action chains onto by default. */
function tailOfFlow(graph: WfGraph): WfNode | null {
  const flow = flowEdges(graph.edges);
  const actions = graph.nodes.filter((n) => roleOf(n.type) !== "qualifier");
  if (actions.length === 0) return null;
  const withoutSuccessor = actions.filter((n) => !flow.some((e) => e.source === n.id));
  const pool = withoutSuccessor.length ? withoutSuccessor : actions;
  return pool.reduce((acc, n) => (!acc || (n.position?.y ?? 0) > (acc.position?.y ?? 0) ? n : acc), null as WfNode | null);
}

export interface LinkVerdict { ok: boolean; reason?: string }

/** The same rules the canvas enforces on a drag — see graph.ts#verifyConnection.
 *  An agent that could draw an edge a human cannot would produce a graph the
 *  editor refuses to explain. */
export function verifyLink(graph: WfGraph, sourceId: string, targetId: string, attach: boolean, handle?: string | null): LinkVerdict {
  if (sourceId === targetId) return { ok: false, reason: "un bloc ne peut pas se relier à lui-même" };
  const src = graph.nodes.find((n) => n.id === sourceId);
  const dst = graph.nodes.find((n) => n.id === targetId);
  if (!src) return { ok: false, reason: `bloc source « ${sourceId} » introuvable` };
  if (!dst) return { ok: false, reason: `bloc cible « ${targetId} » introuvable` };

  const already = graph.edges.some((e) =>
    e.source === sourceId && e.target === targetId
    && (e.sourceHandle ?? null) === (attach ? APPLIES_HANDLE : (handle ?? null))
    && (e.targetHandle ?? null) === (attach ? ATTACH_HANDLE : null));
  if (already) return { ok: false, reason: "ces deux blocs sont déjà reliés ainsi" };

  if (attach) {
    if (roleOf(src.type) !== "qualifier") {
      return { ok: false, reason: `« ${src.type} » ne s'attache pas : seuls contexte, règle, ressource, outil, livrable et mémoire le peuvent` };
    }
    if (roleOf(dst.type) !== "action") {
      return { ok: false, reason: "on n'attache un cadrage qu'à une action (étape, boucle, décision, passation, validation)" };
    }
    return { ok: true };
  }

  if (dst.type === "trigger") return { ok: false, reason: "le déclencheur ouvre la procédure : rien ne le précède" };
  // Flow cycles: readingOrder dedupes, so a loop does not hang — it silently
  // truncates the document where the walk folds back, which is worse.
  const next = new Map<string, string[]>();
  for (const e of flowEdges(graph.edges)) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const seen = new Set<string>();
  const stack = [targetId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === sourceId) return { ok: false, reason: "ce lien refermerait la procédure sur elle-même" };
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return { ok: true };
}

export function addEdge(graph: WfGraph, sourceId: string, targetId: string, attach: boolean, handle?: string | null): WfEdge {
  const edge: WfEdge = {
    id: `${attach ? "a" : "e"}-${sourceId}-${targetId}-${Math.random().toString(36).slice(2, 6)}`,
    source: sourceId, target: targetId,
    sourceHandle: attach ? APPLIES_HANDLE : (handle ?? null),
    targetHandle: attach ? ATTACH_HANDLE : null,
  };
  graph.edges.push(edge);
  return edge;
}

/**
 * What is wrong with this workflow, in the words of someone who would have to
 * run it. Returned by every tool call, because an agent that cannot see the
 * canvas has no other way to notice that it wired a decision with one branch.
 */
export function reviewGraph(graph: WfGraph, kind: WfKind = "procedure"): string[] {
  const problems: string[] = [];
  const flow = flowEdges(graph.edges);
  const auto = kind === "automation";
  const actions = graph.nodes.filter((n) => roleOf(n.type) === "action");
  if (actions.length === 0) problems.push("Aucune action : une procédure sans étape ne fait rien.");

  // Les variables : deux blocs qui rangent leur résultat sous le même nom, et
  // le second écrase le premier sans que rien ne le dise.
  const seenVars = new Set<string>();
  for (const n of graph.nodes) {
    const v = outputVarOf((n.data ?? {}) as Record<string, unknown>);
    if (!v) continue;
    if (seenVars.has(v)) problems.push(`Deux blocs rangent leur résultat dans « ${v} » : le second écrasera le premier.`);
    seenVars.add(v);
  }

  for (const n of graph.nodes) {
    const d = (n.data ?? {}) as Record<string, unknown>;
    const name = str(d.label).trim() || n.type;

    // ── Ce qu'une AUTOMATISATION ne sait pas faire ──────────────────────────
    // Le moteur ne lit rien : il exécute. Un bloc qu'il ne sait pas exécuter
    // est sauté, en silence pour qui n'ouvre pas le journal — donc il faut le
    // dire au moment où on le construit, pas au premier run raté.
    if (auto && n.type !== "trigger" && !isAutomationBlock(n.type)) {
      problems.push(`« ${name} » (${n.type}) ne s'exécute pas dans une automatisation : le moteur le sautera. Une consigne rédigée n'a de sens que pour un agent qui la lit.`);
      continue;
    }
    if (auto && n.type === "tool") {
      const hasAction = !!str(d.provider).trim() && !!str(d.action).trim();
      const hasCode = !!codeToolOf(d) && !!str(d.code).trim();
      if (!hasAction && !hasCode) {
        problems.push(`Action « ${name} » : ni application+action choisies, ni code écrit — le moteur n'aura rien à exécuter.`);
      }
    }
    if (auto && n.type === "decision") {
      // Une condition, ou plusieurs (`tests` + `match` all/any).
      if (testsOf(d).length === 0) {
        problems.push(`Condition « ${name} » : incomplète. Une automatisation n'interprète pas une phrase — il faut une donnée, un opérateur, et une valeur.`);
      }
    }
    if (n.type === "decision") {
      for (const [h, label] of [["true", "si oui"], ["false", "sinon"]] as const) {
        if (!flow.some((e) => e.source === n.id && e.sourceHandle === h)) {
          problems.push(`Décision « ${name} » : la branche « ${label} » ne mène nulle part.`);
        }
      }
    }
    if (n.type === "loop" && !flow.some((e) => e.source === n.id && e.sourceHandle === "body")) {
      problems.push(`Boucle « ${name} » : rien n'est relié à sa sortie « répéter ».`);
    }
    if (n.type === "handoff" && (!Array.isArray(d.agent_ids) || (d.agent_ids as unknown[]).length === 0)) {
      problems.push(`Passation « ${name} » : aucun destinataire — elle n'aura jamais lieu.`);
    }
    if (n.type === "tool" && !str(d.tool).trim()) problems.push(`Bloc outil « ${name} » : aucun outil nommé.`);
    if (roleOf(n.type) === "action" && !str(d.body).trim() && !str(d.label).trim()) {
      problems.push(`Une action est vide : ni titre ni consigne.`);
    }
    // An unreachable block still lands in the document (appended), which is how
    // an agent ends up wondering why its step is in the wrong order.
    if (n.type !== "trigger" && roleOf(n.type) !== "qualifier"
      && !flow.some((e) => e.target === n.id) && graph.nodes.length > 1) {
      problems.push(`« ${name} » n'est relié à rien : il sera lu en fin de document, pas à sa place.`);
    }
  }
  return problems;
}

/** The graph as a compact outline — what the agent reads back between calls
 *  instead of re-sending the whole JSON. */
export function outlineGraph(graph: WfGraph): string {
  if (graph.nodes.length === 0) return "(vide)";
  const attached = attachmentsByTarget(graph.nodes, graph.edges);
  const flow = flowEdges(graph.edges);
  const lines: string[] = [];
  for (const n of graph.nodes) {
    const d = (n.data ?? {}) as Record<string, unknown>;
    const name = str(d.label).trim() || "(sans titre)";
    const qs = (attached.get(n.id) ?? []).map((q) => `${q.type}:${q.id}`);
    const outs = flow.filter((e) => e.source === n.id)
      .map((e) => `${e.sourceHandle ? `${e.sourceHandle}→` : "→"}${e.target}`);
    const scope = roleOf(n.type) === "qualifier"
      ? (targetsOfQualifier(graph.nodes, graph.edges, n.id).length
        ? ` [attaché à ${targetsOfQualifier(graph.nodes, graph.edges, n.id).map((t) => t.id).join(", ")}]`
        : " [global]")
      : "";
    lines.push(
      `- ${n.id} (${n.type}) « ${name} »${scope}`
      + (qs.length ? ` · cadrage: ${qs.join(", ")}` : "")
      + (outs.length ? ` · suite: ${outs.join(", ")}` : ""),
    );
  }
  return lines.join("\n");
}

/**
 * Save both faces, always together.
 *
 * The runtime reads `document` and refuses an empty one; the canvas reads
 * `blocks`. Writing one without the other is exactly how they drift — so this
 * is the only way this module writes, and it recompiles on every call.
 */
export async function saveWorkflow(admin: Admin, wf: WorkflowRow, graph: WfGraph): Promise<string> {
  // Agent names for the delegation callouts — a stale id must print as a
  // problem to fix, not vanish into an unassigned step.
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    const d = (n.data ?? {}) as Record<string, unknown>;
    if (str(d.agent_id)) ids.add(str(d.agent_id));
    for (const a of Array.isArray(d.agent_ids) ? (d.agent_ids as unknown[]) : []) ids.add(String(a));
  }
  let names = new Map<string, string>();
  if (ids.size) {
    const { data } = await admin.from("internal_agents").select("id, name").in("id", [...ids]);
    names = new Map(((data ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
  }
  const document = compileWorkflow({ name: wf.name, description: wf.description }, graph, names);
  const { error } = await admin.from("agent_workflows")
    .update({ blocks: graph, document, updated_at: new Date().toISOString() })
    .eq("id", wf.id);
  if (error) throw new Error(error.message);
  return document;
}

/** The block vocabulary, for the tool description — written from BLOCK_DOC so a
 *  new kind never has to be repeated in a prompt. */
/** Les types disponibles POUR CETTE NATURE. Une automatisation n'exécute que
 *  des actions, des conditions et des passations : lui proposer « étape » ou
 *  « objectif » ferait écrire des consignes que le moteur sautera. */
export function kindCatalogue(kind: WfKind = "procedure"): string {
  return BLOCK_KINDS
    .filter((k) => k !== "trigger")
    .filter((k) => (kind === "automation" ? isAutomationBlock(k) : true))
    .map((k) => `${k} (${roleOf(k)} → ${BLOCK_DOC[k].compiles})`)
    .join(", ");
}


// ─────────────────────────────────────────────────────────────────────────────
// The five operations, as plain functions.
//
// Two very different toolboxes call them — the internal-agent runtime and the
// SaaS assistant in the right-hand panel — and both must build the SAME
// workflows. So the logic lives here once and each side wraps it in its own
// tool shape; the alternative was two copies drifting apart, which is the exact
// failure this module was extracted to avoid in the first place.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthoringScope {
  admin: Admin;
  workspaceId: string;
  projectId: string;
  /** Where the workflow lives. A workflow always belongs to a service. */
  dashboardId: string;
  userId: string | null;
}

/** Load a workflow the caller may edit — same project, same service. A workflow
 *  from another service is not "not found", it is out of scope, and saying so
 *  beats a silent no-op. */
async function loadWorkflow(scope: AuthoringScope, id: string): Promise<WorkflowRow | string> {
  const { data } = await scope.admin.from("agent_workflows")
    .select("id, workspace_id, project_id, service_dashboard_id, name, description, status, kind, blocks, document")
    .eq("id", id).maybeSingle();
  if (!data) return "ERROR: workflow introuvable — vérifie l'id rendu par workflow_create.";
  const wf = data as unknown as WorkflowRow;
  if (wf.project_id !== scope.projectId || (wf.service_dashboard_id && wf.service_dashboard_id !== scope.dashboardId)) {
    return "ERROR: ce workflow appartient à un autre service — tu ne peux modifier que ceux du tien.";
  }
  return { ...wf, blocks: normalizeGraph(wf.blocks) };
}

/** Every call answers the same way: what changed, what the graph looks like now,
 *  and what is still wrong. A caller that cannot see the canvas needs the state
 *  back or it works blind. */
function report(graph: WfGraph, done: string, kind: WfKind = "procedure"): string {
  const problems = reviewGraph(graph, kind);
  return [
    done,
    "",
    "ÉTAT DU WORKFLOW :",
    outlineGraph(graph),
    problems.length ? "\nÀ CORRIGER :\n" + problems.map((p) => "- " + p).join("\n") : "\nRien à corriger.",
  ].join("\n");
}

export async function wfCreate(scope: AuthoringScope, args: Record<string, unknown>): Promise<string> {
  const name = str(args.name).trim().slice(0, 120);
  if (!name) return "ERROR: name est requis.";
  const kind = kindOf(args.kind);
  const auto = kind === "automation";
  // Une PROCÉDURE n'est pas déclenchée : un agent la consulte quand il
  // rencontre la situation décrite. Lui poser un cron n'aurait aucun effet, et
  // laisserait croire qu'elle tourne toute seule.
  const mode = auto && ["manual", "schedule", "event", "webhook"].includes(str(args.trigger))
    ? str(args.trigger)
    : "manual";
  const graph: WfGraph = {
    nodes: [{
      id: "trigger-1", type: "trigger", position: { x: 260, y: 40 },
      data: { ...BLOCK_DOC.trigger.defaults, mode, schedule: str(args.schedule) || "0 9 * * 1" },
    }],
    edges: [],
  };
  const { data, error } = await scope.admin.from("agent_workflows").insert({
    workspace_id: scope.workspaceId, project_id: scope.projectId, service_dashboard_id: scope.dashboardId,
    name, description: str(args.description).trim().slice(0, 2000) || null,
    created_by: scope.userId, blocks: graph, document: "", status: "draft", kind,
  }).select("id").single();
  if (error || !data) return "ERROR: " + (error?.message ?? "création impossible");
  const id = (data as { id: string }).id;

  return [
    (auto ? "Automatisation « " : "Procédure « ") + name + " » créée (id " + id + "), encore vide.",
    auto
      ? "Déclencheur : " + mode + ". Le MOTEUR l'exécutera lui-même, sans modèle — donc chaque bloc doit être exécutable : "
        + "une action nomme une application et son action (ou porte du code), une condition compare une donnée à une valeur."
      : "Une procédure ne se déclenche pas : un agent la consulte quand il rencontre la situation décrite dans sa description. "
        + "Soigne cette description — c'est à elle qu'il la reconnaîtra.",
    "Types disponibles ici : " + kindCatalogue(kind) + ".",
    "Construis-le maintenant, bloc par bloc, avec workflow_add_block(workflow_id=\"" + id + "\", kind=…). "
      + "N'annonce pas qu'il est prêt avant workflow_activate.",
  ].join("\n");
}

export async function wfAddBlock(scope: AuthoringScope, args: Record<string, unknown>): Promise<string> {
  const wf = await loadWorkflow(scope, str(args.workflow_id));
  if (typeof wf === "string") return wf;
  const wfKind = kindOf(wf.kind);
  const kind = str(args.kind).trim();
  if (!isBlockKind(kind)) return "ERROR: type « " + kind + " » inconnu. Types disponibles : " + kindCatalogue(wfKind) + ".";
  if (kind === "trigger") return "ERROR: le déclencheur existe déjà — modifie-le avec workflow_configure.";
  // Refusé À L'ÉCRITURE, pas signalé après coup : un bloc que le moteur saute
  // en silence est plus coûteux à diagnostiquer qu'un refus immédiat.
  if (wfKind === "automation" && !isAutomationBlock(kind)) {
    return "ERROR: « " + kind + " » n'est pas exécutable par le moteur d'automatisation — il le sauterait. "
      + "Une automatisation n'enchaîne que : " + kindCatalogue("automation") + ". "
      + "Si ce travail demande du jugement, écris une PROCÉDURE (un agent la lira), ou pose un bloc « handoff » pour lui passer la main ici.";
  }

  const graph = wf.blocks;
  const role = roleOf(kind);
  const attachToId = str(args.attach_to).trim();
  const attachTo = attachToId ? graph.nodes.find((n) => n.id === attachToId) ?? null : null;
  if (attachToId && !attachTo) return "ERROR: bloc « " + attachToId + " » introuvable pour attach_to.";

  const id = newId(kind);
  const config = (args.config && typeof args.config === "object" ? args.config : {}) as Record<string, unknown>;
  graph.nodes.push({
    id, type: kind, position: placeBlock(graph, kind as BlockKind, attachTo),
    data: {
      ...BLOCK_DOC[kind as BlockKind].defaults,
      ...config,
      label: str(args.label).trim() || str(config.label),
      body: str(args.body) || str(config.body),
    },
  });

  const done: string[] = ["Bloc « " + kind + " » ajouté (id " + id + ")."];
  if (attachTo) {
    const v = verifyLink(graph, id, attachTo.id, true);
    if (!v.ok) { graph.nodes.pop(); return "ERROR: attachement refusé — " + v.reason + "."; }
    addEdge(graph, id, attachTo.id, true);
    done.push("Attaché à " + attachTo.id + " : il ne vaut que pour cette action, et n'écrira pas de section globale.");
  } else if (role !== "qualifier") {
    const afterId = str(args.after).trim();
    const after = afterId
      ? graph.nodes.find((n) => n.id === afterId)
      : tailOfFlow({ nodes: graph.nodes.filter((n) => n.id !== id), edges: graph.edges });
    if (afterId && !after) return "ERROR: bloc « " + afterId + " » introuvable pour after.";
    if (after) {
      const branch = ["true", "false", "body", "done"].includes(str(args.branch)) ? str(args.branch) : null;
      const v = verifyLink(graph, after.id, id, false, branch);
      if (!v.ok) { graph.nodes.pop(); return "ERROR: enchaînement refusé — " + v.reason + "."; }
      addEdge(graph, after.id, id, false, branch);
      done.push("Enchaîné après " + after.id + (branch ? " (branche « " + branch + " »)" : "") + ".");
    }
  } else {
    done.push("Non attaché : il vaudra pour TOUTE la procédure. Passe attach_to pour le restreindre à une action.");
  }

  await saveWorkflow(scope.admin, wf, graph);
  return report(graph, done.join(" "), kindOf(wf.kind));
}

export async function wfLink(scope: AuthoringScope, args: Record<string, unknown>): Promise<string> {
  const wf = await loadWorkflow(scope, str(args.workflow_id));
  if (typeof wf === "string") return wf;
  const graph = wf.blocks;
  const from = str(args.from).trim();
  const to = str(args.to).trim();
  const mode = str(args.mode);

  if (mode === "unlink") {
    const before = graph.edges.length;
    graph.edges = graph.edges.filter((e) => !(e.source === from && e.target === to));
    if (graph.edges.length === before) return "Aucun lien entre " + from + " et " + to + " — rien retiré.";
    await saveWorkflow(scope.admin, wf, graph);
    return report(graph, "Lien retiré entre " + from + " et " + to + ".", kindOf(wf.kind));
  }

  const attach = mode === "attach";
  const branch = ["true", "false", "body", "done"].includes(str(args.branch)) ? str(args.branch) : null;
  const v = verifyLink(graph, from, to, attach, branch);
  if (!v.ok) return "ERROR: lien refusé — " + v.reason + ".";
  addEdge(graph, from, to, attach, branch);
  await saveWorkflow(scope.admin, wf, graph);
  return report(graph, attach
    ? from + " ne vaut plus que pour " + to + "."
    : to + " suit désormais " + from + (branch ? " (branche « " + branch + " »)" : "") + ".",
    kindOf(wf.kind));
}

export async function wfConfigure(scope: AuthoringScope, args: Record<string, unknown>): Promise<string> {
  const wf = await loadWorkflow(scope, str(args.workflow_id));
  if (typeof wf === "string") return wf;
  const graph = wf.blocks;
  const blockId = str(args.block_id).trim();

  if (!blockId) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (str(args.name).trim()) patch.name = str(args.name).trim().slice(0, 120);
    if (args.description !== undefined) patch.description = str(args.description).trim().slice(0, 2000) || null;
    if (Object.keys(patch).length === 1) return "ERROR: rien à modifier — donne block_id, ou name/description.";
    const { error } = await scope.admin.from("agent_workflows").update(patch).eq("id", wf.id);
    if (error) return "ERROR: " + error.message;
    const updated = { ...wf, name: str(patch.name) || wf.name, description: (patch.description as string) ?? wf.description };
    await saveWorkflow(scope.admin, updated, graph);
    return report(graph, "Workflow mis à jour.", kindOf(wf.kind));
  }

  const node = graph.nodes.find((n) => n.id === blockId);
  if (!node) return "ERROR: bloc « " + blockId + " » introuvable.\n" + outlineGraph(graph);

  if (args.remove === true) {
    if (node.type === "trigger") return "ERROR: le déclencheur ne se supprime pas — change son mode avec config.";
    graph.nodes = graph.nodes.filter((n) => n.id !== blockId);
    graph.edges = graph.edges.filter((e) => e.source !== blockId && e.target !== blockId);
    await saveWorkflow(scope.admin, wf, graph);
    return report(graph, "Bloc " + blockId + " supprimé, avec ses liens.", kindOf(wf.kind));
  }

  const config = (args.config && typeof args.config === "object" ? args.config : {}) as Record<string, unknown>;
  node.data = { ...(node.data ?? {}), ...config };
  if (args.label !== undefined) node.data.label = str(args.label);
  if (args.body !== undefined) node.data.body = str(args.body);
  await saveWorkflow(scope.admin, wf, graph);
  return report(graph, "Bloc " + blockId + " (" + node.type + ") mis à jour.", kindOf(wf.kind));
}

export async function wfActivate(scope: AuthoringScope, args: Record<string, unknown>): Promise<string> {
  const wf = await loadWorkflow(scope, str(args.workflow_id));
  if (typeof wf === "string") return wf;
  const graph = wf.blocks;
  const status = ["active", "draft", "paused"].includes(str(args.status)) ? str(args.status) : "active";
  const kind = kindOf(wf.kind);
  const problems = reviewGraph(graph, kind);
  const blocking = problems.filter((p) =>
    /Aucune action|ne mène nulle part|aucun destinataire|aucun outil nommé|rien à exécuter|incomplète|sautera/.test(p));
  if (status === "active" && blocking.length) {
    return "ERROR: pas activable en l'état :\n" + blocking.map((p) => "- " + p).join("\n")
      + "\nCorrige avec workflow_configure, puis rappelle workflow_activate.";
  }
  const document = await saveWorkflow(scope.admin, wf, graph);
  const { error } = await scope.admin.from("agent_workflows")
    .update({ status, updated_at: new Date().toISOString() }).eq("id", wf.id);
  if (error) return "ERROR: " + error.message;
  return [
    "Workflow « " + wf.name + " » enregistré et passé en « " + status + " »"
      + (status === "active"
        ? (kind === "automation"
          ? " — ses déclencheurs sont armés."
          : " — les agents du service peuvent maintenant s'en servir avec use_procedure.")
        : "."),
    problems.length ? "Réserves : " + problems.join(" · ") : "",
    "",
    "Procédure compilée :",
    document.length > 2000 ? document.slice(0, 2000) + "\n… (tronqué)" : document,
  ].filter(Boolean).join("\n");
}

/**
 * The workflows already there.
 *
 * Without this, an assistant standing on an open workflow page could not act on
 * it: it has the NAME on screen and no id, so its only move was to create a
 * second one — or, worse, to describe changes to the one it could not touch.
 */
export async function wfList(scope: AuthoringScope, _args: Record<string, unknown>): Promise<string> {
  const { data } = await scope.admin.from("agent_workflows")
    .select("id, name, status, kind, blocks, updated_at")
    .eq("service_dashboard_id", scope.dashboardId)
    .neq("status", "archived")
    .order("updated_at", { ascending: false }).limit(30);
  const rows = (data ?? []) as Array<{ id: string; name: string; status: string; kind?: string | null; blocks: unknown }>;
  if (rows.length === 0) return "Aucun workflow dans ce service. workflow_create pour en poser un.";
  return rows.map((r) => {
    const g = normalizeGraph(r.blocks);
    const blocks = g.nodes.filter((n) => n.type !== "trigger").length;
    // La nature est dans la liste : elle décide de ce qu'on peut y ajouter, et
    // la découvrir seulement au moment d'un refus fait perdre un aller-retour.
    return "- " + r.id + " · « " + r.name + " » (" + kindOf(r.kind) + ", " + r.status + ", "
      + (blocks === 0 ? "VIDE — rien de construit" : blocks + " bloc" + (blocks > 1 ? "s" : "")) + ")";
  }).join("\n") + "\n\nReprends-en un avec son id, ou crée-en un nouveau.";
}

/** The schemas, shared by both toolboxes so the two never drift. */
export function workflowToolDefs() {
  return [
    {
      name: "workflow_list",
      run: wfList,
      description:
        "Liste les workflows du service, avec leur id, leur état et leur nombre de blocs. "
        + "Appelle-la EN PREMIER quand l'utilisateur parle d'un workflow qui existe déjà (il est souvent ouvert devant lui) : "
        + "tous les autres outils ont besoin de son id, et créer un doublon à côté du sien est le pire résultat possible.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "workflow_create",
      run: wfCreate,
      description:
        "Crée un workflow VIDE et rend son id. DEUX natures, et ce choix compte plus que tout le reste. "
        + "kind=\"procedure\" : des instructions écrites POUR UN AGENT — il les consulte quand il rencontre la situation "
        + "décrite dans la description, et décide comment faire. À choisir dès qu'il y a du jugement (une réclamation, "
        + "une analyse, une réponse à rédiger) ; elle ne se déclenche PAS toute seule. "
        + "kind=\"automation\" : une suite d'appels que le MOTEUR exécute lui-même, sans modèle, à l'identique à chaque fois. "
        + "À choisir quand il n'y a rien à juger (« chaque lundi 9 h, récupérer les deals et les poster dans Slack ») ; "
        + "elle seule a un déclencheur. "
        + "Dans le doute, une question suffit : y a-t-il une décision qui dépend du CONTENU ? Oui → procédure, non → automatisation. "
        + "N'écris JAMAIS un workflow sous forme de document ou de récapitulatif : construis-le avec ces outils, sinon il n'existe pas.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nom court, ce que le workflow accomplit." },
          kind: { type: "string", enum: ["procedure", "automation"], description: "procedure (un agent lit et décide) ou automation (le moteur exécute). Défaut : procedure." },
          description: {
            type: "string",
            description: "Pour une PROCÉDURE, c'est le mécanisme lui-même : la situation à laquelle un agent la reconnaîtra "
              + "(« quand un client signale une commande abîmée… »). Pour une automatisation, ce qu'elle fait.",
          },
          trigger: { type: "string", enum: ["manual", "schedule", "event", "webhook"], description: "AUTOMATISATION uniquement — comment elle se lance (manual par défaut). Ignoré pour une procédure, qui n'a pas de déclencheur." },
          schedule: { type: "string", description: "Expression cron si trigger=schedule (ex. 0 8 * * 1 = lundi 8 h UTC)." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "workflow_add_block",
      run: wfAddBlock,
      description:
        "Ajoute UN bloc au workflow et le relie. Types (procédure) : " + kindCatalogue("procedure") + ". "
        + "Une AUTOMATISATION n'accepte que : " + kindCatalogue("automation") + " — tout le reste y serait sauté par le moteur. "
        + "Deux relations : la SÉQUENCE (le bloc s'enchaîne après le précédent, ou après « after ») et l'ATTACHEMENT "
        + "(« attach_to » : un contexte, une règle, un outil, un livrable ne valent QUE pour l'action visée, et sont chargés "
        + "à ce moment de la procédure au lieu d'être empilés au début). "
        + "Rend l'id du bloc, l'état du graphe et ce qui reste à corriger.",
      parameters: {
        type: "object",
        properties: {
          workflow_id: { type: "string" },
          kind: { type: "string", description: "Le type de bloc." },
          label: { type: "string", description: "Le titre : devient le titre de la section dans le document." },
          body: { type: "string", description: "Le contenu : la consigne détaillée d'une étape, le texte d'une règle, les connaissances d'un contexte…" },
          after: { type: "string", description: "Id du bloc dont celui-ci est la suite. Par défaut : le dernier de la chaîne." },
          branch: { type: "string", enum: ["true", "false", "body", "done"], description: "Pour enchaîner sur une sortie nommée : true/false d'une décision, body/done d'une boucle." },
          attach_to: { type: "string", description: "Id de l'ACTION que ce bloc de cadrage qualifie." },
          config: {
            type: "object",
            description: "Champs propres au type. "
              + "étape : agent_id, output_var · passation : agent_ids, expects, mode · "
              + "outil : soit tool (\"web_search\", \"read_url\", \"deep_research\"…), soit provider+action+args pour un appel précis sur une app connectée, "
              + "soit tool=\"python_exec\"/\"nodejs_exec\"/\"shell_exec\" + code · "
              + "boucle : mode, over, until, max · livrable : format, schema · contexte/mémoire : scope · entrée : params · "
              + "décision d'AUTOMATISATION : test={left,op,right} (op parmi equals, not_equals, contains, not_contains, gt, lt, exists, empty), ou plusieurs : tests=[…] + match=\"all\"|\"any\" · "
              + "outil d'AUTOMATISATION : on_error=\"continue\" pour une étape accessoire dont l'échec ne doit pas arrêter la chaîne (son résultat vaut alors {error}), retries=0-3 (2 par défaut, les écritures ne sont rejouées que si elles ont été refusées avant exécution). "
              + "output_var nomme le résultat d'un bloc : les blocs suivants le réutilisent avec {{nom}} — dans du code, un paramètre, une condition ou une phrase.",
          },
        },
        required: ["workflow_id", "kind"],
        additionalProperties: false,
      },
    },
    {
      name: "workflow_link",
      run: wfLink,
      description:
        "Relie deux blocs existants. mode=\"flow\" : le second suit le premier (avec « branch » pour une sortie nommée). "
        + "mode=\"attach\" : le premier (cadrage) ne vaut plus que pour le second (action). mode=\"unlink\" : retire le lien. "
        + "Un même bloc de cadrage peut être attaché à PLUSIEURS actions — c'est fait pour.",
      parameters: {
        type: "object",
        properties: {
          workflow_id: { type: "string" },
          from: { type: "string", description: "Id du bloc source." },
          to: { type: "string", description: "Id du bloc cible." },
          mode: { type: "string", enum: ["flow", "attach", "unlink"] },
          branch: { type: "string", enum: ["true", "false", "body", "done"] },
        },
        required: ["workflow_id", "from", "to", "mode"],
        additionalProperties: false,
      },
    },
    {
      name: "workflow_configure",
      run: wfConfigure,
      description:
        "Modifie un bloc existant (titre, contenu, agent destinataire, outil, format…), le supprime (remove=true), "
        + "ou renomme le workflow (sans block_id). Utilise-la pour corriger ce que les autres appels signalent.",
      parameters: {
        type: "object",
        properties: {
          workflow_id: { type: "string" },
          block_id: { type: "string", description: "Le bloc à modifier. Omis : c'est le workflow lui-même." },
          remove: { type: "boolean", description: "true pour supprimer le bloc et ses liens." },
          label: { type: "string" },
          body: { type: "string" },
          config: { type: "object", description: "Champs propres au type du bloc, fusionnés dans sa configuration." },
          name: { type: "string", description: "Sans block_id : renomme le workflow." },
          description: { type: "string", description: "Sans block_id : sa description." },
        },
        required: ["workflow_id"],
        additionalProperties: false,
      },
    },
    {
      name: "workflow_activate",
      run: wfActivate,
      description:
        "Termine le workflow : compile la procédure et la passe en actif (ou brouillon). Appelle-la EN DERNIER. "
        + "Elle refuse d'activer ce que le moteur ne pourrait pas exécuter, et rend le document final — "
        + "c'est SEULEMENT après son succès que tu peux dire à l'utilisateur que le workflow est en place.",
      parameters: {
        type: "object",
        properties: {
          workflow_id: { type: "string" },
          status: { type: "string", enum: ["active", "draft", "paused"], description: "active par défaut." },
        },
        required: ["workflow_id"],
        additionalProperties: false,
      },
    },
  ];
}

export { isBlockKind, isAttachEdge, newId, placeBlock, tailOfFlow, emptyGraph };
export type { BlockKind, WfGraph, WfNode, WfEdge };
