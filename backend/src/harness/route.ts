// /functions/v1/internal-agent-run : l'URL que le front, les passerelles et les
// appelants internes utilisent depuis toujours, servie par le harnais OpenCode.
// L'ancien moteur n'existe plus ; tous les modes passent ici.
//
//   chat                 { agent_id, conversation_id, model? }  → un tour (runs.ts)
//   mission              { agent_id, run_id }                    → la mission en file
//   room_advance         { mission_id }                          → l'orchestrateur de salle
//   mobile, mobile_chat  l'API de l'application mobile (agents/extras.ts)
//   design               { request, project_id? }                → la conception d'un agent
//   knowledge_backfill   { workspace_id }                        → le graphe de connaissances
//   tick                 obsolète (l'ancienne file de ticks) : sans effet
//
// Mêmes contrôles qu'avant : clé de service, ou personne ayant accès à
// l'agent ; conversation appartenant à l'agent ; crédits et quota vérifiés
// avant d'engager la dépense.

import express, { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "../edge/_shared/authz.ts";
import { isQuotaError, quotaErrorResponse } from "../edge/_shared/metering.ts";
import { createServiceClient } from "../edge/_shared/supabase-admin.ts";
import { advanceRoomMission } from "../edge/_shared/room-orchestrator.ts";
import { backfillKnowledge, designAgent, handleMobile } from "../agents/extras.ts";
import { RunRequestError, startAgentRun } from "./runs.ts";
import type { HarnessRuntime } from "./runtime.ts";

/** Une réponse d'edge function (Response) recopiée dans Express. */
async function sendResponse(res: Response, r: globalThis.Response) {
  const text = await r.text();
  res.status(r.status);
  r.headers.forEach((v, k) => { if (k.toLowerCase() !== "content-length") res.setHeader(k, v); });
  res.send(text);
}

export function harnessRouter(runtime: () => HarnessRuntime | null): Router {
  const router = Router();
  router.post("/internal-agent-run", express.raw({ type: () => true, limit: "50mb" }), async (req: Request, res: Response) => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.isBuffer(req.body) && req.body.length ? req.body.toString("utf8") : "{}");
    } catch {
      return res.status(400).json({ error: "corps JSON invalide" });
    }
    const authHeader = String(req.headers.authorization ?? "");
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Missing Authorization header" });
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    const isService = !!serviceKey && timingSafeEqual(token, serviceKey);
    const mode = String(body.mode ?? "");
    const admin = createServiceClient();
    const userOf = async (): Promise<string | null> => {
      if (typeof res.locals.userId === "string") return res.locals.userId;
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    };

    try {
      if (mode === "tick") return res.json({ ok: true, skipped: true, reason: "le harnais OpenCode n'utilise plus de ticks" });

      if (mode === "room_advance") {
        const tickSecret = process.env.AGENT_TICK_SECRET ?? "";
        const provided = String(req.headers["x-tick-secret"] ?? "");
        if (!isService && (!tickSecret || !timingSafeEqual(provided, tickSecret))) return res.status(403).json({ error: "room_advance is internal-only" });
        const missionId = String(body.mission_id ?? "");
        if (!missionId) return res.status(400).json({ error: "mission_id required" });
        await advanceRoomMission(admin as never, missionId);
        return res.json({ ok: true });
      }

      if (mode === "mobile" || mode === "mobile_chat") return sendResponse(res, await handleMobile(body, authHeader));

      if (mode === "design") {
        const request = String(body.request ?? "").trim();
        if (!request) return res.status(400).json({ error: "request required" });
        if (!isService && !await userOf()) return res.status(401).json({ error: "Invalid session" });
        return sendResponse(res, await designAgent(request, typeof body.project_id === "string" ? body.project_id : null));
      }

      if (mode === "knowledge_backfill") {
        const workspaceId = String(body.workspace_id ?? "");
        if (!workspaceId) return res.status(400).json({ error: "workspace_id required" });
        if (!isService) {
          const userId = await userOf();
          const { data: mem } = userId
            ? await admin.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle()
            : { data: null };
          if (!mem || (mem as { role: string }).role === "viewer") return res.status(403).json({ error: "Not authorized" });
        }
        return res.json(await backfillKnowledge(admin as never, workspaceId));
      }

      if (mode !== "chat" && mode !== "mission") {
        return res.status(400).json({ error: mode ? `mode inconnu : ${mode}` : "Missing agent_id or mode" });
      }
      const rt = runtime();
      if (!rt) return res.status(503).json({ error: "le moteur d'agents (harnais OpenCode) n'est pas démarré" });
      const agentId = typeof body.agent_id === "string" ? body.agent_id : "";
      if (!agentId) return res.status(400).json({ error: "Missing agent_id or mode" });
      const agent = await rt.store.agent(agentId).catch(() => null);
      if (!agent) return res.status(404).json({ error: "agent introuvable" });

      let userId: string | null = null;
      if (!isService && !timingSafeEqual(token, rt.serviceKey)) {
        userId = (typeof res.locals.userId === "string" ? res.locals.userId : null) ?? await rt.verifyUser(token);
        if (!userId) return res.status(401).json({ error: "Invalid session" });
        if (!await rt.store.hasAgentAccess(agent.id, userId)) return res.status(403).json({ error: "Not authorized for this agent" });
      }

      if (mode === "chat") {
        const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : "";
        if (!conversationId) return res.status(400).json({ error: "conversation_id required for chat mode" });
        if (!await rt.store.conversation(conversationId, agent.id)) {
          return res.status(403).json({ error: "Conversation does not belong to this agent" });
        }
        await rt.checkCredits(agent.workspace_id);
        return res.json(await (rt.startRun ?? ((i) => startAgentRun(rt, i)))({
          agentId: agent.id, kind: "chat", conversationId, actingUserId: userId,
          model: typeof body.model === "string" ? body.model : null, via: "chat",
        }));
      }

      // mission
      const runId = typeof body.run_id === "string" ? body.run_id : "";
      if (!runId) return res.status(400).json({ error: "run_id required for mission mode" });
      await rt.checkCredits(agent.workspace_id);
      return res.json(await (rt.startRun ?? ((i) => startAgentRun(rt, i)))({ agentId: agent.id, kind: "mission", runId, actingUserId: userId }));
    } catch (e) {
      if (isQuotaError(e)) {
        const r = quotaErrorResponse(e);
        return res.status(r.status).json(await r.json());
      }
      if (e instanceof RunRequestError) return res.status(e.status).json({ ok: false, error: e.message });
      return res.status(500).json({ error: e instanceof Error ? e.message : "Internal error" });
    }
  });
  return router;
}
