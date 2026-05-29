// marketing-sync-metrics — pull engagement metrics for published posts.
// Body: { workspace_id, project_id }
// Buffer exposes per-update analytics; for webhook-published posts (no analytics
// API), metrics are left as-is. Upserts one metrics row per post.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

async function fetchBufferStats(token: string, updateId: string): Promise<Record<string, number> | null> {
  try {
    let res = await fetch(`https://api.buffer.com/1/updates/${encodeURIComponent(updateId)}/interactions.json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      res = await fetch(
        `https://api.bufferapp.com/1/updates/${encodeURIComponent(updateId)}/interactions.json?access_token=${encodeURIComponent(token)}`,
      );
    }
    if (!res.ok) return null;
    const json = await res.json();
    // Buffer returns aggregated statistics on the update object as well.
    const s = json?.statistics ?? json ?? {};
    return {
      impressions: Number(s.reach ?? s.impressions ?? 0),
      likes: Number(s.favorites ?? s.likes ?? 0),
      comments: Number(s.comments ?? 0),
      shares: Number(s.retweets ?? s.shares ?? 0),
      clicks: Number(s.clicks ?? 0),
    };
  } catch {
    return null;
  }
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
    if (!member) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    const { data: posts } = await admin
      .from("marketing_posts")
      .select("id, external_post_id")
      .eq("project_id", project_id)
      .eq("status", "published")
      .not("external_post_id", "is", null)
      .limit(200);

    if (!posts || posts.length === 0) {
      return jsonResponse({ ok: true, synced: 0, note: "No published posts with external ids to sync." });
    }

    let token: string | null = null;
    try {
      const buffer = await getConnectorCredential(workspace_id, project_id, "buffer");
      token = buffer.payload?.access_token ?? null;
    } catch {
      token = null;
    }
    if (!token) {
      return jsonResponse({ ok: true, synced: 0, note: "Buffer not connected — no analytics source." });
    }

    let synced = 0;
    for (const p of posts) {
      const stats = await fetchBufferStats(token, String(p.external_post_id));
      if (!stats) continue;
      const denom = stats.impressions || 1;
      const engagement = (stats.likes + stats.comments + stats.shares + stats.clicks) / denom;
      const { error } = await admin.from("marketing_post_metrics").upsert(
        {
          workspace_id,
          project_id,
          post_id: p.id,
          impressions: stats.impressions,
          likes: stats.likes,
          comments: stats.comments,
          shares: stats.shares,
          clicks: stats.clicks,
          engagement_rate: Number(engagement.toFixed(4)),
          collected_at: new Date().toISOString(),
        },
        { onConflict: "post_id" },
      );
      if (!error) synced++;
    }

    return jsonResponse({ ok: true, synced });
  } catch (err) {
    return jsonResponse(
      { error: "marketing-sync-metrics failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
