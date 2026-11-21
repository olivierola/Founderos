// Passerelle LLM imposée (llm-upstream) : LiteLLM avec la clé virtuelle de
// l'agent, `user` et métadonnées lus dans le contexte d'appel ; Azure en
// direct ; garde-fou de sortie. Contre une fausse passerelle locale.

import { JWT_SECRET, listen } from "../test-env.ts";

import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { SignJWT } from "jose";
import { llmCallerStore } from "../compat/index.ts";
import type { EdgeRegistry } from "../compat/express.ts";
import { callAi } from "../edge/_shared/ai.ts";
import { embedTexts } from "../edge/_shared/jina.ts";
import { currentLlmCaller } from "../edge/_shared/llm-context.ts";
import { assertAllowedLlmUrl, LlmUpstreamPolicyError, pinnedChatTarget, resetUpstreamCaches } from "../edge/_shared/llm-upstream.ts";
import { createServer } from "../server.ts";

// ── Fausse passerelle (LiteLLM ou Azure, mêmes routes OpenAI) ────────────────
interface Seen { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, any> }
const seen: Seen[] = [];
const gateway: Server = createHttpServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ path: req.url ?? "", headers: req.headers, body });
    res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("/embeddings")) {
      res.end(JSON.stringify({
        data: (body.input as string[]).map((_, i) => ({ index: i, embedding: Array(body.dimensions).fill(i) })),
      }));
      return;
    }
    if (req.url?.endsWith("/decisions")) {
      res.end(JSON.stringify({ model: body.model, answers: { pertinent: { type: "noul", noul: 0.83 } }, usage: { input_tokens: 42 } }));
      return;
    }
    res.end(JSON.stringify({
      model: body.model,
      choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }));
  });
});
let base = "";

const LLM_VARS = [
  "LLM_UPSTREAM", "LLM_BASE_URL", "LLM_API_KEY", "LLM_AGENT_KEYS", "LLM_MODEL_DEFAULT", "LLM_MODEL_HEAVY",
  "LLM_EMBEDDING_MODEL", "LLM_REASONING", "LLM_ALLOWED_HOSTS", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_DEPLOYMENT_HEAVY", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_REASONING",
  "AZURE_OPENAI_DEPLOYMENT_LIGHT", "LLM_MODEL_LIGHT", "AZURE_OPENAI_REASONING_EFFORT", "LLM_REASONING_EFFORT",
  "LLM_REASONING_HEADROOM", "RUNWARE_API_KEY", "RUNWARE_BASE_URL", "RUNWARE_MODEL", "RUNWARE_MODEL_HEAVY",
  "RUNWARE_MODEL_LIGHT", "RUNWARE_REASONING_EFFORT", "JINA_API_KEY", "TYPESAFE_API_KEY", "TYPESAFE_PROVIDER", "TYPESAFE_MODEL",
];

function useLiteLlm(extra: Record<string, string> = {}) {
  Object.assign(process.env, {
    LLM_UPSTREAM: "litellm",
    LLM_BASE_URL: `${base}/v1`,
    LLM_API_KEY: "sk-portal",
    LLM_AGENT_KEYS: JSON.stringify({ "ops-investigator": "sk-investigator", "agent-uuid-2": "sk-change" }),
    LLM_MODEL_DEFAULT: "ops-default",
    LLM_MODEL_HEAVY: "ops-reasoning",
    LLM_EMBEDDING_MODEL: "ops-embed",
    ...extra,
  });
}

const ask = (opts: Partial<Parameters<typeof callAi>[0]> = {}) =>
  callAi({ task: "summary", systemPrompt: "s", userPrompt: "ping", ...opts });

before(async () => { base = await listen(gateway); });
after(() => { gateway.close(); });
beforeEach(() => {
  seen.length = 0;
  for (const k of LLM_VARS) delete process.env[k];
  resetUpstreamCaches();
});

describe("LiteLLM", () => {
  it("un appel d'agent part avec sa clé virtuelle, la personne et le run", async () => {
    useLiteLlm();
    const out = await llmCallerStore.run(
      { agentId: "agent-uuid-1", agentName: "ops-investigator", userId: "user-alice", runId: "run-42" },
      () => ask(),
    );
    assert.equal(out.content, "pong");
    assert.equal(seen.length, 1);
    const [call] = seen;
    assert.equal(call.path, "/v1/chat/completions");
    assert.equal(call.headers.authorization, "Bearer sk-investigator");
    assert.equal(call.body.model, "ops-default");
    assert.equal(call.body.user, "user-alice");
    assert.deepEqual(call.body.metadata, { agent: "ops-investigator", agent_id: "agent-uuid-1", run_id: "run-42" });
    // LiteLLM traduit max_tokens lui-même : on ne le touche pas.
    assert.equal(call.body.max_tokens, 1500);
    assert.equal(call.body.max_completion_tokens, undefined);
  });

  it("la clé se trouve aussi par l'identifiant de l'agent", async () => {
    useLiteLlm();
    await llmCallerStore.run({ agentId: "agent-uuid-2", agentName: "renamed" }, () => ask());
    assert.equal(seen[0].headers.authorization, "Bearer sk-change");
  });

  it("le palier lourd prend l'alias de raisonnement", async () => {
    useLiteLlm();
    await ask({ model: "deepseek-reasoner" });
    assert.equal(seen[0].body.model, "ops-reasoning");
  });

  it("un alias de raisonnement ne reçoit pas de température", async () => {
    useLiteLlm({ LLM_REASONING: "1" });
    await ask({ temperature: 0.7 });
    assert.equal("temperature" in seen[0].body, false);
  });

  it("sans agent : la clé commune, et ni `user` ni métadonnées inventés", async () => {
    useLiteLlm();
    await ask();
    assert.equal(seen[0].headers.authorization, "Bearer sk-portal");
    assert.equal(seen[0].body.user, undefined);
    assert.equal(seen[0].body.metadata, undefined);
  });

  it("un agent sans clé et sans clé commune : refus, aucune requête", async () => {
    useLiteLlm({ LLM_API_KEY: "" });
    await assert.rejects(
      llmCallerStore.run({ agentName: "inconnu" }, () => ask()),
      /Aucune clé LiteLLM pour inconnu/,
    );
    assert.equal(seen.length, 0);
  });

  it("les embeddings passent par l'alias dédié, en 1024 dimensions", async () => {
    useLiteLlm();
    const vectors = await llmCallerStore.run({ userId: "user-alice" }, () => embedTexts(["a", "b"]));
    assert.equal(vectors.length, 2);
    assert.equal(vectors[0].length, 1024);
    assert.equal(seen[0].path, "/v1/embeddings");
    assert.equal(seen[0].body.model, "ops-embed");
    assert.equal(seen[0].body.dimensions, 1024);
    assert.equal(seen[0].body.user, "user-alice");
  });

  it("sans alias d'embeddings : une erreur qui dit quoi renseigner", async () => {
    useLiteLlm({ LLM_EMBEDDING_MODEL: "" });
    await assert.rejects(embedTexts(["a"]), /LLM_EMBEDDING_MODEL/);
  });

  it("le relais brut (pinnedChatTarget) vise la passerelle avec la bonne clé", async () => {
    useLiteLlm();
    const target = await llmCallerStore.run({ agentName: "ops-investigator" }, () => pinnedChatTarget());
    assert.deepEqual(target, {
      url: `${base}/v1/chat/completions`,
      model: "ops-default",
      headers: { Authorization: "Bearer sk-investigator" },
    });
  });

  it("aucun autre hôte n'est joignable, sauf LLM_ALLOWED_HOSTS", () => {
    useLiteLlm({ LLM_ALLOWED_HOSTS: "vllm.ips.internal:8000" });
    assert.throws(
      () => assertAllowedLlmUrl("https://api.deepseek.com/chat/completions"),
      (error) => error instanceof LlmUpstreamPolicyError && /refusé/.test(error.message),
    );
    assert.throws(() => assertAllowedLlmUrl(`${base}/v1x/chat/completions`), /refusé/);
    assert.doesNotThrow(() => assertAllowedLlmUrl("https://vllm.ips.internal:8000/v1/chat/completions"));
    assert.doesNotThrow(() => assertAllowedLlmUrl(`${base}/v1/chat/completions`));
  });

  it("une configuration incomplète échoue au lieu de repartir vers DeepSeek", async () => {
    process.env.LLM_UPSTREAM = "litellm";
    await assert.rejects(ask(), /LLM_BASE_URL/);
    process.env.LLM_UPSTREAM = "openai";
    await assert.rejects(ask(), /LLM_UPSTREAM inconnu/);
  });
});

describe("Azure OpenAI en direct", () => {
  it("clé de ressource, déploiement, max_completion_tokens", async () => {
    Object.assign(process.env, {
      LLM_UPSTREAM: "azure",
      AZURE_OPENAI_BASE_URL: `${base}/openai/v1`,
      AZURE_OPENAI_DEPLOYMENT: "gpt-4o-ops",
      AZURE_OPENAI_API_KEY: "azure-key",
    });
    await llmCallerStore.run({ agentName: "ops-investigator", userId: "user-alice" }, () => ask());
    const [call] = seen;
    assert.equal(call.path, "/openai/v1/chat/completions");
    assert.equal(call.headers["api-key"], "azure-key");
    assert.equal(call.body.model, "gpt-4o-ops");
    assert.equal(call.body.max_completion_tokens, 1500);
    assert.equal("max_tokens" in call.body, false);
    // Les champs de passerelle n'ont pas de sens pour Azure.
    assert.equal(call.body.user, undefined);
    assert.equal(call.body.metadata, undefined);
  });

  // La configuration du cloud depuis le 10/11/2026 : gpt-5.6-terra pour le
  // travail, gpt-5-mini pour les juges, text-embedding-3-large pour les vecteurs.
  function useFoundry(extra: Record<string, string> = {}) {
    Object.assign(process.env, {
      LLM_UPSTREAM: "azure",
      AZURE_OPENAI_BASE_URL: `${base}/openai/v1`,
      AZURE_OPENAI_DEPLOYMENT: "gpt-5.6-terra",
      AZURE_OPENAI_DEPLOYMENT_HEAVY: "gpt-5.6-terra",
      AZURE_OPENAI_DEPLOYMENT_LIGHT: "gpt-5-mini",
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "text-embedding-3-large",
      AZURE_OPENAI_REASONING: "1",
      AZURE_OPENAI_REASONING_EFFORT: JSON.stringify({ "gpt-5-mini": "minimal" }),
      AZURE_OPENAI_API_KEY: "azure-key",
      ...extra,
    });
  }

  it("un appel annexe (cheapModel) part sur le déploiement léger, en effort minimal, sans marge", async () => {
    useFoundry();
    const { cheapModel } = await import("../edge/_shared/model-router.ts");
    await ask({ model: cheapModel(), maxTokens: 120, temperature: 0 });
    const [call] = seen;
    assert.equal(call.body.model, "gpt-5-mini");
    assert.equal(call.body.reasoning_effort, "minimal");
    // L'effort minimal ne réfléchit pas : le plafond reste celui demandé.
    assert.equal(call.body.max_completion_tokens, 120);
    assert.equal("temperature" in call.body, false);
  });

  it("le modèle de travail garde son effort par défaut et reçoit une marge pour réfléchir", async () => {
    useFoundry();
    await ask({ maxTokens: 500, temperature: 0.3 });
    const [call] = seen;
    assert.equal(call.body.model, "gpt-5.6-terra");
    // gpt-5.6-terra refuse tout effort explicite dès qu'il y a des outils.
    assert.equal("reasoning_effort" in call.body, false);
    assert.equal(call.body.max_completion_tokens, 500 + 1024);
    assert.equal("temperature" in call.body, false);
  });

  it("la marge se règle (0 la supprime)", async () => {
    useFoundry({ LLM_REASONING_HEADROOM: "0" });
    await ask({ maxTokens: 500 });
    assert.equal(seen[0].body.max_completion_tokens, 500);
  });

  it("le palier léger, sans passerelle imposée, ne fuit pas vers le fournisseur", async () => {
    const { cheapModel } = await import("../edge/_shared/model-router.ts");
    assert.equal(cheapModel(), undefined);
  });

  it("les embeddings ne reçoivent aucun champ de raisonnement", async () => {
    useFoundry({ AZURE_OPENAI_REASONING_EFFORT: "low" });
    const vectors = await embedTexts(["a"]);
    assert.equal(vectors[0].length, 1024);
    const [call] = seen;
    assert.equal(call.path, "/openai/v1/embeddings");
    assert.equal(call.body.model, "text-embedding-3-large");
    assert.equal(call.body.dimensions, 1024);
    assert.equal("reasoning_effort" in call.body, false);
  });

  it("un effort unique s'applique à tous les modèles", async () => {
    useFoundry({ AZURE_OPENAI_REASONING_EFFORT: "low" });
    await ask({ maxTokens: 200 });
    assert.equal(seen[0].body.reasoning_effort, "low");
    assert.equal(seen[0].body.max_completion_tokens, 200 + 1024);
  });
});

// ── Runware : un compte, des modèles de plusieurs éditeurs (identifiants AIR) ──
describe("Runware", () => {
  function useRunware(extra: Record<string, string> = {}) {
    Object.assign(process.env, {
      LLM_UPSTREAM: "runware",
      RUNWARE_API_KEY: "rw-key",
      RUNWARE_BASE_URL: `${base}/v1`,
      ...extra,
    });
  }

  it("le modèle par défaut est gpt-5.6-terra, la clé part en Bearer, au format OpenAI de raisonnement", async () => {
    useRunware();
    await llmCallerStore.run({ agentName: "ops-investigator", userId: "user-alice" }, () => ask({ maxTokens: 500, temperature: 0.3 }));
    const [call] = seen;
    assert.equal(call.path, "/v1/chat/completions");
    assert.equal(call.headers.authorization, "Bearer rw-key");
    assert.equal(call.body.model, "openai:gpt@5.6-terra");
    // Pas d'outils : la marge de raisonnement s'applique, la température non.
    assert.equal(call.body.max_completion_tokens, 500 + 1024);
    assert.equal("max_tokens" in call.body, false);
    assert.equal("temperature" in call.body, false);
    // Les champs de passerelle LiteLLM n'ont rien à faire chez Runware.
    assert.equal(call.body.user, undefined);
    assert.equal(call.body.metadata, undefined);
  });

  it("avec des outils, un modèle OpenAI reçoit reasoning_effort « none » et pas de marge", async () => {
    useRunware();
    const { adaptChatBody } = await import("../edge/_shared/llm-upstream.ts");
    const out = adaptChatBody(`${base}/v1/chat/completions`, {
      model: "openai:gpt@5.6-terra", messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "t", parameters: {} } }], max_tokens: 6000, temperature: 0.3,
    });
    assert.equal(out.reasoning_effort, "none");
    assert.equal(out.max_completion_tokens, 6000);
    assert.equal("temperature" in out, false);
  });

  it("un modèle non OpenAI garde max_tokens et sa température, sans effort inventé", async () => {
    useRunware({ RUNWARE_MODEL: "google:gemini@3.5-flash" });
    await ask({ maxTokens: 700, temperature: 0.2 });
    const [call] = seen;
    assert.equal(call.body.model, "google:gemini@3.5-flash");
    assert.equal(call.body.max_tokens, 700);
    assert.equal(call.body.temperature, 0.2);
    assert.equal("reasoning_effort" in call.body, false);
  });

  it("le réglage d'effort resté pour Azure ne fuit pas vers Runware ; le sien s'applique", async () => {
    useRunware({ RUNWARE_MODEL: "google:gemini@3.5-flash", AZURE_OPENAI_REASONING_EFFORT: "minimal" });
    await ask({ maxTokens: 300 });
    assert.equal("reasoning_effort" in seen[0].body, false);
    seen.length = 0;
    process.env.RUNWARE_REASONING_EFFORT = JSON.stringify({ "google:gemini@3.5-flash": "low" });
    await ask({ maxTokens: 300 });
    assert.equal(seen[0].body.reasoning_effort, "low");
  });

  it("paliers : léger gpt-5.4-mini par défaut, lourd configurable", async () => {
    useRunware({ RUNWARE_MODEL_HEAVY: "anthropic:claude@opus-5" });
    const { cheapModel } = await import("../edge/_shared/model-router.ts");
    await ask({ model: cheapModel(), maxTokens: 100 });
    await ask({ model: "deepseek-reasoner", maxTokens: 100 });
    assert.equal(seen[0].body.model, "openai:gpt@5.4-mini");
    assert.equal(seen[1].body.model, "anthropic:claude@opus-5");
  });

  it("sans clé : une erreur qui dit quoi renseigner, aucune requête", async () => {
    Object.assign(process.env, { LLM_UPSTREAM: "runware" });
    await assert.rejects(ask(), /RUNWARE_API_KEY/);
    assert.equal(seen.length, 0);
  });

  it("aucun autre hôte de chat n'est joignable", () => {
    useRunware();
    assert.throws(() => assertAllowedLlmUrl("https://api.deepseek.com/chat/completions"), /refusé/);
  });

  it("les embeddings restent chez Jina (Runware n'en sert pas)", async () => {
    useRunware();
    const { embeddingsAvailable } = await import("../edge/_shared/jina.ts");
    assert.equal(embeddingsAvailable(), false);
    await assert.rejects(embedTexts(["a"]), /JINA_API_KEY/);
    process.env.JINA_API_KEY = "jina-key";
    assert.equal(embeddingsAvailable(), true);
    assert.equal(seen.length, 0);
  });

  it("les jugements typés passent par /decisions avec la clé Runware", async () => {
    useRunware({ TYPESAFE_API_KEY: "ts-key" });
    const { judge, noul, hasTypesafeKey, forgetTypesafeConfig } = await import("../edge/_shared/typesafe.ts");
    forgetTypesafeConfig();
    assert.equal(hasTypesafeKey(), true);
    const settings = { features: { run_end: { mode: "on", threshold: 0.6 } } };
    const admin = {
      from: (table: string) => table === "typesafe_settings"
        ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: settings }) }) }) }
        : { insert: async () => ({}) },
    };
    const verdict = await judge(
      { admin: admin as never, workspaceId: "ws-runware", projectId: null, runId: null },
      "run_end", { objectif: "x" }, { pertinent: noul("Est-ce rempli ?") },
    );
    const call = seen.find((s) => s.path.endsWith("/decisions"));
    assert.ok(call, "appel /decisions attendu");
    assert.equal(call!.path, "/v1/decisions");
    assert.equal(call!.headers.authorization, "Bearer rw-key");
    assert.equal(call!.body.model, "typesafe:jev@1.14");
    assert.equal(verdict?.apply, true);
  });

  it("TYPESAFE_PROVIDER=typesafe garde TypeSafe en direct", async () => {
    useRunware({ TYPESAFE_PROVIDER: "typesafe" });
    const { hasTypesafeKey } = await import("../edge/_shared/typesafe.ts");
    assert.equal(hasTypesafeKey(), false); // pas de TYPESAFE_API_KEY
    process.env.TYPESAFE_API_KEY = "ts-key";
    assert.equal(hasTypesafeKey(), true);
  });
});

describe("contexte d'appel posé par le backend", () => {
  const registry: EdgeRegistry = {
    "rag-chat": async () => ({ default: () => Response.json(currentLlmCaller() ?? null) }),
    other: async () => ({ default: () => Response.json(currentLlmCaller() ?? null) }),
  };
  let server: Server;
  let api = "";
  before(async () => {
    server = createServer(registry, { gateway: "production" });
    api = await listen(server);
  });
  after(() => { server.close(); });

  const sign = (sub: string, secret = JWT_SECRET) =>
    new SignJWT({ sub, role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
  const call = async (name: string, token: string) =>
    (await fetch(`${api}/functions/v1/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).json();

  it("la personne vérifiée par la passerelle est dans le contexte", async () => {
    assert.deepEqual(await call("rag-chat", await sign("user-alice")), { userId: "user-alice" });
  });

  it("un jeton que la passerelle ne contrôle pas ne renseigne personne", async () => {
    // « other » n'est pas protégée en production : un sub forgé ne doit pas
    // pouvoir imputer des dépenses au budget de quelqu'un d'autre.
    assert.deepEqual(await call("other", await sign("user-alice", "un-autre-secret-de-32-caracteres!!")), { userId: null });
  });

  it("chaque requête a son propre contexte", async () => {
    const [a, b] = await Promise.all([
      call("rag-chat", await sign("user-a")),
      call("rag-chat", await sign("user-b")),
    ]);
    assert.deepEqual([a, b], [{ userId: "user-a" }, { userId: "user-b" }]);
  });
});
