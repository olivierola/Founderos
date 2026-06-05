// analytics-query — server-side analytics engine over product_events.
//
// Computes funnels, retention cohorts, event trends and breakdowns directly in
// Postgres (via the fos_run_select SECURITY DEFINER helper) so it scales past
// what the browser could load. Authenticated: caller must be a workspace member.
//
// Body: { workspace_id, project_id, kind, ... }
//   kind = "funnel"     → { steps: string[], window_days?, from?, to? }
//   kind = "retention"  → { acquisition_event, return_event, period, periods, from?, to? }
//   kind = "trends"     → { event_name?, period, from?, to? }
//   kind = "breakdown"  → { from?, to?, limit? }   // counts per event_name
//   kind = "summary"    → { from?, to? }           // headline KPIs

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Escape a string as a SQL single-quoted literal. The only values we ever
// interpolate are event names; everything else is validated as uuid/int/enum.
function lit(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}
function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}
function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function periodTrunc(period: string): "day" | "week" | "month" {
  return period === "day" || period === "month" ? period : "week";
}
// A bounded ISO timestamp literal, or null (caller may omit the window edge).
function tsLit(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return lit(d.toISOString());
}

interface Ctx {
  runSelect: (sql: string) => Promise<unknown[]>;
  projectId: string;
  fromLit: string | null;
  toLit: string | null;
}

function windowClause(ctx: Ctx, col = "occurred_at"): string {
  const parts = [`project_id = ${lit(ctx.projectId)}`];
  if (ctx.fromLit) parts.push(`${col} >= ${ctx.fromLit}::timestamptz`);
  if (ctx.toLit) parts.push(`${col} <= ${ctx.toLit}::timestamptz`);
  return parts.join(" and ");
}

// Identity for a "user": prefer email, fall back to customer id. Used as the
// grouping key across all analyses so anonymous + identified events line up.
const ACTOR = "coalesce(user_email, customer_external_id)";

// ── Funnel ────────────────────────────────────────────────────────────────
// For each ordered step, count distinct actors who completed *all* prior steps
// (in timestamp order) and then this step within window_days of step 1.
async function funnel(ctx: Ctx, steps: string[], windowDays: number) {
  const clean = steps.filter((s) => typeof s === "string" && s.trim()).slice(0, 12);
  if (clean.length < 2) throw new Error("A funnel needs at least 2 steps");

  // First-touch time of each actor for each step, as CTEs s0..sN.
  const stepCtes = clean
    .map(
      (ev, i) => `
      s${i} as (
        select ${ACTOR} as actor, min(occurred_at) as t
        from product_events
        where ${windowClause(ctx)} and ${ACTOR} is not null and event_name = ${lit(ev)}
        group by actor
      )`,
    )
    .join(",");

  // Progressive join: actor must hit each step at t >= previous step's t, and
  // step i within window_days of step 0.
  const selectCounts = clean
    .map((_, i) => `count(distinct c.a${i}) as step_${i}`)
    .join(", ");

  let chain = `select s0.actor as a0, s0.t as t0`;
  for (let i = 1; i < clean.length; i++) {
    chain += `, s${i}.actor as a${i}, s${i}.t as t${i}`;
  }
  chain += ` from s0`;
  for (let i = 1; i < clean.length; i++) {
    chain +=
      ` left join s${i} on s${i}.actor = s0.actor` +
      ` and s${i}.t >= s${i - 1}.t` +
      ` and s${i}.t <= s0.t + (${windowDays} * interval '1 day')`;
  }

  const sql = `
    with ${stepCtes},
    chained as (${chain})
    select ${selectCounts} from chained c`;

  const rows = (await ctx.runSelect(sql)) as Record<string, number>[];
  const r = rows[0] ?? {};
  const counts = clean.map((_, i) => Number(r[`step_${i}`] ?? 0));
  const top = counts[0] || 0;
  const result = clean.map((event_name, i) => {
    const count = counts[i];
    const prev = i === 0 ? count : counts[i - 1];
    return {
      event_name,
      count,
      pct_of_top: top ? (count / top) * 100 : 0,
      step_conversion: prev ? (count / prev) * 100 : 0,
      dropoff: prev - count,
    };
  });
  return { steps: result, window_days: windowDays };
}

// ── Retention ───────────────────────────────────────────────────────────────
// Group actors into cohorts by the period of their first acquisition_event,
// then for each later period count how many performed return_event.
async function retention(
  ctx: Ctx,
  acquisitionEvent: string,
  returnEvent: string,
  period: "day" | "week" | "month",
  periods: number,
) {
  const sql = `
    with cohort as (
      select ${ACTOR} as actor, date_trunc('${period}', min(occurred_at)) as cohort_period
      from product_events
      where ${windowClause(ctx)} and ${ACTOR} is not null and event_name = ${lit(acquisitionEvent)}
      group by actor
    ),
    returns as (
      select ${ACTOR} as actor, date_trunc('${period}', occurred_at) as ret_period
      from product_events
      where ${windowClause(ctx)} and ${ACTOR} is not null and event_name = ${lit(returnEvent)}
      group by actor, ret_period
    ),
    grid as (
      select
        c.cohort_period,
        floor(extract(epoch from (r.ret_period - c.cohort_period)) /
          extract(epoch from interval '1 ${period}'))::int as period_index,
        count(distinct c.actor) as retained
      from cohort c
      join returns r on r.actor = c.actor and r.ret_period >= c.cohort_period
      group by c.cohort_period, period_index
    ),
    sizes as (
      select cohort_period, count(distinct actor) as cohort_size
      from cohort group by cohort_period
    )
    select
      to_char(s.cohort_period, 'YYYY-MM-DD') as cohort,
      s.cohort_size,
      g.period_index,
      g.retained
    from sizes s
    left join grid g on g.cohort_period = s.cohort_period
      and g.period_index >= 0 and g.period_index < ${periods}
    order by s.cohort_period desc`;

  const rows = (await ctx.runSelect(sql)) as {
    cohort: string;
    cohort_size: number;
    period_index: number | null;
    retained: number | null;
  }[];

  // Pivot into one row per cohort with a retained[] array.
  const byCohort = new Map<string, { cohort: string; size: number; retained: number[] }>();
  for (const row of rows) {
    let entry = byCohort.get(row.cohort);
    if (!entry) {
      entry = { cohort: row.cohort, size: Number(row.cohort_size), retained: new Array(periods).fill(0) };
      byCohort.set(row.cohort, entry);
    }
    if (row.period_index != null && row.period_index >= 0 && row.period_index < periods) {
      entry.retained[row.period_index] = Number(row.retained ?? 0);
    }
  }
  const cohorts = [...byCohort.values()].slice(0, 24).map((c) => ({
    cohort: c.cohort,
    size: c.size,
    retained: c.retained,
    pct: c.retained.map((n) => (c.size ? (n / c.size) * 100 : 0)),
  }));
  return { period, periods, cohorts };
}

// ── Trends ────────────────────────────────────────────────────────────────
async function trends(ctx: Ctx, eventName: string | undefined, period: "day" | "week" | "month") {
  const evClause = eventName ? ` and event_name = ${lit(eventName)}` : "";
  const sql = `
    select
      to_char(date_trunc('${period}', occurred_at), 'YYYY-MM-DD') as bucket,
      count(*) as events,
      count(distinct ${ACTOR}) as users
    from product_events
    where ${windowClause(ctx)}${evClause}
    group by 1 order by 1`;
  const rows = (await ctx.runSelect(sql)) as { bucket: string; events: number; users: number }[];
  return { period, series: rows.map((r) => ({ ...r, events: Number(r.events), users: Number(r.users) })) };
}

// ── Breakdown (top events) ──────────────────────────────────────────────────
async function breakdown(ctx: Ctx, limit: number) {
  const sql = `
    select event_name, count(*) as events, count(distinct ${ACTOR}) as users,
           max(occurred_at) as last_seen
    from product_events
    where ${windowClause(ctx)}
    group by event_name order by events desc limit ${limit}`;
  const rows = (await ctx.runSelect(sql)) as Record<string, unknown>[];
  return { events: rows.map((r) => ({ event_name: r.event_name, events: Number(r.events), users: Number(r.users), last_seen: r.last_seen })) };
}

// ── Summary KPIs ────────────────────────────────────────────────────────────
async function summary(ctx: Ctx) {
  const sql = `
    select
      count(*) as total_events,
      count(distinct event_name) as distinct_events,
      count(distinct ${ACTOR}) as active_users,
      count(distinct ${ACTOR}) filter (where occurred_at >= now() - interval '1 day') as active_1d,
      count(distinct ${ACTOR}) filter (where occurred_at >= now() - interval '7 days') as active_7d,
      count(distinct ${ACTOR}) filter (where occurred_at >= now() - interval '30 days') as active_30d
    from product_events
    where ${windowClause(ctx)}`;
  const rows = (await ctx.runSelect(sql)) as Record<string, number>[];
  const r = rows[0] ?? {};
  return {
    total_events: Number(r.total_events ?? 0),
    distinct_events: Number(r.distinct_events ?? 0),
    active_users: Number(r.active_users ?? 0),
    active_1d: Number(r.active_1d ?? 0),
    active_7d: Number(r.active_7d ?? 0),
    active_30d: Number(r.active_30d ?? 0),
  };
}

// ── Growth / engagement metrics ─────────────────────────────────────────────
// One round-trip that computes the high-value marketing/growth KPIs:
//   * DAU / WAU / MAU + stickiness (DAU/MAU, WAU/MAU)
//   * WAU series over the last `weeks` weeks with week-over-week growth
//   * new vs returning users this week
//   * power users (>= powerThreshold active days in the last 28 days)
//   * activation rate: of users first seen in the last `activationDays`, the
//     share who performed any of `keyEvents` within their activation window.
async function growth(
  ctx: Ctx,
  opts: { weeks: number; powerThreshold: number; activationDays: number; keyEvents: string[] },
) {
  const base = windowClause(ctx);

  // 1. Rolling DAU/WAU/MAU + stickiness (point-in-time, relative to now()).
  const sticky = (await ctx.runSelect(`
    select
      count(distinct ${ACTOR}) filter (where occurred_at >= now() - interval '1 day')  as dau,
      count(distinct ${ACTOR}) filter (where occurred_at >= now() - interval '7 days')  as wau,
      count(distinct ${ACTOR}) filter (where occurred_at >= now() - interval '30 days') as mau
    from product_events
    where ${base} and ${ACTOR} is not null
  `)) as Record<string, number>[];
  const dau = Number(sticky[0]?.dau ?? 0);
  const wau = Number(sticky[0]?.wau ?? 0);
  const mau = Number(sticky[0]?.mau ?? 0);

  // 2. WAU per week over the last `weeks` weeks (oldest → newest).
  const wauRows = (await ctx.runSelect(`
    select to_char(date_trunc('week', occurred_at), 'YYYY-MM-DD') as bucket,
           count(distinct ${ACTOR}) as users
    from product_events
    where ${base} and ${ACTOR} is not null
      and occurred_at >= date_trunc('week', now()) - (${opts.weeks - 1} * interval '1 week')
    group by 1 order by 1
  `)) as { bucket: string; users: number }[];
  const wauSeries = wauRows.map((r, i) => {
    const users = Number(r.users);
    const prev = i > 0 ? Number(wauRows[i - 1]!.users) : 0;
    return { bucket: r.bucket, users, growth_pct: prev ? ((users - prev) / prev) * 100 : 0 };
  });

  // 3. New vs returning this week: a user is "new" if their first-ever event in
  //    this project falls in the current week.
  const nr = (await ctx.runSelect(`
    with firsts as (
      select ${ACTOR} as actor, min(occurred_at) as first_seen
      from product_events
      where ${base} and ${ACTOR} is not null
      group by actor
    ),
    this_week as (
      select distinct ${ACTOR} as actor
      from product_events
      where ${base} and ${ACTOR} is not null
        and occurred_at >= date_trunc('week', now())
    )
    select
      count(*) filter (where f.first_seen >= date_trunc('week', now())) as new_users,
      count(*) filter (where f.first_seen <  date_trunc('week', now())) as returning_users
    from this_week t join firsts f on f.actor = t.actor
  `)) as Record<string, number>[];
  const newUsers = Number(nr[0]?.new_users ?? 0);
  const returningUsers = Number(nr[0]?.returning_users ?? 0);

  // 4. Power users: distinct active days in the last 28 days >= threshold.
  const power = (await ctx.runSelect(`
    with active_days as (
      select ${ACTOR} as actor, count(distinct date_trunc('day', occurred_at)) as days
      from product_events
      where ${base} and ${ACTOR} is not null and occurred_at >= now() - interval '28 days'
      group by actor
    )
    select
      count(*) as active_users,
      count(*) filter (where days >= ${opts.powerThreshold}) as power_users
    from active_days
  `)) as Record<string, number>[];
  const activeUsers28 = Number(power[0]?.active_users ?? 0);
  const powerUsers = Number(power[0]?.power_users ?? 0);

  // 5. Activation rate over users first seen in the last `activationDays` days.
  let activation = { cohort: 0, activated: 0, rate: 0, key_events: opts.keyEvents };
  if (opts.keyEvents.length > 0) {
    const keyList = opts.keyEvents.map((e) => lit(e)).join(", ");
    const act = (await ctx.runSelect(`
      with firsts as (
        select ${ACTOR} as actor, min(occurred_at) as first_seen
        from product_events
        where ${base} and ${ACTOR} is not null
        group by actor
      ),
      recent as (
        select * from firsts
        where first_seen >= now() - (${opts.activationDays} * interval '1 day')
      ),
      activated as (
        select distinct r.actor
        from recent r
        join product_events e
          on coalesce(e.user_email, e.customer_external_id) = r.actor
         and e.project_id = ${lit(ctx.projectId)}
         and e.event_name in (${keyList})
         and e.occurred_at >= r.first_seen
         and e.occurred_at <= r.first_seen + (${opts.activationDays} * interval '1 day')
      )
      select
        (select count(*) from recent) as cohort,
        (select count(*) from activated) as activated
    `)) as Record<string, number>[];
    const cohort = Number(act[0]?.cohort ?? 0);
    const activated = Number(act[0]?.activated ?? 0);
    activation = { cohort, activated, rate: cohort ? (activated / cohort) * 100 : 0, key_events: opts.keyEvents };
  }

  return {
    dau,
    wau,
    mau,
    stickiness_dau_mau: mau ? (dau / mau) * 100 : 0,
    stickiness_wau_mau: mau ? (wau / mau) * 100 : 0,
    wau_series: wauSeries,
    new_users: newUsers,
    returning_users: returningUsers,
    power_users: powerUsers,
    active_users_28d: activeUsers28,
    power_user_rate: activeUsers28 ? (powerUsers / activeUsers28) * 100 : 0,
    power_threshold: opts.powerThreshold,
    activation,
  };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const body = await req.json();
    const { workspace_id, project_id, kind } = body ?? {};
    if (!isUuid(workspace_id) || !isUuid(project_id) || !kind) {
      return jsonResponse({ error: "workspace_id, project_id (uuid), kind required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!m) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    // Confirm the project belongs to the workspace before querying its events.
    const { data: proj } = await admin
      .from("projects")
      .select("id")
      .eq("id", project_id)
      .eq("workspace_id", workspace_id)
      .maybeSingle();
    if (!proj) return jsonResponse({ error: "Project not in workspace" }, { status: 403 });

    const ctx: Ctx = {
      projectId: project_id,
      fromLit: tsLit(body.from),
      toLit: tsLit(body.to),
      runSelect: async (sql: string) => {
        const { data, error } = await admin.rpc("fos_run_select", { query_text: sql });
        if (error) throw new Error(error.message);
        return (data as unknown[]) ?? [];
      },
    };

    let result: unknown;
    switch (kind) {
      case "funnel":
        result = await funnel(ctx, Array.isArray(body.steps) ? body.steps : [], clampInt(body.window_days, 30, 1, 365));
        break;
      case "retention":
        if (typeof body.acquisition_event !== "string" || typeof body.return_event !== "string") {
          return jsonResponse({ error: "acquisition_event, return_event required" }, { status: 400 });
        }
        result = await retention(
          ctx,
          body.acquisition_event,
          body.return_event,
          periodTrunc(body.period),
          clampInt(body.periods, 8, 2, 24),
        );
        break;
      case "trends":
        result = await trends(ctx, typeof body.event_name === "string" ? body.event_name : undefined, periodTrunc(body.period));
        break;
      case "breakdown":
        result = await breakdown(ctx, clampInt(body.limit, 50, 1, 200));
        break;
      case "summary":
        result = await summary(ctx);
        break;
      case "growth":
        result = await growth(ctx, {
          weeks: clampInt(body.weeks, 12, 4, 52),
          powerThreshold: clampInt(body.power_threshold, 4, 1, 28),
          activationDays: clampInt(body.activation_days, 7, 1, 90),
          keyEvents: Array.isArray(body.key_events)
            ? (body.key_events as unknown[]).filter((e): e is string => typeof e === "string" && e.trim().length > 0).slice(0, 20)
            : [],
        });
        break;
      default:
        return jsonResponse({ error: `Unknown kind ${kind}` }, { status: 400 });
    }

    return jsonResponse({ ok: true, ...(result as object) });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
