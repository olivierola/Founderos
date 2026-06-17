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

## Security scanning scope

Active scans are **non-destructive**: connect-and-close port checks and surface
enumeration to *prove exposure*, never exploitation. The platform refuses to
queue an active scan for a target without recorded consent (you declare you own
/ are authorised on the target). Passive checks (HTTP headers, TLS, exposed
files, dependency CVEs, leaked secrets) run server-side in edge functions.
