// /storage/v1 — l'API de Supabase Storage, telle que supabase-js (storage-js)
// la parle. Les métadonnées vivent dans storage.objects (et ses politiques RLS
// des migrations décident qui lit et qui écrit, comme chez Supabase) ; les
// octets, dans STORAGE_DIR, un fichier par objet.
//
//   POST|PUT  /object/<bucket>/<chemin>          envoi (x-upsert: true pour écraser)
//   GET       /object/[authenticated/]<bucket>/<chemin>   lecture sous RLS
//   GET       /object/public/<bucket>/<chemin>   lecture, bucket public seulement
//   POST      /object/sign/<bucket>/<chemin>     URL signée { expiresIn }
//   GET       /object/sign/<bucket>/<chemin>?token=…
//   DELETE    /object/<bucket>                   { prefixes: [...] }
//   POST      /object/list/<bucket>              { prefix, limit, offset, search, sortBy }
//   POST      /object/move, /object/copy         { bucketId, sourceKey, destinationKey }
//   GET|POST  /bucket, GET|PUT|DELETE /bucket/<id>, POST /bucket/<id>/empty

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import Busboy from "busboy";
import express, { type Request, type Response, type Router } from "express";
import { claimsFromRequest } from "../auth/claims.ts";
import { asRole, type JwtClaims } from "../db.ts";
import { signJwt, verifyJwt } from "../jwt.ts";
import type { Platform } from "../platform.ts";

class StorageError extends Error {
  constructor(readonly status: number, readonly statusCode: string, readonly error: string, message: string) { super(message); }
}

const notFound = () => new StorageError(400, "404", "not_found", "Object not found");

/** Le chemin d'un objet : relatif, sans « .. » ni octet nul. */
function cleanKey(raw: string): string {
  const key = decodeURIComponent(raw).replace(/^\/+/, "");
  if (!key || key.includes("\u0000") || key.split("/").some((s) => s === ".." || s === ".")) {
    throw new StorageError(400, "400", "InvalidKey", `Invalid key: ${raw}`);
  }
  return key;
}

export function storageRouter(p: Platform): Router {
  const r = express.Router();
  const root = path.resolve(p.config.storageDir);
  const fileOf = (bucket: string, key: string) => {
    const f = path.resolve(root, bucket, key);
    if (!f.startsWith(root + path.sep)) throw new StorageError(400, "400", "InvalidKey", "Invalid key");
    return f;
  };

  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof StorageError) { res.status(e.status).json({ statusCode: e.statusCode, error: e.error, message: e.message }); return; }
      const pg = e as { code?: string; message?: string };
      if (pg?.code === "42501") { res.status(403).json({ statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" }); return; }
      if (pg?.code === "23505") { res.status(400).json({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }); return; }
      if (pg?.code === "23503") { res.status(400).json({ statusCode: "404", error: "Bucket not found", message: "Bucket not found" }); return; }
      console.error("[storage]", e);
      res.status(500).json({ statusCode: "500", error: "internal", message: e instanceof Error ? e.message : String(e) });
    }
  };

  async function bucketRow(id: string) {
    const [b] = await p.db.query<{ id: string; public: boolean; file_size_limit: number | null; allowed_mime_types: string[] | null }>(
      "select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = $1", [id]);
    if (!b) throw new StorageError(400, "404", "Bucket not found", "Bucket not found");
    return b;
  }

  /** Le corps d'un envoi : multipart (navigateur) ou brut (Node). */
  function readUpload(req: Request): Promise<{ data: Buffer; contentType: string; cacheControl: string }> {
    const ct = String(req.headers["content-type"] ?? "application/octet-stream");
    const limit = Number(process.env.STORAGE_FILE_SIZE_LIMIT ?? 50 * 1024 * 1024);
    if (ct.startsWith("multipart/form-data")) {
      return new Promise((resolve, reject) => {
        const bb = Busboy({ headers: req.headers, limits: { fileSize: limit } });
        let data: Buffer | null = null;
        let fileType = "application/octet-stream";
        let cacheControl = String(req.headers["cache-control"] ?? "max-age=3600");
        bb.on("field", (name, val) => { if (name === "cacheControl") cacheControl = /^\d+$/.test(val) ? `max-age=${val}` : val; });
        bb.on("file", (_name, stream, info) => {
          fileType = info.mimeType || fileType;
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("limit", () => reject(new StorageError(413, "413", "Payload too large", "The object exceeded the maximum allowed size")));
          stream.on("end", () => { data = Buffer.concat(chunks); });
        });
        bb.on("close", () => resolve({ data: data ?? Buffer.alloc(0), contentType: fileType, cacheControl }));
        bb.on("error", reject);
        req.pipe(bb);
      });
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) { reject(new StorageError(413, "413", "Payload too large", "The object exceeded the maximum allowed size")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve({
        data: Buffer.concat(chunks), contentType: ct,
        cacheControl: String(req.headers["cache-control"] ?? "max-age=3600").replace(/^(\d+)$/, "max-age=$1"),
      }));
      req.on("error", reject);
    });
  }

  const keyOf = (req: Request) => {
    const pth = (req.params as Record<string, string | string[]>).path;
    return cleanKey(Array.isArray(pth) ? pth.join("/") : String(pth));
  };

  async function upload(req: Request, res: Response, upsertDefault: boolean) {
    const claims = claimsFromRequest(p, req);
    const bucket = String(req.params.bucket);
    const key = keyOf(req);
    const b = await bucketRow(bucket);
    const upsert = String(req.headers["x-upsert"] ?? (upsertDefault ? "true" : "false")) === "true";
    const body = await readUpload(req);
    if (b.file_size_limit && body.data.length > Number(b.file_size_limit)) {
      throw new StorageError(413, "413", "Payload too large", "The object exceeded the maximum allowed size");
    }
    if (b.allowed_mime_types?.length && !b.allowed_mime_types.some((m) => m === body.contentType || (m.endsWith("/*") && body.contentType.startsWith(m.slice(0, -1))))) {
      throw new StorageError(415, "415", "invalid_mime_type", `mime type ${body.contentType} is not supported`);
    }
    const metadata = {
      eTag: `"${createHash("md5").update(body.data).digest("hex")}"`,
      size: body.data.length, mimetype: body.contentType, cacheControl: body.cacheControl,
      lastModified: new Date().toISOString(), contentLength: body.data.length, httpStatusCode: 200,
    };
    const owner = claims.role === "authenticated" && claims.sub ? String(claims.sub) : null;
    // Les métadonnées d'abord, sous RLS : c'est là que la politique d'écriture
    // du bucket accepte ou refuse.
    const id = await asRole(p.db, claims, async (q) => {
      const sql = upsert
        ? `insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5::jsonb)
           on conflict (bucket_id, name) do update set metadata = excluded.metadata, owner = excluded.owner, owner_id = excluded.owner_id,
             updated_at = now(), last_accessed_at = now() returning id`
        : `insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5::jsonb) returning id`;
      const rows = await q.query<{ id: string }>(sql, [bucket, key, owner, owner, JSON.stringify(metadata)]).catch((e) => {
        if ((e as { code?: string }).code === "23505") throw new StorageError(400, "409", "Duplicate", "The resource already exists");
        throw e;
      });
      const f = fileOf(bucket, key);
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(`${f}.tmp`, body.data);
      await rename(`${f}.tmp`, f);
      return rows[0]?.id ?? randomUUID();
    });
    res.json({ Id: id, Key: `${bucket}/${key}` });
  }

  async function sendObject(res: Response, bucket: string, key: string, meta: Record<string, unknown> | null, download: unknown) {
    const f = fileOf(bucket, key);
    const st = await stat(f).catch(() => null);
    if (!st) throw notFound();
    res.setHeader("Content-Type", String(meta?.mimetype ?? "application/octet-stream"));
    res.setHeader("Content-Length", String(st.size));
    res.setHeader("Cache-Control", String(meta?.cacheControl ?? "max-age=3600"));
    if (meta?.eTag) res.setHeader("ETag", String(meta.eTag));
    res.setHeader("Last-Modified", st.mtime.toUTCString());
    if (download !== undefined) {
      const name = typeof download === "string" && download ? download : path.basename(key);
      res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/"/g, "")}"`);
    }
    createReadStream(f).pipe(res);
  }

  async function readable(claims: JwtClaims, bucket: string, key: string): Promise<Record<string, unknown>> {
    const rows = await asRole(p.db, claims, (q) => q.query<{ metadata: Record<string, unknown> | string | null }>(
      "select metadata from storage.objects where bucket_id = $1 and name = $2", [bucket, key]));
    if (!rows.length) throw notFound();
    const m = rows[0].metadata;
    return typeof m === "string" ? JSON.parse(m) : (m ?? {});
  }

  // ── Objets ────────────────────────────────────────────────────────────────

  r.get("/object/public/:bucket/*path", handle(async (req, res) => {
    const b = await bucketRow(String(req.params.bucket));
    if (!b.public) throw notFound();
    const key = keyOf(req);
    const [row] = await p.db.query<{ metadata: Record<string, unknown> | string | null }>(
      "select metadata from storage.objects where bucket_id = $1 and name = $2", [b.id, key]);
    if (!row) throw notFound();
    await sendObject(res, b.id, key, typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata, req.query.download);
  }));

  r.post("/object/sign/:bucket/*path", express.json(), handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const key = keyOf(req);
    await readable(claims, String(req.params.bucket), key);
    const expiresIn = Math.max(1, Number(req.body?.expiresIn ?? 60));
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ url: `${String(req.params.bucket)}/${key}`, iat: now, exp: now + expiresIn }, p.jwtSecret);
    res.json({ signedURL: `/object/sign/${String(req.params.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}?token=${token}` });
  }));

  r.post("/object/sign/:bucket", express.json(), handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const paths = Array.isArray(req.body?.paths) ? req.body.paths as string[] : [];
    const expiresIn = Math.max(1, Number(req.body?.expiresIn ?? 60));
    const now = Math.floor(Date.now() / 1000);
    const out = [];
    for (const raw of paths) {
      try {
        const key = cleanKey(raw);
        await readable(claims, String(req.params.bucket), key);
        const token = signJwt({ url: `${String(req.params.bucket)}/${key}`, iat: now, exp: now + expiresIn }, p.jwtSecret);
        out.push({ path: raw, signedURL: `/object/sign/${String(req.params.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}?token=${token}`, error: null });
      } catch { out.push({ path: raw, signedURL: null, error: "Either the object does not exist or you do not have access to it" }); }
    }
    res.json(out);
  }));

  r.get("/object/sign/:bucket/*path", handle(async (req, res) => {
    const key = keyOf(req);
    let claims: Record<string, unknown>;
    try { claims = verifyJwt(String(req.query.token ?? ""), p.jwtSecret); } catch (e) {
      throw new StorageError(400, "400", "InvalidJWT", (e as Error).message);
    }
    if (claims.url !== `${String(req.params.bucket)}/${key}`) throw new StorageError(400, "400", "InvalidSignature", "The url do not match the signature");
    const [row] = await p.db.query<{ metadata: Record<string, unknown> | string | null }>(
      "select metadata from storage.objects where bucket_id = $1 and name = $2", [String(req.params.bucket), key]);
    if (!row) throw notFound();
    await sendObject(res, String(req.params.bucket), key, typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata, req.query.download);
  }));

  r.post("/object/list/:bucket", express.json(), handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const prefix = String(req.body?.prefix ?? "").replace(/^\/+|\/+$/g, "");
    const limit = Math.min(1000, Number(req.body?.limit ?? 100));
    const offset = Number(req.body?.offset ?? 0);
    const search = String(req.body?.search ?? "");
    const sortCol = ["name", "created_at", "updated_at", "last_accessed_at"].includes(req.body?.sortBy?.column) ? req.body.sortBy.column : "name";
    const sortDir = req.body?.sortBy?.order === "desc" ? "desc" : "asc";
    const like = `${prefix ? `${prefix}/` : ""}${search.replace(/[%_]/g, "\\$&")}%`;
    // Comme Supabase : les « dossiers » du niveau (sans métadonnées) puis les fichiers.
    const rows = await asRole(p.db, claims, (q) => q.query<{ name: string; id: string | null; updated_at: unknown; created_at: unknown; last_accessed_at: unknown; metadata: unknown }>(
      `with lvl as (
         select split_part(substr(name, length($2) + 1), '/', 1) as part, (strpos(substr(name, length($2) + 1), '/') > 0) as is_dir,
                id, updated_at, created_at, last_accessed_at, metadata, name as full_name
           from storage.objects where bucket_id = $1 and name like $3
       )
       select distinct on (part) part as name, case when is_dir then null else id end as id,
              case when is_dir then null else updated_at end as updated_at,
              case when is_dir then null else created_at end as created_at,
              case when is_dir then null else last_accessed_at end as last_accessed_at,
              case when is_dir then null else metadata end as metadata
         from lvl order by part, is_dir desc`,
      [String(req.params.bucket), prefix ? `${prefix}/` : "", like]));
    const sorted = rows.sort((a, b) => {
      const av = String(a[sortCol as keyof typeof a] ?? ""), bv = String(b[sortCol as keyof typeof b] ?? "");
      return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    res.json(sorted.slice(offset, offset + limit));
  }));

  r.post("/object/move", express.json(), handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const { bucketId, sourceKey, destinationKey } = req.body ?? {};
    const src = cleanKey(String(sourceKey)), dst = cleanKey(String(destinationKey));
    const destBucket = String(req.body?.destinationBucket ?? bucketId);
    const n = await asRole(p.db, claims, (q) => q.command(
      "update storage.objects set bucket_id = $4, name = $3, updated_at = now() where bucket_id = $1 and name = $2", [bucketId, src, dst, destBucket]));
    if (!n) throw notFound();
    await mkdir(path.dirname(fileOf(destBucket, dst)), { recursive: true });
    await rename(fileOf(String(bucketId), src), fileOf(destBucket, dst));
    res.json({ message: "Successfully moved" });
  }));

  r.post("/object/copy", express.json(), handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const { bucketId, sourceKey, destinationKey } = req.body ?? {};
    const src = cleanKey(String(sourceKey)), dst = cleanKey(String(destinationKey));
    const destBucket = String(req.body?.destinationBucket ?? bucketId);
    const meta = await readable(claims, String(bucketId), src);
    const owner = claims.role === "authenticated" ? String(claims.sub) : null;
    const [row] = await asRole(p.db, claims, (q) => q.query<{ id: string }>(
      `insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $3, $4::jsonb) returning id`,
      [destBucket, dst, owner, JSON.stringify(meta)]));
    await mkdir(path.dirname(fileOf(destBucket, dst)), { recursive: true });
    await copyFile(fileOf(String(bucketId), src), fileOf(destBucket, dst));
    res.json({ Id: row?.id, Key: `${destBucket}/${dst}` });
  }));

  r.get(["/object/authenticated/:bucket/*path", "/object/:bucket/*path"], handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const key = keyOf(req);
    const meta = await readable(claims, String(req.params.bucket), key);
    await sendObject(res, String(req.params.bucket), key, meta, req.query.download);
  }));

  r.post("/object/:bucket/*path", handle((req, res) => upload(req, res, false)));
  r.put("/object/:bucket/*path", handle((req, res) => upload(req, res, true)));

  r.delete("/object/:bucket", express.json(), handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const prefixes = (Array.isArray(req.body?.prefixes) ? req.body.prefixes as string[] : []).map(cleanKey);
    const removed = await asRole(p.db, claims, (q) => q.query<Record<string, unknown>>(
      `delete from storage.objects where bucket_id = $1 and name = any($2::text[])
       returning id, name, bucket_id, owner, created_at, updated_at, last_accessed_at, metadata`, [String(req.params.bucket), prefixes]));
    for (const o of removed) await rm(fileOf(String(req.params.bucket), String(o.name)), { force: true });
    res.json(removed);
  }));

  r.delete("/object/:bucket/*path", handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const key = keyOf(req);
    const n = await asRole(p.db, claims, (q) => q.command("delete from storage.objects where bucket_id = $1 and name = $2", [String(req.params.bucket), key]));
    if (!n) throw notFound();
    await rm(fileOf(String(req.params.bucket), key), { force: true });
    res.json({ message: "Successfully deleted" });
  }));

  // ── Buckets ───────────────────────────────────────────────────────────────

  const bucketJson = "id, name, owner, public, file_size_limit, allowed_mime_types, created_at, updated_at";
  r.get("/bucket", handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    res.json(await asRole(p.db, claims, (q) => q.query(`select ${bucketJson} from storage.buckets order by name`)));
  }));
  r.get("/bucket/:id", handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const [b] = await asRole(p.db, claims, (q) => q.query(`select ${bucketJson} from storage.buckets where id = $1`, [String(req.params.id)]));
    if (!b) throw new StorageError(400, "404", "Bucket not found", "Bucket not found");
    res.json(b);
  }));
  r.post("/bucket", express.json(), handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const b = req.body ?? {};
    const id = String(b.id ?? b.name ?? "");
    await asRole(p.db, claims, (q) => q.query(
      "insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ($1, $2, $3, $4, $5)",
      [id, String(b.name ?? id), !!b.public, b.file_size_limit ?? null, b.allowed_mime_types ?? null]));
    res.json({ name: id });
  }));
  r.put("/bucket/:id", express.json(), handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const b = req.body ?? {};
    await asRole(p.db, claims, (q) => q.query(
      "update storage.buckets set public = coalesce($2, public), file_size_limit = $3, allowed_mime_types = $4, updated_at = now() where id = $1",
      [String(req.params.id), b.public ?? null, b.file_size_limit ?? null, b.allowed_mime_types ?? null]));
    res.json({ message: "Successfully updated" });
  }));
  r.post("/bucket/:id/empty", handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const removed = await asRole(p.db, claims, (q) => q.query<{ name: string }>("delete from storage.objects where bucket_id = $1 returning name", [String(req.params.id)]));
    for (const o of removed) await rm(fileOf(String(req.params.id), o.name), { force: true });
    res.json({ message: "Successfully emptied" });
  }));
  r.delete("/bucket/:id", handle(async (req, res) => {
    const claims = claimsFromRequest(p, req);
    const [{ n }] = await p.db.query<{ n: number }>("select count(*)::int as n from storage.objects where bucket_id = $1", [String(req.params.id)]);
    if (n > 0) throw new StorageError(409, "409", "Bucket not empty", "The bucket you tried to delete is not empty");
    await asRole(p.db, claims, (q) => q.query("delete from storage.buckets where id = $1", [String(req.params.id)]));
    await rm(path.join(root, String(req.params.id)), { recursive: true, force: true });
    res.json({ message: "Successfully deleted" });
  }));

  return r;
}
