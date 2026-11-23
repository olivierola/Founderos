// La passerelle des agents embarqués : /embedded/v1, ce que joint le SDK FounderOS
// depuis un conteneur, avec la clé d'API de l'instance. Tout est borné à l'agent
// de la clé : ses outils (dans ses pools, avec ses garde-fous), sa recherche, ses
// conversations, ses runs. Aucun secret ne sort : les connecteurs s'exécutent ici.
//
//   POST /hello            l'instance s'annonce (nom, version, empreinte du manifeste)
//   POST /heartbeat        elle est en vie ; réponse : des ordres l'attendent-ils
//   GET  /manifest         la configuration à jour (rechargement à chaud)
//   GET  /tools            les outils de la plateforme ouverts à l'agent
//   POST /tools/call       en exécuter un, pour un run
//   POST /search/grep      chercher dans la base de l'agent (grep du toolkit)
//   POST /search/read      relire des sources
//   POST /llm/chat/completions   le modèle, par la connexion de la plateforme
//   POST /store            les écritures du pont (runs, événements, messages, consommation)
//   POST /commands/take    l'ordre suivant pour cette instance
//   POST /commands/done    un ordre exécuté

import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "../edge/_shared/supabase-admin.ts";
import { assertCredits, isQuotaError } from "../edge/_shared/metering.ts";
import { llmAuthHeaders, pinnedUpstream } from "../edge/_shared/llm-upstream.ts";
import { prepareAgentToolset } from "../agents/context.ts";
import { guardToolCall, guardToolResult, loadAgentGuardrails } from "../harness/guard.ts";
import { afterTool, beforeTool, researchFor } from "../harness/research.ts";
import { usageToLlm } from "../harness/runtime.ts";
import { supabaseStore, type HarnessStore } from "../harness/store.ts";
import { documentCollections, rpcSearchIndex, supabaseRpc } from "../harness/toolkit/grep.ts";
import { resolveKey, type KeyOwner } from "./keys.ts";
import { compileManifest, LOCAL_ONLY, loadConfig } from "./manifest.ts";

type Admin = SupabaseClient;

interface Owner extends KeyOwner {
  projectId: string;
  agentName: string;
  syncLevel: "full" | "summary" | "metadata";
}

const owner = (res: Response) => res.locals.embedded as Owner;

/** Ce qui remonte d'une conversation, selon le niveau de synchronisation choisi. */
export function syncText(level: Owner["syncLevel"], text: string): string {
  if (level === "metadata") return "(contenu gardé sur l'instance)";
  if (level === "summary") return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return text;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Les champs d'un run que le conteneur peut écrire. */
const RUN_PATCH = new Set([
  "status", "finished_at", "final_output", "live_output", "live_output_at", "error_message", "tokens_in", "tokens_out",
  "cost_usd", "action_count", "steps", "todos", "pending_question",
]);

export function embeddedGateway(): Router {
  const router = Router();
  router.use(express.json({ limit: "20mb" }));
  const admin = () => createServiceClient() as unknown as Admin;

  // La clé d'API : l'agent, son espace, son projet.
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const key = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const found = key ? await resolveKey(admin(), key).catch(() => null) : null;
    if (!found) return res.status(401).json({ error: "clé d'API invalide ou révoquée" });
    const { data: agent } = await admin().from("internal_agents").select("name, project_id, deployment, is_archived").eq("id", found.agentId).maybeSingle();
    const a = agent as { name: string; project_id: string; deployment: string; is_archived: boolean } | null;
    if (!a || a.is_archived) return res.status(403).json({ error: "agent introuvable ou archivé" });
    const config = await loadConfig(admin(), found.agentId);
    res.locals.embedded = { ...found, projectId: a.project_id, agentName: a.name, syncLevel: config?.sync_level ?? "full" } satisfies Owner;
    next();
  });

  const fail = (res: Response, e: unknown) => {
    if (isQuotaError(e)) return res.status(402).json({ error: "crédits épuisés" });
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  };

  // ── L'instance ──
  router.post("/hello", async (req, res) => {
    try {
      const o = owner(res);
      const name = String(req.body?.name ?? o.label ?? "instance").slice(0, 80);
      const { data: build } = await admin().from("embedded_agent_builds").select("id, version, manifest_sha")
        .eq("agent_id", o.agentId).order("version", { ascending: false }).limit(1).maybeSingle();
      const b = build as { id: string; version: number; manifest_sha: string } | null;
      const { data: inst, error } = await admin().from("embedded_agent_instances").upsert({
        agent_id: o.agentId, workspace_id: o.workspaceId, name, status: "online", build_id: b?.id ?? null,
        manifest_sha: String(req.body?.manifest_sha ?? "") || null, version: Number(req.body?.version) || b?.version || null,
        info: (req.body?.info ?? {}) as Record<string, unknown>, last_seen_at: new Date().toISOString(),
        ...(typeof req.body?.container_ref === "string" ? { container_ref: req.body.container_ref } : {}),
      }, { onConflict: "agent_id,name" }).select("id").single();
      if (error) throw new Error(error.message);
      const live = await compileManifest(admin(), o.agentId);
      res.json({ instance_id: (inst as { id: string }).id, agent_id: o.agentId, manifest: live.manifest, sha: live.sha, latest_build: b });
    } catch (e) { fail(res, e); }
  });

  router.post("/heartbeat", async (req, res) => {
    const o = owner(res);
    const instanceId = String(req.body?.instance_id ?? "");
    if (!UUID.test(instanceId)) return res.status(400).json({ error: "instance_id invalide : appelez /hello d'abord" });
    const status = ["online", "paused"].includes(String(req.body?.status)) ? String(req.body.status) : "online";
    await admin().from("embedded_agent_instances").update({
      last_seen_at: new Date().toISOString(), status,
      ...(req.body?.info ? { info: req.body.info } : {}),
      ...(req.body?.manifest_sha ? { manifest_sha: String(req.body.manifest_sha) } : {}),
    }).eq("id", instanceId).eq("agent_id", o.agentId);
    const { count } = await admin().from("embedded_agent_commands").select("id", { count: "exact", head: true })
      .eq("agent_id", o.agentId).is("taken_at", null).or(`instance_id.is.null,instance_id.eq.${instanceId}`);
    res.json({ ok: true, commands: count ?? 0 });
  });

  router.get("/manifest", async (_req, res) => {
    try {
      const live = await compileManifest(admin(), owner(res).agentId);
      res.json({ manifest: live.manifest, sha: live.sha });
    } catch (e) { fail(res, e); }
  });

  // ── Les outils de la plateforme ──
  const toolsets = new Map<string, ReturnType<typeof prepareAgentToolset>>();
  const toolsetFor = (agentId: string, runId: string | null, conversationId: string | null) => {
    const key = `${agentId}:${runId ?? "-"}`;
    let p = toolsets.get(key);
    if (!p) {
      p = prepareAgentToolset(agentId, { runId, conversationId });
      p.catch(() => toolsets.delete(key));
      toolsets.set(key, p);
      while (toolsets.size > 64) toolsets.delete(toolsets.keys().next().value as string);
    }
    return p;
  };

  router.get("/tools", async (_req, res) => {
    try {
      const t = await toolsetFor(owner(res).agentId, null, null);
      res.json({
        agent: { name: t.agent.name, is_orchestrator: !!t.agent.is_orchestrator },
        tools: t.allDefs.filter((d) => !LOCAL_ONLY.test(d.name)).map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })),
      });
    } catch (e) { fail(res, e); }
  });

  router.post("/tools/call", async (req, res) => {
    const o = owner(res);
    try {
      const name = String(req.body?.name ?? "");
      const args = (req.body?.args && typeof req.body.args === "object" ? req.body.args : {}) as Record<string, unknown>;
      const runId = typeof req.body?.run_id === "string" ? req.body.run_id : null;
      if (!name || LOCAL_ONLY.test(name)) return res.status(400).json({ error: `outil « ${name} » non servi par la passerelle` });
      if (runId) {
        const { data: run } = await admin().from("internal_agent_runs").select("agent_id").eq("id", runId).maybeSingle();
        if ((run as { agent_id?: string } | null)?.agent_id !== o.agentId) return res.status(403).json({ error: "ce run n'est pas celui de l'agent" });
      }
      const conversationId = typeof req.body?.conversation_id === "string" ? req.body.conversation_id : null;
      const t = await toolsetFor(o.agentId, runId, conversationId);
      if (!t.allDefs.some((d) => d.name === name)) return res.status(403).json({ error: `outil « ${name} » hors des pools de l'agent` });
      const research = runId ? researchFor({ runId, agentId: o.agentId, projectId: o.projectId, workspaceId: o.workspaceId }, admin()) : null;
      const short = research ? await beforeTool(research, name, args).catch(() => null) : null;
      if (short != null) return res.json({ result: short });
      const rows = await loadAgentGuardrails(admin(), t.agent).catch(() => []);
      const refused = rows.length ? await guardToolCall(admin(), t.agent, runId, rows, name, args) : null;
      if (refused) return res.json({ result: refused });
      const out = String(await t.executor(name, args, {}));
      const checked = rows.length ? await guardToolResult(admin(), t.agent, runId, rows, name, out) : out;
      res.json({ result: research ? await afterTool(research, name, args, checked).catch(() => checked) : checked });
    } catch (e) { fail(res, e); }
  });

  // ── La recherche ──
  const indexFor = async (o: Owner) => {
    const t = await toolsetFor(o.agentId, null, null);
    return rpcSearchIndex(supabaseRpc(admin() as never), {
      workspaceId: o.workspaceId, projectId: o.projectId, agentId: o.agentId, collections: documentCollections(t.rows),
    });
  };
  router.post("/search/grep", async (req, res) => {
    try { res.json({ rows: await (await indexFor(owner(res))).grep(req.body ?? {}) }); } catch (e) { fail(res, e); }
  });
  router.post("/search/read", async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      res.json({ rows: await (await indexFor(owner(res))).read(ids, req.body?.whole === true) });
    } catch (e) { fail(res, e); }
  });

  // ── Le modèle, par la connexion de la plateforme ──
  router.post("/llm/chat/completions", async (req, res) => {
    const o = owner(res);
    try {
      await assertCredits(o.workspaceId, { minimum: 1 });
      const up = pinnedUpstream();
      if (!up) return res.status(503).json({ error: "aucune connexion LLM sur la plateforme" });
      const url = `${up.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const headers = await llmAuthHeaders(url, "");
      const upstream = await fetch(url, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(req.body ?? {}),
      });
      res.status(upstream.status);
      const type = upstream.headers.get("content-type");
      if (type) res.setHeader("Content-Type", type);
      if (!upstream.body) return res.end();
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      res.end();
    } catch (e) {
      if (!res.headersSent) fail(res, e);
      else res.end();
    }
  });

  // ── Le pont : ce que le conteneur écrit, borné à son agent ──
  router.post("/store", async (req, res) => {
    const o = owner(res);
    const op = String(req.body?.op ?? "");
    const a = (Array.isArray(req.body?.args) ? req.body.args : []) as unknown[];
    const store = supabaseStore(admin(), usageToLlm);
    const ownConversation = async (cid: unknown) => {
      const { data } = await admin().from("internal_agent_conversations").select("agent_id").eq("id", String(cid ?? "")).maybeSingle();
      return (data as { agent_id?: string } | null)?.agent_id === o.agentId;
    };
    const ownRun = async (rid: unknown) => {
      const { data } = await admin().from("internal_agent_runs").select("agent_id").eq("id", String(rid ?? "")).maybeSingle();
      return (data as { agent_id?: string } | null)?.agent_id === o.agentId;
    };
    const deny = () => res.status(403).json({ error: `opération ${op} refusée hors de l'agent` });
    try {
      switch (op as keyof HarnessStore) {
        case "agent":
          return res.json({ result: String(a[0]) === o.agentId ? await store.agent(o.agentId) : null });
        case "conversation":
          return res.json({ result: String(a[1]) === o.agentId ? await store.conversation(String(a[0]), o.agentId) : null });
        case "setConversationSession":
          if (!await ownConversation(a[0])) return deny();
          await store.setConversationSession(String(a[0]), String(a[1]));
          return res.json({ result: null });
        case "recentMessages":
          if (!await ownConversation(a[0])) return deny();
          return res.json({ result: await store.recentMessages(String(a[0]), Number(a[1]) || 13) });
        case "activeRun":
          if (!await ownConversation(a[0])) return deny();
          return res.json({ result: await store.activeRun(String(a[0])) });
        case "pendingQuestion":
          if (!await ownConversation(a[0])) return deny();
          return res.json({ result: await store.pendingQuestion!(String(a[0])) });
        case "createRun": {
          const input = (a[0] ?? {}) as Parameters<HarnessStore["createRun"]>[0];
          if (input.conversationId && !await ownConversation(input.conversationId)) return deny();
          if (input.runId && !await ownRun(input.runId)) return deny();
          const agent = await store.agent(o.agentId);
          if (!agent) return deny();
          const runId = await store.createRun({ ...input, agent });
          if (typeof req.body?.instance_id === "string") {
            await admin().from("internal_agent_runs").update({ instance_id: req.body.instance_id }).eq("id", runId).eq("agent_id", o.agentId);
          }
          return res.json({ result: runId });
        }
        case "runningRuns": {
          const runs = await store.runningRuns();
          return res.json({ result: runs.filter((r) => r.agentId === o.agentId) });
        }
        case "cancelledAmong": {
          const ids = (Array.isArray(a[0]) ? a[0] : []).map(String);
          const { data } = await admin().from("internal_agent_runs").select("id").in("id", ids.length ? ids : ["-"]).eq("agent_id", o.agentId).eq("status", "cancelled");
          return res.json({ result: ((data ?? []) as Array<{ id: string }>).map((r) => r.id) });
        }
        case "insertEvent":
          if (!await ownRun(a[0])) return deny();
          await store.insertEvent(String(a[0]), o.agentId, String(a[2]), (a[3] ?? {}) as Record<string, unknown>);
          return res.json({ result: null });
        case "updateRun": {
          if (!await ownRun(a[0])) return deny();
          const patch = Object.fromEntries(Object.entries((a[1] ?? {}) as Record<string, unknown>).filter(([k]) => RUN_PATCH.has(k)));
          if (o.syncLevel !== "full") {
            if (typeof patch.final_output === "string") patch.final_output = syncText(o.syncLevel, patch.final_output);
            if (typeof patch.live_output === "string") patch.live_output = o.syncLevel === "metadata" ? null : syncText(o.syncLevel, patch.live_output);
          }
          await store.updateRun(String(a[0]), patch);
          return res.json({ result: null });
        }
        case "insertAssistantMessage": {
          const row = (a[0] ?? {}) as Parameters<HarnessStore["insertAssistantMessage"]>[0];
          if (!await ownConversation(row.conversationId) || !await ownRun(row.runId)) return deny();
          await store.insertAssistantMessage({ ...row, agentId: o.agentId, content: syncText(o.syncLevel, String(row.content ?? "")) });
          return res.json({ result: null });
        }
        case "touchConversation":
          if (!await ownConversation(a[0])) return deny();
          await store.touchConversation(String(a[0]));
          return res.json({ result: null });
        case "logUsage": {
          const row = (a[0] ?? {}) as Parameters<HarnessStore["logUsage"]>[0];
          if (row.runId && !await ownRun(row.runId)) return deny();
          await store.logUsage({ ...row, agentId: o.agentId, workspaceId: o.workspaceId, projectId: o.projectId });
          return res.json({ result: null });
        }
        default:
          return res.status(400).json({ error: `opération inconnue : ${op}` });
      }
    } catch (e) { fail(res, e); }
  });

  // ── Les ordres ──
  router.post("/commands/take", async (req, res) => {
    const o = owner(res);
    const instanceId = UUID.test(String(req.body?.instance_id ?? "")) ? String(req.body.instance_id) : "";
    const base = admin().from("embedded_agent_commands").select("id, command, payload, instance_id")
      .eq("agent_id", o.agentId).is("taken_at", null);
    const { data } = await (instanceId ? base.or(`instance_id.is.null,instance_id.eq.${instanceId}`) : base.is("instance_id", null))
      .order("created_at", { ascending: true }).limit(1).maybeSingle();
    const cmd = data as { id: number; command: string; payload: Record<string, unknown> } | null;
    if (!cmd) return res.json({ command: null });
    // Pris une seule fois, même si deux instances demandent en même temps.
    const { data: taken } = await admin().from("embedded_agent_commands")
      .update({ taken_at: new Date().toISOString(), instance_id: instanceId || null }).eq("id", cmd.id).is("taken_at", null).select("id");
    if (!taken || !(taken as unknown[]).length) return res.json({ command: null });
    res.json({ command: cmd });
  });

  router.post("/commands/done", async (req, res) => {
    const o = owner(res);
    await admin().from("embedded_agent_commands").update({ done_at: new Date().toISOString() })
      .eq("id", Number(req.body?.id)).eq("agent_id", o.agentId);
    res.json({ ok: true });
  });

  return router;
}
