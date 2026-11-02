# start-live.ps1 (L1): starts the LIVE Station from this checkout, which must be the live worktree
# (..\office-agents-live, branch live, no uncommitted changes to tracked files; npm start checks all three).
# Port 8790, instance live, data in this checkout's data\. The provider and the keys come from this checkout's .env only
# (the owner's, made from .env.live.example): Station and key variables inherited from the shell are not passed on.
# Runs in this window (Ctrl+C stops it cleanly). Your shell's own environment is restored when it exits.
#   powershell -ExecutionPolicy Bypass -File scripts\start-live.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pattern = '^(STATION_|ANTHROPIC_|OPENROUTER_|OPENAI_)'
$saved = @{}
Get-ChildItem Env: | Where-Object { $_.Name -match $pattern } | ForEach-Object { $saved[$_.Name] = $_.Value }
try {
  foreach ($n in @($saved.Keys)) { Remove-Item "Env:$n" }
  $env:STATION_INSTANCE = 'live'
  $env:STATION_PORT = '8790'
  $env:STATION_DATA_ROOT = Join-Path $root 'data'
  Push-Location $root
  try { & node scripts/start.mjs; $code = $LASTEXITCODE } finally { Pop-Location }
} finally {
  Get-ChildItem Env: | Where-Object { $_.Name -match $pattern } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
  foreach ($n in $saved.Keys) { Set-Item "Env:$n" $saved[$n] }
}
exit $code
