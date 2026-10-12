// Jeton d'API tournant : le serveur MCP change son jeton à chaque période et
// l'envoie lui-même à FounderOS.
//
// Le jeton se calcule, il ne se stocke pas :
//   jeton(période) = mcpt_<id>_<HMAC-SHA256(graine, "epoch:<période>")>
//   période        = floor(maintenant / durée)        (24 h par défaut)
// La graine (256 bits) est générée à l'installation et ne quitte jamais le
// serveur (un Secret monté). Toutes les répliques calculent le même jeton, sans
// se coordonner ni rien écrire ; un redémarrage ne change rien. L'id est tiré
// de la graine : il reste le même d'une période à l'autre (audit, `token:<id>`).
//
// Accepté : le jeton de la période courante et celui de la précédente (le temps
// que FounderOS reçoive le nouveau), et celui de la suivante dans les dernières
// minutes de la période (horloges des répliques légèrement décalées).
//
// La livraison (TokenPusher) : à chaque nouvelle période, le serveur pousse le
// nouveau jeton à FounderOS (connector-action, mode mcp.token_push), en présentant
// comme preuve le jeton que FounderOS détient déjà. Aucun autre secret partagé.
// Si FounderOS a manqué des livraisons (arrêt, réseau), le serveur présente des
// jetons plus anciens, jusqu'à `lookback` périodes : la livraison reprend seule.
// Au-delà, il faut réenrôler (token current, puis coller le jeton dans FounderOS).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { callerIdentity, TOKEN_PREFIX, type AssertedCaller } from "./api-tokens.ts";
import { AuthError, type AccessTokenVerifier } from "./auth.ts";
import { request } from "./http.ts";
import type { Metrics } from "./metrics.ts";

const TOKEN_RE = /^mcpt_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Le jeton de la période suivante est accepté dans ses 5 dernières minutes. */
const SKEW_MS = 5 * 60_000;

/** Une graine neuve, en base64url : le contenu du Secret. */
export function generateSeed(): string {
  return randomBytes(32).toString("base64url");
}

export function parseSeed(raw: string): Buffer {
  const text = raw.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("graine du jeton invalide : base64url attendu (token seed)");
  const seed = Buffer.from(text, "base64url");
  if (seed.length < 32) throw new Error("graine du jeton trop courte : 32 octets au moins (token seed)");
  return seed;
}

export function readSeedFile(file: string): Buffer {
  return parseSeed(readFileSync(file, "utf8"));
}

/** « 24h », « 30m », « 7d », « 90s » → millisecondes. */
export function parseDuration(text: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(text.trim());
  if (!m) throw new Error(`durée invalide : ${text} (ex. 24h, 30m, 7d)`);
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

export function tokenIdOf(seed: Buffer): string {
  const mac = createHmac("sha256", seed).update("founderos-mcp-token-id").digest();
  return Array.from(mac.subarray(0, 8), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

export const epochOf = (now: number, periodMs: number) => Math.floor(now / periodMs);

export function tokenFor(seed: Buffer, epoch: number): string {
  return `${TOKEN_PREFIX}${tokenIdOf(seed)}_${createHmac("sha256", seed).update(`epoch:${epoch}`).digest("base64url")}`;
}

/** Le jeton de la période en cours : celui à coller dans FounderOS à l'enrôlement. */
export function currentToken(seed: Buffer, periodMs: number, now = Date.now()): string {
  return tokenFor(seed, epochOf(now, periodMs));
}

export interface RotatingTokenOptions {
  seed: Buffer;
  periodMs: number;
  roles: string[];
  scopes: string[];
  /** Le nom du détenteur, pour l'audit (défaut : founderos). */
  label?: string;
  now?: () => number;
}

const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface RotatingTokenVerifier {
  verify: AccessTokenVerifier;
  tokenId: string;
}

export function createRotatingTokenVerifier(opts: RotatingTokenOptions): RotatingTokenVerifier {
  if (!(opts.periodMs >= 60_000)) throw new Error("durée de rotation : une minute au moins");
  const id = tokenIdOf(opts.seed);
  const now = opts.now ?? Date.now;
  const label = opts.label ?? "founderos";
  const verify = async (token: string, asserted: AssertedCaller = {}) => {
    const m = TOKEN_RE.exec(token);
    if (!m) throw new AuthError("jeton refusé : format inconnu");
    if (m[1] !== id) throw new AuthError("jeton refusé");
    const t = now();
    const e = epochOf(t, opts.periodMs);
    const epochs = [e, e - 1];
    if ((e + 1) * opts.periodMs - t <= SKEW_MS) epochs.push(e + 1);
    // Toutes les comparaisons, toujours : le temps de réponse ne dit pas laquelle a réussi.
    let ok = false;
    for (const ep of epochs) ok = sameToken(token, tokenFor(opts.seed, ep)) || ok;
    if (!ok) throw new AuthError("jeton refusé : périmé ou inconnu");
    return callerIdentity({ id, label, roles: opts.roles, scopes: opts.scopes }, asserted);
  };
  return { verify, tokenId: id };
}

/**
 * Jeton tournant d'abord (son id est connu), puis les jetons du fichier s'il y en a.
 * Un jeton d'un autre id ne coûte aucun calcul de HMAC.
 */
export function composeTokenVerifiers(rotating: RotatingTokenVerifier, fallback?: AccessTokenVerifier): AccessTokenVerifier {
  return async (token, asserted) => {
    const m = TOKEN_RE.exec(token);
    if (m && m[1] === rotating.tokenId) return rotating.verify(token, asserted);
    if (fallback) return fallback(token, asserted);
    throw new AuthError(m ? "jeton refusé" : "jeton refusé : format inconnu");
  };
}

// ── Livraison à FounderOS ────────────────────────────────────────────────────

export type PushResult = "delivered" | "current" | "unknown" | "error" | "skipped";

export interface PushTransportResult { status: number; body: unknown }
export type PushTransport = (url: string, auth: string, body: Record<string, unknown>) => Promise<PushTransportResult>;

export interface TokenPusherOptions {
  seed: Buffer;
  periodMs: number;
  /** L'adresse de FounderOS (backend, ou https://<projet>.supabase.co). */
  founderosUrl: string;
  /** AC de FounderOS, si elle n'est pas dans les AC du système. */
  caFile?: string;
  /** Combien de périodes en arrière chercher le jeton que FounderOS détient (défaut 7). */
  lookback?: number;
  /** Intervalle entre deux tentatives tant que la période n'est pas livrée (défaut 10 min). */
  everyMs?: number;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  metrics?: Metrics;
  transport?: PushTransport;
}

function httpTransport(caFile?: string): PushTransport {
  return async (url, auth, body) => {
    const res = await request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      caFile,
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
    });
    let parsed: unknown = null;
    try { parsed = res.text ? JSON.parse(res.text) : null; } catch { /* corps non JSON */ }
    return { status: res.status, body: parsed };
  };
}

export class TokenPusher {
  private confirmedEpoch = -1;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly url: string;
  private readonly transport: PushTransport;
  private readonly now: () => number;
  readonly tokenId: string;

  constructor(private readonly opts: TokenPusherOptions) {
    this.url = `${opts.founderosUrl.replace(/\/+$/, "")}/functions/v1/connector-action`;
    this.transport = opts.transport ?? httpTransport(opts.caFile);
    this.now = opts.now ?? Date.now;
    this.tokenId = tokenIdOf(opts.seed);
  }

  private log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
    // Jamais le jeton : son id et sa période suffisent à suivre la rotation.
    (this.opts.log ?? ((l, m, x) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: l, msg: m, ...x }))))(
      level, msg, { token_id: this.tokenId, ...extra },
    );
  }

  /** La période en cours est-elle livrée ? */
  delivered(): boolean {
    return this.confirmedEpoch === epochOf(this.now(), this.opts.periodMs);
  }

  /** Une tentative de livraison du jeton de la période en cours. */
  async tick(): Promise<PushResult> {
    const e = epochOf(this.now(), this.opts.periodMs);
    if (this.confirmedEpoch === e) return "skipped";
    const next = tokenFor(this.opts.seed, e);
    const body = { mode: "mcp.token_push", token: next, period_seconds: Math.round(this.opts.periodMs / 1000) };
    const lookback = this.opts.lookback ?? 7;
    for (let k = 1; k <= lookback; k++) {
      let res: PushTransportResult;
      try {
        res = await this.transport(this.url, tokenFor(this.opts.seed, e - k), body);
      } catch (err) {
        this.opts.metrics?.tokenPush.inc({ result: "error" });
        this.log("warn", "FounderOS injoignable : nouvel essai plus tard", { epoch: e, error: (err as Error).message });
        return "error";
      }
      if (res.status === 200) {
        const out = (res.body ?? {}) as { unchanged?: boolean; updated?: number };
        this.confirmedEpoch = e;
        const result: PushResult = out.unchanged ? "current" : "delivered";
        this.opts.metrics?.tokenPush.inc({ result });
        this.log("info", out.unchanged ? "FounderOS a déjà le jeton de la période" : "jeton de la période livré à FounderOS", {
          epoch: e, servers: out.updated ?? 0, lookback: k,
        });
        return result;
      }
      if (res.status !== 401) {
        this.opts.metrics?.tokenPush.inc({ result: "error" });
        this.log("warn", "FounderOS refuse la livraison", { epoch: e, status: res.status });
        return "error";
      }
    }
    this.opts.metrics?.tokenPush.inc({ result: "unknown" });
    this.log("error", `FounderOS ne détient aucun des jetons des ${lookback} dernières périodes : réenrôlez le serveur (token current), puis collez le jeton dans FounderOS`, { epoch: e });
    return "unknown";
  }

  start(): void {
    const every = this.opts.everyMs ?? 10 * 60_000;
    const schedule = (ms: number) => {
      if (this.stopped) return;
      this.timer = setTimeout(async () => {
        await this.tick().catch((err) => this.log("error", "livraison du jeton", { error: (err as Error).message }));
        // Livrée : on revient au début de la période suivante ; sinon, dans `every`.
        const now = this.now();
        const nextEpochAt = (epochOf(now, this.opts.periodMs) + 1) * this.opts.periodMs;
        const wait = this.delivered() ? Math.min(nextEpochAt - now + 5_000, every) : every;
        schedule(Math.max(1_000, Math.round(wait * (0.9 + Math.random() * 0.2))));
      }, ms);
      this.timer.unref?.();
    };
    schedule(2_000 + Math.round(Math.random() * 3_000));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
