// ops-rotate-runner-token — issue a fresh runner authentication token.
//
// Body: { project_id }
//
// Returns the plaintext token ONCE (shown in UI for the user to copy into the
// runner's env). The DB only stores the SHA-256 hash; runners send the token
// in the X-Runner-Token header, the runner-poll edge function compares hashes.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "founder_ops_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const { project_id } = await req.json();
    if (!project_id) return jsonResponse({ ok: false, message: "project_id required" }, { status: 400 });

    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }

    const admin = createServiceClient();

    // Resolve workspace from project (for ops_settings row).
    const { data: project } = await admin
      .from("projects")
      .select("workspace_id")
      .eq("id", project_id)
      .maybeSingle();
    if (!project) return jsonResponse({ ok: false, message: "Project not found" }, { status: 404 });

    const token = generateToken();
    const hash = await sha256Hex(token);

    await admin.from("ops_settings").upsert({
      project_id,
      workspace_id: project.workspace_id,
      runner_token_hash: hash,
      updated_at: new Date().toISOString(),
    });

    return jsonResponse({ ok: true, token });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
