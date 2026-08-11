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
import {
  DOC_KINDS, isDocKind, contentForKind, renderContent, CONTENT_FORMAT_HELP,
} from "./artifact-content.ts";
import type { ToolDef, ToolExecutor } from "./ai.ts";
import type { ToolTier } from "./model-router.ts";
import { CONNECTOR_ACTIONS } from "./connector-actions.ts";
import { embedTexts, toVectorLiteral } from "./jina.ts";
import { mcpCallTool, type McpTool } from "./mcp-client.ts";
import { executeApprovalAction, approvalScope, approvalScopePrefix, approvalScopeLabel } from "./approval-exec.ts";

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
  action_kind: "edge_function" | "webhook" | "connector_action" | "composio_action" | "crm_write";
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
}

export const MAX_DELEGATION_DEPTH = 3;

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
    // Skip exact duplicates so re-runs don't pile up the same line.
    const { data: dup } = await ctx.admin
      .from("internal_agent_memories").select("id").eq("agent_id", ctx.agentId).eq("content", content).limit(1);
    if (dup && dup.length) return;
    const { count } = await ctx.admin
      .from("internal_agent_memories").select("id", { count: "exact", head: true }).eq("agent_id", ctx.agentId);
    if ((count ?? 0) >= 300) return;
    await ctx.admin.from("internal_agent_memories").insert({
      agent_id: ctx.agentId, workspace_id: ctx.workspaceId, project_id: ctx.projectId,
      kind: "context", content, importance: 2, source: "agent", source_run_id: ctx.runId ?? null,
      embedding: await embedMemoryVector(content),
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
    const [vec] = await embedTexts([query], "retrieval.query");
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
  "header", "paragraph", "list", "checklist", "image", "table", "quote", "code", "delimiter",
  "kpi", "chart", "banner", "comparison", "matrix", "callout", "slide",
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

  const BLOCK_CATALOGUE =
    'Types de blocs. Texte : header {text, level:1-4}, paragraph {text}, list {style:"ordered"|"unordered", items:[]}, '
    + 'checklist {items:[{text,checked}]}, quote {text, caption?}, code {code}, delimiter {}. '
    + 'Données : table {withHeadings:true, content:[[..],[..]]}, kpi {items:[{label,value,delta?,trend:"up"|"down"|"flat"}]}, '
    + 'chart {chartType:"bar"|"line"|"area"|"pie"|"donut"|"radar"|"scatter", title?, x, series:[], data:[{...}], stacked?}. '
    + 'Analyse : comparison {title?, columns:[], highlight?, rows:[{label, note?, cells:[true|false|"texte"]}]}, '
    + 'matrix {title?, xLabel, yLabel, xLow?, xHigh?, yLow?, yHigh?, quadrants:[4], items:[{label,x:0-100,y:0-100,note?,highlight?}]}. '
    + 'Mise en avant : banner {title, subtitle?, author?, tone?, imageUrl?}, callout {tone:"info"|"success"|"warning"|"danger", text}, '
    + 'image {file:{url}, caption?}. Découpage : slide {title?, layout?} — ouvre une nouvelle page dans une présentation. '
    + 'Le texte accepte le HTML inline restreint : <b> <i> <code> <a href> <mark>.';

  const draftKey = (target: string) => (target === "presentation" ? "deck_draft" : "report_draft_v2");

  tools.set("add_block", {
    incompressible: true,
    family: "DELIVER",
    def: {
      name: "add_block",
      description:
        "Ajoute UN bloc au document en cours de construction. C'est ainsi que tu écris : un appel par bloc, dans l'ordre de lecture. "
        + "Appelle-le dès que tu as les faits d'une partie — le fil de conversation est compacté au fil du run, un chiffre non écrit dans un bloc est un chiffre perdu. "
        + "Quand le document est complet, appelle publish_artifact. " + BLOCK_CATALOGUE,
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["report", "presentation"], description: "Le document auquel ce bloc appartient." },
          block: { type: "object", description: 'Un bloc : { "type": "...", "data": { ... } }. Voir le catalogue ci-dessus.' },
        },
        required: ["target", "block"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const target = str(args.target) === "presentation" ? "presentation" : "report";
      const raw = args.block;
      const block = (raw && typeof raw === "object" ? raw : safeJson(str(raw))) as { type?: string; data?: unknown } | null;
      if (!block?.type) {
        return 'ERROR: `block` doit être un objet { "type": "...", "data": { ... } }. ' + BLOCK_CATALOGUE;
      }
      if (!ARTIFACT_BLOCK_TYPES.includes(String(block.type))) {
        return `ERROR: type de bloc « ${block.type} » inconnu. ${BLOCK_CATALOGUE}`;
      }
      const meta = await readRunMeta(ctx);
      const key = draftKey(target);
      const draft = (Array.isArray(meta[key]) ? meta[key] : []) as unknown[];
      draft.push({ type: block.type, data: block.data ?? {} });
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
        "Publie le document construit avec add_block. C'est le SEUL moyen de livrer quelque chose de rédigé — rapport d'analyse, veille, audit, compte rendu, présentation. "
        + "Le contenu est le JSON des blocs, rendu par l'application. Il n'existe aucun autre format : ni markdown, ni tableur, ni document texte.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["report", "presentation"], description: "report = document défilant ; presentation = slides." },
          title: { type: "string", description: "Titre court et lisible." },
        },
        required: ["target", "title"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const target = str(args.target) === "presentation" ? "presentation" : "report";
      const title = str(args.title, target === "presentation" ? "Présentation" : "Rapport").slice(0, 120);
      const meta = await readRunMeta(ctx);
      const key = draftKey(target);
      const blocks = (Array.isArray(meta[key]) ? meta[key] : []) as Array<{ type: string; data: unknown }>;
      if (blocks.length === 0) {
        return `ERROR: aucun bloc n'a été construit pour ce ${target}. Appelle d'abord add_block(target="${target}", block={type, data}) une fois par bloc. ${BLOCK_CATALOGUE}`;
      }
      const content = JSON.stringify({ time: Date.now(), version: "2.30.0", blocks });
      const summary = blocks
        .map((b) => (b.data as { text?: string; title?: string })?.title ?? (b.data as { text?: string })?.text ?? "")
        .filter(Boolean).join(" · ").replace(/<[^>]+>/g, "").slice(0, 200) || title;
      await ctx.createDeliverable({ kind: target, name: title, content, summary });
      // Consume the draft so a second publish cannot duplicate the document.
      const { [key]: _used, ...rest } = meta;
      await writeRunMeta(ctx, rest);
      return `${target === "presentation" ? "Présentation" : "Rapport"} « ${title} » publié (${blocks.length} blocs). Résume-le en deux phrases dans ta réponse — le document s'ouvre en carte.`;
    },
  });

  summaryLines.push('- add_block / publish_artifact: écrire un rapport ou une présentation, un bloc à la fois, en JSON rendu par l\'app (le SEUL format de livrable).');


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
    const skillIndex = ctx.skills.map((s) => `${s.name} (${s.slug})`).join(", ");
    summaryLines.push(`- use_skill: load the full playbook of an activated skill on demand. Activated: ${skillIndex}.`);

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
          schedule: { type: "string", description: "Optional cron expression to run it on a RECURRING schedule, e.g. '0 6 * * *' = daily at 06:00, '0 9 * * 1' = Mondays 09:00. When set, the mission recurs (it does NOT fire immediately)." },
          start_now: { type: "boolean", description: "If true, activate immediately (default true; ignored when a schedule is set)." },
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
      const startNow = args.start_now !== false && !schedule;
      const row: Record<string, unknown> = {
        agent_id: agentId, workspace_id: ctx.workspaceId, project_id: ctx.projectId,
        title, brief, acceptance_criteria: str(args.acceptance_criteria) || null,
        status: schedule || startNow ? "active" : "draft",
        delegation_depth: childDepth,
        delegated_by_agent: ctx.agentId,
      };
      if (schedule) { row.schedule = schedule; row.next_run_at = new Date(Date.now() + 60_000).toISOString(); }
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
      return schedule
        ? `Mission "${title}" scheduled (cron ${schedule}) — it will run automatically (id ${mission.id}).`
        : `Mission "${title}" created${startNow ? " and started" : " as a draft"} (id ${mission.id}).`;
    },
  });
  summaryLines.push("- create_mission: assign a full background mission to yourself or a teammate, optionally on a recurring cron schedule (always available).");

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

  // Always-on: persistent memory. The agent reads its memory from the system
  // prompt and writes back through these tools.
  tools.set("save_memory", {
    def: {
      name: "save_memory",
      description:
        "Persist a durable memory you will see in every future session: a stable fact, a team preference, a lesson learned, or background context. Use it when you discover something worth remembering beyond this session. Don't save transient details or duplicates of what's already in your memory.",
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
      // Bound the store: beyond the cap the agent must consolidate, not hoard.
      const { count } = await ctx.admin
        .from("internal_agent_memories")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", ctx.agentId);
      if ((count ?? 0) >= 300) {
        return "ERROR: memory store is full (300 entries). Ask the team to prune the Memory tab before saving more.";
      }
      const { error } = await ctx.admin.from("internal_agent_memories").insert({
        agent_id: ctx.agentId,
        workspace_id: ctx.workspaceId,
        project_id: ctx.projectId,
        kind,
        content,
        importance,
        source: "agent",
        source_run_id: ctx.runId,
        source_conversation_id: ctx.conversationId ?? null,
        embedding: await embedMemoryVector(content),
      });
      if (error) return `ERROR: ${error.message}`;
      return `Memory saved (${kind}, importance ${importance}).`;
    },
  });
  tools.set("search_memory", {
    def: {
      name: "search_memory",
      description:
        "Search your full persistent memory by keyword. Your system prompt only shows the top memories — use this when you need older or less prominent ones.",
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
          const [qvec] = await embedTexts([query.slice(0, 500)], "retrieval.query");
          if (qvec) {
            const { data: sem } = await ctx.admin.rpc("match_agent_memories", {
              p_agent_id: ctx.agentId,
              p_query_embedding: toVectorLiteral(qvec),
              p_match_count: 10,
            });
            if (Array.isArray(sem) && sem.length > 0) {
              return JSON.stringify(sem.map((m: any) => ({
                kind: m.kind, content: m.content, importance: m.importance,
                similarity: Number(m.similarity ?? 0).toFixed(2),
              })));
            }
          }
        }
      } catch { /* fall back to keyword */ }
      const { data } = await ctx.admin
        .from("internal_agent_memories")
        .select("kind, content, importance, created_at")
        .eq("agent_id", ctx.agentId)
        .ilike("content", `%${query.slice(0, 60)}%`)
        .order("importance", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(10);
      if (!data || data.length === 0) return "No matching memories.";
      return JSON.stringify(data);
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
    const sbHeaders = {
      "Content-Type": "application/json",
      // Bypass ngrok free-tier interstitial warning page (returns HTML otherwise).
      "ngrok-skip-browser-warning": "true",
      "User-Agent": "Anduran-Agent/1.0",
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
          exec_dir: { type: "string", description: "Working directory (default /home/gem)." },
        }, required: ["command"], additionalProperties: false },
      },
      run: async (args) => {
        const d = await sb("v1/bash/exec", { command: str(args.command), timeout: Math.min(Number(args.timeout) || 60, 300), exec_dir: str(args.exec_dir) || undefined });
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
          "List the other autonomous agents on your team (project), with their role and skills, so you know who to ask for help or delegate to. Returns agent ids you can use with send_message_to_agent and delegate_mission.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      run: async () => {
        const { data } = await ctx.admin
          .from("internal_agents")
          .select("id, name, role, skills, description")
          .eq("project_id", ctx.projectId)
          .eq("is_archived", false)
          .eq("collaboration_enabled", true)
          .neq("id", ctx.agentId)
          .limit(30);
        if (!data || data.length === 0) return "No other collaborating agents on this team yet.";
        return JSON.stringify(data);
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
          .select("id, name, collaboration_enabled, is_archived")
          .eq("id", to)
          .eq("project_id", ctx.projectId)
          .maybeSingle();
        if (!peer || (peer as any).is_archived || (peer as any).collaboration_enabled === false) {
          return "ERROR: recipient is not a collaborating agent on this project.";
        }
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
          })
          .select("id")
          .single();
        if (error) return `ERROR: ${error.message}`;
        await triggerA2A((msg as { id: string }).id);
        return `Message sent to ${(peer as { name: string }).name}. They will react autonomously; their reply will appear in your A2A thread.`;
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
          .select("id, name, collaboration_enabled, is_archived, project_id, workspace_id")
          .eq("id", to)
          .eq("project_id", ctx.projectId)
          .maybeSingle();
        if (!peer || (peer as any).is_archived || (peer as any).collaboration_enabled === false) {
          return "ERROR: recipient is not a collaborating agent on this project.";
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
            status: "active",
            board_column: "todo",
            priority: "high",
            delegation_depth: childDepth,
            delegated_by_agent: ctx.agentId,
            report_back_to_agent: reportBack ? ctx.agentId : null,
          })
          .select("id")
          .single();
        if (error) return `ERROR: ${error.message}`;
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
        return `Mission "${title}" delegated to ${(peer as { name: string }).name} and started.${reportBack ? " They will report back to you." : ""}`;
      },
    });

    tools.set("team_memory", {
      def: {
        name: "team_memory",
        description:
          "Read or write the shared TEAM knowledge pool — facts, decisions and lessons every agent on the project can see. Use 'search' to look something up before asking a peer, and 'add' to record a shared decision or finding others should know.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["search", "add"], description: "search the pool or add to it." },
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
        if (action === "add") {
          const content = str(args.content).trim().slice(0, 600);
          if (!content) return "ERROR: content is required to add team memory.";
          const kind = ["fact", "preference", "learning", "context", "decision"].includes(str(args.kind)) ? str(args.kind) : "fact";
          const { error } = await ctx.admin.from("internal_agent_team_memories").insert({
            workspace_id: ctx.workspaceId,
            project_id: ctx.projectId,
            kind,
            content,
            author_agent: ctx.agentId,
            source: "agent",
          });
          if (error) return `ERROR: ${error.message}`;
          return `Team memory recorded (${kind}). All project agents can now see it.`;
        }
        // search (default)
        const query = str(args.query).trim();
        let q = ctx.admin
          .from("internal_agent_team_memories")
          .select("kind, content, importance, created_at")
          .eq("project_id", ctx.projectId)
          .order("is_pinned", { ascending: false })
          .order("importance", { ascending: false })
          .limit(12);
        if (query) q = q.ilike("content", `%${query.slice(0, 60)}%`);
        const { data } = await q;
        if (!data || data.length === 0) return query ? "No matching team memory." : "Team memory is empty.";
        return JSON.stringify(data);
      },
    });

    summaryLines.push(
      "- list_team_agents / send_message_to_agent / delegate_mission: collaborate with your teammate agents.",
      "- team_memory: read & contribute to the shared team knowledge pool.",
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
    "ask_user", "update_todos", "create_deliverable", "report_section",
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
  save_memory: "MEMORY", search_memory: "MEMORY", team_memory: "MEMORY", search_past_work: "MEMORY",
  create_mission: "TEAM", delegate_mission: "TEAM", send_message_to_agent: "TEAM", list_team_agents: "TEAM",
  create_task: "TEAM", list_missions: "TEAM", move_mission: "TEAM", propose_mission: "TEAM", create_agent: "TEAM",
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
