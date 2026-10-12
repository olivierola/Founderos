// Compatibilité Deno → Node pour le code généré dans src/edge/.
//
// Les edge functions y sont copiées presque telles quelles (scripts/port-edge.mjs).
// Ce module fournit les seules API du runtime Supabase qu'elles utilisent :
// Deno.env, Deno.resolveDns, Deno.connectTls, EdgeRuntime.waitUntil, et la
// signature `(req: Request) => Response` de Deno.serve.

import { AsyncLocalStorage } from "node:async_hooks";
import { resolve4, resolve6 } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { connect as tlsConnect } from "node:tls";
import { env } from "../env.ts";
import "./mtls.ts";
import { installMcpObserver } from "../shared/metrics.ts";

export type EdgeHandler = (req: Request) => Response | Promise<Response>;

/** Remplace `Deno.serve(handler)` : le module exporte son handler, l'adaptateur Express le monte. */
export function defineHandler(handler: EdgeHandler): EdgeHandler {
  return handler;
}

/** Base des URL /functions/v1/… : les appels entre fonctions visent ce backend. */
export const FUNCTIONS_URL = env.functionsUrl;

/**
 * Réglages de l'installation (G4, shared/installation.ts) : servis comme des
 * variables d'environnement, quand l'environnement ne les fixe pas lui-même.
 */
let envOverlay: Record<string, string> = {};
export function setEnvOverlay(values: Record<string, string>): void {
  envOverlay = { ...values };
}

export const Deno = {
  env: {
    get: (key: string): string | undefined => {
      const v = process.env[key];
      return v !== undefined && v !== "" ? v : (envOverlay[key] ?? v);
    },
  },

  /** Lecture du catalogue des tools (CATALOG_FILE, mcp-auth.ts). */
  readTextFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  },

  resolveDns(host: string, type: "A" | "AAAA"): Promise<string[]> {
    return type === "A" ? resolve4(host) : resolve6(host);
  },

  /**
   * Seul appelant : la sonde SSL d'ops-run-checks, qui lit la date d'expiration
   * dans `peerCertificates[0].notAfter`. Deno n'exposait pas ce champ (la sonde
   * répondait toujours « warn ») ; Node le fournit.
   */
  connectTls(opts: { hostname: string; port: number }): Promise<{
    peerCertificates: { notAfter: string }[];
    close(): void;
  }> {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect({ host: opts.hostname, port: opts.port, servername: opts.hostname }, () => {
        const cert = socket.getPeerCertificate();
        resolve({
          peerCertificates: cert?.valid_to ? [{ notAfter: cert.valid_to }] : [],
          close: () => socket.end(),
        });
      });
      socket.once("error", reject);
      socket.setTimeout(10_000, () => socket.destroy(new Error("TLS handshake timeout")));
    });
  },
};

// ── EdgeRuntime.waitUntil ────────────────────────────────────────────────────
// Le code edge détecte `globalThis.EdgeRuntime` et y confie ses tâches de fond.
// Sous Node rien ne coupe le processus après la réponse : on garde seulement la
// trace des tâches pour les laisser finir à l'arrêt du serveur.

const background = new Set<Promise<unknown>>();

export function waitUntil(task: Promise<unknown>): void {
  const tracked: Promise<unknown> = Promise.resolve(task)
    .catch((err) => console.error("[waitUntil] tâche de fond en échec :", err))
    .finally(() => background.delete(tracked));
  background.add(tracked);
}

/** Attend les tâches de fond en cours, au plus `timeoutMs`. */
export async function drainBackgroundTasks(timeoutMs: number): Promise<void> {
  if (!background.size) return;
  await Promise.race([
    Promise.allSettled([...background]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

(globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = { waitUntil };

// ── Contexte d'appel LLM (_shared/llm-context.ts) ───────────────────────────
// L'agent, la personne et le run d'un appel de modèle, que la passerelle
// LiteLLM reçoit (clé virtuelle, `user`, métadonnées). Le contexte suit les
// promesses : une tâche confiée à waitUntil pendant un run le garde.

export interface LlmCallerContext {
  agentId?: string;
  agentName?: string;
  userId?: string | null;
  runId?: string | null;
}

export const llmCallerStore = new AsyncLocalStorage<LlmCallerContext>();
(globalThis as { __llmCallerStore?: unknown }).__llmCallerStore = llmCallerStore;

// ── Audit et métriques des appels MCP (_shared/mcp-observe.ts, D7) ─────────
installMcpObserver();
