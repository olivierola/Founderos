import { drainBackgroundTasks } from "./compat/index.ts";
import { env } from "./env.ts";
import { createServer } from "./server.ts";
import { createMgmtServer } from "./shared/metrics.ts";
import { createServiceClient } from "./shared/supabase.ts";
import { sealPendingMcpHeaders } from "./edge/_shared/mcp-headers.ts";
import { startInstallationSync } from "./shared/installation.ts";

// Le code porté lance des fetch « fire and forget » sans .catch. Sous Deno, un
// rejet non géré tuait l'isolat d'UNE requête ; sous Node il arrêterait tout le
// serveur. On le journalise à la place.
process.on("unhandledRejection", (reason) => {
  console.error("[backend] promesse rejetée sans gestionnaire :", reason);
});

// Réglages de l'installation (G4) : lus au démarrage, puis chaque minute.
startInstallationSync(createServiceClient());

const server = createServer().listen(env.port, () => {
  console.log(`[backend] prêt sur http://localhost:${env.port}`);
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
    process.exit(0);
  });
}
