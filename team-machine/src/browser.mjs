// Les navigateurs des agents, côté superviseur.
//
// Un agent qui se sert de team_browser reçoit SON navigateur : un processus
// browserd.mjs lancé sous son uid (setpriv), profil dans ~/.browser/profile.
// Le superviseur le joint par la socket Unix ~/.browser/s.sock : le dossier
// est en 0700, donc un autre agent ne peut ni s'y connecter ni lire le profil.
//
// Le navigateur ne reçoit que le groupe de l'ÉQUIPE, jamais ceux des dossiers
// protégés : une page web n'a pas à voir ce qu'un secret ouvre, et un
// processus qui vit dix minutes ne doit pas garder un accès qu'on retirerait
// entre-temps.

import http from "node:http";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentEnv, buildArgv } from "./exec.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Playwright et son Chromium sont-ils dans l'image ? */
export function browserInstalled() {
  return existsSync(path.join(here, "..", "node_modules", "playwright", "package.json"));
}

function request(socketPath, { method = "GET", body = null, timeoutMs = 2_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: "/", method, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error("réponse illisible du navigateur")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("le navigateur ne répond pas")));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export class BrowserPool {
  constructor({ stateDir, idleSeconds = 600, log = () => {} }) {
    this.logDir = path.join(stateDir, "browsers");
    this.idleSeconds = idleSeconds;
    this.log = log;
    this.starting = new Map();
    mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
  }

  paths(id) {
    const dir = path.posix.join(id.home, ".browser");
    return { dir, socket: path.posix.join(dir, "s.sock"), profile: path.posix.join(dir, "profile") };
  }

  async alive(socket) {
    if (!existsSync(socket)) return false;
    try { return (await request(socket, { timeoutMs: 1_500 })).ok === true; } catch { return false; }
  }

  /** Le navigateur de l'agent, démarré s'il ne tourne pas (un seul démarrage à la fois). */
  async ensure(id, { limits, options }) {
    const p = this.paths(id);
    if (await this.alive(p.socket)) return p;
    if (!this.starting.has(id.agentKey)) {
      this.starting.set(id.agentKey, this.start(id, p, { limits, options }).finally(() => this.starting.delete(id.agentKey)));
    }
    await this.starting.get(id.agentKey);
    return p;
  }

  async start(id, p, { limits, options }) {
    const teamOnly = { ...id, groups: id.groups.slice(0, 1) };
    const argv = [process.execPath, path.join(here, "browserd.mjs"), p.socket, p.profile];
    const [cmd, ...args] = buildArgv(teamOnly, id.home, argv, options);
    const logFile = path.join(this.logDir, `${id.user}.log`);
    const fd = openSync(logFile, "a", 0o600);
    try {
      const child = spawn(cmd, args, {
        env: {
          ...agentEnv(teamOnly, limits),
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/ms-playwright",
          BROWSER_IDLE_SECONDS: String(this.idleSeconds),
        },
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.alive(p.socket)) {
        this.log(`navigateur de ${id.user} démarré`);
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw Object.assign(new Error("le navigateur n'a pas démarré (journal : /var/lib/team-machine/browsers)"), { status: 504, code: "browser_start_failed" });
  }

  /** L'écran et les onglets d'un navigateur ouvert — sans le démarrer ni le réveiller. */
  async peek(id) {
    const p = this.paths(id);
    if (!(await this.alive(p.socket))) return null;
    const r = await request(p.socket, { method: "POST", body: { action: "peek" }, timeoutMs: 15_000 }).catch(() => null);
    return r?.ok ? r.result : null;
  }

  async call(id, args, ctx) {
    const p = await this.ensure(id, ctx);
    const timeoutMs = 75_000;
    let r;
    try {
      r = await request(p.socket, { method: "POST", body: args, timeoutMs });
    } catch (e) {
      throw Object.assign(new Error(`navigateur : ${e.message}`), { status: 502, code: "browser_failed" });
    }
    if (!r.ok) throw Object.assign(new Error(r.error ?? "échec du navigateur"), { status: 422, code: "browser_error" });
    return r.result;
  }
}
