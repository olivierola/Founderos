// issue-api-key — generates a personal API key, returns plaintext ONCE, stores SHA-256 hash.
// Body: { workspace_id, label }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, label } = await req.json();
    if (!workspace_id || !label) return jsonResponse({ error: "workspace_id, label required" }, { status: 400 });

    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!m) return jsonResponse({ error: "Not a workspace member" }, { status: 403 });

    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const raw =
      "fos_" +
      Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const key_hash = await sha256(raw);
    const key_prefix = raw.slice(0, 12);

    const { data: row, error } = await admin
      .from("founder_api_keys")
      .insert({
        workspace_id,
        user_id: userData.user.id,
        label,
        key_hash,
        key_prefix,
      })
      .select("id, label, key_prefix, created_at")
      .single();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });

    return jsonResponse({ ok: true, api_key: raw, record: row });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
