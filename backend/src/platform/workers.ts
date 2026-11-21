// Ce que pg_cron et pg_net faisaient dans la base, fait par le backend.
//
//   cron : lit cron.job chaque seconde ; une tâche « */5 * * * * » ou
//     « 10 seconds » s'exécute à son heure (SQL, sous le propriétaire de la
//     base, comme pg_cron), notée dans cron.job_run_details. Chaque passage
//     réserve un créneau (cron._slots) : plusieurs instances, une exécution.
//   net : envoie les requêtes de net.http_request_queue dès leur notification
//     (et en rattrapage toutes les 2 s), range la réponse dans
//     net._http_response — c'est ainsi que les tâches planifiées appellent les
//     fonctions (internal-agent-run, scheduler…).

import type { Db } from "./db.ts";

// ── Planning ────────────────────────────────────────────────────────────────

/** « 10 seconds » → 10 ; sinon null (expression cron à 5 champs). */
export function intervalSeconds(schedule: string): number | null {
  const m = /^\s*(\d+)\s+seconds?\s*$/i.exec(schedule);
  return m ? Math.max(1, Number(m[1])) : null;
}

function fieldMatches(expr: string, value: number, min: number, max: number): boolean {
  for (const part of expr.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    let lo = min, hi = max;
    if (rangePart !== "*") {
      const [a, b] = rangePart.split("-").map(Number);
      lo = a; hi = b === undefined || Number.isNaN(b) ? (stepPart ? max : a) : b;
    }
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}

/** Minute, heure, jour du mois, mois, jour de semaine (0 ou 7 = dimanche), en UTC comme pg_cron. */
export function cronMatches(schedule: string, d: Date): boolean {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const dow = d.getUTCDay();
  const domOk = fieldMatches(f[2], d.getUTCDate(), 1, 31);
  const dowOk = fieldMatches(f[4], dow, 0, 7) || (dow === 0 && fieldMatches(f[4], 7, 0, 7));
  // Règle de cron : si les deux jours sont restreints, l'un OU l'autre suffit.
  const dayOk = f[2] !== "*" && f[4] !== "*" ? domOk || dowOk : domOk && dowOk;
  return fieldMatches(f[0], d.getUTCMinutes(), 0, 59)
    && fieldMatches(f[1], d.getUTCHours(), 0, 23)
    && fieldMatches(f[3], d.getUTCMonth() + 1, 1, 12)
    && dayOk;
}

/**
 * Le dernier créneau échu d'une tâche, ou null. Pas la seconde exacte : un
 * minuteur qui dérive en sauterait une. La réservation (cron._slots) garantit
 * qu'un créneau ne s'exécute qu'une fois.
 */
export function slotFor(schedule: string, now: Date): Date | null {
  const every = intervalSeconds(schedule);
  if (every) {
    const s = Math.floor(now.getTime() / 1000);
    return new Date(Math.floor(s / every) * every * 1000);
  }
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  return cronMatches(schedule, minute) ? minute : null;
}

// ── Les deux workers ────────────────────────────────────────────────────────

export function startWorkers(db: Db, log: (l: string) => void = (l) => console.log(`[platform] ${l}`)) {
  let stopped = false;
  const running = new Set<number>();

  async function cronTick() {
    const now = new Date();
    const jobs = await db.query<{ jobid: string; schedule: string; command: string; jobname: string | null }>(
      "select jobid::text as jobid, schedule, command, jobname from cron.job where active");
    for (const j of jobs) {
      const id = Number(j.jobid);
      const slot = slotFor(j.schedule, now);
      if (!slot || running.has(id)) continue;
      const claimed = await db.command("insert into cron._slots (jobid, slot) values ($1, $2) on conflict do nothing", [id, slot.toISOString()]);
      if (!claimed) continue;
      running.add(id);
      const start = new Date();
      db.exec(j.command)
        .then(() => db.query(
          `insert into cron.job_run_details (jobid, command, status, return_message, start_time, end_time, database, username)
           values ($1, $2, 'succeeded', '1 row', $3, now(), current_database(), current_user)`, [id, j.command, start.toISOString()]))
        .catch((e) => {
          log(`cron ${j.jobname ?? id} : ${e instanceof Error ? e.message : e}`);
          return db.query(
            `insert into cron.job_run_details (jobid, command, status, return_message, start_time, end_time, database, username)
             values ($1, $2, 'failed', $3, $4, now(), current_database(), current_user)`,
            [id, j.command, String(e instanceof Error ? e.message : e).slice(0, 2000), start.toISOString()]).catch(() => {});
        })
        .finally(() => running.delete(id));
    }
  }

  // Le ménage de pg_cron et pg_net : l'historique ne grossit pas sans fin.
  async function prune() {
    await db.query("delete from cron._slots where slot < now() - interval '1 hour'");
    await db.query("delete from cron.job_run_details where end_time < now() - interval '7 days'");
    await db.query("delete from net._http_response where created < now() - interval '6 hours'");
  }

  let netBusy = false;
  async function netDrain() {
    if (netBusy) return;
    netBusy = true;
    try {
      for (;;) {
        const batch = await db.tx((q) => q.query<{ id: string; method: string; url: string; headers: Record<string, string> | string | null; body: Buffer | Uint8Array | string | null; timeout_milliseconds: number }>(
          `delete from net.http_request_queue where id in (
             select id from net.http_request_queue order by id limit 20 for update skip locked)
           returning id::text as id, method, url, headers, body, timeout_milliseconds`));
        if (!batch.length) break;
        await Promise.all(batch.map(async (r) => {
          const headers = typeof r.headers === "string" ? JSON.parse(r.headers) : (r.headers ?? {});
          const body = r.body == null ? undefined
            : typeof r.body === "string" ? (r.body.startsWith("\\x") ? Buffer.from(r.body.slice(2), "hex") : r.body)
            : Buffer.from(r.body);
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), Math.max(1000, r.timeout_milliseconds));
          try {
            const res = await fetch(r.url, { method: r.method, headers, body: r.method === "GET" ? undefined : body, signal: ctrl.signal });
            const content = await res.text();
            await db.query(
              `insert into net._http_response (id, status_code, content_type, headers, content, timed_out)
               values ($1, $2, $3, $4::jsonb, $5, false) on conflict (id) do nothing`,
              [r.id, res.status, res.headers.get("content-type"), JSON.stringify(Object.fromEntries(res.headers)), content.slice(0, 100_000)]);
          } catch (e) {
            const timedOut = (e as Error).name === "AbortError";
            await db.query(
              `insert into net._http_response (id, timed_out, error_msg) values ($1, $2, $3) on conflict (id) do nothing`,
              [r.id, timedOut, String(e instanceof Error ? e.message : e).slice(0, 2000)]).catch(() => {});
          } finally {
            clearTimeout(timer);
          }
        }));
      }
    } catch (e) {
      log(`net : ${e instanceof Error ? e.message : e}`);
    } finally {
      netBusy = false;
    }
  }

  const cronTimer = setInterval(() => { if (!stopped) cronTick().catch((e) => log(`cron : ${e instanceof Error ? e.message : e}`)); }, 1000);
  const netTimer = setInterval(() => { if (!stopped) void netDrain(); }, 2000);
  const pruneTimer = setInterval(() => { if (!stopped) prune().catch(() => {}); }, 10 * 60_000);
  let unlisten: (() => Promise<void>) | null = null;
  db.listen("platform_net", () => { void netDrain(); }).then((off) => { unlisten = off; }).catch(() => {});

  return {
    stop: async () => {
      stopped = true;
      clearInterval(cronTimer); clearInterval(netTimer); clearInterval(pruneTimer);
      await unlisten?.();
    },
  };
}
