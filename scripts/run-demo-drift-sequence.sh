#!/usr/bin/env bash
# Replay the same steps as record-demo-drift.tape — use while recording with ShareX, OBS, etc.
# (No VHS/ttyd.) From repo root of this package:
#   bash scripts/run-demo-drift-sequence.sh
# Optional: DEMO_DRIFT_PAUSE=3 bash scripts/run-demo-drift-sequence.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PAUSE="${DEMO_DRIFT_PAUSE:-2}"

rm -rf ./out

echo "# Deterministic drift: on-disk export vs fresh export from the same IR"
sleep "$PAUSE"

npm run build
node dist/cli.js export -i fixtures/payment-retry-demo.json -t python -o ./out --skip-host-port-check --skip-ir-lint

sleep "$PAUSE"

echo "# out/app/main.py — tail before tamper (generated, matches IR)"
tail -n 10 ./out/app/main.py
sleep "$PAUSE"

echo "# Tamper: append one line (IR JSON is unchanged)"
sleep 1
echo '# Drift introduced' >> ./out/app/main.py

echo "# Same file — tail after (extra line is the only change)"
tail -n 12 ./out/app/main.py
sleep "$PAUSE"

set +e
node dist/cli.js validate-drift -i fixtures/payment-retry-demo.json -t python -o ./out --skip-host-port-check --skip-ir-lint
set -e

sleep "$PAUSE"

echo "# Fix: re-export from IR (or revert the file) — then validate-drift is clean again"
