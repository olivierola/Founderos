#!/usr/bin/env node
// Opérations de fichiers, exécutées SOUS L'IDENTITÉ de l'agent.
//
// Le superviseur (root) ne lit ni n'écrit jamais les fichiers d'un agent : il
// lance ce script avec l'uid, le gid et les groupes de l'agent (exec.mjs), lui
// passe la requête sur stdin et relit la réponse sur stdout. C'est donc le
// noyau qui tranche chaque accès — un dossier perso d'un collègue, un dossier
// protégé dont on n'est pas membre : EACCES, quoi que dise la requête.

import {
  appendFile, chmod, chown, cp, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_RETURN_CHARS = 200_000;

function resolvePath(p, home) {
  let s = String(p ?? "").trim();
  if (!s || s === "~") return home;
  if (s.startsWith("~/")) s = path.posix.join(home, s.slice(2));
  // path.isAbsolute plutôt que startsWith("/") : les tests tournent aussi hors Linux.
  if (!path.isAbsolute(s)) s = path.posix.join(home, s);
  return path.posix.normalize(s);
}

/** uid/gid → nom, pour que `owner` dise « nova-3f2a » et non 20003. */
function nameMaps() {
  const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  const map = (txt) => new Map(txt.split("\n").filter(Boolean).map((l) => {
    const [name, , id] = l.split(":");
    return [Number(id), name];
  }));
  return { users: map(read("/etc/passwd")), groups: map(read("/etc/group")) };
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

async function describe(p, names, rel) {
  const st = await lstat(p);
  return {
    path: rel ?? p,
    type: st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
    size: st.size,
    mode: (st.mode & 0o7777).toString(8).padStart(4, "0"),
    owner: names.users.get(st.uid) ?? String(st.uid),
    group: names.groups.get(st.gid) ?? String(st.gid),
    modified: st.mtime.toISOString(),
  };
}

/** Un fichier déposé dans un dossier partagé (setgid) prend le groupe du
 *  dossier, et devient lisible par le groupe : sans ça, un `move` depuis son
 *  dossier perso garderait le groupe privé, et les collègues verraient un
 *  fichier qu'ils ne peuvent pas ouvrir. */
async function adoptParentGroup(target) {
  try {
    const parent = await stat(path.posix.dirname(target));
    if (!(parent.mode & 0o2000)) return;
    const walk = async (p) => {
      const st = await lstat(p);
      if (st.isSymbolicLink()) return;
      await chown(p, st.uid, parent.gid).catch(() => {});
      await chmod(p, (st.mode | (st.isDirectory() ? 0o2070 : 0o060)) & 0o7777).catch(() => {});
      if (st.isDirectory()) for (const e of await readdir(p)) await walk(path.posix.join(p, e));
    };
    await walk(target);
  } catch { /* au mieux */ }
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".cache", ".npm-global", ".local"]);

async function walkFiles(root, { maxFiles, depth }, visit) {
  let seen = 0;
  const go = async (dir, d) => {
    if (seen >= maxFiles) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen >= maxFiles) return;
      const full = path.posix.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && d < depth) await go(full, d + 1);
      } else if (e.isFile()) {
        seen++;
        if ((await visit(full)) === false) return;
      }
    }
  };
  await go(root, 0);
  return seen;
}

function globToRegExp(glob) {
  const s = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`(^|/)${s}$`, "i");
}

export async function handle(req, home) {
  const names = nameMaps();
  const p = resolvePath(req.path, home);
  switch (req.op) {
    case "read": {
      const st = await stat(p);
      if (st.isDirectory()) throw new Error(`${p} est un dossier — utilise list`);
      // Une image, pour l'aperçu des humains (les captures du navigateur) : brute, en base64.
      if (req.encoding === "base64") {
        if (st.size > 8 * 1024 * 1024) throw new Error(`${p} : trop gros pour un aperçu (${st.size} octets)`);
        return { path: p, size: st.size, base64: (await readFile(p)).toString("base64") };
      }
      const fh = await open(p, "r");
      let buf;
      try {
        buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES));
        await fh.read(buf, 0, buf.length, 0);
      } finally { await fh.close(); }
      if (isBinary(buf)) return { path: p, binary: true, size: st.size };
      const lines = buf.toString("utf8").split("\n");
      const offset = Math.max(0, Number(req.offset) || 0);
      const limit = Math.max(1, Math.min(Number(req.limit) || 2000, 20000));
      const slice = lines.slice(offset, offset + limit);
      let content = slice.join("\n");
      const cut = content.length > MAX_RETURN_CHARS;
      if (cut) content = content.slice(0, MAX_RETURN_CHARS);
      return {
        path: p, size: st.size, total_lines: lines.length, from_line: offset, lines: slice.length,
        truncated: cut || st.size > MAX_READ_BYTES || offset + limit < lines.length, content,
      };
    }
    case "write":
    case "append": {
      const data = req.encoding === "base64" ? Buffer.from(String(req.content ?? ""), "base64") : String(req.content ?? "");
      await mkdir(path.posix.dirname(p), { recursive: true });
      const existed = await lstat(p).then(() => true, () => false);
      if (req.op === "append") await appendFile(p, data);
      else await writeFile(p, data);
      if (!existed) await adoptParentGroup(p);
      return { path: p, bytes: Buffer.byteLength(data), created: !existed };
    }
    case "edit": {
      const before = await readFile(p, "utf8");
      const oldStr = String(req.old ?? "");
      if (!oldStr) throw new Error("`old` est vide");
      const count = before.split(oldStr).length - 1;
      if (count === 0) throw new Error("le texte à remplacer est introuvable (il doit correspondre exactement, espaces compris)");
      if (count > 1 && !req.all) throw new Error(`le texte à remplacer apparaît ${count} fois — donne plus de contexte, ou all=true`);
      const after = req.all ? before.split(oldStr).join(String(req.new ?? "")) : before.replace(oldStr, () => String(req.new ?? ""));
      await writeFile(p, after);
      return { path: p, replaced: req.all ? count : 1 };
    }
    case "list": {
      const depth = Math.max(0, Math.min(Number(req.depth) || 0, 4));
      const limit = 400;
      const out = [];
      const go = async (dir, d) => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) {
          if (d === 0) throw e;
          out.push({ path: path.posix.relative(p, dir) || ".", error: e.code ?? e.message });
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          if (out.length >= limit) return;
          if (!req.all && e.name.startsWith(".")) continue;
          const full = path.posix.join(dir, e.name);
          out.push(await describe(full, names, path.posix.relative(p, full)).catch((err) => ({ path: path.posix.relative(p, full), error: err.code })));
          if (e.isDirectory() && d < depth && !SKIP_DIRS.has(e.name)) await go(full, d + 1);
        }
      };
      await go(p, 0);
      return { path: p, entries: out, truncated: out.length >= limit };
    }
    case "stat":
      return await describe(p, names);
    case "mkdir":
      await mkdir(p, { recursive: true });
      await adoptParentGroup(p);
      return { path: p, created: true };
    case "delete": {
      const st = await lstat(p);
      if (st.isDirectory() && !req.recursive) throw new Error(`${p} est un dossier : recursive=true pour le supprimer avec son contenu`);
      if (p === home) throw new Error("on ne supprime pas son propre dossier perso");
      await rm(p, { recursive: !!req.recursive, force: false });
      return { path: p, deleted: true };
    }
    case "move":
    case "copy": {
      const to = resolvePath(req.to, home);
      await mkdir(path.posix.dirname(to), { recursive: true });
      if (req.op === "move") await rename(p, to);
      else await cp(p, to, { recursive: true, errorOnExist: !req.overwrite, force: !!req.overwrite, verbatimSymlinks: true });
      await adoptParentGroup(to);
      return { from: p, to, done: true };
    }
    case "search": {
      const pattern = String(req.pattern ?? "");
      const glob = req.glob ? globToRegExp(req.glob) : null;
      const max = Math.max(1, Math.min(Number(req.max_results) || 60, 300));
      const results = [];
      let re = null;
      if (pattern) {
        try { re = new RegExp(pattern, req.case_sensitive ? "" : "i"); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      }
      const scanned = await walkFiles(p, { maxFiles: 5000, depth: 12 }, async (file) => {
        if (glob && !glob.test(file)) return true;
        if (!re) { results.push({ path: file }); return results.length < max; }
        let st;
        try { st = await stat(file); } catch { return true; }
        if (st.size > 1024 * 1024) return true;
        let buf;
        try { buf = await readFile(file); } catch { return true; }
        if (isBinary(buf)) return true;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push({ path: file, line: i + 1, text: lines[i].slice(0, 300) });
            if (results.length >= max) return false;
          }
        }
        return true;
      });
      return { path: p, results, scanned_files: scanned, truncated: results.length >= max };
    }
    default:
      throw new Error(`opération inconnue : ${req.op}`);
  }
}

// Exécuté comme script (et non importé par les tests) : stdin → stdout.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", async () => {
    let res;
    try {
      const req = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      res = { ok: true, result: await handle(req, process.env.HOME || "/tmp") };
    } catch (e) {
      const code = e?.code;
      const hint = code === "EACCES" || code === "EPERM"
        ? "accès refusé — ce chemin appartient à un autre agent ou à un dossier protégé dont tu n'es pas membre"
        : code === "ENOENT" ? "introuvable" : null;
      res = { ok: false, error: hint ? `${hint} (${e.message})` : String(e?.message ?? e), code: code ?? null };
    }
    process.stdout.write(JSON.stringify(res));
  });
}
