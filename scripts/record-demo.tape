# Record a README GIF with VHS: https://github.com/charmbracelet/vhs
# Run from packages/deterministic (bash available): vhs scripts/record-demo.tape
# → writes demo.gif next to package.json (packages/deterministic)
# From monorepo root: cd packages/deterministic && vhs scripts/record-demo.tape

Output demo.gif
Require echo

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 600
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "clear" Enter
Show

Sleep 500ms
Type "# Build + export (golden path demo)" Sleep 200ms Enter
Sleep 300ms
Type "npm run build && node dist/cli.js export --ir fixtures/minimal-graph.json --target python --out ./demo-gif-out --skip-host-port-check" Sleep 100ms Enter
Sleep 4s

Type "ls demo-gif-out | head -8" Sleep 100ms Enter
Sleep 2s

Type "# Next: cd demo-gif-out && make run  (Docker)" Sleep 100ms Enter
Sleep 1s

Type "# Then: curl -X POST http://localhost:8080/signup -H 'Content-Type: application/json' -d '{}'" Sleep 100ms Enter
Sleep 2s
