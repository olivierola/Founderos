// Provider validation: hits each provider's API (or pings its webhook) with the
// supplied credentials and returns a small metadata object.

import { getGoogleAccessToken, FIRESTORE_SCOPES } from "./google-auth.ts";

export type Provider = string;

export interface ProviderValidationResult {
  ok: boolean;
  permissions: "read_only" | "write_enabled";
  metadata: Record<string, unknown>;
  error?: string;
}

async function fetchJson(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { ok: res.ok, status: res.status, body };
}

const fail = (error: string): ProviderValidationResult => ({
  ok: false,
  permissions: "read_only",
  metadata: {},
  error,
});
const ok = (
  metadata: Record<string, unknown> = {},
  permissions: "read_only" | "write_enabled" = "read_only",
): ProviderValidationResult => ({ ok: true, permissions, metadata });

// Generic bearer-API validator
async function bearer(
  url: string,
  key: string,
  meta: Record<string, unknown> = {},
  perm: "read_only" | "write_enabled" = "read_only",
  extraHeaders: Record<string, string> = {},
): Promise<ProviderValidationResult> {
  const r = await fetchJson(url, { headers: { Authorization: `Bearer ${key}`, ...extraHeaders } });
  if (!r.ok) return fail(`Invalid credentials (HTTP ${r.status})`);
  return ok(meta, perm);
}

// Normalise a PostHog host: default to EU cloud, strip a trailing slash, and
// accept a bare hostname (no scheme) by prefixing https://.
export function normalizePosthogHost(raw?: string): string {
  let host = (raw ?? "").trim();
  if (!host) return "https://eu.i.posthog.com";
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;
  return host.replace(/\/+$/, "");
}

// Validate an outgoing webhook by sending a lightweight ping.
async function pingWebhook(url: string, body: unknown): Promise<ProviderValidationResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Most webhook receivers return 200/204; some return 400 on unexpected payload but the URL is valid.
    if (res.status >= 500) return fail(`Webhook endpoint error (HTTP ${res.status})`);
    return ok({ webhook: true }, "write_enabled");
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Webhook unreachable");
  }
}

export async function validateProvider(
  provider: Provider,
  payload: Record<string, string>,
): Promise<ProviderValidationResult> {
  try {
    switch (provider) {
      // --- Repo ---
      case "github": {
        const token = payload.token;
        if (!token) return fail("token required");
        const r = await fetchJson("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "FounderOS" },
        });
        if (!r.ok) return fail("Invalid GitHub token");
        const b = r.body as { login: string; id: number };
        return ok({ github_login: b.login, github_user_id: b.id });
      }
      case "gitlab": {
        const token = payload.api_key;
        if (!token) return fail("token required");
        const r = await fetchJson("https://gitlab.com/api/v4/user", { headers: { "PRIVATE-TOKEN": token } });
        if (!r.ok) return fail("Invalid GitLab token");
        const b = r.body as { username?: string };
        return ok({ username: b.username ?? null });
      }

      // --- Payments ---
      case "stripe": {
        const key = payload.secret_key;
        if (!key) return fail("secret_key required");
        const r = await fetchJson("https://api.stripe.com/v1/account", { headers: { Authorization: `Bearer ${key}` } });
        if (!r.ok) return fail("Invalid Stripe key");
        const b = r.body as { id: string; business_profile?: { name?: string }; email?: string; livemode?: boolean };
        const writeEnabled = key.startsWith("sk_live_") || key.startsWith("sk_test_");
        return ok(
          { account_id: b.id, business_name: b.business_profile?.name ?? null, email: b.email ?? null, livemode: b.livemode ?? false },
          writeEnabled ? "write_enabled" : "read_only",
        );
      }
      case "lemonsqueezy": {
        const key = payload.api_key;
        if (!key) return fail("api_key required");
        return bearer("https://api.lemonsqueezy.com/v1/users/me", key, {}, "read_only", { Accept: "application/vnd.api+json" });
      }
      case "paddle": {
        const key = payload.api_key;
        if (!key) return fail("api_key required");
        return bearer("https://api.paddle.com/event-types", key);
      }

      // --- Backend / hosting ---
      case "vercel": {
        const token = payload.token;
        if (!token) return fail("token required");
        const teamQs = payload.team_id ? `?teamId=${encodeURIComponent(payload.team_id)}` : "";
        const r = await fetchJson(`https://api.vercel.com/v2/user${teamQs}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return fail("Invalid Vercel token");
        const b = r.body as { user?: { username?: string; email?: string } };
        return ok({ username: b.user?.username ?? null, email: b.user?.email ?? null, team_id: payload.team_id ?? null });
      }
      case "supabase": {
        const token = payload.access_token;
        if (!token) return fail("access_token required");
        const r = await fetchJson("https://api.supabase.com/v1/projects", { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return fail("Invalid Supabase token");
        const b = r.body as Array<{ id: string }>;
        const perm = payload.service_role_key ? "write_enabled" : "read_only";
        return ok({ project_count: Array.isArray(b) ? b.length : 0, project_ref: payload.project_ref ?? null, crud: !!payload.service_role_key }, perm);
      }
      case "netlify":
        return payload.api_key ? bearer("https://api.netlify.com/api/v1/user", payload.api_key) : fail("api_key required");
      case "railway":
        return payload.api_key
          ? pingWebhook("https://backboard.railway.app/graphql/v2", { query: "{ me { id } }" }).then((r) => (r.ok ? ok({}) : r))
          : fail("api_key required");
      case "render":
        return payload.api_key ? bearer("https://api.render.com/v1/services?limit=1", payload.api_key) : fail("api_key required");
      case "cloudflare":
        return payload.api_key ? bearer("https://api.cloudflare.com/client/v4/user/tokens/verify", payload.api_key) : fail("api_key required");
      case "clerk":
        return payload.api_key ? bearer("https://api.clerk.com/v1/users?limit=1", payload.api_key) : fail("api_key required");
      case "neon": {
        // A connection string enables the visual DB console; the API key (optional)
        // is validated if provided.
        if (payload.api_key) {
          const r = await fetchJson("https://console.neon.tech/api/v2/projects", {
            headers: { Authorization: `Bearer ${payload.api_key}` },
          });
          if (!r.ok) return fail("Invalid Neon API key");
        }
        if (!payload.connection_string && !payload.api_key) return fail("connection_string or api_key required");
        return ok({ crud: !!payload.connection_string }, payload.connection_string ? "write_enabled" : "read_only");
      }
      case "postgres": {
        const cs = payload.connection_string || payload.database_url;
        if (!cs || !/^postgres(ql)?:\/\//.test(cs)) return fail("A valid postgresql:// connection string is required");
        return ok({ crud: true }, "write_enabled");
      }
      case "firebase": {
        if (!payload.project_id || !payload.service_account) return fail("project_id + service_account JSON required");
        try {
          const { token } = await getGoogleAccessToken(payload.service_account, FIRESTORE_SCOPES);
          // Probe Firestore: list root collections (cheap, confirms project + perms).
          const r = await fetchJson(
            `https://firestore.googleapis.com/v1/projects/${payload.project_id}/databases/(default)/documents:listCollectionIds`,
            { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" },
          );
          if (!r.ok) return fail(`Firestore rejected the service account (HTTP ${r.status}). Check the project ID and that Firestore is enabled.`);
          return ok({ project_id: payload.project_id, crud: true }, "write_enabled");
        } catch (e) {
          return fail(e instanceof Error ? e.message : "Invalid service account");
        }
      }
      case "planetscale":
        return payload.api_key && payload.service_token_id
          ? bearer("https://api.planetscale.com/v1/organizations", payload.api_key, {}, "read_only", {
              Authorization: `${payload.service_token_id}:${payload.api_key}`,
            })
          : fail("service_token_id + api_key required");

      // --- AI ---
      case "groq":
        return payload.api_key ? bearer("https://api.groq.com/openai/v1/models", payload.api_key) : fail("api_key required");
      case "deepseek":
        return payload.api_key ? bearer("https://api.deepseek.com/models", payload.api_key) : fail("api_key required");
      case "openai":
        return payload.api_key ? bearer("https://api.openai.com/v1/models", payload.api_key) : fail("api_key required");
      case "anthropic": {
        const key = payload.api_key;
        if (!key) return fail("api_key required");
        const r = await fetchJson("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        });
        if (!r.ok) return fail("Invalid Anthropic key");
        return ok({});
      }
      case "mistral":
        return payload.api_key ? bearer("https://api.mistral.ai/v1/models", payload.api_key) : fail("api_key required");
      case "openrouter":
        return payload.api_key ? bearer("https://openrouter.ai/api/v1/key", payload.api_key) : fail("api_key required");

      // --- Analytics ---
      case "posthog": {
        const key = payload.api_key;
        const host = payload.host || "https://app.posthog.com";
        if (!key) return fail("api_key required");
        return bearer(`${host}/api/users/@me/`, key, { host });
      }
      case "plausible":
        return payload.api_key
          ? bearer("https://plausible.io/api/v1/sites?limit=1", payload.api_key)
          : fail("api_key required");
      case "mixpanel": {
        // Validate the service-account/secret via the project events API (HTTP Basic).
        const secret = payload.api_secret || payload.api_key;
        if (!secret) return fail("api_secret required");
        const auth = btoa(`${secret}:`);
        const r = await fetchJson("https://mixpanel.com/api/2.0/engage?limit=1", {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (!r.ok && r.status === 401) return fail("Invalid Mixpanel secret");
        return ok({ project_token: payload.project_token ?? null });
      }
      case "amplitude": {
        // Amplitude validates by posting an identify with the API key.
        if (!payload.api_key) return fail("api_key required");
        const r = await fetchJson("https://api2.amplitude.com/identify", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ api_key: payload.api_key, identification: "[]" }).toString(),
        });
        if (r.status === 400 || r.status === 403) return fail("Invalid Amplitude API key");
        return ok({});
      }
      case "posthog": {
        // Read access (importing events) needs a personal API key + project id.
        // Write/mirror (project_api_key) is optional.
        if (!payload.personal_api_key || !payload.project_id) {
          return fail("personal_api_key + project_id required");
        }
        const host = normalizePosthogHost(payload.host);
        const r = await fetchJson(`${host}/api/projects/${encodeURIComponent(payload.project_id)}/`, {
          headers: { Authorization: `Bearer ${payload.personal_api_key}` },
        });
        if (r.status === 401 || r.status === 403) return fail("Invalid PostHog personal API key");
        if (r.status === 404) return fail("PostHog project not found — check the project ID and host");
        if (!r.ok) return fail(`PostHog rejected the request (HTTP ${r.status})`);
        const name = (r.body as { name?: string } | null)?.name ?? null;
        // write_enabled when a capture key is supplied (we can mirror events out).
        return ok(
          { host, project_id: payload.project_id, project_name: name, can_mirror: !!payload.project_api_key },
          payload.project_api_key ? "write_enabled" : "read_only",
        );
      }

      // --- Monitoring ---
      case "sentry":
        return payload.api_key ? bearer("https://sentry.io/api/0/organizations/", payload.api_key) : fail("api_key required");
      case "datadog": {
        if (!payload.api_key || !payload.app_key) return fail("api_key + app_key required");
        const r = await fetchJson("https://api.datadoghq.com/api/v1/validate", {
          headers: { "DD-API-KEY": payload.api_key, "DD-APPLICATION-KEY": payload.app_key },
        });
        if (!r.ok) return fail("Invalid Datadog keys");
        return ok({});
      }
      case "betterstack":
        return payload.api_key
          ? bearer("https://uptime.betterstack.com/api/v2/monitors", payload.api_key)
          : fail("api_key required");

      // --- Messaging (webhook ping) ---
      case "slack":
        return payload.webhook_url
          ? pingWebhook(payload.webhook_url, { text: "✅ FounderOS connected" })
          : fail("webhook_url required");
      case "discord":
        return payload.webhook_url
          ? pingWebhook(payload.webhook_url, { content: "✅ FounderOS connected" })
          : fail("webhook_url required");
      case "telegram": {
        if (!payload.api_key || !payload.chat_id) return fail("bot token + chat_id required");
        const r = await fetchJson(`https://api.telegram.org/bot${payload.api_key}/getMe`, {});
        if (!r.ok) return fail("Invalid Telegram bot token");
        return ok({ chat_id: payload.chat_id }, "write_enabled");
      }

      // --- Email ---
      case "resend":
        return payload.api_key
          ? bearer("https://api.resend.com/domains", payload.api_key, {}, "write_enabled")
          : fail("api_key required");
      case "sendgrid":
        return payload.api_key
          ? bearer("https://api.sendgrid.com/v3/scopes", payload.api_key, {}, "write_enabled")
          : fail("api_key required");
      case "postmark": {
        const key = payload.api_key;
        if (!key) return fail("server token required");
        const r = await fetchJson("https://api.postmarkapp.com/server", {
          headers: { "X-Postmark-Server-Token": key, Accept: "application/json" },
        });
        if (!r.ok) return fail("Invalid Postmark token");
        return ok({}, "write_enabled");
      }

      // --- Storage ---
      case "aws-s3":
        return payload.access_key_id && payload.secret_access_key
          ? ok({ region: payload.region ?? null }) // credentials stored; signed requests done at use-time
          : fail("access_key_id + secret_access_key required");
      case "cloudinary": {
        // Expects cloud_name + api_key + api_secret; ping the usage endpoint.
        if (!payload.api_key) return fail("api_key required");
        if (payload.cloud_name && payload.api_secret) {
          const auth = btoa(`${payload.api_key}:${payload.api_secret}`);
          const r = await fetchJson(`https://api.cloudinary.com/v1_1/${payload.cloud_name}/usage`, {
            headers: { Authorization: `Basic ${auth}` },
          });
          if (!r.ok) return fail("Invalid Cloudinary credentials");
        }
        return ok({ cloud_name: payload.cloud_name ?? null });
      }

      // --- Automation (webhook ping) ---
      case "n8n":
      case "zapier":
      case "make":
        return payload.webhook_url
          ? pingWebhook(payload.webhook_url, { source: "founderos", event: "connection.test" })
          : fail("webhook_url required");

      // --- Security ---
      case "snyk":
        return payload.api_key
          ? bearer("https://api.snyk.io/rest/self?version=2024-01-01", payload.api_key, {}, "read_only", {
              Authorization: `token ${payload.api_key}`,
            })
          : fail("api_key required");

      // --- CRM / tooling ---
      case "hubspot":
        return payload.api_key
          ? bearer("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", payload.api_key)
          : fail("token required");
      case "intercom":
        return payload.api_key
          ? bearer("https://api.intercom.io/me", payload.api_key, {}, "read_only", { Accept: "application/json" })
          : fail("access token required");
      case "pipedrive": {
        if (!payload.company_domain || !payload.api_key) return fail("company_domain + api_token required");
        const r = await fetchJson(`https://${payload.company_domain}.pipedrive.com/api/v1/users/me?api_token=${encodeURIComponent(payload.api_key)}`, {});
        if (!r.ok) return fail("Invalid Pipedrive domain or token");
        return ok({ company_domain: payload.company_domain });
      }
      case "salesforce": {
        if (!payload.instance_url || !payload.access_token) return fail("instance_url + access_token required");
        const base = String(payload.instance_url).replace(/\/+$/, "");
        const r = await fetchJson(`${base}/services/data/v60.0/limits`, { headers: { Authorization: `Bearer ${payload.access_token}` } });
        if (r.status === 401) return fail("Invalid/expired Salesforce token");
        if (!r.ok) return fail(`Salesforce error (HTTP ${r.status})`);
        return ok({ instance_url: base });
      }
      case "attio":
        return payload.api_key
          ? bearer("https://api.attio.com/v2/self", payload.api_key)
          : fail("API key required");
      case "factorial":
        return payload.api_key
          ? bearer("https://api.factorialhr.com/api/v1/employees", payload.api_key, {}, "read_only", { "x-api-key": payload.api_key })
          : fail("API key required");
      case "linear": {
        const key = payload.api_key;
        if (!key) return fail("api_key required");
        const r = await fetchJson("https://api.linear.app/graphql", {
          method: "POST",
          headers: { Authorization: key, "Content-Type": "application/json" },
          body: JSON.stringify({ query: "{ viewer { id name } }" }),
        });
        if (!r.ok) return fail("Invalid Linear key");
        return ok({});
      }
      case "notion": {
        const key = payload.api_key;
        if (!key) return fail("token required");
        const r = await fetchJson("https://api.notion.com/v1/users/me", {
          headers: { Authorization: `Bearer ${key}`, "Notion-Version": "2022-06-28" },
        });
        if (!r.ok) return fail("Invalid Notion token");
        return ok({});
      }
      case "algolia": {
        if (!payload.app_id || !payload.api_key) return fail("app_id + api_key required");
        const r = await fetchJson(`https://${payload.app_id}-dsn.algolia.net/1/indexes`, {
          headers: { "X-Algolia-API-Key": payload.api_key, "X-Algolia-Application-Id": payload.app_id },
        });
        if (!r.ok) return fail("Invalid Algolia credentials");
        return ok({ app_id: payload.app_id });
      }
      case "twilio": {
        if (!payload.account_sid || !payload.api_key) return fail("account_sid + auth token required");
        const auth = btoa(`${payload.account_sid}:${payload.api_key}`);
        const r = await fetchJson(`https://api.twilio.com/2010-04-01/Accounts/${payload.account_sid}.json`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (!r.ok) return fail("Invalid Twilio credentials");
        return ok({ account_sid: payload.account_sid }, "write_enabled");
      }
      case "buffer": {
        if (!payload.access_token) return fail("access_token required");
        // Modern Buffer uses a GraphQL API at api.buffer.com with a Bearer token.
        const r = await fetchJson("https://api.buffer.com/", {
          method: "POST",
          headers: { Authorization: `Bearer ${payload.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "query { account { email currentOrganization { id channels { id } } } }",
          }),
        });
        const body = r.body as { data?: { account?: { currentOrganization?: { channels?: unknown[] } } }; errors?: unknown };
        if (!r.ok || body?.errors || !body?.data?.account) {
          return fail("Buffer rejected the token. Generate an access token from your Buffer account and paste it here.");
        }
        const channels = body.data.account.currentOrganization?.channels?.length ?? 0;
        return ok({ channels }, "write_enabled");
      }
      case "typefully":
      case "hypefury":
        return payload.api_key ? ok({}, "write_enabled") : fail("api_key required");
      case "x": {
        // Validate the bearer token against the X API v2 (me endpoint may be
        // restricted on some tiers; fall back to a tweets lookup which is broadly allowed).
        const t = payload.bearer_token;
        if (!t) return fail("bearer_token required");
        const r = await fetchJson("https://api.twitter.com/2/users/me", { headers: { Authorization: `Bearer ${t}` } });
        if (r.status === 401) return fail("Invalid X bearer token");
        return ok({}, "write_enabled");
      }
      case "linkedin": {
        const t = payload.access_token;
        if (!t) return fail("access_token required");
        const r = await fetchJson("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${t}` } });
        if (r.status === 401) return fail("Invalid or expired LinkedIn access token");
        return ok({}, "write_enabled");
      }
      case "social-webhook":
        return payload.webhook_url ? ok({ webhook: true }, "write_enabled") : fail("webhook_url required");

      case "segment":
        // A write key is used to POST events; validate format (no cheap read API).
        return payload.api_key && payload.api_key.length >= 10
          ? ok({}, "write_enabled")
          : fail("A valid Segment write key is required");
      case "upstash": {
        // Upstash Redis REST: api_key is the REST token, host is the REST URL.
        if (!payload.api_key) return fail("api_key required");
        if (payload.host) {
          const r = await fetchJson(`${payload.host.replace(/\/$/, "")}/ping`, {
            headers: { Authorization: `Bearer ${payload.api_key}` },
          });
          if (!r.ok) return fail(`Upstash rejected the token (HTTP ${r.status})`);
        }
        return ok({ host: payload.host ?? null });
      }
      case "inngest":
        return payload.api_key && payload.api_key.length >= 8
          ? ok({}, "write_enabled")
          : fail("A valid Inngest event key is required");

      // ── HR / People ──
      case "bamboohr": {
        if (!payload.subdomain || !payload.api_key) return fail("subdomain + api_key required");
        // BambooHR uses HTTP Basic: api_key as username, any password.
        const r = await fetchJson(`https://api.bamboohr.com/api/gateway.php/${payload.subdomain}/v1/employees/directory`, {
          headers: { Authorization: `Basic ${btoa(`${payload.api_key}:x`)}`, Accept: "application/json" },
        });
        if (r.status === 401) return fail("Invalid BambooHR API key or subdomain");
        if (!r.ok && r.status !== 403) return fail(`BambooHR error (HTTP ${r.status})`);
        return ok({ subdomain: payload.subdomain });
      }
      case "greenhouse":
        return payload.api_key
          ? bearer("https://harvest.greenhouse.io/v1/jobs?per_page=1", payload.api_key, {}, "read_only", {
              Authorization: `Basic ${btoa(`${payload.api_key}:`)}`,
            })
          : fail("api_key required");
      case "deel":
        return payload.api_key ? bearer("https://api.letsdeel.com/rest/v2/people", payload.api_key) : fail("api_key required");
      case "personio": {
        if (!payload.client_id || !payload.client_secret) return fail("client_id + client_secret required");
        const r = await fetchJson("https://api.personio.de/v1/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: payload.client_id, client_secret: payload.client_secret }),
        });
        if (!r.ok) return fail("Invalid Personio credentials");
        return ok({});
      }

      // ── Design ──
      case "figma":
        return payload.api_key
          ? bearer("https://api.figma.com/v1/me", payload.api_key, {}, "read_only", { "X-Figma-Token": payload.api_key })
          : fail("Personal access token required");
      case "unsplash":
        return payload.api_key
          ? bearer(`https://api.unsplash.com/me`, payload.api_key, {}, "read_only", { Authorization: `Client-ID ${payload.api_key}` })
          : fail("Access key required");
      case "cloudinary-design": {
        if (!payload.cloud_name || !payload.api_key || !payload.api_secret) return fail("cloud_name + api_key + api_secret required");
        const auth = btoa(`${payload.api_key}:${payload.api_secret}`);
        const r = await fetchJson(`https://api.cloudinary.com/v1_1/${payload.cloud_name}/usage`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (r.status === 401) return fail("Invalid Cloudinary credentials");
        return ok({ cloud_name: payload.cloud_name }, "write_enabled");
      }
      case "canva":
        // Canva Connect uses OAuth; accept a token and validate format here.
        return payload.api_key && payload.api_key.length >= 8 ? ok({}, "write_enabled") : fail("A Canva API token is required");

      // ── Data & analytics ──
      case "airtable":
        return payload.api_key
          ? bearer("https://api.airtable.com/v0/meta/whoami", payload.api_key)
          : fail("Personal access token required");
      case "metabase": {
        if (!payload.base_url || !payload.api_key) return fail("base_url + api_key required");
        const base = String(payload.base_url).replace(/\/+$/, "");
        const r = await fetchJson(`${base}/api/user/current`, { headers: { "x-api-key": payload.api_key } });
        if (r.status === 401) return fail("Invalid Metabase API key");
        if (!r.ok) return fail(`Metabase error (HTTP ${r.status})`);
        return ok({ base_url: base });
      }
      case "bigquery": {
        // Validate the service account by minting a Google token (datastore scope
        // also works for BigQuery read via the cloud-platform scope).
        if (!payload.project_id || !payload.service_account) return fail("project_id + service_account JSON required");
        try {
          await getGoogleAccessToken(payload.service_account, ["https://www.googleapis.com/auth/bigquery.readonly"]);
          return ok({ project_id: payload.project_id }, "read_only");
        } catch (e) {
          return fail(e instanceof Error ? e.message : "Invalid service account");
        }
      }
      case "googlesheets": {
        if (!payload.service_account) return fail("service_account JSON required");
        try {
          await getGoogleAccessToken(payload.service_account, ["https://www.googleapis.com/auth/spreadsheets"]);
          return ok({}, "write_enabled");
        } catch (e) {
          return fail(e instanceof Error ? e.message : "Invalid service account");
        }
      }
      case "snowflake":
        // Snowflake auth needs its driver/SQL API session; accept connection
        // details (validated on first query by the data adapter).
        return payload.account && payload.username && payload.password
          ? ok({ account: payload.account }, "read_only")
          : fail("account + username + password required");

      default:
        // Unknown provider: accept if it has any field, store as-is (best effort).
        return Object.keys(payload).length > 0
          ? ok({ note: "stored without live validation" })
          : fail(`Unknown provider ${provider}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
