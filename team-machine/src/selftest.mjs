#!/usr/bin/env node
// Auto-test d'isolement — À LANCER DANS LE CONTENEUR :
//
//   docker exec team-machine node /opt/team-machine/src/selftest.mjs
//
// Monte une équipe jetable (sous /tmp, uids 39000+, groupes 59000+ : rien ne
// touche aux vraies équipes), trois agents et un dossier protégé, puis vérifie
// que le NOYAU refuse ce qui doit l'être. Nettoie derrière lui. Code de sortie
// 0 si tout passe, 1 sinon.

import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { readConfig, createMachine } from "./server.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${String(detail).slice(0, 300)}` : ""}`);
};
const secret = () => randomBytes(32).toString("base64url");

async function main() {
  if (process.getuid?.() !== 0) {
    console.error("à lancer en root dans le conteneur (docker exec team-machine node /opt/team-machine/src/selftest.mjs)");
    process.exit(2);
  }
  const base = `/tmp/tm-selftest-${process.pid}`;
  // Le dossier d'état se crée en 0700 : sans ce 0711 posé avant, aucun agent
  // ne traverserait la base du test (en production, /teams est un volume à part).
  await mkdir(base, { recursive: true });
  await chmod(base, 0o711);
  const config = { ...readConfig(), root: `${base}/teams`, stateDir: `${base}/state`, dry: false, allowApt: false };
  config.boundingSet = true;
  const m = createMachine(config, () => {});
  // Après boot() (qui recharge l'état) : des uid/gid loin de ceux des vrais agents.
  await m.boot();
  m.store.data.nextUid = 39000;
  m.store.data.nextGid = 59000;

  const team1 = randomUUID(), team2 = randomUUID();
  const ids = { alice: randomUUID(), bob: randomUUID(), carol: randomUUID(), dave: randomUUID() };
  const keys = Object.fromEntries(Object.keys(ids).map((k) => [k, secret()]));
  const created = [];
  try {
    const t1 = await m.teamEnsure({ team: { id: team1, key: `st-${process.pid % 100000}`, name: "Selftest" } });
    const t2 = await m.teamEnsure({ team: { id: team2, key: `st2-${process.pid % 100000}`, name: "Selftest 2" } });
    for (const [n, id] of Object.entries(ids)) {
      const a = await m.agentEnsure({ team: { id: n === "dave" ? team2 : team1 }, agent: { id, name: `st ${n}`, secret: keys[n] } });
      created.push(a.user);
    }
    const folderId = randomUUID();
    const folderSecret = secret();
    const folder = await m.folderCreate({ team: { id: team1 }, folder: { id: folderId, name: "secret-projet", secret: folderSecret } });

    const P = (n, folders = []) => ({
      team: { id: n === "dave" ? team2 : team1 }, agent: { id: ids[n], secret: keys[n] }, folders,
    });
    const sh = (n, command, folders) => m.exec(P(n, folders), { command, timeout: 20 });
    const grant = [{ id: folderId, secret: folderSecret }];

    // 1. Dossier perso
    let r = await sh("alice", "echo confidentiel > ~/note.txt && cat ~/note.txt");
    check("alice écrit dans son dossier perso", r.exit_code === 0 && r.stdout.includes("confidentiel"), r.stderr);
    const aliceHome = (await m.status({ teams: [team1] })).teams[0].agents.find((a) => a.id === ids.alice).home;
    r = await sh("bob", `cat ${aliceHome}/note.txt`);
    check("bob ne lit PAS le dossier perso d'alice", r.exit_code !== 0, r.stdout);
    r = await sh("bob", `ls ${aliceHome}`);
    check("bob ne liste PAS le dossier perso d'alice", r.exit_code !== 0, r.stdout);

    // 2. Commun d'équipe
    r = await sh("alice", `echo partage > ${t1.common}/hello.txt`);
    r = await sh("bob", `cat ${t1.common}/hello.txt`);
    check("bob lit le dossier commun de l'équipe", r.exit_code === 0 && r.stdout.includes("partage"), r.stderr);
    r = await sh("dave", `ls ${t1.common}`);
    check("dave (autre équipe) n'entre PAS dans l'équipe 1", r.exit_code !== 0, r.stdout);

    // 3. Dossier protégé
    r = await sh("alice", `echo plan-secret > ${folder.path}/plan.md`, grant);
    check("alice (membre, avec le secret) écrit dans le dossier protégé", r.exit_code === 0, r.stderr);
    r = await sh("bob", `cat ${folder.path}/plan.md`);
    check("bob (sans le secret) ne lit PAS le dossier protégé", r.exit_code !== 0, r.stdout);
    r = await sh("bob", `cat ${folder.path}/plan.md`, [{ id: folderId, secret: secret() }]);
    check("bob avec un faux secret ne lit PAS le dossier protégé", r.exit_code !== 0 && r.refused_folders.length === 1, r.stdout);
    r = await sh("carol", `cat ${folder.path}/plan.md`, grant);
    check("carol (membre, avec le secret) lit ce qu'alice a écrit", r.exit_code === 0 && r.stdout.includes("plan-secret"), r.stderr);
    r = await sh("bob", `ls ${t1.folders}`);
    check("bob ne liste PAS les noms des dossiers protégés", r.exit_code !== 0, r.stdout);

    // 4. Fichiers par l'outil (fsop sous l'identité de l'agent)
    let denied = false;
    try { await m.fs(P("bob"), { op: "read", path: `${aliceHome}/note.txt` }); } catch (e) { denied = e.code === "access_denied"; }
    check("fs.read de bob sur le dossier d'alice : access_denied", denied);
    const moved = await m.fs(P("alice", grant), { op: "write", path: "~/brouillon.txt", content: "v1" })
      .then(() => m.fs(P("alice", grant), { op: "move", path: "~/brouillon.txt", to: `${folder.path}/brouillon.txt` }))
      .then(() => m.fs(P("carol", grant), { op: "read", path: `${folder.path}/brouillon.txt` }))
      .catch((e) => ({ error: e.message }));
    check("un fichier déplacé du perso vers le dossier protégé reste lisible par les membres", moved?.content === "v1", JSON.stringify(moved));

    // 5. Le superviseur et ses secrets
    r = await sh("alice", `cat ${config.stateDir}/state.json`);
    check("un agent ne lit PAS l'état de la machine", r.exit_code !== 0, r.stdout);
    r = await sh("alice", "cat /proc/1/environ");
    check("un agent ne lit PAS l'environnement du superviseur", r.exit_code !== 0 || !r.stdout.includes("MACHINE_TOKEN"), r.stdout);
    r = await sh("alice", "env");
    check("aucun MACHINE_TOKEN dans l'environnement d'un agent", !r.stdout.includes("MACHINE_TOKEN"), r.stdout);
    r = await sh("alice", `ls ${config.root}`);
    check("un agent ne liste PAS les équipes de la machine", r.exit_code !== 0, r.stdout);

    // 6. Privilèges
    r = await sh("alice", "id -u; grep NoNewPrivs /proc/self/status; grep CapEff /proc/self/status");
    check("alice tourne sans privilège (uid ≠ 0, NoNewPrivs, CapEff nul)",
      !/^0$/m.test(r.stdout) && /NoNewPrivs:\s+1/.test(r.stdout) && /CapEff:\s+0+$/m.test(r.stdout), r.stdout);
    r = await sh("alice", "su -c id root </dev/null 2>&1 || sudo -n id 2>&1; true");
    check("ni su ni sudo ne rendent root", !/uid=0\(root\)/.test(r.stdout), r.stdout);

    // 7. Processus
    const job = m.jobStart(P("alice"), { command: "sleep 120", label: "selftest" });
    await new Promise((res) => setTimeout(res, 500));
    r = await sh("bob", `kill -9 ${job.pid} 2>&1; true`);
    await new Promise((res) => setTimeout(res, 300));
    // Vu de bob, même « kill -0 » est refusé : c'est root qui constate.
    let alive = true;
    try { process.kill(job.pid, 0); } catch { alive = false; }
    check("bob ne tue PAS le processus d'alice", alive && /not permitted/i.test(r.stdout), r.stdout);
    let foreign = false;
    try { m.jobLogs(P("bob"), { id: job.id }); } catch (e) { foreign = e.code === "job_not_found"; }
    check("bob ne voit PAS les journaux du job d'alice", foreign);
    await m.jobStop(P("alice"), { id: job.id });

    // 8. Retrait d'un membre : nouveau secret, l'ancien ne vaut plus rien
    const rotated = secret();
    await m.folderRotate({ folder: { id: folderId, secret: folderSecret, new_secret: rotated } });
    r = await sh("carol", `cat ${folder.path}/plan.md`, grant);
    check("après rotation, l'ancien secret n'ouvre plus le dossier", r.exit_code !== 0, r.stdout);
    r = await sh("alice", `cat ${folder.path}/plan.md`, [{ id: folderId, secret: rotated }]);
    check("après rotation, le nouveau secret l'ouvre", r.exit_code === 0, r.stderr);

    // 8. Navigateur (si l'image l'embarque)
    if (m.browserReady) {
      const page = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(u.searchParams.has("nom")
          ? `<title>Merci</title><p>Bonjour ${u.searchParams.get("nom").replace(/[<>&]/g, "")}</p>`
          : `<title>Formulaire</title><form><input name="nom" placeholder="Votre nom"><button>Envoyer</button></form>`);
      });
      await new Promise((res) => page.listen(0, "127.0.0.1", res));
      const url = `http://127.0.0.1:${page.address().port}/`;
      const B = (args) => m.browser(P("alice", [{ id: folderId, secret: rotated }]), args);
      try {
        let b = await B({ action: "navigate", url });
        const input = b.elements.find((e) => e.kind.startsWith("input"));
        const button = b.elements.find((e) => e.kind === "button");
        check("le navigateur d'alice ouvre une page et en numérote les éléments", b.title === "Formulaire" && !!input && !!button, JSON.stringify(b).slice(0, 300));
        await B({ action: "fill", ref: input.ref, value: "Alice" });
        b = await B({ action: "click", ref: button.ref });
        b = await B({ action: "text" });
        check("remplir puis cliquer soumet le formulaire", /Bonjour Alice/.test(b.text), b.text);
        b = await B({ action: "screenshot" });
        const shot = await stat(b.saved).catch(() => null);
        const aliceUid = m.state.agents[`${team1}:${ids.alice}`].uid;
        check("la capture est un fichier d'alice, dans son dossier perso", !!shot && shot.size > 1000 && shot.uid === aliceUid && b.saved.startsWith(aliceHome), b.saved);
        // Le profil persiste : un cookie posé survit à l'arrêt du navigateur.
        await B({ action: "evaluate", value: "document.cookie = 'tm=1; max-age=3600'" });
        await B({ action: "close" });
        await new Promise((res) => setTimeout(res, 1500));
        b = await B({ action: "navigate", url });
        b = await B({ action: "evaluate", value: "document.cookie" });
        check("le profil d'alice garde ses cookies d'un démarrage à l'autre", /tm=1/.test(b.result ?? ""), b.result);
        // Le processus : sous l'uid d'alice, sans le groupe du dossier protégé.
        const { pid } = await new Promise((res, rej) => http.get({ socketPath: `${aliceHome}/.browser/s.sock`, path: "/" }, (r) => {
          let d = ""; r.on("data", (c) => { d += c; }); r.on("end", () => res(JSON.parse(d)));
        }).on("error", rej));
        const status = await readFile(`/proc/${pid}/status`, "utf8");
        const folderGid = m.state.folders[folderId].gid;
        check("le navigateur tourne sous l'uid d'alice, sans le groupe du dossier protégé",
          new RegExp(`^Uid:\\s+${aliceUid}\\b`, "m").test(status) && !new RegExp(`^Groups:.*\\b${folderGid}\\b`, "m").test(status), status.split("\n").filter((l) => /^(Uid|Groups)/.test(l)).join(" | "));
        r = await sh("bob", `ls ${aliceHome}/.browser 2>&1; node -e "require('http').get({socketPath:'${aliceHome}/.browser/s.sock',path:'/'},()=>console.log('CONNECTE')).on('error',e=>console.log(e.code))"`);
        check("bob ne lit pas le profil d'alice et ne joint pas son navigateur", !r.stdout.includes("CONNECTE") && !r.stdout.includes("profile"), r.stdout);
        b = await m.browser(P("bob"), { action: "navigate", url });
        b = await m.browser(P("bob"), { action: "evaluate", value: "document.cookie" });
        check("bob a son propre navigateur, sans les cookies d'alice", !/tm=1/.test(b.result ?? ""), b.result);
      } finally {
        page.close();
      }
    } else {
      console.log("(navigateur absent de l'image : vérifications sautées)");
    }

    // 9. Archive
    await m.folderArchive({ folder: { id: folderId } });
    r = await sh("alice", `ls ${folder.path}`, [{ id: folderId, secret: rotated }]);
    check("un dossier archivé n'est plus atteignable", r.exit_code !== 0, r.stdout);
  } catch (e) {
    check("déroulé du test", false, e?.stack ?? e);
  } finally {
    // Les navigateurs (et tout processus) des agents du test s'arrêtent avant leurs comptes.
    const testUids = new Set(Object.values(m.state.agents).map((a) => a.uid));
    await m.sys.kill((p) => testUids.has(p.uid)).catch(() => {});
    for (const u of created) {
      await m.sys.run("userdel", [u]).catch(() => {});
      await m.sys.run("groupdel", [u]).catch(() => {});
    }
    for (const t of Object.values(m.state.teams)) await m.sys.removeGroup(t.group);
    for (const f of Object.values(m.state.folders)) await m.sys.removeGroup(f.group);
    await rm(base, { recursive: true, force: true });
  }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} vérifications passées.`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
