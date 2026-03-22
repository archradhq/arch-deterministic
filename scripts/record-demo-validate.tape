# Short GIF: archrad validate → IR-LINT / IR-STRUCT findings (no Docker).
# Prereq: npm run build (dist/ exists). From packages/deterministic:
#   vhs scripts/record-demo-validate.tape
# → demo-validate.gif next to package.json

Output demo-validate.gif
Require echo

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 700
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "clear" Enter
Show

Sleep 400ms
Type "# Validate your architecture before you write code (deterministic lint)" Sleep 150ms Enter
Sleep 400ms
Type "node dist/cli.js validate --ir fixtures/ecommerce-with-warnings.json" Sleep 100ms Enter
Sleep 5s

Type "# CI: --fail-on-warning  |  JSON: --json" Sleep 100ms Enter
Sleep 2s
