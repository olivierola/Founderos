// Générer une image, quel que soit le fournisseur.
//
// Trois dialectes, un seul résultat (les octets de l'image, son modèle, son
// coût quand le fournisseur le dit) :
//   · runware    — l'API native, une tâche `imageInference` (FLUX, Nano
//                  Banana…), l'image revient en URL ;
//   · openrouter — l'Image API (`POST /images` : Recraft, FLUX, Seedream…,
//                  l'image revient en base64), ou, pour les modèles de chat
//                  qui dessinent (Gemini Image, GPT Image…), un chat avec
//                  `modalities: ["image","text"]` ;
//   · openai     — tout endpoint compatible /images/generations (OpenAI,
//                  Azure, un serveur maison).
//
// Le choix du fournisseur suit celui des modèles de texte : la route « image »
// du connecteur de l'agent s'il en a une (AI Ops → Modèles), sinon le compte
// de la plateforme (Runware ou OpenRouter). Le stockage dépose l'image dans le
// bucket public office-media, sous le projet : l'URL rendue s'affiche dans le
// chat (composant `image` des ui_blocks) et reste valable après le run.

import { parseModelRoutes, primaryModel, RUNWARE_DEFAULT_BASE_URL, OPENROUTER_DEFAULT_BASE_URL, upstreamKind } from "./llm-upstream.ts";
import { firstFreeImageModel, freeRoute, OPENROUTER_FREE_ROUTES, openrouterCatalog, openrouterFreeOnly } from "./openrouter-catalog.ts";

export type ImageRatio = "1:1" | "16:9" | "9:16" | "4:3";
export const IMAGE_RATIOS: ImageRatio[] = ["1:1", "16:9", "9:16", "4:3"];

export interface ImageTarget {
  kind: "runware" | "openrouter" | "openai";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mime: string;
  model: string;
  provider: ImageTarget["kind"];
  width?: number;
  height?: number;
  costUsd?: number;
}

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const TIMEOUT_MS = 120_000;

/** Le dialecte d'un endpoint, d'après son hôte. */
export function imageKindOf(baseUrl: string): ImageTarget["kind"] {
  try {
    const host = new URL(baseUrl).host;
    if (host === "api.runware.ai" || (env("RUNWARE_BASE_URL") && host === new URL(env("RUNWARE_BASE_URL")).host)) return "runware";
    if (host === "openrouter.ai" || (env("OPENROUTER_BASE_URL") && host === new URL(env("OPENROUTER_BASE_URL")).host)) return "openrouter";
  } catch { /* URL illisible : le dialecte générique */ }
  return "openai";
}

/** La cible d'un connecteur d'agent qui a une route « image ». */
export function imageTargetFromEndpoint(baseUrl: string, apiKey: string | undefined, model: string): ImageTarget {
  const kind = imageKindOf(baseUrl);
  // La connexion OpenRouter de la plateforme n'a pas de clé à elle : c'est
  // celle du backend (les routes par agent, sur le compte par défaut).
  const key = apiKey || (kind === "openrouter" ? env("OPENROUTER_API_KEY") : kind === "runware" ? env("RUNWARE_API_KEY") : "");
  return { kind, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey: key, model: primaryModel(model) };
}

/**
 * Le compte d'images de la plateforme. Le fournisseur de la passerelle imposée
 * d'abord (une seule facture), puis l'autre s'il a une clé. Le modèle :
 * RUNWARE_IMAGE_MODEL / OPENROUTER_IMAGE_MODEL, sinon la route « image » de
 * LLM_MODEL_ROUTES quand elle vise ce fournisseur, sinon un défaut sûr.
 */
export function platformImageTarget(): ImageTarget | null {
  const upstream = upstreamKind();
  const routeImage = parseModelRoutes(env("LLM_MODEL_ROUTES")).image;
  const runware = (): ImageTarget | null => env("RUNWARE_API_KEY") ? {
    kind: "runware",
    baseUrl: (env("RUNWARE_BASE_URL") || RUNWARE_DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey: env("RUNWARE_API_KEY"),
    model: env("RUNWARE_IMAGE_MODEL") || (upstream === "runware" && routeImage ? primaryModel(routeImage) : "") || "runware:101@1",
  } : null;
  const openrouter = (): ImageTarget | null => env("OPENROUTER_API_KEY") ? {
    kind: "openrouter",
    baseUrl: (env("OPENROUTER_BASE_URL") || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey: env("OPENROUTER_API_KEY"),
    model: primaryModel(openrouterFreeOnly()
      // Mode gratuit (défaut) : un modèle d'image gratuit, quoi que dise l'env.
      ? freeRoute(env("OPENROUTER_IMAGE_MODEL") || (upstream === "openrouter" ? routeImage : "") || "", OPENROUTER_FREE_ROUTES.image)
      : env("OPENROUTER_IMAGE_MODEL") || (upstream === "openrouter" && routeImage ? routeImage : "") || "google/gemini-2.5-flash-image"),
  } : null;
  return upstream === "openrouter" ? (openrouter() ?? runware()) : (runware() ?? openrouter());
}

// FLUX demande des multiples de 64 (128 → 2048).
const RUNWARE_SIZE: Record<ImageRatio, [number, number]> = {
  "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344], "4:3": [1152, 896],
};
const OPENAI_SIZE: Record<ImageRatio, string> = {
  "1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536", "4:3": "1536x1024",
};

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("image illisible (data URL attendue)");
  const mime = m[1] || "image/png";
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return { bytes, mime };
}

async function download(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (url.startsWith("data:")) return decodeDataUrl(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`téléchargement de l'image impossible (${res.status})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("content-type")?.split(";")[0] || "image/png" };
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  const errors = json.errors as Array<{ message?: string; code?: string }> | undefined;
  const error = json.error as { message?: string } | string | undefined;
  if (!res.ok || errors?.length) {
    const why = errors?.[0]?.message ?? errors?.[0]?.code ?? (typeof error === "string" ? error : error?.message) ?? `HTTP ${res.status}`;
    throw new Error(`${why}`.slice(0, 300));
  }
  return json;
}

/** Génère UNE image. Lève une erreur lisible (le message part au modèle). */
export async function generateImage(target: ImageTarget, prompt: string, ratio: ImageRatio = "1:1"): Promise<GeneratedImage> {
  const text = prompt.trim().slice(0, 3000);
  if (text.length < 3) throw new Error("description d'image trop courte");

  if (target.kind === "runware") {
    const [width, height] = RUNWARE_SIZE[ratio];
    const json = await postJson(target.baseUrl, target.apiKey, [{
      taskType: "imageInference", taskUUID: crypto.randomUUID(), model: target.model,
      positivePrompt: text, width, height, numberResults: 1,
      outputType: "URL", outputFormat: "PNG", includeCost: true,
    }]);
    const row = (json.data as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
    const url = String(row.imageURL ?? "");
    if (!url) throw new Error("Runware n'a rendu aucune image");
    const { bytes, mime } = await download(url);
    const cost = Number(row.cost);
    return { bytes, mime, model: target.model, provider: "runware", width, height, costUsd: Number.isFinite(cost) ? cost : undefined };
  }

  if (target.kind === "openrouter") {
    try {
      return await openrouterImage(target, text, ratio);
    } catch (e) {
      // Les modèles gratuits sortent vite du catalogue : un modèle disparu
      // cède la place au premier modèle d'image gratuit encore servi.
      const msg = e instanceof Error ? e.message : String(e);
      if (!openrouterFreeOnly() || !/not.*(found|exist|available)|no endpoints|invalid model|404/i.test(msg)) throw e;
      const next = await firstFreeImageModel(target.model);
      if (!next) throw e;
      return await openrouterImage({ ...target, model: next }, text, ratio);
    }
  }

  const json = await postJson(`${target.baseUrl}/images/generations`, target.apiKey, {
    model: target.model, prompt: text, size: OPENAI_SIZE[ratio], n: 1,
  });
  const row = (json.data as Array<{ b64_json?: string; url?: string }> | undefined)?.[0];
  if (row?.b64_json) {
    return { bytes: Uint8Array.from(atob(row.b64_json), (c) => c.charCodeAt(0)), mime: "image/png", model: target.model, provider: "openai" };
  }
  if (row?.url) {
    const { bytes, mime } = await download(row.url);
    return { bytes, mime, model: target.model, provider: "openai" };
  }
  throw new Error("l'endpoint n'a rendu aucune image");
}

/** Un modèle de chat qui dessine (Gemini Image, GPT Image…) : il sort aussi du
 *  texte. Les autres (Recraft, FLUX, Seedream…) ne servent que l'Image API. */
const CHAT_IMAGE_FAMILIES = /gemini|nano-banana|\/gpt-5/i;
const IMAGE_ONLY_FAMILIES = /recraft|flux|seedream|qwen-image|riverflow|krea|mai-image|grok-imagine|hy-image|muse-image|gpt-image/i;
async function isChatImageModel(model: string): Promise<boolean> {
  if (CHAT_IMAGE_FAMILIES.test(model)) return true;
  if (IMAGE_ONLY_FAMILIES.test(model)) return false;
  // Une famille inconnue : le catalogue le dit (sortie texte = modèle de chat).
  try {
    const m = (await openrouterCatalog()).find((x) => x.id === model);
    if (m) return m.output.includes("text");
  } catch { /* catalogue injoignable : l'Image API par défaut */ }
  return false;
}

/** Une image chez OpenRouter : l'Image API, ou le chat pour un modèle de chat. */
async function openrouterImage(target: ImageTarget, text: string, ratio: ImageRatio): Promise<GeneratedImage> {
  if (!(await isChatImageModel(target.model))) {
    const json = await postJson(`${target.baseUrl}/images`, target.apiKey, {
      model: target.model, prompt: text, aspect_ratio: ratio, n: 1,
    });
    const row = (json.data as Array<{ b64_json?: string; url?: string; media_type?: string }> | undefined)?.[0];
    const cost = Number((json.usage as { cost?: number } | undefined)?.cost);
    const costUsd = Number.isFinite(cost) ? cost : undefined;
    if (row?.b64_json) {
      return {
        bytes: Uint8Array.from(atob(row.b64_json), (c) => c.charCodeAt(0)),
        mime: row.media_type || "image/png", model: target.model, provider: "openrouter", costUsd,
      };
    }
    if (row?.url) {
      const { bytes, mime } = await download(row.url);
      return { bytes, mime: row.media_type || mime, model: target.model, provider: "openrouter", costUsd };
    }
    throw new Error(`${target.model} n'a rendu aucune image`);
  }
  const json = await postJson(`${target.baseUrl}/chat/completions`, target.apiKey, {
    model: target.model,
    messages: [{ role: "user", content: text }],
    modalities: ["image", "text"],
    image_config: { aspect_ratio: ratio },
    usage: { include: true },
  });
  const message = ((json.choices as Array<{ message?: Record<string, unknown> }> | undefined)?.[0]?.message) ?? {};
  const images = message.images as Array<{ image_url?: { url?: string } }> | undefined;
  const url = images?.[0]?.image_url?.url ?? "";
  if (!url) throw new Error(`${target.model} n'a rendu aucune image — vérifiez que c'est un modèle de génération d'images`);
  const { bytes, mime } = await download(url);
  const cost = Number((json.usage as { cost?: number } | undefined)?.cost);
  return { bytes, mime, model: String(json.model ?? target.model), provider: "openrouter", costUsd: Number.isFinite(cost) ? cost : undefined };
}

// deno-lint-ignore no-explicit-any
type Admin = any;

/** Dépose l'image dans le bucket public office-media et rend son URL. */
export async function storeGeneratedImage(
  admin: Admin, projectId: string, runId: string | null, img: GeneratedImage,
): Promise<string> {
  const ext = img.mime.includes("jpeg") || img.mime.includes("jpg") ? "jpg" : img.mime.includes("webp") ? "webp" : "png";
  const path = `${projectId}/agents/${runId ?? "direct"}/${crypto.randomUUID()}.${ext}`;
  const { error } = await admin.storage.from("office-media").upload(path, img.bytes, { contentType: img.mime, upsert: false });
  if (error) throw new Error(`stockage de l'image impossible : ${error.message}`);
  return `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "")}/storage/v1/object/public/office-media/${path}`;
}
