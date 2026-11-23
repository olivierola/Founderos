// Ce qu'un run d'agent assemble avant de travailler : la ligne de l'agent, son
// point d'accès au modèle, ses outils (contexte d'outils, pools, skills, MCP,
// machine, dashboards, Composio) et l'état de ses mondes d'exécution.
// Sorti de l'ancien moteur (internal-agent-run), sans sa boucle.

import { Deno } from "../compat/index.ts";
import { createServiceClient } from "../edge/_shared/supabase-admin.ts";
import { decryptSecret } from "../edge/_shared/crypto.ts";
import { loadAgentDashboards } from "../edge/_shared/agent-dashboards.ts";
import { writeReport } from "../edge/_shared/reporter.ts";
import { normalizeAutonomy } from "../edge/_shared/policyguard.ts";
import { modelForTier, resolveProvider, modelForRequest, type Provider, type ModelNeed } from "../edge/_shared/model-router.ts";
import { parseModelRoutes, pinnedUpstream, upstreamRoutes, type ModelRoutes } from "../edge/_shared/llm-upstream.ts";
import { imageTargetFromEndpoint } from "../edge/_shared/image-gen.ts";
import { freeRoutes } from "../edge/_shared/openrouter-catalog.ts";
import { estimateCostUsd } from "../edge/_shared/llm-pricing.ts";
import {
  buildInternalToolset, loadCustomConnectorSnapshots, type AgentToolRow, type InternalToolContext,
} from "../edge/_shared/internal-agent-tools.ts";
import { applyPoolToToolRows, loadPoolScope } from "../edge/_shared/resource-pools.ts";
import { loadAgentMachine } from "../edge/_shared/team-machine.ts";
import { loadRunMcpServers } from "../edge/_shared/mcp-servers.ts";
import { insertArtifact, generateArtifactImage, isDocKind } from "../edge/_shared/artifact-content.ts";


export interface AgentRow {
  id: string;
  name: string;
  persona: string | null;
  instructions: string | null;
  /** The three files (0210): instructions above, plus who it IS and what its
   *  user prefers. `preferences` is the one the agent writes to itself. */
  soul?: string | null;
  preferences?: string | null;
  created_by?: string | null;
  service_dashboard_id?: string | null;
  is_orchestrator?: boolean;
  /** What it may do alone (0266) — observer / propose / assisted / autonomous. */
  autonomy_level?: string | null;
  model: string;
  temperature: number;
  max_steps: number;
  max_run_cost_usd: number;
  workspace_id: string;
  project_id: string;
  is_archived: boolean;
  collaboration_enabled: boolean;
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
  /** Ses modèles sur la connexion par défaut, par palier et critère (0303). */
  model_routes?: Record<string, unknown> | null;
}

/** Resolve the OpenAI-compatible endpoint an agent runs on, or undefined for the
 *  Anduran default. Provider-aware: a company-registered cloud/custom model
 *  (aiops_providers) carries its own base_url + encrypted key (decrypted here,
 *  never sent to the browser); a RunPod server uses the platform vLLM key. */
export async function resolveAgentEndpoint(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
): Promise<{ baseUrl: string; apiKey?: string; model?: string; routes?: ModelRoutes } | undefined> {
  // 1) A registered cloud/custom model (Modèles tab).
  if (agent.hosted_provider_id) {
    const { data: p } = await admin
      .from("aiops_providers")
      .select("config, secret_ciphertext, secret_iv")
      .eq("id", agent.hosted_provider_id).maybeSingle();
    const config = (p?.config ?? {}) as { base_url?: string; model_routes?: unknown };
    const baseUrl = String(config.base_url ?? "");
    if (baseUrl) {
      let apiKey = "";
      if (p?.secret_ciphertext && p?.secret_iv) {
        try { apiKey = await decryptSecret(p.secret_ciphertext as string, p.secret_iv as string); } catch { /* key unresolved → call will fail loudly */ }
      }
      // Les modèles du connecteur par palier et par critère (AI Ops →
      // Modèles) : une requête qui demande `@code|heavy` y trouve le sien. Le
      // modèle choisi pour l'agent reste le repli — et la route « standard »
      // s'il n'en a pas d'autre.
      // Les modèles par tâche propres à CET agent (internal_agents.model_routes)
      // passent par-dessus ceux du connecteur : « Lourd : Claude Opus » pour un
      // seul agent, sans changer les autres agents du même connecteur.
      const routes = { ...parseModelRoutes(config.model_routes), ...parseModelRoutes(agent.model_routes ?? {}) };
      const model = agent.hosted_model || routes.standard || undefined;
      return { baseUrl, apiKey, model, routes: Object.keys(routes).length ? routes : undefined };
    }
  }
  // 2) A self-hosted RunPod GPU server (legacy path, platform vLLM key).
  if (agent.hosted_endpoint_url) {
    return { baseUrl: agent.hosted_endpoint_url, apiKey: Deno.env.get("RUNPOD_VLLM_API_KEY") ?? "", model: agent.hosted_model || undefined };
  }
  // 3) La connexion par défaut (OpenRouter…) avec les modèles propres à cet
  // agent (0303) : ses routes par-dessus celles de la plateforme. La clé reste
  // celle du backend (llmAuthHeaders la pose pour l'URL de la passerelle).
  return platformEndpointForAgent(agent);
}

/** L'agent sur la connexion par défaut, quand il a choisi ses modèles. */
export function platformEndpointForAgent(agent: AgentRow): { baseUrl: string; model?: string; routes?: ModelRoutes } | undefined {
  let agentRoutes = parseModelRoutes(agent.model_routes ?? {});
  if (!Object.keys(agentRoutes).length) return undefined;
  let up: ReturnType<typeof pinnedUpstream> = null;
  try { up = pinnedUpstream(); } catch { return undefined; }
  if (!up) return undefined;
  // Compte gratuit : un modèle payant choisi avant le passage en gratuit
  // retombe sur le modèle gratuit du palier.
  if (up.kind === "openrouter") agentRoutes = freeRoutes(agentRoutes);
  const routes = { ...upstreamRoutes(up), ...agentRoutes };
  return { baseUrl: up.baseUrl, model: routes.standard ?? up.model, routes };
}

// Rough per-1k-token rates (USD). Adjust as providers change pricing. These are
// the legacy provider-level rates; the shared llm-pricing table now drives cost
// whenever a model id is available (which also covers self-hosted endpoints).
export const RATES: Record<string, { in: number; out: number }> = {
  groq: { in: 0.00005, out: 0.0001 },
  deepseek: { in: 0.00014, out: 0.00028 },
};

export function estimateCost(
  usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number; reported_cost_usd?: number; unpriced_calls?: number } | undefined,
  provider: "groq" | "deepseek",
  model?: string,
  custom?: boolean,
): number {
  if (!usage) return 0;
  // Le prix facturé par le fournisseur (Runware le donne), quand il l'a donné
  // pour chaque appel : plus juste qu'une table de tarifs pour des modèles
  // dont le prix change d'un éditeur à l'autre.
  if (usage.unpriced_calls === 0 && (usage.reported_cost_usd ?? 0) > 0) return usage.reported_cost_usd!;
  if (model) return estimateCostUsd(model, usage.prompt_tokens, usage.completion_tokens, { custom, cachedTokens: usage.cached_tokens });
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
export function providerFor(agent: AgentRow): Provider {
  return resolveProvider(agent.model);
}

/** The tier→model resolution for THIS agent's provider. Never let a provider
 *  and a model id from different vendors meet. */
export function agentModelForTier(agent: AgentRow, tier: Parameters<typeof modelForTier>[0]): string {
  return modelForTier(tier, providerFor(agent));
}

/**
 * Le modèle d'une requête pour CET agent : son palier et son critère (code,
 * vision, long contexte). Quand quelque chose sait traduire une route — la
 * passerelle imposée (Runware, OpenRouter…) ou le connecteur de l'agent avec
 * ses modèles par tâche (AI Ops → Modèles) — c'est un alias `@code|heavy` ;
 * sinon le modèle de palier du fournisseur, comme avant.
 */
export function agentModelForRequest(agent: AgentRow, tier: Parameters<typeof modelForTier>[0], need: ModelNeed | null): string {
  let routed = !!agent.hosted_provider_id || !!agent.hosted_endpoint_url;
  if (!routed) { try { routed = !!pinnedUpstream(); } catch { routed = false; } }
  return modelForRequest(tier, need, { provider: providerFor(agent), routed });
}

/**
 * A provider-level failure (bad key, unknown model, provider outage) as opposed
 * to a normal API error. These are the only ones worth retrying on the OTHER
 * provider — a 429 or a malformed request would fail identically there.
 */
export function isProviderFailure(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /\b(401|403|404)\b|api[_ ]?key|unauthor|invalid.*model|model.*not.*(found|exist)|does not exist|decommission|deprecated/i.test(msg);
}

/** Les toolkits connectés via Composio pour cet agent : partagés (sans
 *  propriétaire), sur son tableau ou sur le projet. Une panne vaut « aucun ». */
export async function loadComposioApps(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
): Promise<string[]> {
  try {
    const { data } = await admin.from("connectors")
      .select("provider, service_dashboard_id")
      .eq("workspace_id", agent.workspace_id).eq("project_id", agent.project_id)
      .eq("source", "composio").eq("status", "connected")
      .is("owner_user_id", null);
    const dash = (agent as { service_dashboard_id?: string | null }).service_dashboard_id ?? null;
    return [...new Set(((data ?? []) as Array<{ provider: string; service_dashboard_id: string | null }>)
      .filter((c) => !c.service_dashboard_id || c.service_dashboard_id === dash)
      .map((c) => c.provider).filter(Boolean))];
  } catch {
    return [];
  }
}

export async function loadAgentAndTools(agentId: string) {
  const admin = createServiceClient();
  const [{ data: agent, error: agentErr }, { data: tools }] = await Promise.all([
    admin
      .from("internal_agents")
      .select("id, name, persona, instructions, soul, preferences, model, temperature, max_steps, max_run_cost_usd, workspace_id, project_id, is_archived, collaboration_enabled, swarm_enabled, swarm_max_concurrency, hosted_endpoint_url, hosted_model, hosted_provider_id, model_routes, created_by, service_dashboard_id, is_orchestrator, autonomy_level")
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
  // Mode pools (0291) : l'agent n'atteint que l'union de ses pools — ses lignes
  // hors pools tombent, ce que les pools donnent sans ligne est synthétisé.
  const scope = await loadPoolScope(admin, agentId);
  const rows = (tools ?? []) as AgentToolRow[];
  return { agent: agent as AgentRow, tools: scope ? applyPoolToToolRows(rows, scope) as AgentToolRow[] : rows };
}

/**
 * Le jeu d'outils complet d'un agent, monté comme le fait un tick : le contexte
 * d'outils (skills, MCP, outils internes, pools, dashboards, machine, Composio,
 * image) puis buildInternalToolset. Exporté pour le harnais OpenCode du backend
 * local, qui expose ces handlers derrière ses outils regroupés par lot.
 */
export async function prepareAgentToolset(agentId: string, opts: {
  runId: string | null;
  conversationId?: string | null;
  actingUserId?: string | null;
}) {
  const admin = createServiceClient();
  const { agent, tools } = await loadAgentAndTools(agentId);
  const [agentEndpoint, skills, mcpServers, customConnectors, poolScope, dashboards, machine, composioApps] = await Promise.all([
    resolveAgentEndpoint(admin, agent).catch(() => undefined),
    loadActivatedSkills(admin, agent.id),
    loadRunMcpServers(admin, agent.id, opts.runId).catch(() => []),
    loadCustomConnectorSnapshots(admin, {
      agentId: agent.id, projectId: agent.project_id, serviceDashboardId: agent.service_dashboard_id ?? null,
    }).catch(() => []),
    loadPoolScope(admin, agent.id),
    loadAgentDashboards(admin, agent.id).catch(() => []),
    loadAgentMachine(admin, agent).catch(() => null),
    loadComposioApps(admin, agent).catch(() => []),
  ]);
  const ctx = makeToolContext({
    admin, agent, runId: opts.runId, missionId: null, conversationId: opts.conversationId ?? null, delegationDepth: 0,
  });
  ctx.skills = skills;
  ctx.mcpServers = mcpServers;
  ctx.customConnectors = customConnectors;
  ctx.poolScope = poolScope;
  ctx.dashboards = dashboards;
  ctx.teamMachine = machine;
  ctx.composioApps = composioApps;
  ctx.actingUserId = opts.actingUserId ?? null;
  ctx.imageTarget = agentEndpoint?.routes?.image
    ? imageTargetFromEndpoint(agentEndpoint.baseUrl, agentEndpoint.apiKey, agentEndpoint.routes.image)
    : null;
  // Le harnais OpenCode a ses propres sous-agents : pas d'essaim de clones ici.
  ctx.swarmEnabled = false;
  const toolset = buildInternalToolset(tools, ctx);
  return { agent, rows: tools, ctx, skills, ...toolset };
}

// Load the skills activated for this agent (full fields). Their playbooks are
// NOT injected up-front — only an index goes in the prompt; the agent pulls a
// skill's full instructions on demand via use_skill (progressive disclosure).
export async function loadActivatedSkills(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
): Promise<Array<{ id: string; slug: string; name: string; description: string | null; category: string | null; instructions: string | null; tools: string[] | null; files: Array<{ path: string }> }>> {
  // Embed the bundled files' PATHS only (an index) — their content is pulled on
  // demand via read_skill_file (progressive disclosure), never up-front.
  const cols = "id, slug, name, description, category, system_prompt_extension, required_tools, files:agent_skill_files(path, sort)";
  // Mode pools (0291) : les compétences sont celles des pools, pas les activations.
  const scope = await loadPoolScope(admin, agentId);
  const skills = scope
    ? (scope.skills.size
        ? ((await admin.from("agent_skills").select(cols).in("id", [...scope.skills])).data ?? []) as any[]
        : [])
    : ((await admin.from("agent_skill_activations").select(`skill:agent_skills(${cols})`).eq("agent_id", agentId)).data ?? [] as any[])
        .map((a: any) => a.skill);
  return skills
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

// Les serveurs MCP du run : activés sur l'agent, plus ceux accordés au run par
// un workflow (limités aux outils choisis) — voir _shared/mcp-servers.ts.

export function nextRunAt(schedule: string, from: Date): string {
  const d = new Date(from);
  if (schedule === "daily") d.setDate(d.getDate() + 1);
  else if (schedule === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Compagnon navigateur (0271)
// ---------------------------------------------------------------------------
// Une conversation ouverte depuis le panneau latéral du navigateur porte sur la
// page que la personne a sous les yeux. Elle reçoit l'outil page_assist et une
// consigne de forme : le panneau est étroit, et la réponse peut arriver dans
// une bulle si le panneau s'est refermé entre-temps.

export async function isCompanionConversation(
  admin: ReturnType<typeof createServiceClient>,
  conversationId: string | null | undefined,
): Promise<boolean> {
  if (!conversationId) return false;
  const { data } = await admin.from("internal_agent_conversations")
    .select("origin").eq("id", conversationId).maybeSingle();
  return (data as { origin?: string | null } | null)?.origin === "companion";
}

export const COMPANION_NOTE = [
  "",
  "",
  "## Compagnon navigateur",
  "La personne te parle depuis le panneau latéral de son navigateur, à côté de la page qu'elle consulte.",
  "- Les blocs <page_context>, <selection_context> et <element_context> joints à ses messages sont ce qu'elle a sous les yeux : c'est ton matériau principal. Réponds à partir d'eux et cite-les ; n'invente rien qui n'y est pas.",
  "- Un bloc collapsed=\"true\" ou unchanged=\"true\" renvoie à la page déjà fournie plus haut dans la conversation.",
  "- Pour attirer son attention sur un passage, un chiffre ou un bouton de SA page, surligne-le avec page_assist action=\"highlight\" (extrait exact du texte, ou libellé visible) au lieu de décrire où regarder.",
  "- Le panneau est étroit : va à l'essentiel, phrases courtes, listes brèves. Si le panneau est fermé, ta réponse lui arrive dans une bulle : mets la conclusion dans la première phrase.",
].join("\n");

export const CONTEXT_BLOCK_RE = /<page_context\b([^>]*)>([\s\S]*?)<\/page_context>/g;

/**
 * Une page jointe pèse jusqu'à ~6 000 tokens, et l'historique d'une conversation
 * en garde trente messages. Renvoyer chaque version de chaque page à chaque
 * tour noierait le modèle et la facture : seule la DERNIÈRE page complète reste
 * entière, les précédentes deviennent une ligne qui dit ce qu'elles étaient.
 */
export function collapseStalePageContexts<T extends { role: string; content: string | null }>(history: T[]): T[] {
  let keep = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user" || !m.content) continue;
    const full = [...m.content.matchAll(CONTEXT_BLOCK_RE)].some((x) => !/\b(unchanged|collapsed)="true"/.test(x[1]));
    if (full) { keep = i; break; }
  }
  return history.map((m, i) => {
    if (i === keep || m.role !== "user" || !m.content || !m.content.includes("<page_context")) return m;
    const content = m.content.replace(CONTEXT_BLOCK_RE, (whole, attrs: string, body: string) =>
      /\b(unchanged|collapsed)="true"/.test(attrs)
        ? whole
        : `<page_context${attrs} collapsed="true">[page jointe à ce moment-là (${body.length} caractères), remplacée par une version plus récente ; page_assist look pour la relire]</page_context>`);
    return { ...m, content };
  });
}

export function makeToolContext(opts: {
  admin: ReturnType<typeof createServiceClient>;
  agent: AgentRow;
  runId: string | null;
  missionId: string | null;
  conversationId?: string | null;
  delegationDepth?: number;
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
    // Autopilot stays off for collaborators: what they may do alone is their
    // autonomy level (0266), applied by PolicyGuard with Jev's risk judgement —
    // never a blanket dispensation.
    autopilot: false,
    autonomy: normalizeAutonomy(agent.autonomy_level),
    runId,
    conversationId: opts.conversationId ?? null,
    missionMode: opts.missionId != null,
    delegationDepth: opts.delegationDepth ?? 0,
    // Essaim: default ON (preserves the always-available behaviour); the tool
    // is simply not registered when the owner turned it off.
    swarmEnabled: agent.swarm_enabled !== false,
    serviceDashboardId: agent.service_dashboard_id ?? null,
    userId: agent.created_by ?? null,
    // The service's assistant gets the administration tools (assistant-ops).
    isOrchestrator: agent.is_orchestrator === true,
    // Reports are written by Le Rédacteur (0206): this agent hands over the
    // matter and gets back a published document. Injected HERE, in the one place
    // every path builds a context, so the toolbox the system prompt advertises
    // (built in initChatRun / runMission) and the toolbox the tick actually
    // executes can never disagree about who writes reports.
    //
    // Also injected when this agent IS the Rédacteur: his authoring pass has no
    // delegation tool of its own, so a self-request writes rather than recurses.
    requestReport: async (brief) => (await writeReport({
      admin,
      workspaceId: agent.workspace_id,
      projectId: agent.project_id,
      parentRunId: runId,
      missionId: missionId ?? null,
      conversationId: opts.conversationId ?? null,
      requesterAgentId: agent.id,
      requesterName: agent.name,
      createdBy: agent.created_by ?? null,
      parentLogEvent: (kind, payload) => writeEvent(kind as "status" | "ui", payload),
    }, brief)).message,
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
          ...(r.requested_by !== undefined ? { requested_by: r.requested_by } : {}),
          ...(r.expires_at ? { expires_at: r.expires_at } : {}),
          ...(r.policy ?? {}),
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
