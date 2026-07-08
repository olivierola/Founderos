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
import type { ToolDef, ToolExecutor } from "./ai.ts";
import { CONNECTOR_ACTIONS } from "./connector-actions.ts";
import { embedTexts, toVectorLiteral } from "./jina.ts";

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
    | "security_scan"
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

export interface ApprovalRequest {
  tool_name: string;
  action_kind: "edge_function" | "webhook";
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
  /** Queue a sensitive action for human approval. Returns the approval id. */
  requestApproval: (r: ApprovalRequest) => Promise<string>;
  /** Append a run event (no-op when runId is null). */
  logEvent: (kind: "tool_call" | "tool_result" | "status" | "log" | "plan" | "plan_step" | "tool_error" | "question" | "todos", payload: Record<string, unknown>) => Promise<void>;
  /** True when this context belongs to a MISSION run (gates meta-tools like
   *  self-mission creation that fueled the fork-bomb incident). */
  missionMode?: boolean;
  /** Missions created during THIS run (budget: 2). Mutated by the guard. */
  missionCreates?: number;
  /** Re-check whether the run was cancelled by a human. */
  isCancelled: () => Promise<boolean>;
  /** AIO Sandbox URL when agent runs in sandbox mode. */
  sandboxUrl?: string | null;
  /** Whether the agent may drive the Playwright runner (browse_web). */
  runnerEnabled?: boolean;
  /** Runner browser URL from the live DB config (fallback: env). */
  runnerUrl?: string | null;
  /** Skills activated for this agent — their full playbooks are loaded on
   *  demand via use_skill (progressive disclosure), not injected up-front. */
  skills?: AgentSkill[];
  /** Depth of this run in a delegation chain (0 = user-initiated). create_mission
   *  refuses to delegate beyond MAX_DELEGATION_DEPTH to stop infinite loops. */
  delegationDepth?: number;
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
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
  /** Full playbook / methodology — returned by use_skill when loaded. */
  instructions?: string | null;
  /** Tool kinds this skill expects to use. */
  tools?: string[] | null;
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function cap(s: string, max = 8000): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
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

function slugToToolName(prefix: string, slug: string): string {
  return `${prefix}_${slug.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`.slice(0, 60);
}

interface InternalTool {
  def: ToolDef["function"];
  run: (args: Record<string, unknown>) => Promise<string>;
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
  // Keyless fallbacks: DuckDuckGo HTML endpoint, then the lite variant (the
  // full endpoint sometimes serves an anomaly page to datacenter IPs).
  const html = await fetchDdg(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  let results = html ? parseDdgHtml(html, maxResults) : [];
  if (results.length === 0) {
    const lite = await fetchDdg(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
    if (lite) results = parseDdgLite(lite, maxResults);
  }
  if (results.length === 0) {
    return "ERROR: web search returned no results (search providers unreachable). Try read_url on a known site, or ask the team to configure TAVILY_API_KEY.";
  }
  return JSON.stringify({ provider: "duckduckgo", results });
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

export async function readUrl(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "ERROR: url must be an absolute http(s) URL.";
  // Jina Reader proxies and extracts readable content; no API key required.
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { "X-Return-Format": "markdown" },
  });
  if (!res.ok) return `ERROR: could not fetch (${res.status}).`;
  return cap(await res.text());
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
  const { data } = await ctx.admin
    .from("connectors")
    .select("provider, status, permissions")
    .eq("project_id", ctx.projectId);
  if (!data || data.length === 0) return "No connectors configured for this project.";
  return JSON.stringify(data);
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

const DELIVERABLE_KINDS = ["report", "markdown", "json", "code", "url"];

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
      "callout": { "tone": "info|success|warning|danger", "text": "string" }
    }
  ]
}
MAKE REPORTS VISUAL AND PROFESSIONAL. Whenever you have numbers, SHOW them: lead a section with KPI cards, add at least one chart (pick the right type — line for trends over time, bar for comparisons, donut/pie for composition, radar for multi-dimension scores, scatter for correlation), use gauges for scores/completion, tables for detailed rows, a timeline for sequences of events, and callouts to highlight risks/wins. Prefer charts/KPIs over long prose. Every analytical report should contain visuals, not just text.
You may also embed a chart inside markdown deliverables using a fenced block: \`\`\`chart\\n{ "type":"bar", "x":"month", "series":["mrr"], "data":[...] }\\n\`\`\``;

export function buildInternalToolset(
  rows: AgentToolRow[],
  ctx: InternalToolContext,
): { defs: ToolDef[]; executor: ToolExecutor; capabilitySummary: string } {
  const tools = new Map<string, InternalTool>();
  const summaryLines: string[] = [];
  // Execution-family guidance rendered under the EXECUTION section of the tree.
  const sandboxGuidance: string[] = [];

  // Always-on: deliverable materialisation.
  tools.set("create_deliverable", {
    def: {
      name: "create_deliverable",
      description:
        "Save a finished deliverable — your durable output. Prefer kind=\"report\" for analyses/results: a structured, designed document with sections, KPIs, charts and tables. Use markdown/json/code/url for simpler outputs. Call once per expected deliverable; summarise (don't repeat the full content) in your final answer.\n" +
        REPORT_SCHEMA_HINT,
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: DELIVERABLE_KINDS, description: "Deliverable format. Use 'report' for structured analyses with charts/KPIs." },
          name: { type: "string", description: "Short human-readable name." },
          content: { type: "string", description: "The full deliverable content (for report: the JSON string described above)." },
        },
        required: ["kind", "name", "content"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      let kind = DELIVERABLE_KINDS.includes(str(args.kind)) ? str(args.kind) : "markdown";
      const name = str(args.name, "Output").slice(0, 120);
      const content = str(args.content);
      if (!content) return "ERROR: content is required.";
      // Validate report JSON; downgrade to markdown if it's not parseable so we
      // never persist a broken report.
      let summary: string | null;
      if (kind === "report") {
        try {
          const parsed = JSON.parse(content);
          summary = (str(parsed.summary) || str(parsed.title)).slice(0, 200) || null;
        } catch {
          kind = "markdown";
          summary = content.replace(/[#*`>_\n]+/g, " ").trim().slice(0, 200) || null;
        }
      } else {
        summary = content.replace(/[#*`>_\n]+/g, " ").trim().slice(0, 200) || null;
      }
      await ctx.createDeliverable({ kind, name, content, summary });
      return `Deliverable "${name}" (${kind}) saved.`;
    },
  });
  summaryLines.push("- create_deliverable: save your outputs as durable deliverables, ideally as a structured 'report' with charts/KPIs (always available).");

  // Always-on: the run's todo list (TodoWrite-style). The FULL list is sent on
  // every call and persisted structurally on the run — it drives the checklist
  // the user watches live. Replaces the old per-step update_plan_step.
  tools.set("update_todos", {
    def: {
      name: "update_todos",
      description:
        "Maintain your run's todo checklist — the user watches it live. Send the COMPLETE list every time (all items, not a diff). Rules: exactly ONE item 'active' at a time; update it right BEFORE starting a step (mark it active) and right AFTER finishing it (mark it done — only once VERIFIED); mark 'blocked' with a note when stuck; add new items when you discover extra work. Keep titles short and action-oriented.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The full, ordered todo list.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Stable id, e.g. 'step-1'." },
                title: { type: "string", description: "Short action title." },
                status: { type: "string", enum: ["pending", "active", "done", "blocked"] },
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
      const todos = raw.slice(0, 20).map((t: any, i: number) => ({
        id: str(t?.id) || `step-${i + 1}`,
        title: str(t?.title).slice(0, 140) || `Step ${i + 1}`,
        status: ["pending", "active", "done", "blocked"].includes(str(t?.status)) ? str(t?.status) : "pending",
        ...(str(t?.note) ? { note: str(t?.note).slice(0, 300) } : {}),
      }));
      if (ctx.runId) {
        await ctx.admin.from("internal_agent_runs").update({ todos }).eq("id", ctx.runId);
      }
      await ctx.logEvent("todos", { todos });
      const active = todos.filter((t) => t.status === "active").length;
      const done = todos.filter((t) => t.status === "done").length;
      const warn = active > 1 ? " WARNING: more than one item is 'active' — keep exactly one." : "";
      return `Todos updated (${done}/${todos.length} done).${warn}`;
    },
  });
  summaryLines.push("- update_todos: maintain your live todo checklist (send the FULL list; one item active at a time).");

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
        parts.push("", "## Playbook", sk.instructions || "(no detailed instructions provided — apply the skill's intent.)");
        parts.push("", "Now apply this skill to the current step.");
        return cap(parts.join("\n"), 6000);
      },
    });
    const skillIndex = ctx.skills.map((s) => `${s.name} (${s.slug})`).join(", ");
    summaryLines.push(`- use_skill: load the full playbook of an activated skill on demand. Activated: ${skillIndex}.`);
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
          start_now: { type: "boolean", description: "If true, activate immediately (default true)." },
        },
        required: ["title", "brief"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const title = str(args.title).slice(0, 200);
      const brief = str(args.brief);
      if (!title || !brief) return "ERROR: title and brief are required.";
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
      const startNow = args.start_now !== false;
      const { data: mission, error } = await ctx.admin.from("internal_agent_missions").insert({
        agent_id: agentId, workspace_id: ctx.workspaceId, project_id: ctx.projectId,
        title, brief, acceptance_criteria: str(args.acceptance_criteria) || null,
        status: startNow ? "active" : "draft",
        delegation_depth: childDepth,
        delegated_by_agent: ctx.agentId,
      }).select("id").single();
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
      return `Mission "${title}" created${startNow ? " and started" : " as a draft"} (id ${mission.id}).`;
    },
  });
  summaryLines.push("- create_mission: assign a full background mission to yourself or a teammate (always available).");

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
      const url = str(args.url);
      if (!/^https?:\/\//i.test(url)) return "ERROR: url must be absolute http(s).";
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
      `[exit: ${d.exit_code ?? "?"}${d.timed_out ? " | TIMED OUT" : ""} | ${d.duration_ms ?? "?"}ms]\n\n${String(d.stdout ?? "").slice(0, 8000)}${d.stderr ? `\n--- stderr ---\n${String(d.stderr).slice(0, 4000)}` : ""}`;

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

  // ── Sandbox tools: only available when the agent runs in sandbox mode. ──
  // All AIO Sandbox responses are wrapped as { success, message, data, hint }.
  if (ctx.sandboxUrl) {
    const sbUrl = ctx.sandboxUrl.replace(/\/$/, "");
    const sbHeaders = {
      "Content-Type": "application/json",
      // Bypass ngrok free-tier interstitial warning page (returns HTML otherwise).
      "ngrok-skip-browser-warning": "true",
      "User-Agent": "FounderOS-Agent/1.0",
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
        return `$ ${str(args.command)}\n[status: ${d.status ?? "?"} | exit: ${d.exit_code ?? "?"}]\n\n${(d.stdout ?? "").slice(0, 8000)}${d.stderr ? `\n--- stderr ---\n${d.stderr.slice(0, 4000)}` : ""}`;
      },
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
        return `[status: ${d.status ?? "?"} | exit: ${d.exit_code ?? "?"}]\n\n${(d.stdout ?? "").slice(0, 8000)}${d.stderr ? `\n--- stderr ---\n${d.stderr.slice(0, 3000)}` : ""}${tb ? `\n--- traceback ---\n${tb.slice(0, 3000)}` : ""}${hint}`;
      },
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
        return `[exit: ${d.exit_code ?? "?"}]\n\n${(d.stdout ?? d.output ?? "").slice(0, 8000)}${d.stderr ? `\n--- stderr ---\n${d.stderr.slice(0, 3000)}` : ""}`;
      },
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
        return `[status: ${d.status ?? "ok"}]\n\n${(d.stdout ?? "").slice(0, 4000)}${outputs ? `\n${outputs.slice(0, 4000)}` : ""}${d.stderr ? `\n--- stderr ---\n${d.stderr.slice(0, 2000)}` : ""}`;
      },
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
        return String(d.content ?? "").slice(0, 12000);
      },
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

    summaryLines.push("- shell_exec: run shell commands (pip/npm install, git, scripts, curl, any command).");
    summaryLines.push("- python_exec / nodejs_exec / jupyter_exec: execute code (stateful Python, Node.js, Jupyter for data analysis).");
    summaryLines.push("- file_write / file_read / file_edit / list_files / file_search: full filesystem (write, read, edit, list, glob/grep).");
    summaryLines.push("- sandbox_browser: drive a real Chromium browser (navigate, screenshot, get_markdown, click, fill, evaluate JS, 25+ actions).");
    summaryLines.push("- sandbox_env: environment info, installed packages, URL→markdown conversion.");
    sandboxGuidance.push("  SANDBOX DISCIPLINE — use the sandbox ONLY when the task actually needs it: running code, reading/writing files, installing packages, fetching or processing data, or building/testing something. For greetings, simple questions, explanations, advice, opinions or planning, ANSWER DIRECTLY from your own knowledge and do NOT call any sandbox / shell / python / file tool. Don't 'check the sandbox' by reflex. When the work genuinely requires it: save files with file_write, run code with python_exec or shell_exec — and never claim you 'can't access the filesystem' (you can).");
    sandboxGuidance.push("  EFFICIENCY: the python_exec kernel can RESET between calls (state is lost), so do NOT split one analysis into many tiny python_exec calls that each re-import and re-read the data — that wastes huge amounts of tokens. For any multi-step pipeline (load → analyse → model → save), write ONE self-contained script with file_write and run it with shell_exec \"python3 script.py\", saving intermediate results (CSV/JSON/pickle) to disk. Re-use those files instead of recomputing.");
    sandboxGuidance.push("  VERIFY BACKGROUND PROCESSES: after launching anything with `nohup … &` (a server, a Gradio app), you MUST read its log (e.g. `cat gradio.log`) to confirm it actually started — never assume success. If the log shows a traceback/error, FIX the script and relaunch before continuing. For a web app: a 'public URL' only counts if the log printed it AND a test request to it succeeds. Gradio `demo.launch(share=True)` prints a *.gradio.live URL; avoid version-specific kwargs (e.g. show_copy_button) that crash on launch.");
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

  const enabled = rows.filter((r) => r.enabled);
  const hasKind = (k: AgentToolRow["kind"]) => enabled.some((r) => r.kind === k);

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
            action: { type: "string", description: `One of: ${actions.map((a) => a.name).join(", ")}` },
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
          const id = await ctx.requestApproval({
            tool_name: toolName,
            action_kind: "connector_action",
            payload: { provider, action, params },
            reason: str(args.reason) || null,
          });
          return `Action ${provider}.${action} queued for human approval (approval ${id}). It runs once a team member approves it — continue and mention the pending approval in your final answer.`;
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
          const id = await ctx.requestApproval({
            tool_name: toolName,
            action_kind: "edge_function",
            payload: { slug, args: fnArgs },
            reason: str(args.reason) || null,
          });
          return `Action queued for human approval (approval ${id}). It will run once a team member approves it — continue with the rest of the mission and mention the pending approval in your final answer.`;
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
          const id = await ctx.requestApproval({
            tool_name: toolName,
            action_kind: "webhook",
            payload: { url, method, headers, args },
            reason: str(args.reason) || null,
          });
          return `Action queued for human approval (approval ${id}). Continue with the rest of the mission and mention the pending approval in your final answer.`;
        }
        return invokeWebhook(url, method, args, headers);
      },
    });
    summaryLines.push(`- ${toolName}: ${row.description || row.name}${row.requires_approval ? " (requires human approval)" : ""}.`);
  }

  const defs: ToolDef[] = [...tools.values()].map((t) => ({ type: "function", function: t.def }));

  // NOTE: the executor does NOT log run events itself — the run loop's logging
  // wrapper (internal-agent-run) is the single source of tool_call/tool_result
  // events. Logging in both places was double-rendering every action in the UI.
  const executor: ToolExecutor = async (name, args) => {
    if (await ctx.isCancelled()) throw new RunCancelledError();
    const tool = tools.get(name);
    if (!tool) return `ERROR: unknown tool "${name}".`;
    try {
      return await tool.run(args);
    } catch (e) {
      if (e instanceof RunCancelledError || e instanceof AwaitingInputError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      return `ERROR: ${msg}`;
    }
  };

  return { defs, executor, capabilitySummary: buildCapabilityTree(tools, sandboxGuidance, summaryLines) };
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
  web_search: "WEB", read_url: "WEB", deep_research: "WEB", http_get: "WEB",
  search_knowledge: "DATA", query_table: "DATA", list_connectors: "DATA",
  update_todos: "PLAN", use_skill: "PLAN", ask_user: "PLAN",
  create_deliverable: "DELIVER",
  save_memory: "MEMORY", search_memory: "MEMORY", team_memory: "MEMORY",
  create_mission: "TEAM", delegate_mission: "TEAM", send_message_to_agent: "TEAM", list_team_agents: "TEAM",
  create_task: "TEAM", list_missions: "TEAM", move_mission: "TEAM",
  send_email: "INTEGRATIONS", security_scan: "INTEGRATIONS",
};

function buildCapabilityTree(
  tools: Map<string, { def: { name: string; description: string } } & Record<string, unknown>>,
  sandboxGuidance: string[],
  legacyLines: string[],
): string {
  const byFamily = new Map<ToolFamily, string[]>();
  for (const [name, t] of tools) {
    const fam = TOOL_FAMILY[name] ?? "INTEGRATIONS";
    // First sentence of the description keeps the inventory scannable.
    const firstSentence = (t.def.description ?? "").split(/(?<=\.)\s+/)[0] ?? "";
    const arr = byFamily.get(fam) ?? [];
    arr.push(`  - ${name}: ${firstSentence.slice(0, 200)}`);
    byFamily.set(fam, arr);
  }
  const out: string[] = [
    "# TOOLBOX — grouped by family, in order of preference",
    "RULE #1 — PREFER EXECUTION TOOLS. Real progress = files created, commands run, data processed, things built and verified. Meta-tools (missions, tasks, messages, memory) only RECORD or COORDINATE work — they never DO it. If you notice several consecutive meta-tool calls with no new file/command/result, STOP and switch to EXECUTION tools.",
    "",
  ];
  for (const fam of FAMILY_ORDER) {
    const lines = byFamily.get(fam);
    if (!lines?.length) continue;
    out.push(`## ${FAMILY_META[fam].label}`);
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
