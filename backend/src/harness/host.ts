// L'hôte OpenCode embarqué dans le backend (docs/harness-opencode).
//
// Le moteur d'agent d'OpenCode (session, étapes, outils, permissions,
// compaction, reprise après crash) tourne DANS ce processus, par le SDK
// `@opencode/sdk` : aucune écoute réseau, aucun saut HTTP. FounderOS s'y branche
// par des plugins (src/harness/plugins).
//
// Actif seulement en PLATFORM=self avec HARNESS_OPENCODE=1 : le backend est
// alors un processus long-vivant avec un disque, ce qu'exige OpenCode (une
// session s'exécute dans un seul processus). Hors de ce mode, rien n'est
// chargé : les modules d'OpenCode ne sont importés que par createHarness.
//
// Ce qu'il garde sur disque, sous `dataDir` :
//   opencode.db         état d'exécution d'OpenCode (sessions, inbox, événements
//                       durables). La source de vérité métier reste Postgres.
//   config/             répertoire de configuration (vide : tout vient des plugins)
//   agents/<agent_id>/  dossier de travail de chaque agent

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { OpenCode } from "@opencode/sdk";

export type OpenCodeHost = Awaited<ReturnType<typeof OpenCode.create>>;
/** Un plugin tel que le SDK l’accepte (Plugin.define de @opencode/plugin). */
export type HarnessPlugin = NonNullable<NonNullable<Parameters<typeof OpenCode.create>[0]>["plugins"]>[number];

export interface HarnessOptions {
  /** Racine des données du harnais. */
  dataDir: string;
  /** Plugins FounderOS (outils, permissions, modèles, pont…). */
  plugins?: HarnessPlugin[];
  /** Configuration OpenCode (fournisseurs, modèle par défaut), en objet. */
  config?: Record<string, unknown>;
  /** Base en mémoire (tests) au lieu de `dataDir/opencode.db`. */
  inMemory?: boolean;
  /** Charger le catalogue models.dev (réseau). Faux en test. */
  fetchModels?: boolean;
  /** Journal : avertissements et erreurs d'OpenCode. */
  log?: (level: string, message: string) => void;
  /** Un jeu de plugins par clé (un par agent FounderOS, voir runtime.ts). */
  instances?: HarnessInstances;
}

export type HarnessInstances = NonNullable<NonNullable<Parameters<typeof OpenCode.create>[0]>["instances"]>;

export interface Harness {
  readonly opencode: OpenCodeHost;
  readonly dataDir: string;
  /** Le dossier de travail d'un agent, créé au besoin. */
  agentDir(agentId: string): Promise<string>;
  close(): Promise<void>;
}

/** Un identifiant sûr comme nom de dossier (pas de séparateur, pas de « .. »). */
export function safeSegment(id: string): string {
  const s = String(id).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  if (!s) throw new Error("identifiant vide");
  return s;
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const dataDir = path.resolve(options.dataDir);
  const configDir = path.join(dataDir, "config");
  await mkdir(configDir, { recursive: true });
  await mkdir(path.join(dataDir, "agents"), { recursive: true });

  const { OpenCode } = await import("@opencode/sdk");
  const opencode = await OpenCode.create({
    ...(options.inMemory ? {} : { database: { path: path.join(dataDir, "opencode.db") } }),
    plugins: options.plugins ?? [],
    ...(options.instances ? { instances: options.instances } : {}),
    config: {
      directory: configDir,
      // Pas de configuration de projet, ni des CLAUDE.md de la machine : un
      // agent FounderOS ne reçoit que ce que ses plugins lui donnent.
      project: false,
      claude: false,
      ...(options.config ? { content: JSON.stringify(options.config) } : {}),
    },
    instructions: { claude: false },
    models: { fetch: options.fetchModels ?? false },
    fs: { filewatcher: false },
    log: {
      level: "warn",
      emit: (entry: { level?: string; message: string }) => options.log?.(entry.level ?? "warn", entry.message),
    },
  } as Parameters<typeof OpenCode.create>[0]);

  return {
    opencode,
    dataDir,
    agentDir: async (agentId) => {
      const dir = path.join(dataDir, "agents", safeSegment(agentId));
      await mkdir(dir, { recursive: true });
      return dir;
    },
    close: () => opencode.close(),
  };
}

// ── L'hôte du processus ──────────────────────────────────────────────────────

let current: Promise<Harness> | null = null;

/** Démarre l'hôte du backend (une fois). */
export function startHarness(options: HarnessOptions): Promise<Harness> {
  current ??= createHarness(options);
  return current;
}

/** L'hôte du backend, ou null s'il n'est pas démarré (mode cloud, interrupteur). */
export function harness(): Promise<Harness> | null {
  return current;
}

/** Ferme l'hôte (arrêt du backend) : les sessions en cours seront reprises au redémarrage. */
export async function stopHarness(): Promise<void> {
  const h = current;
  current = null;
  if (h) await (await h).close().catch(() => {});
}
