// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/team-machine-tools.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// Les outils de la machine d'équipe (0296) — team_shell, team_files,
// team_folders, team_jobs, team_install.
//
// Enregistrés par buildInternalToolset quand l'agent a une machine (son équipe
// en a une, active). Ils parlent à la machine AU NOM de l'agent : son identité
// et les secrets de SES dossiers protégés partent avec chaque appel, déchiffrés
// à la volée par team-machine.ts. Aucun de ces outils ne rend jamais un
// secret : le modèle ne les voit pas, il ne peut donc ni les répéter ni se les
// faire soutirer.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  agentCall, audit, changeFolderMembers, createFolder, ensureAgentOnMachine, leaveFolder, loadFolder, MachineError,
  refreshFolders, resolveAgentRefs, rotateFolderSecret, type AgentMachine,
} from "./team-machine.ts";

interface MachineTool {
  def: { name: string; description: string; parameters: Record<string, unknown> };
  run: (args: Record<string, unknown>) => Promise<string>;
  compress?: (result: string, maxChars: number) => string;
  family: "EXECUTION";
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

const DENIED_HINT =
  "[accès refusé : ce chemin appartient à un autre agent, ou à un dossier protégé dont tu n'es pas membre. " +
  "Ne cherche pas à contourner : demande l'accès au propriétaire du dossier (send_message_to_agent) ou à un humain.]";

function explain(e: unknown): string {
  if (e instanceof MachineError) {
    if (e.code === "machine_unreachable" || e.code === "machine_not_configured") {
      return `ERROR: ${e.message}. La machine d'équipe est hors ligne : ne réessaie pas en boucle, signale-le et continue avec ce qui ne demande pas la machine.`;
    }
    if (e.code === "team_suspended") return "ERROR: la machine de ton équipe est en pause (décision humaine). Ne réessaie pas.";
    if (e.code === "agent_secret_invalid" || e.code === "agent_secret_mismatch") {
      return "ERROR: ton identité sur la machine ne correspond plus (secret réinitialisé ailleurs). Un humain doit la réinitialiser depuis le panneau Machine de l'équipe.";
    }
    if (e.code === "access_denied") return `ERROR: ${e.message}\n${DENIED_HINT}`;
    return `ERROR: ${e.message}`;
  }
  return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
}

/** Le bloc de consignes qui ouvre la famille EXECUTION. */
export function teamMachineGuidance(am: AgentMachine): string[] {
  const mates = am.teammates.map((t) => t.name).join(", ") || "personne d'autre pour l'instant";
  const home = am.home ?? `${am.teamDir}/home/<ton utilisateur>`;
  const folders = am.folders.length
    ? am.folders.map((f) => {
      const others = f.members.filter((m) => m.agent_id !== am.agentId).map((m) => m.name);
      return `${f.name} (${f.path ?? "?"} — ${others.length ? `avec ${others.join(", ")}` : "toi seul"}${f.role === "owner" ? ", tu en es propriétaire" : ""})`;
    }).join(" ; ")
    : "aucun";
  return [
    `  TEAM MACHINE « ${am.team.name} » — a REAL Linux machine shared with your team (team_* tools), where you are your own Linux user${am.unixUser ? ` \`${am.unixUser}\`` : ""}. Files persist between runs.`,
    `   • ~ (${home}) is PRIVATE: only you can read it. Drafts, scratch work, anything not ready to share.`,
    `   • ${am.teamDir}/commun is shared by the whole team (${mates}).`,
    `   • Protected folders you belong to: ${folders}. Other protected folders may exist: you can't see or open them.`,
    "   ACCESS IS ENFORCED BY THE KERNEL: another agent's home, or a protected folder you're not a member of, answers \"Permission denied\". Never try to work around it — ask the folder's owner (send_message_to_agent) or a human.",
    "   CONFIDENTIALITY: never copy content from a protected folder into commun, a room, a message or a deliverable that non-members can read. Folder secrets are held by the platform: you never see them and must never ask for them.",
    "   To work on something sensitive with only some teammates: team_folders(action=\"create\", name, members=[…]) — you become its owner and manage its members.",
    "   Moving a file from ~ to a shared folder: team_files move/copy (it fixes group permissions). A plain `mv` in the shell keeps your private group and teammates can't read the file.",
    "   Servers, watchers, long jobs: team_shell with background=true, then team_jobs (logs / stop). Stop what you started before finishing.",
    "   Web pages: team_browser is your own browser on this machine (persistent profile in ~/.browser, captures in ~/captures). Test what you serve with it at http://localhost:<port>.",
  ];
}

function formatExec(command: string, d: Record<string, unknown>): string {
  const secs = (Number(d.duration_ms ?? 0) / 1000).toFixed(1);
  const flags = [d.timed_out ? "TIMED OUT" : "", d.truncated ? "output truncated" : ""].filter(Boolean).join(", ");
  const stdout = str(d.stdout);
  const stderr = str(d.stderr);
  const denied = /permission denied|operation not permitted/i.test(stderr) ? `\n${DENIED_HINT}` : "";
  return `$ ${command}\n[exit: ${d.exit_code ?? d.signal ?? "?"} | ${secs}s${flags ? ` | ${flags}` : ""}]\n\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}${denied}`;
}

function formatFs(action: string, r: Record<string, unknown>): string {
  if (action === "read") {
    if (r.binary) return `${r.path} : fichier binaire (${r.size} octets) — lis-le avec un outil adapté dans team_shell.`;
    const head = `${r.path} — lignes ${Number(r.from_line) + 1}–${Number(r.from_line) + Number(r.lines)} sur ${r.total_lines}${r.truncated ? " (suite : offset/limit)" : ""}`;
    return `${head}\n\n${str(r.content)}`;
  }
  if (action === "list") {
    const entries = (r.entries ?? []) as Array<Record<string, unknown>>;
    if (!entries.length) return `${r.path} : vide.`;
    const lines = entries.map((e) => e.error
      ? `  ${e.path}  [${e.error}]`
      : `  ${e.type === "dir" ? "d" : e.type === "link" ? "l" : "-"} ${e.mode} ${String(e.owner).padEnd(14)} ${String(e.group).padEnd(16)} ${String(e.size).padStart(9)}  ${e.path}${e.type === "dir" ? "/" : ""}`);
    return `${r.path}\n${lines.join("\n")}${r.truncated ? "\n  … (liste tronquée)" : ""}`;
  }
  if (action === "search") {
    const results = (r.results ?? []) as Array<Record<string, unknown>>;
    if (!results.length) return `Aucun résultat sous ${r.path} (${r.scanned_files} fichiers parcourus).`;
    return results.map((x) => (x.line ? `${x.path}:${x.line}: ${x.text}` : str(x.path))).join("\n") +
      (r.truncated ? "\n… (résultats tronqués)" : "");
  }
  return JSON.stringify(r);
}

/** Ce que le navigateur rend, lisible par un modèle : où l'on est, puis le reste. */
function formatBrowser(action: string, r: Record<string, unknown>): string {
  const lines: string[] = [];
  if (r.url !== undefined) lines.push(`Page affichée : ${str(r.title) || "(sans titre)"} · ${str(r.url)}`);
  // Ce qui est affiché n'est pas forcément ce qui a été demandé : une
  // redirection, ou une appli dont toutes les routes rendent la même page.
  if (typeof r.status === "number" && r.status >= 400) lines.push(`ATTENTION : la page a répondu ${r.status}.`);
  if (r.redirected === true && typeof r.requested === "string") {
    lines.push(`ATTENTION : tu as demandé ${r.requested}, le navigateur affiche ${str(r.url)}. Vérifie que c'est bien la page voulue avant d'en parler.`);
  }
  if (Array.isArray(r.elements)) {
    const els = r.elements as Array<{ ref: number; kind: string; label?: string; href?: string; value?: string }>;
    lines.push(els.length ? `\nÉléments (agis avec ref) :` : "\nAucun élément interactif visible.");
    for (const e of els) {
      lines.push(`  [${e.ref}] ${e.kind}${e.label ? ` « ${e.label} »` : ""}${e.value ? ` = ${e.value}` : ""}${e.href ? ` → ${e.href}` : ""}`);
    }
  }
  if (typeof r.text === "string") lines.push(`\n${r.text}`);
  if (typeof r.html === "string") lines.push(`\n${r.html}${r.truncated ? "\n… (html tronqué)" : ""}`);
  if (typeof r.saved === "string") {
    lines.push(`Capture enregistrée : ${r.saved}. Elle montre la page ci-dessus (titre et adresse) : décris celle-là, pas celle que tu voulais ouvrir.`);
  }
  if (r.result !== undefined) lines.push(`Résultat : ${str(r.result)}`);
  if (Array.isArray(r.console)) lines.push((r.console as string[]).length ? (r.console as string[]).join("\n") : "Console vide.");
  if (Array.isArray(r.tabs)) {
    for (const t of r.tabs as Array<{ index: number; url: string; title: string; active: boolean }>) {
      lines.push(`  ${t.active ? "▸" : " "} ${t.index}. ${t.title || "(sans titre)"} · ${t.url}`);
    }
  }
  if (r.closed) lines.push("Navigateur fermé (le profil reste).");
  if (!lines.length) lines.push(`${action} : fait.`);
  return lines.join("\n");
}

/**
 * Les outils, pour un agent qui a une machine. `compressExec` : le compresseur
 * de sortie d'exécution de la boîte à outils (tête + queue).
 */
export function teamMachineTools(
  admin: SupabaseClient, am: AgentMachine, compressExec: (result: string, maxChars: number) => string,
): Array<[string, MachineTool]> {
  const out: Array<[string, MachineTool]> = [];

  out.push(["team_shell", {
    family: "EXECUTION",
    compress: compressExec,
    def: {
      name: "team_shell",
      description:
        "Run a bash command on your TEAM'S MACHINE (a real shared Linux box), as your own Linux user. " +
        "Default directory: your private home (~). Use it for git, builds, tests, scripts, pip/npm installs (user-level, into ~), curl, data work. " +
        "For servers, watchers or long jobs set background=true: you get a job id, then read its output with team_jobs.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command." },
          cwd: { type: "string", description: "Working directory: ~/…, relative to ~, or absolute (e.g. the team's commun folder)." },
          timeout: { type: "number", description: "Seconds before the command is killed (default 120, max 600). Ignored with background=true." },
          background: { type: "boolean", description: "Start as a background job (servers, watchers, trainings)." },
          label: { type: "string", description: "Short name for a background job." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const command = str(args.command);
      try {
        if (args.background === true) {
          const j = await agentCall<Record<string, unknown>>(admin, am, "job.start", { command, cwd: str(args.cwd) || undefined, label: str(args.label) || undefined });
          return `Job ${j.id} lancé (pid ${j.pid}). Sa sortie : team_jobs(action="logs", id="${j.id}") — vérifie qu'il a bien démarré. Pour l'arrêter : team_jobs(action="stop", id="${j.id}").`;
        }
        const timeout = Math.min(Math.max(Number(args.timeout) || 120, 1), 600);
        const d = await agentCall<Record<string, unknown>>(admin, am, "exec", { command, cwd: str(args.cwd) || undefined, timeout }, (timeout + 30) * 1000);
        return formatExec(command, d);
      } catch (e) {
        return explain(e);
      }
    },
  }]);

  out.push(["team_files", {
    family: "EXECUTION",
    def: {
      name: "team_files",
      description:
        "Files on your TEAM'S MACHINE, as your own Linux user. Actions: read (offset/limit in lines), write, append, edit (exact old → new), " +
        "list (depth 0-4), stat, mkdir, delete (recursive for folders), move, copy (to), search (pattern = regex in contents, glob = file names). " +
        "Paths: ~/…, relative to ~, or absolute.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "write", "append", "edit", "list", "stat", "mkdir", "delete", "move", "copy", "search"] },
          path: { type: "string", description: "Target path (default ~)." },
          content: { type: "string", description: "write/append: the content." },
          encoding: { type: "string", enum: ["utf8", "base64"], description: "write/append: base64 for binary content." },
          old: { type: "string", description: "edit: exact text to replace (must match once, unless all=true)." },
          new: { type: "string", description: "edit: replacement text." },
          all: { type: "boolean", description: "edit: replace every occurrence." },
          to: { type: "string", description: "move/copy: destination path." },
          overwrite: { type: "boolean", description: "copy: overwrite the destination." },
          recursive: { type: "boolean", description: "delete: remove a folder and its content." },
          depth: { type: "number", description: "list: how many levels (0-4)." },
          all_files: { type: "boolean", description: "list: include hidden files." },
          pattern: { type: "string", description: "search: regex looked for inside files." },
          glob: { type: "string", description: "search: file name glob, e.g. **/*.py" },
          offset: { type: "number", description: "read: first line (0-based)." },
          limit: { type: "number", description: "read: number of lines (default 2000)." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const action = str(args.action);
      const req: Record<string, unknown> = { ...args, op: action };
      delete req.action;
      if (args.all_files !== undefined) { req.all = args.all_files; delete req.all_files; }
      try {
        const r = await agentCall<Record<string, unknown>>(admin, am, "fs", req);
        return formatFs(action, r);
      } catch (e) {
        return explain(e);
      }
    },
    compress: (result, maxChars) => (result.length <= maxChars ? result : `${result.slice(0, maxChars)}\n…[${result.length - maxChars} caractères coupés — lis la suite avec offset/limit]`),
  }]);

  out.push(["team_folders", {
    family: "EXECUTION",
    def: {
      name: "team_folders",
      description:
        "Your places on the team machine and the PROTECTED folders — shared with only some teammates, closed to everyone else by the kernel. " +
        "list: your home, the team's commun folder, the protected folders you belong to and their members. " +
        "create (name, purpose, members): a new protected folder, you become its owner. " +
        "add_members / remove_members (folder, members): owner only. leave (folder). rotate_secret (folder): owner only, after a doubt on who had access. " +
        "Members are teammates, by name or id. You never see a folder's secret: the platform presents it for you.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "create", "add_members", "remove_members", "leave", "rotate_secret"] },
          folder: { type: "string", description: "The protected folder (name or id)." },
          name: { type: "string", description: "create: folder name (letters, digits, . _ -)." },
          purpose: { type: "string", description: "create: what it is for, in one sentence." },
          members: { type: "array", items: { type: "string" }, description: "Teammates (names or ids). On create, you are added automatically." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const action = str(args.action);
      const actor = { agentId: am.agentId };
      const pickFolder = async () => {
        const key = str(args.folder).trim();
        if (!key) throw new MachineError(400, "missing_folder", "précise le dossier (folder)");
        await refreshFolders(admin, am);
        const f = am.folders.find((x) => x.id === key || x.name === key);
        if (!f) throw new MachineError(404, "folder_not_member", `tu n'es membre d'aucun dossier « ${key} » — team_folders(action="list") montre les tiens`);
        const row = await loadFolder(admin, f.id);
        if (!row) throw new MachineError(404, "folder_unknown", "dossier introuvable");
        return row;
      };
      try {
        if (action === "list") {
          await refreshFolders(admin, am);
          if (!am.unixUser) await ensureAgentOnMachine(admin, am).catch(() => {});
          return JSON.stringify({
            machine: am.team.name,
            you: am.unixUser,
            home: { path: am.home ?? "~", access: "toi seul" },
            commun: { path: `${am.teamDir}/commun`, access: `toute l'équipe : ${am.teammates.map((t) => t.name).join(", ") || "toi"}` },
            protected_folders: am.folders.map((f) => ({
              name: f.name, path: f.path, purpose: f.purpose, your_role: f.role,
              members: f.members.map((m) => `${m.name}${m.role === "owner" ? " (propriétaire)" : ""}`),
            })),
            note: "D'autres dossiers protégés peuvent exister dans l'équipe : tu ne les vois pas, tu n'y entres pas.",
          }, null, 1);
        }
        if (action === "create") {
          const { ids, unknown } = resolveAgentRefs(args.members, am.teammates);
          if (unknown.length) return `ERROR: hors de ton équipe ou inconnus : ${unknown.join(", ")}. Membres possibles : ${am.teammates.map((t) => t.name).join(", ") || "aucun"}.`;
          const f = await createFolder(admin, {
            machine: am.machine, team: am.team, name: str(args.name), purpose: str(args.purpose) || null,
            memberIds: ids, ownerAgentId: am.agentId, actor,
          });
          await refreshFolders(admin, am);
          const names = am.teammates.filter((t) => ids.includes(t.id)).map((t) => t.name);
          return `Dossier protégé « ${f.name} » créé : ${f.path}. Membres : toi (propriétaire)${names.length ? `, ${names.join(", ")}` : ""}. ` +
            "Personne d'autre ne peut l'ouvrir ; ses membres y accèdent dès leur prochain appel.";
        }
        if (action === "add_members" || action === "remove_members") {
          const folder = await pickFolder();
          const pool = action === "add_members" ? am.teammates : [...am.teammates, { id: am.agentId, name: am.agentName }];
          const { ids, unknown } = resolveAgentRefs(args.members, pool);
          if (unknown.length) return `ERROR: hors de ton équipe ou inconnus : ${unknown.join(", ")}.`;
          if (!ids.length) return "ERROR: précise les membres (members).";
          const r = await changeFolderMembers(admin, {
            folder, team: am.team, machine: am.machine, actor,
            add: action === "add_members" ? ids : [], remove: action === "remove_members" ? ids : [],
          });
          await refreshFolders(admin, am);
          const nameOf = (id: string) => pool.find((p) => p.id === id)?.name ?? id;
          return action === "add_members"
            ? (r.added.length ? `Ajouté(s) à « ${folder.name} » : ${r.added.map(nameOf).join(", ")}.` : "Rien à faire : déjà membres.")
            : (r.removed.length ? `Retiré(s) de « ${folder.name} » : ${r.removed.map(nameOf).join(", ")} — leur accès est coupé, leurs processus qui tenaient le dossier sont arrêtés.` : "Rien à faire : pas membres.");
        }
        if (action === "leave") {
          const folder = await pickFolder();
          await leaveFolder(admin, { folder, machine: am.machine, agentId: am.agentId });
          await refreshFolders(admin, am);
          return `Tu as quitté « ${folder.name} » : tu n'y as plus accès.`;
        }
        if (action === "rotate_secret") {
          const folder = await pickFolder();
          await rotateFolderSecret(admin, { folder, team: am.team, machine: am.machine, actor });
          return `Secret de « ${folder.name} » renouvelé : l'ancien n'ouvre plus rien. Les membres actuels gardent l'accès (la plateforme présente le nouveau pour eux).`;
        }
        return `ERROR: action inconnue « ${action} ».`;
      } catch (e) {
        return explain(e);
      }
    },
  }]);

  out.push(["team_jobs", {
    family: "EXECUTION",
    def: {
      name: "team_jobs",
      description: "Your background jobs on the team machine (started with team_shell background=true). Actions: list, logs (id, tail in bytes), stop (id).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "logs", "stop"] },
          id: { type: "string", description: "The job id." },
          tail: { type: "number", description: "logs: how many bytes from the end (default 16000)." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const action = str(args.action);
      try {
        if (action === "list") {
          const r = await agentCall<{ jobs: unknown[] }>(admin, am, "job.list", {});
          return r.jobs.length ? JSON.stringify(r.jobs, null, 1) : "Aucun processus de fond.";
        }
        if (!str(args.id)) return "ERROR: précise l'id du job.";
        if (action === "logs") {
          const r = await agentCall<Record<string, unknown>>(admin, am, "job.logs", { id: str(args.id), tail: Number(args.tail) || undefined });
          return `[job ${r.id} — ${r.running ? "en cours" : `terminé (code ${r.exit_code})`}] $ ${r.command}\n\n${str(r.output) || "(aucune sortie pour l'instant)"}`;
        }
        if (action === "stop") {
          const r = await agentCall<Record<string, unknown>>(admin, am, "job.stop", { id: str(args.id) });
          return `Job ${r.id} ${r.running ? "toujours en cours (réessaie dans un instant)" : `arrêté (code ${r.exit_code})`}.`;
        }
        return `ERROR: action inconnue « ${action} ».`;
      } catch (e) {
        return explain(e);
      }
    },
    compress: compressExec,
  }]);

  out.push(["team_browser", {
    family: "EXECUTION",
    def: {
      name: "team_browser",
      description:
        "Your OWN web browser on the team machine (headless Chromium, as your Linux user). Its profile lives in your private ~/.browser: " +
        "cookies and logins persist between runs, no teammate can see them. The page stays open between calls. " +
        "Start with navigate (it returns the page text and its numbered elements); then act on an element by its ref number. " +
        "Actions: navigate (url), snapshot (re-number the elements), text, html, click, fill (value), type (value, key by key), " +
        "press (value = key, e.g. Enter), select (value), check, uncheck, hover, scroll (value = up|down), wait (element or timeout ms), " +
        "back, forward, reload, screenshot (saved as a PNG in ~/captures, or at path), evaluate (value = JS expression), console, " +
        "tabs, new_tab (url), switch_tab (index), close_tab, close. " +
        "Servers started on the machine are reachable at http://localhost:<port>. " +
        "To open a FILE you wrote on the machine, navigate with its path: ~/site/index.html, /teams/…/file.html or a path relative to your home (me.html); it opens as file://. " +
        "Never guess a web URL for a local file. Every result starts with « Page affichée » (title · address): that is what a screenshot captures; if it is not the page you meant, fix the navigation before answering.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["navigate", "snapshot", "text", "html", "click", "fill", "type", "press", "select", "check", "uncheck", "hover", "scroll", "wait",
              "back", "forward", "reload", "screenshot", "evaluate", "console", "tabs", "new_tab", "switch_tab", "close_tab", "close"],
          },
          url: { type: "string", description: "navigate / new_tab: a web address, or the path of a file on the machine (~/…, /…, relative to your home)." },
          ref: { type: "number", description: "The element's number, from navigate/snapshot/click." },
          selector: { type: "string", description: "Instead of ref: a CSS selector." },
          text: { type: "string", description: "Instead of ref: the element's visible text." },
          value: { type: "string", description: "fill/type/select: the value; press: the key; scroll: up|down; evaluate: the JS expression." },
          full_page: { type: "boolean", description: "screenshot: the whole page, not just the visible part." },
          path: { type: "string", description: "screenshot: where to save the PNG (default ~/captures/<date>.png)." },
          index: { type: "number", description: "switch_tab: the tab index (see tabs)." },
          timeout: { type: "number", description: "wait: milliseconds." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      // Les champs vides ne désignent rien : on ne les transmet pas.
      const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== "" && v !== null && v !== undefined));
      try {
        const r = await agentCall<Record<string, unknown>>(admin, am, "browser", clean, 90_000);
        return formatBrowser(str(args.action), r);
      } catch (e) {
        if (e instanceof MachineError && e.code === "browser_unavailable") {
          return "ERROR: cette machine n'a pas de navigateur (image antérieure à team-machine 0.3.0). Signale-le ; ne réessaie pas.";
        }
        return explain(e);
      }
    },
  }]);

  if (am.machine.allow_system_packages) {
    out.push(["team_install", {
      family: "EXECUTION",
      def: {
        name: "team_install",
        description:
          "Install Debian packages (apt) on the team machine — for the WHOLE machine, every teammate gets them. " +
          "Only when a user-level install (pip/npm into ~) can't do it.",
        parameters: {
          type: "object",
          properties: {
            packages: { type: "array", items: { type: "string" }, description: "Debian package names (max 20)." },
            reason: { type: "string", description: "Why, in one sentence (kept in the machine's journal)." },
          },
          required: ["packages", "reason"],
          additionalProperties: false,
        },
      },
      run: async (args) => {
        try {
          const r = await agentCall<{ installed: string[]; output: string }>(admin, am, "apt.install", { packages: args.packages }, 16 * 60_000);
          await audit(admin, {
            team_id: am.team.id, workspace_id: am.machine.workspace_id, agent_id: am.agentId, action: "apt_install",
            detail: { packages: r.installed, reason: str(args.reason).slice(0, 300) },
          });
          return `Installé : ${r.installed.join(", ")}.\n\n${r.output}`;
        } catch (e) {
          return explain(e);
        }
      },
      compress: compressExec,
    }]);
  }

  return out;
}
