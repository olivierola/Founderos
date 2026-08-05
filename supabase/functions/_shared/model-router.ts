// Cost-aware model routing for the agent runtimes. Default to the CHEAP model
// and only pay for a stronger reasoning model when the task genuinely needs it
// (or when a run keeps failing and gets escalated). Purely heuristic — no extra
// LLM call — so classification itself is free.
//
// Tiers → concrete models are env-overridable so ops can retune without a deploy:
//   AGENT_MODEL_LIGHT     (default deepseek-chat)   greetings, acks, tiny Q&A
//   AGENT_MODEL_STANDARD  (default deepseek-chat)   normal tool-using work
//   AGENT_MODEL_HEAVY     (default deepseek-reasoner) deep reasoning / code / analysis

export type ModelTier = "light" | "standard" | "heavy";

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

const env = (k: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : undefined);

/** Resolve a tier to a concrete model id (env-overridable). */
export function modelForTier(tier: ModelTier): string {
  if (tier === "heavy") return env("AGENT_MODEL_HEAVY") || "deepseek-reasoner";
  if (tier === "light") return env("AGENT_MODEL_LIGHT") || "deepseek-chat";
  return env("AGENT_MODEL_STANDARD") || "deepseek-chat";
}

/** Convenience: classify + resolve in one call, honouring an explicit override. */
export function routeModel(text: string, opts?: { mode?: "chat" | "mission"; continuation?: boolean; override?: string | null }): { tier: ModelTier; model: string } {
  const tier = classifyTier(text, opts);
  return { tier, model: opts?.override || modelForTier(tier) };
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
    model === "light" &&
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
