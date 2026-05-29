// marketing-publish — publish or schedule a marketing post via Buffer (hub)
// or a social automation webhook (n8n/Make/Zapier).
// Body: { workspace_id, project_id, post_id, schedule_at? (ISO) }
// Buffer is preferred when connected; otherwise a "social-webhook" connector is used.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

async function publishViaBuffer(token: string, profileIds: string[], text: string, scheduleAt?: string) {
  // POST /updates/create.json — body is form-encoded on both API hosts.
  const form = new URLSearchParams();
  form.set("text", text);
  for (const id of profileIds) form.append("profile_ids[]", id);
  if (scheduleAt) {
    form.set("scheduled_at", String(Math.floor(new Date(scheduleAt).getTime() / 1000)));
  } else {
    form.set("now", "true");
  }

  // New Buffer API uses a Bearer token (api.buffer.com); legacy uses ?access_token=.
  let res = await fetch("https://api.buffer.com/1/updates/create.json", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    res = await fetch(`https://api.bufferapp.com/1/updates/create.json?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  }
  const text2 = await res.text();
  if (!res.ok) throw new Error(`Buffer ${res.status}: ${text2.slice(0, 200)}`);
  let json: any = {};
  try { json = JSON.parse(text2); } catch { /* ignore */ }
  const updateId = json?.updates?.[0]?.id ?? json?.buffer_id ?? null;
  return { externalId: updateId };
}

async function publishViaWebhook(url: string, payload: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status >= 400) throw new Error(`Webhook ${res.status}`);
  return { externalId: null };
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

    const { workspace_id, project_id, post_id, schedule_at } = await req.json();
    if (!workspace_id || !project_id || !post_id) {
      return jsonResponse({ error: "workspace_id, project_id, post_id required" }, { status: 400 });
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

    const { data: post } = await admin
      .from("marketing_posts")
      .select("*")
      .eq("id", post_id)
      .eq("project_id", project_id)
      .maybeSingle();
    if (!post) return jsonResponse({ error: "Post not found" }, { status: 404 });

    const fullText = [post.content, (post.hashtags ?? []).map((h: string) => `#${h}`).join(" ")]
      .filter(Boolean)
      .join("\n\n");

    await admin.from("marketing_posts").update({ status: "publishing", error_message: null }).eq("id", post_id);

    // Resolve a publishing channel: Buffer first, else social-webhook.
    let externalId: string | null = null;
    let usedProvider = "";
    try {
      let buffer: { payload: Record<string, string> } | null = null;
      try { buffer = await getConnectorCredential(workspace_id, project_id, "buffer"); } catch { buffer = null; }

      if (buffer?.payload?.access_token) {
        usedProvider = "buffer";
        // Channel rows hold Buffer profile ids; fall back to all connected channels.
        const { data: channels } = await admin
          .from("marketing_channels")
          .select("external_id")
          .eq("project_id", project_id)
          .eq("provider", "buffer")
          .eq("status", "connected");
        const profileIds = (channels ?? []).map((c: any) => c.external_id).filter(Boolean);
        const r = await publishViaBuffer(buffer.payload.access_token, profileIds, fullText, schedule_at);
        externalId = r.externalId;
      } else {
        let hook: { payload: Record<string, string> } | null = null;
        try { hook = await getConnectorCredential(workspace_id, project_id, "social-webhook"); } catch { hook = null; }
        if (!hook?.payload?.webhook_url) {
          await admin.from("marketing_posts").update({
            status: "failed",
            error_message: "No publishing channel connected. Connect Buffer or a social webhook in the Catalog.",
          }).eq("id", post_id);
          return jsonResponse({ error: "No publishing channel connected" }, { status: 400 });
        }
        usedProvider = "webhook";
        await publishViaWebhook(hook.payload.webhook_url, {
          platform: post.platform,
          content: fullText,
          schedule_at: schedule_at ?? null,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from("marketing_posts").update({ status: "failed", error_message: msg }).eq("id", post_id);
      return jsonResponse({ error: "Publish failed", detail: msg }, { status: 502 });
    }

    const scheduled = !!schedule_at;
    await admin.from("marketing_posts").update({
      status: scheduled ? "scheduled" : "published",
      external_post_id: externalId,
      scheduled_at: scheduled ? schedule_at : null,
      published_at: scheduled ? null : new Date().toISOString(),
    }).eq("id", post_id);

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: userData.user.id,
      event_type: scheduled ? "marketing.post_scheduled" : "marketing.post_published",
      title: `Post ${scheduled ? "scheduled" : "published"} via ${usedProvider} (${post.platform})`,
      payload: { post_id, provider: usedProvider },
    });

    return jsonResponse({ ok: true, status: scheduled ? "scheduled" : "published", provider: usedProvider, external_post_id: externalId });
  } catch (err) {
    return jsonResponse(
      { error: "marketing-publish failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
