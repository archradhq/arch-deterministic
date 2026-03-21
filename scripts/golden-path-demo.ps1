# Golden-path demo commands (README / GIF). Run from packages/deterministic.
param([string] $OutDir = "golden-path-out")

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

Write-Host ">>> npm run build"
npm run build

$out = Join-Path $Root $OutDir
if (Test-Path $out) { Remove-Item -Recurse -Force $out }

Write-Host ">>> archrad export -> $OutDir"
node dist/cli.js export --ir fixtures/minimal-graph.json --target python --out $out

Write-Host ""
Write-Host "=== Next (terminal 1) ==="
Write-Host "  cd $out"
Write-Host "  make run"
Write-Host ""
Write-Host "=== Next (terminal 2) ==="
Write-Host "  curl -sS -X POST http://localhost:8080/signup -H `"Content-Type: application/json`" -d '{}'"
Write-Host ""
Write-Host "Expect HTTP 422 or 400 with a structured error body."
