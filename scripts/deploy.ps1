# FounderOS — Supabase deploy script
# Usage:
#   $env:SUPABASE_ACCESS_TOKEN = "sbp_xxx"
#   $env:SUPABASE_DB_PASSWORD  = "your-db-password"
#   ./scripts/deploy.ps1

$ErrorActionPreference = "Stop"

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  Write-Error "SUPABASE_ACCESS_TOKEN env var required (generate at https://supabase.com/dashboard/account/tokens)"
}
if (-not $env:SUPABASE_DB_PASSWORD) {
  Write-Error "SUPABASE_DB_PASSWORD env var required (Project Settings -> Database)"
}

$projectRef = "scugmxahflsjabglodyv"

Write-Host "==> Linking project $projectRef"
supabase link --project-ref $projectRef --password $env:SUPABASE_DB_PASSWORD

Write-Host "==> Pushing database migrations"
supabase db push --password $env:SUPABASE_DB_PASSWORD

Write-Host "==> Setting Edge Function secrets"
# Pre-generated 32-byte base64 AES-GCM key. Rotate with `supabase secrets set CREDENTIAL_ENCRYPTION_KEY=...`
# For security we do NOT use a hardcoded fallback key. Fail fast if missing.
if (-not $env:CREDENTIAL_ENCRYPTION_KEY) {
  Write-Error "CREDENTIAL_ENCRYPTION_KEY env var required and not set. Refuse to continue."
  exit 1
}
supabase secrets set CREDENTIAL_ENCRYPTION_KEY=$env:CREDENTIAL_ENCRYPTION_KEY

Write-Host "==> Deploying Edge Functions (--no-verify-jwt)"
supabase functions deploy connect-github     --no-verify-jwt
supabase functions deploy github-list-repos  --no-verify-jwt
supabase functions deploy start-repo-scan    --no-verify-jwt
supabase functions deploy process-repo-scan  --no-verify-jwt

Write-Host "==> Done. Edge function base URL:"
Write-Host "    https://$projectRef.supabase.co/functions/v1/<name>"
