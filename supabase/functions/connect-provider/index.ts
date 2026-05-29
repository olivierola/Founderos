// connect-provider — generic upsert of a connector + encrypted credentials.
// Body: { workspace_id, project_id, provider, payload: { ...fields } }
// Validates against the provider's API, then stores credentials encrypted (AES-GCM).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { encryptSecret } from "../_shared/crypto.ts";
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
    const { workspace_id, project_id, provider, payload } = body as {
      workspace_id?: string;
      project_id?: string;
      provider?: Provider;
      payload?: Record<string, string>;
    };

    if (!workspace_id || !project_id || !provider || !payload) {
      return jsonResponse({ error: "workspace_id, project_id, provider, payload required" }, { status: 400 });
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

    const validation = await validateProvider(provider, payload);
    if (!validation.ok) {
      return jsonResponse({ error: validation.error ?? "Validation failed" }, { status: 400 });
    }

    const { data: connector, error: connErr } = await admin
      .from("connectors")
      .upsert(
        {
          workspace_id,
          project_id,
          provider,
          status: "connected",
          permissions: validation.permissions,
          metadata: validation.metadata,
        },
        { onConflict: "workspace_id,project_id,provider" },
      )
      .select()
      .single();
    if (connErr || !connector) {
      return jsonResponse({ error: "Could not save connector", detail: connErr?.message }, { status: 500 });
    }

    // Encrypt the full credential payload as JSON
    const plaintext = JSON.stringify(payload);
    const { ciphertext, iv } = await encryptSecret(plaintext);
    await admin.from("encrypted_credentials").delete().eq("connector_id", connector.id);
    const { error: credErr } = await admin.from("encrypted_credentials").insert({
      workspace_id,
      connector_id: connector.id,
      encrypted_payload: ciphertext,
      iv,
      key_version: "v1",
    });
    if (credErr) {
      return jsonResponse({ error: "Could not save credential", detail: credErr.message }, { status: 500 });
    }

    // Buffer: discover social profiles and register them as marketing channels.
    if (provider === "buffer" && payload.access_token) {
      try {
        let res = await fetch("https://api.buffer.com/1/profiles.json", {
          headers: { Authorization: `Bearer ${payload.access_token}` },
        });
        if (!res.ok) {
          res = await fetch(
            `https://api.bufferapp.com/1/profiles.json?access_token=${encodeURIComponent(payload.access_token)}`,
          );
        }
        if (res.ok) {
          const profiles = (await res.json()) as Array<{
            id?: string;
            service?: string;
            service_username?: string;
            formatted_username?: string;
          }>;
          const rows = (profiles ?? []).map((p) => ({
            workspace_id,
            project_id,
            provider: "buffer",
            platform: (p.service ?? "unknown").toLowerCase(),
            external_id: p.id ?? null,
            handle: p.formatted_username ?? p.service_username ?? null,
            status: "connected",
          }));
          if (rows.length > 0) {
            await admin.from("marketing_channels").upsert(rows, { onConflict: "project_id,provider,external_id" });
          }
        }
      } catch {
        // non-fatal: channels can be synced later
      }
    }

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: userId,
      event_type: "connector.connected",
      title: `${provider} connected`,
      payload: { provider, permissions: validation.permissions },
    });

    return jsonResponse({
      ok: true,
      connector_id: connector.id,
      permissions: validation.permissions,
      metadata: validation.metadata,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
