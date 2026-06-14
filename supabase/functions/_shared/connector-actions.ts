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

export const CONNECTOR_ACTIONS: Record<string, ConnectorAction[]> = {
  hubspot, pipedrive, salesforce, attio, intercom,
  bamboohr, greenhouse, deel, factorial,
};

export function actionsFor(provider: string): ConnectorAction[] {
  return CONNECTOR_ACTIONS[provider] ?? [];
}
export function findAction(provider: string, name: string): ConnectorAction | undefined {
  return actionsFor(provider).find((a) => a.name === name);
}
