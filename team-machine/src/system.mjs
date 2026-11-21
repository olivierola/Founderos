// Ce que la machine fait en root : groupes, utilisateurs, dossiers, signaux.
//
// Arborescence d'une équipe (clé k) :
//
//   /teams                      root:root      0711  on traverse, on ne liste pas les équipes
//   /teams/k                    root:équipe    0750  seuls les membres de l'équipe entrent
//   /teams/k/home               root:équipe    0750  la liste des collègues
//   /teams/k/home/<agent>       agent:agent    0700  le dossier PERSO — personne d'autre
//   /teams/k/commun             root:équipe    2770  partagé par toute l'équipe (setgid)
//   /teams/k/dossiers           root:équipe    0710  on traverse, on ne liste pas : un nom
//                                                    de dossier protégé peut déjà en dire trop
//   /teams/k/dossiers/<nom>     root:dossier   2770  les seuls membres du dossier
//   /teams/k/.archives          root:root      0700  les dossiers retirés, hors d'atteinte
//
// Règle tenue partout : root n'écrit JAMAIS dans un répertoire qu'un agent
// contrôle (son dossier perso, commun, un dossier protégé). Un agent pourrait y
// poser un lien symbolique vers /etc ; root le suivrait. Ce qui doit exister
// chez un agent est créé PAR l'agent (le préambule de exec.mjs).

import { execFile } from "node:child_process";
import { chmod, chown, lstat, mkdir, readdir, readFile, readlink, rename, statfs } from "node:fs/promises";
import path from "node:path";

export class SystemOps {
  /**
   * @param {{ root: string, dry?: boolean, log?: (m: string) => void }} opts
   *  dry : ni groupadd, ni useradd, ni chown — pour les tests hors Linux.
   */
  constructor({ root, dry = false, log = () => {} }) {
    this.root = root;
    this.dry = dry;
    this.log = log;
  }

  run(cmd, args, { timeoutMs = 30_000 } = {}) {
    // Jamais l'environnement du superviseur (MACHINE_TOKEN) dans un sous-processus.
    const env = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", DEBIAN_FRONTEND: "noninteractive", LANG: "C.UTF-8" };
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env },
        (err, stdout, stderr) => {
          if (err) {
            const e = new Error(`${cmd} ${args.join(" ")} : ${String(stderr || err.message).trim().slice(0, 400)}`);
            e.code = err.code;
            reject(e);
          } else resolve(String(stdout));
        });
    });
  }

  async exists(kind, name) {
    if (this.dry) return true;
    try {
      await this.run("getent", [kind, name]);
      return true;
    } catch {
      return false;
    }
  }

  async ensureGroup(name, gid) {
    if (this.dry || await this.exists("group", name)) return;
    await this.run("groupadd", ["-g", String(gid), name]);
  }

  async removeGroup(name) {
    if (this.dry || !(await this.exists("group", name))) return;
    await this.run("groupdel", [name]).catch((e) => this.log(`groupdel ${name} : ${e.message}`));
  }

  /** L'utilisateur d'un agent, avec son groupe privé du même numéro. */
  async ensureUser({ user, uid, home, gecos }) {
    if (this.dry) return;
    await this.ensureGroup(user, uid);
    if (await this.exists("passwd", user)) return;
    const comment = String(gecos ?? "").replace(/[:\n,]/g, " ").slice(0, 60) || user;
    await this.run("useradd", ["-u", String(uid), "-g", String(uid), "-M", "-d", home, "-s", "/bin/bash", "-c", comment, user]);
  }

  /** Crée (ou remet d'aplomb) un répertoire que root possède ou attribue.
   *  Refuse un lien symbolique à sa place : voir l'en-tête. */
  async ensureDir(p, { uid = 0, gid = 0, mode }) {
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${p} n'est pas un répertoire`);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
      await mkdir(p, { mode });
    }
    if (!this.dry) await chown(p, uid, gid);
    // chmod après chown : chown efface les bits setuid/setgid.
    await chmod(p, mode).catch((e) => { if (!this.dry) throw e; });
  }

  teamPaths(key) {
    const dir = path.posix.join(this.root, key);
    return {
      dir,
      home: path.posix.join(dir, "home"),
      common: path.posix.join(dir, "commun"),
      folders: path.posix.join(dir, "dossiers"),
      archives: path.posix.join(dir, ".archives"),
    };
  }

  async ensureRoot() {
    await mkdir(this.root, { recursive: true });
    await this.ensureDir(this.root, { mode: 0o711 });
  }

  async ensureTeamTree(team) {
    const p = this.teamPaths(team.key);
    await this.ensureGroup(team.group, team.gid);
    await this.ensureDir(p.dir, { gid: team.gid, mode: 0o750 });
    await this.ensureDir(p.home, { gid: team.gid, mode: 0o750 });
    await this.ensureDir(p.common, { gid: team.gid, mode: 0o2770 });
    await this.ensureDir(p.folders, { gid: team.gid, mode: 0o710 });
    await this.ensureDir(p.archives, { mode: 0o700 });
    return p;
  }

  async ensureAgentHome(agent) {
    await this.ensureUser(agent);
    await this.ensureDir(agent.home, { uid: agent.uid, gid: agent.uid, mode: 0o700 });
  }

  async ensureFolderDir(folder) {
    await this.ensureGroup(folder.group, folder.gid);
    await this.ensureDir(folder.path, { gid: folder.gid, mode: 0o2770 });
  }

  /** Retire un dossier protégé hors d'atteinte des agents, sans rien effacer. */
  async archiveFolder(team, folder) {
    const p = this.teamPaths(team.key);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.posix.join(p.archives, `${path.posix.basename(folder.path)}-${stamp}`);
    try {
      await rename(folder.path, target);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
      return null;
    }
    if (!this.dry) await chown(target, 0, 0);
    await chmod(target, 0o700).catch(() => {});
    await this.removeGroup(folder.group);
    return target;
  }

  /** Les processus vivants, avec leur uid réel et leurs groupes. */
  async processes() {
    if (this.dry) return [];
    const out = [];
    for (const name of await readdir("/proc").catch(() => [])) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const status = await readFile(`/proc/${name}/status`, "utf8");
        const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
        const groups = (/^Groups:\s*(.*)$/m.exec(status)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
        out.push({ pid: Number(name), uid, groups });
      } catch { /* processus disparu entre-temps */ }
    }
    return out;
  }

  /**
   * Le détail des processus de certains uids : ligne de commande, mémoire,
   * temps CPU et âge. Lu dans /proc ; rien n'est lancé.
   */
  async processDetails(uids) {
    if (this.dry || !uids.size) return [];
    const tick = 100; // CLK_TCK sous Linux
    const uptime = Number((await readFile("/proc/uptime", "utf8").catch(() => "0")).split(/\s+/)[0]) || 0;
    const out = [];
    for (const p of await this.processes()) {
      if (!uids.has(p.uid)) continue;
      try {
        const [cmdline, status, stat] = await Promise.all([
          readFile(`/proc/${p.pid}/cmdline`, "utf8"),
          readFile(`/proc/${p.pid}/status`, "utf8"),
          readFile(`/proc/${p.pid}/stat`, "utf8"),
        ]);
        // Le nom du programme est entre parenthèses et peut contenir des espaces.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const cpu = (Number(fields[11]) + Number(fields[12])) / tick;
        const age = Math.max(0, uptime - Number(fields[19]) / tick);
        out.push({
          pid: p.pid, uid: p.uid,
          state: fields[0],
          command: cmdline.replace(/\0+$/, "").replace(/\0/g, " ").slice(0, 300) || `[${/^Name:\s+(.*)$/m.exec(status)?.[1] ?? "?"}]`,
          rss_kb: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0),
          cpu_s: Math.round(cpu * 10) / 10,
          age_s: Math.round(age),
        });
      } catch { /* processus disparu entre-temps */ }
    }
    return out.sort((a, b) => b.cpu_s - a.cpu_s).slice(0, 200);
  }

  /**
   * Les ports en écoute ouverts par des processus de ces uids : les serveurs
   * que les agents ont lancés (une appli web, une API, un notebook…).
   */
  async listeners(uids) {
    if (this.dry || !uids.size) return [];
    const inodes = new Map();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      const text = await readFile(file, "utf8").catch(() => "");
      for (const line of text.split("\n").slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 10 || f[3] !== "0A") continue; // 0A = LISTEN
        const [hexAddr, hexPort] = f[1].split(":");
        const port = parseInt(hexPort, 16);
        const local = /^0+$/.test(hexAddr) ? "toutes" : hexAddr === "0100007F" || hexAddr === "00000000000000000000000001000000" ? "localhost" : "réseau";
        inodes.set(f[9], { port, address: local, uid: Number(f[7]) });
      }
    }
    if (!inodes.size) return [];
    const out = [];
    for (const p of await this.processes()) {
      if (!uids.has(p.uid)) continue;
      const fds = await readdir(`/proc/${p.pid}/fd`).catch(() => []);
      for (const fd of fds) {
        const link = await readlink(`/proc/${p.pid}/fd/${fd}`).catch(() => "");
        const m = /^socket:\[(\d+)\]$/.exec(link);
        const l = m && inodes.get(m[1]);
        if (!l || out.some((x) => x.port === l.port && x.pid === p.pid)) continue;
        const cmd = (await readFile(`/proc/${p.pid}/cmdline`, "utf8").catch(() => "")).replace(/\0+$/, "").replace(/\0/g, " ");
        out.push({ port: l.port, address: l.address, pid: p.pid, uid: p.uid, command: cmd.slice(0, 200) });
      }
    }
    return out.sort((a, b) => a.port - b.port);
  }

  /** La place sur le volume des équipes. */
  async diskOf(dir) {
    try {
      const s = await statfs(dir);
      return { total_kb: Math.round((s.blocks * s.bsize) / 1024), free_kb: Math.round((s.bavail * s.bsize) / 1024) };
    } catch {
      return null;
    }
  }

  /** Tue les processus qui correspondent. Rend leur nombre. */
  async kill(pred) {
    let n = 0;
    for (const p of await this.processes()) {
      if (p.uid < 1000 || !pred(p)) continue; // jamais root ni un compte système
      try { process.kill(p.pid, "SIGKILL"); n++; } catch { /* déjà parti */ }
    }
    return n;
  }

  async diskUsageKb(dir) {
    if (this.dry) return null;
    try {
      const out = await this.run("du", ["-sk", dir], { timeoutMs: 15_000 });
      return Number(out.split(/\s+/)[0]) || 0;
    } catch {
      return null;
    }
  }
}
