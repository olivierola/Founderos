#!/usr/bin/env node
// Le superviseur HTTP de la machine d'équipe.
//
//   GET  /health        → { ok, version } — sans authentification, sans détail
//   POST /v1/<opération> → corps JSON signé (auth.mjs)
//
// Il tourne en root DANS le conteneur, seul processus privilégié ; tout ce
// qu'un agent lance passe par setpriv sous son propre uid (exec.mjs).
// Variables : voir README.md.

import http from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { NonceCache, verifySignature } from "./auth.mjs";
import { Machine, MachineError, VERSION } from "./machine.mjs";
import { StateStore } from "./state.mjs";
import { SystemOps } from "./system.mjs";
import { JobTable } from "./jobs.mjs";

const MAX_BODY = 12 * 1024 * 1024;

const ADMIN_OPS = {
  "status": (m, b) => m.status(b),
  "machine.info": (m) => m.info(),
  "activity": (m, b) => m.activity(b),
  "browser.view": (m, b) => m.browserView(b),
  "team.ensure": (m, b) => m.teamEnsure(b),
  "team.suspend": (m, b) => m.teamSuspend(b),
  "agent.ensure": (m, b) => m.agentEnsure(b),
  "agent.reset_secret": (m, b) => m.agentResetSecret(b),
  "folder.create": (m, b) => m.folderCreate(b),
  "folder.rotate": (m, b) => m.folderRotate(b),
  "folder.revoke": (m, b) => m.folderRevoke(b),
  "folder.archive": (m, b) => m.folderArchive(b),
};

const AGENT_OPS = {
  "exec": (m, p, a) => m.exec(p, a),
  "fs": (m, p, a) => m.fs(p, a),
  "job.start": (m, p, a) => m.jobStart(p, a),
  "job.list": (m, p) => m.jobList(p),
  "job.logs": (m, p, a) => m.jobLogs(p, a),
  "job.stop": (m, p, a) => m.jobStop(p, a),
  "apt.install": (m, p, a) => m.aptInstall(p, a),
  "browser": (m, p, a) => m.browser(p, a),
};

export function readConfig(env = process.env) {
  const num = (k, d) => (env[k] != null && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  return {
    token: env.MACHINE_TOKEN ?? "",
    port: num("MACHINE_PORT", 8080),
    host: env.MACHINE_HOST || "0.0.0.0",
    root: env.MACHINE_ROOT || "/teams",
    stateDir: env.MACHINE_STATE || "/var/lib/team-machine",
    dry: env.MACHINE_DRY_RUN === "1",
    allowApt: env.MACHINE_ALLOW_APT === "1",
    nproc: num("MACHINE_MAX_PROCS", 512),
    fsizeKb: num("MACHINE_MAX_FILE_MB", 2048) * 1024,
    memKb: num("MACHINE_MAX_MEM_MB", 0) * 1024,
    execMaxSec: num("MACHINE_EXEC_MAX_SECONDS", 600),
    jobMaxHours: num("MACHINE_JOB_MAX_HOURS", 12),
    jobsPerAgent: num("MACHINE_JOBS_PER_AGENT", 8),
    shell: env.MACHINE_SHELL || "/bin/bash",
    browser: env.MACHINE_BROWSER !== "0",
    browserIdleSeconds: num("MACHINE_BROWSER_IDLE_SECONDS", 600),
  };
}

export function createMachine(config, log = (m) => console.log(m)) {
  const store = new StateStore(config.stateDir);
  const sys = new SystemOps({ root: config.root, dry: config.dry, log });
  const jobs = new JobTable({ dir: path.join(config.stateDir, "jobs"), maxPerAgent: config.jobsPerAgent, maxHours: config.jobMaxHours, log });
  return new Machine({ store, sys, jobs, config, log });
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

export function createServer(machine, config, log = (m) => console.log(m)) {
  const nonces = new NonceCache();
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://machine");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, version: VERSION });
    const m = /^\/v1\/([a-z._]+)$/.exec(url.pathname);
    if (req.method !== "POST" || !m) return send(res, 404, { ok: false, error: "not_found" });
    const op = m[1];

    const chunks = [];
    let size = 0;
    try {
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) return send(res, 413, { ok: false, error: "body_too_large" });
        chunks.push(c);
      }
    } catch {
      return send(res, 400, { ok: false, error: "bad_body" });
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const refusal = verifySignature({
      token: config.token, ts: req.headers["x-machine-ts"], signature: req.headers["x-machine-signature"], rawBody,
    });
    if (refusal) {
      log(`refus ${op} : ${refusal}`);
      return send(res, 401, { ok: false, error: refusal });
    }
    let body;
    try { body = JSON.parse(rawBody); } catch { return send(res, 400, { ok: false, error: "bad_json" }); }
    if (!nonces.claim(body?.nonce)) return send(res, 409, { ok: false, error: "replayed_request" });

    try {
      let result;
      if (ADMIN_OPS[op]) result = await ADMIN_OPS[op](machine, body);
      else if (AGENT_OPS[op]) result = await AGENT_OPS[op](machine, body.principal, body.args ?? {});
      else return send(res, 404, { ok: false, error: "unknown_op" });
      if (AGENT_OPS[op]) machine.record(op, body.principal, body.args, { status: 200, ms: Date.now() - started });
      log(`${op} ${body?.principal?.agent?.id?.slice?.(0, 8) ?? "-"} 200 ${Date.now() - started}ms`);
      return send(res, 200, { ok: true, result });
    } catch (e) {
      const status = e instanceof MachineError || e?.status ? e.status : 500;
      const code = e?.code && typeof e.code === "string" ? e.code : "internal_error";
      if (AGENT_OPS[op]) machine.record(op, body?.principal, body?.args, { status, code, ms: Date.now() - started });
      log(`${op} ${body?.principal?.agent?.id?.slice?.(0, 8) ?? "-"} ${status} ${code} ${Date.now() - started}ms`);
      return send(res, status, { ok: false, error: code, message: String(e?.message ?? e).slice(0, 800) });
    }
  });
}

/** Vérifie que l'isolement est possible ICI ; rend l'option bounding-set utilisable. */
function checkIsolation(config) {
  if (config.dry) return true;
  if (process.getuid?.() !== 0) throw new Error("le superviseur doit tourner en root dans le conteneur (il crée les utilisateurs des agents)");
  const base = ["--reuid=65534", "--regid=65534", "--clear-groups", "--no-new-privs", "--inh-caps=-all"];
  try {
    execFileSync("setpriv", [...base, "--bounding-set=-all", "--", "/bin/true"], { stdio: "ignore", env: {} });
    return true;
  } catch {
    try {
      execFileSync("setpriv", [...base, "--", "/bin/true"], { stdio: "ignore", env: {} });
      console.warn("setpriv : --bounding-set refusé (CAP_SETPCAP retirée ?) — les processus d'agents tournent quand même sans privilège.");
      return false;
    } catch (e) {
      throw new Error(`setpriv inutilisable : ${e.message} — l'isolement entre agents est impossible, arrêt.`);
    }
  }
}

async function main() {
  const config = readConfig();
  if (!config.token || config.token.length < 32) {
    console.error("MACHINE_TOKEN manquant ou trop court (32 caractères au moins) — arrêt.");
    process.exit(1);
  }
  config.boundingSet = checkIsolation(config);
  // Le jeton ne reste que dans la config : hors de l'environnement, il ne
  // risque plus d'être hérité par un sous-processus oublié.
  delete process.env.MACHINE_TOKEN;
  const machine = createMachine(config);
  await machine.boot();
  const server = createServer(machine, config);
  server.listen(config.port, config.host, () => {
    console.log(`team-machine ${VERSION} — ${config.root} — :${config.port}${config.dry ? " (DRY RUN)" : ""}${config.allowApt ? " — apt ouvert" : ""}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
}
