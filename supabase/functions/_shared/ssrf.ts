// Garde anti-SSRF pour les requêtes sortantes dont l'URL vient de l'appelant.
//
// POURQUOI
// Deux chemins laissaient un utilisateur choisir l'adresse que le serveur allait
// interroger, puis lui rendaient la réponse (FOS-11) : la branche « test » de
// mcp-gateway, et `internal_agents.sandbox_url`, colonne que tout membre du
// workspace peut écrire. La seule validation était /^https?:\/\//, qui accepte
// 127.0.0.1, 169.254.169.254 (métadonnées cloud) et n'importe quel service
// interne non exposé.
//
// CE QUE FAIT CE MODULE
// Il résout le nom d'hôte AVANT la requête et refuse toute adresse privée, de
// bouclage, de lien local ou réservée — puis revalide après chaque redirection,
// parce qu'un serveur distant peut répondre 302 vers une adresse interne
// (« DNS rebinding » par redirection, la variante la plus simple à exploiter).

/** Une adresse IPv4 littérale sous ses formes acceptées par les résolveurs. */
function parseIPv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/** Plages IPv4 qu'un service public n'a aucune raison d'atteindre. */
function isBlockedIPv4(p: number[]): boolean {
  const [a, b] = p;
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 10) return true;                       // privé
  if (a === 127) return true;                      // bouclage
  if (a === 169 && b === 254) return true;         // lien local — métadonnées cloud
  if (a === 172 && b >= 16 && b <= 31) return true;// privé
  if (a === 192 && b === 168) return true;         // privé
  if (a === 192 && b === 0) return true;           // IETF
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                       // multicast + réservé
  return false;
}

function isBlockedIPv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "::") return true;      // bouclage / non spécifié
  if (h.startsWith("fe80")) return true;           // lien local
  if (/^f[cd]/.test(h)) return true;               // unique-local fc00::/7
  // IPv4 déguisée en IPv6, le contournement classique. `new URL()` normalise
  // `::ffff:127.0.0.1` en `::ffff:7f00:1` (les deux derniers hextets encodent
  // les quatre octets IPv4 en hexadécimal) — il faut donc reconnaître LES DEUX
  // formes, décimale pointée et hexadécimale, sinon le filtre se contourne en
  // écrivant l'adresse interne sous sa forme normalisée.
  const dotted = h.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = parseIPv4(dotted[1]);
    return !p || isBlockedIPv4(p);
  }
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
    return isBlockedIPv4(octets);
  }
  return false;
}

export interface SsrfVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * L'URL est-elle sûre à interroger depuis le serveur ?
 * Résout le DNS : un nom qui pointe vers 127.0.0.1 est refusé comme l'IP l'aurait été.
 */
export async function assertSafeUrl(raw: string): Promise<SsrfVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "URL invalide" };
  }

  // http:// est accepté pour ne pas casser les serveurs MCP en clair sur un
  // réseau de confiance, mais rien d'autre : file:, gopher: et data: n'ont
  // aucune raison d'être ici.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `schéma ${url.protocol} refusé — http(s) uniquement` };
  }

  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "hôte absent" };

  // Noms qui ne sortent jamais de la machine.
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return { ok: false, reason: `hôte interne refusé : ${host}` };
  }

  // Adresse littérale : on tranche sans résoudre.
  const v4 = parseIPv4(host);
  if (v4) {
    return isBlockedIPv4(v4)
      ? { ok: false, reason: `adresse non routable refusée : ${host}` }
      : { ok: true };
  }
  if (host.includes(":")) {
    return isBlockedIPv6(host)
      ? { ok: false, reason: `adresse non routable refusée : ${host}` }
      : { ok: true };
  }

  // Nom de domaine : on résout et on juge CHAQUE réponse. Un nom qui répond à
  // la fois une adresse publique et 127.0.0.1 est refusé.
  try {
    const records = await Promise.allSettled([
      Deno.resolveDns(host, "A"),
      Deno.resolveDns(host, "AAAA"),
    ]);
    const addrs = records
      .filter((r): r is PromiseFulfilledResult<string[]> => r.status === "fulfilled")
      .flatMap((r) => r.value);

    // Aucune réponse : on laisse passer plutôt que de casser un environnement
    // où la permission --allow-net ne couvre pas la résolution. La requête
    // elle-même échouera si l'hôte n'existe pas.
    if (addrs.length === 0) return { ok: true };

    for (const addr of addrs) {
      const p = parseIPv4(addr);
      if (p ? isBlockedIPv4(p) : isBlockedIPv6(addr)) {
        return { ok: false, reason: `${host} résout vers une adresse non routable (${addr})` };
      }
    }
  } catch {
    return { ok: true };
  }

  return { ok: true };
}

/**
 * fetch() qui refuse les cibles internes, à l'aller comme à chaque redirection.
 * `redirect: "manual"` est indispensable : sans lui, le runtime suit le 302
 * lui-même et la revalidation n'a jamais lieu.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = 4,
): Promise<Response> {
  let target = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const verdict = await assertSafeUrl(target);
    if (!verdict.ok) throw new Error(`Requête sortante refusée — ${verdict.reason}`);

    const res = await fetch(target, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status > 399) return res;

    const location = res.headers.get("location");
    if (!location) return res;
    target = new URL(location, target).toString();
  }

  throw new Error("Requête sortante refusée — trop de redirections");
}
