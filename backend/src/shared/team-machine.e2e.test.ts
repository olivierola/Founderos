// La machine d'équipe (0296), de bout en bout : le vrai serveur auto-hébergé
// sur une base PGlite neuve (socle + toutes les migrations), supabase-js en
// face, et le VRAI superviseur team-machine/ en mode « dry » (pas de setpriv
// ni de comptes Linux hors conteneur : l'isolement par le noyau se vérifie
// dans le conteneur, avec selftest.mjs).
//
// Ce qui est vérifié ici, c'est la moitié plateforme du contrat : qui reçoit
// quels secrets. Un agent présente le secret d'un dossier protégé SEULEMENT
// s'il en est membre, la machine les accepte, un retrait ou une rotation prend
// effet à l'appel suivant, aucun secret ne sort dans une réponse d'outil ni
// dans l'API des humains, et RLS ne laisse rien écrire ni lire de secret.
//
// Lent (les migrations) : PLATFORM_E2E=0 le saute.

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PORT = Number(process.env.TEAM_MACHINE_E2E_PORT ?? 18795);
const MPORT = PORT + 1;
process.env.PLATFORM = "self";
process.env.DATABASE_URL = "pglite://memory";
process.env.JWT_SECRET = "e2e-secret-e2e-secret-e2e-secret-e2e-secret";
process.env.FUNCTIONS_URL = `http://localhost:${PORT}`;
process.env.STORAGE_DIR = `${process.env.TEMP ?? "/tmp"}/founderos-team-machine-e2e-${process.pid}`;
process.env.MGMT_PORT = "0";
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.TEAM_MACHINE_TOKEN = "m".repeat(48);
process.env.TEAM_MACHINE_URL = `http://127.0.0.1:${MPORT}`;
delete process.env.LLM_UPSTREAM;
delete process.env.AUTH_SMTP_HOST;
delete process.env.RESEND_API_KEY;

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

// Le superviseur lance ses commandes avec bash : celui de Git sous Windows.
const SHELL = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const skip = process.env.PLATFORM_E2E === "0" || !existsSync(SHELL);

const here = path.dirname(fileURLToPath(import.meta.url));
const supervisorUrl = pathToFileURL(path.resolve(here, "../../../team-machine/src/server.mjs")).href;

describe("machine d'équipe : identités, dossiers protégés, secrets (0296)", { skip, timeout: 300_000 }, () => {
  let server: import("node:http").Server;
  let platform: import("../platform/platform.ts").Platform;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let admin: any, userClient: any, supervisor: any, machineServer: any, sup: any;
  let tm: typeof import("../edge/_shared/team-machine.ts");
  let tools: typeof import("../edge/_shared/team-machine-tools.ts");
  let crypto: typeof import("../edge/_shared/crypto.ts");
  let accessToken = "";
  let anonKey = "";
  const id: Record<string, string> = {};
  const outputs: string[] = [];
  /** Les dossiers que la machine a ouverts à chaque appel, par agent. */
  const opened: Array<{ agent: string; folders: string[] }> = [];
  const machineDirs: string[] = [];

  const startMachine = async () => {
    const base = mkdtempSync(path.join(tmpdir(), "tm-e2e-")).split("\\").join("/");
    machineDirs.push(base);
    const config = { ...sup.readConfig({}), token: process.env.TEAM_MACHINE_TOKEN, root: `${base}/teams`, stateDir: `${base}/state`, dry: true, shell: SHELL };
    supervisor = sup.createMachine(config, () => {});
    await supervisor.boot();
    const resolve = supervisor.resolve.bind(supervisor);
    supervisor.resolve = (p: { agent?: { id?: string } }) => {
      const r = resolve(p);
      opened.push({ agent: String(p?.agent?.id), folders: r.opened });
      return r;
    };
    machineServer = sup.createServer(supervisor, config, () => {});
    await new Promise<void>((r) => machineServer.listen(MPORT, "127.0.0.1", r));
  };
  const stopMachine = () => new Promise<void>((r) => machineServer.close(() => r()));

  before(async () => {
    sup = await import(supervisorUrl);
    await startMachine();
    const { env } = await import("../env.ts");
    const { startPlatform } = await import("../platform/platform.ts");
    const { createServer } = await import("../server.ts");
    const { createClient } = await import("@supabase/supabase-js");
    platform = await startPlatform({
      ...env.platform!, publicUrl: env.functionsUrl, anonKey: env.supabaseAnonKey, serviceKey: env.supabaseServiceRoleKey, workers: false,
    }, () => {});
    server = createServer(undefined, { platform });
    await new Promise<void>((r) => server.listen(PORT, r));
    const opts = { auth: { persistSession: false, autoRefreshToken: false } };
    admin = createClient(env.functionsUrl, env.supabaseServiceRoleKey, opts);
    anonKey = env.supabaseAnonKey;
    tm = await import("../edge/_shared/team-machine.ts");
    tools = await import("../edge/_shared/team-machine-tools.ts");
    crypto = await import("../edge/_shared/crypto.ts");

    const anon = createClient(env.functionsUrl, env.supabaseAnonKey, opts);
    const email = `machine-${Date.now()}@example.com`;
    const su = await anon.auth.signUp({ email, password: "correct horse battery staple" });
    assert.equal(su.error, null, su.error?.message);
    id.user = su.data.user!.id;
    const si = await anon.auth.signInWithPassword({ email, password: "correct horse battery staple" });
    assert.equal(si.error, null, si.error?.message);
    accessToken = si.data.session!.access_token;
    userClient = createClient(env.functionsUrl, env.supabaseAnonKey, { ...opts, global: { headers: { Authorization: `Bearer ${accessToken}` } } });

    const one = async (table: string, row: Record<string, unknown>) => {
      const { data, error } = await admin.from(table).insert(row).select("id").single();
      assert.equal(error, null, `${table} : ${error?.message}`);
      return data.id as string;
    };
    id.ws = await one("workspaces", { name: "Espace", slug: `espace-${Date.now()}` });
    const { error: memberErr } = await admin.from("workspace_members").insert({ workspace_id: id.ws, user_id: id.user, role: "owner" });
    assert.equal(memberErr, null, memberErr?.message);
    id.project = await one("projects", { workspace_id: id.ws, name: "Projet", slug: "projet" });
    await admin.from("workspace_subscriptions").upsert({ workspace_id: id.ws, plan_code: "enterprise" }, { onConflict: "workspace_id" });
    id.dash = await one("service_dashboards", { workspace_id: id.ws, project_id: id.project, name: "Études" });
    const agent = (name: string) => one("internal_agents", { workspace_id: id.ws, project_id: id.project, service_dashboard_id: id.dash, name });
    id.nova = await agent("Nova");
    id.atlas = await agent("Atlas");
    id.iris = await agent("Iris");
    id.zed = await agent("Zed");
    id.team = "8f3a2c10-1111-4000-8000-000000000001";
    id.other = "9e4b3d21-2222-4000-8000-000000000002";
    const { error: setErr } = await admin.from("service_dashboards").update({
      settings: {
        teams: [
          { id: id.team, name: "Data", color: "#5fa8d3", agent_ids: [id.nova, id.atlas, id.iris], lead_id: id.nova, focus: "Analyse" },
          { id: id.other, name: "Ventes", color: "#e0a458", agent_ids: [id.zed], lead_id: id.zed, focus: "" },
        ],
      },
    }).eq("id", id.dash);
    assert.equal(setErr, null, setErr?.message);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await platform.close();
    await stopMachine();
    for (const d of machineDirs) rmSync(d, { recursive: true, force: true });
  });

  const fn = async (body: Record<string, unknown>) => {
    const res = await fetch(`${process.env.FUNCTIONS_URL}/functions/v1/team-machine`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  const agentRow = (name: string) => ({ id: id[name], name: name[0].toUpperCase() + name.slice(1), service_dashboard_id: id.dash });
  /** Les outils d'un agent, tels que son run les reçoit. */
  const toolsOf = async (name: string) => {
    const am = await tm.loadAgentMachine(admin, agentRow(name));
    assert.ok(am, `${name} devrait avoir une machine`);
    const map = new Map(tools.teamMachineTools(admin, am, (s: string) => s));
    return async (tool: string, args: Record<string, unknown>) => {
      const out = await map.get(tool)!.run(args);
      outputs.push(out);
      return out;
    };
  };
  const lastOpened = (agent: string) => [...opened].reverse().find((o) => o.agent === id[agent])?.folders;

  it("sans machine, pas d'outils", async () => {
    assert.equal(await tm.loadAgentMachine(admin, agentRow("nova")), null);
  });

  it("un humain donne une machine à l'équipe", async () => {
    const r = await fn({ action: "enable", dashboard_id: id.dash, team_id: id.team });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((r.json.machine as { team_key: string }).team_key, "data-8f3a");
    assert.equal(supervisor.state.teams[id.team].key, "data-8f3a");
    const { data: row } = await admin.from("team_machines").select("status, machine_path").eq("team_id", id.team).single();
    assert.equal(row.status, "active");
    assert.match(row.machine_path, /\/teams\/data-8f3a$/);
    assert.equal(await tm.loadAgentMachine(admin, agentRow("zed")), null, "l'autre équipe n'a rien");
  });

  it("un agent travaille dans son dossier perso, sous sa propre identité", async () => {
    const nova = await toolsOf("nova");
    const out = await nova("team_shell", { command: "echo bonjour > ~/note.txt && cat ~/note.txt" });
    assert.match(out, /\[exit: 0/);
    assert.match(out, /bonjour/);
    const { data: who } = await admin.from("team_machine_agents").select("unix_user, home_path").eq("agent_id", id.nova).single();
    assert.match(who.unix_user, /^nova-/);
    // Le secret de l'agent : chiffré en base, et la machine n'en garde que l'empreinte.
    const { data: sec } = await admin.from("team_machine_secrets").select("ciphertext, iv").eq("kind", "agent").eq("ref_id", `${id.team}:${id.nova}`).single();
    const plain = await crypto.decryptSecret(sec.ciphertext, sec.iv);
    const { createHash } = await import("node:crypto");
    assert.equal(supervisor.state.agents[`${id.team}:${id.nova}`].secretHash, createHash("sha256").update(plain).digest("hex"));
    assert.ok(!sec.ciphertext.includes(plain));
  });

  it("un agent crée un dossier protégé avec un coéquipier — jamais avec un agent d'une autre équipe", async () => {
    const nova = await toolsOf("nova");
    const refused = await nova("team_folders", { action: "create", name: "Rachat", members: ["Zed"] });
    assert.match(refused, /^ERROR: hors de ton équipe/);
    const out = await nova("team_folders", { action: "create", name: "Rachat Concurrent", purpose: "Étude confidentielle", members: ["Atlas"] });
    assert.match(out, /« rachat-concurrent » créé/);
    const { data: f } = await admin.from("team_machine_folders").select("id, path").eq("name", "rachat-concurrent").single();
    id.folder = f.id;
    assert.match(f.path, /\/dossiers\/rachat-concurrent$/);
    const { data: members } = await admin.from("team_machine_folder_members").select("agent_id, role").eq("folder_id", f.id).order("role");
    assert.deepEqual(members.map((m: { agent_id: string; role: string }) => [m.agent_id, m.role]).sort(), [[id.atlas, "member"], [id.nova, "owner"]].sort());
  });

  it("seuls les membres présentent le secret du dossier, et la machine l'accepte", async () => {
    const nova = await toolsOf("nova");
    const atlas = await toolsOf("atlas");
    const iris = await toolsOf("iris");
    const { data: f } = await admin.from("team_machine_folders").select("path").eq("id", id.folder).single();
    assert.match(await nova("team_files", { action: "write", path: `${f.path}/plan.md`, content: "plan secret" }), /"bytes":11/);
    assert.deepEqual(lastOpened("nova"), ["rachat-concurrent"]);
    assert.match(await atlas("team_files", { action: "read", path: `${f.path}/plan.md` }), /plan secret/);
    assert.deepEqual(lastOpened("atlas"), ["rachat-concurrent"]);
    await iris("team_shell", { command: "true" });
    assert.deepEqual(lastOpened("iris"), [], "Iris n'est pas membre : aucun secret présenté, aucun groupe ouvert");
    // Iris ne voit pas le dossier, et ne peut rien y gérer.
    const list = JSON.parse(await iris("team_folders", { action: "list" }));
    assert.deepEqual(list.protected_folders, []);
    assert.match(await iris("team_folders", { action: "add_members", folder: "rachat-concurrent", members: ["Iris"] }), /tu n'es membre d'aucun dossier/);
  });

  it("un membre qui n'est pas propriétaire ne gère pas les membres", async () => {
    const atlas = await toolsOf("atlas");
    assert.match(await atlas("team_folders", { action: "add_members", folder: "rachat-concurrent", members: ["Iris"] }), /seul le propriétaire/);
  });

  it("retirer un membre lui coupe l'accès dès l'appel suivant", async () => {
    const nova = await toolsOf("nova");
    const atlas = await toolsOf("atlas");
    assert.match(await nova("team_folders", { action: "remove_members", folder: "rachat-concurrent", members: ["Atlas"] }), /Retiré\(s\)/);
    await atlas("team_shell", { command: "true" });
    assert.deepEqual(lastOpened("atlas"), []);
    const { data: log } = await admin.from("team_machine_audit").select("action, agent_id").eq("folder_id", id.folder).order("created_at");
    assert.deepEqual(log.map((l: { action: string }) => l.action), ["folder_create", "member_remove"]);
  });

  it("rotation : un nouveau secret, que la machine accepte, et l'ancien ne vaut plus rien", async () => {
    const read = async () => {
      const { data } = await admin.from("team_machine_secrets").select("ciphertext, iv, version").eq("kind", "folder").eq("ref_id", id.folder).single();
      return { plain: await crypto.decryptSecret(data.ciphertext, data.iv), version: data.version };
    };
    const before = await read();
    const nova = await toolsOf("nova");
    assert.match(await nova("team_folders", { action: "rotate_secret", folder: "rachat-concurrent" }), /renouvelé/);
    const afterRot = await read();
    assert.notEqual(afterRot.plain, before.plain);
    assert.equal(afterRot.version, before.version + 1);
    await nova("team_shell", { command: "true" });
    assert.deepEqual(lastOpened("nova"), ["rachat-concurrent"]);
    const old = supervisor.resolve({ team: { id: id.team }, agent: { id: id.nova, secret: (await crypto.decryptSecret(
      (await admin.from("team_machine_secrets").select("ciphertext").eq("ref_id", `${id.team}:${id.nova}`).single()).data.ciphertext,
      (await admin.from("team_machine_secrets").select("iv").eq("ref_id", `${id.team}:${id.nova}`).single()).data.iv,
    )) }, folders: [{ id: id.folder, secret: before.plain }] });
    assert.deepEqual(old.opened, [], "l'ancien secret n'ouvre plus le dossier");
  });

  it("aucun secret ne sort, ni dans les outils, ni dans l'API des humains", async () => {
    const { data: rows } = await admin.from("team_machine_secrets").select("ciphertext, iv");
    const secrets = await Promise.all(rows.map((r: { ciphertext: string; iv: string }) => crypto.decryptSecret(r.ciphertext, r.iv)));
    assert.ok(secrets.length >= 4);
    const status = await fn({ action: "status", dashboard_id: id.dash });
    assert.equal(status.status, 200, JSON.stringify(status.json));
    const everything = [...outputs, JSON.stringify(status.json)].join("\n");
    for (const s of secrets) assert.ok(!everything.includes(s), "un secret a fuité");
    const team = (status.json.teams as Array<Record<string, unknown>>).find((t) => t.team_id === id.team)!;
    assert.equal((team.folders as unknown[]).length, 1);
    assert.equal((status.json.live as { reachable: boolean }).reachable, true);
  });

  it("RLS : un membre lit l'annuaire, n'écrit rien, ne voit aucun secret", async () => {
    const { data: machines } = await userClient.from("team_machines").select("team_id");
    assert.equal(machines?.length, 1);
    const { data: secrets } = await userClient.from("team_machine_secrets").select("ref_id");
    assert.ok(!secrets?.length, "aucun secret lisible");
    const { error } = await userClient.from("team_machine_folders").insert({ team_id: id.team, workspace_id: id.ws, name: "pirate" });
    assert.ok(error, "écriture directe refusée");
    const { error: memberErr } = await userClient.from("team_machine_folder_members").insert({ folder_id: id.folder, agent_id: id.iris });
    assert.ok(memberErr, "s'ajouter soi-même un agent à un dossier : refusé");
  });

  it("un humain gère les membres ; les membres restent dans l'équipe", async () => {
    let r = await fn({ action: "folder_members", folder_id: id.folder, add: [id.zed] });
    assert.equal(r.status, 400);
    r = await fn({ action: "folder_members", folder_id: id.folder, add: [id.iris] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const iris = await toolsOf("iris");
    await iris("team_shell", { command: "true" });
    assert.deepEqual(lastOpened("iris"), ["rachat-concurrent"]);
  });

  it("machine recréée (volume d'état perdu) : l'équipe, l'agent et ses dossiers se redéclarent seuls", async () => {
    await stopMachine();
    await startMachine();
    const nova = await toolsOf("nova");
    const out = await nova("team_shell", { command: "echo revenu" });
    assert.match(out, /revenu/);
    assert.ok(supervisor.state.teams[id.team], "équipe redéclarée");
    assert.deepEqual(lastOpened("nova"), ["rachat-concurrent"], "dossier redéclaré avec son secret");
  });

  it("archiver un dossier le retire à tous ; mettre la machine en pause retire les outils", async () => {
    let r = await fn({ action: "folder_archive", folder_id: id.folder });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const nova = await toolsOf("nova");
    await nova("team_shell", { command: "true" });
    assert.deepEqual(lastOpened("nova"), []);
    r = await fn({ action: "pause", team_id: id.team });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(supervisor.state.teams[id.team].suspended, true);
    assert.equal(await tm.loadAgentMachine(admin, agentRow("nova")), null);
    r = await fn({ action: "enable", dashboard_id: id.dash, team_id: id.team });
    assert.equal(r.status, 200);
    assert.equal(supervisor.state.teams[id.team].suspended, false, "réveillée");
  });

  // ── Le parc (0304) : des machines à part entière, données à une équipe ou à un agent ──

  const fleet = async (body: Record<string, unknown>) => {
    const res = await fetch(`${process.env.FUNCTIONS_URL}/functions/v1/machines`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };

  it("parc : déclarer la machine de la plateforme reprend les attributions d'avant, et la sonde répond", async () => {
    const r = await fleet({ action: "create", dashboard_id: id.dash, name: "Docker local", kind: "docker" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    id.machine = (r.json.machine as { id: string }).id;
    assert.equal((r.json.probe as { reachable: boolean }).reachable, true, JSON.stringify(r.json.probe));
    assert.equal(((r.json.probe as { info: { version: string } }).info).version, "0.3.0");
    const { data: row } = await admin.from("team_machines").select("machine_id").eq("team_id", id.team).single();
    assert.equal(row.machine_id, id.machine, "l'équipe Data est sur cette machine");
    const list = await fleet({ action: "list", dashboard_id: id.dash });
    assert.equal(list.status, 200, JSON.stringify(list.json));
    const m = (list.json.machines as Array<{ id: string; assignments: number; has_token: boolean }>)[0];
    assert.equal(m.assignments, 1);
    assert.equal(m.has_token, false);
    assert.equal((list.json.agents as unknown[]).length, 4);
  });

  it("parc : un agent seul reçoit sa machine ; elle passe avant celle de son équipe", async () => {
    let r = await fleet({ action: "assign", dashboard_id: id.dash, target: { type: "agent", id: id.zed }, machine_id: id.machine });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.team_id, `agent-${id.zed}`);
    const zed = await toolsOf("zed");
    assert.match(await zed("team_shell", { command: "echo seul > ~/solo.txt && cat ~/solo.txt" }), /seul/);
    assert.ok(supervisor.state.teams[`agent-${id.zed}`], "une « équipe d'un » sur la machine");

    r = await fleet({ action: "assign", dashboard_id: id.dash, target: { type: "agent", id: id.nova }, machine_id: id.machine });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await tm.loadAgentMachine(admin, agentRow("nova")))?.team.id, `agent-${id.nova}`, "la machine personnelle d'abord");
    r = await fleet({ action: "assign", dashboard_id: id.dash, target: { type: "agent", id: id.nova }, machine_id: null });
    assert.equal(r.json.status, "paused");
    assert.equal((await tm.loadAgentMachine(admin, agentRow("nova")))?.team.id, id.team, "retirée : retour à la machine de l'équipe");
  });

  it("parc : un humain lit les fichiers PAR un agent, et c'est journalisé", async () => {
    let r = await fleet({ action: "files", team_id: `agent-${id.zed}`, agent_id: id.zed, op: "list", path: "~" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const entries = (r.json.result as { entries: Array<{ path: string }> }).entries.map((e) => e.path);
    assert.ok(entries.includes("solo.txt"), entries.join(","));
    assert.equal((r.json.where as { solo: boolean }).solo, true);
    r = await fleet({ action: "files", team_id: `agent-${id.zed}`, agent_id: id.zed, op: "read", path: "~/solo.txt" });
    assert.match((r.json.result as { content: string }).content, /seul/);
    const { data: log } = await admin.from("team_machine_audit").select("action, detail").eq("team_id", `agent-${id.zed}`).eq("action", "human_read");
    assert.equal(log.length, 1);
    // Un agent d'une autre attribution ne sert pas de « regard » ici.
    r = await fleet({ action: "files", team_id: `agent-${id.zed}`, agent_id: id.nova, op: "list" });
    assert.equal(r.status, 400);
  });

  it("parc : l'activité ne montre que les équipes de l'espace, jobs compris", async () => {
    const zed = await toolsOf("zed");
    const started = await zed("team_shell", { command: "sleep 20", background: true });
    assert.match(started, /job|processus|id/i);
    const r = await fleet({ action: "activity", machine_id: id.machine });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.reachable, true, String(r.json.error));
    const jobs = r.json.jobs as Array<{ agent_id: string; running: boolean; id: string }>;
    const mine = jobs.find((j) => j.agent_id === id.zed && j.running);
    assert.ok(mine, JSON.stringify(jobs));
    const teams = (r.json.teams as Array<{ team_id: string }>).map((t) => t.team_id).sort();
    assert.deepEqual(teams, [id.team, `agent-${id.nova}`, `agent-${id.zed}`].sort());
    const stop = await fleet({ action: "job_stop", team_id: `agent-${id.zed}`, agent_id: id.zed, job_id: mine.id });
    assert.equal(stop.status, 200, JSON.stringify(stop.json));
  });

  it("team_browser : présent dans les outils, et dit clairement quand la machine n'a pas de navigateur", async () => {
    const zed = await toolsOf("zed");
    const out = await zed("team_browser", { action: "navigate", url: "https://example.com" });
    assert.match(out, /pas de navigateur/);
  });

  it("parc : en pause, plus d'outils ; une machine utilisée ne se supprime pas ; aucun jeton ne sort", async () => {
    let r = await fleet({ action: "update", machine_id: id.machine, status: "paused" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(await tm.loadAgentMachine(admin, agentRow("zed")), null);
    r = await fleet({ action: "update", machine_id: id.machine, status: "active" });
    assert.ok(await tm.loadAgentMachine(admin, agentRow("zed")));
    r = await fleet({ action: "delete", machine_id: id.machine });
    assert.equal(r.status, 409);

    // Un jeton propre : chiffré, jamais rendu, utilisé pour joindre la machine.
    const own = "o".repeat(48);
    r = await fleet({ action: "update", machine_id: id.machine, token: own });
    assert.equal((r.json.machine as { has_token: boolean }).has_token, true);
    assert.ok(!JSON.stringify(r.json).includes(own));
    const cfg = await tm.fleetConfig(admin, { id: id.machine, url: null });
    assert.equal(cfg?.token, own);
    const list = await fleet({ action: "list", dashboard_id: id.dash });
    assert.ok(!JSON.stringify(list.json).includes(own));
    await fleet({ action: "update", machine_id: id.machine, token: null });
    assert.equal((await tm.fleetConfig(admin, { id: id.machine, url: null }))?.token, process.env.TEAM_MACHINE_TOKEN);
  });
});
