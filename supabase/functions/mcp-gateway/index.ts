// mcp-gateway — discover / test a remote MCP server on behalf of the UI.
//
// Body:
//   { action: "discover", server_id }        → handshake + tools/list an existing
//                                               server, CACHE the tools + status
//                                               on the mcp_servers row.
//   { action: "test", url, headers, transport } → same, for a DRAFT config (not yet
//                                               saved); returns the tools without
//                                               persisting.
//
// Auth: the caller's JWT drives an RLS-scoped client, so a user can only touch MCP
// servers in a workspace they belong to. The actual MCP tool CALLS at run time
// happen inside internal-agent-run (already server-side) — this function only
// covers discovery/testing (which the browser can't do directly: CORS + secrets).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { mcpDiscoverTools } from "../_shared/mcp-client.ts";
import { ensureAccessToken } from "../_shared/mcp-oauth.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json().catch(() => ({}));
    const supa = createUserClient(req);

    let url = "";
    let headers: Record<string, string> = {};
    let serverId: string | null = null;

    if (body.server_id) {
      serverId = String(body.server_id);
      const { data, error } = await supa
        .from("mcp_servers").select("id, url, headers, auth_mode, oauth").eq("id", serverId).maybeSingle();
      if (error || !data) return jsonResponse({ ok: false, error: "server not found or access denied" }, { status: 404 });
      url = String(data.url);
      headers = data.headers && typeof data.headers === "object" ? data.headers as Record<string, string> : {};
      // OAuth server: attach a fresh Bearer token (secrets are service-role only).
      if ((data as { auth_mode?: string }).auth_mode === "oauth") {
        const token = await ensureAccessToken(createServiceClient(), { id: serverId, oauth: (data as { oauth?: Record<string, unknown> }).oauth || {} });
        if (token) headers = { ...headers, Authorization: `Bearer ${token}` };
      }
    } else {
      url = String(body.url ?? "");
      headers = body.headers && typeof body.headers === "object" ? body.headers as Record<string, string> : {};
    }

    if (!/^https?:\/\//i.test(url)) {
      return jsonResponse({ ok: false, error: "url must be an absolute http(s) URL" }, { status: 400 });
    }

    const { tools, error, usedUrl } = await mcpDiscoverTools(url, headers);

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
      await supa.from("mcp_servers").update(patch).eq("id", serverId);
    }

    if (error) return jsonResponse({ ok: false, error, tools: [] });
    return jsonResponse({ ok: true, tools, count: tools.length });
  } catch (e) {
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
