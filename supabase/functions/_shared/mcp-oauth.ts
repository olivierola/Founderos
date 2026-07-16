// MCP OAuth 2.1 helper (the MCP "Authorization" spec) for Deno edge functions.
// Covers: 401 probe + resource/authorization-server metadata discovery
// (RFC 9728 / RFC 8414), Dynamic Client Registration (RFC 7591), PKCE, the
// authorization-code exchange and refresh, plus ensureAccessToken() used by the
// run loop to keep a fresh Bearer token. All server-side (secrets never reach the
// browser). Tokens are stored per server in mcp_oauth_secrets (service-role only).

export interface OAuthServerConfig {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

const PROTOCOL_VERSION = "2025-06-18";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export function randomState(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Discover the OAuth config for an MCP server: probe for a 401 + resource
// metadata pointer, resolve the authorization server, then read its metadata.
export async function discoverOAuth(
  mcpUrl: string,
  staticHeaders: Record<string, string>,
): Promise<{ ok: boolean; error?: string; config?: OAuthServerConfig; resource: string }> {
  const resource = mcpUrl;
  let prmUrl: string | undefined;

  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", ...staticHeaders },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "founderos", version: "1.0" } } }),
    });
    if (res.status === 401) {
      const wa = res.headers.get("www-authenticate") || "";
      const m = wa.match(/resource_metadata="?([^",\s]+)"?/i);
      if (m) prmUrl = m[1];
    }
  } catch { /* fall through to well-known probing */ }

  const origin = new URL(mcpUrl).origin;
  const prm = (prmUrl && await fetchJson(prmUrl)) || await fetchJson(`${origin}/.well-known/oauth-protected-resource`);
  const authServers: string[] = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers : [];
  const asBase = (authServers[0] || origin).replace(/\/$/, "");
  const resourceId = (typeof prm?.resource === "string" && prm.resource) || resource;

  let asPath = "";
  try { asPath = new URL(asBase).pathname.replace(/\/$/, ""); } catch { /* asBase not a full URL */ }
  const asMeta =
    await fetchJson(`${asBase}/.well-known/oauth-authorization-server`) ||
    await fetchJson(`${asBase}/.well-known/openid-configuration`) ||
    (asPath ? await fetchJson(`${asBase}/.well-known/oauth-authorization-server${asPath}`) : null);

  if (!asMeta?.authorization_endpoint || !asMeta?.token_endpoint) {
    return { ok: false, error: "Impossible de découvrir le serveur d'autorisation (aucune métadonnée OAuth trouvée).", resource: resourceId };
  }
  return {
    ok: true,
    resource: resourceId,
    config: {
      authorization_endpoint: asMeta.authorization_endpoint,
      token_endpoint: asMeta.token_endpoint,
      registration_endpoint: asMeta.registration_endpoint,
      scopes_supported: Array.isArray(asMeta.scopes_supported) ? asMeta.scopes_supported : undefined,
    },
  };
}

// Dynamic Client Registration (RFC 7591). Public client + PKCE by default.
// clientName is configurable because some servers (e.g. Figma) allowlist it and
// reject unknown names with 403.
export async function registerClient(
  registrationEndpoint: string, redirectUri: string, scope?: string, clientName = "FounderOS AI Workforce",
): Promise<{ client_id?: string; client_secret?: string; error?: string }> {
  try {
    const res = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(scope ? { scope } : {}),
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.client_id) return { error: j.error_description || j.error || `Dynamic client registration a échoué (${res.status})` };
    return { client_id: j.client_id, client_secret: j.client_secret };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function buildAuthorizeUrl(opts: {
  authorization_endpoint: string; client_id: string; redirect_uri: string;
  code_challenge: string; state: string; scope?: string; resource: string;
}): string {
  const u = new URL(opts.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.client_id);
  u.searchParams.set("redirect_uri", opts.redirect_uri);
  u.searchParams.set("code_challenge", opts.code_challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("resource", opts.resource);
  if (opts.scope) u.searchParams.set("scope", opts.scope);
  return u.toString();
}

async function tokenRequest(tokenEndpoint: string, form: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string }> {
  try {
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) return { error: j.error_description || j.error || `token endpoint a échoué (${res.status})` };
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: Number(j.expires_in) || undefined };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function exchangeCode(opts: {
  token_endpoint: string; code: string; redirect_uri: string; client_id: string;
  client_secret?: string; code_verifier: string; resource: string;
}) {
  return tokenRequest(opts.token_endpoint, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirect_uri,
    client_id: opts.client_id,
    code_verifier: opts.code_verifier,
    resource: opts.resource,
    ...(opts.client_secret ? { client_secret: opts.client_secret } : {}),
  });
}

export function refreshAccessToken(opts: {
  token_endpoint: string; refresh_token: string; client_id: string; client_secret?: string; resource?: string;
}) {
  return tokenRequest(opts.token_endpoint, {
    grant_type: "refresh_token",
    refresh_token: opts.refresh_token,
    client_id: opts.client_id,
    ...(opts.resource ? { resource: opts.resource } : {}),
    ...(opts.client_secret ? { client_secret: opts.client_secret } : {}),
  });
}

// Return a fresh access token for an oauth server, refreshing (and persisting)
// when it's within 60s of expiry. `admin` is a service-role client. Returns null
// when the server isn't connected.
export async function ensureAccessToken(
  admin: { from: (t: string) => any },
  server: { id: string; oauth: Record<string, any> },
): Promise<string | null> {
  const { data: sec } = await admin
    .from("mcp_oauth_secrets")
    .select("access_token, refresh_token, expires_at, client_secret")
    .eq("server_id", server.id)
    .maybeSingle();
  if (!sec?.access_token) return null;

  const exp = sec.expires_at ? new Date(sec.expires_at).getTime() : 0;
  if (!exp || exp - Date.now() > 60_000) return sec.access_token; // still valid

  const oauth = server.oauth || {};
  if (!sec.refresh_token || !oauth.token_endpoint || !oauth.client_id) return sec.access_token;

  const r = await refreshAccessToken({
    token_endpoint: oauth.token_endpoint,
    refresh_token: sec.refresh_token,
    client_id: oauth.client_id,
    client_secret: sec.client_secret ?? undefined,
    resource: oauth.resource,
  });
  if (r.access_token) {
    await admin.from("mcp_oauth_secrets").update({
      access_token: r.access_token,
      refresh_token: r.refresh_token ?? sec.refresh_token,
      expires_at: r.expires_in ? new Date(Date.now() + r.expires_in * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq("server_id", server.id);
    return r.access_token;
  }
  return sec.access_token;
}
