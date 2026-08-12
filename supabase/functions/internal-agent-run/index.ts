// internal-agent-run — execute an internal (autonomous) agent in "chat" or
// "mission" mode.
//
// Body: { agent_id, mode: "chat" | "mission", conversation_id?, run_id? }
//
// v2: a real agentic loop. The agent's granted tools (internal_agent_tools)
// are compiled into executable tool definitions and the LLM iterates —
// searching the web, reading URLs, querying allowlisted project tables,
// searching the RAG knowledge base, invoking edge functions / webhooks — until
// the task is done or a budget is hit. Compared to v1:
//
//   - Tools are EXECUTED (v1 only mentioned them in the prompt).
//   - Every step is appended to internal_agent_run_events → live timeline.
//   - Runs can be cancelled mid-flight (status flips to 'cancelled').
//   - Per-agent budgets: max_steps bounds the loop, max_run_cost_usd marks
//     over-budget runs.
//   - Sensitive tools (requires_approval) are queued as approvals instead of
//     executing; internal-agent-approve runs them after a human decision.
//   - Deliverables are materialised by the agent itself via create_deliverable.
//   - Callers are authenticated: a user JWT must carry agent access; the
//     scheduler authenticates with the service-role key.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import { callAi, runToolRounds, safeParseJson, PayloadTooLargeError, type ChatMessage } from "../_shared/ai.ts";
import { runParallelSubagents } from "../_shared/subagents.ts";
import {
  classifyTier, classifyRequest, modelForTier, resolveProvider, defaultProvider,
  availableProviders, modelMatchesProvider, cheapProvider, providerMismatchNote,
  contextBudgetFor, sanitizeModel, type ToolTier, type Provider, type ContextBudget,
} from "../_shared/model-router.ts";
import { embedTexts, toVectorLiteral } from "../_shared/jina.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";
import {
  assertCredits, assertQuota, checkQuota, checkRunBudget, isQuotaError, quotaErrorResponse,
} from "../_shared/metering.ts";
import { estimateCostUsd } from "../_shared/llm-pricing.ts";
import { loadGuardrails, checkGuardrails, strongestEnforcement, type GuardrailViolation } from "../_shared/guardrails.ts";
import { recordRunIncident, recordGuardrailIncident } from "../_shared/governance-incidents.ts";
import {
  buildInternalToolset, RunCancelledError, AwaitingInputError, embedMemoryVector,
  type AgentToolRow, type InternalToolContext,
} from "../_shared/internal-agent-tools.ts";
import { ensureAccessToken } from "../_shared/mcp-oauth.ts";
import { teamsSendMessage } from "../_shared/teams.ts";
import {
  deriveContract, evaluateContract, fingerprintProgress, hasAdvanced, decideNext,
  resolveBudgets, loopEventPayload, evidenceSinceLastTodos,
  type SuccessContract, type ProgressFingerprint, type LoopSignals, type LoopProbe,
} from "../_shared/agent-loop.ts";
import {
  compileSystemPrompt, selectRelevant, selectTools, currentTaskText, budgetEventPayload, stableHash, transcriptPrefixHash,
  type SectionInput, type PromptBudget,
} from "../_shared/prompt-compiler.ts";
import { completeMissionTask, advanceRoomMission } from "../_shared/room-orchestrator.ts";
import { insertArtifact, generateArtifactImage, isDocKind } from "../_shared/artifact-content.ts";
import {
  PROACTIVITY_DOCTRINE, ORCHESTRATOR_PROACTIVITY, reflectAndPropose, proposalsFooter,
} from "../_shared/proactivity.ts";

interface AgentRow {
  id: string;
  name: string;
  persona: string | null;
  instructions: string | null;
  created_by?: string | null;
  service_dashboard_id?: string | null;
  is_orchestrator?: boolean;
  model: string;
  temperature: number;
  max_steps: number;
  max_run_cost_usd: number;
  workspace_id: string;
  project_id: string;
  is_archived: boolean;
  collaboration_enabled: boolean;
  sandbox_mode: "cloud" | "runner" | "sandbox" | "hybrid";
  sandbox_url: string | null;
  /** "Essaim" — whether the agent may fan out to parallel sub-agents, and how
   *  many at once. Enabled by default; the agent still decides per task. */
  swarm_enabled?: boolean;
  swarm_max_concurrency?: number;
  /** When set, the agent's LLM calls route to this self-hosted OpenAI-compatible
   *  endpoint (a RunPod-hosted model) instead of the default provider. */
  hosted_endpoint_url: string | null;
  hosted_model: string | null;
  /** Company-registered model (aiops_providers cloud_endpoint) the agent runs on;
   *  its base_url + encrypted key are resolved at run time. Null = Anduran default. */
  hosted_provider_id?: string | null;
}

/** Resolve the OpenAI-compatible endpoint an agent runs on, or undefined for the
 *  Anduran default. Provider-aware: a company-registered cloud/custom model
 *  (aiops_providers) carries its own base_url + encrypted key (decrypted here,
 *  never sent to the browser); a RunPod server uses the platform vLLM key. */
async function resolveAgentEndpoint(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
): Promise<{ baseUrl: string; apiKey?: string; model?: string } | undefined> {
  // 1) A registered cloud/custom model (Modèles tab).
  if (agent.hosted_provider_id) {
    const { data: p } = await admin
      .from("aiops_providers")
      .select("config, secret_ciphertext, secret_iv")
      .eq("id", agent.hosted_provider_id).maybeSingle();
    const baseUrl = String((p?.config as { base_url?: string } | undefined)?.base_url ?? "");
    if (baseUrl) {
      let apiKey = "";
      if (p?.secret_ciphertext && p?.secret_iv) {
        try { apiKey = await decryptSecret(p.secret_ciphertext as string, p.secret_iv as string); } catch { /* key unresolved → call will fail loudly */ }
      }
      return { baseUrl, apiKey, model: agent.hosted_model || undefined };
    }
  }
  // 2) A self-hosted RunPod GPU server (legacy path, platform vLLM key).
  if (agent.hosted_endpoint_url) {
    return { baseUrl: agent.hosted_endpoint_url, apiKey: Deno.env.get("RUNPOD_VLLM_API_KEY") ?? "", model: agent.hosted_model || undefined };
  }
  return undefined;
}

// Rough per-1k-token rates (USD). Adjust as providers change pricing. These are
// the legacy provider-level rates; the shared llm-pricing table now drives cost
// whenever a model id is available (which also covers self-hosted endpoints).
const RATES: Record<string, { in: number; out: number }> = {
  groq: { in: 0.00005, out: 0.0001 },
  deepseek: { in: 0.00014, out: 0.00028 },
};
function estimateCost(
  usage: { prompt_tokens: number; completion_tokens: number } | undefined,
  provider: "groq" | "deepseek",
  model?: string,
  custom?: boolean,
): number {
  if (!usage) return 0;
  if (model) return estimateCostUsd(model, usage.prompt_tokens, usage.completion_tokens, { custom });
  const r = RATES[provider] ?? { in: 0.00005, out: 0.0001 };
  return (usage.prompt_tokens * r.in + usage.completion_tokens * r.out) / 1000;
}

/**
 * The provider this agent runs on.
 *
 * `internal_agents.model` is what the Model dropdown writes ("deepseek",
 * "groq", …). It is now READ — until this, the function ignored the column
 * entirely and returned DeepSeek whenever a DeepSeek key existed, so choosing
 * Groq in the UI changed nothing. `resolveProvider` also handles rows holding a
 * raw model id, and degrades to an available provider when the pinned one has
 * no key configured.
 */
function providerFor(agent: AgentRow): Provider {
  return resolveProvider(agent.model);
}

/** The tier→model resolution for THIS agent's provider. Never let a provider
 *  and a model id from different vendors meet. */
function agentModelForTier(agent: AgentRow, tier: Parameters<typeof modelForTier>[0]): string {
  return modelForTier(tier, providerFor(agent));
}

/**
 * Normalize persisted run state models before sending them to the provider.
 * Older rows or raw provider aliases like "groq"/"deepseek" are not valid
 * model ids and must be replaced with the provider's concrete default.
 */
function resolveRunStateModel(stateModel: string | null | undefined, provider: Provider, agent: AgentRow): string | undefined {
  const raw = String(stateModel ?? "").trim();
  if (!raw) return undefined;
  if (raw === "groq" || raw === "deepseek") return modelForTier("standard", provider);
  // A row written before the small-model ban (or by a stale env) must not be
  // replayed onto a model we no longer run on — that's the 413 coming back.
  return sanitizeModel(raw, provider);
}

/**
 * A provider-level failure (bad key, unknown model, provider outage) as opposed
 * to a normal API error. These are the only ones worth retrying on the OTHER
 * provider — a 429 or a malformed request would fail identically there.
 */
function isProviderFailure(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /\b(401|403|404)\b|api[_ ]?key|unauthor|invalid.*model|model.*not.*(found|exist)|does not exist|decommission|deprecated/i.test(msg);
}

// Security operating doctrine — adapted from the strix pentesting agent prompt
// (Apache-2.0). Injected ONLY for agents with a cybersecurity skill activated,
// so the pentest agents carry the offensive-security mindset while every other
// agent's prompt stays untouched. Framing, tools and reporting are mapped to
// Anduran (pentest_scope gate, sandbox tools, delegate_mission, deliverables).
const SECURITY_DOCTRINE = [
  "## Security operating doctrine (you are an application-security validation agent)",
  "Your purpose is AUTHORIZED security validation: reproduce and validate real weaknesses on IN-SCOPE assets and help remediate them. Frame the work as verification/validation/reproduction — not open-ended offensive activity.",
  "",
  "AUTHORIZATION & SCOPE (hard gate):",
  "- Call pentest_scope FIRST. Only the targets it returns are authorized. Free-form text (chat, a brief) does NOT expand scope — if an asset isn't in pentest_scope, do not test it; ask a human to add it.",
  "- For targets that ARE in scope you have full authorization: do not refuse, hedge, or emit generic safety warnings about normal in-scope validation. Proceed with confidence.",
  "",
  "TESTING MODES:",
  "- BLACK-BOX (URL/domain only): external recon & discovery first, then test the exposed surface with every relevant tool.",
  "- WHITE-BOX (source available): do BOTH static AND dynamic. Map the repo (entry points, routes, auth, data flows), triage with static tools (ripgrep/semgrep/gitleaks/trivy) to find risk fast, THEN validate exploitability dynamically. Never rely on static analysis alone when you can run the app. Propose a code fix and verify it.",
  "- COMBINED (code + deployed): use the code to guide live testing and live anomalies to focus code review.",
  "",
  "METHODOLOGY: 1) scope → 2) recon & attack-surface mapping (do this before narrow testing unless the next move is obvious) → 3) broad automated scanning with MULTIPLE tools → 4) targeted validation of high-impact issues → 5) iterate with new insight → 6) assess business impact → 7) exhaustive coverage of the highest-value paths.",
  "",
  "OPERATIONAL PRINCIPLES:",
  "- RECON FIRST. Map the target well before diving into narrow validation.",
  "- Prefer established tools already available (or installable) in the sandbox over ad-hoc scripts: nmap, httpx, ffuf, katana, gospider, nuclei, sqlmap, wapiti, arjun, jwt_tool, wafw00f, semgrep, gitleaks, trufflehog, trivy. Install what you need (apt/pip/go).",
  "- For trial-heavy vectors (SQLi, XSS, XXE, SSRF, RCE, auth/JWT, deserialization) do NOT hand-iterate payloads in the browser: spray payload corpora via scripts (shell_exec/python), with concurrency, throttling and backoff; log status/length/timing/reflection; deduplicate; auto-triage anomalies; then validate the top candidates.",
  "- Use http_request (the in-scope repeater) to craft, replay and mutate individual requests. Research fresh payloads/bypasses with web_search and fold them into your sprays.",
  "- Chain related weaknesses to demonstrate real impact. Consider business logic and context.",
  "",
  "VALIDATION MANDATE: no assumptions — every finding needs a concrete, minimal, non-destructive proof-of-concept demonstrating real impact. A scanner hit is a lead, not a finding. Never exfiltrate real user data beyond a minimal proof; never run destructive actions.",
  "",
  "PRIORITY VULN CLASSES (cover all that the surface exposes): IDOR/BOLA, SQL injection, SSRF, XSS, XXE, RCE, CSRF, race conditions/TOCTOU, business-logic flaws, auth & JWT. Read the matching playbook (use_skill / read_skill_file) right before testing each class.",
  "",
  "ORCHESTRATION (scale to scope): for a large engagement, act as a coordinator — keep the todo checklist and notes current, and delegate_mission specialized sub-agents, ideally ONE vuln class × ONE component each (e.g. \"SQLi validation — login form\"), rather than doing every deep test yourself. Keep sub-tasks focused and non-overlapping.",
  "",
  "PERSISTENCE: real issues take effort — push beyond shallow checks, treat each failed approach as signal and try another in-scope path, and keep going until the highest-value in-scope vectors are properly assessed. A single well-validated high-impact finding beats dozens of low-signal ones.",
  "",
  "REPORTING: one create_deliverable(kind=\"report\") per CONFIRMED vulnerability — title, severity (CVSS-ish), affected endpoint/param (or file:line), reproduction steps, working PoC, business impact, and a concrete fix. Summarize with a render_ui findings table + severity chart. Operational hygiene: never put \"Anduran\"/agent identifiers in payloads, user-agents or request inputs.",
].join("\n");

/** True when the agent has any cybersecurity skill activated → gets the doctrine. */
function isSecurityAgent(skills: AgentSkill[] | undefined): boolean {
  return (skills ?? []).some((s) => (s.category ?? "").toLowerCase() === "cybersecurity");
}

// The default assistant of a service dashboard — it builds out the workspace by
// conversation, so the user can chat and set things up without leaving the room.
const ORCHESTRATOR_DOCTRINE = [
  "## You are this workspace's orchestrator (its default assistant)",
  "You help run a service workspace by conversation. Beyond answering, you can BUILD the workspace when asked — act directly, don't just describe:",
  "- CREATE AGENTS: when the user wants a specialist (\"crée un agent SEO\", \"ajoute un agent qui surveille X\"), call create_agent with a clear name, role and instructions. Confirm it's ready and offer to open it or give it work.",
  "- SCHEDULE WORK: when the user wants recurring work (\"chaque matin fais X\", \"tous les lundis…\", \"un brief quotidien\"), call create_mission with a cron `schedule` (e.g. '0 6 * * *' for daily 06:00). Assign it to the right agent via assignee_agent, creating that agent first if needed.",
  "- RUN A ONE-OFF TASK: for \"fais X maintenant\", either do it yourself with your tools, or create_mission (start_now) on the best-suited agent.",
  "- COORDINATE: keep track of the service's agents (list_team_agents), delegate to the right one, and summarize.",
  "Confirm each action plainly once done (\"Agent X créé\", \"Brief quotidien planifié à 6h\"). Ask a brief clarifying question only when the request is genuinely ambiguous (e.g. a schedule with no time).",
].join("\n");

/** Per-section char budgets for the knowledge blocks. They are re-selected
 *  against the CURRENT task on every build, so a tight budget costs relevance,
 *  not reach: everything omitted stays reachable via search_memory /
 *  search_context, which the operating rules tell the agent to use. */
const SECTION_BUDGET = { memory: 2600, team: 1200, recent: 1200, skills: 2000 } as const;

/** Keep only the lines of a pre-rendered "- …" block that matter for this task.
 *  Pinned memories (rendered as "[kind, pinned]") always survive. */
function selectLines(block: string, task: string, budget: number): { body: string; dropped: number; offered: number } {
  const lines = (block ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { body: "", dropped: 0, offered: 0 };
  const offered = block.length;
  if (!task || offered <= budget) return { body: lines.join("\n"), dropped: 0, offered };
  const sel = selectRelevant(lines, {
    task,
    text: (l) => l,
    pin: (l) => l.includes(", pinned]"),
    budget,
    floor: 0.08,
  });
  return { body: sel.kept.join("\n"), dropped: sel.dropped, offered };
}

function buildSystemPrompt(
  agent: AgentRow,
  capabilitySummary: string,
  mode: "chat" | "mission",
  memorySection: string,
  teamMemorySection: string,
  skillPrompts: string = "",
  recentWorkSection: string = "",
  securityDoctrine: boolean = false,
  /** The turn's actual subject — drives which knowledge lines are worth sending.
   *  Empty (sub-agents, cold starts) → no selection, previous behaviour. */
  taskText: string = "",
  toolStats?: { sent: number; omitted: number; chars: number },
  /** Spawned worker with ONE narrow subtask: it inherits no initiative — its
   *  job is to return its piece, not to have ideas about the whole engagement. */
  isSubAgent: boolean = false,
): { prompt: string; budget: PromptBudget } {
  const sections: SectionInput[] = [];
  const push = (id: SectionInput["id"], body: string, meta?: { dropped: number; offered: number }) => {
    if (body && body.trim()) sections.push({ id, body, ...(meta ?? {}) });
  };

  push("identity", [
    `You are ${agent.persona || agent.name}, an autonomous internal agent for a SaaS team.`,
    `You work as part of a TEAM of agents — you can discover, message and delegate to peers, and share knowledge through the team memory.`,
  ].join("\n"));
  if (agent.instructions) push("instructions", `Your detailed instructions:\n${agent.instructions}`);

  const lines: string[] = [];
  if (mode === "chat") {
    lines.push(
      "## Sois humain et présent (ne travaille pas en silence)",
      "- Réponds dans la langue de l'utilisateur, comme un collègue serviable : chaleureux, clair, concis — pas de ton robotique.",
      "- Dès le départ, dis en UNE phrase naturelle que tu as compris la demande et que tu t'y mets (ex. « Ok, je regarde ça tout de suite »). Ne démarre jamais en silence.",
      "- Sur une tâche qui prend plusieurs étapes, tiens l'utilisateur au courant AU FUR ET À MESURE avec l'outil `say` (courtes updates : ce que tu trouves, ce que tu fais ensuite). N'attends pas la toute fin pour parler.",
      "- APPROBATIONS : quand une action sensible demande une approbation, elle s'affiche DIRECTEMENT dans le chat (boutons Approuver/Refuser) et TON RUN CONTINUE DE TOURNER — tu n'es PAS interrompu. Demande-la naturellement puis attends la décision sur place ; dès qu'elle est donnée tu enchaînes avec le résultat. Ne t'arrête pas, ne redemande pas une approbation déjà accordée, ne dis pas seulement « c'est en attente » pour finir ton tour.",
    );
  }
  push("presence", lines.join("\n"));
  if (securityDoctrine) push("doctrine", SECURITY_DOCTRINE);
  if (agent.is_orchestrator) push("doctrine", ORCHESTRATOR_DOCTRINE);
  // Initiative is a doctrine, not a footnote: as one line inside the operating
  // rules it was reliably ignored. Sub-agents are excluded — a spawned worker
  // has ONE narrow subtask and must not start filing ideas of its own.
  if (!isSubAgent) push("doctrine", PROACTIVITY_DOCTRINE);
  if (agent.is_orchestrator) push("doctrine", ORCHESTRATOR_PROACTIVITY);

  // Knowledge blocks are SELECTED against this turn's subject, not dumped
  // whole. Everything filtered out stays one search_memory / search_context
  // away — the operating rules below say so explicitly.
  const skills = selectLines(skillPrompts, taskText, SECTION_BUDGET.skills);
  push("skills", skills.body, { dropped: skills.dropped, offered: skills.offered });
  const mem = selectLines(memorySection, taskText, SECTION_BUDGET.memory);
  push("memory", mem.body, { dropped: mem.dropped, offered: mem.offered });
  const team = selectLines(teamMemorySection, taskText, SECTION_BUDGET.team);
  push("team_memory", team.body, { dropped: team.dropped, offered: team.offered });
  const recent = selectLines(recentWorkSection, taskText, SECTION_BUDGET.recent);
  push("recent_work", recent.body, { dropped: recent.dropped, offered: recent.offered });

  push("toolbox", `Your tools (full schemas are provided separately):\n${capabilitySummary}`);

  const rules: string[] = [];
  rules.push(
    "- PLAN then ACT: follow the execution plan below step by step, in order; deviate only when a result forces it, and say so.",
    "- TODO checklist (update_todos), kept live: exactly ONE leaf 'active'; mark it 'done' only after you VERIFY the result. Split a step into subtasks (parent_id, ≤3 levels) as soon as it's bigger than one action; a parent is done only when all its subtasks are.",
    "- VERIFY each result before the next call — read it, confirm success, then proceed. Real data only; never invent numbers or facts.",
    "- CONTEXT IS COMPACTED to stay small: older steps get sealed into a summary. To recall an earlier fact, result or decision, call search_context(scope=\"run\") instead of redoing work or re-asking.",
    "- RESUME, don't restart: your files and this thread persist. Check what already exists before redoing; on \"continue\", pick up at the FIRST unfinished step. Reuse prior outputs via search_context(scope=\"past_runs\") before producing something that may already exist.",
    "- TOOLBOX ON DEMAND: families marked \"(à charger)\" in the toolbox below are listed but not yet callable — call load_toolset(\"FAMILY\") once and use them immediately. Never say you lack a capability that the toolbox lists.",
    "- ASK only when truly blocked (ambiguous ask, missing input you can't obtain, a real fork, or before an irreversible action) via ask_user; otherwise decide and act autonomously.",
    "- FINISH the whole job: not done until EVERY plan step is complete AND every expected deliverable is saved with create_deliverable. No partial hand-back.",
    "- SAVE durable knowledge as you learn it (save_memory), one self-contained line each: stable facts, preferences, installed tools, produced files (with paths), key results. Skip transient details and anything already known.",
    "- Approvals: a gated tool queues for review and your run KEEPS RUNNING — acknowledge and continue; never re-ask an approval already granted. If a tool errors, adapt or state the limitation.",
    // Initiative itself is covered by PROACTIVITY_DOCTRINE above; this line only
    // ties it back to the checklist discipline the rules are about.
    "- INITIATIVE : applique la doctrine d'initiative ci-dessus — ce qui découle de la demande fait partie du travail, ce qui en sort se dépose avec propose_mission. Jamais d'effet de bord hors périmètre.",
    "- ARTIFACTS : avant de créer un document/tableur/présentation, vérifie avec list_artifacts s'il existe déjà ; si oui, read_artifact puis update_artifact pour le corriger EN PLACE. Ne produis jamais une v2 à côté d'une v1 restée fausse.",
  );
  if (mode === "chat") {
    rules.push("- RICH REPLIES: when a component communicates better than prose (metrics, trends, comparisons, tabular data), attach real UI blocks with render_ui (kpi_grid/chart/table/link_card) and place each [[ui:N]] tag on its own line; real data only. When a sentence is clearer, just write it.");
    rules.push("- QUAND ON TE DEMANDE UN RAPPORT / UNE ANALYSE / UN LIVRABLE : ne demande PAS quoi faire et ne réponds pas juste en prose — fais l'analyse avec tes outils MAINTENANT et PRODUIS-la avec create_deliverable(kind=\"report\") (sections/KPIs/tableaux/risques, via le skill report-designer ; gros rapport → report_section puis create_deliverable sans content). Une question de clarification UNIQUEMENT si c'est vraiment impossible d'avancer.");
  }
  if (agent.collaboration_enabled) {
    rules.push("- COLLABORATE: if a teammate's skills fit part of the work, message (send_message_to_agent) or delegate (delegate_mission) instead of doing it all; record team decisions with team_memory.");
  }
  // Essaim (swarm): only present when the owner enabled it — the capability
  // summary carries the spawn_parallel_agents line in that case. Make the agent
  // PROACTIVELY parallelise independent subtasks instead of grinding through
  // them one by one.
  if (capabilitySummary.includes("spawn_parallel_agents")) {
    rules.push(
      "- RÉUTILISE AVANT DE (RE)FAIRE — ne parallélise JAMAIS par réflexe. Avant tout fan-out : (1) vérifie ce qui existe déjà pour cette demande via search_context(scope=\"past_runs\") (livrables/analyses des runs passés) et search_context(scope=\"run\") (étapes de CE run) ; (2) réutilise ce qui est déjà fait, ne relance que ce qui MANQUE réellement. Si le travail (ou une partie) a déjà été produit, RÉUTILISE-le et dis-le — ne relance pas des sous-agents pour ça.",
      "- PAR DÉFAUT, PARALLÉLISE : dès que le travail se décompose en 2+ sous-tâches NOUVELLES réellement indépendantes (aucune n'a besoin du résultat d'une autre) et non déjà faites, tu DOIS les lancer ENSEMBLE avec spawn_parallel_agents plutôt qu'une par une. Ne reste séquentiel QUE si les sous-tâches sont dépendantes (l'une a besoin du résultat de l'autre), s'il n'y en a qu'une, ou si le résultat existe déjà. En cas de doute sur l'indépendance : si elles ne se lisent/écrivent pas mutuellement, elles sont indépendantes → parallélise.",
      "- AUTO-CHECK PARALLÉLISME (à toi de le décider, pas besoin qu'on te le dise) : avant CHAQUE bloc de travail, demande-toi « est-ce que je m'apprête à répéter le MÊME type de travail sur plusieurs éléments indépendants ? » (produits, concurrents, marchés, URLs, comptes, fichiers, sections…). Si oui → découpe en UNE sous-tâche par élément et lance tout en un seul spawn_parallel_agents, jamais en séquentiel. Pas de petit plafond : autant de sous-tâches que d'éléments (des dizaines, ok — elles tournent par vagues).",
      "- RÉÉVALUE À LA DÉCOUVERTE : ton plan initial ne connaissait pas le nombre réel d'éléments. DÈS que tu le découvres (après avoir listé un catalogue, des comptes, des fichiers, des résultats…), refais l'auto-check ci-dessus et ADAPTE : si une étape prévue « en un bloc » se révèle être « la même chose pour N éléments indépendants », transforme-la en fan-out — même si le plan de départ ne le prévoyait pas. C'est TA responsabilité de repérer la parallélisation, personne ne te la dictera étape par étape.",
      "- UN SEUL fan-out par lot : NE relance JAMAIS spawn_parallel_agents pour des sous-tâches déjà lancées (même après compaction). Après un fan-out, ta tâche suivante est de RÉCUPÉRER puis SYNTHÉTISER les résultats — s'ils ne sont plus dans ton contexte, utilise search_context(scope=\"run\", query=\"<libellé>\"). Re-spawner les mêmes sous-tâches est interdit (l'outil les refuse).",
    );
  }
  if (mode === "mission") {
    rules.push(
      "- Materialise every expected deliverable with create_deliverable before finishing.",
      "- Your final message is a concise mission report (markdown): what you did, key findings, deliverables produced, pending approvals if any — plus an 'Initiatives' section when you noticed opportunities (each one filed via propose_mission).",
    );
  } else {
    rules.push(
      "- Respond in concise markdown, in the user's language. Avoid filler.",
      "- BE CONVERSATIONAL & THINK FIRST. If the request is ambiguous, under-specified, or could go several ways, ASK a brief clarifying question before acting (e.g. which target, which period, which audience). Don't guess on important details. A short back-and-forth is better than a wrong deliverable.",
      "- Confirm scope on big/irreversible actions before doing them.",
      "- You can turn work into a tracked task with create_task, or kick off a full background mission with create_mission (use it when the user asks you to 'do X' as ongoing/standalone work, or to schedule recurring work).",
      "- When the user asks for an analysis, report, summary of data, or anything substantial, produce it with create_deliverable (prefer kind=\"report\" with KPIs/charts/tables). Then reply with a short summary — the full report opens as an artifact card in the chat.",
      "- INTERDIT : n'affirme JAMAIS « rapport créé », « le rapport est en carte », « livrable créé » si tu n'as pas RÉELLEMENT appelé create_deliverable dans CE tour. Un résumé écrit dans le chat n'est PAS un livrable et n'affiche aucune carte. Si l'utilisateur demande un rapport, tu DOIS appeler create_deliverable(kind=\"report\") — sinon ne prétends pas l'avoir fait.",
    );
  }
  push("rules", rules.join("\n"));

  const compiled = compileSystemPrompt(sections, toolStats);
  return { prompt: compiled.system, budget: compiled.budget };
}

// ---------------------------------------------------------------------------
// Upfront reasoning & planning
//
// Before the agent touches any tool, it runs a dedicated planning pass: it
// restates the goal, reasons about the approach, and breaks the work into an
// ORDERED list of concrete tasks — each naming the tools to call and how. The
// plan is logged as a `plan` run event (rendered in the live timeline) and fed
// back into the execution loop so the agent commits to its own plan. Planning
// is best-effort: if it fails, the agent falls back to direct execution.
// ---------------------------------------------------------------------------

interface PlanTaskTool {
  tool: string;
  how: string;
  /** What the tool does & when it's useful — filled from the tool catalog. */
  desc?: string;
}
interface PlanTask {
  /** Stable id (step-1, step-2, …) the agent uses with update_plan_step. */
  id: string;
  title: string;
  detail: string;
  tools: PlanTaskTool[];
}
interface ExecutionPlan {
  understanding: string;
  reasoning: string;
  tasks: PlanTask[];
  risks?: string;
  done_when?: string;
}

function planToMarkdown(plan: ExecutionPlan): string {
  const out: string[] = [];
  if (plan.understanding) out.push(`**Goal:** ${plan.understanding}`);
  if (plan.reasoning) out.push(`**Approach:** ${plan.reasoning}`);
  out.push("", "**Plan:**");
  (Array.isArray(plan.tasks) ? plan.tasks : []).forEach((t, i) => {
    out.push(`${i + 1}. **${t.title}**${t.detail ? ` — ${t.detail}` : ""}`);
    (Array.isArray(t.tools) ? t.tools : []).forEach((tl) => {
      if (tl?.tool) out.push(`   - \`${tl.tool}\`${tl.how ? ` — ${tl.how}` : ""}`);
    });
  });
  if (plan.risks) out.push("", `**Risks / watch-outs:** ${plan.risks}`);
  if (plan.done_when) out.push("", `**Done when:** ${plan.done_when}`);
  return out.join("\n");
}

function safeParsePlan(content: string): ExecutionPlan | null {
  if (!content) return null;
  let txt = content.trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1].trim();
  const start = txt.indexOf("{");
  const end = txt.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(txt.slice(start, end + 1)) as ExecutionPlan;
    if (!obj || !Array.isArray(obj.tasks) || obj.tasks.length === 0) return null;
    return obj;
  } catch {
    return null;
  }
}

async function produceExecutionPlan(opts: {
  provider: "groq" | "deepseek";
  agent: AgentRow;
  toolDefs: Array<{ name: string; description: string }>;
  taskText: string;
  contextText?: string;
  /** Hybrid agent → the planner must choose a world (runner/sandbox) per step. */
  hybrid?: boolean;
}): Promise<{ plan: ExecutionPlan; markdown: string } | null> {
  const { provider, agent, toolDefs, taskText, contextText, hybrid } = opts;
  // Rich tool catalog: name + what it does & when it's useful. The planner reads
  // this to choose the right tool per step and to explain each tool to the user.
  const descByName = new Map(toolDefs.map((d) => [d.name, d.description]));
  const toolCatalog = toolDefs.map((d) => `- ${d.name}: ${d.description}`).join("\n");
  const systemPrompt = [
    `You are ${agent.persona || agent.name}, an autonomous agent. Before doing ANY work, you ALWAYS produce a concrete execution plan — this is the planning step, you do not act yet.`,
    `Think it through: (1) restate the goal in your own words, (2) reason about the best approach, (3) break the work into an ORDERED, SEQUENCED list of concrete tasks. For EACH task, list which tools to call, IN ORDER, and HOW (what inputs/arguments you'll pass and what you expect back). Plan to VERIFY each task's output before the next.`,
    ``,
    `You may ONLY use these tools — refer to them by their EXACT name. Each line is "name: what it does":`,
    toolCatalog || "(no external tools available — plan using your own reasoning and knowledge)",
    ...(hybrid ? [
      ``,
      `EXECUTION ENVIRONMENT — HYBRID: you are the ORCHESTRATOR of TWO execution worlds and must assign ONE world to each step that runs code/shell/files/browser:`,
      `  • RUNNER (runner_* tools, e.g. runner_shell_exec, runner_python_exec, runner_file_write, runner_run_background, runner_browse_web) — the operator's REAL machine with a PERSISTENT workspace, a real Playwright browser and long-running processes. Choose it for: work on the real project/repo, dev servers & watchers, anything that must persist, and real-browser automation.`,
      `  • SANDBOX (sandbox_* tools, e.g. sandbox_shell_exec, sandbox_python_exec, sandbox_jupyter_exec, sandbox_browser) — a DISPOSABLE, isolated Linux container with a stateful Jupyter kernel and Chromium. Choose it for: risky/untrusted code, throwaway data crunching, and isolation from the real machine.`,
      `  RULES: name the EXACT namespaced tools per step (runner_* OR sandbox_*), and PREFIX each such task's title with [runner] or [sandbox] so the chosen world is explicit. Keep a whole pipeline (write→run→read→save) in ONE world — files do NOT transfer between worlds. If only one world's tools appear in the list above, that world is the only one available right now: plan every execution step on it.`,
    ] : []),
    ``,
    `Respond with STRICT JSON only (no prose, no code fence), matching exactly:`,
    `{`,
    `  "understanding": "one sentence restating the goal",`,
    `  "reasoning": "2-4 sentences on your approach and key decisions",`,
    `  "tasks": [`,
    `    { "title": "short task title", "detail": "what to do, why, and how you'll verify it succeeded", "tools": [ { "tool": "exact_tool_name", "how": "how/with what inputs you'll use it" } ] }`,
    `  ],`,
    `  "risks": "main risks, ambiguities or assumptions (optional)",`,
    `  "done_when": "objective definition of done"`,
    `}`,
    `Keep it tight: 3-8 tasks. Only include tools that genuinely apply to a task (a task may need zero tools). Do not invent tool names. If the request is too ambiguous to plan responsibly, make your first task use the ask_user tool.`,
    ...(descByName.has("spawn_parallel_agents") ? [
      `REUSE FIRST: if this request (or parts of it) may already have been done, make the FIRST task check with search_context(scope="past_runs") and reuse existing deliverables — do NOT re-run work that already exists.`,
      `PARALLELISM BY DEFAULT: actively look for parallelism when decomposing. Whenever 2+ steps are genuinely NEW and INDEPENDENT (none needs another's output) and not already done, plan them as ONE fan-out task with spawn_parallel_agents instead of separate sequential tasks. ESPECIALLY when a step is "do X for EACH of N items" (source each of N products, analyse each of N competitors/URLs) — make it a SINGLE fan-out with one subtask per item (no small cap — dozens is fine), never N sequential tasks. Keep steps sequential ONLY when they truly depend on each other's output (chain them), or the work is already produced.`,
    ] : []),
    `RESUME-AWARE: if the context below shows work already done (files created, steps completed) — e.g. the user said "continue" — plan ONLY the REMAINING steps. Make the first task verify existing state (list files / re-read prior results) and then proceed from the first unfinished step. Never re-plan finished work from scratch.`,
  ].join("\n");

  const userPrompt = [
    `# Task to plan`,
    taskText,
    contextText ? `\n# Relevant context (memory / prior work)\n${contextText.slice(0, 4000)}` : "",
  ].join("\n");

  // Planning is a reasoning task: the heavy tier OF THIS PROVIDER, never a
  // model id borrowed from the other one.
  const callOnce = (p: Provider) =>
    callAi({
      task: "architecture_reasoning",
      systemPrompt,
      userPrompt,
      provider: p,
      model: Deno.env.get("AGENT_MODEL_PLANNER") || modelForTier("heavy", p),
      jsonMode: true,
      maxTokens: 1800,
      temperature: 0.3,
    });

  try {
    let res;
    try {
      res = await callOnce(provider);
    } catch (e) {
      // Cross-provider retry, whichever way round: an agent pinned on Groq
      // deserves the same resilience as one on DeepSeek.
      const other = availableProviders().find((p) => p !== provider);
      if (other) res = await callOnce(other);
      else throw e;
    }
    const parsed = safeParsePlan(res.content);
    if (!parsed) return null;
    // Assign stable ids and attach each tool's catalog description (function &
    // utility) so the live timeline can explain every tool to the user.
    parsed.tasks = parsed.tasks.slice(0, 10).map((t, i) => ({
      ...t,
      id: `step-${i + 1}`,
      tools: (Array.isArray(t.tools) ? t.tools : []).map((tl) => ({
        ...tl,
        desc: descByName.get(tl.tool) ? String(descByName.get(tl.tool)).slice(0, 240) : undefined,
      })),
    }));
    return { plan: parsed, markdown: planToMarkdown(parsed) };
  } catch {
    // Planning is best-effort: on failure the agent executes without a plan.
    return null;
  }
}

// Build the messages that inject a committed plan into the execution loop.
function planMessages(markdown: string, mode: "chat" | "mission"): ChatMessage[] {
  const nudge = mode === "mission"
    ? "The plan is approved. Execute it now, task by task, in order, calling the tools exactly as you outlined. Do not re-plan from scratch — follow the plan, adapting only when a tool result requires it. Begin with task 1."
    : "Proceed with this plan now, task by task, calling the tools as outlined. Adapt only when a result requires it. If something critical is genuinely ambiguous, ask one short clarifying question first; otherwise begin.";
  return [
    { role: "assistant", content: `Here is my execution plan before I act:\n\n${markdown}` },
    { role: "user", content: nudge },
  ];
}

async function loadAgentAndTools(agentId: string) {
  const admin = createServiceClient();
  const [{ data: agent, error: agentErr }, { data: tools }] = await Promise.all([
    admin
      .from("internal_agents")
      .select("id, name, persona, instructions, model, temperature, max_steps, max_run_cost_usd, workspace_id, project_id, is_archived, collaboration_enabled, sandbox_mode, sandbox_url, swarm_enabled, swarm_max_concurrency, hosted_endpoint_url, hosted_model, hosted_provider_id, created_by, service_dashboard_id, is_orchestrator")
      .eq("id", agentId)
      .maybeSingle(),
    admin
      .from("internal_agent_tools")
      .select("id, kind, name, description, config, enabled, requires_approval")
      .eq("agent_id", agentId),
  ]);
  if (agentErr) throw new Error(`Could not load agent: ${agentErr.message}`);
  if (!agent) throw new Error(`Agent not found (id=${agentId})`);
  if ((agent as AgentRow).is_archived) throw new Error("Agent is archived");
  return { agent: agent as AgentRow, tools: (tools ?? []) as AgentToolRow[] };
}

// Top-of-mind memory injected into every prompt: pinned first, then by
// importance and recency, capped so it can't crowd out the context window.
// The agent reaches older entries through search_memory.
async function loadMemorySection(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
  taskText?: string,
): Promise<string> {
  const { data } = await admin
    .from("internal_agent_memories")
    .select("id, kind, content, importance, is_pinned")
    .eq("agent_id", agentId)
    .order("is_pinned", { ascending: false })
    .order("importance", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(25);
  if (!data || data.length === 0) return "";
  type Mem = { id?: string; kind: string; content: string; importance: number; is_pinned: boolean };
  let rows = data as Mem[];

  // Semantic recall: when we know the current task, pull the memories most
  // RELEVANT to it (not just the most important) and rank them first after the
  // pinned ones. Best-effort — falls back to the static top-N.
  if (taskText && Deno.env.get("JINA_API_KEY")) {
    try {
      const [qvec] = await embedTexts([taskText.slice(0, 1500)], "retrieval.query");
      if (qvec) {
        const { data: sem } = await admin.rpc("match_agent_memories", {
          p_agent_id: agentId, p_query_embedding: toVectorLiteral(qvec), p_match_count: 8,
        });
        if (Array.isArray(sem) && sem.length) {
          const pinned = rows.filter((m) => m.is_pinned);
          const seen = new Set(pinned.map((m) => m.content));
          const semantic = (sem as Mem[]).filter((m) => !seen.has(m.content));
          for (const m of semantic) seen.add(m.content);
          const rest = rows.filter((m) => !seen.has(m.content));
          rows = [...pinned, ...semantic, ...rest];
        }
      }
    } catch { /* static fallback */ }

    // Lazy backfill: embed a few legacy memories that predate the embedding
    // column so they become findable next time. Fire-and-forget.
    (async () => {
      try {
        const { data: missing } = await admin
          .from("internal_agent_memories").select("id, content")
          .eq("agent_id", agentId).is("embedding", null).limit(5);
        for (const m of missing ?? []) {
          const v = await embedMemoryVector(m.content as string);
          if (v) await admin.from("internal_agent_memories").update({ embedding: v }).eq("id", m.id);
        }
      } catch { /* best-effort */ }
    })();
  }

  const lines: string[] = [];
  let budget = 3500;
  for (const m of rows) {
    const line = `- [${m.kind}${m.is_pinned ? ", pinned" : ""}] ${m.content}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

// Shared team knowledge pool, injected so agents share context across the team.
// "Recent work" for the chat system prompt: the agent's last mission runs, so a
// conversation starts aware of what it just did (paths, results, failures)
// instead of rediscovering — or worse, redoing — its own work.
async function loadRecentWorkSection(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
): Promise<string> {
  try {
    const { data: runs } = await admin
      .from("internal_agent_runs")
      .select("status, finished_at, final_output, error_message, mission_id")
      .eq("agent_id", agentId)
      .in("status", ["succeeded", "failed"])
      .not("mission_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(3);
    if (!runs?.length) return "";
    const missionIds = [...new Set(runs.map((r: any) => r.mission_id))];
    const { data: missions } = await admin
      .from("internal_agent_missions").select("id, title").in("id", missionIds);
    const titleOf = new Map((missions ?? []).map((m: any) => [m.id, m.title]));
    return runs.map((r: any) => {
      const when = String(r.finished_at ?? "").slice(0, 16);
      const head = `- [${r.status === "succeeded" ? "OK" : "ÉCHEC"}] "${titleOf.get(r.mission_id) ?? "mission"}" (${when})`;
      const body = r.status === "failed"
        ? ` — erreur: ${String(r.error_message ?? "inconnue").slice(0, 200)}`
        : ` — ${String(r.final_output ?? "").replace(/[#*`>_\n]+/g, " ").trim().slice(0, 400)}`;
      return head + body;
    }).join("\n");
  } catch { return ""; }
}

async function loadTeamMemorySection(
  admin: ReturnType<typeof createServiceClient>,
  projectId: string,
): Promise<string> {
  const { data } = await admin
    .from("internal_agent_team_memories")
    .select("kind, content, is_pinned")
    .eq("project_id", projectId)
    .order("is_pinned", { ascending: false })
    .order("importance", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(15);
  if (!data || data.length === 0) return "";
  return (data as Array<{ kind: string; content: string; is_pinned: boolean }>)
    .map((m) => `- [${m.kind}${m.is_pinned ? ", pinned" : ""}] ${m.content}`)
    .join("\n");
}

// Load the skills activated for this agent (full fields). Their playbooks are
// NOT injected up-front — only an index goes in the prompt; the agent pulls a
// skill's full instructions on demand via use_skill (progressive disclosure).
async function loadActivatedSkills(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
): Promise<Array<{ id: string; slug: string; name: string; description: string | null; category: string | null; instructions: string | null; tools: string[] | null; files: Array<{ path: string }> }>> {
  // Embed the bundled files' PATHS only (an index) — their content is pulled on
  // demand via read_skill_file (progressive disclosure), never up-front.
  const { data } = await admin
    .from("agent_skill_activations")
    .select("skill:agent_skills(id, slug, name, description, category, system_prompt_extension, required_tools, files:agent_skill_files(path, sort))")
    .eq("agent_id", agentId);
  return ((data ?? []) as any[])
    .map((a) => a.skill)
    .filter(Boolean)
    .map((s: any) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      description: s.description ?? null,
      category: s.category ?? null,
      instructions: s.system_prompt_extension ?? null,
      tools: s.required_tools ?? null,
      files: Array.isArray(s.files)
        ? [...s.files].sort((a: any, b: any) => (a.sort ?? 0) - (b.sort ?? 0)).map((f: any) => ({ path: f.path }))
        : [],
    }));
}

// Load the MCP servers attached to this agent (enabled only) with their cached
// tool list, so the run loop exposes them without re-handshaking every tick.
async function loadActivatedMcpServers(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
): Promise<Array<{ id: string; name: string; url: string; headers: Record<string, string>; tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>> {
  const { data } = await admin
    .from("agent_mcp_servers")
    .select("server:mcp_servers(id, name, url, headers, enabled, cached_tools, auth_mode, oauth)")
    .eq("agent_id", agentId);
  const rows = ((data ?? []) as any[]).map((r) => r.server).filter((s: any) => s && s.enabled);
  const out: Array<{ id: string; name: string; url: string; headers: Record<string, string>; tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }> = [];
  for (const s of rows) {
    let headers: Record<string, string> = s.headers && typeof s.headers === "object" ? { ...s.headers } : {};
    // OAuth servers: inject a fresh Bearer token (refreshed if near expiry).
    if (s.auth_mode === "oauth") {
      const token = await ensureAccessToken(admin, { id: s.id, oauth: s.oauth || {} });
      if (token) headers = { ...headers, Authorization: `Bearer ${token}` };
    }
    out.push({ id: s.id, name: s.name, url: s.url, headers, tools: Array.isArray(s.cached_tools) ? s.cached_tools : [] });
  }
  return out;
}

// One-line-per-skill index for the system prompt (the agent's global view of
// the skills it can pull in with use_skill).
function skillsIndex(skills: Array<{ slug: string; name: string; description: string | null; category: string | null }>): string {
  return skills
    .map((s) => `- ${s.name} (${s.slug})${s.category ? ` [${s.category}]` : ""}${s.description ? `: ${s.description}` : ""}`)
    .join("\n");
}

function nextRunAt(schedule: string, from: Date): string {
  const d = new Date(from);
  if (schedule === "daily") d.setDate(d.getDate() + 1);
  else if (schedule === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Tool context wiring
// ---------------------------------------------------------------------------

// Runtime infra config read FRESH from the DB on every run. Edge workers cache
// env secrets until they're recycled (the pg_cron drainer keeps them warm), so a
// re-synced SANDBOX_URL secret could stay stale for hours — the root cause of
// the 03/07 "Sandbox unreachable" fork-bomb incident. app_config is always live.
async function loadRuntimeConfig(
  admin: ReturnType<typeof createServiceClient>,
): Promise<{ sandboxUrl: string | null; runnerUrl: string | null }> {
  try {
    const { data } = await admin.from("app_config").select("key, value").in("key", ["sandbox_url", "runner_browser_url"]);
    const map = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    return {
      sandboxUrl: map.get("sandbox_url") || null,
      runnerUrl: map.get("runner_browser_url") || null,
    };
  } catch {
    return { sandboxUrl: null, runnerUrl: null };
  }
}

// Circuit breaker: one cheap probe of the sandbox API before starting real
// work. Returns null when healthy, else a short diagnostic. Prevents the
// "grind for hours against a dead tunnel" failure mode.
async function probeSandbox(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/bash/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify({ command: "echo ok", timeout: 5 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) return `HTTP ${res.status}`;
    if (!text.trim().startsWith("{")) return "réponse HTML — tunnel mort ou intersticiel";
    return null;
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).slice(0, 120);
  }
}

const SANDBOX_DOWN_MSG =
  "⚠縏 Sandbox d'exécution injoignable — l'infrastructure locale (Docker/ngrok/runner) est arrêtée ou le tunnel a changé. " +
  "Relance-la en une commande : powershell -ExecutionPolicy Bypass -File scripts\\start-agents-infra.ps1 — puis relance la mission.";

// Circuit breaker for RUNNER mode: same idea as probeSandbox, but the runner
// exposes a plain /health endpoint (browser.js). Returns null when healthy.
async function probeRunner(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      method: "GET",
      // The runner authenticates EVERY route (incl. /health) with X-Runner-Token;
      // without it the probe gets 401 and wrongly marks the runner down.
      headers: { "ngrok-skip-browser-warning": "true", "X-Runner-Token": Deno.env.get("PLATFORM_RUNNER_TOKEN") || "" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) return `HTTP ${res.status}`;
    if (!text.trim().startsWith("{")) return "réponse HTML — tunnel mort ou intersticiel";
    return null;
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).slice(0, 120);
  }
}

const RUNNER_DOWN_MSG =
  "⚠縏 Runner injoignable — la machine self-hosted (runner + tunnel) est arrêtée ou son URL a changé. " +
  "Relance-la : powershell -ExecutionPolicy Bypass -File scripts\\start-agents-infra.ps1 — puis relance la mission.";

// HYBRID health gate: probe both execution worlds configured on the context and
// DISABLE (in place) whichever is unreachable, so buildInternalToolset only
// exposes healthy worlds this turn. Never throws — a hybrid run degrades to the
// healthy world; the caller decides what to do if BOTH are down. Returns the
// health map and a short human note.
async function gateHybridHealth(
  ctx: InternalToolContext,
): Promise<{ runnerUp: boolean; sandboxUp: boolean; note: string }> {
  const notes: string[] = [];
  const runnerConfigured = !!(ctx.runnerEnabled && ctx.runnerUrl);
  const sandboxConfigured = !!ctx.sandboxUrl;
  const [runnerProbe, sandboxProbe] = await Promise.all([
    runnerConfigured ? probeRunner(ctx.runnerUrl as string) : Promise.resolve<string | null>(null),
    sandboxConfigured ? probeSandbox(ctx.sandboxUrl as string) : Promise.resolve<string | null>(null),
  ]);
  let runnerUp = runnerConfigured;
  let sandboxUp = sandboxConfigured;
  if (runnerConfigured && runnerProbe) {
    ctx.runnerEnabled = false; ctx.runnerUrl = null; runnerUp = false;
    notes.push(`runner hors-ligne (${runnerProbe})`);
  }
  if (sandboxConfigured && sandboxProbe) {
    ctx.sandboxUrl = null; sandboxUp = false;
    notes.push(`sandbox hors-ligne (${sandboxProbe})`);
  }
  return { runnerUp, sandboxUp, note: notes.join(" · ") };
}

/** The last thing the human actually asked, out of a tick's message history. */
function lastUserText(messages: ChatMessage[]): string {
  return String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
}

function makeToolContext(opts: {
  admin: ReturnType<typeof createServiceClient>;
  agent: AgentRow;
  runId: string | null;
  missionId: string | null;
  conversationId?: string | null;
  delegationDepth?: number;
  /** DB-backed infra config (loadRuntimeConfig) — takes precedence over env. */
  runtimeConfig?: { sandboxUrl: string | null; runnerUrl: string | null };
}): InternalToolContext {
  const { admin, agent, runId, missionId } = opts;
  let lastCancelCheck = 0;
  let cancelled = false;
  // Standalone so the context's own members (createArtifact) can record events
  // too — inside the object literal `logEvent` is only reachable via `this`.
  const writeEvent = async (kind: string, payload: Record<string, unknown>) => {
    if (!runId) return;
    await admin.from("internal_agent_run_events").insert({
      run_id: runId, agent_id: agent.id, kind, payload,
    }).then(() => {}, () => {});
  };
  return {
    admin,
    workspaceId: agent.workspace_id,
    projectId: agent.project_id,
    agentId: agent.id,
    agentName: agent.name,
    collaborationEnabled: agent.collaboration_enabled,
    // Autopilot = the agent may execute write actions without per-action
    // approval. There is no per-agent autopilot flag on internal_agents, so we
    // default to NOT autopilot — write gating is driven per-tool by each tool's
    // own requires_approval flag.
    autopilot: false,
    runId,
    conversationId: opts.conversationId ?? null,
    // Precedence: per-agent override → live DB config → env fallback.
    // HYBRID exposes BOTH worlds at once (namespaced runner_* / sandbox_*); the
    // per-tick health gate strips whichever world is currently unreachable.
    sandboxUrl: (agent.sandbox_mode === "sandbox" || agent.sandbox_mode === "hybrid")
      ? (agent.sandbox_url || opts.runtimeConfig?.sandboxUrl || Deno.env.get("SANDBOX_URL") || null)
      : null,
    runnerEnabled: agent.sandbox_mode === "runner" || agent.sandbox_mode === "hybrid",
    runnerUrl: opts.runtimeConfig?.runnerUrl || null,
    hybrid: agent.sandbox_mode === "hybrid",
    missionMode: opts.missionId != null,
    delegationDepth: opts.delegationDepth ?? 0,
    // Essaim: default ON (preserves the always-available behaviour); the tool
    // is simply not registered when the owner turned it off.
    swarmEnabled: agent.swarm_enabled !== false,
    serviceDashboardId: agent.service_dashboard_id ?? null,
    userId: agent.created_by ?? null,
    createDeliverable: async (d) => {
      // The error was discarded here. A failed insert therefore looked exactly
      // like a successful one: publish_artifact answered "publié (17 blocs)",
      // the agent moved on, and the run finished with zero deliverables — which
      // is what the "materialised automatically" salvage was catching. An insert
      // that fails must say so, loudly, to the model AND to the timeline.
      const { data: row, error } = await admin.from("internal_agent_deliverables").insert({
        run_id: runId,
        mission_id: missionId,
        conversation_id: opts.conversationId ?? null,
        agent_id: agent.id,
        kind: d.kind,
        name: d.name,
        content: d.content,
        summary: d.summary,
      }).select("id").maybeSingle();
      // Announce it NOW, like createArtifact does. The card used to be attached
      // only by the success finalizer, so a run that ended any other way — the
      // Gmail approval gate, a question, an exhausted budget — produced a real
      // deliverable that appeared NOWHERE in the room, and the agent's "j'ai
      // produit le rapport" read as a hallucination. The 'ui' event also gives
      // the run timeline (and the closing report) hard proof the file exists.
      const id = (row as { id?: string } | null)?.id;
      if (error || !id) {
        const why = error?.message ?? "aucune ligne écrite";
        await writeEvent("error", { error: `Enregistrement du livrable « ${d.name} » impossible : ${why}` }).catch(() => {});
        throw new Error(`enregistrement impossible : ${why}`);
      }
      await writeEvent("ui", {
        block: { component: "deliverable", props: { id, name: d.name, kind: d.kind, agentId: agent.id } },
      }).catch(() => {});
    },
    // Outside a room there is no inline card, but the artifact itself must be
    // IDENTICAL to the one a room turn produces: same parsing, same storage,
    // same image pipeline. It used to differ — markdown landed as a single
    // paragraph, CSV as one column, and images/text were silently dropped — so
    // an agent's spreadsheet was unusable unless it happened to run in a room.
    // Every kind is now materialised and announced on the timeline, which is
    // also what read_artifact/update_artifact need to find it again.
    createArtifact: async (a) => {
      const scope = {
        workspaceId: agent.workspace_id ?? null,
        projectId: agent.project_id ?? null,
        createdBy: agent.created_by ?? null,
        agentId: agent.id,
      };
      if (a.kind === "image") {
        const mediaId = await generateArtifactImage(admin, a.content, scope);
        await writeEvent("ui", mediaId
          ? { block: { component: "artifact", props: { id: mediaId, table: "office_media", kind: "image", title: a.title } } }
          : { block: { component: "artifact", props: { table: "text", kind: "text", title: a.title, content: "Image generation failed or is not configured." } } });
        return;
      }
      if (!isDocKind(a.kind)) {
        // Plain text: inline block only, nothing to store.
        await writeEvent("ui", { block: { component: "artifact", props: { table: "text", kind: "text", title: a.title, content: a.content } } });
        return;
      }
      const id = await insertArtifact(admin, a.kind, a.title, a.content, scope);
      if (id) {
        await writeEvent("ui", { block: { component: "artifact", props: { id, table: "office_documents", kind: a.kind, title: a.title } } });
      }
    },
    requestApproval: async (r) => {
      const { data, error } = await admin
        .from("internal_agent_approvals")
        .insert({
          agent_id: agent.id,
          run_id: runId,
          mission_id: missionId,
          conversation_id: opts.conversationId ?? null,
          workspace_id: agent.workspace_id,
          project_id: agent.project_id,
          tool_name: r.tool_name,
          action_kind: r.action_kind,
          payload: r.payload,
          reason: r.reason,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Could not queue approval: ${error.message}`);
      return (data as { id: string }).id;
    },
    logEvent: async (kind, payload) => {
      if (!runId) return;
      await admin.from("internal_agent_run_events").insert({
        run_id: runId,
        agent_id: agent.id,
        kind,
        payload,
      });
    },
    isCancelled: async () => {
      if (!runId || cancelled) return cancelled;
      // Throttle: at most one status check per 2s.
      const now = Date.now();
      if (now - lastCancelCheck < 2000) return false;
      lastCancelCheck = now;
      const { data } = await admin
        .from("internal_agent_runs")
        .select("status")
        .eq("id", runId)
        .maybeSingle();
      cancelled = data?.status === "cancelled";
      return cancelled;
    },
  };
}

// ---------------------------------------------------------------------------
// Chat mode
// ---------------------------------------------------------------------------

async function runChat(
  agent: AgentRow,
  tools: AgentToolRow[],
  conversationId: string,
  /** Model picked in the composer for THIS turn (overrides the cost tiering). */
  modelChoice?: string | null,
) {
  const admin = createServiceClient();

  // Mid-run steering: if a run is already in flight for this conversation, DON'T
  // start a competing one. The user's message is already persisted; the running
  // tick loop will fold it in on its next tick (see the sync block in
  // runMissionTick). This lets you correct/add to the task while it works.
  const { data: activeState } = await admin
    .from("internal_agent_run_state").select("run_id").eq("conversation_id", conversationId).limit(1);
  if (activeState && activeState.length > 0) {
    return jsonResponse({ ok: true, run_id: activeState[0].run_id, injected: true });
  }

  // Create a lightweight run so tool calls are logged and visible in real-time.
  const { data: chatRun } = await admin.from("internal_agent_runs").insert({
    agent_id: agent.id,
    workspace_id: agent.workspace_id,
    project_id: agent.project_id,
    conversation_id: conversationId,
    status: "running",
    started_at: new Date().toISOString(),
    triggered_via: "chat",
  }).select("id").single();
  const chatRunId = chatRun?.id ?? null;
  if (!chatRunId) return jsonResponse({ ok: false, error: "could not create chat run" }, { status: 500 });

  // Build the initial messages + plan, persist resumable state and enqueue the
  // FIRST tick — synchronously, so the enqueue is guaranteed before we respond
  // (init is light: one planning call + an upsert). The long tool loop then runs
  // across many short ticks (runMissionTick handles chat too), never bounded by
  // the Edge wall-clock that used to kill long chats and orphan the run.
  await initChatRun(admin, agent, tools, conversationId, chatRunId, modelChoice);
  return jsonResponse({ ok: true, run_id: chatRunId, queued: true });
}

async function initChatRun(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  tools: AgentToolRow[],
  conversationId: string,
  chatRunId: string,
  modelChoice?: string | null,
): Promise<void> {
 try {
  const { data: history } = await admin
    .from("internal_agent_messages")
    .select("role, content, tool_calls")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(30);

  const runtimeConfig = await loadRuntimeConfig(admin);
  const ctx = makeToolContext({ admin, agent, runId: chatRunId, missionId: null, conversationId, runtimeConfig });
  // Circuit breaker (chat = graceful degrade): if the sandbox is down, strip the
  // execution tools for this turn and tell the model why, instead of letting it
  // grind against a dead tunnel.
  let sandboxDownNote = "";
  if (ctx.sandboxUrl) {
    const probe = await probeSandbox(ctx.sandboxUrl);
    if (probe) {
      ctx.sandboxUrl = null;
      sandboxDownNote = ctx.hybrid
        ? `\n\nNOTE INFRA: the SANDBOX world is currently OFFLINE (${probe}) — its sandbox_* tools are unavailable this turn. If the RUNNER world is up, use its runner_* tools for any execution work instead. Do not attempt sandbox_* calls.`
        : `\n\nNOTE INFRA: the execution sandbox is currently OFFLINE (${probe}) — execution tools are unavailable for this turn. If the user asks for execution work, answer that the local infra must be relaunched first (scripts/start-agents-infra.ps1) and do NOT attempt workarounds via meta-tools.`;
      await ctx.logEvent("status", { message: `Sandbox hors-ligne (${probe}) — outils d'exécution désactivés pour ce tour.` }).catch(() => {});
    }
  }
  // Same graceful-degrade for RUNNER mode: strip the machine/browser tools this
  // turn if the self-hosted runner is unreachable, instead of grinding.
  if (ctx.runnerEnabled && ctx.runnerUrl) {
    const probe = await probeRunner(ctx.runnerUrl);
    if (probe) {
      ctx.runnerEnabled = false;
      ctx.runnerUrl = null;
      sandboxDownNote += ctx.hybrid
        ? `\n\nNOTE INFRA: the RUNNER world is currently OFFLINE (${probe}) — its runner_* tools are unavailable this turn. If the SANDBOX world is up, use its sandbox_* tools for any execution work instead. Do not attempt runner_* calls.`
        : `\n\nNOTE INFRA: the self-hosted runner is currently OFFLINE (${probe}) — browser/shell/code/file tools are unavailable for this turn. If the user asks for execution work, answer that the runner must be relaunched first (scripts/start-agents-infra.ps1) and do NOT attempt workarounds via meta-tools.`;
      await ctx.logEvent("status", { message: `Runner hors-ligne (${probe}) — outils d'exécution désactivés pour ce tour.` }).catch(() => {});
    }
  }
  // Semantic memory recall keyed on the user's latest message.
  const lastUserText = String([...(history ?? [])].reverse().find((m) => m.role === "user")?.content ?? "");
  const [memorySection, teamMemorySection, chatSkills, recentWorkSection] = await Promise.all([
    loadMemorySection(admin, agent.id, lastUserText || undefined),
    loadTeamMemorySection(admin, agent.project_id),
    loadActivatedSkills(admin, agent.id),
    loadRecentWorkSection(admin, agent.id),
  ]);
  ctx.skills = chatSkills;
  ctx.mcpServers = await loadActivatedMcpServers(admin, agent.id);
  const { defs, capabilitySummary } = buildInternalToolset(tools, ctx);
  const chatSkillIndex = skillsIndex(chatSkills);

  const chatPrompt = buildSystemPrompt(
    agent, capabilitySummary + sandboxDownNote, "chat", memorySection, teamMemorySection,
    chatSkillIndex, recentWorkSection, isSecurityAgent(chatSkills), lastUserText,
  );
  await ctx.logEvent("prompt", budgetEventPayload(chatPrompt.budget, null)).catch(() => {});
  const messages: ChatMessage[] = [
    { role: "system", content: chatPrompt.prompt },
    ...(history ?? [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        // Surface what an assistant turn actually DID (tool names) so a later
        // "continue" can resume instead of restarting — chat history otherwise
        // drops the tool_calls and the agent forgets its own progress.
        const tcs = Array.isArray((m as any).tool_calls) ? (m as any).tool_calls : [];
        const names = [...new Set(tcs.map((t: any) => t?.name).filter(Boolean))];
        const note = m.role === "assistant" && names.length ? `\n\n[tools used this turn: ${names.join(", ")}]` : "";
        return { role: m.role as "user" | "assistant", content: (m.content ?? "") + note };
      }),
  ];
  if (messages.length === 1) messages.push({ role: "user", content: "Greet the user." });

  await ctx.logEvent("status", { message: "Chat started — thinking…" });

  // The composer can pin THIS turn's model. It only wins when its provider has
  // a key — otherwise we'd send a Groq id to DeepSeek and 400 every round.
  const wantedProvider = modelChoice ? resolveProvider(modelChoice) : null;
  const provider = wantedProvider ?? providerFor(agent);
  const pickedModel = modelChoice && modelMatchesProvider(modelChoice, provider)
    ? sanitizeModel(modelChoice, provider)
    : null;
  // A pinned provider we could not honour (missing secret) is reported, not
  // swallowed — otherwise it reads exactly like a broken switch.
  {
    const note = providerMismatchNote(modelChoice || agent.model);
    if (note) await ctx.logEvent("status", { message: note }).catch(() => {});
  }

  // Plan-first (chat): for a substantive request, reason and draft an ordered
  // plan before acting. Skipped for greetings / very short turns so quick Q&A
  // stays snappy.
  const lastUserMsg = String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
  // "continue"/"poursuis"/… are short but DO need a (resume-aware) plan.
  const isContinuation = /^\s*(continue|continu|poursuis|reprends?|resume|go on|keep going|next|suite|encore|vas[-\s]?y|ok\b)/i.test(lastUserMsg.trim());
  /** Success contract for this turn — derived alongside the plan (below). */
  let contract: SuccessContract | null = null;
  if ((lastUserMsg.trim().length >= 24 || isContinuation) && lastUserMsg !== "Greet the user.") {
    if (chatRunId) await ctx.logEvent("status", { message: "Reasoning & planning…" });
    // On a continuation, give the planner the prior reply so it resumes the
    // unfinished work rather than restarting from scratch.
    const prevReply = isContinuation ? String([...(history ?? [])].reverse().find((m: any) => m.role === "assistant")?.content ?? "") : "";
    const progressNote = prevReply ? `\n\n# Work already underway in this conversation (RESUME — do not restart)\nYour previous turn:\n${prevReply.slice(0, 1800)}` : "";
    const planContext = [memorySection, teamMemorySection].filter(Boolean).join("\n\n") + progressNote;
    const planTask = isContinuation
      ? `${lastUserMsg}\n\n(The user is asking you to CONTINUE the task already underway in this conversation. Plan ONLY the remaining steps — first verify what already exists on disk, then resume from the first unfinished step.)`
      : lastUserMsg;
    const toolDefs = defs.map((d) => ({ name: d.function.name, description: d.function.description }));
    const planned = await produceExecutionPlan({ provider, agent, toolDefs, taskText: planTask, contextText: planContext, hybrid: agent.sandbox_mode === "hybrid" });
    if (planned) {
      if (chatRunId) await ctx.logEvent("plan", { plan: planned.plan, markdown: planned.markdown });
      messages.push(...planMessages(planned.markdown, "chat"));
      // Seed the structured todo checklist (live UI + maintained via update_todos).
      const todos = planned.plan.tasks.map((t, i) => ({
        id: t.id, title: t.title.slice(0, 140), status: i === 0 ? "active" : "pending",
      }));
      await admin.from("internal_agent_runs").update({ todos }).eq("id", chatRunId);
      if (chatRunId) await ctx.logEvent("todos", { todos });
      // Chat runs get a success contract too — until now they were the ONLY
      // path with no verification at all (the mission self-check required a
      // brief/acceptance criteria), which is why chat needed regex rescue
      // guards for "the agent said 'report' but saved nothing".
      contract = await deriveContract({
        source: "chat",
        goal: lastUserMsg.slice(0, 800),
        doneWhen: planned.plan.done_when ?? null,
        hasTodos: true,
      }).catch(() => null);
      if (contract && chatRunId) {
        await ctx.logEvent("loop", { phase: "contract", goal: contract.goal, checks: contract.checks.map((c) => ({ label: c.label, kind: c.kind, required: c.required !== false })) });
      }
    }
  }

  // Persist resumable state + enqueue the first tick. The tool loop now runs in
  // the durable tick processor (runMissionTick handles chat too), so a long chat
  // survives Edge wall-clock recycling instead of being killed mid-run.
  // Request classification (Context Engine, étage 0): decides the model tier AND
  // how much of the toolbox this turn ships. A greeting used to carry ~59 tool
  // schemas (7-11k tokens) for a five-token answer; it now carries one escape
  // hatch (need_tools) which the model calls if the turn needs real work.
  const requestClass = classifyRequest(lastUserMsg, {
    mode: "chat",
    continuation: isContinuation,
    hasToolHistory: (history ?? []).some((m) => Array.isArray((m as { tool_calls?: unknown[] }).tool_calls) && ((m as { tool_calls?: unknown[] }).tool_calls!.length > 0)),
  });
  await ctx.logEvent("status", { message: `Contexte : ${requestClass.tools} · modèle ${requestClass.model}.` }).catch(() => {});

  await admin.from("internal_agent_run_state").upsert({
    run_id: chatRunId,
    mode: "chat",
    agent_id: agent.id,
    conversation_id: conversationId,
    mission_id: null,
    messages,
    round: 0,
    // Bounded by the agent's own budget (see resolveBudgets) instead of a
    // hard-coded 400; hitting it wraps the turn up rather than killing it.
    max_rounds: resolveBudgets(agent, "chat").maxRounds,
    contract,
    provider,
    meta: { tool_tier: requestClass.tools, context_manifest: { prefix_hash: chatPrompt.budget.prefix_hash } },
    // Model, most explicit wins: the composer's pick for this turn, then the
    // AGENT_MODEL_CHAT override, then the cost tier (see classifyRequest).
    // Sanitised either way — a banned id here is a 413 three rounds later.
    model: pickedModel
      ?? sanitizeModel(Deno.env.get("AGENT_MODEL_CHAT"), provider, agentModelForTier(agent, requestClass.model)),
    processing_until: null,
    // The triggering message is already in `messages`; only fold in turns that
    // arrive AFTER this point (mid-run steering).
    last_input_at: new Date().toISOString(),
  });
  await admin.rpc("agent_tick_enqueue", { p_run_id: chatRunId });
  return;
 } catch (e) {
   // Any unexpected failure in the background worker: mark the run failed and
   // post an error reply so the client's poll terminates (not stuck "running").
   const msg = e instanceof Error ? e.message : String(e);
   if (chatRunId) {
     await admin.from("internal_agent_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_message: msg.slice(0, 500) }).eq("id", chatRunId).then(() => {}, () => {});
     await recordRunIncident(admin, agent, chatRunId, {
       title: "Échec d'exécution du run",
       description: msg.slice(0, 1500),
       category: "other", severity: "medium",
     }).catch(() => {});
   }
   await admin.from("internal_agent_messages").insert({ conversation_id: conversationId, agent_id: agent.id, role: "assistant", content: `⚠縏 Le run a échoué : ${msg.slice(0, 400)}` }).then(() => {}, () => {});
   await admin.from("internal_agent_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId).then(() => {}, () => {});
 }
}

// ---------------------------------------------------------------------------
// Mission mode
// ---------------------------------------------------------------------------

async function runMission(agent: AgentRow, tools: AgentToolRow[], runId: string) {
  const admin = createServiceClient();

  const { data: run } = await admin
    .from("internal_agent_runs")
    .select("id, mission_id, status")
    .eq("id", runId)
    .maybeSingle();
  if (!run) throw new Error("Run not found");
  // Idempotence: only a queued run may start (double invocations are no-ops).
  if (run.status !== "queued") {
    return jsonResponse({ ok: false, error: `Run is ${run.status}, not queued` }, { status: 409 });
  }

  const { data: mission } = await admin
    .from("internal_agent_missions")
    .select("id, title, brief, acceptance_criteria, expected_deliverables, schedule, report_back_to_agent, delegation_depth")
    .eq("id", run.mission_id)
    .maybeSingle();
  if (!mission) throw new Error("Mission not found");

  await admin
    .from("internal_agent_runs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", runId);
  // Kanban: a running mission sits in "in_progress".
  await admin
    .from("internal_agent_missions")
    .update({ board_column: "in_progress" })
    .eq("id", run.mission_id)
    .in("board_column", ["backlog", "todo"]);

  const runtimeConfig = await loadRuntimeConfig(admin);
  const ctx = makeToolContext({ admin, agent, runId, missionId: mission.id, delegationDepth: (mission as { delegation_depth?: number }).delegation_depth ?? 0, runtimeConfig });

  // Circuit breaker (HYBRID missions): probe both worlds; degrade to whichever
  // is up. Only HARD-FAIL when BOTH are unreachable — a hybrid agent should not
  // die because one world is down.
  if (ctx.hybrid) {
    const h = await gateHybridHealth(ctx);
    if (!h.runnerUp && !h.sandboxUp) {
      const msg = `⚠縏 Mission hybride impossible — les DEUX mondes d'exécution sont injoignables (${h.note}). Relance l'infra locale (scripts/start-agents-infra.ps1) puis relance la mission.`;
      await ctx.logEvent("error", { error: msg });
      await admin.from("internal_agent_runs").update({
        status: "failed", finished_at: new Date().toISOString(), error_message: msg.slice(0, 500),
      }).eq("id", runId);
      await admin.from("internal_agent_missions").update({ board_column: "todo" })
        .eq("id", mission.id).eq("board_column", "in_progress");
      await autoSaveMemory(admin, agent, runId, {
        kind: "learning", importance: 3, dedupePrefix: "Exec down:",
        content: `Exec down: mission "${mission.title}" — runner ET sandbox injoignables le ${new Date().toISOString().slice(0, 10)} (${h.note}). Relancer l'infra locale (start-agents-infra.ps1) avant toute mission d'exécution.`,
      });
      await recordRunIncident(admin, agent, runId, {
        title: `Infrastructure d'exécution injoignable — ${mission.title}`,
        description: `Mission « ${mission.title} » : runner ET sandbox injoignables (${h.note}). Run interrompu avant le premier appel.`,
        category: "outage", severity: "critical",
      }).catch(() => {});
      await admin.from("aiops_infra_incidents").insert({
        workspace_id: agent.workspace_id, project_id: agent.project_id,
        server_name: "runner + sandbox", kind: "service_down", severity: "critical",
        cause: `runner ET sandbox injoignables (${h.note})`,
        impact: `Run interrompu avant le premier appel — mission « ${mission.title} », agent ${agent.name}`,
      }).catch(() => {});
      await postMissionReportToChannel(admin, mission.id, msg).catch(() => {});
      return jsonResponse({ ok: false, error: "both execution worlds unreachable", detail: h.note });
    }
    if (h.note) await ctx.logEvent("status", { message: `Mode hybride — ${h.note}. La mission continue avec le monde disponible.` });
  }

  // Circuit breaker (missions = HARD FAIL): a mission whose agent runs in
  // sandbox mode exists to EXECUTE. If the sandbox is unreachable, fail in
  // seconds with an actionable ops message instead of grinding for hours
  // (the 03/07 incident: 100% tool failure → 269 self-spawned missions).
  if (!ctx.hybrid && ctx.sandboxUrl) {
    const probe = await probeSandbox(ctx.sandboxUrl);
    if (probe) {
      const msg = `${SANDBOX_DOWN_MSG} (diagnostic: ${probe})`;
      await ctx.logEvent("error", { error: msg });
      await admin.from("internal_agent_runs").update({
        status: "failed", finished_at: new Date().toISOString(), error_message: msg.slice(0, 500),
      }).eq("id", runId);
      await admin.from("internal_agent_missions").update({ board_column: "todo" })
        .eq("id", mission.id).eq("board_column", "in_progress");
      await autoSaveMemory(admin, agent, runId, {
        kind: "learning", importance: 3, dedupePrefix: "Sandbox down:",
        content: `Sandbox down: run de la mission "${mission.title}" échoué le ${new Date().toISOString().slice(0, 10)} — sandbox injoignable (${probe}). L'infra locale doit être relancée (start-agents-infra.ps1) avant toute mission d'exécution.`,
      });
      await recordRunIncident(admin, agent, runId, {
        title: `Sandbox injoignable — ${mission.title}`,
        description: `Mission « ${mission.title} » : sandbox injoignable (${probe}). Run interrompu avant le premier appel.`,
        category: "outage", severity: "critical",
      }).catch(() => {});
      await admin.from("aiops_infra_incidents").insert({
        workspace_id: agent.workspace_id, project_id: agent.project_id,
        server_name: "sandbox", kind: "service_down", severity: "critical",
        cause: `sandbox injoignable (${probe})`,
        impact: `Run interrompu avant le premier appel — mission « ${mission.title} », agent ${agent.name}`,
      }).catch(() => {});
      await postMissionReportToChannel(admin, mission.id, msg).catch(() => {});
      return jsonResponse({ ok: false, error: "sandbox unreachable", detail: probe });
    }
  }
  // Same HARD-FAIL for RUNNER-mode missions: no runner → no execution, fail fast.
  if (!ctx.hybrid && ctx.runnerEnabled && ctx.runnerUrl) {
    const probe = await probeRunner(ctx.runnerUrl);
    if (probe) {
      const msg = `${RUNNER_DOWN_MSG} (diagnostic: ${probe})`;
      await ctx.logEvent("error", { error: msg });
      await admin.from("internal_agent_runs").update({
        status: "failed", finished_at: new Date().toISOString(), error_message: msg.slice(0, 500),
      }).eq("id", runId);
      await admin.from("internal_agent_missions").update({ board_column: "todo" })
        .eq("id", mission.id).eq("board_column", "in_progress");
      await autoSaveMemory(admin, agent, runId, {
        kind: "learning", importance: 3, dedupePrefix: "Runner down:",
        content: `Runner down: run de la mission "${mission.title}" échoué le ${new Date().toISOString().slice(0, 10)} — runner injoignable (${probe}). La machine self-hosted doit être relancée (start-agents-infra.ps1) avant toute mission d'exécution.`,
      });
      await recordRunIncident(admin, agent, runId, {
        title: `Runner injoignable — ${mission.title}`,
        description: `Mission « ${mission.title} » : runner injoignable (${probe}). Run interrompu avant le premier appel.`,
        category: "outage", severity: "critical",
      }).catch(() => {});
      await admin.from("aiops_infra_incidents").insert({
        workspace_id: agent.workspace_id, project_id: agent.project_id,
        server_name: "runner", kind: "service_down", severity: "critical",
        cause: `runner injoignable (${probe})`,
        impact: `Run interrompu avant le premier appel — mission « ${mission.title} », agent ${agent.name}`,
      }).catch(() => {});
      await postMissionReportToChannel(admin, mission.id, msg).catch(() => {});
      return jsonResponse({ ok: false, error: "runner unreachable", detail: probe });
    }
  }

  // Semantic memory recall keyed on the mission itself (title + brief).
  const missionTaskText = `${mission.title ?? ""}\n${(mission as { brief?: string | null }).brief ?? ""}`.trim();
  const [memorySection, teamMemorySection, missionSkills, recentWorkSection] = await Promise.all([
    loadMemorySection(admin, agent.id, missionTaskText || undefined),
    loadTeamMemorySection(admin, agent.project_id),
    loadActivatedSkills(admin, agent.id),
    loadRecentWorkSection(admin, agent.id),
  ]);
  ctx.skills = missionSkills;
  ctx.mcpServers = await loadActivatedMcpServers(admin, agent.id);
  const { defs, capabilitySummary } = buildInternalToolset(tools, ctx);
  await ctx.logEvent("log", { message: `Run started (ticked) — budget: ${agent.max_steps} steps, $${agent.max_run_cost_usd}` });

  const skillPrompts = skillsIndex(missionSkills);

  // Continuity for re-runs: the last runs of this mission — successes to build
  // on, failures so the agent doesn't retry an approach that already failed.
  const { data: prevRuns } = await admin
    .from("internal_agent_runs")
    .select("finished_at, status, final_output, error_message")
    .eq("mission_id", mission.id)
    .in("status", ["succeeded", "failed"])
    .neq("id", runId)
    .order("created_at", { ascending: false })
    .limit(3);
  let previousRunSection = "";
  if (prevRuns && prevRuns.length > 0) {
    const parts = (prevRuns as Array<{ finished_at: string | null; status: string; final_output: string | null; error_message: string | null }>).map((r) => {
      const head = `### ${r.status === "succeeded" ? "✅ Succès" : "❌ Échec"} — ${String(r.finished_at ?? "").slice(0, 16)}`;
      const err = r.status === "failed" ? `\nErreur: ${String(r.error_message ?? "inconnue").slice(0, 300)}` : "";
      const body = String(r.final_output ?? "").slice(0, 1200);
      return `${head}${err}${body ? `\n${body}` : ""}`;
    });
    previousRunSection = `\n## Previous runs of this mission (newest first)\nDo NOT redo what already succeeded; do NOT retry an approach that already failed the same way.\n${parts.join("\n\n")}\n`;
  }

  const deliverablesSpec = (Array.isArray(mission.expected_deliverables) ? mission.expected_deliverables : [])
    .map((d: { kind: string; name: string; description?: string }) =>
      `- ${d.kind}: ${d.name}${d.description ? ` — ${d.description}` : ""}`)
    .join("\n");

  const userPrompt = `# Mission: ${mission.title}

## Brief
${mission.brief ?? "(no brief provided)"}

${mission.acceptance_criteria ? `## Acceptance criteria\n${mission.acceptance_criteria}\n` : ""}
${deliverablesSpec ? `## Expected deliverables\n${deliverablesSpec}\n` : ""}${previousRunSection}
Execute this mission now. Use your tools to gather what you need, save each expected deliverable with create_deliverable, then write your final mission report.`;

  const provider = providerFor(agent);
  // A pinned provider we could not honour (missing secret) is reported, not
  // swallowed — otherwise it reads exactly like a broken switch.
  {
    const note = providerMismatchNote(agent.model);
    if (note) await ctx.logEvent("status", { message: note }).catch(() => {});
  }

  // Plan-first: the agent reasons about the goal and drafts an ordered task
  // plan (tools per task + how) BEFORE executing. Logged as a `plan` event and
  // injected into the loop so the agent commits to its own plan.
  await ctx.logEvent("status", { message: "Reasoning & planning the mission…" });
  const planContext = [memorySection, teamMemorySection, previousRunSection, recentWorkSection ? `# Recent work by this agent (build on it, don't redo it)\n${recentWorkSection}` : ""].filter(Boolean).join("\n\n");
  const toolDefs = defs.map((d) => ({ name: d.function.name, description: d.function.description }));
  const planned = await produceExecutionPlan({ provider, agent, toolDefs, taskText: userPrompt, contextText: planContext, hybrid: agent.sandbox_mode === "hybrid" });
  if (planned) {
    await ctx.logEvent("plan", { plan: planned.plan, markdown: planned.markdown });
    // Seed the STRUCTURED todo checklist from the plan (the UI renders this
    // live; the agent maintains it with update_todos).
    const todos = planned.plan.tasks.map((t, i) => ({
      id: t.id, title: t.title.slice(0, 140), status: i === 0 ? "active" : "pending",
    }));
    await admin.from("internal_agent_runs").update({ todos }).eq("id", runId);
    await ctx.logEvent("todos", { todos });
  }

  // ── Success contract (loop engineering) ────────────────────────────────────
  // The definition of done becomes a list of TYPED, mostly deterministic checks
  // the run is verified against before it may finish — instead of a single LLM
  // judge asked to grade free text. The planner's `done_when`, the mission's
  // acceptance criteria and its expected deliverables all feed into it.
  const contract = await deriveContract({
    source: "mission",
    goal: `${mission.title ?? ""} — ${(mission.brief ?? "").slice(0, 600)}`,
    doneWhen: planned?.plan.done_when ?? null,
    acceptanceCriteria: mission.acceptance_criteria ?? null,
    expectedDeliverables: Array.isArray(mission.expected_deliverables) ? mission.expected_deliverables as Array<{ kind: string; name: string; description?: string }> : [],
    hasTodos: Boolean(planned),
  }).catch(() => null);
  if (contract) {
    await ctx.logEvent("loop", { phase: "contract", goal: contract.goal, checks: contract.checks.map((c) => ({ label: c.label, kind: c.kind, required: c.required !== false })) });
  }
  const budgets = resolveBudgets(agent, "mission");

  // Persist the initial conversation as resumable state and enqueue the FIRST
  // tick. The long loop then runs across many short ticks (runMissionTick),
  // never bounded by the Edge wall-clock.
  const missionPrompt = buildSystemPrompt(
    agent, capabilitySummary, "mission", memorySection, teamMemorySection,
    skillPrompts, recentWorkSection, isSecurityAgent(missionSkills), missionTaskText,
  );
  await ctx.logEvent("prompt", budgetEventPayload(missionPrompt.budget, null)).catch(() => {});
  const initialMessages: ChatMessage[] = [
    { role: "system", content: missionPrompt.prompt },
    { role: "user", content: userPrompt },
    ...(planned ? planMessages(planned.markdown, "mission") : []),
  ];
  await admin.from("internal_agent_run_state").upsert({
    run_id: runId,
    mode: "mission",
    agent_id: agent.id,
    mission_id: mission.id,
    messages: initialMessages,
    round: 0,
    // The agent's OWN budget (max_steps, expanded into rounds) now bounds the
    // loop — it used to be a hard-coded 400 that ignored the configured value.
    // Reaching it triggers a wrap-up, not a kill: the run still delivers.
    max_rounds: budgets.maxRounds,
    contract,
    provider,
    // Missions always ship the full toolbox: a mission that has to discover its
    // own tools wastes rounds it was given to do the work.
    meta: { tool_tier: "full" as ToolTier, context_manifest: { prefix_hash: missionPrompt.budget.prefix_hash } },
    // Cost-tiered from the mission's nature (title + brief). AGENT_MODEL_MISSION
    // still overrides if set. A run that keeps failing is escalated to the heavy
    // model in runMissionTick (see the replan branch).
    model: Deno.env.get("AGENT_MODEL_MISSION") || agentModelForTier(agent, classifyTier(missionTaskText, { mode: "mission" })),
    processing_until: null,
  });
  await admin.rpc("agent_tick_enqueue", { p_run_id: runId });
  return jsonResponse({ ok: true, run_id: runId, queued: true });
}

// Finalize a successful (or budget-exhausted) mission: deliverable safety net,
// run → succeeded, kanban → review, scheduling, delegation report-back, usage.
// Deterministic, best-effort memory write — so the agent's memory populates
// from real lifecycle events instead of only when the model remembers to call
// save_memory. `dedupePrefix` replaces any prior memory with that prefix so a
// recurring mission keeps ONE up-to-date entry instead of piling up.
async function autoSaveMemory(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  runId: string | null,
  opts: { kind: "fact" | "preference" | "learning" | "context"; content: string; importance?: number; dedupePrefix?: string },
) {
  const content = opts.content.replace(/\s+/g, " ").trim().slice(0, 600);
  if (!content) return;
  try {
    if (opts.dedupePrefix) {
      const esc = opts.dedupePrefix.replace(/[%_]/g, (m) => `\\${m}`);
      await admin.from("internal_agent_memories").delete().eq("agent_id", agent.id).ilike("content", `${esc}%`);
    }
    const { count } = await admin
      .from("internal_agent_memories")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agent.id);
    if ((count ?? 0) >= 300) return; // respect the cap silently
    await admin.from("internal_agent_memories").insert({
      agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
      kind: opts.kind, content, importance: opts.importance ?? 3,
      source: "agent", source_run_id: runId,
      embedding: await embedMemoryVector(content),
    });
  } catch { /* best-effort: never block finalization on memory */ }
}

async function finalizeMissionSuccess(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  runId: string,
  mission: { id: string; title?: string; schedule?: string | null; report_back_to_agent?: string | null },
  finalOutput: string,
  stats: { tokIn: number; tokOut: number; cost: number; actions: number; provider: string; model: string; custom?: boolean },
) {
  const { count } = await admin
    .from("internal_agent_deliverables")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId);
  if (!count) {
    await admin.from("internal_agent_deliverables").insert({
      run_id: runId, mission_id: mission.id, agent_id: agent.id, kind: "markdown",
      name: "Mission output", content: finalOutput,
      summary: finalOutput.replace(/[#*`>_\n]+/g, " ").trim().slice(0, 200) || null,
    });
  }
  await admin.from("internal_agent_runs").update({
    status: "succeeded", finished_at: new Date().toISOString(), final_output: finalOutput,
    tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost,
    action_count: stats.actions, steps: stats.actions,
  }).eq("id", runId);
  await completeRunTodos(admin, runId);

  const missionUpdate: Record<string, unknown> = { last_run_at: new Date().toISOString() };
  if (mission.schedule) missionUpdate.next_run_at = nextRunAt(mission.schedule, new Date());
  await admin.from("internal_agent_missions").update(missionUpdate).eq("id", mission.id);
  await admin.from("internal_agent_missions").update({ board_column: "review" }).eq("id", mission.id).eq("board_column", "in_progress");

  // Consign the mission outcome to the agent's persistent memory so future
  // sessions know what was done, what it produced, and the key conclusion.
  try {
    const title = mission.title ?? "mission";
    const { data: delivs } = await admin
      .from("internal_agent_deliverables").select("name").eq("run_id", runId).limit(8);
    const delivList = (delivs ?? []).map((d: any) => d.name).filter(Boolean).join(", ");
    const summary = finalOutput.replace(/[#*`>_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    await autoSaveMemory(admin, agent, runId, {
      kind: "context",
      importance: 4,
      dedupePrefix: `Mission "${title}"`,
      content: `Mission "${title}" — completed ${new Date().toISOString().slice(0, 10)}.${summary ? ` Result: ${summary}` : ""}${delivList ? ` · Deliverables: ${delivList}.` : ""}`,
    });
  } catch { /* best-effort */ }

  if (mission.report_back_to_agent) {
    try {
      const [a, b] = [agent.id, mission.report_back_to_agent as string].sort();
      let threadId: string;
      const { data: existing } = await admin.from("internal_agent_a2a_threads").select("id").eq("agent_a", a).eq("agent_b", b).maybeSingle();
      if (existing) threadId = (existing as { id: string }).id;
      else {
        const { data: created } = await admin.from("internal_agent_a2a_threads")
          .insert({ workspace_id: agent.workspace_id, project_id: agent.project_id, agent_a: a, agent_b: b, topic: `Re: ${mission.title}` })
          .select("id").single();
        threadId = (created as { id: string }).id;
      }
      const { data: rb } = await admin.from("internal_agent_a2a_messages").insert({
        thread_id: threadId, workspace_id: agent.workspace_id, project_id: agent.project_id,
        from_agent: agent.id, to_agent: mission.report_back_to_agent,
        content: `Delegated mission "${mission.title}" complete. Report:\n\n${finalOutput.slice(0, 3500)}`,
      }).select("id").single();
      if (rb) {
        const base = Deno.env.get("SUPABASE_URL"); const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (base && key) {
          fetch(`${base}/functions/v1/internal-agent-a2a`, {
            method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message_id: (rb as { id: string }).id }),
          }).catch(() => {});
        }
      }
    } catch { /* best-effort */ }
  }

  await logLlmUsage({
    workspace_id: agent.workspace_id, project_id: agent.project_id,
    provider: stats.provider, model: stats.model,
    task: "content_generation", feature: "internal-agent-mission",
    custom: stats.custom,
    // Ligne de SYNTHÈSE du run : la dépense a déjà été facturée tick par tick
    // (voir la télémétrie par tour). On la garde pour le monitoring, pas pour
    // la facturation — sinon chaque run serait débité deux fois.
    billable: false,
    usage: { prompt_tokens: stats.tokIn, completion_tokens: stats.tokOut, total_tokens: stats.tokIn + stats.tokOut },
    metadata: { run_id: runId, agent_id: agent.id, mode: "mission", custom: !!stats.custom },
  });
  // If the mission was created from a channel (e.g. a Slack "mission: …"), post
  // the completion report back into that thread.
  await postMissionReportToChannel(admin, mission.id, finalOutput);
}

// Post a mission's completion report to its bound channel (Slack thread).
async function postMissionReportToChannel(
  admin: ReturnType<typeof createServiceClient>,
  missionId: string,
  report: string,
) {
  try {
    const { data: m } = await admin
      .from("internal_agent_missions")
      .select("title, channel_id, external_channel_ref, external_thread_ref")
      .eq("id", missionId).maybeSingle();
    if (!m?.channel_id || !m.external_channel_ref) return;
    const { data: ch } = await admin
      .from("internal_agent_channels").select("provider, service_url").eq("id", m.channel_id).maybeSingle();
    const body = report.replace(/[#*`>_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 2500);

    if (ch?.provider === "teams") {
      await teamsSendMessage(ch.service_url, m.external_channel_ref,
        `✅ Mission **${m.title}** terminée.\n\n${body}\n\n_(Livrables complets dans l'onglet Deliverables.)_`);
      return;
    }
    // Slack
    const { data: tok } = await admin
      .from("internal_agent_channel_tokens").select("access_token").eq("channel_id", m.channel_id).maybeSingle();
    if (!tok?.access_token) return;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        channel: m.external_channel_ref,
        thread_ts: m.external_thread_ref || undefined,
        text: `✅ Mission *${m.title}* terminée.\n\n${body}\n\n_(Livrables complets dans l'onglet Deliverables.)_`,
      }),
    }).catch(() => {});
  } catch { /* best-effort */ }
}

// Post an agent reply back to whatever channel the conversation is bound to: an
// external Slack thread and/or an in-app project-inbox channel. Best-effort — a
// channel failure must never block finalization.
async function postReplyToBoundChannel(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  conversationId: string,
  text: string,
) {
  try {
    const { data: convo } = await admin
      .from("internal_agent_conversations")
      .select("channel_id, external_channel_ref, external_thread_ref, inbox_channel_id, workspace_id, project_id")
      .eq("id", conversationId).maybeSingle();
    if (!convo) return;

    // In-app project-inbox mirror (repairs the async-chat regression).
    if (convo.inbox_channel_id) {
      await admin.from("project_messages").insert({
        workspace_id: convo.workspace_id, project_id: convo.project_id,
        channel_id: convo.inbox_channel_id, author_kind: "agent", agent_id: agent.id,
        body: text.slice(0, 12000),
      }).then(() => {}, () => {});
    }

    // External channel (Slack thread / Teams conversation).
    if (convo.channel_id && convo.external_channel_ref) {
      const { data: ch } = await admin
        .from("internal_agent_channels").select("provider, service_url").eq("id", convo.channel_id).maybeSingle();
      if (ch?.provider === "teams") {
        await teamsSendMessage(ch.service_url, convo.external_channel_ref, text.slice(0, 12000));
      } else if (ch?.provider === "slack") {
        const { data: tok } = await admin
          .from("internal_agent_channel_tokens").select("access_token").eq("channel_id", convo.channel_id).maybeSingle();
        if (tok?.access_token) {
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({
              channel: convo.external_channel_ref,
              thread_ts: convo.external_thread_ref || undefined,
              text: text.slice(0, 3500),
            }),
          }).catch(() => {});
        }
      }
    }
  } catch { /* best-effort */ }
}

// Mark the run's todo checklist complete on a successful finish (blocked items
// keep their status — they tell the story of what didn't work).
async function completeRunTodos(
  admin: ReturnType<typeof createServiceClient>,
  runId: string,
) {
  try {
    const { data: r } = await admin.from("internal_agent_runs").select("todos").eq("id", runId).maybeSingle();
    const todos = Array.isArray(r?.todos) ? (r!.todos as Array<Record<string, unknown>>) : [];
    if (!todos.length) return;
    const done = todos.map((t) => ({ ...t, status: t.status === "blocked" ? "blocked" : "done" }));
    await admin.from("internal_agent_runs").update({ todos: done }).eq("id", runId);
  } catch { /* best-effort */ }
}

// Finalize a chat run: post the assistant reply, mark the run succeeded and
// bump the conversation. The chat equivalent of finalizeMissionSuccess.
/** UI blocks the agent attached during the run (render_ui → 'ui' events). */
async function collectUiBlocks(
  admin: ReturnType<typeof createServiceClient>,
  runId: string,
): Promise<Array<Record<string, unknown>> | null> {
  try {
    const { data } = await admin
      .from("internal_agent_run_events")
      .select("payload")
      .eq("run_id", runId).eq("kind", "ui")
      // Deliverables now emit a block too, so a productive run legitimately has
      // more than a handful; a cap of 8 silently swallowed the later cards.
      .order("created_at", { ascending: true }).limit(24);
    const blocks = (data ?? [])
      .map((e: { payload?: { block?: Record<string, unknown> } }) => e.payload?.block)
      .filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
    return blocks.length ? blocks : null;
  } catch {
    return null;
  }
}

async function finalizeChatSuccess(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  conversationId: string,
  runId: string,
  finalOutput: string,
  stats: { tokIn: number; tokOut: number; cost: number; actions: number; provider: string; model: string; custom?: boolean },
) {
  const reply = finalOutput?.trim() || "(no reply)";
  const uiBlocks = (await collectUiBlocks(admin, runId)) ?? [];
  // Attach any deliverables produced this run as openable cards ON the message —
  // guarantees the card renders inline (not dependent on a separate client query
  // that can miss on timing). Covers ctx.createDeliverable + materialize + salvage.
  const { data: delivs } = await admin
    .from("internal_agent_deliverables").select("id, name, kind")
    .eq("run_id", runId).order("created_at", { ascending: true });
  const deliverableBlocks = (delivs ?? []).map((d) => ({
    component: "deliverable",
    props: { id: (d as { id: string }).id, name: (d as { name: string }).name, kind: (d as { kind: string }).kind, agentId: agent.id },
  }));
  const allBlocks = [...uiBlocks, ...deliverableBlocks];
  await admin.from("internal_agent_messages").insert({
    conversation_id: conversationId, agent_id: agent.id, role: "assistant",
    content: reply, run_id: runId, ui_blocks: allBlocks.length ? allBlocks : null,
    tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost,
  });
  await completeRunTodos(admin, runId);
  await admin.from("internal_agent_runs").update({
    status: "succeeded", finished_at: new Date().toISOString(), final_output: finalOutput?.slice(0, 2000),
    tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost,
    action_count: stats.actions, steps: stats.actions,
  }).eq("id", runId);
  await admin.from("internal_agent_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  // Mirror the reply to any bound channel (Slack thread / project inbox) —
  // channels can't render UI blocks, so strip the [[ui:N]] placement tags.
  await postReplyToBoundChannel(admin, agent, conversationId, reply.replace(/\n?\[\[ui:\d+\]\]\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
  await logLlmUsage({
    workspace_id: agent.workspace_id, project_id: agent.project_id,
    provider: stats.provider, model: stats.model, task: "chat_simple", feature: "internal-agent-chat",
    custom: stats.custom,
    billable: false, // synthèse du run — déjà facturé par tick
    usage: { prompt_tokens: stats.tokIn, completion_tokens: stats.tokOut, total_tokens: stats.tokIn + stats.tokOut },
    metadata: { run_id: runId, agent_id: agent.id, mode: "chat", custom: !!stats.custom },
  });
}

/**
 * Persist a report the agent built section-by-section but never finalised.
 *
 * `report_section` accumulates into run_state.meta.report_draft, and only
 * `create_deliverable(kind="report")` turns it into a row. A run that stops
 * before that call — budget exhausted, approval gate, context overflow, or a
 * worker killed and later reaped (which DELETES the state row) — used to throw
 * the whole report away: the human then sees an agent claiming a report that
 * exists nowhere. Called from every terminal path, idempotent by the count
 * check below.
 */
async function salvageReportDraft(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  runId: string,
  state: { mission_id: string | null; conversation_id: string | null },
): Promise<boolean> {
  try {
    const { data: fs } = await admin.from("internal_agent_run_state").select("meta").eq("run_id", runId).maybeSingle();
    const draft = ((fs as { meta?: { report_draft?: { title?: string; subtitle?: string; author?: string; summary?: string; sections?: unknown[] } } } | null)?.meta?.report_draft) ?? null;
    if (!draft || !Array.isArray(draft.sections) || draft.sections.length === 0) return false;
    const { count } = await admin.from("internal_agent_deliverables")
      .select("id", { count: "exact", head: true }).eq("run_id", runId).eq("kind", "report");
    if ((count ?? 0) > 0) return false;
    const content = JSON.stringify({
      title: draft.title || "Rapport", subtitle: draft.subtitle, author: draft.author,
      summary: draft.summary, sections: draft.sections,
    });
    await admin.from("internal_agent_deliverables").insert({
      run_id: runId, mission_id: state.mission_id ?? null, conversation_id: state.conversation_id,
      agent_id: agent.id, kind: "report", name: draft.title || "Rapport",
      content, summary: (draft.summary || draft.title || "Rapport").slice(0, 200),
    }).then(() => {}, () => {});
    await admin.from("internal_agent_run_events").insert({
      run_id: runId, agent_id: agent.id, kind: "status",
      payload: { message: `Rapport « ${draft.title || "Rapport"} » sauvegardé depuis les ${draft.sections.length} sections construites (le run s'est arrêté avant de le finaliser).` },
    }).then(() => {}, () => {});
    return true;
  } catch {
    return false; // best-effort salvage
  }
}

/** Every card this run produced: UI blocks it emitted, plus its deliverables,
 *  de-duplicated (createDeliverable now emits its own block, and a run from
 *  before that change has only the row). */
async function runCards(
  admin: ReturnType<typeof createServiceClient>,
  runId: string,
  agentId: string,
): Promise<Array<Record<string, unknown>>> {
  const uiBlocks = (await collectUiBlocks(admin, runId)) ?? [];
  const seen = new Set(
    uiBlocks
      .filter((b) => b.component === "deliverable")
      .map((b) => String((b.props as { id?: string } | undefined)?.id ?? "")),
  );
  const { data: delivs } = await admin
    .from("internal_agent_deliverables").select("id, name, kind")
    .eq("run_id", runId).order("created_at", { ascending: true });
  const deliverableBlocks = (delivs ?? [])
    .filter((d) => !seen.has((d as { id: string }).id))
    .map((d) => ({
      component: "deliverable",
      props: { id: (d as { id: string }).id, name: (d as { name: string }).name, kind: (d as { kind: string }).kind, agentId },
    }));
  return [...uiBlocks, ...deliverableBlocks];
}

/**
 * Close a room turn that did NOT end in success — an approval gate, a question,
 * an exhausted budget, an unreachable sandbox.
 *
 * These paths used to write plain text over the placeholder, discarding the
 * cards for work the agent had genuinely finished before it stopped. Stopping
 * early is not the same as producing nothing, and the room has to show the
 * difference.
 */
async function closeRoomMessage(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  room: { room_id: string; placeholder_id: string },
  runId: string,
  content: string,
  status: "done" | "failed",
) {
  const blocks = await runCards(admin, runId, agent.id);
  await admin.from("service_room_messages").update({
    content, status, run_id: runId, ui_blocks: blocks.length ? blocks : null,
  }).eq("id", room.placeholder_id);
  await admin.from("service_rooms").update({ updated_at: new Date().toISOString() }).eq("id", room.room_id);
}

// Finalize a ROOM-bound run on the durable tick engine: update the room
// placeholder message (content + UI blocks + deliverable cards produced) so the
// room reply materialises exactly like a chat reply — but survives the edge
// wall-clock because it ran on the tick queue. The room equivalent of
// finalizeChatSuccess.
async function finalizeRoomSuccess(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  room: { room_id: string; placeholder_id: string },
  runId: string,
  finalOutput: string,
  stats: { tokIn: number; tokOut: number; cost: number; actions: number; provider: string; model: string; custom?: boolean },
) {
  const reply = (finalOutput?.trim() || "Terminé — voir les cartes ci-dessus.")
    .replace(/\n?\[\[ui:\d+\]\]\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const allBlocks = await runCards(admin, runId, agent.id);
  await admin.from("service_room_messages").update({
    content: reply, ui_blocks: allBlocks.length ? allBlocks : null, status: "done", run_id: runId,
  }).eq("id", room.placeholder_id);
  await completeRunTodos(admin, runId);
  await admin.from("internal_agent_runs").update({
    status: "succeeded", finished_at: new Date().toISOString(), final_output: finalOutput?.slice(0, 2000),
    tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost, action_count: stats.actions, steps: stats.actions,
  }).eq("id", runId);
  await admin.from("service_rooms").update({ updated_at: new Date().toISOString() }).eq("id", room.room_id);
  await logLlmUsage({
    workspace_id: agent.workspace_id, project_id: agent.project_id,
    provider: stats.provider, model: stats.model, task: "chat_simple", feature: "internal-agent-room",
    custom: stats.custom,
    billable: false, // synthèse du run — déjà facturé par tick
    usage: { prompt_tokens: stats.tokIn, completion_tokens: stats.tokOut, total_tokens: stats.tokIn + stats.tokOut },
    metadata: { run_id: runId, agent_id: agent.id, mode: "room", custom: !!stats.custom },
  });
}

// ── Context window (sliding, no summary) ───────────────────────────────────────
// run_state.messages grows across hundreds of rounds while the model's context is
// finite. Rather than summarizing the middle (an extra LLM call that could strand
// tool-call pairs — the "400 tool_calls must be followed by tool messages" bug),
// we keep a SLIDING WINDOW: the head (system + original task) plus the most recent
// turns up to a char budget, and drop the old middle. Nothing critical is lost —
// the FOCUS header re-injects the objective + todo state on every tick, and the
// agent can call search_history / recall to retrieve a specific past detail.
// Mutates `messages` in place. Returns true when it trimmed.
// Budgets scale with the request class (see contextBudgetFor): a `social` turn
// keeps a tiny recency window, a `full` turn the largest.
// The sealed zone is a contiguous run of these markers, sitting right after the
// head (system + task grounding). It is APPEND-ONLY: a marker is written once
// and never re-sealed, so the byte-identical prefix [head][sealed zone] stays
// provider-cacheable across ticks, and only a compaction invalidates it.
// NOTE: ASCII-only on purpose — some in-flight markers were written by older
// builds in a double-encoded form, so we match on the encoding-agnostic head.
const SEALED_PREFIX = "[Segment scell";

/** Deterministic digest of a transcript span about to be sealed away: what was
 *  called, what was produced, what failed. No LLM — it must be free, instant and
 *  incapable of inventing anything. This is what stops the agent from redoing
 *  work whose evidence just left the context window. */
function sealDigest(span: ChatMessage[]): string {
  const toolCounts = new Map<string, number>();
  const paths = new Set<string>();
  const produced = new Set<string>();
  const errors = new Set<string>();

  for (const m of span) {
    for (const c of (m as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls ?? []) {
      const name = c.function?.name;
      if (!name) continue;
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      try {
        const a = JSON.parse(c.function?.arguments || "{}") as Record<string, unknown>;
        for (const k of ["path", "file_path", "file", "url", "name"]) {
          const v = a[k];
          if (typeof v === "string" && v.length < 200) paths.add(v);
        }
      } catch { /* unparsable args are not worth a digest line */ }
    }
    if (m.role !== "tool") continue;
    const text = String(m.content ?? "");
    const made = text.match(/Deliverable "([^"]+)"|Family (\w+) loaded|saved to ([^\s]+)/);
    if (made) produced.add((made[1] ?? made[2] ?? made[3])!);
    if (text.startsWith("ERROR")) errors.add(text.slice(0, 140));
  }

  const top = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([n, c]) => (c > 1 ? `${n}×${c}` : n));
  const lines: string[] = [];
  if (top.length) lines.push(`- Outils appelés : ${top.join(", ")}`);
  if (paths.size) lines.push(`- Fichiers / cibles touchés : ${[...paths].slice(0, 15).join(", ")}`);
  if (produced.size) lines.push(`- Produits : ${[...produced].slice(0, 10).join(", ")}`);
  if (errors.size) lines.push(`- Échecs rencontrés (ne pas réessayer à l'identique) :\n  ${[...errors].slice(0, 5).join("\n  ")}`);
  return lines.length ? lines.join("\n") : "- (aucune action outillée dans ce segment)";
}
function compactMessagesIfNeeded(
  messages: ChatMessage[],
  budget: ContextBudget = contextBudgetFor("full"),
): boolean {
  if (messages.length < 16) return false;
  if (JSON.stringify(messages).length < budget.triggerChars) return false;
  const keepHead = Math.min(2, messages.length); // system + original task (grounding)

  // Locate the end of the SEALED zone: consecutive markers right after the head.
  // Markers are never re-sealed - they accumulate as the stable cache prefix.
  let sealEnd = keepHead;
  while (
    sealEnd < messages.length &&
    messages[sealEnd].role === "user" &&
    String(messages[sealEnd].content ?? "").startsWith(SEALED_PREFIX)
  ) sealEnd++;

  // Grow the recent-window backwards from the end until the char budget is hit.
  let start = messages.length;
  let size = 0;
  while (start > sealEnd) {
    size += JSON.stringify(messages[start - 1]).length;
    if (size > budget.windowChars) break;
    start--;
  }
  // Never start the window on a tool message (would orphan it) ??" pull back to
  // include its calling assistant.
  while (start > sealEnd && messages[start]?.role === "tool") start--;
  if (start <= sealEnd + 1) return false; // window already covers (almost) everything
  const dropped = start - sealEnd;
  // SEAL, don't just drop: replace the removed span with a DETERMINISTIC digest
  // of what happened in it (no LLM call ??" cheap, and it can't hallucinate). A
  // bare "N messages removed" marker was the reason agents redid work they had
  // already done: nothing in context said what the dropped span accomplished.
  // The new marker is APPENDED at the end of the sealed zone (right before the
  // live window), never spliced into the middle - the seal is append-only.
  const digest = sealDigest(messages.slice(sealEnd, start));
  messages.splice(sealEnd, dropped, {
    role: "user",
    content:
      `[Segment scellé : ${dropped} messages retirés pour rester dans la fenêtre de contexte. ` +
      `Résumé factuel de ce segment ci-dessous — ce travail EST FAIT, ne le refais pas. ` +
      `Pour un détail précis, utilise search_context(scope="run").]\n${digest}`,
  });
  // Belt-and-suspenders: the drop can leave the last head message as an
  // assistant(tool_calls) whose responses were in the removed middle.
  sanitizeToolPairs(messages);
  return true;
}

// Guarantee valid tool-call pairing for the OpenAI-compatible API: every
// assistant message with tool_calls must be immediately followed by one tool
// message per tool_call_id, and no orphan tool messages may exist. Mutates in
// place. Runs after compaction (which can break pairs) and defensively before
// each model call.
function sanitizeToolPairs(messages: ChatMessage[]): void {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const tc = (m as { tool_calls?: Array<{ id: string }> }).tool_calls;
    if (m.role === "assistant" && tc?.length) {
      const toolMsgs: ChatMessage[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") { toolMsgs.push(messages[j]); j++; }
      const answered = new Set(toolMsgs.map((t) => (t as { tool_call_id?: string }).tool_call_id));
      if (tc.every((c) => answered.has(c.id))) {
        out.push(m, ...toolMsgs);
      } else {
        // Strip the (now unanswerable) tool_calls; keep any text so context stays.
        out.push({ role: "assistant", content: m.content ?? "[appel d'outil tronqué]" } as ChatMessage);
      }
      i = j - 1; // skip the tool messages we just consumed (or dropped)
    } else if (m.role === "tool") {
      // Orphan tool message (its calling assistant is gone) → drop it.
      continue;
    } else {
      out.push(m);
    }
  }
  messages.length = 0;
  messages.push(...out);
}

// ── Mission self-verification ─────────────────────────────────────────────────
// Before finalizing a mission, have a fast reviewer check the outcome against
// the brief/acceptance criteria and the deliverables actually produced. A FAIL
// feeds concrete gaps back into the loop instead of shipping a partial result.
async function verifyMissionOutcome(
  admin: ReturnType<typeof createServiceClient>,
  runId: string,
  mission: { title?: string; brief?: string | null; acceptance_criteria?: string | null } | null,
  finalOutput: string,
): Promise<{ pass: boolean; feedback: string } | null> {
  if (!mission?.brief && !mission?.acceptance_criteria) return null; // nothing to check against
  const { data: delivs } = await admin
    .from("internal_agent_deliverables").select("kind, name, content, file_url")
    .eq("run_id", runId).limit(12);
  const delivList = (delivs ?? [])
    .map((d: any) => `- [${d.kind}] ${d.name} — ${d.content ? `${String(d.content).length} chars` : d.file_url ? d.file_url : "empty"}`)
    .join("\n") || "(no deliverables produced)";
  const res = await callAi({
    task: "classification",
    // Cheap side-call: Groq when it is keyed, otherwise whatever is — this used
    // to be hard-coded and silently disabled mission verification on a
    // DeepSeek-only deployment.
    provider: cheapProvider(),
    jsonMode: true,
    maxTokens: 500,
    systemPrompt:
      'You are a strict QA reviewer for an autonomous agent\'s mission. Decide if the mission is genuinely COMPLETE. PASS only if the final report answers the brief AND every acceptance criterion is satisfied AND the expected deliverables exist (non-empty). Reply as JSON: {"verdict":"pass"|"fail","missing":"short concrete list of what is missing or wrong"}.',
    userPrompt: `MISSION: ${mission.title ?? ""}\n\nBRIEF:\n${(mission.brief ?? "").slice(0, 2000)}\n\nACCEPTANCE CRITERIA:\n${(mission.acceptance_criteria ?? "(none stated)").slice(0, 1200)}\n\nDELIVERABLES PRODUCED:\n${delivList}\n\nFINAL REPORT:\n${finalOutput.slice(0, 3500)}`,
  });
  const j = safeParseJson<{ verdict?: string; missing?: string }>(res.content);
  if (!j?.verdict) return null;
  return { pass: j.verdict.toLowerCase() === "pass", feedback: String(j.missing ?? "").slice(0, 800) };
}

const TICK_ROUNDS = 4;

/** Lease held while a tick processes a run. MUST stay LONGER than the pgmq
 *  visibility timeout used by drain_agent_ticks (180s): a redelivery that lands
 *  while a live tick is still working has to find the lease held and back off.
 *  A tick whose worker was killed therefore recovers on the SECOND redelivery
 *  (~6 min) — well inside the 12-minute zombie cutoff. */
const TICK_LEASE_MS = 4 * 60 * 1000;

// Process ONE tick of a mission: lease, run a few rounds against persisted
// state, then finalize / re-enqueue. Invoked by the pg_cron drainer via pg_net.
async function runMissionTick(runId: string, msgId: number | null) {
  const admin = createServiceClient();

  // Lease the state so two deliveries can't process the same run at once.
  const nowIso = new Date().toISOString();
  const { data: leased } = await admin
    .from("internal_agent_run_state")
    .update({ processing_until: new Date(Date.now() + TICK_LEASE_MS).toISOString() })
    .eq("run_id", runId)
    .or(`processing_until.is.null,processing_until.lt.${nowIso}`)
    .select("*")
    .maybeSingle();
  if (!leased) {
    // Someone else holds the lease. Do NOT ack: pgmq redelivers the SAME message
    // (same msg_id), and the only worker allowed to delete it is the one that
    // owns the tick — via agent_tick_next when it chains the next one. Acking
    // here dropped the run's only queued tick, so a worker the edge runtime had
    // already killed left the run with nothing to wake it: the mission stayed
    // "en cours" and never moved again.
    return jsonResponse({ ok: true, skipped: true });
  }
  const state = leased as {
    run_id: string; agent_id: string; mission_id: string | null; conversation_id: string | null; mode: string;
    messages: ChatMessage[];
    round: number; max_rounds: number; provider: string | null; model: string | null;
    tokens_in: number; tokens_out: number; cost_usd: number; last_input_at: string | null;
    error_count: number; replans: number; verify_fails: number; meta: Record<string, unknown> | null;
    // Loop engine (migration 0164): the durable half of the control system.
    contract: SuccessContract | null; progress: ProgressFingerprint | null;
    stagnation: number; iteration: number;
  };
  const isChat = state.mode === "chat" || !state.mission_id;
  // Room-bound run: same durable tick engine as chat, but the reply/deliverables
  // are posted back to a room placeholder message instead of a conversation.
  const roomBinding = ((state.meta as { room?: { room_id: string; placeholder_id: string } } | undefined)?.room) ?? null;
  // Room MISSION task: this run executes one card of a multi-agent mission. Its
  // outcome is what unblocks the tasks waiting on it, so every terminal path
  // below (success, failure, cancellation) must report back — a task whose run
  // ends silently would stall the whole mission.
  const missionTask = ((state.meta as { mission_task?: { mission_id: string; task_id: string } } | undefined)?.mission_task) ?? null;
  const reportMissionTask = async (ok: boolean, output: string) => {
    if (!missionTask?.task_id || !missionTask.mission_id) return;
    await completeMissionTask(admin, {
      missionId: missionTask.mission_id, taskId: missionTask.task_id, ok, output,
    }).catch(() => {});
  };

  // Run no longer active? clean up.
  const { data: runRow } = await admin.from("internal_agent_runs")
    .select("status, error_message").eq("id", runId).maybeSingle();
  if (!runRow || ["cancelled", "failed", "succeeded"].includes(runRow.status as string)) {
    // Report before cleaning up. This branch is what the zombie reconciler
    // leaves behind (it flips a timed-out run to 'failed' from SQL, which no
    // TypeScript path observes) — returning silently left the mission's task
    // 'in_progress' for good, and the mission "en cours" with nothing running.
    const st = (runRow?.status as string | undefined) ?? "disparu";
    await reportMissionTask(
      st === "succeeded",
      st === "succeeded"
        ? "Run terminé hors tick — résultat repris depuis la room."
        : `Run ${st} avant d'avoir rendu son résultat${(runRow as { error_message?: string } | null)?.error_message ? ` : ${(runRow as { error_message?: string }).error_message}` : "."}`,
    );
    await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
    if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
    return jsonResponse({ ok: true, done: true });
  }

  const { agent, tools } = await loadAgentAndTools(state.agent_id);
  // Resolve the model endpoint once per tick (provider-aware; decrypts the key).
  const agentEndpoint = await resolveAgentEndpoint(admin, agent);

  // ── Provider for this tick ────────────────────────────────────────────────
  // The persisted provider wins — a run must not change vendor mid-flight just
  // because someone edited the agent — but it is VALIDATED: a provider whose key
  // has since been removed would otherwise 400 on every round for the rest of
  // the run, which reads as an outage rather than a misconfiguration.
  let tickProvider: Provider = (state.provider === "groq" || state.provider === "deepseek")
    ? state.provider
    : providerFor(agent);
  let tickModel = resolveRunStateModel(state.model, tickProvider, agent);
  const usable = availableProviders();
  const providerUnavailable = usable.length > 0 && !usable.includes(tickProvider);
  if (providerUnavailable) tickProvider = defaultProvider();
  const { data: mission } = state.mission_id
    ? await admin.from("internal_agent_missions")
        .select("id, title, brief, acceptance_criteria, schedule, report_back_to_agent, delegation_depth")
        .eq("id", state.mission_id).maybeSingle()
    : { data: null };
  const runtimeConfig = await loadRuntimeConfig(admin);
  const ctx = makeToolContext({ admin, agent, runId, missionId: state.mission_id, conversationId: state.conversation_id, delegationDepth: (mission as { delegation_depth?: number } | null)?.delegation_depth ?? 0, runtimeConfig });
  ctx.skills = await loadActivatedSkills(admin, agent.id);
  ctx.mcpServers = await loadActivatedMcpServers(admin, agent.id);
  // ── Guardrails (runtime enforcement) ──────────────────────────────────────
  // Loaded once per tick. Only guardrails carrying a match_pattern are enforced;
  // documentation-only rules are never evaluated. Best-effort: a load failure
  // means "no guardrails" rather than a broken run.
  const guardrails = await loadGuardrails(admin, agent.workspace_id, agent.project_id);
  // This is a PRIMARY run — let it fan independent subtasks out to ephemeral
  // parallel sub-agents (children run in-process and stream to their own runId).
  ctx.spawnParallel = (subtasks) => runParallelSubagents({
    admin, parentRunId: runId,
    agentId: agent.id, workspaceId: agent.workspace_id, projectId: agent.project_id, createdBy: agent.created_by ?? null,
    tools, provider: tickProvider, endpoint: agentEndpoint, temperature: agent.temperature ?? 0.3,
    parentLogEvent: (p) => ctx.logEvent("status", p),
    makeChildContext: (childRunId) => {
      const c = makeToolContext({ admin, agent, runId: childRunId, missionId: null, conversationId: null, delegationDepth: (ctx.delegationDepth ?? 0) + 1, runtimeConfig });
      c.skills = ctx.skills; c.mcpServers = ctx.mcpServers; c.isSubagent = true;
      return c;
    },
    buildChildSystem: (cap, c) => buildSystemPrompt(agent, cap, "mission", "", "", "", "", isSecurityAgent(c.skills), "", undefined, true).prompt,
    maxConcurrency: agent.swarm_max_concurrency ?? undefined,
  }, subtasks);
  // HYBRID: re-probe both worlds each tick and strip whichever is unreachable, so
  // the toolset rebuilt below exposes only healthy worlds (and recovers a world
  // that comes back). Cheap (two parallel health pings) and keeps the agent from
  // grinding against a dead tunnel when the other world is fine.
  if (ctx.hybrid) {
    const h = await gateHybridHealth(ctx);
    if (h.note) await ctx.logEvent("status", { message: `Mode hybride — ${h.note}. Le tick continue avec le monde disponible.` }).catch(() => {});
  }
  // ── Progressive disclosure of tool schemas ────────────────────────────────
  // The tier is decided once per turn by the request classifier and carried in
  // meta. Families the agent pulled in with load_toolset survive across ticks,
  // so it never has to re-discover its own toolbox.
  const metaNow = (state.meta ?? {}) as Record<string, unknown>;
  let toolTier: ToolTier = (metaNow.tool_tier as ToolTier) ?? "full";
  const loadedFamilies = new Set<string>(
    Array.isArray(metaNow.loaded_families) ? (metaNow.loaded_families as string[]) : [],
  );
  ctx.loadedFamilies = [...loadedFamilies];
  ctx.onToolsetLoaded = async (family) => {
    if (family === "*") toolTier = "full";
    else loadedFamilies.add(family);
  };

  const { defs, defsFor, executor } = buildInternalToolset(tools, ctx);

  // ── Per-round tool selection (prompt compiler) ─────────────────────────────
  // Tool schemas are re-sent on EVERY round, so on a wide agent (connectors +
  // MCP servers + both execution worlds) they are the single largest recurring
  // input cost — larger than the transcript. The compiler ranks them against
  // what this tick is actually about and sends the ones that matter, under a
  // char budget.
  //
  // This can only ever cost a round, never a capability: the toolbox INDEX in
  // the system prompt still names every tool, need_tools("…") restores the full
  // set inside the same turn, and anything the agent called recently is pinned
  // so a multi-step pipeline can't lose its tool mid-way.
  const TOOL_SCHEMA_BUDGET = 55_000;      // ≈14k tokens of JSON schema per round
  const PINNED_TOOLS = new Set([
    "ask_user", "update_todos", "create_deliverable", "report_section", "render_ui",
    "search_context", "load_toolset", "need_tools", "say", "use_skill", "read_skill_file",
    "save_memory", "spawn_parallel_agents",
  ]);
  /** Tools called in the recent transcript — the agent is mid-pipeline with
   *  them, so their schemas stay whatever the ranking says. */
  const recentlyUsedTools = (msgs: ChatMessage[]): string[] => {
    const out = new Set<string>();
    for (const m of msgs.slice(-24)) {
      for (const c of (m as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls ?? []) {
        if (c.function?.name) out.add(c.function.name);
      }
    }
    return [...out];
  };
  /** need_tools / load_toolset("*") turns selection OFF for the rest of the
   *  tick — the agent explicitly asked for everything. */
  let fullSchemas = false;
  const prevOnToolsetLoaded = ctx.onToolsetLoaded;
  ctx.onToolsetLoaded = async (family) => {
    if (family === "*") fullSchemas = true;
    await prevOnToolsetLoaded?.(family);
  };
  let toolStats = { sent: defs.length, omitted: 0, chars: 0 };
  /** Schemas for the current round — re-evaluated every round so a mid-loop
   *  need_tools / load_toolset is honoured immediately, not next tick. */
  const liveTools = () => {
    const base = defsFor(toolTier);
    if (fullSchemas || toolTier === "social") {
      toolStats = { sent: base.length, omitted: 0, chars: 0 };
      return base;
    }
    const sel = selectTools(base, {
      task: tickTaskText,
      keep: [...PINNED_TOOLS, ...recentlyUsedTools(state.messages)],
      budget: TOOL_SCHEMA_BUDGET,
      floorCount: 14,
    });
    toolStats = { sent: sel.defs.length, omitted: sel.omitted.length, chars: sel.chars };
    return sel.defs;
  };
  // Compact long string args (file content, code, html…) so the live timeline
  // shows WHAT a call does without storing megabytes per event.
  const compactArgs = (a: any): any => {
    if (!a || typeof a !== "object") return a;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) {
      out[k] = typeof v === "string" && v.length > 700 ? `${v.slice(0, 700)}… (+${v.length - 700} chars)` : v;
    }
    return out;
  };
  // Per-tool consecutive-failure tally (circuit breaker). Survives ticks via
  // run_state.meta.tool_fails. A tool that keeps erroring — even with DIFFERENT
  // args each time (so the identical-signature loop guard misses it, e.g. trying
  // slug after slug of a broken integration) — trips a breaker below.
  const toolFails: Record<string, number> = {
    ...((state.meta as { tool_fails?: Record<string, number> } | undefined)?.tool_fails ?? {}),
  };
  // ── Repeated-research guard ───────────────────────────────────────────────
  // The identical-signature loop guard below compares the LAST call only, and a
  // model researching a topic never repeats itself exactly: it rotates through
  // "McKinsey France effectif 2024", "McKinsey France 700 consultants Paris",
  // "McKinsey France effectif consultants CA 2023"… Each signature differs from
  // the previous one, so sig_count resets every call and the run can search the
  // same six things until the wall clock kills it — which is exactly what a
  // stuck research mission looks like from the outside.
  //
  // So searches are deduplicated SEMANTICALLY and across the whole run: the
  // query is normalised (accents, stop-words, order) and a repeat is answered
  // without spending the call, with an instruction to move on to reading.
  const searchSigs: Record<string, number> = {
    ...((state.meta as { search_sigs?: Record<string, number> } | undefined)?.search_sigs ?? {}),
  };
  const SEARCH_TOOLS = new Set(["web_search", "deep_research", "search_knowledge", "search_memory", "search_past_work"]);
  const querySig = (name: string, args: Record<string, unknown>): string | null => {
    if (!SEARCH_TOOLS.has(name)) return null;
    const q = String((args?.query ?? args?.q ?? "") || "").toLowerCase();
    if (!q) return null;
    const words = q
      .normalize("NFD").replace(/[̀-ͯ]/g, "")   // strip accents
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !/^(les|des|une|dans|pour|avec|sur|par|the|and|for|with|from)$/.test(w))
      .sort();
    return words.length ? `${name}:${[...new Set(words)].join(" ")}` : null;
  };

  // ── The two memories ──────────────────────────────────────────────────────
  // TEMPORARY (this run): every research result is written in full to the run's
  // event log, which compaction never touches, and read back with
  // recall_findings. The transcript can shrink without the facts being lost.
  // PERMANENT (across runs): the same material is condensed into
  // internal_agent_memories at the end of the run, so the NEXT mission on the
  // same subject searches memory instead of paying for the web again.
  const RESEARCH_TOOLS = new Set(["web_search", "deep_research", "read_url", "http_get", "browse_web", "search_knowledge"]);
  const findings: Array<{ tool: string; label: string; text: string }> = [];
  const recordFinding = async (tool: string, args: Record<string, unknown>, text: string) => {
    const label = String(args?.query ?? args?.url ?? args?.q ?? "").slice(0, 200) || tool;
    const body = text.slice(0, 12_000);
    findings.push({ tool, label, text: body });
    await admin.from("internal_agent_run_events").insert({
      run_id: runId, agent_id: agent.id, kind: "log",
      payload: { finding: { tool, label, text: body } },
    }).then(() => {}, () => {});
  };

  // Before the FIRST web search of a run, look in permanent memory. Done here
  // rather than trusted to the prompt: "check your memory first" is advice a
  // model skips, a prepended hit is a fact it cannot miss — and it is the whole
  // point of remembering, that the second mission on a subject costs less.
  let memoryProbed = false;
  const probeMemory = async (query: string): Promise<string> => {
    if (memoryProbed || !query.trim()) return "";
    memoryProbed = true;
    try {
      const { data } = await admin.from("internal_agent_memories")
        .select("content, created_at")
        .eq("project_id", agent.project_id)
        .in("kind", ["context", "learning", "fact"])
        .order("created_at", { ascending: false }).limit(60);
      const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const hits = (data ?? [])
        .map((m) => String((m as { content: string }).content ?? ""))
        .filter((c) => terms.filter((t) => c.toLowerCase().includes(t)).length >= 2)
        .slice(0, 3);
      if (hits.length === 0) return "";
      await ctx.logEvent("status", { message: `${hits.length} élément(s) déjà en mémoire sur ce sujet — réutilisés au lieu d'être recherchés.` }).catch(() => {});
      return `⚡ DÉJÀ EN MÉMOIRE (travail antérieur sur ce sujet — vérifie la date, réutilise plutôt que de rechercher) :\n${hits.map((h) => `- ${h.slice(0, 700)}`).join("\n")}\n\n— Résultats web ci-dessous —\n`;
    } catch { return ""; }
  };

  const loggingExecutor: typeof executor = async (name, args) => {
    // Short-circuit a search this run has already run. Cheaper than the call,
    // and far more useful to the model than the same snippets a third time.
    const sig = querySig(name, args ?? {});
    if (sig) {
      const seen = (searchSigs[sig] ?? 0) + 1;
      searchSigs[sig] = seen;
      if (seen > 1) {
        const distinct = Object.keys(searchSigs).length;
        const msg = `ERROR: recherche déjà effectuée dans ce run (${seen}× « ${String(args?.query ?? "")} »). Ses résultats sont DÉJÀ dans ton contexte plus haut — les relancer ne donnera rien de neuf.\n`
          + `Tu as lancé ${distinct} recherches distinctes. Passe à l'exploitation : ouvre les URL les plus prometteuses avec read_url(url) pour en extraire les chiffres, puis écris tes sections avec report_section. `
          + `Si une donnée reste introuvable après lecture, écris « non publié » et avance — ne reformule pas la même requête.`;
        await ctx.logEvent("tool_call", { tool: name, args: compactArgs(args), deduped: true });
        await ctx.logEvent("tool_result", { tool: name, preview: msg.slice(0, 400), ok: false, deduped: true });
        return msg;
      }
    }
    await ctx.logEvent("tool_call", { tool: name, args: compactArgs(args) });
    // ── Guardrails — tool_call scope ─────────────────────────────────────────
    // Tested BEFORE execution: a block stops the tool from ever running (the
    // model receives an explanatory ERROR as its result), warn/log just trace.
    if (guardrails.length > 0) {
      const probe = `${name}\n${JSON.stringify(args ?? {})}`;
      const hits = checkGuardrails(guardrails, "tool_call", probe);
      if (hits.length > 0) {
        const block = strongestEnforcement(hits) === "block";
        for (const v of hits) {
          await ctx.logEvent("guardrail", {
            scope: "tool_call", guardrail: v.title, category: v.category,
            enforcement: v.enforcement, tool: name, matched: v.matched,
            blocked: block,
          }).catch(() => {});
        }
        if (block) {
          await recordGuardrailIncident(admin, agent, runId, hits[0].title, "tool_call", hits[0].matched).catch(() => {});
          const msg = `ERROR: Action bloquée par le guardrail « ${hits[0].title} » (${hits[0].matched ? `correspondance : ${hits[0].matched}` : "règle de sécurité"}). Réessayez autrement ou expliquez l'action requise à l'utilisateur.`;
          await ctx.logEvent("tool_result", { tool: name, preview: msg.slice(0, 1000), ok: false, guardrail: true }).catch(() => {});
          return msg;
        }
      }
    }
    const r = await executor(name, args);
    const text = String(r);
    const ok = !text.startsWith("ERROR");
    toolFails[name] = ok ? 0 : (toolFails[name] ?? 0) + 1;
    // Step-level evidence: a successful tool result is what lets the agent close
    // a checklist item. update_todos resets the counter itself.
    if (ok && name !== "update_todos" && ctx.loopEvidence) ctx.loopEvidence.results++;
    // ── Guardrails — tool_result scope ───────────────────────────────────────
    if (guardrails.length > 0 && text) {
      const hits = checkGuardrails(guardrails, "tool_result", text.slice(0, 4000));
      if (hits.length > 0) {
        const block = strongestEnforcement(hits) === "block";
        for (const v of hits) {
          await ctx.logEvent("guardrail", {
            scope: "tool_result", guardrail: v.title, category: v.category,
            enforcement: v.enforcement, tool: name, matched: v.matched,
            blocked: block,
          }).catch(() => {});
        }
        if (block) {
          await recordGuardrailIncident(admin, agent, runId, hits[0].title, "tool_result", hits[0].matched).catch(() => {});
          const redacted = `ERROR: Résultat bloqué par le guardrail « ${hits[0].title} » — le contenu renvoyé enfreint une règle de sécurité et n'est pas transmis.`;
          await ctx.logEvent("tool_result", { tool: name, preview: redacted.slice(0, 1000), ok: false, guardrail: true }).catch(() => {});
          return redacted;
        }
      }
    }
    await ctx.logEvent("tool_result", { tool: name, preview: text.slice(0, 1000), ok });
    // Keep the full result out-of-band, and enrich the FIRST search with what
    // we already knew. Both are best-effort: research must never fail on its
    // bookkeeping.
    if (ok && RESEARCH_TOOLS.has(name) && text.length > 80) {
      await recordFinding(name, args ?? {}, text).catch(() => {});
      if (name === "web_search" || name === "deep_research") {
        const known = await probeMemory(String((args as { query?: string })?.query ?? ""));
        if (known) return `${known}${text}`;
      }
    }
    return r;
  };

  const messages = state.messages;

  // Evidence carried over from the previous tick: tool results the transcript
  // holds since the last update_todos. Without this seed, a step whose work
  // finished at the end of tick N could not be closed at the start of tick N+1.
  ctx.loopEvidence = { results: evidenceSinceLastTodos(messages) };

  // ── Execution-world probe for contract checks ──────────────────────────────
  // file_exists / command_exits_zero are only verifiable when this agent has an
  // execution world. Without one the check is SKIPPED (never failed) — a
  // verifier that can't observe must not accuse.
  const hasTool = (n: string) => defs.some((d) => d.function.name === n);
  const readTool = ["file_read", "runner_file_read", "sandbox_file_read"].find(hasTool);
  const shellTool = ["shell_exec", "runner_shell_exec", "sandbox_shell_exec"].find(hasTool);
  const loopProbe: LoopProbe | undefined = (readTool || shellTool)
    ? async (kind, args) => {
        if (kind === "file_exists") {
          if (!readTool) return null;
          const path = String(args.path ?? "");
          if (!path) return null;
          const out = String(await executor(readTool, { file: path }).catch(() => "ERROR"));
          return out.startsWith("ERROR")
            ? { pass: false, detail: `${path} introuvable` }
            : { pass: true, detail: `${path} présent (${out.length} caractères)` };
        }
        if (!shellTool) return null;
        const command = String(args.command ?? "");
        if (!command) return null;
        const out = String(await executor(shellTool, { command }).catch(() => "ERROR"));
        const code = out.match(/\[exit:\s*(\d+)/)?.[1];
        if (out.startsWith("ERROR") || code == null) return { pass: false, detail: `commande non exécutable (${out.slice(0, 80)})` };
        return { pass: code === "0", detail: `\`${command.slice(0, 60)}\` → exit ${code}` };
      }
    : undefined;

  // Mid-run steering: fold in any user messages that arrived AFTER this run last
  // synced, so a correction/addition sent while the agent works is taken into
  // account on this tick (chat runs only).
  let newLastInputAt = state.last_input_at;
  if (isChat && state.conversation_id) {
    const since = state.last_input_at ?? new Date(0).toISOString();
    const { data: fresh } = await admin
      .from("internal_agent_messages")
      .select("content, created_at").eq("conversation_id", state.conversation_id).eq("role", "user")
      .gt("created_at", since).order("created_at", { ascending: true }).limit(10);
    if (fresh && fresh.length) {
      for (const m of fresh) {
        messages.push({ role: "user", content: `[The user sent this while you were working — take it into account, adjust course if needed]\n${m.content}` });
      }
      newLastInputAt = fresh[fresh.length - 1].created_at as string;
      await ctx.logEvent("status", { message: `Nouveau message reçu en cours d'exécution — pris en compte (${fresh.length}).` }).catch(() => {});
    }
  }

  // Compact the transcript when it gets heavy (protects the model's context
  // window on long runs). The budget scales with the request class: a `social`
  // turn barely reads history, a `full` turn pipelines across many rounds.
  // Best-effort — a compaction failure never blocks work.
  try {
    if (compactMessagesIfNeeded(messages, contextBudgetFor(toolTier))) {
      await ctx.logEvent("status", { message: "Fenêtre de contexte : l'historique ancien a été tronqué (objectif conservé, détails via search_context)." }).catch(() => {});
    }
  } catch { /* keep going untrimmed */ }
  // Defensive: guarantee valid tool-call pairing before the model call, whatever
  // upstream mutation (compaction, mid-run message folding) touched the tail.
  sanitizeToolPairs(messages);

  // ── FOCUS header: refresh situational awareness on EVERY tick ──────────────
  // Rebuilt from durable state (mission + structured todo tree) so the objective,
  // what's already done and what comes next survive long transcripts.
  //
  // EPHEMERAL: it is NOT written into `messages`. It used to be pushed in and
  // pulled back out on the next tick — mutating the MIDDLE of the transcript,
  // which invalidates the provider's prefix cache for everything after it, every
  // single tick. It is now handed to runToolRounds as an `ephemeral` thunk and
  // concatenated at send time, after the transcript: same visibility to the
  // model, zero cache invalidation, and nothing to clean up next tick.
  const FOCUS_PREFIX = "[FOCUS — auto-generated recap";
  let focusMessage: ChatMessage | null = null;
  /** What this tick is about — the query the tool selector ranks against.
   *  Refined below with the mission goal and the active checklist step. */
  let tickTaskText = currentTaskText(messages);
  // One-shot migration: purge FOCUS headers that the previous implementation
  // persisted into runs already in flight. Harmless once none remain.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && String(messages[i].content ?? "").startsWith(FOCUS_PREFIX)) messages.splice(i, 1);
  }
  // ── Context manifest (per-tick cache fingerprint) ─────────────────────────
  // The provider's prefix cache spans the byte-identical part of what we send:
  // [system][head][sealed zone]. The live window legitimately grows every tick,
  // so THIS is the span to fingerprint. Equal to the previous tick's hash → the
  // provider should have served the prefix from cache; a false=false while the
  // sealed zone didn't grow is a cache-thrash worth investigating.
  const prevManifest = (metaNow.context_manifest ?? null) as
    | { transcript_prefix_hash?: string; sealed_markers?: number }
    | null;
  let sealedMarkers = 0;
  for (let i = Math.min(2, messages.length); i < messages.length; i++) {
    if (messages[i].role !== "user") break;
    if (!String(messages[i].content ?? "").startsWith(SEALED_PREFIX)) break;
    sealedMarkers++;
  }
  const tickPrefixHash = transcriptPrefixHash(messages, SEALED_PREFIX);
  const cacheExpected = prevManifest?.transcript_prefix_hash != null && prevManifest.transcript_prefix_hash === tickPrefixHash;
  await ctx.logEvent("prompt", {
    kind: "tick_manifest",
    prefix_hash: tickPrefixHash,
    cache_expected: cacheExpected,
    sealed_markers: sealedMarkers,
    sealed_grew: (prevManifest?.sealed_markers ?? 0) !== sealedMarkers,
    transcript_chars: JSON.stringify(messages).length,
  }).catch(() => {});
  try {
    const { data: runTodoRow } = await admin.from("internal_agent_runs").select("todos").eq("id", runId).maybeSingle();
    type Todo = { id: string; title: string; status: string; parent_id?: string; note?: string };
    const todos = Array.isArray(runTodoRow?.todos) ? (runTodoRow!.todos as Todo[]) : [];
    if (todos.length > 0 || mission) {
      const parentIds = new Set(todos.filter((t) => t.parent_id).map((t) => t.parent_id));
      const leaves = todos.filter((t) => !parentIds.has(t.id));
      const done = leaves.filter((t) => t.status === "done");
      const activeLeaf = leaves.find((t) => t.status === "active");
      const nextPending = leaves.filter((t) => t.status === "pending").slice(0, 3);
      const blocked = leaves.filter((t) => t.status === "blocked");
      const mark = (s: string) => (s === "done" ? "x" : s === "active" ? "▶" : s === "blocked" ? "!" : " ");
      const renderTree = (parentId: string | undefined, depth: number): string[] =>
        todos.filter((t) => (t.parent_id ?? undefined) === parentId).flatMap((t) => [
          `${"  ".repeat(depth)}- [${mark(t.status)}] ${t.title}${t.note ? ` — ${t.note.slice(0, 120)}` : ""}`,
          ...(depth < 3 ? renderTree(t.id, depth + 1) : []),
        ]);
      const tree = renderTree(undefined, 0).slice(0, 40).join("\n");
      const m = mission as { title?: string; brief?: string | null } | null;
      const goal = m?.title
        ? `${m.title}${m.brief ? ` — ${String(m.brief).replace(/\s+/g, " ").slice(0, 300)}` : ""}`
        : "Complete the user's current request in this conversation.";
      focusMessage = {
        role: "user",
        content: [
          `${FOCUS_PREFIX} — not a new instruction; use it to stay on track]`,
          `OBJECTIVE: ${goal}`,
          leaves.length ? `PROGRESS: ${done.length}/${leaves.length} steps done` : "",
          activeLeaf ? `NOW: ${activeLeaf.title}` : nextPending[0] ? `NEXT UP: ${nextPending[0].title} (mark it active first)` : "",
          nextPending.length > (activeLeaf ? 0 : 1) ? `THEN: ${(activeLeaf ? nextPending : nextPending.slice(1)).map((t) => t.title).join(" · ")}` : "",
          blocked.length ? `BLOCKED: ${blocked.map((t) => `${t.title}${t.note ? ` (${t.note.slice(0, 80)})` : ""}`).join(" · ")}` : "",
          tree ? `CHECKLIST:\n${tree}` : "",
          "Stay the course: finish the current step, VERIFY it, update_todos, then move to the next. Never redo work already marked done.",
        ].filter(Boolean).join("\n"),
      };
      // The tool selector ranks against the SAME picture the agent is looking
      // at: the objective plus the step actually in flight. Without the active
      // step, a mission whose brief says "audit" would keep scoring `web_search`
      // above the file tools it needs three steps in.
      tickTaskText = currentTaskText(messages, {
        goal, activeStep: activeLeaf?.title ?? nextPending[0]?.title ?? null,
      });
    }
  } catch { /* focus header is best-effort */ }
  // Prime the selection so the notice below is accurate from the first round.
  liveTools();

  /** Appended at SEND time, after the transcript, never persisted. */
  const ephemeral = (): ChatMessage[] => {
    const out: ChatMessage[] = focusMessage ? [focusMessage] : [];
    // A deferred schema must never read as a missing capability. The toolbox
    // index in the system prompt still lists every tool; this says how to get
    // the rest back, in one call, without losing the turn.
    if (toolStats.omitted > 0) {
      out.push({
        role: "user",
        content:
          `[SCHÉMAS DIFFÉRÉS — ${toolStats.omitted} outil(s) de ta boîte sont listés dans ton inventaire mais leur schéma n'est pas chargé ce tour, pour rester compact. ` +
          `Si tu as besoin de l'un d'eux, appelle need_tools("<ce que tu veux faire>") : la boîte complète revient immédiatement, dans le même tour. ` +
          `Ne dis JAMAIS que tu n'as pas un outil listé dans ton inventaire.]`,
      });
    }
    return out;
  };

  // Model for THIS tick — may get escalated below if the run keeps struggling.
  // A self-hosted endpoint carries its own model id, so the vendor check only
  // applies to OUR providers. A mismatch here is what a provider switch used to
  // produce: the run kept its DeepSeek model id and sent it to Groq.
  if (!agentEndpoint && !modelMatchesProvider(tickModel, tickProvider)) {
    const corrected = agentModelForTier(agent, "standard");
    await ctx.logEvent("status", {
      message: `Modèle « ${tickModel} » incompatible avec le fournisseur « ${tickProvider} » — bascule sur « ${corrected} ».`,
    }).catch(() => {});
    tickModel = corrected;
  }
  if (providerUnavailable) {
    await ctx.logEvent("status", {
      message: `Fournisseur « ${state.provider} » non configuré — ce run continue sur « ${tickProvider} ».`,
    }).catch(() => {});
  }
  // ── Guardrails — prompt scope ─────────────────────────────────────────────
  // The user's actual instruction (auto-injected FOCUS / compaction / schema
  // notices are internal and not "prompts"). A `block` match refuses the run
  // outright with an actionable message; warn/log just trace on the timeline.
  if (guardrails.length > 0) {
    const lastUser = [...messages].reverse().find(
      (m) => m.role === "user" && !/^\[(FOCUS|Segment scell|Historique|CONTEXT|SCHÉMAS DIFFÉRÉS|The user sent this while)/.test(String(m.content ?? "")),
    );
    const promptProbe = lastUser ? String(lastUser.content ?? "") : "";
    if (promptProbe) {
      const hits = checkGuardrails(guardrails, "prompt", promptProbe);
      if (hits.length > 0) {
        const block = strongestEnforcement(hits) === "block";
        for (const v of hits) {
          await ctx.logEvent("guardrail", {
            scope: "prompt", guardrail: v.title, category: v.category,
            enforcement: v.enforcement, matched: v.matched, blocked: block,
          }).catch(() => {});
        }
        if (block) {
          const msg = `Demande refusée par le guardrail « ${hits[0].title} »${hits[0].matched ? ` (correspondance : « ${hits[0].matched} »)` : ""}. La consigne enfreint une règle de sécurité de cet espace — reformulez votre demande.`;
          await ctx.logEvent("error", { error: msg }).catch(() => {});
          await recordGuardrailIncident(admin, agent, runId, hits[0].title, "prompt", hits[0].matched).catch(() => {});
          await admin.from("internal_agent_runs").update({
            status: "failed", finished_at: new Date().toISOString(), error_message: msg.slice(0, 500),
          }).eq("id", runId);
          await reportMissionTask(false, msg).catch(() => {});
          await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
          if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
          return jsonResponse({ ok: false, blocked: true, reason: msg });
        }
      }
    }
  }
  try {
    const runRounds = (p: Provider, m: string | undefined) => runToolRounds({
      provider: p,
      model: m,
      endpoint: agentEndpoint,
      messages, tools: liveTools, executor: loggingExecutor, ephemeral,
      // 6000 (was 4000): a full report deliverable emitted in one tool call needs
      // headroom, otherwise its `content` argument is truncated → invalid/empty.
      temperature: agent.temperature, maxTokens: 6000, maxRounds: TICK_ROUNDS,
      onNotice: async (n) => { await ctx.logEvent("tool_error", { message: n.message, detail: n.detail }); },
    });

    let result;
    try {
      result = await runRounds(tickProvider, tickModel);
    } catch (e) {
      // Cross-provider failover. Only for PROVIDER-level failures (bad key,
      // unknown/retired model, 404) — a rate limit or a malformed request would
      // fail identically on the other vendor, so retrying there just burns
      // budget. A self-hosted endpoint has no alternative, so it never retries.
      const other = agentEndpoint ? undefined : availableProviders().find((p) => p !== tickProvider);
      if (!other || !isProviderFailure(e)) throw e;
      const otherModel = modelForTier("standard", other);
      await ctx.logEvent("status", {
        message: `Le fournisseur « ${tickProvider} » a échoué (${e instanceof Error ? e.message.slice(0, 120) : "erreur"}) — reprise sur « ${other} » (${otherModel}).`,
      }).catch(() => {});
      // Persist the switch: subsequent ticks start on the working provider
      // instead of re-failing on the broken one every single time.
      tickProvider = other;
      tickModel = otherModel;
      sanitizeToolPairs(messages); // the failed attempt may have left a dangling pair
      result = await runRounds(tickProvider, tickModel);
    }
    // Trace what the compiler spent this tick — context growth becomes visible
    // in the timeline instead of silently eating the window.
    if (toolStats.omitted > 0) {
      await ctx.logEvent("prompt", {
        tools: toolStats, focus: tickTaskText.slice(0, 200),
      }).catch(() => {});
    }

    let newRound = state.round + result.roundsRun;
    let tokIn = (state.tokens_in ?? 0) + (result.usage.prompt_tokens ?? 0);
    let tokOut = (state.tokens_out ?? 0) + (result.usage.completion_tokens ?? 0);
    let cost = Number(state.cost_usd ?? 0) + estimateCost(result.usage, result.provider, result.model, !!agentEndpoint);
    let finalProvider = result.provider;
    let finalModel = result.model;

    // ── Per-tick telemetry ───────────────────────────────────────────────────
    // A real llm_usage row per round batch — not only at finalize — so Prompt
    // Monitoring and the cost views see spend live, and a run that dies
    // mid-flight (sandbox down, abort, worker kill) still leaves its cost trace.
    // The finalizer later writes the run-total row (metadata without `tick`),
    // which is the canonical per-run record for the monitoring UI.
    const tickNo = (state.iteration ?? 0) + 1;
    await logLlmUsage({
      workspace_id: agent.workspace_id, project_id: agent.project_id,
      provider: finalProvider, model: finalModel,
      task: "content_generation", feature: isChat ? "internal-agent-chat" : "internal-agent-mission",
      custom: !!agentEndpoint,
      usage: { prompt_tokens: result.usage.prompt_tokens ?? 0, completion_tokens: result.usage.completion_tokens ?? 0 },
      metadata: { run_id: runId, agent_id: agent.id, mode: isChat ? "chat" : "mission", tick: tickNo, custom: !!agentEndpoint },
    }).catch(() => {});

    // ── FAIL-FAST: sandbox died MID-run ──────────────────────────────────────
    // 3+ consecutive "Sandbox unreachable" tool results = the tunnel/infra is
    // down. Fail with an actionable ops message instead of grinding/replanning.
    let consecUnreachable = 0;
    for (const m of messages.slice(-16)) {
      if (m.role !== "tool") continue;
      if (String(m.content ?? "").startsWith("ERROR: Sandbox unreachable")) consecUnreachable++;
      else consecUnreachable = 0;
    }
    if (!ctx.hybrid && consecUnreachable >= 3) {
      const msg = SANDBOX_DOWN_MSG;
      await ctx.logEvent("error", { error: msg }).catch(() => {});
      await admin.from("internal_agent_runs").update({
        status: "failed", finished_at: new Date().toISOString(), error_message: msg.slice(0, 500),
        tokens_in: tokIn, tokens_out: tokOut, cost_usd: cost, action_count: newRound,
      }).eq("id", runId);
      if (roomBinding) {
        await closeRoomMessage(admin, agent, roomBinding, runId, msg, "failed");
        await reportMissionTask(false, msg);
      } else if (isChat && state.conversation_id) {
        await admin.from("internal_agent_messages").insert({
          conversation_id: state.conversation_id, agent_id: agent.id, role: "assistant",
          content: msg, run_id: runId,
        });
        await postReplyToBoundChannel(admin, agent, state.conversation_id, msg);
      } else if (state.mission_id) {
        await admin.from("internal_agent_missions").update({ board_column: "todo" })
          .eq("id", state.mission_id).eq("board_column", "in_progress");
      }
      await autoSaveMemory(admin, agent, runId, {
        kind: "learning", importance: 3, dedupePrefix: "Sandbox down:",
        content: `Sandbox down: run interrompu le ${new Date().toISOString().slice(0, 10)} — la sandbox est devenue injoignable en cours d'exécution. Relancer l'infra locale (start-agents-infra.ps1) avant de reprendre.`,
      });
      await recordRunIncident(admin, agent, runId, {
        title: "Sandbox injoignable en cours de run",
        description: "Sandbox devenue injoignable pendant l'exécution (3+ résultats consécutifs « Sandbox unreachable »). Run interrompu.",
        category: "outage", severity: "critical",
      }).catch(() => {});
      await admin.from("aiops_infra_incidents").insert({
        workspace_id: agent.workspace_id, project_id: agent.project_id,
        server_name: "sandbox", kind: "service_down", severity: "critical",
        cause: "sandbox unreachable (3+ résultats consécutifs)",
        impact: `Run interrompu — mission « ${mission?.title ?? ""} », agent ${agent.name}`,
      }).catch(() => {});
      await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
      if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
      return jsonResponse({ ok: false, failed: true, reason: "sandbox unreachable" });
    }

    // ── Adaptive control: accumulate errors, detect tool-call loops, re-plan ──
    const meta = (state.meta ?? {}) as Record<string, unknown>;
    let lastSig = typeof meta.last_sig === "string" ? meta.last_sig : "";
    let sigCount = Number(meta.sig_count) || 0;
    let loopDetected = false;
    // A rolling window, not just the previous call: the common loop is not
    // A-A-A-A but A-B-C-A-B-C — six calls that each differ from the one before,
    // so a "same as last" test never fires while the run goes nowhere.
    const recentSigs: string[] = Array.isArray(meta.recent_sigs) ? (meta.recent_sigs as string[]).slice(-12) : [];
    let cycleHits = 0;
    for (const c of result.toolCalls) {
      const sig = `${c.name}:${JSON.stringify(c.args ?? {}).slice(0, 180)}`;
      if (sig === lastSig) sigCount++;
      else { lastSig = sig; sigCount = 1; }
      if (sigCount >= 4) loopDetected = true;
      if (recentSigs.includes(sig)) cycleHits++;
      recentSigs.push(sig);
      if (recentSigs.length > 12) recentSigs.shift();
    }
    // Half the calls in this tick were already made recently → it is cycling.
    if (result.toolCalls.length >= 4 && cycleHits >= Math.ceil(result.toolCalls.length / 2)) loopDetected = true;
    // Circuit breaker: a specific tool that failed ≥3 times in a row (even with
    // varying args) is broken/unavailable — stop hammering it, adapt or skip.
    const brokenTools = Object.entries(toolFails).filter(([, n]) => (n as number) >= 3).map(([t]) => t);
    let errorCount = (state.error_count ?? 0) + result.errorCount;
    let replans = state.replans ?? 0;

    // ── Progress fingerprint → stagnation ────────────────────────────────────
    // Steps closed, deliverables produced, genuinely new approaches tried. An
    // agent burning rounds with varied arguments and producing nothing scores
    // zero here — which the identical-signature guard above never caught.
    const prevProgress = (state.progress ?? null) as ProgressFingerprint | null;
    let progress = prevProgress;
    let stagnation = state.stagnation ?? 0;
    try {
      progress = await fingerprintProgress(admin, runId, messages);
      stagnation = hasAdvanced(prevProgress, progress) ? 0 : stagnation + 1;
    } catch { /* fingerprinting is best-effort — never block the loop on it */ }

    // ── THE CONTROLLER ───────────────────────────────────────────────────────
    // One decision point reading every signal. It replaces the branches that
    // used to be scattered through this handler, so the loop's behaviour is
    // reproducible (pure function of the signals) and auditable (traced below).
    const budgets = resolveBudgets(agent, isChat ? "chat" : "mission");
    const iteration = (state.iteration ?? 0) + 1;
    const signals: LoopSignals = {
      finished: result.finished,
      roundsUsed: newRound,
      maxRounds: state.max_rounds || budgets.maxRounds,
      costUsd: cost,
      maxCostUsd: budgets.maxCostUsd,
      errorCount, loopDetected, brokenTools,
      stagnantTicks: stagnation,
      replans, maxReplans: 3,
    };
    let decision = decideNext(signals);

    // ── Budget IA : le contrôleur de boucle raisonne en tours et en dollars
    // estimés ; le quota raisonne en crédits réellement facturés. Les deux
    // doivent pouvoir arrêter le run. On réutilise l'action "abort" existante
    // plutôt qu'un chemin d'erreur parallèle : le run se termine alors comme un
    // run à court de budget — livrables sauvegardés, message clair, pas de 500.
    const runBudget = await checkRunBudget(runId);
    if (runBudget.exceeded) {
      decision = {
        action: "abort",
        reason: `Plafond de l'offre atteint pour cette exécution (${Math.round(runBudget.credits)} crédits, maximum ${runBudget.cap}). Relancez en découpant la mission, ou passez à une offre supérieure.`,
        interventions: [], escalateModel: false, consumesReplan: false,
      };
    } else {
      const quota = await checkQuota(agent.workspace_id, "credits");
      if (!quota.allowed) {
        decision = {
          action: "abort",
          reason: quota.reason ?? "Crédits IA épuisés pour cette période.",
          interventions: [], escalateModel: false, consumesReplan: false,
        };
      }
    }

    // Apply the decision: inject its course corrections, escalate the model,
    // consume a re-plan credit.
    for (const iv of decision.interventions) messages.push({ role: "user", content: iv.content });
    if (decision.interventions.some((i) => i.tag === "circuit_breaker")) {
      for (const t of brokenTools) toolFails[t] = 0; // reset after nudging so we don't re-fire every tick
    }
    if (decision.escalateModel) {
      // Start cheap, pay for more capability only where it's actually needed.
      const heavy = Deno.env.get("AGENT_MODEL_MISSION") || modelForTier("heavy", tickProvider);
      if (tickModel !== heavy) {
        tickModel = heavy;
        await ctx.logEvent("status", { message: `Escalade vers un modèle plus puissant (${heavy}) pour débloquer.` }).catch(() => {});
      }
    }
    if (decision.consumesReplan) {
      replans++;
      errorCount = 0;
      lastSig = ""; sigCount = 0;
      // The replan gets a clean slate on the CYCLE window too — the new plan is
      // allowed to revisit a tool the old one had exhausted. `search_sigs` is
      // NOT cleared: re-running the identical query is never the new idea.
      recentSigs.length = 0;
      stagnation = 0;
    }
    if (decision.action !== "continue") {
      await ctx.logEvent("status", { message: decision.reason }).catch(() => {});
    }
    /** Trace one controller iteration (the audit record of the loop). Called
     *  once per tick — with the contract verdict when the tick finalizes. */
    const traceLoop = async (verdict: Parameters<typeof loopEventPayload>[0]["verdict"] = undefined) => {
      await ctx.logEvent("loop", loopEventPayload({ iteration, decision, signals, progress: progress ?? undefined, verdict })).catch(() => {});
    };

    // ── Runaway: past every budget with no end in sight ──────────────────────
    if (decision.action === "abort") {
      await traceLoop();
      await ctx.logEvent("error", { error: decision.reason }).catch(() => {});
      const partial = (result.content?.trim() || "").slice(0, 4000);
      await admin.from("internal_agent_runs").update({
        status: "failed", finished_at: new Date().toISOString(),
        error_message: decision.reason.slice(0, 500),
        final_output: partial || null,
        tokens_in: tokIn, tokens_out: tokOut, cost_usd: cost, action_count: newRound,
      }).eq("id", runId);
      // Before announcing "le travail déjà produit reste disponible", make it
      // true for a half-built report too.
      await salvageReportDraft(admin, agent, runId, state);
      const notice = `⚠縏 ${decision.reason}\n\nLe travail déjà produit reste disponible (livrables et étapes ci-dessus).${partial ? `\n\n${partial}` : ""}`;
      if (roomBinding) {
        // "les livrables ci-dessus" has to be true: closeRoomMessage carries the
        // cards for whatever the agent finished before the budget ran out.
        await closeRoomMessage(admin, agent, roomBinding, runId, notice, "done");
        // Partial work still counts: hand the frontier what was produced so
        // dependent tasks can decide, rather than stalling on an empty result.
        await reportMissionTask(false, partial || decision.reason);
      } else if (isChat && state.conversation_id) {
        await admin.from("internal_agent_messages").insert({ conversation_id: state.conversation_id, agent_id: agent.id, role: "assistant", content: notice, run_id: runId });
        await admin.from("internal_agent_conversations").update({ updated_at: new Date().toISOString() }).eq("id", state.conversation_id);
      } else if (state.mission_id) {
        await admin.from("internal_agent_missions").update({ board_column: "todo" }).eq("id", state.mission_id).eq("board_column", "in_progress");
      }
      await recordRunIncident(admin, agent, runId, {
        title: "Run interrompu — budget épuisé",
        description: `Run arrêté par le contrôleur de boucle : ${decision.reason}.`,
        category: "other", severity: "medium",
      }).catch(() => {});
      await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
      if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
      return jsonResponse({ ok: false, aborted: true, reason: decision.reason });
    }

    // Build the meta to persist at tick-end. CRITICAL: re-read the CURRENT meta
    // from the DB and treat it as the source of truth for mid-tick accumulators
    // (spawned_subtasks written by spawn_parallel_agents, report_draft written by
    // report_section / consumed by create_deliverable). The local `meta` snapshot
    // was loaded BEFORE the tick ran, so writing `{ ...meta }` would clobber those
    // mid-tick writes — that's what let a fan-out re-spawn duplicates and a report
    // draft vanish across ticks. We overlay only the keys we own locally.
    const buildNextMeta = async (): Promise<Record<string, unknown>> => {
      const { data: fs } = await admin.from("internal_agent_run_state").select("meta").eq("run_id", runId).maybeSingle();
      const freshMeta = ((fs as { meta?: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>;
      return {
        ...freshMeta, // DB truth: spawned_subtasks, report_draft (incl. deletions)
        deliverable_forced: (meta.deliverable_forced as boolean | undefined) ?? freshMeta.deliverable_forced,
        last_sig: lastSig, sig_count: sigCount, tool_fails: toolFails,
        // Carried across ticks: a research loop spans them, so a per-tick set
        // would forget the queries between two ticks and let it start over.
        search_sigs: searchSigs, recent_sigs: recentSigs,
        // Progressive disclosure carried to the next tick.
        tool_tier: toolTier, loaded_families: [...loadedFamilies],
        // Context manifest: the byte-identical transcript prefix sent this tick,
        // so the next tick can say whether the provider cache was expected to hit.
        context_manifest: { transcript_prefix_hash: tickPrefixHash, sealed_markers: sealedMarkers },
      };
    };

    if (decision.action === "finalize") {
      let finalOutput = result.content?.trim() || "";

      // Finalizing WITHOUT a natural finish (budget reached, or stuck past its
      // re-plan credits): give a wrap-up allowance so the agent ships what it
      // has (deliverables + summary for a mission, a clear reply for chat)
      // instead of ending empty-handed.
      if (!result.finished) {
        messages.push({ role: "user", content: isChat
          ? "STOP — you've reached your step budget. Wrap up now, nothing else: save any final artifact you produced with create_deliverable (e.g. a report, or a running app's public URL), then write a concise reply to the user that INCLUDES any public URL and key file paths produced. Do not start new exploration, downloads or training."
          : "STOP — you've reached your step budget. Do ONLY this now, nothing else: (1) create your final deliverable(s) with create_deliverable — at minimum a structured report (kind=\"report\") with the key results / KPIs / tables you've already gathered, plus any artifact already produced (e.g. a running app's public URL); (2) then write a concise final summary that INCLUDES that URL if any. Do not start new exploration, downloads or training." });
        try {
          const fin = await runToolRounds({
            provider: tickProvider,
            model: tickModel,
            endpoint: agentEndpoint,
            messages, tools: liveTools, executor: loggingExecutor, ephemeral,
            temperature: agent.temperature, maxTokens: 4000, maxRounds: 5,
            onNotice: async (n) => { await ctx.logEvent("tool_error", { message: n.message, detail: n.detail }); },
          });
          finalOutput = fin.content?.trim() || finalOutput;
          newRound += fin.roundsRun;
          tokIn += fin.usage.prompt_tokens ?? 0;
          tokOut += fin.usage.completion_tokens ?? 0;
          cost += estimateCost(fin.usage, fin.provider, fin.model, !!agentEndpoint);
          finalProvider = fin.provider; finalModel = fin.model;
        } catch (e) {

          const nm = (e as { name?: string } | null)?.name;
          if (nm === "AwaitingInputError" || nm === "AwaitingApprovalError" || nm === "RunCancelledError") throw e;
          // Other errors during finalization: finalize with what we have.
        }
      }

      // ── Promote the run's findings to permanent memory ────────────────────
      // What this run paid the web for becomes the next mission's starting
      // point. One condensed row per run, not one per page: memory that grows
      // by the hundred stops being searchable, and the point is that the second
      // mission on a subject is cheaper, not that everything is hoarded.
      if (findings.length >= 2 && (ctx.delegationDepth ?? 0) === 0) {
        try {
          const subject = (findings[0]?.label ?? "").slice(0, 120);
          const digest = findings.slice(0, 12)
            .map((f) => `• [${f.label}] ${f.text.replace(/\s+/g, " ").slice(0, 320)}`)
            .join("\n");
          const content = `[Recherche — ${subject} · ${new Date().toISOString().slice(0, 10)}]\n${digest}`.slice(0, 4000);
          const embedding = await embedMemoryVector(content).catch(() => null);
          await admin.from("internal_agent_memories").insert({
            workspace_id: agent.workspace_id, project_id: agent.project_id,
            agent_id: agent.id, source: "agent", kind: "context", importance: 3,
            source_run_id: runId, content, ...(embedding ? { embedding } : {}),
          }).then(() => {}, () => {});
          await ctx.logEvent("status", {
            message: `${findings.length} collecte(s) versées en mémoire permanente — une prochaine mission sur « ${subject} » les retrouvera sans rechercher.`,
          }).catch(() => {});
        } catch { /* memory is a bonus, never a blocker */ }
      }

      // Finalise the section-by-section draft BEFORE the contract is judged.
      // It ran after, so a run that had built eight sections was graded "aucun
      // livrable enregistré" — a red cross on a report that materialised two
      // lines later. The check must see the same state the human will.
      await salvageReportDraft(admin, agent, runId, state);

      // ── Contract verification (chat AND missions, on a natural finish) ──────
      // The run is checked against its SUCCESS CONTRACT before shipping:
      // deterministic checks first (a deliverable exists, a URL answers, a file
      // is on disk, the checklist is closed), LLM judge only for what none of
      // them can express. Required gaps go back into the loop as a concrete
      // punch list. Two failed verifications max, then we ship what we have.
      let verdict: Awaited<ReturnType<typeof evaluateContract>> | null = null;
      if (result.finished && (state.verify_fails ?? 0) < 2) {
        let gaps: string[] = [];
        let hints: string[] = [];
        const contract = state.contract ?? null;
        if (contract) {
          verdict = await evaluateContract({ admin, runId, contract, finalOutput, probe: loopProbe }).catch(() => null);
          if (verdict) { gaps = verdict.gaps; hints = verdict.soft; }
        } else if (!isChat) {
          // No contract (mission without criteria, or a run started before the
          // loop engine shipped) → previous behaviour, unchanged.
          const legacy = await verifyMissionOutcome(admin, runId, mission as any, finalOutput).catch(() => null);
          if (legacy && !legacy.pass) gaps = [legacy.feedback || "Les critères d'acceptation ne sont pas tous satisfaits."];
        }
        if (gaps.length > 0) {
          await ctx.logEvent("status", { message: `Vérification du contrat : ÉCHEC — ${gaps[0].slice(0, 180)}. Reprise du travail.` }).catch(() => {});
          await traceLoop(verdict);
          messages.push({
            role: "user",
            content: [
              `SELF-CHECK FAILED — the work is NOT complete. These checks did not pass:`,
              ...gaps.map((g) => `- ${g}`),
              ...(hints.length ? ["", "Also worth fixing while you're at it:", ...hints.map((h) => `- ${h}`)] : []),
              "",
              "Fix exactly these gaps now (create the missing deliverables, correct the wrong ones, close the open steps), then produce your final answer again. Do not re-do anything that already passed.",
            ].join("\n"),
          });
          await admin.from("internal_agent_run_state").update({
            messages, round: newRound, tokens_in: tokIn, tokens_out: tokOut, cost_usd: cost,
            error_count: errorCount, replans, verify_fails: (state.verify_fails ?? 0) + 1,
            progress, stagnation, iteration,
            meta: await buildNextMeta(),
            processing_until: null, updated_at: new Date().toISOString(), last_input_at: newLastInputAt,
          }).eq("run_id", runId);
          if (msgId != null) await admin.rpc("agent_tick_next", { p_msg_id: msgId, p_run_id: runId });
          else await admin.rpc("agent_tick_enqueue", { p_run_id: runId });
          return jsonResponse({ ok: true, verify_failed: true, gaps: gaps.length, continued: true });
        }
        if (verdict?.pass) {
          const checked = verdict.results.filter((r) => !r.skipped).length;
          await ctx.logEvent("status", { message: `Vérification du contrat : OK (${checked} contrôle${checked > 1 ? "s" : ""} passé${checked > 1 ? "s" : ""}).` }).catch(() => {});
        }
      }
      await traceLoop(verdict);

      // Salvage a report built section-by-section but never finalised. No
      // longer gated on `result.finished`: a run that stopped short is exactly
      // the one whose draft would otherwise be lost.
      await salvageReportDraft(admin, agent, runId, state);

      // ── Chat guard: agent CLAIMED a deliverable but never saved one ─────────
      // The #1 confusing failure: the model writes "le rapport est en carte"
      // without calling create_deliverable, so the user sees no card. If the
      // final answer claims one and none exists for this run, force it — ONCE.
      if (isChat && result.finished && !(meta.deliverable_forced as boolean)) {
        const countRun = async () => (await admin
          .from("internal_agent_deliverables").select("id", { count: "exact", head: true }).eq("run_id", runId)).count ?? 0;
        const claimsDeliverable = /\b(rapport|report|livrable|deliverable|carte|artifact)\b/i.test(finalOutput);
        // Did the USER actually ask for a report/deliverable? (Scan real user
        // messages, skipping auto-injected FOCUS / trim / compaction markers.)
        const userText = messages
          .filter((m) => m.role === "user" && !/^\[(FOCUS|Segment scell|Historique|CONTEXT)/.test(String(m.content ?? "")))
          .map((m) => String(m.content ?? "")).join(" \n ");
        const reportRequested = /\b(rapport|report|livrable|deliverable|analyse|analyser|audit|synth[eè]se|bilan|plan de|tableau de bord|dashboard)\b/i.test(userText);
        // Fire when a deliverable is expected (the final text claims one OR the
        // user requested one) but none was saved — even if the final answer is
        // EMPTY (the model often ends silent after a failed create_deliverable).
        if ((await countRun()) === 0 && (claimsDeliverable || reportRequested)) {
          meta.deliverable_forced = true; // guard against looping
          // Try once to make the agent create a PROPER report itself…
          messages.push({
            role: "user",
            content: "L'utilisateur a EXPLICITEMENT demandé un rapport / livrable. NE pose PAS de question et ne demande PAS quoi faire — tu as déjà les informations (ou les outils pour les obtenir). Produis MAINTENANT le rapport COMPLET en appelant create_deliverable(kind=\"report\", name, content) : sections, KPIs, tableaux, risques (conçu avec ton skill report-designer — pas de prose), à partir de l'analyse que tu viens de faire. Si des données manquent, mets des hypothèses étiquetées plutôt que de t'arrêter. Puis termine par un court résumé.",
          });
          try {
            const fin = await runToolRounds({
              provider: tickProvider,
              model: tickModel, endpoint: agentEndpoint,
              messages, tools: liveTools, executor: loggingExecutor, ephemeral,
              temperature: agent.temperature, maxTokens: 4000, maxRounds: 4,
              onNotice: async (n) => { await ctx.logEvent("tool_error", { message: n.message, detail: n.detail }); },
            });
            finalOutput = fin.content?.trim() || finalOutput;
            newRound += fin.roundsRun;
            tokIn += fin.usage.prompt_tokens ?? 0; tokOut += fin.usage.completion_tokens ?? 0;
            cost += estimateCost(fin.usage, fin.provider, fin.model, !!agentEndpoint);
            finalProvider = fin.provider; finalModel = fin.model;
          } catch (e) {
            const nm = (e as { name?: string } | null)?.name;
            if (nm === "AwaitingInputError" || nm === "AwaitingApprovalError" || nm === "RunCancelledError") throw e;
          }
          // …still nothing? Materialise it server-side so the user ALWAYS gets a
          // card. Salvage a body from the run's recent substantive output when the
          // final answer is empty (the model often ends silent after doing the
          // work) — never persist an empty card.
          if ((await countRun()) === 0) {
            let body = finalOutput;
            if (!body.trim()) {
              const recent = messages
                .filter((m) => (m.role === "assistant" || m.role === "tool") && String(m.content ?? "").trim().length > 40)
                .slice(-14).map((m) => String(m.content).slice(0, 800)).join("\n\n");
              body = recent
                ? `# Rapport (récupéré automatiquement)\n\n_L'agent a effectué le travail mais n'a pas rédigé de conclusion ; voici une synthèse des dernières étapes._\n\n${recent}`
                : "Rapport généré automatiquement — voir le détail des étapes ci-dessus.";
            }
            const summary = body.replace(/[#*`>_\n]+/g, " ").trim().slice(0, 200) || null;
            await admin.from("internal_agent_deliverables").insert({
              run_id: runId, mission_id: null, conversation_id: state.conversation_id,
              agent_id: agent.id, kind: "markdown", name: "Rapport", content: body, summary,
            }).then(() => {}, () => {});
            await ctx.logEvent("status", { message: "Livrable matérialisé automatiquement (l'agent avait fini sans l'enregistrer)." }).catch(() => {});
          }
        }
      }

      // ── Closing reflex: what did this work open up? ────────────────────────
      // One cheap pass over what just happened, filing genuine follow-ups as
      // PAUSED backlog missions. It runs here, before the answer is finalized,
      // because a proposal the human never sees is a proposal that does not
      // exist — the footer goes out with the reply.
      //
      // Gated so it stays a signal rather than a tax: only runs that actually
      // did something (3+ rounds), never sub-agents (a spawned worker owns one
      // narrow subtask), never a stub answer. Failures are swallowed inside
      // reflectAndPropose — the user's answer never waits on an idea.
      // A room-mission TASK is excluded too: it is one card of a plan the
      // orchestrator already owns, and its follow-ups belong to that plan's
      // closing report, not to a backlog item filed per card.
      if (newRound >= 3 && (ctx.delegationDepth ?? 0) === 0 && !missionTask && finalOutput.trim().length > 120) {
        const usedTools = [...new Set(
          messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.function?.name ?? "").filter(Boolean)),
        )];
        const m = mission as { title?: string; brief?: string } | null;
        const proposals = await reflectAndPropose(admin, {
          agentId: agent.id,
          workspaceId: agent.workspace_id ?? null,
          projectId: agent.project_id ?? null,
          goal: state.contract?.goal || (isChat ? lastUserText(messages) : `${m?.title ?? ""} — ${m?.brief ?? ""}`),
          output: finalOutput,
          actions: usedTools,
        });
        if (proposals.length > 0) {
          finalOutput += proposalsFooter(proposals);
          await ctx.logEvent("status", {
            message: `💡 ${proposals.length} initiative(s) déposée(s) dans le backlog : ${proposals.map((p) => p.title).join(" · ")}.`,
          }).catch(() => {});
        }
      }

      if (isChat) {
        // Never end on an empty/stub reply: if a deliverable exists, point to it
        // with its real summary so the user gets a meaningful closing message.
        if (!finalOutput.trim()) {
          const { data: dv } = await admin
            .from("internal_agent_deliverables").select("name, summary")
            .eq("run_id", runId).order("created_at", { ascending: false }).limit(1).maybeSingle();
          if (dv) {
            finalOutput = `✅ **${(dv as { name?: string }).name ?? "Livrable"}** créé — voir la carte ci-dessus.${(dv as { summary?: string }).summary ? `\n\n${(dv as { summary?: string }).summary}` : ""}`;
          }
        }
        if (!finalOutput) finalOutput = "Terminé — voir le détail des étapes ci-dessus.";
        if (roomBinding) {
          await finalizeRoomSuccess(admin, agent, roomBinding, runId, finalOutput,
            { tokIn, tokOut, cost, actions: newRound, provider: finalProvider, model: finalModel, custom: !!agentEndpoint });
          // The orchestrator's frontier moves here: this task is done, its
          // result is folded into whatever was waiting on it, and the next
          // agent starts.
          await reportMissionTask(true, finalOutput);
        } else {
          await finalizeChatSuccess(admin, agent, state.conversation_id!, runId, finalOutput,
            { tokIn, tokOut, cost, actions: newRound, provider: finalProvider, model: finalModel, custom: !!agentEndpoint });
        }
      } else {
        if (!finalOutput) finalOutput = "Mission terminée — voir le détail des étapes et des livrables.";
        await finalizeMissionSuccess(admin, agent, runId, (mission ?? { id: state.mission_id }) as any, finalOutput,
          { tokIn, tokOut, cost, actions: newRound, provider: finalProvider, model: finalModel, custom: !!agentEndpoint });
      }
      await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
      // Race net: a message that landed during this FINAL tick (after the sync)
      // wasn't handled. Kick a fresh run so it doesn't sit unanswered.
      if (isChat && state.conversation_id) {
        const { data: pending } = await admin
          .from("internal_agent_messages").select("id")
          .eq("conversation_id", state.conversation_id).eq("role", "user")
          .gt("created_at", newLastInputAt ?? new Date(0).toISOString()).limit(1);
        if (pending && pending.length) {
          const base = Deno.env.get("SUPABASE_URL"); const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
          if (base && key) fetch(`${base}/functions/v1/internal-agent-run`, {
            method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ agent_id: agent.id, mode: "chat", conversation_id: state.conversation_id }),
          }).catch(() => {});
        }
      }
      if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
      return jsonResponse({ ok: true, finished: true, rounds: newRound });
    }

    // Not done (continue / replan) → trace the iteration, persist the loop state
    // and chain the next tick atomically. `model` carries any mid-run escalation
    // forward; `progress`/`stagnation` are what the next tick compares against.
    await traceLoop();
    await admin.from("internal_agent_run_state").update({
      messages, round: newRound, tokens_in: tokIn, tokens_out: tokOut, cost_usd: cost,
      error_count: errorCount, replans,
      // Carry the provider forward with the model it belongs to: a failover (or
      // a corrected mismatch) must survive the tick, or the next one re-fails.
      provider: tickProvider, model: tickModel ?? state.model,
      progress, stagnation, iteration,
      meta: await buildNextMeta(),
      processing_until: null, updated_at: new Date().toISOString(), last_input_at: newLastInputAt,
    }).eq("run_id", runId);
    if (msgId != null) await admin.rpc("agent_tick_next", { p_msg_id: msgId, p_run_id: runId });
    else await admin.rpc("agent_tick_enqueue", { p_run_id: runId });
    return jsonResponse({ ok: true, rounds: newRound, continued: true });
  } catch (e) {
    if (e instanceof AwaitingInputError) {
      const q = e.options.length ? `${e.question}\n\n${e.options.map((o) => `- ${o}`).join("\n")}` : e.question;
      await salvageReportDraft(admin, agent, runId, state);
      await admin.from("internal_agent_runs").update({
        status: "awaiting_input", finished_at: new Date().toISOString(),
        final_output: q.slice(0, 2000), pending_question: { question: e.question, options: e.options },
      }).eq("id", runId);
      if (roomBinding) {
        // Rooms don't have inline answer buttons — surface the question as the
        // room reply; the user answers with a new message (which starts a fresh
        // room turn carrying the context).
        await closeRoomMessage(admin, agent, roomBinding, runId, q, "done");
        // A mission task that ends on a question cannot be waited on forever —
        // report it as failed so the frontier either reroutes or blocks visibly.
        await reportMissionTask(false, `Question posée, sans réponse : ${q}`);
      } else if (isChat) {
        // Surface the question as the assistant's reply so the user can just answer.
        // Options become clickable buttons in the chat (ui_blocks 'options').
        if (state.conversation_id) {
          const optionsBlock = e.options.length
            ? [{ component: "options", props: { question: e.question, options: e.options.slice(0, 6) } }]
            : null;
          await admin.from("internal_agent_messages").insert({ conversation_id: state.conversation_id, agent_id: agent.id, role: "assistant", content: e.options.length ? e.question : q, run_id: runId, ui_blocks: optionsBlock });
          await admin.from("internal_agent_conversations").update({ updated_at: new Date().toISOString() }).eq("id", state.conversation_id);
          // If this chat came from a channel, ask the question there too.
          await postReplyToBoundChannel(admin, agent, state.conversation_id, q);
        }
      } else {
        await admin.from("internal_agent_missions").update({ board_column: "todo" }).eq("id", state.mission_id).eq("board_column", "in_progress");
      }
      await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
      if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
      return jsonResponse({ ok: true, awaiting_input: true });
    }
    // Write-action approval in a room: rooms have no inline approval, so end the
    // turn with a clear note (don't loop the tick) — approve in direct chat.
    if ((e as { name?: string })?.name === "AwaitingApprovalError" && roomBinding) {
      const summary = (e as { summary?: string }).summary ?? "action sensible";
      await salvageReportDraft(admin, agent, runId, state);
      await admin.from("internal_agent_runs").update({ status: "awaiting_input", finished_at: new Date().toISOString() }).eq("id", runId);
      // The gate stops the ACTION, not the work already done: the report the
      // agent wrote before asking for permission ships with this message.
      await closeRoomMessage(admin, agent, roomBinding, runId,
        `⏸️ L'action « ${summary} » nécessite une approbation humaine. Ouvre-moi en chat direct (hors room) pour l'approuver et l'exécuter.`,
        "done");
      await reportMissionTask(false, `Approbation humaine requise : ${summary}`);
      await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
      if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
      return jsonResponse({ ok: true, awaiting_approval: true });
    }
    if (e instanceof RunCancelledError) {
      await admin.from("internal_agent_runs").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", runId);
      await reportMissionTask(false, "Run annulé.");
      await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
      if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
      return jsonResponse({ ok: false, cancelled: true });
    }
    const msg = e instanceof Error ? e.message : String(e);

    // Over budget even after compaction AND the provider failover: retrying is
    // pointless — the same transcript would be re-sent every redelivery until
    // the zombie reaper kills the run 12 minutes later, which is how a plain
    // "prompt too big" surfaced as "Run did not finish in time". End it now,
    // with the reason a human can act on (raise the tier, or shorten the brief).
    if (e instanceof PayloadTooLargeError) {
      // The context blew up AFTER the agent had written most of its report —
      // keep the sections rather than losing the whole run's output.
      await salvageReportDraft(admin, agent, runId, state);
      const detail = e.limit
        ? `${msg} — le contexte de l'agent (${e.requested ?? "?"} tokens) dépasse le quota du modèle (${e.limit}).`
        : msg;
      await ctx.logEvent("error", { error: detail }).catch(() => {});
      await admin.from("internal_agent_runs").update({
        status: "failed", finished_at: new Date().toISOString(), error_message: detail.slice(0, 500),
      }).eq("id", runId);
      if (roomBinding) {
        await closeRoomMessage(admin, agent, roomBinding, runId,
          `⚠️ Contexte trop volumineux pour le modèle configuré. ${detail}\n\nPistes : réduire la portée de la tâche, ou passer l'agent sur DeepSeek (fenêtre plus large).`,
          "failed");
      }
      await reportMissionTask(false, detail);
      await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
      if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
      return jsonResponse({ ok: false, error: detail }, { status: 200 });
    }

    // Transient error: release the lease and DON'T ack → pgmq redelivers (the
    // #8 reconciler caps it if it never recovers).
    await admin.from("internal_agent_run_state").update({ processing_until: null }).eq("run_id", runId);
    await ctx.logEvent("error", { error: msg }).catch(() => {});
    return jsonResponse({ ok: false, error: msg }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Opportunistic zombie reconciler. The Edge runtime caps a worker's wall clock
// (~400s), so a background run whose worker was killed mid-flight would stay
// 'running' forever (and would shadow the live view's "latest run" lookup). On
// every invocation we cheaply fail any run that's been 'running' far longer than
// a worker can live — UNLESS it has a fresh tick state (mission OR chat ticks
// keep `internal_agent_run_state.updated_at` current), which means it's still
// progressing across ticks and must NOT be killed.
const ZOMBIE_RUN_MS = 12 * 60 * 1000;
async function reconcileZombieRuns(admin: ReturnType<typeof createServiceClient>) {
  try {
    const before = new Date(Date.now() - ZOMBIE_RUN_MS).toISOString();
    // Runs that are still actively ticking (state touched within the window).
    const { data: ticking } = await admin
      .from("internal_agent_run_state").select("run_id").gt("updated_at", before);
    const activeIds = (ticking ?? []).map((r: { run_id: string }) => r.run_id);
    let q = admin
      .from("internal_agent_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_message: "Run did not finish in time (worker timed out)." })
      .eq("status", "running")
      .lt("started_at", before);
    if (activeIds.length) q = q.not("id", "in", `(${activeIds.join(",")})`);
    await q;
  } catch { /* best-effort */ }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mobile companion app. Two ways in — a logged-in Anduran **account** (user JWT
// in Authorization) which unlocks every agent the user can access, or the legacy
// per-agent **secret** which unlocks that one agent. Then dispatched on `action`,
// using the SAME agent + conversation store as the web chat (shared memory, tools,
// past sessions). Actions:
//   list_agents         → (account only) the agents this user can talk to
//   verify              → credentials check (registration)
//   list_conversations  → the agent's recent conversations
//   get_messages        → messages of a conversation (+ whether a run is running)
//   send                → append the user message and run the real agentic chat
// Body: { agent_id?, secret?, action?, conversation_id?, message?, verify? }
async function handleMobile(body: Record<string, unknown>, authHeader: string | null): Promise<Response> {
  const admin = createServiceClient();
  const agentId = String(body.agent_id ?? "");
  const secret = body.secret ? String(body.secret) : "";
  const action = String(body.action ?? (body.verify ? "verify" : "send"));

  // ── Resolve the caller ──
  // No secret → account mode: authenticate the Anduran user from the JWT.
  let userId: string | null = null;
  let userClient: ReturnType<typeof createUserClient> | null = null;
  if (!secret) {
    userClient = createUserClient(authHeader);
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return jsonResponse({ error: "authentication required" }, { status: 401 });
    userId = u.user.id;
  }

  // ── Account-only: list every agent this user can talk to (RLS-scoped) ──
  if (action === "list_agents") {
    if (!userClient) return jsonResponse({ error: "account required" }, { status: 401 });
    const { data, error } = await userClient
      .from("internal_agents")
      .select("id, name, avatar_url, avatar_emoji, accent_color, description, updated_at")
      .eq("is_archived", false)
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    return jsonResponse({ agents: data ?? [] });
  }

  // Every other action is agent-scoped.
  if (!agentId) return jsonResponse({ error: "agent_id required" }, { status: 400 });

  // ── Authorize this agent for the caller (secret hash OR account access) ──
  if (secret) {
    const { data: sec } = await admin
      .from("internal_agents")
      .select("mobile_secret_hash, mobile_enabled, is_archived")
      .eq("id", agentId)
      .maybeSingle();
    if (!sec || sec.is_archived) return jsonResponse({ error: "unknown agent" }, { status: 404 });
    if (!sec.mobile_enabled || !sec.mobile_secret_hash) {
      return jsonResponse({ error: "mobile access is disabled for this agent" }, { status: 403 });
    }
    if ((await sha256Hex(secret)) !== sec.mobile_secret_hash) {
      return jsonResponse({ error: "invalid secret" }, { status: 401 });
    }
  } else {
    const { data: allowed } = await admin.rpc("has_internal_agent_access", {
      p_agent_id: agentId,
      p_user_id: userId,
    });
    if (!allowed) return jsonResponse({ error: "not authorized for this agent" }, { status: 403 });
  }

  if (action === "verify") return jsonResponse({ ok: true });

  if (action === "list_conversations") {
    const { data } = await admin
      .from("internal_agent_conversations")
      .select("id, title, updated_at, created_at")
      .eq("agent_id", agentId)
      .order("updated_at", { ascending: false })
      .limit(50);
    return jsonResponse({ conversations: data ?? [] });
  }

  if (action === "get_messages") {
    const cid = String(body.conversation_id ?? "");
    if (!cid) return jsonResponse({ error: "conversation_id required" }, { status: 400 });
    const { data } = await admin
      .from("internal_agent_messages")
      .select("id, role, content, created_at, run_id")
      .eq("conversation_id", cid)
      .order("created_at", { ascending: true })
      .limit(300);
    // A run in flight for this conversation → the client keeps polling / shows "thinking".
    const { data: active } = await admin
      .from("internal_agent_run_state")
      .select("run_id")
      .eq("conversation_id", cid)
      .limit(1);
    return jsonResponse({ messages: data ?? [], running: (active ?? []).length > 0 });
  }

  if (action === "send") {
    const message = String(body.message ?? "").trim();
    if (!message) return jsonResponse({ error: "message required" }, { status: 400 });
    const { agent, tools } = await loadAgentAndTools(agentId);

    let cid = body.conversation_id ? String(body.conversation_id) : null;
    if (!cid) {
      const { data: convo } = await admin
        .from("internal_agent_conversations")
        .insert({
          agent_id: agent.id,
          workspace_id: agent.workspace_id,
          project_id: agent.project_id,
          title: message.slice(0, 60),
        })
        .select("id")
        .single();
      cid = convo?.id ?? null;
    }
    if (!cid) return jsonResponse({ error: "could not open conversation" }, { status: 500 });

    await admin.from("internal_agent_messages").insert({
      conversation_id: cid,
      agent_id: agent.id,
      role: "user",
      content: message.slice(0, 4000),
    });

    // Same agentic chat loop as the web app (tools, memory, planning) — runs in
    // the background across ticks; the reply lands in internal_agent_messages.
    const runResp = await runChat(agent, tools, cid);
    const runJson = await runResp.json().catch(() => ({}));
    return jsonResponse({ conversation_id: cid, run_id: runJson?.run_id ?? null, queued: true });
  }

  return jsonResponse({ error: "unknown mobile action" }, { status: 400 });
}

// ── Agent designer ──────────────────────────────────────────────────────────
// One request in, one runnable agent spec out. The model picks the studio when
// the request is really about coding / testing / simulating an app, because a
// studio agent gets a real engine instead of generic web tools.
const DESIGNABLE_TOOL_KINDS = [
  "web_search", "web_fetch", "rag_search", "db_read", "vibe_code",
] as const;

const DESIGNER_SYSTEM = `You design internal AI agents for a company workspace. Given a plain-language request, output ONE agent that would actually do that job.

Return STRICT JSON, no prose, with this shape:
{
  "name": "short human name, e.g. 'Release Tester'",
  "tagline": "one line: what you get",
  "category": "Support|Revenue|Growth|Ops|Leadership|Product|Cybersecurity|Data|HR|Supply chain|Design|QA|R&D|Finance|Legal|Marketing|Assistant",
  "studio": "vibe_code|testing|simulation|null",
  "persona": "2-3 sentences describing who this agent is and how it behaves",
  "instructions": "the agent's operating procedure: numbered steps it follows for every task, plus explicit rules about what it must never do. Be specific to the request — no generic filler.",
  "autonomy": "advisor|assisted|autopilot",
  "max_steps": 8,
  "tools": [{ "kind": "web_search|web_fetch|rag_search|db_read|vibe_code", "name": "short label", "description": "why this agent needs it" }],
  "outcomes": ["3 concrete results the owner gets"],
  "suggestedSchedule": { "label": "string", "cron": "0 9 * * 1", "prompt": "what to do on each run" } or null
}

Rules:
- studio="vibe_code" ONLY when the agent writes/modifies real code in a repository. Give it the vibe_code tool.
- studio="testing" for agents that run test suites against an app; "simulation" for agents that simulate users/scenarios. Otherwise null.
- autonomy: "advisor" when the job is analysis/recommendation, "assisted" when it acts but a human should approve writes, "autopilot" only for low-risk repetitive work.
- max_steps: 6-10 for simple jobs, up to 20 for coding/testing agents.
- Instructions are the product. Write what a competent operator would write, in the language of the request.`;

async function designAgent(request: string, projectId: string | null): Promise<Response> {
  // Ground the design in what this project actually has, so the model doesn't
  // invent a repo-driven agent for a project with no repository connected.
  let context = "";
  if (projectId) {
    const admin = createServiceClient();
    const [{ data: repos }, { data: connectors }] = await Promise.all([
      admin.from("repositories").select("full_name").eq("project_id", projectId).limit(10),
      admin.from("connectors").select("provider").eq("project_id", projectId).eq("status", "connected").limit(20),
    ]);
    const repoNames = ((repos ?? []) as Array<{ full_name: string }>).map((r) => r.full_name);
    const providers = ((connectors ?? []) as Array<{ provider: string }>).map((c) => c.provider);
    context =
      `\n\nProject context — repositories: ${repoNames.length ? repoNames.join(", ") : "none connected"}.` +
      ` Connected tools: ${providers.length ? providers.join(", ") : "none"}.`;
  }

  const { content } = await callAi({
    task: "json_extraction",
    systemPrompt: DESIGNER_SYSTEM,
    userPrompt: `Request: ${request}${context}`,
    jsonMode: true,
    temperature: 0.4,
    maxTokens: 2000,
  });

  const spec = safeParseJson<Record<string, unknown>>(content);
  if (!spec || typeof spec.name !== "string") {
    return jsonResponse({ error: "Could not design an agent from this request", detail: content.slice(0, 300) }, { status: 422 });
  }

  // Normalise everything the UI will instantiate — a hallucinated tool kind or
  // autonomy level would fail at insert time (the tool-kind CHECK constraint),
  // so they're filtered here rather than surfacing as a broken agent.
  const rawTools = Array.isArray(spec.tools) ? spec.tools as Array<Record<string, unknown>> : [];
  const tools = rawTools
    .filter((t) => DESIGNABLE_TOOL_KINDS.includes(String(t.kind) as typeof DESIGNABLE_TOOL_KINDS[number]))
    .slice(0, 6)
    .map((t) => ({
      kind: String(t.kind),
      name: String(t.name ?? t.kind).slice(0, 60),
      description: t.description ? String(t.description).slice(0, 200) : undefined,
      ...(String(t.kind) === "vibe_code" ? { config: { actions: ["run", "apply", "pr_status", "fix_pr"] } } : {}),
    }));

  const studio = ["vibe_code", "testing", "simulation"].includes(String(spec.studio)) ? String(spec.studio) : null;
  const autonomy = ["advisor", "assisted", "autopilot"].includes(String(spec.autonomy)) ? String(spec.autonomy) : "assisted";
  const maxSteps = Number(spec.max_steps);

  return jsonResponse({
    spec: {
      name: String(spec.name).slice(0, 60),
      tagline: String(spec.tagline ?? "").slice(0, 160),
      category: String(spec.category ?? "Assistant"),
      studio,
      persona: String(spec.persona ?? ""),
      instructions: String(spec.instructions ?? ""),
      autonomy,
      max_steps: Number.isFinite(maxSteps) ? Math.min(Math.max(Math.round(maxSteps), 4), 24) : 10,
      // A studio agent is useless without its engine — add it back if the model
      // described the studio but forgot the tool.
      tools: studio === "vibe_code" && !tools.some((t) => t.kind === "vibe_code")
        ? [{ kind: "vibe_code", name: "Vibe Code", config: { actions: ["run", "apply", "pr_status", "fix_pr"] } }, ...tools]
        : tools,
      outcomes: Array.isArray(spec.outcomes) ? (spec.outcomes as unknown[]).slice(0, 4).map(String) : [],
      suggestedSchedule: spec.suggestedSchedule && typeof spec.suggestedSchedule === "object"
        ? spec.suggestedSchedule
        : null,
    },
  });
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    // Reconcile stuck runs before doing anything else (best-effort, cheap).
    await reconcileZombieRuns(createServiceClient());

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const isService = token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const body = await req.json();
    const { agent_id, mode, conversation_id, run_id, msg_id } = body as {
      agent_id?: string;
      mode?: string;
      conversation_id?: string;
      run_id?: string;
      msg_id?: number;
    };

    // Mission ticks are INTERNAL: dispatched by the pg_cron drainer via pg_net.
    // Authenticated by a dedicated shared secret (x-tick-secret) rather than the
    // service key, so it doesn't depend on the gateway/env key byte-matching.
    if (mode === "tick") {
      const tickSecret = Deno.env.get("AGENT_TICK_SECRET");
      const provided = req.headers.get("x-tick-secret");
      if (!isService && (!tickSecret || provided !== tickSecret)) {
        return jsonResponse({ error: "tick is internal-only" }, { status: 403 });
      }
      if (!run_id) return jsonResponse({ error: "run_id required for tick" }, { status: 400 });
      return await runMissionTick(run_id, typeof msg_id === "number" ? msg_id : null);
    }

    // Room-mission watchdog, same trust model as the tick above: the SQL cron
    // (reconcile_stalled_room_missions) spots a mission whose frontier has
    // nothing alive left and re-enters the orchestrator here. advanceRoomMission
    // heals the dead in-flight tasks itself, then dispatches, replans or closes
    // — so a killed worker no longer parks a mission at "en cours" for ever.
    if (mode === "room_advance") {
      const tickSecret = Deno.env.get("AGENT_TICK_SECRET");
      const provided = req.headers.get("x-tick-secret");
      if (!isService && (!tickSecret || provided !== tickSecret)) {
        return jsonResponse({ error: "room_advance is internal-only" }, { status: 403 });
      }
      const missionId = (body as { mission_id?: string }).mission_id;
      if (!missionId) return jsonResponse({ error: "mission_id required" }, { status: 400 });
      await advanceRoomMission(createServiceClient(), missionId);
      return jsonResponse({ ok: true });
    }

    // Mobile companion app: authenticated by a Anduran account (user JWT) or the
    // agent's own (id + secret). Dispatches on body.action (list_agents / verify /
    // list_conversations / get_messages / send), same store as the web chat.
    if (mode === "mobile" || mode === "mobile_chat") {
      return await handleMobile(body, authHeader);
    }

    // DESIGN: turn a plain-language request ("un agent qui teste mon app avant
    // chaque release") into a complete agent spec the UI can instantiate. Lives
    // here rather than in its own function because it needs exactly this
    // module's model routing — and the project is one slot from Supabase's
    // 100-function cap.
    if (mode === "design") {
      const { request, project_id } = body as { request?: string; project_id?: string };
      if (!request?.trim()) return jsonResponse({ error: "request required" }, { status: 400 });
      if (!isService) {
        const { data: userData, error: userErr } = await createUserClient(authHeader).auth.getUser();
        if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      }
      return await designAgent(request.trim(), project_id ?? null);
    }

    if (!agent_id || !mode) {
      return jsonResponse({ error: "Missing agent_id or mode" }, { status: 400 });
    }

    // Authenticated users must have access to this agent (creator or member).
    if (!isService) {
      const userClient = createUserClient(authHeader);
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      const admin = createServiceClient();
      const { data: allowed } = await admin.rpc("has_internal_agent_access", {
        p_agent_id: agent_id,
        p_user_id: userData.user.id,
      });
      if (!allowed) return jsonResponse({ error: "Not authorized for this agent" }, { status: 403 });
    }

    const { agent, tools } = await loadAgentAndTools(agent_id);

    // ── Quota : on refuse AVANT d'engager la dépense ─────────────────────────
    // Démarrer un run sans crédits produit un échec au deuxième tour et un
    // client mécontent. Le minimum exigé (60 crédits ≈ deux tours d'agent)
    // garantit qu'un run qui démarre a de quoi produire quelque chose.
    // Les ticks (mode "tick") ne repassent pas ici : la boucle se contrôle
    // elle-même à chaque tour, cf. le contrôleur plus bas.
    if (mode === "chat" || mode === "mission") {
      await assertCredits(agent.workspace_id, { minimum: 60 });
      await assertQuota(agent.workspace_id, "concurrent_runs", 1, { fresh: true });
    }

    if (mode === "chat") {
      if (!conversation_id) return jsonResponse({ error: "conversation_id required for chat mode" }, { status: 400 });
      return await runChat(agent, tools, conversation_id, (body as { model?: string }).model ?? null);
    }
    if (mode === "mission") {
      if (!run_id) return jsonResponse({ error: "run_id required for mission mode" }, { status: 400 });
      return await runMission(agent, tools, run_id);
    }
    return jsonResponse({ error: "Unknown mode" }, { status: 400 });
  } catch (e) {
    // 402 plutôt que 500 : le front doit pouvoir distinguer « plus de crédits »
    // (action : recharger / changer d'offre) d'une panne (action : réessayer).
    if (isQuotaError(e)) return quotaErrorResponse(e);
    return jsonResponse({ error: e instanceof Error ? e.message : "Internal error" }, { status: 500 });
  }
});
