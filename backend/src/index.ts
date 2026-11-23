import { drainBackgroundTasks } from "./compat/index.ts";
import { env } from "./env.ts";
import { createServer } from "./server.ts";
import { createMgmtServer } from "./shared/metrics.ts";
import { createServiceClient } from "./shared/supabase.ts";
import { sealPendingMcpHeaders } from "./edge/_shared/mcp-headers.ts";
import { startInstallationSync } from "./shared/installation.ts";
import { startPlatform } from "./platform/platform.ts";
import { startHarness, stopHarness } from "./harness/host.ts";
import { agentSupport, startRuntime, stopRuntime } from "./harness/runtime.ts";
import { installMachineProvisioner } from "./edge/_shared/team-machine.ts";
import { dockerMachineProvisioner } from "./platform/machine-provisioner.ts";

// Le code porté lance des fetch « fire and forget » sans .catch. Sous Deno, un
// rejet non géré tuait l'isolat d'UNE requête ; sous Node il arrêterait tout le
// serveur. On le journalise à la place.
process.on("unhandledRejection", (reason) => {
  console.error("[backend] promesse rejetée sans gestionnaire :", reason);
});

// PLATFORM=self : la base, l'auth, le storage et le realtime sont servis ici.
const platform = env.platform
  ? await startPlatform({
    ...env.platform,
    publicUrl: env.functionsUrl,
    anonKey: env.supabaseAnonKey,
    serviceKey: env.supabaseServiceRoleKey,
  })
  : null;

// Les machines d'équipe créées à la demande (0311) : le Docker de l'hôte, en
// mode auto-hébergé seulement (MACHINE_PROVISIONER=0 pour s'en passer).
const machineProvisioning = !!platform && process.env.MACHINE_PROVISIONER !== "0";
if (machineProvisioning) installMachineProvisioner(dockerMachineProvisioner());

// Le harnais OpenCode (PLATFORM=self et HARNESS_OPENCODE=1) : démarré avant
// l'écoute, il reprend aussitôt les sessions qu'un arrêt a laissées en cours.
// Ses modules ne sont chargés que dans ce cas.
if (env.harness) {
  const started = Date.now();
  // Le pont et les agents lisent et écrivent dans la base de ce backend (client
  // de service) : en mode local, ce sont les tables que le front lit.
  const harnessAdmin = createServiceClient();
  // L'outillage FounderOS par lots (HARNESS_TOOLKIT=0 : les outils natifs seuls).
  const agents = agentSupport(harnessAdmin, {
    kit: process.env.HARNESS_TOOLKIT !== "0",
    skillsDir: `${env.harness.dataDir}/skills`,
    log: (m) => console.warn(`[harness] ${m}`),
  });
  const harnessReady = await startHarness({
    instances: agents.instances,
    dataDir: env.harness.dataDir,
    fetchModels: true,
    config: env.harness.model ? { model: env.harness.model } : undefined,
    log: (level, message) => console.warn(`[harness] ${level} ${message}`),
  });
  console.log(`[harness] OpenCode prêt en ${Date.now() - started} ms (${env.harness.dataDir})`);
  startRuntime(harnessReady, harnessAdmin, env.supabaseServiceRoleKey, agents.support);
}

const server = createServer(undefined, { platform }).listen(env.port, () => {
  console.log(`[backend] prêt sur http://localhost:${env.port}${platform ? " (plateforme auto-hébergée)" : ""}`);
  // Réglages de l'installation (G4) : lus au démarrage, puis chaque minute.
  // Après l'écoute : en mode self, ils passent par ce serveur même.
  startInstallationSync(createServiceClient());
  // Une création de machine coupée par un arrêt ne reprendra pas : on le dit.
  if (machineProvisioning) {
    createServiceClient().from("machines")
      .update({ provision_state: "failed", last_error: "création interrompue par un redémarrage du backend : supprimez-la et recréez-la" })
      .eq("provision_state", "creating")
      .then(({ error }) => { if (error) console.error("[machines] reprise :", error.message); });
  }
  // En-têtes MCP déposés en clair par la migration 0280 (la base ne connaît pas
  // la clé) : chiffrés dès le démarrage. Au mieux ; la première lecture le fait aussi.
  sealPendingMcpHeaders(createServiceClient())
    .then((n) => { if (n) console.log(`[backend] en-têtes MCP chiffrés : ${n} serveur(s)`); })
    .catch((e) => console.error("[backend] chiffrement des en-têtes MCP :", e instanceof Error ? e.message : e));
});

// Métriques des appels MCP des agents (D7), sur un port séparé, non routé.
const mgmt = env.mgmtPort > 0
  ? createMgmtServer().listen(env.mgmtPort, () => console.log(`[backend] métriques sur :${env.mgmtPort}/metrics`))
  : null;

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    mgmt?.close();
    // Les tâches lancées par EdgeRuntime.waitUntil ont jusqu'à 25 s pour finir.
    await drainBackgroundTasks(25_000);
    // Les sessions en cours gardent leur revendication : reprises au redémarrage.
    await stopRuntime();
    await stopHarness();
    await platform?.close().catch(() => {});
    process.exit(0);
  });
}
