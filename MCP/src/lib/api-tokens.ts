// Jetons d'API du serveur MCP : le mode d'authentification par défaut.
//
// À l'installation du serveur, l'exploitant génère un jeton (npm run token --
// generate, ou la même commande dans l'image). Le serveur n'en garde que
// l'EMPREINTE, dans un fichier (un Secret Kubernetes monté) ; le jeton lui-même
// est montré une seule fois, puis collé dans FounderOS, qui le garde chiffré et
// le présente à chaque appel d'un agent.
//
//   Format : mcpt_<id>_<secret>  —  id : 8 caractères, pour retrouver l'entrée ;
//            secret : 32 octets aléatoires en base64url (256 bits).
//   Fichier : { "tokens": [ { id, label, hash, roles, scopes, created_at,
//             expires_at, revoked_at } ] }  —  hash = SHA-256 hexadécimal du
//             jeton entier. Un secret de 256 bits n'a pas besoin d'un hachage
//             lent : il ne se devine pas.
//
// Ce que le jeton accorde : ses rôles et ses scopes, lus par OPA comme ceux
// d'un jeton d'appel (le catalogue, les approbations en PRD, tout le reste
// s'applique). FounderOS ajoute, pour l'audit, la personne et l'agent
// (X-FounderOS-User, X-FounderOS-Agent) : affirmés par le détenteur du jeton,
// ils ne donnent aucun droit de plus.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { AuthError, type CallerIdentity } from "./auth.ts";

export const TOKEN_PREFIX = "mcpt_";
const TOKEN_RE = /^mcpt_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Valeurs affirmées par FounderOS : courtes, sans caractère de contrôle. */
const ASSERTED_RE = /^[A-Za-z0-9._:@\/ -]{1,200}$/;

export interface TokenEntry {
  id: string;
  label: string;
  hash: string;
  roles: string[];
  scopes: string[];
  created_at: string;
  expires_at?: string | null;
  revoked_at?: string | null;
}

export interface TokenFile {
  tokens: TokenEntry[];
}

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Un jeton neuf et son entrée. Le jeton n'existe nulle part ailleurs : il faut le copier maintenant. */
export function generateToken(input: { label: string; roles: string[]; scopes: string[]; expiresInDays?: number | null; now?: Date }): { token: string; entry: TokenEntry } {
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(input.label)) throw new Error("libellé : lettres, chiffres, . _ -, 60 caractères au plus");
  const now = input.now ?? new Date();
  const id = Array.from(randomBytes(8), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
  const token = `${TOKEN_PREFIX}${id}_${randomBytes(32).toString("base64url")}`;
  const expires = input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString() : null;
  return {
    token,
    entry: {
      id, label: input.label, hash: tokenHash(token),
      roles: [...new Set(input.roles)], scopes: [...new Set(input.scopes)],
      created_at: now.toISOString(), expires_at: expires, revoked_at: null,
    },
  };
}

export function parseTokenFile(raw: string): TokenFile {
  const parsed = JSON.parse(raw) as Partial<TokenFile>;
  if (!Array.isArray(parsed?.tokens)) throw new Error("fichier de jetons invalide : { \"tokens\": [...] } attendu");
  for (const t of parsed.tokens) {
    if (!/^[a-z0-9]{8}$/.test(String(t?.id)) || !/^[0-9a-f]{64}$/.test(String(t?.hash))) throw new Error(`entrée de jeton invalide : ${String(t?.id)}`);
    if (!Array.isArray(t.roles) || !Array.isArray(t.scopes)) throw new Error(`entrée ${t.id} : roles et scopes doivent être des listes`);
  }
  return parsed as TokenFile;
}

export interface ApiTokenVerifierOptions {
  /** Le fichier des empreintes (Secret monté), relu quand il change. */
  file?: string;
  /** Pour les tests : les entrées directement. */
  entries?: TokenEntry[];
  /** Vérification de la date du fichier au plus toutes les `recheckMs` (défaut 10 s). */
  recheckMs?: number;
}

export type AssertedCaller = { user?: string; agent?: string };

export function createApiTokenVerifier(opts: ApiTokenVerifierOptions) {
  let entries = new Map<string, TokenEntry>();
  let mtime = -1;
  let checkedAt = 0;
  const recheck = opts.recheckMs ?? 10_000;
  const load = () => {
    if (opts.entries) {
      entries = new Map(opts.entries.map((e) => [e.id, e]));
      return;
    }
    const m = statSync(opts.file!).mtimeMs;
    if (m !== mtime) {
      entries = new Map(parseTokenFile(readFileSync(opts.file!, "utf8")).tokens.map((e) => [e.id, e]));
      mtime = m;
    }
    checkedAt = Date.now();
  };
  if (!opts.entries && !opts.file) throw new Error("createApiTokenVerifier : file ou entries requis");
  load();

  return async (token: string, asserted: AssertedCaller = {}): Promise<CallerIdentity> => {
    if (!opts.entries && Date.now() - checkedAt >= recheck) load();
    const m = TOKEN_RE.exec(token);
    if (!m) throw new AuthError("jeton refusé : format inconnu");
    const entry = entries.get(m[1]);
    // Même coût de comparaison qu'il existe ou non : l'id ne se devine pas au chronomètre.
    const expected = Buffer.from(entry?.hash ?? "0".repeat(64), "hex");
    const got = Buffer.from(tokenHash(token), "hex");
    if (!entry || !timingSafeEqual(expected, got)) throw new AuthError("jeton refusé");
    if (entry.revoked_at) throw new AuthError("jeton révoqué");
    if (entry.expires_at && Date.parse(entry.expires_at) <= Date.now()) throw new AuthError("jeton expiré");
    return callerIdentity(entry, asserted);
  };
}

/** L'identité d'un appel par jeton d'API (fichier ou jeton tournant). */
export function callerIdentity(
  entry: { id: string; label: string; roles: string[]; scopes: string[] },
  asserted: AssertedCaller = {},
): CallerIdentity {
  const user = asserted.user && ASSERTED_RE.test(asserted.user) ? asserted.user : null;
  const agent = asserted.agent && ASSERTED_RE.test(asserted.agent) ? asserted.agent : null;
  return {
    // La personne affirmée par FounderOS (audit, quatre yeux des approbations) ;
    // sans elle, le jeton lui-même.
    sub: user ?? `token:${entry.id}`,
    azp: agent ?? entry.label,
    username: entry.label,
    scopes: entry.scopes,
    roles: entry.roles,
    exp: Math.floor(Date.now() / 1000) + 300,
    tokenId: entry.id,
  };
}
