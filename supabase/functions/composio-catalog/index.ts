// composio-catalog — proxies Composio's toolkit catalogue server-side so the
// COMPOSIO_API_KEY never reaches the browser.
// Body: { search?, category? }        → the catalogue
//       { toolkit_slug }              → one toolkit's auth-config fields
// Auth: any authenticated workspace member (read-only, no secrets returned).
//
// Composio's full catalogue (~1050 toolkits) is exposed, not just the ones it
// can OAuth for us with zero setup — most toolkits are API_KEY/NO_AUTH, which
// composio-connect handles too. Toolkits that are OAuth-only WITHOUT
// Composio-managed auth (Microsoft Power BI, Twitter…) need YOUR OWN
// registered OAuth app: they come back as "oauth_custom" and the connect
// dialog collects the client id/secret, whose expected field names come from
// the toolkit_slug branch below.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createUserClient } from "../_shared/supabase-admin.ts";

export type AuthMode = "oauth" | "oauth_custom" | "api_key" | "none" | "unsupported";

const COMPOSIO_API = "https://backend.composio.dev/api/v3";
const OAUTH_SCHEMES = ["OAUTH2", "OAUTH1", "OAUTH1A"];

/** Redirect URI to register in the provider's OAuth app — Composio's own. */
const COMPOSIO_CALLBACK_URL = "https://backend.composio.dev/api/v3.1/toolkits/auth/callback";

interface SlimToolkit {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  authMode: AuthMode;
  authScheme: string;
  /** Every scheme the toolkit accepts (OAUTH2, API_KEY, BASIC_WITH_JWT…). */
  authSchemes: string[];
  /** Subset of the above that Composio can authenticate for us with no setup. */
  managedSchemes: string[];
  toolsCount: number;
  triggersCount: number;
  /** Composio toolkit version, e.g. "20260721_00". */
  version: string;
}

function pick(t: Record<string, unknown>, camel: string, snake: string): unknown {
  return t[camel] ?? t[snake];
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const { search, category, toolkit_slug } = body as { search?: string; category?: string; toolkit_slug?: string };

    const apiKey = Deno.env.get("COMPOSIO_API_KEY");
    if (!apiKey) return jsonResponse({ error: "COMPOSIO_API_KEY is not configured" }, { status: 500 });

    // Single-toolkit branch: which credentials does its own OAuth app need?
    // Composio spells them out per auth mode, and they vary (client_id/
    // client_secret, plus e.g. a tenant or subdomain for some providers).
    if (toolkit_slug) {
      const res = await fetch(`${COMPOSIO_API}/toolkits/${encodeURIComponent(toolkit_slug)}`, {
        headers: { "x-api-key": apiKey },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return jsonResponse({ error: "Toolkit unavailable", detail: detail.slice(0, 500) }, { status: 502 });
      }
      const tk = await res.json() as Record<string, unknown>;
      const details = (tk.auth_config_details ?? []) as Array<Record<string, unknown>>;
      const modes = details.map((d) => {
        const fields = ((d.fields ?? {}) as Record<string, unknown>).auth_config_creation as
          | { required?: unknown[]; optional?: unknown[] }
          | undefined;
        return {
          mode: String(d.mode ?? ""),
          name: String(d.name ?? d.mode ?? ""),
          authHintUrl: (d.auth_hint_url as string) ?? null,
          required: (fields?.required ?? []) as unknown[],
          optional: (fields?.optional ?? []) as unknown[],
        };
      });
      return jsonResponse({
        slug: String(tk.slug ?? toolkit_slug),
        name: String(tk.name ?? toolkit_slug),
        authGuideUrl: (tk.auth_guide_url as string) ?? null,
        callbackUrl: COMPOSIO_CALLBACK_URL,
        modes,
      });
    }

    // The catalogue is >1000 toolkits and Composio caps `limit` at 1000, so a
    // single page silently truncated the tail (that's why toolkits like
    // microsoft_power_bi never showed up) — we have to follow next_cursor.
    //
    // We hit the REST endpoint directly instead of composio.toolkits.get():
    // the SDK returns a bare array (it maps `items` and drops the pagination
    // envelope), so next_cursor is simply unreachable through it. Same reason
    // its free-text `search` never worked — its param schema is only
    // category/managedBy/sortBy/cursor/limit — so we keep filtering by
    // name/slug/description ourselves below.
    const raw: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${COMPOSIO_API}/toolkits`);
      url.searchParams.set("limit", "1000");
      if (category) url.searchParams.set("category", category);
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url, { headers: { "x-api-key": apiKey } });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return jsonResponse({ error: "Composio catalogue unavailable", detail: detail.slice(0, 500) }, { status: 502 });
      }
      const payload = await res.json() as { items?: Array<Record<string, unknown>>; next_cursor?: string | null };
      const items = payload.items ?? [];
      raw.push(...items);

      cursor = payload.next_cursor ?? null;
      if (!cursor || items.length === 0) break;
    }

    const toolkits: SlimToolkit[] = raw
      .map((t) => {
        const meta = (t.meta ?? {}) as Record<string, unknown>;
        const categories = Array.isArray(meta.categories)
          ? (meta.categories as Array<{ name?: string; id?: string }>).map((c) => c.name ?? c.id ?? "").filter(Boolean)
          : [];
        const authSchemes = (pick(t, "authSchemes", "auth_schemes") as string[]) ?? [];
        const managedSchemes = (pick(t, "composioManagedAuthSchemes", "composio_managed_auth_schemes") as string[]) ?? [];

        let authMode: AuthMode;
        let authScheme: string;
        if (managedSchemes.length > 0) {
          authMode = "oauth"; authScheme = managedSchemes[0];
        } else if (authSchemes.some((s) => ["API_KEY", "BEARER_TOKEN", "BASIC"].includes(s))) {
          authMode = "api_key";
          authScheme = authSchemes.find((s) => ["API_KEY", "BEARER_TOKEN", "BASIC"].includes(s))!;
        } else if (authSchemes.includes("NO_AUTH")) {
          authMode = "none"; authScheme = "NO_AUTH";
        } else if (authSchemes.some((s) => OAUTH_SCHEMES.includes(s))) {
          // OAuth the user must bring their own app for — connectable, but
          // only after we collect its client id/secret.
          authMode = "oauth_custom";
          authScheme = authSchemes.find((s) => OAUTH_SCHEMES.includes(s))!;
        } else {
          authMode = "unsupported"; authScheme = authSchemes[0] ?? "";
        }

        return {
          slug: String(t.slug ?? ""),
          name: String(t.name ?? t.slug ?? ""),
          description: String(meta.description ?? ""),
          logo: (meta.logo as string) ?? null,
          categories,
          authMode,
          authScheme,
          authSchemes,
          managedSchemes,
          toolsCount: Number(pick(meta, "toolsCount", "tools_count") ?? 0),
          triggersCount: Number(pick(meta, "triggersCount", "triggers_count") ?? 0),
          version: String(meta.version ?? ""),
        };
      })
      // A toolkit can come back on more than one page when the catalogue
      // shifts between cursor fetches — keep the first occurrence.
      .filter((t, i, all) => t.slug && all.findIndex((x) => x.slug === t.slug) === i);

    const q = search?.trim().toLowerCase();
    const filtered = q
      ? toolkits.filter((t) =>
          t.name.toLowerCase().includes(q) ||
          t.slug.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q))
      : toolkits;

    return jsonResponse({ toolkits: filtered });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
