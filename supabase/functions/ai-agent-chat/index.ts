// ai-agent-chat — contextual chat with the SaaS Cockpit agent.
// Body: { workspace_id, project_id, conversation_id?, message }
// - Creates conversation if missing, persists user message, builds context,
//   calls Groq, persists assistant message, returns full message + conversation id.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, callAiWithTools, safeParseJson, type AiTask, type ChatMessage } from "../_shared/ai.ts";
import { sanitizeModel } from "../_shared/model-router.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";
import {
  type WorkspaceRole, type EmittedArtifact, type ToolContext,
  toolDefsForRole, accessScopeSummary, buildExecutor,
} from "../_shared/assistant-tools.ts";

const BASE_SYSTEM_PROMPT = `Tu es l'assistant interne de Anduran, une plateforme pour fondateurs et équipes SaaS.
Tu agis comme un collaborateur capable d'exécuter des tâches : analyser des données, rédiger des documents, produire des tableaux, du JSON, du code.

Règles:
- Utilise les OUTILS à ta disposition pour répondre. Ne devine jamais des chiffres : si une donnée est nécessaire, appelle l'outil correspondant.
- Quand l'utilisateur demande un livrable (document, rapport, tableau, JSON, code), utilise l'outil de création correspondant (create_document, create_table, create_json, create_code). Le livrable s'affiche comme un artefact téléchargeable — ne recopie pas son contenu intégral dans la réponse, résume-le brièvement.
- Ne réalise jamais d'action irréversible sans validation explicite de l'utilisateur.
- Réponds en markdown concis et actionnable, dans la langue de l'utilisateur.
- FORMAT OBLIGATOIRE: structure toujours ta réponse en markdown propre. Quand tu listes des options, des étapes ou des actions, utilise une VRAIE liste markdown (chaque item sur sa propre ligne commençant par "- "), JAMAIS un paragraphe avec des libellés en gras collés les uns aux autres. Sépare les paragraphes par une ligne vide. Utilise des titres "###" pour les sections, du gras pour les libellés d'item ("- **Action** — description"). Reste bref.
- Respecte strictement ton périmètre d'accès décrit ci-dessous.
- Si un snapshot de la page actuelle de l'utilisateur est fourni, traite-le comme contexte PREMIER : réponds d'abord par rapport à ce qu'il voit à l'écran (chiffres, tableaux, sections visibles) avant de chercher ailleurs.

CONFIGURATION DES AGENTS (tu es LE point de configuration — il n'y a pas de formulaire à conseiller):
Configurer un agent porte sur TROIS choses, et rien d'autre: son PROMPT SYSTÈME (ce qu'on lui demande de faire), ses CONNECTEURS (ce sur quoi il peut agir) et ses SKILLS (comment il travaille). Le reste (modèle, autonomie, identité, sandbox) a une valeur par défaut qui marche : n'en parle QUE si l'utilisateur le demande explicitement, ne le propose jamais de toi-même.
L'utilisateur voit ces trois cartes dans ce panneau ; il clique "Configurer" sur l'une d'elles et cela ouvre une conversation sur CETTE étape. Mène-la à son terme sans déborder sur les autres.
  1) get_agent_setup (l'agent_id est dans le message) — ne devine JAMAIS un id d'outil, de connexion ou de skill.
  2) Lis ce qui concerne l'étape : "profile.instructions_excerpt" (prompt système), "tools" + "options.connectors" (connecteurs réellement connectés dans ce projet, avec leur statut), "skills.active". Si aucune connexion utile n'existe, dis-le et propose de la créer dans l'onglet Connecteurs — n'invente pas de provider.
  3) Propose du CONCRET et court, une seule question à la fois ("Je rattache Slack — je valide ?"). Pour le prompt système, montre le texte proposé avant de l'écrire.
  4) Après accord, écris : update_agent_profile (instructions), configure_agent_tool / add_agent_tool avec kind 'connector_action' ou 'composio_toolkit' (connecteurs), search_agent_skills puis set_agent_skills (skills).
  5) Termine par l'état de CETTE carte : ce qui est prêt, ce qui reste.

AUTOMATISER UN TRAVAIL (WORKFLOWS) — TU CONSTRUIS, TU NE DÉCRIS PAS:
Quand l'utilisateur veut qu'un travail se répète tout seul ("chaque matin…", "à chaque nouveau lead…", "automatise…"), tu CONSTRUIS un workflow avec les outils workflow_*. Un récapitulatif en markdown, un document ou un artefact ne créent RIEN : le workflow n'existe que s'il a été construit par ces appels.
  0) Si l'utilisateur parle d'un workflow DÉJÀ ouvert devant lui (le snapshot de page le nomme), commence par workflow_list pour récupérer son id et construis DEDANS. Créer un doublon à côté du sien est le pire résultat possible.
  1) Sinon workflow_create (nom, déclencheur, cron si planifié) — rend l'id à réutiliser.
  2) workflow_add_block, un appel par bloc, dans l'ordre de lecture : l'objectif, puis les étapes. Chaque appel te rend l'état du graphe ET ce qui reste à corriger — lis-le.
  3) Le CADRAGE se rattache : un contexte, une règle, un outil imposé, un livrable se posent avec attach_to sur l'action qu'ils concernent, et ne valent que pour elle. Un même contexte peut être attaché à plusieurs étapes (workflow_link, mode="attach").
  4) Une décision a DEUX suites : ajoute les blocs des deux branches avec branch="true" et branch="false", sinon la procédure s'arrête là.
  5) workflow_activate EN DERNIER. Tant qu'il n'a pas réussi, ne dis jamais que le workflow est prêt, en place, ou qu'il ne reste plus qu'à l'activer.
Pose au plus UNE question de clarification si un réglage est vraiment indécidable (l'heure, le nombre d'éléments) ; pour le reste, choisis un défaut raisonnable, construis, et dis ce que tu as choisi.

INSTRUMENTATION DU CODE & ANALYTICS AVANCÉE:
Tu peux instrumenter le dépôt GitHub connecté du projet : poser du tracking d'events, du feature flagging, installer les SDK Anduran (analytics & RAG), et définir une analytics avancée à partir d'une description en langage naturel.
- Tu ne MODIFIES JAMAIS le dépôt directement. Chaque outil d'écriture (propose_code_changes, instrument_event, add_feature_flag, install_sdk) crée une proposition EN ATTENTE qu'un owner/admin doit approuver ; l'application réelle (Pull Request par défaut, ou commit direct si demandé) se fait après approbation. Annonce toujours clairement qu'une approbation humaine est requise.

FLUX OBLIGATOIRE POUR INSTALLER LE SDK / BALISER (NE JAMAIS SAUTER D'ÉTAPE):
  1) ANALYSER d'abord: appelle analyze_repo_structure. Il renvoie la stack, les services, les pages/routes/éléments, si le SDK est installé, ET surtout: defined_events (la taxonomie d'events que l'utilisateur a saisie dans l'UI Anduran) + defined_feature_flags (les flags définis dans l'UI). (Tu peux aussi appeler list_event_definitions / list_feature_flags séparément.) N'installe/ne balise JAMAIS à l'aveugle.
  2) RÉUTILISER L'EXISTANT — RÈGLE CLÉ: tu dois prioritairement instrumenter les defined_events (avec le event_name EXACT et les propriétés déclarées) et gater le code derrière les defined_feature_flags (flag_key EXACT). N'invente un nouvel event/flag (define_custom_event / add_feature_flag) que si rien d'existant ne convient, et explique pourquoi.
  3) LIRE les fichiers cibles: pour CHAQUE page/call-site à instrumenter (entrée d'app, login/auth, signup, checkout/paiement, onboarding, actions métier, et chaque page concernée par un flag), lis-le avec read_repo_file (list_repo_files pour localiser). Comprends le code réel avant de le modifier. Tu peux toucher le code en PROFONDEUR si nécessaire (créer des hooks/wrappers, modifier le routing, envelopper des composants), tant que chaque "change" contient le CONTENU COMPLET du fichier.
  4) SDK + IDENTIFY + FLAGS: si le SDK n'est pas présent, propose install_sdk (contenu réel injecté par le serveur). L'init navigateur active déjà l'auto-capture (page_view + clics [data-fos-event]) et charge les flags (analytics.loadFlags()). Ajoute analytics.identify(email) après le login, puis re-appelle analytics.loadFlags() pour l'état par utilisateur.
  5) BALISER PAGE PAR PAGE: pour chaque page pertinente, pose les analytics.track('event_defini', { properties }) (logique métier: succès paiement, fin d'onboarding…) et/ou tague les CTA en JSX data-fos-event="event_defini". Pour le FEATURE FLAGGING page par page: enveloppe/branche le rendu avec if (analytics.isFeatureEnabled("flag_key")) { … } aux bons endroits, en utilisant les flag_key définis. Utilise instrument_event (events) et add_feature_flag (gating) — ou propose_code_changes pour des modifications de fond.
  6) PROPOSER LA/LES PR: regroupe les changements et crée la proposition (PR par défaut). Résume ce que tu as balisé/flaggé, page par page, et quels events/flags définis tu as utilisés.
- Avant de modifier un fichier existant, LIS-LE avec read_repo_file (et localise les bons fichiers avec list_repo_files). Chaque "change" doit contenir le CONTENU COMPLET du nouveau fichier, pas un diff.
- Pour un nouvel event analytics : d'abord define_custom_event (taxonomie + schéma de propriétés + config avancée), puis instrument_event pour poser les appels fos.track(...) au bon endroit. Pour un parcours : define_journey, puis instrument chaque étape.
- Le tracking utilise le SDK Anduran (fos.track('event_name', { properties })). Propose d'abord install_sdk si le SDK n'est pas encore présent.
- SDK — RÈGLE STRICTE: n'INVENTE JAMAIS le contenu d'un SDK, ni une commande "git clone github.com/founderos/sdk", ni une API "founderos.configure(api_key, api_secret)". Ces choses N'EXISTENT PAS. Le vrai SDK est servi par l'outil install_sdk (le contenu réel est injecté côté serveur) : tu choisis seulement sdk ('analytics'|'rag'), runtime ('browser'|'server'), lib_dir et l'expression d'environnement de la clé. L'auth réelle = UNE clé 'fos_' (serveur) OU anon key + workspaceId (navigateur). En JS: import { createClient } from "./founderos"; const analytics = createClient({ host, projectId, apiKey|anonKey }). Pour ajouter des appels track au bon endroit, passe-les dans extra_changes (contenu complet du fichier).
- Si le connecteur GitHub est en lecture seule, explique qu'un admin doit activer l'accès en écriture dans Integrations avant que la proposition puisse être appliquée.`;

// Default system prompt for the folded-in fast_summary utility.
const FAST_SUMMARY_SYSTEM = `Tu es l'agent admin technique d'un SaaS code-aware.
Tu aides un fondateur ou développeur à comprendre son produit, ses métriques, ses coûts, ses risques et ses actions possibles.
Tu peux analyser les données fournies, mais tu ne dois jamais inventer de métriques absentes.
Réponds de manière concise, technique et actionnable.`;

// Lightweight, non-sensitive identity context only. Everything sensitive
// (metrics, scan, finance, alerts) is fetched on demand by role-gated tools.
async function buildContext(projectId: string) {
  const admin = createServiceClient();
  const [{ data: project }, { data: connectors }, { data: repos }] = await Promise.all([
    admin.from("projects").select("id, name, slug, detected_stack").eq("id", projectId).maybeSingle(),
    admin.from("connectors").select("provider, status, permissions").eq("project_id", projectId),
    admin
      .from("repositories")
      .select("full_name, default_branch, updated_at")
      .eq("project_id", projectId)
      .eq("provider", "github")
      .order("updated_at", { ascending: false })
      .limit(5),
  ]);

  const github = (connectors ?? []).find((c) => c.provider === "github");
  return {
    project: project ? { name: project.name, slug: project.slug, stack: (project as any).detected_stack ?? null } : null,
    connectors: (connectors ?? []).map((c) => ({ provider: c.provider, status: c.status })),
    // Repo context for code instrumentation: what the agent can read/write.
    code: {
      github_connected: !!github,
      github_writable: github?.permissions === "write_enabled",
      repositories: (repos ?? []).map((r) => ({ full_name: r.full_name, default_branch: r.default_branch })),
    },
  };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });

    const body = await req.json();

    // ── Folded-in utility (formerly the ai-fast-summary fn): a generic Groq
    //    summary/classification/extraction helper. Auth header still required.
    if (body?.mode === "fast_summary") {
      const task = (body.task ?? "summary") as AiTask;
      const inputStr = typeof body.input === "string" ? body.input : JSON.stringify(body.input ?? "");
      const r = await callAi({
        task,
        systemPrompt: body.system_prompt ?? FAST_SUMMARY_SYSTEM,
        userPrompt: inputStr,
        jsonMode: body.json === true,
        maxTokens: 1200,
        temperature: 0.2,
      });
      await logLlmUsage({
        workspace_id: body.workspace_id ?? null, project_id: body.project_id ?? null,
        provider: r.provider, model: r.model, task, feature: body.feature ?? "fast-summary", usage: r.usage,
      });
      return jsonResponse({
        provider: r.provider, model: r.model, usage: r.usage, content: r.content,
        json: body.json ? safeParseJson(r.content) : null,
      });
    }

    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const { workspace_id, project_id, message, page_context, model } = body as {
      workspace_id?: string;
      project_id?: string;
      conversation_id?: string;
      message?: string;
      page_context?: string;
      /** Model picked in the composer for this turn. */
      model?: string;
    };
    let conversation_id = body.conversation_id as string | undefined;

    if (!workspace_id || !project_id || !message) {
      return jsonResponse({ error: "workspace_id, project_id, message required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership) return jsonResponse({ error: "Not authorized" }, { status: 403 });
    const userRole = (membership.role ?? "viewer") as WorkspaceRole;

    // Ensure conversation
    if (!conversation_id) {
      const { data: newConvo, error } = await admin
        .from("ai_conversations")
        .insert({
          workspace_id,
          project_id,
          user_id: userId,
          title: message.slice(0, 80),
        })
        .select("id")
        .single();
      if (error || !newConvo) {
        return jsonResponse({ error: "Could not create conversation", detail: error?.message }, { status: 500 });
      }
      conversation_id = newConvo.id;
    } else {
      await admin.from("ai_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversation_id);
    }

    // Persist user message
    await admin.from("ai_messages").insert({
      conversation_id,
      role: "user",
      content: message,
    });

    // Load conversation history
    const { data: history } = await admin
      .from("ai_messages")
      .select("role, content")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true })
      .limit(30);

    // Build a light project context (only metrics the user is allowed to see is
    // enforced by the tools; this context is non-sensitive identity info).
    const context = await buildContext(project_id);

    // Optional snapshot of the page the user is looking at — the assistant uses
    // it as primary context to answer about what's on screen.
    const pageSection = typeof page_context === "string" && page_context.trim()
      ? `\n\n--- PAGE ACTUELLE DE L'UTILISATEUR (contexte premier — ce qu'il regarde à l'écran) ---\n${page_context.slice(0, 6000)}`
      : "";

    // The workflow the user is LOOKING AT, extracted here rather than left to
    // the model to read off a URL.
    //
    // The snapshot already carried the path — /…/service/<id>/workflows/<id> —
    // and the model ignored it: asked to automate something while an empty
    // workflow was open in front of them, it built a brand-new one under a name
    // of its own and reported success. The user was watching the page it had
    // not touched. A path is not a hint you can leave to interpretation, so the
    // id is pulled out deterministically and the instruction is made explicit.
    const openWorkflow = /\/service\/[0-9a-f-]{8,}\/workflows\/([0-9a-f-]{8,})/i
      .exec(typeof page_context === "string" ? page_context : "")?.[1] ?? null;
    const openWorkflowSection = openWorkflow
      ? `\n\n--- LE WORKFLOW OUVERT DEVANT L'UTILISATEUR ---
Il a le workflow ${openWorkflow} sous les yeux, sur son canvas.
Toute demande d'automatisation porte sur CELUI-CI : appelle les outils workflow_* avec workflow_id="${openWorkflow}".
N'appelle PAS workflow_create — il en existe déjà un, et en créer un second à côté du sien laisse sa page vide pendant que tu annonces un travail fait ailleurs.
S'il te demande explicitement un NOUVEAU workflow, dis-lui d'abord que celui-ci est ouvert et demande confirmation.`
      : "";

    // System prompt = base behaviour + access-scope summary tailored to the role.
    const systemPrompt = `${BASE_SYSTEM_PROMPT}

--- PÉRIMÈTRE D'ACCÈS ---
${accessScopeSummary(userRole)}

--- CONTEXTE PROJET (non sensible) ---
${JSON.stringify({ project: context.project, connectors: context.connectors, code: context.code }, null, 2)}${pageSection}${openWorkflowSection}`;

    // Assemble the message list from history.
    const chatMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...(history ?? []).map((m) => ({
        role: m.role as ChatMessage["role"],
        content: m.content,
      })),
    ];

    // Artifacts collected during the tool loop.
    const artifacts: EmittedArtifact[] = [];
    const toolCtx: ToolContext = {
      admin,
      workspaceId: workspace_id,
      projectId: project_id,
      userId,
      userRole,
      emitArtifact: (a) => artifacts.push(a),
    };

    // DeepSeek handles native tool-calling reliably; Groq/Llama frequently emits
    // malformed tool calls (400 tool_use_failed). Prefer DeepSeek when available,
    // fall back to Groq otherwise — unless the composer pinned a model, whose
    // provider then decides. Banned/unknown ids fall back to the provider's own
    // default rather than reaching the API (see sanitizeModel).
    const pinned = String(model ?? "").trim();
    const pinnedProviderName: "groq" | "deepseek" | null = pinned
      ? (pinned.startsWith("deepseek") ? "deepseek" : "groq")
      : null;
    const hasKey = (p: "groq" | "deepseek") =>
      !!Deno.env.get(p === "groq" ? "GROQ_API_KEY" : "DEEPSEEK_API_KEY");
    const preferred: "groq" | "deepseek" =
      pinnedProviderName && hasKey(pinnedProviderName)
        ? pinnedProviderName
        : (hasKey("deepseek") ? "deepseek" : "groq");
    const pinnedModel = pinnedProviderName === preferred ? sanitizeModel(pinned, preferred) : undefined;
    let aiResult;
    try {
      aiResult = await callAiWithTools({
        provider: preferred,
        model: pinnedModel,
        messages: chatMessages,
        tools: toolDefsForRole(userRole),
        executor: buildExecutor(toolCtx),
        temperature: 0.3,
        maxTokens: 1500,
        // Building a workflow is a SEQUENCE of calls (create → un bloc par
        // appel → activate). At six the loop stopped mid-procedure and the
        // model narrated a workflow it had never finished.
        maxRounds: 16,
      });
    } catch (e) {
      // If the preferred provider fails, retry once on the other provider.
      const fallback = preferred === "deepseek" ? "groq" : "deepseek";
      const fallbackKey = fallback === "groq" ? "GROQ_API_KEY" : "DEEPSEEK_API_KEY";
      if (!Deno.env.get(fallbackKey)) throw e;
      aiResult = await callAiWithTools({
        provider: fallback,
        messages: chatMessages,
        tools: toolDefsForRole(userRole),
        executor: buildExecutor(toolCtx),
        temperature: 0.3,
        maxTokens: 1500,
        // Building a workflow is a SEQUENCE of calls (create → un bloc par
        // appel → activate). At six the loop stopped mid-procedure and the
        // model narrated a workflow it had never finished.
        maxRounds: 16,
      });
    }

    await logLlmUsage({
      workspace_id,
      project_id,
      provider: aiResult.provider,
      model: aiResult.model,
      task: "chat_simple",
      feature: "ai-agent-chat",
      usage: aiResult.usage,
    });

    // The model sometimes returns empty content when it only produced artifacts.
    // ai_messages.content is NOT NULL, so synthesise a short confirmation.
    let finalContent = aiResult.content?.trim() ?? "";
    if (!finalContent) {
      finalContent = artifacts.length
        ? `J'ai préparé ${artifacts.length} livrable${artifacts.length > 1 ? "s" : ""} ci-dessous.`
        : "(réponse vide)";
    }

    const { data: assistantMsg } = await admin
      .from("ai_messages")
      .insert({
        conversation_id,
        role: "assistant",
        content: finalContent,
        metadata: {
          provider: aiResult.provider,
          model: aiResult.model,
          usage: aiResult.usage,
          tool_calls: aiResult.toolCalls.map((t) => t.name),
          artifact_count: artifacts.length,
        },
      })
      .select()
      .single();

    // Persist emitted artifacts attached to this assistant message.
    let savedArtifacts: unknown[] = [];
    if (assistantMsg && artifacts.length > 0) {
      const rows = artifacts.map((a) => ({
        conversation_id,
        message_id: assistantMsg.id,
        workspace_id,
        project_id,
        kind: a.kind,
        title: a.title,
        content: a.content ?? null,
        data: a.data ?? null,
        language: a.language ?? null,
      }));
      const { data: inserted } = await admin.from("ai_artifacts").insert(rows).select();
      savedArtifacts = inserted ?? [];
    }

    return jsonResponse({
      ok: true,
      conversation_id,
      assistant_message: assistantMsg,
      artifacts: savedArtifacts,
    });
  } catch (err) {
    return jsonResponse(
      { error: "ai-agent-chat failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
