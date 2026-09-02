# Step-by-step: record `demo-validate.gif` (and use a branch, not `main`)

Use this when regenerating the **npm README** hero GIF from the built 0.7 release candidate: zero-setup **`archrad demo`** followed by a cited **`archrad scan`**. For install troubleshooting, see **[README_DEMO_RECORDING.md](./README_DEMO_RECORDING.md)**.

---

## Part A — Git: work on a branch

Do **not** commit the new GIF (or tape tweaks) straight to `main` until reviewed.

1. **Update local `main`** (from repo root `InkByte`):

   ```bash
   git fetch origin
   git checkout main
   git pull origin main
   ```

2. **Create a branch** (pick a name that matches your convention):

   ```bash
   git checkout -b chore/record-demo-validate-gif
   ```

3. **Do all recording, edits, and commits on this branch** (see Part C–D).

4. **Open a PR** into `main` when the GIF looks right and file size is acceptable (~3–5 MB for npm).

---

## Part B — One-time prerequisites

- **Node.js ≥ 20** (`node -v`).
- **This monorepo** cloned; you will run commands from **`packages/deterministic`**.
- **VHS** + **ffmpeg** + **ttyd** on your `PATH` (VHS drives a headless terminal). On Windows, run the release tape from PowerShell; it uses **`Set Shell "powershell"`**.

Install hints (Windows):

- `winget install charmbracelet.vhs`
- `winget install Gyan.FFmpeg`
- `winget install -e --id tsl0922.ttyd` (or Scoop: `scoop install ttyd`)

Verify:

```bash
vhs --version
ffmpeg -version
ttyd --version
```

---

## Part C — Build the release candidate, then record

All steps from **`packages/deterministic`**:

1. **Install deps** (if you have not already):

   ```bash
   cd packages/deterministic
   npm ci
   ```

2. **Build and verify the exact release candidate** that will be published:

   ```powershell
   npm run build
   node dist/cli.js --version
   ```

3. **Record the GIF** from PowerShell on Windows:

   ```powershell
   npm run record:demo:validate
   ```

   This writes **`demo-validate.gif`** next to **`package.json`** (`packages/deterministic/demo-validate.gif`).

4. **If output is too fast or slow**, edit **`scripts/record-demo-validate.tape`** **`Sleep`** durations (e.g. after each `Enter`), then run **`vhs`** again.

---

## Part D — Check, commit on your branch, PR

1. **Open the GIF** locally and confirm:
   - **`archrad demo`** shows deterministic architecture findings and the no-LLM/no-network statement.
   - **`archrad scan`** lists all six extractors, scans seven files, and writes a two-node/one-edge draft graph.
   - File size is reasonable for npm (~**&lt; 3–5 MB** if possible).

2. **Stage and commit** (still on your feature branch):

   ```bash
   git add packages/deterministic/demo-validate.gif
   # include any tape/README changes you made
   git status
   git commit -m "chore(deterministic): refresh 0.7 release demo GIF"
   ```

3. **Push the branch** and open a **PR to `main`**:

   ```bash
   git push -u origin chore/record-demo-validate-gif
   ```

4. After merge, **`package.json` → `files`** already includes **`demo-validate.gif`** so it ships in the **npm** tarball.

---

## Optional GIFs (same package, same branch if you like)

| Tape | Output |
|------|--------|
| **`scripts/record-demo.tape`** | **`demo.gif`** (minimal export + file list) |
| **`scripts/record-demo-payment-retry.tape`** | **`demo-payment-retry.gif`** |
| **`scripts/record-demo-drift.tape`** | **`demo-drift.gif`** (**`validate-drift`** trust tape) |
| **`scripts/record-demo-validate.tape`** | **`demo-validate.gif`** (README hero) |

---

## Quick reference — what the tape runs

1. `node dist/cli.js validate -i fixtures/demo-direct-db-violation.json`
2. Comment + `node dist/cli.js validate -i fixtures/demo-direct-db-layered.json`
3. Short comment about **`--fail-on-warning`** / **`--json`**

Fixtures live under **`packages/deterministic/fixtures/`**.
