# FounderOS Test Runner

Executes the agentic end-to-end tests defined in **DevOps → Testing** using a real
Chromium browser driven by [Playwright](https://playwright.dev). The AI agent
lives server-side (Supabase edge functions); this runner is its hands and eyes:
it loads the app, captures the DOM + a screenshot, asks the orchestrator for the
next action, and executes it.

```
┌──────────────┐   claim/observe/poll   ┌───────────────────────┐   decideNextAction   ┌──────────┐
│ test-runner  │ ─────────────────────▶ │  test-runner-poll     │ ───────────────────▶ │  Agent   │
│ (Playwright) │ ◀───────────────────── │  (edge function)      │ ◀─────────────────── │ (Groq)   │
└──────────────┘   next browser action  └───────────────────────┘                      └──────────┘
```

## Why a runner (and not an iframe)

Browsers forbid reading/controlling the DOM of a **cross-origin** iframe, and most
apps refuse to be embedded at all (`X-Frame-Options` / CSP `frame-ancestors`).
Playwright also runs in Node, not in the browser. So real E2E on an arbitrary URL
requires a server-side browser. The "embedded app" you see in the live view is the
**streamed screenshot** of this runner's Chromium page.

## Setup

```bash
cd test-runner
npm install          # also runs `playwright install chromium`
cp .env.example .env # fill in the values below
npm start
```

### Environment

| Var | Required | Notes |
|-----|----------|-------|
| `SUPABASE_URL` | ✅ | `https://<ref>.supabase.co` |
| `RUNNER_TOKEN` | ✅ | Plaintext runner token. Register it in **DevOps → Settings** (it's hashed into `ops_settings.runner_token_hash`). The same token drives Ops jobs and E2E tests. |
| `SUPABASE_SERVICE_ROLE_KEY` | ⚠️ | Only used to upload screenshots to the `test-artifacts` bucket. Without it, runs still work but the live view shows no frames. |
| `RUNNER_ID` | — | Defaults to `hostname-pid`. |
| `POLL_INTERVAL_MS` | — | Idle poll cadence, default `3000`. |
| `MAX_STEPS` | — | Safety cap on actions per run, default `40`. |

The `test-artifacts` storage bucket is created by migration `0042_e2e_testing.sql`
(public read; writes via service role).

## How a run flows

1. UI calls `test-run-orchestrate` (`action: start`) → creates a `test_runs` row,
   the agent drafts a plan, status becomes `queued`.
2. This runner claims it (`mode: claim`), opens the app URL.
3. Loop: screenshot + DOM excerpt → `mode: observe` → the agent returns one action
   (`navigate`/`click`/`fill`/`scroll`/`press`/`assert`) → the runner executes it.
4. If the agent needs info it returns `ask_user`; the run pauses (`needs_input`).
   The runner idle-polls (`mode: poll`) until the user answers in the live view,
   then continues.
5. On `pass`/`fail` the run finishes; the timeline and verdict are shown in the UI.

## Security notes

- Point runs at **staging / non-production** apps. The agent only fills data from
  the test's `fixtures` or the user's answers, and never invents secrets, but E2E
  tests still perform real clicks/submits.
- The runner authenticates with `X-Runner-Token`; rotate it from **DevOps → Settings**.
