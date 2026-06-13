// office-ai-stream — streaming AI for the Plate editor, grounded in the project's
// RAG knowledge base + code-scan understanding.
//
// Two modes (same endpoint):
//   - "chat"    (default): the Plate AI menu (⌘+J). Body is the AI-SDK chat
//     payload { messages, ... } plus { workspace_id, project_id, use_knowledge }.
//     Responds with an AI-SDK UI message stream (SSE: text-start/-delta/-end…).
//   - "copilot": inline autocomplete. Body { prompt|messages, system, workspace_id,
//     project_id }. Responds with a plain-text stream (what useCompletion expects).
//
// Auth: requires the user's Supabase Authorization header; the caller must be a
// member of the workspace. Knowledge access is implicitly scoped to the project.

import { handleCors, jsonResponse, corsHeaders } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";
import { loadGrounding, groundingPromptBlock, searchKnowledge } from "../_shared/office-rag.ts";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const enc = new TextEncoder();

function sse(obj: unknown): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

// Extract the latest user text from an AI-SDK message list.
function lastUserText(messages: any[]): string {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  const parts = last.parts ?? last.content ?? [];
  return (Array.isArray(parts) ? parts : [])
    .filter((p: any) => p?.type === "text" || typeof p === "string")
    .map((p: any) => (typeof p === "string" ? p : p.text))
    .join(" ");
}

// Flatten AI-SDK messages into plain {role, content} for the LLM call.
function toLlmMessages(messages: any[]): { role: string; content: string }[] {
  return (messages ?? []).map((m) => {
    let content = "";
    if (typeof m.content === "string") content = m.content;
    else {
      const parts = m.parts ?? m.content ?? [];
      content = (Array.isArray(parts) ? parts : [])
        .filter((p: any) => p?.type === "text" || typeof p === "string")
        .map((p: any) => (typeof p === "string" ? p : p.text))
        .join("\n");
    }
    return { role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user", content };
  });
}

// Open a streaming Groq completion and yield text deltas.
async function* streamGroq(
  messages: { role: string; content: string }[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) throw new Error("GROQ_API_KEY not configured");
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.5, max_tokens: 1500, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta as string;
      } catch { /* ignore keep-alive / partial */ }
    }
  }
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

    const body = await req.json();
    const { workspace_id, project_id } = body;
    const mode = (body.mode ?? "chat") as "chat" | "copilot";
    const useKnowledge = body.use_knowledge !== false;
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: member } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!member) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    // ----------------------------------------------------------- COPILOT
    if (mode === "copilot") {
      const prompt = String(body.prompt ?? lastUserText(body.messages ?? []) ?? "").trim();
      const system = String(body.system ?? "You are a writing copilot. Continue the text naturally.");
      // Light RAG: pull a couple of knowledge snippets to keep completions on-topic.
      const knowledge = useKnowledge ? await searchKnowledge(admin, project_id, prompt, 3) : [];
      const sys = knowledge.length
        ? `${system}\n\nProject knowledge (use only if relevant):\n- ${knowledge.join("\n- ")}`
        : system;

      const abort = new AbortController();
      req.signal.addEventListener("abort", () => abort.abort());
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const delta of streamGroq(
              [{ role: "system", content: sys }, { role: "user", content: prompt }],
              abort.signal,
            )) {
              controller.enqueue(enc.encode(delta));
            }
          } catch (_e) { /* end */ }
          controller.close();
        },
      });
      logLlmUsage({ workspace_id, project_id, provider: "groq", model: GROQ_MODEL, task: "chat_simple", feature: "office-ai-stream-copilot" });
      return new Response(stream, { headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } });
    }

    // -------------------------------------------------------------- CHAT
    const messages = body.messages ?? [];
    const query = lastUserText(messages);
    const grounding = await loadGrounding(admin, project_id, query, useKnowledge);
    const groundingBlock = groundingPromptBlock(grounding);

    const systemPrompt = `Tu es l'assistant d'écriture intégré à l'éditeur bureautique de FounderOS.
Tu aides à rédiger, continuer, améliorer et reformuler le document de l'utilisateur.
Réponds en markdown, dans la langue de l'utilisateur, de façon concise et directement utilisable (pas de méta-commentaire).
${groundingBlock ? `\nContexte du projet — utilise-le s'il est pertinent, n'invente rien:\n${groundingBlock}` : ""}`;

    const llmMessages = [{ role: "system", content: systemPrompt }, ...toLlmMessages(messages)];

    const abort = new AbortController();
    req.signal.addEventListener("abort", () => abort.abort());
    const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;

    const stream = new ReadableStream({
      async start(controller) {
        // AI-SDK UI message stream protocol (matches what the Plate AI plugin reads).
        controller.enqueue(sse({ type: "start" }));
        controller.enqueue(sse({ type: "start-step" }));
        controller.enqueue(sse({ type: "text-start", id: messageId }));
        try {
          for await (const delta of streamGroq(llmMessages, abort.signal)) {
            controller.enqueue(sse({ type: "text-delta", id: messageId, delta }));
          }
        } catch (_e) { /* finish anyway */ }
        controller.enqueue(sse({ type: "text-end", id: messageId }));
        controller.enqueue(sse({ type: "finish-step" }));
        controller.enqueue(sse({ type: "finish" }));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    logLlmUsage({ workspace_id, project_id, provider: "groq", model: GROQ_MODEL, task: "chat_simple", feature: "office-ai-stream-chat" });
    return new Response(stream, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  } catch (err) {
    return jsonResponse({ error: "office-ai-stream failed", detail: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
