// Cadence maths shared by the Schedules tab and template creation.
//
// A schedule is an internal_agent_missions row with a cadence plus UTC
// alignment (schedule_minute/hour/dow/dom). The user picks a LOCAL wall-clock
// time; we persist the concrete next instant and the UTC fields derived from
// it, so the pure-UTC scheduler lands on the same cadence.

export type Cadence = "hourly" | "daily" | "weekly" | "monthly";

export interface Cadenced { cadence: Cadence; minute: number; hour: number; dow: number; dom: number; }

// First occurrence strictly after `now`, computed in the user's local time.
export function firstOccurrenceLocal(sel: Cadenced, now = new Date()): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  if (sel.cadence === "hourly") {
    d.setMinutes(sel.minute);
    if (d <= now) d.setHours(d.getHours() + 1);
    return d;
  }
  d.setHours(sel.hour, sel.minute);
  if (sel.cadence === "daily") { if (d <= now) d.setDate(d.getDate() + 1); return d; }
  if (sel.cadence === "weekly") {
    let delta = (sel.dow - d.getDay() + 7) % 7;
    if (delta === 0 && d <= now) delta = 7;
    d.setDate(d.getDate() + delta);
    return d;
  }
  // monthly
  d.setDate(sel.dom);
  if (d <= now) d.setMonth(d.getMonth() + 1, sel.dom);
  return d;
}

// UTC alignment fields derived from a concrete occurrence.
export function toAlignment(sel: Cadenced, occ: Date) {
  return {
    schedule_minute: occ.getUTCMinutes(),
    schedule_hour: sel.cadence === "hourly" ? null : occ.getUTCHours(),
    schedule_dow: sel.cadence === "weekly" ? occ.getUTCDay() : null,
    schedule_dom: sel.cadence === "monthly" ? Math.min(occ.getUTCDate(), 28) : null,
  };
}

/**
 * Read a template's suggested cron as a cadence. Templates write crons in the
 * user's wall-clock time ("0 8 * * 1" = Monday 8:00 where they live). Only the
 * shapes the scheduler can express are accepted — a step, a list or a range has
 * no cadence equivalent, and guessing one would fire at a time nobody chose.
 */
export function cadenceFromCron(cron: string): Cadenced | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, mon, dow] = parts;
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
  const minute = num(mi);
  if (minute === null || minute > 59 || mon !== "*") return null;
  if (h === "*" && dom === "*" && dow === "*") return { cadence: "hourly", minute, hour: 0, dow: 0, dom: 1 };
  const hour = num(h);
  if (hour === null || hour > 23) return null;
  if (dom === "*" && dow === "*") return { cadence: "daily", minute, hour, dow: 0, dom: 1 };
  const d = num(dow);
  if (dom === "*" && d !== null && d <= 6) return { cadence: "weekly", minute, hour, dow: d, dom: 1 };
  const m = num(dom);
  if (dow === "*" && m !== null && m >= 1 && m <= 28) return { cadence: "monthly", minute, hour, dow: 0, dom: m };
  return null;
}
