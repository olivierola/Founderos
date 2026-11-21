// La machine d'équipe : ce qu'elle sait faire, indépendamment de HTTP.
//
// Deux sortes d'opérations :
//   - d'ADMINISTRATION (équipe, agent, dossier) : la signature de la
//     plateforme suffit. Elles créent, suspendent, archivent — elles ne lisent
//     jamais le travail de personne.
//   - au NOM D'UN AGENT (exec, fichiers, jobs) : il faut en plus le « principal »,
//     c'est-à-dire le secret de l'agent et celui de chaque dossier protégé qu'il
//     ouvre. Chaque secret est comparé à l'empreinte gardée ici ; seul un secret
//     juste ajoute le groupe Linux du dossier au processus. Sans lui, le noyau
//     refuse l'accès — quelle que soit la requête.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, stat } from "node:fs/promises";
import {
  FOLDER_RE, PACKAGE_RE, TEAM_KEY_RE, USER_RE, clampInt, isSafeAbsolutePath, isSecret, isTeamId, isUuid,
  secretMatches, sha256Hex, slugify,
} from "./names.mjs";
import { agentKey } from "./state.mjs";
import { runAs } from "./exec.mjs";
import { BrowserPool, browserInstalled } from "./browser.mjs";
import { Recorder, describeOp } from "./recorder.mjs";

export class MachineError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

const bad = (code, message) => new MachineError(400, code, message);

export const VERSION = "0.3.0";

export class Machine {
  /**
   * @param {{ store: import("./state.mjs").StateStore, sys: import("./system.mjs").SystemOps,
   *   jobs: import("./jobs.mjs").JobTable, config: Record<string, any>, log?: (m: string) => void }} deps
   */
  constructor({ store, sys, jobs, config, log = () => {} }) {
    this.store = store;
    this.sys = sys;
    this.jobs = jobs;
    this.config = config;
    this.log = log;
    this.fsopPath = config.fsopPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "fsop.mjs");
    this.aptQueue = Promise.resolve();
    this.recorder = new Recorder({ file: config.stateDir ? path.join(config.stateDir, "recorder.json") : null });
    this.browsers = config.stateDir ? new BrowserPool({ stateDir: config.stateDir, idleSeconds: config.browserIdleSeconds ?? 600, log }) : null;
  }

  /** Un navigateur est possible ici : Playwright dans l'image, pas de mode dry, pas désactivé. */
  get browserReady() {
    return !!this.browsers && !this.sys.dry && this.config.browser !== false && browserInstalled();
  }

  get state() { return this.store.data; }

  execOptions() {
    return { dry: this.sys.dry, boundingSet: this.config.boundingSet !== false, shell: this.config.shell ?? "/bin/bash" };
  }

  /** Charge l'état et remet le système d'aplomb (utilisateurs, groupes, droits). */
  async boot() {
    await this.store.load();
    await this.recorder.load();
    await this.sys.ensureRoot();
    for (const team of Object.values(this.state.teams)) {
      await this.sys.ensureTeamTree(team).catch((e) => this.log(`équipe ${team.key} : ${e.message}`));
    }
    for (const a of Object.values(this.state.agents)) {
      await this.sys.ensureAgentHome(a).catch((e) => this.log(`agent ${a.user} : ${e.message}`));
    }
    for (const f of Object.values(this.state.folders)) {
      if (!f.archived) await this.sys.ensureFolderDir(f).catch((e) => this.log(`dossier ${f.path} : ${e.message}`));
    }
  }

  team(teamId) {
    const t = this.state.teams[teamId];
    if (!t) throw new MachineError(404, "team_unknown", "équipe inconnue de la machine");
    return t;
  }

  // ── Administration ────────────────────────────────────────────────────────

  async teamEnsure({ team }) {
    if (!isTeamId(team?.id)) throw bad("bad_team", "team.id invalide");
    const wanted = TEAM_KEY_RE.test(team?.key ?? "") ? team.key : slugify(team?.name || team.id, 20);
    const t = await this.store.mutate((s) => {
      const cur = s.teams[team.id];
      if (cur) {
        if (team.name) cur.name = String(team.name).slice(0, 80);
        return cur;
      }
      const key = this.store.freeTeamKey(wanted, team.id);
      const created = {
        id: team.id, key, name: String(team.name ?? key).slice(0, 80),
        group: `eq-${key}`, gid: this.store.allocGid(), suspended: false, createdAt: new Date().toISOString(),
      };
      s.teams[team.id] = created;
      return created;
    });
    const p = await this.sys.ensureTeamTree(t);
    return { key: t.key, path: p.dir, common: p.common, folders: p.folders, suspended: t.suspended };
  }

  async teamSuspend({ team, suspended }) {
    const t = this.team(team?.id);
    await this.store.mutate(() => { t.suspended = !!suspended; });
    let stopped = 0;
    if (t.suspended) {
      const uids = new Set(this.agentsOf(t.id).map((a) => a.uid));
      stopped += await this.jobs.stopWhere((j) => j.agentKey.startsWith(`${t.id}:`));
      stopped += await this.sys.kill((p) => uids.has(p.uid));
    }
    return { suspended: t.suspended, stopped };
  }

  agentsOf(teamId) {
    return Object.values(this.state.agents).filter((a) => a.teamId === teamId);
  }

  async agentEnsure({ team, agent }) {
    const t = this.team(team?.id);
    if (!isUuid(agent?.id)) throw bad("bad_agent", "agent.id invalide");
    if (!isSecret(agent?.secret)) throw bad("bad_secret", "agent.secret absent ou trop court");
    const key = agentKey(t.id, agent.id);
    const a = await this.store.mutate((s) => {
      const cur = s.agents[key];
      if (cur) {
        if (!secretMatches(agent.secret, cur.secretHash)) {
          throw new MachineError(409, "agent_secret_mismatch",
            "cet agent existe déjà sur la machine avec un autre secret — un humain doit le réinitialiser (agent.reset_secret)");
        }
        if (agent.name) cur.name = String(agent.name).slice(0, 80);
        return cur;
      }
      const wanted = USER_RE.test(agent.user ?? "") ? agent.user : `${slugify(agent.name || "agent", 20)}-${agent.id.slice(0, 4)}`;
      const user = this.store.freeUserName(wanted);
      const created = {
        teamId: t.id, agentId: agent.id, user, uid: this.store.allocUid(),
        name: String(agent.name ?? user).slice(0, 80), secretHash: sha256Hex(agent.secret),
        home: path.posix.join(this.sys.teamPaths(t.key).home, user), createdAt: new Date().toISOString(),
      };
      s.agents[key] = created;
      return created;
    });
    await this.sys.ensureAgentHome(a);
    return { user: a.user, uid: a.uid, home: a.home };
  }

  /** Un humain a perdu (ou veut changer) le secret d'un agent : ses fichiers restent. */
  async agentResetSecret({ team, agent }) {
    const t = this.team(team?.id);
    if (!isSecret(agent?.secret)) throw bad("bad_secret", "agent.secret absent ou trop court");
    const key = agentKey(t.id, agent?.id);
    const a = this.state.agents[key];
    if (!a) throw new MachineError(404, "agent_unknown", "agent inconnu de la machine");
    await this.store.mutate(() => { a.secretHash = sha256Hex(agent.secret); });
    // Ce qui tournait avec l'ancienne identité s'arrête.
    const stopped = (await this.jobs.stopWhere((j) => j.agentKey === key)) + (await this.sys.kill((p) => p.uid === a.uid));
    return { user: a.user, reset: true, stopped };
  }

  async folderCreate({ team, folder }) {
    const t = this.team(team?.id);
    if (!isUuid(folder?.id)) throw bad("bad_folder", "folder.id invalide");
    if (!FOLDER_RE.test(folder?.name ?? "")) throw bad("bad_folder_name", "nom de dossier invalide (a-z, 0-9, . _ -, 48 caractères)");
    if (!isSecret(folder?.secret)) throw bad("bad_secret", "folder.secret absent ou trop court");
    const f = await this.store.mutate((s) => {
      const cur = s.folders[folder.id];
      if (cur) {
        if (cur.teamId !== t.id) throw new MachineError(409, "folder_conflict", "ce dossier appartient à une autre équipe");
        if (!secretMatches(folder.secret, cur.secretHash)) throw new MachineError(409, "folder_secret_mismatch", "dossier déjà créé avec un autre secret");
        return cur;
      }
      const taken = Object.values(s.folders).some((x) => x.teamId === t.id && !x.archived && x.name === folder.name);
      if (taken) throw new MachineError(409, "folder_name_taken", `un dossier « ${folder.name} » existe déjà dans l'équipe`);
      const created = {
        id: folder.id, teamId: t.id, name: folder.name,
        group: `dp-${slugify(folder.name, 16)}-${folder.id.slice(0, 6)}`, gid: this.store.allocGid(),
        path: path.posix.join(this.sys.teamPaths(t.key).folders, folder.name),
        secretHash: sha256Hex(folder.secret), archived: false, createdAt: new Date().toISOString(),
      };
      s.folders[folder.id] = created;
      return created;
    });
    await this.sys.ensureFolderDir(f);
    return { path: f.path, group: f.group };
  }

  folderOf(id) {
    const f = this.state.folders[id];
    if (!f) throw new MachineError(404, "folder_unknown", "dossier inconnu de la machine");
    return f;
  }

  /** Tue ce qui tourne avec le groupe du dossier — pour un agent, ou pour tous. */
  async dropFolderHolders(f, agentUid = null) {
    return this.sys.kill((p) => p.groups.includes(f.gid) && (agentUid == null || p.uid === agentUid));
  }

  /** Change le secret. Il faut l'ancien, sauf `force` (décision humaine). */
  async folderRotate({ folder, force }) {
    const f = this.folderOf(folder?.id);
    if (!isSecret(folder?.new_secret)) throw bad("bad_secret", "folder.new_secret absent ou trop court");
    if (!force && !secretMatches(folder?.secret, f.secretHash)) throw new MachineError(403, "folder_secret_invalid", "ancien secret invalide");
    await this.store.mutate(() => { f.secretHash = sha256Hex(folder.new_secret); f.rotatedAt = new Date().toISOString(); });
    // Les processus ouverts avec l'ancien secret perdent l'accès.
    const stopped = await this.dropFolderHolders(f);
    return { rotated: true, stopped };
  }

  /** Un agent sort d'un dossier : ses processus qui le tenaient ouvert s'arrêtent. */
  async folderRevoke({ folder, agent }) {
    const f = this.folderOf(folder?.id);
    const a = this.state.agents[agentKey(f.teamId, agent?.id)];
    if (!a) return { stopped: 0 };
    return { stopped: await this.dropFolderHolders(f, a.uid) };
  }

  async folderArchive({ folder }) {
    const f = this.folderOf(folder?.id);
    if (f.archived) return { archived: true, path: f.archivedPath ?? null };
    const t = this.team(f.teamId);
    const stopped = await this.dropFolderHolders(f);
    const target = await this.sys.archiveFolder(t, f);
    await this.store.mutate(() => { f.archived = true; f.archivedPath = target; f.secretHash = "0".repeat(64); });
    return { archived: true, path: target, stopped };
  }

  async status({ teams, usage } = {}) {
    const wanted = Array.isArray(teams) ? new Set(teams.map(String)) : null;
    const out = [];
    for (const t of Object.values(this.state.teams)) {
      if (wanted && !wanted.has(t.id)) continue;
      const agents = this.agentsOf(t.id).map((a) => ({
        id: a.agentId, user: a.user, uid: a.uid, name: a.name, home: a.home,
        jobs_running: this.jobs.running(agentKey(t.id, a.agentId)).length,
      }));
      const folders = Object.values(this.state.folders).filter((f) => f.teamId === t.id && !f.archived)
        .map((f) => ({ id: f.id, name: f.name, path: f.path, group: f.group }));
      out.push({
        id: t.id, key: t.key, name: t.name, path: this.sys.teamPaths(t.key).dir, suspended: t.suspended, agents, folders,
        usage_kb: usage ? await this.sys.diskUsageKb(this.sys.teamPaths(t.key).dir) : null,
      });
    }
    return { version: VERSION, apt: !!this.config.allowApt, teams: out };
  }

  /** La machine elle-même : charge, mémoire, disque, limites. Rien sur le travail des agents. */
  async info() {
    return {
      version: VERSION,
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      uptime_s: Math.round(os.uptime()),
      cpus: os.cpus().length,
      load: os.loadavg().map((x) => Math.round(x * 100) / 100),
      mem: { total_kb: Math.round(os.totalmem() / 1024), free_kb: Math.round(os.freemem() / 1024) },
      disk: await this.sys.diskOf(this.config.root ?? "/teams"),
      apt: !!this.config.allowApt,
      browser: this.browserReady,
      dry: !!this.sys.dry,
      limits: {
        procs_per_agent: this.config.nproc ?? 512,
        file_mb: Math.round((this.config.fsizeKb ?? 2 * 1024 * 1024) / 1024),
        exec_max_s: this.config.execMaxSec ?? 600,
        job_max_h: this.config.jobMaxHours ?? 12,
        jobs_per_agent: this.config.jobsPerAgent ?? 8,
      },
    };
  }

  /**
   * Ce qui tourne, pour les équipes demandées SEULEMENT : une machine peut
   * servir plusieurs espaces de travail, et chacun ne voit que les siennes.
   * On rend les commandes (`ps` les montre déjà aux agents), jamais un journal
   * ni un fichier : pour lire, il faut passer par un agent et ses secrets.
   */
  async activity({ teams, since } = {}) {
    const wanted = new Set((Array.isArray(teams) ? teams : []).map(String).filter(isTeamId));
    const sinceIso = typeof since === "string" && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : null;
    const agents = Object.values(this.state.agents).filter((a) => wanted.has(a.teamId));
    const byUid = new Map(agents.map((a) => [a.uid, a]));
    const byKey = new Map(agents.map((a) => [agentKey(a.teamId, a.agentId), a]));
    const uids = new Set(byUid.keys());
    const procs = await this.sys.processDetails(uids);
    const ports = await this.sys.listeners(uids);
    const history = this.recorder.forTeams(wanted, { since: sinceIso });
    const browsers = [];
    if (this.browsers) {
      for (const a of agents) {
        const p = this.browsers.paths(a);
        if (await this.browsers.alive(p.socket)) browsers.push({ team_id: a.teamId, agent_id: a.agentId, user: a.user });
      }
    }
    const jobs = this.jobs.listWhere((k) => byKey.has(k)).map(({ agent_key, ...j }) => {
      const a = byKey.get(agent_key);
      return { ...j, team_id: a.teamId, agent_id: a.agentId, user: a.user };
    });
    return {
      processes: procs.map(({ uid, ...p }) => {
        const a = byUid.get(uid);
        return { ...p, team_id: a.teamId, agent_id: a.agentId, user: a.user };
      }),
      jobs: jobs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).slice(0, 200),
      execs: history.execs,
      events: history.events,
      listeners: ports.map(({ uid, ...l }) => {
        const a = byUid.get(uid);
        return { ...l, team_id: a.teamId, agent_id: a.agentId, user: a.user };
      }),
      browsers,
      teams: [...wanted].filter((id) => this.state.teams[id]).map((id) => {
        const t = this.state.teams[id];
        return { id, key: t.key, suspended: t.suspended, agents: this.agentsOf(id).length };
      }),
    };
  }

  // ── Au nom d'un agent ─────────────────────────────────────────────────────

  /** Le principal → l'identité Unix d'un processus. */
  resolve(principal) {
    if (!principal || typeof principal !== "object") throw bad("missing_principal", "principal requis");
    const t = this.team(principal.team?.id);
    if (t.suspended) throw new MachineError(423, "team_suspended", "la machine de cette équipe est suspendue");
    const key = agentKey(t.id, principal.agent?.id);
    const a = this.state.agents[key];
    if (!a) throw new MachineError(404, "agent_unknown", "agent inconnu de la machine");
    if (!secretMatches(principal.agent?.secret, a.secretHash)) throw new MachineError(403, "agent_secret_invalid", "secret d'agent invalide");
    const groups = [t.gid];
    const opened = [];
    const refused = [];
    for (const g of (Array.isArray(principal.folders) ? principal.folders : []).slice(0, 64)) {
      const f = this.state.folders[g?.id];
      if (f && f.teamId === t.id && !f.archived && secretMatches(g?.secret, f.secretHash)) {
        groups.push(f.gid);
        opened.push(f.name);
      } else {
        refused.push(String(g?.id ?? "").slice(0, 40));
      }
    }
    return {
      uid: a.uid, gid: a.uid, groups, user: a.user, home: a.home, agentKey: key,
      teamDir: this.sys.teamPaths(t.key).dir, opened, refused,
    };
  }

  limits() {
    return { nproc: this.config.nproc ?? 512, fsizeKb: this.config.fsizeKb ?? 2 * 1024 * 1024, memKb: this.config.memKb ?? 0 };
  }

  cwdFor(id, cwd) {
    const raw = String(cwd ?? "").trim();
    if (!raw || raw === "~") return id.home;
    const p = raw.startsWith("~/") ? path.posix.join(id.home, raw.slice(2)) : raw.startsWith("/") ? raw : path.posix.join(id.home, raw);
    if (!isSafeAbsolutePath(p)) throw bad("bad_cwd", "dossier de travail invalide");
    return path.posix.normalize(p);
  }

  async exec(principal, { command, cwd, timeout }) {
    if (typeof command !== "string" || !command.trim()) throw bad("missing_command", "command requis");
    if (command.length > 64_000) throw bad("command_too_long", "commande trop longue — écris un script avec fs.write puis lance-le");
    const id = this.resolve(principal);
    const max = this.config.execMaxSec ?? 600;
    const dir = this.cwdFor(id, cwd);
    const done = this.recorder.execStart(id, { command, cwd: dir });
    const r = await runAs(id, {
      argv: ["/bin/bash", "-c", command], cwd: dir,
      timeoutMs: clampInt(timeout, 1, max, 120) * 1000, limits: this.limits(), options: this.execOptions(),
    });
    done(r);
    return {
      exit_code: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr,
      truncated: r.truncated, timed_out: r.timedOut, duration_ms: r.durationMs, user: id.user, refused_folders: id.refused,
    };
  }

  async fs(principal, request) {
    if (!request || typeof request !== "object" || typeof request.op !== "string") throw bad("bad_fs_request", "request.op requis");
    const id = this.resolve(principal);
    const r = await runAs(id, {
      argv: [process.execPath, this.fsopPath], cwd: id.home, stdin: JSON.stringify(request),
      timeoutMs: 60_000, maxOutput: 4 * 1024 * 1024, limits: this.limits(), options: this.execOptions(),
    });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* voir plus bas */ }
    if (!parsed) throw new MachineError(500, "fs_failed", (r.stderr || r.stdout || "opération de fichier sans réponse").slice(0, 600));
    if (!parsed.ok) throw new MachineError(422, parsed.code === "EACCES" || parsed.code === "EPERM" ? "access_denied" : "fs_error", parsed.error);
    return parsed.result;
  }

  jobStart(principal, { command, cwd, label }) {
    if (typeof command !== "string" || !command.trim()) throw bad("missing_command", "command requis");
    const id = this.resolve(principal);
    return this.jobs.start(id, {
      agentKey: id.agentKey, command, cwd: this.cwdFor(id, cwd), label, limits: this.limits(), options: this.execOptions(),
    });
  }

  jobList(principal) {
    const id = this.resolve(principal);
    return { jobs: this.jobs.list(id.agentKey) };
  }

  jobLogs(principal, { id: jobId, tail }) {
    const id = this.resolve(principal);
    return this.jobs.logs(jobId, id.agentKey, clampInt(tail, 512, 200_000, 16_000));
  }

  async jobStop(principal, { id: jobId }) {
    const id = this.resolve(principal);
    return this.jobs.stop(jobId, id.agentKey);
  }

  /** Une opération d'agent, inscrite au fil (appelé par le serveur). */
  record(op, principal, args, { status, code = null, ms }) {
    const teamId = String(principal?.team?.id ?? "");
    const agentId = String(principal?.agent?.id ?? "");
    if (!teamId || !agentId) return;
    const a = this.state.agents[agentKey(teamId, agentId)];
    this.recorder.event({ team_id: teamId, agent_id: agentId, user: a?.user ?? null, op, detail: describeOp(op, args), status, code, ms });
  }

  /** L'écran du navigateur d'un agent, s'il est ouvert (opération d'administration). */
  async browserView({ team, agent }) {
    const a = this.state.agents[agentKey(String(team?.id ?? ""), String(agent?.id ?? ""))];
    if (!a || !this.browsers) return { open: false };
    const view = await this.browsers.peek({ ...a, agentKey: agentKey(a.teamId, a.agentId) });
    return view ? { open: true, ...view } : { open: false };
  }

  /** Le navigateur de l'agent (browser.mjs) : ouvrir, cliquer, remplir, capturer. */
  async browser(principal, args) {
    const id = this.resolve(principal);
    if (!this.browserReady) {
      throw new MachineError(501, "browser_unavailable", "pas de navigateur sur cette machine (image sans Chromium, ou mode test)");
    }
    if (!args || typeof args.action !== "string") throw bad("missing_action", "action requise");
    return this.browsers.call(id, args, { limits: this.limits(), options: this.execOptions() });
  }

  /** Paquets système : partagés par toute la machine, installés par root. */
  async aptInstall(principal, { packages }) {
    if (!this.config.allowApt) throw new MachineError(403, "apt_disabled", "l'installation de paquets système est fermée sur cette machine");
    this.resolve(principal);
    const list = (Array.isArray(packages) ? packages : []).map(String);
    if (!list.length || list.length > 20) throw bad("bad_packages", "1 à 20 paquets");
    const invalid = list.filter((p) => !PACKAGE_RE.test(p));
    if (invalid.length) throw bad("bad_packages", `noms refusés : ${invalid.join(", ")}`);
    const run = this.aptQueue.then(async () => {
      if (this.sys.dry) return { installed: list, output: "(dry)" };
      const lists = await readdir("/var/lib/apt/lists").catch(() => []);
      const fresh = await stat("/var/lib/apt/lists").then((s) => Date.now() - s.mtimeMs < 6 * 3600_000, () => false);
      let output = "";
      if (lists.length < 3 || !fresh) output += await this.sys.run("apt-get", ["update", "-q"], { timeoutMs: 300_000 });
      output += await this.sys.run("apt-get", ["install", "-y", "-q", "--no-install-recommends", ...list], { timeoutMs: 600_000 });
      return { installed: list, output: output.slice(-6000) };
    });
    this.aptQueue = run.catch(() => {});
    return run;
  }
}
