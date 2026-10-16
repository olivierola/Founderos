// Garde-fous d'exécution : un agent qui boucle ne doit ni saturer l'API du
// cluster, ni monopoliser le serveur, ni rejouer une action approuvée.
//
//   RateLimiter    seau à jetons par appelant (jeton d'API ou personne) :
//                  un débit soutenu et une rafale ; au-delà, rate_limited avec
//                  le délai à attendre.
//   Semaphore      nombre maximal de tools en cours d'exécution sur le serveur ;
//                  au-delà d'une attente bornée, busy.
//   ApprovalLedger un jeton d'approbation ne sert qu'une fois (son jti), pendant
//                  sa durée de validité. Mémoire du processus : avec plusieurs
//                  répliques, la liaison aux paramètres exacts et l'expiration
//                  à 5 minutes bornent ce qui reste possible.

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perMs: number;

  constructor(private readonly opts: { perMinute: number; burst: number }, private readonly now: () => number = Date.now) {
    if (!(opts.perMinute > 0) || !(opts.burst >= 1)) throw new Error("RateLimiter : perMinute > 0 et burst ≥ 1");
    this.perMs = opts.perMinute / 60_000;
  }

  /** Consomme un jeton pour `key` ; sinon, le délai avant le prochain, en secondes. */
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.opts.burst, at: t };
    b.tokens = Math.min(this.opts.burst, b.tokens + (t - b.at) * this.perMs);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      if (this.buckets.size > 10_000) this.prune(t);
      return { ok: true };
    }
    this.buckets.set(key, b);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / this.perMs / 1000)) };
  }

  private prune(t: number): void {
    const full = this.opts.burst / this.perMs;
    for (const [k, b] of this.buckets) if (t - b.at > full) this.buckets.delete(k);
  }
}

export class BusyError extends Error {
  constructor() {
    super("serveur occupé : trop de tools en cours");
    this.name = "BusyError";
  }
}

export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(readonly max: number) {
    if (!(max >= 1)) throw new Error("Semaphore : max ≥ 1");
  }

  get inUse(): number {
    return this.active;
  }

  /** Une place, ou BusyError après `waitMs`. Rend une fonction de libération, à appeler une fois. */
  async acquire(waitMs: number): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        this.active++;
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((g) => g !== grant);
        reject(new BusyError());
      }, waitMs);
      this.queue.push(grant);
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

export class ApprovalLedger {
  private used = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Vrai si ce jti n'a jamais servi (et le marque) ; faux s'il a déjà servi. */
  claim(jti: string, expiresAtMs: number): boolean {
    const t = this.now();
    for (const [k, exp] of this.used) if (exp <= t) this.used.delete(k);
    if (this.used.has(jti)) return false;
    this.used.set(jti, Math.max(expiresAtMs, t + 60_000));
    return true;
  }
}

/** Une promesse bornée dans le temps : au-delà, TimeoutError (l'appel sous-jacent a ses propres délais). */
export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`délai dépassé (${ms} ms)`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(ms)), ms); }),
  ]);
}
