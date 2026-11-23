// Le prompt système d'un agent et ses sections (identité, entreprise, âme,
// consignes, doctrines, skills classés, préférences, mémoire, mémoire d'équipe,
// travail récent, règles, horloge), et le plan d'exécution qui amorce ses tâches.
// Sorti de l'ancien moteur (internal-agent-run), sans sa boucle.

import { Deno } from "../compat/index.ts";
import { createServiceClient } from "../edge/_shared/supabase-admin.ts";
import { callAi } from "../edge/_shared/ai.ts";
import { normalizeAutonomy, type AutonomyLevel } from "../edge/_shared/policyguard.ts";
import { classifyTier, modelForTier, availableProviders, type Provider } from "../edge/_shared/model-router.ts";
import { NO_LONG_DASH_RULE, RICH_REPLY_DOCTRINE } from "../edge/_shared/reply-format.ts";
import { embedTexts, embeddingsAvailable, toVectorLiteral } from "../edge/_shared/jina.ts";
import { judge, choice, readChoice, ranked, qid, type JudgeContext } from "../edge/_shared/typesafe.ts";
import { embedMemoryVector, touchAgentMemories, type AgentSkill } from "../edge/_shared/internal-agent-tools.ts";
import { compileSystemPrompt, selectRelevant, type SectionInput, type PromptBudget } from "../edge/_shared/prompt-compiler.ts";
import {
  renderSoul, selectPreferences, selectSkills, type SkillLike,
} from "../edge/_shared/agent-context.ts";
import { selectMemoriesForPrompt, type MemoryRow } from "../edge/_shared/agent-memory.ts";
import {
  loadCompanyContext, renderCompanySection, type CompanyContext,
} from "../edge/_shared/company-context.ts";
import { ASSISTANT_OPS_DOCTRINE } from "../edge/_shared/assistant-ops.ts";
import { TEAM_OPS_DOCTRINE } from "../edge/_shared/team-architect.ts";
import { CONNECTOR_OPS_DOCTRINE } from "../edge/_shared/assistant-connectors.ts";
import { defaultTimezone, renderClock } from "../edge/_shared/clock.ts";
import { PROACTIVITY_DOCTRINE, ORCHESTRATOR_PROACTIVITY } from "../edge/_shared/proactivity.ts";
import type { AgentRow } from "./context.ts";

// Security operating doctrine — adapted from the strix pentesting agent prompt
// (Apache-2.0). Injected ONLY for agents with a cybersecurity skill activated,
// so the pentest agents carry the offensive-security mindset while every other
// agent's prompt stays untouched. Framing, tools and reporting are mapped to
// Anduran (pentest_scope gate, sandbox tools, delegate_mission, deliverables).
export const SECURITY_DOCTRINE = [
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
export function isSecurityAgent(skills: AgentSkill[] | undefined): boolean {
  return (skills ?? []).some((s) => (s.category ?? "").toLowerCase() === "cybersecurity");
}

// The default assistant of a service dashboard — it builds out the workspace by
// conversation, so the user can chat and set things up without leaving the room.
export const ORCHESTRATOR_DOCTRINE = [
  "## You are this workspace's orchestrator (its default assistant)",
  "You help run a service workspace by conversation. Beyond answering, you can BUILD the workspace when asked — act directly, don't just describe:",
  "- CREATE & CONFIGURE AGENTS: when the user wants a specialist (\"crée un agent SEO\", \"ajoute un agent qui surveille X\") or wants one changed, use manage_agents (create, update, connect, set_skills, add_tool…). Give the connectors, skills and tools asked for in the SAME create call. Confirm it's ready and offer to open it or give it work.",
  "- RUN THE WORK TRACKER: projects, work items, crews and pages go through manage_projects; launch an agent on an item only when asked.",
  "- SCHEDULE WORK: when the user wants recurring work (\"chaque matin fais X\", \"tous les lundis…\", \"un brief quotidien\"), call create_mission with a cron `schedule` (e.g. '0 6 * * *' for daily 06:00). Assign it to the right agent via assignee_agent, creating that agent first if needed.",
  "- RUN A ONE-OFF TASK: for \"fais X maintenant\", either do it yourself with your tools, or create_mission (start_now) on the best-suited agent.",
  "- COORDINATE: keep track of the service's agents (list_team_agents), delegate to the right one, and summarize.",
  "Confirm each action plainly once done (\"Agent X créé\", \"Brief quotidien planifié à 6h\"). Ask a brief clarifying question only when the request is genuinely ambiguous (e.g. a schedule with no time).",
].join("\n");

/**
 * Classer les skills d'un agent contre la tâche — en un appel.
 *
 * Le catalogue système en compte plusieurs centaines ; celles ACTIVÉES sur un
 * agent sont moins nombreuses, mais la correspondance de mots ne sait
 * rapprocher que ce qui partage un vocabulaire : une demande « le client
 * conteste sa facture » ne réveille pas une skill « recouvrement » tant que le
 * mot n'y est pas écrit. Un `choice` rend la distribution COMPLÈTE sur toutes
 * les options : c'est un classement entier au prix d'une seule question.
 *
 * Rend `undefined` quand l'usage est éteint, en shadow, ou quand l'appel
 * échoue — et la sélection lexicale reprend la main, inchangée.
 */
export async function rankSkills(
  judgeCtx: JudgeContext,
  skills: SkillLike[],
  taskText: string,
): Promise<((s: SkillLike) => number) | undefined> {
  // En dessous de cinq, la sélection les garde toutes : classer ne changerait
  // rien et coûterait un appel.
  if (skills.length < 5 || !taskText.trim()) return undefined;
  const criteria: Record<string, string | null> = {};
  const bySlug = new Map<string, SkillLike>();
  for (const s of skills.slice(0, 200)) {
    const key = qid(s.slug);
    if (criteria[key] !== undefined) continue;
    criteria[key] = `${s.name ?? s.slug} — ${String(s.description ?? "").replace(/\s+/g, " ").slice(0, 180)}`;
    bySlug.set(key, s);
  }
  if (Object.keys(criteria).length < 5) return undefined;

  const verdict = await judge(
    judgeCtx, "skill_ranking",
    { tache: taskText.slice(0, 2000) },
    {
      skill: choice(
        "Quelle expertise documentée sert le plus à traiter cette tâche ?",
        criteria,
      ),
    },
    { subject: `${bySlug.size} skill(s)` },
  ).catch(() => null);
  if (!verdict?.apply) return undefined;

  const answer = readChoice(verdict, "skill");
  const order = ranked(answer);
  if (order.length === 0) return undefined;
  // La probabilité devient un FACTEUR, pas un score : elle pondère la
  // correspondance lexicale au lieu de l'écraser. Un plancher à 1 évite qu'une
  // skill jugée inutile disparaisse alors que la tâche la nomme en toutes
  // lettres.
  const top = order[0].p || 1;
  const factor = new Map<string, number>();
  for (const { key, p } of order) {
    const slug = bySlug.get(key)?.slug;
    if (slug) factor.set(slug, 1 + (p / top) * 3);
  }
  return (s: SkillLike) => factor.get(s.slug) ?? 1;
}

/** Per-section char budgets for the knowledge blocks. They are re-selected
 *  against the CURRENT task on every build, so a tight budget costs relevance,
 *  not reach: everything omitted stays reachable via search_memory /
 *  search_context, which the operating rules tell the agent to use. */
export const SECTION_BUDGET = { memory: 2600, team: 1200, recent: 1200, skills: 1400, preferences: 1200, company: 1400 } as const;

/** Keep only the lines of a pre-rendered "- …" block that matter for this task.
 *  Pinned memories (rendered as "[kind, pinned]") always survive. */
export function selectLines(block: string, task: string, budget: number): { body: string; dropped: number; offered: number } {
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

// What the collaborator may do alone (0266). PolicyGuard enforces it; this line
// keeps it from bumping into the gate in a loop.
export const AUTONOMY_RULE: Record<AutonomyLevel, string> = {
  observer: "- AUTONOMIE : OBSERVATEUR. Tu lis, analyses et rédiges des livrables, mais tu n'écris JAMAIS dans les outils connectés (CRM, e-mail, intégrations, suivi) : ces actions te seront refusées. Décris ce que tu ferais, ou dépose-le avec propose_mission.",
  propose: "- AUTONOMIE : PROPOSER. Chaque écriture dans un outil connecté attend une validation humaine. Prépare l'action complète, demande-la, et avance sur le reste en attendant.",
  assisted: "- AUTONOMIE : ASSISTÉ. Les écritures sensibles attendent une validation humaine ; celles que l'équipe t'a confiées passent directement.",
  autonomous: "- AUTONOMIE : AUTONOME. Tu agis seul sous le plafond de risque de l'équipe ; une action irréversible ou engageante demande toujours une personne. Rends compte de ce que tu as fait.",
};

export function buildSystemPrompt(
  agent: AgentRow,
  capabilitySummary: string,
  mode: "chat" | "mission",
  memorySection: string,
  teamMemorySection: string,
  /** The agent's ACTIVATED skills, unranked. They are selected against the
   *  task below — never sent whole. A pre-rendered string is still accepted
   *  (legacy call sites) and passed through untouched. */
  skillPrompts: string | SkillLike[] = "",
  recentWorkSection: string = "",
  securityDoctrine: boolean = false,
  /** The turn's actual subject — drives which knowledge lines are worth sending.
   *  Empty (sub-agents, cold starts) → no selection, previous behaviour. */
  taskText: string = "",
  toolStats?: { sent: number; omitted: number; chars: number },
  /** Spawned worker with ONE narrow subtask: it inherits no initiative — its
   *  job is to return its piece, not to have ideas about the whole engagement. */
  isSubAgent: boolean = false,
  /** L'entreprise pour laquelle l'agent travaille (0212). Absent = projet sans
   *  profil ni objectif : la section disparaît, tout le reste est identique. */
  company: CompanyContext | null = null,
  /** Le classement des skills par jugement rapide (TypeSafe), quand l'usage est
   *  allumé. Absent = classement lexical, comportement d'avant au mot près. */
  skillBoost?: (s: SkillLike) => number,
  /** Ce que l'agent sait de lui-même : équipe, bilan, charge (self-model.ts). */
  selfModel: string = "",
): { prompt: string; budget: PromptBudget } {
  const sections: SectionInput[] = [];
  const push = (id: SectionInput["id"], body: string, meta?: { dropped: number; offered: number }) => {
    if (body && body.trim()) sections.push({ id, body, ...(meta ?? {}) });
  };

  push("identity", [
    `You are ${agent.persona || agent.name}, an autonomous internal agent for a SaaS team.`,
    `You work as part of a TEAM of agents — you can discover, message and delegate to peers, and share knowledge through the team memory.`,
    ...(selfModel && !isSubAgent ? ["", selfModel] : []),
  ].join("\n"));
  // L'employeur, avant le caractère : un agent doit savoir OÙ il travaille
  // avant qu'on lui dise comment se comporter. Le profil part en entier (il
  // tient en dix lignes) ; les objectifs sont sélectionnés contre la tâche,
  // avec passe-droit pour ceux dont cet agent ou son service répond.
  const comp = renderCompanySection(company, taskText, SECTION_BUDGET.company);
  push("company", comp.body, { dropped: comp.dropped, offered: comp.offered });
  // The three files. Soul and instructions go whole — they are what the agent
  // IS and what it DOES, and neither means anything half-sent. Preferences are
  // selected further down, against the task.
  push("soul", renderSoul(agent.soul));
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
  if (agent.is_orchestrator) push("doctrine", `${ORCHESTRATOR_DOCTRINE}\n\n${ASSISTANT_OPS_DOCTRINE}\n\n${TEAM_OPS_DOCTRINE}\n\n${CONNECTOR_OPS_DOCTRINE}`);
  // Initiative is a doctrine, not a footnote: as one line inside the operating
  // rules it was reliably ignored. Sub-agents are excluded — a spawned worker
  // has ONE narrow subtask and must not start filing ideas of its own.
  if (!isSubAgent) push("doctrine", PROACTIVITY_DOCTRINE);
  if (agent.is_orchestrator) push("doctrine", ORCHESTRATOR_PROACTIVITY);

  // Knowledge blocks are SELECTED against this turn's subject, not dumped
  // whole. Everything filtered out stays one search_memory / search_context
  // away — the operating rules below say so explicitly.
  // Skills: ranked against the task, trimmed to what it plausibly needs, and
  // the one decisive match arrives already loaded. What isn't named is one
  // list_skills() away — the heading says so.
  if (Array.isArray(skillPrompts)) {
    const sel = selectSkills(skillPrompts, taskText, { budget: SECTION_BUDGET.skills, boost: skillBoost });
    push("skills", sel.body, { dropped: sel.dropped, offered: skillPrompts.length });
  } else {
    const skills = selectLines(skillPrompts, taskText, SECTION_BUDGET.skills);
    push("skills", skills.body, { dropped: skills.dropped, offered: skills.offered });
  }
  const prefs = selectPreferences(agent.preferences, taskText, SECTION_BUDGET.preferences);
  push("preferences", prefs.body, { dropped: prefs.dropped, offered: prefs.offered });
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
    "- SAVE durable knowledge as you learn it (save_memory), one self-contained line each: stable facts, installed tools, produced files (with paths), key results. Skip transient details and anything already known.",
    "- GRAPHE DE CONNAISSANCES (partagé par tout l'espace) : avant de demander une information interne à l'utilisateur ou à un pair, cherche-la avec knowledge_search — un nom propre de l'entreprise (client, personne, produit, système) est le signal. Dès que tu apprends quelque chose d'important et de durable que d'autres agents devraient savoir, enregistre-le avec knowledge_save, sous le nom complet de l'entité ; un modèle de décision filtre le reste.",
    "- PRÉFÉRENCES : dès que l'utilisateur exprime une habitude durable ou te reprend sur la forme (langue, ton, format d'un livrable, canal, horaire, ce qu'il ne veut jamais), enregistre-la avec remember_preference — une phrase impérative, réutilisable hors de cette conversation. S'il change d'avis, corrige la préférence existante (`replaces`) au lieu d'en empiler une seconde. Ne redemande jamais ce qui est déjà dans tes préférences.",
    "- Approvals: a gated tool queues for review and your run KEEPS RUNNING — acknowledge and continue; never re-ask an approval already granted. If a tool errors, adapt or state the limitation.",
    AUTONOMY_RULE[normalizeAutonomy(agent.autonomy_level)],
    // Initiative itself is covered by PROACTIVITY_DOCTRINE above; this line only
    // ties it back to the checklist discipline the rules are about.
    "- INITIATIVE : applique la doctrine d'initiative ci-dessus — ce qui découle de la demande fait partie du travail, ce qui en sort se dépose avec propose_mission. Jamais d'effet de bord hors périmètre.",
    "- ARTIFACTS : avant de créer un document/tableur/présentation, vérifie avec list_artifacts s'il existe déjà ; si oui, read_artifact puis update_artifact pour le corriger EN PLACE. Ne produis jamais une v2 à côté d'une v1 restée fausse.",
    "- TRAVAIL FAIT AILLEURS : dès que tu crées ou modifies quelque chose dans un outil externe (page Notion, issue Linear, doc Drive, fichier Figma, PR…), épingle-le avec link_artifact en donnant l'URL rendue par l'outil. Sinon ce travail n'existe nulle part dans le produit et personne ne le retrouvera.",
  );
  if (mode === "chat") {
    rules.push(RICH_REPLY_DOCTRINE);
    rules.push("- RICH REPLIES: when a component communicates better than prose (metrics, trends, comparisons, tabular data), attach real UI blocks with render_ui (kpi_grid/chart/table/link_card) and place each [[ui:N]] tag on its own line; real data only. When a sentence is clearer, just write it.");
    rules.push("- QUAND ON TE DEMANDE UN RAPPORT / UNE ANALYSE / UN LIVRABLE : ne demande PAS quoi faire et ne réponds pas juste en prose — fais l'analyse avec tes outils MAINTENANT, puis confie-la au Rédacteur avec request_report(subject, material, angle). Tu ne rédiges pas le rapport toi-même : tu lui passes les chiffres avec leurs sources, les constats et ce qui reste incertain, il publie le document. Une question de clarification UNIQUEMENT si c'est vraiment impossible d'avancer.");
  }
  if (agent.collaboration_enabled) {
    rules.push("- COLLABORATE: if a teammate's skills fit part of the work, message (send_message_to_agent) or delegate (delegate_mission) instead of doing it all; record team decisions with team_memory.");
    rules.push(
      "- L'ENTREPRISE A PLUSIEURS SERVICES, pas seulement le tien. Quand le travail touche un domaine qui n'est pas le tien (facturation, juridique, sécurité, recrutement…), CHERCHE d'abord qui s'en occupe — list_team_agents(scope=\"company\") ou explore_company_graph — au lieu de l'improviser ou de le laisser tomber. " +
      "Chaque service dit dans l'annuaire s'il accepte du travail venu d'ailleurs : respecte-le. Une mission refusée ou mise en attente n'est pas un échec, c'est la réponse — signale-la et poursuis ce que tu peux faire toi-même.",
    );
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
      "- UN SEUL fan-out par lot : NE relance JAMAIS spawn_parallel_agents pour des sous-tâches déjà lancées (même après compaction). Après un fan-out, ta tâche suivante est de RÉCUPÉRER puis SYNTHÉTISER les résultats (quand les sous-agents tournent en arrière-plan, chacun arrive dans un message <background-result> : avance sur le reste en attendant, puis synthétise) — s'ils ne sont plus dans ton contexte, utilise search_context(scope=\"run\", query=\"<libellé>\"). Re-spawner les mêmes sous-tâches est interdit (l'outil les refuse).",
    );
  }
  if (mode === "mission") {
    rules.push(
      "- Materialise every expected deliverable with create_deliverable before finishing.",
      `- ${NO_LONG_DASH_RULE}`,
      "- Your final message is a concise mission report (markdown): what you did, key findings, deliverables produced, pending approvals if any — plus an 'Initiatives' section when you noticed opportunities (each one filed via propose_mission).",
    );
  } else {
    rules.push(
      "- Respond in concise markdown, in the user's language. Avoid filler.",
      `- ${NO_LONG_DASH_RULE}`,
      "- BE CONVERSATIONAL & THINK FIRST. If the request is ambiguous, under-specified, or could go several ways, ASK a brief clarifying question before acting (e.g. which target, which period, which audience). Don't guess on important details. A short back-and-forth is better than a wrong deliverable.",
      "- Confirm scope on big/irreversible actions before doing them.",
      "- You can turn work into a tracked task with create_task, or kick off a full background mission with create_mission (use it when the user asks you to 'do X' as ongoing/standalone work, or to schedule recurring work).",
      "- When the user asks for an analysis, report or summary of data, do the work with your tools, then hand the MATTER to Le Rédacteur with request_report(subject, material) — he writes and publishes every report. Then reply with a short summary; the document opens as a card in the chat.",
      "- INTERDIT : n'affirme JAMAIS « rapport créé », « le rapport est en carte », « livrable créé » si tu n'as pas RÉELLEMENT appelé request_report dans CE tour ET qu'il t'a répondu « publié ». Un résumé écrit dans le chat n'est PAS un livrable et n'affiche aucune carte.",
    );
  }
  push("rules", rules.join("\n"));
  // Last section on purpose: the time changes every call, and anything after
  // the first changed byte misses the provider prefix cache.
  push("context", renderClock(defaultTimezone()));

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

export interface PlanTaskTool {
  tool: string;
  how: string;
  /** What the tool does & when it's useful — filled from the tool catalog. */
  desc?: string;
}

export interface PlanTask {
  /** Stable id (step-1, step-2, …) the agent uses with update_plan_step. */
  id: string;
  title: string;
  detail: string;
  tools: PlanTaskTool[];
}

export interface ExecutionPlan {
  understanding: string;
  reasoning: string;
  tasks: PlanTask[];
  risks?: string;
  done_when?: string;
}

export function planToMarkdown(plan: ExecutionPlan): string {
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

export function safeParsePlan(content: string): ExecutionPlan | null {
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

export async function produceExecutionPlan(opts: {
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

// Memory injected into the prompt, selected for THIS task (see agent-memory.ts).
// Pool = pinned + the vector matches of the task + the critical facts; each
// memory becomes ONE bounded line, ranked by relevance × importance × freshness
// × proven usefulness, under the section budget. What is left out (or cut
// short) is one search_memory away. The rows actually shown are marked as
// recalled — that usage is what later protects them from eviction.
export async function loadMemorySection(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
  taskText?: string,
): Promise<string> {
  const fetchStatic = (cols: string) => Promise.all([
    admin.from("internal_agent_memories").select(cols)
      .eq("agent_id", agentId).eq("is_pinned", true)
      .order("importance", { ascending: false }).limit(20),
    admin.from("internal_agent_memories").select(cols)
      .eq("agent_id", agentId).eq("is_pinned", false)
      .order("importance", { ascending: false }).order("updated_at", { ascending: false }).limit(20),
  ]);
  let [{ data: pinned, error: e1 }, { data: top }] = await fetchStatic(
    "id, kind, content, importance, is_pinned, source, recall_count, last_recalled_at, updated_at, created_at");
  // Before migration 0249 the usage columns do not exist, and the select would
  // fail — silently emptying every prompt's memory. Fall back to the old shape.
  if (e1) [{ data: pinned }, { data: top }] = await fetchStatic("id, kind, content, importance, is_pinned, source, updated_at, created_at");
  const staticRows = [...(pinned ?? []), ...(top ?? [])] as unknown as MemoryRow[];
  if (staticRows.length === 0) return "";
  let rows = staticRows;

  // Semantic recall against the task. Skipped for a greeting: an embedding
  // call to decide which memories a « merci » needs is money for nothing.
  const task = (taskText ?? "").trim();
  if (task && classifyTier(task, { mode: "chat" }) !== "light" && embeddingsAvailable()) {
    try {
      const [qvec] = await embedTexts([task.slice(0, 1500)], "retrieval.query");
      if (qvec) {
        const { data: sem } = await admin.rpc("match_agent_memories", {
          p_agent_id: agentId, p_query_embedding: toVectorLiteral(qvec), p_match_count: 12,
        });
        if (Array.isArray(sem) && sem.length) {
          // Once the task is known, a non-pinned memory earns its place by
          // matching it — or by being critical (importance ≥ 4).
          const semantic = sem as MemoryRow[];
          const semIds = new Set(semantic.map((m) => m.id));
          rows = [
            ...staticRows.filter((m) => m.is_pinned && !semIds.has(m.id)),
            ...semantic,
            ...staticRows.filter((m) => !m.is_pinned && !semIds.has(m.id) && (m.importance ?? 3) >= 4),
          ];
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

  const sel = selectMemoriesForPrompt(rows, { budget: SECTION_BUDGET.memory });
  touchAgentMemories(admin, sel.ids);
  return sel.body;
}

// Shared team knowledge pool, injected so agents share context across the team.
// "Recent work" for the chat system prompt: the agent's last mission runs, so a
// conversation starts aware of what it just did (paths, results, failures)
// instead of rediscovering — or worse, redoing — its own work.
export async function loadRecentWorkSection(
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

/**
 * La mémoire partagée, sur DEUX des trois étages (0213).
 *
 * Avant : une seule requête sur project_id, quinze lignes, toutes équipes
 * confondues. Le savoir Finance occupait le contexte d'un agent Marketing, et
 * le savoir réellement transverse n'avait aucun rang particulier.
 *
 * Maintenant l'agent reçoit ce qui le concerne, étiqueté :
 *   • ENTREPRISE — service_dashboard_id NULL : ça vaut pour tout le monde.
 *   • SERVICE    — son dashboard : ça vaut pour son équipe.
 * La mémoire des AUTRES services ne part plus d'office ; elle reste accessible
 * via team_memory(scope="all"), ce que les règles d'opération disent.
 *
 * L'entreprise passe en premier et garde une part réservée du quota : c'est le
 * cadre commun, il ne doit pas se faire évincer par quinze notes de service.
 */
export async function loadTeamMemorySection(
  admin: ReturnType<typeof createServiceClient>,
  projectId: string,
  dashboardId: string | null,
): Promise<string> {
  type Row = { kind: string; content: string; is_pinned: boolean };
  // Les filtres AVANT les tris et la limite : passé `.limit()`, le builder
  // Supabase n'expose plus `.eq()` / `.is()`.
  const pick = (scope: "company" | "service", limit: number) => {
    const base = admin
      .from("internal_agent_team_memories")
      .select("kind, content, is_pinned")
      .eq("project_id", projectId);
    const scoped = scope === "company"
      ? base.is("service_dashboard_id", null)
      : base.eq("service_dashboard_id", dashboardId!);
    return scoped
      .order("is_pinned", { ascending: false })
      .order("importance", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(limit);
  };

  const [{ data: company }, service] = await Promise.all([
    pick("company", 8),
    dashboardId ? pick("service", 10) : Promise.resolve({ data: [] as Row[] }),
  ]);
  const line = (m: Row, tier: string) =>
    `- [${tier}·${m.kind}${m.is_pinned ? ", pinned" : ""}] ${m.content}`;
  const out = [
    ...((company ?? []) as Row[]).map((m) => line(m, "entreprise")),
    ...(((service as { data: Row[] | null }).data ?? []) as Row[]).map((m) => line(m, "service")),
  ];
  return out.join("\n");
}

/** L'entreprise de cet agent, et sa place dedans (0212/0213). Le service est
 *  résolu par le chargeur : c'est lui qui décide de ce qui sera marqué « à
 *  toi » dans les objectifs. */
export function loadCompanySection(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
): Promise<CompanyContext | null> {
  if (!agent.project_id) return Promise.resolve(null);
  return loadCompanyContext(admin, agent.project_id, {
    agentId: agent.id,
    dashboardId: agent.service_dashboard_id ?? null,
  });
}

// ---------------------------------------------------------------------------
// Le prompt du harnais OpenCode
// ---------------------------------------------------------------------------
//
// Deux morceaux, pour que le cache de préfixe du fournisseur serve :
//   - le prompt de l'AGENT (buildAgentSystem), stable d'un run à l'autre :
//     identité, entreprise, âme, consignes, doctrines, préférences, outils,
//     règles. Ses outils sont ceux du toolkit (grep, build_context, remember,
//     todowrite, question, subagent, lots) ; les doctrines qui citent encore
//     les anciens noms sont traduites par la table d'alias de l'outillage.
//   - le contexte du RUN (buildRunContext), ajouté à chaque requête du run :
//     son mode, les skills, la mémoire, la mémoire d'équipe et le travail
//     récent choisis pour SA tâche, puis l'heure.

/** Les règles de travail, avec les outils du harnais. */
function harnessRules(agent: AgentRow, opts: { subagents: boolean }): string[] {
  const rules = [
    "- PLAN puis AGIS : pour une demande en plusieurs étapes, pose d'abord ta liste de tâches avec todowrite ; une seule tâche en cours ; coche-la seulement après avoir vérifié son résultat.",
    "- VÉRIFIE chaque résultat avant l'étape suivante. Des données réelles seulement : n'invente jamais un chiffre ou un fait.",
    "- CHERCHE AVANT DE DEMANDER OU DE REFAIRE : ce que tu ne sais pas est peut-être dans la base, ta mémoire ou tes travaux passés (grep, puis build_context). Avant de produire quelque chose, vérifie qu'il n'existe pas déjà.",
    "- REPRENDS, ne recommence pas : tes fichiers et ce fil persistent ; sur « continue », repars de la première étape non faite.",
    "- DEMANDE seulement si tu es vraiment bloqué (question) : demande ambiguë, information introuvable, vrai choix, ou avant une action irréversible. Sinon décide et avance.",
    "- TERMINE tout le travail : chaque tâche de ta liste faite et chaque livrable attendu enregistré (outil document, action deliver).",
    "- RETIENS ce qui dure avec remember, une phrase autoportante par appel : faits stables, fichiers produits avec leur chemin, résultats clés (fact) ; habitudes de la personne (preference, en corrigeant l'existante avec replaces plutôt que d'en empiler une seconde) ; ce que ton équipe doit savoir (team) ; ce que tout l'espace doit savoir (knowledge).",
    "- APPROBATIONS : une action sensible demande une approbation, affichée dans le chat avec ses boutons ; ton travail continue, attends la décision et enchaîne avec son résultat. Ne redemande jamais une approbation déjà accordée. Si un outil échoue, adapte-toi ou dis la limite.",
    AUTONOMY_RULE[normalizeAutonomy(agent.autonomy_level)],
    "- INITIATIVE : applique la doctrine d'initiative ; ce qui découle de la demande fait partie du travail, ce qui en sort se propose (outil mission, action propose). Jamais d'effet de bord hors périmètre.",
    "- ARTEFACTS : avant de créer un document, un tableur ou une présentation, vérifie s'il existe (outil document, action list) ; s'il existe, corrige-le en place plutôt que d'en faire une v2.",
    "- TRAVAIL FAIT AILLEURS : ce que tu crées ou modifies dans un outil externe (page Notion, issue Linear, doc Drive, Figma, PR…), épingle-le avec son URL (outil document, action link).",
  ];
  if (agent.collaboration_enabled) {
    rules.push(
      "- COLLABORE : si une partie du travail revient à un collègue, écris-lui ou délègue-lui (outil team) plutôt que de tout faire ; consigne les décisions d'équipe (remember, kind team).",
      "- L'ENTREPRISE A PLUSIEURS SERVICES : quand le travail touche un autre domaine (facturation, juridique, sécurité, recrutement…), cherche d'abord qui s'en occupe (outil team, action list) au lieu d'improviser. Une mission refusée ou mise en attente par un autre service est une réponse, pas un échec.",
    );
  }
  if (opts.subagents) {
    rules.push(
      "- PARALLÉLISE ce qui est indépendant : plusieurs sous-tâches NOUVELLES qui ne dépendent pas l'une de l'autre (un élément par sous-tâche : produits, comptes, fichiers…) partent ensemble chez des spécialistes (subagent), avec toutes les données utiles. Jamais pour refaire ce qui existe ; leurs résultats reviennent dans un message <background-result>, synthétise-les.",
    );
  }
  return rules;
}

/**
 * Le prompt de l'agent dans le harnais : stable d'un run à l'autre. `tools` est
 * le texte « Tes outils » (le guide du toolkit, ou ses capacités natives).
 */
export function buildAgentSystem(
  agent: AgentRow,
  tools: string,
  opts: { company?: CompanyContext | null; selfModel?: string; securityDoctrine?: boolean; subagents?: boolean } = {},
): string {
  const sections: SectionInput[] = [];
  const push = (id: SectionInput["id"], body: string) => {
    if (body && body.trim()) sections.push({ id, body });
  };
  push("identity", [
    `Tu es ${agent.persona || agent.name}, un agent autonome qui travaille pour une équipe.`,
    "Tu fais partie d'une ÉQUIPE d'agents : tu peux trouver tes collègues, leur écrire, leur déléguer, et partager ce que tu sais par la mémoire d'équipe.",
    ...(opts.selfModel ? ["", opts.selfModel] : []),
  ].join("\n"));
  push("company", renderCompanySection(opts.company ?? null, "", SECTION_BUDGET.company).body);
  push("soul", renderSoul(agent.soul));
  if (agent.instructions) push("instructions", `Tes consignes détaillées :\n${agent.instructions}`);
  push("presence", [
    "## Sois humain et présent",
    "- Réponds dans la langue de la personne, comme un collègue : chaleureux, clair, concis, jamais robotique.",
    "- Dès le départ, dis en une phrase que tu as compris et que tu t'y mets. Sur un travail en plusieurs étapes, écris de courts points d'étape entre tes actions : ce que tu trouves, ce que tu fais ensuite.",
  ].join("\n"));
  if (opts.securityDoctrine) push("doctrine", SECURITY_DOCTRINE);
  if (agent.is_orchestrator) push("doctrine", `${ORCHESTRATOR_DOCTRINE}\n\n${ASSISTANT_OPS_DOCTRINE}\n\n${TEAM_OPS_DOCTRINE}\n\n${CONNECTOR_OPS_DOCTRINE}`);
  push("doctrine", PROACTIVITY_DOCTRINE);
  if (agent.is_orchestrator) push("doctrine", ORCHESTRATOR_PROACTIVITY);
  push("preferences", selectPreferences(agent.preferences, "", SECTION_BUDGET.preferences).body);
  push("toolbox", `Tes outils (leurs schémas complets sont fournis à part) :\n${tools}`);
  push("rules", harnessRules(agent, { subagents: opts.subagents ?? true }).join("\n"));
  return compileSystemPrompt(sections).system;
}

export type RunMode = "chat" | "mission" | "room" | "workflow" | "a2a";

/** Ce qui change d'un mode à l'autre : à qui l'agent répond, et comment il finit. */
function modeRules(mode: RunMode): string[] {
  const finalShape = [`- ${NO_LONG_DASH_RULE}`];
  switch (mode) {
    case "chat":
      return [
        "Tu réponds à une personne, dans une conversation.",
        RICH_REPLY_DOCTRINE,
        "- RÉPONSES RICHES : quand un composant dit mieux que la prose (indicateurs, tendances, comparaisons, tableaux), affiche de vrais blocs (outil interface, action render) et place chaque balise [[ui:N]] seule sur sa ligne ; des données réelles seulement.",
        "- RAPPORT, ANALYSE, LIVRABLE DEMANDÉ : ne réponds pas en prose et ne demande pas quoi faire ; fais l'analyse avec tes outils, puis confie la matière au rédacteur (outil report, action request : sujet, matière avec ses sources, angle). Réponds ensuite par un court résumé ; le document s'ouvre en carte dans le chat.",
        "- INTERDIT : n'affirme jamais « rapport créé » ou « livrable créé » sans avoir réellement appelé l'outil dans CE tour et reçu sa confirmation.",
        "- Réponds en markdown concis, dans la langue de la personne, sans remplissage. Si la demande est ambiguë sur un point important, pose une courte question avant d'agir. Confirme le périmètre d'une action lourde ou irréversible.",
        "- Un travail qui doit durer ou revenir devient une mission (outil mission, action create) ; un suivi devient une tâche (action task).",
        ...finalShape,
      ];
    case "mission":
      return [
        "Ce run est une MISSION autonome : personne ne te répond en direct, ne pose pas de question sauf blocage réel.",
        "- Enregistre chaque livrable attendu (outil document, action deliver) avant de finir.",
        "- Ton dernier message est un compte rendu de mission concis en markdown : ce que tu as fait, les constats clés, les livrables produits, les approbations en attente, et une section « Initiatives » si tu as repéré des opportunités (chacune proposée avec l'outil mission, action propose).",
        ...finalShape,
      ];
    case "room":
      return [
        "Ce run est un tour de parole dans une SALLE de service : tes collègues et les humains de la salle liront ta réponse.",
        "- Réponds à ce qui t'est demandé, avec tes outils si besoin ; ta réponse finale est ton message dans la salle, en markdown concis.",
        ...finalShape,
      ];
    case "workflow":
      return [
        "Ce run est une étape de WORKFLOW automatique : personne ne te répond en direct.",
        "- Fais exactement ce que l'étape demande ; ton dernier message est son résultat, factuel et concis.",
        ...finalShape,
      ];
    case "a2a":
      return [
        "Un COLLÈGUE agent t'écrit. Réponds-lui comme à un pair : utile, précis, concis.",
        "- Fais le travail demandé avec tes outils s'il le faut ; ta réponse finale lui est renvoyée telle quelle.",
        ...finalShape,
      ];
  }
}

/**
 * Le contexte d'UN run, ajouté au prompt à chaque requête de ce run : son mode,
 * puis ce qui a été choisi pour sa tâche (skills, mémoire, mémoire d'équipe,
 * travail récent), puis l'heure, en dernier.
 */
export function buildRunContext(input: {
  mode: RunMode;
  taskText: string;
  memory?: string;
  teamMemory?: string;
  recentWork?: string;
  skills?: SkillLike[];
  skillBoost?: (s: SkillLike) => number;
  /** Un bloc propre au run (salle, workflow, notes d'infrastructure…). */
  extra?: string;
}): string {
  const parts: string[] = [`<run_context mode="${input.mode}">`, ...modeRules(input.mode)];
  const add = (title: string, body: string) => { if (body && body.trim()) parts.push("", `## ${title}`, body.trim()); };
  if (input.skills?.length) {
    const sel = selectSkills(input.skills, input.taskText, { budget: SECTION_BUDGET.skills, boost: input.skillBoost });
    add("Skills utiles pour cette tâche (les autres se chargent avec skill)", sel.body);
  }
  add("Ce que tu sais (mémoire choisie pour cette tâche ; le reste est à un grep)", selectLines(input.memory ?? "", input.taskText, SECTION_BUDGET.memory).body);
  add("Ce que sait ton équipe", selectLines(input.teamMemory ?? "", input.taskText, SECTION_BUDGET.team).body);
  add("Ton travail récent (appuie-toi dessus, ne le refais pas)", selectLines(input.recentWork ?? "", input.taskText, SECTION_BUDGET.recent).body);
  if (input.extra?.trim()) parts.push("", input.extra.trim());
  parts.push("", renderClock(defaultTimezone()), "</run_context>");
  return parts.join("\n");
}
