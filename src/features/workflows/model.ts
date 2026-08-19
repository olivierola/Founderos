import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import type { Node, Edge } from "reactflow";

// Workflows (migration 0196): an editor for a PROCEDURE whose output is a
// markdown playbook. Blocks are assembled on a canvas, compiled into a
// `workflow.md`, and when the trigger fires the service's assistant reads that
// playbook and executes it — deciding for itself who does what.

export type WorkflowStatus = "draft" | "active" | "paused" | "archived";
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

/** The sections a good procedure is made of. */
export type BlockKind =
  | "trigger"      // when it runs → frontmatter
  | "input"        // what the run needs to start
  | "goal"         // what it is for
  | "rule"         // a constraint that holds throughout
  | "context"      // knowledge to load — globally, or for one branch only
  | "resource"     // a document / collection / app to use
  | "tool"         // a capability the procedure must use (search, code, HTTP, connector…)
  | "step"         // one action, optionally delegated, optionally with its own context
  | "decision"     // a branch
  | "loop"         // repeat: for each X, or until a condition holds
  | "handoff"      // pass the baton to one or several agents, with a return contract
  | "approval"     // stop and ask a human
  | "deliverable"  // what must be produced
  | "memory"       // what must outlive the run
  | "example";     // one worked case

// Block knowledge lives in ./context — the compiler needs those rules and has
// no business importing a Supabase client to get them. Re-exported so callers
// keep one import for "the workflow model".
export { contextSourceOf, contextBodyOf } from "./context";
export type { ContextRef, ContextSourceKind } from "./context";

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
  name: string; description: string;
}): Promise<string | null> {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase.from("agent_workflows").insert({
    workspace_id: input.workspaceId,
    project_id: input.projectId,
    service_dashboard_id: input.dashboardId,
    name: input.name.trim().slice(0, 120),
    description: input.description.trim().slice(0, 2000) || null,
    created_by: auth.user?.id ?? null,
    // Every workflow opens with its trigger and an objective already placed: an
    // empty canvas gives no clue that a procedure starts by saying what it is for.
    blocks: {
      nodes: [
        { id: "trigger-1", type: "trigger", position: { x: 260, y: 80 }, data: { label: "Déclencheur", mode: "manual" } },
        { id: "goal-1", type: "goal", position: { x: 260, y: 240 }, data: { label: "", body: "" } },
      ],
      edges: [{ id: "e-trigger-goal", source: "trigger-1", target: "goal-1" }],
    },
    document: "",
  }).select("id").single();
  if (error) throw new Error(error.message);
  return (data as { id: string } | null)?.id ?? null;
}

/** Persist blocks + document together. They are two faces of one procedure, so
 *  saving one without the other is what makes them drift. */
export async function saveWorkflowContent(id: string, blocks: WorkflowGraph, document: string) {
  const { error } = await supabase.from("agent_workflows")
    .update({ blocks, document, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function updateWorkflow(
  id: string,
  patch: Partial<Pick<Workflow, "name" | "description" | "status">>,
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

export async function fetchWorkflowRuns(workflowId: string, limit = 20): Promise<WorkflowRun[]> {
  const { data } = await supabase
    .from("agent_workflow_runs")
    .select("id, workflow_id, agent_run_id, agent_id, status, trigger, document, error_message, started_at, finished_at")
    .eq("workflow_id", workflowId)
    .order("started_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as WorkflowRun[];
}
