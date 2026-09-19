// Agent context — the three files an agent is written in, and the selection
// that decides which parts of them a given task actually gets to see.
//
// The three files (see migration 0210):
//
//   instructions — WHAT the agent does: its procedure, its absolute rules.
//                  Human-written, always sent whole.
//   soul         — WHO it is: character, voice, values, what it won't trade.
//                  Human-written, short, stable, always sent whole.
//   preferences  — HOW its user likes things. Written by the human AND by the
//                  agent itself (remember_preference), one preference per
//                  line, SELECTED against the task at hand.
//
// Why selection at all: a prompt is not free, and relevance beats volume. An
// agent with thirty preferences and a dozen skills that ships all of them on
// every request spends its context on things the current task has nothing to
// do with — and buries the two lines that matter. So preferences and skills
// are scored against the task, and only what earns its place is sent. Nothing
// is lost: what is left out stays one `use_skill` / `list_skills` call away,
// and the pinned preferences (`- ![sujet] …`) never compete at all.
//
// Everything here is PURE: no I/O, no client, no Deno API. That is what lets
// the run engine, the room turn and the tests all share one behaviour.

import { relevanceScore, selectRelevant, tokenize } from "./prompt-compiler.ts";

// ---------------------------------------------------------------------------
// The preferences file
// ---------------------------------------------------------------------------

export interface Preference {
  /** Short free tag ("langue", "format", "outils"…), or null. */
  topic: string | null;
  text: string;
  /** `- !` prefix: sent on EVERY task, never subject to selection. */
  always: boolean;
}

/** Hard stops. A preferences file is a working memory, not an archive: past
 *  these the agent must replace or drop something rather than pile on. */
export const PREFERENCES_MAX_ENTRIES = 120;
export const PREFERENCES_MAX_CHARS = 12000;
export const PREFERENCE_MAX_TEXT = 400;

const BULLET = /^[-*•]\s*(!)?\s*(?:\[([^\]]{1,40})\]\s*)?(.*\S)\s*$/;

/** Fold to a comparison key: lowercase, accent-free, punctuation-free. Two
 *  preferences with the same key are the same preference, however written. */
export function preferenceKey(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Read the file. Tolerant on purpose — a human editing this by hand writes
 * plain lines, not a grammar. Bullets carry the optional `!` flag and `[topic]`
 * tag; any other non-empty, non-heading line is still a preference, untagged.
 */
export function parsePreferences(file: string | null | undefined): Preference[] {
  const out: Preference[] = [];
  for (const raw of String(file ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(">")) continue;
    const m = BULLET.exec(line);
    if (m) {
      const text = m[3].trim();
      if (text) out.push({ always: !!m[1], topic: (m[2] ?? "").trim() || null, text });
      continue;
    }
    out.push({ always: false, topic: null, text: line });
  }
  return out;
}

export function preferenceLine(p: Preference): string {
  return `- ${p.always ? "!" : ""}${p.topic ? `[${p.topic}] ` : ""}${p.text}`;
}

export function renderPreferences(prefs: Preference[]): string {
  return prefs.map(preferenceLine).join("\n");
}

export type PreferenceWrite =
  | { status: "added" | "updated" | "unchanged"; file: string; entry: Preference; previous?: Preference }
  | { status: "full"; file: string; reason: string };

/**
 * Add a preference, or update the one it supersedes.
 *
 * "Supersedes" is deliberately generous: the same normalised text, or the same
 * topic where one text contains the other ("réponses en français" →
 * "réponses en français, jamais en anglais"). An agent that learns a sharper
 * version of something it already knew must REPLACE it — a file that grows a
 * near-duplicate every time the user restates a habit stops being readable,
 * and the selection below would then spend its budget on the same idea twice.
 */
export function upsertPreference(
  file: string | null | undefined,
  entry: { text: string; topic?: string | null; always?: boolean; replaces?: string | null },
): PreferenceWrite {
  const text = String(entry.text ?? "").trim().replace(/\s+/g, " ").slice(0, PREFERENCE_MAX_TEXT);
  const topic = (entry.topic ?? "").trim().slice(0, 40).replace(/[[\]]/g, "") || null;
  const always = entry.always === true;
  const next: Preference = { text, topic, always };
  const prefs = parsePreferences(file);

  const key = preferenceKey(text);
  const replacesKey = entry.replaces ? preferenceKey(entry.replaces) : "";
  const supersedes = (p: Preference): boolean => {
    const pk = preferenceKey(p.text);
    if (replacesKey && pk === replacesKey) return true;
    if (pk === key) return true;
    // Same subject, one phrasing swallowing the other.
    if (topic && p.topic && preferenceKey(p.topic) === preferenceKey(topic)) {
      return pk.includes(key) || key.includes(pk);
    }
    return false;
  };

  const at = prefs.findIndex(supersedes);
  if (at >= 0) {
    const previous = prefs[at];
    if (previous.text === text && previous.topic === topic && previous.always === always) {
      return { status: "unchanged", file: renderPreferences(prefs), entry: previous };
    }
    prefs[at] = next;
    return { status: "updated", file: renderPreferences(prefs), entry: next, previous };
  }

  if (prefs.length >= PREFERENCES_MAX_ENTRIES) {
    return {
      status: "full",
      file: renderPreferences(prefs),
      reason: `le fichier de préférences est plein (${prefs.length} entrées)`,
    };
  }
  prefs.push(next);
  const rendered = renderPreferences(prefs);
  if (rendered.length > PREFERENCES_MAX_CHARS) {
    return {
      status: "full",
      file: renderPreferences(prefs.slice(0, -1)),
      reason: `le fichier de préférences atteint sa taille maximale (${PREFERENCES_MAX_CHARS} caractères)`,
    };
  }
  return { status: "added", file: rendered, entry: next };
}

/** Drop the preference matching `text` (same normalised key, or a unique
 *  containment match). Returns the file unchanged when nothing matched. */
export function removePreference(
  file: string | null | undefined,
  text: string,
): { file: string; removed: Preference | null } {
  const prefs = parsePreferences(file);
  const key = preferenceKey(text);
  if (!key) return { file: renderPreferences(prefs), removed: null };
  let at = prefs.findIndex((p) => preferenceKey(p.text) === key);
  if (at < 0) {
    const hits = prefs.filter((p) => preferenceKey(p.text).includes(key));
    // Only when it is unambiguous: removing "the one that contains 'rapport'"
    // out of four candidates would silently delete the wrong preference.
    if (hits.length === 1) at = prefs.indexOf(hits[0]);
  }
  if (at < 0) return { file: renderPreferences(prefs), removed: null };
  const [removed] = prefs.splice(at, 1);
  return { file: renderPreferences(prefs), removed };
}

export interface PreferenceSelection {
  /** Rendered block, ready to push as a prompt section. Empty when nothing. */
  body: string;
  kept: Preference[];
  dropped: number;
  offered: number;
}

/**
 * How many of the NEWEST preferences ride along whatever the task is.
 *
 * Without this, the most embarrassing failure mode in the whole feature: the
 * user says "arrête les emoji", the agent dutifully records it, and on the very
 * next round the selection drops it — "emoji" shares no word with "audit SEO" —
 * so the agent carries on with emoji in front of the person who just asked it
 * to stop. Lexical relevance cannot see that a preference stated ten seconds
 * ago is about THIS conversation. Recency can, and the file is append-ordered,
 * so its tail is exactly the recent end.
 */
export const PREFERENCES_KEEP_RECENT = 3;

/**
 * The preferences this task is entitled to: the pinned ones and the freshest
 * ones (always), then the ones whose words meet the task's, under a budget.
 *
 * With no task text (a cold sub-agent, a scheduled tick before its brief is
 * known) selection cannot mean anything, so the whole file goes — the previous
 * behaviour, and the safe one.
 */
export function selectPreferences(
  file: string | null | undefined,
  task: string,
  budget: number,
  opts: { recent?: number } = {},
): PreferenceSelection {
  const prefs = parsePreferences(file);
  if (prefs.length === 0) return { body: "", kept: [], dropped: 0, offered: 0 };
  const offered = renderPreferences(prefs).length;
  if (!task || offered <= budget) {
    return { body: renderPreferences(prefs), kept: prefs, dropped: 0, offered };
  }
  const size = (p: Preference) => preferenceLine(p).length + 1;
  const recent = Math.max(0, opts.recent ?? PREFERENCES_KEEP_RECENT);
  const freshest = recent > 0 ? prefs.slice(-recent) : [];

  // Recency gets a RESERVE, not a pin. Pinning the newest three outright let
  // them crowd out the preference the task was actually about, which is the
  // opposite trade: at a tight budget the on-topic line matters more than the
  // third-newest one. A capped reserve keeps the just-learned preference alive
  // without ever eating the whole section.
  const reserve = Math.min(
    Math.floor(budget * 0.3),
    freshest.reduce((n, p) => n + size(p), 0),
  );

  const sel = selectRelevant(prefs, {
    task,
    text: (p) => `${p.topic ?? ""} ${p.text}`,
    pin: (p) => p.always,
    budget: Math.max(0, budget - reserve),
    size,
    // Preferences are short and cheap; a low floor keeps a loosely-related one
    // rather than dropping it, because a preference the user stated and the
    // agent then ignores reads as the agent forgetting.
    floor: 0.05,
  });

  const kept = new Set(sel.kept);
  let room = budget - sel.chars;
  for (let i = freshest.length - 1; i >= 0; i--) { // newest first
    const p = freshest[i];
    if (kept.has(p) || size(p) > room) continue;
    kept.add(p);
    room -= size(p);
  }
  // The selection reorders (pinned first); the FILE's order is what the human
  // wrote and what "the newest are last" means, so restore it before rendering.
  const ordered = prefs.filter((p) => kept.has(p));
  return { body: renderPreferences(ordered), kept: ordered, dropped: prefs.length - ordered.length, offered };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillLike {
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
  /** The full playbook (SKILL.md body) — only ever inlined for a decisive match. */
  instructions?: string | null;
  files?: Array<{ path: string }> | null;
}

export interface SkillSelection {
  /** Skills worth naming in the index this round, best first. */
  index: SkillLike[];
  /** The one skill whose playbook is inlined, when the task points at it
   *  unambiguously — otherwise null and the agent calls use_skill itself. */
  preload: SkillLike | null;
  /** Skills not named in the index (still reachable via list_skills). */
  dropped: number;
  /** Rendered block, ready to push as a prompt section. */
  body: string;
}

export interface SkillSelectOptions {
  /** How many skills the index may name. */
  max?: number;
  /** Char budget for the index. */
  budget?: number;
  /** Below this many activated skills, everything is named (the index is cheap
   *  and a short list is its own summary). */
  floorCount?: number;
  /** Largest playbook worth inlining up-front. */
  preloadMaxChars?: number;
  /** Inline the winner only when it beats the runner-up by this factor. */
  dominance?: number;
}

/** Score a skill against the task. The NAME and the SLUG say what it is far
 *  more sharply than its description, so they weigh more — same reasoning as
 *  tool selection, where `send_email` must win on "envoie un mail". */
function skillScore(s: SkillLike, task: string, terms: Map<string, number>): number {
  const name = `${s.name} ${s.slug.replace(/[-_]/g, " ")}`;
  return relevanceScore(name, terms, task) * 3
    + relevanceScore(s.description ?? "", terms, task)
    + relevanceScore(s.category ?? "", terms, task) * 0.5;
}

function queryTermsOf(task: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tokenize(task).slice(0, 400)) out.set(t, (out.get(t) ?? 0) + 1);
  for (const [k, v] of out) out.set(k, 1 + Math.log(v));
  return out;
}

/**
 * Pick the skills this task should see.
 *
 * The old behaviour sent the whole activated-skill index on every request and
 * left the agent to call use_skill. That is cheap with three skills and absurd
 * with thirty — and it makes the model choose from a list where nothing points
 * at the current task. Here the list is RANKED and TRIMMED against the task,
 * and when one skill matches decisively its playbook rides along, so the agent
 * applies it on the same round instead of spending a call to fetch it.
 *
 * A skill that is not named is not lost: `list_skills` returns the full roster
 * and `use_skill` takes any slug, named or not.
 */
export function selectSkills(
  skills: SkillLike[],
  task: string,
  opts: SkillSelectOptions = {},
): SkillSelection {
  const all = (skills ?? []).filter((s) => s && s.slug);
  const max = opts.max ?? 6;
  const budget = opts.budget ?? 1400;
  const floorCount = opts.floorCount ?? 4;
  const preloadMax = opts.preloadMaxChars ?? 4000;
  const dominance = opts.dominance ?? 1.5;

  if (all.length === 0) return { index: [], preload: null, dropped: 0, body: "" };

  const terms = task ? queryTermsOf(task) : new Map<string, number>();
  const ranked = terms.size
    ? all.map((s) => ({ s, score: skillScore(s, task, terms) })).sort((a, b) => b.score - a.score)
    : all.map((s) => ({ s, score: 0 }));

  // Few enough skills: naming them all IS the short answer.
  const keepAll = all.length <= floorCount || terms.size === 0;
  let index: SkillLike[] = [];
  if (keepAll) {
    index = ranked.map((r) => r.s);
  } else {
    let chars = 0;
    for (const { s, score } of ranked) {
      const line = indexLine(s).length + 1;
      // A skill sharing no word with the task is noise this round — but keep a
      // couple when NOTHING matched, so the section never goes silently empty.
      if (score <= 0 && index.length >= 2) break;
      if (index.length >= max || chars + line > budget) break;
      index.push(s);
      chars += line;
    }
    if (index.length === 0) index = ranked.slice(0, 2).map((r) => r.s);
  }

  // Decisive match → the playbook rides along. "Decisive" is relative, not
  // absolute: a lexical score has no meaningful scale, but a winner that
  // doubles the runner-up is a winner whatever the scale.
  const best = ranked[0];
  const second = ranked[1]?.score ?? 0;
  const body = (best?.s.instructions ?? "").trim();
  const preload = best && best.score > 0 && body.length > 0 && body.length <= preloadMax
    && (second <= 0 || best.score >= second * dominance)
    ? best.s
    : null;

  return { index, preload, dropped: all.length - index.length, body: renderSkillSection(index, preload, all.length) };
}

function indexLine(s: SkillLike): string {
  return `- ${s.name} (${s.slug})${s.category ? ` [${s.category}]` : ""}${s.description ? `: ${s.description}` : ""}`;
}

/** The skills block as the model reads it: what is loaded, what is one call
 *  away, and how many exist beyond the ones named. */
export function renderSkillSection(index: SkillLike[], preload: SkillLike | null, total: number): string {
  if (index.length === 0 && !preload) return "";
  const parts: string[] = [];
  const listed = index.filter((s) => s.slug !== preload?.slug);
  if (listed.length) {
    parts.push(listed.map(indexLine).join("\n"));
  }
  const hidden = total - index.length;
  if (hidden > 0) {
    parts.push(`(+ ${hidden} autre${hidden > 1 ? "s" : ""} skill${hidden > 1 ? "s" : ""} activé${hidden > 1 ? "s" : ""} non listé${hidden > 1 ? "s" : ""} ici — list_skills() pour le roster complet.)`);
  }
  if (preload) {
    parts.push(
      "",
      `### ${preload.name} (${preload.slug}) — PRÉCHARGÉE pour cette tâche`,
      (preload.instructions ?? "").trim(),
    );
    if (preload.files && preload.files.length) {
      parts.push(
        "",
        `Fichiers de cette skill (à lire à la demande) : ${preload.files.map((f) => f.path).join(", ")} — read_skill_file(slug="${preload.slug}", path="…").`,
      );
    }
  }
  return parts.join("\n").trim();
}

// ---------------------------------------------------------------------------
// The soul file
// ---------------------------------------------------------------------------

/** Souls are short by contract — a page of character is a character nobody
 *  reads. Truncation is silent on purpose: the editor shows the count. */
export const SOUL_MAX_CHARS = 2400;

export function renderSoul(soul: string | null | undefined): string {
  const body = String(soul ?? "").trim();
  if (!body) return "";
  return body.length > SOUL_MAX_CHARS ? `${body.slice(0, SOUL_MAX_CHARS)}…` : body;
}
