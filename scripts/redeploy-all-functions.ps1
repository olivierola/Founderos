# Redeploy ALL edge functions to the FounderOs project.
# Usage:
#   $env:SUPABASE_ACCESS_TOKEN = "sbp_xxx"   # optional if CLI already logged in
#   ./scripts/redeploy-all-functions.ps1
#
# Deploys every function under supabase/functions/ (skipping _shared), one at a
# time, logging success/failure and exiting non-zero if any deploy failed.

$ErrorActionPreference = "Stop"

$projectRef = "scugmxahflsjabglodyv"

$funcDir = Join-Path $PSScriptRoot "..\supabase\functions"
if (-not (Test-Path $funcDir)) {
  Write-Error "functions dir not found: $funcDir"
}

# If the CLI is not already authenticated, require the env token.
if (-not $env:SUPABASE_ACCESS_TOKEN) {
  Write-Host "SUPABASE_ACCESS_TOKEN not set - relying on existing CLI login. Set it if deploy fails with auth errors."
}

$functions = Get-ChildItem -Directory $funcDir | Where-Object { $_.Name -ne "_shared" } | Sort-Object Name
Write-Host "==> Deploying $($functions.Count) edge functions to $projectRef"

$failures = @()
$start = Get-Date

foreach ($fn in $functions) {
  $name = $fn.Name
  Write-Host ""
  Write-Host "==> [$name] deploying..."
  supabase functions deploy $name --project-ref $projectRef --no-verify-jwt 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Host "    [$name] OK"
  } else {
    Write-Host "    [$name] FAILED (exit $LASTEXITCODE)"
    $failures += $name
  }
}

$elapsed = ((Get-Date) - $start).ToString("hh\:mm\:ss")
Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host "==> DEPLOY FINISHED WITH FAILURES ($elapsed): $($failures -join ', ')"
  exit 1
} else {
  Write-Host "==> ALL $($functions.Count) FUNCTIONS DEPLOYED OK in $elapsed"
  Write-Host "    Base URL: https://$projectRef.supabase.co/functions/v1/<name>"
}
