# Demo GIF — **`@archrad/deterministic`** (npm README + OSS trust)

This doc covers GIFs shipped next to **`package.json`**: **npm** README, **GitHub** README, and **“one-command trust”** (tape → GIF). For **how** to record, see **[README_DEMO_RECORDING.md](./README_DEMO_RECORDING.md)**.

## README hero (IR gate — still the primary npm clip)

| Output file | Tape | What viewers see |
|-------------|------|------------------|
| **`demo-validate.gif`** | **`record-demo-validate.tape`** | **Failure first:** `validate` on **`fixtures/demo-direct-db-violation.json`** → **`IR-LINT-DIRECT-DB-ACCESS-002`** (red when stderr is a TTY) + **`IR-LINT-NO-HEALTHCHECK-003`** → comment → **`fixtures/demo-direct-db-layered.json`** → **clean** (no **IR-LINT-***). **No export** — gate on the blueprint. Stress-test many rules: **`fixtures/ecommerce-with-warnings.json`**. |

**Do not** overload the npm README with many GIFs unless total size stays small (&lt; ~3–5 MB each). Optional: **`demo.gif`** (**`record-demo.tape`**) — IR → project files in motion.

## Deterministic drift — **OSS trust tape** (repo-automated)

| Output file | Tape | What viewers see |
|-------------|------|------------------|
| **`demo-drift.gif`** | **`record-demo-drift.tape`** | **Export** → **`tail`** end of **`out/app/main.py`** (before) → **one-line tamper** → **`tail`** again (after, shows **`# Drift introduced`**) → **`validate-drift`** → **`DRIFT-MODIFIED`**. **`--skip-ir-lint`** keeps the clip about **drift**, not healthcheck lint on this fixture. Closing comment: **re-export** (or revert) realigns the tree. |

**One command (from `packages/deterministic`):** **`npm run record:demo:drift`** (requires **VHS** + **ffmpeg** + **ttyd** — see **[GIF_RECORDING_STEP_BY_STEP.md](./GIF_RECORDING_STEP_BY_STEP.md)**). **If VHS fails:** run **`scripts/run-demo-drift-sequence.sh`** (Git Bash) or **`scripts/run-demo-drift-sequence.ps1`** while capturing the terminal — see **[README_DEMO_RECORDING.md](./README_DEMO_RECORDING.md)** (**When VHS fails**).

### Trust loop (IDE + terminal) — convert skeptics

Terminal-only drift clips prove the **CLI**; they do not always prove **causality**. Viewers may think: *“A command failed — bug? typo? staged error?”* A **human-recorded** clip that shows **edit → save → drift** ties the failure to a **visible action** and reads as accountability, not theater.

**Narrative (four beats):**

| Beat | What the viewer sees | Why it lands |
|------|----------------------|--------------|
| **The crime** | **IDE** (VS Code / Cursor): open **`out/app/main.py`** from a real **`archrad export`** (e.g. **`fixtures/payment-retry-demo.json`**). **Change a concrete, meaningful line** — e.g. a **`max_attempts`** / retry-related value **`3` → `1`**, or delete a small retry helper block. Cursor on the line; change is obvious. | Triggers “you broke the contract” intuition. |
| **The evidence** | **Ctrl+S** (save). | Disk state is now wrong vs IR; no hand-waving. |
| **The trial** | **Terminal:** `archrad validate-drift -i … -t python -o ./out` (same flags you use in CI; **`--skip-host-port-check`** as needed). | Shows the tool is reading **files on disk**, not a script. |
| **The verdict** | Stderr shows **`DRIFT-MODIFIED`** (and the **path**, e.g. **`app/main.py`**). Red / ❌ visible. | Instant “aha”: the change they **just saw** is what the engine flags. |

**Full arc (what a “complete” GIF should show):** not only **failure**. Include **(1)** export + **first `validate-drift` = OK** (proves the gate is sane), **(2)** visible edit + save, **(3)** **`validate-drift` = DRIFT**, **(4)** revert file *or* re-export + **final `validate-drift` = OK** (proves recovery). Skipping (1) or (4) makes the clip look like a rigged error.

**How to frame (two layouts):**

- **Option A — Split screen (best ~30–45s video):** Left = IDE, right = terminal, **one fixed region** (ShareX “region”, OBS canvas, ScreenStudio). Edit on the left; error appears on the right **without** frantic tab switching — “god view.”
- **Option B — Quick-cut GIF:** (1) Terminal: export success. (2) Terminal: **`validate-drift`** → green / “no drift”. (3) Cut to IDE: edit + save. (4) Terminal: **`validate-drift`** → red. (5) Cut to IDE: undo/revert *or* skip to terminal re-export. (6) Terminal: **`validate-drift`** → green again.

**Tools:** **ShareX** (Windows, region → GIF), **ScreenStudio** (Mac), **OBS** + ffmpeg → GIF. This path is **not** VHS-automatable (real editor UI); keep **`record-demo-drift.tape`** as the **repo-reproducible** artifact; use the trust loop for **homepage, Reddit, investor deck**, or a second clip (**`demo-drift-trust-loop.gif`** — commit only if you ship it; not required for npm size).

**Windows — step-by-step PowerShell:** **[README_DEMO_RECORDING.md](./README_DEMO_RECORDING.md)** (**Walkthrough — Windows PowerShell** under *Trust loop drift*).

**Golden file for the retry story:** after **`export -i fixtures/payment-retry-demo.json`**, **`grep -n maxAttempts out/app/main.py`** (or search in IDE) to pick a line viewers can recognize.

## npm tarball checklist

- Put GIFs next to **`package.json`** so the README can use **`![…](demo-validate.gif)`** (relative URL; works on **npm** and **GitHub**).
- **`package.json` → `files`** includes **`demo-validate.gif`**, **`demo-drift.gif`**, etc., so published tarballs carry them when you **`npm publish`** (optional for **GitHub-only** OSS — commit the GIF either way).
- **Record from a clone** of this package (fixtures + `dist/` after **`npm run build`**). Recording from **`npx`** is possible if fixture paths exist in your env.

## Script beats — validate hero (recommended npm story)

1. Comment: enforcement on the **artifact** (not prose)
2. `node dist/cli.js validate -i fixtures/demo-direct-db-violation.json` — hold on **IR-LINT-DIRECT-DB-ACCESS-002**
3. Comment: fix the **graph** (service layer + health) — see **`demo-direct-db-layered.json`**
4. `node dist/cli.js validate -i fixtures/demo-direct-db-layered.json` — clean pass
5. Optional line: **`--fail-on-warning`** / **`--json`**

## Script beats — **validate-drift** (drift tape)

1. Comment: on-disk tree vs **fresh** export from the same IR
2. `npm run build && node dist/cli.js export … -o ./out --skip-host-port-check --skip-ir-lint`
3. `tail -n 10 ./out/app/main.py` — **before** (baseline tail of generated file)
4. Tamper: `echo '# Drift introduced' >> ./out/app/main.py`
5. `tail -n 12 ./out/app/main.py` — **after** (same region + new line visible)
6. `node dist/cli.js validate-drift … -o ./out --skip-host-port-check --skip-ir-lint` — **`DRIFT-MODIFIED`**
7. Comment: **re-export** or revert → **`validate-drift`** clean again

## Quality

- Font **16–18px**, width **~1200px** in the tape, trim **`Sleep`** so each GIF stays under a few MB.
- **Windows:** VHS needs **bash** (Git Bash / WSL).

## Not in scope here

Live investor demos, server API export, or Docker + **curl** — use **`docs/INVESTOR_DEMO.md`** / **`golden-path-demo`** scripts if you need that story elsewhere.

---

## Phase A — accurate IR → export + “regenerate matters”

| Piece | What we ship |
|--------|----------------|
| **Golden IR** | **`fixtures/payment-retry-demo.json`** — signup → payment, **`edge.config.retry`** + **`retryPolicy`** with **`maxAttempts: 3`** (matches **`pythonFastAPI`** / edge config, not a fictional `retry_count` field). |
| **CLI** | **`archrad export -i … -t python -o …`** (short flags **`-i` / `-t` / `-o`**). **`python`** emits **FastAPI**; there is no **`fastapi`** target. |
| **Recording** | **`record-demo-payment-retry.tape`** → **`demo-payment-retry.gif`** (optional). **`record-demo-drift.tape`** → **`demo-drift.gif`** — same golden IR; shows **validate-drift** after a deliberate file edit. |
| **Regression** | **`exportPipeline.test.ts`** asserts emitted **`app/main.py`** contains **`maxAttempts` 3** for the payment path; **`validate-drift.test.ts`** covers diff + **`runValidateDrift`**. |

### Phase B / C — status

**Canonical plan:** **`docs/PHASE_B_C_DRIFT_AND_OSS_REGEN.md`** (monorepo root).

| Phase | Shipped today | Still roadmap |
|--------|----------------|---------------|
| **C (OSS)** | **`archrad validate-drift`** — compare **`--out`** to a fresh export; **`record-demo-drift.tape`** reproduces **`demo-drift.gif`** | Deeper commands only if needed |
| **B (Cloud)** | Drift check API + builder **Artifacts** “Check drift”; **Re-sync** on Code | KPI strip, guided **SYNC** film, semantic / infra drift |

**Cloud complement:** OSS GIF = **the wall** (deterministic error). A separate **screen recording** (ScreenStudio, OBS, etc.) = **the door** (sync / repair in product).
