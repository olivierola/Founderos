# FounderOS Ops Runner

The Ops Runner is a small Node.js daemon that polls FounderOS for queued Ops jobs
(server probes, Ansible applies, Docker compose deploys, SSH commands…) and
executes them against the target servers over SSH.

It is intentionally separate from the SaaS:

- Supabase Edge Functions cannot keep persistent SSH connections, run native
  binaries (`ansible`, `terraform`, `kubectl`), or exfiltrate logs in
  real time.
- Keeping the runner outside Supabase means SSH credentials never traverse the
  customer-facing API surface: the runner fetches them via a single dedicated
  edge endpoint and keeps them in memory.

## Architecture

```
Frontend (React)
     │ ops-create-job
     ▼
  Supabase  ──(ops_jobs row, status=queued)──┐
     ▲                                        │
     │ ops-runner-poll (claim / log /         │
     │  complete / update_server / cred)      │
     │                                        │
  Ops Runner ◄───────────────────────────────┘
     │  SSH connection (ssh2)
     ▼
  Target Server (Ubuntu VPS)
```

## Setup

```bash
cd ops-runner
npm install
cp .env.example .env
# Edit .env — set SUPABASE_URL and RUNNER_TOKEN (rotated from the Ops > Settings page).
npm start
```

## Configuration (.env)

| Variable          | Required | Description                                                         |
| ----------------- | -------- | ------------------------------------------------------------------- |
| `SUPABASE_URL`    | yes      | `https://<project-ref>.supabase.co`                                  |
| `RUNNER_TOKEN`    | yes      | Token issued in the Ops > Settings page (rotate to get a new one). |
| `RUNNER_ID`       | no       | Identifier for this runner. Defaults to hostname.                   |
| `POLL_INTERVAL_MS`| no       | How often to poll for new jobs. Default 3000.                       |

## Supported jobs (v1)

- `server_test` — fetch OS, CPU, RAM, disk, Docker/Nginx/UFW/fail2ban presence,
  compute security score.
- `server_health` — same probes but lighter (refresh only).
- `security_audit` — recompute the security score after hardening.
- `docker_install` — install Docker + Compose plugin.
- `nginx_setup` — install Nginx as reverse proxy.
- `ssl_setup` — issue a Let's Encrypt certificate via certbot.
- `firewall_setup` — enable UFW with sane defaults.
- `ssh_exec` — execute an arbitrary `commands` array.

## Supported jobs (v2 / not yet implemented)

- `ansible_apply`, `terraform_plan/apply/destroy`, `k8s_apply`, etc.
- These require `ansible`, `terraform`, `kubectl` binaries on the runner host.
- The runner skeleton exposes a `handlers` map you can extend.

## Security

The runner authenticates to FounderOS with a token rotated from the UI. SSH
private keys are decrypted on-demand for the duration of a single job and never
persisted to disk.

## Operations

The runner exits non-zero on unrecoverable errors so a process supervisor
(systemd, Docker restart-on-failure) can restart it. Each job log line is
streamed to FounderOS via the `log` mode, so you can watch a deploy from the
Jobs & Audit page in real time.
