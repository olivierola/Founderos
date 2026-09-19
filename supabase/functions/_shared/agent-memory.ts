// Agent memory — how it is built, ranked and pruned.
//
// The store is `internal_agent_memories` (0038, embeddings 0103, usage 0249).
// This module holds the DECISIONS about it; the runtime does the I/O. Pure on
// purpose, like agent-context.ts: the run engine, the tool layer and the tests
// share one behaviour.
//
// Three problems it answers, all of them costs:
//
//   1. WRITE. A memory that is saved every time it is re-learnt ("le client
//      préfère les rapports courts", then "rapports courts pour ce client")
//      piles up near-duplicates. They eat the prompt budget saying the same
//      thing twice and push out what the task needed. Writes are therefore
//      deduplicated against the nearest existing memory: close enough → merge.
//   2. READ. The memory section used to be pinned + semantic top-8 + importance,
//      rendered whole, then re-ranked LEXICALLY downstream — which threw the
//      semantic order away, and a single long research digest (4 000 chars)
//      stopped the rendering loop dead and shipped an EMPTY section. Here each
//      memory becomes one bounded line, and the ranking mixes relevance,
//      importance, freshness and proven usefulness.
//   3. FULL. At 300 rows save_memory used to refuse and ask a human to prune.
//      Now the least valuable agent-written memories are evicted instead:
//      never pinned ones, never human-written ones.

export interface MemoryRow {
  id?: string;
  kind: string;
  content: string;
  importance: number;
  is_pinned: boolean;
  source?: string | null;
  /** Cosine similarity with the current task, when the row came from a vector match. */
  similarity?: number | null;
  recall_count?: number | null;
  last_recalled_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

/** Hard size of the store per agent. Past it, the least valuable row goes. */
export const MEMORY_CAP = 300;
/** Longest memory line the prompt carries. The rest is one search_memory away. */
export const MEMORY_LINE_MAX = 420;
/** At or above this cosine similarity (Jina v3), two memories say the same thing. */
export const DUP_SIMILARITY = 0.92;
/** Below this, a vector "match" is noise — Jina v3 puts unrelated FR/EN text
 *  around 0.1–0.3. Injecting it costs tokens and teaches the model nothing. */
export const RELEVANCE_FLOOR = 0.3;

const DAY = 86_400_000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

const ts = (s?: string | null): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/** Days since the memory last proved useful (recalled) or was last written. */
function ageDays(m: MemoryRow, now: number): number {
  const t = ts(m.last_recalled_at) ?? ts(m.updated_at) ?? ts(m.created_at);
  return t == null ? 30 : Math.max(0, (now - t) / DAY);
}

/** 0 → never recalled, 1 → recalled ~10 times or more. Log-saturated: the
 *  50th recall is not five times more telling than the 10th. */
function usage(m: MemoryRow): number {
  return clamp01(Math.log1p(Math.max(0, m.recall_count ?? 0)) / Math.log(11));
}

/**
 * How much a memory deserves a place in THIS prompt, in [0, 1].
 *
 * With a similarity (vector-matched against the task) relevance dominates —
 * that is the whole point of recalling against the task. Without one (the
 * static top-N, or no embeddings configured) importance and freshness decide.
 */
export function memoryScore(m: MemoryRow, now = Date.now()): number {
  const importance = clamp01(((m.importance ?? 3) - 1) / 4);
  const recency = Math.exp(-ageDays(m, now) / 45); // ~1 month half-life
  const used = usage(m);
  if (m.similarity == null) return 0.55 * importance + 0.3 * recency + 0.15 * used;
  const relevance = clamp01((m.similarity - RELEVANCE_FLOOR) / 0.45);
  return 0.6 * relevance + 0.2 * importance + 0.12 * recency + 0.08 * used;
}

/** How much a memory is worth KEEPING, independently of any task. */
export function retentionScore(m: MemoryRow, now = Date.now()): number {
  const importance = clamp01(((m.importance ?? 3) - 1) / 4);
  const recency = Math.exp(-ageDays(m, now) / 60);
  return 0.5 * importance + 0.3 * recency + 0.2 * usage(m);
}

/** Collapse whitespace so a multi-line memory stays ONE prompt line. The
 *  downstream selection splits on newlines — a digest's bullets used to arrive
 *  there as headless fragments that no longer said which memory they were. */
export function flattenMemory(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** One memory as the prompt reads it. The `[kind, pinned]` shape is load-
 *  bearing: the section selector keeps pinned lines by that marker. */
export function renderMemoryLine(m: MemoryRow, max = MEMORY_LINE_MAX): string {
  const flat = flattenMemory(m.content);
  const body = flat.length > max
    ? `${flat.slice(0, max).replace(/\s+\S*$/, "")}… (suite : search_memory)`
    : flat;
  return `- [${m.kind}${m.is_pinned ? ", pinned" : ""}] ${body}`;
}

export interface MemoryPromptSelection {
  body: string;
  /** Rows actually rendered — the caller marks them as recalled. */
  ids: string[];
  kept: number;
  dropped: number;
}

/**
 * Choose and render the memories this task gets.
 *
 * Pinned first (a human said "always"), then everything else by memoryScore.
 * Vector matches under RELEVANCE_FLOOR are dropped when the pool also carries
 * real matches — an unrelated memory is not "context", it is noise the model
 * then tries to use. A line that does not fit is skipped, not a stop: the next,
 * shorter one may.
 */
export function selectMemoriesForPrompt(
  rows: MemoryRow[],
  opts: { budget: number; now?: number },
): MemoryPromptSelection {
  const now = opts.now ?? Date.now();
  const seen = new Set<string>();
  const pool: MemoryRow[] = [];
  for (const m of rows ?? []) {
    if (!m?.content) continue;
    const key = m.id ?? flattenMemory(m.content).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(m);
  }
  if (pool.length === 0) return { body: "", ids: [], kept: 0, dropped: 0 };

  const hasMatches = pool.some((m) => (m.similarity ?? 0) >= RELEVANCE_FLOOR);
  const pinned = pool.filter((m) => m.is_pinned)
    .sort((a, b) => (b.importance ?? 3) - (a.importance ?? 3));
  const rest = pool
    .filter((m) => !m.is_pinned)
    .filter((m) => !(hasMatches && m.similarity != null && m.similarity < RELEVANCE_FLOOR))
    .map((m) => ({ m, s: memoryScore(m, now) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);

  const lines: string[] = [];
  const ids: string[] = [];
  let room = opts.budget;
  for (const m of [...pinned, ...rest]) {
    const line = renderMemoryLine(m);
    if (line.length + 1 > room) continue;
    lines.push(line);
    if (m.id) ids.push(m.id);
    room -= line.length + 1;
  }
  return { body: lines.join("\n"), ids, kept: lines.length, dropped: pool.length - lines.length };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type MemoryWritePlan =
  | { action: "insert" }
  | { action: "skip"; id: string; reason: string }
  | { action: "merge"; id: string; content: string; importance: number };

const norm = (s: string) =>
  flattenMemory(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, "");

/**
 * Decide what a new memory does to the store, given its nearest neighbour.
 *
 *   • nothing close           → insert
 *   • same text               → skip (it is already known)
 *   • close, human-written    → skip: an agent must not rephrase what a person
 *                                wrote into the Memory tab
 *   • close, agent-written    → merge: the newer statement wins (it is the
 *                                sharper, more current one) unless it is only a
 *                                fragment of the existing text; importance is
 *                                the max of the two
 */
export function planMemoryWrite(
  candidate: { content: string; importance: number },
  nearest: (MemoryRow & { id: string; similarity: number }) | null,
): MemoryWritePlan {
  if (!nearest) return { action: "insert" };
  const a = norm(candidate.content);
  const b = norm(nearest.content);
  if (a === b) return { action: "skip", id: nearest.id, reason: "identique" };
  if ((nearest.similarity ?? 0) < DUP_SIMILARITY) return { action: "insert" };
  if (nearest.source === "user") return { action: "skip", id: nearest.id, reason: "déjà écrit par l'équipe" };
  const importance = Math.max(candidate.importance ?? 3, nearest.importance ?? 3);
  const content = b.includes(a) ? nearest.content : candidate.content;
  return { action: "merge", id: nearest.id, content, importance };
}

/**
 * Which rows to delete to make room for `count` new ones. Pinned and
 * human-written memories are never candidates: someone decided they matter.
 * Returns fewer ids than asked when the store holds nothing evictable.
 */
export function pickEvictions(rows: MemoryRow[], count: number, now = Date.now()): string[] {
  if (count <= 0) return [];
  return (rows ?? [])
    .filter((m) => m.id && !m.is_pinned && m.source !== "user")
    .map((m) => ({ id: m.id!, s: retentionScore(m, now) }))
    .sort((x, y) => x.s - y.s)
    .slice(0, count)
    .map((x) => x.id);
}
