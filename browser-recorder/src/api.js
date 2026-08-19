// api.js — identité de l'appareil et dialogue avec FounderOS.
//
// Même contrat que le paquet skill-recorder/ : l'extension est un PRODUCTEUR
// d'événements parmi d'autres. Le serveur ne sait pas — et n'a pas besoin de
// savoir — si les gestes viennent de Playwright ou d'un onglet réel.
//
// Aucune clé n'est embarquée ici. L'extension est installée sur le poste de
// quelqu'un : tout secret qu'elle contiendrait serait publié. Son identité,
// elle l'obtient par appairage (code à 8 caractères saisi dans FounderOS), et
// les captures d'écran partent en base64 vers `rec_shot`, qui les range côté
// serveur avec la clé qui, elle, reste au serveur.

// Chrome, Edge, Opera, Brave et Vivaldi exposent `chrome`. Firefox expose
// `browser` (et `chrome` en partie). Cette ligne suffit à couvrir les deux.
export const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  supabaseUrl: "",
};

export async function getSettings() {
  const stored = await api.storage.local.get(["supabaseUrl", "token", "workspaceId", "deviceId"]);
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await api.storage.local.set(patch);
}

function pollUrl(supabaseUrl) {
  return `${String(supabaseUrl).replace(/\/+$/, "")}/functions/v1/test-runner-poll`;
}

/**
 * Un appel au endpoint recorder. `token` absent = appel d'appairage, qui est
 * précisément celui qui sert à en obtenir un.
 */
export async function rpc(body, { timeoutMs = 30000 } = {}) {
  const { supabaseUrl, token } = await getSettings();
  if (!supabaseUrl) throw new Error("URL FounderOS non configurée");

  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Recorder-Token"] = token;

  let res;
  try {
    res = await fetch(pollUrl(supabaseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error(`${body?.mode ?? "requête"} a expiré`);
    }
    // Comme dans le paquet Node : « Failed to fetch » seul ne dit rien.
    throw new Error(e.cause?.message ? `${e.message} — ${e.cause.message}` : e.message);
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

/** Démarre un appairage : renvoie { device_id, code, expires_in_s } à afficher. */
export async function startPairing() {
  const name = `${navigator.userAgent.match(/(Edg|OPR|Brave|Vivaldi|Firefox|Chrome)\/[\d.]+/)?.[0] ?? "Navigateur"} — extension`;
  const res = await rpc({ mode: "rec_pair_start", name });
  await setSettings({ deviceId: res.device_id, pairingCode: res.code, pairingUntil: Date.now() + (res.expires_in_s ?? 600) * 1000 });
  return res;
}

/** Vérifie si quelqu'un a saisi le code ; enregistre le jeton le cas échéant. */
export async function pollPairing() {
  const { deviceId } = await getSettings();
  if (!deviceId) return { paired: false };
  const res = await rpc({ mode: "rec_pair_poll", device_id: deviceId });
  if (res.paired && res.token) {
    await setSettings({ token: res.token, workspaceId: res.workspace_id, pairingCode: null, pairingUntil: null });
  }
  return res;
}

/** Oublie l'identité — après révocation, ou sur demande depuis la popup. */
export async function forgetDevice() {
  await api.storage.local.remove(["token", "workspaceId", "deviceId", "pairingCode", "pairingUntil"]);
}
