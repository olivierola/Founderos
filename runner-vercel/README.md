# FounderOS Runner (Vercel)

Serverless version of the FounderOS runner, deployed on Vercel with a cron job that triggers every minute.

## Sources

| Source | Status | Notes |
|--------|--------|-------|
| Simulations | Active | LLM-driven multi-agent simulations (HTTP calls to edge functions) |
| Security scans | Active | TCP port scans (non-destructive, consented targets only) |
| Ops jobs | Skipped | Requires SSH — needs a real server |
| E2E tests | Skipped | Requires Playwright/Chromium — needs a real server |

## Deploy

```bash
cd runner-vercel
npx vercel --prod
```

## Environment Variables

Set these in the Vercel dashboard (Settings → Environment Variables):

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `RUNNER_TOKEN` | Yes | Value of `PLATFORM_RUNNER_TOKEN` from Supabase edge env |
| `RUNNER_ID` | No | Runner identifier (default: `vercel-runner`) |
| `CRON_SECRET` | No | Vercel auto-sets this for cron auth |
| `MAX_DURATION_MS` | No | Time budget in ms (default: 55000) |

## How it works

1. Vercel Cron triggers `GET /api/tick` every minute
2. The function tries security scans first (fast, one-shot)
3. Then claims a queued simulation and runs rounds within the time budget
4. If a simulation has more rounds than fit in one invocation, it stays `running` and the next cron tick continues it
5. When all rounds are done, the runner calls `complete` to generate the report

## Vercel Plan Notes

- **Hobby** (10s timeout): Can run ~1 simulation round per tick. A 20-round simulation takes ~20 minutes.
- **Pro** (60s default, up to 300s with `maxDuration`): Can run a full simulation in 1-2 ticks.
- The `vercel.json` sets `maxDuration: 300` — requires Vercel Pro plan for full effect.
