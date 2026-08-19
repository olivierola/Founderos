// popup.js — les quatre états possibles de l'extension, et rien d'autre.
//
// Réglage (URL du projet) → Appairage (code à saisir dans l'app) → Prêt →
// Enregistrement. La popup ne pilote pas la capture : elle montre où on en est,
// et offre la seule action qu'on peut vouloir depuis le navigateur — arrêter.

import { api, rpc, getSettings, setSettings, startPairing, pollPairing, forgetDevice } from "./api.js";

const $ = (id) => document.getElementById(id);
const show = (name) => {
  for (const s of document.querySelectorAll("section")) s.classList.toggle("on", s.id === `s-${name}`);
};
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

let pairTimer = null;
let liveTimer = null;

async function render() {
  const { supabaseUrl, token, pairingCode, pairingUntil } = await getSettings();

  if (!supabaseUrl) {
    $("url").value = "";
    show("setup");
    return;
  }
  $("sub").textContent = new URL(supabaseUrl).host;

  if (!token) {
    show("pair");
    $("code").textContent = pairingCode ?? "••••-••••";
    // Un code périmé n'a plus aucune valeur : on en demande un neuf plutôt que
    // de laisser quelqu'un le retaper en vain.
    if (!pairingCode || (pairingUntil && pairingUntil < Date.now())) await requestCode();
    startPairPolling();
    return;
  }

  stopPairPolling();

  const status = await api.runtime.sendMessage({ type: "rec:status" }).catch(() => null);
  if (status?.recording) {
    show("live");
    $("live-title").textContent = status.title || "Enregistrement";
    clearInterval(liveTimer);
    const tick = () => { $("live-time").textContent = mmss(Date.now() - status.startedAt); };
    tick();
    liveTimer = setInterval(tick, 1000);
    return;
  }

  clearInterval(liveTimer);
  show("idle");
  await renderControl();
}

// ── Pilotage par un agent ───────────────────────────────────────────────────
// C'est ICI que se donne le consentement. Il est borné dans le temps et dans le
// périmètre, et il se coupe d'un clic — parce qu'une autorisation qu'on ne peut
// pas retirer facilement n'en est pas une.

async function renderControl() {
  let armed = false;
  let until = null;
  try {
    const res = await rpc({ mode: "rec_control_poll" });
    armed = !!res.armed;
    until = res.control_until;
  } catch { /* hors ligne : on montre l'état par défaut */ }

  $("ctl-state").textContent = armed && until
    ? `actif jusqu'à ${new Date(until).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`
    : "désactivé";
  $("disarm").style.display = armed ? "" : "none";
  $("arm15").textContent = armed ? "Prolonger de 15 minutes" : "Autoriser 15 minutes";
}

/** Le périmètre « ce site » est résolu depuis l'onglet ACTIF au moment du clic —
 *  c'est le site que l'utilisateur a sous les yeux quand il décide. */
async function currentOrigins() {
  if ($("ctl-scope").value === "all") return [];
  try {
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url ? [new URL(tab.url).host] : [];
  } catch { return []; }
}

async function arm(minutes) {
  $("ctl-err").textContent = "";
  try {
    await rpc({ mode: "rec_control_arm", minutes, origins: await currentOrigins() });
    await renderControl();
  } catch (e) {
    $("ctl-err").textContent = e.message;
  }
}

$("arm15").addEventListener("click", () => arm(15));
$("arm60").addEventListener("click", () => arm(60));
$("disarm").addEventListener("click", () => arm(0));

async function requestCode() {
  $("pair-err").textContent = "";
  try {
    const res = await startPairing();
    $("code").textContent = res.code;
    $("pair-hint").textContent = "En attente de la saisie…";
  } catch (e) {
    $("code").textContent = "••••-••••";
    $("pair-err").textContent = e.message;
  }
}

function startPairPolling() {
  stopPairPolling();
  pairTimer = setInterval(async () => {
    try {
      const res = await pollPairing();
      if (res.paired) { stopPairPolling(); await render(); return; }
      if (res.expired) { $("pair-hint").textContent = "Code expiré."; await requestCode(); }
    } catch { /* la popup peut être fermée entre-temps */ }
  }, 2500);
}
function stopPairPolling() {
  if (pairTimer) clearInterval(pairTimer);
  pairTimer = null;
}

$("save").addEventListener("click", async () => {
  const raw = $("url").value.trim().replace(/\/+$/, "");
  $("setup-err").textContent = "";
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) throw new Error("protocole");
  } catch {
    $("setup-err").textContent = "Entrez une URL complète, par ex. https://xxxx.supabase.co";
    return;
  }
  await setSettings({ supabaseUrl: raw });
  await render();
});

$("new-code").addEventListener("click", requestCode);

$("forget").addEventListener("click", async () => {
  await forgetDevice();
  await render();
});

$("stop").addEventListener("click", async () => {
  $("stop").disabled = true;
  $("stop").textContent = "Finalisation…";
  await api.runtime.sendMessage({ type: "rec:stop_now" }).catch(() => {});
  await render();
});

render();
