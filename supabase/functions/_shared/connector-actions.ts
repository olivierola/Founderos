// Connector actions — safe, read-mostly operations that agents can run against
// connected third-party tools (CRM / HR). Each provider declares a set of named
// actions; the runtime decrypts the provider credential and calls the OFFICIAL
// API. Secrets never reach the model — the agent only picks an action + params.
//
// Endpoints follow each product's official REST docs:
//   HubSpot   https://developers.hubspot.com/docs/api/crm
//   Pipedrive https://developers.pipedrive.com/docs/api/v1
//   Salesforce https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta
//   Attio     https://developers.attio.com
//   Intercom  https://developers.intercom.com/docs/references/rest-api
//   BambooHR  https://documentation.bamboohr.com/reference
//   Greenhouse https://developers.greenhouse.io/harvest.html
//   Personio  https://developer.personio.de
//   Deel      https://developer.deel.com
//   Factorial https://apidoc.factorialhr.com

import { awsFetch } from "./aws-sigv4.ts";
import { getGoogleAccessToken } from "./google-auth.ts";

type Cred = Record<string, string>;
type Params = Record<string, unknown>;

export interface ConnectorAction {
  name: string;                 // e.g. "list_deals"
  description: string;
  params?: Record<string, { type: string; description: string }>;
  run: (cred: Cred, params: Params) => Promise<unknown>;
}

const num = (v: unknown, d: number, max: number) => Math.min(Math.max(Number(v) || d, 1), max);
const str = (v: unknown) => (typeof v === "string" ? v : "");

async function getJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

// ── HubSpot ─────────────────────────────────────────────────────────────────
const hubspot: ConnectorAction[] = [
  {
    name: "list_contacts", description: "List CRM contacts.",
    params: { limit: { type: "number", description: "Max 100, default 20." } },
    run: (c, p) => getJson(`https://api.hubapi.com/crm/v3/objects/contacts?limit=${num(p.limit, 20, 100)}`,
      { headers: { Authorization: `Bearer ${c.api_key}` } }),
  },
  {
    name: "list_deals", description: "List deals in the pipeline.",
    params: { limit: { type: "number", description: "Max 100, default 20." } },
    run: (c, p) => getJson(`https://api.hubapi.com/crm/v3/objects/deals?limit=${num(p.limit, 20, 100)}&properties=dealname,amount,dealstage,closedate`,
      { headers: { Authorization: `Bearer ${c.api_key}` } }),
  },
  {
    name: "list_companies", description: "List companies.",
    params: { limit: { type: "number", description: "Max 100, default 20." } },
    run: (c, p) => getJson(`https://api.hubapi.com/crm/v3/objects/companies?limit=${num(p.limit, 20, 100)}`,
      { headers: { Authorization: `Bearer ${c.api_key}` } }),
  },
  {
    name: "search_contacts", description: "Search contacts by a query string (email/name).",
    params: { query: { type: "string", description: "Search text." } },
    run: (c, p) => getJson("https://api.hubapi.com/crm/v3/objects/contacts/search",
      { method: "POST", headers: { Authorization: `Bearer ${c.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: str(p.query), limit: 20 }) }),
  },
];

// ── Pipedrive ───────────────────────────────────────────────────────────────
const pipedrive: ConnectorAction[] = [
  {
    name: "list_deals", description: "List deals.",
    params: { limit: { type: "number", description: "Max 100." }, status: { type: "string", description: "open|won|lost|all (default all_not_deleted)." } },
    run: (c, p) => getJson(`https://${c.company_domain}.pipedrive.com/api/v1/deals?limit=${num(p.limit, 20, 100)}${p.status ? `&status=${encodeURIComponent(str(p.status))}` : ""}&api_token=${c.api_key}`, {}),
  },
  {
    name: "list_persons", description: "List persons (contacts).",
    params: { limit: { type: "number", description: "Max 100." } },
    run: (c, p) => getJson(`https://${c.company_domain}.pipedrive.com/api/v1/persons?limit=${num(p.limit, 20, 100)}&api_token=${c.api_key}`, {}),
  },
  {
    name: "pipeline_summary", description: "Summary of deals per stage in the default pipeline.",
    run: (c) => getJson(`https://${c.company_domain}.pipedrive.com/api/v1/deals/summary?api_token=${c.api_key}`, {}),
  },
];

// ── Salesforce ──────────────────────────────────────────────────────────────
const salesforce: ConnectorAction[] = [
  {
    name: "soql_query", description: "Run a read-only SOQL query (SELECT only).",
    params: { soql: { type: "string", description: "A SELECT SOQL query, e.g. SELECT Id,Name FROM Account LIMIT 20." } },
    run: (c, p) => {
      const q = str(p.soql).trim();
      if (!/^select\s/i.test(q)) throw new Error("Only SELECT queries are allowed");
      const base = c.instance_url.replace(/\/+$/, "");
      return getJson(`${base}/services/data/v60.0/query?q=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${c.access_token}` } });
    },
  },
  {
    name: "list_opportunities", description: "List recent opportunities.",
    params: { limit: { type: "number", description: "Max 100." } },
    run: (c, p) => {
      const base = c.instance_url.replace(/\/+$/, "");
      const q = `SELECT Id,Name,Amount,StageName,CloseDate FROM Opportunity ORDER BY CreatedDate DESC LIMIT ${num(p.limit, 20, 100)}`;
      return getJson(`${base}/services/data/v60.0/query?q=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${c.access_token}` } });
    },
  },
];

// ── Attio ───────────────────────────────────────────────────────────────────
const attio: ConnectorAction[] = [
  {
    name: "list_records", description: "Query records for an object (e.g. companies, people).",
    params: { object: { type: "string", description: "Object slug, e.g. 'companies' or 'people'." }, limit: { type: "number", description: "Max 100." } },
    run: (c, p) => getJson(`https://api.attio.com/v2/objects/${encodeURIComponent(str(p.object) || "companies")}/records/query`,
      { method: "POST", headers: { Authorization: `Bearer ${c.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ limit: num(p.limit, 20, 100) }) }),
  },
];

// ── Intercom ────────────────────────────────────────────────────────────────
const intercom: ConnectorAction[] = [
  {
    name: "list_contacts", description: "List contacts.",
    run: (c) => getJson("https://api.intercom.io/contacts?per_page=20",
      { headers: { Authorization: `Bearer ${c.api_key}`, Accept: "application/json" } }),
  },
  {
    name: "search_conversations", description: "List recent conversations.",
    run: (c) => getJson("https://api.intercom.io/conversations?per_page=20",
      { headers: { Authorization: `Bearer ${c.api_key}`, Accept: "application/json" } }),
  },
];

// ── BambooHR (HTTP Basic: apiKey:x) ──────────────────────────────────────────
const bamboohr: ConnectorAction[] = [
  {
    name: "employee_directory", description: "Company employee directory.",
    run: (c) => getJson(`https://api.bamboohr.com/api/gateway.php/${c.subdomain}/v1/employees/directory`,
      { headers: { Authorization: `Basic ${btoa(`${c.api_key}:x`)}`, Accept: "application/json" } }),
  },
  {
    name: "time_off_requests", description: "List time-off requests.",
    run: (c) => getJson(`https://api.bamboohr.com/api/gateway.php/${c.subdomain}/v1/time_off/requests`,
      { headers: { Authorization: `Basic ${btoa(`${c.api_key}:x`)}`, Accept: "application/json" } }),
  },
];

// ── Greenhouse (HTTP Basic: apiKey:) ─────────────────────────────────────────
const greenhouse: ConnectorAction[] = [
  {
    name: "list_jobs", description: "List open jobs.",
    run: (c) => getJson("https://harvest.greenhouse.io/v1/jobs?per_page=50",
      { headers: { Authorization: `Basic ${btoa(`${c.api_key}:`)}` } }),
  },
  {
    name: "list_candidates", description: "List recent candidates.",
    run: (c) => getJson("https://harvest.greenhouse.io/v1/candidates?per_page=25",
      { headers: { Authorization: `Basic ${btoa(`${c.api_key}:`)}` } }),
  },
];

// ── Deel ─────────────────────────────────────────────────────────────────────
const deel: ConnectorAction[] = [
  {
    name: "list_people", description: "List workers / contractors.",
    run: (c) => getJson("https://api.letsdeel.com/rest/v2/people",
      { headers: { Authorization: `Bearer ${c.api_key}` } }),
  },
];

// ── Factorial ─────────────────────────────────────────────────────────────────
const factorial: ConnectorAction[] = [
  {
    name: "list_employees", description: "List employees.",
    run: (c) => getJson("https://api.factorialhr.com/api/v1/employees",
      { headers: { "x-api-key": c.api_key } }),
  },
  {
    name: "list_leaves", description: "List leaves / time off.",
    run: (c) => getJson("https://api.factorialhr.com/api/v1/leaves",
      { headers: { "x-api-key": c.api_key } }),
  },
];

// ── AWS Athena (SQL over an S3 data lake) ────────────────────────────────────
async function athenaQuery(c: Cred, sql: string): Promise<unknown> {
  if (!/^\s*(select|with|show|describe)\b/i.test(sql)) throw new Error("Only read-only queries (SELECT/WITH/SHOW/DESCRIBE) are allowed");
  const creds = { accessKeyId: c.access_key_id, secretAccessKey: c.secret_access_key, region: c.region };
  const host = `athena.${c.region}.amazonaws.com`;
  const callout = async (target: string, payload: unknown) => {
    const res = await awsFetch(creds, { service: "athena", host, target: `AmazonAthena.${target}`, contentType: "application/x-amz-json-1.1", body: JSON.stringify(payload) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Athena ${target} HTTP ${res.status}: ${text.slice(0, 240)}`);
    return text ? JSON.parse(text) : {};
  };
  const start = await callout("StartQueryExecution", {
    QueryString: sql,
    QueryExecutionContext: c.database ? { Database: c.database } : undefined,
    ResultConfiguration: { OutputLocation: c.output_location },
    WorkGroup: c.workgroup || undefined,
  }) as { QueryExecutionId: string };
  const id = start.QueryExecutionId;
  // Poll for completion (Athena is async).
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await callout("GetQueryExecution", { QueryExecutionId: id }) as { QueryExecution: { Status: { State: string; StateChangeReason?: string } } };
    const state = st.QueryExecution.Status.State;
    if (state === "SUCCEEDED") break;
    if (state === "FAILED" || state === "CANCELLED") throw new Error(`Query ${state}: ${st.QueryExecution.Status.StateChangeReason ?? ""}`);
    if (i === 29) throw new Error("Query timed out");
  }
  const out = await callout("GetQueryResults", { QueryExecutionId: id, MaxResults: 100 }) as {
    ResultSet: { Rows: { Data: { VarCharValue?: string }[] }[] };
  };
  const rows = out.ResultSet.Rows.map((r) => r.Data.map((d) => d.VarCharValue ?? null));
  const [header, ...body] = rows;
  return { columns: header, rows: body };
}
const athena: ConnectorAction[] = [
  {
    name: "query", description: "Run a read-only SQL query against the S3 data lake (Athena).",
    params: { sql: { type: "string", description: "SELECT/WITH/SHOW/DESCRIBE only." } },
    run: (c, p) => athenaQuery(c, str(p.sql)),
  },
  {
    name: "list_tables", description: "List tables in the configured Glue database.",
    run: (c) => athenaQuery(c, "SHOW TABLES"),
  },
];

// ── Google Cloud Storage ─────────────────────────────────────────────────────
const gcs: ConnectorAction[] = [
  {
    name: "list_objects", description: "List objects in a GCS bucket (optionally by prefix).",
    params: { bucket: { type: "string", description: "Bucket name." }, prefix: { type: "string", description: "Optional path prefix." } },
    run: async (c, p) => {
      const { token } = await getGoogleAccessToken(c.service_account, ["https://www.googleapis.com/auth/devstorage.read_only"]);
      const q = new URLSearchParams({ maxResults: "100" });
      if (p.prefix) q.set("prefix", str(p.prefix));
      return getJson(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(str(p.bucket))}/o?${q}`,
        { headers: { Authorization: `Bearer ${token}` } });
    },
  },
  {
    name: "read_object", description: "Read a text/JSON object's content (first 100KB).",
    params: { bucket: { type: "string", description: "Bucket." }, object: { type: "string", description: "Object path." } },
    run: async (c, p) => {
      const { token } = await getGoogleAccessToken(c.service_account, ["https://www.googleapis.com/auth/devstorage.read_only"]);
      const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(str(p.bucket))}/o/${encodeURIComponent(str(p.object))}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`GCS HTTP ${res.status}`);
      return (await res.text()).slice(0, 100_000);
    },
  },
];

// ── Azure Blob Storage (SAS) ─────────────────────────────────────────────────
const azureBlob: ConnectorAction[] = [
  {
    name: "list_containers", description: "List containers in the storage account.",
    run: async (c) => {
      const sas = c.sas_token.replace(/^\?/, "");
      const res = await fetch(`https://${c.account}.blob.core.windows.net/?comp=list&${sas}`);
      if (!res.ok) throw new Error(`Azure HTTP ${res.status}`);
      return (await res.text()).slice(0, 20_000); // XML
    },
  },
  {
    name: "list_blobs", description: "List blobs in a container.",
    params: { container: { type: "string", description: "Container name." }, prefix: { type: "string", description: "Optional prefix." } },
    run: async (c, p) => {
      const sas = c.sas_token.replace(/^\?/, "");
      const pre = p.prefix ? `&prefix=${encodeURIComponent(str(p.prefix))}` : "";
      const res = await fetch(`https://${c.account}.blob.core.windows.net/${encodeURIComponent(str(p.container))}?restype=container&comp=list${pre}&${sas}`);
      if (!res.ok) throw new Error(`Azure HTTP ${res.status}`);
      return (await res.text()).slice(0, 20_000);
    },
  },
];

// ── Azure Synapse (serverless SQL over the lake) ─────────────────────────────
const azureSynapse: ConnectorAction[] = [
  {
    name: "query", description: "Run a read-only SQL query (SELECT) on Synapse serverless.",
    params: { sql: { type: "string", description: "A SELECT query." } },
    run: async (c, p) => {
      const sql = str(p.sql).trim();
      if (!/^select\s/i.test(sql)) throw new Error("Only SELECT queries are allowed");
      // Synapse serverless SQL is exposed over the SQL-on-demand REST endpoint.
      const host = `${c.workspace}-ondemand.sql.azuresynapse.net`;
      return getJson(`https://${host}/databases/${encodeURIComponent(c.database || "master")}/query`,
        { method: "POST", headers: { Authorization: `Bearer ${c.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: sql }) });
    },
  },
];

// ── BigQuery ─────────────────────────────────────────────────────────────────
const bigquery: ConnectorAction[] = [
  {
    name: "query", description: "Run a read-only SQL query (BigQuery standard SQL).",
    params: { sql: { type: "string", description: "A SELECT query." } },
    run: async (c, p) => {
      const sql = str(p.sql).trim();
      if (!/^\s*(select|with)\b/i.test(sql)) throw new Error("Only SELECT/WITH queries are allowed");
      const { token } = await getGoogleAccessToken(c.service_account, ["https://www.googleapis.com/auth/bigquery.readonly"]);
      return getJson(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(c.project_id)}/queries`,
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: sql, useLegacySql: false, maxResults: 100, timeoutMs: 25000 }) });
    },
  },
  {
    name: "list_datasets", description: "List datasets in the project.",
    run: async (c) => {
      const { token } = await getGoogleAccessToken(c.service_account, ["https://www.googleapis.com/auth/bigquery.readonly"]);
      return getJson(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(c.project_id)}/datasets`,
        { headers: { Authorization: `Bearer ${token}` } });
    },
  },
];

// ── Google Calendar ──────────────────────────────────────────────────────────
const googleCalendar: ConnectorAction[] = [
  {
    name: "list_events", description: "List upcoming events.",
    params: { days: { type: "string", description: "Look-ahead window in days (default 14)." } },
    run: async (c) => {
      const { token } = await getGoogleAccessToken(c.service_account, ["https://www.googleapis.com/auth/calendar.readonly"]);
      const timeMin = new Date().toISOString();
      return getJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.calendar_id)}/events?timeMin=${encodeURIComponent(timeMin)}&singleEvents=true&orderBy=startTime&maxResults=20`,
        { headers: { Authorization: `Bearer ${token}` } });
    },
  },
  {
    name: "create_event", description: "Create a calendar event.",
    params: {
      summary: { type: "string", description: "Event title." },
      start: { type: "string", description: "ISO start datetime (e.g. 2026-07-01T15:00:00Z)." },
      end: { type: "string", description: "ISO end datetime." },
      description: { type: "string", description: "Optional details." },
      attendees: { type: "string", description: "Optional comma-separated emails." },
    },
    run: async (c, p) => {
      const { token } = await getGoogleAccessToken(c.service_account, ["https://www.googleapis.com/auth/calendar"]);
      const attendees = str(p.attendees).split(",").map((e) => e.trim()).filter(Boolean).map((email) => ({ email }));
      const body = {
        summary: str(p.summary) || "Event",
        description: str(p.description) || undefined,
        start: { dateTime: str(p.start) },
        end: { dateTime: str(p.end) || str(p.start) },
        attendees: attendees.length ? attendees : undefined,
      };
      return getJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.calendar_id)}/events`,
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    },
  },
];

// ── Stripe ────────────────────────────────────────────────────────────────────
// Read-only billing data via the official API (use a restricted/read key).
const stripe: ConnectorAction[] = [
  {
    name: "list_customers", description: "List customers.",
    params: { limit: { type: "number", description: "Max 100, default 20." } },
    run: (c, p) => getJson(`https://api.stripe.com/v1/customers?limit=${num(p.limit, 20, 100)}`,
      { headers: { Authorization: `Bearer ${c.secret_key}` } }),
  },
  {
    name: "list_subscriptions", description: "List subscriptions (optionally by status).",
    params: { limit: { type: "number", description: "Max 100." }, status: { type: "string", description: "active|past_due|canceled|all" } },
    run: (c, p) => getJson(`https://api.stripe.com/v1/subscriptions?limit=${num(p.limit, 20, 100)}${p.status ? `&status=${encodeURIComponent(str(p.status))}` : ""}`,
      { headers: { Authorization: `Bearer ${c.secret_key}` } }),
  },
  {
    name: "list_invoices", description: "List invoices.",
    params: { limit: { type: "number", description: "Max 100." }, status: { type: "string", description: "draft|open|paid|uncollectible|void" } },
    run: (c, p) => getJson(`https://api.stripe.com/v1/invoices?limit=${num(p.limit, 20, 100)}${p.status ? `&status=${encodeURIComponent(str(p.status))}` : ""}`,
      { headers: { Authorization: `Bearer ${c.secret_key}` } }),
  },
  {
    name: "balance", description: "Current account balance.",
    run: (c) => getJson("https://api.stripe.com/v1/balance", { headers: { Authorization: `Bearer ${c.secret_key}` } }),
  },
];

// ── Notion ────────────────────────────────────────────────────────────────────
const NOTION_VER = "2022-06-28";
const notion: ConnectorAction[] = [
  {
    name: "search", description: "Search pages and databases by text.",
    params: { query: { type: "string", description: "Search text." } },
    run: (c, p) => getJson("https://api.notion.com/v1/search",
      { method: "POST", headers: { Authorization: `Bearer ${c.api_key}`, "Notion-Version": NOTION_VER, "Content-Type": "application/json" },
        body: JSON.stringify({ query: str(p.query), page_size: 20 }) }),
  },
  {
    name: "query_database", description: "Query rows of a Notion database.",
    params: { database_id: { type: "string", description: "Database ID." } },
    run: (c, p) => getJson(`https://api.notion.com/v1/databases/${encodeURIComponent(str(p.database_id))}/query`,
      { method: "POST", headers: { Authorization: `Bearer ${c.api_key}`, "Notion-Version": NOTION_VER, "Content-Type": "application/json" },
        body: JSON.stringify({ page_size: 50 }) }),
  },
  {
    name: "get_page", description: "Get a page's properties.",
    params: { page_id: { type: "string", description: "Page ID." } },
    run: (c, p) => getJson(`https://api.notion.com/v1/pages/${encodeURIComponent(str(p.page_id))}`,
      { headers: { Authorization: `Bearer ${c.api_key}`, "Notion-Version": NOTION_VER } }),
  },
];

// ── Linear (GraphQL) ───────────────────────────────────────────────────────────
function linearGql(apiKey: string, query: string): Promise<unknown> {
  return getJson("https://api.linear.app/graphql",
    { method: "POST", headers: { Authorization: apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
}
const linear: ConnectorAction[] = [
  {
    name: "list_issues", description: "List recent issues (title, state, assignee, priority).",
    run: (c) => linearGql(c.api_key, `{ issues(first: 30, orderBy: updatedAt) { nodes { identifier title priority state { name } assignee { name } updatedAt } } }`),
  },
  {
    name: "list_teams", description: "List teams.",
    run: (c) => linearGql(c.api_key, `{ teams(first: 50) { nodes { key name } } }`),
  },
  {
    name: "list_projects", description: "List projects and their progress.",
    run: (c) => linearGql(c.api_key, `{ projects(first: 50) { nodes { name state progress targetDate } } }`),
  },
];

// ── Sentry ─────────────────────────────────────────────────────────────────────
const sentry: ConnectorAction[] = [
  {
    name: "list_projects", description: "List projects you can access.",
    run: (c) => getJson("https://sentry.io/api/0/projects/", { headers: { Authorization: `Bearer ${c.api_key}` } }),
  },
  {
    name: "list_issues", description: "List unresolved issues for a project.",
    params: { organization_slug: { type: "string", description: "Org slug." }, project_slug: { type: "string", description: "Project slug." } },
    run: (c, p) => getJson(`https://sentry.io/api/0/projects/${encodeURIComponent(str(p.organization_slug))}/${encodeURIComponent(str(p.project_slug))}/issues/?query=is:unresolved&statsPeriod=14d`,
      { headers: { Authorization: `Bearer ${c.api_key}` } }),
  },
];

// ── PostHog ─────────────────────────────────────────────────────────────────────
const posthog: ConnectorAction[] = [
  {
    name: "list_insights", description: "List saved insights (dashboards' charts).",
    run: (c) => getJson(`${c.host.replace(/\/$/, "")}/api/projects/${c.project_id}/insights/?limit=25`,
      { headers: { Authorization: `Bearer ${c.personal_api_key}` } }),
  },
  {
    name: "trends", description: "Run a trends query for an event over time.",
    params: { event: { type: "string", description: "Event name, e.g. '$pageview'." }, days: { type: "number", description: "Lookback days (default 14)." } },
    run: (c, p) => {
      const events = encodeURIComponent(JSON.stringify([{ id: str(p.event) || "$pageview", type: "events", math: "total" }]));
      return getJson(`${c.host.replace(/\/$/, "")}/api/projects/${c.project_id}/insights/trend/?events=${events}&date_from=-${num(p.days, 14, 365)}d`,
        { headers: { Authorization: `Bearer ${c.personal_api_key}` } });
    },
  },
];

// ── Plausible ────────────────────────────────────────────────────────────────────
const plausible: ConnectorAction[] = [
  {
    name: "aggregate", description: "Aggregate visitors/pageviews/bounce for a site over a period.",
    params: { site_id: { type: "string", description: "Domain, e.g. example.com." }, period: { type: "string", description: "day|7d|30d|month|6mo|12mo (default 30d)." } },
    run: (c, p) => getJson(`https://plausible.io/api/v1/stats/aggregate?site_id=${encodeURIComponent(str(p.site_id))}&period=${encodeURIComponent(str(p.period) || "30d")}&metrics=visitors,pageviews,bounce_rate,visit_duration`,
      { headers: { Authorization: `Bearer ${c.api_key}` } }),
  },
  {
    name: "breakdown", description: "Top pages or sources breakdown.",
    params: { site_id: { type: "string", description: "Domain." }, property: { type: "string", description: "event:page | visit:source (default event:page)." } },
    run: (c, p) => getJson(`https://plausible.io/api/v1/stats/breakdown?site_id=${encodeURIComponent(str(p.site_id))}&period=30d&property=${encodeURIComponent(str(p.property) || "event:page")}&limit=20`,
      { headers: { Authorization: `Bearer ${c.api_key}` } }),
  },
];

// ── Figma ─────────────────────────────────────────────────────────────────────
const figma: ConnectorAction[] = [
  {
    name: "get_file", description: "Get a file's document tree (nodes, pages).",
    params: { file_key: { type: "string", description: "File key from the Figma URL." } },
    run: (c, p) => getJson(`https://api.figma.com/v1/files/${encodeURIComponent(str(p.file_key))}?depth=2`,
      { headers: { "X-Figma-Token": c.api_key } }),
  },
  {
    name: "get_comments", description: "List comments on a file.",
    params: { file_key: { type: "string", description: "File key." } },
    run: (c, p) => getJson(`https://api.figma.com/v1/files/${encodeURIComponent(str(p.file_key))}/comments`,
      { headers: { "X-Figma-Token": c.api_key } }),
  },
];

// ── Airtable ─────────────────────────────────────────────────────────────────────
const airtable: ConnectorAction[] = [
  {
    name: "list_records", description: "List records from a base table.",
    params: { base_id: { type: "string", description: "Base ID (appXXXX)." }, table: { type: "string", description: "Table name or ID." } },
    run: (c, p) => getJson(`https://api.airtable.com/v0/${encodeURIComponent(str(p.base_id))}/${encodeURIComponent(str(p.table))}?maxRecords=50`,
      { headers: { Authorization: `Bearer ${c.api_key}` } }),
  },
];

// ── GitHub (read) ─────────────────────────────────────────────────────────────────
const github: ConnectorAction[] = [
  {
    name: "list_repos", description: "List repositories accessible to the token.",
    run: (c) => getJson("https://api.github.com/user/repos?per_page=50&sort=updated",
      { headers: { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json" } }),
  },
  {
    name: "list_issues", description: "List open issues for a repo.",
    params: { owner: { type: "string", description: "Owner/org." }, repo: { type: "string", description: "Repo name." } },
    run: (c, p) => getJson(`https://api.github.com/repos/${encodeURIComponent(str(p.owner))}/${encodeURIComponent(str(p.repo))}/issues?state=open&per_page=30`,
      { headers: { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json" } }),
  },
];

export const CONNECTOR_ACTIONS: Record<string, ConnectorAction[]> = {
  hubspot, pipedrive, salesforce, attio, intercom,
  bamboohr, greenhouse, deel, factorial,
  athena, gcs, bigquery, "azure-blob": azureBlob, "azure-synapse": azureSynapse,
  "google-calendar": googleCalendar,
  // Real SaaS apps (billing, docs, issues, monitoring, analytics, design, data).
  stripe, notion, linear, sentry, posthog, plausible, figma, airtable, github,
};

export function actionsFor(provider: string): ConnectorAction[] {
  return CONNECTOR_ACTIONS[provider] ?? [];
}
export function findAction(provider: string, name: string): ConnectorAction | undefined {
  return actionsFor(provider).find((a) => a.name === name);
}
