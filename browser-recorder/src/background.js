// background.js — le chef d'orchestre de l'extension.
//
// Il fait ce que fait skill-recorder/src/index.js : réclamer une démonstration,
// collecter les gestes, les pousser par lots, écouter l'ordre d'arrêt, déclencher
// la synthèse. Deux différences imposées par le milieu :
//
//   1. UN SERVICE WORKER MV3 MEURT. Après ~30 s sans événement, le navigateur le
//      décharge — au beau milieu d'une démonstration si l'utilisateur s'arrête
//      pour lire une page. Tout l'état vit donc dans chrome.storage.session, et
//      une alarme le ressuscite pour pousser. Garder l'état en mémoire vive
//      aurait perdu des gestes ET tari le battement de cœur, ce que l'app aurait
//      signalé comme « recorder mort » à tort.
//
//   2. L'INSTRUMENTATION EST INJECTÉE À LA DEMANDE. content.js n'est pas déclaré
//      dans le manifeste : hors enregistrement, il n'existe dans aucune de vos
//      pages. C'est ce qui rend acceptable d'enregistrer dans vos propres
//      onglets — la garantie n'est pas une promesse, c'est une absence de code.

import { api, rpc, getSettings, pollPairing, forgetDevice } from "./api.js";
import { runCommand } from "./executor.js";

const STATE_KEY = "rec:state";
const FLUSH_MS = 1500;
const CONTROL_POLL_MS = 1500;
// L'app considère le recorder mort après 90 s de silence. L'alarme de secours
// doit donc battre bien en deçà, même quand le service worker dort.
const ALARM_NAME = "rec:tick";
const ALARM_PERIOD_MIN = 0.5;

// ── État persistant ─────────────────────────────────────────────────────────

async function loadState() {
  const got = await api.storage.session.get(STATE_KEY);
  return got[STATE_KEY] ?? null;
}
async function saveState(state) {
  await api.storage.session.set({ [STATE_KEY]: state });
}
async function clearState() {
  await api.storage.session.remove(STATE_KEY);
}

// Le stockage est ASYNCHRONE, et deux flux le modifient : les gestes qui
// arrivent des onglets, et la poussée périodique. Sans sérialisation, un geste
// lu-modifié-écrit pendant qu'un envoi écrit de son côté écraserait l'autre —
// et le geste disparaîtrait sans la moindre erreur. Une file d'attente d'une
// ligne suffit à rendre chaque section critique atomique.
let chain = Promise.resolve();
function withState(fn) {
  const run = chain.then(fn, fn);
  // La chaîne ne doit jamais se rompre sur une erreur d'une section.
  chain = run.then(() => {}, () => {});
  return run;
}

async function setBadge(text, color = "#ef4444") {
  try {
    await api.action.setBadgeText({ text });
    if (text) await api.action.setBadgeBackgroundColor({ color });
  } catch { /* certains navigateurs limitent l'API action */ }
}

// ── Injection ───────────────────────────────────────────────────────────────

/**
 * Reconnaître un onglet FounderOS.
 *
 * L'identification par tab_id seule était trop fragile : elle dépendait qu'une
 * page se déclare, ce que seule la page d'enregistrement faisait. Un agent
 * lancé depuis le chat détournait donc l'onglet où on lui parlait. On mémorise
 * désormais l'ORIGINE, durablement (storage.local) : une fois qu'un onglet
 * FounderOS a été vu sur un domaine, tous les onglets de ce domaine sont
 * protégés, y compris après un redémarrage du navigateur.
 */
async function appOrigins() {
  const { appOrigins: saved } = await api.storage.local.get("appOrigins");
  return new Set(saved ?? []);
}

async function rememberAppOrigin(url) {
  if (!url) return;
  try {
    const origin = new URL(url).origin;
    const known = await appOrigins();
    if (known.has(origin)) return;
    known.add(origin);
    await api.storage.local.set({ appOrigins: [...known] });
  } catch { /* URL inexploitable */ }
}

function isAppTab(tab, appTabIds, origins) {
  if (tab.id != null && appTabIds.has(tab.id)) return true;
  try { return origins.has(new URL(tab.url ?? "").origin); } catch { return false; }
}

/** Les onglets observables : ni les pages internes du navigateur (où aucune
 *  extension ne peut s'injecter), ni FounderOS lui-même — les clics dans le
 *  panneau de contrôle ne font pas partie de la démonstration. */
async function recordableTabs(state) {
  const tabs = await api.tabs.query({});
  const appTabs = new Set(state?.appTabIds ?? []);
  const origins = await appOrigins();
  return tabs.filter((t) =>
    t.id != null
    && /^https?:/.test(t.url ?? "")
    && !isAppTab(t, appTabs, origins),
  );
}

async function injectInto(tabId, startedAt) {
  try {
    await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["src/content.js"],
    });
    await api.tabs.sendMessage(tabId, { type: "rec:started_at", value: startedAt }).catch(() => {});
  } catch {
    // Page protégée (chrome://, Web Store, PDF natif) : rien à faire, et ce
    // n'est pas une erreur — juste une page que l'extension ne peut pas voir.
  }
}

// ── Cycle de vie d'un enregistrement ────────────────────────────────────────

/**
 * Garantit que l'appareil possède son jeton.
 *
 * L'appairage se termine en DEUX temps : l'utilisateur saisit le code dans
 * l'app (ce qui lie l'appareil), puis quelqu'un doit appeler rec_pair_poll pour
 * retirer le jeton. Confier cette seconde étape à la popup était une erreur :
 * elle se ferme dès qu'on clique ailleurs — c'est-à-dire systématiquement, vu
 * qu'il faut aller taper le code dans FounderOS. L'appareil restait alors
 * appairé côté serveur et sans identité côté navigateur, à ne rien réclamer.
 */
async function ensureIdentity() {
  const { token, deviceId } = await getSettings();
  if (token) return true;
  if (!deviceId) return false;
  try {
    const res = await pollPairing();
    return !!(res.paired && res.token);
  } catch {
    return false;
  }
}

async function claim() {
  if (!(await ensureIdentity())) return null;

  const existing = await loadState();
  if (existing?.recordingId) return existing;

  // Se déclarer est ce qui garantit qu'on ne prendra pas une démonstration
  // destinée au recorder Playwright (voir migration 0204).
  const { recording } = await rpc({ mode: "rec_claim", runner_id: "extension", capture: "extension" });
  if (!recording) return null;

  const startedAt = recording.started_at ? Date.parse(recording.started_at) : Date.now();
  const state = {
    recordingId: recording.id,
    title: recording.title,
    startedAt,
    seq: 0,
    shotIdx: 0,
    lastShotAt: 0,
    queue: [],
    appTabIds: existing?.appTabIds ?? [],
  };
  await saveState(state);
  await setBadge("REC");

  for (const tab of await recordableTabs(state)) await injectInto(tab.id, startedAt);

  // L'URL de départ, s'il y en a une, s'ouvre dans un nouvel onglet du
  // navigateur COURANT — pas dans une fenêtre séparée.
  if (recording.start_url) {
    try {
      const tab = await api.tabs.create({ url: recording.start_url, active: true });
      // L'injection suivra via tabs.onUpdated, une fois la page chargée.
      void tab;
    } catch { /* URL invalide : l'utilisateur naviguera lui-même */ }
  }

  await api.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  return state;
}

async function flush() {
  // Le lot est prélevé sous verrou ; l'envoi réseau, lui, se fait en dehors —
  // le tenir sous verrou bloquerait la collecte des gestes pendant toute la
  // requête, et c'est précisément ce qu'on ne veut pas rater.
  const taken = await withState(async () => {
    const state = await loadState();
    if (!state?.recordingId) return null;
    const batch = state.queue.splice(0, 200);
    await saveState(state);
    return { recordingId: state.recordingId, batch };
  });
  if (!taken) return;

  let res;
  try {
    res = await rpc({ mode: "rec_events", recording_id: taken.recordingId, events: taken.batch });
  } catch (e) {
    // Lot remis en tête : l'upsert serveur est idempotent, un renvoi ne
    // duplique rien. Perdre un lot pour une coupure passagère serait absurde.
    await withState(async () => {
      const fresh = await loadState();
      if (fresh?.recordingId === taken.recordingId) {
        fresh.queue = [...taken.batch, ...fresh.queue];
        await saveState(fresh);
      }
    });
    if (/Appareil (inconnu|révoqué)/i.test(e.message)) {
      await forgetDevice();
      await stopRecording("appareil révoqué");
    }
    return;
  }

  if (res.stop) {
    await stopRecording(res.status === "cancelled" ? "annulé" : "arrêté depuis l'app");
  }
}

async function stopRecording(reason) {
  const state = await loadState();
  if (!state?.recordingId) return;

  // Dernier lot : c'est souvent là que se trouve le geste final.
  if (state.queue.length) {
    try {
      await rpc({ mode: "rec_events", recording_id: state.recordingId, events: state.queue.splice(0, 500) });
    } catch { /* la synthèse partira sans lui */ }
  }

  for (const tab of await recordableTabs(state)) {
    api.tabs.sendMessage(tab.id, { type: "rec:stop" }).catch(() => {});
  }

  try {
    await rpc({
      mode: "rec_finish",
      recording_id: state.recordingId,
      duration_ms: Date.now() - state.startedAt,
    });
  } catch { /* l'app peut relancer la synthèse elle-même */ }

  await clearState();
  await setBadge("");
  await api.alarms.clear(ALARM_NAME);
  console.log(`[skill-recorder] enregistrement terminé (${reason})`);
}

// ── Captures ────────────────────────────────────────────────────────────────

async function maybeCapture(state, kind) {
  const worth = ["click", "submit", "select", "upload"].includes(kind);
  if (!worth || Date.now() - (state.lastShotAt ?? 0) < 2000) return null;
  state.lastShotAt = Date.now();
  try {
    const dataUrl = await api.tabs.captureVisibleTab(undefined, { format: "jpeg", quality: 55 });
    if (!dataUrl) return null;
    const res = await rpc({
      mode: "rec_shot",
      recording_id: state.recordingId,
      idx: state.shotIdx++,
      image: dataUrl,
    });
    return res.url ?? null;
  } catch {
    // Onglet non capturable, permission refusée, image trop grosse : la
    // timeline perd une vignette, pas un geste.
    return null;
  }
}

// ── Pilotage par un agent ───────────────────────────────────────────────────
// N'existe que dans la fenêtre d'armement décidée par l'utilisateur. Le serveur
// ne remet aucun ordre hors de cette fenêtre ; ce qui suit ne s'exécute donc
// jamais « par erreur ».

/**
 * L'onglet visé. Un agent doit pouvoir travailler sur N'IMPORTE LEQUEL des
 * onglets ouverts — comparer deux fiches, recopier d'un outil vers un autre —
 * et pas seulement sur celui qui a le focus. `tab_id` désigne donc l'onglet
 * explicitement ; sans lui on retombe sur l'onglet actif, qui est le sens
 * naturel de « la page ».
 */
async function targetTab(state, params = {}) {
  const appTabs = new Set(state?.appTabIds ?? []);
  const origins = await appOrigins();

  if (params.tab_id != null) {
    try {
      const tab = await api.tabs.get(Number(params.tab_id));
      if (tab && /^https?:/.test(tab.url ?? "") && !isAppTab(tab, appTabs, origins)) return tab;
    } catch { /* onglet fermé entre-temps */ }
    return null;
  }

  const [active] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && /^https?:/.test(active.url ?? "") && !isAppTab(active, appTabs, origins)) return active;
  const others = await recordableTabs(state);
  return others[others.length - 1] ?? null;
}

/** Un onglet déjà ouvert sur le même hôte, s'il en existe un. */
async function tabOnHost(url, state) {
  let host;
  try { host = new URL(url).host; } catch { return null; }
  const candidates = await recordableTabs(state);
  return candidates.find((t) => { try { return new URL(t.url).host === host; } catch { return false; } }) ?? null;
}

/** Le périmètre autorisé est vérifié ICI, sur l'URL réelle de l'onglet — pas
 *  sur ce que l'ordre prétend viser. */
function originAllowed(url, origins) {
  if (!origins?.length) return true;
  try {
    const host = new URL(url).host;
    return origins.some((o) => {
      const clean = String(o).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      return host === clean || host.endsWith(`.${clean}`);
    });
  } catch { return false; }
}

async function runOneCommand(cmd, state, origins) {
  const params = cmd.params ?? {};
  const appTabs = new Set(state?.appTabIds ?? []);

  // ── Ordres portant sur les ONGLETS eux-mêmes ──
  // Traités par le service worker : ils ne s'exécutent pas DANS une page.

  if (cmd.action === "tabs") {
    const all = await api.tabs.query({});
    // Le périmètre autorisé vaut aussi pour la LECTURE : lister les onglets
    // révèle les URL de tout ce qui est ouvert. Armer « ce site uniquement » ne
    // doit pas laisser fuiter le reste de la navigation de quelqu'un.
    const visible = all.filter((t) =>
      t.id != null && !appTabs.has(t.id)
      && /^https?:/.test(t.url ?? "")
      && originAllowed(t.url, origins),
    );
    return {
      result: {
        ok: true,
        hidden: all.length - visible.length,
        tabs: visible.map((t) => ({
          tab_id: t.id,
          title: (t.title ?? "").slice(0, 120),
          url: (t.url ?? "").slice(0, 300),
          active: !!t.active,
        })),
      },
    };
  }

  if (cmd.action === "open") {
    const url = String(params.url ?? "");
    if (!/^https?:\/\//.test(url)) return { error: "URL invalide (http/https attendu)" };
    if (!originAllowed(url, origins)) return { error: `Domaine hors du périmètre autorisé : ${url}` };
    const tab = await api.tabs.create({ url, active: params.active !== false });
    await new Promise((r) => setTimeout(r, 1500));
    return { result: { ok: true, tab_id: tab.id, url } };
  }

  if (cmd.action === "switch") {
    const tab = await targetTab(state, params);
    if (!tab) return { error: "Onglet introuvable (tab_id invalide ou onglet fermé)" };
    if (!originAllowed(tab.url, origins)) return { error: "Onglet hors du périmètre autorisé" };
    await api.tabs.update(tab.id, { active: true });
    await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { result: { ok: true, tab_id: tab.id, url: tab.url } };
  }

  if (cmd.action === "close") {
    const tab = await targetTab(state, params);
    if (!tab) return { error: "Onglet introuvable" };
    if (!originAllowed(tab.url, origins)) return { error: "Onglet hors du périmètre autorisé" };
    await api.tabs.remove(tab.id);
    return { result: { ok: true, closed: tab.id } };
  }

  if (cmd.action === "navigate") {
    const url = String(params.url ?? "");
    if (!/^https?:\/\//.test(url)) return { error: "URL invalide (http/https attendu)" };
    if (!originAllowed(url, origins)) return { error: `Domaine hors du périmètre autorisé : ${url}` };

    // L'ordre de préférence compte, et l'ancien était le mauvais : il chargeait
    // l'URL dans l'onglet ACTIF, c'est-à-dire celui que l'utilisateur était en
    // train de lire. Aller sur LinkedIn écrasait la page en cours alors qu'un
    // onglet LinkedIn était déjà ouvert deux crans plus loin.
    //
    //   1. tab_id explicite   — l'agent sait ce qu'il veut
    //   2. un onglet DÉJÀ sur cet hôte — on reprend le travail là où il est
    //   3. un nouvel onglet   — on n'écrase jamais ce que quelqu'un regarde
    let tab = null;
    let reused = false;
    if (params.tab_id != null) {
      tab = await targetTab(state, params);
      if (!tab) return { error: `Onglet ${params.tab_id} introuvable` };
    } else if (params.new_tab !== true) {
      tab = await tabOnHost(url, state);
      reused = !!tab;
    }

    const updated = tab
      ? await api.tabs.update(tab.id, { url, active: true })
      : await api.tabs.create({ url, active: true });
    // Laisser la page charger, sinon l'ordre suivant agirait sur l'ancienne.
    await new Promise((r) => setTimeout(r, 1500));
    return { result: { ok: true, url, tab_id: updated.id, reused_existing_tab: reused } };
  }

  // ── Ordres s'exécutant DANS une page ──
  const tab = await targetTab(state, params);
  if (!tab) {
    return {
      error: params.tab_id != null
        ? `Onglet ${params.tab_id} introuvable (fermé, ou page interne du navigateur)`
        : "Aucun onglet exploitable (ouvrez une page http/https)",
    };
  }
  if (!originAllowed(tab.url, origins)) {
    return { error: `Onglet courant hors du périmètre autorisé (${tab.url ?? "?"})` };
  }

  try {
    const [res] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: runCommand,
      args: [{ action: cmd.action, params: cmd.params ?? {} }],
    });
    const value = res?.result;
    if (!value) return { error: "Aucun résultat renvoyé par la page" };
    return value.ok === false ? { error: value.error, result: value } : { result: value };
  } catch (e) {
    return { error: `Injection impossible : ${e.message}` };
  }
}

async function pumpControl() {
  const { token } = await getSettings();
  if (!token) return;

  let res;
  try {
    res = await rpc({ mode: "rec_control_poll" });
  } catch {
    return; // réseau : on réessaiera au tour suivant
  }

  await setControlBadge(res.armed, res.control_until);
  if (!res.armed || !res.commands?.length) return;

  const state = await loadState();
  for (const cmd of res.commands) {
    const outcome = await runOneCommand(cmd, state, res.origins);
    try {
      await rpc({ mode: "rec_control_result", command_id: cmd.id, ...outcome });
    } catch { /* le serveur périmera l'ordre */ }
  }
}

/** Le badge dit ce qui est vrai : REC pendant un enregistrement, ⚡ quand un
 *  agent peut piloter. L'utilisateur ne doit jamais avoir à deviner. */
async function setControlBadge(armed, until) {
  const state = await loadState();
  if (state?.recordingId) return; // REC prime
  if (armed) {
    await setBadge("⚡", "#f59e0b");
    await api.action.setTitle({ title: `Pilotage autorisé jusqu'à ${until ? new Date(until).toLocaleTimeString("fr-FR") : "?"}` }).catch(() => {});
  } else {
    await setBadge("");
    await api.action.setTitle({ title: "FounderOS Skill Recorder" }).catch(() => {});
  }
}

// ── Messages ────────────────────────────────────────────────────────────────

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const state = await loadState();

    switch (msg?.type) {
      // Un content script vient de s'installer : il veut l'origine du chrono.
      case "rec:hello":
        sendResponse({ startedAt: state?.startedAt ?? null });
        return;

      case "rec:event": {
        if (!state?.recordingId) return sendResponse({ ok: false });
        const ev = msg.event ?? {};
        // La capture sort du verrou : elle prend ~100 ms et fait un aller-retour
        // réseau. Le numéro de séquence, lui, est attribué sous verrou.
        const screenshotUrl = await maybeCapture(state, ev.kind);
        await withState(async () => {
          const fresh = await loadState();
          if (!fresh?.recordingId) return;
          fresh.lastShotAt = Math.max(fresh.lastShotAt ?? 0, state.lastShotAt ?? 0);
          fresh.shotIdx = Math.max(fresh.shotIdx ?? 0, state.shotIdx ?? 0);
          fresh.queue.push({
            source: "browser",
            seq: fresh.seq++,
            at_ms: Math.max(0, Math.round((ev.t ?? Date.now()) - fresh.startedAt)),
            kind: ev.kind,
            url: ev.url ?? null,
            target: ev.frame ? { ...(ev.target ?? {}), frame: ev.frame } : (ev.target ?? {}),
            value: ev.value ?? null,
            is_secret: ev.is_secret === true,
            screenshot_url: screenshotUrl,
          });
          if (fresh.queue.length > 3000) fresh.queue.splice(0, fresh.queue.length - 3000);
          await saveState(fresh);
        });
        sendResponse({ ok: true });
        return;
      }

      // L'onglet FounderOS se signale : on l'exclut de l'enregistrement, et sa
      // présence nous sert de déclencheur immédiat (voir bridge.js).
      case "rec:app_here": {
        const tabId = sender.tab?.id;
        // L'origine est mémorisée DURABLEMENT : c'est elle qui protège les
        // futurs onglets de l'app, y compris après redémarrage du navigateur.
        await rememberAppOrigin(sender.tab?.url ?? sender.url);
        const next = state ?? { appTabIds: [] };
        if (tabId != null && !next.appTabIds.includes(tabId)) {
          next.appTabIds = [...(next.appTabIds ?? []), tabId];
          if (state) await saveState(next);
          else await api.storage.session.set({ [STATE_KEY]: { appTabIds: next.appTabIds } });
        }
        sendResponse({ ok: true, version: api.runtime.getManifest().version, recording: !!state?.recordingId });
        return;
      }

      // « Démarrer » vient d'être pressé dans l'app : inutile d'attendre le
      // prochain battement d'alarme.
      case "rec:nudge":
        await claim();
        sendResponse({ ok: true });
        return;

      case "rec:status":
        sendResponse({
          recording: !!state?.recordingId,
          title: state?.title ?? null,
          startedAt: state?.startedAt ?? null,
          queued: state?.queue?.length ?? 0,
        });
        return;

      case "rec:stop_now":
        await stopRecording("arrêté depuis l'extension");
        sendResponse({ ok: true });
        return;

      default:
        sendResponse({ ok: false });
    }
  })();
  // Réponse asynchrone : sans ce `true`, le canal se referme avant sendResponse.
  return true;
});

// Un onglet ouvert ou rechargé PENDANT un enregistrement doit être instrumenté
// lui aussi — une démonstration passe presque toujours par plusieurs pages.
api.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  const state = await loadState();
  if (!state?.recordingId) return;
  if ((state.appTabIds ?? []).includes(tabId)) return;
  if (!/^https?:/.test(tab.url ?? "")) return;
  await injectInto(tabId, state.startedAt);
});

api.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadState();
  if (!state?.appTabIds?.includes(tabId)) return;
  state.appTabIds = state.appTabIds.filter((id) => id !== tabId);
  await saveState(state);
});

// Le battement : pousse les lots, et sert aussi de réveil quand le service
// worker a été déchargé. C'est également ici que l'appairage se conclut.
api.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const state = await loadState();
  if (state?.recordingId) await flush();
  else await claim().catch(() => {});
  await pumpControl().catch(() => {});
});

// Tant que le service worker est vivant, on pousse au rythme fin ; l'alarme
// prend le relais s'il s'endort.
setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
// Le pilotage demande un rythme interactif : un agent qui attend 30 s par clic
// serait inutilisable. L'alarme ne sert qu'à réveiller un worker endormi.
setInterval(() => { pumpControl().catch(() => {}); }, CONTROL_POLL_MS);

// Au démarrage du navigateur : reprendre l'alarme de réclamation si l'appareil
// est appairé, et finir un appairage laissé en suspens.
api.runtime.onStartup?.addListener(async () => {
  const { token, deviceId } = await getSettings();
  if (!token && deviceId) await pollPairing().catch(() => {});
  await api.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
});
api.runtime.onInstalled.addListener(async () => {
  await api.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
});
