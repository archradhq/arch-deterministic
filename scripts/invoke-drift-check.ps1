# Payment-retry fixture drift check (same flags as trust-loop docs).
# From packages/deterministic:
#   .\scripts\invoke-drift-check.ps1
# Or from anywhere:
#   powershell -ExecutionPolicy Bypass -File path\to\packages\deterministic\scripts\invoke-drift-check.ps1

$ErrorActionPreference = "Stop"
$pkgRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $pkgRoot

& node dist/cli.js validate-drift `
  -i fixtures/payment-retry-demo.json `
  -t python -o ./out `
  --skip-host-port-check --skip-ir-lint

exit $LASTEXITCODE
