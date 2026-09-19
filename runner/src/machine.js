// Machine execution API for AI agents (runner mode).
//
// Gives runner-mode agents real hands on the machine hosting the runner:
//   exec  — run shell commands (powershell / cmd / bash / sh)
//   code  — run Python or Node.js snippets
//   files — read / write / edit / list / glob / grep
//   info  — machine + runtime inventory
//
// Every agent session gets a persistent workspace directory under
// RUNNER_WORKSPACE_ROOT (default ./workspace/<session_id>); relative paths
// resolve inside it, so state survives across runs.
//
// Les chemins absolus sont REFUSES par defaut (RUNNER_RESTRICT_TO_WORKSPACE=0
// pour lever le cantonnement). L'ancien defaut etait l'inverse, au motif que
// « shell access already implies machine access » — vrai en soi, mais cela
// supposait un shell libre : voir policy.js, qui ne l'est plus.
//
// Les commandes passent par checkCommand() (policy.js) avant execution.
// Auth is the same X-Runner-Token as the browser API.

import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ts } from "./env.js";
import { checkCommand } from "./policy.js";

const IS_WIN = process.platform === "win32";
export const WORKSPACE_ROOT = path.resolve(
  process.env.RUNNER_WORKSPACE_ROOT || path.join(process.cwd(), "workspace"),
);
// FOS-07 — ce cantonnement etait opt-IN, donc desactive partout par defaut :
// une lecture de fichier arbitraire suffisait a remonter ~/.ssh/id_rsa dans le
// contexte du modele. Il est desormais actif sauf desactivation explicite.
const RESTRICT_TO_WORKSPACE = process.env.RUNNER_RESTRICT_TO_WORKSPACE !== "0";
export const EXEC_DISABLED = process.env.RUNNER_DISABLE_EXEC === "1";
const PYTHON_BIN = process.env.PYTHON_BIN || (IS_WIN ? "python" : "python3");
const MAX_OUTPUT = 200_000; // chars kept per stream
const MAX_TIMEOUT_S = 600;

// ── workspace + path resolution ─────────────────────────────────────────────

function sessionDir(sessionId) {
  const safe = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return path.join(WORKSPACE_ROOT, safe);
}

async function ensureSessionDir(sessionId) {
  const dir = sessionDir(sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Relative paths live in the session workspace; absolute paths reach the whole
// machine unless RUNNER_RESTRICT_TO_WORKSPACE=1.
function resolvePath(sessionId, p) {
  const raw = String(p || "").trim();
  if (!raw) throw new Error("file/path is required");
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(sessionDir(sessionId), raw);
  if (RESTRICT_TO_WORKSPACE) {
    const root = sessionDir(sessionId);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`path escapes the agent workspace (${root}) and RUNNER_RESTRICT_TO_WORKSPACE=1`);
    }
  }
  return abs;
}

// ── exec (shell commands) ───────────────────────────────────────────────────

function shellArgv(shell, command) {
  switch (shell) {
    case "powershell":
      // `powershell -Command` otherwise reports only 0/1, losing a child exe's
      // real exit code (e.g. a failing test runner). Propagate $LASTEXITCODE so
      // exit codes match cmd/bash. On a newline (not `;`) so a trailing #comment
      // in the user's command can't swallow the suffix. $LASTEXITCODE is $null
      // when no native exe ran → `exit` yields 0 (success), which is correct.
      return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `${command}\nexit $LASTEXITCODE`]];
    case "cmd":
      return ["cmd.exe", ["/d", "/s", "/c", command]];
    case "bash":
      return ["bash", ["-lc", command]];
    case "sh":
      return ["sh", ["-c", command]];
    default:
      return IS_WIN ? shellArgv("powershell", command) : shellArgv("bash", command);
  }
}

// Kill the whole process tree — a bare child.kill leaves grandchildren
// (e.g. a python spawned by powershell) running past the timeout.
function killTree(pid) {
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch { /* already gone */ }
}

function runProcess(bin, args, { cwd, timeoutS, env }) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", truncated = false, timedOut = false, settled = false;
    const started = Date.now();
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        windowsHide: true,
        detached: !IS_WIN, // process group on POSIX so killTree(-pid) works
      });
    } catch (e) {
      resolve({ exit_code: -1, stdout: "", stderr: `spawn failed: ${e.message}`, timed_out: false, duration_ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, Math.min(Math.max(Number(timeoutS) || 60, 1), MAX_TIMEOUT_S) * 1000);
    const grab = (buf, current) => {
      if (current.length >= MAX_OUTPUT) { truncated = true; return current; }
      return current + buf.toString("utf-8");
    };
    child.stdout?.on("data", (b) => { stdout = grab(b, stdout); });
    child.stderr?.on("data", (b) => { stderr = grab(b, stderr); });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit_code: timedOut ? -1 : (code ?? -1),
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT) + (truncated ? "\n…(output truncated)" : ""),
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      });
    };
    child.on("error", (e) => { stderr += `\n${e.message}`; finish(-1); });
    child.on("close", finish);
  });
}

export async function handleExec(body) {
  if (EXEC_DISABLED) return { error: "exec is disabled on this runner (RUNNER_DISABLE_EXEC=1)" };
  const { session_id, command, shell, cwd, timeout, env } = body;
  if (!String(command || "").trim()) return { error: "command is required" };
  // FOS-07 : la politique est appliquee ici, cote machine. Le prompt systeme
  // demandait au modele de s'abstenir ; une consigne se negocie, pas ceci.
  const verdict = checkCommand(command);
  if (!verdict.ok) {
    console.log(`[${ts()}] exec [${session_id ?? "default"}] REFUSE: ${verdict.reason}`);
    return { error: verdict.reason, exit_code: -1, stdout: "", stderr: verdict.reason, blocked: true };
  }
  const ws = await ensureSessionDir(session_id);
  const workdir = cwd ? resolvePath(session_id, cwd) : ws;
  const [bin, args] = shellArgv(String(shell || "").toLowerCase(), String(command));
  console.log(`[${ts()}] exec [${session_id ?? "default"}] $ ${String(command).slice(0, 120)}`);
  const result = await runProcess(bin, args, { cwd: workdir, timeoutS: timeout, env });
  return { ...result, cwd: workdir, shell: path.basename(bin, ".exe") };
}

// ── background processes ────────────────────────────────────────────────────
// handleExec is timeout-bounded and kills its tree, so it cannot host a
// long-running server or watcher. The process manager keeps such processes
// alive between tool calls: start returns a proc_id, and the agent tails logs
// / stops it later. Procs are keyed per session and capped to avoid leaks.

const procs = new Map(); // proc_id → { session_id, command, child, stdout, stderr, status, exit_code, started_at, ended_at }
let procSeq = 0;
const MAX_PROC_LOG = 100_000; // chars kept per stream (ring-trimmed)
const MAX_PROCS_PER_SESSION = 10;

function appendLog(proc, key, buf) {
  proc[key] = (proc[key] + buf.toString("utf-8")).slice(-MAX_PROC_LOG);
}

function procView(p) {
  return {
    proc_id: p.proc_id, command: p.command, status: p.status,
    exit_code: p.exit_code, pid: p.pid,
    started_at: p.started_at, ended_at: p.ended_at,
    uptime_ms: (p.ended_at ?? Date.now()) - p.started_at,
  };
}

export async function handleProc(body) {
  if (EXEC_DISABLED) return { error: "exec is disabled on this runner (RUNNER_DISABLE_EXEC=1)" };
  const { session_id, action } = body;
  const sid = String(session_id || "default");

  switch (String(action || "")) {
    case "start": {
      if (!String(body.command || "").trim()) return { error: "command is required" };
      // Meme politique qu'exec : sans cela, run_background serait le contournement.
      const procVerdict = checkCommand(body.command);
      if (!procVerdict.ok) return { error: procVerdict.reason, blocked: true };
      const running = [...procs.values()].filter((p) => p.session_id === sid && p.status === "running");
      if (running.length >= MAX_PROCS_PER_SESSION) {
        return { error: `too many background processes (${MAX_PROCS_PER_SESSION}). Stop one before starting another.` };
      }
      const ws = await ensureSessionDir(sid);
      const workdir = body.cwd ? resolvePath(sid, body.cwd) : ws;
      const [bin, args] = shellArgv(String(body.shell || "").toLowerCase(), String(body.command));
      const proc_id = `p${++procSeq}`;
      let child;
      try {
        child = spawn(bin, args, {
          cwd: workdir,
          env: { ...process.env, ...(body.env || {}) },
          windowsHide: true,
          detached: !IS_WIN,
        });
      } catch (e) {
        return { error: `spawn failed: ${e.message}` };
      }
      const proc = {
        proc_id, session_id: sid, command: String(body.command), pid: child.pid,
        child, stdout: "", stderr: "", status: "running", exit_code: null,
        started_at: Date.now(), ended_at: null,
      };
      child.stdout?.on("data", (b) => appendLog(proc, "stdout", b));
      child.stderr?.on("data", (b) => appendLog(proc, "stderr", b));
      child.on("error", (e) => { proc.stderr += `\n${e.message}`; });
      child.on("close", (code) => {
        proc.status = proc.status === "killed" ? "killed" : "exited";
        proc.exit_code = code;
        proc.ended_at = Date.now();
      });
      procs.set(proc_id, proc);
      console.log(`[${ts()}] proc [${sid}] start ${proc_id}: ${String(body.command).slice(0, 100)}`);
      // Brief settle so an instant-crash surfaces in the very first response.
      await new Promise((r) => setTimeout(r, 400));
      return { ...procView(proc), stdout: proc.stdout.slice(-2000), stderr: proc.stderr.slice(-2000) };
    }
    case "list": {
      const list = [...procs.values()].filter((p) => p.session_id === sid).map(procView);
      return { processes: list };
    }
    case "logs": {
      const p = procs.get(String(body.proc_id));
      if (!p || p.session_id !== sid) return { error: "proc_id not found for this session" };
      const tail = Math.min(Number(body.tail) || 8000, MAX_PROC_LOG);
      return { ...procView(p), stdout: p.stdout.slice(-tail), stderr: p.stderr.slice(-tail) };
    }
    case "stop": {
      const p = procs.get(String(body.proc_id));
      if (!p || p.session_id !== sid) return { error: "proc_id not found for this session" };
      if (p.status === "running") { p.status = "killed"; killTree(p.pid); }
      return { ...procView(p), stopped: true };
    }
    default:
      return { error: `unknown action "${action}" (start | list | logs | stop)` };
  }
}

// ── code (python / node snippets) ───────────────────────────────────────────

export async function handleCode(body) {
  if (EXEC_DISABLED) return { error: "exec is disabled on this runner (RUNNER_DISABLE_EXEC=1)" };
  const { session_id, language, code, timeout } = body;
  if (!String(code || "").trim()) return { error: "code is required" };
  const lang = String(language || "python").toLowerCase();
  const ws = await ensureSessionDir(session_id);
  const tmpDir = path.join(ws, ".agent-tmp");
  await fs.mkdir(tmpDir, { recursive: true });

  let bin, args, file;
  if (lang === "python") {
    file = path.join(tmpDir, "snippet.py");
    bin = PYTHON_BIN;
    args = [file];
  } else if (lang === "node" || lang === "nodejs" || lang === "javascript") {
    file = path.join(tmpDir, "snippet.mjs"); // .mjs so top-level import/await work
    bin = process.execPath;
    args = [file];
  } else {
    return { error: `unsupported language "${lang}" (python | node)` };
  }
  await fs.writeFile(file, String(code), "utf-8");
  console.log(`[${ts()}] code [${session_id ?? "default"}] ${lang} (${String(code).length} chars)`);
  const result = await runProcess(bin, args, { cwd: ws, timeoutS: timeout });
  return { ...result, language: lang, workspace: ws };
}

// ── files ───────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", ".agent-tmp", "__pycache__", ".venv", "venv", "dist", "build"]);

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("\\^$.|+()[]{}".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$", "i");
}

async function* walk(dir, depth = 0) {
  if (depth > 12) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(path.join(dir, e.name), depth + 1);
    } else if (e.isFile()) {
      yield path.join(dir, e.name);
    }
  }
}

export async function handleFiles(body) {
  const { session_id, action } = body;
  await ensureSessionDir(session_id);

  switch (String(action || "")) {
    case "write": {
      const file = resolvePath(session_id, body.file);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const content = String(body.content ?? "");
      if (body.append) await fs.appendFile(file, content, "utf-8");
      else await fs.writeFile(file, content, "utf-8");
      return { file, bytes_written: Buffer.byteLength(content, "utf-8"), appended: !!body.append };
    }
    case "read": {
      const file = resolvePath(session_id, body.file);
      const content = await fs.readFile(file, "utf-8");
      return { file, size: content.length, content: content.slice(0, MAX_OUTPUT) };
    }
    case "replace": {
      const file = resolvePath(session_id, body.file);
      const oldStr = String(body.old_str ?? "");
      if (!oldStr) return { error: "old_str is required" };
      const content = await fs.readFile(file, "utf-8");
      const count = content.split(oldStr).length - 1;
      if (count === 0) return { error: "old_str not found in file" };
      if (count > 1) return { error: `old_str matches ${count} times — make it unique` };
      await fs.writeFile(file, content.replace(oldStr, String(body.new_str ?? "")), "utf-8");
      return { file, replaced: 1 };
    }
    case "list": {
      const dir = resolvePath(session_id, body.path || ".");
      const out = [];
      if (body.recursive) {
        for await (const f of walk(dir)) {
          const st = await fs.stat(f).catch(() => null);
          out.push({ path: path.relative(dir, f).replaceAll("\\", "/"), type: "file", size: st?.size ?? 0 });
          if (out.length >= 500) break;
        }
      } else {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries.slice(0, 500)) {
          const st = e.isFile() ? await fs.stat(path.join(dir, e.name)).catch(() => null) : null;
          out.push({ path: e.name, type: e.isDirectory() ? "dir" : "file", size: st?.size ?? 0 });
        }
      }
      return { dir, entries: out, truncated: out.length >= 500 };
    }
    case "find": {
      const dir = resolvePath(session_id, body.path || ".");
      const rx = globToRegex(String(body.glob || "*"));
      const matches = [];
      for await (const f of walk(dir)) {
        const rel = path.relative(dir, f).replaceAll("\\", "/");
        if (rx.test(rel) || rx.test(path.basename(f))) matches.push(rel);
        if (matches.length >= 200) break;
      }
      return { dir, matches, truncated: matches.length >= 200 };
    }
    case "grep": {
      const dir = resolvePath(session_id, body.path || ".");
      let rx;
      try { rx = new RegExp(String(body.pattern || ""), "i"); } catch (e) { return { error: `invalid pattern: ${e.message}` }; }
      const maxResults = Math.min(Number(body.max_results) || 50, 200);
      const results = [];
      outer: for await (const f of walk(dir)) {
        const st = await fs.stat(f).catch(() => null);
        if (!st || st.size > 2_000_000) continue;
        const buf = await fs.readFile(f).catch(() => null);
        if (!buf || buf.subarray(0, 8000).includes(0)) continue; // skip binaries
        const lines = buf.toString("utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (rx.test(lines[i])) {
            results.push({ file: path.relative(dir, f).replaceAll("\\", "/"), line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (results.length >= maxResults) break outer;
          }
        }
      }
      return { dir, results, truncated: results.length >= maxResults };
    }
    case "mkdir": {
      const dir = resolvePath(session_id, body.path || body.file);
      await fs.mkdir(dir, { recursive: true });
      return { dir, created: true };
    }
    case "delete": {
      const target = resolvePath(session_id, body.path || body.file);
      await fs.rm(target, { recursive: !!body.recursive, force: true });
      return { path: target, deleted: true };
    }
    case "move": {
      const from = resolvePath(session_id, body.from || body.file);
      const to = resolvePath(session_id, body.to);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      return { from, to, moved: true };
    }
    case "copy": {
      const from = resolvePath(session_id, body.from || body.file);
      const to = resolvePath(session_id, body.to);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.cp(from, to, { recursive: true });
      return { from, to, copied: true };
    }
    default:
      return { error: `unknown action "${action}" (write | read | replace | list | find | grep | mkdir | delete | move | copy)` };
  }
}

// ── download (URL → workspace file) ─────────────────────────────────────────

export async function handleDownload(body) {
  const { session_id, url } = body;
  if (!/^https?:\/\//i.test(String(url || ""))) return { error: "a http(s) url is required" };
  await ensureSessionDir(session_id);
  // Default filename from the URL path; caller may override.
  const fromUrl = decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || "download.bin";
  const dest = resolvePath(session_id, body.file || fromUrl);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) return { error: `download failed: HTTP ${res.status}` };
  const MAX_BYTES = 100 * 1024 * 1024; // 100 MB cap
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) return { error: `file too large (${buf.byteLength} bytes, cap ${MAX_BYTES})` };
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  console.log(`[${ts()}] download [${session_id ?? "default"}] ${String(url).slice(0, 80)} → ${dest} (${buf.byteLength}b)`);
  return { file: dest, bytes: buf.byteLength, content_type: res.headers.get("content-type") };
}

// ── info ────────────────────────────────────────────────────────────────────

function probeVersion(bin, args = ["--version"]) {
  try {
    const r = spawnSync(bin, args, { encoding: "utf-8", timeout: 5000, windowsHide: true });
    return (r.stdout || r.stderr || "").trim().split("\n")[0] || null;
  } catch { return null; }
}

export async function handleInfo(body) {
  const ws = await ensureSessionDir(body?.session_id);
  return {
    platform: process.platform,
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    hostname: os.hostname(),
    default_shell: IS_WIN ? "powershell" : "bash",
    shells_available: ["powershell", "cmd", "bash", "sh"].filter((s) => (IS_WIN ? true : s !== "powershell" && s !== "cmd")),
    node: process.version,
    python: probeVersion(PYTHON_BIN) || "not found",
    git: probeVersion("git") || "not found",
    workspace: ws,
    workspace_root: WORKSPACE_ROOT,
    restrict_to_workspace: RESTRICT_TO_WORKSPACE,
    exec_disabled: EXEC_DISABLED,
    memory_gb: Math.round(os.totalmem() / 1e9),
    cpus: os.cpus().length,
  };
}
