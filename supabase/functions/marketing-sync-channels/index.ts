// marketing-sync-channels — refresh the project's Buffer channels via GraphQL.
// Body: { workspace_id, project_id }
// Upserts current Buffer channels into marketing_channels.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, project_id } = await req.json();
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: member } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!member || !["owner", "admin", "member"].includes(member.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    let token: string | null = null;
    try {
      const buffer = await getConnectorCredential(workspace_id, project_id, "buffer");
      token = buffer.payload?.access_token ?? null;
    } catch {
      return jsonResponse({ error: "Buffer not connected. Connect it in the Catalog first." }, { status: 400 });
    }
    if (!token) return jsonResponse({ error: "Buffer access token missing" }, { status: 400 });

    const res = await fetch("https://api.buffer.com/", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { account { currentOrganization { channels { id service name } } } }" }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.errors) {
      return jsonResponse({ error: "Buffer channel query failed", detail: json?.errors?.[0]?.message }, { status: 502 });
    }

    const channels = (json?.data?.account?.currentOrganization?.channels ?? []) as Array<{
      id?: string; service?: string; name?: string;
    }>;
    const rows = channels
      .filter((c) => c.id)
      .map((c) => ({
        workspace_id,
        project_id,
        provider: "buffer",
        platform: (c.service ?? "unknown").toLowerCase(),
        external_id: c.id!,
        handle: c.name ?? null,
        status: "connected",
      }));

    if (rows.length > 0) {
      const { error } = await admin
        .from("marketing_channels")
        .upsert(rows, { onConflict: "project_id,provider,external_id" });
      if (error) return jsonResponse({ error: "Could not save channels", detail: error.message }, { status: 500 });
    }

    return jsonResponse({ ok: true, synced: rows.length });
  } catch (err) {
    return jsonResponse(
      { error: "marketing-sync-channels failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
