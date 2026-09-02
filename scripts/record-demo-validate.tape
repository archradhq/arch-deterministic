# Hero README GIF for the 0.7.2 release.
# Uses the built release candidate so the recording can be made before npm publish.
# Build, then record from packages/deterministic (PowerShell on Windows):
#   npm run build
#   vhs scripts/record-demo-validate.tape
# -> demo-validate.gif

Output demo-validate.gif

Set Shell "powershell"
Set FontSize 15
Set Width 1200
Set Height 760
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 18ms

Hide
Type "function global:archrad { node ./dist/cli.js @args }" Enter
Type "Clear-Host" Enter
Show

Sleep 350ms
Type "# @archrad/deterministic 0.7.2 release candidate - no account, no LLM" Enter
Sleep 400ms
Type "archrad --version" Enter
Sleep 800ms
Type "archrad demo" Enter
Sleep 8s

Type "# Scan a repository - merge Compose, OpenAPI, manifests, and code evidence" Enter
Sleep 500ms
Type "archrad scan fixtures/export-golden-node-compose-demo --out $env:TEMP/archrad-v072-demo.json --verbose" Enter
Sleep 6s

Type "# Draft IR ready: every inferred component is cited to file:line + confidence" Enter
Sleep 3s
