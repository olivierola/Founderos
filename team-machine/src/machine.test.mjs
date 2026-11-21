// Tests sans Linux : signatures, état, secrets, principal, opérations de
// fichiers. L'isolement réel (setpriv, droits Unix) se vérifie DANS le
// conteneur avec selftest.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { NonceCache, sign, verifySignature } from "./auth.mjs";
import { isSecret, secretMatches, sha256Hex, slugify, TEAM_KEY_RE, USER_RE } from "./names.mjs";
import { buildArgv, agentEnv } from "./exec.mjs";
import { handle as fsop } from "./fsop.mjs";
import { createMachine, createServer, readConfig } from "./server.mjs";

const secret = () => randomBytes(32).toString("base64url");
const posix = (p) => p.replace(/\\/g, "/");

test("signature : vecteur partagé avec la plateforme", () => {
  // Le même vecteur est vérifié côté plateforme (backend/src/shared/team-machine.test.ts).
  assert.equal(sign("k".repeat(32), 1700000000, '{"nonce":"abc"}'),
    "974611c2dfaecea193c6059d7614b5c2e37a85ea6b6773b728beef8e8596ab40");
  const body = '{"nonce":"0123456789abcdef"}';
  const ts = Math.floor(Date.now() / 1000);
  const token = "t".repeat(40);
  assert.equal(verifySignature({ token, ts, signature: sign(token, ts, body), rawBody: body }), null);
  assert.equal(verifySignature({ token, ts, signature: sign(token, ts, body), rawBody: body + " " }), "bad_signature");
  assert.equal(verifySignature({ token, ts: ts - 1000, signature: sign(token, ts - 1000, body), rawBody: body }), "stale_request");
  assert.equal(verifySignature({ token: "", ts, signature: "x", rawBody: body }), "machine_not_configured");
});

test("nonces : une requête ne se rejoue pas", () => {
  const c = new NonceCache(1000);
  assert.equal(c.claim("0123456789abcdef", 0), true);
  assert.equal(c.claim("0123456789abcdef", 10), false);
  assert.equal(c.claim("0123456789abcdef", 5000), true, "oublié après la fenêtre");
  assert.equal(c.claim("court", 0), false);
});

test("noms et secrets", () => {
  assert.equal(slugify("Équipe Données & IA"), "equipe-donnees-ia");
  assert.equal(slugify("42 robots"), "x42-robots");
  assert.equal(slugify(""), "x");
  assert.ok(TEAM_KEY_RE.test(`${slugify("une équipe au nom vraiment très long", 20)}-abcd`));
  assert.ok(USER_RE.test(`${slugify("Nova la data scientist", 20)}-3f2a`));
  const s = secret();
  assert.ok(isSecret(s));
  assert.ok(secretMatches(s, sha256Hex(s)));
  assert.ok(!secretMatches(secret(), sha256Hex(s)));
  assert.ok(!secretMatches("court", sha256Hex("court")), "un secret trop court ne vaut rien");
});

test("exec : setpriv pose uid, groupes et no_new_privs ; l'environnement ne fuit pas", () => {
  const id = { uid: 20001, gid: 20001, groups: [40000, 40003, 40000], home: "/teams/k/home/nova", user: "nova", teamDir: "/teams/k" };
  const argv = buildArgv(id, "/teams/k/home/nova", ["/bin/bash", "-c", "ls"]);
  assert.equal(argv[0], "setpriv");
  assert.ok(argv.includes("--reuid=20001") && argv.includes("--regid=20001"));
  assert.ok(argv.includes("--groups=40000,40003"), "groupes dédoublonnés");
  assert.ok(argv.includes("--no-new-privs") && argv.includes("--inh-caps=-all") && argv.includes("--bounding-set=-all"));
  assert.ok(buildArgv({ ...id, groups: [] }, "/", ["true"]).includes("--clear-groups"));
  process.env.MACHINE_TOKEN = "ne-doit-pas-fuir";
  const env = agentEnv(id, { nproc: 512, fsizeKb: 0, memKb: 0 });
  assert.ok(!Object.values(env).includes("ne-doit-pas-fuir"));
  assert.equal(env.HOME, id.home);
  assert.equal(env.TEAM_SHARED, "/teams/k/commun");
  delete process.env.MACHINE_TOKEN;
});

test("fsop : lire, écrire, éditer, lister, chercher, déplacer", async () => {
  const home = posix(await mkdtemp(path.join(tmpdir(), "tm-fsop-")));
  try {
    await fsop({ op: "write", path: "~/src/app.py", content: "print('a')\nprint('b')\n" }, home);
    const r = await fsop({ op: "read", path: "src/app.py" }, home);
    assert.equal(r.content, "print('a')\nprint('b')\n");
    await assert.rejects(() => fsop({ op: "edit", path: "~/src/app.py", old: "print", new: "x" }, home), /2 fois/);
    await fsop({ op: "edit", path: "~/src/app.py", old: "print('b')", new: "print('c')" }, home);
    assert.match((await fsop({ op: "read", path: "~/src/app.py" }, home)).content, /print\('c'\)/);
    const ls = await fsop({ op: "list", path: "~", depth: 2 }, home);
    assert.ok(ls.entries.some((e) => e.path === "src/app.py" && e.type === "file"));
    const found = await fsop({ op: "search", path: "~", pattern: "print\\('c'\\)" }, home);
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].line, 2);
    const byGlob = await fsop({ op: "search", path: "~", glob: "**/*.py" }, home);
    assert.equal(byGlob.results.length, 1);
    await fsop({ op: "move", path: "~/src/app.py", to: "~/lib/app.py" }, home);
    await assert.rejects(() => fsop({ op: "read", path: "~/src/app.py" }, home));
    await fsop({ op: "write", path: "~/bin.dat", content: Buffer.from([0, 1, 2, 3]).toString("base64"), encoding: "base64" }, home);
    assert.equal((await fsop({ op: "read", path: "~/bin.dat" }, home)).binary, true);
    await assert.rejects(() => fsop({ op: "delete", path: "~/lib" }, home), /recursive=true/);
    await fsop({ op: "delete", path: "~/lib", recursive: true }, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function dryMachine() {
  const base = posix(await mkdtemp(path.join(tmpdir(), "tm-machine-")));
  const config = { ...readConfig({}), token: "x".repeat(40), root: `${base}/teams`, stateDir: `${base}/state`, dry: true };
  const m = createMachine(config, () => {});
  await m.boot();
  return { m, base, config };
}

test("machine : équipes, agents, dossiers, et le principal qui ouvre (ou non) les groupes", async () => {
  const { m, base } = await dryMachine();
  try {
    const teamId = randomUUID();
    const t = await m.teamEnsure({ team: { id: teamId, key: "data-ab12", name: "Data" } });
    assert.equal(t.key, "data-ab12");
    assert.equal((await m.teamEnsure({ team: { id: teamId, key: "autre-cle", name: "Data" } })).key, "data-ab12", "la clé ne change plus");
    // Une autre équipe qui voudrait la même clé en reçoit une autre.
    assert.notEqual((await m.teamEnsure({ team: { id: randomUUID(), key: "data-ab12" } })).key, "data-ab12");

    const nova = { id: randomUUID(), secret: secret() };
    const a = await m.agentEnsure({ team: { id: teamId }, agent: { ...nova, name: "Nova" } });
    assert.match(a.user, /^nova-/);
    assert.ok(a.home.endsWith(`/data-ab12/home/${a.user}`));
    await assert.rejects(() => m.agentEnsure({ team: { id: teamId }, agent: { id: nova.id, secret: secret(), name: "Nova" } }),
      (e) => e.code === "agent_secret_mismatch");

    const folderId = randomUUID();
    const fSecret = secret();
    const f = await m.folderCreate({ team: { id: teamId }, folder: { id: folderId, name: "rachat", secret: fSecret } });
    assert.ok(f.path.endsWith("/data-ab12/dossiers/rachat"));
    await assert.rejects(() => m.folderCreate({ team: { id: teamId }, folder: { id: randomUUID(), name: "rachat", secret: secret() } }),
      (e) => e.code === "folder_name_taken");

    const P = (folders, s = nova.secret) => ({ team: { id: teamId }, agent: { id: nova.id, secret: s }, folders });
    const teamGid = m.state.teams[teamId].gid;
    const folderGid = m.state.folders[folderId].gid;
    assert.deepEqual(m.resolve(P([])).groups, [teamGid]);
    assert.deepEqual(m.resolve(P([{ id: folderId, secret: fSecret }])).groups, [teamGid, folderGid]);
    const wrong = m.resolve(P([{ id: folderId, secret: secret() }]));
    assert.deepEqual(wrong.groups, [teamGid], "un faux secret n'ouvre pas le groupe");
    assert.deepEqual(wrong.refused, [folderId]);
    assert.throws(() => m.resolve(P([], secret())), (e) => e.code === "agent_secret_invalid");
    assert.throws(() => m.resolve({ team: { id: teamId }, agent: { id: randomUUID(), secret: secret() } }), (e) => e.code === "agent_unknown");

    // Rotation : l'ancien secret ne vaut plus rien.
    const next = secret();
    await assert.rejects(() => m.folderRotate({ folder: { id: folderId, secret: secret(), new_secret: next } }), (e) => e.code === "folder_secret_invalid");
    await m.folderRotate({ folder: { id: folderId, secret: fSecret, new_secret: next } });
    assert.deepEqual(m.resolve(P([{ id: folderId, secret: fSecret }])).groups, [teamGid]);
    assert.deepEqual(m.resolve(P([{ id: folderId, secret: next }])).groups, [teamGid, folderGid]);

    // Suspension, puis archive.
    await m.teamSuspend({ team: { id: teamId }, suspended: true });
    assert.throws(() => m.resolve(P([])), (e) => e.code === "team_suspended");
    await m.teamSuspend({ team: { id: teamId }, suspended: false });
    await m.folderArchive({ folder: { id: folderId } });
    assert.deepEqual(m.resolve(P([{ id: folderId, secret: next }])).groups, [teamGid], "archivé : plus de groupe");
    // Le nom se libère.
    await m.folderCreate({ team: { id: teamId }, folder: { id: randomUUID(), name: "rachat", secret: secret() } });

    // L'état ne garde que des empreintes.
    const raw = JSON.stringify(m.state);
    assert.ok(!raw.includes(nova.secret) && !raw.includes(fSecret) && !raw.includes(next));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("info et activité : la machine se décrit, chaque espace ne voit que ses équipes", async () => {
  const { m, base } = await dryMachine();
  try {
    const info = await m.info();
    assert.equal(info.version, "0.3.0");
    assert.ok(info.cpus >= 1 && info.mem.total_kb > 0 && Array.isArray(info.load));
    assert.equal(info.dry, true);

    const mine = randomUUID();
    const theirs = randomUUID();
    await m.teamEnsure({ team: { id: mine, name: "Ops" } });
    await m.teamEnsure({ team: { id: theirs, name: "Autre" } });
    const a = { id: randomUUID(), secret: secret() };
    const b = { id: randomUUID(), secret: secret() };
    await m.agentEnsure({ team: { id: mine }, agent: { ...a, name: "Nova" } });
    await m.agentEnsure({ team: { id: theirs }, agent: { ...b, name: "Kai" } });
    // Deux jobs factices (pas de processus en mode dry : on remplit la table).
    for (const [team, agent] of [[mine, a], [theirs, b]]) {
      m.jobs.jobs.set(randomUUID().slice(0, 8), {
        id: "j", agentKey: `${team}:${agent.id}`, command: "npm run dev", label: null, pid: 1, startedAt: new Date().toISOString(),
        exitCode: undefined, endedAt: null, logFile: "/dev/null",
      });
    }
    const act = await m.activity({ teams: [mine] });
    assert.equal(act.jobs.length, 1, "le job de l'autre équipe n'apparaît pas");
    assert.equal(act.jobs[0].agent_id, a.id);
    assert.equal(act.jobs[0].team_id, mine);
    assert.ok(!("agent_key" in act.jobs[0]));
    assert.deepEqual(act.teams.map((t) => t.id), [mine]);
    assert.deepEqual((await m.activity({})).jobs, [], "sans équipe demandée, rien");

    // Le fil et les commandes : par équipe, depuis une date, et gardés d'un démarrage à l'autre.
    m.record("fs", { team: { id: mine }, agent: { id: a.id, secret: a.secret } }, { op: "write", path: "~/a.txt", content: "SECRET-CONTENU" }, { status: 200, ms: 3 });
    m.record("exec", { team: { id: theirs }, agent: { id: b.id, secret: b.secret } }, { command: "ls" }, { status: 200, ms: 3 });
    const fin = m.recorder.execStart({ agentKey: `${mine}:${a.id}`, user: "nova" }, { command: "echo salut", cwd: "~" });
    fin({ exitCode: 0, stdout: "salut\n", stderr: "", durationMs: 12 });
    let act2 = await m.activity({ teams: [mine] });
    assert.equal(act2.events.length, 1);
    assert.equal(act2.events[0].detail, "write ~/a.txt");
    assert.ok(!JSON.stringify(act2).includes("SECRET-CONTENU"), "jamais le contenu d'un fichier");
    assert.ok(!JSON.stringify(act2).includes(a.secret), "jamais un secret");
    assert.equal(act2.execs.length, 1);
    assert.equal(act2.execs[0].stdout, "salut\n");
    act2 = await m.activity({ teams: [mine], since: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(act2.execs.length + act2.events.length, 0, "rien après « since »");
    clearTimeout(m.recorder.timer);
    m.recorder.timer = null;
    await m.recorder.dirty();
    await new Promise((r) => setTimeout(r, 0));
    const { Recorder } = await import("./recorder.mjs");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(m.recorder.file, JSON.stringify({ seq: m.recorder.seq, execs: m.recorder.execs, events: m.recorder.events }));
    const again = new Recorder({ file: m.recorder.file });
    await again.load();
    assert.equal(again.execs.length, 1, "l'historique survit au redémarrage");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("serveur HTTP : signature exigée, rejeu refusé, erreurs typées", async () => {
  const { m, base, config } = await dryMachine();
  const server = createServer(m, config, () => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const call = async (op, payload, { token = config.token, nonce = randomUUID() } = {}) => {
    const body = JSON.stringify({ nonce, ...payload });
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`http://127.0.0.1:${port}/v1/${op}`, {
      method: "POST", body,
      headers: { "content-type": "application/json", "x-machine-ts": String(ts), "x-machine-signature": sign(token, ts, body) },
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await call("status", {}, { token: "y".repeat(40) })).status, 401);
    const nonce = randomUUID();
    assert.equal((await call("status", {}, { nonce })).status, 200);
    assert.equal((await call("status", {}, { nonce })).status, 409, "rejeu");
    const teamId = randomUUID();
    assert.equal((await call("team.ensure", { team: { id: teamId, name: "Ops" } })).json.result.key, "ops");
    const r = await call("exec", { principal: { team: { id: teamId }, agent: { id: randomUUID(), secret: secret() } }, args: { command: "id" } });
    assert.equal(r.status, 404);
    assert.equal(r.json.error, "agent_unknown");
    assert.equal((await call("nope", {})).status, 404);
  } finally {
    server.close();
    await rm(base, { recursive: true, force: true });
  }
});
