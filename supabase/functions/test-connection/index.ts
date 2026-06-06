// test-connection — re-validates a stored connector's credentials against the
// provider's live API, without the user re-entering them. Decrypts the saved
// payload, runs the same validateProvider() used at connect time, and updates
// the connector's status/permissions to reflect the result.
//
// Body: { workspace_id, project_id, provider }
// → { ok, status, permissions, metadata, error? }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";
import { validateProvider, type Provider } from "../_shared/providers.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });

    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const body = await req.json();
    const { workspace_id, project_id, provider } = body as {
      workspace_id?: string;
      project_id?: string;
      provider?: Provider;
    };
    if (!workspace_id || !project_id || !provider) {
      return jsonResponse({ error: "workspace_id, project_id, provider required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized for this workspace" }, { status: 403 });
    }

    // Decrypt the stored payload and re-run validation against the live API.
    let payload: Record<string, string>;
    let connectorId: string;
    try {
      const c = await getConnectorCredential(workspace_id, project_id, provider);
      payload = c.payload;
      connectorId = c.connector.id;
    } catch (e) {
      return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 404 });
    }

    const validation = await validateProvider(provider, payload);

    // Reflect the live result on the connector so the UI status stays honest.
    // `status` is constrained; use 'invalid_credentials' on failure. The error
    // message + last-tested timestamp live in metadata (no dedicated column).
    const now = new Date().toISOString();
    if (validation.ok) {
      await admin
        .from("connectors")
        .update({
          status: "connected",
          permissions: validation.permissions,
          metadata: { ...validation.metadata, last_tested_at: now, last_test_error: null },
        })
        .eq("id", connectorId);
      return jsonResponse({
        ok: true,
        status: "connected",
        permissions: validation.permissions,
        metadata: validation.metadata,
      });
    }

    await admin
      .from("connectors")
      .update({
        status: "invalid_credentials",
        metadata: { last_tested_at: now, last_test_error: validation.error ?? "Validation failed" },
      })
      .eq("id", connectorId);
    return jsonResponse({ ok: false, status: "invalid_credentials", error: validation.error ?? "Validation failed" });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
