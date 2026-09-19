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
import { runCoach } from "./coach.js";

const STATE_KEY = "rec:state";
// L'étape de formation en cours attend un HUMAIN : elle survivra donc presque
// toujours à la mort du service worker. Elle vit en storage, comme le reste.
const COACH_KEY = "rec:coach";
const COACH_TAB_KEY = "rec:coachTab";
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

// ── FORMATION ───────────────────────────────────────────────────────────────
//
// Le canal `coach` est l'inverse du pilotage : l'agent pose un repère, écrit
// une phrase, et c'est la PERSONNE qui agit. D'où trois différences de
// traitement qui justifient un chemin séparé plutôt qu'une action de plus dans
// runOneCommand :
//
//   1. le compte rendu est DIFFÉRÉ — il vient d'un geste humain, pas d'un
//      retour de fonction. On garde l'étape en suspens (COACH_KEY) et c'est le
//      message `coach:outcome` qui la referme ;
//   2. rien ne mute — la liste blanche ci-dessous est la garantie technique de
//      ce que promet l'armement « mode formation » ;
//   3. une navigation ne casse pas l'étape : on la ré-injecte dans la nouvelle
//      page, ou on la conclut, selon le geste attendu.

const COACH_ACTIONS = new Set(["guide_step", "guide_say", "guide_ask", "guide_end", "look", "tabs"]);

async function loadCoach() {
  const got = await api.storage.session.get(COACH_KEY);
  return got[COACH_KEY] ?? null;
}
async function saveCoach(pending) {
  if (pending) await api.storage.session.set({ [COACH_KEY]: pending });
  else await api.storage.session.remove(COACH_KEY);
}

// L'onglet où un repère est AFFICHÉ — distinct de l'étape en attente, qui n'est
// vraie que tant qu'on attend un geste. Sans lui, « Arrêter la formation »
// couperait le canal mais laisserait la bulle à l'écran : l'utilisateur verrait
// un bouton sans effet, ce qui est pire que pas de bouton du tout.
async function saveCoachTab(tabId) {
  if (tabId == null) await api.storage.session.remove(COACH_TAB_KEY);
  else await api.storage.session.set({ [COACH_TAB_KEY]: tabId });
}
async function loadCoachTab() {
  const got = await api.storage.session.get(COACH_TAB_KEY);
  return got[COACH_TAB_KEY] ?? null;
}
async function teardownCoachUi() {
  const tabId = await loadCoachTab();
  await saveCoachTab(null);
  if (tabId == null) return;
  await api.tabs.sendMessage(tabId, { type: "coach:teardown" }).catch(() => {});
}

/** Referme l'étape en suspens, une seule fois, quelle qu'en soit la cause. */
async function settleCoach(outcome, extra) {
  const pending = await loadCoach();
  if (!pending) return;
  await saveCoach(null);
  try {
    await rpc({ mode: "rec_control_result", command_id: pending.command_id, result: { ok: true, outcome, ...(extra || {}) } });
  } catch { /* le serveur périmera l'ordre */ }
}

async function runCoachCommand(cmd, state, origins) {
  const params = cmd.params ?? {};

  if (!COACH_ACTIONS.has(cmd.action)) {
    // Ce refus n'est pas une politesse : c'est la promesse du mode formation.
    // Un agent qui tente de cliquer pendant qu'il forme doit se heurter à un mur
    // ici, et pas seulement à une consigne dans son prompt.
    return { error: `Action « ${cmd.action} » interdite en mode formation : le coach montre, il n'agit pas. Demandez l'armement du pilotage si vous voulez agir.` };
  }

  if (cmd.action === "tabs") return runOneCommand({ ...cmd, action: "tabs" }, state, origins);

  const tab = await targetTab(state, params);
  if (!tab) return { error: "Aucun onglet exploitable (demandez à la personne d'ouvrir l'outil)" };
  if (!originAllowed(tab.url, origins)) {
    return { error: `Onglet hors du périmètre de formation autorisé (${tab.url ?? "?"})` };
  }

  // `look` est la lecture de la page, empruntée telle quelle à l'exécuteur :
  // c'est ce qui permet à l'agent de re-viser quand l'outil a changé depuis la
  // démonstration. Lire ne mute rien.
  if (cmd.action === "look") {
    return runOneCommand({ ...cmd, action: params.text === true ? "read" : "elements" }, state, origins);
  }

  const kind = cmd.action === "guide_step" ? "step"
    : cmd.action === "guide_ask" ? "ask"
      : cmd.action === "guide_end" ? "end" : "say";
  const payload = {
    kind,
    command_id: cmd.id,
    step: params.step ?? {},
    session: params.session ?? {},
  };

  let value;
  try {
    const [res] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: runCoach,
      args: [payload],
    });
    value = res?.result;
  } catch (e) {
    return { error: `Le repère n'a pas pu être affiché : ${e.message}` };
  }
  if (!value) return { error: "Aucune réponse de la page" };
  if (value.ok === false) return { error: value.reason ?? "affichage impossible", result: value };

  if (kind === "end") await saveCoachTab(null);
  else await saveCoachTab(tab.id);

  // L'étape attend un humain : on ne rend PAS compte maintenant. Elle est mise
  // en suspens avec sa propre échéance — plus longue que celle de l'agent, pour
  // que ce soit toujours lui qui renonce le premier et puisse revenir attendre.
  if (value.waiting) {
    await saveCoach({
      command_id: cmd.id,
      tab_id: tab.id,
      gesture: payload.step.gesture || (payload.step.target ? "click" : "none"),
      deadline: Date.now() + (Number(params.wait_s) || 240) * 1000 + 30_000,
      payload,
      url: tab.url ?? null,
    });
    return null; // pas de compte rendu : voir settleCoach
  }
  return { result: value };
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

  await setControlBadge(res.armed, res.control_until, res.coach_armed, res.coach_until);

  // « Arrêter la formation » doit se voir : le canal se referme côté serveur,
  // mais c'est ici qu'on retire le repère de la page. Un consentement qu'on
  // retire sans que rien ne change à l'écran n'a pas l'air d'avoir été retiré.
  // Le pilotage emporte le guidage (qui peut le plus peut le moins) : tant
  // qu'il est armé, un repère affiché a toujours un mandat.
  if (!res.coach_armed && !res.armed) {
    await settleCoach("quit", { note: "mode formation désactivé" });
    await teardownCoachUi();
  }

  // Une étape restée sans réponse doit mourir, sinon l'agent attendrait un
  // geste que personne ne fera plus — la personne a fermé l'onglet, ou est
  // partie déjeuner.
  const pending = await loadCoach();
  if (pending && Date.now() > pending.deadline) {
    await settleCoach("timeout", { note: "aucune réaction dans le temps imparti" });
  }

  if (!res.commands?.length) return;

  const state = await loadState();
  // Le périmètre suit l'armement qui autorise réellement l'ordre. Sans cette
  // distinction, quelqu'un qui n'a armé QUE le pilotage « ce site uniquement »
  // se ferait guider partout : le périmètre du mode formation vaut `[]` tant
  // qu'il n'a jamais été armé, et `[]` veut dire « tous les sites ».
  const coachOrigins = res.coach_armed ? (res.coach_origins ?? []) : (res.origins ?? []);
  for (const cmd of res.commands) {
    const outcome = cmd.channel === "coach"
      ? await runCoachCommand(cmd, state, coachOrigins)
      : await runOneCommand(cmd, state, res.origins);
    if (!outcome) continue; // étape de formation en attente d'un geste humain
    try {
      await rpc({ mode: "rec_control_result", command_id: cmd.id, ...outcome });
    } catch { /* le serveur périmera l'ordre */ }
  }
}

/** Le badge dit ce qui est vrai : REC pendant un enregistrement, ⚡ quand un
 *  agent peut piloter, 🎓 quand il ne peut que former. L'utilisateur ne doit
 *  jamais avoir à deviner — et surtout pas confondre les deux pouvoirs. */
async function setControlBadge(armed, until, coachArmed, coachUntil) {
  const state = await loadState();
  if (state?.recordingId) return; // REC prime
  const hhmm = (v) => (v ? new Date(v).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "?");
  if (armed) {
    await setBadge("⚡", "#f59e0b");
    await api.action.setTitle({ title: `Pilotage autorisé jusqu'à ${hhmm(until)}` }).catch(() => {});
  } else if (coachArmed) {
    await setBadge("🎓", "#7C5CFF");
    await api.action.setTitle({ title: `Mode formation jusqu'à ${hhmm(coachUntil)} — l'agent affiche des repères, il ne clique pas` }).catch(() => {});
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

      // Le geste attendu vient d'avoir lieu — ou la personne a dit qu'elle
      // bloquait. C'est LE compte rendu d'une étape de formation ; il arrive
      // par ce chemin plutôt que par le retour de l'injection, parce qu'entre
      // les deux le service worker a eu tout le temps de mourir (et de
      // ressusciter : recevoir ce message suffit à le réveiller).
      case "coach:outcome": {
        const pending = await loadCoach();
        if (!pending || pending.command_id !== msg.command_id) {
          // Étape déjà close (périmée, ou remplacée par la suivante). On ne
          // rouvre rien : le premier verdict rendu fait foi.
          sendResponse({ ok: false, stale: true });
          return;
        }
        await saveCoach(null);
        try {
          await rpc({
            mode: "rec_control_result",
            command_id: msg.command_id,
            result: {
              ok: true,
              outcome: msg.outcome,
              url: msg.url ?? null,
              duration_ms: msg.duration_ms ?? null,
              hints: msg.hints ?? 0,
              ...(msg.answer != null ? { answer: msg.answer } : {}),
              ...(msg.note ? { note: msg.note } : {}),
              ...(msg.typed ? { typed: msg.typed } : {}),
            },
          });
        } catch { /* le serveur périmera l'ordre */ }
        sendResponse({ ok: true });
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

  // Une formation traverse les pages : cliquer « Se connecter » recharge tout,
  // et le repère meurt avec la page. Selon le geste attendu, ce changement est
  // soit LA preuve que la personne a fait ce qu'on lui demandait, soit
  // simplement le décor qui bouge — auquel cas on replante le repère.
  const pending = await loadCoach();
  if (pending && pending.tab_id === tabId) {
    const sameUrl = pending.url && tab.url && pending.url.split("#")[0] === tab.url.split("#")[0];
    if (!sameUrl && (pending.gesture === "navigate" || pending.gesture === "click")) {
      await settleCoach("done", { note: "la page a changé — le geste a produit son effet", url: tab.url ?? null });
    } else if (/^https?:/.test(tab.url ?? "")) {
      try {
        await api.scripting.executeScript({ target: { tabId }, func: runCoach, args: [pending.payload] });
      } catch { /* page interne ou onglet fermé : l'échéance tranchera */ }
    }
  }

  const state = await loadState();
  if (!state?.recordingId) return;
  if ((state.appTabIds ?? []).includes(tabId)) return;
  if (!/^https?:/.test(tab.url ?? "")) return;
  await injectInto(tabId, state.startedAt);
});

api.tabs.onRemoved.addListener(async (tabId) => {
  // L'onglet où se déroulait la formation vient d'être fermé : personne ne fera
  // plus le geste attendu. Le dire tout de suite vaut mieux que laisser l'agent
  // attendre quatre minutes dans le vide.
  const pending = await loadCoach();
  if (pending?.tab_id === tabId) {
    await settleCoach("quit", { note: "l'onglet de formation a été fermé" });
  }

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
