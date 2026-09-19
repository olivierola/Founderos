// Internal agent tool registry — the execution layer behind "autonomous agents".
//
// Each internal agent is granted tools as rows in internal_agent_tools. This
// module turns those rows into real, executable tool definitions for the
// callAiWithTools loop:
//
//   web_search      → web_search(query)            Tavily if key set, DuckDuckGo fallback
//   web_fetch       → read_url(url)                Jina Reader extraction
//   rag_search      → search_knowledge(query)      semantic search over project RAG chunks
//   db_read         → query_table(table, …)        read-only, allowlisted tables, project-scoped
//   vault_connector → list_connectors()            connector inventory (no secrets)
//   edge_function   → one tool per row             invoke an internal edge function
//   custom          → one tool per row             POST a webhook with model-provided args
//
// Cross-cutting concerns handled here:
//
//  1. HUMAN-IN-THE-LOOP. Rows flagged requires_approval never execute directly:
//     the call is recorded as a pending internal_agent_approvals row and the
//     model gets back an acknowledgement. internal-agent-approve executes it
//     after a human decision.
//  2. OBSERVABILITY. Every tool call/result is appended to
//     internal_agent_run_events (when a run id is present) so the UI can render
//     a live timeline.
//  3. CANCELLATION. Before each tool execution the loop re-checks the run
//     status; a cancelled run aborts with RunCancelledError.
//  4. DELIVERABLES. create_deliverable is always available — the agent
//     materialises outputs itself instead of relying on fragile text parsing.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { TOOL_RESULT_CAP } from "./ai.ts";
import { blockKey, blockSubstanceKey, REPEATABLE_BLOCKS } from "./report-artisan.ts";
import { removePreference, upsertPreference } from "./agent-context.ts";
import { MEMORY_CAP, pickEvictions, planMemoryWrite, RELEVANCE_FLOOR, type MemoryRow } from "./agent-memory.ts";
import { inferProvider, isSafeUrl } from "./external-artifacts.ts";
import { workflowToolDefs } from "./workflow-authoring.ts";
import {
  DOC_KINDS, isDocKind, contentForKind, renderContent, CONTENT_FORMAT_HELP,
} from "./artifact-content.ts";
import type { ToolDef, ToolExecutor } from "./ai.ts";
import type { ToolTier } from "./model-router.ts";
import { CONNECTOR_ACTIONS } from "./connector-actions.ts";
import { defaultTimezone, parseRunAt, parseSchedule } from "./clock.ts";
import { embedTexts, toVectorLiteral } from "./jina.ts";
import { mcpCallTool, type McpTool } from "./mcp-client.ts";
import { executeApprovalAction, approvalScope, approvalScopePrefix, approvalScopeLabel } from "./approval-exec.ts";
import { runTrackerAction, trackerScope } from "./tracker-actions.ts";
import { postApprovalToBoundChannel } from "./channel-approval.ts";

export interface AgentToolRow {
  id: string;
  kind:
    | "web_search"
    | "web_fetch"
    | "db_read"
    | "rag_search"
    | "edge_function"
    | "vault_connector"
    | "connector_action"
    | "composio_toolkit"
    | "crm"
    | "tracker"
    | "security_scan"
    | "vibe_code"
    | "testing"
    | "simulation"
    | "custom";
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  requires_approval: boolean;
}

export interface DeliverableDraft {
  kind: string;
  name: string;
  content: string;
  summary: string | null;
}

export interface ArtifactDraft {
  kind: "document" | "presentation" | "spreadsheet" | "image" | "text";
  title: string;
  /** Markdown (document/text), "Title | body" lines (presentation), CSV (spreadsheet), or an image prompt (image). */
  content: string;
}

export interface ApprovalRequest {
  tool_name: string;
  action_kind: "edge_function" | "webhook" | "connector_action" | "composio_action" | "crm_write" | "tracker_write";
  payload: Record<string, unknown>;
  reason: string | null;
}

export interface InternalToolContext {
  admin: SupabaseClient;
  workspaceId: string;
  projectId: string;
  agentId: string;
  /** This agent's display name — used when collaborating with peers. */
  agentName?: string;
  /** Whether this agent may message/delegate to peers. */
  collaborationEnabled?: boolean;
  /** Whether the agent may run write/outgoing actions without per-action approval. */
  autopilot?: boolean;
  runId: string | null;
  /** Originating chat session, when running in chat mode. */
  conversationId?: string | null;
  /** Persist a deliverable produced by the agent. */
  createDeliverable: (d: DeliverableDraft) => Promise<void>;
  /** Create a rich, openable artifact (document/presentation/spreadsheet/image/text). */
  createArtifact: (a: ArtifactDraft) => Promise<void>;
  /** Queue a sensitive action for human approval. Returns the approval id. */
  requestApproval: (r: ApprovalRequest) => Promise<string>;
  /** Append a run event (no-op when runId is null). The union lists every kind
   *  the runtime actually emits — it must stay in sync with the
   *  internal_agent_run_events kind CHECK constraint (migration 0164). */
  logEvent: (
    kind:
      | "tool_call" | "tool_result" | "status" | "log" | "error" | "plan" | "plan_step"
      | "tool_error" | "question" | "todos" | "ui" | "loop"
      | "browser_navigate" | "browser_action" | "browser_screenshot",
    payload: Record<string, unknown>,
  ) => Promise<void>;
  /** Loop engine: successful tool results observed since the last update_todos
   *  call. A checklist step may only be closed against evidence — see
   *  update_todos. Seeded per tick from the transcript by the run engine. */
  loopEvidence?: { results: number };
  /** True when this context belongs to a MISSION run (gates meta-tools like
   *  self-mission creation that fueled the fork-bomb incident). */
  missionMode?: boolean;
  /** Missions created during THIS run (budget: 2). Mutated by the guard. */
  missionCreates?: number;
  /** Re-check whether the run was cancelled by a human. */
  isCancelled: () => Promise<boolean>;
  /** AIO Sandbox URL when agent runs in sandbox (or hybrid) mode. */
  sandboxUrl?: string | null;
  /** Whether the agent may drive the Playwright runner (browse_web). */
  runnerEnabled?: boolean;
  /** Runner browser URL from the live DB config (fallback: env). */
  runnerUrl?: string | null;
  /** HYBRID mode: BOTH the runner and the sandbox are exposed at once. Their
   *  overlapping tools are namespaced (runner_* / sandbox_*) so the model — guided
   *  by the plan-time env tagging — chooses a world explicitly per call. When one
   *  world is unhealthy its tools are simply not registered (graceful degrade). */
  hybrid?: boolean;
  /** Skills activated for this agent — their full playbooks are loaded on
   *  demand via use_skill (progressive disclosure), not injected up-front. */
  skills?: AgentSkill[];
  /** MCP servers attached to this agent. Their (cached) tools are exposed as
   *  namespaced mcp_<server>_<tool> tools, executed via JSON-RPC tools/call to
   *  the remote server (edge-side). */
  mcpServers?: Array<{ id: string; name: string; url: string; headers: Record<string, string>; tools: McpTool[] }>;
  /** Per-run MCP session cache (server id → session), reused across tool calls. */
  mcpSessions?: Map<string, { id?: string }>;
  /** Depth of this run in a delegation chain (0 = user-initiated). create_mission
   *  refuses to delegate beyond MAX_DELEGATION_DEPTH to stop infinite loops. */
  delegationDepth?: number;
  /** The service dashboard this agent belongs to — new agents created via
   *  create_agent inherit it so the orchestrator builds its own team. */
  serviceDashboardId?: string | null;
  /** The room this turn happens in, when there is one. Stamped on the artifacts
   *  the agent registers so the wall can filter them by room like the rest. */
  serviceRoomId?: string | null;
  /** The user who owns/created the agent — stamped on resources it creates. */
  userId?: string | null;
  /** True when THIS context is an ephemeral parallel sub-agent — disables
   *  spawn_parallel_agents / create_mission so a sub-agent can't fan out again. */
  isSubagent?: boolean;
  /** Owner's "Essaim" switch: when false the spawn_parallel_agents tool is not
   *  registered at all (the agent can't fan out). Default true — the agent
   *  still decides per task whether to actually use it. */
  swarmEnabled?: boolean;
  /** Fan out INDEPENDENT subtasks to ephemeral parallel sub-agents (clones of
   *  this agent) and return their collected results. Injected by the run engine
   *  on primary runs only; absent on sub-agent runs. */
  spawnParallel?: (
    subtasks: Array<{ label: string; brief: string; acceptance?: string }>,
  ) => Promise<string>;
  /** Tool families already loaded for this run (restored from run_state.meta),
   *  so progressive disclosure survives across ticks instead of resetting. */
  loadedFamilies?: string[];
  /** Called when load_toolset / need_tools widens the toolbox, so the run engine
   *  can persist it. "*" = the whole toolbox was loaded. */
  onToolsetLoaded?: (family: string) => Promise<void>;
  /** Hand raw matter to Le Rédacteur and get back a published report.
   *  Injected by the run engine (see _shared/reporter.ts). Its PRESENCE is what
   *  tells the toolset that reports are written elsewhere: where it is injected,
   *  add_block/publish_artifact stop accepting target="report". */
  requestReport?: (brief: {
    subject: string; material: string; angle?: string; audience?: string; accent?: string;
  }) => Promise<string>;
}

export const MAX_DELEGATION_DEPTH = 3;
/** Tag marking a one-off mission (create_mission run_at): the scheduler runs it
 *  once at next_run_at, then clears next_run_at. */
export const RUN_ONCE_TAG = "run_once";

/** Reports a single run may publish. One is the answer; two is the ceiling for a
 *  mission that genuinely covered two subjects. Enforced in request_report. */
export const REPORT_BUDGET = 2;

// Fork-bomb guards shared by create_mission / delegate_mission: a per-run
// creation budget (2) and a per-agent hourly flood cap (10). Returns an error
// string to send back to the model, or null when allowed.
async function missionCreationGuard(ctx: InternalToolContext): Promise<string | null> {
  ctx.missionCreates = (ctx.missionCreates ?? 0) + 1;
  if (ctx.missionCreates > 2) {
    return "ERROR: mission-creation budget for this run is exhausted (max 2). Execute the remaining work YOURSELF with your execution tools.";
  }
  const { count } = await ctx.admin
    .from("internal_agent_missions")
    .select("id", { count: "exact", head: true })
    .eq("delegated_by_agent", ctx.agentId)
    .gt("created_at", new Date(Date.now() - 3600_000).toISOString());
  if ((count ?? 0) >= 10) {
    return "ERROR: this agent already created 10 missions in the last hour (flood guard). Execute the work directly instead of creating missions.";
  }
  return null;
}

export interface AgentSkill {
  /** agent_skills.id — needed to resolve bundled files at read time. */
  id?: string;
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
  /** Full playbook / methodology (SKILL.md body) — returned by use_skill. */
  instructions?: string | null;
  /** Tool kinds this skill expects to use. */
  tools?: string[] | null;
  /** Bundled resource files (paths only — an INDEX). Their content is pulled on
   *  demand with read_skill_file (progressive disclosure), not injected up-front. */
  files?: Array<{ path: string }> | null;
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled by user");
    this.name = "RunCancelledError";
  }
}

// Thrown by the ask_user tool to PAUSE the run and surface a question to the
// human (Claude-Code-style clarification). It is a control-flow signal, not a
// failure — the tool loop re-throws it (by name) and the run handler turns it
// into an awaiting_input state instead of an error.
export class AwaitingInputError extends Error {
  question: string;
  options: string[];
  constructor(question: string, options: string[] = []) {
    super("Agent is awaiting human input");
    this.name = "AwaitingInputError";
    this.question = question;
    this.options = options;
  }
}

// Thrown by an approval-gated tool to PAUSE the run until a human approves the
// action IN THE CHAT. Like AwaitingInputError, but the decision executes (or
// cancels) the queued action and then resumes the agent with its result. It is a
// control-flow signal, not a failure — the tool loop re-throws it by name.
export class AwaitingApprovalError extends Error {
  approvalId: string;
  toolName: string;
  summary: string;
  constructor(approvalId: string, toolName: string, summary: string) {
    super("Agent is awaiting human approval");
    this.name = "AwaitingApprovalError";
    this.approvalId = approvalId;
    this.toolName = toolName;
    this.summary = summary;
  }
}

// Inline approval that keeps the RUN ALIVE. Instead of stopping the run, the
// gated tool: (1) queues the approval, (2) posts it INLINE in the chat with
// approve/reject buttons — visible while the run keeps turning, and (3) polls
// for the decision so the agent continues in the SAME run once approved (the
// decision endpoint executes the action and stores its result, which we read
// here). No stop, no re-plan, no re-request. In non-chat contexts (rooms / a2a:
// no conversationId) it degrades to a queued note instead of blocking.
const APPROVAL_POLL_MS = 120_000; // wait up to ~2 min inline for a decision
const APPROVAL_POLL_STEP = 2_000;

async function awaitInlineApproval(
  ctx: InternalToolContext,
  req: ApprovalRequest,
  summary: string,
): Promise<string> {
  // Already approved this EXACT call earlier in the conversation? Auto-run it so
  // we never re-ask for something the user already granted — a different action
  // (or different arguments) still gets its own approval.
  if (ctx.conversationId) {
    const scope = approvalScope(req.action_kind, req.payload, req.tool_name);
    const prefix = approvalScopePrefix(req.action_kind, req.payload, req.tool_name);
    const { data: prior } = await ctx.admin.from("internal_agent_approvals")
      .select("action_kind, payload, tool_name, status, result")
      .eq("conversation_id", ctx.conversationId).in("status", ["executed", "approved", "pending"]).limit(120);
    const sameScope = (prior ?? []).filter(
      (a: { action_kind?: string; payload?: Record<string, unknown>; tool_name?: string }) =>
        approvalScope(a.action_kind ?? "", a.payload ?? {}, a.tool_name ?? "") === scope,
    );
    // Same action already waiting? Don't create a duplicate or start another
    // long poll — tell the agent to stop and wait (prevents a retry loop).
    if (sameScope.some((a: { status?: string }) => a.status === "pending")) {
      return `⏳ L'action « ${summary} » est DÉJÀ en attente de ton approbation au-dessus. Je ne la relance pas — j'attends ta décision là-haut.`;
    }
    const exact = sameScope.some((a: { status?: string }) => a.status === "executed" || a.status === "approved");
    // "Tout autoriser {toolkit}" grant covers every action of this integration
    // in the conversation → auto-run without asking again.
    const toolkitGranted = (prior ?? []).some(
      (a: { result?: { grant_scope?: string } | null }) => (a.result?.grant_scope ?? "") === prefix,
    );
    if (exact || toolkitGranted) {
      const outcome = await executeApprovalAction({
        action_kind: req.action_kind, payload: req.payload, workspace_id: ctx.workspaceId, project_id: ctx.projectId,
      });
      const gid = await ctx.requestApproval(req); // audit trail for the auto-run
      await ctx.admin.from("internal_agent_approvals").update({
        status: outcome.ok ? "executed" : "failed", decided_at: new Date().toISOString(),
        executed_at: new Date().toISOString(), result: { detail: outcome.detail },
        error_message: outcome.ok ? null : outcome.detail.slice(0, 500),
      }).eq("id", gid).then(() => {}, () => {});
      const why = toolkitGranted ? `${approvalScopeLabel(req.action_kind, req.payload, req.tool_name)} déjà autorisé` : "déjà autorisé cette session";
      return outcome.ok
        ? `✅ (${why} — je n'ai pas redemandé) Action « ${summary} » exécutée. Résultat :\n${outcome.detail.slice(0, 6000)}`
        : `⚠️ Action « ${summary} » (${why}) — l'exécution a échoué : ${outcome.detail.slice(0, 1500)}`;
    }
  }

  const id = await ctx.requestApproval(req);
  if (!ctx.conversationId) {
    return `⏳ Action « ${summary} » mise en attente d'approbation (id ${id}). Approuve-la depuis le chat direct de l'agent pour que je l'exécute.`;
  }

  // Surface the approval inline, live, while the run keeps turning.
  await ctx.admin.from("internal_agent_messages").insert({
    conversation_id: ctx.conversationId, agent_id: ctx.agentId, role: "assistant",
    content: `🔐 J'ai besoin de ton feu vert pour : **${summary}**. Approuve ou refuse juste en dessous — je patiente et je continue dès ta décision.`,
    run_id: ctx.runId,
    ui_blocks: [{ component: "approval", props: { approval_id: id, tool: req.tool_name, summary, scope_label: approvalScopeLabel(req.action_kind, req.payload, req.tool_name) } }],
  }).then(() => {}, () => {});
  await ctx.admin.from("internal_agent_conversations")
    .update({ updated_at: new Date().toISOString() }).eq("id", ctx.conversationId).then(() => {}, () => {});
  // Et dans le fil Slack / Teams quand la conversation vient de là : sans cela,
  // la personne qui a écrit à l'agent depuis sa messagerie ne voyait jamais la
  // demande, et l'exécution expirait en attendant.
  await postApprovalToBoundChannel(ctx.admin, {
    conversationId: ctx.conversationId, approvalId: id, summary,
    scopeLabel: approvalScopeLabel(req.action_kind, req.payload, req.tool_name),
    actionKind: req.action_kind,
  });
  // Extend the tick lease so a duplicate delivery can't fire while we wait.
  if (ctx.runId) {
    await ctx.admin.from("internal_agent_run_state")
      .update({ processing_until: new Date(Date.now() + APPROVAL_POLL_MS + 60_000).toISOString() })
      .eq("run_id", ctx.runId).then(() => {}, () => {});
  }

  const deadline = Date.now() + APPROVAL_POLL_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, APPROVAL_POLL_STEP));
    if (await ctx.isCancelled()) throw new RunCancelledError();
    const { data } = await ctx.admin
      .from("internal_agent_approvals").select("status, result, error_message").eq("id", id).maybeSingle();
    const st = (data as { status?: string } | null)?.status;
    if (!st || st === "pending") continue;
    if (st === "rejected") {
      return `❌ L'utilisateur a REFUSÉ l'action « ${summary} ». Ne la refais pas — adapte-toi ou propose une alternative, puis poursuis.`;
    }
    const detail = (data as { result?: { detail?: string } } | null)?.result?.detail ?? "";
    if (st === "failed") {
      return `⚠️ Action « ${summary} » approuvée, mais l'exécution a échoué : ${((data as { error_message?: string } | null)?.error_message ?? detail).slice(0, 1500)}`;
    }
    return `✅ Action « ${summary} » approuvée et exécutée. Résultat :\n${detail.slice(0, 6000) || "(ok)"}`;
  }
  return `⏳ Toujours en attente de ton approbation pour « ${summary} » — approuve/refuse au-dessus quand tu veux, puis dis-moi de continuer.`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function cap(s: string, max = 8000): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}

/**
 * Coerce what a model typically passes as a "url" into an absolute one.
 *
 * Models routinely hand over `api.example.com/v1/x`, `//host/path` or a quoted
 * URL, and the fetch tools used to reject all of those with a flat "url must be
 * absolute" — an error the model can't act on, so it retries the same shape and
 * burns rounds. Anything that plainly isn't a host (a bare path, a sentence)
 * still returns null: guessing a host would be worse than refusing.
 */
function normalizeUrl(raw: string): string | null {
  const s = raw.trim().replace(/^['"<]+|['">]+$/g, "");
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  // host[:port][/path…] — a dotted label before the first slash is enough to
  // call it a host; "docs/readme.md" or "explique-moi ceci" are not.
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?(\/|\?|#|$)/i.test(s)) return `https://${s}`;
  return null;
}

// ── Per-tool deterministic output compression (the `compress` contract) ───────
// A tool whose output can legitimately exceed TOOL_RESULT_CAP declares a
// `compress(result, maxChars)` so the executor can shrink THAT tool's output the
// way only the tool knows (keep the tail of a log, keep a CSV's header + last
// rows, keep JSON structure) instead of the generic blind middle-cut in ai.ts.
// MUST be deterministic: same input → same output, so the sealed transcript hash
// (prompt-compiler.ts / tick_manifest) stays stable across runs.

/** Keep head + tail of a result, marking the middle as cut. Deterministic. */
function compressHeadTail(s: string, maxChars: number, headRatio = 0.5): string {
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * headRatio);
  const tail = maxChars - head;
  return `${s.slice(0, head)}\n…[${s.length - maxChars} caractères coupés au milieu]…\n${s.slice(-tail)}`;
}

/** Exec-style output: keep the `$ cmd`/`[status]` header verbatim, then head+tail
 *  the body so the last lines of stdout/stderr (where results and errors land)
 *  survive. */
function compressExecResult(result: string, maxChars: number): string {
  const sep = result.indexOf("\n\n");
  if (sep < 0 || sep + 2 >= result.length) return compressHeadTail(result, maxChars);
  const header = result.slice(0, sep);
  const body = result.slice(sep + 2);
  const bodyMax = Math.max(64, maxChars - header.length - 2);
  return `${header}\n\n${compressHeadTail(body, bodyMax)}`;
}

// Coerce a tool argument that SHOULD be a JSON/text string but which the model
// often emits as a nested object/array (DeepSeek does this a lot for big report
// payloads) into a string. Empty/nullish → "".
function strOrJson(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "object") { try { return JSON.stringify(v); } catch { return ""; } }
  return String(v);
}

// Small run_state.meta accessors so a tool can accumulate durable per-run state
// (e.g. an incremental report draft, spawn dedup) across tool calls / ticks.
async function readRunMeta(ctx: InternalToolContext): Promise<Record<string, unknown>> {
  if (!ctx.runId) return {};
  const { data } = await ctx.admin.from("internal_agent_run_state").select("meta").eq("run_id", ctx.runId).maybeSingle();
  return ((data as { meta?: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>;
}
async function writeRunMeta(ctx: InternalToolContext, meta: Record<string, unknown>): Promise<void> {
  if (!ctx.runId) return;
  await ctx.admin.from("internal_agent_run_state").update({ meta }).eq("run_id", ctx.runId).then(() => {}, () => {});
}

// Classify an action as a WRITE (create / update / delete / send / modify) vs a
// READ (fetch / list / get / search …). ONLY writes need human approval — reads
// run freely, so a simple lookup like "show my last emails" never nags. Heuristic
// on the action name's verb; an unknown verb is treated as a read (don't gate
// safe lookups). Destructive verbs are covered explicitly.
const WRITE_ACTION_RE = /\b(SEND|CREATE|DELETE|REMOVE|UPDATE|MODIFY|ADD|PUT|PATCH|POST|TRASH|ARCHIVE|MOVE|REPLY|FORWARD|DRAFT|SET|EDIT|INSERT|UPLOAD|MARK|WRITE|RENAME|CANCEL|MERGE|ASSIGN|INVITE|CLEAR|REVOKE|GRANT|ENABLE|DISABLE|SCHEDULE|PUBLISH|CLOSE|IMPORT|SNOOZE|LABEL|REACT|PIN|UNPIN|STAR|SUBSCRIBE|UNSUBSCRIBE|BLOCK|MUTE|APPROVE|REJECT|COMPLETE|SUBMIT|EXECUTE|TRIGGER|DUPLICATE|RESTORE|EMPTY|BATCH)\b/;
export function isWriteAction(name: string): boolean {
  return WRITE_ACTION_RE.test(String(name ?? "").toUpperCase().replace(/[_.\-]+/g, " "));
}

// Best-effort embedding for a memory (Jina v3, 1024 dims — same pipeline as the
// RAG Center). Returns a pgvector literal, or null when embeddings are
// unavailable — a memory without an embedding still works via keyword fallback.
export async function embedMemoryVector(content: string): Promise<string | null> {
  try {
    if (!Deno.env.get("JINA_API_KEY")) return null;
    const [vec] = await embedTexts([content.slice(0, 2000)], "retrieval.passage");
    return vec ? toVectorLiteral(vec) : null;
  } catch { return null; }
}

export interface MemoryWriteInput {
  agent_id: string;
  workspace_id: string;
  project_id: string | null;
  kind: string;
  content: string;
  importance?: number;
  source?: "agent" | "user";
  source_run_id?: string | null;
  source_conversation_id?: string | null;
}

export type MemoryWriteResult =
  | { status: "inserted"; id: string | null; evicted: number }
  | { status: "merged" | "duplicate"; id: string }
  | { status: "full" | "failed"; error: string };

/**
 * The ONE way the runtime writes a memory (see agent-memory.ts for the rules).
 *
 * Embeds once, looks up the nearest existing memory, then inserts, merges or
 * skips. When the store is at its cap, the least valuable agent-written rows
 * are evicted instead of the write being refused. Never throws.
 */
export async function writeAgentMemory(
  admin: SupabaseClient,
  input: MemoryWriteInput,
): Promise<MemoryWriteResult> {
  try {
    const content = String(input.content ?? "").trim();
    if (!content) return { status: "failed", error: "content is required" };
    const importance = Math.min(Math.max(Math.round(Number(input.importance ?? 3)) || 3, 1), 5);
    const embedding = await embedMemoryVector(content);

    let nearest: (MemoryRow & { id: string; similarity: number }) | null = null;
    if (embedding) {
      const { data } = await admin.rpc("match_agent_memories", {
        p_agent_id: input.agent_id, p_query_embedding: embedding, p_match_count: 1,
      });
      const top = Array.isArray(data) ? data[0] : null;
      if (top?.id) nearest = { ...top, similarity: Number(top.similarity ?? 0) };
    } else {
      // No embeddings: exact-text duplicates are still caught.
      const { data } = await admin.from("internal_agent_memories")
        .select("id, kind, content, importance, is_pinned, source")
        .eq("agent_id", input.agent_id).eq("content", content).limit(1);
      if (data?.[0]) nearest = { ...(data[0] as MemoryRow & { id: string }), similarity: 1 };
    }

    const plan = planMemoryWrite({ content, importance }, nearest);
    if (plan.action === "skip") return { status: "duplicate", id: plan.id };
    if (plan.action === "merge") {
      const changed = plan.content !== nearest?.content;
      await admin.from("internal_agent_memories").update({
        content: plan.content,
        importance: plan.importance,
        updated_at: new Date().toISOString(),
        ...(changed && embedding ? { embedding } : {}),
        ...(input.source_run_id ? { source_run_id: input.source_run_id } : {}),
      }).eq("id", plan.id);
      return { status: "merged", id: plan.id };
    }

    const { count } = await admin.from("internal_agent_memories")
      .select("id", { count: "exact", head: true }).eq("agent_id", input.agent_id);
    let evicted = 0;
    if ((count ?? 0) >= MEMORY_CAP) {
      const candidates = (cols: string) => admin.from("internal_agent_memories")
        .select(cols)
        .eq("agent_id", input.agent_id).eq("is_pinned", false).neq("source", "user")
        .order("importance", { ascending: true }).order("updated_at", { ascending: true })
        .limit(80);
      let { data: pool, error: poolErr } = await candidates(
        "id, kind, content, importance, is_pinned, source, recall_count, last_recalled_at, updated_at, created_at");
      // Pre-0249 schema: rank on importance and age alone.
      if (poolErr) ({ data: pool } = await candidates("id, kind, content, importance, is_pinned, source, updated_at, created_at"));
      const ids = pickEvictions((pool ?? []) as MemoryRow[], (count ?? 0) - MEMORY_CAP + 1);
      if (ids.length === 0) {
        return { status: "full", error: `memory store is full (${MEMORY_CAP}) and every entry is pinned or human-written` };
      }
      await admin.from("internal_agent_memories").delete().in("id", ids);
      evicted = ids.length;
    }

    const { data: row, error } = await admin.from("internal_agent_memories").insert({
      agent_id: input.agent_id,
      workspace_id: input.workspace_id,
      project_id: input.project_id,
      kind: input.kind,
      content,
      importance,
      source: input.source ?? "agent",
      source_run_id: input.source_run_id ?? null,
      source_conversation_id: input.source_conversation_id ?? null,
      ...(embedding ? { embedding } : {}),
    }).select("id").maybeSingle();
    if (error) return { status: "failed", error: error.message };
    return { status: "inserted", id: (row as { id?: string } | null)?.id ?? null, evicted };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Mark memories as recalled (injected or returned). Fire-and-forget. */
export function touchAgentMemories(admin: SupabaseClient, ids: string[]): void {
  const list = [...new Set(ids.filter(Boolean))];
  if (list.length === 0) return;
  admin.rpc("touch_agent_memories", { p_ids: list }).then(() => {}, () => {});
}

// Best-effort: when a sandbox command installs packages or fetches a
// dataset/repo, record it in the agent's persistent memory so it doesn't lose
// track of its environment (and won't re-install needlessly) across sessions.
async function rememberSandboxAction(ctx: InternalToolContext, command: string): Promise<void> {
  try {
    const cmd = command.trim();
    let content: string | null = null;
    const inst =
      cmd.match(/(?:pip3?|python3?\s+-m\s+pip|uv\s+pip)\s+install\s+(.+)/i) ??
      cmd.match(/(?:npm\s+(?:install|i)|yarn\s+add|pnpm\s+add)\s+(.+)/i) ??
      cmd.match(/(?:apt-get|apt)\s+install\s+(?:-y\s+)?(.+)/i) ??
      cmd.match(/conda\s+install\s+(?:-y\s+)?(.+)/i);
    if (inst) {
      const pkgs = inst[1].replace(/--?\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (pkgs) content = `Installed in sandbox: ${pkgs}`;
    }
    if (!content) {
      const dl =
        cmd.match(/(?:wget|curl)\b[^|]*?(https?:\/\/\S+)/i) ??
        cmd.match(/git\s+clone\s+(\S+)/i) ??
        cmd.match(/kaggle\s+datasets\s+download\s+(\S+)/i) ??
        cmd.match(/huggingface-cli\s+download\s+(\S+)/i);
      if (dl) content = `Fetched into sandbox: ${dl[1].slice(0, 200)}`;
    }
    if (!content) return;
    // Re-runs re-install the same packages: writeAgentMemory dedupes them.
    await writeAgentMemory(ctx.admin, {
      agent_id: ctx.agentId, workspace_id: ctx.workspaceId, project_id: ctx.projectId,
      kind: "context", content, importance: 2, source_run_id: ctx.runId ?? null,
    });
  } catch { /* best-effort */ }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x?\d+;/g, " ");
}

// ── Pentest authorization scope ───────────────────────────────────────────────
// The security tools (http_request) only act on targets the workspace has
// EXPLICITLY authorized via agent_pentest_scope. Default-deny: no active/attested
// scope entry ⇒ nothing is in scope.
interface PentestScopeEntry { label: string; targets: string[] }
async function loadPentestScope(ctx: InternalToolContext): Promise<PentestScopeEntry[]> {
  const { data } = await ctx.admin
    .from("agent_pentest_scope")
    .select("label, targets")
    .eq("project_id", ctx.projectId)
    .eq("authorized", true);
  return ((data ?? []) as PentestScopeEntry[]).filter((e) => Array.isArray(e.targets) && e.targets.length);
}

/** Whether a URL's host is covered by an authorized scope target. Supports an
 *  exact host, a parent domain (sub-domain match) and a "*.example.com" wildcard.
 *  IPs match exactly. Conservative by design — when unsure, it's NOT in scope. */
function hostInScope(rawUrl: string, scope: PentestScopeEntry[]): { ok: boolean; host?: string } {
  let host: string;
  try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return { ok: false }; }
  if (!host) return { ok: false };
  const targets = scope.flatMap((e) => e.targets).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  for (const t of targets) {
    const bare = t.replace(/^\*\./, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!bare) continue;
    if (host === bare || host.endsWith(`.${bare}`)) return { ok: true, host };
  }
  return { ok: false, host };
}

/** Outils de reconnaissance réseau : leur seul emploi est de sonder un tiers. */
const SCANNER_BINARIES =
  /\b(nmap|masscan|zmap|ffuf|gobuster|dirb|dirbuster|feroxbuster|sqlmap|nuclei|nikto|whatweb|wpscan|hydra|medusa|patator|amass|subfinder|httpx|naabu|katana|testssl|sslscan|metasploit|msfconsole|msfvenom|responder|crackmapexec|enum4linux)\b/i;

/**
 * Une commande shell lance-t-elle un scanner, et si oui, le périmètre autorisé
 * existe-t-il ? — correctif FOS-21.
 *
 * CE QUI N'ALLAIT PAS
 * `http_request` refusait bien toute cible hors périmètre attesté, mais la
 * consigne donnée au modèle juste en dessous disait : « les scanners passent par
 * shell_exec (nmap, ffuf, sqlmap, nuclei, whatweb…) » — et shell_exec n'avait
 * aucun contrôle. Le garde-fou se contournait donc en une ligne. Un agent
 * détourné par injection de prompt scannait des tiers depuis l'infrastructure de
 * la plateforme, ce qui engage sa responsabilité.
 *
 * CE QUE CE CONTRÔLE VAUT, ET CE QU'IL NE VAUT PAS
 * Il exige qu'un humain (owner ou admin — c'est la politique RLS de
 * `agent_pentest_scope`) ait déclaré et attesté un périmètre avant qu'un
 * scanner puisse seulement démarrer. Il n'empêche pas un `curl` en boucle : le
 * seul contrôle qui ne se contourne pas par le choix d'un autre outil est un
 * pare-feu sortant en refus par défaut sur le réseau du bac à sable, ouvert aux
 * seuls hôtes du périmètre. Ceci réduit la friction à zéro pour l'usage
 * légitime et la rend infranchissable pour l'usage accidentel.
 */
async function scannerGuard(ctx: InternalToolContext, command: string): Promise<string | null> {
  if (!SCANNER_BINARIES.test(command)) return null;
  const scope = await loadPentestScope(ctx);
  if (scope.length) return null;
  return (
    "ERROR: cette commande lance un outil de test d'intrusion, et aucun périmètre " +
    "autorisé n'est déclaré pour ce projet. Scanner un système sans autorisation " +
    "écrite est illégal dans la plupart des juridictions, et l'infrastructure qui " +
    "émet le scan est celle de la plateforme. Un owner ou un admin doit déclarer " +
    "et attester le périmètre dans l'application (Admin → Gouvernance → Périmètre " +
    "pentest) avant tout test actif. Voir aussi l'outil pentest_scope."
  );
}

function slugToToolName(prefix: string, slug: string): string {
  return `${prefix}_${slug.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`.slice(0, 60);
}

interface InternalTool {
  def: ToolDef["function"];
  run: (args: Record<string, unknown>) => Promise<string>;
  /** The description carries a REQUIRED output contract (JSON schema, enum,
   *  exact format). Never truncated by compactToolDefs — a half-sent schema is
   *  worse than none, since the model is still told to follow one. */
  incompressible?: boolean;
  /** Per-tool output compressor. When a tool can legitimately return MORE than
   *  TOOL_RESULT_CAP, it declares how to shrink its own output deterministically
   *  (keep the verdict / tail / key rows, mark what was cut) instead of letting
   *  the generic truncateMiddle in ai.ts blind-cut the middle. Applied by the
   *  executor right after `run`; MUST be deterministic for the same input so the
   *  sealed transcript hash stays stable. */
  compress?: (result: string, maxChars: number) => string;
  /** Executable, but NOT advertised in `defs`. Used for deprecated names kept as
   *  aliases (so a model that learned the old name still works) without paying
   *  for their schema on every round. */
  hidden?: boolean;
  /** Toolbox family — drives progressive disclosure (see toolFamily / defsFor). */
  family?: ToolFamily;
}

// ---------------------------------------------------------------------------
// built-in capability implementations
// ---------------------------------------------------------------------------

export async function webSearch(query: string, maxResults: number): Promise<string> {
  const tavilyKey = Deno.env.get("TAVILY_API_KEY");
  if (tavilyKey) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: tavilyKey, query, max_results: maxResults }),
    });
    if (res.ok) {
      const json = await res.json();
      const results = (json.results ?? []).map((r: any) => ({
        title: r.title,
        url: r.url,
        snippet: (r.content ?? "").slice(0, 300),
      }));
      return JSON.stringify({ provider: "tavily", results });
    }
  }
  // Primary engine: Jina Search (s.jina.ai) — same reliable fetch infra as
  // read_url, works from datacenter IPs (Supabase), uses JINA_API_KEY when set.
  // Replaces DDG/Bing HTML scraping which gets 202/anti-bot on datacenter IPs.
  let results = await jinaSearch(query, maxResults);
  let provider = "jina";
  // Last-ditch keyless fallbacks (rarely needed now).
  if (results.length === 0) {
    const bing = await fetchBing(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`);
    if (bing) { results = parseBingHtml(bing, maxResults); provider = "bing"; }
  }
  if (results.length === 0) {
    const html = await fetchDdg(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    if (html) { results = parseDdgHtml(html, maxResults); provider = "duckduckgo"; }
  }
  if (results.length === 0) {
    return "ERROR: web search returned no results. Read a source directly with read_url (e.g. a Made-in-China / Alibaba category or search URL) — that fetch path is reliable.";
  }
  return JSON.stringify({ provider, results });
}

// Jina Search: fetch a search-results feed through Jina (like read_url does for a
// page). Returns real organic results (title/url/snippet) as JSON. Keyless works
// but is rate-limited; JINA_API_KEY (already used by read_url + embeddings) makes
// it reliable. `X-Respond-With: no-content` returns SERP metadata only (fast).
async function jinaSearch(query: string, maxResults: number): Promise<SearchHit[]> {
  const key = Deno.env.get("JINA_API_KEY");
  try {
    const res = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
      headers: {
        "Accept": "application/json",
        "X-Respond-With": "no-content",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const items = Array.isArray(json?.data) ? json.data : [];
    return items.slice(0, maxResults).map((r: Record<string, unknown>) => ({
      title: str(r.title),
      url: str(r.url),
      snippet: (str(r.description) || str(r.content)).slice(0, 300),
    })).filter((h: SearchHit) => !!h.url);
  } catch {
    return [];
  }
}

async function fetchDdg(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FounderOSAgent/1.0)" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Bing HTML SERP fallback (keyless). Uses a browser UA so Bing serves the real
// results page rather than a redirect/consent stub.
async function fetchBing(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function parseBingHtml(html: string, maxResults: number): SearchHit[] {
  const results: SearchHit[] = [];
  // Each organic result is an <li class="b_algo"> … <h2><a href="URL">TITLE</a></h2>
  // … <p …>SNIPPET</p>. Walk the b_algo blocks and pull the first link + snippet.
  const blockRe = /<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>|$)/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) && results.length < maxResults) {
    const chunk = block[0];
    const link = chunk.match(/<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = link[1];
    if (!/^https?:\/\//i.test(url)) continue;
    const snip = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({
      title: decodeEntities(link[2].replace(/<[^>]+>/g, "")).trim(),
      url,
      snippet: snip ? decodeEntities(snip[1].replace(/<[^>]+>/g, "")).trim().slice(0, 300) : "",
    });
  }
  return results;
}

interface SearchHit { title: string; url: string; snippet: string }

// Unwrap DDG redirect links: //duckduckgo.com/l/?uddg=<encoded>
function unwrapDdgUrl(url: string): string {
  const uddg = url.match(/uddg=([^&]+)/);
  return uddg ? decodeURIComponent(uddg[1]) : url;
}

function parseDdgHtml(html: string, maxResults: number): SearchHit[] {
  const results: SearchHit[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = snippetRe.exec(html)) && snippets.length < maxResults) {
    snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim());
  }
  while ((m = linkRe.exec(html)) && results.length < maxResults) {
    results.push({
      title: decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim(),
      url: unwrapDdgUrl(m[1]),
      snippet: snippets[results.length] ?? "",
    });
  }
  return results;
}

function parseDdgLite(html: string, maxResults: number): SearchHit[] {
  const results: SearchHit[] = [];
  const linkRe = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && results.length < maxResults) {
    const url = unwrapDdgUrl(m[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim(),
      url,
      snippet: "",
    });
  }
  return results;
}

export async function readUrl(raw: string): Promise<string> {
  const url = normalizeUrl(raw);
  if (!url) return `ERROR: « ${raw.slice(0, 80)} » n'est pas une URL. Donne une adresse complète (https://…), ou passe par web_search si tu ne connais pas encore le lien.`;
  // Jina Reader proxies and extracts readable content; no API key required.
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { "X-Return-Format": "markdown" },
  });
  if (!res.ok) return `ERROR: could not fetch (${res.status}).`;
  return (await res.text()).slice(0, 250000);
}

export async function searchKnowledge(
  ctx: InternalToolContext,
  query: string,
  limit: number,
  collectionIds: string[] = [],
): Promise<string> {
  // Semantic search. If the agent has activated specific RAG Center collections,
  // search those; otherwise search the project's RAG agents. Keyword fallback
  // when embeddings are unavailable.
  try {
    const { embedTexts, toVectorLiteral } = await import("./jina.ts");
    const [vec] = await embedTexts([query], "retrieval.query", {
      workspace_id: ctx.workspaceId, project_id: ctx.projectId,
      agent_id: ctx.agentId, run_id: ctx.runId, feature: "agent-search-knowledge",
    });
    if (vec) {
      const vecLiteral = toVectorLiteral(vec);
      const hits: Array<{ similarity: number; text: string }> = [];

      if (collectionIds.length > 0) {
        // Single RPC across all activated collections.
        const { data, error } = await ctx.admin.rpc("match_rag_collection_chunks", {
          p_collection_ids: collectionIds,
          p_query_embedding: vecLiteral,
          p_match_count: limit,
        });
        if (!error && data) {
          for (const d of data as Array<{ similarity?: number; content?: string }>) {
            hits.push({ similarity: d.similarity ?? 0, text: (d.content ?? "").slice(0, 600) });
          }
        }
      } else {
        const { data: agents } = await ctx.admin
          .from("rag_agents")
          .select("id")
          .eq("project_id", ctx.projectId)
          .limit(10);
        for (const a of agents ?? []) {
          const { data, error } = await ctx.admin.rpc("match_rag_chunks", {
            p_agent_id: (a as { id: string }).id,
            p_query_embedding: vecLiteral,
            p_match_count: limit,
          });
          if (!error && data) {
            for (const d of data as Array<{ similarity?: number; content?: string }>) {
              hits.push({ similarity: d.similarity ?? 0, text: (d.content ?? "").slice(0, 600) });
            }
          }
        }
      }
      if (hits.length) {
        hits.sort((x, y) => y.similarity - x.similarity);
        return JSON.stringify(hits.slice(0, limit));
      }
    }
  } catch {
    // embeddings / rpc unavailable — fall through to keyword search
  }
  let kw = ctx.admin
    .from("rag_chunks")
    .select("content")
    .ilike("content", `%${query.slice(0, 60)}%`)
    .limit(limit);
  kw = collectionIds.length > 0 ? kw.in("collection_id", collectionIds) : kw.eq("project_id", ctx.projectId);
  const { data } = await kw;
  if (!data || data.length === 0) return "No matching knowledge found.";
  return JSON.stringify(data.map((d: { content?: string }) => ({ text: (d.content ?? "").slice(0, 600) })));
}

// Deep research: multi-step web research → synthesis
export async function deepResearch(query: string, maxSources = 5): Promise<string> {
  const jobs: Promise<string>[] = [
    webSearch(query, maxSources),
    webSearch(`${query} latest news analysis`, 3),
  ];
  const [mainRaw, newsRaw] = await Promise.allSettled(jobs);
  const parseResults = (raw: PromiseSettledResult<string>) => {
    if (raw.status !== "fulfilled") return [];
    try { return JSON.parse(raw.value)?.results ?? []; } catch { return []; }
  };
  const allResults = [...parseResults(mainRaw), ...parseResults(newsRaw)];
  const seen = new Set<string>();
  const unique = allResults.filter((r: any) => { if (seen.has(r.url)) return false; seen.add(r.url); return true; });
  const topUrls = unique.slice(0, maxSources).map((r: any) => r.url);

  // Read top URLs in parallel
  const readJobs = topUrls.map((url: string) => readUrl(url).catch(() => ""));
  const contents = await Promise.allSettled(readJobs);
  const sourceTexts = contents.map((c, i) => {
    const text = c.status === "fulfilled" ? c.value : "";
    return `[Source ${i + 1}: ${topUrls[i]}]\n${text.slice(0, 3000)}`;
  }).join("\n\n---\n\n");

  // Synthesize via LLM
  const { callAi } = await import("./ai.ts");
  let synthesis = "";
  try {
    const res = await callAi({
      task: "content_generation",
      systemPrompt: "You are a research analyst. Synthesize the provided sources into a structured brief with: Executive Summary, Key Findings (bullet points), Data Points, Risks/Concerns, Sources. Be specific and cite source numbers.",
      userPrompt: `RESEARCH QUERY: ${query}\n\nSOURCES:\n${sourceTexts}`,
      maxTokens: 2000,
      temperature: 0.3,
    });
    synthesis = res.content ?? "";
  } catch (e) {
    synthesis = "Synthesis unavailable: " + (e instanceof Error ? e.message : String(e));
  }

  return JSON.stringify({
    query,
    sources: unique.slice(0, maxSources).map((r: any) => ({ title: r.title, url: r.url, snippet: r.snippet })),
    synthesis,
    source_count: unique.length,
  });
}

async function queryTable(
  ctx: InternalToolContext,
  allowedTables: string[],
  args: Record<string, unknown>,
): Promise<string> {
  const table = str(args.table);
  if (!table) return "ERROR: table is required.";
  if (!allowedTables.includes(table)) {
    return `ERROR: table "${table}" is not allowed. Allowed tables: ${allowedTables.join(", ") || "(none configured)"}.`;
  }
  let columns = str(args.columns, "*");
  // SECURITY: only plain column names / "*" — block PostgREST embed `other(*)`,
  // rename `a:b`, casts `::` and FK hints `!`, which (on a service-role client
  // that bypasses RLS) could pull data from non-allowlisted related tables.
  if (!/^[\w\s,*]+$/.test(columns)) {
    return `ERROR: invalid columns. Use a comma-separated list of plain column names or "*" (no joins/embeds).`;
  }
  columns = columns.replace(/\s+/g, "");
  const limit = Math.min(Math.max(Number(args.limit ?? 25) || 25, 1), 100);
  const orderBy = str(args.order_by);
  const filters = (args.filters && typeof args.filters === "object" ? args.filters : {}) as Record<string, unknown>;

  // The query MUST stay inside the project: scope by project_id, falling back
  // to workspace_id for workspace-level tables. Tables with neither column are
  // refused — we never run an unscoped read with the service role.
  for (const scopeCol of ["project_id", "workspace_id"] as const) {
    let q = ctx.admin.from(table).select(columns).limit(limit);
    q = q.eq(scopeCol, scopeCol === "project_id" ? ctx.projectId : ctx.workspaceId);
    for (const [k, v] of Object.entries(filters)) {
      if (/^[a-zA-Z0-9_]+$/.test(k)) q = q.eq(k, v as never);
    }
    if (orderBy && /^[a-zA-Z0-9_]+$/.test(orderBy)) {
      q = q.order(orderBy, { ascending: args.descending !== true });
    }
    const { data, error } = await q;
    if (!error) return cap(JSON.stringify(data ?? []));
    // 42703 = undefined column → the scope column doesn't exist on this table.
    if (error.code !== "42703") return `ERROR: ${error.message}`;
  }
  return `ERROR: table "${table}" has neither project_id nor workspace_id — it cannot be read safely.`;
}

async function listConnectors(ctx: InternalToolContext): Promise<string> {
  // Scoped inventory (migration 0177): what THIS agent can actually reach —
  // its dashboard's connections plus the project-wide fallbacks, and its
  // owner's personal accounts flagged as such (usable only on explicit
  // request via use_personal_account).
  const { data } = await ctx.admin
    .from("connectors")
    .select("provider, status, permissions, scope, service_dashboard_id, owner_user_id")
    .eq("project_id", ctx.projectId);
  if (!data || data.length === 0) return "No connectors configured for this project.";
  const rows = (data as Array<{
    provider: string; status: string; permissions: string;
    scope: string; service_dashboard_id: string | null; owner_user_id: string | null;
  }>).filter((c) =>
    c.scope === "project" ||
    (c.scope === "dashboard" && c.service_dashboard_id === ctx.serviceDashboardId) ||
    (c.scope === "personal" && c.service_dashboard_id === ctx.serviceDashboardId && c.owner_user_id === ctx.userId));
  if (rows.length === 0) return "No connectors reachable from this dashboard.";
  return JSON.stringify(rows.map((c) => ({
    provider: c.provider, status: c.status, permissions: c.permissions,
    scope: c.scope,
    ...(c.scope === "personal" ? { note: "personal account — set use_personal_account:true to act through it" } : {}),
  })));
}

async function invokeEdgeFunction(slug: string, args: Record<string, unknown>): Promise<string> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return "ERROR: edge function invocation is not configured.";
  const res = await fetch(`${base}/functions/v1/${slug}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  return cap(`HTTP ${res.status}\n${text}`, 6000);
}

async function invokeWebhook(
  url: string,
  method: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "ERROR: webhook url must be absolute http(s).";
  const res = await fetch(url, {
    method: method || "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  return cap(`HTTP ${res.status}\n${text}`, 6000);
}

// ---------------------------------------------------------------------------
// collaboration (inter-agent) implementations
// ---------------------------------------------------------------------------

// Resolve (or create) the canonical A2A thread for an agent pair. The pair is
// stored ordered (agent_a < agent_b) so each pair has a single thread.
async function getOrCreateThread(
  ctx: InternalToolContext,
  peerId: string,
): Promise<string> {
  const [a, b] = [ctx.agentId, peerId].sort();
  const { data: existing } = await ctx.admin
    .from("internal_agent_a2a_threads")
    .select("id")
    .eq("agent_a", a)
    .eq("agent_b", b)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await ctx.admin
    .from("internal_agent_a2a_threads")
    .insert({ workspace_id: ctx.workspaceId, project_id: ctx.projectId, agent_a: a, agent_b: b })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

// Fire-and-forget: ask the a2a edge to make the recipient agent react now.
// The scheduler is the safety net if this invocation fails.
async function triggerA2A(messageId: string): Promise<void> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return;
  try {
    await fetch(`${base}/functions/v1/internal-agent-a2a`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message_id: messageId }),
    });
  } catch { /* scheduler will pick it up */ }
}

// ---------------------------------------------------------------------------
// toolset assembly
// ---------------------------------------------------------------------------

const DELIVERABLE_KINDS = [
  "report", "coding_session", "test_session", "simulation_session",
  "markdown", "json", "code", "url",
];
/**
 * What the MODEL is allowed to choose. `markdown` is deliberately absent: an
 * option a model can see is an option it will take, and prose is a downgrade of
 * every deliverable this app renders. Removing it from the enum is what makes
 * "always JSON" real — the refusal further down is only the backstop for a
 * model that ignores its own schema.
 *
 * DELIVERABLE_KINDS above stays complete: rows written before this change, and
 * the session kinds the studios emit, must still validate.
 */
const OFFERED_DELIVERABLE_KINDS = ["report", "json", "code", "url"];
/** Block types the renderer knows — mirrors src/features/artifacts/blocks.ts.
 *  A type absent here is refused at write time rather than rendering as a
 *  silent blank in the document. */
const ARTIFACT_BLOCK_TYPES = [
  "header", "paragraph", "list", "checklist", "image", "table", "quote", "code", "delimiter", "warning", "embed", "raw",
  "kpi", "chart", "comparison", "matrix", "callout", "slide",
];
const safeJson = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return null; } };
/** Structured kinds whose content is JSON validated at save time. */
const STRUCTURED_KINDS = new Set(["report", "coding_session", "test_session", "simulation_session"]);

// vibe_code tool — actions the engine understands, and the subset that WRITES
// to GitHub (those are what an "assisted" agent must get approved).
const VIBE_ACTIONS = ["run", "apply", "pr_status", "fix_pr", "merge_pr", "status"];
const WRITE_VIBE_ACTIONS = new Set(["apply", "fix_pr", "merge_pr"]);

/** Parse the "HTTP <status>\n<body>" envelope invokeEdgeFunction returns. */
function parseEdgeJson(raw: string): Record<string, unknown> | null {
  const nl = raw.indexOf("\n");
  if (nl < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(nl + 1));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
const ARTIFACT_KINDS = ["document", "presentation", "spreadsheet", "image", "text"];
/**
 * What the MODEL may create. `document` and `text` are withheld: their content
 * is markdown prose, which is exactly the format that must never carry a piece
 * of written work here. Locking create_deliverable alone was not enough — the
 * agent simply used this other door and shipped its analysis as a Plate
 * document, with the figures as markdown tables and no KPI or chart anywhere.
 *
 * The kinds left are the ones whose content is genuinely structured:
 * a deck, a sheet, an image. Anything WRITTEN goes through
 * create_deliverable(kind="report").
 */
const OFFERED_ARTIFACT_KINDS = ["image"];

// Guidance shown to the model for the structured `report` kind. The content is
// a JSON string matching this shape; the UI renders it as a designed report.
const REPORT_SCHEMA_HINT = `For kind="report", content MUST be a JSON string with this shape:
{
  "title": "string",
  "subtitle": "string, optional (e.g. 'Weekly report')",
  "author": "string, optional (the agent's name)",
  "summary": "string (1-3 sentences, executive summary)",
  "sections": [
    {
      "heading": "string",
      "body": "markdown paragraph(s), optional",
      "kpis": [{ "label": "string", "value": "string|number", "delta": "string, optional", "trend": "up|down|flat" }],
      "gauges": [{ "label": "string", "value": 72, "max": 100, "tone": "good|bad|neutral" }],
      "charts": [{ "type": "bar|line|area|pie|donut|radar|scatter", "title": "string", "x": "category key", "series": ["key1"], "data": [{ "<x>": "Jan", "key1": 12 }], "stacked": false }],
      "table": { "title": "string, optional", "columns": ["A","B"], "rows": [["x", 1]] },
      "timeline": [{ "date": "2026-06-01", "title": "string", "detail": "string", "tone": "info|success|warning|danger" }],
      "callout": { "tone": "info|success|warning|danger", "text": "string" },
      "images": [{ "url": "https://…", "caption": "what it shows and why it matters", "alt": "string, optional", "source": "site name, optional" }],
      "comparison": { "title": "string", "columns": ["Us","Rival A","Rival B"], "highlight": 0,
                      "rows": [{ "label": "criterion", "note": "optional detail", "cells": [true, "partial", false] }] },
      "matrix": { "title": "string", "x_label": "axis name", "y_label": "axis name",
                  "x_low": "low end", "x_high": "high end", "y_low": "low end", "y_high": "high end",
                  "quadrants": ["top-left","top-right","bottom-right","bottom-left"],
                  "items": [{ "label": "Player", "x": 70, "y": 40, "note": "why here", "highlight": false }] }
    }
  ]
}
MAKE REPORTS VISUAL AND PROFESSIONAL. Whenever you have numbers, SHOW them: lead a section with KPI cards, add at least one chart (pick the right type — line for trends over time, bar for comparisons, donut/pie for composition, radar for multi-dimension scores, scatter for correlation), use gauges for scores/completion, tables for detailed rows, a timeline for sequences of events, and callouts to highlight risks/wins. Prefer charts/KPIs over long prose. Every analytical report should contain visuals, not just text.
MINIMUM BAR for any analytical report: an executive KPI row in the first section, at least one chart, at least one table, and a closing callout with the recommendation. A section that is a wall of prose with no visual is a section you have not finished designing.
STRUCTURE the document like a consultant's deck, not a blog post: (1) executive summary with the KPIs and the verdict up front — a reader who stops after section 1 must already have the answer; (2) one section per subject, each opening with its own finding in one bold sentence, then the evidence; (3) a synthesis section that CONFRONTS the findings (what they mean together, what contradicts what); (4) a closing section with a ranked, actionable recommendation. Never end on a summary of what you did — end on what to do.
"comparison" is the right block for "X versus Y versus Z" (booleans render as real ✓/✕, and highlight marks our own column) — reach for it before a plain table. "matrix" is the right block for a positioning map: place every player on two named axes (0-100), name the four quadrants, and set highlight:true on us. Both beat a paragraph describing the same thing.
ANALYSE, do not inventory. Every section states a finding, backs it with a figure, and says the consequence. "Rival A charges $99/seat" is data; "Rival A's $99/seat puts them out of the SMB segment we own, which is why their published logos are all enterprise" is analysis. The report is judged on the second kind of sentence.
IMAGES: use "images" whenever the subject is visual — a product screenshot, a pricing page, a UI you are comparing, a diagram or photo you found while researching. The url must be a direct, absolute link to the image itself (ending in .png/.jpg/.webp/.svg, or a CDN image url), NEVER a link to the page that contains it. Always write a caption saying what it shows; a picture with no caption is decoration. Two to four well-chosen figures beat a gallery. If an image you generated is what matters, produce it with create_artifact(kind="image") instead — it becomes its own openable artifact.
A section body may also carry a chart as a fenced block: \`\`\`chart\\n{ "type":"bar", "x":"month", "series":["mrr"], "data":[...] }\\n\`\`\`
Markdown in "body" is rendered fully: headings, GFM tables, lists, links, images (![caption](url)), blockquotes and fenced code all work — use them instead of flattening everything into paragraphs.`;

// The studio artifact: a coding session rendered as a real session view (goal,
// plan, per-file diffs, commands, PR + preview). This is what the Vibe Code
// agent hands back instead of a prose recap.
const CODING_SESSION_SCHEMA_HINT = `For kind="coding_session", content MUST be a JSON string with this shape:
{
  "title": "string — what this session shipped",
  "goal": "string — the request in one sentence",
  "repository": "owner/repo",
  "branch": "string, optional (the base branch)",
  "status": "shipped|staged|failed|partial",
  "summary": "string (2-4 sentences: what changed and why)",
  "plan": [{ "step": "string", "status": "done|skipped|failed", "detail": "string, optional" }],
  "files": [{ "path": "src/x.ts", "change": "added|modified|deleted", "language": "ts", "summary": "one line", "diff": "unified diff or the new content, optional" }],
  "commands": [{ "cmd": "npm test", "result": "string, optional", "ok": true }],
  "pull_request": { "url": "https://github.com/…/pull/12", "number": 12, "title": "string", "state": "open|merged|draft" },
  "preview_url": "https://… , optional",
  "risks": ["string — what a reviewer must check"],
  "next_steps": ["string"]
}
Be concrete: real paths, real diffs, the real PR url. "files" is the heart of the artifact — never leave it empty when you changed code. Put anything a reviewer could get wrong in "risks".`;

const TEST_SESSION_SCHEMA_HINT = `For kind="test_session", content MUST be a JSON string with this shape:
{
  "title": "string", "app_url": "string", "verdict": "passed|failed|flaky|blocked",
  "summary": "string (2-4 sentences)",
  "cases": [{ "name": "string", "status": "passed|failed|skipped|blocked", "duration_s": 12, "failure": "what broke, optional", "screenshot_url": "optional", "steps": ["what it did"] }],
  "defects": [{ "title": "string", "severity": "critical|major|minor", "detail": "reproduction + expected vs actual", "case": "which case found it" }],
  "coverage": ["what this session actually exercised"],
  "next_steps": ["string"]
}
"cases" and "defects" are the artifact — a verdict with no case list is useless. Quote the real failure message, never paraphrase it.`;

const SIMULATION_SESSION_SCHEMA_HINT = `For kind="simulation_session", content MUST be a JSON string with this shape:
{
  "title": "string", "question": "the prediction question", "population": 12, "rounds": 6,
  "verdict": "string — the answer to the question, in one sentence",
  "confidence": "high|medium|low",
  "summary": "string (2-4 sentences)",
  "sentiment": [{ "round": 1, "positive": 3, "neutral": 6, "negative": 3 }],
  "cohorts": [{ "name": "string", "size": 4, "stance": "adopt|wait|reject", "why": "one line" }],
  "signals": [{ "quote": "what a persona actually said", "cohort": "string", "tone": "positive|neutral|negative" }],
  "risks": ["what would make this prediction wrong"],
  "next_steps": ["string"]
}
Quote real persona reactions in "signals" — invented quotes make the whole artifact worthless. "sentiment" must have one entry per round played.`;

export function buildInternalToolset(
  rows: AgentToolRow[],
  ctx: InternalToolContext,
): {
  defs: ToolDef[];
  /** Schemas for the CURRENT round. Pass as a thunk to runToolRounds so a
   *  mid-loop load_toolset / need_tools is visible on the very next round. */
  defsFor: (tier?: ToolTier) => ToolDef[];
  executor: ToolExecutor;
  capabilitySummary: string;
} {
  const tools = new Map<string, InternalTool>();
  const summaryLines: string[] = [];
  // Execution-family guidance rendered under the EXECUTION section of the tree.
  const sandboxGuidance: string[] = [];

  // Hoisted: which tool kinds this agent actually has. Needed EARLY so built-in
  // tools can gate the parts of their schema that only apply to a capability the
  // agent doesn't have (e.g. the coding_session contract on a non-coding agent).
  const enabled = rows.filter((r) => r.enabled);
  const hasKind = (k: AgentToolRow["kind"]) => enabled.some((r) => r.kind === k);

  // HYBRID namespacing: the runner and the sandbox register OVERLAPPING tool
  // names (shell_exec, python_exec, file_write, …). In single-world modes only
  // one branch runs, so names stay clean. In hybrid mode BOTH run, so right
  // after a world registers its tools we prefix the keys it just added
  // (runner_* / sandbox_*) — that lets both worlds coexist and lets the model
  // (guided by the plan's per-step env tag) pick a world explicitly. Tools that
  // already carry the prefix (sandbox_browser, sandbox_env) are left as-is.
  const prefixNewTools = (before: Set<string>, prefix: string): void => {
    if (!ctx.hybrid) return;
    for (const k of [...tools.keys()]) {
      if (before.has(k) || k.startsWith(prefix)) continue;
      const t = tools.get(k)!;
      const nk = `${prefix}${k}`;
      t.def.name = nk;
      tools.delete(k);
      tools.set(nk, t);
    }
  };

  // Always-on: deliverable materialisation.
  //
  // The output CONTRACT (the JSON shapes below) is the whole point of this tool:
  // without it the model is told to emit a schema it never sees, produces
  // free-form JSON, and every downstream salvage path fires. So the tool is
  // marked `incompressible` — and, to keep that affordable, only the session
  // schemas the agent can ACTUALLY produce are included (a non-coding agent
  // never emits a coding_session).
  const sessionHints = [
    hasKind("vibe_code") ? CODING_SESSION_SCHEMA_HINT : "",
    hasKind("testing") ? TEST_SESSION_SCHEMA_HINT : "",
    hasKind("simulation") ? SIMULATION_SESSION_SCHEMA_HINT : "",
  ].filter(Boolean).join("\n");
  // ══════════════════════════════════════════════════════════════════════════
  // ARTIFACTS — one JSON contract, two shapes
  // ══════════════════════════════════════════════════════════════════════════
  // Everything an agent writes is an Editor.js document: `{ blocks: [{type,
  // data}] }`. A REPORT is those blocks top to bottom; a PRESENTATION is the
  // same blocks cut into pages by `slide` blocks. There is no third format, no
  // markdown, no CSV, no prose blob — the front renders blocks with React
  // components and nothing else.
  //
  // Blocks accumulate in the run's draft (run_state.meta.artifact_draft) so a
  // long document is never squeezed into one tool-call argument, and so a run
  // that dies mid-way can still be salvaged.

  // The document IS an Editor.js document, so a block is only valid if the
  // Editor.js tool that owns it accepts its shape. A block whose data does not
  // match its tool renders as an empty node, and Editor.js treats an empty node
  // as an empty block — it is dropped the first time a human opens the report.
  // These shapes are the installed tools' own contracts, not a convention.
  const BLOCK_CATALOGUE =
    'BLOCS EDITOR.JS — la forme de `data` est imposée par l\'outil, un écart et le bloc est perdu à l\'ouverture. '
    + 'Natifs : header {text:"…", level:1|2|3|4} · paragraph {text:"…"} · '
    + 'list {style:"ordered"|"unordered", items:["texte","texte"]} (items = chaînes, jamais d\'objets) · '
    + 'checklist {items:[{text:"…", checked:false}]} · '
    + 'table {withHeadings:true, content:[["En-tête A","En-tête B"],["cellule","cellule"]]} '
    + '(content = tableau de lignes de CHAÎNES, toutes de même longueur ; la 1re ligne est l\'en-tête) · '
    + 'quote {text:"…", caption:"source", alignment:"left"} · code {code:"…"} · delimiter {} · '
    + 'warning {title:"…", message:"…"} (limite, réserve méthodologique, angle mort) · '
    + 'embed {service:"youtube"|"vimeo"|"figma"|"miro"|"codepen", source:"url de la page", embed:"url embarquable", width:580, height:320, caption?} · '
    + 'raw {html:"…"} (extrait conservé tel quel, affiché en clair, jamais interprété) · '
    + 'image {file:{url:"https://…"}, caption:"…", withBorder:false, withBackground:false, stretched:false}. '
    + 'Analytiques (outils maison, même exigence) : '
    + 'kpi {items:[{label,value,delta?,trend:"up"|"down"|"flat"}]} (1 à 4 items) · '
    + 'chart {chartType:"bar"|"line"|"area"|"pie"|"donut"|"radar"|"scatter", title?, x:"clé de catégorie", series:["clé"], data:[{"<x>":"Jan","clé":12}], stacked?} · '
    + 'comparison {title?, columns:["Nous","Rival A"], highlight?, rows:[{label, note?, cells:[true|false|"texte"]}]} (cells = 1 par colonne) · '
    + 'matrix {title?, xLabel, yLabel, xLow?, xHigh?, yLow?, yHigh?, quadrants:[4 libellés], items:[{label,x:0-100,y:0-100,note?,highlight?}]} · '
    + 'callout {tone:"info"|"success"|"warning"|"danger", text}. '
    + "Le TITRE du document est porté par l'application, pas par un bloc : n'écris ni bandeau de titre ni page de garde, commence directement par la première section. "
    + 'Présentation uniquement : slide {title:"Titre de la page"} — ouvre une page, le titre est obligatoire. '
    + 'RÈGLES : jamais de markdown dans un champ texte (ni #, ni **, ni |, ni -) — la structure passe par le TYPE du bloc. '
    + 'Le texte accepte seulement le HTML inline <b> <i> <code> <a href> <mark>. '
    + 'Un bloc sans contenu (liste vide, table sans lignes, chart sans data) est refusé.';

  /** Reject a block whose data its Editor.js tool would not accept.
   *  Refusing here, with the reason, is the only way the agent learns the shape:
   *  a block accepted now and dropped at render time is a silent data loss. */
  const checkBlockShape = (type: string, data: Record<string, unknown>): string | null => {
    const s = (k: string) => (typeof data[k] === "string" ? (data[k] as string).trim() : "");
    const arr = (k: string) => (Array.isArray(data[k]) ? data[k] as unknown[] : null);
    const hasMd = (t: string) => /(^|\n)\s{0,3}#{1,6}\s|\*\*|(^|\n)\s*[-*]\s+|(^|\n)\s*\|/.test(t);
    switch (type) {
      case "header": {
        if (!s("text")) return 'header exige data.text non vide.';
        const lvl = Number(data.level);
        if (!Number.isInteger(lvl) || lvl < 1 || lvl > 4) return 'header exige data.level entier de 1 à 4.';
        if (hasMd(s("text"))) return 'header.text ne doit pas contenir de markdown : le niveau est porté par data.level.';
        return null;
      }
      case "paragraph": {
        if (!s("text")) return 'paragraph exige data.text non vide.';
        if (hasMd(s("text")))
          return 'paragraph.text contient du markdown. Un titre est un bloc header, une liste un bloc list, un tableau un bloc table.';
        return null;
      }
      case "list": {
        const items = arr("items");
        if (!items?.length) return 'list exige data.items : un tableau de chaînes non vide.';
        if (items.some((i) => typeof i !== "string" || !i.trim()))
          return 'list.items doit contenir des CHAÎNES non vides (pas d\'objets {text:…}).';
        if (data.style !== "ordered" && data.style !== "unordered")
          return 'list exige data.style = "ordered" ou "unordered".';
        return null;
      }
      case "checklist": {
        const items = arr("items");
        if (!items?.length) return 'checklist exige data.items:[{text, checked}].';
        if (items.some((i) => !i || typeof i !== "object" || typeof (i as { text?: unknown }).text !== "string"))
          return 'checklist.items exige des objets {text:"…", checked:true|false}.';
        return null;
      }
      case "table": {
        const rows = arr("content");
        if (!rows?.length) return 'table exige data.content : un tableau de lignes, la première étant l\'en-tête.';
        if (rows.some((r) => !Array.isArray(r))) return 'table.content doit être un tableau de TABLEAUX (une ligne = un tableau de cellules).';
        const width = (rows[0] as unknown[]).length;
        if (!width) return 'table : la ligne d\'en-tête est vide.';
        if ((rows as unknown[][]).some((r) => r.length !== width))
          return `table : toutes les lignes doivent avoir ${width} cellules, comme l'en-tête.`;
        return null;
      }
      case "quote": return s("text") ? null : 'quote exige data.text.';
      case "warning": return s("title") || s("message") ? null : 'warning exige data.title et data.message.';
      case "raw": return s("html") ? null : 'raw exige data.html.';
      case "embed":
        return s("embed") || s("source") ? null : 'embed exige data.embed (URL embarquable) et data.source (URL de la page).';
      case "code": return s("code") ? null : 'code exige data.code.';
      case "image": {
        const file = data.file as { url?: unknown } | undefined;
        return typeof file?.url === "string" && file.url.trim() ? null : 'image exige data.file.url (une URL http(s)).';
      }
      case "kpi": {
        const items = arr("items");
        if (!items?.length) return 'kpi exige data.items:[{label, value}] (1 à 4).';
        if (items.some((i) => !i || typeof i !== "object" || !(i as { label?: unknown }).label))
          return 'kpi.items exige des objets {label:"…", value:"…"}.';
        return null;
      }
      case "chart": {
        if (!arr("data")?.length) return 'chart exige data.data : les points, ex. [{"mois":"Jan","valeur":12}].';
        if (!arr("series")?.length) return 'chart exige data.series : les clés à tracer, ex. ["valeur"].';
        if (!s("x")) return 'chart exige data.x : la clé de catégorie, ex. "mois".';
        return null;
      }
      case "comparison": {
        const cols = arr("columns"); const rows = arr("rows");
        if (!cols?.length || !rows?.length) return 'comparison exige data.columns et data.rows non vides.';
        if (rows.some((r) => !Array.isArray((r as { cells?: unknown }).cells) || ((r as { cells: unknown[] }).cells).length !== cols.length))
          return `comparison : chaque ligne doit porter cells avec ${cols.length} entrées, une par colonne.`;
        return null;
      }
      case "matrix": {
        const items = arr("items");
        if (!items?.length) return 'matrix exige data.items:[{label, x:0-100, y:0-100}].';
        if (items.some((i) => typeof (i as { x?: unknown }).x !== "number" || typeof (i as { y?: unknown }).y !== "number"))
          return 'matrix.items exige x et y NUMÉRIQUES entre 0 et 100.';
        return null;
      }

      case "callout": return s("text") ? null : 'callout exige data.text.';
      case "slide": return s("title") ? null : 'slide exige data.title : une page sans titre est rendue comme un bloc vide et disparaît.';
      default: return null;
    }
  };

  const draftKey = (target: string) => (target === "presentation" ? "deck_draft" : "report_draft_v2");

  // Reports left this toolbox with the Rédacteur (0206). Where the delegation is
  // wired, a rapport written here would be a second, worse format living beside
  // the real one — so the target is refused, with the address of the agent that
  // owns it. Presentations stayed: a deck is not a report.
  const reportsDelegated = typeof ctx.requestReport === "function";

  // ── Was a PRESENTATION actually asked for? ────────────────────────────────
  // A deck is a format the reader has to sit through; nobody wants one they did
  // not ask for. Since reports left this toolbox, "presentation" became the only
  // writing target left — and an agent with something to write reaches for the
  // tool it still has. So the ask is verified against the run's own origin (the
  // mission brief, or the conversation) rather than trusted to the prompt.
  //
  // Read lazily and once: most runs never touch a deck and pay nothing.
  const DECK_ASKED = /\b(pr[ée]sentation|slides?|deck|powerpoint|keynote|diapo\w*|pitch)\b/i;

  /** Where this run comes from: its mission (if any) and the text of the ask.
   *  One read, reused by the deck gate and the report budget. */
  interface RunOrigin { missionId: string | null; delegated: boolean; text: string }
  let origin: RunOrigin | null = null;
  const runOrigin = async (): Promise<RunOrigin> => {
    if (origin) return origin;
    const parts: string[] = [];
    let missionId: string | null = null;
    let delegated = false;
    try {
      if (ctx.runId) {
        const { data: run } = await ctx.admin.from("internal_agent_runs")
          .select("mission_id, label").eq("id", ctx.runId).maybeSingle();
        missionId = (run as { mission_id?: string } | null)?.mission_id ?? null;
        parts.push(str((run as { label?: string } | null)?.label));
      }
      if (missionId) {
        const { data: m } = await ctx.admin.from("internal_agent_missions")
          .select("title, description, expected_deliverables, delegation_depth, delegated_by_agent")
          .eq("id", missionId).maybeSingle();
        const mm = (m ?? {}) as {
          title?: string; description?: string; expected_deliverables?: unknown;
          delegation_depth?: number; delegated_by_agent?: string | null;
        };
        parts.push(str(mm.title), str(mm.description), JSON.stringify(mm.expected_deliverables ?? ""));
        delegated = (mm.delegation_depth ?? 0) > 0 || !!mm.delegated_by_agent;
      }
      if (ctx.conversationId) {
        const { data: msgs } = await ctx.admin.from("internal_agent_messages")
          .select("content").eq("conversation_id", ctx.conversationId).eq("role", "user")
          .order("created_at", { ascending: false }).limit(6);
        for (const m of (msgs ?? []) as Array<{ content?: string }>) parts.push(str(m.content));
      }
    } catch { /* unreadable origin → the callers fall back to permissive defaults */ }
    origin = { missionId, delegated, text: parts.filter(Boolean).join(" \n ") };
    return origin;
  };

  const deckRequested = async (): Promise<boolean> => {
    const { text } = await runOrigin();
    // Nothing legible to check (a room turn, an odd entry point): allow, rather
    // than silently withdraw a format that used to work.
    return text.trim() ? DECK_ASKED.test(text) : true;
  };
  const DECK_NOT_ASKED =
    "ERROR: personne n'a demandé de présentation. Une présentation ne se produit QUE si l'utilisateur l'a demandée explicitement, "
    + "dans sa requête ou dans l'ordre de mission. "
    + (reportsDelegated
      ? "Ce que tu as à livrer ici est un rapport : passe ta matière au Rédacteur avec request_report(subject, material)."
      : 'Écris un rapport à la place : add_block(target="report", …) puis publish_artifact(target="report", …).');
  const REPORT_MOVED =
    'ERROR: tu n\'écris plus les rapports. Le Rédacteur les écrit tous — passe-lui ta matière avec '
    + 'request_report(subject, material, angle?) et il publie le document. '
    + '(add_block/publish_artifact ne servent plus qu\'aux présentations, target="presentation".)';
  const artifactTargets = reportsDelegated ? ["presentation"] : ["report", "presentation"];

  tools.set("add_block", {
    incompressible: true,
    family: "DELIVER",
    def: {
      name: "add_block",
      description:
        (reportsDelegated
          ? "Ajoute UN bloc à la PRÉSENTATION en cours de construction (les rapports passent par request_report). "
          : "Ajoute UN bloc au document en cours de construction. C'est ainsi que tu écris : un appel par bloc, dans l'ordre de lecture. ")
        + "Appelle-le dès que tu as les faits d'une partie — le fil de conversation est compacté au fil du run, un chiffre non écrit dans un bloc est un chiffre perdu. "
        + "Quand le document est complet, appelle publish_artifact. " + BLOCK_CATALOGUE,
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: artifactTargets, description: "Le document auquel ce bloc appartient." },
          block: { type: "object", description: 'Un bloc : { "type": "...", "data": { ... } }. Voir le catalogue ci-dessus.' },
        },
        required: ["target", "block"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const target = str(args.target) === "presentation" ? "presentation" : "report";
      if (target === "report" && reportsDelegated) return REPORT_MOVED;
      if (target === "presentation" && !(await deckRequested())) return DECK_NOT_ASKED;
      const raw = args.block;
      const block = (raw && typeof raw === "object" ? raw : safeJson(str(raw))) as { type?: string; data?: unknown } | null;
      if (!block?.type) {
        return 'ERROR: `block` doit être un objet { "type": "...", "data": { ... } }. ' + BLOCK_CATALOGUE;
      }
      if (!ARTIFACT_BLOCK_TYPES.includes(String(block.type))) {
        return `ERROR: type de bloc « ${block.type} » inconnu. ${BLOCK_CATALOGUE}`;
      }
      const data = (block.data && typeof block.data === "object" ? block.data : {}) as Record<string, unknown>;
      if (block.type === "slide" && target !== "presentation") {
        return "ERROR: le bloc « slide » n'existe que dans une présentation. Dans un rapport, une partie s'ouvre par un bloc header.";
      }
      const shapeError = checkBlockShape(String(block.type), data);
      if (shapeError) return `ERROR: ${shapeError} Le bloc n'a pas été ajouté — corrige sa forme et rappelle add_block.`;
      const meta = await readRunMeta(ctx);
      const key = draftKey(target);
      const draft = (Array.isArray(meta[key]) ? meta[key] : []) as unknown[];
      // Already written: refuse the copy, not the run. A model that cannot see
      // its own effect repeats the call, and the reader gets the same slide (or
      // the same KPI row) several times over.
      if (!REPEATABLE_BLOCKS.has(String(block.type))) {
        const candidate = { type: String(block.type), data };
        const rows = draft as Array<{ type: string; data: Record<string, unknown> }>;
        const sig = blockKey(candidate);
        const at = rows.findIndex((b) => blockKey(b) === sig);
        if (at >= 0) {
          return `Ce bloc « ${block.type} » est DÉJÀ dans le ${target} (position ${at + 1}, à l'identique) — il n'a pas été ajouté une seconde fois. `
            + `Continue la suite, ou publie avec publish_artifact (${draft.length} blocs).`;
        }
        // Same figures, reworded: a correction, not a second block. There is no
        // way to edit a block already added, so take the newer version in place.
        const substance = blockSubstanceKey(candidate);
        const sameAt = substance ? rows.findIndex((b) => blockSubstanceKey(b) === substance) : -1;
        if (sameAt >= 0) {
          rows[sameAt] = candidate;
          await writeRunMeta(ctx, { ...meta, [key]: draft });
          return `Ce bloc « ${block.type} » reprend des données DÉJÀ présentes (position ${sameAt + 1}) : cette version REMPLACE l'ancienne sur place, `
            + `elle n'a pas été ajoutée en double (${draft.length} blocs). Continue la suite.`;
        }
      }
      // A deck whose first block is not a slide has no pages: everything piles
      // into one, and the reader gets a single endless card where a presentation
      // was promised. Since reports left this toolbox, "presentation" is the only
      // target left — which is exactly when an agent reaches for it to write a
      // document. Refuse at the first block, while there is nothing to redo.
      if (target === "presentation" && draft.length === 0 && block.type !== "slide") {
        return 'ERROR: une présentation COMMENCE par un bloc slide : add_block(target="presentation", block={type:"slide", data:{title:"…"}}) ouvre la page, '
          + "les blocs suivants la remplissent, et le slide suivant ouvre la page d'après. "
          + (reportsDelegated
            ? "Si ce que tu écris est un rapport et non une présentation, ce n'est pas ici : passe la matière au Rédacteur avec request_report."
            : "Si ce que tu écris est un document défilant, utilise target=\"report\".");
      }
      draft.push({ type: block.type, data });
      await writeRunMeta(ctx, { ...meta, [key]: draft });
      return `Bloc « ${block.type} » ajouté (${draft.length} bloc(s) dans le ${target}). Continue, puis publish_artifact(target="${target}", title="…") pour publier.`;
    },
  });

  tools.set("publish_artifact", {
    incompressible: true,
    family: "DELIVER",
    def: {
      name: "publish_artifact",
      description:
        (reportsDelegated
          ? "Publie la présentation construite avec add_block. Un RAPPORT ne se publie pas ici : passe la matière à request_report. "
          : "Publie le document construit avec add_block. C'est le SEUL moyen de livrer quelque chose de rédigé — rapport d'analyse, veille, audit, compte rendu, présentation. ")
        + "Le contenu est le JSON des blocs, rendu par l'application. Il n'existe aucun autre format : ni markdown, ni tableur, ni document texte.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: artifactTargets, description: "report = document défilant ; presentation = slides." },
          title: { type: "string", description: "Titre court et lisible." },
        },
        required: ["target", "title"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const target = str(args.target) === "presentation" ? "presentation" : "report";
      if (target === "report" && reportsDelegated) return REPORT_MOVED;
      if (target === "presentation" && !(await deckRequested())) return DECK_NOT_ASKED;
      const title = str(args.title, target === "presentation" ? "Présentation" : "Rapport").slice(0, 120);
      const meta = await readRunMeta(ctx);
      const key = draftKey(target);
      const blocks = (Array.isArray(meta[key]) ? meta[key] : []) as Array<{ type: string; data: unknown }>;
      if (blocks.length === 0) {
        return `ERROR: aucun bloc n'a été construit pour ce ${target}. Appelle d'abord add_block(target="${target}", block={type, data}) une fois par bloc. ${BLOCK_CATALOGUE}`;
      }
      // Second gate, for a draft started before the first one existed: without a
      // single slide block the viewer has one page to show, and shows a wall.
      if (target === "presentation" && !blocks.some((b) => b.type === "slide")) {
        return `ERROR: cette présentation n'a AUCUN bloc slide — elle s'ouvrirait comme une seule page interminable. `
          + `Découpe-la : add_block(target="presentation", block={type:"slide", data:{title:"…"}}) avant chaque groupe de blocs (une idée par page, deux ou trois blocs au plus), puis republie.`;
      }
      const content = JSON.stringify({ time: Date.now(), version: "2.30.0", blocks });
      const summary = blocks
        .map((b) => (b.data as { text?: string; title?: string })?.title ?? (b.data as { text?: string })?.text ?? "")
        .filter(Boolean).join(" · ").replace(/<[^>]+>/g, "").slice(0, 200) || title;
      // Never announce a publish that did not happen — and never consume the
      // draft when it failed, or the seventeen blocks the agent just wrote
      // would be gone with no way to retry.
      try {
        await ctx.createDeliverable({ kind: target, name: title, content, summary });
      } catch (e) {
        return `ERROR: le ${target} n'a PAS été enregistré (${e instanceof Error ? e.message : "erreur inconnue"}). Tes ${blocks.length} blocs sont conservés — réessaie publish_artifact, ou signale l'échec dans ta réponse plutôt que d'affirmer que le document existe.`;
      }
      // Consume the draft so a second publish cannot duplicate the document.
      const { [key]: _used, ...rest } = meta;
      await writeRunMeta(ctx, rest);
      return `${target === "presentation" ? "Présentation" : "Rapport"} « ${title} » publié (${blocks.length} blocs). Résume-le en deux phrases dans ta réponse — le document s'ouvre en carte.`;
    },
  });

  if (reportsDelegated) {
    // ══════════════════════════════════════════════════════════════════════
    // REPORTS — you gather, Le Rédacteur writes
    // ══════════════════════════════════════════════════════════════════════
    // The old arrangement asked every agent to be a writer too: each carried the
    // whole reporting doctrine in its prompt, and each produced a slightly
    // different document. One agent owns it now. What arrives here is MATTER,
    // not a draft — the moment an agent starts writing prose for the report, the
    // report gets written twice and neither half is good.
    tools.set("request_report", {
      incompressible: true,
      family: "DELIVER",
      def: {
        name: "request_report",
        description:
          "Confie la rédaction d'un rapport au Rédacteur, l'agent qui écrit TOUS les rapports (bilan de mission, analyse, veille, audit, compte rendu, synthèse, livrable client). "
          + "UNIQUEMENT SUR DEMANDE : n'appelle cet outil que si l'utilisateur (ou la mission) demande EXPLICITEMENT un rapport, un document ou un livrable écrit. Une question, une analyse ou une recherche demandée en conversation se répond dans le chat, sans rapport. "
          + "Tu ne rédiges pas : tu lui passes la MATIÈRE — chiffres avec leur source et leur date, citations, constats, ce qui reste incertain — et il publie le document. "
          + "Passe TOUT ce que tu as recueilli : il n'a aucun outil pour aller chercher ce qui manque, et ce qu'il n'a pas, il l'écrira « non publié ». "
          + "À LA FIN, PAS À CHAQUE ÉTAPE : le rapport se demande une fois la mission terminée, quand toute la matière est là — pas au bout de chaque sous-tâche. "
          + "UN SEUL rapport répond à une mission : rassemble TOUT et fais-le écrire en une fois, plutôt que d'en demander un par sujet. Deux au maximum, et seulement si les sujets ne tiennent vraiment pas dans un même document. "
          + "L'appel rend la main quand le rapport est publié ; résume-le ensuite en une phrase, ne le recopie pas.",
        parameters: {
          type: "object",
          properties: {
            subject: { type: "string", description: "De quoi parle le rapport, en une ligne." },
            material: {
              type: "string",
              description:
                "La matière brute, aussi complète que possible : les chiffres AVEC leur source et leur date, les citations, "
                + "les constats, les contradictions entre sources, ce qui n'a pas pu être vérifié. Du texte structuré, pas un rapport rédigé.",
            },
            angle: { type: "string", description: "La question à laquelle le rapport doit répondre, ou ce qu'il doit démontrer." },
            audience: { type: "string", description: "Qui le lit (un client, l'équipe, un comité) — ça règle le registre." },
            accent: { type: "string", description: "Couleur d'accent, si le client en a une : blue, indigo, teal, green, amber, rose, plum, slate." },
          },
          required: ["subject", "material"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const subject = str(args.subject).trim();
        const material = str(args.material).trim();
        if (!subject) return "ERROR: `subject` est requis — dis en une ligne de quoi parle le rapport.";
        if (material.length < 120) {
          return "ERROR: `material` fait moins de 120 caractères. Le Rédacteur n'enquête pas : sans matière il ne peut écrire que des généralités. "
            + "Rassemble d'abord tes résultats (recall_findings, tes appels d'outils), puis rappelle request_report.";
        }
        // ── A SUB-TASK DOES NOT WRITE THE REPORT ──────────────────────────
        // A mission is split across parallel sub-agents and delegated missions,
        // each finishing on its own run. Letting every one of them publish gave
        // a mission with six sub-tasks six reports, none of which was the report
        // anyone asked for. A sub-task hands its matter UP; the run that closes
        // the mission is the one that writes.
        if (ctx.isSubagent) {
          return "ERROR: tu es un sous-agent — tu n'écris pas de rapport. Termine par un compte rendu TEXTUEL complet de ta sous-tâche "
            + "(les chiffres avec leur source et leur date, les constats, ce qui reste incertain) : il remonte à l'agent principal, "
            + "qui rassemble tout et fait écrire UN rapport à la fin de la mission.";
        }
        const { missionId, delegated } = await runOrigin();
        if (delegated || (ctx.delegationDepth ?? 0) > 0) {
          return "ERROR: cette mission t'a été déléguée — le rapport final revient à l'agent qui a délégué, pas à toi. "
            + "Termine par un compte rendu TEXTUEL complet (chiffres, sources, constats, incertitudes) : il lui est transmis et il en fera UN rapport.";
        }

        // ONE report answers a mission. A second is sometimes legitimate (two
        // subjects that genuinely do not belong in one document); a third never
        // is — past that, the reader is handed a pile instead of an answer, and
        // each one costs a full authoring pass.
        //
        // Counted over the MISSION, not the run: a mission re-ticks, retries and
        // resumes across several runs, and a per-run budget resets each time.
        let written = 0;
        const scope = missionId
          ? { col: "mission_id", id: missionId }
          : (ctx.runId ? { col: "run_id", id: ctx.runId } : null);
        if (scope) {
          const { count } = await ctx.admin
            .from("internal_agent_deliverables")
            .select("id", { count: "exact", head: true })
            .eq(scope.col, scope.id).eq("kind", "report");
          written = count ?? 0;
        }
        if (written >= REPORT_BUDGET) {
          return `ERROR: ${written} rapports ont déjà été publiés pour ${missionId ? "cette mission" : "ce travail"} — c'est le maximum. `
            + "N'en écris pas un troisième : ce qui reste à dire complète l'un des deux existants. "
            + "Termine en résumant ce qui a été produit.";
        }
        const out = await ctx.requestReport!({
          subject, material,
          angle: str(args.angle) || undefined,
          audience: str(args.audience) || undefined,
          accent: str(args.accent) || undefined,
        });
        return written === REPORT_BUDGET - 1
          ? `${out}\n\nC'était le second et dernier rapport de ce travail — tout ce qui reste à dire complète l'un des deux.`
          : out;
      },
    });
    summaryLines.push('- request_report: confier un rapport au Rédacteur (tu rassembles la matière, il écrit et publie). Tu n\'écris JAMAIS de rapport toi-même, et UN SEUL rapport répond à un travail.');
    summaryLines.push('- add_block / publish_artifact: construire une PRÉSENTATION, un bloc à la fois (target="presentation") — UNIQUEMENT si l\'utilisateur en a demandé une.');
  } else {
    summaryLines.push('- add_block / publish_artifact: écrire un rapport ou une présentation, un bloc à la fois, en JSON rendu par l\'app (le SEUL format de livrable).');
  }


  tools.set("create_deliverable", {
    incompressible: true,
    family: "DELIVER",
    def: {
      name: "create_deliverable",
      description:
        "Save a finished deliverable — your durable output. Prefer kind=\"report\" for analyses/results: a modern, designed document with sections, KPIs, charts and tables. BEFORE writing a report, DESIGN it with your Report Designer skill — read_skill_file(slug=\"report-designer\", path=\"principles.md\" then \"schema.md\", and \"example.md\" for a full model) — so it reads like an executive dashboard, not prose. `content` must be a STRING (a JSON string for structured kinds). For a LARGE report, don't cram it into one call: build it section-by-section with report_section(...), then call create_deliverable(kind=\"report\") with NO content to finalize. Use markdown/json/code/url for simpler outputs. Call once per expected deliverable; summarise (don't repeat the full content) in your final answer.\n" +
        REPORT_SCHEMA_HINT + (sessionHints ? "\n" + sessionHints : ""),
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: OFFERED_DELIVERABLE_KINDS, description: "'report' par défaut, pour absolument tout contenu rédigé (analyse, veille, audit, bilan, comparatif, note, compte rendu) : son content est un JSON structuré rendu par l'app. Il n'existe PAS d'option markdown — ne rédige jamais un livrable en prose markdown. 'json' = données brutes, 'code' = du code, 'url' = un simple lien." },
          name: { type: "string", description: "Short human-readable name." },
          content: { type: "string", description: "The full deliverable content (for report: the JSON string described above)." },
        },
        required: ["kind", "name", "content"],
        additionalProperties: false,
      },
    },
    run: async () => {
      // Retired: the artifact system is add_block + publish_artifact now.
      if (reportsDelegated) return "ERROR: create_deliverable n'existe plus, et tu n'écris plus les rapports. Un rapport se demande au Rédacteur avec request_report(subject, material, angle?) ; une présentation se construit avec add_block(target=\"presentation\") puis publish_artifact.";
      return "ERROR: create_deliverable n'existe plus. Tout ce que tu rédiges est un document JSON rendu par l'app : construis-le avec add_block(target=\"report\"|\"presentation\", block={type,data}) une fois par bloc, puis publie avec publish_artifact(target, title). Il n'y a plus de markdown, plus de kind à choisir.";
    },
  });
  summaryLines.push("- create_deliverable: save your outputs as durable deliverables, ideally as a structured 'report' with charts/KPIs (always available).");

  // Incremental report builder — assemble a kind="report" deliverable one section
  // at a time so a large report never has to fit in a single (truncation-prone)
  // create_deliverable argument. Set the header once, add sections, then finalize
  // with create_deliverable(kind="report") and NO content.
  // ── Run scratchpad ──────────────────────────────────────────────────────
  // The transcript is compacted as a run grows, so what an agent read early is
  // a stub by the time it writes. Every research result is therefore ALSO
  // written, in full, to a run-scoped store (see recordFinding in
  // internal-agent-run) that compaction never touches. This tool reads it back:
  // the agent's own working memory for the length of the run.
  tools.set("recall_findings", {
    family: "MEMORY",
    def: {
      name: "recall_findings",
      description:
        "Relis ce que TU as déjà trouvé pendant ce run (résultats de recherche, pages lues), en texte intégral. À utiliser dès que tu as besoin d'un chiffre, d'une date ou d'une URL vus plus tôt : le fil de conversation est compacté au fil du run, mais ce magasin, non. TOUJOURS préférer ceci à relancer la même recherche.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Mots-clés à retrouver (nom d'entreprise, « effectif », une URL…). Vide = tout lister." },
          limit: { type: "number", description: "Nombre d'entrées (défaut 6, max 15)." },
        },
        additionalProperties: false,
      },
    },
    run: async (args) => {
      if (!ctx.runId) return "Aucun run en cours — rien à relire.";
      const { data } = await ctx.admin
        .from("internal_agent_run_events")
        .select("payload, created_at")
        .eq("run_id", ctx.runId).eq("kind", "log")
        .order("created_at", { ascending: true }).limit(200);
      const all = (data ?? [])
        .map((e) => (e as { payload?: { finding?: { tool: string; label: string; text: string } } }).payload?.finding)
        .filter((f): f is { tool: string; label: string; text: string } => !!f?.text);
      if (all.length === 0) return "Rien n'a encore été collecté dans ce run.";

      const q = str(args.query).toLowerCase().trim();
      const terms = q ? q.split(/\s+/).filter((w) => w.length > 2) : [];
      const scored = all
        .map((f) => {
          const hay = `${f.label}\n${f.text}`.toLowerCase();
          return { f, score: terms.length === 0 ? 1 : terms.filter((t) => hay.includes(t)).length };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(15, Number(args.limit) || 6)));
      if (scored.length === 0) {
        return `Aucune de tes ${all.length} collectes ne mentionne « ${str(args.query)} ». Cette donnée n'a pas encore été trouvée : cherche-la (requête NOUVELLE), ou écris « non publié » et avance.`;
      }
      return cap(
        `${scored.length} collecte(s) sur ${all.length} :\n\n`
        + scored.map(({ f }) => `### [${f.tool}] ${f.label}\n${f.text}`).join("\n\n---\n\n"),
        14000,
      );
    },
  });
  summaryLines.push("- recall_findings: relire tes propres recherches/lectures de ce run en texte intégral (le fil est compacté, pas ce magasin).");

  tools.set("report_section", {
    def: {
      name: "report_section",
      description:
        "Build a kind=\"report\" deliverable INCREMENTALLY — one section per call — so you never have to emit a huge JSON in a single create_deliverable argument (which gets truncated). First call may set the header (title/subtitle/summary/author); each call may append one `section`. When done, call create_deliverable(kind=\"report\") with NO content to finalize from the accumulated draft. A `section` = one entry of the report 'sections' array: { heading, body?, kpis?, gauges?, charts?, table?, timeline?, callout?, images?, comparison?, matrix? }.\n"
        + "WRITE AS YOU GO — this is not optional on a long run. Your transcript is COMPACTED as the run grows: old tool results are cut down to a stub, so the search results and pages you read EARLY are no longer readable by the time you write the report. A figure you have not written into a section is a figure you have lost. So the moment you have the facts for one section (one company, one theme), call report_section for THAT section immediately — with the numbers, the dates and the source urls in it — then move on. Never gather everything first and write at the end: that is how a report ends up with \"nombre d'employés\" missing after twenty successful searches.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Report title (set once)." },
          subtitle: { type: "string" },
          author: { type: "string" },
          summary: { type: "string", description: "Executive summary (1-3 sentences)." },
          section: { type: "object", description: "One report section object to append (heading + optional body/kpis/gauges/charts/table/timeline/callout/images/comparison/matrix)." },
        },
        additionalProperties: true,
      },
    },
    run: async () => {
      // Retired: the artifact system is add_block + publish_artifact now.
      if (reportsDelegated) return REPORT_MOVED;
      return "ERROR: report_section n'existe plus. Un rapport se construit bloc par bloc : add_block(target=\"report\", block={type:\"header\"|\"paragraph\"|\"kpi\"|\"chart\"|\"table\"|\"comparison\"|\"matrix\"|\"callout\"|..., data:{...}}), puis publish_artifact(target=\"report\", title=\"…\").";
    },
  });
  summaryLines.push("- report_section: build a big report section-by-section, then finalize with create_deliverable(kind=\"report\") (no content).");

  // Always-on: search your OWN earlier steps + this conversation. Older context
  // is compacted/truncated to keep requests small; instead of re-doing work or
  // asking again, grep the history to recover what you already found or decided.
  tools.set("search_history", {
    def: {
      name: "search_history",
      description:
        "Search your earlier steps in this run AND the conversation for a keyword — to recall a fact, result or decision from before it was compacted out of context. Use it instead of re-doing work or re-asking. Returns matching snippets with their source.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword or phrase to find in past messages / tool results." },
          limit: { type: "number", description: "Max snippets (default 8)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const q = str(args.query).trim();
      if (q.length < 2) return "ERROR: query must be at least 2 characters.";
      const ql = q.toLowerCase();
      const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
      const snip = (c: string) => { const i = c.toLowerCase().indexOf(ql); return (i > 120 ? "…" : "") + c.slice(Math.max(0, i - 120), i + 220).trim() + "…"; };
      const out: string[] = [];

      // This run's logged steps (tool calls/results/status previews).
      if (ctx.runId) {
        const { data } = await ctx.admin
          .from("internal_agent_run_events")
          .select("kind, payload, created_at")
          .eq("run_id", ctx.runId).order("created_at", { ascending: false }).limit(400);
        for (const e of (data ?? []) as Array<{ kind: string; payload: unknown }>) {
          const text = (() => { try { return JSON.stringify(e.payload ?? {}); } catch { return ""; } })();
          if (text.toLowerCase().includes(ql)) { out.push(`[step:${e.kind}] ${snip(text)}`); if (out.length >= limit) break; }
        }
      }
      // The conversation (chat mode) — full user/assistant turns.
      if (out.length < limit && ctx.conversationId) {
        const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
        const { data } = await ctx.admin
          .from("internal_agent_messages")
          .select("role, content, created_at")
          .eq("conversation_id", ctx.conversationId).ilike("content", like)
          .order("created_at", { ascending: false }).limit(limit - out.length);
        for (const m of (data ?? []) as Array<{ role: string; content: string }>) {
          out.push(`[${m.role}] ${snip(str(m.content))}`);
        }
      }
      return out.length ? cap(out.join("\n\n"), 6000) : `No earlier message matches "${q}".`;
    },
  });
  summaryLines.push("- search_history: grep your earlier steps / the conversation to recover detail compacted out of context.");

  // Service-dashboard agents: read the assets dropped into their service's
  // Assets tab — the people, repositories, links, files, key references,
  // connected tools and notes that describe what this service works with. This
  // is how an agent (the Vibe Coder included) knows which repositories and
  // resources it may act on. Read-only; registered only when the agent belongs
  // to a service dashboard.
  if (ctx.serviceDashboardId) {
    tools.set("list_assets", {
      def: {
        name: "list_assets",
        description:
          "List the assets of YOUR service dashboard — the resources your team dropped in the Assets tab: " +
          "GitHub repositories you can act on, people, links, files, key/secret references (names only), " +
          "connected tools and notes. Call this to discover what this service works with before acting " +
          "(e.g. which repository to code on).",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", description: "Optional filter: repo | human | link | file | key | connector | note." },
          },
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const wantKind = str(args.kind).trim().toLowerCase();
        const out: string[] = [];

        // Repositories are project-scoped rows (what the vibe_code tool resolves).
        if (!wantKind || wantKind === "repo") {
          const { data: repos } = await ctx.admin
            .from("repositories")
            .select("full_name, default_branch, private")
            .eq("project_id", ctx.projectId)
            .order("created_at", { ascending: false })
            .limit(100);
          const list = (repos ?? []) as Array<{ full_name: string | null; default_branch: string | null; private: boolean | null }>;
          if (list.length) {
            out.push("Repositories:");
            for (const r of list) out.push(`  - ${r.full_name}${r.default_branch ? ` (${r.default_branch})` : ""}${r.private ? " · private" : ""}`);
          }
        }

        // Everything else lives in dashboard_assets, scoped to this dashboard.
        const { data: assets } = await ctx.admin
          .from("dashboard_assets")
          .select("kind, label, value")
          .eq("dashboard_id", ctx.serviceDashboardId!)
          .order("created_at", { ascending: false })
          .limit(300);
        const rows = ((assets ?? []) as Array<{ kind: string; label: string; value: string | null }>)
          .filter((a) => a.kind !== "agent" && (!wantKind || a.kind === wantKind));
        const byKind = new Map<string, string[]>();
        for (const a of rows) {
          const arr = byKind.get(a.kind) ?? [];
          // A "key" asset stores a REFERENCE (a secret name), never the value —
          // surface only the reference so the agent can ask for it by name.
          arr.push(`  - ${a.label}${a.value && a.kind !== "key" ? ` — ${a.value}` : ""}`);
          byKind.set(a.kind, arr);
        }
        const LABELS: Record<string, string> = {
          human: "People", link: "Links", file: "Files", key: "Secret references", connector: "Connected tools", note: "Notes",
        };
        for (const [k, arr] of byKind) {
          out.push(`${LABELS[k] ?? k}:`);
          out.push(...arr);
        }

        return out.length ? cap(out.join("\n"), 6000) : "This service has no assets yet.";
      },
    });
    summaryLines.push("- list_assets: see your service's assets (repositories, people, links, files, connectors, notes).");
  }

  // Chat-only: talk to the human DURING the run — post a short progress /
  // thinking-aloud message right now without ending the turn. Makes the agent
  // feel present and human on longer tasks instead of going silent until the end.
  if (ctx.conversationId) {
    tools.set("say", {
      def: {
        name: "say",
        description:
          "Send a SHORT message to the user RIGHT NOW, mid-task, WITHOUT ending your turn. Use it to: acknowledge the request in your own words before you start; share progress on longer work ('je regarde X…', 'ok j'ai trouvé Y, je continue'); or say what you're about to do. One or two natural sentences, like a helpful colleague. This does NOT replace your final answer — keep working after calling it.",
        parameters: {
          type: "object",
          properties: { message: { type: "string", description: "The short message to show the user now." } },
          required: ["message"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const message = str(args.message).trim();
        if (!message) return "ERROR: message is required.";
        await ctx.admin.from("internal_agent_messages").insert({
          conversation_id: ctx.conversationId, agent_id: ctx.agentId, role: "assistant", content: message.slice(0, 2000), run_id: ctx.runId,
        }).then(() => {}, () => {});
        await ctx.admin.from("internal_agent_conversations")
          .update({ updated_at: new Date().toISOString() }).eq("id", ctx.conversationId).then(() => {}, () => {});
        return "Message affiché à l'utilisateur — continue la tâche.";
      },
    });
    summaryLines.push("- say: send the user a quick progress / acknowledgement message mid-task, without ending your turn (chat only).");
  }

  // Always-on: rich, openable artifacts (document/presentation/spreadsheet/
  // image/text) — shown as a card in the chat, opened in the side panel.
  tools.set("create_artifact", {
    def: {
      name: "create_artifact",
      description:
        "Generate an IMAGE. content is a detailed image-generation prompt (never markdown, never JSON). Shows up as a card in the chat. " +
        "This tool does nothing else. There is no document, no spreadsheet and no presentation artifact: EVERYTHING you write — analysis, note, recap, deck, table of figures — is create_deliverable(kind=\"report\"), whose content is structured JSON the app renders with React components. A deck is a report whose sections are its slides; tabular data is a report section carrying a table block.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: OFFERED_ARTIFACT_KINDS },
          title: { type: "string", description: "Short human-readable title." },
          content: { type: "string", description: "Format depends on kind — see above." },
        },
        required: ["kind", "title", "content"],
        additionalProperties: false,
      },
    },
    run: async () => {
      // Retired: the artifact system is add_block + publish_artifact now.
      if (reportsDelegated) return "ERROR: create_artifact n'existe plus. Un rapport se demande au Rédacteur avec request_report(subject, material) ; une présentation se construit avec add_block(target=\"presentation\", block={type,data}) — les mêmes blocs, séparés par des blocs {type:\"slide\"} — puis publish_artifact. Il n'existe ni document markdown, ni tableur, ni artifact texte.";
      return "ERROR: create_artifact n'existe plus. Un rapport ou une présentation se construit avec add_block puis publish_artifact. Une présentation = les mêmes blocs, séparés par des blocs {type:\"slide\"}. Il n'existe ni document markdown, ni tableur, ni artifact texte.";
    },
  });
  summaryLines.push("- create_artifact: generate an IMAGE only (everything written goes through create_deliverable as a report).");

  // ── Always-on: artifacts are EDITABLE, not write-once ──────────────────────
  // create_artifact alone made every correction a new file: an agent asked to
  // "add a column" produced a second spreadsheet and left the first one wrong.
  // These three close the loop — find it, read it back in the same text format
  // it was written in, save the edit in place.

  tools.set("list_artifacts", {
    def: {
      name: "list_artifacts",
      description:
        "List the documents, spreadsheets and presentations of this workspace — yours and your teammates'. Call this BEFORE creating an artifact that may already exist, and to get the id of one you want to read or update. Returns id, kind, title and last-updated date, newest first.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keywords matched against the title." },
          kind: { type: "string", enum: DOC_KINDS, description: "Optional filter to one kind." },
          limit: { type: "number", description: "Max results (default 15, max 40)." },
        },
        additionalProperties: false,
      },
    },
    run: async (args) => {
      if (!ctx.projectId) return "ERROR: no project context.";
      const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 40);
      let q = ctx.admin.from("office_documents")
        .select("id, kind, title, updated_at, service_room_id")
        .eq("project_id", ctx.projectId).eq("is_archived", false)
        .order("updated_at", { ascending: false }).limit(limit);
      const kind = str(args.kind);
      if (isDocKind(kind)) q = q.eq("kind", kind);
      const query = str(args.query).trim();
      if (query) q = q.ilike("title", `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`);
      const { data, error } = await q;
      if (error) return `ERROR listing artifacts: ${error.message}`;
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        return query
          ? `No artifact matches "${query}". Create it with create_artifact.`
          : "No artifacts yet in this workspace.";
      }
      return rows.map((r) =>
        `[${String(r.kind)}] ${String(r.title)} — id ${String(r.id)} (updated ${String(r.updated_at ?? "").slice(0, 10)})`,
      ).join("\n");
    },
  });
  summaryLines.push("- list_artifacts: list existing documents/spreadsheets/presentations before creating a new one (always available).");

  tools.set("read_artifact", {
    def: {
      name: "read_artifact",
      description:
        "Read an artifact's full content back, in the SAME text format you write it in (" + CONTENT_FORMAT_HELP + "). Use it to check what is already there before editing, to reuse a teammate's work, or to answer a question about a document. Get the id from list_artifacts.",
      parameters: {
        type: "object",
        properties: { artifact_id: { type: "string", description: "The artifact id from list_artifacts." } },
        required: ["artifact_id"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const id = str(args.artifact_id).trim();
      if (!id) return "ERROR: artifact_id is required.";
      const { data, error } = await ctx.admin.from("office_documents")
        .select("id, kind, title, content, project_id, updated_at").eq("id", id).maybeSingle();
      if (error) return `ERROR reading artifact: ${error.message}`;
      const row = data as Record<string, unknown> | null;
      if (!row) return `ERROR: no artifact with id ${id}.`;
      // Scope check: the service role bypasses RLS, so the tool enforces the
      // project boundary itself — an agent must never read another project's work.
      if (ctx.projectId && String(row.project_id) !== ctx.projectId) return "ERROR: that artifact belongs to another project.";
      const body = renderContent(String(row.kind), row.content);
      return cap(`# ${String(row.title)} (${String(row.kind)}, id ${id})\n\n${body || "(empty)"}`, 12000);
    },
  });
  summaryLines.push("- read_artifact: read an artifact's content back as markdown/CSV/slide lines (always available).");

  tools.set("update_artifact", {
    def: {
      name: "update_artifact",
      description:
        "Rewrite an existing artifact IN PLACE — use this instead of creating a second one whenever you are correcting, extending or reworking something that already exists. `content` REPLACES the whole body, so read_artifact first and send back the complete edited version, not just your change. Format: " + CONTENT_FORMAT_HELP,
      parameters: {
        type: "object",
        properties: {
          artifact_id: { type: "string", description: "The artifact id from list_artifacts." },
          content: { type: "string", description: "The COMPLETE new body (replaces the current one)." },
          title: { type: "string", description: "Optional new title." },
        },
        required: ["artifact_id", "content"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const id = str(args.artifact_id).trim();
      const content = str(args.content);
      if (!id || !content) return "ERROR: artifact_id and content are required.";
      const { data: cur } = await ctx.admin.from("office_documents")
        .select("id, kind, title, project_id").eq("id", id).maybeSingle();
      const row = cur as Record<string, unknown> | null;
      if (!row) return `ERROR: no artifact with id ${id}.`;
      if (ctx.projectId && String(row.project_id) !== ctx.projectId) return "ERROR: that artifact belongs to another project.";
      const kind = String(row.kind);
      if (!isDocKind(kind)) return `ERROR: artifacts of kind ${kind} cannot be edited.`;
      const patch: Record<string, unknown> = {
        content: contentForKind(kind, content),
        updated_at: new Date().toISOString(),
      };
      const title = str(args.title).trim();
      if (title) patch.title = title.slice(0, 200);
      const { error } = await ctx.admin.from("office_documents").update(patch).eq("id", id);
      if (error) return `ERROR updating artifact: ${error.message}`;
      await ctx.logEvent("ui", {
        block: { component: "artifact", props: { id, table: "office_documents", kind, title: title || String(row.title) } },
      }).catch(() => {});
      return `Artifact "${title || String(row.title)}" updated in place (id ${id}).`;
    },
  });
  summaryLines.push("- update_artifact: rewrite an existing artifact in place instead of creating a duplicate (always available).");

  // Always-on: attach rich UI blocks to the reply — the chat renders them as
  // real components (generative UI). Blocks are logged as 'ui' events during
  // the run and attached to the final assistant message at finalize. Each call
  // returns a [[ui:N]] tag the agent places INSIDE its final text, so text and
  // components interleave exactly where they make sense.
  let uiBlockCount = 0;
  tools.set("render_ui", {
    def: {
      name: "render_ui",
      description:
        "Attach a rich UI block to your FINAL chat reply — the interface renders it as a real interactive component instead of markdown. Pick the component that FITS the data; NEVER dump raw objects into a table (they render as [object Object]). Components & props:\n" +
        "- email_list: {title?, emails:[{from, subject, date?, snippet?, unread?, url?}]} — ALWAYS use this to show emails.\n" +
        "- products: {products:[{title, price?, image?, description?, url?}]} — product cards.\n" +
        "- image: {url, alt?, caption?} — a single image.\n" +
        "- code: {code, language?} — a highlighted, copyable code block.\n" +
        "- text: {title?, text} — a titled block of rich markdown (headings, lists, bold…).\n" +
        "- kpi_grid: {items:[{label, value, delta?, tone?('emerald'|'red'|'amber'|'blue')}]} — up to 8 metric tiles.\n" +
        "- chart: {type:'bar'|'line'|'area'|'pie', title?, data:[{x:string, y:number}]} — up to 50 points, REAL data only.\n" +
        "- table: {title?, columns:[string], rows:[[cell,…]]} — cells MUST be strings/numbers, never objects.\n" +
        "- link_card: {title, description?, url} — a clickable card to a URL or in-app path.\n" +
        "Each call returns a tag like [[ui:1]] — write that tag ON ITS OWN LINE in your final answer at the exact spot where the block belongs, and interleave text and blocks naturally (intro → block → explanation). Prefer a specific block (email_list, products, image, code) over a generic table.",
      parameters: {
        type: "object",
        properties: {
          component: { type: "string", enum: ["email_list", "products", "image", "code", "text", "kpi_grid", "chart", "table", "link_card"] },
          props: { type: "object", description: "The component's props (see the description for each component's shape)." },
        },
        required: ["component", "props"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const component = str(args.component);
      if (!["email_list", "emails", "products", "product_card", "product", "image", "code", "text", "kpi_grid", "chart", "table", "link_card"].includes(component)) return "ERROR: unknown component.";
      const props = args.props && typeof args.props === "object" ? (args.props as Record<string, unknown>) : null;
      if (!props) return "ERROR: props (object) is required.";
      if (JSON.stringify(props).length > 20000) return "ERROR: props too large (20k max) — aggregate the data first.";
      await ctx.logEvent("ui", { block: { component, props } });
      uiBlockCount++;
      return `UI block '${component}' attached as [[ui:${uiBlockCount}]]. In your FINAL answer, write [[ui:${uiBlockCount}]] on its own line exactly where this block should appear, with your text around it.`;
    },
  });
  summaryLines.push("- render_ui: attach rich UI blocks (email_list, products, image, code, text, KPIs, charts, tables, links) and place them in your reply with the returned [[ui:N]] tag; use the block that fits the data (always available).");

  // Always-on: read the workspace's AUTHORIZED pentest scope. Security agents
  // MUST call this before any active testing to confirm a target is in scope.
  tools.set("pentest_scope", {
    def: {
      name: "pentest_scope",
      description:
        "List the targets this workspace has EXPLICITLY authorized for security testing (hostnames/domains). Call this BEFORE any active security test — active tools (http_request) only work on in-scope targets. If a target you need isn't listed, stop and ask a human to add it to the authorized scope (they do this in the app); never test out-of-scope systems.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    run: async () => {
      const scope = await loadPentestScope(ctx);
      if (!scope.length) {
        return "No authorized pentest scope is defined for this project. Active security testing is DISABLED until an owner/admin declares and attests an authorized scope (targets they own or are contractually allowed to test). Ask them to set it up; do NOT test any target meanwhile.";
      }
      const lines = scope.map((e) => `- ${e.label}: ${e.targets.join(", ")}`);
      return `Authorized testing scope (only these targets may be actively tested):\n${lines.join("\n")}`;
    },
  });
  summaryLines.push("- pentest_scope: list the workspace's AUTHORIZED security-testing targets (call before any active test).");

  // Always-on: the run's todo list (TodoWrite-style). The FULL list is sent on
  // every call and persisted structurally on the run — it drives the checklist
  // the user watches live. Replaces the old per-step update_plan_step.
  tools.set("update_todos", {
    def: {
      name: "update_todos",
      description:
        "Maintain your run's todo checklist — the user watches it live. Send the COMPLETE list every time (all items, not a diff). RECURSIVE DECOMPOSITION: when a step turns out to be complex, SPLIT it into subtasks (items whose parent_id is that step's id — nesting allowed up to 3 levels). Keep the parent in the list; a parent is 'done' only when ALL its subtasks are done. Rules: exactly ONE LEAF item 'active' at a time (a parent with an active subtask stays 'active' too); update right BEFORE starting a step (mark it active) and right AFTER finishing it (mark it done — only once VERIFIED, with a one-line note); mark 'blocked' with the reason when stuck; add new items when you discover extra work. Keep titles short and action-oriented.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The full, ordered todo list (parents listed before their subtasks).",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Stable id, e.g. 'step-1' or 'step-1.2'." },
                title: { type: "string", description: "Short action title." },
                status: { type: "string", enum: ["pending", "active", "done", "blocked"] },
                parent_id: { type: "string", description: "Id of the parent task when this item is a subtask (omit for top-level tasks)." },
                note: { type: "string", description: "Optional one-liner (verification result, blocker reason)." },
              },
              required: ["id", "title", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const raw = Array.isArray(args.todos) ? args.todos : null;
      if (!raw || raw.length === 0) return "ERROR: todos (non-empty array) is required.";
      const todos = raw.slice(0, 40).map((t: any, i: number) => ({
        id: str(t?.id) || `step-${i + 1}`,
        title: str(t?.title).slice(0, 140) || `Step ${i + 1}`,
        status: ["pending", "active", "done", "blocked"].includes(str(t?.status)) ? str(t?.status) : "pending",
        ...(str(t?.parent_id) ? { parent_id: str(t?.parent_id) } : {}),
        ...(str(t?.note) ? { note: str(t?.note).slice(0, 300) } : {}),
      }));
      // Sanity: drop dangling/self/looping parents (item becomes top-level) and
      // cap nesting at 3 levels so the tree stays readable.
      const ids = new Set(todos.map((t) => t.id));
      for (const t of todos) {
        if (t.parent_id && (!ids.has(t.parent_id) || t.parent_id === t.id)) delete (t as any).parent_id;
      }
      const depthOf = (t: (typeof todos)[number], hop = 0): number => {
        if (!t.parent_id || hop >= 4) return hop;
        const p = todos.find((x) => x.id === t.parent_id);
        return p ? depthOf(p, hop + 1) : hop;
      };
      for (const t of todos) if (depthOf(t) >= 3) delete (t as any).parent_id;

      // ── Step-level evidence (loop engineering) ─────────────────────────────
      // A leaf may only be closed against EVIDENCE: a successful tool result
      // since the last checklist update, or an explicit verification note.
      // Otherwise the item keeps its previous status and the agent is told to
      // verify first — "done because I said so" is exactly how a loop convinces
      // itself it has finished, and it is the reason a checklist can read 8/8
      // while nothing was produced.
      const reverted: string[] = [];
      if (ctx.runId && ctx.loopEvidence && ctx.loopEvidence.results === 0) {
        const { data: prevRow } = await ctx.admin
          .from("internal_agent_runs").select("todos").eq("id", ctx.runId).maybeSingle();
        const prevStatus = new Map(
          (Array.isArray((prevRow as { todos?: unknown } | null)?.todos)
            ? ((prevRow as { todos: Array<{ id: string; status: string }> }).todos)
            : []).map((t) => [t.id, t.status]),
        );
        const parents = new Set(todos.filter((t) => t.parent_id).map((t) => t.parent_id));
        for (const t of todos) {
          if (t.status !== "done") continue;
          if (parents.has(t.id)) continue;                          // a parent inherits from its children
          if (prevStatus.get(t.id) === "done") continue;            // already closed in an earlier update
          if ((t.note ?? "").trim().length >= 12) continue;         // an explicit verification note IS evidence
          t.status = prevStatus.get(t.id) ?? "pending";             // no evidence → no state change
          reverted.push(t.title);
        }
      }
      if (ctx.loopEvidence) ctx.loopEvidence.results = 0;

      if (ctx.runId) {
        await ctx.admin.from("internal_agent_runs").update({ todos }).eq("id", ctx.runId);
      }
      await ctx.logEvent("todos", { todos });
      // Progress counts on LEAVES (a parent's state is derived from its children).
      const hasChildren = new Set(todos.filter((t) => t.parent_id).map((t) => t.parent_id));
      const leaves = todos.filter((t) => !hasChildren.has(t.id));
      const activeLeaves = leaves.filter((t) => t.status === "active").length;
      const done = leaves.filter((t) => t.status === "done").length;
      const parentMismatch = todos.some((t) =>
        hasChildren.has(t.id) && t.status === "done" &&
        todos.some((c) => c.parent_id === t.id && c.status !== "done"));
      const warn = (activeLeaves > 1 ? " WARNING: more than one LEAF is 'active' — keep exactly one." : "") +
        (parentMismatch ? " WARNING: a parent is 'done' while some of its subtasks are not." : "");
      const evidenceWarn = reverted.length
        ? ` ⚠️ NOT MARKED DONE — no evidence: ${reverted.slice(0, 4).join(", ")}. You closed ${reverted.length} step(s) without a single successful tool result since your last checklist update and without a verification note. VERIFY for real (re-read the file, re-run the command, open the URL, re-query the data), THEN mark the step done with a one-line note stating the evidence.`
        : "";
      return `Todos updated (${done}/${leaves.length} leaf steps done).${warn}${evidenceWarn}`;
    },
  });
  summaryLines.push("- update_todos: maintain your live todo checklist (full list every time; split complex steps into subtasks via parent_id; one leaf active at a time).");

  // Always-on: pause and ask the human (Claude-Code-style clarification). Use
  // ONLY when genuinely blocked on missing info, an ambiguous choice, or before
  // an irreversible action. Throws AwaitingInputError to stop the run cleanly.
  tools.set("ask_user", {
    def: {
      name: "ask_user",
      description:
        "Pause and ask the human a clarifying question, then STOP. Use this ONLY when you genuinely cannot proceed correctly without more information: an ambiguous/under-specified request, a missing input, a fork in direction, or confirmation before an irreversible action. Do NOT use it for things you can reasonably decide or look up yourself — prefer acting autonomously. The run pauses until the human replies.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The single, specific question to ask. Be concise and explain why you need it." },
          options: { type: "array", items: { type: "string" }, description: "Optional suggested answers / choices to make replying quick." },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const question = str(args.question).trim();
      if (!question) return "ERROR: question is required.";
      const options = Array.isArray(args.options) ? (args.options as unknown[]).map((o) => str(o)).filter(Boolean).slice(0, 6) : [];
      await ctx.logEvent("question", { question, options });
      // Control-flow signal: unwinds the tool loop and pauses the run.
      throw new AwaitingInputError(question, options);
    },
  });
  summaryLines.push("- ask_user: pause and ask the human for clarification when (and only when) you truly cannot proceed correctly without it (always available).");

  // Contextual skills (progressive disclosure): the agent's activated skills are
  // listed by name/description in the system prompt; their FULL playbook is
  // pulled into context on demand with use_skill, right before a step needs it.
  if (ctx.skills && ctx.skills.length) {
    const bySlug = new Map(ctx.skills.map((s) => [s.slug, s]));
    tools.set("use_skill", {
      def: {
        name: "use_skill",
        description:
          "Load the FULL playbook of one of your activated skills into context — call it right before a step that needs that expertise. Returns the skill's detailed methodology and the tools it relies on. The list of skills available to you (name + slug + description) is in your system prompt under 'Activated skills'.",
        parameters: {
          type: "object",
          properties: {
            slug: { type: "string", description: "The slug of the activated skill to load." },
          },
          required: ["slug"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const slug = str(args.slug);
        const sk = bySlug.get(slug);
        if (!sk) return `ERROR: "${slug}" is not one of your activated skills. Available: ${[...bySlug.keys()].join(", ") || "(none)"}.`;
        const parts: string[] = [`# Skill loaded: ${sk.name} (${sk.slug})`];
        if (sk.description) parts.push(sk.description);
        if (sk.tools && sk.tools.length) parts.push(`Tools this skill uses: ${sk.tools.join(", ")}.`);
        parts.push("", "## SKILL.md — playbook", sk.instructions || "(no detailed instructions provided — apply the skill's intent.)");
        // Bundled files are NOT dumped here (progressive disclosure): list them so
        // the agent pulls only the one(s) a step actually needs via read_skill_file.
        if (sk.files && sk.files.length) {
          parts.push(
            "",
            "## Bundled files (load on demand — do NOT assume their content)",
            ...sk.files.map((f) => `- ${f.path}`),
            "",
            `Read a bundled file with read_skill_file(slug="${sk.slug}", path="<one of the paths above>") right before the step that needs it.`,
          );
        }
        parts.push("", "Now apply this skill to the current step.");
        return cap(parts.join("\n"), 6000);
      },
    });
    // The prompt no longer lists every activated skill — it lists the ones this
    // TASK plausibly needs. That trade only works if the full roster stays one
    // call away, otherwise a trimmed index becomes a capability the agent
    // believes it doesn't have.
    tools.set("list_skills", {
      def: {
        name: "list_skills",
        description:
          "Liste TOUTES tes skills activées (nom, slug, description). Ton prompt n'en montre qu'une sélection, celle qui colle à la tâche en cours : appelle-la quand tu cherches une expertise que tu n'y vois pas, avant de conclure que tu ne l'as pas.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      run: () => {
        const lines = (ctx.skills ?? []).map((s) =>
          `- ${s.name} (${s.slug})${s.category ? ` [${s.category}]` : ""}${s.description ? `: ${s.description}` : ""}`);
        return Promise.resolve(
          lines.length
            ? `Skills activées (${lines.length}) :\n${lines.join("\n")}\n\nCharge celle qu'il te faut avec use_skill(slug).`
            : "Aucune skill activée.",
        );
      },
    });
    const skillIndex = ctx.skills.map((s) => `${s.name} (${s.slug})`).join(", ");
    summaryLines.push(`- use_skill / list_skills: charge le playbook d'une skill activée à la demande (le prompt n'en liste qu'une sélection). Activées : ${skillIndex}.`);

    // read_skill_file — progressive disclosure for a skill's bundled resource
    // files. Registered only when at least one activated skill has files.
    if (ctx.skills.some((s) => s.files && s.files.length)) {
      const idBySlug = new Map(ctx.skills.filter((s) => s.id).map((s) => [s.slug, s.id as string]));
      tools.set("read_skill_file", {
        def: {
          name: "read_skill_file",
          description:
            "Read the FULL content of one bundled file of an activated skill (progressive disclosure). Use it right before a step that needs that reference/script, after use_skill listed the skill's files. Returns the file's text content.",
          parameters: {
            type: "object",
            properties: {
              slug: { type: "string", description: "The activated skill's slug." },
              path: { type: "string", description: "The bundled file path exactly as listed by use_skill (e.g. references/tone.md)." },
            },
            required: ["slug", "path"],
            additionalProperties: false,
          },
        },
        run: async (args) => {
          const slug = str(args.slug);
          const path = str(args.path).trim();
          const skillId = idBySlug.get(slug);
          if (!skillId) return `ERROR: "${slug}" is not one of your activated skills (or it has no bundled files).`;
          if (!path) return "ERROR: path is required.";
          const { data, error } = await ctx.admin
            .from("agent_skill_files").select("content").eq("skill_id", skillId).eq("path", path).maybeSingle();
          if (error) return `ERROR: ${error.message}`;
          if (!data) {
            const sk = bySlug.get(slug);
            const avail = (sk?.files ?? []).map((f) => f.path).join(", ") || "(none)";
            return `ERROR: no file "${path}" in skill "${slug}". Available files: ${avail}.`;
          }
          return cap(`# ${slug}/${path}\n\n${String((data as { content: string }).content ?? "")}`, 10000);
        },
      });
      summaryLines.push("- read_skill_file: load one bundled file of an activated skill on demand (after use_skill lists them).");
    }
  }

  // Chat only: filing tasks is coordination noise during a mission run (it fed
  // the meta-work spiral) — a mission should EXECUTE, not file to-dos.
  if (!ctx.missionMode) {
  tools.set("create_task", {
    def: {
      name: "create_task",
      description: "File a durable, trackable task (a to-do) for the team. Use it to capture follow-ups, action items or things a human must do.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short task title." },
          detail: { type: "string", description: "Optional details / context." },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Default medium." },
          due_at: { type: "string", description: "Optional ISO date/time." },
          assignee: { type: "string", description: "Optional owner (name or email)." },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const title = str(args.title).slice(0, 200);
      if (!title) return "ERROR: title is required.";
      const { error } = await ctx.admin.from("agent_tasks").insert({
        workspace_id: ctx.workspaceId, project_id: ctx.projectId, agent_id: ctx.agentId ?? null,
        title, detail: str(args.detail) || null,
        priority: ["low", "medium", "high", "urgent"].includes(str(args.priority)) ? str(args.priority) : "medium",
        due_at: str(args.due_at) || null, assignee: str(args.assignee) || null,
      });
      if (error) return `ERROR creating task: ${error.message}`;
      return `Task "${title}" created.`;
    },
  });
  summaryLines.push("- create_task: file trackable to-dos / action items (always available).");
  }

  // Always-on: spin up a full background mission (assigned to self by default,
  // or to a teammate agent). Use this when the user asks the agent to "do X" as
  // standalone / ongoing work, optionally on a schedule.
  tools.set("create_mission", {
    def: {
      name: "create_mission",
      description: "Create a mission — a self-contained piece of work the agent (or a teammate) executes in the background. Use when the user assigns a job to do, or wants recurring/scheduled work. The mission runs the agent autonomously with its tools.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short mission title." },
          brief: { type: "string", description: "Detailed instructions: what to do, context, constraints." },
          acceptance_criteria: { type: "string", description: "Optional: what counts as done." },
          assignee_agent: { type: "string", description: "Optional teammate agent name to run it; defaults to this agent." },
          schedule: { type: "string", description: "Optional cron expression, in the USER'S local time, to run it on a RECURRING schedule: '30 7 * * *' = every day at 07:30, '0 9 * * 1' = Mondays 09:00, '0 9 1 * *' = the 1st of each month (days 1-28), '15 * * * *' = hourly. Only these four shapes are supported (no steps, lists or ranges). When set, the mission recurs (it does NOT fire immediately)." },
          run_at: { type: "string", description: "Optional ONE-OFF date for a reminder or a task to do later, in the user's local time: 'YYYY-MM-DDTHH:mm' (e.g. '2026-09-18T14:00'). Compute it from the current date given in your prompt. The mission runs once at that moment. Do not combine with schedule." },
          start_now: { type: "boolean", description: "If true, activate immediately (default true; ignored when a schedule or run_at is set)." },
        },
        required: ["title", "brief"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const title = str(args.title).slice(0, 200);
      const brief = str(args.brief);
      if (!title || !brief) return "ERROR: title and brief are required.";
      const schedule = str(args.schedule).trim() || null;
      const runAtRaw = str(args.run_at).trim() || null;
      if (schedule && runAtRaw) return "ERROR: pass either schedule (recurring) or run_at (one-off), not both.";
      // The column only holds a cadence (0146) — the raw cron used to be written
      // as is and every recurring mission was refused by the database.
      const tz = defaultTimezone();
      const parsed = schedule ? parseSchedule(schedule, tz) : null;
      if (schedule && !parsed) {
        return `ERROR: unsupported schedule "${schedule}". Use one of: 'M * * * *' (hourly), 'M H * * *' (daily), 'M H * * D' (weekly, D=0-6, 0=Sunday), 'M H DOM * *' (monthly, DOM=1-28). No steps, lists or ranges.`;
      }
      const runAt = runAtRaw ? parseRunAt(runAtRaw, tz) : null;
      if (runAtRaw && !runAt) return `ERROR: run_at "${runAtRaw}" is not a date. Use 'YYYY-MM-DDTHH:mm' in the user's local time.`;
      if (runAt && runAt.getTime() < Date.now() - 60_000) {
        return `ERROR: run_at ${runAtRaw} is in the past (now: ${new Date().toISOString()}). Recompute it from the current date in your prompt.`;
      }
      // Resolve assignee (default = self).
      let agentId = ctx.agentId ?? null;
      const who = str(args.assignee_agent);
      if (who) {
        const { data: mate } = await ctx.admin.from("internal_agents")
          .select("id").eq("project_id", ctx.projectId).ilike("name", who).maybeSingle();
        if (mate) agentId = mate.id;
      }
      if (!agentId) return "ERROR: no agent to assign the mission to.";
      const isDelegation = agentId !== ctx.agentId;
      // FORK-BOMB GUARD 1: inside a MISSION run, an agent may never create a
      // mission for ITSELF (this is how one bad run self-replicated 269 times).
      if (ctx.missionMode && !isDelegation) {
        return "ERROR: you are ALREADY in a mission run. Do NOT create missions for yourself — that produces no work. Execute the task directly NOW with your execution tools (shell_exec, file_write, python_exec, …). If a step fails, read the error and try a different approach.";
      }
      // FORK-BOMB GUARD 2: any mission creation counts a step down the chain,
      // self-missions included (chat mode), capped by MAX_DELEGATION_DEPTH.
      const depth = ctx.delegationDepth ?? 0;
      const childDepth = depth + 1;
      if (childDepth > MAX_DELEGATION_DEPTH) {
        return `ERROR: delegation depth limit (${MAX_DELEGATION_DEPTH}) reached — cannot create more missions from this chain. Do the work yourself or report back instead.`;
      }
      // FORK-BOMB GUARD 3: per-run budget (2) and per-hour flood cap (10).
      const guard = await missionCreationGuard(ctx);
      if (guard) return guard;
      // A scheduled mission recurs on its cron; it does NOT fire now (the
      // scheduler picks it up at next_run_at, then bumps next_run_at each run).
      const startNow = args.start_now !== false && !schedule && !runAt;
      const row: Record<string, unknown> = {
        agent_id: agentId, workspace_id: ctx.workspaceId, project_id: ctx.projectId,
        title, brief, acceptance_criteria: str(args.acceptance_criteria) || null,
        status: schedule || runAt || startNow ? "active" : "draft",
        delegation_depth: childDepth,
        delegated_by_agent: ctx.agentId,
      };
      if (parsed) {
        row.schedule = parsed.cadence;
        row.next_run_at = parsed.next_run_at;
        row.schedule_minute = parsed.schedule_minute;
        row.schedule_hour = parsed.schedule_hour;
        row.schedule_dow = parsed.schedule_dow;
        row.schedule_dom = parsed.schedule_dom;
      }
      // A one-off has no cadence; the RUN_ONCE_TAG is what tells the scheduler
      // this row is due once — a bare next_run_at on an unscheduled row could be
      // a leftover from a schedule someone removed.
      if (runAt) {
        row.next_run_at = runAt.toISOString();
        row.tags = [RUN_ONCE_TAG];
        row.board_column = "todo";
      }
      const { data: mission, error } = await ctx.admin.from("internal_agent_missions").insert(row).select("id").single();
      if (error) return `ERROR creating mission: ${error.message}`;
      // Kick it off now via the run function (best-effort, fire-and-forget).
      if (startNow) {
        const base = Deno.env.get("SUPABASE_URL"); const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (base && key) {
          fetch(`${base}/functions/v1/internal-agent-run`, {
            method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "mission", mission_id: mission.id }),
          }).catch(() => {});
        }
      }
      const localWhen = (iso: string) => new Intl.DateTimeFormat("fr-FR", {
        timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
      }).format(new Date(iso));
      if (parsed) {
        return `Mission "${title}" scheduled (${parsed.cadence}) — first run ${localWhen(parsed.next_run_at)} (${tz}), then automatically (id ${mission.id}). Tell the user the first date in words.`;
      }
      if (runAt) {
        return `Mission "${title}" will run once on ${localWhen(runAt.toISOString())} (${tz}) (id ${mission.id}). Confirm that date to the user in words.`;
      }
      return `Mission "${title}" created${startNow ? " and started" : " as a draft"} (id ${mission.id}).`;
    },
  });
  summaryLines.push("- create_mission: assign a full background mission to yourself or a teammate — now, once at a later date (run_at, e.g. a reminder), or on a recurring schedule (always available).");

  // Parallel multitasking: fan INDEPENDENT subtasks out to ephemeral sub-agents
  // that run at the same time. Offered on any PRIMARY run so it shows up in the
  // capability summary; the engine injects ctx.spawnParallel at execution time
  // (guarded below). A sub-agent can't spawn again (no recursion / fork-bomb),
  // and the owner's "Essaim" switch can turn the capability off entirely — the
  // agent still decides, per task, whether to actually fan out.
  if (!ctx.isSubagent && ctx.swarmEnabled !== false) {
    tools.set("spawn_parallel_agents", {
      def: {
        name: "spawn_parallel_agents",
        description:
          "Run several INDEPENDENT subtasks in PARALLEL as ephemeral sub-agents (clones of you). Use ONLY when the subtasks do NOT depend on each other's output — they all run at the same time and you receive every result together. For sequential or dependent work, do it yourself instead. STRONG PATTERN — 'for each of N items': when the task is 'do X for each of N items' (source EACH of N products, analyse EACH of N competitors/markets/URLs), split it into ONE subtask PER item and fan them ALL out together — do NOT process them one by one. There is NO small cap: pass one subtask per item (dozens is fine); they run in concurrent waves. Each sub-agent is focused on its one subtask and cannot spawn further sub-agents.",
        parameters: {
          type: "object",
          properties: {
            subtasks: {
              type: "array",
              description: "The independent subtasks to run in parallel — one per item. Pass as many as there are items (e.g. one per product to source).",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Short label shown on this sub-agent's instance card (e.g. 'Analyse concurrent A')." },
                  brief: { type: "string", description: "Full, self-contained instructions for this subtask — the sub-agent does NOT see the others or the parent conversation." },
                  acceptance: { type: "string", description: "Optional: what counts as done for this subtask." },
                },
                required: ["label", "brief"],
                additionalProperties: false,
              },
            },
          },
          required: ["subtasks"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const raw = Array.isArray(args.subtasks) ? args.subtasks : [];
        const subtasks = raw
          .map((s: any) => ({ label: str(s?.label).slice(0, 120), brief: str(s?.brief), acceptance: str(s?.acceptance) || undefined }))
          .filter((s) => s.label && s.brief);
        if (subtasks.length < 2) {
          return "ERROR: spawn_parallel_agents needs at least 2 INDEPENDENT subtasks. For a single task, just execute it yourself.";
        }
        if (!ctx.spawnParallel) {
          return "ERROR: parallel sub-agents aren't available in this context. Execute the subtasks yourself, one after another.";
        }

        // DEDUP across the whole run — survives context compaction. Without this,
        // once the earlier spawn call is compacted out of context the agent
        // re-fans-out the SAME subtasks (observed: 12 → 24 duplicate suppliers).
        // We remember every subtask label already spawned in run_state.meta and
        // refuse to spawn it again.
        const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
        // Significant tokens = words that carry topic meaning (drop generic
        // sourcing/analysis filler + short words), so near-duplicate labels with
        // different wording ("Fournisseurs mode (t-shirt)" vs "Sourcing textile")
        // still collide when they share ≥2 topic words.
        const STOP = new Set(["fournisseurs", "fournisseur", "sourcing", "source", "analyse", "analyser", "recherche", "import", "chine", "china", "france", "chinois", "pour", "des", "les", "avec", "and", "the", "for", "&", "et", "de", "du", "la", "le"]);
        const topicTokens = (s: string) => new Set(norm(s).replace(/[()[\],+/&]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
        let meta: Record<string, unknown> = {};
        let already: string[] = [];
        let alreadyTokens: string[][] = [];
        let fanoutCount = 0;
        if (ctx.runId) {
          const { data } = await ctx.admin.from("internal_agent_run_state").select("meta").eq("run_id", ctx.runId).maybeSingle();
          meta = ((data as { meta?: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>;
          already = Array.isArray(meta.spawned_subtasks) ? (meta.spawned_subtasks as string[]) : [];
          alreadyTokens = Array.isArray(meta.spawned_topics) ? (meta.spawned_topics as string[][]) : [];
          fanoutCount = Number(meta.fanout_count) || 0;
        }

        // BATCH CAP: after 2 fan-out batches, stop — more is almost always the
        // agent re-spawning work it already did (labels differ so exact-dedup
        // misses it). Force it to collect + synthesise instead.
        if (fanoutCount >= 2) {
          return `STOP — tu as déjà lancé ${fanoutCount} vagues de sous-agents dans CE run. N'en relance PAS d'autres : les résultats des sous-agents précédents sont disponibles — récupère-les avec search_context(scope="run", query="${subtasks[0]?.label?.split(/[ (]/)[0] ?? "sourcing"}") (ou attends ceux en cours), puis SYNTHÉTISE-les dans ton livrable (create_deliverable). Relancer des vagues en double gaspille le budget et crée des doublons.`;
        }

        const seen = new Set(already);
        const overlapsPrior = (s: string) => {
          const toks = topicTokens(s);
          if (toks.size === 0) return false;
          return alreadyTokens.some((prev) => {
            let shared = 0;
            for (const t of toks) if (prev.includes(t)) shared++;
            return shared >= 2; // ≥2 shared topic words = same work under a new label
          });
        };
        const fresh = subtasks.filter((s) => !seen.has(norm(s.label)) && !overlapsPrior(s.label));
        const skipped = subtasks.length - fresh.length;

        if (fresh.length === 0) {
          return `DÉJÀ FAIT : ces ${subtasks.length} sous-tâches recouvrent un travail déjà lancé en parallèle plus tôt dans CE run — ne les relance PAS. Leurs résultats sont dans tes étapes précédentes : appelle search_context(scope="run", query="${subtasks[0]?.label ?? ""}") pour les lire (ou attends celles en cours), puis synthétise. Relancer des doublons gaspille le budget.`;
        }

        // Persist labels + topic tokens + batch count BEFORE spawning, merging
        // (never overwriting the anti-loop / compaction keys) so a tick retry
        // can't double-fire.
        if (ctx.runId) {
          const next = [...already, ...fresh.map((s) => norm(s.label))].slice(-300);
          const nextTopics = [...alreadyTokens, ...fresh.map((s) => [...topicTokens(s.label)])].slice(-300);
          await ctx.admin.from("internal_agent_run_state")
            .update({ meta: { ...meta, spawned_subtasks: next, spawned_topics: nextTopics, fanout_count: fanoutCount + 1 } })
            .eq("run_id", ctx.runId)
            .then(() => {}, () => {});
        }

        const result = await ctx.spawnParallel(fresh);
        return skipped > 0
          ? `(${skipped} subtask(s) skipped — already spawned earlier in this run; not repeated.)\n\n${result}`
          : result;
      },
    });
    summaryLines.push("- spawn_parallel_agents: fan out INDEPENDENT subtasks to ephemeral parallel sub-agents and collect their results (one per item — no small cap; runs in concurrent waves).");
  }

  // Always-on: create a NEW teammate agent. Safe — an agent row is passive (it
  // does not auto-run), so this can't fork-bomb. Scoped to the creator's service
  // dashboard so the orchestrator can build out its team by request.
  let agentsCreatedThisRun = 0;
  tools.set("create_agent", {
    def: {
      name: "create_agent",
      description:
        "Create a NEW agent (teammate) — use when the user asks to set up an agent for a role/task. The new agent is created ready to use (it does NOT start running on its own); tell the user it's ready and, if relevant, that they can open it or you can assign it a mission. Give it a clear name, role and instructions. Max 5 per run.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short agent name, e.g. 'SEO Analyst'." },
          role: { type: "string", description: "One-line role, e.g. 'Analyse le SEO et propose des optimisations'." },
          instructions: { type: "string", description: "What this agent does and how — its operating instructions." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const name = str(args.name).trim().slice(0, 120);
      if (!name) return "ERROR: name is required.";
      if (agentsCreatedThisRun >= 5) return "ERROR: agent-creation limit reached for this run (5).";
      const { data: created, error } = await ctx.admin.from("internal_agents").insert({
        workspace_id: ctx.workspaceId, project_id: ctx.projectId,
        service_dashboard_id: ctx.serviceDashboardId ?? null,
        name,
        role: str(args.role).slice(0, 200) || null,
        instructions: str(args.instructions) || null,
        chat_enabled: true, mission_enabled: true,
        created_by: ctx.userId ?? null,
      }).select("id").single();
      if (error) return `ERROR creating agent: ${error.message}`;
      agentsCreatedThisRun++;
      await ctx.logEvent("status", { message: `🤖 Agent « ${name} » créé et prêt.` }).catch(() => {});
      return `Agent "${name}" created and ready (id ${created.id}). It is idle until the user opens it or you assign it a mission (create_mission with assignee_agent="${name}").`;
    },
  });
  summaryLines.push("- create_agent: spin up a new teammate agent on request (passive until used; always available).");

  // Draft a reusable PROCEDURE from a plain-language request. The workflow is
  // created as a DRAFT, never active: turning a sentence into something that
  // fires on its own, unattended, is the user's decision — the agent's job is
  // to have written it well enough that the decision is easy.
  let workflowsThisRun = 0;
  tools.set("create_workflow", {
    incompressible: true,
    family: "TEAM",
    def: {
      name: "create_workflow",
      description:
        "Turn a repeatable procedure the user describes (\"chaque lundi, analyse les tickets puis fais-moi valider avant l'envoi\") into a WORKFLOW: a written playbook the assistant replays on every trigger. " +
        "Write it as MARKDOWN with these sections, in this order, omitting any that do not apply: " +
        "'## Entrées' (bullets `- \\`param\\` — what it is`, what the run needs before it can start) · " +
        "'## Objectif' (what it achieves and how you know it is done) · '## Règles' (bullets, constraints that hold throughout) · " +
        "'## Contexte' (knowledge to load) · '## Ressources à utiliser' (bullets) · " +
        "'## Outils à utiliser' (bullets `- \\`web_search\\` — why`, tools whose use is IMPOSED here) · " +
        "'## Procédure' with '### 1. Titre' per step · " +
        "'### Décision — …' for a branch · '### 🔁 Boucle — …' to repeat · " +
        "'### ➜ Passation — …' to hand a chunk of work to other agents · " +
        "'### ⏸ Validation humaine — …' for a human checkpoint · " +
        "'## Livrables attendus' (bullets) · '## À mémoriser' (bullets, what must outlive the run) · '## Exemples'. " +
        "Inside a step you may add '> **Confier à :** <nom exact d'un agent>' to delegate it; inside a Passation, add " +
        "'> **Confier à :** …', '> **Mode :** en parallèle|l'un après l'autre' and '> **Ce qui doit revenir :** …'. " +
        "Be SPECIFIC: a vague playbook produces a vague run. Created as a draft — tell the user to open it and activate it.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name, e.g. 'Revue hebdomadaire des tickets'." },
          description: { type: "string", description: "One line: what it is for." },
          document: { type: "string", description: "The full playbook in markdown, per the format above." },
          schedule: { type: "string", description: "Cron expression if it should run on a clock, e.g. '0 9 * * 1'. Omit for manual." },
        },
        required: ["name", "document"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      if (!ctx.serviceDashboardId) return "ERROR: workflows belong to a service dashboard; this agent has none.";
      if (workflowsThisRun >= 3) return "ERROR: workflow-creation limit reached for this run (3).";
      const name = str(args.name).trim().slice(0, 120);
      const document = str(args.document).trim();
      if (!name || !document) return "ERROR: name and document are required.";

      const schedule = str(args.schedule).trim();
      // The blocks are derived from the document by the EDITOR (the round-trip
      // parser lives there). Here we seed only the trigger, so the canvas opens
      // with a coherent graph and re-parses the body on first load.
      const blocks = {
        nodes: [{
          id: "trigger-1", type: "trigger", position: { x: 260, y: 80 },
          data: { label: "Déclencheur", mode: schedule ? "schedule" : "manual", schedule: schedule || "0 9 * * 1" },
        }],
        edges: [] as unknown[],
      };
      const { data, error } = await ctx.admin.from("agent_workflows").insert({
        workspace_id: ctx.workspaceId, project_id: ctx.projectId,
        service_dashboard_id: ctx.serviceDashboardId,
        name, description: str(args.description).slice(0, 2000) || null,
        status: "draft", blocks, document,
        schedule: schedule || null,
        created_by: ctx.userId ?? null,
      }).select("id").single();
      if (error) return `ERROR creating workflow: ${error.message}`;
      workflowsThisRun++;
      await ctx.logEvent("status", { message: `⚙️ Workflow « ${name} » rédigé (brouillon).` }).catch(() => {});
      return `Workflow "${name}" created as a DRAFT (id ${(data as { id: string }).id}). ` +
        `Tell the user it is in Ressources → Workflows: they open it to review the blocks and ACTIVATE it — ` +
        `it will not run until they do.`;
    },
  });
  summaryLines.push("- create_workflow: write a repeatable procedure as a reusable workflow (draft; the user activates it).");

  // Always-on: PROPOSE work you noticed would add value, WITHOUT executing it.
  // Files a paused mission in the kanban backlog — the human reviews and starts
  // it. This is the safe channel for agent initiative (unlike create_mission it
  // never runs anything), so it bypasses the in-mission self-creation guard.
  let proposalsThisRun = 0;
  tools.set("propose_mission", {
    def: {
      name: "propose_mission",
      description:
        "Propose a NEW piece of valuable work you noticed while working (an improvement, a risk to fix, a follow-up, an automation opportunity). This creates a PAUSED mission in the backlog for the human to review — nothing executes until they start it. Use it for genuine value beyond the current ask (max 3 per run); do NOT use it to split or defer your CURRENT task (use update_todos subtasks for that).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short, action-oriented mission title." },
          brief: { type: "string", description: "What to do, with enough context that a future run can execute it without this conversation." },
          value: { type: "string", description: "One sentence: the concrete value / why it matters." },
        },
        required: ["title", "brief", "value"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const title = str(args.title).trim().slice(0, 160);
      const brief = str(args.brief).trim();
      const value = str(args.value).trim().slice(0, 300);
      if (!title || !brief) return "ERROR: title and brief are required.";
      if (proposalsThisRun >= 3) return "ERROR: proposal limit reached for this run (3). Mention further ideas in your final report instead.";
      const { data: mission, error } = await ctx.admin.from("internal_agent_missions").insert({
        agent_id: ctx.agentId, workspace_id: ctx.workspaceId, project_id: ctx.projectId,
        title,
        brief: `${brief}\n\n---\n💡 Proposée par l'agent${value ? ` — Valeur attendue : ${value}` : ""}`,
        status: "paused",
        board_column: "backlog",
        delegated_by_agent: ctx.agentId,
      }).select("id").single();
      if (error) return `ERROR proposing mission: ${error.message}`;
      proposalsThisRun++;
      await ctx.logEvent("status", { message: `💡 Initiative proposée : « ${title} » (backlog, en attente de validation humaine).` }).catch(() => {});
      return `Proposal filed in the backlog: "${title}" (id ${mission.id}). It will NOT run until a human starts it — mention it in your final report under "Initiatives".`;
    },
  });
  summaryLines.push("- propose_mission: file a PAUSED backlog mission for valuable work you noticed (human reviews; never auto-executes).");

  // Always-on: search the agent's OWN past output (deliverables + run reports)
  // so it can reuse prior work instead of redoing it. Complements search_memory
  // (facts/learnings) with the concrete artifacts themselves.
  tools.set("search_past_work", {
    def: {
      name: "search_past_work",
      description:
        "Search your OWN past work — deliverables and final mission reports from previous runs — by keyword. Use it BEFORE redoing anything that may already exist (a report, a dataset, an analysis, a script) and to ground new work in what was already produced. Returns matches with dates and content excerpts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to search for (matched against names, summaries and content)." },
          limit: { type: "number", description: "Max results (default 5, max 10)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const query = str(args.query).trim().slice(0, 120);
      if (!query) return "ERROR: query is required.";
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
      const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      const [{ data: delivs }, { data: runs }] = await Promise.all([
        ctx.admin.from("internal_agent_deliverables")
          .select("name, kind, summary, content, file_url, created_at")
          .eq("agent_id", ctx.agentId)
          .or(`name.ilike.${like},summary.ilike.${like},content.ilike.${like}`)
          .order("created_at", { ascending: false }).limit(limit),
        ctx.admin.from("internal_agent_runs")
          .select("final_output, finished_at, mission_id")
          .eq("agent_id", ctx.agentId).eq("status", "succeeded")
          .ilike("final_output", like)
          .order("finished_at", { ascending: false }).limit(limit),
      ]);
      const parts: string[] = [];
      for (const d of (delivs ?? []) as Array<Record<string, unknown>>) {
        const body = String(d.content ?? "").replace(/\s+/g, " ").slice(0, 500);
        parts.push(`[deliverable · ${String(d.kind)} · ${String(d.created_at).slice(0, 10)}] ${String(d.name)}${d.file_url ? ` (${String(d.file_url)})` : ""}${body ? ` — ${body}` : ""}`);
      }
      for (const r of ((runs ?? []) as Array<Record<string, unknown>>).slice(0, Math.max(0, limit - parts.length))) {
        parts.push(`[run report · ${String(r.finished_at ?? "").slice(0, 10)}] ${String(r.final_output ?? "").replace(/\s+/g, " ").slice(0, 500)}`);
      }
      if (parts.length === 0) return `No past work matched "${query}". You likely haven't produced this before — proceed, and save durable results with create_deliverable.`;
      return cap(parts.slice(0, limit).join("\n\n"));
    },
  });
  summaryLines.push("- search_past_work: search your own past deliverables & reports before redoing anything (always available).");

  // ---------------------------------------------------------------------------
  // Les procédures du service
  //
  // Une procédure n'est PAS déclenchée : personne ne la lance. C'est un mode
  // opératoire écrit une fois, que l'agent consulte quand il tombe sur la
  // situation qu'elle décrit. Sans cet outil, elles n'existaient que pour
  // l'écran qui les édite — écrites, activées, et jamais lues par personne.
  //
  // Divulgation progressive, comme les skills : l'INDEX (nom + quand s'en
  // servir) tient dans la description de l'outil, le texte complet ne part que
  // quand l'agent le demande. Charger douze procédures entières dans chaque
  // prompt serait exactement le fichier d'instructions monolithique que les
  // workflows existent pour remplacer.
  // ---------------------------------------------------------------------------
  if (ctx.serviceDashboardId) {
    tools.set("use_procedure", {
      family: "PLAN",
      def: {
        name: "use_procedure",
        description:
          "Les modes opératoires écrits par ton service. Sans argument, liste ceux qui existent avec la situation que chacun couvre. " +
          "Avec un `id`, rend la procédure complète, étape par étape — et tu la SUIS toi-même, dans ce run : c'est le cas normal. " +
          "mode=\"run\" est réservé au cas où le travail doit se dérouler À CÔTÉ du tien (long, indépendant, avec son propre compte rendu) : " +
          "il ouvre un run séparé confié à l'assistant du service, et tu n'attends pas son résultat. " +
          "RÉFLEXE : avant de traiter une demande qui ressemble à un cas récurrent (une réclamation, une relance, une clôture, un incident), regarde s'il en existe une — la suivre vaut mieux que réinventer une façon de faire qui devra être corrigée ensuite.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "L'id de la procédure. Omets-le pour lister ce qui existe." },
            mode: {
              type: "string", enum: ["read", "run"],
              description: "read (défaut) : tu la lis et tu la suis ici. run : elle part dans son propre run, tu n'attends pas.",
            },
          },
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const id = str(args.id).trim();
        const mode = str(args.mode) === "run" ? "run" : "read";
        if (!id) {
          const { data } = await ctx.admin.from("agent_workflows")
            .select("id, name, description")
            .eq("service_dashboard_id", ctx.serviceDashboardId!)
            .eq("kind", "procedure").eq("status", "active")
            .order("updated_at", { ascending: false }).limit(30);
          const rows = (data ?? []) as Array<{ id: string; name: string; description: string | null }>;
          if (rows.length === 0) {
            return "Aucune procédure écrite pour ce service. Traite la demande à ta façon, et si le cas se répète, propose d'en écrire une (propose_mission).";
          }
          return JSON.stringify(rows.map((r) => ({
            id: r.id, nom: r.name, quand_s_en_servir: r.description ?? "(non précisé)",
          })));
        }
        const { data } = await ctx.admin.from("agent_workflows")
          .select("name, description, document, status, kind, service_dashboard_id")
          .eq("id", id).maybeSingle();
        const wf = data as {
          name: string; description: string | null; document: string;
          status: string; kind: string; service_dashboard_id: string | null;
        } | null;
        // On vérifie le service ET la nature : une automatisation n'est pas un
        // texte à suivre, et rendre son playbook ferait exécuter à la main ce
        // que le moteur exécute déjà tout seul.
        if (!wf || wf.service_dashboard_id !== ctx.serviceDashboardId) return "ERROR: procédure introuvable dans ce service.";
        if (wf.kind !== "procedure") return "ERROR: ceci est une automatisation — elle s'exécute toute seule, il n'y a rien à suivre.";
        if (wf.status !== "active") return `La procédure « ${wf.name} » n'est pas active : ne t'en sers pas.`;
        if (!wf.document.trim()) return `La procédure « ${wf.name} » est vide.`;

        if (mode === "run") {
          // Garde-fou : une procédure déjà en cours ne se relance pas. Sans ça,
          // l'assistant qui exécute une procédure et y rencontre son propre nom
          // la relancerait indéfiniment, chaque run en ouvrant un nouveau.
          const { data: live } = await ctx.admin.from("agent_workflow_runs")
            .select("id").eq("workflow_id", id).eq("status", "running").limit(1).maybeSingle();
          if (live) {
            return `La procédure « ${wf.name} » a déjà un run en cours (${(live as { id: string }).id}). N'en relance pas un second — suis-la ici si tu en as besoin maintenant.`;
          }
          const base = Deno.env.get("SUPABASE_URL");
          const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
          if (!base || !key) return "ERROR: runtime non configuré.";
          const res = await fetch(`${base}/functions/v1/run-workflow`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              workflow_id: id,
              trigger_payload: { trigger: "agent", agent_id: ctx.agentId },
            }),
          });
          const json = await res.json().catch(() => null) as Record<string, unknown> | null;
          if (!res.ok || !json?.run_id) return `ERROR: lancement impossible — ${str(json?.error) || res.status}.`;
          return `Procédure « ${wf.name} » lancée dans son propre run (${str(json.run_id)}), confiée à l'assistant du service. `
            + `N'attends pas son résultat ici : signale-le et poursuis ce que tu peux faire toi-même.`;
        }

        return cap([
          `# Procédure : ${wf.name}`,
          wf.description ? `_Quand s'en servir : ${wf.description}_` : "",
          "",
          wf.document.trim(),
          "",
          "_Suis ces étapes. Si le cas s'en écarte vraiment, dis-le dans ton rapport plutôt que d'improviser en silence._",
        ].filter(Boolean).join("\n"), 14000);
      },
    });
    summaryLines.push("- use_procedure: les modes opératoires écrits par ton service — liste-les, puis lis celui qui couvre la situation, AVANT d'inventer ta façon de faire.");
  }

  // ---------------------------------------------------------------------------
  // L'entreprise : ses objectifs, et sa carte (0212 / 0214)
  //
  // Le prompt système porte déjà le profil et les objectifs qui concernent CET
  // agent. Ces deux outils servent au reste : le pourquoi qu'il n'a pas reçu,
  // et les gens qu'il ne connaît pas encore.
  // ---------------------------------------------------------------------------
  tools.set("company_objectives", {
    def: {
      name: "company_objectives",
      description:
        "Les objectifs de l'entreprise — au-delà de ceux déjà dans ton contexte. " +
        "'list' pour voir l'arbre complet (y compris ceux des autres services) ; " +
        "'why' pour REMONTER la chaîne au-dessus d'un objectif et comprendre ce qu'il sert vraiment — à utiliser quand une demande te semble arbitraire ; " +
        "'measure' pour mettre à jour la valeur courante d'une métrique dont tu viens d'obtenir le vrai chiffre. " +
        "Ne 'measure' que des chiffres que tu as réellement constatés, jamais une estimation.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "why", "measure"], description: "list · why · measure" },
          objective_id: { type: "string", description: "L'objectif visé (pour 'why' et 'measure')." },
          value: { type: "number", description: "La valeur courante constatée (pour 'measure')." },
          note: { type: "string", description: "D'où vient ce chiffre (pour 'measure') — la source, pas le commentaire." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const action = str(args.action) || "list";
      const cols = "id, parent_id, title, detail, metric, unit, baseline_value, target_value, current_value, direction, period_end, status, priority, owner_dashboard_id, owner_agent_id";

      if (action === "measure") {
        const id = str(args.objective_id);
        const value = Number(args.value);
        if (!id || !Number.isFinite(value)) return "ERROR: objective_id et value (numérique) sont requis.";
        const { data: before } = await ctx.admin.from("company_objectives")
          .select("title, metric, unit, target_value").eq("id", id).eq("project_id", ctx.projectId).maybeSingle();
        if (!before) return "ERROR: cet objectif n'existe pas dans cette entreprise.";
        const { error } = await ctx.admin.from("company_objectives").update({
          current_value: value,
          measured_at: new Date().toISOString(),
          measured_by: "agent",
          measured_note: str(args.note).slice(0, 600) || null,
          updated_at: new Date().toISOString(),
        }).eq("id", id).eq("project_id", ctx.projectId);
        if (error) return `ERROR: ${error.message}`;
        const b = before as { title: string; metric: string | null; unit: string | null; target_value: number | null };
        return `Mesure enregistrée : « ${b.title} » — ${b.metric ?? "valeur"} = ${value}${b.unit ? ` ${b.unit}` : ""}` +
          `${b.target_value != null ? ` (cible ${b.target_value}${b.unit ? ` ${b.unit}` : ""})` : ""}. ` +
          `Elle est datée et attribuée à toi : le tableau de bord montrera qui l'a mise à jour.`;
      }

      const { data } = await ctx.admin.from("company_objectives")
        .select(cols).eq("project_id", ctx.projectId)
        .in("status", ["active", "at_risk", "draft", "done"])
        .order("priority", { ascending: true }).limit(80);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        return "Aucun objectif n'est défini pour cette entreprise. " +
          "Si la demande en cours en suppose un, dis-le plutôt que de le deviner — c'est à un humain de le poser.";
      }

      if (action === "why") {
        const id = str(args.objective_id);
        if (!id) return "ERROR: objective_id est requis pour 'why'.";
        const byId = new Map(rows.map((r) => [String(r.id), r]));
        const chain: Array<Record<string, unknown>> = [];
        // Le type est ANNOTÉ. Sans lui, `cur` est inféré depuis `byId.get` puis
        // réaffecté depuis lui-même dans la boucle : TypeScript n'a pas de
        // point de départ pour résoudre la circularité et abandonne (TS7022).
        let cur: Record<string, unknown> | undefined = byId.get(id);
        if (!cur) return "ERROR: cet objectif n'existe pas dans cette entreprise.";
        // Garde-fou sur la profondeur : un arbre mal saisi peut contenir un
        // cycle, et une remontée infinie est un run mort.
        while (cur && chain.length < 8) {
          chain.push(cur);
          const p: Record<string, unknown> | undefined = cur.parent_id
            ? byId.get(String(cur.parent_id))
            : undefined;
          if (!p || p === cur) break;
          cur = p;
        }
        return JSON.stringify({
          chaine_du_plus_precis_au_plus_general: chain.map((o) => ({
            id: o.id, titre: o.title, metrique: o.metric,
            cible: o.target_value, valeur_actuelle: o.current_value, unite: o.unit,
            echeance: o.period_end, statut: o.status,
          })),
          lecture: "Le dernier élément est ce que l'entreprise cherche vraiment. Si ton travail ne le sert pas, dis-le.",
        });
      }

      return JSON.stringify(rows.map((o) => ({
        id: o.id, parent_id: o.parent_id, titre: o.title, detail: o.detail,
        metrique: o.metric, unite: o.unit, cible: o.target_value, valeur_actuelle: o.current_value,
        sens: o.direction, echeance: o.period_end, statut: o.status, priorite: o.priority,
        a_toi: o.owner_agent_id === ctx.agentId,
        a_ton_service: !!ctx.serviceDashboardId && o.owner_dashboard_id === ctx.serviceDashboardId,
      })));
    },
  });
  summaryLines.push("- company_objectives: lire l'arbre des objectifs de l'entreprise, remonter le POURQUOI d'une demande, ou enregistrer une mesure constatée (toujours disponible).");

  tools.set("explore_company_graph", {
    def: {
      name: "explore_company_graph",
      description:
        "La carte de l'entreprise : services, agents, rooms, missions, livrables, outils connectés, collections et ressources — et ce qui les relie. " +
        "Sert à répondre à « qui s'occupe de ça ? », « quel service a déjà cet outil connecté ? », « qu'a produit ce service récemment ? » " +
        "SANS demander à un humain ni deviner. " +
        "'search' cherche par mot-clé, 'neighbors' déplie ce qui entoure un nœud, 'overview' donne la structure d'ensemble. " +
        "Les ids sont de la forme \"<type>:<uuid>\" ; un id d'agent s'utilise tel quel avec send_message_to_agent en retirant le préfixe.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["overview", "search", "neighbors"], description: "overview · search · neighbors" },
          query: { type: "string", description: "Mot-clé (pour 'search')." },
          node_id: { type: "string", description: "Nœud de départ, ex. \"service:<uuid>\" (pour 'neighbors')." },
          kind: {
            type: "string",
            description: "Filtre de type : company · objective · service · agent · room · mission · deliverable · connector · collection · asset.",
          },
          limit: { type: "number", description: "Max résultats (défaut 25, max 60)." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const action = str(args.action) || "overview";
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 60);

      if (action === "overview") {
        const { data } = await ctx.admin
          .from("company_graph_nodes").select("kind, label, sublabel, status, dashboard_id")
          .eq("project_id", ctx.projectId).limit(600);
        const rows = (data ?? []) as Array<{ kind: string; label: string; sublabel: string | null; status: string | null; dashboard_id: string | null }>;
        if (rows.length === 0) return "La carte de l'entreprise est vide.";
        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
        const services = rows.filter((r) => r.kind === "service")
          .map((s) => ({ service: s.label, mission: s.sublabel, collaboration: s.status }));
        return JSON.stringify({
          entreprise: rows.find((r) => r.kind === "company")?.label ?? null,
          effectifs: counts,
          services,
          note: "Utilise action=\"search\" pour trouver quelqu'un ou quelque chose, action=\"neighbors\" pour déplier un nœud.",
        });
      }

      if (action === "search") {
        const query = str(args.query).trim();
        if (!query) return "ERROR: query est requis pour 'search'.";
        const like = `%${query.slice(0, 60).replace(/[%_]/g, (m) => `\\${m}`)}%`;
        const found = ctx.admin
          .from("company_graph_nodes").select("id, kind, label, sublabel, status")
          .eq("project_id", ctx.projectId)
          .or(`label.ilike.${like},sublabel.ilike.${like}`);
        const typed = str(args.kind) ? found.eq("kind", str(args.kind)) : found;
        const { data } = await typed.limit(limit);
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        if (rows.length === 0) return `Rien dans la carte ne correspond à « ${query} ».`;
        return JSON.stringify(rows);
      }

      // neighbors
      const nodeId = str(args.node_id).trim();
      if (!nodeId) return "ERROR: node_id est requis pour 'neighbors' (ex. \"service:<uuid>\").";
      const [{ data: outEdges }, { data: inEdges }] = await Promise.all([
        ctx.admin.from("company_graph_edges").select("target_id, relation")
          .eq("project_id", ctx.projectId).eq("source_id", nodeId).limit(120),
        ctx.admin.from("company_graph_edges").select("source_id, relation")
          .eq("project_id", ctx.projectId).eq("target_id", nodeId).limit(60),
      ]);
      const ids = [
        ...((outEdges ?? []) as Array<{ target_id: string }>).map((e) => e.target_id),
        ...((inEdges ?? []) as Array<{ source_id: string }>).map((e) => e.source_id),
      ];
      if (ids.length === 0) return `Le nœud ${nodeId} n'a aucun voisin (ou n'existe pas).`;
      const { data: nodes } = await ctx.admin
        .from("company_graph_nodes").select("id, kind, label, sublabel, status")
        .eq("project_id", ctx.projectId).in("id", [...new Set(ids)].slice(0, 150));
      const byId = new Map(((nodes ?? []) as Array<{ id: string }>).map((n) => [n.id, n]));
      const decorate = (id: string, relation: string, dir: "sortant" | "entrant") => {
        const n = byId.get(id) as Record<string, unknown> | undefined;
        return n ? { ...n, relation, sens: dir } : null;
      };
      const out = [
        ...((outEdges ?? []) as Array<{ target_id: string; relation: string }>)
          .map((e) => decorate(e.target_id, e.relation, "sortant")),
        ...((inEdges ?? []) as Array<{ source_id: string; relation: string }>)
          .map((e) => decorate(e.source_id, e.relation, "entrant")),
      ].filter(Boolean).slice(0, limit);
      return JSON.stringify(out);
    },
  });
  summaryLines.push("- explore_company_graph: la carte de l'entreprise (qui fait quoi, quel service a quel outil, ce qui a été produit) — cherche ici avant de demander à un humain (toujours disponible).");

  // Always-on: read-only HTTP GET to any public API/URL returning JSON/text.
  tools.set("http_get", {
    def: {
      name: "http_get",
      description: "Fetch data from a public HTTP(S) URL (read-only GET) — e.g. a public REST API, JSON feed or webpage. Use for data the other tools don't cover. Returns the response body (truncated).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute https URL." },
          headers: { type: "object", description: "Optional request headers (e.g. Accept)." },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const url = normalizeUrl(str(args.url));
      if (!url) {
        return `ERROR: « ${str(args.url).slice(0, 80)} » n'est pas une URL. Passe une adresse complète, par exemple https://api.exemple.com/v1/data. Pour lire des données internes, utilise query_table ou un outil connecteur plutôt que http_get.`;
      }
      // Block obvious internal/metadata targets (SSRF guard).
      if (/(localhost|127\.0\.0\.1|169\.254\.169\.254|::1|metadata\.google)/i.test(url)) {
        return "ERROR: that host is not allowed.";
      }
      try {
        const headers = (args.headers && typeof args.headers === "object") ? args.headers as Record<string, string> : {};
        const res = await fetch(url, { headers: { Accept: "application/json, text/*", ...headers } });
        const body = await res.text();
        return cap(`HTTP ${res.status}\n${body}`, 8000);
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
  summaryLines.push("- http_get: read data from a public API/URL (always available).");

  // Always-on: send a real email (needs a connected Resend integration).
  tools.set("send_email", {
    def: {
      name: "send_email",
      description: "Send a real email via the connected email provider (Resend). Use for outreach, reports or notifications to real recipients. Be professional; only email people the task is about.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email (or comma-separated list)." },
          subject: { type: "string", description: "Email subject." },
          html: { type: "string", description: "HTML body (preferred for formatted emails)." },
          text: { type: "string", description: "Plain-text body (if no HTML)." },
        },
        required: ["to", "subject"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const base = Deno.env.get("SUPABASE_URL");
      const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!base || !key) return "ERROR: email is not configured.";
      const to = str(args.to);
      const subject = str(args.subject);
      if (!to || !subject || (!str(args.html) && !str(args.text))) return "ERROR: to, subject and html|text are required.";
      const res = await fetch(`${base}/functions/v1/send-email`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: ctx.workspaceId, project_id: ctx.projectId,
          to: to.includes(",") ? to.split(",").map((e) => e.trim()) : to,
          subject, html: str(args.html) || undefined, text: str(args.text) || undefined,
        }),
      });
      return cap(`HTTP ${res.status}\n${await res.text()}`, 2000);
    },
  });
  summaryLines.push("- send_email: send a real email via Resend (needs the email integration connected).");

  // ── Pilotage du navigateur DE L'UTILISATEUR ───────────────────────────────
  //
  // Complémentaire de sandbox_browser, pas redondant : le Chromium du sandbox
  // n'a AUCUNE session, il faudrait s'y reconnecter partout. Ici l'agent agit
  // dans le navigateur de la personne, avec ses accès déjà ouverts — donc
  // exactement là où la procédure a été démontrée.
  //
  // Le consentement n'est pas géré ici mais par l'ARMEMENT, décidé dans
  // l'extension pour une durée et un périmètre bornés. Une approbation par
  // action serait inutilisable (une procédure = vingt clics) et pousserait à
  // tout approuver sans lire. Quand le pilotage n'est pas armé, l'outil ne
  // demande rien : il explique à l'agent qu'il doit le faire demander.
  tools.set("user_browser", {
    def: {
      name: "user_browser",
      description:
        "Agir dans le navigateur de l'utilisateur — ses onglets ouverts, ses sessions déjà connectées — via l'extension FounderOS. " +
        "ONGLETS : tabs (lister tous les onglets ouverts avec leur tab_id), switch (mettre un onglet au premier plan), " +
        "open (ouvrir une url dans un NOUVEL onglet), close, navigate (aller sur une url). " +
        "navigate RÉUTILISE automatiquement un onglet déjà ouvert sur le même site s'il en existe un, sinon il en ouvre un nouveau : " +
        "il n'écrase jamais la page que l'utilisateur est en train de lire. Force un nouvel onglet avec new_tab=true, ou vise un onglet précis avec tab_id. " +
        "DANS UNE PAGE : elements (lister ce qui est cliquable — À FAIRE EN PREMIER sur une page inconnue), read (texte de la page), " +
        "find (chercher un texte), click, fill (target+value), select, check, press (value=touche), scroll. " +
        "Chaque action accepte tab_id pour viser un onglet précis (obtenu via 'tabs') ; sans lui, l'onglet actif est utilisé — " +
        "tu peux donc travailler sur plusieurs onglets en parallèle sans changer le focus de l'utilisateur. " +
        "Les cibles se décrivent par {label, role, testid, css, name, placeholder} — le même vocabulaire que les skills apprises par démonstration. " +
        "Nécessite que l'utilisateur ait autorisé le pilotage depuis l'extension.",
      parameters: { type: "object", properties: {
        action: { type: "string", description: "tabs | switch | open | close | navigate | elements | read | find | click | fill | select | check | press | scroll" },
        target: { type: "object", description: "Cible : {label?, role?, testid?, css?, name?, placeholder?}. Le label est le texte visible." },
        value: { type: "string", description: "Valeur à saisir/choisir, touche à presser, ou texte à chercher." },
        url: { type: "string", description: "URL pour navigate / open." },
        tab_id: { type: "number", description: "Onglet visé (voir l'action 'tabs'). Omis = onglet actif, ou onglet déjà ouvert sur le site pour navigate." },
        new_tab: { type: "boolean", description: "navigate : forcer l'ouverture d'un nouvel onglet au lieu de réutiliser un onglet existant." },
      }, required: ["action"], additionalProperties: false },
    },
    run: async (args) => {
      const action = str(args.action);
      const known = [
        "tabs", "switch", "open", "close", "navigate",
        "elements", "read", "find", "click", "fill", "select", "check", "press", "scroll",
      ];
      if (!known.includes(action)) return `ERROR: action inconnue « ${action} ». Disponibles : ${known.join(", ")}.`;

      // L'appareil éligible : appairé, armé, et vu récemment. Plusieurs postes
      // peuvent exister dans un workspace — on prend celui qui est réellement
      // devant quelqu'un.
      const nowIso = new Date().toISOString();
      const { data: devices } = await ctx.admin.from("recorder_devices")
        .select("id, name, control_until, last_seen_at")
        .eq("workspace_id", ctx.workspaceId).is("revoked_at", null)
        .gt("control_until", nowIso)
        .order("last_seen_at", { ascending: false }).limit(1);
      const device = (devices ?? [])[0] as { id: string; name: string; control_until: string } | undefined;

      if (!device) {
        return "Le pilotage du navigateur n'est pas autorisé en ce moment. "
          + "Demande à l'utilisateur d'ouvrir l'extension FounderOS dans sa barre d'outils "
          + "et de cliquer « Autoriser 15 minutes ». N'essaie pas de contourner : "
          + "sans cette autorisation aucun ordre ne lui sera transmis.";
      }

      const params: Record<string, unknown> = {};
      if (args.target && typeof args.target === "object") params.target = args.target;
      if (args.value != null) params.value = str(args.value);
      if (args.url != null) params.url = str(args.url);
      if (args.tab_id != null && Number.isFinite(Number(args.tab_id))) params.tab_id = Number(args.tab_id);
      if (args.new_tab === true) params.new_tab = true;

      const { data: cmd, error } = await ctx.admin.from("browser_commands").insert({
        workspace_id: ctx.workspaceId, device_id: device.id,
        agent_id: ctx.agentId, run_id: ctx.runId,
        action, params,
      }).select("id").single();
      if (error || !cmd) return `ERROR: commande non enregistrée (${error?.message ?? "inconnu"})`;

      if (ctx.logEvent) await ctx.logEvent("browser_action", { action, target: args.target, url: args.url });

      // Attente du compte rendu. L'extension interroge toutes les ~1,5 s ; au
      // pire elle dormait et son alarme la réveille sous 30 s. Au-delà, c'est
      // que le navigateur est fermé — le dire vaut mieux que bloquer le run.
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1200));
        const { data: row } = await ctx.admin.from("browser_commands")
          .select("status, result, error").eq("id", cmd.id).maybeSingle();
        const st = (row as { status?: string; result?: unknown; error?: string } | null);
        if (!st || st.status === "pending" || st.status === "running") continue;
        if (st.status === "done") return JSON.stringify(st.result ?? {}).slice(0, 8000);
        return `ERROR: ${st.error ?? "échec de l'action dans le navigateur"}`;
      }

      await ctx.admin.from("browser_commands")
        .update({ status: "expired", error: "aucune réponse du navigateur" }).eq("id", cmd.id);
      return "ERROR: le navigateur n'a pas répondu (fermé, ou en veille). "
        + "Demande à l'utilisateur de vérifier que son navigateur est ouvert et le pilotage toujours autorisé.";
    },
  });
  summaryLines.push("- user_browser: act in the user's own browser (their tabs and sessions), when they have armed control in the extension.");


  // ── FORMER QUELQU'UN, DANS SON PROPRE NAVIGATEUR ──────────────────────────
  //
  // user_browser fait le travail À LA PLACE de la personne. guide_user fait
  // exactement l'inverse, et c'est ce que demandait l'onboarding : l'agent
  // connaît la procédure, mais c'est le nouvel arrivant qui doit apprendre à la
  // faire — dans le vrai outil, avec son propre compte.
  //
  // Techniquement, la différence tient en un mot : ATTENDRE. L'outil pose un
  // repère sur l'élément, écrit la phrase, et rend la main seulement quand la
  // personne a agi (ou renoncé). Un agent qui « montre » sans attendre ne forme
  // personne — il fait défiler des bulles.
  //
  // Le canal `coach` (migration 0218) garantit le reste : aucune commande
  // mutante n'y est servie, ni par le serveur ni par l'extension. Ce n'est donc
  // pas une consigne de prompt que l'agent pourrait contourner en insistant.

  /** L'appareil devant lequel se tient quelqu'un. Le mode formation suffit ; un
   *  appareil armé pour le pilotage convient aussi — qui peut le plus peut le
   *  moins, et exiger deux armements pour être guidé serait absurde. */
  const coachDevice = async (): Promise<{ id: string; name: string } | undefined> => {
    const nowIso = new Date().toISOString();
    const { data } = await ctx.admin.from("recorder_devices")
      .select("id, name, coach_until, control_until, last_seen_at")
      .eq("workspace_id", ctx.workspaceId).is("revoked_at", null)
      .or(`coach_until.gt.${nowIso},control_until.gt.${nowIso}`)
      .order("last_seen_at", { ascending: false }).limit(1);
    return (data ?? [])[0] as { id: string; name: string } | undefined;
  };

  /** Attend le verdict d'un ordre de guidage. Rend `null` si l'échéance de
   *  l'agent tombe avant celle de la personne : l'ordre reste alors vivant, et
   *  `guide_user action="wait"` permet de revenir l'attendre. */
  const awaitCommand = async (id: string, deadlineMs: number): Promise<{ status: string; result?: Record<string, unknown>; error?: string } | null> => {
    while (Date.now() < deadlineMs) {
      await new Promise((r) => setTimeout(r, 1200));
      const { data: row } = await ctx.admin.from("browser_commands")
        .select("status, result, error").eq("id", id).maybeSingle();
      const st = row as { status?: string; result?: Record<string, unknown>; error?: string } | null;
      if (!st || st.status === "pending" || st.status === "running") continue;
      return { status: st.status!, result: st.result ?? undefined, error: st.error ?? undefined };
    }
    return null;
  };

  /**
   * Journaliser n'est pas une politesse administrative : une étape sur laquelle
   * trois personnes sur quatre bloquent est une procédure à réécrire, et
   * personne ne s'en apercevra si la trace dépend du bon vouloir de l'agent en
   * fin de session. Le journal est donc un SOUS-PRODUIT du guidage, écrit ici,
   * qu'on y pense ou non.
   */
  const logTrainingStep = async (
    stepPayload: Record<string, unknown>,
    outcome: string,
    extra: { url?: string | null; duration_ms?: number | null; hints?: number; note?: string | null },
  ): Promise<void> => {
    const meta = await readRunMeta(ctx);
    const sessionId = typeof meta.training_session_id === "string" ? meta.training_session_id : null;
    if (!sessionId) return;
    const seq = Number(meta.training_step_seq ?? 0) + 1;
    await ctx.admin.from("training_step_logs").insert({
      session_id: sessionId,
      seq,
      title: str(stepPayload.title) || null,
      instruction: str(stepPayload.instruction) || null,
      target: stepPayload.target ?? {},
      url: extra.url ?? null,
      outcome: ["done", "stuck", "skipped", "timeout", "not_found", "answered"].includes(outcome) ? outcome : "done",
      hints: extra.hints ?? 0,
      duration_ms: extra.duration_ms ?? null,
      note: extra.note ?? null,
    }).then(() => {}, () => {});
    await writeRunMeta(ctx, { ...meta, training_step_seq: seq });
    // Le compteur de blocages vit sur la session : c'est lui qu'on lit pour
    // savoir si un parcours se passe mal AVANT qu'il ne se termine.
    const patch: Record<string, unknown> = { current_step: seq };
    if (outcome === "stuck") {
      const { data: s } = await ctx.admin.from("training_sessions").select("stuck_count").eq("id", sessionId).maybeSingle();
      patch.stuck_count = Number((s as { stuck_count?: number } | null)?.stuck_count ?? 0) + 1;
    }
    await ctx.admin.from("training_sessions").update(patch).eq("id", sessionId).then(() => {}, () => {});
  };

  tools.set("guide_user", {
    def: {
      name: "guide_user",
      description:
        "FORMER une personne dans son navigateur : entourer le bon élément, écrire (et dire à voix haute) quoi faire, puis ATTENDRE qu'elle le fasse. " +
        "Tu ne cliques jamais à sa place — c'est elle qui apprend. " +
        "ACTIONS : step (poser un repère sur une cible + instruction, et attendre le geste — l'action principale), " +
        "say (un message sans cible : introduction, explication, encouragement ; ack=true pour attendre un « compris »), " +
        "ask (une question avec des choix cliquables, rend la réponse), " +
        "look (lire ce qui est réellement à l'écran — À FAIRE quand un repère n'a pas pu être posé, ou pour vérifier où en est la personne), " +
        "end (retirer l'overlay et clore la formation), " +
        "wait (revenir attendre une étape déjà affichée, avec son command_id). " +
        "Le résultat d'un step dit ce qui s'est passé : done (fait), stuck (elle demande de l'aide), skipped (passée), timeout (aucune réaction), quit (elle a arrêté). " +
        "Nécessite que la personne ait activé « Mode formation » dans l'extension FounderOS.",
      parameters: { type: "object", properties: {
        action: { type: "string", description: "step | say | ask | look | end | wait" },
        instruction: { type: "string", description: "Ce qu'elle doit faire, à l'impératif, 15 mots maximum. « Clique sur Nouveau contact », pas « il faudrait maintenant que vous cliquiez… »." },
        title: { type: "string", description: "Titre court de l'étape (2-4 mots), affiché au-dessus de l'instruction." },
        tip: { type: "string", description: "Le pourquoi, le raccourci, le piège classique. Une étape sur deux environ, pas à chaque fois." },
        target: { type: "object", description: "L'élément à entourer : {label?, role?, testid?, css?, name?, placeholder?}. Le label est le texte visible. Sans cible, la bulle s'affiche en coin." },
        gesture: { type: "string", description: "Le geste attendu, qui détermine comment la réussite est détectée : click | fill | select | check | keypress | navigate | none. Défaut : click si une cible est donnée." },
        value: { type: "string", description: "Pour fill/select : la valeur attendue (montrée à la personne, jamais saisie par toi). Pour keypress : la touche." },
        choices: { type: "array", items: { type: "string" }, description: "Pour ask : les réponses proposées (5 maximum)." },
        ack: { type: "boolean", description: "Pour say : attendre qu'elle clique « Compris » avant de continuer." },
        step: { type: "number", description: "Numéro de l'étape en cours, affiché dans la carte de formation." },
        total: { type: "number", description: "Nombre total d'étapes du parcours." },
        program: { type: "string", description: "Titre du parcours, affiché dans la carte de session." },
        text: { type: "boolean", description: "Pour look : rendre le TEXTE de la page au lieu de la liste des éléments cliquables." },
        wait_s: { type: "number", description: "Combien de temps attendre le geste (défaut 240 s). Au-delà, tu peux revenir avec action=wait." },
        command_id: { type: "string", description: "Pour wait : l'identifiant rendu par le step qui attend encore." },
        tab_id: { type: "number", description: "Onglet visé. Omis = celui que la personne a sous les yeux." },
      }, required: ["action"], additionalProperties: false },
    },
    run: async (args) => {
      const action = str(args.action) || "step";
      const known = ["step", "say", "ask", "look", "end", "wait"];
      if (!known.includes(action)) return `ERROR: action inconnue « ${action} ». Disponibles : ${known.join(", ")}.`;

      const stepPayload: Record<string, unknown> = {
        title: str(args.title) || undefined,
        instruction: str(args.instruction) || undefined,
        tip: str(args.tip) || undefined,
        target: (args.target && typeof args.target === "object") ? args.target : undefined,
        gesture: str(args.gesture) || undefined,
        value: args.value != null ? str(args.value) : undefined,
        choices: Array.isArray(args.choices) ? args.choices.map((c) => str(c)).slice(0, 5) : undefined,
        ack: args.ack === true ? true : undefined,
        step: Number.isFinite(Number(args.step)) ? Number(args.step) : undefined,
        total: Number.isFinite(Number(args.total)) ? Number(args.total) : undefined,
      };

      // Rendre compte de ce qu'a fait la personne, dans les mots dont l'agent a
      // besoin pour décider de la suite. Un « ok » ne suffirait pas : « elle
      // bloque » et « elle a fait » n'appellent pas le même geste suivant.
      const speak = async (res: Record<string, unknown> | undefined): Promise<string> => {
        const outcome = str(res?.outcome);
        const url = str(res?.url);
        const note = str(res?.note);
        await logTrainingStep(stepPayload, outcome || "done", {
          url: url || null,
          duration_ms: Number.isFinite(Number(res?.duration_ms)) ? Number(res?.duration_ms) : null,
          hints: Number(res?.hints ?? 0),
          note: note || null,
        });
        const secs = Math.round(Number(res?.duration_ms ?? 0) / 1000);
        switch (outcome) {
          case "done":
            return `FAIT en ${secs}s${note ? ` (${note})` : ""}${url ? ` — page : ${url}` : ""}. Enchaîne sur l'étape suivante.`;
          case "stuck":
            return "ELLE BLOQUE sur cette étape. Ne répète pas la même phrase : décris ce qu'elle doit CHERCHER DES YEUX (couleur, position, libellé voisin), ou appelle guide_user action=\"look\" pour voir ce qui est à l'écran avant de reformuler.";
          case "skipped":
            return "ÉTAPE PASSÉE à sa demande. Note ce qui reste à revoir et continue ; propose d'y revenir à la fin.";
          case "answered":
            return `RÉPONSE : « ${str(res?.answer)} ».`;
          case "timeout":
            return "AUCUNE RÉACTION dans le temps imparti. Demande-lui si elle est toujours là avant de poursuivre — n'invente pas que l'étape est faite.";
          case "quit":
            return "ELLE A QUITTÉ la formation (onglet fermé ou bouton Quitter). Clos la session avec training action=\"finish\" status=\"abandoned\".";
          case "superseded":
            return "Étape remplacée par la suivante avant d'avoir été faite.";
          default:
            return JSON.stringify(res ?? {}).slice(0, 4000);
        }
      };

      if (action === "wait") {
        const id = str(args.command_id);
        if (!id) return "ERROR: command_id requis pour action=\"wait\" (il est rendu par le step qui attend encore).";
        const done = await awaitCommand(id, Date.now() + Math.min(300, Math.max(10, Number(args.wait_s ?? 240))) * 1000);
        if (!done) return `Toujours rien. L'étape reste affichée à l'écran ; reviens attendre avec guide_user action="wait" command_id="${id}", ou parle-lui.`;
        if (done.status !== "done") return `ERROR: ${done.error ?? "l'étape a échoué"}`;
        return await speak(done.result);
      }

      const device = await coachDevice();
      if (!device) {
        return "Le mode formation n'est pas actif sur le poste de la personne. "
          + "Demande-lui d'ouvrir l'extension FounderOS dans sa barre d'outils et de cliquer « Activer 1 heure » sous « Mode formation ». "
          + "Précise-lui ce que ça autorise : tu affiches des repères et tu lis la page, tu ne cliques jamais à sa place. "
          + "N'essaie pas de contourner — sans cette autorisation aucun repère ne lui sera transmis.";
      }

      const waiting = action === "step" || action === "ask" || (action === "say" && args.ack === true);
      const waitS = Math.min(600, Math.max(10, Number(args.wait_s ?? (waiting ? 240 : 25))));
      const cmdAction = action === "step" ? "guide_step"
        : action === "ask" ? "guide_ask"
          : action === "end" ? "guide_end"
            : action === "look" ? "look" : "guide_say";

      const params: Record<string, unknown> = {
        step: stepPayload,
        session: { agent: ctx.agentName ?? "Formateur", program: str(args.program) || undefined },
        wait_s: waitS,
      };
      if (action === "look" && args.text === true) params.text = true;
      if (args.tab_id != null && Number.isFinite(Number(args.tab_id))) params.tab_id = Number(args.tab_id);

      const { data: cmd, error } = await ctx.admin.from("browser_commands").insert({
        workspace_id: ctx.workspaceId, device_id: device.id,
        agent_id: ctx.agentId, run_id: ctx.runId,
        channel: "coach", action: cmdAction, params,
        // L'ordre doit survivre à l'attente d'un humain : sans ce délai, le
        // balayage d'expiration tuerait le repère pendant qu'on le lit.
        expires_at: new Date(Date.now() + (waitS + 90) * 1000).toISOString(),
      }).select("id").single();
      if (error || !cmd) return `ERROR: repère non enregistré (${error?.message ?? "inconnu"})`;

      if (ctx.logEvent) {
        await ctx.logEvent("browser_action", {
          action: cmdAction, guiding: true,
          instruction: stepPayload.instruction, target: stepPayload.target,
        });
      }

      const done = await awaitCommand(cmd.id, Date.now() + waitS * 1000);
      if (!done) {
        return `L'étape est affichée, mais la personne n'a pas encore agi (${waitS}s). `
          + `Elle voit toujours le repère. Reviens attendre avec guide_user action="wait" command_id="${cmd.id}", `
          + "ou dis-lui quelque chose avec action=\"say\".";
      }
      if (done.status !== "done") {
        const err = done.error ?? "échec";
        if (/target_not_found/.test(err)) {
          await logTrainingStep(stepPayload, "not_found", { note: "repère impossible à poser" });
          return "REPÈRE IMPOSSIBLE À POSER : l'élément visé n'est pas sur la page. "
            + "N'insiste pas avec la même cible — appelle guide_user action=\"look\" pour lire ce qui est réellement à l'écran, "
            + "puis re-vise avec un libellé que tu y auras trouvé. Si l'outil a changé depuis la démonstration, dis-le à la personne et note-le.";
        }
        return `ERROR: ${err}`;
      }

      const res = done.result ?? {};
      if (!waiting) {
        // say / look / end : c'est délivré, il n'y a personne à attendre.
        return JSON.stringify(res).slice(0, 8000);
      }
      return await speak(res);
    },
  });
  summaryLines.push("- guide_user: coach a person step by step INSIDE a real web tool (highlight + instruction + wait for their gesture). Never acts for them.");


  // ── LE PARCOURS, ET CE QU'IL APPREND SUR LUI-MÊME ─────────────────────────
  //
  // Une formation qui ne laisse pas de trace se redonne à l'identique la fois
  // suivante, avec les mêmes trébuchements au même endroit. Ces tables-là
  // existent pour que la troisième personne formée profite des deux premières.
  tools.set("training", {
    def: {
      name: "training",
      description:
        "Les parcours de formation aux outils et leur mémoire. " +
        "ACTIONS : list_programs (les parcours existants), get_program (un parcours + les procédures démontrées qu'il référence — lis ensuite leurs gestes avec read_skill_file(slug, \"steps.json\")), " +
        "start (ouvrir une session pour la personne formée — À FAIRE avant de guider : chaque étape guidée s'y journalise toute seule), " +
        "note (consigner une observation hors étape), finish (clore la session avec un résumé honnête), " +
        "blockers (où les gens ont trébuché sur ce parcours — la donnée qui dit quelle étape réécrire).",
      parameters: { type: "object", properties: {
        action: { type: "string", description: "list_programs | get_program | start | note | finish | blockers" },
        program_id: { type: "string", description: "Le parcours (get_program, start, blockers)." },
        session_id: { type: "string", description: "La session (note, finish). Omis = celle ouverte dans ce run." },
        trainee_name: { type: "string", description: "Qui est formé (start)." },
        trainee_email: { type: "string", description: "Son email, si connu (start)." },
        total_steps: { type: "number", description: "Nombre d'étapes prévues (start), pour la barre de progression." },
        status: { type: "string", description: "finish : done | abandoned | paused. Défaut done." },
        summary: { type: "string", description: "finish : ce qui est acquis, ce qui a bloqué, ce qu'il faut revoir." },
        note: { type: "string", description: "note : l'observation à consigner." },
      }, required: ["action"], additionalProperties: false },
    },
    run: async (args) => {
      const action = str(args.action);

      if (action === "list_programs") {
        const { data } = await ctx.admin.from("training_programs")
          .select("id, title, tool_name, audience, est_minutes, is_published, skill_ids")
          .eq("workspace_id", ctx.workspaceId).order("created_at", { ascending: false }).limit(50);
        if (!data?.length) return "Aucun parcours de formation n'existe encore. Tu peux quand même former quelqu'un à partir d'une skill apprise par démonstration : cherche-la avec search_skills.";
        return JSON.stringify(data);
      }

      if (action === "get_program") {
        const id = str(args.program_id);
        if (!id) return "ERROR: program_id requis.";
        const { data: prog } = await ctx.admin.from("training_programs")
          .select("*").eq("id", id).eq("workspace_id", ctx.workspaceId).maybeSingle();
        if (!prog) return "ERROR: parcours introuvable dans cet espace de travail.";
        const skillIds = (prog as { skill_ids?: string[] }).skill_ids ?? [];
        let skills: unknown[] = [];
        if (skillIds.length) {
          const { data } = await ctx.admin.from("agent_skills")
            .select("id, slug, name, description").in("id", skillIds);
          // L'ordre du parcours est pédagogique : la base le rendrait par date.
          skills = skillIds.map((sid) => (data ?? []).find((s: { id: string }) => s.id === sid)).filter(Boolean);
        }
        return JSON.stringify({ ...prog, skills }).slice(0, 12000);
      }

      if (action === "start") {
        const programId = str(args.program_id) || null;
        const { data: session, error } = await ctx.admin.from("training_sessions").insert({
          workspace_id: ctx.workspaceId,
          program_id: programId,
          agent_id: ctx.agentId,
          run_id: ctx.runId,
          trainee_name: str(args.trainee_name) || null,
          trainee_email: str(args.trainee_email) || null,
          total_steps: Number.isFinite(Number(args.total_steps)) ? Number(args.total_steps) : null,
        }).select("id").single();
        if (error || !session) return `ERROR: session non ouverte (${error?.message ?? "inconnu"})`;
        // C'est ce numéro qui fait que guide_user journalise sans qu'on le lui
        // demande — voir logTrainingStep.
        const meta = await readRunMeta(ctx);
        await writeRunMeta(ctx, { ...meta, training_session_id: session.id, training_step_seq: 0 });
        return `Session ouverte (${session.id}). Chaque étape guidée y sera journalisée automatiquement. Clos-la avec training action="finish".`;
      }

      const currentSession = async (): Promise<string | null> => {
        const explicit = str(args.session_id);
        if (explicit) return explicit;
        const meta = await readRunMeta(ctx);
        return typeof meta.training_session_id === "string" ? meta.training_session_id : null;
      };

      if (action === "note") {
        const sid = await currentSession();
        if (!sid) return "ERROR: aucune session ouverte (training action=\"start\" d'abord).";
        const meta = await readRunMeta(ctx);
        const seq = Number(meta.training_step_seq ?? 0) + 1;
        await ctx.admin.from("training_step_logs").insert({
          session_id: sid, seq, title: "Observation",
          instruction: null, outcome: "done", note: str(args.note).slice(0, 2000),
        });
        await writeRunMeta(ctx, { ...meta, training_step_seq: seq });
        return "Observation consignée.";
      }

      if (action === "finish") {
        const sid = await currentSession();
        if (!sid) return "ERROR: aucune session ouverte.";
        const { data: s } = await ctx.admin.from("training_sessions")
          .select("started_at").eq("id", sid).maybeSingle();
        const startedAt = (s as { started_at?: string } | null)?.started_at;
        const status = ["done", "abandoned", "paused"].includes(str(args.status)) ? str(args.status) : "done";
        await ctx.admin.from("training_sessions").update({
          status,
          summary: str(args.summary).slice(0, 4000) || null,
          finished_at: new Date().toISOString(),
          duration_ms: startedAt ? Date.now() - Date.parse(startedAt) : null,
        }).eq("id", sid);
        const meta = await readRunMeta(ctx);
        delete meta.training_session_id;
        await writeRunMeta(ctx, meta);
        return "Session close. Si des étapes ont bloqué, regarde training action=\"blockers\" et dis au responsable ce qu'il faut réécrire.";
      }

      if (action === "blockers") {
        const programId = str(args.program_id);
        if (!programId) return "ERROR: program_id requis.";
        const { data: sessions } = await ctx.admin.from("training_sessions")
          .select("id").eq("workspace_id", ctx.workspaceId).eq("program_id", programId).limit(200);
        const ids = (sessions ?? []).map((s: { id: string }) => s.id);
        if (!ids.length) return "Personne n'a encore suivi ce parcours.";
        const { data: logs } = await ctx.admin.from("training_step_logs")
          .select("seq, title, instruction, outcome, duration_ms").in("session_id", ids).limit(2000);
        // L'agrégation se fait ici plutôt qu'en SQL : quelques centaines de
        // lignes, et une vue de plus à maintenir pour un seul appel.
        const byStep = new Map<string, { title: string; seen: number; stuck: number; timeout: number; not_found: number; skipped: number }>();
        for (const l of (logs ?? []) as Array<{ seq: number; title?: string; instruction?: string; outcome: string }>) {
          const key = `${l.seq}·${l.title ?? l.instruction ?? ""}`;
          const row = byStep.get(key) ?? { title: l.title || l.instruction || `étape ${l.seq}`, seen: 0, stuck: 0, timeout: 0, not_found: 0, skipped: 0 };
          row.seen += 1;
          if (l.outcome === "stuck") row.stuck += 1;
          if (l.outcome === "timeout") row.timeout += 1;
          if (l.outcome === "not_found") row.not_found += 1;
          if (l.outcome === "skipped") row.skipped += 1;
          byStep.set(key, row);
        }
        const rough = [...byStep.values()]
          .filter((r) => r.stuck + r.timeout + r.not_found + r.skipped > 0)
          .sort((a, b) => (b.stuck + b.timeout + b.not_found) - (a.stuck + a.timeout + a.not_found))
          .slice(0, 15);
        if (!rough.length) return `${ids.length} session(s) suivie(s), aucune étape problématique.`;
        return `${ids.length} session(s). Étapes qui font trébucher :\n${JSON.stringify(rough)}`;
      }

      return `ERROR: action inconnue « ${action} ».`;
    },
  });
  summaryLines.push("- training: training programs, live sessions and where trainees get stuck.");


  // ── Workflow authoring ────────────────────────────────────────────────────
  //
  // An assistant asked for a procedure used to have one move: write a markdown
  // document. The canvas then parsed it into a stack of unlinked blocks — no
  // branches, no attachments, nothing wired — and a human had to redraw it.
  // These five build the REAL graph, with the rules of the canvas enforced, and
  // keep the compiled playbook in sync on every call (the runtime refuses to
  // launch a workflow whose document is empty).
  //
  // The implementations are shared with the SaaS assistant's toolbox — same
  // module, same behaviour, one copy. Registered only where a workflow has
  // somewhere to live: a service dashboard.
  if (ctx.serviceDashboardId) {
    const wfScope = {
      admin: ctx.admin, workspaceId: ctx.workspaceId, projectId: ctx.projectId,
      dashboardId: ctx.serviceDashboardId, userId: ctx.userId ?? null,
    };
    for (const t of workflowToolDefs()) {
      tools.set(t.name, {
        def: { name: t.name, description: t.description, parameters: t.parameters },
        run: (args) => t.run(wfScope, args),
      });
    }
    summaryLines.push(
      "- workflow_create / workflow_add_block / workflow_link / workflow_configure / workflow_activate: construis une PROCÉDURE réutilisable "
      + "(blocs posés, reliés, cadrés) quand on te demande d'automatiser un travail récurrent plutôt que de le faire une fois.",
    );
  }

  // Always-on: register work produced OUTSIDE the product (0211).
  //
  // An agent with connectors and MCP servers does most of its visible work
  // elsewhere — a Notion page, a Linear issue, a Drive file. That work existed
  // nowhere in the product: you had to remember an agent had done something,
  // then go and find it in the other tool. One call puts a card on the wall,
  // with the tool's logo, that opens the real thing.
  tools.set("link_artifact", {
    def: {
      name: "link_artifact",
      description:
        "Épingle sur le mur d'artifacts un contenu que tu viens de créer ou de modifier DANS UN OUTIL EXTERNE (connecteur ou serveur MCP) : page Notion, issue Linear, document Drive, fichier Figma, pull request… "
        + "Appelle-la juste après l'action qui l'a produit, avec l'URL rendue par l'outil. "
        + "Sans ça, ton travail reste invisible ici : personne ne saura qu'il existe, ni où le trouver. "
        + "Ne l'utilise PAS pour une page que tu as seulement consultée — uniquement pour ce que TU as produit ou modifié.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Le nom du contenu, tel qu'il apparaît dans l'outil." },
          url: { type: "string", description: "L'URL exacte rendue par l'outil (https://…)." },
          summary: { type: "string", description: "Une phrase : ce que c'est, et ce que tu y as fait." },
          provider: { type: "string", description: "Optionnel — l'outil, s'il n'est pas devinable depuis l'URL (instance auto-hébergée)." },
          kind: { type: "string", description: "Optionnel — page, issue, document, design, fichier…" },
        },
        required: ["title", "url"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const url = str(args.url).trim();
      const title = str(args.title).trim().slice(0, 200);
      if (!title) return "ERROR: `title` est requis.";
      if (!isSafeUrl(url)) return "ERROR: `url` doit être un lien http(s) complet, tel que l'outil te l'a rendu.";

      const guess = inferProvider(url);
      const provider = (str(args.provider).trim().toLowerCase() || guess.provider).slice(0, 40);
      const kind = (str(args.kind).trim().toLowerCase() || guess.kind).slice(0, 40);
      const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
      const mcpServer = (ctx.mcpServers ?? [])
        .find((s) => norm(s.name).includes(norm(provider)) || norm(provider).includes(norm(s.name)))?.name ?? null;

      // On conflict = the same page registered twice: refresh the card rather
      // than stack a second one. An agent that edits a document over three runs
      // should leave one artifact, not three.
      const { error } = await ctx.admin.from("external_artifacts").upsert({
        workspace_id: ctx.workspaceId,
        project_id: ctx.projectId,
        service_room_id: ctx.serviceRoomId ?? null,
        agent_id: ctx.agentId,
        run_id: ctx.runId ?? null,
        // Connector or MCP: worked out here rather than asked of the model,
        // which would guess. If one of the agent's attached MCP servers is
        // named after this provider, that is where the link came from.
        source: mcpServer ? "mcp" : "connector",
        provider,
        tool: mcpServer,
        kind,
        title,
        url,
        summary: str(args.summary).trim().slice(0, 500) || null,
        created_by: ctx.userId ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "project_id,url" });
      if (error) return `ERROR: ${error.message}`;

      await ctx.logEvent("status", { message: `Artifact épinglé : ${title} (${provider})` }).catch(() => {});
      return `« ${title} » est épinglé sur le mur d'artifacts, avec le logo ${provider} — un clic ouvre le contenu. Inutile de recoller l'URL dans ta réponse.`;
    },
  });
  summaryLines.push("- link_artifact: épingle sur le mur un contenu créé dans un outil externe (Notion, Linear, Drive, Figma…) — à appeler juste après l'avoir produit.");

  // Always-on: the preferences FILE (0210). Distinct from save_memory on
  // purpose — memory is what the agent knows, preferences are how its user
  // wants things done. They are a short, curated, human-editable file that
  // rides in every prompt (selected against the task), where a memory is one
  // row among hundreds behind a search. Mixing the two is how "réponds en
  // français" ends up ranked 47th and never read again.
  tools.set("remember_preference", {
    def: {
      name: "remember_preference",
      description:
        "Enregistre (ou corrige) une PRÉFÉRENCE DURABLE de ton utilisateur dans ton fichier de préférences — tu la reverras à chaque session. "
        + "Appelle-la dès qu'il exprime une habitude ou te reprend sur la forme : langue, ton, format des livrables, canal à utiliser, horaires, ce qu'il ne veut jamais. "
        + "Une préférence = une phrase impérative, réutilisable hors de cette conversation (« Répondre en français », pas « il a demandé le français ce matin »). "
        + "Ne l'utilise PAS pour un fait ponctuel (→ save_memory), ni pour une consigne valable seulement cette fois. "
        + "Si l'utilisateur change d'avis, rappelle-la avec `replaces` (ou op=\"remove\") : le fichier doit rester à jour, pas s'empiler.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "La préférence, une phrase impérative et autoportante (max ~400 caractères)." },
          topic: { type: "string", description: "Sujet court pour la regrouper : langue, ton, format, outils, horaires, sécurité…" },
          always: { type: "boolean", description: "true seulement si elle vaut pour TOUTES les tâches sans exception (elle échappe alors à la sélection). Rare — n'en abuse pas." },
          replaces: { type: "string", description: "Le texte exact d'une préférence existante que celle-ci remplace (changement d'avis, formulation plus précise)." },
          op: { type: "string", enum: ["add", "remove"], description: "add (défaut) ou remove pour retirer la préférence dont le texte est donné." },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const text = str(args.text).trim();
      if (!text) return "ERROR: `text` est requis.";
      const remove = str(args.op) === "remove";
      // Compare-and-swap, retried: two parallel sub-agents can each learn
      // something in the same second, and a plain read-modify-write would let
      // the slower one silently erase the faster one's line.
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: row, error: readErr } = await ctx.admin
          .from("internal_agents").select("preferences").eq("id", ctx.agentId).maybeSingle();
        if (readErr) return `ERROR: ${readErr.message}`;
        const current = (row as { preferences: string | null } | null)?.preferences ?? null;

        let next: string;
        let message: string;
        if (remove) {
          const res = removePreference(current, text);
          if (!res.removed) return `Aucune préférence ne correspond à « ${text.slice(0, 80)} » — rien retiré. Reformule avec le texte exact.`;
          next = res.file;
          message = `Préférence retirée : « ${res.removed.text} ».`;
        } else {
          const res = upsertPreference(current, {
            text,
            topic: str(args.topic) || null,
            always: args.always === true,
            replaces: str(args.replaces) || null,
          });
          if (res.status === "full") {
            return `ERROR: ${res.reason}. Retire d'abord une préférence devenue fausse (op="remove") ou remplace-en une avec \`replaces\`.`;
          }
          if (res.status === "unchanged") return `Déjà enregistrée à l'identique : « ${res.entry.text} ». Rien à faire.`;
          next = res.file;
          message = res.status === "updated"
            ? `Préférence mise à jour : « ${res.previous?.text ?? ""} » → « ${res.entry.text} ».`
            : `Préférence enregistrée : « ${res.entry.text} »${res.entry.topic ? ` [${res.entry.topic}]` : ""}.`;
        }

        const guard = ctx.admin.from("internal_agents")
          .update({
            preferences: next,
            preferences_updated_at: new Date().toISOString(),
            preferences_updated_by: "agent",
          })
          .eq("id", ctx.agentId);
        const { data: written, error: writeErr } = await (current === null
          ? guard.is("preferences", null)
          : guard.eq("preferences", current)).select("id");
        if (writeErr) return `ERROR: ${writeErr.message}`;
        if (written && written.length > 0) {
          await ctx.logEvent("status", { message }).catch(() => {});
          return `${message} Elle s'appliquera à toutes tes prochaines sessions — inutile de la redemander.`;
        }
        // Someone else wrote between the read and the write: re-read and redo
        // the merge on top of THEIR version rather than over it.
      }
      return "ERROR: le fichier de préférences a été modifié en même temps que toi, trois fois de suite. Réessaie dans un instant.";
    },
  });
  summaryLines.push("- remember_preference: enregistre une préférence durable de l'utilisateur (langue, ton, format, canal) dans ton fichier de préférences — à chaque fois qu'il en exprime une ou te reprend sur la forme.");

  // Always-on: persistent memory. The agent reads its memory from the system
  // prompt and writes back through these tools.
  tools.set("save_memory", {
    def: {
      name: "save_memory",
      description:
        "Persist a durable memory you will see in every future session: a stable fact, a team preference, a lesson learned, or background context. Use it when you discover something worth remembering beyond this session. Don't save transient details. Restating a known memory merges into it, so saving a sharper version of something you already know is fine; when the store is full the least useful entry is evicted.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The memory, one self-contained statement (max ~500 chars)." },
          kind: { type: "string", enum: ["fact", "preference", "learning", "context"], description: "Type of memory (default fact)." },
          importance: { type: "number", description: "1 (minor) to 5 (critical). Default 3." },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const content = str(args.content).trim().slice(0, 600);
      if (!content) return "ERROR: content is required.";
      const kind = ["fact", "preference", "learning", "context"].includes(str(args.kind)) ? str(args.kind) : "fact";
      const importance = Math.min(Math.max(Math.round(Number(args.importance ?? 3)) || 3, 1), 5);
      // Dedup + eviction live in writeAgentMemory: a restated memory merges into
      // the one it restates, and a full store drops its least useful entry.
      const res = await writeAgentMemory(ctx.admin, {
        agent_id: ctx.agentId,
        workspace_id: ctx.workspaceId,
        project_id: ctx.projectId,
        kind,
        content,
        importance,
        source_run_id: ctx.runId,
        source_conversation_id: ctx.conversationId ?? null,
      });
      if (res.status === "duplicate") return "Already in memory — nothing saved (no need to save it again).";
      if (res.status === "merged") return `Merged into an existing memory that said nearly the same thing (${kind}, importance ${importance}).`;
      if (res.status === "full" || res.status === "failed") return `ERROR: ${res.error}`;
      return `Memory saved (${kind}, importance ${importance})${res.evicted ? ` — ${res.evicted} stale memory evicted to make room` : ""}.`;
    },
  });
  tools.set("search_memory", {
    def: {
      name: "search_memory",
      description:
        "Search your full persistent memory by meaning (keyword fallback). Your system prompt only shows the memories selected for this task, shortened — use this for older ones or the full text of a line ending in « (suite : search_memory) ».",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword(s) to search for." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const query = str(args.query).trim();
      if (!query) return "ERROR: query is required.";
      // Semantic search first (meaning-based, finds memories that don't share
      // the exact words), keyword ilike as fallback.
      try {
        if (Deno.env.get("JINA_API_KEY")) {
          const [qvec] = await embedTexts([query.slice(0, 500)], "retrieval.query", {
            workspace_id: ctx.workspaceId, project_id: ctx.projectId,
            agent_id: ctx.agentId, run_id: ctx.runId, feature: "agent-search-memory",
          });
          if (qvec) {
            const { data: sem } = await ctx.admin.rpc("match_agent_memories", {
              p_agent_id: ctx.agentId,
              p_query_embedding: toVectorLiteral(qvec),
              p_match_count: 10,
            });
            // A vector search always returns its top-N, relevant or not; below
            // the floor it is noise the model would then try to use.
            const hits = (Array.isArray(sem) ? sem : [])
              .filter((m: any) => Number(m.similarity ?? 0) >= RELEVANCE_FLOOR);
            if (hits.length > 0) {
              touchAgentMemories(ctx.admin, hits.map((m: any) => m.id));
              return JSON.stringify(hits.map((m: any) => ({
                kind: m.kind, content: m.content, importance: m.importance,
                similarity: Number(m.similarity ?? 0).toFixed(2),
                date: String(m.updated_at ?? m.created_at ?? "").slice(0, 10) || undefined,
              })));
            }
          }
        }
      } catch { /* fall back to keyword */ }
      const { data } = await ctx.admin
        .from("internal_agent_memories")
        .select("id, kind, content, importance, created_at")
        .eq("agent_id", ctx.agentId)
        .ilike("content", `%${query.slice(0, 60).replace(/[%_]/g, (c) => `\\${c}`)}%`)
        .order("importance", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(10);
      if (!data || data.length === 0) return "No matching memories.";
      touchAgentMemories(ctx.admin, data.map((m: { id: string }) => m.id));
      return JSON.stringify(data.map(({ id: _id, ...m }: Record<string, unknown>) => m));
    },
  });
  summaryLines.push("- save_memory / search_memory: your persistent cross-session memory (always available).");

  // Chat only: kanban housekeeping is meta-work — during a mission run the
  // board is driven by the run lifecycle itself, not by the model.
  const BOARD_COLUMNS = ["backlog", "todo", "in_progress", "review", "done"];
  if (!ctx.missionMode) {
  tools.set("list_missions", {
    def: {
      name: "list_missions",
      description:
        "List your missions and their kanban position (backlog → todo → in_progress → review → done), priority and due date.",
      parameters: {
        type: "object",
        properties: {
          column: { type: "string", enum: BOARD_COLUMNS, description: "Optional: only this board column." },
        },
        additionalProperties: false,
      },
    },
    run: async (args) => {
      let q = ctx.admin
        .from("internal_agent_missions")
        .select("id, title, board_column, status, priority, due_date, schedule, last_run_at")
        .eq("agent_id", ctx.agentId)
        .neq("status", "archived")
        .order("updated_at", { ascending: false })
        .limit(50);
      if (BOARD_COLUMNS.includes(str(args.column))) q = q.eq("board_column", str(args.column));
      const { data, error } = await q;
      if (error) return `ERROR: ${error.message}`;
      if (!data || data.length === 0) return "No missions on the board.";
      return JSON.stringify(data);
    },
  });
  tools.set("move_mission", {
    def: {
      name: "move_mission",
      description:
        "Move one of your missions to another kanban column (e.g. to 'review' when its output is ready for a human, or 'done' once validated). Use list_missions to get mission ids.",
      parameters: {
        type: "object",
        properties: {
          mission_id: { type: "string", description: "Mission id (uuid)." },
          column: { type: "string", enum: BOARD_COLUMNS, description: "Target column." },
        },
        required: ["mission_id", "column"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const missionId = str(args.mission_id);
      const column = str(args.column);
      if (!BOARD_COLUMNS.includes(column)) return "ERROR: invalid column.";
      const { data, error } = await ctx.admin
        .from("internal_agent_missions")
        .update({ board_column: column, updated_at: new Date().toISOString() })
        .eq("id", missionId)
        .eq("agent_id", ctx.agentId)
        .select("id, title")
        .maybeSingle();
      if (error) return `ERROR: ${error.message}`;
      if (!data) return "ERROR: mission not found (or it belongs to another agent).";
      return `Mission "${(data as { title: string }).title}" moved to ${column}.`;
    },
  });
  summaryLines.push("- list_missions / move_mission: inspect and move missions on your kanban board (always available).");
  }

  // Always-on: deep multi-source web research.
  tools.set("deep_research", {
    def: {
      name: "deep_research",
      description: "Perform deep web research on a topic. Searches multiple queries, reads top sources, and produces a structured synthesis with citations. Use this for thorough research instead of manual web_search + read_url loops.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The research question or topic." },
          max_sources: { type: "number", description: "Max sources to read (default 5, max 8)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const query = str(args.query);
      if (!query) return "ERROR: query is required.";
      const max = Math.min(Number(args.max_sources) || 5, 8);
      return deepResearch(query, max);
    },
  });
  summaryLines.push("- deep_research: thorough multi-source web research with synthesis (always available).");

  // Runner mode: drive a real Playwright browser (browse_web) AND execute on
  // the machine hosting the runner — shell, Python/Node, files. Available only
  // when the agent's execution environment is "runner" (per-agent choice) and
  // a runner URL is configured.
  const runnerUrl = ctx.runnerUrl || Deno.env.get("RUNNER_BROWSER_URL") || Deno.env.get("RUNNER_URL");
  const beforeRunner = new Set(tools.keys());
  if (ctx.runnerEnabled && runnerUrl) {
    tools.set("browse_web", {
      def: {
        name: "browse_web",
        description: "Navigate and interact with real web pages using a browser. Returns a DOM snapshot with numbered element refs. Actions: navigate (open URL), click (ref), fill (ref + value), select (ref + value), scroll (direction), press (key), hover (ref), screenshot, extract_text (ref), extract_links.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["navigate", "click", "fill", "select", "scroll", "press", "hover", "wait", "screenshot", "extract_text", "extract_links"], description: "Browser action to perform." },
            url: { type: "string", description: "URL (for navigate action)." },
            ref: { type: "number", description: "Element ref number from the DOM snapshot." },
            value: { type: "string", description: "Text to fill, option to select, key to press, or scroll direction." },
            selector: { type: "string", description: "CSS selector fallback if ref is not available." },
            reason: { type: "string", description: "Why you're performing this action (logged for observability)." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const action = str(args.action);
        if (!action) return "ERROR: action is required.";
        try {
          const sessionId = ctx.agentId || "default";
          const res = await fetch(`${runnerUrl}/api/browser`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Runner-Token": Deno.env.get("PLATFORM_RUNNER_TOKEN") || "",
            },
            body: JSON.stringify({ session_id: sessionId, action, ...args }),
          });
          if (!res.ok) return `ERROR: browser action failed (${res.status}).`;
          const result = await res.json();
          // Log browser event for artifact observability
          if (ctx.logEvent) {
            const kind = action === "screenshot" ? "browser_screenshot" : action === "navigate" ? "browser_navigate" : "browser_action";
            await ctx.logEvent(kind, { action, url: result.current_url, ref: args.ref, value: args.value, reason: args.reason, snapshot_preview: String(result.snapshot ?? "").slice(0, 500) });
          }
          return typeof result.snapshot === "string"
            ? `URL: ${result.current_url}\n\nDOM SNAPSHOT:\n${result.snapshot.slice(0, 8000)}`
            : JSON.stringify(result).slice(0, 8000);
        } catch (e) {
          return `ERROR: browser unreachable — ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    });
    summaryLines.push("- browse_web: navigate and interact with real web pages via a browser (always available when runner is connected).");

    // ── Machine tools: shell, code and files on the runner host. ──
    // Same tool names as sandbox mode (the two modes are exclusive) so the
    // UI icons, timeline rendering and EXECUTION family mapping work unchanged.
    const rnBase = String(runnerUrl).replace(/\/$/, "");
    const rn = async (path: string, body?: Record<string, unknown>): Promise<any> => {
      const res = await fetch(`${rnBase}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Runner-Token": Deno.env.get("PLATFORM_RUNNER_TOKEN") || "",
          // Bypass ngrok free-tier interstitial warning page (returns HTML otherwise).
          "ngrok-skip-browser-warning": "true",
        },
        body: JSON.stringify({ session_id: ctx.agentId, ...(body ?? {}) }),
      });
      const text = await res.text();
      if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) {
        throw new Error("Runner unreachable: got an HTML page (likely an ngrok tunnel warning). Check runner_browser_url in app_config.");
      }
      let json: any = {};
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!res.ok || json?.error) {
        const detail = json?.error || json?.raw || `HTTP ${res.status}`;
        throw new Error(`Runner error: ${typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300)}`);
      }
      return json;
    };
    const fmtExec = (d: any) =>
      `[exit: ${d.exit_code ?? "?"}${d.timed_out ? " | TIMED OUT" : ""} | ${d.duration_ms ?? "?"}ms]\n\n${String(d.stdout ?? "").slice(0, 250000)}${d.stderr ? `\n--- stderr ---\n${String(d.stderr).slice(0, 250000)}` : ""}`;

    tools.set("shell_exec", {
      def: {
        name: "shell_exec",
        description: "Run a shell command on the runner machine (the operator's real computer). Use for: installing packages (pip/npm install), git, running scripts, builds, curl, any CLI. Relative paths resolve inside your persistent agent workspace. Returns stdout, stderr and exit code. Call machine_info first if unsure of the OS/default shell.",
        parameters: { type: "object", properties: {
          command: { type: "string", description: "The shell command to run." },
          shell: { type: "string", enum: ["powershell", "cmd", "bash", "sh"], description: "Shell to use (default: powershell on Windows, bash elsewhere)." },
          cwd: { type: "string", description: "Working directory (default: your agent workspace)." },
          timeout: { type: "number", description: "Timeout in seconds (default 60, max 300)." },
        }, required: ["command"], additionalProperties: false },
      },
      run: async (args) => {
        // Même garde qu'en mode sandbox (FOS-21) — et il compte davantage ici,
        // puisque le scan partirait de la machine et de l'IP de l'opérateur.
        const refus = await scannerGuard(ctx, str(args.command));
        if (refus) return refus;
        const d = await rn("/api/exec", {
          command: str(args.command),
          shell: str(args.shell) || undefined,
          cwd: str(args.cwd) || undefined,
          timeout: Math.min(Number(args.timeout) || 60, 300),
        });
        if ((d.exit_code ?? 1) === 0) await rememberSandboxAction(ctx, str(args.command));
        return `$ ${str(args.command)}\n${fmtExec(d)}`;
      },
      compress: compressExecResult,
    });

    tools.set("python_exec", {
      def: {
        name: "python_exec",
        description: "Execute Python code on the runner machine, inside your persistent workspace. Each call is a FRESH process — no in-memory state survives between calls, but files do. For multi-step pipelines, write ONE script with file_write and run it via shell_exec, saving intermediate results to files.",
        parameters: { type: "object", properties: {
          code: { type: "string", description: "Python code to execute." },
          timeout: { type: "number", description: "Timeout in seconds (default 60, max 300)." },
        }, required: ["code"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await rn("/api/code", { language: "python", code: str(args.code), timeout: Math.min(Number(args.timeout) || 60, 300) });
        return fmtExec(d);
      },
      compress: compressExecResult,
    });

    tools.set("nodejs_exec", {
      def: {
        name: "nodejs_exec",
        description: "Execute Node.js / JavaScript code on the runner machine (fresh process, top-level import/await supported). Files persist in your workspace; in-memory state does not.",
        parameters: { type: "object", properties: {
          code: { type: "string", description: "JavaScript code to execute." },
          timeout: { type: "number", description: "Timeout in seconds (default 60, max 300)." },
        }, required: ["code"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await rn("/api/code", { language: "node", code: str(args.code), timeout: Math.min(Number(args.timeout) || 60, 300) });
        return fmtExec(d);
      },
      compress: compressExecResult,
    });

    tools.set("file_write", {
      def: {
        name: "file_write",
        description: "Write content to a file on the runner machine. Creates parent directories. Relative paths go inside your persistent agent workspace (preferred).",
        parameters: { type: "object", properties: {
          file: { type: "string", description: "File path (relative = inside your workspace, e.g. scripts/analyse.py)." },
          content: { type: "string", description: "Full file content." },
          append: { type: "boolean", description: "Append instead of overwrite (default false)." },
        }, required: ["file", "content"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await rn("/api/files", { action: "write", file: str(args.file), content: str(args.content), append: !!args.append });
        return `File written: ${d.file ?? str(args.file)} (${d.bytes_written ?? str(args.content).length} bytes)`;
      },
    });

    tools.set("file_read", {
      def: {
        name: "file_read",
        description: "Read a file from the runner machine (relative paths = your workspace).",
        parameters: { type: "object", properties: {
          file: { type: "string", description: "File path to read." },
        }, required: ["file"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await rn("/api/files", { action: "read", file: str(args.file) });
        return String(d.content ?? "").slice(0, 12000);
      },
    });

    tools.set("file_edit", {
      def: {
        name: "file_edit",
        description: "Edit a file on the runner machine: replace exact text (old_str → new_str). The old_str must match exactly once.",
        parameters: { type: "object", properties: {
          file: { type: "string", description: "File path." },
          old_str: { type: "string", description: "Exact text to find." },
          new_str: { type: "string", description: "Replacement text." },
        }, required: ["file", "old_str", "new_str"], additionalProperties: false },
      },
      run: async (args) => {
        await rn("/api/files", { action: "replace", file: str(args.file), old_str: str(args.old_str), new_str: str(args.new_str) });
        return `File edited: ${str(args.file)} (1 replacement).`;
      },
    });

    tools.set("list_files", {
      def: {
        name: "list_files",
        description: "List files and directories on the runner machine (relative paths = your workspace).",
        parameters: { type: "object", properties: {
          path: { type: "string", description: "Directory path (default: your workspace root)." },
          recursive: { type: "boolean", description: "List recursively (default false)." },
        }, additionalProperties: false },
      },
      run: async (args) => {
        const d = await rn("/api/files", { action: "list", path: str(args.path) || ".", recursive: !!args.recursive });
        return JSON.stringify(d).slice(0, 8000);
      },
    });

    tools.set("file_search", {
      def: {
        name: "file_search",
        description: "Search files on the runner machine: by name glob (glob param) or by content (grep param).",
        parameters: { type: "object", properties: {
          path: { type: "string", description: "Directory to search (default: your workspace)." },
          glob: { type: "string", description: "Filename glob, e.g. **/*.py" },
          grep: { type: "string", description: "Text/regex to find inside files." },
        }, additionalProperties: false },
      },
      run: async (args) => {
        const p = str(args.path) || ".";
        const d = str(args.grep)
          ? await rn("/api/files", { action: "grep", path: p, pattern: str(args.grep), max_results: 50 })
          : await rn("/api/files", { action: "find", path: p, glob: str(args.glob) || "*" });
        return JSON.stringify(d).slice(0, 8000);
      },
    });

    tools.set("machine_info", {
      def: {
        name: "machine_info",
        description: "Inspect the runner machine: OS, available shells, Python/Node/git versions, your workspace path, CPU/RAM. Call it once before machine work to know your environment.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      run: async () => JSON.stringify(await rn("/api/info")).slice(0, 4000),
    });

    tools.set("manage_files", {
      def: {
        name: "manage_files",
        description: "Filesystem housekeeping on the runner machine: create a directory, delete a file/folder, move/rename, or copy. Relative paths resolve inside your workspace.",
        parameters: { type: "object", properties: {
          action: { type: "string", enum: ["mkdir", "delete", "move", "copy"], description: "Operation to perform." },
          path: { type: "string", description: "Target path (for mkdir / delete)." },
          from: { type: "string", description: "Source path (for move / copy)." },
          to: { type: "string", description: "Destination path (for move / copy)." },
          recursive: { type: "boolean", description: "For delete: remove folders and their contents (default false)." },
        }, required: ["action"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await rn("/api/files", {
          action: str(args.action), path: str(args.path) || undefined,
          from: str(args.from) || undefined, to: str(args.to) || undefined,
          recursive: !!args.recursive,
        });
        return JSON.stringify(d).slice(0, 2000);
      },
    });

    tools.set("download_file", {
      def: {
        name: "download_file",
        description: "Download a file from a http(s) URL directly onto the runner machine (into your workspace). Use for datasets, repos' release assets, images, models — faster and more reliable than piping through code. Max 100 MB.",
        parameters: { type: "object", properties: {
          url: { type: "string", description: "The http(s) URL to download." },
          file: { type: "string", description: "Destination path (default: filename from the URL, inside your workspace)." },
        }, required: ["url"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await rn("/api/download", { url: str(args.url), file: str(args.file) || undefined });
        return `Downloaded ${d.bytes ?? "?"} bytes → ${d.file ?? "?"}${d.content_type ? ` (${d.content_type})` : ""}`;
      },
    });

    // Long-running processes: handleExec is timeout-bounded, so servers/watchers
    // need this manager. Start returns a proc_id; tail with process_logs, stop
    // with process_stop. Critical for coding tasks (dev servers, test watchers).
    tools.set("run_background", {
      def: {
        name: "run_background",
        description: "Start a LONG-RUNNING process on the runner machine that keeps running between tool calls (e.g. a dev server, a watcher, a training job). Returns a proc_id. Use process_logs to read its output and process_stop to kill it. For short commands that finish on their own, use shell_exec instead.",
        parameters: { type: "object", properties: {
          command: { type: "string", description: "The command to launch (e.g. 'npm run dev', 'python app.py')." },
          shell: { type: "string", enum: ["powershell", "cmd", "bash", "sh"], description: "Shell to use (default matches the OS)." },
          cwd: { type: "string", description: "Working directory (default: your workspace)." },
        }, required: ["command"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await rn("/api/proc", { action: "start", command: str(args.command), shell: str(args.shell) || undefined, cwd: str(args.cwd) || undefined });
        return `Started ${d.proc_id} [${d.status}${d.exit_code != null ? ` exit ${d.exit_code}` : ""}] pid ${d.pid}\n${d.stdout ? `stdout:\n${d.stdout}` : ""}${d.stderr ? `\nstderr:\n${d.stderr}` : ""}`;
      },
    });

    tools.set("list_processes", {
      def: {
        name: "list_processes",
        description: "List the background processes you started on the runner machine, with their status (running/exited/killed) and uptime.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      run: async () => {
        const d = await rn("/api/proc", { action: "list" });
        const list = Array.isArray(d.processes) ? d.processes : [];
        if (list.length === 0) return "No background processes.";
        return JSON.stringify(list).slice(0, 4000);
      },
    });

    tools.set("process_logs", {
      def: {
        name: "process_logs",
        description: "Read the latest stdout/stderr of a background process (by proc_id). ALWAYS check the logs after run_background to confirm it actually started and didn't crash.",
        parameters: { type: "object", properties: {
          proc_id: { type: "string", description: "The proc_id returned by run_background." },
          tail: { type: "number", description: "Max characters of output to return (default 8000)." },
        }, required: ["proc_id"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await rn("/api/proc", { action: "logs", proc_id: str(args.proc_id), tail: Number(args.tail) || undefined });
        return `[${d.proc_id} · ${d.status}${d.exit_code != null ? ` · exit ${d.exit_code}` : ""}]\n${d.stdout ? `stdout:\n${d.stdout}` : "(no stdout)"}${d.stderr ? `\nstderr:\n${d.stderr}` : ""}`;
      },
    });

    tools.set("process_stop", {
      def: {
        name: "process_stop",
        description: "Stop (kill) a background process you started, by proc_id. Always stop servers/watchers you no longer need before finishing.",
        parameters: { type: "object", properties: {
          proc_id: { type: "string", description: "The proc_id to stop." },
        }, required: ["proc_id"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await rn("/api/proc", { action: "stop", proc_id: str(args.proc_id) });
        return `Process ${d.proc_id} stopped (status: ${d.status}).`;
      },
    });

    summaryLines.push("- shell_exec: run shell commands on the runner machine (pip/npm install, git, scripts, any CLI).");
    summaryLines.push("- python_exec / nodejs_exec: execute code on the runner machine (fresh process each call, files persist).");
    summaryLines.push("- file_write / file_read / file_edit / list_files / file_search / manage_files: full filesystem in your persistent workspace (read, write, edit, glob/grep, mkdir/delete/move/copy).");
    summaryLines.push("- download_file: fetch a URL straight to disk (datasets, assets, models).");
    summaryLines.push("- run_background / list_processes / process_logs / process_stop: manage long-running processes (dev servers, watchers, jobs).");
    summaryLines.push("- machine_info: OS, runtimes and workspace inventory of the runner machine.");
    sandboxGuidance.push("  RUNNER MACHINE — your execution tools run on the operator's REAL machine, not a disposable container. Your workspace directory persists across runs: files you create remain available next time. Work INSIDE the workspace (use relative paths). NEVER run destructive or system-wide commands (deleting outside the workspace, formatting, registry edits, shutdown/reboot, killing processes you didn't start) and never read or exfiltrate credentials or personal files unrelated to the task.");
    sandboxGuidance.push("  EFFICIENCY: python_exec/nodejs_exec start a FRESH process each call — in-memory state is lost between calls. For any multi-step pipeline (load → analyse → save), write ONE self-contained script with file_write and run it with shell_exec, saving intermediate results (CSV/JSON) to files. The default shell may be PowerShell (Windows) — call machine_info first when unsure, and prefer cross-platform commands or explicit shell selection.");
    sandboxGuidance.push("  LONG-RUNNING PROCESSES: shell_exec is timeout-bounded and kills its process tree, so NEVER start a server/watcher with it — use run_background, which survives between calls. After run_background, ALWAYS call process_logs to confirm it started (a printed URL, 'listening on…') and didn't crash; if it crashed, fix and relaunch. Stop every process you started with process_stop before finishing the task.");
  }
  // Hybrid: namespace the runner's tools (runner_*) so they coexist with the sandbox's.
  prefixNewTools(beforeRunner, "runner_");

  // ── Sandbox tools: only available when the agent runs in sandbox (or hybrid) mode. ──
  // All AIO Sandbox responses are wrapped as { success, message, data, hint }.
  const beforeSandbox = new Set(tools.keys());
  if (ctx.sandboxUrl) {
    const sbUrl = ctx.sandboxUrl.replace(/\/$/, "");
    // FOS-06 — ces en-tetes ne portaient AUCUNE authentification. L'URL est un
    // tunnel public : quiconque la decouvrait obtenait POST /v1/bash/exec, donc
    // l'execution de commandes arbitraires, sans compte. Le secret doit etre
    // exige cote sandbox (variable d'environnement du conteneur AIO).
    const sbToken = Deno.env.get("SANDBOX_TOKEN") ?? "";
    const sbHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      // Bypass ngrok free-tier interstitial warning page (returns HTML otherwise).
      "ngrok-skip-browser-warning": "true",
      "User-Agent": "Anduran-Agent/1.0",
      ...(sbToken ? { "X-Sandbox-Token": sbToken } : {}),
    };

    // Cloisonnement par client (FOS-06, second volet). Le mode runner isole deja
    // les espaces de travail par session_id ; le mode sandbox n'avait rien, et
    // exec_dir valait /home/gem pour TOUT LE MONDE — les fichiers qu'un agent y
    // ecrit pour un client (exports, jeux de donnees, identifiants recuperes en
    // mission) etaient lisibles par l'agent du client suivant. Chaque workspace
    // recoit desormais sa racine.
    const sbHome = "/home/gem/ws-" + String(ctx.workspaceId ?? "shared").replace(/[^a-zA-Z0-9_-]/g, "");
    let sbHomeReady = false;
    const ensureSbHome = async () => {
      if (sbHomeReady) return;
      sbHomeReady = true;
      try {
        await fetch(sbUrl + "/v1/bash/exec", {
          method: "POST", headers: sbHeaders,
          body: JSON.stringify({ command: "mkdir -p " + sbHome, timeout: 10 }),
        });
      } catch { /* le premier appel reel signalera le probleme */ }
    };

    async function sb(path: string, body?: Record<string, unknown>): Promise<any> {
      const res = await fetch(`${sbUrl}/${path}`, {
        method: "POST", headers: sbHeaders,
        body: JSON.stringify(body ?? {}),
      });
      const text = await res.text();
      // Detect ngrok/HTML interstitial instead of JSON.
      if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) {
        throw new Error("Sandbox unreachable: got an HTML page (likely an ngrok tunnel warning). Check SANDBOX_URL.");
      }
      let json: any = {};
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!res.ok) {
        const detail = json?.message || json?.detail || json?.raw || res.status;
        throw new Error(`Sandbox error (${res.status}): ${typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300)}`);
      }
      return json?.data ?? json;
    }

    // ── Shell / terminal ──
    tools.set("shell_exec", {
      def: {
        name: "shell_exec",
        description: "Run a shell command in the sandbox terminal. Use for: installing packages (pip install, npm install), git, running scripts, mkdir, ls, curl, any system command. Returns stdout, stderr and exit code.",
        parameters: { type: "object", properties: {
          command: { type: "string", description: "The shell command to run." },
          timeout: { type: "number", description: "Timeout in seconds (default 60, max 300)." },
          exec_dir: { type: "string", description: "Working directory (default: your workspace's private directory)." },
        }, required: ["command"], additionalProperties: false },
      },
      run: async (args) => {
        // FOS-21 : le périmètre pentest ne gardait que http_request, alors que la
        // consigne système envoyait explicitement les scanners par ici.
        const refus = await scannerGuard(ctx, str(args.command));
        if (refus) return refus;
        await ensureSbHome();
        const d = await sb("v1/bash/exec", { command: str(args.command), timeout: Math.min(Number(args.timeout) || 60, 300), exec_dir: str(args.exec_dir) || sbHome });
        // Auto-remember installs / dataset fetches when the command succeeded.
        if ((d.exit_code ?? 1) === 0) await rememberSandboxAction(ctx, str(args.command));
        return `$ ${str(args.command)}\n[status: ${d.status ?? "?"} | exit: ${d.exit_code ?? "?"}]\n\n${(d.stdout ?? "").slice(0, 250000)}${d.stderr ? `\n--- stderr ---\n${d.stderr.slice(0, 250000)}` : ""}`;
      },
      compress: compressExecResult,
    });

    // ── Code execution (Python / Node) ──
    tools.set("python_exec", {
      def: {
        name: "python_exec",
        description: "Execute Python code in the sandbox. State persists across calls when stateful=true. Use for data analysis, scripting, computations. Returns stdout, stderr, and any errors.",
        parameters: { type: "object", properties: {
          code: { type: "string", description: "Python code to execute." },
          stateful: { type: "boolean", description: "Keep variables between calls (default true)." },
        }, required: ["code"], additionalProperties: false },
      },
      run: async (args) => {
        const code = str(args.code);
        const stateful = args.stateful !== false;
        const exec = () => sb("v1/code/execute", { language: "python", code, stateful });
        const kernelLost = (s: any) =>
          /kernel|no kernel|died|dead|restart|disconnect|connection/i.test(
            `${s?.status ?? ""} ${s?.stderr ?? ""} ${Array.isArray(s?.traceback) ? s.traceback.join(" ") : ""}`,
          );
        let d = await exec();
        // The stateful Jupyter kernel can die between calls. It auto-restarts, so
        // retry ONCE; the model is told its in-memory state was reset.
        let restarted = false;
        if (kernelLost(d)) {
          restarted = true;
          await new Promise((r) => setTimeout(r, 1500));
          d = await exec();
        }
        const tb = Array.isArray(d.traceback) ? d.traceback.join("\n") : "";
        const hint = restarted
          ? "\n\n[hint: the Python kernel had restarted — in-memory variables were reset. Re-load data from disk (re-read your CSV / re-import) before relying on previous state.]"
          : "";
        return `[status: ${d.status ?? "?"} | exit: ${d.exit_code ?? "?"}]\n\n${(d.stdout ?? "").slice(0, 250000)}${d.stderr ? `\n--- stderr ---\n${d.stderr.slice(0, 250000)}` : ""}${tb ? `\n--- traceback ---\n${tb.slice(0, 250000)}` : ""}${hint}`;
      },
      compress: compressExecResult,
    });

    tools.set("nodejs_exec", {
      def: {
        name: "nodejs_exec",
        description: "Execute Node.js / JavaScript code in the sandbox. Returns stdout, stderr.",
        parameters: { type: "object", properties: {
          code: { type: "string", description: "JavaScript code to execute." },
        }, required: ["code"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await sb("v1/nodejs/execute", { code: str(args.code) });
        return `[exit: ${d.exit_code ?? "?"}]\n\n${(d.stdout ?? d.output ?? "").slice(0, 250000)}${d.stderr ? `\n--- stderr ---\n${d.stderr.slice(0, 250000)}` : ""}`;
      },
      compress: compressExecResult,
    });

    tools.set("jupyter_exec", {
      def: {
        name: "jupyter_exec",
        description: "Execute Python code in a Jupyter kernel (stateful, ideal for data analysis & plotting). Returns rich outputs including text, tables, and image references.",
        parameters: { type: "object", properties: {
          code: { type: "string", description: "Python code to run in Jupyter." },
        }, required: ["code"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await sb("v1/jupyter/execute", { code: str(args.code) });
        const outputs = Array.isArray(d.outputs) ? d.outputs.map((o: any) => o.text ?? o.data ?? JSON.stringify(o)).join("\n") : "";
        return `[status: ${d.status ?? "ok"}]\n\n${(d.stdout ?? "").slice(0, 250000)}${outputs ? `\n${outputs.slice(0, 250000)}` : ""}${d.stderr ? `\n--- stderr ---\n${d.stderr.slice(0, 250000)}` : ""}`;
      },
      compress: compressExecResult,
    });

    // ── Filesystem ──
    tools.set("file_write", {
      def: {
        name: "file_write",
        description: "Write content to a file in the sandbox. Creates parent directories. Use absolute paths like /home/gem/script.py.",
        parameters: { type: "object", properties: {
          file: { type: "string", description: "Absolute file path (e.g. /home/gem/hn.py)." },
          content: { type: "string", description: "Full file content." },
          append: { type: "boolean", description: "Append instead of overwrite (default false)." },
        }, required: ["file", "content"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await sb("v1/file/write", { file: str(args.file), content: str(args.content), append: !!args.append });
        // (the run loop's logging executor already records this call with full args)
        return `File written: ${str(args.file)} (${d.bytes_written ?? str(args.content).length} bytes)`;
      },
    });

    tools.set("file_read", {
      def: {
        name: "file_read",
        description: "Read a file from the sandbox filesystem.",
        parameters: { type: "object", properties: {
          file: { type: "string", description: "Absolute file path to read." },
        }, required: ["file"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await sb("v1/file/read", { file: str(args.file) });
        return String(d.content ?? "").slice(0, 250000);
      },
      compress: (result, maxChars) => compressHeadTail(result, maxChars, 0.5),
    });

    tools.set("file_edit", {
      def: {
        name: "file_edit",
        description: "Edit a file: replace exact text (old_str → new_str). The old_str must match exactly once.",
        parameters: { type: "object", properties: {
          file: { type: "string", description: "Absolute file path." },
          old_str: { type: "string", description: "Exact text to find." },
          new_str: { type: "string", description: "Replacement text." },
        }, required: ["file", "old_str", "new_str"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await sb("v1/file/replace", { file: str(args.file), old_str: str(args.old_str), new_str: str(args.new_str) });
        return `File edited: ${str(args.file)}. ${JSON.stringify(d).slice(0, 500)}`;
      },
    });

    tools.set("list_files", {
      def: {
        name: "list_files",
        description: "List files and directories in a sandbox path.",
        parameters: { type: "object", properties: {
          path: { type: "string", description: "Directory path (default /home/gem)." },
          recursive: { type: "boolean", description: "List recursively (default false)." },
        }, additionalProperties: false },
      },
      run: async (args) => {
        const d = await sb("v1/file/list", { path: str(args.path) || "/home/gem", recursive: !!args.recursive, include_size: true });
        return JSON.stringify(d).slice(0, 8000);
      },
    });

    tools.set("file_search", {
      def: {
        name: "file_search",
        description: "Search files: by name glob (glob param) or by content (grep param).",
        parameters: { type: "object", properties: {
          path: { type: "string", description: "Directory to search (default /home/gem)." },
          glob: { type: "string", description: "Filename glob, e.g. **/*.py" },
          grep: { type: "string", description: "Text/regex to find inside files." },
        }, additionalProperties: false },
      },
      run: async (args) => {
        const p = str(args.path) || "/home/gem";
        if (str(args.grep)) {
          const d = await sb("v1/file/grep", { path: p, pattern: str(args.grep), max_results: 50 });
          return JSON.stringify(d).slice(0, 8000);
        }
        const d = await sb("v1/file/find", { path: p, glob: str(args.glob) || "*" });
        return JSON.stringify(d).slice(0, 8000);
      },
    });

    // ── Sandbox browser (Chromium) ──
    tools.set("sandbox_browser", {
      def: {
        name: "sandbox_browser",
        description: "Control the sandbox's real Chromium browser. Actions: " +
          "navigate (open url), screenshot (capture page), get_markdown (page as markdown), get_text (visible text), get_html (raw html), " +
          "click (selector), fill (selector+value), type (selector+value), press_key (value=key), hover (selector), select_option (selector+value), " +
          "check/uncheck (selector), scroll (value=up|down), find_text (value), evaluate (value=JS expression), wait (selector), " +
          "back, forward, reload, get_elements (selector), get_console, tabs_list.",
        parameters: { type: "object", properties: {
          action: { type: "string", description: "Browser action (see list)." },
          url: { type: "string", description: "URL for navigate." },
          selector: { type: "string", description: "CSS selector." },
          value: { type: "string", description: "Value for fill/type/select/press_key/scroll/find_text/evaluate." },
        }, required: ["action"], additionalProperties: false },
      },
      run: async (args) => {
        const a = str(args.action);
        const sel = str(args.selector);
        const val = str(args.value);
        const routes: Record<string, { path: string; body?: any }> = {
          navigate: { path: "v1/browser/page/navigate", body: { url: str(args.url), wait_until: "load" } },
          screenshot: { path: "v1/browser/screenshot", body: { full_page: false } },
          get_markdown: { path: "v1/browser/page/markdown", body: {} },
          get_text: { path: "v1/browser/page/text", body: {} },
          get_html: { path: "v1/browser/page/html", body: {} },
          get_elements: { path: "v1/browser/page/elements", body: { selector: sel || "a" } },
          get_console: { path: "v1/browser/page/console", body: {} },
          click: { path: "v1/browser/page/click", body: { selector: sel } },
          fill: { path: "v1/browser/page/fill", body: { selector: sel, value: val } },
          type: { path: "v1/browser/page/type", body: { selector: sel, text: val } },
          press_key: { path: "v1/browser/page/press_key", body: { key: val } },
          hover: { path: "v1/browser/page/hover", body: { selector: sel } },
          select_option: { path: "v1/browser/page/select_option", body: { selector: sel, value: val } },
          check: { path: "v1/browser/page/check", body: { selector: sel } },
          uncheck: { path: "v1/browser/page/uncheck", body: { selector: sel } },
          scroll: { path: "v1/browser/page/scroll", body: { direction: val || "down" } },
          find_text: { path: "v1/browser/page/find_text", body: { text: val } },
          evaluate: { path: "v1/browser/page/evaluate", body: { expression: val } },
          wait: { path: "v1/browser/page/wait", body: { selector: sel, timeout: 5000 } },
          back: { path: "v1/browser/page/back", body: {} },
          forward: { path: "v1/browser/page/forward", body: {} },
          reload: { path: "v1/browser/page/reload", body: {} },
          tabs_list: { path: "v1/browser/tabs", body: {} },
        };
        const r = routes[a];
        if (!r) return `ERROR: unknown action "${a}". Available: ${Object.keys(routes).join(", ")}`;
        const d = await sb(r.path, r.body);
        if (ctx.logEvent) {
          const kind = a === "screenshot" ? "browser_screenshot" : a === "navigate" ? "browser_navigate" : "browser_action";
          await ctx.logEvent(kind, { action: a, url: args.url, selector: sel });
        }
        if (a === "screenshot") return `Screenshot captured (base64 length: ${(d.image ?? d.screenshot ?? "").length}). Current URL: ${d.url ?? "?"}`;
        return JSON.stringify(d).slice(0, 10000);
      },
    });

    // ── Environment / packages ──
    tools.set("sandbox_env", {
      def: {
        name: "sandbox_env",
        description: "Inspect the sandbox environment. Actions: info (system context), python_packages, nodejs_packages, to_markdown (convert a URL or file to markdown).",
        parameters: { type: "object", properties: {
          action: { type: "string", enum: ["info", "python_packages", "nodejs_packages", "to_markdown"], description: "What to inspect." },
          input: { type: "string", description: "URL or file path (for to_markdown)." },
        }, required: ["action"], additionalProperties: false },
      },
      run: async (args) => {
        const a = str(args.action);
        if (a === "info") return JSON.stringify(await sb("v1/sandbox", {})).slice(0, 4000);
        if (a === "python_packages") return JSON.stringify(await sb("v1/sandbox/packages/python", {})).slice(0, 8000);
        if (a === "nodejs_packages") return JSON.stringify(await sb("v1/sandbox/packages/nodejs", {})).slice(0, 8000);
        if (a === "to_markdown") {
          const d = await sb("v1/util/convert_to_markdown", { url: str(args.input) });
          return String(d.markdown ?? d.content ?? "").slice(0, 10000);
        }
        return "ERROR: unknown action.";
      },
    });

    // ── Security testing repeater (authorized scope only) ──
    // Crafts an arbitrary HTTP request (any method/headers/body) and runs it
    // FROM the sandbox — contained network, realistic origin — via a one-shot
    // python. Gated: the target host must be in the workspace's authorized
    // pentest scope, else it refuses. This is the "repeater" web pentest relies
    // on; recon/scanners still go through shell_exec (nmap, ffuf, sqlmap…).
    tools.set("http_request", {
      def: {
        name: "http_request",
        description: "Security-testing HTTP client (a 'repeater'): send a crafted request with ANY method, headers and body to an AUTHORIZED target, and inspect the full response (status, headers, body). Use it to probe endpoints, test injection/auth/IDOR/SSRF, replay & mutate requests. Only works on targets in the workspace's authorized pentest scope (check pentest_scope first). Runs from the sandbox network.",
        parameters: { type: "object", properties: {
          url: { type: "string", description: "Absolute target URL (must be within the authorized scope)." },
          method: { type: "string", description: "HTTP method (GET, POST, PUT, DELETE, PATCH, …). Default GET." },
          headers: { type: "object", description: "Request headers as a JSON object." },
          body: { type: "string", description: "Raw request body (for POST/PUT/PATCH)." },
          follow_redirects: { type: "boolean", description: "Follow redirects (default false — you usually want to SEE the 30x)." },
          timeout: { type: "number", description: "Timeout in seconds (default 20, max 60)." },
        }, required: ["url"], additionalProperties: false },
      },
      run: async (args) => {
        const url = str(args.url).trim();
        if (!/^https?:\/\//i.test(url)) return "ERROR: url must be an absolute http(s) URL.";
        const scope = await loadPentestScope(ctx);
        if (!scope.length) return "ERROR: no authorized pentest scope is defined for this project — active testing is disabled. Ask an owner/admin to declare & attest an authorized scope (targets they own or may test). See pentest_scope.";
        const chk = hostInScope(url, scope);
        if (!chk.ok) return `ERROR: target host "${chk.host ?? "?"}" is NOT in the authorized pentest scope. Refusing. Call pentest_scope to see allowed targets; ask a human to authorize this host before testing it.`;
        const method = (str(args.method) || "GET").toUpperCase().replace(/[^A-Z]/g, "") || "GET";
        const headers = args.headers && typeof args.headers === "object" ? args.headers as Record<string, unknown> : {};
        const body = args.body != null ? String(args.body) : null;
        const follow = args.follow_redirects === true;
        const timeout = Math.min(Math.max(Number(args.timeout) || 20, 1), 60);
        // One-shot python (requests) in the sandbox — reliable arbitrary requests.
        const py = [
          "import json,sys,requests",
          `url=${JSON.stringify(url)}`,
          `method=${JSON.stringify(method)}`,
          `headers=${JSON.stringify(headers)}`,
          `data=${JSON.stringify(body)}`,
          `try:`,
          `    r=requests.request(method,url,headers=headers,data=(data.encode() if data else None),allow_redirects=${follow ? "True" : "False"},timeout=${timeout},verify=False)`,
          `    b=r.text[:12000]`,
          `    out={'status':r.status_code,'reason':r.reason,'headers':dict(r.headers),'history':[h.status_code for h in r.history],'body':b,'len':len(r.content)}`,
          `    print(json.dumps(out))`,
          `except Exception as e:`,
          `    print(json.dumps({'error':str(e)[:500]}))`,
        ].join("\n");
        try {
          const d = await sb("v1/code/execute", { language: "python", code: `import warnings;warnings.filterwarnings('ignore')\n${py}`, stateful: false });
          const raw = String(d.stdout ?? d.output ?? "").trim();
          const parsed = (() => { try { return JSON.parse(raw.split("\n").filter(Boolean).pop() || "{}"); } catch { return null; } })();
          if (!parsed) return `HTTP request ran but output wasn't parseable:\n${raw.slice(0, 2000)}${d.stderr ? `\n[stderr] ${String(d.stderr).slice(0, 500)}` : ""}`;
          if (parsed.error) return `Request error: ${parsed.error}`;
          const hdrs = Object.entries(parsed.headers ?? {}).slice(0, 40).map(([k, v]) => `${k}: ${v}`).join("\n");
          return `${method} ${url}\n→ ${parsed.status} ${parsed.reason ?? ""}${parsed.history?.length ? ` (redirects: ${parsed.history.join("→")})` : ""} · ${parsed.len} bytes\n\n--- response headers ---\n${hdrs}\n\n--- body (truncated) ---\n${String(parsed.body ?? "").slice(0, 10000)}`;
        } catch (e) {
          return `ERROR running request in sandbox: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    });

    summaryLines.push("- shell_exec: run shell commands (pip/npm install, git, scripts, curl, any command).");
    summaryLines.push("- python_exec / nodejs_exec / jupyter_exec: execute code (stateful Python, Node.js, Jupyter for data analysis).");
    summaryLines.push("- file_write / file_read / file_edit / list_files / file_search: full filesystem (write, read, edit, list, glob/grep).");
    summaryLines.push("- sandbox_browser: drive a real Chromium browser (navigate, screenshot, get_markdown, click, fill, evaluate JS, 25+ actions).");
    summaryLines.push("- sandbox_env: environment info, installed packages, URL→markdown conversion.");
    summaryLines.push("- http_request: security-testing HTTP repeater (any method/headers/body) — AUTHORIZED scope only, runs from the sandbox.");
    sandboxGuidance.push("  SECURITY TESTING: only test targets returned by pentest_scope. Recon/scanners run via shell_exec (nmap, ffuf, sqlmap, nuclei, whatweb…); craft & replay individual requests with http_request. Prefer non-destructive proofs; validate every finding with a concrete PoC before reporting it.");
    sandboxGuidance.push("  SANDBOX DISCIPLINE — use the sandbox ONLY when the task actually needs it: running code, reading/writing files, installing packages, fetching or processing data, or building/testing something. For greetings, simple questions, explanations, advice, opinions or planning, ANSWER DIRECTLY from your own knowledge and do NOT call any sandbox / shell / python / file tool. Don't 'check the sandbox' by reflex. When the work genuinely requires it: save files with file_write, run code with python_exec or shell_exec — and never claim you 'can't access the filesystem' (you can).");
    sandboxGuidance.push("  EFFICIENCY: the python_exec kernel can RESET between calls (state is lost), so do NOT split one analysis into many tiny python_exec calls that each re-import and re-read the data — that wastes huge amounts of tokens. For any multi-step pipeline (load → analyse → model → save), write ONE self-contained script with file_write and run it with shell_exec \"python3 script.py\", saving intermediate results (CSV/JSON/pickle) to disk. Re-use those files instead of recomputing.");
    sandboxGuidance.push("  VERIFY BACKGROUND PROCESSES: after launching anything with `nohup … &` (a server, a Gradio app), you MUST read its log (e.g. `cat gradio.log`) to confirm it actually started — never assume success. If the log shows a traceback/error, FIX the script and relaunch before continuing. For a web app: a 'public URL' only counts if the log printed it AND a test request to it succeeds. Gradio `demo.launch(share=True)` prints a *.gradio.live URL; avoid version-specific kwargs (e.g. show_copy_button) that crash on launch.");
  }
  // Hybrid: namespace the sandbox's tools (sandbox_*) so they coexist with the runner's.
  prefixNewTools(beforeSandbox, "sandbox_");

  // Hybrid orchestration note — surfaced FIRST under the EXECUTION family so the
  // agent understands it owns two worlds and how to pick between them.
  if (ctx.hybrid) {
    const runnerUp = ctx.runnerEnabled && !!runnerUrl;
    const sandboxUp = !!ctx.sandboxUrl;
    const bothUp = runnerUp && sandboxUp;
    sandboxGuidance.unshift(
      "  TWO EXECUTION WORLDS (HYBRID) — you have BOTH worlds at once, and you choose one PER TASK:\n" +
      "   • RUNNER (runner_* tools: runner_shell_exec, runner_python_exec, runner_nodejs_exec, runner_file_*, runner_run_background, runner_browse_web, runner_machine_info…) — the operator's REAL machine with a PERSISTENT per-agent workspace, a real Playwright browser and long-running processes. Use it for: work on the real project/repo, dev servers & watchers, anything that must persist across runs, and real-browser automation.\n" +
      "   • SANDBOX (sandbox_* tools: sandbox_shell_exec, sandbox_python_exec, sandbox_jupyter_exec, sandbox_file_*, sandbox_browser…) — a DISPOSABLE, isolated Linux container with a stateful Jupyter kernel and Chromium. Use it for: risky or untrusted code, throwaway data crunching, and anything you want isolated from the real machine.\n" +
      "   HOW TO CHOOSE: your execution plan tags each step with a recommended world — follow it unless a result forces a change. When unsure, prefer the RUNNER for real/persistent work and the SANDBOX for isolated/experimental work.\n" +
      "   CRITICAL — NO CROSS-WORLD FILES: the runner and the sandbox have SEPARATE filesystems. Files written in one are NOT visible in the other. Keep an entire pipeline (write → run → read → save) inside ONE world; only switch worlds at a clean boundary and re-materialise anything you need." +
      (bothUp ? "" : `\n   AVAILABILITY THIS RUN: ${runnerUp ? "runner UP" : "runner DOWN (runner_* tools unavailable)"}, ${sandboxUp ? "sandbox UP" : "sandbox DOWN (sandbox_* tools unavailable)"} — use only the world whose tools are listed above.`),
    );
  }

  // -------------------------------------------------------------------------
  // MCP servers: expose each attached server's discovered (cached) tools as
  // namespaced mcp_<server>_<tool> tools. Execution is a JSON-RPC tools/call to
  // the remote server, done here (the edge is server-side). Sessions are cached
  // per run so several calls share one handshake.
  // -------------------------------------------------------------------------
  if (ctx.mcpServers && ctx.mcpServers.length) {
    const mcpNames: string[] = [];
    for (const server of ctx.mcpServers) {
      const serverSlug = (server.name || server.id).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || server.id.slice(0, 8);
      for (const t of server.tools ?? []) {
        if (!t?.name) continue;
        const toolName = `mcp_${serverSlug}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60);
        if (tools.has(toolName)) continue;
        const schema = t.inputSchema && typeof t.inputSchema === "object" && (t.inputSchema as { type?: unknown }).type === "object"
          ? t.inputSchema as ToolDef["function"]["parameters"]
          : { type: "object", properties: {}, additionalProperties: true } as ToolDef["function"]["parameters"];
        tools.set(toolName, {
          family: "INTEGRATIONS",
          // A remote server's schema is a contract we don't own and can't
          // regenerate — never rewrite it.
          incompressible: true,
          def: {
            name: toolName,
            description: `[MCP · ${server.name}] ${t.description || t.name}`.slice(0, 1000),
            parameters: schema,
          },
          run: async (args) => {
            if (!ctx.mcpSessions) ctx.mcpSessions = new Map();
            let sess = ctx.mcpSessions.get(server.id);
            if (!sess) { sess = {}; ctx.mcpSessions.set(server.id, sess); }
            return await mcpCallTool(server.url, server.headers ?? {}, t.name, args, sess);
          },
        });
        mcpNames.push(toolName);
      }
    }
    if (mcpNames.length) {
      summaryLines.push(`- MCP tools (${mcpNames.length}) from connected servers: ${ctx.mcpServers.map((s) => s.name).join(", ")} — external capabilities exposed as mcp_* tools; call them like any other tool.`);
    }
  }

  // -------------------------------------------------------------------------
  // Collaboration: discover, message and delegate to peer agents + team memory.
  // -------------------------------------------------------------------------
  if (ctx.collaborationEnabled !== false) {
    tools.set("list_team_agents", {
      def: {
        name: "list_team_agents",
        description:
          "L'annuaire des autres agents de l'entreprise : leur rôle, leurs compétences, LEUR SERVICE, et s'ils acceptent du travail venu du tien. " +
          "Par défaut tu vois d'abord ton propre service (ce sont tes collègues directs), puis les autres. " +
          "Retourne les ids à utiliser avec send_message_to_agent et delegate_mission.",
        parameters: {
          type: "object",
          properties: {
            scope: {
              type: "string", enum: ["service", "company"],
              description: "'service' = seulement ton équipe · 'company' = toute l'entreprise (défaut).",
            },
            query: { type: "string", description: "Filtre optionnel sur le nom, le rôle ou les compétences." },
          },
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const scope = str(args.scope) === "service" ? "service" : "company";
        const all = ctx.admin
          .from("internal_agents")
          .select("id, name, role, skills, description, service_dashboard_id, parent_agent_id")
          .eq("project_id", ctx.projectId)
          .eq("is_archived", false)
          .eq("collaboration_enabled", true)
          .neq("id", ctx.agentId);
        // Le filtre de portée s'applique avant `.limit()` : passé la limite, le
        // builder Supabase n'expose plus `.eq()` / `.is()`.
        const scoped = scope !== "service" ? all
          : ctx.serviceDashboardId ? all.eq("service_dashboard_id", ctx.serviceDashboardId)
          : all.is("service_dashboard_id", null);
        const { data } = await scoped.limit(40);
        const rows = (data ?? []) as Array<{
          id: string; name: string; role: string | null; skills: string[] | null;
          description: string | null; service_dashboard_id: string | null; parent_agent_id: string | null;
        }>;
        if (rows.length === 0) {
          return scope === "service"
            ? "Aucun autre agent dans ton service. Rappelle list_team_agents avec scope=\"company\" pour voir le reste de l'entreprise."
            : "Aucun autre agent collaboratif dans cette entreprise pour l'instant.";
        }

        // Le service de chacun, et sa politique de collaboration (0213) : un
        // agent qui découvre un pair sans savoir si son service accepte du
        // travail extérieur délègue à l'aveugle et se prend un refus.
        const { data: dashes } = await ctx.admin
          .from("service_dashboards")
          .select("id, name, mission, collaboration")
          .eq("project_id", ctx.projectId);
        const byId = new Map(
          ((dashes ?? []) as Array<{ id: string; name: string; mission: string | null; collaboration: string }>)
            .map((d) => [d.id, d]),
        );

        const needle = str(args.query).trim().toLowerCase();
        const described = rows
          .map((a) => {
            const d = a.service_dashboard_id ? byId.get(a.service_dashboard_id) : null;
            const same = !!ctx.serviceDashboardId && a.service_dashboard_id === ctx.serviceDashboardId;
            return {
              id: a.id,
              name: a.name,
              role: a.role,
              skills: a.skills ?? [],
              description: a.description,
              service: d?.name ?? "(hors service)",
              service_mission: d?.mission ?? null,
              same_service: same,
              // Ce que ça CHANGE pour l'appelant, pas le code brut de la
              // politique : "open" ne dit rien à un modèle, "tu peux déléguer"
              // se comprend sans commentaire.
              can_delegate: same ? "oui (même service)"
                : d?.collaboration === "closed" ? "non — ce service ne prend que du travail interne"
                : d?.collaboration === "on_request" ? "oui, mais la délégation passera en approbation humaine"
                : "oui",
            };
          })
          .filter((a) => !needle ||
            `${a.name} ${a.role ?? ""} ${a.skills.join(" ")} ${a.description ?? ""} ${a.service}`
              .toLowerCase().includes(needle))
          // Ses collègues d'abord : c'est vers eux qu'un agent doit se tourner
          // en premier, et une liste qui commence par un autre service invite
          // à traverser une frontière sans raison.
          .sort((a, b) => Number(b.same_service) - Number(a.same_service));

        return JSON.stringify(described);
      },
    });

    tools.set("send_message_to_agent", {
      def: {
        name: "send_message_to_agent",
        description:
          "Send a message to another team agent (ask a question, share info, request help). The recipient reacts autonomously and may reply — their reply arrives back as a message you'll see in a later turn or session. Use list_team_agents to get agent ids.",
        parameters: {
          type: "object",
          properties: {
            to_agent_id: { type: "string", description: "Recipient agent id (uuid)." },
            content: { type: "string", description: "Your message." },
            topic: { type: "string", description: "Optional short topic for the thread." },
          },
          required: ["to_agent_id", "content"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const to = str(args.to_agent_id);
        const content = str(args.content).trim();
        if (!to || !content) return "ERROR: to_agent_id and content are required.";
        if (to === ctx.agentId) return "ERROR: you cannot message yourself.";
        // Recipient must be a collaborating agent in the same project.
        const { data: peer } = await ctx.admin
          .from("internal_agents")
          .select("id, name, collaboration_enabled, is_archived, service_dashboard_id")
          .eq("id", to)
          .eq("project_id", ctx.projectId)
          .maybeSingle();
        if (!peer || (peer as any).is_archived || (peer as any).collaboration_enabled === false) {
          return "ERROR: recipient is not a collaborating agent on this project.";
        }
        // Poser une QUESTION à un autre service reste libre — c'est déléguer du
        // travail qui se gouverne (voir delegate_mission). On se contente donc
        // de tracer la frontière franchie, pour que l'échange inter-services
        // soit relisible (0213).
        const peerDash = (peer as { service_dashboard_id?: string | null }).service_dashboard_id ?? null;
        const crossService = !!ctx.serviceDashboardId && peerDash !== ctx.serviceDashboardId;
        const threadId = await getOrCreateThread(ctx, to);
        if (str(args.topic)) {
          await ctx.admin.from("internal_agent_a2a_threads")
            .update({ topic: str(args.topic).slice(0, 120), updated_at: new Date().toISOString() })
            .eq("id", threadId);
        }
        const { data: msg, error } = await ctx.admin
          .from("internal_agent_a2a_messages")
          .insert({
            thread_id: threadId,
            workspace_id: ctx.workspaceId,
            project_id: ctx.projectId,
            from_agent: ctx.agentId,
            to_agent: to,
            content: content.slice(0, 4000),
            from_dashboard_id: ctx.serviceDashboardId ?? null,
            to_dashboard_id: peerDash,
            cross_service: crossService,
          })
          .select("id")
          .single();
        if (error) return `ERROR: ${error.message}`;
        await triggerA2A((msg as { id: string }).id);
        return `Message envoyé à ${(peer as { name: string }).name}${crossService ? " (autre service — l'échange est tracé)" : ""}. Il réagira de lui-même ; sa réponse arrivera dans ton fil A2A.`;
      },
    });

    tools.set("delegate_mission", {
      def: {
        name: "delegate_mission",
        description:
          "Delegate a task to a better-suited team agent by creating a mission they own. Use when another agent's skills fit the work better than yours. The mission runs on their side; ask them to report back if you need the result.",
        parameters: {
          type: "object",
          properties: {
            to_agent_id: { type: "string", description: "Agent to delegate to (uuid)." },
            title: { type: "string", description: "Mission title." },
            brief: { type: "string", description: "Detailed task description." },
            report_back: { type: "boolean", description: "If true, the assignee mirrors its final report back to you (default true)." },
          },
          required: ["to_agent_id", "title", "brief"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const to = str(args.to_agent_id);
        const title = str(args.title).trim().slice(0, 160);
        const brief = str(args.brief).trim();
        if (!to || !title || !brief) return "ERROR: to_agent_id, title and brief are required.";
        if (to === ctx.agentId) return "ERROR: you cannot delegate to yourself.";
        const { data: peer } = await ctx.admin
          .from("internal_agents")
          .select("id, name, collaboration_enabled, is_archived, project_id, workspace_id, service_dashboard_id")
          .eq("id", to)
          .eq("project_id", ctx.projectId)
          .maybeSingle();
        if (!peer || (peer as any).is_archived || (peer as any).collaboration_enabled === false) {
          return "ERROR: recipient is not a collaborating agent on this project.";
        }

        // ── La frontière de service (0213) ────────────────────────────────
        // Déléguer DANS son service est une affaire d'équipe. Déléguer À un
        // autre service engage une équipe qui n'a pas choisi ce travail : c'est
        // le service destinataire qui décide s'il l'accepte, pas l'agent
        // émetteur. Trois positions, et pas une de plus (voir 0213).
        const peerDash = (peer as { service_dashboard_id?: string | null }).service_dashboard_id ?? null;
        const crossService = !!ctx.serviceDashboardId && peerDash !== ctx.serviceDashboardId;
        let needsHuman = false;
        if (crossService && peerDash) {
          const { data: dash } = await ctx.admin
            .from("service_dashboards").select("name, collaboration").eq("id", peerDash).maybeSingle();
          const policy = (dash as { collaboration?: string } | null)?.collaboration ?? "open";
          const dashName = (dash as { name?: string } | null)?.name ?? "cet autre service";
          if (policy === "closed") {
            return `ERROR: le service « ${dashName} » ne prend que du travail interne. ` +
              `Tu peux lui POSER une question avec send_message_to_agent, ou déposer l'idée avec propose_mission — mais pas lui imposer une mission.`;
          }
          needsHuman = policy === "on_request";
        }
        // Anti-loop: delegation steps down the chain (was previously NOT
        // propagated — a delegated agent could delegate forever) + shared
        // per-run budget and hourly flood cap.
        const childDepth = (ctx.delegationDepth ?? 0) + 1;
        if (childDepth > MAX_DELEGATION_DEPTH) {
          return `ERROR: delegation depth limit (${MAX_DELEGATION_DEPTH}) reached — cannot delegate further. Do this work yourself or report back instead.`;
        }
        const guard = await missionCreationGuard(ctx);
        if (guard) return guard;
        const reportBack = args.report_back !== false;
        const { data: mission, error } = await ctx.admin
          .from("internal_agent_missions")
          .insert({
            agent_id: to,
            workspace_id: ctx.workspaceId,
            project_id: ctx.projectId,
            title,
            brief,
            // Un service en "on_request" reçoit la mission dans son backlog,
            // pas dans son exécution : elle existe, elle est visible, elle ne
            // démarre que quand un humain de CE service la lance.
            status: needsHuman ? "paused" : "active",
            board_column: needsHuman ? "backlog" : "todo",
            priority: "high",
            delegation_depth: childDepth,
            delegated_by_agent: ctx.agentId,
            report_back_to_agent: reportBack ? ctx.agentId : null,
          })
          .select("id")
          .single();
        if (error) return `ERROR: ${error.message}`;
        if (needsHuman) {
          await ctx.logEvent("status", {
            message: `📨 Mission « ${title} » déposée chez ${(peer as { name: string }).name} (autre service) — en attente d'un feu vert humain.`,
          }).catch(() => {});
          return `Mission « ${title} » DÉPOSÉE dans le backlog de ${(peer as { name: string }).name}. ` +
            `Son service demande une validation humaine pour le travail venu d'ailleurs : elle ne démarrera pas toute seule. ` +
            `N'attends pas son résultat dans ce run — signale-le dans ton rapport et continue avec ce que tu peux faire toi-même.`;
        }
        // Launch the delegated mission immediately (fire-and-forget run).
        const { data: run } = await ctx.admin
          .from("internal_agent_runs")
          .insert({
            mission_id: (mission as { id: string }).id,
            agent_id: to,
            workspace_id: ctx.workspaceId,
            project_id: ctx.projectId,
            status: "queued",
            triggered_via: "api",
          })
          .select("id")
          .single();
        if (run) {
          const base = Deno.env.get("SUPABASE_URL");
          const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
          if (base && key) {
            fetch(`${base}/functions/v1/internal-agent-run`, {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({ agent_id: to, mode: "mission", run_id: (run as { id: string }).id }),
            }).catch(() => {});
          }
        }
        return `Mission « ${title} » déléguée à ${(peer as { name: string }).name}${crossService ? " (autre service)" : ""} et démarrée.${reportBack ? " Il te fera son retour." : ""}`;
      },
    });

    tools.set("team_memory", {
      def: {
        name: "team_memory",
        description:
          "La connaissance partagée, à DEUX portées (0213). " +
          "'service' = ce qui vaut pour ton équipe (ses conventions, ses interlocuteurs, ses pièges). " +
          "'company' = ce qui vaut pour TOUTE l'entreprise (une décision, un positionnement, une règle qu'aucun service ne peut ignorer). " +
          "Cherche AVANT de demander à un pair ; écris quand tu apprends quelque chose que d'autres re-découvriraient sinon. " +
          "Choisis la portée honnêtement : une note de ton service publiée en 'company' encombre le contexte de tous les autres agents, et une décision d'entreprise rangée en 'service' ne sera jamais lue par ceux qu'elle engage.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["search", "add"], description: "search the pool or add to it." },
            scope: {
              type: "string", enum: ["service", "company", "all"],
              description:
                "Pour 'add' : où ranger (défaut 'service' si tu appartiens à un service, sinon 'company'). " +
                "Pour 'search' : où chercher — 'all' inclut la mémoire des AUTRES services (défaut : entreprise + ton service).",
            },
            query: { type: "string", description: "Search keywords (for action=search)." },
            content: { type: "string", description: "The knowledge to record (for action=add)." },
            kind: { type: "string", enum: ["fact", "preference", "learning", "context", "decision"], description: "Type (for add; default fact)." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const action = str(args.action);
        const askedScope = str(args.scope);
        const mine = ctx.serviceDashboardId ?? null;

        if (action === "add") {
          const content = str(args.content).trim().slice(0, 600);
          if (!content) return "ERROR: content is required to add team memory.";
          const kind = ["fact", "preference", "learning", "context", "decision"].includes(str(args.kind)) ? str(args.kind) : "fact";
          // Défaut prudent : ce qu'on apprend appartient à son équipe jusqu'à
          // preuve du contraire. Publier vers toute l'entreprise est un choix
          // qu'on fait, pas un défaut qu'on subit.
          const toCompany = askedScope === "company" || !mine;
          const { error } = await ctx.admin.from("internal_agent_team_memories").insert({
            workspace_id: ctx.workspaceId,
            project_id: ctx.projectId,
            service_dashboard_id: toCompany ? null : mine,
            kind,
            content,
            author_agent: ctx.agentId,
            source: "agent",
          });
          if (error) return `ERROR: ${error.message}`;
          return toCompany
            ? `Enregistré en mémoire d'ENTREPRISE (${kind}) — tous les agents, tous services confondus, le verront.`
            : `Enregistré en mémoire de SERVICE (${kind}) — les agents de ton service le verront. Repasse en scope="company" si ça engage toute l'entreprise.`;
        }

        // search — les filtres AVANT les tris et la limite : passé `.limit()`,
        // le builder Supabase n'expose plus `.eq()` / `.is()`.
        const query = str(args.query).trim();
        type Row = { kind: string; content: string; importance: number; created_at: string; service_dashboard_id: string | null };
        const pick = (where: "company" | "service" | "any", limit: number) => {
          const filtered = ctx.admin
            .from("internal_agent_team_memories")
            .select("kind, content, importance, created_at, service_dashboard_id")
            .eq("project_id", ctx.projectId);
          const scoped = where === "company" ? filtered.is("service_dashboard_id", null)
            : where === "service" ? filtered.eq("service_dashboard_id", mine!)
            : filtered;
          const searched = query ? scoped.ilike("content", `%${query.slice(0, 60)}%`) : scoped;
          return searched
            .order("is_pinned", { ascending: false })
            .order("importance", { ascending: false })
            .limit(limit);
        };

        let rows: Row[];
        if (askedScope === "all") {
          const { data } = await pick("any", 20);
          rows = (data ?? []) as Row[];
        } else if (askedScope === "company" || !mine) {
          const { data } = await pick("company", 12);
          rows = (data ?? []) as Row[];
        } else if (askedScope === "service") {
          const { data } = await pick("service", 12);
          rows = (data ?? []) as Row[];
        } else {
          // Défaut : ce qui te concerne — l'entreprise et ton service.
          const [a, b] = await Promise.all([pick("company", 8), pick("service", 8)]);
          rows = [...((a.data ?? []) as Row[]), ...((b.data ?? []) as Row[])];
        }
        if (rows.length === 0) {
          return query
            ? `Rien en mémoire partagée sur « ${query} »${askedScope === "all" ? "" : " dans ta portée — réessaie avec scope=\"all\" pour inclure les autres services"}.`
            : "La mémoire partagée est vide.";
        }
        return JSON.stringify(rows.map((m) => ({
          scope: m.service_dashboard_id ? (m.service_dashboard_id === mine ? "service" : "autre service") : "entreprise",
          kind: m.kind, content: m.content, importance: m.importance, created_at: m.created_at,
        })));
      },
    });

    summaryLines.push(
      "- list_team_agents / send_message_to_agent / delegate_mission : collaborer, dans ton service comme avec les autres — l'annuaire dit qui accepte du travail venu d'ailleurs.",
      "- team_memory : la connaissance partagée, à deux portées (service / entreprise). Cherche avant de demander ; écris avec la bonne portée.",
    );
  }

  if (hasKind("web_search")) {
    tools.set("web_search", {
      def: {
        name: "web_search",
        description: "Search the web for fresh, public information. Returns titles, URLs and snippets.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            max_results: { type: "number", description: "Max results (default 5, max 8)." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      run: (args) => {
        const query = str(args.query);
        if (!query) return Promise.resolve("ERROR: query is required.");
        const max = Math.min(Math.max(Number(args.max_results ?? 5) || 5, 1), 8);
        return webSearch(query, max);
      },
      // web_search returns structured JSON; keep it PARSEABLE under the cap by
      // dropping whole trailing results (never a mid-JSON cut).
      compress: (result, maxChars) => {
        if (result.length <= maxChars) return result;
        try {
          const parsed = JSON.parse(result);
          if (parsed && Array.isArray(parsed.results)) {
            let kept = parsed.results;
            while (kept.length > 1 && JSON.stringify({ ...parsed, results: kept }).length > maxChars) {
              kept = kept.slice(0, kept.length - 1);
            }
            return JSON.stringify({ ...parsed, results: kept, truncated: parsed.results.length - kept.length });
          }
        } catch { /* not JSON — fall through */ }
        return compressHeadTail(result, maxChars, 0.5);
      },
    });
    summaryLines.push("- web_search: search the public web.");
  }

  if (hasKind("web_fetch")) {
    tools.set("read_url", {
      def: {
        name: "read_url",
        description: "Fetch a public web page and return its main text content as markdown.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "Absolute http(s) URL." } },
          required: ["url"],
          additionalProperties: false,
        },
      },
      run: (args) => readUrl(str(args.url)),
      compress: (result, maxChars) => compressHeadTail(result, maxChars, 0.4),
    });
    summaryLines.push("- read_url: read the content of a specific URL.");
  }

  if (hasKind("rag_search")) {
    // Activated RAG Center collections, gathered from each rag_search row's
    // config.collection_ids. Empty → fall back to project-wide RAG-agent search.
    const collectionIds = [
      ...new Set(
        enabled
          .filter((r) => r.kind === "rag_search")
          .flatMap((r) => {
            const ids = (r.config as { collection_ids?: unknown })?.collection_ids;
            return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
          }),
      ),
    ];
    tools.set("search_knowledge", {
      def: {
        name: "search_knowledge",
        description: collectionIds.length > 0
          ? "Semantic search across the knowledge collections activated on this agent."
          : "Semantic search across the project's indexed knowledge base (uploaded docs, notes).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural-language query." },
            limit: { type: "number", description: "Max results (default 5, max 10)." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      run: (args) => {
        const query = str(args.query);
        if (!query) return Promise.resolve("ERROR: query is required.");
        const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 10);
        return searchKnowledge(ctx, query, limit, collectionIds);
      },
    });
    summaryLines.push(collectionIds.length > 0
      ? `- search_knowledge: search ${collectionIds.length} activated knowledge collection(s).`
      : "- search_knowledge: search the project's internal knowledge base.");
  }

  if (hasKind("db_read")) {
    // Union of every db_read row's allowlist.
    const allowedTables = [
      ...new Set(
        enabled
          .filter((r) => r.kind === "db_read")
          .flatMap((r) => (Array.isArray(r.config?.tables) ? (r.config.tables as string[]) : []))
          .filter((t) => typeof t === "string" && /^[a-zA-Z0-9_]+$/.test(t)),
      ),
    ];
    tools.set("query_table", {
      def: {
        name: "query_table",
        description: `Read rows from an allowed project table (read-only). Allowed tables: ${allowedTables.join(", ") || "(none configured — ask the user to configure the Read project DB tool)"}.`,
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "Table name (must be in the allowed list)." },
            columns: { type: "string", description: 'Comma-separated columns (default "*").' },
            filters: { type: "object", description: "Optional equality filters, e.g. {\"status\":\"active\"}." },
            order_by: { type: "string", description: "Optional column to sort by." },
            descending: { type: "boolean", description: "Sort descending (default true when order_by is set)." },
            limit: { type: "number", description: "Max rows (default 25, max 100)." },
          },
          required: ["table"],
          additionalProperties: false,
        },
      },
      run: (args) => queryTable(ctx, allowedTables, args),
    });
    summaryLines.push(`- query_table: read project data from: ${allowedTables.join(", ") || "(not configured)"}.`);
  }

  if (hasKind("vault_connector")) {
    tools.set("list_connectors", {
      def: {
        name: "list_connectors",
        description: "List the project's connected integrations (provider, status, permissions). No secrets.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      run: () => listConnectors(ctx),
    });
    summaryLines.push("- list_connectors: inventory of connected integrations.");
  }

  // connector_action rows: one tool per provider that exposes safe actions
  // (CRM / HR). The agent picks an action + params; the connector-action edge
  // function decrypts the credential and calls the official API.
  for (const row of enabled.filter((r) => r.kind === "connector_action")) {
    const provider = str(row.config?.provider);
    const actions = CONNECTOR_ACTIONS[provider];
    if (!provider || !actions || actions.length === 0) continue;
    const toolName = slugToToolName("use", provider);
    const writeNames = new Set(actions.filter((a) => a.write).map((a) => a.name));
    const actionList = actions.map((a) => `${a.name}${a.write ? " [write]" : ""} (${a.description})`).join("; ");
    const hasWrite = writeNames.size > 0;
    tools.set(toolName, {
      // The action catalogue IS this tool's contract: truncate it and the model
      // invents action names that the connector rejects. The names additionally
      // go into a real JSON-schema `enum` — never rewritten by compaction, and
      // enforced by the provider's constrained decoding.
      incompressible: true,
      family: "INTEGRATIONS",
      def: {
        name: toolName,
        description:
          `Work with ${provider}. Available actions: ${actionList}. Pass the action name and its params.` +
          (hasWrite && !ctx.autopilot
            ? " Actions marked [write] send/create data and are queued for human approval before running."
            : ""),
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: actions.map((a) => a.name),
              description: "The action to run (see the tool description for what each one does).",
            },
            params: { type: "object", description: "Action parameters (see the action's description)." },
            reason: { type: "string", description: "One-sentence justification (used for write actions)." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const action = str(args.action);
        const params = (args.params && typeof args.params === "object") ? args.params : {};
        // Write actions need human approval unless the agent is on autopilot.
        if (writeNames.has(action) && !ctx.autopilot) {
          return await awaitInlineApproval(ctx, {
            tool_name: toolName,
            action_kind: "connector_action",
            payload: { provider, action, params },
            reason: str(args.reason) || null,
          }, `${provider} · ${action}`);
        }
        const base = Deno.env.get("SUPABASE_URL");
        const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (!base || !key) return "ERROR: connector actions are not configured.";
        const res = await fetch(`${base}/functions/v1/connector-action`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: ctx.workspaceId, project_id: ctx.projectId,
            provider, action, params,
          }),
        });
        return cap(`HTTP ${res.status}\n${await res.text()}`, 8000);
      },
    });
    summaryLines.push(`- ${toolName}: act on ${provider} (${actions.map((a) => a.name).join(", ")}).`);
  }

  // composio_toolkit rows: same shape as connector_action above, but backed by
  // a Composio-connected toolkit instead of the in-house action catalogue —
  // the agent picks a Composio tool slug + arguments; the composio-action
  // edge function resolves the connected account and calls Composio's API.
  // buildInternalToolset is synchronous, so — unlike connector_action, whose
  // fixed action list is known at build time — discovery happens lazily at
  // call time (action omitted → composio-action lists the toolkit's tools).
  for (const row of enabled.filter((r) => r.kind === "composio_toolkit")) {
    const toolkit = str(row.config?.toolkit);
    if (!toolkit) continue;
    const toolName = slugToToolName("use", toolkit);
    tools.set(toolName, {
      // Short, but every clause is operative: the discover-then-call protocol and
      // the reads-run-directly rule. Truncated at 140 chars both were lost, which
      // is why the agent kept announcing approvals for simple lookups.
      incompressible: true,
      family: "INTEGRATIONS",
      def: {
        name: toolName,
        description:
          `Work with ${toolkit} (via Composio). Call with no "action" first to list its available ` +
          `tool slugs, then call again with the chosen action and its arguments.` +
          (!ctx.autopilot ? " Read actions (fetch/list/get/search) run DIRECTLY — no approval. Only write/send/delete actions ask for a quick inline approval (the user can also approve the whole toolkit at once), so don't warn about approval for reads." : ""),
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", description: "A Composio tool slug (e.g. GITHUB_CREATE_AN_ISSUE). Omit to discover available slugs." },
            params: { type: "object", description: "Arguments for the tool (see its description from discovery)." },
            reason: { type: "string", description: "One-sentence justification (used for approval)." },
            use_personal_account: {
              type: "boolean",
              description:
                "Act through the OWNER'S OWN connected account instead of this workspace's shared one. Set it ONLY when the point of the call is to reach that person personally (e.g. notify them on their own mailbox). Fails if they haven't connected their own account here.",
            },
          },
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const action = str(args.action);
        const params = (args.params && typeof args.params === "object") ? args.params : {};
        // Connection scope (migration 0177): the dashboard's shared account by
        // default, the user's own only when the model explicitly asks for it.
        const asUserId = args.use_personal_account === true ? (ctx.userId ?? null) : null;
        const scopeBody = {
          service_dashboard_id: ctx.serviceDashboardId ?? null,
          ...(asUserId ? { as_user_id: asUserId } : {}),
        };
        const base = Deno.env.get("SUPABASE_URL");
        const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (!base || !key) return "ERROR: composio actions are not configured.";
        // Discovery (no action) is read-only — runs directly, never gated.
        if (!action) {
          const res = await fetch(`${base}/functions/v1/composio-action`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ workspace_id: ctx.workspaceId, project_id: ctx.projectId, toolkit, ...scopeBody }),
          });
          return cap(`HTTP ${res.status}\n${await res.text()}`, 8000);
        }
        // Only WRITE / delete / send actions need approval — reads (fetch, list,
        // get, search…) run directly so simple lookups never nag the user.
        if (!ctx.autopilot && isWriteAction(action)) {
          return await awaitInlineApproval(ctx, {
            tool_name: toolName,
            action_kind: "composio_action",
            // The scope travels with the approval so the action executes through
            // the SAME account the user approved, not whatever resolves later.
            payload: { toolkit, tool_slug: action, params, ...scopeBody },
            reason: str(args.reason) || null,
          }, `${toolkit} · ${action}${asUserId ? " (compte personnel)" : ""}`);
        }
        const res = await fetch(`${base}/functions/v1/composio-action`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: ctx.workspaceId, project_id: ctx.projectId,
            toolkit, tool_slug: action, arguments: params, ...scopeBody,
          }),
        });
        return cap(`HTTP ${res.status}\n${await res.text()}`, 8000);
      },
    });
    summaryLines.push(`- ${toolName}: act on ${toolkit} via Composio.`);
  }

  // crm rows: read + write the in-house CRM (contacts, deals, companies, …).
  // One tool with an action discriminator, same shape as connector_action.
  // Reads (list_objects/search_records/get_record) run directly; writes
  // (create/update/delete_record) are queued for human approval unless the
  // agent is on autopilot — same safe default as the other write tools.
  if (hasKind("crm")) {
    const CRM_WRITE = new Set(["create_record", "update_record", "delete_record", "link_records", "unlink_records"]);
    tools.set("crm", {
      def: {
        name: "crm",
        description:
          "Read and write the in-house CRM. Start with action=list_objects to discover the record " +
          "types (contacts, deals, …), their fields, and which fields are RELATIONS (relation_to names the " +
          "linked object). Then: search_records/get_record to read; create_record/update_record/delete_record " +
          "to write; link_records/unlink_records/get_related to connect records (e.g. attach a contact to a deal)." +
          (!ctx.autopilot ? " Write actions are queued for human approval before running." : ""),
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "One of: list_objects, search_records, get_record, get_related, create_record, update_record, delete_record, link_records, unlink_records.",
            },
            params: {
              type: "object",
              description:
                "Action params. search_records: {object: slug, query?, limit?}. get_record/delete_record: {record_id}. " +
                "create_record: {object: slug, fields: {property_key: value}}. update_record: {record_id, fields: {property_key: value}}. " +
                "get_related: {record_id, property?} (property = a relation field key from list_objects). " +
                "link_records/unlink_records: {from_record_id, to_record_id, property} (property = the relation field on the FROM record's object).",
            },
            reason: { type: "string", description: "One-sentence justification (used for write approvals)." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const action = str(args.action);
        const params = (args.params && typeof args.params === "object") ? args.params : {};
        if (CRM_WRITE.has(action) && !ctx.autopilot) {
          return await awaitInlineApproval(ctx, {
            tool_name: "crm",
            action_kind: "crm_write",
            payload: { action, params },
            reason: str(args.reason) || null,
          }, `CRM · ${action}`);
        }
        const base = Deno.env.get("SUPABASE_URL");
        const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (!base || !key) return "ERROR: CRM actions are not configured.";
        const res = await fetch(`${base}/functions/v1/crm-action`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ workspace_id: ctx.workspaceId, project_id: ctx.projectId, action, params }),
        });
        return cap(`HTTP ${res.status}\n${await res.text()}`, 8000);
      },
    });
    summaryLines.push("- crm: read/write the in-house CRM (contacts, deals, …) and link related records.");
  }

  // ── Suivi de travail ──────────────────────────────────────────────────
  //
  // C'est ce qui fait passer un agent de « quelqu'un à qui on parle » à
  // « quelqu'un qui travaille dans l'outil » : il voit le board, s'y assigne
  // du travail, avance les états et rend compte au même endroit que tout le
  // monde. Sans cet outil, tout ce qu'un agent produit reste dans un fil de
  // conversation que personne ne relit.
  //
  // Deux garde-fous, et ils ne sont pas négociables.
  //
  //  · LE PÉRIMÈTRE. L'agent ne voit que les projets où on l'a mis
  //    (`pj_project_agents`). Une table vide veut dire « aucun projet » et non
  //    « tous » : le défaut le plus fermé, parce qu'un agent de support n'a
  //    rien à faire dans le backlog de l'infrastructure.
  //  · L'APPROBATION. Les lectures sont libres, les écritures passent par la
  //    file d'approbation tant que l'autopilote n'est pas armé. Le découpage
  //    suit celui du reste du produit — lire ne change rien, écrire engage.
  if (hasKind("tracker")) {
    const READS = new Set([
      "list_projects", "list_work_items", "get_work_item", "my_work",
      "list_cycles", "list_modules", "list_states", "search",
    ]);

    /** Les projets où cet agent a le droit d'agir, et son rôle sur chacun. */
    const scope = async (): Promise<Map<string, string>> => {
      const { data } = await ctx.admin
        .from("pj_project_agents")
        .select("pj_project_id, role")
        .eq("agent_id", ctx.agentId);
      return new Map(
        ((data ?? []) as Array<{ pj_project_id: string; role: string }>)
          .map((r) => [r.pj_project_id, r.role]),
      );
    };

    /**
     * Le compte rendu d'avancement sur SON PROPRE work item passe sans
     * approbation.
     *
     * Toute écriture du suivi attend normalement qu'une personne valide. C'est
     * juste pour une action qu'un agent décide seul ; c'est absurde pour la
     * seule chose qu'on attend de lui en fin de tâche. Un agent planifié qui
     * travaille la nuit sur un item et doit attendre le matin qu'on approuve
     * « passer en terminé » n'est pas autonome : il est suspendu.
     *
     * L'exception est ÉTROITE, et chaque borne compte :
     *
     *   · l'item doit être CELUI QUE SERT LA MISSION en cours (pj_issue_id).
     *     La personne a déjà autorisé exactement ce périmètre en assignant
     *     l'agent, en l'ouvrant en écriture sur le projet, puis en armant l'item
     *     ou en lançant la mission. Un autre item, même du même projet, repasse
     *     par l'approbation ;
     *   · seuls l'ÉTAT et le COMMENTAIRE sont concernés. Renommer l'item, en
     *     réécrire la description, changer sa priorité ou ses dates, c'est
     *     modifier la commande, pas en rendre compte — ça reste validé ;
     *   · hors mission (conversation, run manuel sans work item), rien ne
     *     change : il n'y a pas d'item « à soi ».
     *
     * La résolution run → mission → item est mémorisée : l'agent appelle
     * l'outil plusieurs fois par run, et la réponse ne change pas en cours de
     * route.
     */
    let ownIssue: Promise<string | null> | null = null;
    const missionIssueId = (): Promise<string | null> => {
      ownIssue ??= (async () => {
        if (!ctx.runId) return null;
        const { data: run } = await ctx.admin.from("internal_agent_runs")
          .select("mission_id").eq("id", ctx.runId).maybeSingle();
        const missionId = (run as { mission_id?: string | null } | null)?.mission_id;
        if (!missionId) return null;
        const { data: m } = await ctx.admin.from("internal_agent_missions")
          .select("pj_issue_id").eq("id", missionId).maybeSingle();
        return (m as { pj_issue_id?: string | null } | null)?.pj_issue_id ?? null;
      })();
      return ownIssue;
    };

    const PROGRESS_FIELDS = new Set(["issue_id", "state_id", "state_group"]);
    const isOwnProgressReport = async (
      action: string, params: Record<string, unknown>,
    ): Promise<boolean> => {
      if (action !== "update_work_item" && action !== "comment") return false;
      const target = str(params.issue_id);
      if (!target) return false;
      if (action === "update_work_item"
        && Object.keys(params).some((k) => !PROGRESS_FIELDS.has(k))) {
        return false;
      }
      const own = await missionIssueId();
      return !!own && own === target;
    };

    tools.set("tracker", {
      def: {
        name: "tracker",
        description:
          "Le suivi de travail : projets, work items, cycles, modules. Commence TOUJOURS par " +
          "action=list_projects pour savoir sur quoi tu as le droit d'agir — tu n'as accès qu'aux " +
          "projets où on t'a explicitement mis. Puis my_work pour ce qui t'est assigné, " +
          "list_work_items/get_work_item pour lire, create_work_item/update_work_item/comment/" +
          "assign_self pour agir. Tu peux aussi ORGANISER le travail, pas seulement l'exécuter : " +
          "break_down découpe un sujet en sous-tâches, plan_work_item le range dans un cycle, des " +
          "modules, sous un parent et lui pose des dates, create_cycle et create_module ouvrent les " +
          "cadres qui manquent." +
          (!ctx.autopilot ? " Les écritures sont soumises à approbation humaine avant de partir." : ""),
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "list_projects", "my_work", "list_work_items", "get_work_item", "search",
                "list_states", "list_cycles", "list_modules",
                "create_work_item", "update_work_item", "comment", "assign_self", "unassign_self",
                "break_down", "plan_work_item", "create_cycle", "create_module",
              ],
              description: "L'opération. Tout ce qui suit list_modules écrit.",
            },
            params: {
              type: "object",
              description:
                "list_work_items: {project_id, state_group?, priority?, assigned_to_me?, limit?}. " +
                "get_work_item: {issue_id}. search: {query, limit?}. " +
                "list_states/list_cycles/list_modules: {project_id}. " +
                "create_work_item: {project_id, name, description?, priority?, state_id?, target_date?}. " +
                "update_work_item: {issue_id, name?, description?, priority?, state_id?, state_group?, start_date?, target_date?} — " +
                "state_group vaut backlog|unstarted|started|completed|cancelled et évite de chercher l'identifiant de l'état. " +
                "Faire avancer l'état ou commenter LE work item de ta mission ne demande pas d'approbation. " +
                "comment: {issue_id, body}. assign_self/unassign_self: {issue_id}. " +
                "break_down: {issue_id, titles: [string]} — crée les sous-items d'un coup. " +
                "plan_work_item: {issue_id, cycle_id?, module_ids?: [string], parent_id?, start_date?, target_date?} " +
                "(chaîne vide = retirer). create_cycle: {project_id, name, description?, start_date?, end_date?}. " +
                "create_module: {project_id, name, description?, status?, start_date?, target_date?}.",
            },
            reason: {
              type: "string",
              description: "Une phrase qui dit POURQUOI. Montrée telle quelle à qui approuve.",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const action = str(args.action);
        const params = (args.params && typeof args.params === "object")
          ? args.params as Record<string, unknown>
          : {};

        const allowed = await trackerScope(ctx);
        if (allowed.size === 0) {
          return "Aucun projet ne t'est ouvert dans le suivi de travail. Demande qu'on t'ajoute "
            + "à un projet (réglages du projet → agents) avant d'utiliser cet outil.";
        }

        // Le périmètre est vérifié AVANT l'approbation : faire approuver une
        // action qui sera de toute façon refusée fait perdre son temps à la
        // personne qui approuve, et lui apprend à approuver sans lire.
        const pid = str(params.project_id);
        if (pid && !allowed.has(pid)) {
          return `ERREUR : le projet ${pid} n'est pas dans ton périmètre. Utilise list_projects.`;
        }

        if (!READS.has(action)) {
          const role = pid ? allowed.get(pid) : null;
          if (role === "observer") {
            return "ERREUR : tu es observateur sur ce projet, tu peux lire mais pas écrire.";
          }
          if (!ctx.autopilot && !(await isOwnProgressReport(action, params))) {
            return await awaitInlineApproval(ctx, {
              tool_name: "tracker",
              action_kind: "tracker_write",
              payload: { action, params, agent_id: ctx.agentId },
              reason: str(args.reason) || null,
            }, `Suivi · ${action}`);
          }
        }

        return await runTrackerAction(ctx, action, params, allowed);
      },
    });

    summaryLines.push(
      "- tracker: lire, faire avancer ET organiser le suivi de travail (projets, work items, cycles, modules) "
      + "sur les seuls projets où tu es rattaché.",
    );
  }

  // security_scan rows: defensive + consented active scanning.
  if (hasKind("security_scan")) {
    tools.set("security_scan", {
      def: {
        name: "security_scan",
        description:
          "Run a security scan on an AUTHORISED target. Passive types (headers, tls, exposure) run instantly and are non-destructive. " +
          "Active types (port_scan, surface, full) require recorded consent and run via the runner — they detect/prove exposure but never exploit. " +
          "If an active scan is blocked, tell the user to register the target and confirm consent first.",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", description: "Domain or URL to scan (must be owned/authorised)." },
            scan_type: { type: "string", description: "headers | tls | exposure (passive) | port_scan | surface | full (active, consent required)." },
          },
          required: ["target", "scan_type"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const base = Deno.env.get("SUPABASE_URL");
        const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (!base || !key) return "ERROR: security scanning is not configured.";
        const res = await fetch(`${base}/functions/v1/security-scan`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ workspace_id: ctx.workspaceId, project_id: ctx.projectId, target: str(args.target), scan_type: str(args.scan_type) }),
        });
        return cap(`HTTP ${res.status}\n${await res.text()}`, 8000);
      },
    });
    summaryLines.push("- security_scan: defensive checks + consented active scans (no exploitation).");
  }

  // vibe_code rows: the engine behind the Vibe Code studio agent. It drives the
  // existing `vibe-code` function (the very same one the retired module used),
  // so coding sessions, memory and PR plumbing are shared — the agent replaces
  // the UI, not the engine. Which actions it may take is per-agent config.
  for (const row of enabled.filter((r) => r.kind === "vibe_code")) {
    const cfg = row.config ?? {};
    const configured = Array.isArray(cfg.actions) ? (cfg.actions as unknown[]).map((a) => str(a)) : [];
    const allowed = new Set(
      (configured.length ? configured : ["run", "apply", "pr_status", "fix_pr"])
        .filter((a) => VIBE_ACTIONS.includes(a)),
    );
    allowed.add("status"); // reading a running session is never gated
    const pinnedRepo = str(cfg.repository_id) || null;

    // Session state carried across calls WITHIN a run: the model asks for a
    // change, then applies it, without re-sending whole file contents.
    let sessionId: string | null = null;
    let staged: Array<{ path: string; content: string }> = [];
    let stagedBranch: string | null = null;
    let lastMessageId: string | null = null;
    let repoId: string | null = pinnedRepo;

    const resolveRepo = async (wanted: string): Promise<{ id: string; full_name: string } | string> => {
      const { data: repos } = await ctx.admin
        .from("repositories").select("id, full_name").eq("project_id", ctx.projectId);
      const list = (repos ?? []) as Array<{ id: string; full_name: string }>;
      if (!list.length) return "ERROR: no repository is connected to this project. Connect one first.";
      if (wanted) {
        const hit = list.find((r) => r.id === wanted || r.full_name.toLowerCase() === wanted.toLowerCase()
          || r.full_name.split("/")[1]?.toLowerCase() === wanted.toLowerCase());
        if (!hit) return `ERROR: repository "${wanted}" not found. Available: ${list.map((r) => r.full_name).join(", ")}`;
        return hit;
      }
      if (list.length === 1) return list[0];
      return `ERROR: several repositories exist — pass "repository". Available: ${list.map((r) => r.full_name).join(", ")}`;
    };

    // The engine answers immediately and finishes in the background, writing
    // progress onto the assistant vibe_messages row — so we poll that row
    // rather than holding an HTTP call open for minutes.
    const waitForSession = async (messageId: string): Promise<string> => {
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        if (await ctx.isCancelled()) return "Run cancelled by a human — the coding session was left running.";
        await new Promise((r) => setTimeout(r, 5000));
        const { data } = await ctx.admin
          .from("vibe_messages").select("content, meta").eq("id", messageId).maybeSingle();
        const meta = ((data as { meta?: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>;
        const status = str(meta.status);
        if (status === "failed") return `Coding session FAILED: ${str(meta.error) || "unknown error"}`;
        if (status === "done") {
          const result = (meta.result ?? {}) as Record<string, unknown>;
          const changes = (Array.isArray(result.changes) ? result.changes : []) as Array<{ path: string; content: string }>;
          staged = changes;
          stagedBranch = str(result.base_branch) || null;
          const steps = (Array.isArray(result.steps) ? result.steps : []) as Array<{ t: string; label: string }>;
          const files = changes.map((c) => `  - ${c.path} (${c.content.split("\n").length} lines)`).join("\n");
          return cap(
            `Coding session finished on branch ${stagedBranch ?? "?"}.\n` +
            `${str((data as { content?: string } | null)?.content) || str(result.message)}\n\n` +
            (changes.length
              ? `STAGED FILES (not pushed yet — call action="apply" to open the PR):\n${files}`
              : "No file was modified.") +
            (steps.length ? `\n\nSteps: ${steps.map((s) => `${s.t}:${s.label}`).join(" · ")}` : ""),
            7000,
          );
        }
      }
      return `The coding session is still running (session ${sessionId ?? "?"}). Call vibe_code(action="status") later to collect the result — do NOT start another run.`;
    };

    const callEngine = (payload: Record<string, unknown>) =>
      invokeEdgeFunction("vibe-code", {
        workspace_id: ctx.workspaceId, project_id: ctx.projectId,
        acting_user_id: ctx.userId ?? null, ...payload,
      });

    tools.set("vibe_code", {
      def: {
        name: "vibe_code",
        description:
          "Write real code on a connected GitHub repository and ship it as a pull request. " +
          `Allowed actions: ${[...allowed].join(", ")}. ` +
          "run = start a coding session from a precise prompt (returns the staged diff); " +
          "apply = open the PR with the files staged by the last run; " +
          "pr_status = read a PR's CI/review state; fix_pr = push a fix for failing CI; " +
          "merge_pr = merge; status = collect a session that was still running." +
          (row.requires_approval ? " Write actions REQUIRE HUMAN APPROVAL before they execute." : ""),
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: [...allowed], description: "What to do." },
            prompt: { type: "string", description: "For run: the change to make — files involved, expected behaviour, acceptance criteria." },
            repository: { type: "string", description: "Repository full name (owner/repo) or id. Omit when the project has only one." },
            branch: { type: "string", description: "Base branch for run/apply, or the PR head branch for fix_pr." },
            title: { type: "string", description: "For apply: the pull request title." },
            body: { type: "string", description: "For apply: the pull request description." },
            pr_number: { type: "number", description: "For pr_status / fix_pr / merge_pr." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const action = str(args.action);
        if (!allowed.has(action)) {
          return `ERROR: action "${action}" is not enabled for this agent. Allowed: ${[...allowed].join(", ")}.`;
        }

        if (action === "status") {
          if (!lastMessageId) return "ERROR: no coding session has been started in this run.";
          return await waitForSession(lastMessageId);
        }

        if (!repoId) {
          const resolved = await resolveRepo(str(args.repository));
          if (typeof resolved === "string") return resolved;
          repoId = resolved.id;
        }

        // Write actions go through the same inline-approval path as every other
        // outgoing action, so "assisted" autonomy actually gates the PR.
        if (row.requires_approval && WRITE_VIBE_ACTIONS.has(action)) {
          return await awaitInlineApproval(ctx, {
            tool_name: "vibe_code",
            action_kind: "edge_function",
            payload: { slug: "vibe-code", args: { ...args, repository_id: repoId } },
            reason: str(args.title) || str(args.prompt) || null,
          }, row.name || "Vibe Code");
        }

        if (action === "run" || action === "fix_pr") {
          const prompt = str(args.prompt);
          if (action === "run" && !prompt) return "ERROR: prompt is required for a coding session.";
          const raw = await callEngine({
            repository_id: repoId, action, prompt: prompt || undefined,
            branch: str(args.branch) || undefined,
            pr_number: typeof args.pr_number === "number" ? args.pr_number : undefined,
            session_id: sessionId ?? undefined,
          });
          const parsed = parseEdgeJson(raw);
          if (!parsed) return raw;
          if (parsed.error) return `ERROR from the coding engine: ${str(parsed.error)}`;
          sessionId = str(parsed.session_id) || sessionId;
          lastMessageId = str(parsed.assistant_message_id) || null;
          if (!lastMessageId) return raw;
          return await waitForSession(lastMessageId);
        }

        if (action === "apply") {
          if (!staged.length) return "ERROR: nothing is staged — run a coding session first (action=\"run\").";
          const raw = await callEngine({
            repository_id: repoId, action: "apply",
            base_branch: str(args.branch) || stagedBranch || undefined,
            title: str(args.title) || "Vibe Code changes",
            body: str(args.body) || undefined,
            changes: staged,
          });
          return raw;
        }

        // pr_status / merge_pr — thin pass-through.
        return await callEngine({
          repository_id: repoId, action,
          pr_number: typeof args.pr_number === "number" ? args.pr_number : undefined,
          branch: str(args.branch) || undefined,
        });
      },
    });
    summaryLines.push(
      `- vibe_code: code on the project's repositories and open PRs (${[...allowed].join("/")})${row.requires_approval ? " — writes need approval" : ""}.`,
    );
  }

  // testing rows: the Testing studio agent's engine — the same
  // test-run-orchestrate + Playwright runner the retired Test runs module used.
  // The agent picks the scenario, launches it, follows the live steps and can
  // answer the runner when it gets stuck.
  for (const row of enabled.filter((r) => r.kind === "testing")) {
    const cfg = row.config ?? {};
    const pinnedSuite = str(cfg.suite_id) || null;

    let lastRunId: string | null = null;

    const waitForRun = async (runId: string): Promise<string> => {
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        if (await ctx.isCancelled()) return "Run cancelled by a human — the test run was left running.";
        await new Promise((r) => setTimeout(r, 5000));
        const { data: run } = await ctx.admin
          .from("test_runs")
          .select("status, result, error_message, pending_question, current_url, last_screenshot_url")
          .eq("id", runId).maybeSingle();
        const r = (run ?? {}) as Record<string, unknown>;
        const status = str(r.status);
        if (status === "needs_input") {
          return `The test is PAUSED and needs an answer: "${str(r.pending_question)}". ` +
            `Reply with testing(action="answer", run_id="${runId}", answer="…").`;
        }
        if (["passed", "failed", "error", "cancelled"].includes(status)) {
          const { data: steps } = await ctx.admin
            .from("test_run_steps").select("actor, kind, label")
            .eq("run_id", runId).order("idx", { ascending: true }).limit(60);
          const timeline = ((steps ?? []) as Array<{ actor: string; kind: string; label: string | null }>)
            .map((s) => `  ${s.kind}: ${s.label ?? ""}`).join("\n");
          const result = (r.result ?? {}) as Record<string, unknown>;
          return cap(
            `Test run ${status.toUpperCase()} (run ${runId}).\n` +
            (r.error_message ? `Error: ${str(r.error_message)}\n` : "") +
            (result.summary ? `Summary: ${str(result.summary)}\n` : "") +
            (r.last_screenshot_url ? `Last screenshot: ${str(r.last_screenshot_url)}\n` : "") +
            `\nTimeline:\n${timeline}`,
            7000,
          );
        }
      }
      return `The test run is still going (run ${runId}). Call testing(action="status", run_id="${runId}") later — do NOT start another run.`;
    };

    tools.set("testing", {
      def: {
        name: "testing",
        description:
          "Run real end-to-end tests against the app with the Playwright runner. " +
          "list = the available test cases; run = execute one and wait for the verdict; " +
          "status = collect a run still in progress; answer = unblock a run that is asking a question; " +
          "directive = send a new instruction to a run (even a finished one).",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "run", "status", "answer", "directive"] },
            case_id: { type: "string", description: "For run: the test case to execute (see action=\"list\")." },
            run_id: { type: "string", description: "For status/answer/directive." },
            answer: { type: "string", description: "For answer: what the runner should do / the information it asked for." },
            directive: { type: "string", description: "For directive: the new instruction." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const action = str(args.action);

        if (action === "list") {
          let q = ctx.admin.from("test_cases")
            .select("id, name, instructions, suite_id").eq("project_id", ctx.projectId).eq("enabled", true);
          if (pinnedSuite) q = q.eq("suite_id", pinnedSuite);
          const { data } = await q.limit(50);
          const cases = (data ?? []) as Array<{ id: string; name: string; instructions: string }>;
          if (!cases.length) return "No test case exists for this project yet.";
          return cases.map((c) => `- ${c.name} (id: ${c.id}) — ${c.instructions.slice(0, 140)}`).join("\n");
        }

        if (action === "run") {
          const caseId = str(args.case_id);
          if (!caseId) return "ERROR: case_id is required — call action=\"list\" first.";
          const raw = await invokeEdgeFunction("test-run-orchestrate", {
            action: "start", workspace_id: ctx.workspaceId, project_id: ctx.projectId,
            acting_user_id: ctx.userId ?? null, case_id: caseId,
          });
          const parsed = parseEdgeJson(raw);
          if (!parsed || parsed.error) return `ERROR from the test engine: ${parsed ? str(parsed.error) : raw}`;
          lastRunId = str(parsed.run_id) || null;
          if (!lastRunId) return raw;
          return await waitForRun(lastRunId);
        }

        if (action === "status") {
          const runId = str(args.run_id) || lastRunId;
          if (!runId) return "ERROR: no test run has been started in this run.";
          return await waitForRun(runId);
        }

        const runId = str(args.run_id) || lastRunId;
        if (!runId) return "ERROR: run_id is required.";
        const raw = await invokeEdgeFunction("test-run-orchestrate", {
          action, workspace_id: ctx.workspaceId, project_id: ctx.projectId,
          acting_user_id: ctx.userId ?? null, run_id: runId,
          answer: str(args.answer) || undefined, directive: str(args.directive) || undefined,
        });
        const parsed = parseEdgeJson(raw);
        if (parsed?.error) return `ERROR: ${str(parsed.error)}`;
        return await waitForRun(runId);
      },
    });
    summaryLines.push("- testing: run real end-to-end tests against the app and read the verdict.");
  }

  // simulation rows: the Simulations studio agent's engine. It creates the
  // population, then drives the rounds itself (the round action accepts a
  // service-role caller) instead of waiting for an external runner.
  for (const row of enabled.filter((r) => r.kind === "simulation")) {
    const cfg = row.config ?? {};
    const maxRounds = Math.min(Math.max(Number(cfg.max_rounds) || 6, 1), 12);
    let lastSimId: string | null = null;

    tools.set("simulation", {
      def: {
        name: "simulation",
        description:
          "Simulate how a realistic population reacts to an idea, a launch or a scenario. " +
          "run = build the population and play every round, then return the prediction report; " +
          "ask = put a question to one persona; status = read a simulation already created.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["run", "ask", "status"] },
            name: { type: "string", description: "For run: a short name for the simulation." },
            seed: { type: "string", description: "For run: the material to react to — the idea, the pitch, the change." },
            question: { type: "string", description: "For run: what you want predicted (e.g. 'will our SMB users churn?')." },
            persona_count: { type: "number", description: "Population size (default 12, max 40)." },
            rounds: { type: "number", description: `Rounds to play (default 6, max ${maxRounds}).` },
            persona_id: { type: "string", description: "For ask: which persona to question." },
            message: { type: "string", description: "For ask: the question." },
            simulation_id: { type: "string", description: "For status." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const action = str(args.action);
        const engine = (payload: Record<string, unknown>) =>
          invokeEdgeFunction("simulation-prepare", { acting_user_id: ctx.userId ?? null, ...payload });

        if (action === "ask") {
          if (!str(args.persona_id) || !str(args.message)) return "ERROR: persona_id and message are required.";
          return await engine({ action: "chat", persona_id: str(args.persona_id), message: str(args.message) });
        }

        if (action === "status") {
          const simId = str(args.simulation_id) || lastSimId;
          if (!simId) return "ERROR: no simulation has been created in this run.";
          const { data } = await ctx.admin
            .from("sim_simulations").select("name, status, current_round, total_rounds, report, error")
            .eq("id", simId).maybeSingle();
          if (!data) return "ERROR: simulation not found.";
          return cap(JSON.stringify(data), 7000);
        }

        const seed = str(args.seed);
        const question = str(args.question);
        if (!seed || !question) return "ERROR: seed and question are required to run a simulation.";
        const personaCount = Math.min(Math.max(Number(args.persona_count) || 12, 4), 40);
        const rounds = Math.min(Math.max(Number(args.rounds) || 6, 1), maxRounds);

        const { data: created, error: createErr } = await ctx.admin
          .from("sim_simulations").insert({
            workspace_id: ctx.workspaceId, project_id: ctx.projectId,
            name: str(args.name, "Simulation").slice(0, 80),
            seed_text: seed, question, persona_count: personaCount, total_rounds: rounds,
            status: "draft", created_by: ctx.userId ?? null,
          }).select("id").single();
        if (createErr || !created) return `ERROR: could not create the simulation (${createErr?.message ?? "unknown"}).`;
        lastSimId = (created as { id: string }).id;

        const prep = parseEdgeJson(await engine({ action: "prepare", simulation_id: lastSimId }));
        if (prep?.error) return `ERROR while building the population: ${str(prep.error)}`;

        // Play the rounds inline — each one is a single model call, and the
        // engine reports `done` when the population has run its course.
        for (let i = 0; i < rounds; i++) {
          if (await ctx.isCancelled()) return "Run cancelled by a human — the simulation was left unfinished.";
          const res = parseEdgeJson(await engine({ action: "round", simulation_id: lastSimId, runner_id: "agent" }));
          if (res?.error) return `ERROR at round ${i + 1}: ${str(res.error)}`;
          if (res?.done) break;
        }
        await engine({ action: "complete", simulation_id: lastSimId, status: "completed" });

        const { data: done } = await ctx.admin
          .from("sim_simulations").select("report, status, current_round").eq("id", lastSimId).maybeSingle();
        const report = (done as { report?: unknown } | null)?.report;
        return cap(
          `Simulation ${lastSimId} finished (${str((done as { status?: string } | null)?.status)}).\n` +
          `Prediction report:\n${report ? JSON.stringify(report) : "(no report produced)"}`,
          8000,
        );
      },
    });
    summaryLines.push("- simulation: simulate a population's reaction and return a prediction report.");
  }

  // edge_function rows: one tool per configured function.
  for (const row of enabled.filter((r) => r.kind === "edge_function")) {
    const slug = str(row.config?.slug);
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) continue;
    const toolName = slugToToolName("call", slug);
    tools.set(toolName, {
      def: {
        name: toolName,
        description:
          `${row.description || `Invoke the internal "${slug}" function.`}` +
          (row.requires_approval ? " REQUIRES HUMAN APPROVAL: the call is queued for review, not executed immediately." : ""),
        parameters: {
          type: "object",
          properties: {
            args: { type: "object", description: "JSON body to send to the function." },
            reason: { type: "string", description: "One-sentence justification for this action." },
          },
          required: ["args"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const fnArgs = (args.args && typeof args.args === "object" ? args.args : {}) as Record<string, unknown>;
        if (row.requires_approval) {
          return await awaitInlineApproval(ctx, {
            tool_name: toolName,
            action_kind: "edge_function",
            payload: { slug, args: fnArgs },
            reason: str(args.reason) || null,
          }, row.name || toolName);
        }
        return invokeEdgeFunction(slug, fnArgs);
      },
    });
    summaryLines.push(`- ${toolName}: ${row.description || `call the ${slug} function`}${row.requires_approval ? " (requires human approval)" : ""}.`);
  }

  // custom rows: webhook-backed tools with a model-facing JSON schema.
  for (const row of enabled.filter((r) => r.kind === "custom")) {
    const url = str(row.config?.webhook_url);
    if (!url) continue;
    const toolName = slugToToolName("tool", str(row.config?.tool_name) || row.name);
    const method = str(row.config?.method, "POST").toUpperCase();
    const headers = (row.config?.headers && typeof row.config.headers === "object"
      ? row.config.headers
      : {}) as Record<string, string>;
    const parameters =
      row.config?.parameters && typeof row.config.parameters === "object"
        ? (row.config.parameters as Record<string, unknown>)
        : {
            type: "object",
            properties: {
              args: { type: "object", description: "JSON payload to send." },
              reason: { type: "string", description: "One-sentence justification." },
            },
            required: ["args"],
            additionalProperties: false,
          };
    tools.set(toolName, {
      def: {
        name: toolName,
        description:
          `${row.description || row.name}` +
          (row.requires_approval ? " REQUIRES HUMAN APPROVAL: the call is queued for review, not executed immediately." : ""),
        parameters,
      },
      run: async (args) => {
        if (row.requires_approval) {
          return await awaitInlineApproval(ctx, {
            tool_name: toolName,
            action_kind: "webhook",
            payload: { url, method, headers, args },
            reason: str(args.reason) || null,
          }, row.name || toolName);
        }
        return invokeWebhook(url, method, args, headers);
      },
    });
    summaryLines.push(`- ${toolName}: ${row.description || row.name}${row.requires_approval ? " (requires human approval)" : ""}.`);
  }

  // ---------------------------------------------------------------------------
  // Context Engine wiring: one search tool, and progressive disclosure.
  // ---------------------------------------------------------------------------

  // ONE retrieval tool instead of four near-synonyms. search_history /
  // search_memory / search_past_work / search_knowledge stay EXECUTABLE (a model
  // that learned the old name still works, and nothing in prod breaks) but are
  // hidden from `defs` — so they stop costing four schemas and, more importantly,
  // stop making the model hesitate between four tools that all mean "look it up".
  const SEARCH_SCOPES: Record<string, { target: string; args?: Record<string, unknown> }> = {
    run: { target: "search_history" },
    agent: { target: "search_memory" },
    team: { target: "team_memory", args: { action: "search" } },
    past_runs: { target: "search_past_work" },
    kb: { target: "search_knowledge" },
  };
  const availableScopes = Object.entries(SEARCH_SCOPES)
    .filter(([, s]) => tools.has(s.target))
    .map(([scope]) => scope);
  if (availableScopes.length) {
    // Hide the pure-READ aliases only. team_memory also WRITES (action="add"),
    // so it stays advertised — folding it away would cost the agent its ability
    // to record shared knowledge.
    for (const name of ["search_history", "search_memory", "search_past_work", "search_knowledge"]) {
      const t = tools.get(name);
      if (t) t.hidden = true;
    }
    tools.set("search_context", {
      family: "MEMORY",
      incompressible: true,
      def: {
        name: "search_context",
        description:
          "Look something up instead of redoing work or re-asking. Pick the scope: " +
          "'run' = your earlier steps in THIS run (recover detail compacted out of context) · " +
          "'agent' = your persistent memory · 'team' = the shared team memory · " +
          "'past_runs' = deliverables and outputs of your PREVIOUS runs · " +
          "'kb' = the project knowledge base. When unsure, start with 'run'.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keyword, phrase, identifier, path or error string to find." },
            scope: { type: "string", enum: availableScopes, description: "Where to look." },
            limit: { type: "number", description: "Max results (default 8)." },
          },
          required: ["query", "scope"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        const scope = str(args.scope, "run");
        const spec = SEARCH_SCOPES[scope];
        const t = spec ? tools.get(spec.target) : undefined;
        if (!t) return `ERROR: unknown scope "${scope}". Available: ${availableScopes.join(", ")}.`;
        return await t.run({ ...args, ...(spec.args ?? {}) });
      },
    });
  }

  // Progressive disclosure of tool SCHEMAS. The capability tree in the system
  // prompt still lists every tool (one short line each — cheap), so the model
  // always knows what exists; only the full JSON schemas are lazy. Loading a
  // family takes effect on the NEXT round of the same tick (the run loop passes
  // `defs` as a thunk), so there is no lost turn.
  const loadedFamilies = new Set<ToolFamily>(
    (ctx.loadedFamilies ?? []).filter((f): f is ToolFamily => (FAMILY_ORDER as readonly string[]).includes(f)),
  );
  const familyOf = (name: string): ToolFamily => {
    const t = tools.get(name);
    if (t?.family) return t.family;
    const base = name.replace(/^(?:runner|sandbox)_/, "");
    return TOOL_FAMILY[name] ?? TOOL_FAMILY[base] ?? "INTEGRATIONS";
  };
  // Always present, whatever the tier: the agent must be able to plan, ask,
  // deliver, look things up and widen its own toolset.
  const CORE_TOOLS = new Set([
    "ask_user", "update_todos", "create_deliverable", "report_section", "request_report",
    "search_context", "load_toolset", "need_tools", "say", "use_skill", "read_skill_file",
    // Initiative must never cost a load_toolset round. propose_mission is the
    // ONLY safe channel for an agent to act on something it noticed (it files a
    // paused backlog item, it executes nothing) — behind a lazily-loaded family
    // it simply never got called, and the initiative died with it.
    "propose_mission",
  ]);
  // Families whose schemas ship by default: the ones that DO work, plus MEMORY
  // (tiny, and saving knowledge is opportunistic hygiene — it must never cost a
  // load_toolset round). The heavy families load on demand: DATA (allowlisted
  // tables), TEAM (missions/delegation) and INTEGRATIONS (connectors + one
  // schema per remote MCP tool, the real fan-out).
  const DEFAULT_FAMILIES: ToolFamily[] = ["EXECUTION", "WEB", "DELIVER", "PLAN", "MEMORY"];

  tools.set("load_toolset", {
    family: "PLAN",
    incompressible: true,
    def: {
      name: "load_toolset",
      description:
        "Load the full schemas of a tool family you need but whose tools aren't callable yet. " +
        "The toolbox in your system prompt lists every family and what's in it; a family marked " +
        "(à charger) must be loaded here before you can call its tools. Takes effect immediately — " +
        "call the tool you wanted right after.",
      parameters: {
        type: "object",
        properties: {
          family: { type: "string", enum: [...FAMILY_ORDER], description: "The family to load." },
        },
        required: ["family"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const fam = str(args.family).toUpperCase() as ToolFamily;
      if (!FAMILY_ORDER.includes(fam)) return `ERROR: unknown family "${fam}". One of: ${FAMILY_ORDER.join(", ")}.`;
      loadedFamilies.add(fam);
      await ctx.onToolsetLoaded?.(fam);
      const names = [...tools.entries()]
        .filter(([n, t]) => !t.hidden && familyOf(n) === fam)
        .map(([n]) => n);
      return names.length
        ? `Family ${fam} loaded — now callable: ${names.join(", ")}.`
        : `Family ${fam} is empty for this agent.`;
    },
  });

  // The `social` tier's single escape hatch: a greeting ships ~60 tokens of
  // schema instead of ~10 000, and the model can still escalate in one call
  // when the turn turns out to need real work.
  tools.set("need_tools", {
    family: "PLAN",
    incompressible: true,
    def: {
      name: "need_tools",
      description:
        "Call this the moment the request needs an ACTION (files, code, web, data, sending, integrations) " +
        "rather than a plain conversational reply. Your full toolbox is loaded immediately and you continue " +
        "in the same turn. Never apologise for lacking tools — call this instead.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "What you need to do, in one sentence." } },
        required: ["reason"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      for (const f of FAMILY_ORDER) loadedFamilies.add(f);
      await ctx.onToolsetLoaded?.("*");
      return `Full toolbox loaded (${str(args.reason) || "action required"}). Continue now — call the tool you need.`;
    },
  });

  const toDef = (t: InternalTool): ToolDef =>
    t.incompressible ? { type: "function", function: t.def, incompressible: true } : { type: "function", function: t.def };

  /** The tool schemas exposed for the CURRENT round. Re-evaluated every round by
   *  the run loop, so load_toolset / need_tools widen it without losing a turn. */
  const defsFor = (tier: ToolTier = "full"): ToolDef[] => {
    const visible = [...tools.entries()].filter(([, t]) => !t.hidden);
    if (tier === "social") {
      return visible.filter(([n]) => n === "need_tools" || n === "say").map(([, t]) => toDef(t));
    }
    if (tier === "full") return visible.map(([, t]) => toDef(t));
    // "core": core tools + the default working families + anything loaded since.
    return visible
      .filter(([n]) => CORE_TOOLS.has(n)
        || DEFAULT_FAMILIES.includes(familyOf(n))
        || loadedFamilies.has(familyOf(n)))
      .map(([, t]) => toDef(t));
  };

  const defs: ToolDef[] = defsFor("full");

  // NOTE: the executor does NOT log run events itself — the run loop's logging
  // wrapper (internal-agent-run) is the single source of tool_call/tool_result
  // events. Logging in both places was double-rendering every action in the UI.
  const executor: ToolExecutor = async (name, args) => {
    if (await ctx.isCancelled()) throw new RunCancelledError();
    const tool = tools.get(name);
    if (!tool) return `ERROR: unknown tool "${name}".`;
    try {
      const raw = await tool.run(args);
      // Per-tool compression contract: if the tool can overrun the transcript
      // cap, it shrinks its own output deterministically instead of letting the
      // generic middle-cut in ai.ts do it. No compress → the raw result flows
      // through unchanged and ai.ts's truncateMiddle stays as the fallback.
      return tool.compress ? tool.compress(raw, TOOL_RESULT_CAP) : raw;
    } catch (e) {
      if (e instanceof RunCancelledError || e instanceof AwaitingInputError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      return `ERROR: ${msg}`;
    }
  };

  return {
    defs,
    defsFor,
    executor,
    capabilitySummary: buildCapabilityTree(tools, sandboxGuidance, summaryLines, DEFAULT_FAMILIES, CORE_TOOLS),
  };
}

// ── Structured toolbox tree ───────────────────────────────────────────────────
// The system prompt's tool inventory, grouped by FAMILY in order of preference,
// with one usage rule per family. Replaces the old flat summaryLines dump —
// the flat list buried execution tools among meta-tools, which fed the
// "meta-work instead of real work" failure mode.
const FAMILY_ORDER = ["EXECUTION", "WEB", "DATA", "PLAN", "DELIVER", "MEMORY", "TEAM", "INTEGRATIONS"] as const;
type ToolFamily = (typeof FAMILY_ORDER)[number];
const FAMILY_META: Record<ToolFamily, { label: string; rule: string }> = {
  EXECUTION: { label: "EXECUTION — files, code, shell, browser", rule: "Your hands. REAL work happens here: create files, run commands, process data, build and test. Prefer these tools for any concrete task." },
  WEB: { label: "WEB — research & retrieval", rule: "Gather external information, then ACT on it with EXECUTION tools." },
  DATA: { label: "DATA — internal data & knowledge", rule: "Read project data and knowledge bases (read-only)." },
  PLAN: { label: "PLAN & PROGRESS", rule: "Keep your todo checklist current with update_todos (before AND after each step). Load skill playbooks on demand with use_skill." },
  DELIVER: { label: "DELIVERABLES", rule: "Persist each final output ONCE. Never call create_deliverable repeatedly for the same artifact." },
  MEMORY: { label: "MEMORY", rule: "Save a durable fact once; recall with search_memory. Memory records knowledge — it does not do work." },
  TEAM: { label: "TEAM & DELEGATION", rule: "STRICT: creating missions/messages is coordination, NOT execution. Never create a mission for yourself during a mission run. Max 2 delegations per run. When in doubt, do the work yourself with EXECUTION tools." },
  INTEGRATIONS: { label: "INTEGRATIONS & OTHER", rule: "Connectors, internal functions, custom webhooks — check each tool's description." },
};
const TOOL_FAMILY: Record<string, ToolFamily> = {
  shell_exec: "EXECUTION", python_exec: "EXECUTION", nodejs_exec: "EXECUTION", jupyter_exec: "EXECUTION",
  file_write: "EXECUTION", file_read: "EXECUTION", file_edit: "EXECUTION", list_files: "EXECUTION",
  file_search: "EXECUTION", sandbox_browser: "EXECUTION", sandbox_env: "EXECUTION", browse_web: "EXECUTION",
  machine_info: "EXECUTION", manage_files: "EXECUTION", download_file: "EXECUTION",
  run_background: "EXECUTION", list_processes: "EXECUTION", process_logs: "EXECUTION", process_stop: "EXECUTION",
  web_search: "WEB", read_url: "WEB", deep_research: "WEB", http_get: "WEB", http_request: "WEB",
  pentest_scope: "DATA",
  search_knowledge: "DATA", query_table: "DATA", list_connectors: "DATA",
  update_todos: "PLAN", use_skill: "PLAN", read_skill_file: "PLAN", ask_user: "PLAN",
  create_deliverable: "DELIVER", report_section: "DELIVER", render_ui: "DELIVER",
  // Artifacts are a DELIVER concern. Unmapped, they fell through to
  // INTEGRATIONS — a family that does NOT ship by default — so the tools
  // documented as "always available" needed a load_toolset round first, and
  // agents routinely concluded they couldn't produce a document at all.
  create_artifact: "DELIVER", list_artifacts: "DELIVER", read_artifact: "DELIVER", update_artifact: "DELIVER",
  // Same reason as the line above: buildCapabilityTree classifies by this map
  // alone, so the writing tools were being indexed under INTEGRATIONS — the one
  // family that does not ship by default. request_report is now the ONLY route
  // to a report, so an agent that cannot see it cannot produce one.
  add_block: "DELIVER", publish_artifact: "DELIVER", request_report: "DELIVER",
  save_memory: "MEMORY", search_memory: "MEMORY", team_memory: "MEMORY", search_past_work: "MEMORY",
  create_mission: "TEAM", delegate_mission: "TEAM", send_message_to_agent: "TEAM", list_team_agents: "TEAM",
  create_task: "TEAM", list_missions: "TEAM", move_mission: "TEAM", propose_mission: "TEAM", create_agent: "TEAM", create_workflow: "TEAM",
  send_email: "INTEGRATIONS", security_scan: "INTEGRATIONS",
};

function buildCapabilityTree(
  tools: Map<string, { def: { name: string; description: string }; hidden?: boolean; family?: ToolFamily } & Record<string, unknown>>,
  sandboxGuidance: string[],
  legacyLines: string[],
  defaultFamilies: ToolFamily[] = [...FAMILY_ORDER],
  coreTools: Set<string> = new Set(),
): string {
  const byFamily = new Map<ToolFamily, string[]>();
  for (const [name, t] of tools) {
    // Hidden aliases are executable but never advertised.
    if (t.hidden) continue;
    // Hybrid namespaces execution tools (runner_* / sandbox_*). Classify by the
    // exact name first, then fall back to the un-prefixed base (sandbox_browser /
    // sandbox_env keep their own entries via the exact-name hit).
    const base = name.replace(/^(?:runner|sandbox)_/, "");
    const fam = TOOL_FAMILY[name] ?? TOOL_FAMILY[base] ?? "INTEGRATIONS";
    // Short label only — the full schema is sent separately, so this stays a
    // scannable INDEX, not a duplicate of every tool's description.
    const firstSentence = (t.def.description ?? "").split(/(?<=\.)\s+/)[0] ?? "";
    const arr = byFamily.get(fam) ?? [];
    arr.push(`  - ${name}: ${firstSentence.slice(0, 90)}`);
    byFamily.set(fam, arr);
  }
  const out: string[] = [
    "# TOOLBOX — grouped by family, in order of preference",
    "RULE — PREFER EXECUTION TOOLS: real progress = files/commands/data/results, not meta-tools (missions, tasks, messages, memory) which only record or coordinate. Several meta-calls with no new result → switch to execution tools.",
    "",
  ];
  for (const fam of FAMILY_ORDER) {
    const lines = byFamily.get(fam);
    if (!lines?.length) continue;
    // Progressive disclosure: the INDEX is always complete (so the agent knows
    // what exists), but a family outside the default set ships without its JSON
    // schemas until load_toolset pulls them in. Say so explicitly — an agent that
    // doesn't know a tool is loadable will claim it can't do the job.
    const lazy = !defaultFamilies.includes(fam) && !lines.every((l) => coreTools.has(l.trim().split(":")[0].replace(/^-\s*/, "")));
    out.push(`## ${FAMILY_META[fam].label}${lazy ? ` — (à charger : load_toolset("${fam}") avant le premier appel)` : ""}`);
    out.push(`Rule: ${FAMILY_META[fam].rule}`);
    out.push(...lines);
    if (fam === "EXECUTION" && sandboxGuidance.length) out.push(...sandboxGuidance);
    out.push("");
  }
  // Legacy free-form guidance lines that aren't per-tool descriptions (kept for
  // notes like the activated-skills index).
  const extras = legacyLines.filter((l) => !l.startsWith("- "));
  if (extras.length) out.push(...extras);
  return out.join("\n");
}
