// Les erreurs, sous la forme et avec les statuts HTTP de PostgREST : le front
// teste `error.code` ("23505", "PGRST116"…) et doit voir la même chose qu'avec
// Supabase.

import type { Request, Response } from "express";
import { ApiError } from "./parse.ts";

/** Table de PostgREST (src/PostgREST/Error.hs), par code SQLSTATE. */
export function statusForSqlState(code: string, authenticated: boolean): number {
  if (code === "42501") return authenticated ? 403 : 401;
  if (code === "23503" || code === "23505") return 409;
  if (code === "25006") return 405;
  if (code === "42883" || code === "42P01") return 404;
  if (code === "P0001") return 400;
  if (code === "42P17") return 500;
  if (/^08/.test(code) || /^53/.test(code)) return 503;
  if (/^(0L|0P|28)/.test(code)) return 403;
  if (/^54/.test(code)) return 413;
  if (/^(09|25|2D|38|39|3B|40|55|57|58|F0|HV|P0|XX)/.test(code)) return 500;
  // PTxxx : un `raise sqlstate 'PT404'` choisit son statut.
  const pt = /^PT(\d{3})$/.exec(code);
  if (pt) return Number(pt[1]);
  return 400;
}

interface PgLikeError { code?: string; message?: string; detail?: string; details?: string; hint?: string }

export function pgErrorToApi(e: unknown, req?: Request): ApiError {
  if (e instanceof ApiError) return e;
  const pg = e as PgLikeError;
  if (pg && typeof pg.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code)) {
    const authed = Boolean((req as (Request & { platformClaims?: { role?: string } }) | undefined)?.platformClaims?.role === "authenticated");
    return new ApiError(statusForSqlState(pg.code, authed), pg.code, pg.message ?? "Erreur de la base", pg.detail ?? pg.details ?? null, pg.hint ?? null);
  }
  console.error("[platform] erreur inattendue :", e);
  return new ApiError(500, "PGRST000", e instanceof Error ? e.message : String(e));
}

export function sendApiError(res: Response, e: ApiError) {
  if (res.headersSent) return res.end();
  return res.status(e.status).json({ code: e.code, details: e.details, hint: e.hint, message: e.message });
}
