// Lancer un processus SOUS L'IDENTITÉ d'un agent.
//
// Node sait changer d'uid/gid à la création d'un processus, mais il efface
// les groupes supplémentaires — or ce sont eux qui ouvrent l'équipe et les
// dossiers protégés. On passe donc par setpriv (util-linux), qui pose en une
// fois : uid, gid, groupes, no_new_privs (un binaire setuid ne rend plus root),
// et aucune capacité héritable.
//
// Le préambule bash, exécuté déjà sous l'identité de l'agent, fixe des limites
// DURES (un agent ne peut que les baisser) : nombre de processus — par uid, donc
// par agent — taille de fichier, descripteurs ; puis umask 007 : rien de ce
// qu'un agent écrit n'est lisible par « les autres ».
//
// L'environnement est reconstruit de zéro : celui du superviseur contient
// MACHINE_TOKEN, et il ne doit jamais fuir dans un processus d'agent.

import { spawn } from "node:child_process";

export const PREAMBLE = [
  'ulimit -u "$TM_NPROC" 2>/dev/null',
  'ulimit -n 4096 2>/dev/null',
  'if [ "$TM_FSIZE_KB" != "0" ]; then ulimit -f "$TM_FSIZE_KB" 2>/dev/null; fi',
  'if [ "$TM_MEM_KB" != "0" ]; then ulimit -v "$TM_MEM_KB" 2>/dev/null; fi',
  "umask 007",
  'mkdir -p "$HOME/.tmp" "$HOME/.local/bin" 2>/dev/null',
  'unset TM_NPROC TM_FSIZE_KB TM_MEM_KB',
  'cd -- "$1" 2>/dev/null || { echo "dossier de travail inaccessible : $1" >&2; exit 97; }',
  "shift",
  'exec "$@"',
].join("\n");

/** L'environnement d'un processus d'agent. */
export function agentEnv(id, limits) {
  const home = id.home;
  return {
    PATH: `${home}/.local/bin:${home}/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: home,
    USER: id.user,
    LOGNAME: id.user,
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    TMPDIR: `${home}/.tmp`,
    TEAM_DIR: id.teamDir,
    TEAM_SHARED: `${id.teamDir}/commun`,
    TEAM_FOLDERS: `${id.teamDir}/dossiers`,
    // pip installe dans ~/.local quand le système n'est pas inscriptible ;
    // Debian le refuse par défaut (PEP 668) — on l'autorise, c'est chez l'agent.
    PIP_BREAK_SYSTEM_PACKAGES: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    NPM_CONFIG_PREFIX: `${home}/.npm-global`,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    PYTHONUNBUFFERED: "1",
    TM_NPROC: String(limits.nproc),
    TM_FSIZE_KB: String(limits.fsizeKb),
    TM_MEM_KB: String(limits.memKb),
  };
}

/** La ligne de commande complète : setpriv, préambule, programme. */
export function buildArgv(id, cwd, argv, { dry = false, boundingSet = true, shell = "/bin/bash" } = {}) {
  const tail = [shell, "-c", PREAMBLE, "team-machine", cwd, ...argv];
  if (dry) return tail;
  const groups = [...new Set(id.groups)].map(String);
  return [
    "setpriv",
    `--reuid=${id.uid}`, `--regid=${id.gid}`,
    ...(groups.length ? [`--groups=${groups.join(",")}`] : ["--clear-groups"]),
    "--no-new-privs", "--inh-caps=-all",
    ...(boundingSet ? ["--bounding-set=-all"] : []),
    "--", ...tail,
  ];
}

/**
 * Lance et attend. Sortie bornée (le reste est drainé, pas gardé) ; à
 * l'échéance, tout le groupe de processus est tué.
 */
export function runAs(id, { argv, cwd, stdin, timeoutMs, maxOutput = 256 * 1024, limits, options = {} }) {
  const [cmd, ...args] = buildArgv(id, cwd, argv, options);
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: agentEnv(id, limits), detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: `lancement impossible : ${e.message}`, timedOut: false, durationMs: 0 });
      return;
    }
    const out = { stdout: [], stderr: [], sizes: { stdout: 0, stderr: 0 }, truncated: false };
    const collect = (which) => (chunk) => {
      const room = maxOutput - out.sizes[which];
      if (room <= 0) { out.truncated = true; return; }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) out.truncated = true;
      out[which].push(part);
      out.sizes[which] += part.length;
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    let timedOut = false;
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* fini */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 2000).unref();
    }, timeoutMs);
    child.on("error", (e) => out.stderr.push(Buffer.from(`\n${e.message}`)));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // Ce qui a survécu au processus principal dans son groupe part avec lui.
      killGroup("SIGKILL");
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(out.stdout).toString("utf8"),
        stderr: Buffer.concat(out.stderr).toString("utf8"),
        truncated: out.truncated,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    child.stdin.on("error", () => {});
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
