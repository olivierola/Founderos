// Ce qui s'est passé sur la machine : les commandes lancées par les agents
// (avec la fin de leur sortie) et le fil des opérations. Gardé en mémoire et
// recopié sur le disque d'état (root, 0600) toutes les dix secondes au plus :
// l'historique récent survit à un redémarrage.
//
// C'est ce que voit un humain dans l'onglet Activité : les « terminaux » des
// agents. L'activité ne rend que les équipes que la plateforme demande, comme le reste.

import { readFile, writeFile, rename } from "node:fs/promises";

const tail = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `…${t.slice(-n)}` : t;
};

export class Recorder {
  constructor({ file = null, maxExecs = 1000, maxEvents = 4000 } = {}) {
    this.file = file;
    this.maxExecs = maxExecs;
    this.maxEvents = maxEvents;
    this.execs = [];
    this.events = [];
    this.seq = 0;
    this.timer = null;
  }

  async load() {
    if (!this.file) return;
    try {
      const d = JSON.parse(await readFile(this.file, "utf8"));
      // Une commande « en cours » au moment de l'arrêt ne finira jamais.
      this.execs = (d.execs ?? []).slice(-this.maxExecs).map((e) => (e.running ? { ...e, running: false, interrupted: true } : e));
      this.events = (d.events ?? []).slice(-this.maxEvents);
      this.seq = Number(d.seq) || this.execs.length;
    } catch { /* premier démarrage */ }
  }

  /** Recopie sur disque, au plus toutes les dix secondes. */
  dirty() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      const tmp = `${this.file}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify({ seq: this.seq, execs: this.execs, events: this.events }), { mode: 0o600 });
        await rename(tmp, this.file);
      } catch { /* disque plein : la mémoire suffit */ }
    }, 10_000);
    this.timer.unref?.();
  }

  /** Une commande commence : rend une fonction à appeler quand elle finit. */
  execStart(id, { command, cwd }) {
    const entry = {
      id: ++this.seq, team_id: id.agentKey.split(":")[0], agent_id: id.agentKey.split(":")[1], user: id.user,
      command: String(command).slice(0, 4000), cwd, started_at: new Date().toISOString(),
      running: true, exit_code: null, signal: null, duration_ms: null, timed_out: false, stdout: "", stderr: "",
    };
    this.execs.push(entry);
    if (this.execs.length > this.maxExecs) this.execs.shift();
    this.dirty();
    return (r) => {
      entry.running = false;
      entry.exit_code = r.exitCode ?? null;
      entry.signal = r.signal ?? null;
      entry.duration_ms = r.durationMs ?? null;
      entry.timed_out = !!r.timedOut;
      entry.stdout = tail(r.stdout, 4000);
      entry.stderr = tail(r.stderr, 1500);
      this.dirty();
    };
  }

  event(e) {
    this.events.push({ ts: new Date().toISOString(), ...e });
    if (this.events.length > this.maxEvents) this.events.shift();
    this.dirty();
  }

  /** Pour ces équipes, depuis `since` (ISO) : les plus récents d'abord. */
  forTeams(teams, { since = null, execs = 500, events = 800 } = {}) {
    const keep = (x) => teams.has(x.team_id) && (!since || (x.started_at ?? x.ts) >= since || x.running);
    return {
      execs: this.execs.filter(keep).slice(-execs).reverse(),
      events: this.events.filter(keep).slice(-events).reverse(),
    };
  }
}

/** Le détail lisible d'une opération, pour le fil (jamais un contenu de fichier). */
export function describeOp(op, args) {
  const a = args ?? {};
  if (op === "exec") return String(a.command ?? "").slice(0, 160);
  if (op === "fs") return `${a.op ?? "?"} ${String(a.path ?? "~").slice(0, 200)}${a.to ? ` → ${String(a.to).slice(0, 120)}` : ""}`;
  if (op === "job.start") return String(a.label || a.command || "").slice(0, 160);
  if (op === "job.logs" || op === "job.stop") return String(a.id ?? "");
  if (op === "browser") return `${a.action ?? "?"}${a.url ? ` ${String(a.url).slice(0, 160)}` : a.ref != null ? ` ref ${a.ref}` : a.selector ? ` ${String(a.selector).slice(0, 80)}` : ""}`;
  if (op === "apt.install") return (Array.isArray(a.packages) ? a.packages : []).join(" ").slice(0, 160);
  return "";
}
