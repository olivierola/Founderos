// support-ai — AI assistance for the Support module.
//
// Body: { workspace_id, project_id, ticket_id, action }
//   action = "suggest_reply" | "summarize" | "sentiment"
//
// Grounds the model in the ticket thread + the project's published knowledge-base
// articles (and RAG chunks) so replies are accurate and on-brand.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

async function loadTicketContext(admin: ReturnType<typeof createServiceClient>, ticketId: string) {
  const { data: ticket } = await admin
    .from("support_tickets")
    .select("subject, body, priority, status, requester_email, category")
    .eq("id", ticketId)
    .maybeSingle();
  const { data: messages } = await admin
    .from("support_messages")
    .select("author, body, is_internal, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true })
    .limit(40);
  return { ticket, messages: messages ?? [] };
}

// Pull relevant KB: published articles (keyword overlap) + RAG chunks.
async function loadKnowledge(admin: ReturnType<typeof createServiceClient>, projectId: string, query: string): Promise<string[]> {
  const out: string[] = [];
  const { data: articles } = await admin
    .from("support_articles")
    .select("title, body")
    .eq("project_id", projectId)
    .eq("status", "published")
    .limit(20);
  // Lightweight relevance: score by shared words with the query.
  const qWords = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const scored = (articles ?? [])
    .map((a) => {
      const text = `${a.title}\n${a.body ?? ""}`;
      const words = new Set(text.toLowerCase().split(/\W+/));
      let score = 0; qWords.forEach((w) => { if (words.has(w)) score++; });
      return { score, text: `# ${a.title}\n${(a.body ?? "").slice(0, 800)}` };
    })
    .sort((a, b) => b.score - a.score)
    .filter((s) => s.score > 0)
    .slice(0, 4);
  out.push(...scored.map((s) => s.text));

  // Semantic RAG over the project's indexed knowledge.
  try {
    const { embedTexts, toVectorLiteral } = await import("../_shared/jina.ts");
    const [vec] = await embedTexts([query], "retrieval.query");
    if (vec) {
      const { data: agents } = await admin.from("rag_agents").select("id").eq("project_id", projectId).limit(6);
      const hits: { sim: number; text: string }[] = [];
      for (const a of agents ?? []) {
        const { data } = await admin.rpc("match_rag_chunks", { p_agent_id: (a as any).id, p_query_embedding: toVectorLiteral(vec), p_match_count: 3 });
        for (const d of (data as any[]) ?? []) hits.push({ sim: d.similarity ?? 0, text: (d.content ?? "").slice(0, 500) });
      }
      hits.sort((x, y) => y.sim - x.sim);
      out.push(...hits.slice(0, 4).map((h) => h.text));
    }
  } catch { /* embeddings unavailable */ }
  return out;
}

function threadText(ticket: any, messages: any[]): string {
  const lines = [`Sujet: ${ticket?.subject ?? ""}`, `Priorité: ${ticket?.priority ?? ""}`, ""];
  lines.push(`CLIENT: ${ticket?.body ?? ""}`);
  for (const m of messages) {
    if (m.is_internal) continue; // exclude internal notes from the customer-facing reply context
    lines.push(`${m.author === "agent" ? "AGENT" : "CLIENT"}: ${m.body}`);
  }
  return lines.join("\n");
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

    const { workspace_id, project_id, ticket_id, action } = await req.json();
    if (!workspace_id || !project_id || !ticket_id) {
      return jsonResponse({ error: "workspace_id, project_id, ticket_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: member } = await admin
      .from("workspace_members").select("role")
      .eq("workspace_id", workspace_id).eq("user_id", userData.user.id).maybeSingle();
    if (!member) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    const { ticket, messages } = await loadTicketContext(admin, ticket_id);
    if (!ticket) return jsonResponse({ error: "Ticket not found" }, { status: 404 });
    const thread = threadText(ticket, messages);

    let systemPrompt = "";
    let userPrompt = "";
    const act = (action ?? "suggest_reply") as string;

    if (act === "summarize") {
      systemPrompt = "Tu es un assistant support. Résume le ticket en 2-3 puces: le problème, ce qui a été fait, et la prochaine action. Sois concis.";
      userPrompt = thread;
    } else if (act === "sentiment") {
      systemPrompt = `Analyse le sentiment du client dans ce ticket. Réponds UNIQUEMENT en JSON: {"sentiment":"positive|neutral|negative|frustrated","urgency":"low|medium|high","summary":"une phrase"}.`;
      userPrompt = thread;
    } else {
      // suggest_reply (default) — grounded in the KB.
      const lastCustomer = [...messages].reverse().find((m) => m.author === "customer")?.body ?? ticket.body ?? ticket.subject;
      const knowledge = await loadKnowledge(admin, project_id, `${ticket.subject}\n${lastCustomer}`);
      systemPrompt = `Tu es un agent de support client expert et empathique. Rédige une réponse prête à envoyer au client.
Règles:
- Réponds dans la langue du client.
- Appuie-toi STRICTEMENT sur la base de connaissances fournie quand elle est pertinente; n'invente pas de fonctionnalités ou de procédures.
- Si l'information manque, demande poliment une précision plutôt que d'inventer.
- Ton chaleureux, clair, structuré (étapes numérotées si utile). Pas de méta-commentaire, juste le message au client.`;
      userPrompt = `Fil du ticket:
${thread}

${knowledge.length ? `Base de connaissances (extraits pertinents):\n${knowledge.join("\n\n---\n\n")}` : "(aucun article de base de connaissances pertinent trouvé)"}

Rédige la meilleure réponse au client.`;
    }

    const result = await callAi({
      task: "chat_simple",
      systemPrompt,
      userPrompt,
      jsonMode: act === "sentiment",
      maxTokens: act === "suggest_reply" ? 800 : 400,
      temperature: act === "suggest_reply" ? 0.5 : 0.2,
    });

    await logLlmUsage({
      workspace_id, project_id, provider: result.provider, model: result.model,
      task: "chat_simple", feature: `support-ai-${act}`, usage: result.usage,
    });

    return jsonResponse({ ok: true, action: act, content: result.content });
  } catch (err) {
    return jsonResponse({ error: "support-ai failed", detail: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
