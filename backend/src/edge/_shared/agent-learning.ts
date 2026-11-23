
// Agent self-learning — turn a user's correction into a durable fix of the
// file that should have prevented the mistake (migration 0288).
//
// The loop, for every human message that follows an agent's work:
//
//   1. CUE      — a free lexical pre-filter (feedbackCue). Most messages are new
//                 requests, not corrections; they never reach a model.
//   2. JUDGE    — one short LLM call: is this a remark on what the agent just
//                 did? Durable beyond this task? Which file is at fault?
//   3. REVISE   — for instructions / soul, a second call that writes the
//                 smallest patch: append a lesson, or replace the one sentence
//                 that caused the error. Preferences go through the same
//                 upsertPreference as the agent's own remember_preference.
//   4. DECIDE   — the agent's `self_learning` mode, the judge's confidence and
//                 a rate limit decide between applied and proposed. Unsafe
//                 lessons (that loosen a safety or approval rule) are never
//                 applied without a human.
//   5. JOURNAL  — every lesson is logged with the file before and after, and
//                 the replaced fragment, so agent_learning_decide() can undo it
//                 even after the file moved on.
//
// The pure half (cue, patch application) has no I/O so the tests and both
// entry points (room turn, direct chat) share one behaviour.

import { callAi, safeParseJson } from "./ai.ts";
import { resolveProvider } from "./model-router.ts";
import { preferenceKey, preferenceLine, upsertPreference, SOUL_MAX_CHARS } from "./agent-context.ts";
import type { createServiceClient } from "./supabase-admin.ts";

type Admin = ReturnType<typeof createServiceClient>;

export type LearningFile = "instructions" | "soul" | "preferences";
export type LearningMode = "off" | "suggest" | "auto";

export const LESSONS_HEADING = "## Leçons apprises";
/** Past this, instructions stop growing by themselves: a human must prune. */
export const INSTRUCTIONS_MAX_CHARS = 40000;
const LESSON_MAX_CHARS = 500;
/** Confidence needed to apply without a human, per file. The soul is who the
 *  agent is — it moves only on a clear, unambiguous remark. */
const AUTO_THRESHOLD: Record<LearningFile, number> = { instructions: 0.7, preferences: 0.7, soul: 0.85 };
/** Applied lessons per agent per hour before the rest wait for a human: a
 *  heated conversation must not rewrite an agent in ten minutes. */
const AUTO_PER_HOUR = 5;

// ---------------------------------------------------------------------------
// 1. Cue — is this message worth a judge call at all?
// ---------------------------------------------------------------------------

const fold = (s: string) => (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’`]/g, "'");

const CUES: RegExp[] = [
  // Refusal / "that's wrong".
  /^\s*(non|nan|no|nope)\b/,
  /\b(c'est|c est|ce n'est|ce n est|c'etait) (pas|faux|incorrect|inexact|errone|n'importe quoi)/,
  /\b(faux|erreur|errone|erronee|incorrect|incorrecte|inexact|mauvais|mauvaise|wrong|mistake|incorrectly)\b/,
  /\bpas (ca|ce que|bon|bonne|correct|juste|le bon|la bonne|les bons|les bonnes|ce qu'il faut)\b/,
  /\b(not what i|that's not|that is not|this is not|isn't right|is not right)\b/,
  // Something missing or forgotten.
  /\b(oublie|oubliee|oublies|oublier|manque|manquant|manquante|il manque|tu n'as pas|t'as pas|n'as pas|forgot|forgotten|missing|you didn't|you did not)\b/,
  // Repeated correction.
  /\b(je (te l'ai|t'ai|t'avais|l'avais) (dit|demande|precise)|comme (je l'ai|je t'ai) dit|encore une fois|a nouveau|de nouveau|i told you|i asked you|again)\b/,
  // A rule for the future.
  /\b(la prochaine fois|a l'avenir|desormais|dorenavant|a partir de maintenant|next time|from now on|in the future|going forward)\b/,
  /\b(ne (le |la |les )?(fais|fait|mets|utilise|envoie|ecris|poste|reponds|cree|supprime)s? (plus|jamais|pas)|arrete de|evite de|cesse de|stop |don't |do not |never )/,
  /\b(toujours|jamais|always)\b/,
  // What should have happened.
  /\b(il fallait|il aurait fallu|tu aurais du|tu devais|t'aurais du|tu dois|il faut que tu|should have|shouldn't have|you should|you need to|you were supposed to)\b/,
  /\b(plutot|au lieu de|a la place de|instead)\b/,
  // It did not work.
  /\b(ca (ne )?marche pas|ne fonctionne pas|fonctionne pas|bug|bugue|casse|plante|rate|echoue|n'a pas marche|doesn't work|didn't work|broken|failed)\b/,
  /\b(pourquoi (tu|as-tu|est-ce que tu|t'as)|why did you|why didn't you)\b/,
];

/** Thanks and acknowledgements are never corrections, however they're phrased. */
const PURE_ACK = /^\s*(ok|okay|d'accord|merci|parfait|super|top|genial|nickel|bravo|thanks|thank you|great|perfect|cool|yes|oui)[\s!.,👍🙏]*$/;

/** How many correction cues the message carries. 0 = skip the judge. */
export function feedbackCue(text: string): number {
  const t = fold(text).trim();
  if (t.length < 3 || PURE_ACK.test(t)) return 0;
  let hits = 0;
  for (const re of CUES) if (re.test(t)) hits++;
  return hits;
}

// ---------------------------------------------------------------------------
// 3b. Patches — the smallest edit that carries the lesson.
// ---------------------------------------------------------------------------

export interface FilePatch {
  op: "append" | "replace";
  /** replace only: an exact excerpt of the current file. */
  find?: string;
  text: string;
}

/**
 * The applied edit, as the database stores it: the whole file after, and the
 * fragment swap (`find` → `replace`) that produced it. Reverting is the same
 * swap backwards, which still works when the file has changed elsewhere since.
 * `find` empty = an append at the end of the file.
 */
export type AppliedPatch =
  | { ok: true; file: string; find: string; replace: string }
  | { ok: false; reason: string };

const oneLine = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();

function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Append after the file's trailing whitespace. When there was some, it is part
 *  of the swap — otherwise the reverse swap would not land on the original
 *  bytes. */
function appendAtEnd(file: string, add: string): AppliedPatch {
  const base = file.replace(/\s+$/, "");
  return base === file
    ? { ok: true, file: base + add, find: "", replace: add }
    : { ok: true, file: base + add, find: file, replace: base + add };
}

/** The "## Leçons apprises" section: from its heading to the next heading of
 *  the same or higher level, or the end of the file. */
function lessonsSection(file: string): string | null {
  const at = file.indexOf(LESSONS_HEADING);
  if (at < 0) return null;
  const rest = file.slice(at + LESSONS_HEADING.length);
  const next = rest.search(/\n#{1,2} /);
  const section = next < 0 ? file.slice(at) : file.slice(at, at + LESSONS_HEADING.length + next);
  return section.replace(/\s+$/, "");
}

export function applyLearningPatch(target: Exclude<LearningFile, "preferences">, current: string | null, patch: FilePatch): AppliedPatch {
  const file = String(current ?? "");
  const text = target === "instructions" ? oneLine(patch.text).slice(0, LESSON_MAX_CHARS) : String(patch.text ?? "").trim().slice(0, LESSON_MAX_CHARS);
  if (!text) return { ok: false, reason: "correction vide" };
  if (preferenceKey(file).includes(preferenceKey(text))) return { ok: false, reason: "cette leçon est déjà dans le fichier" };

  let out: AppliedPatch;
  if (patch.op === "replace") {
    const find = String(patch.find ?? "");
    if (find.trim().length < 8) return { ok: false, reason: "extrait à remplacer trop court" };
    const n = occurrences(file, find);
    if (n !== 1) return { ok: false, reason: n === 0 ? "extrait à remplacer introuvable" : "extrait à remplacer ambigu" };
    // A lesson corrects a sentence; it does not get to delete a procedure.
    if (find.length > 1500 || (find.length > 200 && text.length < find.length * 0.3)) {
      return { ok: false, reason: "remplacement trop destructif" };
    }
    out = { ok: true, file: file.replace(find, text), find, replace: text };
  } else if (target === "soul") {
    out = appendAtEnd(file, `${file.trim() ? "\n" : ""}${text}`);
  } else {
    const bullet = `- ${text}`;
    const section = lessonsSection(file);
    if (section && occurrences(file, section) === 1) {
      // Into the existing section, after its last lesson. The section itself is
      // the anchor: still present (as a prefix) after later lessons, so this
      // edit stays revertible on its own.
      const grown = `${section}\n${bullet}`;
      out = { ok: true, file: file.replace(section, grown), find: section, replace: grown };
    } else {
      out = appendAtEnd(file, `${file.trim() ? "\n\n" : ""}${LESSONS_HEADING}\n${bullet}`);
    }
  }

  if (out.ok) {
    if (target === "soul" && out.file.trim().length > SOUL_MAX_CHARS) return { ok: false, reason: `l'âme dépasserait ${SOUL_MAX_CHARS} caractères` };
    if (target === "instructions" && out.file.length > INSTRUCTIONS_MAX_CHARS) return { ok: false, reason: "les instructions ont atteint leur taille maximale" };
  }
  return out;
}

/** Preferences reuse the file's own upsert (dedupe, supersede, caps). An added
 *  line is appended as-is — never re-render a file a human wrote by hand. */
export function applyPreferenceLesson(current: string | null, lesson: { text: string; topic?: string | null }): AppliedPatch {
  const res = upsertPreference(current, { text: lesson.text, topic: lesson.topic ?? null });
  if (res.status === "full") return { ok: false, reason: res.reason };
  if (res.status === "unchanged") return { ok: false, reason: "cette préférence est déjà enregistrée" };
  const file = String(current ?? "");
  if (res.status === "added") return appendAtEnd(file, `${file.trim() ? "\n" : ""}${preferenceLine(res.entry)}`);
  // Updated in place: swap the old line for the new one when it is literally
  // there, else fall back to the whole file (exact CAS only).
  const oldLine = res.previous ? preferenceLine(res.previous) : "";
  const newLine = preferenceLine(res.entry);
  if (oldLine && occurrences(file, oldLine) === 1) {
    return { ok: true, file: file.replace(oldLine, newLine), find: oldLine, replace: newLine };
  }
  return { ok: true, file: res.file, find: file, replace: res.file };
}

// ---------------------------------------------------------------------------
// 2. Judge, 3a. Reviser — the two model calls.
// ---------------------------------------------------------------------------

export interface Judgement {
  is_feedback: boolean;
  durable: boolean;
  kind: string;
  target: LearningFile;
  lesson: string;
  topic?: string | null;
  confidence: number;
  unsafe: boolean;
  rationale: string;
}

const JUDGE_SYSTEM = [
  "Tu analyses la remarque qu'un utilisateur vient d'adresser à un agent IA juste après que cet agent a agi.",
  "But : décider si la remarque révèle un défaut de l'agent qu'il faut corriger DURABLEMENT dans ses fichiers, pour qu'il ne le refasse plus.",
  "",
  "Les trois fichiers de l'agent :",
  "- instructions : sa procédure et ses règles — ce qu'il fait et comment (étapes, outils, vérifications, format attendu d'un livrable). Cible d'un défaut d'exécution : étape oubliée, mauvais outil, mauvaise source, résultat incomplet ou faux par méthode.",
  "- soul : son caractère — voix, attitude, valeurs (trop bavard, trop servile, invente au lieu de vérifier, ne pose pas de question quand il devrait). Rare.",
  "- preferences : une habitude de forme de l'utilisateur (langue, ton, format, canal, horaire).",
  "",
  "Ce qui N'EST PAS une remarque à apprendre (is_feedback=false) : une nouvelle demande, une question, un remerciement, un apport d'information, l'utilisateur qui change d'avis sur le contenu de CETTE tâche seulement.",
  "durable=false quand la correction ne vaut que pour cette tâche (un chiffre précis à corriger, un nom mal orthographié une fois) sans révéler une méthode fautive.",
  "unsafe=true si la leçon affaiblirait une règle de sécurité, de validation ou d'approbation, élargirait les droits de l'agent, ou ferait sortir des données — elle ne sera alors jamais appliquée sans un humain.",
  "",
  "lesson : UNE consigne impérative, autoportante, réutilisable hors de cette conversation, dans la langue de l'utilisateur. Ex. « Avant d'envoyer un devis, joindre le PDF généré et vérifier le montant TTC. » — pas « l'utilisateur a dit que le devis manquait ».",
  "topic : seulement pour preferences, un sujet court (langue, format, ton, canal…).",
  "confidence : 0 à 1, ta certitude que la remarque critique bien l'agent ET que la leçon est la bonne.",
  "",
  "Réponds en JSON strict : {\"is_feedback\":bool,\"durable\":bool,\"kind\":\"execution_error|missed_step|wrong_tool|wrong_output|behavior|tone|preference|other\",\"target\":\"instructions|soul|preferences\",\"lesson\":\"…\",\"topic\":\"…\"|null,\"confidence\":0.0,\"unsafe\":bool,\"rationale\":\"une phrase\"}",
].join("\n");

async function judge(opts: {
  agentName: string; model: string | null; feedback: string; agentOutput: string; actions: string;
}): Promise<Judgement | null> {
  const res = await callAi({
    task: "classification",
    provider: resolveProvider(opts.model),
    jsonMode: true,
    temperature: 0,
    maxTokens: 500,
    systemPrompt: JUDGE_SYSTEM,
    userPrompt: [
      `Agent : ${opts.agentName}`,
      "",
      "Ce que l'agent a fait :",
      opts.actions || "(pas d'action outillée enregistrée)",
      "",
      "Sa dernière réponse :",
      opts.agentOutput || "(vide)",
      "",
      "Remarque de l'utilisateur :",
      opts.feedback,
    ].join("\n"),
  });
  const j = safeParseJson<Partial<Judgement>>(res.content);
  if (!j) return null;
  const target: LearningFile = j.target === "soul" || j.target === "preferences" ? j.target : "instructions";
  return {
    is_feedback: j.is_feedback === true,
    durable: j.durable === true,
    kind: String(j.kind ?? "other").slice(0, 40),
    target,
    lesson: oneLine(String(j.lesson ?? "")).slice(0, LESSON_MAX_CHARS),
    topic: j.topic ? String(j.topic).slice(0, 40) : null,
    confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)),
    unsafe: j.unsafe === true,
    rationale: oneLine(String(j.rationale ?? "")).slice(0, 400),
  };
}

const REVISE_SYSTEM = [
  "Tu corriges le fichier d'un agent IA pour qu'il ne refasse pas une erreur. Tu reçois le fichier actuel et la leçon à intégrer.",
  "Produis la PLUS PETITE modification possible :",
  "- op=\"replace\" quand une phrase existante du fichier est fausse, incomplète ou contredit la leçon : `find` = cette phrase recopiée EXACTEMENT (caractère pour caractère, une ligne ou une phrase, jamais une section entière), `text` = sa version corrigée.",
  "- op=\"append\" sinon : `text` = la leçon, une ou deux phrases impératives.",
  "Ne réécris jamais le reste du fichier. Ne mentionne ni cette conversation, ni une date, ni l'utilisateur à la troisième personne.",
  "Écris dans la langue du fichier (ou de la leçon s'il est vide).",
  "Réponds en JSON strict : {\"op\":\"append|replace\",\"find\":\"…\"|null,\"text\":\"…\"}",
].join("\n");

const SOUL_HINT = "Ce fichier est l'ÂME de l'agent (son caractère, à la 2e personne : « Tu … »). Écris un trait de caractère ou une valeur, pas une étape de procédure.";

async function revise(opts: { target: "instructions" | "soul"; file: string; lesson: string; model: string | null }): Promise<FilePatch | null> {
  const file = opts.file.length > 14000 ? `${opts.file.slice(0, 14000)}\n…(tronqué)` : opts.file;
  const res = await callAi({
    task: "json_extraction",
    provider: resolveProvider(opts.model),
    jsonMode: true,
    temperature: 0,
    maxTokens: 600,
    systemPrompt: opts.target === "soul" ? `${REVISE_SYSTEM}\n${SOUL_HINT}` : REVISE_SYSTEM,
    userPrompt: [
      `Fichier ${opts.target === "soul" ? "soul.md" : "instructions.md"} actuel :`,
      "<<<",
      file || "(vide)",
      ">>>",
      "",
      `Leçon à intégrer : ${opts.lesson}`,
    ].join("\n"),
  });
  const p = safeParseJson<{ op?: string; find?: string | null; text?: string }>(res.content);
  if (!p?.text) return null;
  return { op: p.op === "replace" && p.find ? "replace" : "append", find: p.find ?? undefined, text: p.text };
}

// ---------------------------------------------------------------------------
// What the agent actually did — read back from its run.
// ---------------------------------------------------------------------------

export async function describeRunActions(admin: Admin, runId: string | null | undefined): Promise<string> {
  if (!runId) return "";
  const { data } = await admin.from("internal_agent_run_events")
    .select("kind, payload").eq("run_id", runId)
    .in("kind", ["tool_call", "tool_result", "tool_error", "error"])
    .order("created_at", { ascending: true }).limit(60);
  const lines: string[] = [];
  for (const e of (data ?? []) as Array<{ kind: string; payload: Record<string, unknown> | null }>) {
    const p = e.payload ?? {};
    if (e.kind === "tool_call") lines.push(`→ ${p.tool ?? "outil"} ${JSON.stringify(p.args ?? {}).slice(0, 220)}`);
    else if (e.kind === "tool_result") lines.push(`  ${p.ok === false ? "✗" : "✓"} ${String(p.preview ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    else lines.push(`  ✗ ${String(p.message ?? p.error ?? "erreur").slice(0, 200)}`);
  }
  const out = lines.join("\n");
  return out.length > 3000 ? `${out.slice(0, 1200)}\n…\n${out.slice(-1700)}` : out;
}

// ---------------------------------------------------------------------------
// The pipeline.
// ---------------------------------------------------------------------------

export interface LearnInput {
  agentId: string;
  source: "chat" | "room";
  sourceMessageId: string;
  feedback: string;
  agentOutput: string;
  /** The run behind the agent's output — its tool calls are what's judged. */
  agentRunId?: string | null;
  conversationId?: string | null;
  roomId?: string | null;
  userId?: string | null;
}

export interface LearningOutcome {
  id: string;
  status: "applied" | "proposed" | "skipped";
  target: LearningFile;
  lesson: string;
  agentName: string;
  detail: string | null;
}

interface LearningAgentRow {
  id: string; name: string; model: string | null; workspace_id: string; project_id: string | null;
  instructions: string | null; soul: string | null; preferences: string | null;
  self_learning: LearningMode | null;
}

const FILE_LABEL: Record<LearningFile, string> = { instructions: "instructions.md", soul: "soul.md", preferences: "preferences.md" };

export async function learnFromFeedback(admin: Admin, input: LearnInput): Promise<LearningOutcome | null> {
  const feedback = String(input.feedback ?? "").trim();
  if (!feedback || feedbackCue(feedback) === 0) return null;

  const { data: row } = await admin.from("internal_agents")
    .select("id, name, model, workspace_id, project_id, instructions, soul, preferences, self_learning")
    .eq("id", input.agentId).maybeSingle();
  if (!row) return null;
  const agent = row as LearningAgentRow;
  const mode: LearningMode = agent.self_learning ?? "auto";
  if (mode === "off") return null;

  const { data: seen } = await admin.from("internal_agent_learnings").select("id")
    .eq("agent_id", agent.id).eq("source_message_id", input.sourceMessageId).maybeSingle();
  if (seen) return null;

  const actions = await describeRunActions(admin, input.agentRunId);
  const verdict = await judge({
    agentName: agent.name, model: agent.model, feedback,
    agentOutput: input.agentOutput.slice(0, 3000), actions,
  });
  if (!verdict || !verdict.is_feedback || !verdict.durable || !verdict.lesson) return null;

  const target = verdict.target;
  const current = agent[target] ?? null;
  let applied: AppliedPatch;
  let patchOp: FilePatch["op"] = "append";
  if (target === "preferences") {
    applied = applyPreferenceLesson(current, { text: verdict.lesson, topic: verdict.topic });
  } else {
    const p = await revise({ target, file: current ?? "", lesson: verdict.lesson, model: agent.model })
      ?? { op: "append" as const, text: verdict.lesson };
    patchOp = p.op;
    applied = applyLearningPatch(target, current, p);
    // A replace that misquoted the file is still a good lesson: keep it as an
    // append rather than lose it.
    if (!applied.ok && p.op === "replace") {
      patchOp = "append";
      applied = applyLearningPatch(target, current, { op: "append", text: target === "instructions" ? verdict.lesson : p.text });
    }
  }

  // Status before any write. The journal row goes in FIRST: its unique key is
  // what stops a replayed request from learning the same remark twice.
  let status: LearningOutcome["status"] = "applied";
  let detail: string | null = null;
  if (!applied.ok) { status = "skipped"; detail = applied.reason; }
  else if (mode === "suggest") { status = "proposed"; detail = "mode suggestion : en attente de validation"; }
  else if (verdict.unsafe) { status = "proposed"; detail = "touche à une règle de sécurité ou d'approbation : validation humaine requise"; }
  else if (verdict.confidence < AUTO_THRESHOLD[target]) { status = "proposed"; detail = `confiance ${verdict.confidence.toFixed(2)} sous le seuil d'application automatique`; }
  else {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from("internal_agent_learnings").select("id", { count: "exact", head: true })
      .eq("agent_id", agent.id).eq("status", "applied").gte("created_at", since);
    if ((count ?? 0) >= AUTO_PER_HOUR) { status = "proposed"; detail = `plus de ${AUTO_PER_HOUR} corrections automatiques dans l'heure : validation humaine requise`; }
  }

  const { data: ins, error: insErr } = await admin.from("internal_agent_learnings").insert({
    agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
    source: input.source, source_message_id: input.sourceMessageId,
    conversation_id: input.conversationId ?? null, room_id: input.roomId ?? null,
    run_id: input.agentRunId ?? null, user_id: input.userId ?? null,
    feedback: feedback.slice(0, 4000), agent_output: input.agentOutput.slice(0, 4000),
    kind: verdict.kind, target_file: target, lesson: verdict.lesson,
    rationale: verdict.rationale, confidence: verdict.confidence,
    before_text: current, after_text: applied.ok ? applied.file : null,
    patch: applied.ok ? { op: patchOp, find: applied.find, replace: applied.replace } : {},
    status: status === "applied" ? "proposed" : status,
    detail,
  }).select("id").single();
  if (insErr || !ins) return null; // duplicate: another invocation got there first
  const id = (ins as { id: string }).id;

  if (status === "applied" && applied.ok) {
    // Compare-and-swap on the file: if a human (or the agent's own
    // remember_preference) wrote in between, park it as a proposal rather
    // than overwrite their edit.
    const patch: Record<string, unknown> = { [target]: applied.file, updated_at: new Date().toISOString() };
    if (target === "instructions") patch.instruction_blocks = [];
    if (target === "preferences") {
      patch.preferences_updated_at = new Date().toISOString();
      patch.preferences_updated_by = "agent";
    }
    const guard = admin.from("internal_agents").update(patch).eq("id", agent.id);
    const { data: written } = await (current === null ? guard.is(target, null) : guard.eq(target, current)).select("id");
    if (written && written.length > 0) {
      await admin.from("internal_agent_learnings").update({ status: "applied", decided_at: new Date().toISOString() }).eq("id", id);
    } else {
      status = "proposed";
      detail = "le fichier a été modifié pendant l'analyse : validation humaine requise";
      await admin.from("internal_agent_learnings").update({ detail }).eq("id", id);
    }
  }

  return { id, status, target, lesson: verdict.lesson, agentName: agent.name, detail };
}

/** One line for the thread / timeline, or null when there is nothing to say. */
export function describeOutcome(o: LearningOutcome | null): string | null {
  if (!o || o.status === "skipped") return null;
  return o.status === "applied"
    ? `📚 ${o.agentName} a tiré une leçon de cette remarque et a mis à jour son ${FILE_LABEL[o.target]} : « ${o.lesson} » — annulable dans Fichiers → Apprentissage.`
    : `📚 ${o.agentName} propose une correction de son ${FILE_LABEL[o.target]} : « ${o.lesson} » — à valider dans Fichiers → Apprentissage.`;
}

/** Detached: learning must never delay or break the turn it rides along. */
export function learnInBackground(job: Promise<unknown>): void {
  const safe = job.catch((e) => console.error("self-learning failed", e));
  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(safe);
}
