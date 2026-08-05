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
    const { workspace_id, project_id, toolkit, tool_slug, arguments: toolArgs, limit } = body as {
      workspace_id?: string; project_id?: string; toolkit?: string;
      tool_slug?: string; arguments?: Record<string, unknown>; limit?: number;
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

    const { data: connector } = await admin
      .from("connectors")
      .select("composio_connected_account_id, status")
      .eq("workspace_id", workspace_id).eq("project_id", project_id)
      .eq("provider", toolkit).eq("source", "composio")
      .maybeSingle();
    if (!connector?.composio_connected_account_id || connector.status !== "connected") {
      return jsonResponse({ error: `${toolkit} is not connected for this project` }, { status: 400 });
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
      payload: { toolkit, tool_slug },
    }).then(() => {});

    const json = JSON.stringify(result ?? null);
    const capped = json.length > 14000
      ? { note: "Result truncated (too large)", preview: json.slice(0, 14000) }
      : result;
    return jsonResponse({ ok: true, toolkit, tool_slug, result: capped });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
