// L'état de la machine : qui est qui, et quelles empreintes de secrets.
//
// Un seul fichier JSON dans le volume d'état (root, 0600). Il est la source de
// vérité des identités : /etc/passwd et /etc/group vivent dans la couche du
// conteneur et disparaissent à sa recréation — au démarrage, la machine les
// reconstruit d'ici (system.mjs, reconcile).
//
// Les secrets eux-mêmes n'y sont JAMAIS : seulement leur SHA-256.

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

/** Utilisateurs (un par agent, avec son groupe privé du même numéro). */
export const UID_MIN = 20000;
export const UID_MAX = 39999;
/** Groupes partagés : équipes et dossiers protégés. */
export const GID_MIN = 40000;
export const GID_MAX = 59999;

export function emptyState() {
  return { version: 1, nextUid: UID_MIN, nextGid: GID_MIN, teams: {}, agents: {}, folders: {} };
}

export const agentKey = (teamId, agentId) => `${teamId}:${agentId}`;

export class StateStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "state.json");
    this.data = emptyState();
    this.queue = Promise.resolve();
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      this.data = { ...emptyState(), ...raw };
    } catch (e) {
      if (e?.code !== "ENOENT") throw new Error(`état illisible (${this.file}) : ${e.message}`);
      this.data = emptyState();
      await this.persist();
    }
    return this.data;
  }

  /** Une modification à la fois, écrite avant de rendre la main. */
  mutate(fn) {
    const run = this.queue.then(async () => {
      const out = await fn(this.data);
      await this.persist();
      return out;
    });
    // La file continue même si une modification échoue.
    this.queue = run.catch(() => {});
    return run;
  }

  async persist() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    await rename(tmp, this.file);
    await chmod(this.file, 0o600).catch(() => {});
  }

  allocUid() {
    const used = new Set(Object.values(this.data.agents).map((a) => a.uid));
    let n = Math.max(this.data.nextUid, UID_MIN);
    while (used.has(n)) n++;
    if (n > UID_MAX) throw new Error("plus d'identifiant utilisateur disponible");
    this.data.nextUid = n + 1;
    return n;
  }

  allocGid() {
    const used = new Set([
      ...Object.values(this.data.teams).map((t) => t.gid),
      ...Object.values(this.data.folders).map((f) => f.gid),
    ]);
    let n = Math.max(this.data.nextGid, GID_MIN);
    while (used.has(n)) n++;
    if (n > GID_MAX) throw new Error("plus d'identifiant de groupe disponible");
    this.data.nextGid = n + 1;
    return n;
  }

  /** Un nom d'utilisateur libre, dérivé de celui proposé. */
  freeUserName(wanted) {
    const taken = new Set(Object.values(this.data.agents).map((a) => a.user));
    if (!taken.has(wanted)) return wanted;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${wanted.slice(0, 28)}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error("aucun nom d'utilisateur libre");
  }

  freeTeamKey(wanted, teamId) {
    const owner = Object.entries(this.data.teams).find(([, t]) => t.key === wanted);
    if (!owner || owner[0] === teamId) return wanted;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${wanted.slice(0, 22)}-${i}`;
      if (!Object.values(this.data.teams).some((t) => t.key === candidate)) return candidate;
    }
    throw new Error("aucun nom d'équipe libre");
  }
}
