// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/mcp-gateway/index.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { defineHandler } from "../../compat/index.ts";

// mcp-gateway — discover / test a remote MCP server on behalf of the UI.
//
// Body:
//   { action: "discover", server_id }        → handshake + tools/list an existing
//                                               server, CACHE the tools + status
//                                               on the mcp_servers row.
//   { action: "test", url, headers, transport } → same, for a DRAFT config (not yet
//                                               saved); returns the tools without
//                                               persisting.
//   { action: "set_token", server_id, token } → enregistre le jeton d'API du serveur
//                                               (chiffré, illisible ensuite ; 0278).
//   { action: "set_headers", server_id, headers } → remplace ses en-têtes statiques
//                                               (chiffrés, 0280). Une valeur vide garde
//                                               la valeur enregistrée sous ce nom.
//   « test » d'un brouillon avec draft_of : les valeurs laissées vides reprennent
//   celles du serveur enregistré, seulement vers la même destination.
//
// Auth: the caller's JWT drives an RLS-scoped client, so a user can only touch MCP
// servers in a workspace they belong to. The actual MCP tool CALLS at run time
// happen inside internal-agent-run (already server-side) — this function only
// covers discovery/testing (which the browser can't do directly: CORS + secrets).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { mcpDiscoverTools } from "../_shared/mcp-client.ts";
import { assertSafeUrl } from "../_shared/ssrf.ts";
import { relayFetchFor } from "../_shared/mcp-relay.ts";
import { requireUser } from "../_shared/authz.ts";
import { ensureAccessToken } from "../_shared/mcp-oauth.ts";
import { mcpDiscoveryHeaders } from "../_shared/mcp-auth.ts";
import { apiTokenHeaders, loadMcpApiTokens, saveMcpApiToken } from "../_shared/mcp-api-token.ts";
import { loadMcpHeaders, mergeMcpHeaders, resolveHeaderInput, saveMcpHeaders, urlOrigin } from "../_shared/mcp-headers.ts";

export default defineHandler(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json().catch(() => ({}));

    // La branche "test" n'utilisait pas le client RLS ci-dessous : elle prenait
    // url + headers dans le corps et partait. Le deploiement etant en
    // --no-verify-jwt, elle etait donc joignable sans session du tout (FOS-11).
    const user = await requireUser(req);
    if (!user.ok) return user.response;

    const supa = createUserClient(req);

    // Jeton d'API : seul quelqu'un qui peut modifier ce serveur (RLS) l'enregistre.
    if (body.action === "set_token") {
      const sid = String(body.server_id ?? "");
      const { data: rows, error: updErr } = await supa.from("mcp_servers")
        .update({ updated_at: new Date().toISOString() }).eq("id", sid).select("id");
      if (updErr || !rows || (rows as unknown[]).length === 0) {
        return jsonResponse({ ok: false, error: "Serveur introuvable, ou modification non autorisée." }, { status: 403 });
      }
      try {
        const out = await saveMcpApiToken(createServiceClient(), sid, String(body.token ?? "").trim(), user.userId);
        return jsonResponse({ ok: true, hint: out.hint });
      } catch (e) {
        return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }

    // En-têtes statiques : même règle que le jeton d'API. Après un changement de
    // destination, la garde de 0280 a déjà effacé les valeurs enregistrées : une
    // valeur laissée vide ne retrouve alors rien et doit être ressaisie.
    if (body.action === "set_headers") {
      const sid = String(body.server_id ?? "");
      const { data: rows, error: updErr } = await supa.from("mcp_servers")
        .update({ updated_at: new Date().toISOString() }).eq("id", sid).select("id");
      if (updErr || !rows || (rows as unknown[]).length === 0) {
        return jsonResponse({ ok: false, error: "Serveur introuvable, ou modification non autorisée." }, { status: 403 });
      }
      try {
        const admin = createServiceClient();
        const stored = (await loadMcpHeaders(admin, [sid])).get(sid) ?? {};
        const out = await saveMcpHeaders(admin, sid, resolveHeaderInput(body.headers ?? {}, stored));
        return jsonResponse({ ok: true, hints: out.hints });
      } catch (e) {
        return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }

    let url = "";
    let headers: Record<string, string> = {};
    let serverId: string | null = null;
    let tokenExchangeAudience: string | null = null;
    let tokenExchangeProvider: string | null = null;
    let identityMode: "token_exchange" | "signed_context" = "token_exchange";
    let relay: { id: string; workspaceId: string } | null = null;

    if (body.server_id) {
      serverId = String(body.server_id);
      const { data, error } = await supa
        .from("mcp_servers").select("id, url, auth_mode, auth_config, oauth, relay_id, workspace_id").eq("id", serverId).maybeSingle();
      if (error || !data) return jsonResponse({ ok: false, error: "server not found or access denied" }, { status: 404 });
      url = String(data.url);
      // En-têtes statiques (0280), lus par le rôle de service : la lecture
      // ci-dessus (RLS) a vérifié l'accès, et ils partent vers l'URL enregistrée.
      headers = (await loadMcpHeaders(createServiceClient(), [serverId])).get(serverId) ?? {};
      // OAuth server: attach a fresh Bearer token (secrets are service-role only).
      if ((data as { auth_mode?: string }).auth_mode === "oauth") {
        const token = await ensureAccessToken(createServiceClient(), { id: serverId, oauth: (data as { oauth?: Record<string, unknown> }).oauth || {} });
        if (token) headers = mergeMcpHeaders(headers, { Authorization: `Bearer ${token}` });
      }
      const savedAuth = ((data as { auth_config?: { audience?: string; provider?: string } }).auth_config ?? {});
      const savedMode = (data as { auth_mode?: string }).auth_mode;
      tokenExchangeAudience = savedMode === "token_exchange" || savedMode === "signed_context"
        ? String(savedAuth.audience ?? "")
        : null;
      if (savedMode === "signed_context") identityMode = "signed_context";
      tokenExchangeProvider = savedAuth.provider ?? null;
      const saved = data as { relay_id?: string | null; workspace_id?: string };
      if (saved.relay_id && saved.workspace_id) relay = { id: saved.relay_id, workspaceId: saved.workspace_id };
      if (savedMode === "api_token") {
        const token = (await loadMcpApiTokens(createServiceClient(), [serverId])).get(serverId);
        if (!token) return jsonResponse({ ok: false, error: "Aucun jeton d'API enregistré pour ce serveur.", tools: [] });
        headers = mergeMcpHeaders(headers, apiTokenHeaders({ token, userId: user.userId, agentName: "founderos-discovery" }));
      }
    } else {
      url = String(body.url ?? "");
      tokenExchangeAudience = body.auth_mode === "token_exchange" || body.auth_mode === "signed_context" ? String(body.auth_config?.audience ?? "") : null;
      if (body.auth_mode === "signed_context") identityMode = "signed_context";
      tokenExchangeProvider = typeof body.auth_config?.provider === "string" ? body.auth_config.provider : null;
      // Brouillon joint par un relais : le relais doit être visible de la personne (RLS).
      if (typeof body.relay_id === "string" && body.relay_id) {
        const { data: r } = await supa.from("connector_relays").select("id, workspace_id, status").eq("id", body.relay_id).maybeSingle();
        const rr = r as { id: string; workspace_id: string; status: string } | null;
        if (!rr || rr.status !== "active") return jsonResponse({ ok: false, error: "Relais introuvable ou révoqué.", tools: [] }, { status: 404 });
        relay = { id: rr.id, workspaceId: rr.workspace_id };
      }
      // Brouillon d'un serveur enregistré : une valeur d'en-tête laissée vide
      // reprend la valeur enregistrée, mais seulement si le brouillon vise la
      // même destination (origine de l'URL, relais). Sinon, n'importe quel
      // membre qui voit le serveur pourrait envoyer ses secrets ailleurs.
      let stored: Record<string, string> = {};
      if (typeof body.draft_of === "string" && body.draft_of) {
        const { data: saved } = await supa.from("mcp_servers").select("id, url, relay_id").eq("id", body.draft_of).maybeSingle();
        const sv = saved as { id: string; url: string; relay_id: string | null } | null;
        if (sv && urlOrigin(sv.url) === urlOrigin(url) && (sv.relay_id ?? null) === (relay?.id ?? null)) {
          stored = (await loadMcpHeaders(createServiceClient(), [sv.id])).get(sv.id) ?? {};
        }
      }
      try {
        headers = resolveHeaderInput(body.headers ?? {}, stored);
      } catch (e) {
        return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e), tools: [] }, { status: 400 });
      }
      // Brouillon en jeton d'API : le jeton saisi sert au test, sans être enregistré.
      if (body.auth_mode === "api_token" && typeof body.api_token === "string" && body.api_token.trim()) {
        headers = mergeMcpHeaders(headers, apiTokenHeaders({ token: body.api_token.trim(), userId: user.userId, agentName: "founderos-discovery" }));
      }
    }

    // Serveur interne (échange de jeton) : tools/list avec un jeton de découverte,
    // émis au compte de service d'un client d'agent autorisé pour cette audience.
    if (tokenExchangeAudience !== null) {
      if (!tokenExchangeAudience) return jsonResponse({ ok: false, error: "auth_config.audience requis", tools: [] }, { status: 400 });
      try {
        headers = mergeMcpHeaders(headers, await mcpDiscoveryHeaders(url, tokenExchangeAudience, {
          admin: createServiceClient(), provider: tokenExchangeProvider, viaRelay: !!relay, mode: identityMode, userId: user.userId,
        }));
      } catch (e) {
        return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e), tools: [] });
      }
    }

    if (!/^https?:\/\//i.test(url)) {
      return jsonResponse({ ok: false, error: "url must be an absolute http(s) URL" }, { status: 400 });
    }

    // FOS-11 : jusqu'ici la seule validation était la ligne ci-dessus, qui laisse
    // passer 127.0.0.1, 169.254.169.254 et tout service interne — et la liste
    // d'outils comme les messages d'erreur repartaient vers l'appelant, ce qui en
    // faisait un oracle de découverte réseau.
    // Par le relais (G2), l'URL est interne par nature : c'est la liste blanche
    // du relais, chez le client, qui décide de ce qui est joignable.
    if (!relay) {
      const verdict = await assertSafeUrl(url);
      if (!verdict.ok) {
        return jsonResponse({ ok: false, error: verdict.reason, tools: [] }, { status: 400 });
      }
    }

    const transport = relay
      ? { fetch: relayFetchFor(createServiceClient(), { relayId: relay.id, workspaceId: relay.workspaceId, mcpServerId: serverId }) }
      : {};
    const { tools, error, usedUrl } = await mcpDiscoverTools(url, headers, transport);

    // Persist the discovery result on an existing server so the run loop can use
    // the cached tool list without re-handshaking on every tick. Heal the stored
    // URL if a /sse↔/mcp sibling is what actually answered.
    if (serverId) {
      const patch: Record<string, unknown> = {
        cached_tools: error ? [] : tools,
        status: error ? "error" : "ok",
        last_error: error ?? null,
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (!error && usedUrl && usedUrl !== url) patch.url = usedUrl;
      // Rôle de service : la lecture ci-dessus (RLS) a vérifié l'accès, et tout
      // membre peut tester un serveur qu'il ne peut pas modifier (0279). Le
      // patch ne touche qu'au cache et, au plus, au chemin de l'URL (même
      // origine : les secrets restent liés, 0278 et 0279).
      await createServiceClient().from("mcp_servers").update(patch).eq("id", serverId);
    }

    if (error) return jsonResponse({ ok: false, error, tools: [] });
    return jsonResponse({ ok: true, tools, count: tools.length });
  } catch (e) {
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
