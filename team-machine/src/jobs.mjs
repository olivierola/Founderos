// Processus de fond d'un agent : un serveur de dev, un entraînement, un watcher.
//
// Leur sortie part dans un journal que root tient HORS des dossiers d'agents
// (voir l'en-tête de system.mjs) ; l'agent la lit par `job.logs`. Un job vit au
// plus MACHINE_JOB_MAX_HOURS, puis la machine l'arrête.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, statSync, readSync } from "node:fs";
import path from "node:path";
import { agentEnv, buildArgv } from "./exec.mjs";

export class JobTable {
  constructor({ dir, maxPerAgent = 8, maxHours = 12, log = () => {} }) {
    this.dir = dir;
    this.maxPerAgent = maxPerAgent;
    this.maxMs = maxHours * 3600_000;
    this.log = log;
    this.jobs = new Map();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  running(agentKey) {
    return [...this.jobs.values()].filter((j) => j.agentKey === agentKey && j.exitCode === undefined);
  }

  start(id, { agentKey, command, cwd, label, limits, options }) {
    if (this.running(agentKey).length >= this.maxPerAgent) {
      throw Object.assign(new Error(`déjà ${this.maxPerAgent} processus de fond en cours : arrêtes-en un (job.stop) avant d'en lancer un autre`), { status: 429, code: "too_many_jobs" });
    }
    const jobId = randomUUID().slice(0, 8);
    const logFile = path.join(this.dir, `${jobId}.log`);
    const fd = openSync(logFile, "a", 0o600);
    const [cmd, ...args] = buildArgv(id, cwd, ["/bin/bash", "-c", command], options);
    let child;
    try {
      child = spawn(cmd, args, { env: agentEnv(id, limits), detached: true, stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
    const job = {
      id: jobId, agentKey, command: command.slice(0, 500), label: String(label ?? "").slice(0, 80) || null,
      pid: child.pid, startedAt: new Date().toISOString(), exitCode: undefined, endedAt: null, logFile,
    };
    this.jobs.set(jobId, job);
    child.on("exit", (code, signal) => {
      job.exitCode = code ?? (signal ? `signal ${signal}` : null);
      job.endedAt = new Date().toISOString();
      clearTimeout(job.timer);
    });
    child.on("error", (e) => {
      job.exitCode = `erreur : ${e.message}`;
      job.endedAt = new Date().toISOString();
    });
    job.timer = setTimeout(() => this.stop(jobId, agentKey).catch(() => {}), this.maxMs);
    job.timer.unref?.();
    child.unref();
    return this.view(job);
  }

  view(j) {
    return {
      id: j.id, label: j.label, command: j.command, pid: j.pid, started_at: j.startedAt,
      running: j.exitCode === undefined, exit_code: j.exitCode === undefined ? null : j.exitCode, ended_at: j.endedAt,
    };
  }

  list(agentKey) {
    return [...this.jobs.values()].filter((j) => j.agentKey === agentKey).map((j) => this.view(j));
  }

  /** Tous les jobs dont l'agent passe le filtre, avec leur propriétaire — pour
   *  l'activité vue par un humain (la commande, jamais le journal). */
  listWhere(pred) {
    return [...this.jobs.values()].filter((j) => pred(j.agentKey)).map((j) => ({ ...this.view(j), agent_key: j.agentKey }));
  }

  get(jobId, agentKey) {
    const j = this.jobs.get(String(jobId));
    // Le job d'un autre agent n'existe pas, vu d'ici.
    if (!j || j.agentKey !== agentKey) throw Object.assign(new Error("processus introuvable"), { status: 404, code: "job_not_found" });
    return j;
  }

  logs(jobId, agentKey, tailBytes = 16_000) {
    const j = this.get(jobId, agentKey);
    let text = "";
    try {
      const size = statSync(j.logFile).size;
      const len = Math.min(size, Math.max(512, Math.min(tailBytes, 200_000)));
      const buf = Buffer.alloc(len);
      const fd = openSync(j.logFile, "r");
      try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
      text = buf.toString("utf8");
      if (size > len) text = `…[${size - len} octets plus anciens omis]…\n${text}`;
    } catch { /* journal vide */ }
    return { ...this.view(j), output: text };
  }

  async stop(jobId, agentKey) {
    const j = this.get(jobId, agentKey);
    if (j.exitCode !== undefined) return this.view(j);
    try { process.kill(-j.pid, "SIGTERM"); } catch { /* fini */ }
    await new Promise((r) => setTimeout(r, 1500));
    if (j.exitCode === undefined) { try { process.kill(-j.pid, "SIGKILL"); } catch { /* fini */ } }
    return this.view(j);
  }

  /** Arrête tous les jobs qui correspondent (un agent retiré, une équipe suspendue). */
  async stopWhere(pred) {
    const victims = [...this.jobs.values()].filter((j) => j.exitCode === undefined && pred(j));
    await Promise.all(victims.map((j) => this.stop(j.id, j.agentKey).catch(() => {})));
    return victims.length;
  }
}
