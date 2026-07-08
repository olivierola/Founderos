# FounderOS Unified Runner

One self-hosted runner that executes **all** FounderOS background work from a
single poll loop:

- **Ops jobs** — SSH / infra (Ansible, Docker, deploys) — reuses `ops-runner`.
- **E2E test runs** — Playwright browser automation — reuses `test-runner`.
- **Security scans** — active, non-destructive scans (TCP port scan, surface
  enumeration). Consent is enforced server-side: only scans for a target with a
  recorded authorisation are ever handed out.

It replaces running `ops-runner` and `test-runner` separately. Each tick it asks
each source for work in priority order (ops → tests → security) and does one
unit, then re-polls.

## Setup

```bash
cd runner
npm install          # installs Playwright Chromium + ssh2
cp .env.example .env # fill SUPABASE_URL + RUNNER_TOKEN (+ service key for screenshots)
npm start
```

The unified runner imports the existing `ops-runner` and `test-runner` source
files (siblings of this folder), so keep the repo layout intact. Install their
deps too if you run from a fresh checkout:

```bash
(cd ../ops-runner && npm install) && (cd ../test-runner && npm install)
```

## Voice call center (optional)

The runner also hosts the Support voice bridge: Twilio Media Streams ⇄ Deepgram
STT/TTS ⇄ the AI resolver. Edge functions can't hold long-lived bidirectional
audio sockets, so this persistent WebSocket server runs here, started
automatically by `main()` **only when configured**:

```bash
# .env additions
SUPABASE_SERVICE_ROLE_KEY=...   # used to read/write support_voice_calls
VOICE_WS_PORT=8787              # port the WS server listens on
DEEPGRAM_API_KEY=...            # STT + TTS
# optional overrides:
# DEEPGRAM_STT_MODEL=nova-2  DEEPGRAM_STT_LANGUAGE=fr  DEEPGRAM_TTS_MODEL=aura-2-thalia-fr
```

Expose the port publicly (e.g. via a reverse proxy / tunnel) as `wss://…`, then
set that base URL as `runner_ws` in the voice channel's config (support_channels
row, `config.runner_ws`). The support-voice edge function returns TwiML pointing
Twilio's Media Stream at `runner_ws?call_sid=…&project_id=…`. Set the Twilio
number's Voice webhook to the URL shown in the channel card (Support → Channels).

## Machine tools for runner-mode agents

Internal agents whose execution environment is **Runner** get more than the
Playwright browser: the same HTTP server (port `BROWSER_PORT`, default 3847)
also exposes machine capabilities, all authenticated by the same
`X-Runner-Token`:

- `POST /api/exec` — shell commands (`powershell` / `cmd` / `bash` / `sh`;
  default matches the host OS). Timeout-killed with full process-tree cleanup;
  PowerShell exit codes are propagated faithfully.
- `POST /api/code` — Python or Node.js snippets (fresh process per call).
- `POST /api/files` — `write` / `read` / `replace` / `list` / `find` (glob) /
  `grep` / `mkdir` / `delete` / `move` / `copy`, rooted in the agent's workspace.
- `POST /api/proc` — long-running processes that survive between calls:
  `start` (returns a `proc_id`) / `list` / `logs` / `stop`. For dev servers,
  watchers and jobs that `/api/exec` (timeout-bounded) can't host.
- `POST /api/download` — fetch a http(s) URL straight to a workspace file
  (100 MB cap).
- `POST /api/info` — OS, shells, Python/Node/git versions, workspace paths.

Each agent gets a **persistent workspace** at
`RUNNER_WORKSPACE_ROOT/<agent_id>` (default `./workspace/…`) — relative paths
resolve there and files survive across runs. Absolute paths reach the whole
machine (the agent runs with your user's privileges) unless you set
`RUNNER_RESTRICT_TO_WORKSPACE=1`; set `RUNNER_DISABLE_EXEC=1` to switch off
shell/code execution entirely. Expose the port to the edge functions via a
tunnel and keep `runner_browser_url` in `app_config` pointing at it (see
`scripts/start-agents-infra.ps1`).

## Security scanning scope

Active scans are **non-destructive**: connect-and-close port checks and surface
enumeration to *prove exposure*, never exploitation. The platform refuses to
queue an active scan for a target without recorded consent (you declare you own
/ are authorised on the target). Passive checks (HTTP headers, TLS, exposed
files, dependency CVEs, leaked secrets) run server-side in edge functions.
