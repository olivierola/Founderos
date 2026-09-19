// report-error — captures a client-side error, dedupes by fingerprint.
// Body: { workspace_id, project_id, message, stack?, url?, user_agent?, level? }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { callerIp, enforceRateLimit } from "../_shared/rate-limit.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { assertProjectInWorkspace } from "../_shared/authz.ts";

async function sha1(text: string) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json();
    const { workspace_id, project_id, message } = body;
    if (!workspace_id || !project_id || !message) {
      return jsonResponse({ error: "workspace_id, project_id, message required" }, { status: 400 });
    }

    // FOS-10 : ces points d'entree restent PUBLICS — le SDK analytics tourne
    // dans le navigateur d'un visiteur non connecte. Ce qu'on ferme, c'est
    // l'ecriture croisee : workspace_id et project_id arrivaient tous deux du
    // client sans jamais etre recoupes, donc on inserait dans le projet d'un
    // tiers en annoncant son propre workspace.
    if (workspace_id && !(await assertProjectInWorkspace(project_id, workspace_id))) {
      return jsonResponse({ error: "project_id does not belong to workspace_id" }, { status: 403 });
    }

    // FOS-15 — meme raison : point d'entree anonyme en ecriture.
    const errLimited = await enforceRateLimit(
      { scope: "reporterror", identity: `${project_id}:${callerIp(req)}`, limit: 60, windowSeconds: 60 },
    );
    if (errLimited) return errLimited;
    const fingerprint = await sha1(`${message}|${(body.stack ?? "").split("\n")[0] ?? ""}`);
    const admin = createServiceClient();

    const { data: existing } = await admin
      .from("error_events")
      .select("id, occurrences")
      .eq("project_id", project_id)
      .eq("fingerprint", fingerprint)
      .maybeSingle();

    if (existing) {
      await admin
        .from("error_events")
        .update({ occurrences: (existing.occurrences ?? 0) + 1, last_seen_at: new Date().toISOString() })
        .eq("id", existing.id);
      return jsonResponse({ ok: true, deduped: true, id: existing.id });
    }

    const { data: inserted, error } = await admin
      .from("error_events")
      .insert({
        workspace_id,
        project_id,
        source: body.source ?? "browser",
        level: body.level ?? "error",
        message: String(message).slice(0, 1000),
        stack: body.stack ? String(body.stack).slice(0, 8000) : null,
        url: body.url ?? null,
        user_agent: body.user_agent ?? null,
        fingerprint,
      })
      .select("id")
      .single();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    return jsonResponse({ ok: true, id: inserted!.id });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
