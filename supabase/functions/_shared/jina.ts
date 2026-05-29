// Jina AI embeddings helper. jina-embeddings-v3 → 1024-dim vectors.
// Requires JINA_API_KEY in the function secrets.

const JINA_URL = "https://api.jina.ai/v1/embeddings";
const MODEL = "jina-embeddings-v3";

export async function embedTexts(
  texts: string[],
  task: "retrieval.query" | "retrieval.passage" = "retrieval.passage",
): Promise<number[][]> {
  const apiKey = Deno.env.get("JINA_API_KEY");
  if (!apiKey) throw new Error("JINA_API_KEY is not configured");
  if (texts.length === 0) return [];

  const res = await fetch(JINA_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      task,
      dimensions: 1024,
      input: texts,
    }),
  });
  if (!res.ok) {
    throw new Error(`Jina ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  // Sort by index to keep alignment with the input order.
  const data = (json.data ?? []).sort((a: any, b: any) => a.index - b.index);
  return data.map((d: any) => d.embedding as number[]);
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
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks.filter(Boolean);
}

// Format a JS array as a pgvector literal string: [0.1,0.2,...]
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
