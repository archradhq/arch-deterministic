# Replay the same steps as record-demo-drift.tape - use while recording with ShareX, OBS, ScreenToGif, etc.
# (No VHS/ttyd.) From packages/deterministic:
#   powershell -ExecutionPolicy Bypass -File scripts/run-demo-drift-sequence.ps1
#   (or pwsh on PowerShell 7+)
# Optional: $env:DEMO_DRIFT_PAUSE = "3"

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

$pauseSec = 2
if ($env:DEMO_DRIFT_PAUSE -match '^\d+$') { $pauseSec = [int]$env:DEMO_DRIFT_PAUSE }

if (Test-Path "./out") { Remove-Item -Recurse -Force "./out" }

Write-Host "# Deterministic drift: on-disk export vs fresh export from the same IR"
Start-Sleep -Seconds $pauseSec

npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

node dist/cli.js export -i fixtures/payment-retry-demo.json -t python -o ./out --skip-host-port-check --skip-ir-lint
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Start-Sleep -Seconds $pauseSec

Write-Host "# out/app/main.py - tail before tamper (generated, matches IR)"
Get-Content ./out/app/main.py -Tail 10
Start-Sleep -Seconds $pauseSec

Write-Host "# Tamper: append one line (IR JSON is unchanged)"
Start-Sleep -Seconds 1
Add-Content -Path "./out/app/main.py" -Value "`n# Drift introduced`n" -Encoding utf8

Write-Host "# Same file - tail after (extra line is the only change)"
Get-Content ./out/app/main.py -Tail 12
Start-Sleep -Seconds $pauseSec

node dist/cli.js validate-drift -i fixtures/payment-retry-demo.json -t python -o ./out --skip-host-port-check --skip-ir-lint
# Expected: exit code 1 when drift is detected; continue script for closing caption
$null = $LASTEXITCODE

Start-Sleep -Seconds $pauseSec

Write-Host "# Fix: re-export from IR (or revert the file) - then validate-drift is clean again"
