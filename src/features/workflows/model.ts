import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import type { Node, Edge } from "reactflow";

// Workflows (migration 0196): an editor for a PROCEDURE whose output is a
// markdown playbook. Blocks are assembled on a canvas, compiled into a
// `workflow.md`, and when the trigger fires the service's assistant reads that
// playbook and executes it — deciding for itself who does what.

export type WorkflowStatus = "draft" | "active" | "paused" | "archived";
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled" | "stopped";

/**
 * Les deux natures d'un workflow (migration 0216).
 *
 *   procedure  — des instructions. Un agent lit le playbook et l'exécute en
 *                décidant qui fait quoi. Souple, jamais deux fois identique.
 *   automation — une suite d'appels. Le moteur les exécute lui-même, sans
 *                modèle. Rigide, et strictement reproductible.
 *
 * Ce n'est pas un réglage d'affichage : le déclenchement emprunte deux chemins
 * différents (workflow-engine.ts) et les blocs disponibles ne sont pas les mêmes.
 */
export type WorkflowKind = "procedure" | "automation";

export const WORKFLOW_KIND_META: Record<WorkflowKind, {
  label: string; short: string; long: string; tone: string;
}> = {
  procedure: {
    label: "Procédure",
    short: "Un agent lit et décide",
    long: "Des instructions écrites pour un agent. Il les lit au déclenchement et décide comment faire — utile quand le travail demande du jugement.",
    tone: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  automation: {
    label: "Automatisation",
    short: "Le moteur exécute",
    long: "Une suite d'actions exécutées telles quelles, sans modèle. Identique à chaque fois — utile quand il n'y a rien à juger.",
    tone: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
};

// Le vocabulaire des blocs vient du langage partagé (workflow-doc.ts) et n'est
// PAS redéclaré ici. Il l'était, et la copie a divergé au premier type ajouté :
// l'éditeur refusait un bloc que le compilateur savait très bien produire.
//
// Les lecteurs du sac `data` vivent dans ./context — le compilateur en a besoin
// et n'a aucune raison d'importer un client Supabase pour les obtenir.
// Ré-exportés ici pour que « le modèle du workflow » reste un seul import.
export {
  contextSourceOf, contextBodyOf, chipToken, chipIdsIn, cleanArgs,
  CODE_TOOLS, codeToolOf, outputVarOf,
} from "./context";
export type { BlockKind, ContextRef, ContextSourceKind } from "./context";

// Le cron : une seule implémentation, partagée avec le planificateur. L'éditeur
// en a besoin pour montrer la prochaine échéance AVANT d'enregistrer.
export {
  nextCronRun, isValidCron, buildCron, parseCron, describeCron, parseNaturalCron,
  DEFAULT_CRON_SPEC, CRON_FREQUENCIES, CRON_WEEKDAYS,
} from "../../../supabase/functions/_shared/cron";
export type { CronSpec, CronFrequency } from "../../../supabase/functions/_shared/cron";

export interface WorkflowGraph {
  nodes: Node[];
  edges: Edge[];
}

export interface Workflow {
  id: string;
  workspace_id: string;
  project_id: string;
  service_dashboard_id: string | null;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  kind: WorkflowKind;
  /** The canvas. */
  blocks: WorkflowGraph;
  /** The compiled (and hand-editable) playbook. */
  document: string;
  schedule: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  agent_run_id: string | null;
  agent_id: string | null;
  status: RunStatus;
  trigger: string;
  document: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export const WORKFLOW_STATUS_META: Record<WorkflowStatus, { label: string; tone: string }> = {
  draft: { label: "Brouillon", tone: "bg-muted text-muted-foreground" },
  active: { label: "Actif", tone: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  paused: { label: "En pause", tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  archived: { label: "Archivé", tone: "bg-muted text-muted-foreground" },
};

/** A row whose graph is null/malformed must still open — an editor that refuses
 *  to load is a worse failure than an empty canvas. */
function toWorkflow(row: Record<string, unknown>): Workflow {
  const g = row.blocks as Partial<WorkflowGraph> | null;
  return {
    ...(row as unknown as Workflow),
    blocks: {
      nodes: Array.isArray(g?.nodes) ? (g!.nodes as Node[]) : [],
      edges: Array.isArray(g?.edges) ? (g!.edges as Edge[]) : [],
    },
    document: String(row.document ?? ""),
    // Défaut « procedure » : c est ce qu étaient toutes les lignes écrites avant
    // que la distinction existe, et une automatisation supposée par défaut
    // exécuterait sans agent un contenu écrit pour un agent.
    kind: (row.kind as WorkflowKind) === "automation" ? "automation" : "procedure",
  };
}

export async function fetchWorkflows(dashboardId: string): Promise<Workflow[]> {
  const { data } = await supabase
    .from("agent_workflows")
    .select("*")
    .eq("service_dashboard_id", dashboardId)
    .neq("status", "archived")
    .order("updated_at", { ascending: false });
  return ((data ?? []) as Record<string, unknown>[]).map(toWorkflow);
}

export async function fetchWorkflow(id: string): Promise<Workflow | null> {
  const { data } = await supabase.from("agent_workflows").select("*").eq("id", id).maybeSingle();
  return data ? toWorkflow(data as Record<string, unknown>) : null;
}

export async function createWorkflow(input: {
  workspaceId: string; projectId: string; dashboardId: string;
  name: string; description: string; kind?: WorkflowKind;
}): Promise<string | null> {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase.from("agent_workflows").insert({
    workspace_id: input.workspaceId,
    project_id: input.projectId,
    service_dashboard_id: input.dashboardId,
    name: input.name.trim().slice(0, 120),
    description: input.description.trim().slice(0, 2000) || null,
    created_by: auth.user?.id ?? null,
    kind: input.kind ?? "procedure",
    // L'amorce dépend de la nature. Une procédure s'ouvre avec son objectif
    // déjà posé — c'est par là qu'on commence à en écrire une. Une
    // automatisation n'a pas d'objectif à rédiger : elle a un déclencheur et
    // des actions, et un bloc « objectif » qu'elle n'exécutera jamais y serait
    // une invitation à écrire quelque chose qui ne sert à rien.
    blocks: {
      nodes: [
        { id: "trigger-1", type: "trigger", position: { x: 260, y: 80 }, data: { label: "Déclencheur", mode: "manual" } },
        ...(input.kind === "automation" ? [] : [
          { id: "goal-1", type: "goal", position: { x: 260, y: 240 }, data: { label: "", body: "" } },
        ]),
      ],
      edges: input.kind === "automation" ? [] : [{ id: "e-trigger-goal", source: "trigger-1", target: "goal-1" }],
    },
    document: "",
  }).select("id").single();
  if (error) throw new Error(error.message);
  return (data as { id: string } | null)?.id ?? null;
}

/** Persist blocks + document together. They are two faces of one procedure, so
 *  saving one without the other is what makes them drift. */
export async function saveWorkflowContent(
  id: string, blocks: WorkflowGraph, document: string,
): Promise<string | null> {
  const stamp = new Date().toISOString();
  // The new `updated_at` comes BACK so the editor can tell its own write apart
  // from someone else's. Without that it cannot distinguish "the row changed
  // because I just saved" from "the row changed because the assistant built
  // three blocks into it" — and the second one must never be overwritten.
  const { data, error } = await supabase.from("agent_workflows")
    .update({ blocks, document, updated_at: stamp }).eq("id", id)
    .select("updated_at").maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { updated_at: string } | null)?.updated_at ?? stamp;
}

export async function updateWorkflow(
  id: string,
  patch: Partial<Pick<Workflow, "name" | "description" | "status" | "kind">>,
) {
  const { error } = await supabase.from("agent_workflows")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteWorkflow(id: string) {
  const { error } = await supabase.from("agent_workflows").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Execution ────────────────────────────────────────────────────────────────

export async function startRun(workflowId: string): Promise<string | null> {
  const res = await callEdge<{ run_id?: string }>("run-workflow", {
    workflow_id: workflowId, trigger_payload: { trigger: "manual" },
  });
  return res?.run_id ?? null;
}

export async function cancelRun(runId: string) {
  await callEdge("run-workflow", { action: "cancel", run_id: runId });
}

/** Re-derive schedule/next_run_at from the trigger block. The columns are a
 *  denormalised copy, and a copy that is never refreshed is a lie the scheduler
 *  acts on. */
export async function syncSchedule(workflowId: string) {
  await callEdge("run-workflow", { action: "sync_schedule", workflow_id: workflowId });
}

// ── Event triggers (migration 0198) ──────────────────────────────────────────

export type TriggerStatus = "pending" | "active" | "paused" | "error";

export interface EventTrigger {
  id: string;
  workflow_id: string;
  provider: string;
  event_slug: string;
  config: Record<string, unknown>;
  filter: string | null;
  status: TriggerStatus;
  status_detail: string | null;
  last_event_at: string | null;
}

export async function fetchEventTriggers(workflowId: string): Promise<EventTrigger[]> {
  const { data } = await supabase.from("agent_workflow_triggers")
    .select("id, workflow_id, provider, event_slug, config, filter, status, status_detail, last_event_at")
    .eq("workflow_id", workflowId).order("created_at", { ascending: true });
  return (data ?? []) as EventTrigger[];
}

/** Write the row, then ask the backend to subscribe upstream. Two steps on
 *  purpose: the row is the user's intent and is saved under RLS whatever
 *  Composio answers; the subscription's outcome comes back as `status`. */
export async function addEventTrigger(input: {
  workflowId: string; workspaceId: string; projectId: string;
  provider: string; eventSlug: string; filter: string;
}): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase.from("agent_workflow_triggers").insert({
    workflow_id: input.workflowId,
    workspace_id: input.workspaceId,
    project_id: input.projectId,
    provider: input.provider.trim().toLowerCase(),
    event_slug: input.eventSlug.trim(),
    filter: input.filter.trim() || null,
    created_by: auth.user?.id ?? null,
  }).select("id").single();
  if (error) throw new Error(error.message);
  await callEdge("run-workflow", { action: "sync_trigger", trigger_id: (data as { id: string }).id });
}

export async function updateEventTrigger(id: string, patch: { filter?: string | null }) {
  const { error } = await supabase.from("agent_workflow_triggers")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function retryEventTrigger(id: string) {
  await callEdge("run-workflow", { action: "sync_trigger", trigger_id: id });
}

export async function removeEventTrigger(id: string) {
  await callEdge("run-workflow", { action: "remove_trigger", trigger_id: id });
}

/** The last events received, whether they started a run or were filtered out.
 *  A workflow that "didn't fire" is answered here and nowhere else. */
export async function fetchEventDeliveries(workflowId: string, limit = 20) {
  const { data } = await supabase.from("workflow_event_deliveries")
    .select("id, outcome, detail, received_at, run_id")
    .eq("workflow_id", workflowId).order("received_at", { ascending: false }).limit(limit);
  return (data ?? []) as Array<{
    id: string; outcome: string; detail: string | null; received_at: string; run_id: string | null;
  }>;
}

export async function fetchLatestRun(workflowId: string): Promise<WorkflowRun | null> {
  const { data } = await supabase
    .from("agent_workflow_runs")
    .select("id, workflow_id, agent_run_id, agent_id, status, trigger, document, error_message, started_at, finished_at")
    .eq("workflow_id", workflowId)
    .order("started_at", { ascending: false })
    .limit(1).maybeSingle();
  return (data ?? null) as WorkflowRun | null;
}

/** La trace pas-à-pas d'une exécution automatique (0216).
 *
 *  Une procédure raconte ce qu'elle a fait dans le rapport de son agent. Une
 *  automatisation ne raconte rien : sans ce journal, un échec se résume à
 *  « failed » et rien ne dit quelle action a cassé, ni avec quels arguments. */
export interface RunStep {
  id: number;
  position: number;
  block_id: string;
  block_kind: string;
  label: string | null;
  status: "running" | "succeeded" | "failed" | "skipped";
  input: Record<string, unknown>;
  output: unknown;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export async function fetchRunSteps(runId: string): Promise<RunStep[]> {
  const { data } = await supabase.from("agent_workflow_run_steps")
    .select("id, position, block_id, block_kind, label, status, input, output, error_message, started_at, finished_at")
    .eq("run_id", runId).order("position", { ascending: true });
  return (data ?? []) as RunStep[];
}

export async function fetchWorkflowRuns(workflowId: string, limit = 20): Promise<WorkflowRun[]> {
  const { data } = await supabase
    .from("agent_workflow_runs")
    .select("id, workflow_id, agent_run_id, agent_id, status, trigger, document, error_message, started_at, finished_at")
    .eq("workflow_id", workflowId)
    .order("started_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as WorkflowRun[];
}
