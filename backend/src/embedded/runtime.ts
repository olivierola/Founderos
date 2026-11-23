// Le programme d'un conteneur d'agent embarqué (image founderos/agent-runtime).
//
//   1. s'annonce à FounderOS avec sa clé d'API (SDK, /embedded/v1/hello) et reçoit
//      la configuration à jour de son agent ;
//   2. démarre le moteur OpenCode avec le plugin de l'agent FounderOS : son prompt,
//      ses modèles (par la passerelle ou en direct), l'outillage par lots dont les
//      outils de la plateforme et la recherche passent par le SDK ; le shell et les
//      fichiers sont ceux de CE conteneur (/workspace) ;
//   3. bat toutes les 15 s, et exécute les ordres reçus : un tour de chat ou une
//      mission (préparés par FounderOS : contexte du run, consigne), pause, reprise,
//      rechargement de la configuration, arrêt.
//
// Ses runs, sa timeline, ses messages et sa consommation remontent dans les
// tables habituelles par le pont (bridge.ts) branché sur un magasin distant.
// La conduite des runs reste celle de la plateforme (fos.runs) : contrôleur de
// boucle après chaque étape, plafond de dépense, fin de run (contrat, livrables,
// canaux, mission, salle, workflow), questions ; elle rend les gestes que ce
// conteneur applique à sa session.
//
// Variables : FOUNDEROS_URL, FOUNDEROS_API_KEY, INSTANCE_NAME, MANIFEST,
// DATA_DIR (/data), WORKSPACE_DIR (/workspace), LLM_API_KEY (accès direct).

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Les modules du backend lisent leur environnement au chargement : ici, rien ne
// passe par une base, tout passe par la passerelle.
process.env.SUPABASE_URL ||= process.env.FOUNDEROS_URL || "http://founderos.invalid";
process.env.SUPABASE_ANON_KEY ||= "embedded";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "embedded";
process.env.PLATFORM = "supabase";

const { FounderOS } = await import("./sdk.ts");
const { createHarness } = await import("../harness/host.ts");
const { agentPlugin, newAgentState } = await import("../harness/agent-plugin.ts");
const { modelForRoute } = await import("../harness/agent-profile.ts");
const { startBridge } = await import("../harness/bridge.ts");
const { startChatTurn, startTaskRun } = await import("../harness/chat.ts");
const { toolCallScope } = await import("../harness/toolkit/plugin.ts");
const { classifyRequest } = await import("../edge/_shared/model-router.ts");
type AgentProfile = import("../harness/agent-profile.ts").AgentProfile;
type HarnessStore = import("../harness/store.ts").HarnessStore;
type BoundRun = import("../harness/store.ts").BoundRun;
type TrailEntry = import("../harness/bridge.ts").TrailEntry;
type RunAction = import("./sdk.ts").RunAction;
type Kit = import("../harness/toolkit/plugin.ts").Kit;

const log = (msg: string) => console.log(`[agent] ${new Date().toISOString()} ${msg}`);
const env = (k: string, d = "") => process.env[k] || d;

const fos = new FounderOS({ url: env("FOUNDEROS_URL"), apiKey: env("FOUNDEROS_API_KEY") });
const dataDir = env("DATA_DIR", "/data");
const workspaceDir = env("WORKSPACE_DIR", "/workspace");
const instanceName = env("INSTANCE_NAME", os.hostname());

// La version construite, si le conteneur en porte une (le manifeste de l'image).
const built = await readFile(env("MANIFEST", "/app/manifest.json"), "utf8").then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => null);

interface Manifest {
  agent: Record<string, unknown> & { id: string; name: string; workspace_id: string; project_id: string; is_orchestrator?: boolean };
  system: string;
  steps?: number;
  routes: Record<string, string>;
  llm: { route: "founderos" | "direct"; base_url: string | null; model: string | null; openrouter: boolean };
  machine: { shell: boolean };
  skills: Kit["skills"];
}

const hello = await fos.hello({
  name: instanceName, version: Number(built?.version) || null, manifest_sha: (built?.sha as string | undefined) ?? null,
  info: { node: process.version, platform: `${os.platform()} ${os.arch()}`, built: !!built },
});
const instanceId = hello.instance_id;
const agentId = hello.agent_id;
let manifest = hello.manifest as unknown as Manifest;
let manifestSha = hello.sha;
if (built?.sha && built.sha !== manifestSha) log(`la configuration a changé depuis la construction (${String(built.sha).slice(0, 12)} → ${manifestSha.slice(0, 12)}) : la configuration à jour s'applique`);
log(`instance ${instanceName} (${instanceId}) de l'agent ${manifest.agent.name}`);

/** Le profil de l'agent, depuis le manifeste : prompt, modèles, connexion. */
function profileOf(m: Manifest): AgentProfile {
  const direct = m.llm.route === "direct";
  return {
    agent: m.agent as never,
    system: m.system,
    steps: m.steps,
    connection: direct
      ? { baseURL: String(m.llm.base_url ?? "").replace(/\/+$/, ""), apiKey: env("LLM_API_KEY"), headers: {}, openrouter: false, source: "connector" }
      : { baseURL: fos.llmBaseUrl, apiKey: fos.key, headers: {}, openrouter: m.llm.openrouter, source: "platform" },
    routes: m.routes.standard ? m.routes : { ...m.routes, standard: m.llm.model ?? "" },
  };
}

// ── Le magasin : les écritures du pont passent par la passerelle ──
const remote = <T>(op: string) => (...args: unknown[]) => fos.store<T>(op, args, instanceId);
const store: HarnessStore = {
  agent: remote("agent"),
  hasAgentAccess: async () => false,
  conversation: remote("conversation"),
  setConversationSession: remote("setConversationSession"),
  recentMessages: remote("recentMessages"),
  activeRun: remote("activeRun"),
  pendingQuestion: remote("pendingQuestion"),
  createRun: remote("createRun"),
  runningRuns: remote("runningRuns"),
  cancelledAmong: remote("cancelledAmong"),
  insertEvent: remote("insertEvent"),
  updateRun: remote("updateRun"),
  insertAssistantMessage: remote("insertAssistantMessage"),
  touchConversation: remote("touchConversation"),
  logUsage: remote("logUsage"),
} as HarnessStore;

// ── Le moteur ──
const state = newAgentState();
let bridgeRef: ReturnType<typeof startBridge> | null = null;
const kit = async (): Promise<Kit> => {
  const listed = await fos.tools.list();
  return {
    agentName: listed.agent.name,
    isOrchestrator: listed.agent.is_orchestrator,
    skills: manifest.skills,
    legacy: {
      defs: listed.tools,
      run: (name, args) => {
        const scope = toolCallScope.getStore();
        const run = scope ? bridgeRef?.binding(scope.sessionID) ?? null : null;
        return fos.tools.call(name, args, { run_id: run?.runId ?? null, conversation_id: run?.conversationId ?? null });
      },
    },
    search: { grep: (p) => fos.knowledge.grep(p) as never, read: (ids, whole) => fos.knowledge.read(ids, whole) as never },
  };
};
// Le conteneur est la machine de l'agent : son shell est permis, rien hors du dossier de travail.
const permissions = [
  { action: "*", resource: "*", effect: "allow" },
  ...(manifest.machine.shell ? [] : [{ action: "shell", resource: "*", effect: "deny" }]),
  { action: "external_directory", resource: "*", effect: "deny" },
];
const plugin = agentPlugin(agentId, async () => profileOf(manifest), state, {
  kit, skillsDir: path.join(dataDir, "skills"), permissions, log,
});
const harness = await createHarness({
  dataDir: path.join(dataDir, "opencode"),
  fetchModels: false,
  instances: { key: () => agentId, configure: () => ({ plugins: [plugin] }) },
  log: (level, message) => log(`${level} ${message}`),
});
// Les sessions travaillent dans /workspace, le dossier de la machine.
const host = { ...harness, agentDir: async () => workspaceDir };

// ── La conduite des runs, par la plateforme ──
const refOf = (run: BoundRun) => ({ run_id: run.runId, session_id: run.sessionId });
const compact = (trail: TrailEntry[]) => trail.map((t) => ({ name: t.name, args: t.args, ok: t.ok, result: t.result.slice(0, 1500) }));
/** Le modèle lourd de l'agent, s'il n'y est pas déjà pour cette session. */
const heavyFor = (run: BoundRun) => {
  const heavy = modelForRoute(profileOf(manifest), "heavy");
  return heavy && state.turnModels.get(run.sessionId) !== heavy ? heavy : null;
};
/** Les gestes décidés par la plateforme, appliqués à la session locale. */
async function apply(run: BoundRun, actions: RunAction[]) {
  for (const a of actions) {
    if (a.type === "steer") await harness.opencode.sessions.prompt({ sessionID: run.sessionId, text: a.text, delivery: "steer" });
    else if (a.type === "prompt") await harness.opencode.sessions.prompt({ sessionID: run.sessionId, text: a.text });
    else if (a.type === "interrupt") await harness.opencode.session.interrupt({ sessionID: run.sessionId });
    else if (a.type === "escalate") state.turnModels.set(run.sessionId, a.model);
  }
}
const bridge = startBridge(harness.opencode, store, {
  log,
  afterStep: async (run, info) => {
    const { actions } = await fos.runs.step(refOf(run), { trail: compact(info.trail), steps: info.steps, cost_usd: info.costUsd, heavy: heavyFor(run) });
    await apply(run, actions);
  },
  overBudget: (run) => fos.runs.budget(refOf(run)),
  settle: async (run, outcome) => {
    const { next, actions } = await fos.runs.settle(refOf(run), { ...outcome, trail: compact(outcome.trail) });
    await apply(run, actions);
    return next;
  },
  question: async (run, q) => { await fos.runs.question(refOf(run), q as unknown as Record<string, unknown>); },
});
bridgeRef = bridge;
const agents = {
  state,
  load: async () => profileOf(manifest),
  choose: async (profile: AgentProfile, text: string) => {
    const tier = classifyRequest(text, { mode: "chat" }).model;
    return { model: modelForRoute(profile, tier), tier, need: null };
  },
};
const deps = { harness: host, store, bridge, agents };
const self = { id: agentId, name: manifest.agent.name, workspace_id: manifest.agent.workspace_id, project_id: manifest.agent.project_id, harness: "opencode" as const };

// ── Les ordres ──
const TASK_KINDS = ["mission", "room", "workflow", "a2a"] as const;
type TaskKind = (typeof TASK_KINDS)[number];
let paused = false;
let stopping = false;

async function handle(cmd: { id: number; command: string; payload: Record<string, unknown> }) {
  const p = cmd.payload ?? {};
  switch (cmd.command) {
    case "run": {
      const kind = String(p.kind ?? "chat");
      const common = {
        runContext: typeof p.run_context === "string" ? p.run_context : undefined,
        meta: (p.meta ?? undefined) as Record<string, unknown> | undefined,
        actingUserId: (p.acting_user_id as string | null) ?? null,
      };
      if (kind === "chat") {
        const out = await startChatTurn(deps, {
          agent: self, conversationId: String(p.conversation_id), runId: (p.run_id as string | null) ?? null,
          model: (p.model as string | null) ?? null, ...common,
        });
        log(`tour de chat ${out.run_id}${out.injected ? " (message glissé dans le tour en cours)" : out.answered ? " (réponse à une question)" : ""}`);
      } else {
        if (!TASK_KINDS.includes(kind as TaskKind)) { log(`ordre run : sorte « ${kind} » inconnue`); return; }
        const out = await startTaskRun(deps, {
          agent: self, kind: kind as TaskKind, runId: (p.run_id as string | null) ?? null, text: String(p.text ?? ""),
          unattended: true, ...common,
        });
        log(`${kind} ${out.run_id}`);
      }
      return;
    }
    case "pause": paused = true; log("en pause"); return;
    case "resume": paused = false; log("reprise"); return;
    case "reload": {
      const next = await fos.manifest();
      manifest = next.manifest as unknown as Manifest;
      manifestSha = next.sha;
      await state.controls.get(agentId)?.refresh();
      log(`configuration rechargée (${manifestSha.slice(0, 12)})`);
      return;
    }
    case "stop": stopping = true; log("arrêt demandé"); return;
  }
}

async function beat() {
  await fos.heartbeat({
    instance_id: instanceId, status: paused ? "paused" : "online", manifest_sha: manifestSha,
    info: { uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1e6), load: os.loadavg()[0] },
  }).catch((e) => log(`battement de cœur : ${e instanceof Error ? e.message : String(e)}`));
}

async function loop() {
  let lastBeat = 0;
  while (!stopping) {
    if (Date.now() - lastBeat > 15_000) { lastBeat = Date.now(); await beat(); }
    try {
      const { command } = await fos.commands.take(instanceId);
      // En pause, seuls la reprise, le rechargement et l'arrêt passent ; un tour attend.
      if (command && (!paused || command.command !== "run")) {
        await handle(command).catch((e) => log(`ordre ${command.command} : ${e instanceof Error ? e.message : String(e)}`));
        await fos.commands.done(command.id).catch(() => {});
        continue;
      }
    } catch (e) {
      log(`ordres : ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const shutdown = async () => {
  stopping = true;
  await bridge.stop().catch(() => {});
  await harness.close().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await beat();
await loop();
await shutdown();
