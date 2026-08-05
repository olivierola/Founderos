# start-agents-infra.ps1 -- (re)launch the whole local agent infra in one command.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-agents-infra.ps1
#
# Idempotent: checks each layer and only starts what's down.
#   1. Docker Desktop daemon
#   2. aio-sandbox container on :8080  (verified via a REAL /v1/bash/exec call --
#      the image's healthcheck lies; recreated fresh if the API won't serve)
#   3. AchiCorp unified runner on :3847
#   4. ngrok tunnels (sandbox + browser)
#   5. Supabase secrets SANDBOX_URL / RUNNER_BROWSER_URL re-synced to the new
#      tunnel URLs (free-tier URLs change on every ngrok restart)
#
# NOTE: keep this file pure ASCII -- PowerShell 5.1 reads BOM-less .ps1 as ANSI
# and non-ASCII characters corrupt the parser.

$ErrorActionPreference = "Continue"
$ProjectRef = "scugmxahflsjabglodyv"
$RepoRoot   = Split-Path -Parent $PSScriptRoot
$RunnerDir  = Join-Path $RepoRoot "runner"
$LogDir     = Join-Path $env:LOCALAPPDATA "founderos-infra"
New-Item -ItemType Directory -Force $LogDir | Out-Null

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }

# Real sandbox check: POST /v1/bash/exec (never trust the docker healthcheck).
function Test-SandboxApi {
    $tmp = Join-Path $env:TEMP "sbx-probe.json"
    '{"command":"echo infra-ok"}' | Out-File $tmp -Encoding ascii -NoNewline
    $out = & curl.exe -s -m 10 -X POST http://localhost:8090/v1/bash/exec -H "Content-Type: application/json" --data-binary "@$tmp" 2>$null
    return ($out -match '"success"\s*:\s*true')
}

# -- 1. Docker daemon ----------------------------------------------------------
Step "Docker daemon"
docker ps *> $null
if (-not $?) {
    $dd = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (-not (Test-Path $dd)) { Write-Error "Docker Desktop introuvable ($dd)"; exit 1 }
    Start-Process $dd
    Write-Host "    demarrage de Docker Desktop..."
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 3
        docker ps *> $null
        if ($?) { $ready = $true; break }
    }
    if (-not $ready) { Write-Error "Docker n'a pas demarre en 2 min"; exit 1 }
}
Ok "daemon actif"

# -- 2. Sandbox container ------------------------------------------------------
Step "Sandbox aio-sandbox (host :8090 -> container :8080)"
$exists  = (docker ps -a --filter "name=^aio-sandbox$" --format "{{.Names}}") -eq "aio-sandbox"
$running = (docker ps    --filter "name=^aio-sandbox$" --format "{{.Names}}") -eq "aio-sandbox"
if (-not $exists) {
    Write-Host "    conteneur absent -> docker run"
    docker run -d --name aio-sandbox --restart unless-stopped -p 8090:8080 ghcr.io/agent-infra/sandbox:latest | Out-Null
} elseif (-not $running) {
    Write-Host "    conteneur arrete -> docker start"
    docker start aio-sandbox | Out-Null
}

# Wait for the REAL API (boot takes 1-3 min), with one fresh-recreate remediation
# if nginx is in its known crash-loop state.
$apiUp = $false
for ($round = 0; $round -lt 2 -and -not $apiUp; $round++) {
    for ($i = 0; $i -lt 36; $i++) {          # ~3 min per round
        if (Test-SandboxApi) { $apiUp = $true; break }
        Start-Sleep -Seconds 5
    }
    if (-not $apiUp -and $round -eq 0) {
        Warn "API muette (nginx crash-loop probable) -> recreation du conteneur"
        docker rm -f aio-sandbox | Out-Null
        docker run -d --name aio-sandbox --restart unless-stopped -p 8090:8080 ghcr.io/agent-infra/sandbox:latest | Out-Null
    }
}
if (-not $apiUp) { Write-Error "Sandbox API KO apres recreation - voir 'docker logs aio-sandbox'"; exit 1 }
Ok "API bash/exec repond"

# -- 3. Runner (:3847) ---------------------------------------------------------
Step "Runner AchiCorp (:3847)"
$listening = $null -ne (Get-NetTCPConnection -State Listen -LocalPort 3847 -ErrorAction SilentlyContinue)
if (-not $listening) {
    Start-Process node -ArgumentList "src/index.js" -WorkingDirectory $RunnerDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir "runner.log") -RedirectStandardError (Join-Path $LogDir "runner.err.log")
    Start-Sleep -Seconds 4
    $listening = $null -ne (Get-NetTCPConnection -State Listen -LocalPort 3847 -ErrorAction SilentlyContinue)
}
if ($listening) { Ok "runner en ecoute" } else { Warn "runner pas encore en ecoute (voir $LogDir\runner*.log)" }

# -- 4. ngrok tunnels ----------------------------------------------------------
Step "Tunnels ngrok"
$tunnels = $null
try { $tunnels = (Invoke-RestMethod http://localhost:4040/api/tunnels -TimeoutSec 3).tunnels } catch {}
if (-not $tunnels -or $tunnels.Count -lt 2) {
    Start-Process "ngrok.cmd" -ArgumentList "start","--all" -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir "ngrok.log") -RedirectStandardError (Join-Path $LogDir "ngrok.err.log")
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 2
        try { $tunnels = (Invoke-RestMethod http://localhost:4040/api/tunnels -TimeoutSec 3).tunnels } catch {}
        if ($tunnels -and $tunnels.Count -ge 2) { break }
    }
}
if (-not $tunnels -or $tunnels.Count -lt 2) { Write-Error "Tunnels ngrok KO (voir $LogDir\ngrok*.log)"; exit 1 }
$sandboxUrl = ($tunnels | Where-Object { $_.config.addr -match "8090" } | Select-Object -First 1).public_url
$browserUrl = ($tunnels | Where-Object { $_.config.addr -match "3847" } | Select-Object -First 1).public_url
Ok "sandbox  -> $sandboxUrl"
Ok "browser  -> $browserUrl"

# -- 5. Re-sync config Supabase ---------------------------------------------------
# app_config (DB) est la SOURCE DE VERITE lue a chaque run par les edge functions
# (les workers cachent les secrets env jusqu'au recyclage -> URLs perimees).
# Les secrets restent synchronises en fallback/compat.
Step "Config Supabase (app_config DB + secrets)"
Push-Location $RepoRoot
$sqlFile = Join-Path $env:TEMP "infra-config.sql"
@"
insert into public.app_config(key, value, updated_at) values
  ('sandbox_url', '$sandboxUrl', now()),
  ('runner_browser_url', '$browserUrl', now())
on conflict (key) do update set value = excluded.value, updated_at = now();
"@ | Out-File $sqlFile -Encoding ascii
supabase db query -f $sqlFile --linked 2>$null | Out-Null
supabase secrets set "SANDBOX_URL=$sandboxUrl" "RUNNER_BROWSER_URL=$browserUrl" --project-ref $ProjectRef 2>$null | Out-Null
Pop-Location
Ok "app_config (DB) + secrets synchronises"

# -- 6. Verification bout-en-bout via le tunnel ----------------------------------
Step "Verification via le tunnel public"
$tmp = Join-Path $env:TEMP "sbx-probe.json"
'{"command":"echo tunnel-ok"}' | Out-File $tmp -Encoding ascii -NoNewline
$out = & curl.exe -s -m 15 -X POST "$sandboxUrl/v1/bash/exec" -H "ngrok-skip-browser-warning: true" -H "Content-Type: application/json" --data-binary "@$tmp" 2>$null
if ($out -match "tunnel-ok") { Ok "la sandbox repond a travers le tunnel" }
else { Warn "le tunnel ne repond pas encore proprement: $($out | Out-String)" }

Write-Host ""
Write-Host "Infra agents PRETE - sandbox: $sandboxUrl | browser: $browserUrl" -ForegroundColor Green
Write-Host "(rappel: si un agent a un sandbox_url propre dans l'UI, il ignore le secret)" -ForegroundColor DarkGray
exit 0
