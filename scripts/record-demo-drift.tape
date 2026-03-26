# OSS trust tape: export → tamper generated file → validate-drift catches DRIFT-MODIFIED.
# Same CLI as global `archrad` when linked; tape uses `node dist/cli.js` for clone-local reproducibility.
# Prereq: bash (Git Bash / WSL). From packages/deterministic:
#   npm run record:demo:drift
# or: npm run build && vhs scripts/record-demo-drift.tape
# If VHS/ttyd fails on your machine: run scripts/run-demo-drift-sequence.sh (Git Bash) or
#   scripts/run-demo-drift-sequence.ps1 while capturing the terminal (ShareX, OBS, etc.) — see README_DEMO_RECORDING.md

Output demo-drift.gif

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 720
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "clear" Enter
Type "rm -rf ./out" Enter
Show

Sleep 400ms
Type "# Deterministic drift: on-disk export vs fresh export from the same IR" Sleep 120ms Enter
Sleep 350ms
Type "npm run build && node dist/cli.js export -i fixtures/payment-retry-demo.json -t python -o ./out --skip-host-port-check --skip-ir-lint" Sleep 100ms Enter
Sleep 500ms
Sleep 4s

Type "# out/app/main.py — tail before tamper (generated, matches IR)" Sleep 120ms Enter
Sleep 300ms
Type "tail -n 10 ./out/app/main.py" Sleep 100ms Enter
Sleep 3s

Type "# Tamper: append one line (IR file on disk is unchanged)" Sleep 120ms Enter
Sleep 400ms
Type "echo '# Drift introduced' >> ./out/app/main.py" Sleep 100ms Enter
Sleep 2s

Type "# Same file — tail after (extra line is the only change)" Sleep 120ms Enter
Sleep 300ms
Type "tail -n 12 ./out/app/main.py" Sleep 100ms Enter
Sleep 3s

Type "node dist/cli.js validate-drift -i fixtures/payment-retry-demo.json -t python -o ./out --skip-host-port-check --skip-ir-lint" Sleep 100ms Enter
Sleep 500ms
Sleep 4s

Type "# Fix: re-export from IR (or revert the file) — then validate-drift is clean again" Sleep 100ms Enter
Sleep 2s
