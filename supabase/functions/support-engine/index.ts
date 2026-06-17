// support-engine — consolidated AI + automation for the Support module.
// Replaces support-ai. Action-dispatch to respect the edge-function cap.
//
// Body: { workspace_id, project_id, action, ... }
//   action = "suggest_reply" | "summarize" | "sentiment"   (ticket-grounded, needs ticket_id)
//          | "resolve"                                       (RAG auto-resolve + deflect/escalate decision)
//          | "kb_search"                                     (semantic + article search; needs query)
//          | "route"                                         (apply routing rules to a ticket)
//          | "sla_tick"                                      (recompute SLA breaches; batch)
//          | "portal_reply"                                  (public help-center answer from KB)
//
// AI is grounded in the ticket thread + published KB articles + RAG knowledge.
// When a portal/collection is wired, retrieval is scoped to that RAG collection.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

type Admin = ReturnType<typeof createServiceClient>;

// ───────────────────────────────────────────────────────── knowledge retrieval
async function ragSearch(admin: Admin, projectId: string, query: string, collectionId?: string | null): Promise<string[]> {
  const out: string[] = [];
  try {
    const { embedTexts, toVectorLiteral } = await import("../_shared/jina.ts");
    const [vec] = await embedTexts([query], "retrieval.query");
    if (vec) {
      const lit = toVectorLiteral(vec);
      if (collectionId) {
        const { data } = await admin.rpc("match_rag_collection_chunks", {
          p_collection_ids: [collectionId], p_query_embedding: lit, p_match_count: 6,
        });
        for (const d of (data as any[]) ?? []) out.push((d.content ?? "").slice(0, 500));
      } else {
        const { data: agents } = await admin.from("rag_agents").select("id").eq("project_id", projectId).limit(6);
        const hits: { sim: number; text: string }[] = [];
        for (const a of agents ?? []) {
          const { data } = await admin.rpc("match_rag_chunks", { p_agent_id: (a as any).id, p_query_embedding: lit, p_match_count: 3 });
          for (const d of (data as any[]) ?? []) hits.push({ sim: d.similarity ?? 0, text: (d.content ?? "").slice(0, 500) });
        }
        hits.sort((x, y) => y.sim - x.sim);
        out.push(...hits.slice(0, 6).map((h) => h.text));
      }
    }
  } catch { /* embeddings unavailable */ }
  return out;
}

async function articleSearch(admin: Admin, projectId: string, query: string, limit = 4): Promise<{ title: string; body: string; id: string }[]> {
  const { data: articles } = await admin
    .from("support_articles").select("id, title, body")
    .eq("project_id", projectId).eq("status", "published").limit(30);
  const qWords = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  return (articles ?? [])
    .map((a) => {
      const words = new Set(`${a.title} ${a.body ?? ""}`.toLowerCase().split(/\W+/));
      let score = 0; qWords.forEach((w) => { if (words.has(w)) score++; });
      return { score, id: a.id as string, title: a.title as string, body: (a.body ?? "").slice(0, 800) as string };
    })
    .filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

async function loadTicket(admin: Admin, ticketId: string) {
  const { data: ticket } = await admin.from("support_tickets")
    .select("id, subject, body, priority, status, requester_email, category, channel").eq("id", ticketId).maybeSingle();
  const { data: messages } = await admin.from("support_messages")
    .select("author, body, is_internal, created_at").eq("ticket_id", ticketId)
    .order("created_at", { ascending: true }).limit(40);
  return { ticket, messages: messages ?? [] };
}

function threadText(ticket: any, messages: any[]): string {
  const lines = [`Sujet: ${ticket?.subject ?? ""}`, `Priorité: ${ticket?.priority ?? ""}`, "", `CLIENT: ${ticket?.body ?? ""}`];
  for (const m of messages) { if (m.is_internal) continue; lines.push(`${m.author === "agent" ? "AGENT" : "CLIENT"}: ${m.body}`); }
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────── handlers
async function handleResolve(admin: Admin, workspace_id: string, project_id: string, ticket_id: string, collectionId?: string | null) {
  const { ticket, messages } = await loadTicket(admin, ticket_id);
  if (!ticket) return { error: "Ticket not found", status: 404 };
  const lastCustomer = [...messages].reverse().find((m) => m.author === "customer")?.body ?? ticket.body ?? ticket.subject;
  const query = `${ticket.subject}\n${lastCustomer}`;
  const [rag, articles] = await Promise.all([ragSearch(admin, project_id, query, collectionId), articleSearch(admin, project_id, query)]);
  const knowledge = [...articles.map((a) => `# ${a.title}\n${a.body}`), ...rag];

  const systemPrompt = `Tu es un agent de support autonome. Décide si tu peux résoudre ce ticket avec CERTITUDE à partir de la base de connaissances, sinon escalade vers un humain.
Réponds UNIQUEMENT en JSON:
{"decision":"resolve"|"escalate","confidence":0-100,"reply":"message client prêt à envoyer (langue du client)","reason":"pourquoi escalader le cas échéant"}
Règles: n'invente jamais. Si la connaissance ne couvre pas clairement le problème, ou si le client est très mécontent/menace de partir/demande un humain → escalate. Le 'reply' doit être chaleureux, structuré, sans méta-commentaire.`;
  const userPrompt = `Fil du ticket:\n${threadText(ticket, messages)}\n\n${knowledge.length ? `Base de connaissances:\n${knowledge.join("\n\n---\n\n")}` : "(aucune connaissance pertinente trouvée)"}`;

  const result = await callAi({ task: "chat_simple", systemPrompt, userPrompt, jsonMode: true, maxTokens: 900, temperature: 0.3 });
  await logLlmUsage({ workspace_id, project_id, provider: result.provider, model: result.model, task: "chat_simple", feature: "support-resolve", usage: result.usage });
  const parsed = safeParseJson<{ decision: string; confidence: number; reply: string; reason?: string }>(result.content) ?? { decision: "escalate", confidence: 0, reply: "", reason: "parse_error" };
  return { ok: true, ...parsed };
}

async function handleRoute(admin: Admin, project_id: string, ticket_id: string) {
  const { ticket } = await loadTicket(admin, ticket_id);
  if (!ticket) return { error: "Ticket not found", status: 404 };
  const { data: rules } = await admin.from("support_routing_rules")
    .select("conditions, actions").eq("project_id", project_id).eq("enabled", true).order("position");
  const text = `${ticket.subject} ${ticket.body ?? ""}`.toLowerCase();
  for (const r of (rules ?? []) as any[]) {
    const c = r.conditions ?? {};
    if (c.channel && c.channel !== ticket.channel) continue;
    if (c.priority && c.priority !== ticket.priority) continue;
    if (Array.isArray(c.keywords) && c.keywords.length && !c.keywords.some((k: string) => text.includes(String(k).toLowerCase()))) continue;
    const a = r.actions ?? {};
    const patch: Record<string, unknown> = {};
    if (a.team) patch.assigned_team = a.team;
    if (a.assignee_id) patch.assignee_id = a.assignee_id;
    if (a.priority) patch.priority = a.priority;
    if (a.sla_policy_id) patch.sla_policy_id = a.sla_policy_id;
    if (Object.keys(patch).length) await admin.from("support_tickets").update(patch).eq("id", ticket_id);
    return { ok: true, matched: true, actions: a };
  }
  return { ok: true, matched: false };
}

async function handleSlaTick(admin: Admin, project_id: string) {
  const now = new Date().toISOString();
  // Mark breaches where a due date has passed and the ticket is still open/pending.
  const { data: open } = await admin.from("support_tickets")
    .select("id, first_response_due, resolution_due, first_response_at, status, sla_breached")
    .eq("project_id", project_id).in("status", ["open", "pending", "on_hold"]).limit(500);
  let breached = 0;
  for (const t of (open ?? []) as any[]) {
    const frtBreach = t.first_response_due && !t.first_response_at && t.first_response_due < now;
    const resBreach = t.resolution_due && t.resolution_due < now;
    if ((frtBreach || resBreach) && !t.sla_breached) {
      await admin.from("support_tickets").update({ sla_breached: true }).eq("id", t.id);
      breached++;
    }
  }
  return { ok: true, breached };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const body = await req.json();
    const { workspace_id, project_id, action } = body as { workspace_id?: string; project_id?: string; action?: string };
    if (!workspace_id || !project_id) return jsonResponse({ error: "workspace_id, project_id required" }, { status: 400 });
    const act = (action ?? "suggest_reply") as string;

    const admin = createServiceClient();

    // Auth: workspace member (user session) OR service role (runner/scheduler).
    const authHeader = req.headers.get("Authorization") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const isService = !!serviceKey && authHeader === `Bearer ${serviceKey}`;
    if (!isService) {
      if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
      const userClient = createUserClient(authHeader);
      const { data: userData } = await userClient.auth.getUser();
      if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      const { data: member } = await admin.from("workspace_members").select("role")
        .eq("workspace_id", workspace_id).eq("user_id", userData.user.id).maybeSingle();
      if (!member) return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    // Stateless actions.
    if (act === "kb_search") {
      const query = String(body.query ?? "");
      if (!query) return jsonResponse({ error: "query required" }, { status: 400 });
      const [rag, articles] = await Promise.all([
        ragSearch(admin, project_id, query, body.rag_collection_id ?? null),
        articleSearch(admin, project_id, query, 6),
      ]);
      return jsonResponse({ ok: true, articles, chunks: rag });
    }
    if (act === "sla_tick") return jsonResponse(await handleSlaTick(admin, project_id));
    if (act === "route") {
      if (!body.ticket_id) return jsonResponse({ error: "ticket_id required" }, { status: 400 });
      const r = await handleRoute(admin, project_id, body.ticket_id);
      return jsonResponse(r, { status: (r as any).status ?? 200 });
    }
    if (act === "resolve") {
      if (!body.ticket_id) return jsonResponse({ error: "ticket_id required" }, { status: 400 });
      const r = await handleResolve(admin, workspace_id, project_id, body.ticket_id, body.rag_collection_id ?? null);
      return jsonResponse(r, { status: (r as any).status ?? 200 });
    }
    if (act === "portal_reply") {
      const query = String(body.query ?? "");
      if (!query) return jsonResponse({ error: "query required" }, { status: 400 });
      const [rag, articles] = await Promise.all([
        ragSearch(admin, project_id, query, body.rag_collection_id ?? null),
        articleSearch(admin, project_id, query, 4),
      ]);
      const knowledge = [...articles.map((a) => `# ${a.title}\n${a.body}`), ...rag];
      const result = await callAi({
        task: "chat_simple",
        systemPrompt: `Tu es l'assistant du centre d'aide. Réponds à la question UNIQUEMENT à partir de la base de connaissances. Si elle ne contient pas la réponse, dis que tu vas créer un ticket pour un humain. Langue de l'utilisateur. Concis et utile.`,
        userPrompt: `Question: ${query}\n\n${knowledge.length ? `Connaissances:\n${knowledge.join("\n\n---\n\n")}` : "(rien de pertinent)"}`,
        maxTokens: 600, temperature: 0.3,
      });
      await logLlmUsage({ workspace_id, project_id, provider: result.provider, model: result.model, task: "chat_simple", feature: "support-portal", usage: result.usage });
      return jsonResponse({ ok: true, content: result.content, grounded: knowledge.length > 0, articles });
    }

    // Ticket-grounded AI assist (suggest_reply / summarize / sentiment).
    if (!body.ticket_id) return jsonResponse({ error: "ticket_id required" }, { status: 400 });
    const { ticket, messages } = await loadTicket(admin, body.ticket_id);
    if (!ticket) return jsonResponse({ error: "Ticket not found" }, { status: 404 });
    const thread = threadText(ticket, messages);

    let systemPrompt = "", userPrompt = thread;
    if (act === "summarize") {
      systemPrompt = "Tu es un assistant support. Résume le ticket en 2-3 puces: le problème, ce qui a été fait, et la prochaine action. Sois concis.";
    } else if (act === "sentiment") {
      systemPrompt = `Analyse le sentiment du client. Réponds UNIQUEMENT en JSON: {"sentiment":"positive|neutral|negative|frustrated","urgency":"low|medium|high","summary":"une phrase"}.`;
    } else {
      const lastCustomer = [...messages].reverse().find((m) => m.author === "customer")?.body ?? ticket.body ?? ticket.subject;
      const [rag, articles] = await Promise.all([
        ragSearch(admin, project_id, `${ticket.subject}\n${lastCustomer}`, body.rag_collection_id ?? null),
        articleSearch(admin, project_id, `${ticket.subject}\n${lastCustomer}`),
      ]);
      const knowledge = [...articles.map((a) => `# ${a.title}\n${a.body}`), ...rag];
      systemPrompt = `Tu es un agent de support client expert et empathique. Rédige une réponse prête à envoyer au client.
Règles: réponds dans la langue du client; appuie-toi STRICTEMENT sur la base de connaissances quand pertinente; n'invente rien; si l'info manque, demande une précision; ton chaleureux, clair, structuré; pas de méta-commentaire.`;
      userPrompt = `Fil du ticket:\n${thread}\n\n${knowledge.length ? `Base de connaissances:\n${knowledge.join("\n\n---\n\n")}` : "(aucun article pertinent)"}\n\nRédige la meilleure réponse au client.`;
    }

    const result = await callAi({
      task: "chat_simple", systemPrompt, userPrompt,
      jsonMode: act === "sentiment", maxTokens: act === "suggest_reply" ? 800 : 400,
      temperature: act === "suggest_reply" ? 0.5 : 0.2,
    });
    await logLlmUsage({ workspace_id, project_id, provider: result.provider, model: result.model, task: "chat_simple", feature: `support-${act}`, usage: result.usage });
    return jsonResponse({ ok: true, action: act, content: result.content });
  } catch (err) {
    return jsonResponse({ error: "support-engine failed", detail: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
