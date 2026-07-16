// mcp-oauth — drive the MCP OAuth 2.1 authorization flow for a server.
//
//   { action: "start", server_id, redirect_uri }
//     → discover the authorization server, (dynamically) register a client, mint
//       PKCE + state, persist them, and return an `authorize_url` for the browser.
//
//   { action: "callback", code, state }
//     → match the in-flight authorization by `state`, exchange the code for
//       tokens, store them, mark the server connected, and cache its tools.
//
// The `start` action verifies the caller can access the server (user JWT / RLS).
// The `callback` is matched by the secret `state` and runs with the service role
// (secrets live in mcp_oauth_secrets, which has no RLS policy).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { mcpDiscoverTools } from "../_shared/mcp-client.ts";
import {
  discoverOAuth, registerClient, buildAuthorizeUrl, exchangeCode, pkce, randomState,
} from "../_shared/mcp-oauth.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const admin = createServiceClient();

    // ── START ────────────────────────────────────────────────────────────────
    if (action === "start") {
      const serverId = String(body.server_id ?? "");
      const redirectUri = String(body.redirect_uri ?? "");
      if (!serverId || !/^https?:\/\//i.test(redirectUri)) {
        return jsonResponse({ ok: false, error: "server_id et redirect_uri (http(s)) sont requis" }, { status: 400 });
      }
      // Access check via the caller's RLS-scoped client.
      const user = createUserClient(req);
      const { data: srv } = await user.from("mcp_servers").select("id, url, headers, oauth").eq("id", serverId).maybeSingle();
      if (!srv) return jsonResponse({ ok: false, error: "serveur introuvable ou accès refusé" }, { status: 404 });

      const staticHeaders = srv.headers && typeof srv.headers === "object" ? srv.headers as Record<string, string> : {};
      const prevOauth = (srv.oauth && typeof srv.oauth === "object") ? srv.oauth as Record<string, any> : {};

      // Endpoints: use the manually-configured ones if present, else discover.
      let authorizationEndpoint: string;
      let tokenEndpoint: string;
      let registrationEndpoint: string | undefined = prevOauth.registration_endpoint || undefined;
      let resource: string;
      let discoveredScopes: string[] | undefined;
      if (prevOauth.authorization_endpoint && prevOauth.token_endpoint) {
        authorizationEndpoint = prevOauth.authorization_endpoint;
        tokenEndpoint = prevOauth.token_endpoint;
        resource = prevOauth.resource || String(srv.url);
      } else {
        const disc = await discoverOAuth(String(srv.url), staticHeaders);
        if (!disc.ok || !disc.config) return jsonResponse({ ok: false, error: disc.error ?? "découverte OAuth impossible" });
        authorizationEndpoint = disc.config.authorization_endpoint;
        tokenEndpoint = disc.config.token_endpoint;
        registrationEndpoint = disc.config.registration_endpoint || undefined;
        resource = disc.resource;
        discoveredScopes = disc.config.scopes_supported;
      }

      const scope: string | undefined = prevOauth.scope || (discoveredScopes?.length ? discoveredScopes.join(" ") : undefined);

      // Reuse a manually-set or previously-registered client, else try DCR. When
      // DCR isn't allowed (403) the user can supply a Client ID in the form.
      let clientId: string | undefined = prevOauth.client_id;
      let clientSecret: string | undefined;
      if (!clientId) {
        if (!registrationEndpoint) {
          return jsonResponse({ ok: false, error: "Ce serveur ne supporte pas l'enregistrement dynamique — renseignez un Client ID (et secret) manuellement dans le formulaire du serveur." });
        }
        const reg = await registerClient(registrationEndpoint, redirectUri, scope, prevOauth.client_name || undefined);
        if (reg.error || !reg.client_id) {
          return jsonResponse({ ok: false, error: `${reg.error ?? "enregistrement du client échoué"} — ce serveur restreint peut-être l'enregistrement dynamique (ex. Figma allowliste le « Client name »). Renseignez un Client name accepté et/ou un Client ID manuellement dans le formulaire du serveur.` });
        }
        clientId = reg.client_id;
        clientSecret = reg.client_secret;
      }

      const { verifier, challenge } = await pkce();
      const state = randomState();

      await admin.from("mcp_servers").update({
        auth_mode: "oauth",
        oauth: {
          ...prevOauth,
          status: "connecting",
          authorization_endpoint: authorizationEndpoint,
          token_endpoint: tokenEndpoint,
          registration_endpoint: registrationEndpoint ?? null,
          scope: scope ?? null,
          resource,
          client_id: clientId,
        },
        updated_at: new Date().toISOString(),
      }).eq("id", serverId);

      await admin.from("mcp_oauth_secrets").upsert({
        server_id: serverId,
        ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
        code_verifier: verifier,
        state,
        redirect_uri: redirectUri,
        updated_at: new Date().toISOString(),
      });

      const authorizeUrl = buildAuthorizeUrl({
        authorization_endpoint: authorizationEndpoint,
        client_id: clientId!,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        state,
        scope,
        resource,
      });
      return jsonResponse({ ok: true, authorize_url: authorizeUrl });
    }

    // ── CALLBACK ───────────────────────────────────────────────────────────────
    if (action === "callback") {
      const code = String(body.code ?? "");
      const state = String(body.state ?? "");
      if (!code || !state) return jsonResponse({ ok: false, error: "code et state requis" }, { status: 400 });

      const { data: sec } = await admin.from("mcp_oauth_secrets")
        .select("server_id, code_verifier, client_secret, redirect_uri").eq("state", state).maybeSingle();
      if (!sec?.server_id) return jsonResponse({ ok: false, error: "state invalide ou expiré" }, { status: 400 });

      const { data: srv } = await admin.from("mcp_servers").select("id, url, headers, oauth").eq("id", sec.server_id).maybeSingle();
      if (!srv) return jsonResponse({ ok: false, error: "serveur introuvable" }, { status: 404 });
      const oauth = (srv.oauth && typeof srv.oauth === "object") ? srv.oauth as Record<string, any> : {};

      const tok = await exchangeCode({
        token_endpoint: oauth.token_endpoint,
        code,
        redirect_uri: sec.redirect_uri,
        client_id: oauth.client_id,
        client_secret: sec.client_secret ?? undefined,
        code_verifier: sec.code_verifier,
        resource: oauth.resource,
      });
      if (tok.error || !tok.access_token) {
        // A concurrent/duplicate callback (single-use code) may have already
        // connected — don't clobber a good token with an error status.
        const { data: existing } = await admin.from("mcp_oauth_secrets").select("access_token").eq("server_id", srv.id).maybeSingle();
        if (existing?.access_token) return jsonResponse({ ok: true, duplicate: true });
        await admin.from("mcp_servers").update({ oauth: { ...oauth, status: "error" } }).eq("id", srv.id);
        return jsonResponse({ ok: false, error: tok.error ?? "échange du code échoué" });
      }

      await admin.from("mcp_oauth_secrets").update({
        access_token: tok.access_token,
        refresh_token: tok.refresh_token ?? null,
        expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
        code_verifier: null,
        state: null,
        updated_at: new Date().toISOString(),
      }).eq("server_id", srv.id);

      await admin.from("mcp_servers").update({
        oauth: { ...oauth, status: "connected", connected_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }).eq("id", srv.id);

      // Discover tools now that we're authenticated, and cache them. Heal a stale
      // /sse↔/mcp URL if the sibling is what actually answered.
      const staticHeaders = srv.headers && typeof srv.headers === "object" ? srv.headers as Record<string, string> : {};
      const { tools, error, usedUrl } = await mcpDiscoverTools(String(srv.url), { ...staticHeaders, Authorization: `Bearer ${tok.access_token}` });
      const patch: Record<string, unknown> = {
        cached_tools: error ? [] : tools,
        status: error ? "error" : "ok",
        last_error: error ?? null,
        last_checked_at: new Date().toISOString(),
      };
      if (!error && usedUrl && usedUrl !== String(srv.url)) patch.url = usedUrl;
      await admin.from("mcp_servers").update(patch).eq("id", srv.id);

      return jsonResponse({ ok: true, tools: tools?.length ?? 0 });
    }

    // ── CONFIG ─────────────────────────────────────────────────────────────────
    // Persist manual OAuth settings (for servers without Dynamic Client
    // Registration or without discovery): client_id/secret, scope, and optional
    // endpoint overrides. client_secret lands in the service-role-only secrets.
    if (action === "config") {
      const serverId = String(body.server_id ?? "");
      if (!serverId) return jsonResponse({ ok: false, error: "server_id requis" }, { status: 400 });
      const user = createUserClient(req);
      const { data: srv } = await user.from("mcp_servers").select("id, oauth").eq("id", serverId).maybeSingle();
      if (!srv) return jsonResponse({ ok: false, error: "serveur introuvable ou accès refusé" }, { status: 404 });

      const oauth = (srv.oauth && typeof srv.oauth === "object") ? { ...srv.oauth as Record<string, any> } : {};
      const setStr = (key: string, val: unknown) => { if (val !== undefined) oauth[key] = String(val).trim() || null; };
      setStr("client_id", body.client_id);
      setStr("client_name", body.client_name);
      setStr("scope", body.scope);
      setStr("authorization_endpoint", body.authorization_endpoint);
      setStr("token_endpoint", body.token_endpoint);
      setStr("resource", body.resource);

      await admin.from("mcp_servers").update({ auth_mode: "oauth", oauth, updated_at: new Date().toISOString() }).eq("id", serverId);

      // Only touch the secret when the caller actually sent one.
      if (body.client_secret !== undefined) {
        await admin.from("mcp_oauth_secrets").upsert({
          server_id: serverId,
          client_secret: String(body.client_secret).trim() || null,
          updated_at: new Date().toISOString(),
        });
      }
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: "action inconnue" }, { status: 400 });
  } catch (e) {
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
