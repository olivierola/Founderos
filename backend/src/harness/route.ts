// L'aiguillage : un tour de chat d'un agent marqué « opencode » part sur le
// harnais OpenCode ; tout le reste continue vers l'ancien moteur, inchangé.
//
// Monté dans app.ts juste DEVANT les edge functions portées (après la
// vérification JWT de la passerelle). Le corps est lu en `express.raw`, comme
// le fait le routeur des fonctions : une requête qu'on laisse passer (next)
// arrive intacte à internal-agent-run.
//
// Mêmes contrôles que l'ancien moteur : clé de service, ou personne ayant
// accès à l'agent ; conversation appartenant à l'agent ; crédits et quota
// vérifiés avant d'engager la dépense.

import express, { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "../edge/_shared/authz.ts";
import { isQuotaError, quotaErrorResponse } from "../edge/_shared/metering.ts";
import { startChatTurn } from "./chat.ts";
import type { HarnessRuntime } from "./runtime.ts";

export function harnessRouter(runtime: () => HarnessRuntime | null): Router {
  const router = Router();
  router.post("/internal-agent-run", express.raw({ type: () => true, limit: "50mb" }), async (req: Request, res: Response, next) => {
    const rt = runtime();
    if (!rt) return next();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}");
    } catch {
      return next();
    }
    const agentId = typeof body.agent_id === "string" ? body.agent_id : "";
    if (body.mode !== "chat" || !agentId) return next();
    const agent = await rt.store.agent(agentId).catch(() => null);
    if (!agent || agent.harness !== "opencode") return next();

    try {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!token) return res.status(401).json({ error: "Missing Authorization header" });
      if (!timingSafeEqual(token, rt.serviceKey)) {
        const userId = (typeof res.locals.userId === "string" ? res.locals.userId : null) ?? await rt.verifyUser(token);
        if (!userId) return res.status(401).json({ error: "Invalid session" });
        if (!await rt.store.hasAgentAccess(agent.id, userId)) return res.status(403).json({ error: "Not authorized for this agent" });
      }
      const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : "";
      if (!conversationId) return res.status(400).json({ error: "conversation_id required for chat mode" });
      if (!await rt.store.conversation(conversationId, agent.id)) {
        return res.status(403).json({ error: "Conversation does not belong to this agent" });
      }
      await rt.checkCredits(agent.workspace_id);
      const out = await startChatTurn(rt, {
        agent, conversationId, model: typeof body.model === "string" ? body.model : null,
      });
      return res.json(out);
    } catch (e) {
      if (isQuotaError(e)) {
        const r = quotaErrorResponse(e);
        return res.status(r.status).json(await r.json());
      }
      return res.status(500).json({ error: e instanceof Error ? e.message : "Internal error" });
    }
  });
  return router;
}
