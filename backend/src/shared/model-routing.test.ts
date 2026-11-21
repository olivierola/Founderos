// Le bon modèle pour chaque requête : routes par palier et par critère sur un
// connecteur (passerelle imposée ou connecteur d'agent), OpenRouter et ses
// replis, et la génération d'images chez Runware, OpenRouter ou un endpoint
// compatible OpenAI.

import { listen } from "../test-env.ts";

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { callAi } from "../edge/_shared/ai.ts";
import {
  adaptChatBody, parseModelRoutes, pinnedUpstream, resetUpstreamCaches, resolveModelAlias, routeAlias,
} from "../edge/_shared/llm-upstream.ts";
import { freeRoute, OPENROUTER_FREE_ROUTES } from "../edge/_shared/openrouter-catalog.ts";
import { estimateCostUsd } from "../edge/_shared/llm-pricing.ts";
import { cheapModel, classifyRequest, detectNeed, modelForRequest, preferredIntegrationTool } from "../edge/_shared/model-router.ts";
import { generateImage, imageKindOf, platformImageTarget } from "../edge/_shared/image-gen.ts";

// Une image PNG d'un pixel.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface Seen { path: string; headers: Record<string, string | string[] | undefined>; body: any }
const seen: Seen[] = [];
let base = "";
const server: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    const path = req.url ?? "";
    if (req.method === "GET" && path === "/files/pixel.png") {
      res.setHeader("Content-Type", "image/png");
      res.end(Buffer.from(PIXEL, "base64"));
      return;
    }
    seen.push({ path, headers: req.headers, body });
    res.setHeader("Content-Type", "application/json");
    // Runware : un tableau de tâches à la racine de l'API.
    if (Array.isArray(body)) {
      res.end(JSON.stringify({ data: [{ taskType: "imageInference", taskUUID: body[0].taskUUID, imageUUID: "u1", imageURL: `${base}/files/pixel.png`, cost: 0.0038 }] }));
      return;
    }
    // L'Image API d'OpenRouter.
    if (path.endsWith("/api/v1/images")) {
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: PIXEL, media_type: "image/webp" }], usage: { cost: 0 } }));
      return;
    }
    if (path.endsWith("/images/generations")) {
      res.end(JSON.stringify({ data: [{ b64_json: PIXEL }] }));
      return;
    }
    // Un chat « image » (OpenRouter, modalities).
    if (Array.isArray(body?.modalities)) {
      res.end(JSON.stringify({
        model: body.model,
        choices: [{ message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PIXEL}` } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 1290, total_tokens: 1300, cost: 0.039 },
      }));
      return;
    }
    res.end(JSON.stringify({
      model: body?.model,
      choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.00002 },
    }));
  });
});

const VARS = [
  "LLM_UPSTREAM", "LLM_MODEL_ROUTES", "RUNWARE_API_KEY", "RUNWARE_BASE_URL", "RUNWARE_MODEL", "RUNWARE_MODEL_LIGHT",
  "RUNWARE_MODEL_HEAVY", "RUNWARE_IMAGE_MODEL", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "OPENROUTER_MODEL",
  "OPENROUTER_MODEL_LIGHT", "OPENROUTER_MODEL_HEAVY", "OPENROUTER_IMAGE_MODEL", "LLM_REASONING_EFFORT", "OPENROUTER_REASONING_EFFORT",
  "OPENROUTER_FREE_ONLY",
];
before(async () => { base = await listen(server); });
after(() => { server.closeAllConnections?.(); server.close(); });
beforeEach(() => {
  seen.length = 0;
  for (const k of VARS) delete process.env[k];
  resetUpstreamCaches();
});

const ask = (opts: Partial<Parameters<typeof callAi>[0]> = {}) => callAi({ task: "summary", systemPrompt: "s", userPrompt: "ping", ...opts });

describe("routes de modèles", () => {
  const routes = { light: "l", standard: "s", heavy: "h", code: "c1,c2" };

  it("n'envoie au tier social que les salutations et acquiescements simples", () => {
    assert.equal(classifyRequest("regarde mes stats youtube").tools, "core");
    assert.equal(classifyRequest("ok fais le").tools, "core");
    assert.equal(classifyRequest("montre youtube").tools, "core");
    assert.equal(classifyRequest("merci").tools, "social");
    assert.equal(classifyRequest("ok").tools, "social");
  });

  it("force l'intégration nommée pour une demande explicite de lecture", () => {
    assert.equal(preferredIntegrationTool("regarde mes stats youtube", ["use_youtube"]), "use_youtube");
    assert.equal(preferredIntegrationTool("ok fais-le\nregarde mes stats youtube", ["use_youtube"]), "use_youtube");
    assert.equal(preferredIntegrationTool("explique ce qu'est YouTube", ["use_youtube"]), null);
    assert.equal(preferredIntegrationTool("regarde mes stats youtube", ["use_snowflake"]), null);
  });

  it("un alias prend son critère, sinon son palier, sinon le standard", () => {
    assert.equal(resolveModelAlias("@code|heavy", routes), "c1,c2");
    assert.equal(resolveModelAlias("@vision|heavy", routes), "h");
    assert.equal(resolveModelAlias("@vision|light", { standard: "s" }), "s");
    assert.equal(resolveModelAlias("@heavy", {}, "fallback"), "fallback");
    // Un juge sans route dédiée part sur le léger.
    assert.equal(resolveModelAlias("@judge", routes), "l");
  });

  it("une table illisible ne donne aucune route, jamais d'erreur", () => {
    assert.deepEqual(parseModelRoutes("{oups"), {});
    assert.deepEqual(parseModelRoutes({ code: "  x ", vide: "", n: 3 }), { code: "x" });
  });

  it("le critère d'une requête : code, vision, long contexte — et rien pour du texte courant", () => {
    assert.equal(detectNeed("Corrige ce bug dans src/app/router.tsx"), "code");
    assert.equal(detectNeed("Écris une requête SQL pour les ventes du mois"), "code");
    assert.equal(detectNeed("Que vois-tu sur https://exemple.com/capture.png ?"), "vision");
    assert.equal(detectNeed("court", { contextChars: 80_000 }), "long_context");
    assert.equal(detectNeed("Rédige un post LinkedIn en fonction de notre classe d'actifs"), null);
  });

  it("sans connecteur pour traduire, le palier du fournisseur ; avec, l'alias", () => {
    assert.equal(modelForRequest("heavy", "code", { provider: "deepseek", routed: false }), "deepseek-reasoner");
    assert.equal(modelForRequest("heavy", "code", { routed: true }), "@code|heavy");
    assert.equal(routeAlias("standard"), "@standard");
  });
});

describe("passerelle imposée : LLM_MODEL_ROUTES", () => {
  it("Runware : la route de code sert les analyses de code, les autres tâches gardent le standard", async () => {
    Object.assign(process.env, {
      LLM_UPSTREAM: "runware", RUNWARE_API_KEY: "rw", RUNWARE_BASE_URL: `${base}/v1`,
      LLM_MODEL_ROUTES: JSON.stringify({ code: "anthropic:claude@sonnet-5,openai:gpt@5.5", judge: "google:gemini@3.5-flash-lite" }),
    });
    await ask({ task: "code_analysis" });
    await ask({ task: "summary" });
    await ask({ model: cheapModel() });
    // Runware ne connaît pas de repli : le premier modèle de la liste part seul.
    assert.equal(seen[0].body.model, "anthropic:claude@sonnet-5");
    assert.equal(seen[1].body.model, "openai:gpt@5.6-terra");
    assert.equal(seen[2].body.model, "google:gemini@3.5-flash-lite");
  });
});

describe("OpenRouter, connexion par défaut en modèles gratuits", () => {
  const first = (route: string) => route.split(",")[0];

  it("une clé suffit : OpenRouter sans LLM_UPSTREAM, et LLM_UPSTREAM=none le coupe", () => {
    assert.equal(pinnedUpstream(), null);
    process.env.OPENROUTER_API_KEY = "or-key";
    assert.equal(pinnedUpstream()?.kind, "openrouter");
    process.env.LLM_UPSTREAM = "none";
    assert.equal(pinnedUpstream(), null);
  });

  it("les paliers par défaut sont gratuits, avec leurs replis natifs", async () => {
    Object.assign(process.env, { OPENROUTER_API_KEY: "or-key", OPENROUTER_BASE_URL: `${base}/api/v1` });
    await ask({ maxTokens: 200 });
    await ask({ model: cheapModel() });
    await ask({ model: "@heavy" });
    await ask({ task: "code_analysis" });
    const [main, light, heavy, code] = seen;
    assert.equal(main.body.model, first(OPENROUTER_FREE_ROUTES.standard));
    assert.deepEqual(main.body.models, OPENROUTER_FREE_ROUTES.standard.split(","));
    assert.equal(light.body.model, first(OPENROUTER_FREE_ROUTES.light));
    assert.equal(heavy.body.model, first(OPENROUTER_FREE_ROUTES.heavy));
    assert.equal(code.body.model, first(OPENROUTER_FREE_ROUTES.code));
    for (const s of seen) assert.ok((s.body.models ?? [s.body.model]).every((m: string) => m.endsWith(":free") || m === "openrouter/free"));
  });

  it("un modèle payant demandé retombe sur le gratuit du palier", async () => {
    Object.assign(process.env, {
      OPENROUTER_API_KEY: "or-key", OPENROUTER_BASE_URL: `${base}/api/v1`, OPENROUTER_MODEL: "openai/gpt-5",
      LLM_MODEL_ROUTES: JSON.stringify({ heavy: "anthropic/claude-opus-4.5,google/gemma-4-31b-it:free" }),
    });
    await ask();
    await ask({ model: "@heavy" });
    assert.equal(seen[0].body.model, first(OPENROUTER_FREE_ROUTES.standard));
    assert.equal(seen[1].body.model, "google/gemma-4-31b-it:free");
    assert.equal(freeRoute("openai/gpt-5", "x:free"), "x:free");
  });

  it("un modèle gratuit ne coûte rien", () => {
    assert.equal(estimateCostUsd("nvidia/nemotron-3.5-lightning:free", 100_000, 10_000, { custom: true }), 0);
    assert.equal(estimateCostUsd("openrouter/free", 100_000, 10_000), 0);
  });
});

describe("OpenRouter", () => {
  // Le compte payant : les défauts d'avant le mode gratuit.
  function useOpenRouter(extra: Record<string, string> = {}) {
    Object.assign(process.env, { LLM_UPSTREAM: "openrouter", OPENROUTER_API_KEY: "or-key", OPENROUTER_BASE_URL: `${base}/api/v1`, OPENROUTER_FREE_ONLY: "0", ...extra });
  }

  it("Bearer, modèles par défaut, coût demandé, température retirée pour un modèle OpenAI de raisonnement", async () => {
    useOpenRouter();
    await ask({ temperature: 0.4, maxTokens: 300 });
    await ask({ model: cheapModel(), maxTokens: 100 });
    const [main, light] = seen;
    assert.equal(main.path, "/api/v1/chat/completions");
    assert.equal(main.headers.authorization, "Bearer or-key");
    assert.equal(main.body.model, "openai/gpt-5");
    assert.deepEqual(main.body.usage, { include: true });
    assert.equal("temperature" in main.body, false);
    assert.equal(main.body.max_tokens, 300);
    assert.equal(light.body.model, "openai/gpt-5-mini");
  });

  it("une route à plusieurs modèles devient le repli natif d'OpenRouter (`models`)", async () => {
    useOpenRouter({ LLM_MODEL_ROUTES: JSON.stringify({ heavy: "anthropic/claude-opus-4.5, openai/gpt-5, google/gemini-2.5-pro" }) });
    await ask({ model: "@heavy", temperature: 0.2 });
    const [call] = seen;
    assert.equal(call.body.model, "anthropic/claude-opus-4.5");
    assert.deepEqual(call.body.models, ["anthropic/claude-opus-4.5", "openai/gpt-5", "google/gemini-2.5-pro"]);
    // Un modèle non OpenAI garde sa température.
    assert.equal(call.body.temperature, 0.2);
  });

  it("l'effort réglé passe dans le champ unifié `reasoning`", () => {
    useOpenRouter({ OPENROUTER_REASONING_EFFORT: JSON.stringify({ "openai/gpt-5": "low" }) });
    const out = adaptChatBody(`${base}/api/v1/chat/completions`, { model: "openai/gpt-5", messages: [] });
    assert.deepEqual(out.reasoning, { effort: "low" });
  });

  it("le coût facturé par OpenRouter est repris", async () => {
    useOpenRouter();
    const r = await ask();
    assert.equal(r.content, "pong");
  });
});

describe("connecteur enregistré sous une passerelle imposée", () => {
  it("le connecteur choisi pour l'agent passe, sauf en périmètre strict", async () => {
    Object.assign(process.env, { LLM_UPSTREAM: "runware", RUNWARE_API_KEY: "rw", RUNWARE_BASE_URL: `${base}/v1` });
    const endpoint = { baseUrl: `${base}/openrouter-like/v1`, apiKey: "k", model: "anthropic/claude-sonnet-4.5" };
    const r = await ask({ endpoint });
    assert.equal(r.content, "pong");
    assert.equal(seen[0].path, "/openrouter-like/v1/chat/completions");
    process.env.LLM_STRICT_PERIMETER = "1";
    try {
      await assert.rejects(ask({ endpoint }), /refusé.*périmètre strict/);
    } finally {
      delete process.env.LLM_STRICT_PERIMETER;
    }
  });
});

describe("connecteur d'agent avec routes", () => {
  it("un alias se résout dans les routes du connecteur, le modèle de l'agent en repli", async () => {
    const endpoint = { baseUrl: `${base}/custom/v1`, apiKey: "k", model: "agent-default", routes: { code: "coder-1", heavy: "big-1" } };
    await ask({ endpoint, model: "@code|standard" });
    await ask({ endpoint, model: "@vision|heavy" });
    await ask({ endpoint, model: "@vision|light" });
    await ask({ endpoint });
    assert.deepEqual(seen.map((s) => s.body.model), ["coder-1", "big-1", "agent-default", "agent-default"]);
  });
});

describe("génération d'images", () => {
  it("Runware : une tâche imageInference, l'image téléchargée, le coût repris", async () => {
    const img = await generateImage({ kind: "runware", baseUrl: `${base}/v1`, apiKey: "rw", model: "runware:101@1" }, "a red fox in the snow", "16:9");
    const [task] = seen[0].body;
    assert.equal(task.taskType, "imageInference");
    assert.equal(task.model, "runware:101@1");
    assert.equal(task.width % 64, 0);
    assert.equal(task.height % 64, 0);
    assert.ok(task.width > task.height);
    assert.equal(img.mime, "image/png");
    assert.ok(img.bytes.length > 50);
    assert.equal(img.costUsd, 0.0038);
  });

  it("OpenRouter : un chat avec modalities image, l'image décodée de sa data URL", async () => {
    const img = await generateImage({ kind: "openrouter", baseUrl: `${base}/api/v1`, apiKey: "or", model: "google/gemini-2.5-flash-image" }, "logo minimaliste", "1:1");
    assert.deepEqual(seen[0].body.modalities, ["image", "text"]);
    assert.deepEqual(seen[0].body.image_config, { aspect_ratio: "1:1" });
    assert.equal(img.provider, "openrouter");
    assert.ok(img.bytes.length > 50);
    assert.equal(img.costUsd, 0.039);
  });

  it("OpenRouter : un modèle d'image seul passe par l'Image API (/images)", async () => {
    const img = await generateImage({ kind: "openrouter", baseUrl: `${base}/api/v1`, apiKey: "or", model: "recraft/recraft-v4.1-flash-v2:free" }, "a red fox in the snow", "16:9");
    assert.equal(seen[0].path, "/api/v1/images");
    assert.equal(seen[0].headers.authorization, "Bearer or");
    assert.equal(seen[0].body.aspect_ratio, "16:9");
    assert.equal(img.mime, "image/webp");
    assert.ok(img.bytes.length > 50);
    assert.equal(img.costUsd, 0);
  });

  it("un endpoint compatible OpenAI : /images/generations", async () => {
    const img = await generateImage({ kind: "openai", baseUrl: `${base}/v1x`, apiKey: "k", model: "gpt-image-1" }, "a cozy office", "9:16");
    assert.equal(seen[0].path, "/v1x/images/generations");
    assert.equal(seen[0].body.size, "1024x1536");
    assert.ok(img.bytes.length > 50);
  });

  it("le compte d'images de la plateforme suit la passerelle imposée", () => {
    assert.equal(platformImageTarget(), null);
    Object.assign(process.env, { RUNWARE_API_KEY: "rw", OPENROUTER_API_KEY: "or" });
    // Sans LLM_UPSTREAM, OpenRouter est la connexion par défaut.
    assert.equal(platformImageTarget()?.kind, "openrouter");
    process.env.LLM_UPSTREAM = "runware";
    assert.equal(platformImageTarget()?.kind, "runware");
    process.env.LLM_UPSTREAM = "openrouter";
    assert.equal(platformImageTarget()?.kind, "openrouter");
    // Mode gratuit (défaut) : le modèle d'image gratuit, même si l'env en nomme un payant.
    assert.equal(platformImageTarget()?.model, OPENROUTER_FREE_ROUTES.image);
    process.env.OPENROUTER_IMAGE_MODEL = "google/gemini-2.5-flash-image";
    assert.equal(platformImageTarget()?.model, OPENROUTER_FREE_ROUTES.image);
    process.env.OPENROUTER_FREE_ONLY = "0";
    assert.equal(platformImageTarget()?.model, "google/gemini-2.5-flash-image");
    assert.equal(imageKindOf("https://openrouter.ai/api/v1"), "openrouter");
    assert.equal(imageKindOf("https://api.runware.ai/v1"), "runware");
    assert.equal(imageKindOf("https://api.openai.com/v1"), "openai");
  });

  it("une description trop courte est refusée sans appel", async () => {
    await assert.rejects(generateImage({ kind: "runware", baseUrl: `${base}/v1`, apiKey: "rw", model: "m" }, "x"), /trop courte/);
    assert.equal(seen.length, 0);
  });
});
