// /rest/v1 — l'API de PostgREST, telle que supabase-js la parle.
//
//   GET/HEAD   /rest/v1/<table>          lecture (select, filtres, tri, pages)
//   POST       /rest/v1/<table>          insertion, upsert (Prefer: resolution=…)
//   PATCH      /rest/v1/<table>          mise à jour filtrée
//   DELETE     /rest/v1/<table>          suppression filtrée
//   GET/POST   /rest/v1/rpc/<fonction>   appel de fonction
//
// Chaque requête s'exécute dans SA transaction, sous le rôle de son JWT
// (anon, authenticated, service_role) : la RLS des migrations décide, comme
// chez Supabase.

import express, { type Request, type Response, type Router } from "express";
import { asRole, type JwtClaims } from "../db.ts";
import type { Platform } from "../platform.ts";
import { ApiError, parseQuery } from "./parse.ts";
import { findFunctions, findTable } from "./schema.ts";
import { buildDelete, buildInsert, buildRead, buildUpdate, callSql, ident, pickFunction, type BuiltRead, type Returning } from "./sql.ts";
import { pgErrorToApi, sendApiError } from "./errors.ts";
import { claimsFromRequest } from "../auth/claims.ts";

interface Prefer {
  returning: Returning;
  count: boolean;
  resolution: "merge" | "ignore" | null;
}

function parsePrefer(req: Request): Prefer {
  const raw = String(req.headers.prefer ?? "").toLowerCase();
  const has = (s: string) => raw.split(/\s*,\s*/).includes(s);
  return {
    returning: has("return=representation") ? "representation" : "minimal",
    count: has("count=exact") || has("count=planned") || has("count=estimated"),
    resolution: has("resolution=merge-duplicates") ? "merge" : has("resolution=ignore-duplicates") ? "ignore" : null,
  };
}

const wantsObject = (req: Request) => String(req.headers.accept ?? "").includes("application/vnd.pgrst.object+json");

function queryPairs(req: Request): Array<[string, string]> {
  const i = req.originalUrl.indexOf("?");
  return i < 0 ? [] : [...new URLSearchParams(req.originalUrl.slice(i + 1))];
}

function schemaOf(p: Platform, req: Request, write: boolean): string {
  const h = String((write ? req.headers["content-profile"] : req.headers["accept-profile"]) ?? "").trim();
  if (!h) return p.schemas[0];
  if (!p.schemas.includes(h)) {
    throw new ApiError(406, "PGRST106", `The schema must be one of the following: ${p.schemas.join(", ")}`);
  }
  return h;
}

interface Outcome { body: string | null; n: number; total: number | null }

async function run(p: Platform, claims: JwtClaims, built: BuiltRead): Promise<Outcome> {
  return asRole(p.db, claims, async (q) => {
    const rows = await q.query<{ body?: string; n?: number; total?: string | number }>(built.sql, built.params);
    const r = rows[0] ?? {};
    return {
      body: typeof r.body === "string" ? r.body : null,
      n: Number(r.n ?? 0),
      total: r.total == null ? null : Number(r.total),
    };
  });
}

/** Mutation sans représentation : pas de RETURNING (qui exigerait la politique
 *  SELECT, comme chez PostgREST), le pilote donne le nombre de lignes. */
async function runMinimal(p: Platform, claims: JwtClaims, built: BuiltRead): Promise<number> {
  return asRole(p.db, claims, (q) => q.command(built.sql, built.params));
}

function sendRows(req: Request, res: Response, out: Outcome, status: number, prefer: Prefer, offset = 0) {
  const n = out.n;
  const range = n > 0 ? `${offset}-${offset + n - 1}` : "*";
  res.setHeader("Content-Range", `${range}/${out.total ?? "*"}`);
  if (wantsObject(req)) {
    if (n !== 1) {
      throw new ApiError(406, "PGRST116", "Cannot coerce the result to a single JSON object", `The result contains ${n} rows`);
    }
    const arr = JSON.parse(out.body ?? "[]") as unknown[];
    res.status(status).type("application/vnd.pgrst.object+json; charset=utf-8");
    return req.method === "HEAD" ? res.end() : res.send(JSON.stringify(arr[0]));
  }
  res.status(status).type("application/json; charset=utf-8");
  if (req.method === "HEAD") return res.end();
  return res.send(out.body ?? "[]");
}

export function restRouter(p: Platform): Router {
  const r = express.Router();
  r.use(express.json({ strict: false, limit: process.env.REST_BODY_LIMIT ?? "25mb", type: ["application/json", "application/*+json", "text/plain"] }));

  r.all("/rpc/:fn", async (req, res) => {
    try {
      const claims = claimsFromRequest(p, req);
      const schema = schemaOf(p, req, req.method !== "GET");
      const fns = findFunctions(p.cache(), schema, req.params.fn);
      const prefer = parsePrefer(req);
      const pairs = queryPairs(req);
      let body: Record<string, unknown>;
      if (req.method === "GET" || req.method === "HEAD") {
        const argNames = new Set(fns.flatMap((f) => f.args.map((a) => a.name)));
        body = Object.fromEntries(pairs.filter(([k]) => argNames.has(k)));
      } else {
        body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
      }
      const fn = pickFunction(fns, Object.keys(body));
      if (!fn) {
        throw new ApiError(404, "PGRST202",
          `Could not find the function ${schema}.${req.params.fn}(${Object.keys(body).sort().join(", ")}) in the schema cache`);
      }
      const argSet = new Set(Object.keys(body));
      const call = callSql(fn, argSet, body);
      const params = [JSON.stringify(body)];
      const query = parseQuery(pairs, { rpcArgs: new Set(fn.args.map((a) => a.name)) });

      if (fn.returns === "void") {
        await asRole(p.db, claims, (q) => q.query(`select ${call}`, params));
        return res.status(204).end();
      }
      if (!fn.returnsSet && fn.returns === "scalar") {
        const [row] = await asRole(p.db, claims, (q) => q.query<{ body: string }>(`select to_json(${call})::text as body`, params));
        return res.status(200).type("application/json; charset=utf-8").send(row?.body ?? "null");
      }
      const built = buildRead(p.cache(), query, {
        table: null, from: `${call} as ${ident(fn.name)}`, alias: fn.name, params,
      }, { count: prefer.count, scalarSet: fn.returns === "scalar" });
      const out = await run(p, claims, built);
      if (!fn.returnsSet) {
        // Une ligne composite : un objet, pas un tableau.
        const arr = JSON.parse(out.body ?? "[]") as unknown[];
        return res.status(200).type("application/json; charset=utf-8").send(JSON.stringify(arr[0] ?? null));
      }
      return sendRows(req, res, out, 200, prefer, query.levels.get("")?.offset ?? 0);
    } catch (e) {
      return sendApiError(res, pgErrorToApi(e, req));
    }
  });

  r.all("/:table", async (req, res) => {
    try {
      const claims = claimsFromRequest(p, req);
      const write = !["GET", "HEAD"].includes(req.method);
      const schema = schemaOf(p, req, write);
      const table = findTable(p.cache(), schema, req.params.table);
      if (!table) {
        throw new ApiError(404, "PGRST205", `Could not find the table '${schema}.${req.params.table}' in the schema cache`);
      }
      const prefer = parsePrefer(req);
      const query = parseQuery(queryPairs(req));
      const t = `${ident(table.schema)}.${ident(table.name)}`;

      if (req.method === "GET" || req.method === "HEAD") {
        const built = buildRead(p.cache(), query, { table, from: `${t} as ${ident(table.name)}`, alias: table.name }, { count: prefer.count });
        const out = await run(p, claims, built);
        return sendRows(req, res, out, 200, prefer, query.levels.get("")?.offset ?? 0);
      }

      if (req.method === "POST") {
        const raw = req.body;
        const rows = (Array.isArray(raw) ? raw : [raw ?? {}]) as Record<string, unknown>[];
        if (rows.some((x) => !x || typeof x !== "object" || Array.isArray(x))) {
          throw new ApiError(400, "PGRST102", "Le corps doit être un objet JSON ou un tableau d'objets.");
        }
        if (!rows.length) return sendRows(req, res, { body: "[]", n: 0, total: null }, 201, prefer);
        const built = buildInsert(p.cache(), query, table, rows, { returning: prefer.returning, upsert: prefer.resolution });
        if (prefer.returning === "minimal") {
          const n = await runMinimal(p, claims, built);
          res.setHeader("Content-Range", `*/${prefer.count ? n : "*"}`);
          return res.status(201).end();
        }
        return sendRows(req, res, await run(p, claims, built), 201, prefer);
      }

      if (req.method === "PATCH") {
        const patch = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : null;
        if (!patch) throw new ApiError(400, "PGRST102", "Le corps d'une mise à jour doit être un objet JSON.");
        const built = buildUpdate(p.cache(), query, table, patch, prefer.returning);
        if (!built) return prefer.returning === "minimal" ? res.status(204).end() : sendRows(req, res, { body: "[]", n: 0, total: null }, 200, prefer);
        if (prefer.returning === "minimal") {
          const n = await runMinimal(p, claims, built);
          res.setHeader("Content-Range", `0-${Math.max(0, n - 1)}/${prefer.count ? n : "*"}`);
          return res.status(204).end();
        }
        return sendRows(req, res, await run(p, claims, built), 200, prefer);
      }

      if (req.method === "DELETE") {
        const built = buildDelete(p.cache(), query, table, prefer.returning);
        if (prefer.returning === "minimal") {
          const n = await runMinimal(p, claims, built);
          res.setHeader("Content-Range", `0-${Math.max(0, n - 1)}/${prefer.count ? n : "*"}`);
          return res.status(204).end();
        }
        return sendRows(req, res, await run(p, claims, built), 200, prefer);
      }

      throw new ApiError(405, "PGRST117", `Méthode ${req.method} non prise en charge.`);
    } catch (e) {
      return sendApiError(res, pgErrorToApi(e, req));
    }
  });

  return r;
}
