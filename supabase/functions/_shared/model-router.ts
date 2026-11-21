// Cost-aware model routing for the agent runtimes. Default to the CHEAP model
// and only pay for a stronger reasoning model when the task genuinely needs it
// (or when a run keeps failing and gets escalated). Purely heuristic — no extra
// LLM call — so classification itself is free.
//
// Tiers → concrete models are env-overridable so ops can retune without a deploy:
//   AGENT_MODEL_LIGHT     (default deepseek-chat)   greetings, acks, tiny Q&A
//   AGENT_MODEL_STANDARD  (default deepseek-chat)   normal tool-using work
//   AGENT_MODEL_HEAVY     (default deepseek-reasoner) deep reasoning / code / analysis

import { isModelAlias, LIGHT_MODEL, pinnedUpstream, routeAlias } from "./llm-upstream.ts";

export type ModelTier = "light" | "standard" | "heavy";

/** The inference providers we supply ourselves. A self-hosted endpoint
 *  (aiops_providers / RunPod) bypasses all of this — it carries its own model. */
export type Provider = "groq" | "deepseek";

const env = (k: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : undefined);

const hasKey = (p: Provider) => Boolean(env(p === "groq" ? "GROQ_API_KEY" : "DEEPSEEK_API_KEY"));

// ── DeepSeek only, for now ──────────────────────────────────────────────────
// Decision (2026-08-11): Groq leaves the rotation. Its tier caps tokens PER DAY,
// and a run that hit the cap died on a 34-minute reset while the other provider
// sat idle. One provider means one quota to reason about and no mid-run vendor
// switch. The failover machinery in ai.ts stays — flip this back to re-enable.
const GROQ_ENABLED = false;

/** Providers actually usable in this deployment, best-first. */
export function availableProviders(): Provider[] {
  const all = GROQ_ENABLED ? (["deepseek", "groq"] as Provider[]) : (["deepseek"] as Provider[]);
  return all.filter(hasKey);
}

/** The provider to use when nothing is pinned. DeepSeek first — it is markedly
 *  better at tool calling, which is the whole job here — then whatever is keyed. */
export function defaultProvider(): Provider {
  return availableProviders()[0] ?? "deepseek";
}

/**
 * The provider for the runtime's own cheap side-calls — routing, classification,
 * contract derivation, the QA judge. Groq is the fast/cheap one and these are
 * throwaway calls, but hard-coding it broke every deployment that only has a
 * DeepSeek key: those calls threw, and the features degraded silently.
 */
export function cheapProvider(): Provider {
  return GROQ_ENABLED && hasKey("groq") ? "groq" : defaultProvider();
}

/**
 * Le modèle des mêmes appels annexes. Sur une passerelle imposée (Azure AI
 * Foundry, LiteLLM), c'est son déploiement léger (AZURE_OPENAI_DEPLOYMENT_LIGHT,
 * LLM_MODEL_LIGHT) : un juge qui répond « pass » n'a pas besoin du modèle qui
 * écrit les rapports, et il ne doit pas puiser dans son quota de tokens par
 * minute. Ailleurs, rien : le fournisseur garde son modèle par défaut.
 */
export function cheapModel(): string | undefined {
  try {
    // La route des appels annexes (« judge »), sinon le palier léger : un
    // connecteur peut dédier un modèle à ces jugements, sans y être obligé.
    return pinnedUpstream() ? routeAlias("light", "judge") : undefined;
  } catch {
    return undefined; // configuration incomplète : l'appel lui-même le dira
  }
}

/**
 * Which provider should run this agent?
 *
 * `internal_agents.model` has carried two different meanings since 0025: a
 * PROVIDER alias ("groq", "deepseek") and, in some rows, a raw model id. Both
 * are resolved here so the setting in the UI actually decides something —
 * before this, the column was written by the Model dropdown and read by nobody,
 * so every agent silently ran on DeepSeek.
 *
 * A pinned provider whose key is missing degrades to an available one rather
 * than hard-failing the run: a misconfigured secret must not take the agent
 * offline.
 */
export function resolveProvider(modelSetting?: string | null): Provider {
  const wanted = pinnedProvider(modelSetting);
  if (!wanted) return defaultProvider();
  // A provider that is pinned but DISABLED falls back too, not just one whose
  // key is missing: an agent someone configured on Groq months ago keeps
  // working instead of failing every run.
  return availableProviders().includes(wanted) ? wanted : defaultProvider();
}

/**
 * What the agent's setting ASKED for, before availability is considered.
 * Null when the value names no provider of ours ("gpt-4", "", a legacy row).
 *
 * Separated from `resolveProvider` so the runtime can tell the difference
 * between "this agent is on DeepSeek" and "this agent asked for Groq and
 * silently didn't get it". Without that distinction, a missing GROQ_API_KEY is
 * indistinguishable from a broken switch — the fallback is deliberate (a
 * missing secret must not take agents offline) but it must never be silent.
 */
export function pinnedProvider(modelSetting?: string | null): Provider | null {
  const raw = String(modelSetting ?? "").trim().toLowerCase();
  if (raw === "groq" || /llama|mixtral|gemma|kimi|qwen|gpt-oss/.test(raw)) return "groq";
  if (raw === "deepseek" || raw.startsWith("deepseek")) return "deepseek";
  return null;
}

/** Human-readable reason when the agent is NOT running on what it asked for. */
export function providerMismatchNote(modelSetting?: string | null): string | null {
  const wanted = pinnedProvider(modelSetting);
  if (!wanted || hasKey(wanted)) return null;
  const got = defaultProvider();
  return `Cet agent est configuré sur « ${wanted} », mais la clé ${wanted === "groq" ? "GROQ_API_KEY" : "DEEPSEEK_API_KEY"} n'est pas configurée sur le backend — le run tourne sur « ${got} ». Ajoutez le secret pour que le choix soit respecté.`;
}

/**
 * Does this model id belong to that provider? Guards the one failure mode that
 * makes provider switching look broken from the outside: a persisted run whose
 * `provider` and `model` disagree (a DeepSeek id sent to Groq) gets a 400 that
 * reads like an outage.
 */
export function modelMatchesProvider(model: string | null | undefined, provider: Provider): boolean {
  const m = String(model ?? "").trim().toLowerCase();
  if (!m) return true; // no id → the caller's default for that provider applies
  // A route alias (`@code|heavy`) names no vendor: the gateway or the agent's
  // connector translates it, and without one it falls back to the default.
  if (isModelAlias(m)) return true;
  if (m === "groq" || m === "deepseek") return false; // raw provider alias is not a concrete model id
  return provider === "deepseek" ? m.startsWith("deepseek") : !m.startsWith("deepseek");
}
/** Prefer an explicit environment override only when it is compatible with the provider. */
export function providerAwareOverride(modelOverride: string | null | undefined, provider: Provider): string | null {
  const candidate = String(modelOverride ?? "").trim();
  if (!candidate) return null;
  return modelMatchesProvider(candidate, provider) ? candidate : null;
}
// Short greetings / acknowledgements that never need a strong (or any) model.
const LIGHT_RE = /^\s*(hi|hey|hello|yo|salut|bonjour|coucou|merci+|thanks?|thx|ok(ay)?|d'?accord|yes|yep|yup|no|nope|non|oui|super|great|cool|nice|bravo|parfait|top|ping|test|👍|🙏|❤️)\b[\s!.,👍🙏🎉]*$/i;

// Signals that a task warrants the stronger reasoning model.
const HEAVY_RE = /\b(analy[sz]e?|analyse|mod[eè]l|architecture?|refactor|optimi[sz]e|optimise|debug|d[ée]bogue|algorithm|algorithme|prove|d[ée]montre|derive|pipeline|dataset|jeu de donn[ée]es|train(ing)?|entra[iî]ne|regression|r[ée]gression|vulnerab|vuln[ée]rab|exploit|pentest|migrat|benchmark|orchestrat|multi[-\s]?step|multi[-\s]?[ée]tapes|reason|raisonne|strateg|strat[ée]gie|plan\s+complet)\b/i;

/**
 * Classify a task/turn into a cost tier from its text.
 * @param text  the user message (chat) or the mission brief.
 * @param opts.mode  "chat" turns can be light; missions are never "light".
 * @param opts.continuation  a "continue"/"poursuis" turn is not a greeting.
 */
export function classifyTier(text: string, opts?: { mode?: "chat" | "mission"; continuation?: boolean }): ModelTier {
  const t = (text || "").trim();
  if (!t) return "light";
  const mission = opts?.mode === "mission";
  if (!mission && !opts?.continuation && (LIGHT_RE.test(t) || t.length < 24)) return "light";
  if (HEAVY_RE.test(t) || t.length > 800) return "heavy";
  return "standard";
}

// The two models we run on, and the only ones a tier or an override may resolve
// to. Groq's small models are BANNED, not deprecated: `llama-3.1-8b-instant` is
// capped at 6 000 tokens/minute on the on-demand tier, so a single turn carrying
// a real toolbox dies on a 413 ("Request too large") — "cheap" there means
// "cannot run our agents at all". The ban is enforced here rather than by fixing
// an env var, because the value can also come from a stale secret or a persisted
// run row, and one bad id anywhere brings the same 413 back.
//
// Groq a arrêté `llama-3.3-70b-versatile` le 16/08/2026 : depuis, la bascule
// « DeepSeek à sec → Groq » rendait un 404 model_not_found, et tous les runs
// planifiés mouraient (constaté le 10/11/2026). Son remplaçant officiel est
// gpt-oss-120b, qui appelle les outils (un à la fois).
export const GROQ_MODEL_ID = "openai/gpt-oss-120b";
export const DEEPSEEK_MODEL_ID = "deepseek-chat";       // DeepSeek V4
export const DEEPSEEK_REASONER = "deepseek-reasoner";   // DeepSeek V4 reasoning

// llama-3.3-70b-versatile rejoint la liste : arrêté chez Groq, il ne peut venir
// que d'une ligne de run ou d'un secret anciens, et ramènerait le 404.
const BANNED_MODELS = /(llama-?3(\.1)?-?8b|8b-instant|gemma|mixtral|llama-?3(\.[12])?-?(1|3)b|llama-3\.3-70b-versatile)/i;

/**
 * Force a model id onto a supported one. Any banned/empty/foreign id becomes the
 * provider's default, so no code path can route a run to a model we don't run on.
 */
export function sanitizeModel(
  model: string | null | undefined,
  provider: Provider,
  fallback?: string,
): string {
  const def = fallback ?? (provider === "groq" ? GROQ_MODEL_ID : DEEPSEEK_MODEL_ID);
  const m = String(model ?? "").trim();
  if (!m || BANNED_MODELS.test(m)) return def;
  if (!modelMatchesProvider(m, provider)) return def;
  return m;
}

/**
 * Resolve a tier to a concrete model id FOR A GIVEN PROVIDER (env-overridable).
 *
 * The provider argument is not cosmetic: the tier names are ours, the model ids
 * are theirs. Returning `deepseek-chat` to a run pinned on Groq produces a 400
 * on every round — which is exactly how "switching provider" used to fail,
 * silently and unrecoverably, since the tier defaults were DeepSeek-only.
 */
export function modelForTier(tier: ModelTier, provider: Provider = defaultProvider()): string {
  if (provider === "groq") {
    if (tier === "heavy") return sanitizeModel(env("AGENT_MODEL_GROQ_HEAVY"), "groq");
    if (tier === "light") return sanitizeModel(env("AGENT_MODEL_GROQ_LIGHT"), "groq");
    return sanitizeModel(env("AGENT_MODEL_GROQ_STANDARD"), "groq");
  }
  if (tier === "heavy") return sanitizeModel(env("AGENT_MODEL_HEAVY"), "deepseek", DEEPSEEK_REASONER);
  if (tier === "light") return sanitizeModel(env("AGENT_MODEL_LIGHT"), "deepseek");
  return sanitizeModel(env("AGENT_MODEL_STANDARD"), "deepseek");
}

// ---------------------------------------------------------------------------
// Request profile — WHICH model, not only how strong
//
// The tier says how much reasoning a request needs. Some requests also need a
// particular KIND of model: one that writes code well, one that reads images,
// one with a long context window. A connector with routes per criterion
// (llm-upstream: ModelRoutes) answers each with its own model; the alias
// `@code|heavy` asks for "the code model, else the heavy one", so a connector
// without a code route still gets a sensible model. Deterministic and free —
// no LLM call to decide which LLM to call.
// ---------------------------------------------------------------------------

export type ModelNeed = "code" | "vision" | "long_context";

// Volontairement étroit : « en fonction de », « une classe », « un script
// vidéo » sont du français courant, pas du code.
const CODE_RE = /```|\b(code source|du code|le code|ce code|coder|bug|stack ?trace|traceback|exception|refactor|r[ée]usinage|compil\w*|typescript|javascript|python|golang|kotlin|php|sql|regex|dockerfile|kubernetes|terraform|api rest|endpoint|unit tests?|tests? unitaires?|pull request|repo(sitory)?|d[ée]p[oô]t git)\b/i;
const FILE_RE = /\b[\w./-]+\.(tsx?|jsx?|py|go|rs|java|kt|swift|php|rb|sql|sh|ps1|ya?ml|toml|json|css|html|vue|svelte|c|cpp|h|cs)\b/i;
const IMAGE_INPUT_RE = /data:image\/|https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?(\s|$)/i;
/** Au-delà, on demande un modèle à longue fenêtre quand le connecteur en a un. */
const LONG_CONTEXT_CHARS = 60_000;

/** The kind of model a request needs, if any — null for ordinary work. */
export function detectNeed(text: string, opts?: { contextChars?: number }): ModelNeed | null {
  const t = text || "";
  if ((opts?.contextChars ?? t.length) > LONG_CONTEXT_CHARS) return "long_context";
  if (IMAGE_INPUT_RE.test(t)) return "vision";
  if (CODE_RE.test(t) || FILE_RE.test(t)) return "code";
  return null;
}

/**
 * The model to ask for: a route ALIAS when something can translate it (a
 * pinned gateway, or the agent's own connector), the provider's tier model
 * otherwise. `@code|heavy` → the connector's code model, else its heavy model.
 */
export function modelForRequest(
  tier: ModelTier,
  need: ModelNeed | null,
  opts: { provider?: Provider; routed?: boolean },
): string {
  const routed = opts.routed ?? (() => { try { return !!pinnedUpstream(); } catch { return false; } })();
  return routed ? routeAlias(tier, need) : modelForTier(tier, opts.provider);
}

/** Convenience: classify + resolve in one call, honouring an explicit override. */
export function routeModel(
  text: string,
  opts?: { mode?: "chat" | "mission"; continuation?: boolean; override?: string | null; provider?: Provider },
): { tier: ModelTier; model: string } {
  const tier = classifyTier(text, opts);
  return { tier, model: opts?.override || modelForTier(tier, opts?.provider) };
}

// ---------------------------------------------------------------------------
// Request classification (Context Engine, étage 0)
//
// Chooses the model tier AND how much of the toolbox to ship. Purely
// deterministic — no LLM, no embedding — so classification itself is free.
//
// The point: a greeting used to carry the full toolbox (~59 schemas, 7-11k
// tokens) plus memory, for a five-token answer. It now carries one escape
// hatch (need_tools), which the model calls if the turn turns out to need real
// work — so the aggressive path has no silent failure mode.
// ---------------------------------------------------------------------------

export type ToolTier = "social" | "core" | "full";

/** Signals that the turn wants an ACTION even if it is short ("envoie", "crée",
 *  "lance", "ouvre", "supprime"…). These must never be classified `social`. */
const ACTION_RE =
  /\b(envoie|envoyer|cr[ée]e|cr[ée]er|lance|lancer|ouvre|ouvrir|supprime|supprimer|ajoute|ajouter|modifie|modifier|d[ée]ploie|d[ée]ployer|installe|installer|ex[ée]cute|ex[ée]cuter|cherche|chercher|trouve|trouver|analyse|analyser|g[ée]n[èe]re|g[ée]n[ée]rer|[ée]cris|[ée]crire|corrige|corriger|teste|tester|compare|comparer|liste|lister|send|create|make|run|open|delete|add|update|deploy|install|execute|search|find|generate|write|fix|test|compare|list|build|check)\b/i;

export interface RequestClass {
  /** Model tier for this turn. */
  model: ModelTier;
  /** How much of the toolbox to expose. */
  tools: ToolTier;
}

/**
 * Classify a turn into { model tier, tool tier }.
 *
 * @param text  the user message (chat) or the mission brief.
 * @param opts.mode         missions are never `social`.
 * @param opts.continuation a "continue"/"poursuis" turn resumes real work.
 * @param opts.hasToolHistory  tools were already used in this thread — the turn
 *                             is part of ongoing work, not small talk.
 */
export function classifyRequest(
  text: string,
  opts?: { mode?: "chat" | "mission"; continuation?: boolean; hasToolHistory?: boolean },
): RequestClass {
  const t = (text || "").trim();
  const model = classifyTier(t, opts);
  const mission = opts?.mode === "mission";

  // Missions always mean work.
  if (mission) return { model, tools: "full" };

  // A greeting/ack ONLY when it is short, matches the light pattern, carries no
  // action verb, is not a continuation, and no tool has run in this thread yet.
  const isSocial =
    !opts?.continuation &&
    !opts?.hasToolHistory &&
    LIGHT_RE.test(t) &&
    !ACTION_RE.test(t) &&
    t.length < 60;
  if (isSocial) return { model, tools: "social" };

  // Heavy turns get the whole toolbox up front — a deep task that has to
  // discover its own tools wastes rounds. Everything else starts on the core
  // set and widens itself via load_toolset when it actually needs to.
  //
  // A turn that survived the social test is REAL WORK, so it never runs on the
  // cheapest tier even when it is short ("lance les tests" is 15 characters and
  // classifyTier would call it light).
  return { model: model === "light" ? "standard" : model, tools: model === "heavy" ? "full" : "core" };
}

/** Force the named connected-app wrapper for an explicit read/lookup request. */
export function preferredIntegrationTool(task: string, toolNames: string[]): string | null {
  if (!/\b(regarde|regarder|voir|vois|consulte|consulter|affiche|afficher|montre|montrer|liste|lister|récupère|récupérer|analyse|analyser|cherche|chercher|donne|donner|stats?|statistiques|chiffres|analytics|performances?|metrics?|show|list|get|fetch|check|read|view|statistics)\b/i.test(task)) {
    return null;
  }
  const normalizedTask = task.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  for (const name of toolNames) {
    const match = /^use_([a-z0-9_]+)$/i.exec(name);
    if (!match) continue;
    const toolkit = match[1].replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (toolkit.length >= 4 && normalizedTask.includes(toolkit)) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Class-based context budgets (Context Engine, étage 2)
//
// The compaction window is not one-size-fits-all: a `social` turn (a greeting,
// a "thanks") keeps only a tiny recency window, while a `full` turn (mission,
// heavy analysis) needs the recent transcript to cover a long working pipeline.
// Scaling the window by the request class spends cache/tokens where the run
// actually reads history, and trims faster where it does not.
// ---------------------------------------------------------------------------

export interface ContextBudget {
  /** Start trimming once the transcript is this heavy. */
  triggerChars: number;
  /** Keep roughly this much recent transcript after a compaction. */
  windowChars: number;
  /** Le même seuil en TOKENS du prompt réellement envoyé (système, outils,
   *  transcrit compacté), comparé à la mesure du fournisseur
   *  (context-checkpoint.ts). La fenêtre gardée reste en caractères. */
  triggerTokens: number;
}

/** Per-class context budgets. The char thresholds are the fallback until a
 *  round has been measured; the token ones are compared with what the
 *  provider actually billed (prompt_tokens), tools and system included —
 *  hence a little above the char threshold converted at ~3.5 chars/token. */
export function contextBudgetFor(tools: ToolTier): ContextBudget {
  switch (tools) {
    case "social":
      return { triggerChars: 40_000, windowChars: 24_000, triggerTokens: 16_000 };
    case "core":
      return { triggerChars: 110_000, windowChars: 64_000, triggerTokens: 42_000 };
    case "full":
    default:
      // The pre-classification default kept ~80k chars; "full" (missions, heavy
      // analysis) gets the most headroom since it pipelines across many rounds.
      return { triggerChars: 160_000, windowChars: 96_000, triggerTokens: 62_000 };
  }
}
