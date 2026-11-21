// /realtime/v1/websocket — le protocole de Supabase Realtime (Phoenix), tel que
// supabase-js (realtime-js) le parle : messages en tableau (vsn 2.0.0) ou en
// objet (vsn 1.0.0).
//
//   postgres_changes : chaque table de la publication `supabase_realtime` (que
//     les migrations alimentent) reçoit un déclencheur qui fait
//     pg_notify('platform_realtime', …) ; le serveur relaie la ligne aux
//     abonnés dont le filtre correspond ET qui ont le droit de la lire — la
//     visibilité est vérifiée sous le rôle et les claims de chaque abonné,
//     donc sous la même RLS que /rest/v1, comme le fait Supabase.
//   broadcast, presence : relayés en mémoire entre les abonnés d'un même canal.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { asRole, type JwtClaims } from "./db.ts";
import { verifyJwt } from "./jwt.ts";
import type { Platform } from "./platform.ts";
import { ident, lit } from "./rest/sql.ts";
import { findTable } from "./rest/schema.ts";

type Msg = { join_ref: string | null; ref: string | null; topic: string; event: string; payload: Record<string, unknown> };

interface PgBinding { id: number; event: string; schema: string; table: string | undefined; filter: string | undefined }
interface Channel {
  topic: string;
  joinRef: string | null;
  bindings: PgBinding[];
  broadcastSelf: boolean;
  presenceKey: string | null;
}
interface Client {
  ws: WebSocket;
  vsn: "1.0.0" | "2.0.0";
  claims: JwtClaims;
  channels: Map<string, Channel>;
}

/** Les tables publiées reçoivent leur déclencheur de notification. */
export async function installRealtimeTriggers(p: Platform): Promise<number> {
  const tables = await p.db.query<{ schemaname: string; tablename: string }>(
    "select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime'");
  for (const t of tables) {
    const q = `${ident(t.schemaname)}.${ident(t.tablename)}`;
    await p.db.exec(`
      drop trigger if exists platform_realtime_notify on ${q};
      create trigger platform_realtime_notify after insert or update or delete on ${q}
        for each row execute function realtime.notify_change();`);
  }
  return tables.length;
}

/** `col=eq.valeur` (et neq, lt, lte, gt, gte, in) — les filtres de Realtime. */
export function matchesFilter(filter: string | undefined, record: Record<string, unknown> | null): boolean {
  if (!filter) return true;
  if (!record) return false;
  const m = /^([^=]+)=(eq|neq|lt|lte|gt|gte|in)\.(.*)$/s.exec(filter);
  if (!m) return false;
  const [, col, op, raw] = m;
  const v = record[col];
  const s = v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (op === "in") {
    const list = raw.replace(/^\(|\)$/g, "").split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    return s !== null && list.includes(s);
  }
  if (s === null) return false;
  const num = (x: string) => (x !== "" && !Number.isNaN(Number(x)) ? Number(x) : null);
  const a = num(s), b = num(raw);
  const cmp = a !== null && b !== null ? a - b : s.localeCompare(raw);
  switch (op) {
    case "eq": return s === raw;
    case "neq": return s !== raw;
    case "lt": return cmp < 0;
    case "lte": return cmp <= 0;
    case "gt": return cmp > 0;
    default: return cmp >= 0;
  }
}

export function attachRealtime(server: Server, p: Platform): { close(): Promise<void> } {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<Client>();
  let nextId = 1;
  let unlisten: (() => Promise<void>) | null = null;

  const send = (c: Client, m: Msg) => {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    c.ws.send(c.vsn === "2.0.0"
      ? JSON.stringify([m.join_ref, m.ref, m.topic, m.event, m.payload])
      : JSON.stringify({ topic: m.topic, event: m.event, payload: m.payload, ref: m.ref, join_ref: m.join_ref }));
  };
  const reply = (c: Client, m: Msg, status: "ok" | "error", response: Record<string, unknown> = {}) =>
    send(c, { join_ref: m.join_ref, ref: m.ref, topic: m.topic, event: "phx_reply", payload: { status, response } });

  const claimsOf = (token: unknown): JwtClaims | null => {
    if (typeof token !== "string" || !token) return null;
    try { return verifyJwt(token, p.jwtSecret) as JwtClaims; } catch { return null; }
  };

  /** L'abonné peut-il lire cette ligne ? La même RLS que /rest/v1. */
  async function canSee(c: Client, schema: string, table: string, record: Record<string, unknown>): Promise<boolean> {
    if (c.claims.role === "service_role") return true;
    const t = findTable(p.cache(), schema, table);
    const keys = t?.pk.length ? t.pk : ("id" in record ? ["id"] : []);
    if (!keys.length) return false;
    const where = keys.map((k) => `${ident(k)}::text = ${lit(String(record[k] ?? ""))}`).join(" and ");
    try {
      const rows = await asRole(p.db, c.claims, (q) => q.query(`select 1 from ${ident(schema)}.${ident(table)} where ${where} limit 1`));
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  async function onChange(raw: string) {
    let ev: { schema: string; table: string; type: string; commit_timestamp: string; record: Record<string, unknown> | null; old_record: Record<string, unknown> | null; truncated?: boolean };
    try { ev = JSON.parse(raw); } catch { return; }
    // Trop gros pour NOTIFY : seule la clé est venue, on relit la ligne.
    if (ev.truncated && ev.record?.id) {
      const [row] = await p.db.query<{ r: Record<string, unknown> | string }>(
        `select to_jsonb(t) as r from ${ident(ev.schema)}.${ident(ev.table)} t where t.id::text = $1`, [String(ev.record.id)]);
      if (row) ev.record = typeof row.r === "string" ? JSON.parse(row.r) : row.r;
    }
    const t = findTable(p.cache(), ev.schema, ev.table);
    // Comme Supabase sans REPLICA IDENTITY FULL : l'ancienne ligne ne porte
    // que la clé primaire.
    const pkOnly = (r: Record<string, unknown> | null) =>
      r && t?.pk.length ? Object.fromEntries(t.pk.map((k) => [k, r[k]])) : r;
    const oldRecord = pkOnly(ev.old_record);
    const subject = ev.type === "DELETE" ? ev.old_record : ev.record;

    for (const c of clients) {
      for (const ch of c.channels.values()) {
        const ids = ch.bindings.filter((b) =>
          (b.event === "*" || b.event.toUpperCase() === ev.type)
          && (b.schema === "*" || b.schema === ev.schema)
          && (!b.table || b.table === "*" || b.table === ev.table)
          && matchesFilter(b.filter, subject)).map((b) => b.id);
        if (!ids.length) continue;
        if (ev.type !== "DELETE" && ev.record && !(await canSee(c, ev.schema, ev.table, ev.record))) continue;
        send(c, {
          join_ref: ch.joinRef, ref: null, topic: ch.topic, event: "postgres_changes",
          payload: {
            ids,
            data: {
              schema: ev.schema, table: ev.table, commit_timestamp: ev.commit_timestamp, type: ev.type,
              record: ev.type === "DELETE" ? undefined : ev.record, old_record: ev.type === "INSERT" ? undefined : oldRecord,
              columns: [], errors: null,
            },
          },
        });
      }
    }
  }

  function presenceState(topic: string) {
    const state: Record<string, { metas: unknown[] }> = {};
    for (const c of clients) {
      const ch = c.channels.get(topic);
      const metas = (ch as Channel & { metas?: unknown[] } | undefined)?.metas;
      if (ch?.presenceKey && metas?.length) state[ch.presenceKey] = { metas };
    }
    return state;
  }

  async function handle(c: Client, m: Msg) {
    if (m.topic === "phoenix" && m.event === "heartbeat") return reply(c, m, "ok");
    if (m.event === "phx_join") {
      const cfg = (m.payload.config ?? {}) as { broadcast?: { self?: boolean }; presence?: { key?: string }; postgres_changes?: Array<{ event: string; schema: string; table?: string; filter?: string }> };
      if (m.payload.access_token) {
        const claims = claimsOf(m.payload.access_token);
        if (!claims) return reply(c, m, "error", { reason: "Invalid JWT" });
        c.claims = claims;
      }
      const bindings = (cfg.postgres_changes ?? []).map((b) => ({ id: nextId++, event: b.event, schema: b.schema, table: b.table, filter: b.filter }));
      c.channels.set(m.topic, {
        topic: m.topic, joinRef: m.join_ref ?? m.ref, bindings,
        broadcastSelf: !!cfg.broadcast?.self, presenceKey: cfg.presence?.key || null,
      });
      reply(c, m, "ok", { postgres_changes: bindings.map((b) => ({ id: b.id, event: b.event, schema: b.schema, table: b.table, filter: b.filter })) });
      if (bindings.length) {
        send(c, { join_ref: m.join_ref, ref: null, topic: m.topic, event: "system", payload: { status: "ok", message: "Subscribed to PostgreSQL", extension: "postgres_changes", channel: m.topic.replace(/^realtime:/, "") } });
      }
      send(c, { join_ref: m.join_ref, ref: null, topic: m.topic, event: "presence_state", payload: presenceState(m.topic) });
      return;
    }
    if (m.event === "phx_leave") {
      c.channels.delete(m.topic);
      return reply(c, m, "ok");
    }
    if (m.event === "access_token") {
      const claims = claimsOf(m.payload.access_token);
      if (claims) c.claims = claims;
      return;
    }
    if (m.event === "broadcast") {
      for (const other of clients) {
        if (other === c && !c.channels.get(m.topic)?.broadcastSelf) continue;
        const ch = other.channels.get(m.topic);
        if (ch) send(other, { join_ref: ch.joinRef, ref: null, topic: m.topic, event: "broadcast", payload: m.payload });
      }
      if (m.ref) reply(c, m, "ok");
      return;
    }
    if (m.event === "presence") {
      const ch = c.channels.get(m.topic) as (Channel & { metas?: unknown[] }) | undefined;
      if (!ch) return reply(c, m, "error", { reason: "not joined" });
      const key = ch.presenceKey ?? `anon-${nextId++}`;
      ch.presenceKey = key;
      const leaves: Record<string, unknown> = ch.metas?.length ? { [key]: { metas: ch.metas } } : {};
      const joins: Record<string, unknown> = {};
      if (m.payload.event === "track") {
        ch.metas = [{ ...(m.payload.payload as object), phx_ref: String(nextId++) }];
        joins[key] = { metas: ch.metas };
      } else {
        ch.metas = [];
      }
      for (const other of clients) {
        const och = other.channels.get(m.topic);
        if (och) send(other, { join_ref: och.joinRef, ref: null, topic: m.topic, event: "presence_diff", payload: { joins, leaves } });
      }
      return reply(c, m, "ok");
    }
    if (m.ref) reply(c, m, "ok");
  }

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/realtime/v1/websocket") return;
    const key = url.searchParams.get("apikey");
    const claims = claimsOf(key);
    if (!claims) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Client = { ws, vsn: url.searchParams.get("vsn") === "1.0.0" ? "1.0.0" : "2.0.0", claims, channels: new Map() };
      clients.add(c);
      ws.on("message", (data, isBinary) => {
        if (isBinary) return; // broadcast binaire : non pris en charge
        let m: Msg;
        try {
          const raw = JSON.parse(String(data));
          m = Array.isArray(raw)
            ? { join_ref: raw[0], ref: raw[1], topic: raw[2], event: raw[3], payload: raw[4] ?? {} }
            : { join_ref: raw.join_ref ?? null, ref: raw.ref ?? null, topic: raw.topic, event: raw.event, payload: raw.payload ?? {} };
        } catch { return; }
        handle(c, m).catch((e) => console.error("[realtime]", e));
      });
      ws.on("close", () => {
        for (const [topic, ch] of c.channels) {
          const metas = (ch as Channel & { metas?: unknown[] }).metas;
          if (ch.presenceKey && metas?.length) {
            for (const other of clients) {
              const och = other.channels.get(topic);
              if (och && other !== c) send(other, { join_ref: och.joinRef, ref: null, topic, event: "presence_diff", payload: { joins: {}, leaves: { [ch.presenceKey]: { metas } } } });
            }
          }
        }
        clients.delete(c);
      });
    });
  });

  p.db.listen("platform_realtime", (payload) => { onChange(payload).catch((e) => console.error("[realtime]", e)); })
    .then((off) => { unlisten = off; })
    .catch((e) => console.error("[realtime] écoute impossible :", e));

  return {
    close: async () => {
      for (const c of clients) c.ws.close();
      await unlisten?.();
      wss.close();
    },
  };
}
