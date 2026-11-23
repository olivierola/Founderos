// Un agent embarqué en mode isolé : aucune liaison avec FounderOS. Il part de
// la configuration figée dans son image (manifest.json), parle à son modèle en
// direct, cherche dans sa connaissance embarquée, travaille dans /workspace, et
// tient toute son activité dans un journal (/data/isolated.jsonl) qu'on importe
// ensuite dans FounderOS.
//
// On lui parle par l'entrée locale (local-server.ts) : une page et une API,
// protégées par LOCAL_TOKEN (généré et affiché au premier démarrage s'il manque).
//
// Variables : MANIFEST, KNOWLEDGE, DATA_DIR, WORKSPACE_DIR, LLM_API_KEY,
// LOCAL_TOKEN, LOCAL_PORT (8080), INSTANCE_NAME.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SUPABASE_URL ||= "http://founderos.invalid";
process.env.SUPABASE_ANON_KEY ||= "embedded";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "embedded";
process.env.PLATFORM = "supabase";

const { createHarness } = await import("../harness/host.ts");
const { agentPlugin, newAgentState } = await import("../harness/agent-plugin.ts");
const { modelForRoute } = await import("../harness/agent-profile.ts");
const { startBridge } = await import("../harness/bridge.ts");
const { startChatTurn } = await import("../harness/chat.ts");
const { classifyRequest } = await import("../edge/_shared/model-router.ts");
const { fromJsonl, localIndex } = await import("./knowledge.ts");
const { localStore } = await import("./local-store.ts");
const { startLocalServer } = await import("./local-server.ts");
type AgentProfile = import("../harness/agent-profile.ts").AgentProfile;
type Kit = import("../harness/toolkit/plugin.ts").Kit;

const log = (msg: string) => console.log(`[agent isolé] ${new Date().toISOString()} ${msg}`);
const env = (k: string, d = "") => process.env[k] || d;
const dataDir = env("DATA_DIR", "/data");
const workspaceDir = env("WORKSPACE_DIR", "/workspace");
await mkdir(dataDir, { recursive: true }).catch(() => {});

interface Manifest {
  agent: Record<string, unknown> & { id: string; name: string; workspace_id: string; project_id: string; is_orchestrator?: boolean };
  system: string;
  steps?: number;
  routes: Record<string, string>;
  llm: { route: "founderos" | "direct"; base_url: string | null; model: string | null };
  machine: { shell: boolean };
  skills: Kit["skills"];
}

const manifest = JSON.parse(await readFile(env("MANIFEST", "/app/manifest.json"), "utf8")) as Manifest;
if (manifest.llm.route !== "direct" || !manifest.llm.base_url) {
  log("en mode isolé, le modèle doit être en accès direct (adresse et modèle dans la configuration de l'agent) : arrêt");
  process.exit(1);
}
if (!env("LLM_API_KEY")) log("LLM_API_KEY est vide : le point d'accès du modèle doit accepter les appels sans clé");

// Le jeton de l'entrée locale : celui de l'environnement, sinon un jeton gardé sur le volume.
const tokenFile = path.join(dataDir, "local-token");
let token = env("LOCAL_TOKEN");
if (!token) {
  token = (await readFile(tokenFile, "utf8").catch(() => "")).trim();
  if (!token) {
    token = randomBytes(24).toString("base64url");
    await writeFile(tokenFile, token, { mode: 0o600 });
    log(`jeton de l'entrée locale créé (${tokenFile}) : ${token}`);
  }
}

const profile: AgentProfile = {
  agent: manifest.agent as never,
  system: manifest.system,
  steps: manifest.steps,
  connection: { baseURL: String(manifest.llm.base_url).replace(/\/+$/, ""), apiKey: env("LLM_API_KEY"), headers: {}, openrouter: false, source: "connector" },
  routes: manifest.routes.standard ? manifest.routes : { ...manifest.routes, standard: manifest.llm.model ?? "" },
};
const self = { id: manifest.agent.id, name: manifest.agent.name, workspace_id: manifest.agent.workspace_id, project_id: manifest.agent.project_id, harness: "opencode" as const };

const local = await localStore({ agent: self, file: path.join(dataDir, "isolated.jsonl"), instanceName: env("INSTANCE_NAME", os.hostname()) });

// La connaissance embarquée : la seule source de recherche.
const rows = fromJsonl(await readFile(env("KNOWLEDGE", "/app/knowledge.jsonl"), "utf8").catch(() => ""));
const knowledge = localIndex(rows);
log(`agent ${manifest.agent.name} ; connaissance embarquée : ${rows.length} passages`);

const state = newAgentState();
const kit = async (): Promise<Kit> => ({
  agentName: manifest.agent.name,
  isOrchestrator: !!manifest.agent.is_orchestrator,
  skills: manifest.skills,
  // Aucun outil de la plateforme : rien ne sort du site.
  legacy: { defs: [], run: async (name) => `L'outil ${name} n'est pas disponible : cet agent travaille sans liaison avec FounderOS.` },
  search: { grep: (p) => knowledge.grep(p), read: (ids, whole) => knowledge.read(ids, whole) },
});
const permissions = [
  { action: "*", resource: "*", effect: "allow" as const },
  ...(manifest.machine.shell ? [] : [{ action: "shell", resource: "*", effect: "deny" as const }]),
  { action: "external_directory", resource: "*", effect: "deny" as const },
];
const plugin = agentPlugin(self.id, async () => profile, state, { kit, skillsDir: path.join(dataDir, "skills"), permissions, log });
const harness = await createHarness({
  dataDir: path.join(dataDir, "opencode"),
  fetchModels: false,
  instances: { key: () => self.id, configure: () => ({ plugins: [plugin] }) },
  log: (level, message) => log(`${level} ${message}`),
});
const bridge = startBridge(harness.opencode, local.store, { log, question: (run, q) => local.question(run, q) });
const deps = {
  harness: { ...harness, agentDir: async () => workspaceDir },
  store: local.store,
  bridge,
  agents: {
    state,
    load: async () => profile,
    choose: async (p: AgentProfile, text: string) => {
      const tier = classifyRequest(text, { mode: "chat" }).model;
      return { model: modelForRoute(p, tier), tier, need: null };
    },
  },
};

const server = startLocalServer({
  agentName: manifest.agent.name,
  token,
  local,
  log,
  turn: async (conversationId) => {
    const out = await startChatTurn(deps, { agent: self, conversationId });
    return { run_id: out.run_id };
  },
}, Number(env("LOCAL_PORT", "8080")));

const shutdown = async () => {
  server.close();
  await bridge.stop().catch(() => {});
  await harness.close().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
