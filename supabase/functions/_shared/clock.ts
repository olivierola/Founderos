// clock.ts — what time it is for the USER, and how their wall-clock schedules
// map onto the UTC-aligned scheduler.
//
// Agents had no notion of "now": the prompt carried no date, so "remind me on
// Thursday", "offers posted this week" or "this month's budget" were all
// guesses. And create_mission wrote the raw cron into
// internal_agent_missions.schedule, which 0146 constrains to
// hourly/daily/weekly/monthly — every recurring mission asked for in chat was
// refused by the database.
//
// No user timezone is stored anywhere yet, so the product default (the
// audience is French) applies, overridable per deployment with
// DEFAULT_TIMEZONE. The prompt states the zone so the agent can adapt when the
// user says otherwise.

export type Cadence = "hourly" | "daily" | "weekly" | "monthly";

export function defaultTimezone(): string {
  const tz = Deno.env.get("DEFAULT_TIMEZONE") || "Europe/Paris";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "Europe/Paris";
  }
}

/** Wall-clock parts of `at` in `tz`. */
function zonedParts(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
    hour: Number(get("hour")), minute: Number(get("minute")), second: Number(get("second")),
    dow: dows.indexOf(get("weekday")),
  };
}

/** Offset of `tz` from UTC at instant `at`, in minutes (Paris summer = +120). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** The UTC instant at which the wall clock in `tz` reads the given time. */
export function zonedTimeToUtc(
  y: number, mo: number, d: number, h: number, mi: number, tz: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle DST boundaries (the offset at the guess may differ from
  // the offset at the answer).
  let ts = guess - tzOffsetMinutes(new Date(guess), tz) * 60000;
  ts = guess - tzOffsetMinutes(new Date(ts), tz) * 60000;
  return new Date(ts);
}

/** One line for the prompt: the user's current date and time, spelled out. */
export function renderClock(tz: string, now = new Date()): string {
  const long = new Intl.DateTimeFormat("fr-FR", {
    timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(now);
  const off = tzOffsetMinutes(now, tz);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const utc = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `Maintenant : ${long} (fuseau ${tz}, ${utc}). ` +
    "Toute date relative (« demain », « jeudi », « ce mois-ci », « dans 2 heures ») se calcule à partir de là, dans ce fuseau — sauf si l'utilisateur t'a indiqué vivre ailleurs.";
}

export interface ParsedSchedule {
  cadence: Cadence;
  next_run_at: string;
  schedule_minute: number;
  schedule_hour: number | null;
  schedule_dow: number | null;
  schedule_dom: number | null;
}

/**
 * Read a cron written in the user's wall-clock time and turn it into what the
 * scheduler stores: a cadence, the first run, and the UTC alignment fields.
 * Only shapes the scheduler can honour are accepted — steps, lists and ranges
 * have no cadence equivalent, so they return null rather than a guess.
 *
 * The cadence also accepts the plain words ("daily", "weekly"…), in which case
 * the first run is one minute from now and alignment follows that instant.
 */
export function parseSchedule(input: string, tz: string, now = new Date()): ParsedSchedule | null {
  const raw = input.trim().toLowerCase();
  if (["hourly", "daily", "weekly", "monthly"].includes(raw)) {
    const first = new Date(now.getTime() + 60_000);
    first.setUTCSeconds(0, 0);
    const cadence = raw as Cadence;
    return {
      cadence, next_run_at: first.toISOString(),
      schedule_minute: first.getUTCMinutes(),
      schedule_hour: cadence === "hourly" ? null : first.getUTCHours(),
      schedule_dow: cadence === "weekly" ? first.getUTCDay() : null,
      schedule_dom: cadence === "monthly" ? Math.min(first.getUTCDate(), 28) : null,
    };
  }

  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, mon, dow] = parts;
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
  const minute = num(mi);
  if (minute === null || minute > 59 || mon !== "*") return null;

  let cadence: Cadence;
  let hour = 0, wantDow = 0, wantDom = 1;
  if (h === "*" && dom === "*" && dow === "*") {
    cadence = "hourly";
  } else {
    const hh = num(h);
    if (hh === null || hh > 23) return null;
    hour = hh;
    const dw = num(dow === "7" ? "0" : dow);
    const dm = num(dom);
    if (dom === "*" && dow === "*") cadence = "daily";
    else if (dom === "*" && dw !== null && dw <= 6) { cadence = "weekly"; wantDow = dw; }
    else if (dow === "*" && dm !== null && dm >= 1 && dm <= 28) { cadence = "monthly"; wantDom = dm; }
    else return null;
  }

  // First occurrence strictly after now, walking the user's calendar.
  const local = zonedParts(now, tz);
  let first: Date | null = null;
  if (cadence === "hourly") {
    const base = zonedTimeToUtc(local.year, local.month, local.day, local.hour, minute, tz);
    first = base > now ? base : new Date(base.getTime() + 3600_000);
  } else {
    for (let i = 0; i <= 62 && !first; i++) {
      const day = new Date(Date.UTC(local.year, local.month - 1, local.day + i));
      const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
      if (cadence === "weekly" && day.getUTCDay() !== wantDow) continue;
      if (cadence === "monthly" && d !== wantDom) continue;
      const at = zonedTimeToUtc(y, m, d, hour, minute, tz);
      if (at > now) first = at;
    }
  }
  if (!first) return null;

  return {
    cadence,
    next_run_at: first.toISOString(),
    schedule_minute: first.getUTCMinutes(),
    schedule_hour: cadence === "hourly" ? null : first.getUTCHours(),
    schedule_dow: cadence === "weekly" ? first.getUTCDay() : null,
    schedule_dom: cadence === "monthly" ? Math.min(first.getUTCDate(), 28) : null,
  };
}

/**
 * Parse a one-off date for a reminder. An ISO string with an offset or "Z" is
 * taken as is; a bare "YYYY-MM-DDTHH:mm" is read in the user's zone — which is
 * what a model writes when it computed "Thursday 14:00" from the prompt clock.
 */
export function parseRunAt(input: string, tz: string): Date | null {
  const s = input.trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 9), Number(m[5] ?? 0), tz);
}
