// panel.js — l'hôte du panneau latéral.
//
// Le panneau n'a PAS d'interface propre pour parler aux collaborateurs : il
// affiche l'app elle-même (route /companion) dans un iframe, avec la session de
// la personne. C'est ce qui garantit que le chat du panneau EST celui de l'app —
// mêmes composants, mêmes validations en ligne, mêmes livrables — au lieu d'une
// copie qui divergerait à la première évolution.
//
// Ce que l'iframe ne peut pas faire, l'hôte le fait pour lui : lire l'onglet
// actif, y surligner, y pointer un élément, suivre les changements d'onglet.
// Les deux se parlent par postMessage, origine vérifiée dans les deux sens.

import { api, getSettings, setSettings, startPairing, pollPairing } from "./api.js";
import { extractPage, runCompanion } from "./companion.js";

const $ = (id) => document.getElementById(id);
const VERSION = api.runtime.getManifest().version;

let windowId = null;
let appOrigin = null;
let appReady = false;
let readyTimer = null;
let port = null;
let activeTab = null;
let currentAgent = null;
let selectionPill = true;
const pending = [];

// ── Écrans ──────────────────────────────────────────────────────────────────

function show(name) {
  for (const s of document.querySelectorAll(".screen")) s.classList.toggle("on", s.id === `s-${name}`);
  $("app").classList.toggle("on", name === "app");
}

async function knownOrigins() {
  const { appOrigins } = await api.storage.local.get("appOrigins");
  return Array.isArray(appOrigins) ? appOrigins : [];
}

/** L'adresse de l'app : réglée une fois, sinon devinée. L'extension a déjà vu
 *  passer les onglets Anduran (bridge.js lit leur marqueur) — s'il n'y en a
 *  qu'un, il n'y a rien à demander. */
async function resolveAppUrl() {
  const { appUrl } = await api.storage.local.get("appUrl");
  if (appUrl) return appUrl;
  const origins = await knownOrigins();
  if (origins.length === 1) {
    await api.storage.local.set({ appUrl: origins[0] });
    return origins[0];
  }
  return null;
}

async function showSetup() {
  show("setup");
  const list = $("origins");
  list.innerHTML = "";
  for (const o of await knownOrigins()) {
    const b = document.createElement("button");
    b.textContent = o.replace(/^https?:\/\//, "");
    b.title = o;
    b.onclick = () => saveUrl(o);
    list.appendChild(b);
  }
  if (list.children.length) {
    const p = document.createElement("p");
    p.textContent = "Espaces déjà ouverts dans ce navigateur :";
    list.prepend(p);
  }
}

async function saveUrl(raw) {
  $("setup-err").textContent = "";
  let origin;
  try {
    const u = new URL(String(raw).trim());
    if (!/^https?:$/.test(u.protocol)) throw new Error("protocole");
    origin = u.origin;
  } catch {
    $("setup-err").textContent = "Entrez une adresse complète, par exemple https://app.exemple.com";
    return;
  }
  await api.storage.local.set({ appUrl: origin });
  await load();
}

async function load() {
  $("settings").classList.remove("on");
  const url = await resolveAppUrl();
  if (!url) { await showSetup(); return; }
  appOrigin = new URL(url).origin;
  appReady = false;
  show("loading");
  $("app").src = `${appOrigin}/companion?ext=${encodeURIComponent(VERSION)}`;
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    if (appReady) return;
    $("failed-url").textContent = appOrigin.replace(/^https?:\/\//, "");
    show("failed");
  }, 15000);
}

// ── Dialogue avec l'app ─────────────────────────────────────────────────────

function toApp(msg) {
  if (!appOrigin) return;
  $("app").contentWindow?.postMessage({ __anduran: 1, ...msg }, appOrigin);
}

function deliverIntent(intent) {
  if (appReady) toApp({ type: "intent", intent });
  else pending.push(intent);
}

async function deviceState() {
  const s = await getSettings();
  return { paired: !!s.token, supabaseUrl: s.supabaseUrl || null };
}

/**
 * L'appairage sans code à recopier. La personne est DÉJÀ connectée dans
 * l'iframe : l'hôte demande un code au serveur, le passe à l'app, et c'est
 * l'app — avec la session de la personne — qui le valide. Le résultat est le
 * même que le code saisi à la main (0203), sans les dix secondes de recopie.
 */
async function ensurePairing(ready) {
  const s = await getSettings();
  if (!s.token && ready.supabaseUrl && s.supabaseUrl !== ready.supabaseUrl) {
    await setSettings({ supabaseUrl: ready.supabaseUrl });
  }
  if (s.token) {
    const other = s.supabaseUrl && ready.supabaseUrl && s.supabaseUrl !== ready.supabaseUrl;
    toApp({ type: "device", state: other ? "other_project" : "paired" });
    return;
  }
  if (!ready.user) return;
  try {
    toApp({ type: "pair_code", code: await pairingCode() });
  } catch (e) {
    toApp({ type: "device", state: "error", error: e.message });
  }
}

/** Un seul code à la fois. L'app envoie plusieurs `ready` coup sur coup (page
 *  d'entrée, puis page du projet, puis session résolue) : sans ce verrou,
 *  chacun créait son propre appareil côté serveur. Un code encore valide sert
 *  de nouveau pour la même raison. */
let pairingInFlight = null;
function pairingCode() {
  pairingInFlight ??= (async () => {
    const { pairingCode: code, pairingUntil } = await api.storage.local.get(["pairingCode", "pairingUntil"]);
    if (code && pairingUntil && pairingUntil > Date.now() + 60_000) return code;
    return (await startPairing()).code;
  })().finally(() => { pairingInFlight = null; });
  return pairingInFlight;
}

async function finishPairing() {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await pollPairing();
      if (res.paired) {
        toApp({ type: "device", state: "paired" });
        port?.postMessage({ type: "paired" });
        return;
      }
    } catch { /* réessaie */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  toApp({ type: "device", state: "error", error: "L'appairage n'a pas abouti." });
}

function describeTab(t) {
  if (!t) return null;
  const url = t.url || t.pendingUrl || "";
  let host = "";
  try { host = new URL(url).hostname; } catch { /* page interne */ }
  const isApp = !!appOrigin && url.startsWith(appOrigin);
  return {
    id: t.id, url, host, title: t.title || host, favIconUrl: t.favIconUrl || null,
    injectable: /^https?:/.test(url) && !isApp && !/^https:\/\/chromewebstore\.google\.com/.test(url),
  };
}

async function activeTabRaw() {
  const [tab] = await api.tabs.query({ active: true, windowId });
  return tab ?? null;
}

let tabTimer = null;
function refreshTabSoon() { clearTimeout(tabTimer); tabTimer = setTimeout(refreshTab, 250); }
async function refreshTab() {
  const tab = await activeTabRaw();
  activeTab = describeTab(tab);
  if (appReady) toApp({ type: "tab", tab: activeTab });
  if (activeTab?.injectable) installController(activeTab.id);
}

/** La pastille de sélection n'existe que panneau ouvert, et seulement dans
 *  l'onglet qu'on a sous les yeux. */
function installController(tabId) {
  api.scripting.executeScript({
    target: { tabId },
    func: runCompanion,
    args: [{ kind: "install", selection: selectionPill, agent: currentAgent?.name }],
  }).catch(() => { /* page protégée */ });
}

async function inTab(func, args) {
  const tab = describeTab(await activeTabRaw());
  if (!tab?.injectable) {
    throw new Error(tab?.url?.startsWith(appOrigin ?? "\u0000")
      ? "C'est l'onglet d'Anduran lui-même : ouvrez la page dont vous voulez parler."
      : "Cette page ne peut pas être lue (page interne du navigateur ou boutique d'extensions).");
  }
  const [res] = await api.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return res?.result;
}

async function onRequest(op, args = {}) {
  switch (op) {
    case "capture_page": {
      const res = await inTab(extractPage, [{ offset: args.offset, maxChars: args.maxChars }]);
      if (!res?.ok) throw new Error(res?.error || "lecture impossible");
      return res;
    }
    case "capture_selection":
      return await inTab(() => String(window.getSelection() || "").replace(/\s+/g, " ").trim().slice(0, 6000), []);
    case "highlight":
      return await inTab(runCompanion, [{ kind: "highlight", targets: args.targets, agent: args.agent }]);
    case "clear":
      return await inTab(runCompanion, [{ kind: "clear" }]);
    case "pick":
      return await inTab(runCompanion, [{ kind: "pick", agent: args.agent }]);
    case "open_tab":
      if (!/^https?:\/\//.test(String(args.url || ""))) throw new Error("URL invalide");
      await api.tabs.create({ url: args.url, active: true });
      return { ok: true };
    default:
      throw new Error(`opération inconnue : ${op}`);
  }
}

async function handleApp(m) {
  switch (m.type) {
    case "ready": {
      appReady = true;
      clearTimeout(readyTimer);
      show("app");
      await refreshTab();
      toApp({
        type: "hello", version: VERSION, windowId, tab: activeTab,
        device: await deviceState(), prefs: { selectionPill, bubbles: await bubblesPref() },
      });
      while (pending.length) toApp({ type: "intent", intent: pending.shift() });
      port?.postMessage({ type: "take_intents" });
      await ensurePairing(m);
      return;
    }
    case "request": {
      try {
        const data = await onRequest(m.op, m.args);
        toApp({ type: "response", id: m.id, ok: true, data });
      } catch (e) {
        toApp({ type: "response", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    case "agent": {
      currentAgent = m.agent && m.agent.id ? { id: m.agent.id, name: m.agent.name } : null;
      await api.storage.local.set({ companionAgent: currentAgent });
      port?.postMessage({ type: "agent", agent: currentAgent });
      if (activeTab?.injectable) {
        api.tabs.sendMessage(activeTab.id, { type: "companion:selection_mode", on: selectionPill, agent: currentAgent?.name }).catch(() => {});
      }
      return;
    }
    case "paired":
      await finishPairing();
      return;
    case "open_settings":
      await openSettings();
      return;
    case "prefs":
      if (typeof m.bubbles === "boolean") await setBubbles(m.bubbles);
      if (typeof m.selectionPill === "boolean") await setSelectionPill(m.selectionPill);
      return;
    default:
  }
}

addEventListener("message", (e) => {
  if (e.source !== $("app").contentWindow || e.origin !== appOrigin) return;
  const m = e.data;
  if (!m || m.__anduran !== 1) return;
  handleApp(m).catch(() => {});
});

// ── Réglages ────────────────────────────────────────────────────────────────

async function bubblesPref() {
  const { companionBubbles } = await api.storage.local.get("companionBubbles");
  return companionBubbles !== false;
}
async function setBubbles(on) {
  await api.storage.local.set({ companionBubbles: on });
  port?.postMessage({ type: "prefs", bubbles: on });
}
async function setSelectionPill(on) {
  selectionPill = on;
  await api.storage.local.set({ companionSelectionPill: on });
  if (activeTab?.injectable) {
    api.tabs.sendMessage(activeTab.id, { type: "companion:selection_mode", on, agent: currentAgent?.name }).catch(() => {});
  }
}

async function openSettings() {
  $("settings").classList.add("on");
  $("bubbles").checked = await bubblesPref();
  $("selection-pill").checked = selectionPill;
  $("current-url").textContent = appOrigin ?? "non réglée";
  const list = $("shortcut-list");
  list.innerHTML = "";
  const commands = await api.commands.getAll().catch(() => []);
  for (const c of commands) {
    const k = document.createElement("kbd");
    k.textContent = c.shortcut || "non défini";
    const s = document.createElement("span");
    s.textContent = c.description || (c.name === "_execute_action" ? "Ouvrir le panneau" : c.name);
    list.append(k, s);
  }
  if (!$("recorder-frame").src) $("recorder-frame").src = "popup.html?embedded=1";
}

$("settings-close").onclick = () => $("settings").classList.remove("on");
$("bubbles").onchange = (e) => setBubbles(e.target.checked);
$("selection-pill").onchange = (e) => setSelectionPill(e.target.checked);
$("edit-shortcuts").onclick = () => api.tabs.create({ url: "chrome://extensions/shortcuts" });
$("settings-change-url").onclick = async () => { await api.storage.local.remove("appUrl"); await showSetup(); $("settings").classList.remove("on"); };
$("save-url").onclick = () => saveUrl($("url").value);
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") saveUrl($("url").value); });
$("retry").onclick = () => load();
$("open-tab").onclick = () => appOrigin && api.tabs.create({ url: `${appOrigin}/companion` });
$("change-url").onclick = () => showSetup();

// ── Le service worker : intentions (raccourcis, menu) et fil des réponses ──

function connect() {
  try {
    port = api.runtime.connect({ name: "panel" });
  } catch {
    setTimeout(connect, 1500);
    return;
  }
  port.postMessage({ type: "hello", windowId });
  port.onMessage.addListener((m) => {
    if (m?.type === "intent") deliverIntent(m.intent);
    if (m?.type === "feed" && appReady) toApp({ type: "feed", items: m.items });
  });
  // Le service worker MV3 peut mourir : on se reconnecte, et la reconnexion
  // suffit à le réveiller.
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 1000); });
}
// Un message toutes les 20 s garde le worker éveillé tant que le panneau est
// ouvert — c'est lui qui renouvelle le bail de lecture côté serveur.
setInterval(() => { try { port?.postMessage({ type: "ping" }); } catch { /* reconnexion en cours */ } }, 20000);

// La pastille de sélection parle au panneau de SA fenêtre, pas aux autres.
api.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "companion:selection") return;
  if (sender.tab?.windowId !== windowId) return;
  deliverIntent({ kind: "selection", action: msg.action, text: msg.text, url: msg.url, title: msg.title });
});

api.tabs.onActivated.addListener((info) => { if (info.windowId === windowId) refreshTabSoon(); });
api.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.windowId !== windowId || !tab.active) return;
  if (info.status === "complete" || info.title || info.url) refreshTabSoon();
});

(async () => {
  const w = await api.windows.getCurrent();
  windowId = w.id;
  const st = await api.storage.local.get(["companionAgent", "companionSelectionPill"]);
  currentAgent = st.companionAgent ?? null;
  selectionPill = st.companionSelectionPill !== false;
  connect();
  await load();
})();
