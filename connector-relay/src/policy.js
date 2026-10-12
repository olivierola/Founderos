// La politique du relais, décidée CHEZ LE CLIENT.
//
// Le cloud FounderOS dit au relais quoi appeler ; le relais décide s'il
// accepte. Ces listes vivent dans l'environnement du relais, pas en base : un
// compte FounderOS compromis, une définition de connecteur modifiée ou une
// injection de prompt ne peuvent pas les élargir.
//
//   RELAY_ALLOWED_HOSTS     hôtes joignables (obligatoire, refus par défaut).
//                           Motifs séparés par des virgules : argocd.corp,
//                           *.monitoring.svc.cluster.local, vault.corp:8200,
//                           10.20.0.0/16 (IPv4 littérales).
//   RELAY_ALLOWED_BINARIES  CLI que le relais peut lancer (vide : aucune).
//   RELAY_DENIED_SUBCOMMANDS sous-commandes interdites même si le binaire est
//                           autorisé (défaut : les gestes destructifs de helm et kubectl).

import net from "node:net";

const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const ALLOWED_HOSTS = list(process.env.RELAY_ALLOWED_HOSTS);
export const ALLOWED_BINARIES = list(process.env.RELAY_ALLOWED_BINARIES).map((b) => b.toLowerCase());
export const DENIED_SUBCOMMANDS = list(
  process.env.RELAY_DENIED_SUBCOMMANDS ??
    "helm:uninstall,helm:delete,helm:plugin,kubectl:delete,kubectl:exec,kubectl:cp,kubectl:port-forward,kubectl:proxy,kubectl:attach,kubectl:debug",
).map((s) => s.toLowerCase());

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function matchCidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (!net.isIPv4(ip) || !net.isIPv4(base) || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function matchHost(host, port, pattern) {
  const p = pattern.toLowerCase();
  if (p.includes("/")) return matchCidr(host, p);
  let patHost = p;
  let patPort = null;
  const m = p.match(/^(.*):(\d+)$/);
  if (m && !p.includes("]")) {
    patHost = m[1];
    patPort = m[2];
  }
  if (patPort && patPort !== String(port)) return false;
  if (patHost.startsWith("*.")) return host.endsWith(patHost.slice(1)) && host.length > patHost.length - 1;
  return host === patHost;
}

/** L'URL est-elle dans la liste blanche du relais ? */
export function hostAllowed(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL invalide" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: `schéma ${u.protocol} refusé` };
  if (!ALLOWED_HOSTS.length) return { ok: false, reason: "RELAY_ALLOWED_HOSTS est vide : le relais refuse tout" };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const ok = ALLOWED_HOSTS.some((p) => matchHost(host, port, p));
  return ok ? { ok: true } : { ok: false, reason: `${host}:${port} n'est pas dans RELAY_ALLOWED_HOSTS` };
}

const SAFE_ARG = /^[\w.:/=@,+-]{0,256}$/;

/** La commande est-elle permise ? Aucun shell n'est jamais utilisé. */
export function commandAllowed(binary, args) {
  const b = String(binary ?? "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(b)) return { ok: false, reason: "binaire invalide" };
  if (!ALLOWED_BINARIES.includes(b)) return { ok: false, reason: `${b} n'est pas dans RELAY_ALLOWED_BINARIES` };
  if (!Array.isArray(args) || args.length > 40) return { ok: false, reason: "arguments invalides" };
  for (const a of args) {
    if (typeof a !== "string" || !SAFE_ARG.test(a)) return { ok: false, reason: `argument refusé : ${String(a).slice(0, 40)}` };
  }
  // N'importe quelle position : « kubectl -n prod exec » met la sous-commande
  // après une option à valeur. Mieux vaut refuser une release nommée « delete »
  // que laisser passer un exec.
  const denied = args.find((a) => DENIED_SUBCOMMANDS.includes(`${b}:${a.toLowerCase()}`));
  if (denied) return { ok: false, reason: `${b} ${denied} est interdit par RELAY_DENIED_SUBCOMMANDS` };
  return { ok: true };
}
