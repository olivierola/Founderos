// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/sso-domains.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { Deno } from "../../compat/index.ts";

// SSO d'entreprise pour toutes les organisations (migration 0282).
//
// Deux modes :
//   dédié    l'organisation « maison » d'une installation (0272) : un seul client ;
//   partagé  chaque organisation configure son SSO pour les domaines e-mail
//            qu'elle a VÉRIFIÉS par un enregistrement DNS TXT. La base refuse
//            toute connexion SSO hors de ces domaines (sso_guard_identity).
//
// Le mode effectif : une organisation « maison » déjà revendiquée, c'est le mode
// dédié, quoi que dise la configuration (la base raisonne ainsi : sa garde ne
// contrôle pas les domaines d'une installation dédiée). Sinon, SSO_MODE :
//   shared (défaut) · dedicated · off
// SSO_ADMIN_ENABLED=1, l'ancien drapeau, vaut SSO_MODE=dedicated.

export type SsoMode = "dedicated" | "shared" | "off";

/** Ce que demande la configuration du déploiement. */
export function configuredSsoMode(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): SsoMode {
  const raw = (env("SSO_MODE") ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "dedicated" || raw === "shared") return raw;
  if (env("SSO_ADMIN_ENABLED") === "1") return "dedicated";
  return "shared";
}

/** Le mode effectif, la base faisant foi pour une installation déjà revendiquée. */
export function effectiveSsoMode(configured: SsoMode, homeClaimed: boolean): SsoMode {
  if (configured === "off") return "off";
  return homeClaimed ? "dedicated" : configured;
}

export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Le nom DNS à créer pour prouver la propriété d'un domaine. */
export const verificationRecordName = (domain: string) => `_founderos-sso.${domain}`;

/** « founderos-sso=<32 octets en base64url> » : la valeur TXT attendue. */
export function newVerificationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `founderos-sso=${b64}`;
}

/**
 * Les valeurs TXT d'un nom, par DNS-over-HTTPS (JSON) : marche à l'identique
 * dans les edge functions et le backend Node. Résolveur : SSO_DNS_RESOLVER_URL
 * (défaut Cloudflare ; un résolveur interne pour une installation sans sortie).
 */
export async function lookupTxt(
  name: string,
  opts: { fetch?: typeof fetch; resolver?: string } = {},
): Promise<string[]> {
  const resolver = opts.resolver ?? (Deno.env.get("SSO_DNS_RESOLVER_URL") || "https://cloudflare-dns.com/dns-query");
  const f = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await f(`${resolver}?name=${encodeURIComponent(name)}&type=TXT`, {
      headers: { accept: "application/dns-json" }, signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`résolveur DNS : HTTP ${res.status}`);
    const json = await res.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
    if (json.Status !== 0 && json.Status !== 3) throw new Error(`résolveur DNS : statut ${json.Status}`);
    // Une valeur TXT longue arrive en morceaux entre guillemets : "abc" "def".
    return (json.Answer ?? []).filter((a) => a.type === 16 && typeof a.data === "string")
      .map((a) => (a.data!.match(/"((?:[^"\\]|\\.)*)"/g) ?? [a.data!]).map((s) => s.replace(/^"|"$/g, "").replace(/\\"/g, '"')).join(""));
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyDomainTxt(
  domain: string,
  token: string,
  lookup: (name: string) => Promise<string[]> = (n) => lookupTxt(n),
): Promise<{ ok: boolean; detail: string }> {
  const name = verificationRecordName(domain);
  let values: string[];
  try {
    values = await lookup(name);
  } catch (e) {
    return { ok: false, detail: `Lecture DNS impossible : ${e instanceof Error ? e.message : String(e)}` };
  }
  if (values.some((v) => v.trim() === token)) return { ok: true, detail: `Enregistrement ${name} trouvé.` };
  return {
    ok: false,
    detail: values.length
      ? `${name} existe, mais sans la valeur attendue. La propagation DNS peut prendre quelques minutes.`
      : `Aucun enregistrement TXT ${name} pour l'instant. La propagation DNS peut prendre quelques minutes.`,
  };
}

/**
 * Identifiant d'un fournisseur OIDC dans l'Auth, en mode partagé : préfixé par
 * l'organisation, pour que deux organisations puissent choisir le même nom.
 */
export function sharedAuthRef(workspaceId: string, slug: string): string {
  return `custom:o${workspaceId.replace(/-/g, "").slice(0, 8)}-${slug}`;
}
