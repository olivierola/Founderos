// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/run-tool-hooks.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// Les étapes qui entourent chaque appel d'outil d'un run, en hooks nommés.
//
// Elles vivaient dans une seule fonction du tick (loggingExecutor,
// internal-agent-run) ; elles sont maintenant inscrites une par une sur un
// HarnessHooks (harness-hooks.ts), dans cet ordre :
//
//   tool.before  search-dedup      une recherche déjà faite dans ce run est
//                                  refusée sans appel ; une recherche que la
//                                  mémoire du projet sait déjà est servie
//                                  depuis elle
//                log-call          l'appel entre dans la timeline
//                guardrails-call   CRITIQUE : garde-fous avant exécution
//                eval-stub         les faux outils des évals d'agent
//   tool.after   error-diagnosis   cause + ajustement ; une lecture en échec
//                                  passager est rejouée une fois
//                tool-health       disjoncteur par outil, preuve d'étape
//                guardrails-result CRITIQUE : garde-fous sur le résultat
//                log-result        le résultat entre dans la timeline
//                research-memory   trouvailles gardées hors du transcrit, et
//                                  ce que la mémoire savait déjà, joint
//
// Le comportement est celui de l'ancienne fonction, étape pour étape ; ce qui
// est nouveau est le diagnostic des erreurs. Chaque étape se teste seule.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolExecutor } from "./ai.ts";
import { RELEVANCE_FLOOR } from "./agent-memory.ts";
import { checkGuardrails, judgeGuardrails, mergeViolations, strongestEnforcement, type GuardrailRow } from "./guardrails.ts";
import type { HarnessHooks } from "./harness-hooks.ts";
import { touchAgentMemories } from "./internal-agent-tools.ts";
import { embedTexts, embeddingsAvailable, toVectorLiteral } from "./jina.ts";
import {
  autoRetryDelayMs, diagnoseToolError, judgeToolErrorCause, withDiagnosis,
  type ErrorCause, type FailedAttempt, type ToolErrorDiagnosis,
} from "./tool-error-diagnosis.ts";
import type { JudgeContext } from "./typesafe.ts";

type LogEvent = (kind: "status" | "tool_call" | "tool_result" | "guardrail" | "log", payload: Record<string, unknown>) => Promise<unknown>;

export const SEARCH_TOOLS = new Set(["web_search", "deep_research", "search_knowledge", "search_memory", "search_past_work"]);
export const RESEARCH_TOOLS = new Set(["web_search", "deep_research", "read_url", "http_get", "browse_web", "search_knowledge"]);

/** La signature normalisée d'une recherche : accents, mots vides et ordre
 *  retirés — « McKinsey France effectif » et « effectif McKinsey France » sont
 *  la même recherche. null : pas une recherche. */
export function querySig(name: string, args: Record<string, unknown>): string | null {
  if (!SEARCH_TOOLS.has(name)) return null;
  const q = String((args?.query ?? args?.q ?? "") || "").toLowerCase();
  if (!q) return null;
  const words = q
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(les|des|une|dans|pour|avec|sur|par|the|and|for|with|from)$/.test(w))
    .sort();
  return words.length ? `${name}:${[...new Set(words)].join(" ")}` : null;
}

/** Les arguments longs raccourcis pour la timeline (pas des mégaoctets par événement). */
export function compactArgs(a: unknown): unknown {
  if (!a || typeof a !== "object") return a;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
    out[k] = typeof v === "string" && v.length > 700 ? `${v.slice(0, 700)}… (+${v.length - 700} chars)` : v;
  }
  return out;
}

// ── Les deux mémoires de la recherche ────────────────────────────────────────
// TEMPORAIRE (ce run) : chaque résultat de recherche est écrit en entier dans
// les événements du run, que la compaction ne touche jamais, et relu avec
// recall_findings. PERMANENTE (entre runs) : le même matériau est condensé en
// fin de run dans internal_agent_memories, pour que la mission suivante sur le
// même sujet cherche en mémoire au lieu de repayer le web.

export interface ResearchMemory {
  findings: Array<{ tool: string; label: string; text: string }>;
  recordFinding: (tool: string, args: Record<string, unknown>, text: string) => Promise<void>;
  /** Après une recherche : ce que le projet savait déjà, à joindre en tête. */
  probeMemory: (query: string) => Promise<string>;
  /** Avant une recherche : une réponse fraîche et forte de la mémoire, servie
   *  à la place du web (réversible : la même requête relancée part sur le web). */
  answerFromMemory: (sig: string, query: string, searchSigs: Record<string, number>) => Promise<string>;
}

export function createResearchMemory(deps: {
  admin: SupabaseClient; runId: string; agentId: string; projectId: string | null; logEvent: LogEvent;
}): ResearchMemory {
  const { admin, runId } = deps;
  const findings: ResearchMemory["findings"] = [];
  let memoryProbes = 0;
  const probedIds = new Set<string>();
  type KnownHit = { id: string; content: string; created_at?: string | null; similarity: number | null };
  const knownCache = new Map<string, Promise<KnownHit[]>>();
  const recallKnown = (query: string): Promise<KnownHit[]> => {
    const key = query.trim().toLowerCase();
    if (!knownCache.has(key)) knownCache.set(key, (async () => {
      try {
        if (embeddingsAvailable() && deps.projectId) {
          const [qvec] = await embedTexts([query.slice(0, 500)], "retrieval.query").catch(() => [null]);
          if (qvec) {
            const { data } = await admin.rpc("match_project_memories", {
              p_project_id: deps.projectId, p_query_embedding: toVectorLiteral(qvec), p_match_count: 5,
            });
            const sem = ((data ?? []) as KnownHit[])
              .map((m) => ({ ...m, similarity: Number(m.similarity ?? 0) }))
              .filter((m) => (m.similarity ?? 0) >= Math.max(RELEVANCE_FLOOR, 0.45));
            if (sem.length) return sem;
          }
        }
        const { data } = await admin.from("internal_agent_memories")
          .select("id, content, created_at")
          .eq("project_id", deps.projectId)
          .in("kind", ["context", "learning", "fact"])
          .order("created_at", { ascending: false }).limit(60);
        const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        return ((data ?? []) as KnownHit[])
          .filter((m) => terms.filter((t) => String(m.content ?? "").toLowerCase().includes(t)).length >= 2)
          .map((m) => ({ ...m, similarity: null }));
      } catch { return []; }
    })());
    return knownCache.get(key)!;
  };
  const knownLine = (h: KnownHit) =>
    `- ${h.created_at ? `(${String(h.created_at).slice(0, 10)}) ` : ""}${String(h.content).slice(0, 700)}`;
  const MEMORY_ANSWER_MIN_SIM = 0.62;
  const MEMORY_ANSWER_MAX_AGE_DAYS = 14;

  return {
    findings,
    recordFinding: async (tool, args, text) => {
      const label = String(args?.query ?? args?.url ?? args?.q ?? "").slice(0, 200) || tool;
      const body = text.slice(0, 12_000);
      findings.push({ tool, label, text: body });
      await admin.from("internal_agent_run_events").insert({
        run_id: runId, agent_id: deps.agentId, kind: "log",
        payload: { finding: { tool, label, text: body } },
      }).then(() => {}, () => {});
    },
    probeMemory: async (query) => {
      if (memoryProbes >= 3 || !query.trim()) return "";
      memoryProbes++;
      const hits = (await recallKnown(query)).filter((h) => !probedIds.has(h.id)).slice(0, 3);
      if (hits.length === 0) return "";
      for (const h of hits) probedIds.add(h.id);
      touchAgentMemories(admin, hits.map((h) => h.id));
      await deps.logEvent("status", { message: `${hits.length} élément(s) déjà en mémoire sur ce sujet — joints aux résultats.` }).catch(() => {});
      return `⚡ DÉJÀ EN MÉMOIRE (travail antérieur sur ce sujet — vérifie la date, réutilise plutôt que de rechercher) :\n${hits.map(knownLine).join("\n")}\n\n— Résultats web ci-dessous —\n`;
    },
    answerFromMemory: async (sig, query, searchSigs) => {
      const servedCount = Object.keys(searchSigs).filter((k) => k.startsWith("mem:")).length;
      if (!query.trim() || searchSigs[`mem:${sig}`] || servedCount >= 3) return "";
      const fresh = (await recallKnown(query)).filter((h) =>
        h.similarity != null && h.similarity >= MEMORY_ANSWER_MIN_SIM &&
        !probedIds.has(h.id) &&
        (!h.created_at || Date.now() - Date.parse(h.created_at) <= MEMORY_ANSWER_MAX_AGE_DAYS * 86_400_000),
      ).slice(0, 3);
      if (fresh.length === 0) return "";
      searchSigs[`mem:${sig}`] = 1;
      for (const h of fresh) probedIds.add(h.id);
      touchAgentMemories(admin, fresh.map((h) => h.id));
      return `⚡ RÉPONDU DEPUIS LA MÉMOIRE (aucune recherche web lancée — ce sujet a déjà été recherché récemment dans ce projet) :\n${fresh.map(knownLine).join("\n")}\n\nSi c'est suffisant, utilise-le directement. Si c'est insuffisant ou périmé, relance EXACTEMENT la même requête : elle partira alors sur le web.`;
    },
  };
}

// ── Les hooks ────────────────────────────────────────────────────────────────

export interface RunHookDeps {
  logEvent: LogEvent;
  /** État persistant du run, muté en place (gardé d'un tick à l'autre). */
  searchSigs: Record<string, number>;
  toolFails: Record<string, number>;
  denials: { consecutive: number; total: number };
  /** Les dernières tentatives en échec par outil (pour explainRepeatedFailure). */
  toolErrors: Record<string, Array<FailedAttempt & { at?: string }>>;
  research: ResearchMemory;
  guardrails: GuardrailRow[];
  judgeCtx: JudgeContext;
  recordGuardrailIncident: (title: string, scope: "tool_call" | "tool_result", matched: string) => Promise<void>;
  evalStub: (name: string, args: Record<string, unknown>) => string | null;
  /** La preuve d'étape (ctx.loopEvidence), lue à chaque appel. */
  evidence: () => { results: number } | undefined;
  /** L'outil tel quel, pour rejouer une lecture en échec passager. */
  rawExecutor: ToolExecutor;
  /** Les outils qu'on peut rejouer sans risque (lectures idempotentes). */
  isIdempotent: (name: string) => boolean;
  schemaOf: (name: string) => Record<string, unknown> | undefined;
  /** Échéance du tick (epoch ms) : pas de nouvelle tentative au-delà. */
  deadlineAt: number;
  /** Compteurs ajoutés à la télémétrie du tick. */
  stats: { diagnosed: number; auto_retried: number; auto_recovered: number; by_cause: Partial<Record<ErrorCause, number>> };
}

/** Les hooks dont le court-circuit dispense des étapes d'après (le résultat
 *  n'est pas celui d'un outil : refus de doublon, garde-fou). La réponse servie
 *  depuis la mémoire et le faux outil des évals, eux, les traversent toutes. */
const NOT_A_TOOL_RESULT = new Set(["search-dedup", "guardrails-call"]);

export function registerRunToolHooks(hooks: HarnessHooks, d: RunHookDeps): HarnessHooks {
  // ── tool.before ──────────────────────────────────────────────────────────
  hooks.onToolBefore("search-dedup", async ({ name, args }) => {
    // Une recherche que ce run a déjà faite : moins chère que l'appel, et bien
    // plus utile au modèle que les mêmes extraits une troisième fois.
    const sig = querySig(name, args ?? {});
    if (!sig) return;
    const seen = (d.searchSigs[sig] ?? 0) + 1;
    d.searchSigs[sig] = seen;
    if (seen > 1) {
      const distinct = Object.keys(d.searchSigs).filter((k) => !k.startsWith("mem:")).length;
      const msg = `ERROR: recherche déjà effectuée dans ce run (${seen}× « ${String(args?.query ?? "")} »). Ses résultats sont DÉJÀ dans ton contexte plus haut — les relancer ne donnera rien de neuf.\n`
        + `Tu as lancé ${distinct} recherches distinctes. Passe à l'exploitation : ouvre les URL les plus prometteuses avec read_url(url) pour en extraire les chiffres, puis écris tes sections avec report_section. `
        + `Si une donnée reste introuvable après lecture, écris « non publié » et avance — ne reformule pas la même requête.`;
      await d.logEvent("tool_call", { tool: name, args: compactArgs(args), deduped: true });
      await d.logEvent("tool_result", { tool: name, preview: msg.slice(0, 400), ok: false, deduped: true });
      return { result: msg };
    }
    if (name === "web_search" || name === "deep_research") {
      const fromMemory = await d.research.answerFromMemory(sig, String(args?.query ?? ""), d.searchSigs);
      if (fromMemory) {
        // La signature est décomptée : « relance la même requête » doit
        // atteindre le web, pas le refus de doublon ci-dessus.
        d.searchSigs[sig] = seen - 1;
        await d.logEvent("tool_call", { tool: name, args: compactArgs(args), from_memory: true });
        await d.logEvent("tool_result", { tool: name, preview: fromMemory.slice(0, 1000), ok: true, from_memory: true });
        await d.logEvent("status", { message: "Recherche servie depuis la mémoire du projet — appel web économisé." }).catch(() => {});
        return { result: fromMemory };
      }
    }
  });

  hooks.onToolBefore("log-call", async ({ name, args }) => {
    await d.logEvent("tool_call", { tool: name, args: compactArgs(args) });
  });

  // Testé AVANT l'exécution : un blocage empêche l'outil de jamais partir (le
  // modèle reçoit une ERROR explicative), warn/log ne font que tracer.
  hooks.onToolBefore("guardrails-call", async ({ name, args }) => {
    if (d.guardrails.length > 0) {
      const probe = `${name}\n${JSON.stringify(args ?? {})}`;
      const hits = mergeViolations(
        checkGuardrails(d.guardrails, "tool_call", probe),
        await judgeGuardrails(d.judgeCtx, d.guardrails, "tool_call", probe),
      );
      if (hits.length > 0) {
        const block = strongestEnforcement(hits) === "block";
        for (const v of hits) {
          await d.logEvent("guardrail", {
            scope: "tool_call", guardrail: v.title, category: v.category,
            enforcement: v.enforcement, tool: name, matched: v.matched, blocked: block,
          }).catch(() => {});
        }
        if (block) {
          d.denials.consecutive++;
          d.denials.total++;
          await d.recordGuardrailIncident(hits[0].title, "tool_call", hits[0].matched).catch(() => {});
          const msg = `ERROR: Action bloquée par le guardrail « ${hits[0].title} » (${hits[0].matched ? `correspondance : ${hits[0].matched}` : "règle de sécurité"}). Ne la contourne pas avec une variante : fais sans, ou explique à l'utilisateur (ask_user) pourquoi elle est nécessaire.`;
          await d.logEvent("tool_result", { tool: name, preview: msg.slice(0, 1000), ok: false, guardrail: true }).catch(() => {});
          return { result: msg };
        }
      }
    }
    // Passé les garde-fous : la série de refus est rompue.
    d.denials.consecutive = 0;
  }, { critical: true });

  hooks.onToolBefore("eval-stub", ({ name, args }) => {
    const stubbed = d.evalStub(name, args ?? {});
    return stubbed != null ? { result: stubbed } : undefined;
  });

  // ── tool.after ───────────────────────────────────────────────────────────
  hooks.onToolAfter("error-diagnosis", async (e) => {
    if (e.ok || (e.shortCircuitBy && NOT_A_TOOL_RESULT.has(e.shortCircuitBy))) return;
    let result = e.result;
    let diag: ToolErrorDiagnosis | null = diagnoseToolError(e.name, e.args, result, d.schemaOf(e.name));
    if (!diag) return;
    // Une lecture en échec passager (débit, panne, réseau, délai) est rejouée
    // une fois, ici, sans coûter de tour au modèle. Jamais un appel à effet :
    // son effet est inconnu, le rejouer pourrait le doubler.
    const delay = autoRetryDelayMs(diag, result, d.isIdempotent(e.name));
    if (delay != null && Date.now() + delay + 5_000 < d.deadlineAt && !e.signal?.aborted && !e.shortCircuitBy) {
      d.stats.auto_retried++;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const again = String(await d.rawExecutor(e.name, e.args, { signal: e.signal, callId: e.callId }).catch((err) => `ERROR: ${err instanceof Error ? err.message : String(err)}`));
      if (!/^\s*(ERROR|ERREUR)\b/.test(again)) {
        d.stats.auto_recovered++;
        await d.logEvent("status", { message: `${e.name} : ${diag.label}, réussi à la nouvelle tentative automatique.` }).catch(() => {});
        return again;
      }
      result = again;
      diag = diagnoseToolError(e.name, e.args, result, d.schemaOf(e.name)) ?? diag;
    }
    // Les règles n'ont rien reconnu : Jev classe la cause (une seconde).
    if (diag.cause === "unknown") {
      diag = await judgeToolErrorCause(d.judgeCtx, e.name, e.args, result, d.schemaOf(e.name)).catch(() => null) ?? diag;
    }
    d.stats.diagnosed++;
    d.stats.by_cause[diag.cause] = (d.stats.by_cause[diag.cause] ?? 0) + 1;
    const history = (d.toolErrors[e.name] ??= []);
    history.push({ args: e.args, error: result.slice(0, 600), cause: diag.cause, at: new Date().toISOString() });
    if (history.length > 3) history.splice(0, history.length - 3);
    return withDiagnosis(result, diag);
  });

  hooks.onToolAfter("tool-health", (e) => {
    if (e.shortCircuitBy && NOT_A_TOOL_RESULT.has(e.shortCircuitBy)) return;
    // Disjoncteur : un outil en échec 3 fois de suite (même avec des
    // arguments différents) est tenu pour cassé par le contrôleur.
    d.toolFails[e.name] = e.ok ? 0 : (d.toolFails[e.name] ?? 0) + 1;
    if (e.ok) delete d.toolErrors[e.name];
    // Preuve d'étape : un résultat réussi permet de fermer une étape de la
    // checklist (update_todos remet le compteur à zéro lui-même).
    const ev = d.evidence();
    if (e.ok && e.name !== "update_todos" && ev) ev.results++;
  });

  hooks.onToolAfter("guardrails-result", async (e) => {
    if (e.shortCircuitBy && NOT_A_TOOL_RESULT.has(e.shortCircuitBy)) return;
    if (d.guardrails.length === 0 || !e.result) return;
    const text = e.result.slice(0, 4000);
    const hits = mergeViolations(
      checkGuardrails(d.guardrails, "tool_result", text),
      await judgeGuardrails(d.judgeCtx, d.guardrails, "tool_result", text),
    );
    if (hits.length === 0) return;
    const block = strongestEnforcement(hits) === "block";
    for (const v of hits) {
      await d.logEvent("guardrail", {
        scope: "tool_result", guardrail: v.title, category: v.category,
        enforcement: v.enforcement, tool: e.name, matched: v.matched, blocked: block,
      }).catch(() => {});
    }
    if (!block) return;
    await d.recordGuardrailIncident(hits[0].title, "tool_result", hits[0].matched).catch(() => {});
    const redacted = `ERROR: Résultat bloqué par le guardrail « ${hits[0].title} » — le contenu renvoyé enfreint une règle de sécurité et n'est pas transmis.`;
    await d.logEvent("tool_result", { tool: e.name, preview: redacted.slice(0, 1000), ok: false, guardrail: true }).catch(() => {});
    // Marqué pour que log-result ne journalise pas le contenu retenu.
    return `${redacted}​`;
  }, { critical: true });

  hooks.onToolAfter("log-result", async (e) => {
    if (e.shortCircuitBy && NOT_A_TOOL_RESULT.has(e.shortCircuitBy)) return;
    if (e.result.endsWith("​")) return e.result.slice(0, -1); // déjà journalisé (garde-fou)
    await d.logEvent("tool_result", { tool: e.name, preview: e.result.slice(0, 1000), ok: e.ok });
  });

  hooks.onToolAfter("research-memory", async (e) => {
    // Une réponse servie depuis la mémoire n'est pas une trouvaille nouvelle ;
    // le faux outil d'une éval, si (comme avant).
    if (e.shortCircuitBy && e.shortCircuitBy !== "eval-stub") return;
    // Le résultat complet est gardé hors du transcrit, et la PREMIÈRE
    // recherche est enrichie de ce qu'on savait déjà. Sans jamais faire
    // échouer la recherche pour sa tenue de compte.
    if (!e.ok || !RESEARCH_TOOLS.has(e.name) || e.result.length <= 80) return;
    await d.research.recordFinding(e.name, e.args ?? {}, e.result).catch(() => {});
    if (e.name === "web_search" || e.name === "deep_research") {
      const known = await d.research.probeMemory(String((e.args as { query?: string })?.query ?? "")).catch(() => "");
      if (known) return `${known}${e.result}`;
    }
  });

  return hooks;
}
