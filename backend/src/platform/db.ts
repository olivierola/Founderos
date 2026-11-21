// La base de la plateforme auto-hébergée (PLATFORM=self).
//
// Deux pilotes derrière une seule interface :
//   - un vrai PostgreSQL (DATABASE_URL=postgres://…), par postgres.js, en
//     production ;
//   - PGlite (DATABASE_URL=pglite://<dossier> ou pglite://memory), un
//     PostgreSQL compilé en WebAssembly qui tourne dans le processus : pour
//     essayer et tester sans rien installer.
//
// Tout ce qui sert une requête d'API passe par `asRole` : une transaction où
// le rôle et les claims du JWT sont posés comme le fait PostgREST
// (`set local role …`, `request.jwt.claims`), pour que auth.uid() et toute la
// RLS des migrations s'appliquent à l'identique.

import { mkdirSync } from "node:fs";
import path from "node:path";

export type Row = Record<string, unknown>;

export interface Query {
  /** Une instruction, paramètres $1, $2… */
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Une instruction d'écriture : le nombre de lignes touchées. */
  command(text: string, params?: unknown[]): Promise<number>;
}

export interface Db extends Query {
  /** Plusieurs instructions, sans paramètres (migrations, scripts). */
  exec(text: string): Promise<void>;
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  /** LISTEN ; renvoie de quoi se désabonner. */
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
  readonly kind: "postgres" | "pglite";
}

export interface JwtClaims {
  role?: string;
  sub?: string;
  email?: string;
  [k: string]: unknown;
}

const API_ROLES = new Set(["anon", "authenticated", "service_role"]);

/**
 * Exécute `fn` sous le rôle du JWT, dans une transaction. Un rôle inconnu
 * retombe sur `anon` : un JWT ne peut pas faire endosser à la requête un rôle
 * de la base qui n'est pas un rôle d'API.
 */
export async function asRole<T>(db: Db, claims: JwtClaims, fn: (q: Query) => Promise<T>): Promise<T> {
  const role = API_ROLES.has(String(claims.role)) ? String(claims.role) : "anon";
  return db.tx(async (q) => {
    await q.query(
      `select set_config('role', $1, true),
              set_config('request.jwt.claims', $2, true),
              set_config('request.jwt.claim.sub', $3, true),
              set_config('request.jwt.claim.role', $1, true),
              set_config('request.jwt.claim.email', $4, true)`,
      [role, JSON.stringify(claims), String(claims.sub ?? ""), String(claims.email ?? "")],
    );
    return fn(q);
  });
}

// ── postgres.js ─────────────────────────────────────────────────────────────

async function openPostgres(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    onnotice: () => {},
    // Les réponses d'API sont construites en SQL (json_agg), comme PostgREST,
    // et lues comme texte : le pilote ne reformate rien de ce qu'elles disent.
    transform: { undefined: null },
    connection: { application_name: "founderos-backend" },
  });
  const wrap = (s: typeof sql): Query => ({
    query: async <T extends Row>(text: string, params: unknown[] = []) =>
      (await s.unsafe(text, params as never[])) as unknown as T[],
    command: async (text: string, params: unknown[] = []) => (await s.unsafe(text, params as never[])).count ?? 0,
  });
  return {
    kind: "postgres",
    ...wrap(sql),
    exec: async (text) => { await sql.unsafe(text); },
    tx: async (fn) => (await sql.begin((t) => fn(wrap(t as unknown as typeof sql)))) as never,
    listen: async (channel, cb) => {
      const sub = await sql.listen(channel, cb);
      return async () => { await sub.unlisten(); };
    },
    close: async () => { await sql.end({ timeout: 5 }); },
  };
}

// ── PGlite ──────────────────────────────────────────────────────────────────

async function openPglite(location: string): Promise<Db> {
  const [{ PGlite }, { vector }, { pgcrypto }, { pg_trgm }, { uuid_ossp }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite/vector"),
    import("@electric-sql/pglite/contrib/pgcrypto"),
    import("@electric-sql/pglite/contrib/pg_trgm"),
    import("@electric-sql/pglite/contrib/uuid_ossp"),
  ]);
  const dataDir = location === "memory" || location === "" ? undefined : path.resolve(location);
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const pg = await PGlite.create({ dataDir, extensions: { vector, pgcrypto, pg_trgm, uuid_ossp } });
  // PGlite n'a qu'une session : le search_path de Supabase y est posé une fois.
  await pg.exec(`set search_path = "$user", public, extensions`);

  type PgLike = { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> };
  const wrap = (s: PgLike): Query => ({
    query: async <T extends Row>(text: string, params: unknown[] = []) => (await s.query(text, params)).rows as T[],
    command: async (text: string, params: unknown[] = []) => (await s.query(text, params)).affectedRows ?? 0,
  });
  return {
    kind: "pglite",
    ...wrap(pg as unknown as PgLike),
    exec: async (text) => { await pg.exec(text); },
    tx: async (fn) => pg.transaction((t) => fn(wrap(t as unknown as PgLike))),
    listen: async (channel, cb) => {
      const off = await pg.listen(channel, cb);
      return async () => { await off(); };
    },
    close: async () => { await pg.close(); },
  };
}

export async function openDb(url: string): Promise<Db> {
  if (url.startsWith("pglite://")) return openPglite(url.slice("pglite://".length));
  if (/^postgres(ql)?:\/\//.test(url)) return openPostgres(url);
  throw new Error("DATABASE_URL doit commencer par postgres:// (PostgreSQL) ou pglite:// (base embarquée).");
}
