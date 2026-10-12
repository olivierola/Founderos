import cors from "cors";
import express from "express";
import { edgeRouter, type EdgeRegistry } from "./compat/express.ts";
import { llmCallerStore } from "./compat/index.ts";
import { edgeFunctions, NO_VERIFY_JWT } from "./edge/registry.ts";
import { env } from "./env.ts";
import { approvalJwks } from "./functions/approval-jwks.ts";
import { functionsRouter, NATIVE_FUNCTIONS } from "./functions/index.ts";
import { ENFORCED_IN_PRODUCTION, gatewayJwt, type GatewayMode } from "./shared/gateway.ts";
import { errorHandler } from "./shared/http.ts";
import { deepgramStreamHttp } from "./ws/deepgram-stream.ts";

export interface AppOptions {
  /** Par défaut, GATEWAY_VERIFY_JWT. */
  gateway?: GatewayMode;
}

/** `registry` est remplaçable pour les tests ; par défaut, les fonctions générées. */
export function createApp(registry: EdgeRegistry = edgeFunctions, options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.trustProxy);

  // Même politique que les edge functions (_shared/cors.ts) : origine libre,
  // car le widget et le SDK tournent sur les sites des clients. L'auth passe par
  // l'en-tête Authorization, jamais par un cookie, donc pas de risque CSRF.
  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["authorization", "x-client-info", "apikey", "content-type"],
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Clés publiques des jetons d'approbation (D6) : lues par les serveurs MCP,
  // sans JWT, avant la passerelle (en mode strict, toute fonction en exige un).
  app.get("/functions/v1/approval-jwks", approvalJwks);

  // Les exceptions de config.toml l'emportent dans les deux modes.
  const isKnown = (name: string) =>
    NATIVE_FUNCTIONS.has(name) || Object.hasOwn(registry, name) || name === "deepgram-stream";
  const mode = options.gateway ?? env.gatewayMode;
  const protectedFunction =
    mode === "strict" ? isKnown : (name: string) => ENFORCED_IN_PRODUCTION.has(name) && isKnown(name);
  app.use("/functions/v1/:name", gatewayJwt((name) => protectedFunction(name) && !NO_VERIFY_JWT.has(name)));
  // Un contexte d'appel LLM neuf par requête (_shared/llm-context.ts), avec
  // l'utilisateur que la passerelle a vérifié ; internal-agent-run y ajoute
  // l'agent et le run.
  app.use("/functions/v1", (_req, res, next) => {
    const userId = typeof res.locals.userId === "string" ? res.locals.userId : null;
    llmCallerStore.run({ userId }, next);
  });

  app.use("/functions/v1", functionsRouter);
  app.all("/functions/v1/deepgram-stream", deepgramStreamHttp);
  app.use("/functions/v1", edgeRouter(registry));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);

  return app;
}
