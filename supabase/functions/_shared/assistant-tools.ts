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
import { fetchFileContent, listRepoTree, getDefaultBranch, listUserRepos } from "./github.ts";
import { decryptSecret } from "./crypto.ts";
import { buildSdkInstall } from "./sdk-sources.ts";

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

// ===========================================================================
// CODE INSTRUMENTATION TOOLS — let the agent read a connected GitHub repo and
// PROPOSE changes (analytics events, feature flags, SDK install). Writes are
// never applied directly: each tool creates a *pending* admin_action that an
// owner/admin approves, after which execute-admin-action performs the GitHub
// write (PR by default). All gated to member+ (proposals) — execution itself
// is gated to owner/admin by the admin-action approval flow.
// ===========================================================================

interface RepoHandle {
  token: string;
  full_name: string;
  default_branch: string;
  repository_id: string | null;
  writable: boolean;
}

/** Resolve the project's GitHub connector → decrypted token + a target repo. */
async function resolveRepo(ctx: ToolContext, preferredFullName?: string): Promise<RepoHandle> {
  const { data: connector } = await ctx.admin
    .from("connectors")
    .select("id, permissions")
    .eq("workspace_id", ctx.workspaceId)
    .eq("project_id", ctx.projectId)
    .eq("provider", "github")
    .maybeSingle();
  if (!connector) throw new Error("GitHub is not connected for this project.");

  const { data: cred } = await ctx.admin
    .from("encrypted_credentials")
    .select("encrypted_payload, iv")
    .eq("connector_id", connector.id)
    .maybeSingle();
  if (!cred) throw new Error("GitHub credential missing.");
  const plaintext = await decryptSecret(cred.encrypted_payload, cred.iv);
  let token = plaintext;
  try {
    const parsed = JSON.parse(plaintext);
    token = parsed.token ?? parsed.secret_key ?? parsed.pat ?? plaintext;
  } catch {
    /* raw PAT */
  }

  // Pick the repo: caller preference, else the most recently scanned repo.
  let repoQuery = ctx.admin
    .from("repositories")
    .select("id, full_name, default_branch")
    .eq("project_id", ctx.projectId)
    .eq("provider", "github")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (preferredFullName) repoQuery = repoQuery.eq("full_name", preferredFullName) as typeof repoQuery;
  const { data: repo } = await repoQuery.maybeSingle();

  let full_name = preferredFullName ?? repo?.full_name ?? "";
  if (!full_name) throw new Error("No repository known for this project. Scan a repo first, or pass full_name as 'owner/repo'.");

  // A connected repo must be addressed as "owner/repo". If we only have the
  // short name (e.g. the repo was never scanned, or someone passed "dotmesh"),
  // resolve the full slug from the GitHub account the PAT belongs to.
  if (!full_name.includes("/")) {
    const short = full_name.toLowerCase();
    const repos = await listUserRepos(token).catch(() => []);
    const match =
      repos.find((r) => r.name.toLowerCase() === short) ??
      repos.find((r) => r.full_name.toLowerCase().endsWith(`/${short}`));
    if (!match) {
      throw new Error(
        `Could not resolve "${full_name}" to an owner/repo on the connected GitHub account. ` +
          `Pass full_name as "owner/repo" (e.g. "your-org/${short}").`,
      );
    }
    full_name = match.full_name;
  }

  const default_branch =
    (full_name === repo?.full_name ? repo?.default_branch : undefined) ??
    (await getDefaultBranch(token, full_name).catch(() => "main"));

  return {
    token,
    full_name,
    default_branch,
    repository_id: repo?.full_name === full_name ? repo?.id ?? null : null,
    writable: connector.permissions === "write_enabled",
  };
}

/** Create a pending code.apply_changes admin_action + an instrumentation audit row. */
async function proposeApply(
  ctx: ToolContext,
  repo: RepoHandle,
  opts: {
    changes: { path: string; content: string }[];
    commit_message: string;
    mode: "pull_request" | "direct";
    pr_title?: string;
    pr_body?: string;
    instrumentation: {
      kind: "event" | "journey" | "feature_flag" | "sdk_install" | "custom";
      event_definition_id?: string | null;
      journey_id?: string | null;
      nl_spec?: string;
      plan?: Record<string, unknown>;
    };
  },
): Promise<{ action_id: string; instrumentation_id: string }> {
  const payload = {
    full_name: repo.full_name,
    base_branch: repo.default_branch,
    mode: opts.mode,
    commit_message: opts.commit_message,
    pr_title: opts.pr_title,
    pr_body: opts.pr_body,
    changes: opts.changes,
  };

  const { data: action, error: aErr } = await ctx.admin
    .from("admin_actions")
    .insert({
      workspace_id: ctx.workspaceId,
      project_id: ctx.projectId,
      actor_user_id: ctx.userId,
      action_type: "code.apply_changes",
      target_type: "github_repo",
      target_id: repo.full_name,
      payload,
      status: "pending",
      risk_level: "high",
      requires_approval: true,
    })
    .select("id")
    .single();
  if (aErr || !action) throw new Error(`Could not create pending action: ${aErr?.message}`);

  const { data: instr } = await ctx.admin
    .from("analytics_instrumentation")
    .insert({
      workspace_id: ctx.workspaceId,
      project_id: ctx.projectId,
      kind: opts.instrumentation.kind,
      event_definition_id: opts.instrumentation.event_definition_id ?? null,
      journey_id: opts.instrumentation.journey_id ?? null,
      repository_id: repo.repository_id,
      full_name: repo.full_name,
      targets: opts.changes.map((c) => ({ path: c.path })),
      admin_action_id: action.id,
      status: "proposed",
      nl_spec: opts.instrumentation.nl_spec ?? null,
      plan: opts.instrumentation.plan ?? {},
      created_by: ctx.userId,
    })
    .select("id")
    .single();

  return { action_id: action.id, instrumentation_id: instr?.id ?? "" };
}

const listEventDefinitions: AssistantTool = {
  name: "list_event_definitions",
  minRole: "member",
  scope: "List the analytics events already defined in the FounderOS UI (taxonomy).",
  def: {
    name: "list_event_definitions",
    description:
      "List the analytics event definitions configured for THIS project in the FounderOS UI (Events catalog): event_name, display_name, category, whether it is a key action, value_type, declared property_schema, and instrumentation_status. ALWAYS prefer instrumenting THESE existing events over inventing new ones. Use before instrument_event so the code emits the exact event_name + properties the user already defined.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async (_args, ctx) => {
    const { data } = await ctx.admin
      .from("event_definitions")
      .select("event_name, display_name, category, is_key_action, value_type, property_schema, description, instrumentation_status")
      .eq("project_id", ctx.projectId)
      .order("is_key_action", { ascending: false })
      .order("event_name", { ascending: true });
    if (!data || data.length === 0) {
      return "No event definitions yet. The user can define them in SaaS Analytics → Events, or you can create them with define_custom_event.";
    }
    return JSON.stringify({ count: data.length, events: data });
  },
};

const listFeatureFlags: AssistantTool = {
  name: "list_feature_flags",
  minRole: "member",
  scope: "List the feature flags already defined in the FounderOS UI.",
  def: {
    name: "list_feature_flags",
    description:
      "List the feature flags configured for THIS project in FounderOS: flag_key, enabled, rollout_percent, description, variants, whether they're already instrumented, and target_email (null = project-wide). ALWAYS prefer gating code behind THESE existing flags (use the exact flag_key) over inventing new ones. The SDK reads flag state at runtime via analytics.isFeatureEnabled(flag_key).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async (_args, ctx) => {
    const { data } = await ctx.admin
      .from("feature_flags")
      .select("flag_key, enabled, rollout_percent, description, variants, instrumented, target_email")
      .eq("project_id", ctx.projectId)
      .order("flag_key", { ascending: true });
    if (!data || data.length === 0) {
      return "No feature flags yet. The user can define them, or you can create one with add_feature_flag.";
    }
    // Collapse per-user overrides into a readable shape.
    return JSON.stringify({ count: data.length, flags: data });
  },
};

const analyzeRepoStructure: AssistantTool = {
  name: "analyze_repo_structure",
  minRole: "member",
  scope: "Analyze the target repo (scan + app structure) before instrumenting.",
  def: {
    name: "analyze_repo_structure",
    description:
      "Return a structured analysis of the connected repo to plan analytics instrumentation: detected framework/stack, third-party services, and the app structure (pages, routes, interactive elements like buttons/forms/links with their labels) from the latest code scan. Also reports whether the FounderOS analytics SDK is already installed. ALWAYS call this (and read_repo_file on the key files it surfaces) BEFORE proposing SDK install or tracking — never instrument blind.",
    parameters: {
      type: "object",
      properties: {
        full_name: { type: "string", description: "Optional owner/repo override." },
      },
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const repo = await resolveRepo(ctx, str(args.full_name) || undefined);

    // Latest scan for this project (architecture, services, app_structure).
    const { data: scan } = await ctx.admin
      .from("scan_results")
      .select("summary, services, architecture, app_structure, dependencies, created_at, repositories(full_name)")
      .eq("project_id", ctx.projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Events + feature flags defined in the FounderOS UI — the agent must reuse these.
    const [{ data: defs }, { data: flags }] = await Promise.all([
      ctx.admin
        .from("event_definitions")
        .select("event_name, display_name, category, is_key_action, value_type, property_schema, instrumentation_status")
        .eq("project_id", ctx.projectId)
        .order("is_key_action", { ascending: false }),
      ctx.admin
        .from("feature_flags")
        .select("flag_key, enabled, rollout_percent, description, instrumented, target_email")
        .eq("project_id", ctx.projectId),
    ]);
    const definedEvents = defs ?? [];
    const definedFlags = flags ?? [];

    // Is the analytics SDK already in the tree? (cheap check on the file list)
    let sdkInstalled = false;
    let hint = "";
    try {
      const tree = await listRepoTree(repo.token, repo.full_name, repo.default_branch);
      sdkInstalled = tree.some((p) => /founderos\.(ts|js)$/.test(p) || /(^|\/)analytics\.(ts|js)$/.test(p));
    } catch {
      hint = "Could not list the repo tree (token scope?). Use read_repo_file on specific paths.";
    }

    if (!scan) {
      return JSON.stringify({
        repo: repo.full_name,
        default_branch: repo.default_branch,
        writable: repo.writable,
        sdk_installed: sdkInstalled,
        defined_events: definedEvents,
        defined_feature_flags: definedFlags,
        scan: null,
        note:
          "No code scan found. Run a scan from Code → Repositories for a richer analysis, " +
          "or use list_repo_files + read_repo_file to inspect the code directly. " +
          "Instrument the defined_events above (exact event_name) and gate code behind defined_feature_flags. " + hint,
      });
    }

    const appStructure = (scan as any).app_structure ?? { pages: [], routes: [], element_count: 0 };
    // Surface likely instrumentation targets from page/element labels.
    const KEY_HINTS = /(sign\s?up|signin|log\s?in|register|checkout|subscribe|upgrade|pay|purchase|buy|onboard|invite|create|start|trial)/i;
    const candidates: Array<{ page: string; path: string; element: string; suggested_event: string }> = [];
    for (const pg of appStructure.pages ?? []) {
      for (const el of pg.elements ?? []) {
        const label = String(el.label ?? "");
        if (KEY_HINTS.test(label) || KEY_HINTS.test(pg.name ?? "")) {
          candidates.push({
            page: pg.name,
            path: pg.path,
            element: `${el.type}: ${label}`.slice(0, 80),
            suggested_event: label
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "_")
              .replace(/^_|_$/g, "")
              .slice(0, 40) || "cta_click",
          });
        }
      }
    }

    return JSON.stringify({
      repo: repo.full_name,
      default_branch: repo.default_branch,
      writable: repo.writable,
      sdk_installed: sdkInstalled,
      stack: {
        frontend: (scan as any).architecture?.frontend ?? (scan as any).summary?.detected_frontend ?? null,
        backend: (scan as any).architecture?.backend ?? (scan as any).summary?.backend_framework ?? null,
      },
      services: (scan as any).services ?? [],
      routes: (appStructure.routes ?? []).slice(0, 40),
      pages: (appStructure.pages ?? [])
        .slice(0, 25)
        .map((p: any) => ({ name: p.name, path: p.path, elements: (p.elements ?? []).slice(0, 12) })),
      // Reuse these — the user already defined them in the FounderOS UI.
      defined_events: definedEvents,
      defined_feature_flags: definedFlags,
      instrumentation_candidates: candidates.slice(0, 30),
      next_steps:
        "Map each defined_event to the right page/call-site and emit it with the EXACT event_name (analytics.track or data-fos-event). " +
        "Gate features page-by-page behind defined_feature_flags using analytics.isFeatureEnabled(flag_key). " +
        "Read candidate files with read_repo_file, install_sdk if not installed, then propose changes (full file content) via instrument_event / add_feature_flag / propose_code_changes.",
    });
  },
};

const readRepoFile: AssistantTool = {
  name: "read_repo_file",
  minRole: "member",
  scope: "Read a file from the connected GitHub repo (to plan instrumentation).",
  def: {
    name: "read_repo_file",
    description:
      "Read the content of a file from the project's connected GitHub repository. Use to inspect code before proposing changes. Returns up to ~16k chars.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path, e.g. 'src/main.tsx'." },
        full_name: { type: "string", description: "Optional owner/repo override." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const repo = await resolveRepo(ctx, str(args.full_name) || undefined);
    const path = str(args.path);
    if (!path) return "ERROR: path is required.";
    const content = await fetchFileContent(repo.token, repo.full_name, repo.default_branch, path);
    if (content === null) return `File not found: ${path}`;
    return content.slice(0, 16000);
  },
};

const listRepoFiles: AssistantTool = {
  name: "list_repo_files",
  minRole: "member",
  scope: "List files in the connected GitHub repo (to locate where to instrument).",
  def: {
    name: "list_repo_files",
    description:
      "List file paths in the project's connected GitHub repository (default branch). Optionally filter by a path prefix or substring. Use to find where to add tracking/flags/SDK.",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional substring to filter paths (e.g. 'src/', '.tsx')." },
        full_name: { type: "string", description: "Optional owner/repo override." },
        limit: { type: "number", description: "Max paths to return (default 200, max 800)." },
      },
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const repo = await resolveRepo(ctx, str(args.full_name) || undefined);
    const all = await listRepoTree(repo.token, repo.full_name, repo.default_branch);
    const filter = str(args.filter).toLowerCase();
    const limit = Math.min(Math.max(Number(args.limit ?? 200) || 200, 1), 800);
    const filtered = filter ? all.filter((p) => p.toLowerCase().includes(filter)) : all;
    return JSON.stringify({ repo: repo.full_name, count: filtered.length, paths: filtered.slice(0, limit) });
  },
};

const PROPOSE_CHANGES_NOTE =
  "Each file change must be the FULL new content of that file (not a diff). Read the file first with read_repo_file when modifying existing code.";

const proposeCodeChanges: AssistantTool = {
  name: "propose_code_changes",
  minRole: "member",
  scope: "Propose file changes to the GitHub repo (pending owner/admin approval).",
  def: {
    name: "propose_code_changes",
    description:
      `Propose one or more file changes to the connected GitHub repo. This does NOT write immediately — it creates a PENDING change that an owner/admin must approve, then a pull request (default) or direct commit is created. ${PROPOSE_CHANGES_NOTE}`,
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Short human summary of what this change does." },
        commit_message: { type: "string", description: "Git commit message." },
        mode: { type: "string", enum: ["pull_request", "direct"], description: "Default pull_request (safer)." },
        changes: {
          type: "array",
          description: "Files to write. Each is the full new content.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        full_name: { type: "string", description: "Optional owner/repo override." },
      },
      required: ["summary", "commit_message", "changes"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const repo = await resolveRepo(ctx, str(args.full_name) || undefined);
    const changes = Array.isArray(args.changes) ? (args.changes as { path: string; content: string }[]) : [];
    if (changes.length === 0) return "ERROR: changes must be a non-empty array.";
    const mode = args.mode === "direct" ? "direct" : "pull_request";
    const summary = str(args.summary, "Code changes");
    const { action_id } = await proposeApply(ctx, repo, {
      changes,
      commit_message: str(args.commit_message, summary),
      mode,
      pr_title: summary,
      pr_body: `${summary}\n\nProposed by the FounderOS agent.`,
      instrumentation: { kind: "custom", nl_spec: summary, plan: { files: changes.map((c) => c.path) } },
    });
    return `Proposed ${changes.length} file change(s) on ${repo.full_name} as a ${mode} (pending approval, action_id=${action_id}). ${
      repo.writable ? "" : "NOTE: the GitHub connector is read-only; an admin must enable write access before approval can apply it."
    }`;
  },
};

const defineCustomEvent: AssistantTool = {
  name: "define_custom_event",
  minRole: "member",
  scope: "Create/refine a custom analytics event from a natural-language description.",
  def: {
    name: "define_custom_event",
    description:
      "Define a custom analytics event in the project's taxonomy from a natural-language description. Creates/updates an event_definition (name, display name, category, property schema, value type, advanced config). Does NOT touch code — pair with instrument_event to add tracking calls.",
    parameters: {
      type: "object",
      properties: {
        event_name: { type: "string", description: "Stable snake_case event name, e.g. 'checkout_completed'." },
        display_name: { type: "string" },
        description: { type: "string", description: "What the event means / when it fires." },
        nl_spec: { type: "string", description: "The user's natural-language request, kept for traceability." },
        category: {
          type: "string",
          enum: ["product", "lifecycle", "revenue", "marketing", "system", "custom"],
        },
        value_type: { type: "string", enum: ["none", "count", "sum", "duration", "revenue"] },
        is_key_action: { type: "boolean", description: "Whether this is an activation/key action." },
        property_schema: {
          type: "array",
          description: "Declared properties: [{ key, type, required? }].",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              type: { type: "string" },
              required: { type: "boolean" },
            },
            required: ["key", "type"],
            additionalProperties: false,
          },
        },
        config: { description: "Advanced config object (unit, currency, dedupe_window_s, sampling, alias[]...)." },
      },
      required: ["event_name", "description"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const event_name = str(args.event_name).trim();
    if (!/^[a-z][a-z0-9_]*$/.test(event_name)) {
      return "ERROR: event_name must be snake_case (lowercase letters, digits, underscores).";
    }
    const row = {
      workspace_id: ctx.workspaceId,
      project_id: ctx.projectId,
      event_name,
      display_name: str(args.display_name) || event_name,
      description: str(args.description),
      nl_spec: str(args.nl_spec) || null,
      category: str(args.category, "custom"),
      value_type: str(args.value_type, "count"),
      is_key_action: Boolean(args.is_key_action),
      property_schema: Array.isArray(args.property_schema) ? args.property_schema : [],
      config: args.config && typeof args.config === "object" ? args.config : {},
      created_by: ctx.userId,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await ctx.admin
      .from("event_definitions")
      .upsert(row, { onConflict: "project_id,event_name" })
      .select("id, event_name")
      .single();
    if (error) return `ERROR: could not save event definition: ${error.message}`;
    return JSON.stringify({ ok: true, event_definition_id: data.id, event_name: data.event_name });
  },
};

const instrumentEvent: AssistantTool = {
  name: "instrument_event",
  minRole: "member",
  scope: "Propose code changes that emit an analytics event (pending approval).",
  def: {
    name: "instrument_event",
    description:
      `Propose code changes that INSTRUMENT an analytics event using the FounderOS SDK (fos.track('event_name', { ... })) at the right place(s) in the connected repo. Creates a pending change (PR by default) for owner/admin approval, and links it to the event definition. ${PROPOSE_CHANGES_NOTE} Call define_custom_event first if the event isn't defined yet.`,
    parameters: {
      type: "object",
      properties: {
        event_name: { type: "string", description: "The event to emit (should match an event definition)." },
        nl_spec: { type: "string", description: "Natural-language description of when/where to track it." },
        commit_message: { type: "string" },
        mode: { type: "string", enum: ["pull_request", "direct"] },
        changes: {
          type: "array",
          description: "Full new content of each file that emits the event.",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        full_name: { type: "string" },
      },
      required: ["event_name", "changes"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const repo = await resolveRepo(ctx, str(args.full_name) || undefined);
    const event_name = str(args.event_name);
    const changes = Array.isArray(args.changes) ? (args.changes as { path: string; content: string }[]) : [];
    if (!event_name) return "ERROR: event_name is required.";
    if (changes.length === 0) return "ERROR: changes must be a non-empty array.";

    // Link to an existing event definition if present.
    const { data: def } = await ctx.admin
      .from("event_definitions")
      .select("id")
      .eq("project_id", ctx.projectId)
      .eq("event_name", event_name)
      .maybeSingle();

    const mode = args.mode === "direct" ? "direct" : "pull_request";
    const summary = `Instrument analytics event '${event_name}'`;
    const { action_id } = await proposeApply(ctx, repo, {
      changes,
      commit_message: str(args.commit_message, summary),
      mode,
      pr_title: summary,
      pr_body: `${summary}\n\n${str(args.nl_spec)}\n\nProposed by the FounderOS agent.`,
      instrumentation: {
        kind: "event",
        event_definition_id: def?.id ?? null,
        nl_spec: str(args.nl_spec),
        plan: { event_name, files: changes.map((c) => c.path) },
      },
    });

    if (def?.id) {
      await ctx.admin.from("event_definitions").update({ instrumentation_status: "proposed" }).eq("id", def.id);
    }
    return `Proposed instrumentation for '${event_name}' on ${repo.full_name} (${mode}, pending approval, action_id=${action_id}).`;
  },
};

const addFeatureFlag: AssistantTool = {
  name: "add_feature_flag",
  minRole: "member",
  scope: "Create a feature flag and propose gating code (pending approval).",
  def: {
    name: "add_feature_flag",
    description:
      `Create/update a feature flag and propose the code that gates a feature behind it. Creates the feature_flag config row immediately and a PENDING code change (PR by default) for the gating logic. ${PROPOSE_CHANGES_NOTE}`,
    parameters: {
      type: "object",
      properties: {
        flag_key: { type: "string", description: "snake_case flag key, e.g. 'new_onboarding'." },
        description: { type: "string" },
        enabled: { type: "boolean", description: "Default enabled state (default false)." },
        rollout_percent: { type: "number", description: "0-100 rollout (default 100)." },
        changes: {
          type: "array",
          description: "Full new content of each file that reads the flag. Omit to only create the flag config.",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        full_name: { type: "string" },
      },
      required: ["flag_key"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const flag_key = str(args.flag_key).trim();
    if (!/^[a-z][a-z0-9_]*$/.test(flag_key)) return "ERROR: flag_key must be snake_case.";
    const enabled = Boolean(args.enabled);
    const rollout = Math.min(Math.max(Number(args.rollout_percent ?? 100) || 100, 0), 100);

    const { error: fErr } = await ctx.admin.from("feature_flags").upsert(
      {
        workspace_id: ctx.workspaceId,
        project_id: ctx.projectId,
        flag_key,
        target_email: null,
        enabled,
        description: str(args.description) || null,
        rollout_percent: rollout,
      },
      { onConflict: "project_id,flag_key,target_email" },
    );
    if (fErr) return `ERROR: could not save feature flag: ${fErr.message}`;

    const changes = Array.isArray(args.changes) ? (args.changes as { path: string; content: string }[]) : [];
    if (changes.length === 0) {
      return JSON.stringify({ ok: true, flag_key, enabled, rollout_percent: rollout, code_change: "none (config only)" });
    }
    const repo = await resolveRepo(ctx, str(args.full_name) || undefined);
    const summary = `Add feature flag '${flag_key}' gating`;
    const { action_id } = await proposeApply(ctx, repo, {
      changes,
      commit_message: summary,
      mode: "pull_request",
      pr_title: summary,
      pr_body: `${summary}\n\nProposed by the FounderOS agent.`,
      instrumentation: { kind: "feature_flag", nl_spec: str(args.description), plan: { flag_key, files: changes.map((c) => c.path) } },
    });
    await ctx.admin.from("feature_flags").update({ instrumented: true }).eq("project_id", ctx.projectId).eq("flag_key", flag_key);
    return `Feature flag '${flag_key}' created and gating change proposed on ${repo.full_name} (pending approval, action_id=${action_id}).`;
  },
};

const installSdk: AssistantTool = {
  name: "install_sdk",
  minRole: "member",
  scope: "Propose installing the REAL FounderOS analytics/RAG SDK in the repo (pending approval).",
  def: {
    name: "install_sdk",
    description:
      "Propose installing a FounderOS SDK in the connected repo. The SDK file content is INJECTED BY THE SERVER from the canonical source — you must NOT invent SDK code, a git URL, or an API. You only choose: which SDK ('analytics' tracking/session-replay, or 'rag' agent widget), the runtime ('browser' or 'server'), where to put it (lib_dir), and which env expression holds the key. The server returns the real files; a PENDING pull request is created for approval. " +
      "Optionally pass `extra_changes` for additional call sites you wrote yourself (e.g. importing `analytics` and calling analytics.track(...) — full file content, not a diff). " +
      "Important: there is NO `founderos.configure(api_key, api_secret)` API and NO `git clone founderos/sdk` — auth uses a single `fos_` API key (server) or anon key + workspaceId (browser).",
    parameters: {
      type: "object",
      properties: {
        sdk: { type: "string", enum: ["analytics", "rag"], description: "Which SDK to install." },
        runtime: { type: "string", enum: ["browser", "server"], description: "Target runtime (analytics)." },
        lib_dir: { type: "string", description: "Repo-relative dir for the SDK + init module. Default 'src/lib'." },
        anon_key_expr: {
          type: "string",
          description: "Browser: code expression for the anon key, e.g. 'import.meta.env.VITE_SUPABASE_ANON_KEY'.",
        },
        api_key_expr: {
          type: "string",
          description: "Server: code expression for the API key, e.g. 'process.env.FOUNDEROS_API_KEY!'.",
        },
        extra_changes: {
          type: "array",
          description: "Optional additional files you author (call sites). Full new content each.",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        full_name: { type: "string" },
      },
      required: ["sdk"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const sdk = str(args.sdk);
    if (sdk !== "analytics" && sdk !== "rag") return "ERROR: sdk must be 'analytics' or 'rag'.";
    const runtime = str(args.runtime) === "server" ? "server" : "browser";
    const repo = await resolveRepo(ctx, str(args.full_name) || undefined);

    // Resolve host/projectId from the project's Supabase config so the init
    // module is wired correctly. Host comes from env; project_id is the cockpit id.
    const host = Deno.env.get("SUPABASE_URL") ?? "https://<your-project>.supabase.co";

    // RAG installs need the agent's public key — the widget refuses to boot
    // without it. Use the project's most recent agent.
    let agentPublicKey: string | undefined;
    let agentWelcome: string | undefined;
    if (sdk === "rag") {
      const { data: ragAgent } = await ctx.admin
        .from("rag_agents")
        .select("public_key, welcome_message")
        .eq("project_id", ctx.projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!ragAgent) {
        return "ERROR: this project has no RAG agent yet — create one in RAG Agent → Agents before installing the widget.";
      }
      agentPublicKey = (ragAgent as { public_key?: string }).public_key ?? undefined;
      agentWelcome = (ragAgent as { welcome_message?: string }).welcome_message ?? undefined;
    }

    const { files, notes } = buildSdkInstall({
      sdk,
      runtime,
      host,
      projectId: ctx.projectId,
      workspaceId: ctx.workspaceId,
      libDir: str(args.lib_dir) || undefined,
      anonKeyExpr: str(args.anon_key_expr) || undefined,
      apiKeyExpr: str(args.api_key_expr) || undefined,
      agentPublicKey,
      agentWelcome,
    });

    // Append any author-provided call sites (validated shape).
    const extra = Array.isArray(args.extra_changes)
      ? (args.extra_changes as { path: string; content: string }[]).filter(
          (c) => c && typeof c.path === "string" && typeof c.content === "string",
        )
      : [];
    const changes = [...files, ...extra];

    const summary = `Install FounderOS ${sdk} SDK (${runtime})`;
    const { action_id } = await proposeApply(ctx, repo, {
      changes,
      commit_message: summary,
      mode: "pull_request",
      pr_title: summary,
      pr_body: `${summary}\n\n${notes}\n\nProposed by the FounderOS agent. SDK content is the canonical FounderOS source.`,
      instrumentation: { kind: "sdk_install", nl_spec: notes, plan: { sdk, runtime, files: changes.map((c) => c.path) } },
    });
    return `Proposed ${sdk} SDK install (${runtime}) on ${repo.full_name}: ${changes
      .map((c) => c.path)
      .join(", ")} — pending approval (action_id=${action_id}). ${notes}`;
  },
};

const defineJourney: AssistantTool = {
  name: "define_journey",
  minRole: "member",
  scope: "Define a user journey (ordered events) for analytics.",
  def: {
    name: "define_journey",
    description:
      "Define a user journey to track: an ordered sequence of events (e.g. landing → signup → activation → purchase) from a natural-language description. Creates an analytics_journey config. Pair with instrument_event for each step that isn't yet emitted.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        nl_spec: { type: "string", description: "Natural-language description of the journey." },
        steps: {
          type: "array",
          description: "Ordered steps: [{ event_name, label, optional? }].",
          items: {
            type: "object",
            properties: {
              event_name: { type: "string" },
              label: { type: "string" },
              optional: { type: "boolean" },
            },
            required: ["event_name"],
            additionalProperties: false,
          },
        },
      },
      required: ["name", "steps"],
      additionalProperties: false,
    },
  },
  run: async (args, ctx) => {
    const name = str(args.name);
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (!name || steps.length === 0) return "ERROR: name and a non-empty steps array are required.";
    const { data, error } = await ctx.admin
      .from("analytics_journeys")
      .insert({
        workspace_id: ctx.workspaceId,
        project_id: ctx.projectId,
        name,
        description: str(args.description) || null,
        nl_spec: str(args.nl_spec) || null,
        steps,
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (error) return `ERROR: could not save journey: ${error.message}`;
    return JSON.stringify({ ok: true, journey_id: data.id, name, step_count: steps.length });
  },
};

// ---------------------------------------------------------------------------

// Supply-chain copilot tool — lets the navbar assistant answer supply questions
// (stock health, OTIF/fill rate, open POs, shipment delays, exceptions, carbon).
const supplyOverview: AssistantTool = {
  name: "get_supply_overview",
  minRole: "viewer",
  scope: "Supply chain & logistics: stock health, orders, shipments, exceptions, KPIs.",
  def: {
    name: "get_supply_overview",
    description:
      "Return a snapshot of the project's supply chain: low/out-of-stock items, expiring batches, open purchase orders, sales-order OTIF/fill-rate, in-transit/delayed shipments, carbon, and open control-tower exceptions. Use for ANY supply chain, inventory, procurement, logistics, OTIF, fill rate, stockout, shipment or supplier question.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async (_args, ctx) => {
    const pid = ctx.projectId;
    const [items, batches, pos, so, ship, exc, suppliers] = await Promise.all([
      ctx.admin.from("sc_inventory_items").select("name, sku, quantity, reorder_point, safety_stock, unit_cost_cents").eq("project_id", pid).limit(500),
      ctx.admin.from("sc_batches").select("lot_code, quantity, expiry_date, item_id").eq("project_id", pid).not("expiry_date", "is", null).order("expiry_date", { ascending: true }).limit(50),
      ctx.admin.from("sc_purchase_orders").select("reference, status, total_cents, expected_at").eq("project_id", pid).limit(500),
      ctx.admin.from("sc_sales_orders").select("status, promised_at, delivered_at").eq("project_id", pid).limit(1000),
      ctx.admin.from("sc_shipments").select("reference, status, carrier, eta, carbon_kg, delay_risk").eq("project_id", pid).limit(500),
      ctx.admin.from("sc_exceptions").select("kind, severity, title, detail").eq("project_id", pid).eq("resolved", false).order("severity", { ascending: false }).limit(50),
      ctx.admin.from("sc_suppliers").select("name, reliability, lead_time_days, status").eq("project_id", pid).limit(200),
    ]);
    const it = items.data ?? [];
    const lowStock = it.filter((x: any) => x.quantity <= Math.max(x.reorder_point, x.safety_stock));
    const stockValue = it.reduce((s: number, x: any) => s + x.quantity * x.unit_cost_cents, 0) / 100;
    const orders = so.data ?? [];
    const delivered = orders.filter((o: any) => o.status === "delivered");
    const onTimeInFull = delivered.filter((o: any) => o.promised_at && o.delivered_at && new Date(o.delivered_at) <= new Date(o.promised_at + "T23:59:59"));
    const otif = delivered.length ? Math.round((onTimeInFull.length / delivered.length) * 100) : null;
    const openPo = (pos.data ?? []).filter((p: any) => !["received", "cancelled"].includes(p.status));
    const overduePo = openPo.filter((p: any) => p.expected_at && new Date(p.expected_at) < new Date());
    const shipments = ship.data ?? [];
    const inTransit = shipments.filter((s: any) => s.status === "in_transit");
    const delayed = shipments.filter((s: any) => s.status === "delayed" || s.delay_risk === "high");
    const carbon = shipments.reduce((s: number, x: any) => s + (Number(x.carbon_kg) || 0), 0);
    const soon = (batches.data ?? []).filter((b: any) => b.expiry_date && new Date(b.expiry_date) < new Date(Date.now() + 30 * 864e5));

    return JSON.stringify({
      kpis: {
        stock_value_eur: Math.round(stockValue),
        low_or_out_of_stock: lowStock.length,
        otif_percent: otif,
        open_purchase_orders: openPo.length,
        overdue_purchase_orders: overduePo.length,
        shipments_in_transit: inTransit.length,
        shipments_delayed: delayed.length,
        carbon_kg_total: Math.round(carbon),
        suppliers: (suppliers.data ?? []).length,
        open_exceptions: (exc.data ?? []).length,
      },
      low_stock: lowStock.slice(0, 25).map((x: any) => ({ name: x.name, sku: x.sku, qty: x.quantity, reorder: x.reorder_point, safety: x.safety_stock })),
      expiring_soon: soon.slice(0, 15).map((b: any) => ({ lot: b.lot_code, qty: b.quantity, expiry: b.expiry_date })),
      overdue_pos: overduePo.slice(0, 15).map((p: any) => ({ ref: p.reference, status: p.status, due: p.expected_at })),
      delayed_shipments: delayed.slice(0, 15).map((s: any) => ({ ref: s.reference, carrier: s.carrier, eta: s.eta, risk: s.delay_risk })),
      exceptions: (exc.data ?? []).slice(0, 25),
      worst_suppliers: (suppliers.data ?? []).filter((s: any) => s.reliability < 85).slice(0, 10),
    });
  },
};

// Finance copilot — AP/AR, treasury, profitability signals for the assistant.
const financeOverview: AssistantTool = {
  name: "get_finance_overview",
  minRole: "viewer",
  scope: "Finance: AR/AP, cash, overdue, margin signals.",
  def: {
    name: "get_finance_overview",
    description:
      "Return the project's finance snapshot: accounts receivable (invoices: outstanding, overdue), accounts payable (bills: due, 3-way match exceptions), cash position across bank accounts, and expenses. Use for ANY finance, invoice, bill, payment, cash, treasury, margin, AR/AP or 'why did my margin/cash change' question.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async (_args, ctx) => {
    const pid = ctx.projectId;
    const [inv, bills, exp, accts] = await Promise.all([
      ctx.admin.from("fin_invoices").select("status, amount_cents, due_date, client_name").eq("project_id", pid).limit(1000),
      ctx.admin.from("fin_bills").select("status, amount_cents, due_date, match_status, vendor").eq("project_id", pid).limit(1000),
      ctx.admin.from("fin_expenses").select("status, amount_cents, category").eq("project_id", pid).limit(1000),
      ctx.admin.from("fin_bank_accounts").select("name, balance_cents").eq("project_id", pid).limit(100),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const invoices = inv.data ?? [];
    const ar = invoices.filter((i: any) => !["paid", "void"].includes(i.status));
    const arOverdue = ar.filter((i: any) => i.due_date && i.due_date < today);
    const apRows = bills.data ?? [];
    const ap = apRows.filter((b: any) => !["paid", "void"].includes(b.status));
    const cash = (accts.data ?? []).reduce((s: number, a: any) => s + (a.balance_cents || 0), 0);
    const c = (n: number) => Math.round(n / 100);
    return JSON.stringify({
      accounts_receivable_eur: c(ar.reduce((s: number, i: any) => s + i.amount_cents, 0)),
      ar_overdue_eur: c(arOverdue.reduce((s: number, i: any) => s + i.amount_cents, 0)),
      ar_overdue_count: arOverdue.length,
      accounts_payable_eur: c(ap.reduce((s: number, b: any) => s + b.amount_cents, 0)),
      ap_match_exceptions: apRows.filter((b: any) => b.match_status === "exception").length,
      cash_eur: c(cash),
      expenses_pending: (exp.data ?? []).filter((e: any) => e.status === "pending").length,
      top_overdue: arOverdue.slice(0, 8).map((i: any) => ({ client: i.client_name, amount_eur: c(i.amount_cents), due: i.due_date })),
    });
  },
};

// Project (PSA) copilot — delivery, timesheets, resourcing, profitability.
const projectOverview: AssistantTool = {
  name: "get_project_overview",
  minRole: "viewer",
  scope: "Projects/PSA: boards, timesheets, resourcing, profitability.",
  def: {
    name: "get_project_overview",
    description:
      "Return the project's PSA snapshot: active boards/projects & their status, logged vs billable hours, resource over-allocation (utilization), and per-project margin (billed vs cost). Use for ANY project, delivery, timesheet, resourcing, capacity, utilization, over-allocation, deadline or project-margin question.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async (_args, ctx) => {
    const pid = ctx.projectId;
    const [boards, ts, res, alloc] = await Promise.all([
      ctx.admin.from("pm_projects").select("id, name, status, due_date").eq("project_id", pid).limit(200),
      ctx.admin.from("psa_timesheets").select("hours, billable, pm_project_id, resource_id").eq("project_id", pid).limit(3000),
      ctx.admin.from("psa_resources").select("id, name, cost_rate_cents, bill_rate_cents, capacity_hours_week").eq("project_id", pid).limit(300),
      ctx.admin.from("psa_allocations").select("resource_id, week_start, hours").eq("project_id", pid).limit(3000),
    ]);
    const resById: Record<string, any> = Object.fromEntries((res.data ?? []).map((r: any) => [r.id, r]));
    const tsRows = ts.data ?? [];
    const hours = tsRows.reduce((s: number, t: any) => s + Number(t.hours), 0);
    const billableH = tsRows.filter((t: any) => t.billable).reduce((s: number, t: any) => s + Number(t.hours), 0);
    // Per-week utilization → over-allocated resources.
    const wk: Record<string, number> = {};
    for (const a of (alloc.data ?? [])) wk[`${a.resource_id}|${a.week_start}`] = (wk[`${a.resource_id}|${a.week_start}`] ?? 0) + Number(a.hours);
    const over = Object.entries(wk).filter(([k, h]) => { const rid = k.split("|")[0]; const cap = resById[rid]?.capacity_hours_week ?? 35; return h > cap; })
      .map(([k, h]) => ({ resource: resById[k.split("|")[0]]?.name ?? "?", week: k.split("|")[1], hours: h }));
    // Per-project margin.
    const margins = (boards.data ?? []).map((b: any) => {
      const rows = tsRows.filter((t: any) => t.pm_project_id === b.id);
      const cost = rows.reduce((s: number, t: any) => s + Number(t.hours) * ((resById[t.resource_id]?.cost_rate_cents ?? 0) / 8), 0);
      const billed = rows.filter((t: any) => t.billable).reduce((s: number, t: any) => s + Number(t.hours) * ((resById[t.resource_id]?.bill_rate_cents ?? 0) / 8), 0);
      return { project: b.name, status: b.status, margin_eur: Math.round((billed - cost) / 100), billed_eur: Math.round(billed / 100) };
    });
    return JSON.stringify({
      projects: (boards.data ?? []).length,
      hours_logged: hours,
      billable_pct: hours ? Math.round((billableH / hours) * 100) : 0,
      over_allocated: over.slice(0, 10),
      project_margins: margins.slice(0, 15),
    });
  },
};

// Support copilot — tickets, SLA, resolution rate, CSAT.
const supportOverview: AssistantTool = {
  name: "get_support_overview",
  minRole: "viewer",
  scope: "Support: tickets, backlog, autonomous resolution rate, CSAT.",
  def: {
    name: "get_support_overview",
    description:
      "Return the project's support snapshot: open/backlog tickets, autonomous (AI) resolution rate, escalations, average CSAT and recent tickets. Use for ANY support, ticket, helpdesk, SLA, CSAT or 'how is support doing' question.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async (_args, ctx) => {
    const { data } = await ctx.admin
      .from("support_tickets").select("status, resolution, csat, subject, created_at").eq("project_id", ctx.projectId).limit(1000);
    const t = data ?? [];
    const open = t.filter((x: any) => !["resolved", "closed"].includes(x.status));
    const resolved = t.filter((x: any) => x.resolution);
    const aiResolved = t.filter((x: any) => x.resolution === "ai_resolved");
    const escalated = t.filter((x: any) => x.resolution === "escalated");
    const csats = t.filter((x: any) => typeof x.csat === "number").map((x: any) => x.csat);
    return JSON.stringify({
      total: t.length, open: open.length,
      autonomous_resolution_rate: resolved.length ? Math.round((aiResolved.length / resolved.length) * 100) : null,
      escalations: escalated.length,
      avg_csat: csats.length ? Math.round((csats.reduce((s: number, n: number) => s + n, 0) / csats.length) * 10) / 10 : null,
      recent_open: open.slice(0, 10).map((x: any) => ({ subject: x.subject, status: x.status })),
    });
  },
};

// CRM copilot — pipeline, lead scores, at-risk deals.
const crmOverview: AssistantTool = {
  name: "get_crm_overview",
  minRole: "viewer",
  scope: "CRM: pipeline value, lead scores, at-risk deals, stale activity.",
  def: {
    name: "get_crm_overview",
    description:
      "Return the project's CRM snapshot: open pipeline value & stages, top-scored leads, at-risk deals, and stale (no recent activity) deals. Use for ANY CRM, sales, pipeline, deal, lead-scoring or forecast question.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async (_args, ctx) => {
    const [contacts, deals] = await Promise.all([
      ctx.admin.from("crm_contacts").select("full_name, lead_score, status").eq("project_id", ctx.projectId).limit(1000),
      ctx.admin.from("crm_deals").select("title, stage, amount_cents, risk, last_activity_at").eq("project_id", ctx.projectId).limit(1000),
    ]);
    const d = deals.data ?? [];
    const open = d.filter((x: any) => !["won", "lost"].includes(x.stage));
    const c = (n: number) => Math.round(n / 100);
    const staleCut = Date.now() - 14 * 864e5;
    return JSON.stringify({
      open_pipeline_eur: c(open.reduce((s: number, x: any) => s + (x.amount_cents || 0), 0)),
      open_deals: open.length,
      at_risk: open.filter((x: any) => x.risk === "high").map((x: any) => ({ title: x.title, amount_eur: c(x.amount_cents || 0) })).slice(0, 10),
      stale_deals: open.filter((x: any) => !x.last_activity_at || new Date(x.last_activity_at).getTime() < staleCut).length,
      top_leads: (contacts.data ?? []).filter((x: any) => typeof x.lead_score === "number").sort((a: any, b: any) => b.lead_score - a.lead_score).slice(0, 8).map((x: any) => ({ name: x.full_name, score: x.lead_score })),
    });
  },
};

// Recruitment copilot — ATS pipeline + sources + AI screening (EU AI Act aware).
const recruitmentOverview: AssistantTool = {
  name: "get_recruitment_overview",
  minRole: "viewer",
  scope: "Recruitment/ATS: openings, candidates by stage & source, AI screening.",
  def: {
    name: "get_recruitment_overview",
    description:
      "Return the project's recruiting snapshot: open job openings, candidates by pipeline stage and by source channel (LinkedIn/Indeed/Greenhouse/Lever/Workable/referral), AI screening scores, and onboarding progress. Use for ANY recruiting, ATS, hiring, candidate, sourcing or onboarding question. Note: AI candidate scoring is EU AI Act high-risk — always frame results as decision support requiring human review.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async (_args, ctx) => {
    const [openings, cands, onb] = await Promise.all([
      ctx.admin.from("hr_job_openings").select("title, status").eq("project_id", ctx.projectId).limit(200),
      ctx.admin.from("hr_candidates").select("full_name, stage, source, ai_score, ai_decision, human_override").eq("project_id", ctx.projectId).limit(2000),
      ctx.admin.from("hr_onboardings").select("name, status").eq("project_id", ctx.projectId).limit(200),
    ]);
    const cs = cands.data ?? [];
    const byStage: Record<string, number> = {}; const bySource: Record<string, number> = {};
    for (const c of cs) { byStage[c.stage] = (byStage[c.stage] ?? 0) + 1; bySource[c.source ?? "manual"] = (bySource[c.source ?? "manual"] ?? 0) + 1; }
    return JSON.stringify({
      open_positions: (openings.data ?? []).filter((o: any) => o.status === "open").length,
      candidates: cs.length,
      by_stage: byStage, by_source: bySource,
      ai_screened: cs.filter((c: any) => typeof c.ai_score === "number").length,
      ai_overridden_by_human: cs.filter((c: any) => c.human_override).length,
      onboardings_active: (onb.data ?? []).filter((o: any) => o.status !== "complete").length,
      governance_note: "AI candidate scoring is decision support only (EU AI Act high-risk): a human must review before any hiring decision.",
    });
  },
};

const ALL_TOOLS: AssistantTool[] = [
  getMetrics,
  supplyOverview,
  financeOverview,
  projectOverview,
  supportOverview,
  crmOverview,
  recruitmentOverview,
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
  // Code instrumentation / advanced analytics
  listEventDefinitions,
  listFeatureFlags,
  analyzeRepoStructure,
  readRepoFile,
  listRepoFiles,
  proposeCodeChanges,
  defineCustomEvent,
  instrumentEvent,
  addFeatureFlag,
  installSdk,
  defineJourney,
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
