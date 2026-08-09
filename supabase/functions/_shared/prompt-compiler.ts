// Prompt compiler — the single place that decides WHAT the model sees.
//
// Before this module, every caller (agent chat, mission tick, room turn,
// sub-agent) hand-assembled its own system prompt by string concatenation and
// sent EVERY tool schema on EVERY round. Two costs followed from that:
//
//   1. SIZE. Memory, team memory, recent work, the skill index and the toolbox
//      were injected whole, whether or not the current task had anything to do
//      with them. A 40-tool agent re-sent ~12k tokens of JSON schema per round.
//   2. SHAPE. Sections landed in whatever order the caller wrote them, so the
//      model got knowledge before it got its identity, and the volatile parts
//      (memory, selected tools) sat in the MIDDLE of the prefix — which
//      invalidates the provider's prompt cache for everything after them on
//      every single tick.
//
// The compiler fixes both:
//
//   • CHRONOLOGICAL, CANONICAL ORDER. Sections are emitted in one fixed order,
//     from the most stable to the most volatile: identity → doctrine → rules →
//     toolbox → knowledge → the task's own context. A run's prefix therefore
//     stays byte-identical across ticks up to the first volatile section, so
//     provider prefix caching keeps working.
//   • RELEVANCE SELECTION. Memories, team memories, past work and skills are
//     SCORED against the current task and only the top ones survive, under a
//     per-section char budget. Nothing relevant is lost — everything else stays
//     reachable through search_memory / search_context, which the rules say.
//   • TOOL SELECTION. The same scoring picks the tool SCHEMAS worth sending
//     this round. Core tools (plan/ask/deliver/load) and anything the plan named
//     are pinned; the rest compete for a schema budget. The toolbox INDEX in the
//     system prompt still lists every tool by name, so the model always knows
//     what exists and can pull a family in with load_toolset.
//   • A BUDGET REPORT, traced as a `prompt` run event: what each section cost,
//     what was dropped, how many schemas were sent. Auditable, so a regression
//     in context size is visible instead of silent.
//
// Everything degrades safely: with no task text, selection falls back to
// importance/recency order and the full toolset — exactly the old behaviour.

import type { ChatMessage, ToolDef } from "./ai.ts";

// ---------------------------------------------------------------------------
// Deterministic hashing
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit, hex. Deterministic and dependency-free — used to fingerprint
 *  prompt sections / prefixes so we can tell whether a span is byte-identical
 *  to what a previous tick sent (provider cache hit) or not. NOT cryptographic:
 *  collision resistance is irrelevant here, only stability. */
export function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Lexical relevance
// ---------------------------------------------------------------------------

/** FR/EN stopwords — they match everything, so they must score nothing. */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "you", "your", "are", "was", "will", "have", "has",
  "les", "des", "une", "un", "de", "du", "la", "le", "et", "en", "pour", "avec", "que", "qui", "dans",
  "sur", "par", "au", "aux", "ce", "cette", "ces", "est", "sont", "plus", "tout", "tous", "toute",
  "faire", "fait", "peut", "doit", "son", "sa", "ses", "nos", "vos", "leur", "leurs", "il", "elle",
  "nous", "vous", "ils", "elles", "on", "je", "tu", "me", "te", "se", "ne", "pas", "ou", "où", "mais",
  "donc", "car", "comme", "aussi", "alors", "bien", "très", "sans", "sous", "entre", "vers", "chez",
]);

/** Tokenize for scoring: lowercase, accent-folded, ≥3 chars, no stopwords. */
export function tokenize(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Query terms with a saturating weight: a term repeated in the task counts
 *  more, but not linearly (a 20× repetition must not drown the rest). */
function queryTerms(task: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tokenize(task).slice(0, 400)) out.set(t, (out.get(t) ?? 0) + 1);
  for (const [k, v] of out) out.set(k, 1 + Math.log(v));
  return out;
}

/**
 * Score one candidate text against the task. Deliberately lexical: it runs in
 * microseconds, costs nothing, and needs no network — the semantic layer
 * (pgvector recall on memories) already exists upstream and composes with this
 * as a pre-ranking, not a replacement.
 *
 * Score = Σ (query weight × candidate term frequency, saturated) / √len, plus a
 * bonus for exact multi-word phrases, normalised to roughly [0, 1].
 */
export function relevanceScore(candidate: string, terms: Map<string, number>, task?: string): number {
  if (terms.size === 0) return 0;
  const words = tokenize(candidate);
  if (words.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
  let score = 0;
  for (const [term, qw] of terms) {
    const f = tf.get(term);
    if (!f) continue;
    // Saturating tf (BM25-ish k1=1.2): the 5th occurrence adds much less than
    // the 1st, so a long doc that repeats one word can't outrank a precise one.
    score += qw * ((f * 2.2) / (f + 1.2));
  }
  if (score === 0) return 0;
  // Length normalisation: long candidates would otherwise win on volume alone.
  let norm = score / Math.sqrt(words.length);
  // Phrase bonus: an exact 2-word sequence of the task inside the candidate is
  // much stronger evidence than the two words apart.
  if (task) {
    const hay = candidate.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const qw = tokenize(task);
    for (let i = 0; i + 1 < Math.min(qw.length, 60); i++) {
      if (hay.includes(`${qw[i]} ${qw[i + 1]}`)) { norm *= 1.35; break; }
    }
  }
  return norm;
}

export interface SelectOptions<T> {
  /** The current task/user request; empty → no reordering, budget only. */
  task: string;
  /** Text of an item used for scoring. */
  text: (item: T) => string;
  /** Items with pin() true are always kept, first, whatever they score. */
  pin?: (item: T) => boolean;
  /** Char budget for the rendered selection. */
  budget: number;
  /** Rendered size of an item (defaults to text length + 3). */
  size?: (item: T) => number;
  /** Hard cap on the number of items. */
  max?: number;
  /** Items scoring below this fraction of the best score are dropped even if
   *  budget remains — irrelevant filler is worse than empty space. */
  floor?: number;
}

export interface Selection<T> {
  kept: T[];
  dropped: number;
  chars: number;
}

/**
 * Pick the items worth spending prompt budget on. Pinned items first (in their
 * incoming order — the caller already ranked them), then the rest by relevance
 * to the task, stopping at the budget / cap / relevance floor.
 */
export function selectRelevant<T>(items: T[], opts: SelectOptions<T>): Selection<T> {
  const sizeOf = opts.size ?? ((i: T) => opts.text(i).length + 3);
  const list = items ?? [];
  if (list.length === 0) return { kept: [], dropped: 0, chars: 0 };

  const pinned = opts.pin ? list.filter(opts.pin) : [];
  const rest = opts.pin ? list.filter((i) => !opts.pin!(i)) : [...list];

  const terms = queryTerms(opts.task);
  const ranked = terms.size
    ? rest
        .map((item) => ({ item, score: relevanceScore(opts.text(item), terms, opts.task) }))
        .sort((a, b) => b.score - a.score)
    : rest.map((item) => ({ item, score: 1 })); // no task → keep incoming order

  const best = ranked[0]?.score ?? 0;
  const floor = opts.floor != null && best > 0 ? best * opts.floor : 0;

  const kept: T[] = [];
  let chars = 0;
  const take = (item: T): boolean => {
    const s = sizeOf(item);
    if (chars + s > opts.budget) return false;
    if (opts.max != null && kept.length >= opts.max) return false;
    kept.push(item);
    chars += s;
    return true;
  };
  for (const p of pinned) take(p);
  for (const { item, score } of ranked) {
    // A zero score with a live query means "no term in common" — the item has
    // nothing to do with this task. Keep a couple anyway when the query matched
    // nothing at all (best === 0), otherwise the section would go empty.
    if (best > 0 && score < floor) break;
    if (!take(item)) break;
  }
  return { kept, dropped: list.length - kept.length, chars };
}

// ---------------------------------------------------------------------------
// Tool selection
// ---------------------------------------------------------------------------

export interface ToolSelectOptions {
  /** The current task/focus text used to rank tools. */
  task: string;
  /** Names always sent, whatever they score (plan/ask/deliver/load_toolset…). */
  keep?: Iterable<string>;
  /** Char budget for the serialized schemas. 0 / undefined → no budget cut. */
  budget?: number;
  /** Hard cap on the number of schemas sent. */
  max?: number;
  /** Below this many tools, selection is a no-op (the whole set is cheap). */
  floorCount?: number;
}

export interface ToolSelection {
  defs: ToolDef[];
  /** Names present in the toolbox but not sent this round. */
  omitted: string[];
  chars: number;
}

const defChars = (d: ToolDef) => JSON.stringify(d).length;

/**
 * Choose the tool SCHEMAS for one round.
 *
 * The system prompt's toolbox index still lists every tool, and load_toolset /
 * need_tools widen the set mid-turn, so omitting a schema never removes a
 * capability — it only defers its cost. That is why this can be aggressive:
 * the failure mode is one extra round, not a blocked agent.
 *
 * Ranking uses the tool's name AND description against the task, with the name
 * weighted heavily (a task saying "envoie un mail" must surface `send_email`
 * even when its description shares no other word).
 */
export function selectTools(defs: ToolDef[], opts: ToolSelectOptions): ToolSelection {
  const all = defs ?? [];
  const floorCount = opts.floorCount ?? 12;
  if (all.length <= floorCount) return { defs: all, omitted: [], chars: all.reduce((n, d) => n + defChars(d), 0) };

  const keep = new Set(opts.keep ?? []);
  const terms = queryTerms(opts.task);
  const pinned: ToolDef[] = [];
  const scored: Array<{ def: ToolDef; score: number }> = [];

  for (const d of all) {
    const name = d.function?.name ?? "";
    if (keep.has(name)) { pinned.push(d); continue; }
    if (terms.size === 0) { scored.push({ def: d, score: 1 }); continue; }
    // The NAME is the strongest signal a tool matches an intent — weight it 3×.
    // Names are snake_case, so split them into words before scoring.
    const nameText = name.replace(/_/g, " ");
    const score =
      relevanceScore(nameText, terms, opts.task) * 3 +
      relevanceScore(d.function?.description ?? "", terms, opts.task);
    scored.push({ def: d, score });
  }
  if (terms.size) scored.sort((a, b) => b.score - a.score);

  const out: ToolDef[] = [];
  let chars = 0;
  const budget = opts.budget && opts.budget > 0 ? opts.budget : Infinity;
  const max = opts.max ?? Infinity;
  // Pinned tools bypass the budget: they are what lets the agent plan, ask,
  // deliver and widen its own toolbox. Cutting them to save characters would
  // strand the run.
  for (const d of pinned) { out.push(d); chars += defChars(d); }
  for (const { def, score } of scored) {
    if (out.length >= max) break;
    const c = defChars(def);
    if (chars + c > budget) continue; // a big schema skipped ≠ stop: a small one may still fit
    // A tool with zero lexical overlap is still worth sending while budget
    // remains — the model knows its own toolbox better than this heuristic —
    // but it goes last, so it is the first thing dropped when space runs out.
    void score;
    out.push(def);
    chars += c;
  }
  const sent = new Set(out.map((d) => d.function?.name));
  return { defs: out, omitted: all.map((d) => d.function?.name).filter((n) => n && !sent.has(n)) as string[], chars };
}

// ---------------------------------------------------------------------------
// Section assembly
// ---------------------------------------------------------------------------

/** One block of the system prompt. Order in SECTION_ORDER is what ships. */
export type SectionId =
  | "identity"      // who you are — never changes for a run
  | "instructions"  // the owner's authored instructions
  | "doctrine"      // role doctrine (orchestrator, security…)
  | "presence"      // conversational conduct (chat only)
  | "rules"         // operating rules — the loop contract
  | "toolbox"       // the capability index (names, families, load rules)
  | "skills"        // activated-skill index (progressive disclosure)
  | "memory"        // this agent's durable memory, task-selected
  | "team_memory"   // shared team knowledge, task-selected
  | "recent_work"   // what this agent just did, task-selected
  | "context";      // free-form caller context (room thread, mission brief…)

/** Stable → volatile. Everything above `memory` is byte-identical across the
 *  ticks of one run, which is exactly what a provider prefix cache needs. */
const SECTION_ORDER: SectionId[] = [
  "identity", "instructions", "doctrine", "presence", "rules",
  "toolbox", "skills", "memory", "team_memory", "recent_work", "context",
];

const SECTION_HEADING: Partial<Record<SectionId, string>> = {
  doctrine: "",
  presence: "",
  rules: "## Operating rules",
  toolbox: "",
  skills: "## Activated skills (your specialised playbooks)\nThese skills are activated for you. They are NOT loaded yet — when a step needs one, call use_skill(<slug>) to pull its full playbook into context, then apply it. Plan which skill each step needs.",
  memory: "## Your persistent memory (carried over from previous sessions — selected for this task)",
  team_memory: "## Shared TEAM memory (contributed by you and your teammates — selected for this task)",
  recent_work: "## Your recent work (latest runs — you already did this; build on it, don't redo it)",
  context: "## Context for this turn",
};

export interface SectionInput {
  id: SectionId;
  /** Ready-rendered body. Empty/blank sections are skipped entirely. */
  body: string;
  /** Chars spent vs. offered, for the budget report. */
  dropped?: number;
  offered?: number;
}

export interface PromptBudget {
  total: number;
  sections: Array<{ id: SectionId; chars: number; dropped: number; offered: number; hash: string }>;
  tools: { sent: number; omitted: number; chars: number };
  /** FNV-1a hash of the STABLE sections (identity…skills). Same across ticks
   *  means the provider prefix cache is expected to hit. */
  prefix_hash: string;
}

export interface CompiledPrompt {
  system: string;
  budget: PromptBudget;
}

/**
 * Render the system prompt. Callers hand in already-rendered section bodies
 * (they own the wording); the compiler owns the ORDER, the headings, the blank
 * lines and the accounting. Sections may arrive in any order.
 */
export function compileSystemPrompt(
  sections: SectionInput[],
  toolStats: { sent: number; omitted: number; chars: number } = { sent: 0, omitted: 0, chars: 0 },
): CompiledPrompt {
  const byId = new Map<SectionId, SectionInput>();
  for (const s of sections) {
    if (!s?.body || !s.body.trim()) continue;
    const prev = byId.get(s.id);
    // Two inputs for one section concatenate rather than overwrite — callers
    // sometimes build doctrine from several sources.
    byId.set(s.id, prev ? { ...s, body: `${prev.body}\n${s.body}` } : s);
  }
  const out: string[] = [];
  const report: PromptBudget["sections"] = [];
  // Stable-prefix accumulation: everything up to the first volatile section
  // (`memory` and beyond are task-selected and can move between ticks) is
  // byte-identical across the ticks of one run — that span is exactly what a
  // provider prefix cache can reuse. We hash the RENDERED bytes so a single
  // changed character anywhere upstream is caught.
  const stableEndIdx = SECTION_ORDER.indexOf("memory");
  let stableLines = -1; // out[] index where the volatile sections start
  for (let i = 0; i < SECTION_ORDER.length; i++) {
    const id = SECTION_ORDER[i];
    const s = byId.get(id);
    if (!s) continue;
    const heading = SECTION_HEADING[id];
    if (heading) out.push("", heading);
    else if (out.length) out.push("");
    const body = s.body.trim();
    const hash = stableHash(heading ? `\n${heading}\n${body}` : `\n${body}`);
    if (i === stableEndIdx && stableLines === -1) stableLines = out.length;
    out.push(body);
    report.push({ id, chars: s.body.length, dropped: s.dropped ?? 0, offered: s.offered ?? s.body.length, hash });
  }
  const system = out.join("\n").trim();
  const prefixBuf = stableLines >= 0 ? out.slice(0, stableLines).join("\n") : system;
  return {
    system,
    budget: {
      total: system.length,
      sections: report,
      tools: toolStats,
      prefix_hash: stableHash(prefixBuf),
    },
  };
}

// ---------------------------------------------------------------------------
// Message assembly
// ---------------------------------------------------------------------------

export interface CompileMessagesInput {
  system: string;
  /** The durable transcript, already compacted/sanitised by the caller. */
  history: ChatMessage[];
  /** Appended at SEND time, never persisted (FOCUS header, live signals). */
  ephemeral?: ChatMessage[];
}

/**
 * Guarantee the chronological shape the model expects: exactly one system
 * message, first; then the transcript in order; then the ephemeral tail. A
 * stray system message deeper in the transcript (a legacy state, a resumed run
 * written by an older build) is folded back into the head instead of confusing
 * the ordering.
 */
export function compileMessages(input: CompileMessagesInput): ChatMessage[] {
  const extras: string[] = [];
  const body: ChatMessage[] = [];
  for (const m of input.history ?? []) {
    if (m.role === "system") { if (m.content) extras.push(String(m.content)); continue; }
    body.push(m);
  }
  const system = extras.length ? `${input.system}\n\n${extras.join("\n\n")}` : input.system;
  return [{ role: "system", content: system }, ...body, ...(input.ephemeral ?? [])];
}

// ---------------------------------------------------------------------------
// Task extraction
// ---------------------------------------------------------------------------

/**
 * What is this run actually about, right now? Selection is only as good as the
 * query it runs against, and the naive answer ("the first user message") goes
 * stale the moment a conversation moves on.
 *
 * The current task = the most recent user intent (last two real user messages,
 * skipping the compiler's own injected markers) plus the active checklist item
 * when there is one. Bounded, because it is only ever used as a bag of words.
 */
export function currentTaskText(
  messages: ChatMessage[],
  extra?: { goal?: string | null; activeStep?: string | null },
): string {
  const parts: string[] = [];
  if (extra?.goal) parts.push(extra.goal);
  if (extra?.activeStep) parts.push(extra.activeStep);
  let taken = 0;
  for (let i = (messages?.length ?? 0) - 1; i >= 0 && taken < 2; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = String(m.content ?? "");
    // Skip our own injected scaffolding — it is boilerplate, and scoring
    // against it would make every task look like every other task. Sealed-segment
    // markers match on their ASCII head so both properly-encoded and older
    // double-encoded in-flight markers are skipped.
    if (/^\[(FOCUS|Segment scell|Historique|CONTEXT|The user sent this)/.test(text)) continue;
    parts.push(text.slice(0, 2000));
    taken++;
  }
  return parts.join("\n").slice(0, 4000);
}

/** Compact, human-readable trace of what the compiler spent. Logged as a
 *  `prompt` run event so context growth is auditable in the timeline.
 *
 *  When `prevPrefixHash` is given, `cache_expected` tells whether the stable
 *  prefix sent this tick is byte-identical to the previous tick's — i.e. the
 *  provider's prefix cache should have hit. A run that emits
 *  cache_expected=false while its stable sections (identity…rules) did not
 *  change is a cache-thrashing regression worth investigating. */
export function budgetEventPayload(b: PromptBudget, prevPrefixHash?: string | null): Record<string, unknown> {
  return {
    system_chars: b.total,
    prefix_hash: b.prefix_hash,
    cache_expected: prevPrefixHash != null && prevPrefixHash === b.prefix_hash,
    sections: b.sections
      .filter((s) => s.dropped > 0 || s.chars > 0)
      .map((s) => ({ id: s.id, chars: s.chars, dropped: s.dropped, hash: s.hash })),
    tools: b.tools,
  };
}

/**
 * Hash of the byte-identical transcript prefix actually sent to the provider:
 * `[system][head][sealed zone]`, where the sealed zone is the contiguous run of
 * compaction markers sitting right after the head (see the append-only seal in
 * the runtime). Everything after it is the live window, which legitimately
 * grows between ticks — so `cache_expected` for a tick is simply
 * `transcriptPrefixHash(this) === transcriptPrefixHash(previous)`.
 *
 * `sealedPrefix` must be the ASCII head of a compaction marker (e.g. the
 * runtime's SEALED_PREFIX). `headLen` mirrors the runtime's keepHead.
 */
export function transcriptPrefixHash(
  messages: ChatMessage[],
  sealedPrefix: string,
  headLen = 2,
): string {
  const keepHead = Math.min(headLen, messages.length);
  let sealEnd = keepHead;
  while (
    sealEnd < messages.length &&
    messages[sealEnd].role === "user" &&
    String(messages[sealEnd].content ?? "").startsWith(sealedPrefix)
  ) sealEnd++;
  return stableHash(JSON.stringify(messages.slice(0, sealEnd)));
}
