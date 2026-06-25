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
  logEvent: (kind: "tool_call" | "tool_result" | "status" | "log", payload: Record<string, unknown>) => Promise<void>;
  /** Re-check whether the run was cancelled by a human. */
  isCancelled: () => Promise<boolean>;
  /** AIO Sandbox URL when agent runs in sandbox mode. */
  sandboxUrl?: string | null;
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled by user");
    this.name = "RunCancelledError";
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
  const columns = str(args.columns, "*");
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

  // Always-on: file a trackable task.
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
      const startNow = args.start_now !== false;
      const { data: mission, error } = await ctx.admin.from("internal_agent_missions").insert({
        agent_id: agentId, workspace_id: ctx.workspaceId, project_id: ctx.projectId,
        title, brief, acceptance_criteria: str(args.acceptance_criteria) || null,
        status: startNow ? "active" : "draft",
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

  // Always-on: the agent manages its own kanban board.
  const BOARD_COLUMNS = ["backlog", "todo", "in_progress", "review", "done"];
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

  // Always-on: browse real web pages via runner's Playwright instance.
  const runnerUrl = Deno.env.get("RUNNER_BROWSER_URL") || Deno.env.get("RUNNER_URL");
  if (runnerUrl) {
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
        if (ctx.logEvent) await ctx.logEvent("tool_call", { tool: "shell_exec", command: str(args.command).slice(0, 120), exit_code: d.exit_code });
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
        const d = await sb("v1/code/execute", { language: "python", code: str(args.code), stateful: args.stateful !== false });
        if (ctx.logEvent) await ctx.logEvent("tool_call", { tool: "python_exec", exit_code: d.exit_code });
        const tb = Array.isArray(d.traceback) ? d.traceback.join("\n") : "";
        return `[status: ${d.status ?? "?"} | exit: ${d.exit_code ?? "?"}]\n\n${(d.stdout ?? "").slice(0, 8000)}${d.stderr ? `\n--- stderr ---\n${d.stderr.slice(0, 3000)}` : ""}${tb ? `\n--- traceback ---\n${tb.slice(0, 3000)}` : ""}`;
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
        if (ctx.logEvent) await ctx.logEvent("tool_call", { tool: "file_write", file: str(args.file) });
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
    summaryLines.push("");
    summaryLines.push("IMPORTANT: You have a REAL Linux sandbox. To save a file, use file_write. To run code, use python_exec or shell_exec. NEVER say you 'can't access the filesystem' — you can. Actually execute the task.");
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

  const executor: ToolExecutor = async (name, args) => {
    if (await ctx.isCancelled()) throw new RunCancelledError();
    const tool = tools.get(name);
    if (!tool) return `ERROR: unknown tool "${name}".`;
    await ctx.logEvent("tool_call", { tool: name, args });
    try {
      const result = await tool.run(args);
      await ctx.logEvent("tool_result", { tool: name, ok: !result.startsWith("ERROR"), preview: result.slice(0, 500) });
      return result;
    } catch (e) {
      if (e instanceof RunCancelledError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.logEvent("tool_result", { tool: name, ok: false, preview: `ERROR: ${msg}`.slice(0, 500) });
      return `ERROR: ${msg}`;
    }
  };

  return { defs, executor, capabilitySummary: summaryLines.join("\n") };
}
