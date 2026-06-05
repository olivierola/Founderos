// public-feature-flags — return the evaluated feature-flag state for a project,
// for use by the FounderOS analytics SDK (analytics.isFeatureEnabled(key)).
// No JWT required: callable from the browser with the anon key, like track-event.
//
// Body: { workspace_id, project_id, distinct_id? }
// Returns: { ok, flags: { [flag_key]: boolean } }
//
// Evaluation:
//   - A per-user override (target_email == distinct_id) wins when present.
//   - Otherwise the project-wide flag (target_email is null) applies.
//   - rollout_percent < 100 is applied deterministically by hashing
//     (flag_key + distinct_id) so a given user is stable across loads.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

// Small deterministic 0..99 bucket from a string (FNV-1a).
function bucket(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % 100;
}

interface FlagRow {
  flag_key: string;
  target_email: string | null;
  enabled: boolean;
  rollout_percent: number | null;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json().catch(() => ({}));
    const { workspace_id, project_id, distinct_id } = body as {
      workspace_id?: string;
      project_id?: string;
      distinct_id?: string;
    };
    if (!project_id) return jsonResponse({ error: "project_id required" }, { status: 400 });

    const admin = createServiceClient();
    let q = admin
      .from("feature_flags")
      .select("flag_key, target_email, enabled, rollout_percent")
      .eq("project_id", project_id);
    if (workspace_id) q = q.eq("workspace_id", workspace_id);
    const { data } = await q;
    const rows = (data ?? []) as FlagRow[];

    // Group by flag_key: project-wide row + any per-user override.
    const byKey = new Map<string, { projectWide?: FlagRow; override?: FlagRow }>();
    for (const r of rows) {
      const e = byKey.get(r.flag_key) ?? {};
      if (r.target_email == null) e.projectWide = r;
      else if (distinct_id && r.target_email.toLowerCase() === distinct_id.toLowerCase()) e.override = r;
      byKey.set(r.flag_key, e);
    }

    const flags: Record<string, boolean> = {};
    for (const [key, { projectWide, override }] of byKey) {
      const row = override ?? projectWide;
      if (!row) continue;
      let on = !!row.enabled;
      // Apply rollout only to project-wide flags (overrides are explicit).
      const rollout = row.rollout_percent ?? 100;
      if (on && !override && rollout < 100) {
        const id = distinct_id || "anon";
        on = bucket(`${key}:${id}`) < rollout;
      }
      flags[key] = on;
    }

    return jsonResponse({ ok: true, flags });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
