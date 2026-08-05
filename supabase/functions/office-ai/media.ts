// office-ai/media.ts — Image & Video studios: real generation.
//
// Providers (workspace connectors from the credentials vault, payload.api_key):
//   fal    → FLUX schnell (image) + Kling v2.1 (video), via the fal queue API
//   openai → gpt-image-1 (image, sync; dall-e-3 fallback) + Sora (video, async)
//
// Generated files are downloaded server-side and stored in the public
// `office-media` bucket; `office_media` rows are the persisted gallery
// (the UI lists them directly through RLS, and polls op:"media.sync" while a
// row is still `generating`).
//
// Ops (body.op):
//   media.generate { kind: "image"|"video", prompt, ratio?, provider? } → { media }
//   media.sync     { media_id }                                         → { media }
//   media.delete   { media_id }                                         → { ok }

import { jsonResponse } from "../_shared/cors.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

const FAL_QUEUE = "https://queue.fal.run";
const FAL_IMAGE_MODEL = "fal-ai/flux/schnell";
const FAL_VIDEO_MODEL = "fal-ai/kling-video/v2.1/standard/text-to-video";

type Ratio = "1:1" | "16:9" | "9:16" | "4:3";
const normRatio = (r: unknown): Ratio =>
  r === "1:1" || r === "9:16" || r === "4:3" ? r : "16:9";

// deno-lint-ignore no-explicit-any
type Admin = any;

interface MediaRow {
  id: string; workspace_id: string; project_id: string; kind: "image" | "video";
  prompt: string; ratio: string | null; provider: string; model: string | null;
  status: "generating" | "ready" | "failed"; request_id: string | null;
  url: string | null; storage_path: string | null; error_message: string | null;
}

// ── Provider resolution ───────────────────────────────────────────────────────
async function connectorKey(workspaceId: string, projectId: string, provider: string): Promise<string | null> {
  try {
    const { payload } = await getConnectorCredential(workspaceId, projectId, provider);
    return payload.api_key || null;
  } catch {
    return null;
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function storeBytes(admin: Admin, path: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const { error } = await admin.storage.from("office-media")
    .upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/office-media/${path}`;
}

async function storeFromUrl(admin: Admin, path: string, url: string, contentType: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return await storeBytes(admin, path, bytes, contentType);
}

// ── fal.ai queue API ──────────────────────────────────────────────────────────
async function falFetch(apiKey: string, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (json as { detail?: unknown }).detail;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail ?? json).slice(0, 300));
  }
  return json as Record<string, unknown>;
}

const falImageSize: Record<Ratio, string> = {
  "1:1": "square_hd", "16:9": "landscape_16_9", "9:16": "portrait_16_9", "4:3": "landscape_4_3",
};

async function falSubmit(apiKey: string, model: string, input: Record<string, unknown>): Promise<string> {
  const out = await falFetch(apiKey, `${FAL_QUEUE}/${model}`, { method: "POST", body: JSON.stringify(input) });
  const id = out.request_id as string | undefined;
  if (!id) throw new Error("fal: no request_id returned");
  return id;
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
const openaiImageSize: Record<Ratio, string> = {
  "1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536", "4:3": "1536x1024",
};
const dalleSize: Record<Ratio, string> = {
  "1:1": "1024x1024", "16:9": "1792x1024", "9:16": "1024x1792", "4:3": "1792x1024",
};
const soraSize: Record<Ratio, string> = {
  "1:1": "1280x720", "16:9": "1280x720", "9:16": "720x1280", "4:3": "1280x720",
};

async function openaiFetch(apiKey: string, path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`https://api.openai.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** gpt-image-1 first; if the account lacks access, retry with dall-e-3. */
async function openaiGenerateImage(apiKey: string, prompt: string, ratio: Ratio): Promise<{ bytes: Uint8Array; model: string }> {
  let res = await openaiFetch(apiKey, "/images/generations", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: openaiImageSize[ratio] }),
  });
  let model = "gpt-image-1";
  if (!res.ok && (res.status === 400 || res.status === 403 || res.status === 404)) {
    res = await openaiFetch(apiKey, "/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "dall-e-3", prompt, size: dalleSize[ratio], response_format: "b64_json" }),
    });
    model = "dall-e-3";
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message ?? `OpenAI images → ${res.status}`);
  const b64 = json.data?.[0]?.b64_json as string | undefined;
  if (b64) return { bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), model };
  const url = json.data?.[0]?.url as string | undefined;
  if (!url) throw new Error("OpenAI: empty image response");
  const dl = await fetch(url);
  return { bytes: new Uint8Array(await dl.arrayBuffer()), model };
}

// ── Row helpers ───────────────────────────────────────────────────────────────
async function updateRow(admin: Admin, id: string, patch: Record<string, unknown>): Promise<MediaRow> {
  const { data, error } = await admin.from("office_media")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id).select("*").single();
  if (error) throw new Error(error.message);
  return data as MediaRow;
}

const fail = (admin: Admin, id: string, message: string) =>
  updateRow(admin, id, { status: "failed", error_message: message.slice(0, 500) });

// ── Handler ───────────────────────────────────────────────────────────────────
export async function handleMedia(admin: Admin, userId: string, body: Record<string, unknown>): Promise<Response> {
  const op = String(body.op);
  const workspaceId = String(body.workspace_id);
  const projectId = String(body.project_id);

  if (op === "media.generate") {
    const kind = body.kind === "video" ? "video" : "image";
    const prompt = String(body.prompt ?? "").trim();
    const ratio = normRatio(body.ratio);
    if (!prompt) return jsonResponse({ error: "prompt required" }, { status: 400 });

    // Provider: explicit override, else fal if connected, else openai.
    const falKey = await connectorKey(workspaceId, projectId, "fal");
    const openaiKey = await connectorKey(workspaceId, projectId, "openai");
    const provider = body.provider === "openai" || body.provider === "fal"
      ? String(body.provider)
      : falKey ? "fal" : openaiKey ? "openai" : null;
    const apiKey = provider === "fal" ? falKey : provider === "openai" ? openaiKey : null;
    if (!provider || !apiKey) {
      return jsonResponse({ error: "Aucun fournisseur de génération connecté. Connectez fal.ai ou OpenAI dans Integrations → Credentials Vault." }, { status: 400 });
    }

    const { data: row, error } = await admin.from("office_media").insert({
      workspace_id: workspaceId, project_id: projectId, kind, prompt, ratio,
      provider, status: "generating", created_by: userId,
    }).select("*").single();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    const media = row as MediaRow;

    try {
      if (provider === "fal") {
        const model = kind === "image" ? FAL_IMAGE_MODEL : FAL_VIDEO_MODEL;
        const input = kind === "image"
          ? { prompt, image_size: falImageSize[ratio], num_images: 1 }
          : { prompt, duration: "5", aspect_ratio: ratio === "9:16" ? "9:16" : ratio === "1:1" ? "1:1" : "16:9" };
        const requestId = await falSubmit(apiKey, model, input);
        return jsonResponse({ media: await updateRow(admin, media.id, { model, request_id: requestId }) });
      }
      // openai
      if (kind === "image") {
        const { bytes, model } = await openaiGenerateImage(apiKey, prompt, ratio);
        const path = `${projectId}/${media.id}.png`;
        const url = await storeBytes(admin, path, bytes, "image/png");
        return jsonResponse({ media: await updateRow(admin, media.id, { model, status: "ready", url, storage_path: path }) });
      }
      // openai video (Sora, async)
      const res = await openaiFetch(apiKey, "/videos", {
        method: "POST",
        body: JSON.stringify({ model: "sora-2", prompt, size: soraSize[ratio], seconds: "8" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error?.message ?? `OpenAI videos → ${res.status}`);
      return jsonResponse({ media: await updateRow(admin, media.id, { model: "sora-2", request_id: String(json.id) }) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ media: await fail(admin, media.id, msg) });
    }
  }

  if (op === "media.sync" || op === "media.delete") {
    const mediaId = String(body.media_id ?? "");
    const { data } = await admin.from("office_media").select("*")
      .eq("id", mediaId).eq("project_id", projectId).maybeSingle();
    if (!data) return jsonResponse({ error: "Media not found" }, { status: 404 });
    const media = data as MediaRow;

    if (op === "media.delete") {
      if (media.storage_path) {
        await admin.storage.from("office-media").remove([media.storage_path]).catch(() => {});
      }
      await admin.from("office_media").delete().eq("id", media.id);
      return jsonResponse({ ok: true });
    }

    // media.sync — poll the provider while the row is still generating.
    if (media.status !== "generating" || !media.request_id) return jsonResponse({ media });
    try {
      if (media.provider === "fal") {
        const apiKey = await connectorKey(workspaceId, projectId, "fal");
        if (!apiKey) throw new Error("Connecteur fal.ai introuvable");
        const model = media.model ?? (media.kind === "image" ? FAL_IMAGE_MODEL : FAL_VIDEO_MODEL);
        const st = await falFetch(apiKey, `${FAL_QUEUE}/${model}/requests/${media.request_id}/status`);
        const status = String(st.status ?? "");
        if (status === "COMPLETED") {
          const result = await falFetch(apiKey, `${FAL_QUEUE}/${model}/requests/${media.request_id}`);
          const fileUrl = media.kind === "image"
            ? (result.images as Array<{ url?: string }> | undefined)?.[0]?.url
            : (result.video as { url?: string } | undefined)?.url;
          if (!fileUrl) throw new Error("fal: résultat sans URL");
          const ext = media.kind === "image" ? "png" : "mp4";
          const path = `${projectId}/${media.id}.${ext}`;
          const url = await storeFromUrl(admin, path, fileUrl, media.kind === "image" ? "image/png" : "video/mp4");
          return jsonResponse({ media: await updateRow(admin, media.id, { status: "ready", url, storage_path: path }) });
        }
        if (status === "ERROR" || status === "FAILED" || status === "CANCELLED") {
          return jsonResponse({ media: await fail(admin, media.id, `fal: ${status}`) });
        }
        return jsonResponse({ media }); // still IN_QUEUE / IN_PROGRESS
      }

      // openai (Sora)
      const apiKey = await connectorKey(workspaceId, projectId, "openai");
      if (!apiKey) throw new Error("Connecteur OpenAI introuvable");
      const res = await openaiFetch(apiKey, `/videos/${media.request_id}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error?.message ?? `OpenAI videos → ${res.status}`);
      const status = String(json.status ?? "");
      if (status === "completed") {
        const dl = await openaiFetch(apiKey, `/videos/${media.request_id}/content`);
        if (!dl.ok) throw new Error(`Téléchargement Sora → ${dl.status}`);
        const bytes = new Uint8Array(await dl.arrayBuffer());
        const path = `${projectId}/${media.id}.mp4`;
        const url = await storeBytes(admin, path, bytes, "video/mp4");
        return jsonResponse({ media: await updateRow(admin, media.id, { status: "ready", url, storage_path: path }) });
      }
      if (status === "failed") {
        return jsonResponse({ media: await fail(admin, media.id, String(json.error?.message ?? "Sora: failed")) });
      }
      return jsonResponse({ media }); // queued / in_progress
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ media: await fail(admin, media.id, msg) });
    }
  }

  return jsonResponse({ error: `Unknown media op: ${op}` }, { status: 400 });
}
