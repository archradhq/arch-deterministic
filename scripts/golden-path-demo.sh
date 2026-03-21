#!/usr/bin/env bash
# Commands for a ~60s golden-path demo (and README / HN GIF recording).
# Run from packages/deterministic after: npm run build

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="${1:-./golden-path-out}"
echo ">>> npm run build"
npm run build
echo ">>> rm -rf $OUT && archrad export"
rm -rf "$OUT"
node dist/cli.js export --ir fixtures/minimal-graph.json --target python --out "$OUT"

echo ""
echo "=== Next (terminal 1) — start the stack ==="
echo "  cd $(pwd)/$OUT && make run"
echo ""
echo "=== Next (terminal 2) — validation smoke ==="
echo "  curl -sS -X POST http://localhost:8080/signup -H 'Content-Type: application/json' -d '{}'"
echo ""
echo "Expect HTTP 422 or 400 with a structured error body (not 500)."
