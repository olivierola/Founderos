// marketing-publish — publish or schedule a marketing post via Buffer (hub)
// or a social automation webhook (n8n/Make/Zapier).
// Body: { workspace_id, project_id, post_id, schedule_at? (ISO) }
// Buffer is preferred when connected; otherwise a "social-webhook" connector is used.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

// Buffer GraphQL: create one post per channel. mode=shareNow publishes immediately,
// mode=customScheduled + dueAt schedules it.
async function bufferGraphql(token: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch("https://api.buffer.com/", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.errors) {
    const msg = json?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new Error(`Buffer: ${msg}`);
  }
  return json;
}

async function publishViaBuffer(token: string, channelIds: string[], text: string, scheduleAt?: string) {
  if (channelIds.length === 0) throw new Error("No Buffer channels connected for this project.");
  const mutation =
    "mutation Create($input: CreatePostInput!){ createPost(input: $input){ __typename } }";
  const scheduled = !!scheduleAt;
  for (const channelId of channelIds) {
    const input: Record<string, unknown> = {
      channelId,
      text,
      assets: [],
      schedulingType: "automatic",
      mode: scheduled ? "customScheduled" : "shareNow",
    };
    if (scheduled) input.dueAt = new Date(scheduleAt!).toISOString();
    await bufferGraphql(token, mutation, { input });
  }
  return { externalId: null };
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
        // Buffer channel ids (external_id). Match the post's platform when possible.
        const { data: channels } = await admin
          .from("marketing_channels")
          .select("external_id, platform")
          .eq("project_id", project_id)
          .eq("provider", "buffer")
          .eq("status", "connected");
        const all = (channels ?? []).filter((c: any) => c.external_id);
        const matched = all.filter((c: any) => c.platform === post.platform);
        const channelIds = (matched.length > 0 ? matched : all).map((c: any) => c.external_id);
        const r = await publishViaBuffer(buffer.payload.access_token, channelIds, fullText, schedule_at);
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
