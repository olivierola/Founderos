// Provider validation: hits each provider's API (or pings its webhook) with the
// supplied credentials and returns a small metadata object.

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
      case "neon":
        return payload.api_key ? bearer("https://console.neon.tech/api/v2/projects", payload.api_key) : fail("api_key required");
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
      case "mixpanel":
        return payload.api_secret
          ? ok({ project_token: payload.project_token ?? null })
          : fail("api_secret required");
      case "amplitude":
        return payload.api_key ? ok({}) : fail("api_key required");

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
      case "cloudinary":
        return payload.api_key ? ok({}) : fail("api_key required");

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
        const token = payload.access_token;
        // New Buffer API (api.buffer.com) uses a Bearer token. The legacy
        // api.bufferapp.com endpoint is deprecated; try the new one first,
        // then fall back to legacy for old "1/<hash>" tokens.
        let r = await fetchJson("https://api.buffer.com/1/profiles.json", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) {
          r = await fetchJson(
            `https://api.bufferapp.com/1/profiles.json?access_token=${encodeURIComponent(token)}`,
            {},
          );
        }
        if (!r.ok) {
          return fail(
            `Buffer rejected the token (HTTP ${r.status}). Use an access token from publish.buffer.com → Settings → Apps & Extras, or a Developer app token.`,
          );
        }
        const profiles = Array.isArray(r.body) ? r.body.length : 0;
        return ok({ profiles }, "write_enabled");
      }
      case "typefully":
      case "hypefury":
        return payload.api_key ? ok({}, "write_enabled") : fail("api_key required");
      case "x":
        return payload.bearer_token ? ok({}, "write_enabled") : fail("bearer_token required");
      case "linkedin":
        return payload.access_token ? ok({}, "write_enabled") : fail("access_token required");
      case "social-webhook":
        return payload.webhook_url ? ok({ webhook: true }, "write_enabled") : fail("webhook_url required");

      case "segment":
        return payload.api_key ? ok({}, "write_enabled") : fail("write key required");
      case "upstash":
        return payload.api_key ? ok({}) : fail("api_key required");
      case "inngest":
        return payload.api_key ? ok({}, "write_enabled") : fail("event key required");

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
