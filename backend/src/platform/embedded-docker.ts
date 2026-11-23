// Construire et lancer un agent embarqué sur le Docker de cet hôte (plateforme
// auto-hébergée) : de quoi l'essayer sans quitter FounderOS. Ailleurs, on
// télécharge l'archive et on la lance soi-même (docker compose up -d --build).
//
//   l'image du moteur   founderos/agent-runtime:<version>, construite depuis le
//                       dépôt (embedded/Dockerfile) si elle manque
//   l'image de l'agent  l'archive exportée, dépliée puis construite
//   le conteneur        founderos-agent-<id>, avec sa clé d'API dans son
//                       environnement (jamais en argument de commande) et
//                       FounderOS joint par host.docker.internal

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function docker(args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, {
      env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || "").trim().split(/\r?\n/).slice(-4).join(" ") || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

export interface EmbeddedDocker {
  check(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Construit l'image de l'agent depuis son archive (et le moteur s'il manque). Rend le journal. */
  build(input: { bundle: Uint8Array; tag: string; runtimeVersion: string }): Promise<string>;
  /** Lance le conteneur de l'agent ; rend son nom. */
  run(input: { agentId: string; tag: string; apiKey: string; instanceName: string; founderosUrl: string; cpus: number; memoryMb: number; llmApiKey?: string }): Promise<string>;
  /** Arrête et supprime le conteneur (et ses volumes si demandé). */
  remove(input: { name: string; volumes: boolean }): Promise<void>;
}

const KEY = "__founderosEmbeddedDocker";
export const embeddedDocker = (): EmbeddedDocker | null => ((globalThis as Record<string, unknown>)[KEY] as EmbeddedDocker | undefined) ?? null;
export const installEmbeddedDocker = (d: EmbeddedDocker | null) => { (globalThis as Record<string, unknown>)[KEY] = d ?? undefined; };

const runtimeReady = new Map<string, Promise<void>>();

export function localEmbeddedDocker(): EmbeddedDocker {
  const ensureRuntime = (version: string) => {
    const tag = `founderos/agent-runtime:${version}`;
    let p = runtimeReady.get(tag);
    if (!p) {
      p = (async () => {
        try {
          await docker(["image", "inspect", tag]);
        } catch {
          console.log(`[embarqués] image ${tag} absente : construction depuis ${repoDir} (quelques minutes la première fois)`);
          await docker(["build", "-f", path.join(repoDir, "embedded", "Dockerfile"), "-t", tag, repoDir], { timeoutMs: 30 * 60_000 });
        }
      })().catch((e) => { runtimeReady.delete(tag); throw e; });
      runtimeReady.set(tag, p);
    }
    return p;
  };
  return {
    async check() {
      try {
        await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 8000 });
        return { ok: true };
      } catch {
        return { ok: false, reason: "Docker ne répond pas sur cet hôte : lancez Docker Desktop, ou téléchargez l'archive et lancez-la ailleurs" };
      }
    },

    async build({ bundle, tag, runtimeVersion }) {
      await ensureRuntime(runtimeVersion);
      const dir = await mkdtemp(path.join(os.tmpdir(), "founderos-embedded-"));
      try {
        const reader = new ZipReader(new BlobReader(new Blob([bundle as BlobPart])));
        let root = dir;
        for (const entry of await reader.getEntries()) {
          if (entry.directory || !entry.getData) continue;
          // Le premier dossier de l'archive est son nom (agent-vN) : on construit dedans.
          const rel = entry.filename.split("/").filter((s) => s && s !== "..");
          const target = path.join(dir, ...rel);
          if (!target.startsWith(dir)) continue;
          root = path.join(dir, rel[0]);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, await entry.getData(new TextWriter()));
        }
        await reader.close();
        return await docker(["build", "-t", tag, root], { timeoutMs: 30 * 60_000 });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },

    async run({ agentId, tag, apiKey, instanceName, founderosUrl, cpus, memoryMb, llmApiKey }) {
      const name = `founderos-agent-${agentId.slice(0, 8)}-${instanceName.replace(/[^a-z0-9-]+/gi, "-").slice(0, 20)}`.toLowerCase();
      await docker(["rm", "-f", name]).catch(() => {});
      await docker([
        "run", "-d", "--name", name, "--restart", "unless-stopped",
        "--label", "founderos.embedded=1", "--label", `founderos.agent=${agentId}`,
        "--add-host", "host.docker.internal:host-gateway",
        "--cpus", String(cpus), "--memory", `${memoryMb}m`,
        "-v", `${name}-data:/data`, "-v", `${name}-workspace:/workspace`,
        // Les secrets passent par l'environnement du processus docker, pas par la ligne de commande.
        "-e", "FOUNDEROS_API_KEY", "-e", "LLM_API_KEY",
        "-e", `FOUNDEROS_URL=${founderosUrl}`, "-e", `INSTANCE_NAME=${instanceName}`,
        tag,
      ], { env: { FOUNDEROS_API_KEY: apiKey, LLM_API_KEY: llmApiKey ?? "" }, timeoutMs: 120_000 });
      return name;
    },

    async remove({ name, volumes }) {
      await docker(["rm", "-f", name]).catch(() => {});
      if (volumes) await docker(["volume", "rm", "-f", `${name}-data`, `${name}-workspace`]).catch(() => {});
    },
  };
}
