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
const bridge = startBridge(harness.opencode, store, { log });
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
        const out = await startTaskRun(deps, {
          agent: self, kind: kind as "mission", runId: (p.run_id as string | null) ?? null, text: String(p.text ?? ""),
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
