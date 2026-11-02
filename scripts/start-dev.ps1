# start-dev.ps1 (L1): starts the DEV Station from this checkout (office-agents): port 8792, instance dev, the mock
# provider, its own scratch data in this checkout's data\ (a fresh store on first start; never a copy of live data).
#   powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1          the engine on the dev scratch data
#   powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1 -Demo    demo mode instead (scripted day, data-demo\)
# Station and key variables inherited from the shell are not passed on (dev never reads a key). Runs in this window
# (Ctrl+C stops it). Your shell's own environment is restored when it exits.
param([switch]$Demo)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pattern = '^(STATION_|ANTHROPIC_|OPENROUTER_|OPENAI_)'
$saved = @{}
Get-ChildItem Env: | Where-Object { $_.Name -match $pattern } | ForEach-Object { $saved[$_.Name] = $_.Value }
try {
  foreach ($n in @($saved.Keys)) { Remove-Item "Env:$n" }
  $env:STATION_INSTANCE = 'dev'
  $env:STATION_PROVIDER = 'mock'
  Push-Location $root
  try {
    if ($Demo) { & node scripts/demo.mjs; $code = $LASTEXITCODE }
    else {
      $env:STATION_PORT = '8792'
      $env:STATION_DATA_ROOT = Join-Path $root 'data'
      & node scripts/start.mjs; $code = $LASTEXITCODE
    }
  } finally { Pop-Location }
} finally {
  Get-ChildItem Env: | Where-Object { $_.Name -match $pattern } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
  foreach ($n in $saved.Keys) { Set-Item "Env:$n" $saved[$n] }
}
exit $code
