# Phase A demo: golden payment + retry IR → FastAPI export → show emitted retry in main.py
# Requires bash (Git Bash / WSL). From packages/deterministic:
#   npm run build && vhs scripts/record-demo-payment-retry.tape
# Voiceover (not in tape): IR is source of truth; editing generated code diverges —
#   see record-demo-drift.tape → demo-drift.gif for validate-drift catching tampering.

Output demo-payment-retry.gif

Require echo

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "clear" Enter
Show

Sleep 500ms
Type "# Golden IR: fixtures/payment-retry-demo.json (edge retry + node retryPolicy)" Sleep 200ms Enter
Sleep 400ms
Type "npm run build && node dist/cli.js validate -i fixtures/payment-retry-demo.json" Sleep 100ms Enter
Sleep 3s

Type "node dist/cli.js export -i fixtures/payment-retry-demo.json -t python -o ./demo-payment-retry-out --skip-host-port-check" Sleep 100ms Enter
Sleep 200ms
Sleep 4s

Type "grep -n 'maxAttempts' demo-payment-retry-out/app/main.py | head -6" Sleep 100ms Enter
Sleep 3s

Type "# Voiceover: delete retry in generated code → IR still encodes 3; re-run export to restore" Sleep 100ms Enter
Sleep 2s
