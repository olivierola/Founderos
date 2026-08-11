// Agent loop engine — "loop engineering" for the internal-agent runtime.
//
// The runtime already runs a durable tick loop (plan → act with tools → persist
// → re-enqueue). What this module adds is the part that makes a loop a CONTROL
// SYSTEM rather than a retry pile:
//
//   1. A SUCCESS CONTRACT (deriveContract) — the goal turned into a list of
//      TYPED checks. Deterministic ones first (a deliverable exists, a URL
//      answers, the checklist is closed, a file is on disk); the LLM judge is
//      the last resort for genuinely qualitative criteria. This is what stops a
//      loop from grading its own homework.
//   2. A VERIFY step (evaluateContract) that returns concrete, machine-checked
//      GAPS — usable as feedback to re-enter the loop — instead of a vibe.
//   3. A PROGRESS FINGERPRINT (fingerprintProgress / hasAdvanced) so the
//      controller can see stagnation: an agent burning rounds with varied
//      arguments and producing nothing. The old identical-signature guard only
//      caught literal repetition.
//   4. ONE CONTROLLER (decideNext) that reads every signal and returns a single
//      typed decision — continue / replan / finalize / abort — with the
//      interventions to inject. The tick handler applies it; it no longer
//      decides anything on its own.
//   5. A TRACE (loopEventPayload) written as a `loop` run event: what the
//      controller saw, what it decided, why. Auditable in the live timeline.
//
// Everything here is best-effort by design: a contract that cannot be derived,
// or a check that cannot be evaluated, must never block a run — it degrades to
// the previous behaviour (LLM judge, or no verification at all).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { callAi, safeParseJson, type ChatMessage } from "./ai.ts";
import { cheapProvider } from "./model-router.ts";

// ---------------------------------------------------------------------------
// Success contract
// ---------------------------------------------------------------------------

/** Check kinds, ordered from cheapest/most trustworthy to most subjective. */
export type CheckKind =
  /** A deliverable of this kind / whose name matches exists and is non-empty. */
  | "deliverable_exists"
  /** At least N deliverables were produced by this run. */
  | "deliverables_min"
  /** Every leaf of the run checklist is done (blocked items count as failures). */
  | "todos_all_done"
  /** A URL answers with a non-error status (private/local hosts are skipped). */
  | "http_ok"
  /** A file exists in the execution world (needs a shell probe; skipped without). */
  | "file_exists"
  /** A shell command exits 0 in the execution world (skipped without a probe). */
  | "command_exits_zero"
  /** The final report mentions a required element (URL, id, table, figure…). */
  | "text_contains"
  /** Qualitative criterion — evaluated by an LLM reviewer, as a last resort. */
  | "judge";

export interface SuccessCheck {
  id: string;
  kind: CheckKind;
  /** Human-readable, shown in the timeline. */
  label: string;
  args?: Record<string, unknown>;
  /** A required check that fails sends the run back into the loop. Soft checks
   *  are reported and traced but never block finalization. */
  required?: boolean;
}

export interface SuccessContract {
  goal: string;
  source: "mission" | "chat";
  checks: SuccessCheck[];
  derived_at: string;
}

export interface CheckResult {
  id: string;
  label: string;
  kind: CheckKind;
  /** true = satisfied (or skipped — a check we cannot evaluate never fails). */
  pass: boolean;
  /** Not evaluable in this environment (no probe, private host…). */
  skipped?: boolean;
  required: boolean;
  detail: string;
  /** Machine-checked (free, cannot hallucinate) vs LLM-judged. */
  deterministic: boolean;
}

export interface ContractVerdict {
  pass: boolean;
  results: CheckResult[];
  /** Concrete gaps to feed back into the loop (required failures only). */
  gaps: string[];
  /** Non-blocking failures — reported, and included as hints on a re-entry. */
  soft: string[];
}

const CHECK_KINDS: CheckKind[] = [
  "deliverable_exists", "deliverables_min", "todos_all_done", "http_ok",
  "file_exists", "command_exits_zero", "text_contains", "judge",
];

/** Derive the run's success contract. Deterministic seeds come from structured
 *  data we already hold (expected deliverables, the checklist); one cheap LLM
 *  call turns the free-text criteria (`done_when`, acceptance criteria, or the
 *  user's own request in chat) into additional typed checks. Returns null when
 *  there is genuinely nothing to check — the caller then behaves as before. */
export async function deriveContract(opts: {
  source: "mission" | "chat";
  goal: string;
  doneWhen?: string | null;
  acceptanceCriteria?: string | null;
  expectedDeliverables?: Array<{ kind: string; name: string; description?: string }>;
  hasTodos?: boolean;
}): Promise<SuccessContract | null> {
  const checks: SuccessCheck[] = [];
  let n = 0;
  const nextId = () => `c${++n}`;

  // ── Deterministic seeds ────────────────────────────────────────────────────
  for (const d of (opts.expectedDeliverables ?? []).slice(0, 6)) {
    if (!d?.name) continue;
    checks.push({
      id: nextId(),
      kind: "deliverable_exists",
      label: `Livrable « ${d.name} » produit${d.kind ? ` (${d.kind})` : ""}`,
      args: { kind: d.kind || undefined, name_contains: firstMeaningfulWord(d.name) },
      required: true,
    });
  }
  if (opts.hasTodos) {
    // Soft: a legitimately blocked step should not deadlock the run — it is
    // surfaced as a gap, and the controller decides.
    checks.push({ id: nextId(), kind: "todos_all_done", label: "Toutes les étapes de la checklist sont closes", required: false });
  }

  // ── LLM extraction of the free-text criteria into typed checks ─────────────
  const criteria = [
    opts.doneWhen ? `DONE WHEN: ${opts.doneWhen}` : "",
    opts.acceptanceCriteria ? `ACCEPTANCE CRITERIA:\n${opts.acceptanceCriteria}` : "",
  ].filter(Boolean).join("\n\n");
  if (criteria || opts.source === "chat") {
    try {
      const res = await callAi({
        task: "json_extraction",
        provider: cheapProvider(),
        jsonMode: true,
        maxTokens: 800,
        temperature: 0.1,
        systemPrompt: [
          "You turn a task's definition of done into MACHINE-CHECKABLE checks for an autonomous agent's control loop.",
          "Return STRICT JSON: {\"checks\":[{\"kind\":\"...\",\"label\":\"...\",\"args\":{...},\"required\":true|false}]}",
          "Allowed kinds and their args:",
          '- "deliverable_exists" {"kind"?:"report|markdown|csv|json|...","name_contains"?:"word"} — an artifact must be saved.',
          '- "deliverables_min" {"count":N} — at least N artifacts.',
          '- "http_ok" {"url":"https://…"} — a URL must answer. ONLY if an explicit URL appears in the task.',
          '- "file_exists" {"path":"/abs/or/rel/path"} — ONLY if an explicit path appears in the task.',
          '- "command_exits_zero" {"command":"npm test"} — ONLY if an explicit command/test suite appears in the task.',
          '- "text_contains" {"needle":"…"} — the final report must mention this exact element (an id, a URL, a table name).',
          '- "judge" {"criterion":"…"} — qualitative only, when nothing above can express it.',
          "RULES: 3 checks max. NEVER invent a URL, a path or a command that is not written in the task — when in doubt use judge. Prefer deterministic kinds over judge. Labels in French, short, verifiable.",
        ].join("\n"),
        userPrompt: [
          `# Objectif\n${opts.goal.slice(0, 1200)}`,
          criteria ? `\n# Critères\n${criteria.slice(0, 1500)}` : "",
        ].join("\n"),
      });
      const parsed = safeParseJson<{ checks?: Array<{ kind?: string; label?: string; args?: Record<string, unknown>; required?: boolean }> }>(res.content);
      for (const c of (parsed?.checks ?? []).slice(0, 3)) {
        const kind = String(c?.kind ?? "") as CheckKind;
        if (!CHECK_KINDS.includes(kind)) continue;
        const label = String(c?.label ?? "").slice(0, 160);
        if (!label) continue;
        // Guard the model's favourite hallucination: a check whose target was
        // never mentioned. If the argument's value does not appear in the task
        // text, downgrade it to a judge criterion instead of failing the run on
        // an invented URL/path/command.
        const args = (c?.args ?? {}) as Record<string, unknown>;
        const haystack = `${opts.goal}\n${criteria}`.toLowerCase();
        const target = String(args.url ?? args.path ?? args.command ?? "").toLowerCase();
        // In CHAT, a qualitative criterion never blocks: the "goal" is a single
        // user message, so a judge check derived from it is the most likely to
        // be over-strict — it is reported, not enforced. Missions, which have a
        // real brief and acceptance criteria, keep theirs binding.
        const required = c?.required !== false && !(opts.source === "chat" && kind === "judge");
        if (target && !haystack.includes(target.slice(0, Math.min(target.length, 24)))) {
          checks.push({ id: nextId(), kind: "judge", label, args: { criterion: label }, required: opts.source !== "chat" && c?.required !== false });
          continue;
        }
        checks.push({ id: nextId(), kind, label, args, required });
      }
    } catch { /* extraction is best-effort — the deterministic seeds still stand */ }
  }

  if (checks.length === 0) return null;
  return { goal: opts.goal.slice(0, 600), source: opts.source, checks, derived_at: new Date().toISOString() };
}

function firstMeaningfulWord(s: string): string {
  const w = s.toLowerCase().replace(/[^a-z0-9àâçéèêëîïôûùüÿñ\s-]/gi, " ").split(/\s+/)
    .find((x) => x.length >= 4 && !["rapport", "report", "fichier", "document"].includes(x));
  return (w ?? s.slice(0, 12)).slice(0, 24);
}

// ---------------------------------------------------------------------------
// Contract evaluation
// ---------------------------------------------------------------------------

/** Probe into the agent's execution world (runner/sandbox shell), when one is
 *  available. Returning null means "cannot evaluate" → the check is skipped. */
export type LoopProbe = (
  kind: "file_exists" | "command_exits_zero",
  args: Record<string, unknown>,
) => Promise<{ pass: boolean; detail: string } | null>;

export async function evaluateContract(opts: {
  admin: SupabaseClient;
  runId: string;
  contract: SuccessContract;
  finalOutput: string;
  probe?: LoopProbe;
}): Promise<ContractVerdict> {
  const { admin, runId, contract, finalOutput } = opts;
  const results: CheckResult[] = [];

  // One fetch each, shared by every check that needs them.
  const [{ data: delivs }, { data: runRow }] = await Promise.all([
    admin.from("internal_agent_deliverables").select("kind, name, content, file_url").eq("run_id", runId).limit(30),
    admin.from("internal_agent_runs").select("todos").eq("id", runId).maybeSingle(),
  ]);
  const deliverables = (delivs ?? []) as Array<{ kind: string; name: string; content: string | null; file_url: string | null }>;
  const nonEmpty = deliverables.filter((d) => (d.content && String(d.content).trim().length > 20) || d.file_url);
  const todos = Array.isArray((runRow as { todos?: unknown } | null)?.todos)
    ? ((runRow as { todos: Array<{ id: string; status: string; title: string; parent_id?: string }> }).todos)
    : [];

  const judgeQueue: SuccessCheck[] = [];

  for (const c of contract.checks) {
    const required = c.required !== false;
    const base = { id: c.id, label: c.label, kind: c.kind, required };
    const args = c.args ?? {};
    switch (c.kind) {
      case "deliverable_exists": {
        const wantKind = typeof args.kind === "string" ? args.kind.toLowerCase() : null;
        const wantName = typeof args.name_contains === "string" ? args.name_contains.toLowerCase() : null;
        const hit = nonEmpty.find((d) =>
          (!wantKind || String(d.kind).toLowerCase() === wantKind) &&
          (!wantName || String(d.name).toLowerCase().includes(wantName)));
        // A kind mismatch alone is not worth failing on (the agent may have
        // picked "markdown" where the brief said "report") — accept any
        // non-empty deliverable whose NAME matches.
        const byName = !hit && wantName ? nonEmpty.find((d) => String(d.name).toLowerCase().includes(wantName)) : null;
        // …and neither is a NAME mismatch. The expected name is a guess the
        // planner made before the work existed ("Rapport d'analyse"); the agent
        // titles its report from what it found ("Marchés bouleversés par l'IA").
        // Failing on that marked correct runs red and told the human "aucun
        // livrable enregistré" while the report sat right there. The name is a
        // bonus; the deliverable existing is the check.
        const anyOfKind = !hit && !byName
          ? nonEmpty.find((d) => !wantKind || String(d.kind).toLowerCase() === wantKind) ?? nonEmpty[0]
          : null;
        const found = hit ?? byName ?? anyOfKind;

        // A report must be the JSON DOCUMENT, not prose in a JSON wrapper.
        // Only the structure is required: a report made of plain sections is
        // legitimate — charts and KPIs are the right answer when there are
        // numbers to show, not a quota to fill. What is rejected is content
        // that never was the report shape at all.
        // A report or a deck must be the Editor.js DOCUMENT, not prose in a
        // JSON wrapper. This checked  — the field of the format that
        // preceded blocks — so every correctly published report failed the
        // contract the day the contract stopped matching reality.
        const kindLower = String(found?.kind ?? "").toLowerCase();
        if (found && (kindLower === "report" || kindLower === "presentation")) {
          let blocks = 0;
          try {
            const doc = JSON.parse(String(found.content ?? "{}"));
            blocks = Array.isArray(doc?.blocks) ? doc.blocks.length : 0;
          } catch { blocks = 0; }
          if (blocks === 0) {
            results.push({
              ...base, deterministic: true, pass: false,
              detail: `« ${found.name} » ne contient aucun bloc : son contenu n'est pas le document attendu ({ blocks: [...] }). Reconstruis-le avec add_block puis publish_artifact.`,
            });
            break;
          }
        }

        results.push({
          ...base, deterministic: true,
          pass: Boolean(found),
          detail: found
            ? (hit || byName ? `trouvé : ${found.name}` : `trouvé : ${found.name} (nom différent de « ${wantName ?? "?"} » attendu)`)
            : "aucun livrable enregistré pour ce run",
        });
        break;
      }
      case "deliverables_min": {
        const want = Math.max(1, Number(args.count) || 1);
        results.push({ ...base, deterministic: true, pass: nonEmpty.length >= want, detail: `${nonEmpty.length}/${want} livrable(s) non vides` });
        break;
      }
      case "todos_all_done": {
        const parentIds = new Set(todos.filter((t) => t.parent_id).map((t) => t.parent_id));
        const leaves = todos.filter((t) => !parentIds.has(t.id));
        const open = leaves.filter((t) => t.status !== "done");
        results.push({
          ...base, deterministic: true,
          pass: leaves.length > 0 && open.length === 0,
          detail: leaves.length === 0 ? "pas de checklist" : open.length === 0 ? `${leaves.length}/${leaves.length} étapes closes` : `restant : ${open.map((t) => `${t.title}${t.status === "blocked" ? " (bloqué)" : ""}`).slice(0, 4).join(", ")}`,
        });
        break;
      }
      case "http_ok": {
        const url = String(args.url ?? "");
        const r = await probeUrl(url);
        results.push({ ...base, deterministic: true, pass: r.pass, skipped: r.skipped, detail: r.detail });
        break;
      }
      case "file_exists":
      case "command_exits_zero": {
        const r = opts.probe ? await opts.probe(c.kind, args).catch(() => null) : null;
        if (!r) results.push({ ...base, deterministic: true, pass: true, skipped: true, detail: "non vérifiable (pas d'exécuteur disponible)" });
        else results.push({ ...base, deterministic: true, pass: r.pass, detail: r.detail });
        break;
      }
      case "text_contains": {
        // Keyword match, not literal-phrase match. The planner writes needles
        // like "secteurs où l'impact est déjà mesurable"; no report ever
        // contains that exact string, so the check failed on every correct run.
        // What it is really asking is whether the subject is covered.
        const needle = String(args.needle ?? "").toLowerCase().trim();
        const hay = `${finalOutput}\n${deliverables.map((d) => d.content ?? "").join("\n")}`.toLowerCase();
        if (!needle) { results.push({ ...base, deterministic: true, pass: true, detail: "rien à chercher" }); break; }
        const words = needle
          .normalize("NFD").replace(/[̀-ͯ]/g, "")
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 3 && !/^(dans|pour|avec|est|sont|leur|plus|tout|deja|ou)$/.test(w));
        const flat = hay.normalize("NFD").replace(/[̀-ͯ]/g, "");
        const hits = words.filter((w) => flat.includes(w));
        // Literal hit, or two thirds of the significant words present.
        const pass = hay.includes(needle) || (words.length > 0 && hits.length >= Math.ceil(words.length * 0.66));
        results.push({
          ...base, deterministic: true, pass,
          detail: pass
            ? `« ${needle} » couvert (${hits.length}/${words.length} termes)`
            : `sujet « ${needle} » peu couvert (${hits.length}/${words.length} termes présents)`,
        });
        break;
      }
      case "judge":
        judgeQueue.push(c);
        break;
    }
  }

  // ── LLM reviewer, batched, LAST resort ────────────────────────────────────
  if (judgeQueue.length > 0) {
    const verdicts = await judgeChecks(judgeQueue, contract, finalOutput, deliverables).catch(() => null);
    for (const c of judgeQueue) {
      const v = verdicts?.[c.id];
      results.push({
        id: c.id, label: c.label, kind: "judge", required: c.required !== false,
        deterministic: false,
        // No verdict = do not block. A judge that failed to answer must never
        // hold a finished run hostage.
        pass: v ? v.pass : true,
        skipped: !v,
        detail: v ? v.detail : "juge indisponible — critère non bloquant",
      });
    }
  }

  const gaps = results.filter((r) => r.required && !r.pass && !r.skipped).map((r) => `${r.label} → ${r.detail}`);
  const soft = results.filter((r) => !r.required && !r.pass && !r.skipped).map((r) => `${r.label} → ${r.detail}`);
  // Soft failures never block, but they ARE handed to the agent when the run is
  // already going back into the loop — free extra quality for no extra round.
  return { pass: gaps.length === 0, results, gaps, soft };
}

async function probeUrl(url: string): Promise<{ pass: boolean; detail: string; skipped?: boolean }> {
  if (!/^https?:\/\//i.test(url)) return { pass: true, skipped: true, detail: "URL non testable" };
  // A private / local host is unreachable FROM the edge even when it is up for
  // the user — never fail a run on that.
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[?::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url)) {
    return { pass: true, skipped: true, detail: "hôte privé — non joignable depuis le backend" };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal });
    clearTimeout(t);
    return { pass: res.status < 400, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { pass: false, detail: `injoignable (${e instanceof Error ? e.message.slice(0, 80) : "erreur réseau"})` };
  }
}

async function judgeChecks(
  checks: SuccessCheck[],
  contract: SuccessContract,
  finalOutput: string,
  deliverables: Array<{ kind: string; name: string; content: string | null; file_url: string | null }>,
): Promise<Record<string, { pass: boolean; detail: string }> | null> {
  const delivList = deliverables
    .map((d) => `- [${d.kind}] ${d.name} — ${d.content ? `${String(d.content).length} caractères` : d.file_url ?? "vide"}`)
    .join("\n") || "(aucun livrable)";
  const res = await callAi({
    task: "classification",
    provider: cheapProvider(),
    jsonMode: true,
    maxTokens: 700,
    systemPrompt:
      "You are a strict QA reviewer for an autonomous agent. For EACH criterion, decide whether the agent's output genuinely satisfies it. Judge only what is evidenced by the final report and the deliverables — an unsupported claim is a FAIL. " +
      'Return STRICT JSON: {"verdicts":[{"id":"c1","pass":true|false,"detail":"short concrete reason, in French"}]}',
    userPrompt: [
      `OBJECTIF: ${contract.goal}`,
      `\nCRITÈRES:\n${checks.map((c) => `- ${c.id}: ${String(c.args?.criterion ?? c.label)}`).join("\n")}`,
      `\nLIVRABLES PRODUITS:\n${delivList}`,
      `\nRAPPORT FINAL:\n${finalOutput.slice(0, 3500)}`,
    ].join("\n"),
  });
  const parsed = safeParseJson<{ verdicts?: Array<{ id?: string; pass?: boolean; detail?: string }> }>(res.content);
  if (!parsed?.verdicts) return null;
  const out: Record<string, { pass: boolean; detail: string }> = {};
  for (const v of parsed.verdicts) {
    if (!v?.id) continue;
    out[String(v.id)] = { pass: v.pass === true, detail: String(v.detail ?? "").slice(0, 200) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Progress fingerprint (stagnation detection)
// ---------------------------------------------------------------------------

export interface ProgressFingerprint {
  todos_done: number;
  todos_total: number;
  deliverables: number;
  /** Distinct tool signatures seen so far — grows when the agent tries new things. */
  tool_sigs: number;
  /** Total transcript size — grows even when nothing useful happens (not scored). */
  chars: number;
}

export async function fingerprintProgress(
  admin: SupabaseClient,
  runId: string,
  messages: ChatMessage[],
): Promise<ProgressFingerprint> {
  const [{ count: delivCount }, { data: runRow }] = await Promise.all([
    admin.from("internal_agent_deliverables").select("id", { count: "exact", head: true }).eq("run_id", runId),
    admin.from("internal_agent_runs").select("todos").eq("id", runId).maybeSingle(),
  ]);
  const todos = Array.isArray((runRow as { todos?: unknown } | null)?.todos)
    ? ((runRow as { todos: Array<{ id: string; status: string; parent_id?: string }> }).todos)
    : [];
  const parentIds = new Set(todos.filter((t) => t.parent_id).map((t) => t.parent_id));
  const leaves = todos.filter((t) => !parentIds.has(t.id));
  const sigs = new Set<string>();
  for (const m of messages) {
    for (const c of (m as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls ?? []) {
      if (c.function?.name) sigs.add(`${c.function.name}:${(c.function.arguments ?? "").slice(0, 120)}`);
    }
  }
  return {
    todos_done: leaves.filter((t) => t.status === "done").length,
    todos_total: leaves.length,
    deliverables: delivCount ?? 0,
    tool_sigs: sigs.size,
    chars: JSON.stringify(messages).length,
  };
}

/** Did this tick move the run forward? Progress = a step closed, a deliverable
 *  produced, or genuinely NEW ground covered (new tool signatures). Burning
 *  rounds re-running the same things with different arguments is not progress. */
export function hasAdvanced(prev: ProgressFingerprint | null, next: ProgressFingerprint): boolean {
  if (!prev) return true;
  if (next.todos_done > prev.todos_done) return true;
  if (next.deliverables > prev.deliverables) return true;
  if (next.todos_total > prev.todos_total) return true; // decomposition is progress
  // At least two genuinely new approaches tried this tick.
  return next.tool_sigs - prev.tool_sigs >= 2;
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export interface LoopSignals {
  /** The model produced a final answer this tick. */
  finished: boolean;
  roundsUsed: number;
  maxRounds: number;
  costUsd: number;
  maxCostUsd: number;
  /** Tool errors accumulated since the last re-plan. */
  errorCount: number;
  /** The identical-signature guard tripped. */
  loopDetected: boolean;
  /** Tools that failed ≥3 times in a row (circuit breaker). */
  brokenTools: string[];
  /** Consecutive ticks with no measurable progress. */
  stagnantTicks: number;
  replans: number;
  maxReplans: number;
}

export type LoopAction = "continue" | "replan" | "finalize" | "abort";

export interface LoopDecision {
  action: LoopAction;
  /** Short, user-facing (French) — traced and shown in the timeline. */
  reason: string;
  /** Messages to append to the transcript before the next round. */
  interventions: Array<{ tag: string; content: string }>;
  /** Move this run to the heavy reasoning model. */
  escalateModel: boolean;
  /** Consumes one re-plan credit. */
  consumesReplan: boolean;
}

export const STAGNATION_LIMIT = 3;   // ticks without progress before re-planning
const ERROR_FLOOD = 10;              // tool errors since the last re-plan

/** The single decision point of the loop. Pure: same signals → same decision,
 *  which is what makes the loop reproducible and testable. */
export function decideNext(s: LoopSignals): LoopDecision {
  const interventions: Array<{ tag: string; content: string }> = [];

  // A tool that keeps failing gets a course-correction nudge whatever else is
  // decided — it composes with continue AND with replan.
  if (!s.finished && s.brokenTools.length > 0) {
    interventions.push({
      tag: "circuit_breaker",
      content: `OUTIL(S) EN ÉCHEC RÉPÉTÉ : ${s.brokenTools.join(", ")} — a/ont échoué ≥3 fois d'affilée. N'insiste PAS de la même manière. Choisis : (a) une approche VRAIMENT différente (autre outil, autre source/paramètres), OU (b) marque l'étape concernée comme bloquée (update_todos status="blocked" + note) et CONTINUE le reste du plan. Ne bloque jamais tout le run sur un seul outil cassé — livre un résultat partiel utile plutôt que rien.`,
    });
  }

  // 1. Hard runaway: past every budget with no end in sight → stop cleanly.
  if (!s.finished && (s.roundsUsed >= s.maxRounds * 1.5 || (s.maxCostUsd > 0 && s.costUsd >= s.maxCostUsd * 2))) {
    return {
      action: "abort", escalateModel: false, consumesReplan: false, interventions,
      reason: `Budget très largement dépassé (${s.roundsUsed} rounds, $${s.costUsd.toFixed(3)}) — arrêt de la boucle.`,
    };
  }

  // 2. The model says it's done → go verify against the contract.
  if (s.finished) {
    return { action: "finalize", escalateModel: false, consumesReplan: false, interventions, reason: "L'agent a produit une réponse finale — vérification du contrat." };
  }

  // 3. Budget reached → wrap up with what exists (never end empty-handed).
  const overCost = s.maxCostUsd > 0 && s.costUsd >= s.maxCostUsd;
  if (s.roundsUsed >= s.maxRounds || overCost) {
    return {
      action: "finalize", escalateModel: false, consumesReplan: false, interventions,
      reason: overCost
        ? `Budget de coût atteint ($${s.costUsd.toFixed(3)} / $${s.maxCostUsd}) — finalisation avec l'acquis.`
        : `Budget d'étapes atteint (${s.roundsUsed}/${s.maxRounds}) — finalisation avec l'acquis.`,
    };
  }

  // 4. Stuck: looping, drowning in errors, or producing nothing for N ticks.
  const stagnating = s.stagnantTicks >= STAGNATION_LIMIT;
  if ((s.loopDetected || s.errorCount >= ERROR_FLOOD || stagnating) && s.replans < s.maxReplans) {
    const why = s.loopDetected
      ? "Boucle détectée (même appel répété)"
      : stagnating
      ? `Stagnation : ${s.stagnantTicks} ticks sans progrès mesurable`
      : `Trop d'erreurs accumulées (${s.errorCount})`;
    interventions.push({
      tag: "replan",
      content: s.loopDetected
        ? "STOP — you are LOOPING: you've repeated the same tool call with the same arguments several times and it is not working. Do NOT run it again. Step back and write a short REVISED plan: state why the approach fails, pick a genuinely different approach (different tool, different inputs, or split the step), then execute the new plan."
        : stagnating
        ? "STOP — you are BURNING STEPS WITHOUT PROGRESS: several rounds have produced no closed step and no deliverable. Step back and answer, in one short paragraph: what is actually blocking you, what you have already established, and what is the SHORTEST path to a usable result. Then update_todos (mark what is really done / blocked), narrow the scope if needed, and produce a concrete deliverable with what you already have — a partial but real result beats more exploration."
        : "STOP — you have accumulated many tool errors. Step back and RE-PLAN: list which steps of your plan are actually done, which failed and WHY (read the error messages), and write a short revised plan that works around the failures (different tool, different approach, or narrower scope). Then execute the revised plan. Do not repeat calls that already failed the same way.",
    });
    return {
      action: "replan", escalateModel: true, consumesReplan: true, interventions,
      reason: `${why} — replanification ${s.replans + 1}/${s.maxReplans}.`,
    };
  }

  // 5. Out of re-plan credits and still stuck → cut losses, deliver the partial.
  if ((s.loopDetected || stagnating) && s.replans >= s.maxReplans) {
    return {
      action: "finalize", escalateModel: false, consumesReplan: false, interventions,
      reason: `Toujours bloqué après ${s.replans} replanifications — finalisation avec le résultat partiel.`,
    };
  }

  return { action: "continue", escalateModel: false, consumesReplan: false, interventions, reason: "Progression normale." };
}

// ---------------------------------------------------------------------------
// Budgets & trace
// ---------------------------------------------------------------------------

/** Per-agent budgets, finally enforced. `max_steps` is authored as a number of
 *  PLAN steps (templates use 8-24), not of LLM rounds — a step costs several
 *  rounds — so it is expanded into a round budget and clamped to a sane range.
 *  The old hard-coded 400 becomes the ceiling, not the rule. */
export function resolveBudgets(agent: { max_steps?: number | null; max_run_cost_usd?: number | null }, mode: "chat" | "mission") {
  const steps = Number(agent.max_steps);
  const rounds = Number.isFinite(steps) && steps > 0 ? Math.round(steps * 15) : mode === "chat" ? 240 : 300;
  const cost = Number(agent.max_run_cost_usd);
  return {
    maxRounds: Math.min(Math.max(rounds, 60), 400),
    maxCostUsd: Number.isFinite(cost) && cost > 0 ? cost : 0, // 0 = no cost ceiling
  };
}

/** The audit record of one controller iteration. */
export function loopEventPayload(opts: {
  iteration: number;
  decision: LoopDecision;
  signals: LoopSignals;
  progress?: ProgressFingerprint;
  verdict?: ContractVerdict | null;
}): Record<string, unknown> {
  return {
    iteration: opts.iteration,
    action: opts.decision.action,
    reason: opts.decision.reason,
    escalated: opts.decision.escalateModel,
    signals: {
      rounds: `${opts.signals.roundsUsed}/${opts.signals.maxRounds}`,
      cost_usd: Number(opts.signals.costUsd.toFixed(4)),
      errors: opts.signals.errorCount,
      loop_detected: opts.signals.loopDetected,
      stagnant_ticks: opts.signals.stagnantTicks,
      replans: `${opts.signals.replans}/${opts.signals.maxReplans}`,
      broken_tools: opts.signals.brokenTools,
    },
    progress: opts.progress
      ? { steps: `${opts.progress.todos_done}/${opts.progress.todos_total}`, deliverables: opts.progress.deliverables, approaches: opts.progress.tool_sigs }
      : undefined,
    checks: opts.verdict?.results.map((r) => ({
      label: r.label, pass: r.pass, skipped: r.skipped ?? false,
      required: r.required, deterministic: r.deterministic, detail: r.detail,
    })),
    verdict: opts.verdict ? (opts.verdict.pass ? "pass" : "fail") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Step-level evidence
// ---------------------------------------------------------------------------

/** How many tool RESULTS the transcript holds since the last update_todos call.
 *  Seeds the per-tick evidence counter so a step completed at the end of tick N
 *  can still be closed at the start of tick N+1 — the evidence is in the
 *  transcript, not in the (rebuilt) tool context. */
export function evidenceSinceLastTodos(messages: ChatMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const calls = (m as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls ?? [];
    if (calls.some((c) => c.function?.name === "update_todos")) break;
    if (m.role === "tool" && !String(m.content ?? "").startsWith("ERROR")) count++;
  }
  return count;
}
