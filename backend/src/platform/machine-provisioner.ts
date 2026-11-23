// Les machines d'équipe créées à la demande (0311), avec le Docker de l'hôte.
//
// « Ajouter une machine → Créer » arrive ici par la fonction `machines` : on
// lance un conteneur team-machine qui n'appartient qu'à cette machine du parc,
// avec ses volumes, son port local et son jeton. Le jeton passe par
// l'environnement du processus `docker` (`-e MACHINE_TOKEN` sans valeur), jamais
// par la ligne de commande.
//
// Réglages (backend/.env.self), tous facultatifs :
//   MACHINE_PROVISIONER=0          désactive la création à la demande
//   TEAM_MACHINE_IMAGE             image à lancer (founderos/team-machine:0.3.0)
//   TEAM_MACHINE_BUILD_DIR         où la construire si elle manque (../team-machine)
//   TEAM_MACHINE_PORTS=8100-8199   ports locaux à distribuer
//   TEAM_MACHINE_HOST=localhost    l'hôte par lequel ce backend joint les conteneurs
//   TEAM_MACHINE_CPUS=4  TEAM_MACHINE_MEMORY=8g   limites de chaque conteneur

import { execFile } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MachineProvisioner } from "../edge/_shared/team-machine.ts";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const IMAGE = process.env.TEAM_MACHINE_IMAGE || "founderos/team-machine:0.3.0";
const BUILD_DIR = process.env.TEAM_MACHINE_BUILD_DIR || path.resolve(backendDir, "../team-machine");
const HOST = process.env.TEAM_MACHINE_HOST || "localhost";
const CPUS = process.env.TEAM_MACHINE_CPUS || "4";
const MEMORY = process.env.TEAM_MACHINE_MEMORY || "8g";
const [PORT_MIN, PORT_MAX] = (() => {
  const m = (process.env.TEAM_MACHINE_PORTS || "8100-8199").match(/^(\d+)-(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : [8100, 8199];
})();

const LABEL = "founderos.machine";
const PORT_LABEL = "founderos.port";

/** Une commande docker ; l'erreur garde ce que docker a dit. */
function docker(args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, {
      env: { ...process.env, ...opts.env },
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        const said = String(stderr || "").trim().split(/\r?\n/).slice(-3).join(" ");
        reject(new Error(said || err.message));
      } else resolve(String(stdout).trim());
    });
  });
}

/** Un seul `docker run` (ou build) à la fois : deux créations simultanées ne prennent pas le même port. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

let imageReady: Promise<void> | null = null;
function ensureImage(): Promise<void> {
  imageReady ??= (async () => {
    try {
      await docker(["image", "inspect", IMAGE]);
    } catch {
      console.log(`[machines] image ${IMAGE} absente : construction depuis ${BUILD_DIR} (quelques minutes la première fois)`);
      await docker(["build", "-t", IMAGE, BUILD_DIR], { timeoutMs: 20 * 60_000 });
    }
  })().catch((e) => { imageReady = null; throw e; });
  return imageReady;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/** Un port de la plage que ni un autre conteneur créé ici (même arrêté) ni un autre programme n'occupe. */
async function pickPort(): Promise<number> {
  const out = await docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", `{{.Label "${PORT_LABEL}"}}`]);
  const taken = new Set(out.split(/\r?\n/).map(Number).filter(Boolean));
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!taken.has(p) && await portFree(p)) return p;
  }
  throw new Error(`plus de port libre entre ${PORT_MIN} et ${PORT_MAX} (TEAM_MACHINE_PORTS)`);
}

const containerName = (machineId: string) => `founderos-tm-${machineId.replace(/-/g, "").slice(0, 12)}`;

/** Les mêmes protections que team-machine/compose.yaml. */
async function run(name: string, port: number, machineId: string, token: string, allowApt: boolean): Promise<void> {
  await docker([
    "run", "-d", "--name", name, "--restart", "unless-stopped",
    "--label", `${LABEL}=${machineId}`, "--label", `${PORT_LABEL}=${port}`,
    "-e", "MACHINE_TOKEN",
    "-e", `MACHINE_ALLOW_APT=${allowApt ? "1" : "0"}`,
    "-p", `127.0.0.1:${port}:8080`,
    "-v", `${name}-teams:/teams`, "-v", `${name}-state:/var/lib/team-machine`,
    "--cap-drop", "ALL",
    ...["CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "FSETID", "SETUID", "SETGID", "SETPCAP", "KILL"].flatMap((c) => ["--cap-add", c]),
    "--security-opt", "no-new-privileges:true",
    "--shm-size", "1g", "--pids-limit", "4096", "--memory", MEMORY, "--cpus", CPUS,
    IMAGE,
  ], { env: { MACHINE_TOKEN: token } });
}

async function waitHealthy(url: string, name: string, timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json().catch(() => null) as { ok?: boolean } | null;
      if (j?.ok) return;
    } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const logs = await docker(["logs", "--tail", "5", name]).catch(() => "");
  throw new Error(`le conteneur ${name} ne répond pas sur ${url}${logs ? ` (${logs.replace(/\s+/g, " ").slice(0, 300)})` : ""}`);
}

async function portOf(name: string): Promise<number> {
  const p = Number(await docker(["inspect", "--format", `{{index .Config.Labels "${PORT_LABEL}"}}`, name]));
  if (!p) throw new Error(`conteneur ${name} introuvable`);
  return p;
}

export function dockerMachineProvisioner(): MachineProvisioner {
  return {
    async check() {
      try {
        await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 8000 });
        return { ok: true };
      } catch {
        return { ok: false, reason: "Docker ne répond pas sur cet hôte : lancez Docker Desktop" };
      }
    },

    async create({ machineId, token, allowApt }) {
      await ensureImage();
      const name = containerName(machineId);
      const port = await serial(async () => {
        await docker(["rm", "-f", name]).catch(() => {});
        const p = await pickPort();
        await run(name, p, machineId, token, allowApt);
        return p;
      });
      const url = `http://${HOST}:${port}`;
      await waitHealthy(url, name);
      console.log(`[machines] ${name} prête sur ${url}`);
      return { ref: name, url };
    },

    async reconfigure({ ref, token, allowApt }) {
      const port = await portOf(ref);
      const machineId = await docker(["inspect", "--format", `{{index .Config.Labels "${LABEL}"}}`, ref]);
      await serial(async () => {
        await docker(["rm", "-f", ref]);
        await run(ref, port, machineId, token, allowApt);
      });
      await waitHealthy(`http://${HOST}:${port}`, ref);
    },

    async destroy({ ref, volumes }) {
      await docker(["rm", "-f", ref]).catch((e) => {
        if (!/no such container/i.test(String(e?.message))) throw e;
      });
      if (volumes) {
        await docker(["volume", "rm", "-f", `${ref}-teams`, `${ref}-state`]);
      }
      console.log(`[machines] ${ref} supprimée${volumes ? " avec ses volumes" : " (volumes gardés)"}`);
    },
  };
}
