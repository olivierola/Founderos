// report-error — captures a client-side error, dedupes by fingerprint.
// Body: { workspace_id, project_id, message, stack?, url?, user_agent?, level?, source? }

import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { assertProjectInWorkspace } from "../shared/authz.ts";
import { HttpError } from "../shared/http.ts";
import { callerIp, enforceRateLimit } from "../shared/rate-limit.ts";
import { createServiceClient } from "../shared/supabase.ts";

export async function reportError(req: Request, res: Response): Promise<void> {
  const body = req.body;
  const { workspace_id, project_id, message } = body;
  if (!workspace_id || !project_id || !message) {
    throw new HttpError(400, "workspace_id, project_id, message required");
  }

  // FOS-10 : ce point d'entrée reste PUBLIC — le SDK analytics tourne dans le
  // navigateur d'un visiteur non connecté. Ce qu'on ferme, c'est l'écriture
  // croisée : workspace_id et project_id arrivent tous deux du client, on les
  // recoupe avant d'insérer quoi que ce soit.
  if (!(await assertProjectInWorkspace(project_id, workspace_id))) {
    throw new HttpError(403, "project_id does not belong to workspace_id");
  }

  // FOS-15 — même raison : point d'entrée anonyme en écriture.
  await enforceRateLimit({
    scope: "reporterror",
    identity: `${project_id}:${callerIp(req)}`,
    limit: 60,
    windowSeconds: 60,
  });

  const firstStackLine = String(body.stack ?? "").split("\n")[0] ?? "";
  const fingerprint = createHash("sha1").update(`${message}|${firstStackLine}`).digest("hex");
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
    res.json({ ok: true, deduped: true, id: existing.id });
    return;
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
  if (error) throw new HttpError(500, error.message);
  res.json({ ok: true, id: inserted.id });
}
