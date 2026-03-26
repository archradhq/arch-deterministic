# Hero README GIF: failure-first validate loop (IR gate before codegen).
# IR-LINT-DIRECT-DB-ACCESS-002 on violation → same intent, layered graph → clean validate.
# Prereq: npm run build. From packages/deterministic (bash):
#   vhs scripts/record-demo-validate.tape
# → demo-validate.gif (stderr uses red IR-LINT lines when TTY — VHS/ttyd is TTY)

Output demo-validate.gif
Require echo

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 720
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "clear" Enter
Show

Sleep 350ms
Type "# Validate the blueprint IR — enforcement on the artifact (not on prose)" Sleep 120ms Enter
Sleep 350ms
Type "node dist/cli.js validate -i fixtures/demo-direct-db-violation.json" Sleep 100ms Enter
Sleep 5s

Type "# Fix the graph: service between API and DB + /health (see demo-direct-db-layered.json)" Sleep 100ms Enter
Sleep 2s

Type "node dist/cli.js validate -i fixtures/demo-direct-db-layered.json" Sleep 100ms Enter
Sleep 4s

Type "# CI: archrad validate --fail-on-warning  |  JSON: --json" Sleep 100ms Enter
Sleep 2s
