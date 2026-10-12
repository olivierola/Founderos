// Jina AI embeddings helper. jina-embeddings-v3 → 1024-dim vectors.
// Requires JINA_API_KEY in the function secrets — except on a deployment pinned
// to a gateway (LLM_UPSTREAM=litellm or azure, see llm-upstream.ts), where the
// vectors come from its text-embedding-3 model, cut to the same 1024 dimensions
// so the pgvector columns stay as they are.

import { meterJinaTokens, type MeterScope } from "./metering.ts";
import { adaptChatBody, llmAuthHeaders, pinnedUpstream, type PinnedUpstream } from "./llm-upstream.ts";

const JINA_URL = "https://api.jina.ai/v1/embeddings";
const MODEL = "jina-embeddings-v3";

// One network attempt with a hard timeout, so a hung request can never leave an
// ingestion stuck "processing" — it aborts and surfaces an error.
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param scope  Workspace/projet à débiter. Facultatif : un appel sans scope est
 *   exécuté mais non facturé (tâche système). Le passer partout où le workspace
 *   est connu — la vectorisation est, après les LLM, le second poste de dépense.
 */
export async function embedTexts(
  texts: string[],
  task: "retrieval.query" | "retrieval.passage" = "retrieval.passage",
  scope?: MeterScope,
): Promise<number[][]> {
  const pinned = pinnedUpstream();
  if (pinned) return await embedWithUpstream(pinned, texts);
  const apiKey = Deno.env.get("JINA_API_KEY");
  if (!apiKey) throw new Error("JINA_API_KEY is not configured");
  if (texts.length === 0) return [];

  const body = JSON.stringify({ model: MODEL, task, dimensions: 1024, input: texts });

  // Retry transient failures (timeouts, 429, 5xx) a couple of times with backoff.
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt));
    let res: Response;
    try {
      res = await fetchWithTimeout(
        JINA_URL,
        { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body },
        30_000,
      );
    } catch (e) {
      lastErr = e instanceof Error && e.name === "AbortError" ? "request timed out after 30s" : String(e);
      continue; // retry network/timeout errors
    }
    if (res.ok) {
      const json = await res.json();
      const data = (json.data ?? []).sort((a: any, b: any) => a.index - b.index);
      const vectors = data.map((d: any) => d.embedding as number[]);
      if (vectors.length !== texts.length) {
        throw new Error(`Jina returned ${vectors.length} vectors for ${texts.length} inputs`);
      }
      // Métrage sur les tokens facturés par Jina, pas sur une estimation locale :
      // c'est ce nombre qui apparaîtra sur notre propre facture. Repli sur
      // ~4 caractères/token si la réponse omet `usage`.
      if (scope?.workspace_id) {
        const tokens =
          Number(json?.usage?.total_tokens ?? json?.usage?.prompt_tokens ?? 0) ||
          Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
        void meterJinaTokens({ ...scope, task: scope.task ?? task }, MODEL, tokens, {
          inputs: texts.length,
        });
      }
      return vectors;
    }
    const detail = (await res.text()).slice(0, 200);
    lastErr = `Jina ${res.status}: ${detail}`;
    // 4xx other than 429 are not retryable (bad key, quota, bad input).
    if (res.status !== 429 && res.status < 500) {
      if (res.status === 401 || res.status === 403) throw new Error(`Jina auth failed (check JINA_API_KEY): ${detail}`);
      if (res.status === 402) throw new Error(`Jina quota exhausted (402): ${detail}`);
      throw new Error(lastErr);
    }
  }
  throw new Error(`Jina embedding failed after retries — ${lastErr}`);
}

// text-embedding-3 has no query/passage distinction (Jina's `task`): the same
// vector space serves both sides. Not metered: the customer pays its gateway.
async function embedWithUpstream(up: PinnedUpstream, texts: string[]): Promise<number[][]> {
  if (!up.embeddingModel) {
    throw new Error(up.kind === "litellm"
      ? "LLM_UPSTREAM=litellm : renseignez LLM_EMBEDDING_MODEL (l'alias LiteLLM des embeddings)."
      : "LLM_UPSTREAM=azure : renseignez AZURE_OPENAI_EMBEDDING_DEPLOYMENT (text-embedding-3-small ou -large).");
  }
  if (texts.length === 0) return [];
  const url = `${up.baseUrl}/embeddings`;
  const label = up.kind === "litellm" ? "LLM gateway" : "Azure OpenAI";
  // Only the gateway's user/metadata are added here: the body has no chat field.
  const body = JSON.stringify(adaptChatBody(url, { model: up.embeddingModel, input: texts, dimensions: 1024 }));
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt));
    let res: Response;
    try {
      res = await fetchWithTimeout(
        url,
        { method: "POST", headers: { ...(await llmAuthHeaders(url, "")), "Content-Type": "application/json" }, body },
        30_000,
      );
    } catch (e) {
      lastErr = e instanceof Error && e.name === "AbortError" ? "request timed out after 30s" : String(e);
      continue;
    }
    if (res.ok) {
      const json = await res.json();
      const data = (json.data ?? []).sort((a: any, b: any) => a.index - b.index);
      const vectors = data.map((d: any) => d.embedding as number[]);
      if (vectors.length !== texts.length) {
        throw new Error(`${label} returned ${vectors.length} vectors for ${texts.length} inputs`);
      }
      return vectors;
    }
    lastErr = `${label} ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (res.status !== 429 && res.status < 500) throw new Error(lastErr);
  }
  throw new Error(`${label} embedding failed after retries — ${lastErr}`);
}

// Naive token-ish chunker: split text into ~maxChars chunks on paragraph/sentence
// boundaries. Good enough for RAG ingestion without a tokenizer dependency.
export function chunkText(text: string, maxChars = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + maxChars, clean.length);
    // Try to break on a paragraph or sentence boundary near the end.
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const lastBreak = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
      if (lastBreak > maxChars * 0.5) end = i + lastBreak + 1;
    }
    chunks.push(clean.slice(i, end).trim());
    if (end >= clean.length) break; // reached the end — done
    // Advance with overlap, but ALWAYS make forward progress. Without this guard
    // a short break point could leave `next <= i`, looping forever (→ CPU/OOM,
    // surfaced as a 546 "function failed" with no app error).
    const next = end - overlap;
    i = next > i ? next : end;
  }
  return chunks.filter(Boolean);
}

// Format a JS array as a pgvector literal string: [0.1,0.2,...]
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
