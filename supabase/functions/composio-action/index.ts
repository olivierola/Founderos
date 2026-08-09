// composio-action — direct analog of connector-action, but backed by
// Composio instead of the in-house per-provider action catalogue.
// Body: { workspace_id, project_id, toolkit, tool_slug?, arguments?, limit? }
// Auth: service role (agent worker) OR a workspace member session.
// No tool_slug → discovery (lists the toolkit's available tools, capped at
// `limit` — some toolkits expose hundreds/thousands of raw tools). Used both
// by the agent's own use_<toolkit> tool and by the "capabilities" preview in
// the per-agent Connecteurs tab.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getComposio } from "../_shared/composio.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = createServiceClient();
    const body = await req.json();
    const {
      workspace_id, project_id, toolkit, tool_slug, arguments: toolArgs, limit,
      service_dashboard_id, as_user_id,
    } = body as {
      workspace_id?: string; project_id?: string; toolkit?: string;
      tool_slug?: string; arguments?: Record<string, unknown>; limit?: number;
      /** The calling agent's service dashboard — picks the team connection. */
      service_dashboard_id?: string;
      /** Set ONLY to act through that person's own account (opt-in, 0177). */
      as_user_id?: string;
    };
    if (!workspace_id || !project_id || !toolkit) {
      return jsonResponse({ error: "workspace_id, project_id, toolkit required" }, { status: 400 });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const isService = !!serviceKey && authHeader === `Bearer ${serviceKey}`;
    if (!isService) {
      if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
      const userClient = createUserClient(authHeader);
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      const { data: m } = await admin
        .from("workspace_members").select("role")
        .eq("workspace_id", workspace_id).eq("user_id", userData.user.id).maybeSingle();
      if (!m || !["owner", "admin", "member"].includes(m.role)) {
        return jsonResponse({ error: "Not authorized" }, { status: 403 });
      }
    }

    const composio = getComposio();

    // Discovery: no tool_slug → list the toolkit's available tools.
    if (!tool_slug) {
      const cap = Math.min(Math.max(limit ?? 30, 1), 100);
      const tools = await composio.tools.getRawComposioTools({ toolkits: [toolkit], limit: cap } as Record<string, unknown>);
      const list = (Array.isArray(tools) ? tools : []) as Array<Record<string, unknown>>;
      return jsonResponse({
        toolkit,
        actions: list.map((t) => ({
          name: String(t.slug ?? ""),
          description: String(t.description ?? t.name ?? ""),
        })),
      });
    }

    // ── Which connection does this call use? (migration 0177) ────────────────
    // Resolution is deliberate, not clever: the caller's PERSONAL account only
    // when it explicitly asks for it (as_user_id), otherwise the dashboard's
    // shared account, otherwise the legacy project-wide one. An agent must
    // never send mail from someone's own mailbox by accident.
    const candidates: Array<{ scope: string; dash: string | null; owner: string | null }> = [];
    if (as_user_id && service_dashboard_id) {
      candidates.push({ scope: "personal", dash: service_dashboard_id, owner: as_user_id });
    }
    if (service_dashboard_id) candidates.push({ scope: "dashboard", dash: service_dashboard_id, owner: null });
    candidates.push({ scope: "project", dash: null, owner: null });

    let connector: { composio_connected_account_id: string; status: string } | null = null;
    let usedScope = "project";
    for (const c of candidates) {
      let q = admin
        .from("connectors")
        .select("composio_connected_account_id, status")
        .eq("workspace_id", workspace_id).eq("project_id", project_id)
        .eq("provider", toolkit).eq("source", "composio")
        .eq("status", "connected");
      q = c.dash ? q.eq("service_dashboard_id", c.dash) : q.is("service_dashboard_id", null);
      q = c.owner ? q.eq("owner_user_id", c.owner) : q.is("owner_user_id", null);
      const { data } = await q.maybeSingle();
      if (data?.composio_connected_account_id) {
        connector = data as { composio_connected_account_id: string; status: string };
        usedScope = c.scope;
        break;
      }
    }
    if (!connector) {
      return jsonResponse({
        error: as_user_id
          ? `${toolkit} n'est connecté ni sur votre compte personnel ni sur ce dashboard`
          : `${toolkit} is not connected for this dashboard`,
      }, { status: 400 });
    }

    let result: unknown;
    try {
      result = await composio.tools.execute(tool_slug, {
        userId: project_id,
        connectedAccountId: connector.composio_connected_account_id,
        arguments: toolArgs ?? {},
        dangerouslySkipVersionCheck: true,
      });
    } catch (e) {
      return jsonResponse({ error: `Action failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
    }

    admin.from("activity_logs").insert({
      workspace_id, project_id,
      event_type: `composio_action.${toolkit}.${tool_slug}`,
      title: `Agent ran ${toolkit}.${tool_slug}`,
      // The scope is audited: "which account did this act through?" is the
      // first question anyone asks about an agent that sent an email.
      payload: { toolkit, tool_slug, scope: usedScope, service_dashboard_id: service_dashboard_id ?? null },
    }).then(() => {});

    const json = JSON.stringify(result ?? null);
    const capped = json.length > 14000
      ? { note: "Result truncated (too large)", preview: json.slice(0, 14000) }
      : result;
    return jsonResponse({ ok: true, toolkit, tool_slug, scope: usedScope, result: capped });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
