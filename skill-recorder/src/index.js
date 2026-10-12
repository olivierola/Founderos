// FounderOS Skill Recorder — apprentissage par démonstration.
//
// Boucle :
//   1. réclamer le prochain skill_recording en attente (test-runner-poll,
//      mode=rec_claim)
//   2. ouvrir un Chromium PERSISTANT (profil sur disque) sur l'URL de départ
//   3. injecter instrument.js dans chaque page/iframe : les gestes de
//      l'utilisateur remontent par un binding Playwright
//   4. pousser les gestes par lots (mode=rec_events) ; la réponse porte l'ordre
//      d'arrêt déclenché depuis l'app
//   5. refermer et déclencher la synthèse (mode=rec_finish)
//
// Pendant ce temps, l'app FounderOS pousse dans la MÊME timeline les segments de
// narration dictés au micro (source='narration'). L'alignement chronologique
// repose sur skill_recordings.started_at : les deux producteurs calculent leur
// at_ms comme `Date.now() - Date.parse(started_at)`. Ils tournent sur la même
// machine, donc un éventuel décalage d'horloge avec le serveur s'annule.
//
// Le profil est PERSISTANT (RECORDER_PROFILE_DIR) : l'utilisateur se connecte
// une fois à ses outils, et les sessions survivent d'un enregistrement à
// l'autre. Sans cela, on ne pourrait démontrer que des parcours publics.
//
// IDENTITÉ — il n'y a AUCUN secret à copier. Au premier démarrage, l'appareil
// affiche un code d'appairage à 8 caractères ; l'utilisateur le saisit dans
// FounderOS (où il est déjà authentifié), et c'est cette saisie qui lie
// l'appareil à son workspace. Le token reçu est écrit dans .auth.json et ne
// concerne plus personne. Un appareil ne voit donc que les démonstrations de
// son propre workspace — le serveur le déduit de son identité, le recorder ne
// peut pas l'élargir en le demandant.
//
// Env (.env ou variables d'environnement) :
//   SUPABASE_URL                 REQUIS — ex. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    optionnel — sans lui, pas de vignettes
//   RUNNER_TOKEN                 optionnel — voie héritée (token du test-runner),
//                                pour un déploiement qui en a déjà un ; sinon
//                                l'appairage s'en charge
//   RUNNER_ID                    optionnel, défaut hostname-pid
//   RECORDER_PROFILE_DIR         optionnel, défaut ./.profile
//   POLL_INTERVAL_MS             optionnel, défaut 3000
//   MAX_RECORDING_MIN            optionnel, garde-fou, défaut 45

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Voie héritée. Une valeur de gabarit laissée dans le .env doit être traitée
// comme ABSENTE : sinon elle bloquerait l'appairage (le recorder se croirait
// identifié) tout en se faisant refuser à chaque appel.
const rawRunnerToken = process.env.RUNNER_TOKEN?.trim();
const RUNNER_TOKEN = rawRunnerToken && rawRunnerToken.length >= 24 && !rawRunnerToken.endsWith("...")
  ? rawRunnerToken
  : null;
const RUNNER_ID = process.env.RUNNER_ID || `rec-${os.hostname()}-${process.pid}`;
const WORKSPACE_ID = process.env.RECORDER_WORKSPACE_ID || null;
const PROFILE_DIR = resolve(process.env.RECORDER_PROFILE_DIR || "./.profile");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3000;
const MAX_RECORDING_MS = (Number(process.env.MAX_RECORDING_MIN) || 45) * 60_000;
const POLL_URL = `${SUPABASE_URL}/functions/v1/test-runner-poll`;

// Validation au démarrage. Une valeur de gabarit laissée en place ne produit
// qu'un « fetch failed » toutes les 3 s : le message doit tomber ICI, une fois,
// en disant quoi corriger — pas dans la boucle de poll, indéfiniment.
//
// SUPABASE_URL est la SEULE chose à configurer. L'identité, elle, s'obtient par
// appairage (voir pair()) : demander à quelqu'un de copier un secret dans un
// fichier, c'est déjà une occasion de se tromper, et le secret copié a toujours
// une portée plus large que ce que l'appareil devrait avoir.
const configErrors = [];
if (!SUPABASE_URL) configErrors.push("SUPABASE_URL manquant.");
else if (/x{4,}|<|votre-projet/i.test(SUPABASE_URL)) {
  configErrors.push(`SUPABASE_URL vaut encore le gabarit (${SUPABASE_URL}) — mettez l'URL de votre projet Supabase.`);
} else {
  try { new URL(SUPABASE_URL); } catch { configErrors.push(`SUPABASE_URL n'est pas une URL valide : ${SUPABASE_URL}`); }
}
if (configErrors.length) {
  console.error("\nConfiguration incomplète dans skill-recorder/.env :\n");
  for (const e of configErrors) console.error(`  • ${e}`);
  console.error("");
  process.exit(1);
}

const storage = SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, {
    global: { fetch: (url, init = {}) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30000) }) },
  })
  : null;

const ts = () => new Date().toISOString();
const RPC_TIMEOUT_MS = { rec_claim: 45000, rec_events: 45000, rec_finish: 60000 };

// ── Identité de l'appareil ──────────────────────────────────────────────────
// Obtenue par appairage, puis conservée à côté du profil navigateur. Le token
// n'est jamais affiché ni saisi par un humain : ce qui transite sous ses yeux,
// c'est un code éphémère à 8 caractères, inutile sans une session FounderOS.
const AUTH_FILE = resolve(PROFILE_DIR, "..", ".auth.json");
let deviceToken = process.env.RECORDER_TOKEN || null;

function loadDeviceToken() {
  if (deviceToken) return deviceToken;
  try {
    const saved = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    if (saved?.token) deviceToken = saved.token;
  } catch { /* pas encore appairé */ }
  return deviceToken;
}

function saveDeviceToken(token, workspaceId) {
  deviceToken = token;
  try {
    writeFileSync(AUTH_FILE, JSON.stringify({ token, workspace_id: workspaceId, paired_at: ts() }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn(`  impossible d'écrire ${AUTH_FILE} (${e.message}) — l'appairage sera à refaire au prochain démarrage.`);
  }
}

async function rpc(body) {
  const timeout = RPC_TIMEOUT_MS[body?.mode] ?? 45000;
  let res;
  try {
    // Les modes d'appairage voyagent SANS identité — c'est justement ce qu'ils
    // servent à obtenir. Le token runner reste accepté pour un déploiement qui
    // en dispose déjà, mais il n'est plus requis de personne.
    const headers = { "Content-Type": "application/json" };
    if (deviceToken) headers["X-Recorder-Token"] = deviceToken;
    else if (RUNNER_TOKEN) headers["X-Runner-Token"] = RUNNER_TOKEN;

    res = await fetch(POLL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error(`${body?.mode ?? "rpc"} a expiré après ${Math.round(timeout / 1000)}s`);
    }
    // undici résume TOUTE panne réseau par « fetch failed » et range le motif
    // réel (ENOTFOUND, ECONNREFUSED, certificat…) dans `cause`. Sans ça, une URL
    // mal saisie et un serveur éteint donnent le même message inexploitable.
    const cause = e.cause?.code ? `${e.cause.code}${e.cause.hostname ? ` (${e.cause.hostname})` : ""}` : e.cause?.message;
    throw new Error(cause ? `${e.message} — ${cause}` : e.message);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

let warnedNoStorage = false;
async function snapshot(page, recordingId, idx) {
  if (!storage) {
    if (!warnedNoStorage) {
      console.warn("  [vignettes] SUPABASE_SERVICE_ROLE_KEY absent — la timeline n'aura pas d'images.");
      warnedNoStorage = true;
    }
    return null;
  }
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false, timeout: 5000 });
    const path = `${recordingId}/${String(idx).padStart(4, "0")}.jpg`;
    const { error } = await storage.storage.from("skill-recordings")
      .upload(path, buf, { contentType: "image/jpeg", upsert: true });
    if (error) return null;
    return storage.storage.from("skill-recordings").getPublicUrl(path).data.publicUrl;
  } catch {
    return null;
  }
}

// ── Une session d'enregistrement ────────────────────────────────────────────

async function record(recording) {
  const startedMs = recording.started_at ? Date.parse(recording.started_at) : Date.now();
  const atMs = (t) => Math.max(0, Math.round((t ?? Date.now()) - startedMs));

  console.log(`[${ts()}] ▶ enregistrement « ${recording.title} » (${recording.id})`);
  if (recording.goal) console.log(`         objectif : ${recording.goal}`);

  mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  });

  const queue = [];
  let seq = 0;
  let shotIdx = 0;
  let lastShotAt = 0;
  let stopping = false;
  let closed = false;

  const push = (ev) => {
    queue.push({
      source: "browser",
      seq: seq++,
      at_ms: atMs(ev.t),
      kind: ev.kind,
      url: ev.url ?? null,
      // `frame` n'est renseigné que pour un geste survenu dans une iframe : le
      // garder évite qu'un agent cherche l'élément dans le document principal.
      target: ev.frame ? { ...(ev.target ?? {}), frame: ev.frame } : (ev.target ?? {}),
      value: ev.value ?? null,
      is_secret: ev.is_secret === true,
      screenshot_url: ev.screenshot_url ?? null,
    });
    if (queue.length > 3000) queue.splice(0, queue.length - 3000);
  };

  // Le binding est posé AVANT les init scripts, donc il existe déjà quand
  // instrument.js s'exécute — y compris dans les iframes.
  await context.exposeBinding("__skillRecordPush", async (source, json) => {
    if (stopping) return;
    let ev;
    try { ev = JSON.parse(json); } catch { return; }

    // Une vignette sur les gestes structurants seulement, et au plus une toutes
    // les 2 s : la capture coûte ~150 ms, elle ne doit pas suivre la frappe.
    const worthAShot = ["click", "submit", "select", "upload"].includes(ev.kind);
    if (worthAShot && Date.now() - lastShotAt > 2000) {
      lastShotAt = Date.now();
      ev.screenshot_url = await snapshot(source.page, recording.id, shotIdx++);
    }
    push(ev);
  });

  await context.addInitScript({ path: resolve(HERE, "instrument.js") });
  // Origine du chrono affichée par le bandeau REC, identique dans tous les onglets.
  await context.addInitScript(`window.__skillRecStartedAt = ${startedMs};`);

  // Navigations = étapes à part entière : l'agent devra les rejouer.
  const watchPage = (page) => {
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame() || stopping) return;
      const url = frame.url();
      if (!url || url === "about:blank") return;
      push({ kind: "navigate", url, target: {}, t: Date.now() });
    });
    page.on("close", () => { if (!stopping) push({ kind: "tab_close", target: {}, t: Date.now() }); });
  };

  context.on("page", (page) => {
    if (stopping) return;
    push({ kind: "tab_open", url: page.url(), target: {}, t: Date.now() });
    watchPage(page);
  });
  context.on("close", () => { closed = true; });

  const page = context.pages()[0] ?? await context.newPage();
  watchPage(page);
  try {
    await page.goto(recording.start_url || "about:blank", { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (e) {
    console.warn(`  page de départ non chargée : ${e.message}`);
  }

  // ── Boucle de poussée ─────────────────────────────────────────────────────
  // Elle tourne même à vide : c'est aussi le battement de cœur et le seul canal
  // par lequel l'ordre d'arrêt de l'app nous parvient.
  let stopReason = null;
  let flushError = null;
  while (!stopping) {
    await new Promise((r) => setTimeout(r, 1200));

    if (closed) { stopReason = "navigateur fermé par l'utilisateur"; break; }
    if (Date.now() - startedMs > MAX_RECORDING_MS) { stopReason = "durée maximale atteinte"; break; }

    const batch = queue.splice(0, 200);
    try {
      const res = await rpc({ mode: "rec_events", recording_id: recording.id, events: batch });
      if (batch.length) process.stdout.write(`\r  ${seq} gestes enregistrés   `);
      if (res.stop) { stopReason = res.status === "cancelled" ? "annulé depuis l'app" : "arrêté depuis l'app"; break; }
    } catch (e) {
      // Un lot perdu ne doit pas coûter la session : on le remet en tête et on
      // réessaiera au tour suivant (l'upsert côté serveur est idempotent).
      queue.unshift(...batch);
      flushError = e.message;
      console.warn(`\n  poussée échouée (${e.message}) — nouvelle tentative`);
    }
  }

  stopping = true;
  console.log(`\n[${ts()}] ⏹ ${stopReason ?? "arrêt"} — ${seq} gestes`);

  // Dernier lot avant fermeture : c'est souvent là que se trouve le geste final.
  if (queue.length) {
    try { await rpc({ mode: "rec_events", recording_id: recording.id, events: queue.splice(0, 500) }); }
    catch (e) { console.warn(`  lot final perdu : ${e.message}`); }
  }

  try { if (!closed) await context.close(); } catch { /* déjà fermé */ }

  const res = await rpc({
    mode: "rec_finish",
    recording_id: recording.id,
    duration_ms: Date.now() - startedMs,
    error: flushError && !seq ? flushError : undefined,
  });
  console.log(`[${ts()}] ${res.synthesizing ? "🧠 synthèse de la compétence en cours…" : "sans synthèse (annulé)"}`);
}

// ── Appairage ───────────────────────────────────────────────────────────────
// Flux « device code », comme `gh auth login` : l'appareil affiche un code,
// l'humain le saisit dans une app où il est DÉJÀ authentifié, et c'est cette
// saisie qui lie l'appareil à son workspace. Rien à copier dans un fichier,
// aucun secret sous les yeux de qui que ce soit.
async function pair() {
  // Demander un code est la toute première chose que fait un recorder neuf : un
  // échec ici est le plus souvent un backend pas encore à jour, pas une panne.
  // Il doit se lire comme une consigne, pas comme une stack trace.
  let started;
  for (let attempt = 1; ; attempt++) {
    try {
      started = await rpc({ mode: "rec_pair_start", name: `${os.hostname()} (${os.platform()})` });
      break;
    } catch (e) {
      if (/X-Runner-Token|Unknown mode/i.test(e.message)) {
        console.error("");
        console.error("  L'appairage n'est pas disponible sur ce projet Supabase :");
        console.error("  la fonction test-runner-poll déployée date d'avant cette fonctionnalité.");
        console.error("");
        console.error("      supabase functions deploy test-runner-poll test-run-orchestrate");
        console.error("");
        // process.exit() ici tuerait le process avec des sockets encore ouverts
        // (undici garde le keep-alive), ce qui fait râler libuv sur Windows. On
        // rend la main et on laisse la boucle d'événements se vider.
        process.exitCode = 1;
        return false;
      }
      console.warn(`  appairage indisponible (${e.message}) — nouvelle tentative dans 5 s${attempt > 3 ? ` [${attempt}]` : ""}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const { device_id, code, expires_in_s } = started;

  const box = (line) => console.log(`         │  ${line}`);
  console.log("");
  console.log("  ┌──────────────────────────────────────────────┐");
  console.log("  │  Cet appareil n'est pas encore appairé.       │");
  console.log("  └──────────────────────────────────────────────┘");
  console.log("");
  console.log(`         Code d'appairage :   ${code}`);
  console.log("");
  box("Dans FounderOS : Skills → Enregistrer une");
  box("démonstration, puis saisissez ce code.");
  console.log("");
  console.log(`         (valable ${Math.round((expires_in_s ?? 600) / 60)} minutes)`);
  console.log("");

  const deadline = Date.now() + (expires_in_s ?? 600) * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    let res;
    try {
      res = await rpc({ mode: "rec_pair_poll", device_id });
    } catch (e) {
      console.warn(`  appairage : ${e.message}`);
      continue;
    }
    if (res.paired && res.token) {
      saveDeviceToken(res.token, res.workspace_id);
      console.log(`[${ts()}] ✓ appareil appairé — l'identité est conservée, ce code ne resservira pas.`);
      return true;
    }
    if (res.expired || Date.now() > deadline) {
      console.log("  code expiré — un nouveau va être généré.");
      return pair();
    }
  }
}

// ── Boucle principale ───────────────────────────────────────────────────────

async function main() {
  console.log(`[${ts()}] Skill Recorder ${RUNNER_ID}`);
  console.log(`         profil navigateur : ${PROFILE_DIR}`);

  // L'appairage précède tout : sans identité, aucune démonstration ne peut être
  // réclamée. Une fois fait, il ne se reproduit plus (sauf révocation).
  if (!loadDeviceToken() && !RUNNER_TOKEN) {
    if (await pair() === false) return; // config à corriger, message déjà affiché
  }

  console.log("         en attente d'un enregistrement lancé depuis FounderOS…");

  // Une panne qui dure produit la même ligne toutes les 3 s. On la dit une fois,
  // puis on ne rappelle que périodiquement — un mur de lignes identiques cache
  // l'information au lieu de la donner.
  let lastError = null;
  let repeats = 0;

  for (;;) {
    try {
      // `capture` évite de rafler une démonstration que l'utilisateur destinait à
      // l'extension navigateur (voir migration 0204).
      const { recording } = await rpc({ mode: "rec_claim", runner_id: RUNNER_ID, workspace_id: WORKSPACE_ID, capture: "playwright" });
      if (lastError) {
        console.log(`[${ts()}] connexion rétablie.`);
        lastError = null; repeats = 0;
      }
      if (recording) {
        await record(recording);
        console.log(`[${ts()}] en attente du prochain enregistrement…`);
        continue;
      }
    } catch (e) {
      if (e.message === lastError) {
        repeats++;
        // ~1 rappel par minute, avec le compte des tentatives muettes.
        if (repeats % 20 === 0) console.warn(`[${ts()}] toujours en échec (${repeats} tentatives) : ${e.message}`);
      } else {
        lastError = e.message; repeats = 1;
        // Un appareil révoqué (ou dont la base a été réinitialisée) doit se
        // réappairer, pas boucler sur un 401 jusqu'à la fin des temps.
        if (/Appareil (inconnu|révoqué)/i.test(e.message)) {
          console.warn(`[${ts()}] ${e.message}`);
          deviceToken = null;
          try { writeFileSync(AUTH_FILE, "{}", { mode: 0o600 }); } catch { /* tant pis */ }
          await pair();
          lastError = null; repeats = 0;
          continue;
        }
        console.warn(`[${ts()}] ${e.message}`);
        if (/ENOTFOUND|EAI_AGAIN/.test(e.message)) {
          console.warn("         → SUPABASE_URL pointe vers un hôte introuvable. Vérifiez skill-recorder/.env.");
        } else if (/HTTP 401|Unknown runner token/i.test(e.message)) {
          console.warn("         → identité refusée. Supprimez skill-recorder/.auth.json et relancez pour réappairer.");
        } else if (/HTTP 404|Unknown mode/i.test(e.message)) {
          console.warn("         → l'edge function test-runner-poll n'est pas déployée dans sa version à jour :");
          console.warn("           supabase functions deploy test-runner-poll");
        }
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(`[${ts()}] fatal : ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
