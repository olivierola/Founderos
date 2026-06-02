// get-session-replay — returns the full ordered rrweb event stream for one
// recorded session, so the frontend rrweb player can replay it.
// Authenticated: caller must be a member of the session's workspace.
//
// Body: { workspace_id, project_id, session_id }
// Returns: { session: {...}, events: eventWithTime[] }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, project_id, session_id } = await req.json();
    if (!workspace_id || !project_id || !session_id) {
      return jsonResponse({ error: "workspace_id, project_id, session_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!m) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    const { data: session, error: sErr } = await admin
      .from("session_replay_sessions")
      .select("*")
      .eq("id", session_id)
      .eq("workspace_id", workspace_id)
      .maybeSingle();
    if (sErr) return jsonResponse({ error: sErr.message }, { status: 500 });
    if (!session) return jsonResponse({ error: "Session not found" }, { status: 404 });

    // Fetch all chunks in order and flatten into a single eventWithTime[].
    const { data: chunks, error: cErr } = await admin
      .from("session_replay_events")
      .select("chunk, events")
      .eq("session_id", session_id)
      .order("chunk", { ascending: true });
    if (cErr) return jsonResponse({ error: cErr.message }, { status: 500 });

    const events = (chunks ?? []).flatMap((c) => (Array.isArray(c.events) ? c.events : []));

    return jsonResponse({ session, events });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
