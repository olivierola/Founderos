// Assistant tool registry.
//
// Defines the tools the internal assistant agent can call, the JSON schema the
// model sees, and the executors that run server-side. Two cross-cutting
// concerns are handled here:
//
//  1. ROLE-BASED ACCESS CONTROL. Every tool declares the minimum workspace role
//     required (owner > admin > member > viewer). The caller's role is resolved
//     from workspace_members and tools above their level are *not exposed* to
//     the model and are *refused* at execution time. This guarantees the agent
//     can never read data outside the user's authorised scope.
//
//  2. ARTIFACT EMISSION. Tools whose purpose is to produce a deliverable
//     (document, json, table, code, csv) don't return the payload to the model;
//     they stash it via `emitArtifact` and return a short confirmation. The edge
//     function persists emitted artifacts and the UI renders them as cards.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import type { ToolDef } from "./ai.ts";

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export function roleAllows(userRole: WorkspaceRole, minRole: WorkspaceRole): boolean {
  return ROLE_RANK[userRole] >= ROLE_RANK[minRole];
}

export interface EmittedArtifact {
  kind: "document" | "json" | "table" | "code" | "csv";
  title: string;
  content?: string;
  data?: unknown;
  language?: string;
}

export interface ToolContext {
  admin: SupabaseClient;
  workspaceId: string;
  projectId: string;
  userId: string;
  userRole: WorkspaceRole;
  // Tools push deliverables here; the edge function persists them after the loop.
  emitArtifact: (a: EmittedArtifact) => void;
}

interface AssistantTool {
  name: string;
  minRole: WorkspaceRole;
  /** Short note shown in the access-scope summary appended to the system prompt. */
  scope: string;
  def: ToolDef["function"];
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

// --- helpers ----------------------------------------------------------------

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function clampRows<T>(rows: T[] | null | undefined, max = 50): T[] {
  return (rows ?? []).slice(0, max);
}

function toCsv(columns: string[], rows: (string | number | null)[][]): string {
  const esc = (c: unknown) => {
    const s = c == null ? "" : String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

// ===========================================================================
// DATA TOOLS — read project data, each gated by role.
// ===========================================================================

const getMetrics: AssistantTool = {
  name: "get_metrics",
  minRole: "viewer",
  scope: "Latest product metrics snapshot (read-only).",
  def: {
    name: "get_metrics",
    description:
      "Return the latest metrics snapshot for the current project (MRR, users, churn, etc.). Use when the user asks about product/business metrics.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async (_args, ctx) => {
    const { data } = await ctx.admin
      .from("metrics_snapshots")
      .select("metrics, snapshot_date")
      .eq("project_id", ctx.projectId)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return "No metrics snapshot available yet.";
    return JSON.stringify({ snapshot_date: data.snapshot_date, metrics: data.metrics });
  },
};

const getLatestScan: AssistantTool = {
  name: "get_latest_scan",
  minRole: "member",
  scope: "Latest code scan: services, dependencies, security findings.",
  def: {
    name: "get_latest_scan",
    description:
      "Return the most recent code scan for the project: detected services, dependency count, security findings and the AI analysis summary. Use for architecture, security or dependency questions.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async (_args, ctx) => {
    const { data } = await ctx.admin
      .from("scan_results")
      .select("summary, services, security_findings, ai_analysis, dependencies, created_at, repositories(full_name)")
      .eq("project_id", ctx.projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return "No code scan available yet.";
    return JSON.stringify({
      repo: (data as any).repositories?.full_name ?? null,
      created_at: data.created_at,
      summary: data.summary,
      services: data.services,
      dependencies_count: ((data as any).dependencies ?? []).length,
      security_findings: data.security_findings,
      ai_analysis: data.ai_analysis,
    });
  },
};

const getConnectors: AssistantTool = {
  name: "get_connectors",
  minRole: "member",
  scope: "Connected integrations and their status (no secrets).",
  def: {
    name: "get_connectors",
    description:
      "List the project's connected integrations (provider + status). Never returns secrets. Use to know what data sources are available.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async (_args, ctx) => {
    const { data } = await ctx.admin
      .from("connectors")
      .select("provider, status")
      .eq("project_id", ctx.projectId);
    return JSON.stringify(data ?? []);
  },
};

const getAlerts: AssistantTool = {
  name: "get_open_alerts",
  minRole: "member",
  scope: "Open alerts (severity, title, age).",
  def: {
    name: "get_open_alerts",
    description: "Return the project's currently open alerts. Use for risk / incident questions.",
    parameters: {
      type: "object",
      properties: {
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Optional filter by minimum severity.",
        },
      },
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    let q = ctx.admin
      .from("alerts")
      .select("severity, title, status, created_at")
      .eq("project_id", ctx.projectId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(25);
    const sev = str(args.severity);
    if (sev) q = q.eq("severity", sev);
    const { data } = await q;
    return JSON.stringify(data ?? []);
  },
};

// Finance is sensitive → admin+ only.
const getRevenue: AssistantTool = {
  name: "get_revenue",
  minRole: "admin",
  scope: "Revenue / MRR figures (admins and owners only).",
  def: {
    name: "get_revenue",
    description:
      "Return revenue figures for the project over a recent window: total, by month, and recent records. Sensitive — only available to admins/owners.",
    parameters: {
      type: "object",
      properties: {
        months: { type: "number", description: "How many months back to aggregate (default 6, max 24)." },
      },
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const months = Math.min(Math.max(Number(args.months ?? 6) || 6, 1), 24);
    const since = new Date();
    since.setMonth(since.getMonth() - months);
    const { data } = await ctx.admin
      .from("revenue_records")
      .select("amount_cents, currency, type, occurred_at")
      .eq("project_id", ctx.projectId)
      .gte("occurred_at", since.toISOString())
      .order("occurred_at", { ascending: false })
      .limit(500);
    const records = data ?? [];
    const byMonth: Record<string, number> = {};
    let total = 0;
    for (const r of records) {
      total += r.amount_cents ?? 0;
      const key = (r.occurred_at ?? "").slice(0, 7);
      if (key) byMonth[key] = (byMonth[key] ?? 0) + (r.amount_cents ?? 0);
    }
    return JSON.stringify({
      window_months: months,
      currency: records[0]?.currency ?? "eur",
      total_cents: total,
      by_month_cents: byMonth,
      record_count: records.length,
    });
  },
};

// LLM cost tracking → admin+ (cost data).
const getLlmCosts: AssistantTool = {
  name: "get_llm_costs",
  minRole: "admin",
  scope: "LLM usage & cost breakdown (admins and owners only).",
  def: {
    name: "get_llm_costs",
    description:
      "Return LLM usage and cost aggregates for the project (tokens + estimated cost by provider/feature). Sensitive — admins/owners only.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "Lookback window in days (default 30, max 180)." },
      },
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const days = Math.min(Math.max(Number(args.days ?? 30) || 30, 1), 180);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data } = await ctx.admin
      .from("llm_usage")
      .select("provider, feature, total_tokens, estimated_cost_cents, currency, created_at")
      .eq("project_id", ctx.projectId)
      .gte("created_at", since)
      .limit(2000);
    const rows = data ?? [];
    const byProvider: Record<string, { tokens: number; cost_cents: number }> = {};
    let totalCents = 0;
    let totalTokens = 0;
    for (const r of rows) {
      totalCents += Number(r.estimated_cost_cents ?? 0);
      totalTokens += Number(r.total_tokens ?? 0);
      const p = r.provider ?? "unknown";
      byProvider[p] ??= { tokens: 0, cost_cents: 0 };
      byProvider[p].tokens += Number(r.total_tokens ?? 0);
      byProvider[p].cost_cents += Number(r.estimated_cost_cents ?? 0);
    }
    return JSON.stringify({
      window_days: days,
      currency: rows[0]?.currency ?? "eur",
      total_cost_cents: totalCents,
      total_tokens: totalTokens,
      by_provider: byProvider,
    });
  },
};

// ===========================================================================
// WEB TOOL — read a URL via Jina Reader (no key needed).
// ===========================================================================

const readUrl: AssistantTool = {
  name: "read_url",
  minRole: "member",
  scope: "Fetch and read the text content of a public URL.",
  def: {
    name: "read_url",
    description:
      "Fetch a public web page and return its main text content (markdown). Use to read documentation, articles or competitor pages the user references.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The absolute http(s) URL to read." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  run: async (args) => {
    const url = str(args.url);
    if (!/^https?:\/\//i.test(url)) return "ERROR: url must be an absolute http(s) URL.";
    // Jina Reader proxies and extracts readable content; no API key required.
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { "X-Return-Format": "markdown" },
    });
    if (!res.ok) return `ERROR: could not fetch (${res.status}).`;
    const text = await res.text();
    return text.slice(0, 8000);
  },
};

// ===========================================================================
// RAG TOOL — semantic search across the project's indexed knowledge.
// ===========================================================================

const searchKnowledge: AssistantTool = {
  name: "search_knowledge",
  minRole: "viewer",
  scope: "Semantic search across the project's indexed documents.",
  def: {
    name: "search_knowledge",
    description:
      "Search the project's indexed knowledge base (uploaded docs, notes) by meaning. Use when the user asks about internal content that isn't structured data.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        limit: { type: "number", description: "Max results (default 5, max 10)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const query = str(args.query);
    if (!query) return "ERROR: query is required.";
    const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 10);
    // Try semantic search per RAG agent (the match RPC is agent-scoped); pick the
    // best chunks across the project's agents. Fall back to keyword search.
    try {
      const { embedTexts, toVectorLiteral } = await import("./jina.ts");
      const [vec] = await embedTexts([query], "retrieval.query");
      if (vec) {
        const { data: agents } = await ctx.admin
          .from("rag_agents")
          .select("id")
          .eq("project_id", ctx.projectId)
          .limit(10);
        const vecLiteral = toVectorLiteral(vec);
        const hits: Array<{ similarity: number; text: string }> = [];
        for (const a of agents ?? []) {
          const { data, error } = await ctx.admin.rpc("match_rag_chunks", {
            p_agent_id: (a as any).id,
            p_query_embedding: vecLiteral,
            p_match_count: limit,
          });
          if (!error && data) {
            for (const d of data as any[]) {
              hits.push({ similarity: d.similarity ?? 0, text: (d.content ?? "").slice(0, 600) });
            }
          }
        }
        if (hits.length) {
          hits.sort((x, y) => y.similarity - x.similarity);
          return JSON.stringify(clampRows(hits, limit));
        }
      }
    } catch {
      // embedding / rpc unavailable — fall through to keyword search
    }
    const { data } = await ctx.admin
      .from("rag_chunks")
      .select("content")
      .eq("project_id", ctx.projectId)
      .ilike("content", `%${query.slice(0, 60)}%`)
      .limit(limit);
    if (!data || data.length === 0) return "No matching knowledge found.";
    return JSON.stringify(data.map((d: any) => ({ text: (d.content ?? "").slice(0, 600) })));
  },
};

// ===========================================================================
// ARTIFACT TOOLS — produce deliverables (document, json, table, code, csv).
// These return a short ack; the real payload is emitted as an artifact.
// ===========================================================================

const createDocument: AssistantTool = {
  name: "create_document",
  minRole: "viewer",
  scope: "Write a markdown document deliverable.",
  def: {
    name: "create_document",
    description:
      "Produce a polished markdown document (report, brief, plan, email…). Use whenever the user asks you to 'write', 'draft' or 'create' a document. The document is shown to the user as a downloadable, editable artifact — do NOT also repeat its full content in your chat reply.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Document title." },
        markdown: { type: "string", description: "Full document body in GitHub-flavored markdown." },
      },
      required: ["title", "markdown"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const title = str(args.title, "Document");
    const markdown = str(args.markdown);
    if (!markdown.trim()) return "ERROR: markdown content is required.";
    ctx.emitArtifact({ kind: "document", title, content: markdown });
    return `Document "${title}" created (${markdown.length} chars). It is shown to the user as an artifact.`;
  },
};

const createJson: AssistantTool = {
  name: "create_json",
  minRole: "viewer",
  scope: "Return a structured JSON payload deliverable.",
  def: {
    name: "create_json",
    description:
      "Return a structured JSON object/array as a downloadable artifact. Use when the user wants structured/exportable data. Do not also paste the JSON in your reply.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "A name for the JSON payload." },
        json: { description: "The JSON value (object or array)." },
      },
      required: ["title", "json"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const title = str(args.title, "Data");
    if (args.json === undefined) return "ERROR: json is required.";
    ctx.emitArtifact({ kind: "json", title, data: args.json });
    return `JSON artifact "${title}" created.`;
  },
};

const createTable: AssistantTool = {
  name: "create_table",
  minRole: "viewer",
  scope: "Return a table (grid + CSV export) deliverable.",
  def: {
    name: "create_table",
    description:
      "Return tabular data as an interactive table the user can view and export to CSV. Use for comparisons, lists of rows, breakdowns.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Table title." },
        columns: { type: "array", items: { type: "string" }, description: "Column headers." },
        rows: {
          type: "array",
          items: { type: "array", items: { type: ["string", "number", "null"] } },
          description: "Rows; each row is an array aligned to columns.",
        },
      },
      required: ["title", "columns", "rows"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const title = str(args.title, "Table");
    const columns = Array.isArray(args.columns) ? (args.columns as string[]) : [];
    const rows = Array.isArray(args.rows) ? (args.rows as (string | number | null)[][]) : [];
    if (!columns.length) return "ERROR: columns are required.";
    ctx.emitArtifact({
      kind: "table",
      title,
      data: { columns, rows },
      content: toCsv(columns, rows), // CSV mirror for one-click export
    });
    return `Table "${title}" created with ${columns.length} columns × ${rows.length} rows.`;
  },
};

const createCode: AssistantTool = {
  name: "create_code",
  minRole: "viewer",
  scope: "Return a code file/snippet deliverable.",
  def: {
    name: "create_code",
    description:
      "Return a code snippet or file as a downloadable artifact with syntax language. Use when the user asks for a script, config or code file.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "File/snippet name (e.g. 'deploy.sh')." },
        language: { type: "string", description: "Language id (ts, py, bash, sql, json, yaml…)." },
        code: { type: "string", description: "The code body." },
      },
      required: ["title", "language", "code"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const title = str(args.title, "snippet");
    const language = str(args.language, "text");
    const code = str(args.code);
    if (!code.trim()) return "ERROR: code is required.";
    ctx.emitArtifact({ kind: "code", title, content: code, language });
    return `Code artifact "${title}" (${language}) created.`;
  },
};

// ---------------------------------------------------------------------------

const ALL_TOOLS: AssistantTool[] = [
  getMetrics,
  getLatestScan,
  getConnectors,
  getAlerts,
  getRevenue,
  getLlmCosts,
  readUrl,
  searchKnowledge,
  createDocument,
  createJson,
  createTable,
  createCode,
];

/** Tools the given role is allowed to use. */
export function toolsForRole(role: WorkspaceRole): AssistantTool[] {
  return ALL_TOOLS.filter((t) => roleAllows(role, t.minRole));
}

/** OpenAI tool definitions for the allowed tools. */
export function toolDefsForRole(role: WorkspaceRole): ToolDef[] {
  return toolsForRole(role).map((t) => ({ type: "function", function: t.def }));
}

/** Human-readable summary of what the agent may access, for the system prompt. */
export function accessScopeSummary(role: WorkspaceRole): string {
  const allowed = toolsForRole(role);
  const denied = ALL_TOOLS.filter((t) => !roleAllows(role, t.minRole));
  const lines = [`The current user's workspace role is "${role}". You may ONLY use the tools listed below.`];
  lines.push("Allowed tools:");
  for (const t of allowed) lines.push(`- ${t.name}: ${t.scope}`);
  if (denied.length) {
    lines.push(
      `If the user asks for something requiring a higher privilege (${denied
        .map((t) => t.name)
        .join(", ")}), politely explain it's outside their access level and do not attempt it.`,
    );
  }
  return lines.join("\n");
}

/** Build an executor closure that enforces role at call time and runs the tool. */
export function buildExecutor(ctx: ToolContext) {
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = ALL_TOOLS.find((t) => t.name === name);
    if (!tool) return `ERROR: unknown tool "${name}".`;
    if (!roleAllows(ctx.userRole, tool.minRole)) {
      // Defense in depth: even if a tool leaked into the schema, refuse here.
      return `ACCESS DENIED: tool "${name}" requires role "${tool.minRole}"; the user is "${ctx.userRole}". Do not use this tool.`;
    }
    return await tool.run(args, ctx);
  };
}
