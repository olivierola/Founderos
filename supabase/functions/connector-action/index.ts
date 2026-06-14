// connector-action — execute a safe, read-mostly action against a connected
// third-party tool (CRM / HR) on behalf of an agent. The credential is
// decrypted server-side and the official provider API is called; secrets never
// leave this function.
//
// Body: { workspace_id, project_id, provider, action, params? }
// Auth: user session (owner/admin/member) OR service role (agent worker).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";
import { actionsFor, findAction } from "../_shared/connector-actions.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = createServiceClient();
    const body = await req.json();
    const { workspace_id, project_id, provider, action } = body as {
      workspace_id?: string; project_id?: string; provider?: string; action?: string;
    };
    if (!workspace_id || !project_id || !provider) {
      return jsonResponse({ error: "workspace_id, project_id, provider required" }, { status: 400 });
    }

    // Auth: service role (agent worker) or a workspace member.
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

    // Discovery: no action → list available actions for this provider.
    const available = actionsFor(provider);
    if (available.length === 0) {
      return jsonResponse({ error: `No actions available for provider "${provider}"` }, { status: 400 });
    }
    if (!action) {
      return jsonResponse({ provider, actions: available.map((a) => ({ name: a.name, description: a.description, params: a.params ?? {} })) });
    }

    const def = findAction(provider, action);
    if (!def) {
      return jsonResponse({ error: `Unknown action "${action}" for ${provider}`, available: available.map((a) => a.name) }, { status: 400 });
    }

    // Decrypt the credential and run the action.
    let cred: Record<string, string>;
    try {
      ({ payload: cred } = await getConnectorCredential(workspace_id, project_id, provider));
    } catch {
      return jsonResponse({ error: `${provider} is not connected for this project` }, { status: 400 });
    }

    let result: unknown;
    try {
      result = await def.run(cred, (body.params && typeof body.params === "object") ? body.params : {});
    } catch (e) {
      return jsonResponse({ error: `Action failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
    }

    // Audit + cap the payload so a huge response doesn't blow the context window.
    admin.from("activity_logs").insert({
      workspace_id, project_id,
      event_type: `connector_action.${provider}.${action}`,
      title: `Agent ran ${provider}.${action}`,
      payload: { provider, action },
    }).then(() => {});

    const json = JSON.stringify(result ?? null);
    const capped = json.length > 14000
      ? { note: "Result truncated (too large)", preview: json.slice(0, 14000) }
      : result;
    return jsonResponse({ ok: true, provider, action, result: capped });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
