// composio-connect — initiate a Composio connection for a toolkit, scoped to
// one project. Every scheme that needs a credential (OAuth AND API_KEY/
// BEARER_TOKEN/BASIC) goes through Composio's own hosted connect link —
// Composio's page adapts itself (OAuth "Authorize" button, or a form for the
// API key) and shows/collects whatever it needs; we never build our own
// credential form. The frontend just opens redirect_url and polls
// composio-connection-status, exactly like the OAuth flow always did.
// NO_AUTH is the only case with nothing to collect, so it resolves instantly.
// Body: { workspace_id, project_id, toolkit, auth_scheme }
// Auth: workspace member (owner/admin/member).
//
// Composio's `userId` (its tenant/entity key) is our project_id — one
// Composio "user" per AchiCorp project, matching connectors' existing
// per-project granularity.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getComposio, mapConnectionStatus } from "../_shared/composio.ts";

const OAUTH_SCHEMES = new Set(["OAUTH1", "OAUTH2"]);

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const body = await req.json();
    const { workspace_id, project_id, toolkit, auth_scheme, credentials } = body as {
      workspace_id?: string; project_id?: string; toolkit?: string; auth_scheme?: string;
      credentials?: Record<string, string>;
    };
    if (!workspace_id || !project_id || !toolkit || !auth_scheme) {
      return jsonResponse({ error: "workspace_id, project_id, toolkit, auth_scheme required" }, { status: 400 });
    }
    const isOAuth = OAUTH_SCHEMES.has(auth_scheme);
    const isNoAuth = auth_scheme === "NO_AUTH";
    // OAuth against the caller's OWN registered app (Power BI, Twitter… —
    // anything Composio has no managed app for): the client id/secret come
    // from the connect dialog and belong to this workspace, so its auth
    // config must never be shared through the global cache below.
    const customOAuth = isOAuth && !!credentials && Object.keys(credentials).length > 0;

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!membership || !["owner", "admin", "member"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized for this workspace" }, { status: 403 });
    }

    const composio = getComposio();

    // Auth configs are per (toolkit, auth_scheme), not per-project — cache
    // the id so we don't recreate one on every connect. Custom-OAuth configs
    // carry a workspace's own client secret, so they're keyed on the
    // workspace's existing connector row instead of that shared cache.
    let authConfigId: string;
    const { data: cached } = customOAuth
      ? { data: null }
      : await admin
          .from("composio_auth_configs")
          .select("auth_config_id")
          .eq("toolkit_slug", toolkit).eq("auth_scheme", auth_scheme)
          .maybeSingle();

    if (customOAuth) {
      // Built fresh on every custom-OAuth connect and never cached globally:
      // the user just (re)entered credentials that belong to their workspace
      // alone — reusing a shared config would leak them or silently ignore
      // the new ones. The id lands on this workspace's connector row below.
      const created = await composio.authConfigs.create(toolkit, {
        name: `AchiCorp — ${toolkit}`, type: "use_custom_auth", authScheme: auth_scheme, credentials,
      } as Record<string, unknown>);
      authConfigId = created.id;
    } else if (cached?.auth_config_id) {
      authConfigId = cached.auth_config_id;
    } else {
      const created = isOAuth
        ? await composio.authConfigs.create(toolkit, { name: `AchiCorp — ${toolkit}`, type: "use_composio_managed_auth" })
        : await composio.authConfigs.create(toolkit, { name: `AchiCorp — ${toolkit}`, type: "use_custom_auth", authScheme: auth_scheme, credentials: {} } as Record<string, unknown>);
      authConfigId = created.id;
      await admin.from("composio_auth_configs").insert({ toolkit_slug: toolkit, auth_scheme, auth_config_id: authConfigId });
    }

    if (isNoAuth) {
      // Nothing to collect — resolves synchronously, no hosted page needed.
      const connectionRequest = await composio.connectedAccounts.initiate(project_id, authConfigId, {
        config: { authScheme: auth_scheme, val: { status: "ACTIVE" } },
        allowMultiple: true,
      } as Record<string, unknown>);
      const status = mapConnectionStatus((connectionRequest as { status?: string }).status);
      const { error: upsertErr } = await admin.from("connectors").upsert(
        {
          workspace_id, project_id, provider: toolkit, source: "composio",
          status, permissions: "read_only",
          composio_connected_account_id: connectionRequest.id,
          composio_auth_config_id: authConfigId,
        },
        { onConflict: "workspace_id,project_id,provider,source" },
      );
      if (upsertErr) return jsonResponse({ error: "Could not save connector", detail: upsertErr.message }, { status: 500 });
      return jsonResponse({ ok: true, status });
    }

    // Everything else (OAuth AND API_KEY/BEARER_TOKEN/BASIC) — Composio's own
    // hosted page collects whatever credential it needs; we just poll after.
    // allowMultiple: a project may already have a connected account for this
    // toolkit (e.g. reconnecting GitHub) — Composio errors otherwise.
    const connectionRequest = await composio.connectedAccounts.link(project_id, authConfigId, { allowMultiple: true } as Record<string, unknown>);
    const { error: upsertErr } = await admin.from("connectors").upsert(
      {
        workspace_id, project_id, provider: toolkit, source: "composio",
        status: "pending", permissions: "read_only",
        composio_connected_account_id: connectionRequest.id,
        composio_auth_config_id: authConfigId,
      },
      { onConflict: "workspace_id,project_id,provider,source" },
    );
    if (upsertErr) return jsonResponse({ error: "Could not save connector", detail: upsertErr.message }, { status: 500 });
    return jsonResponse({ ok: true, redirect_url: connectionRequest.redirectUrl });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
