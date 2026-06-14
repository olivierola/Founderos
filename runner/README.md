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

## Security scanning scope

Active scans are **non-destructive**: connect-and-close port checks and surface
enumeration to *prove exposure*, never exploitation. The platform refuses to
queue an active scan for a target without recorded consent (you declare you own
/ are authorised on the target). Passive checks (HTTP headers, TLS, exposed
files, dependency CVEs, leaked secrets) run server-side in edge functions.
