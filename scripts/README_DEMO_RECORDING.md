# Recording the **npm README** demo GIF

**Scope:** the README for **`@archrad/deterministic`** on **npmjs.com** (package root **`README.md`**).  
**Storyboard:** [DEMO_GIF_STORYBOARD.md](./DEMO_GIF_STORYBOARD.md) — one recommended hero GIF.  
**Step-by-step (Git branch + VHS + commit):** [GIF_RECORDING_STEP_BY_STEP.md](./GIF_RECORDING_STEP_BY_STEP.md).

## Recommended: `demo-validate.gif`

**Story:** run the built **`@archrad/deterministic@0.7.2`** release candidate. **`archrad demo`** proves the zero-setup deterministic gate; **`archrad scan`** then processes a repository fixture and writes cited draft IR using the six 0.7 extractors.

Run from **`packages/deterministic`**. **`record-demo-validate.tape`** explicitly uses PowerShell on Windows. The other export/drift tapes still use bash (Git Bash, WSL, or macOS/Linux).

### When VHS fails

VHS shells out to **`ttyd`** + **`ffmpeg`**; installs differ, and some environments block or hang headless terminals.

| Symptom | Things to try |
|--------|----------------|
| **`echo`: executable file not found** | VHS **`Require echo`** checks a real `echo` binary. Our **`record-demo-drift.tape`** omits it; for other tapes, delete the **`Require echo`** line or run VHS from **Git Bash** where **`echo`** exists. |
| **`ttyd` / `ffmpeg` not found** | Install both, **restart the terminal**, confirm **`ttyd --version`** and **`ffmpeg -version`**. |
| **Black screen, hang, or instant failure** | Update VHS; use PowerShell for the release tape or Git Bash for the bash tapes; temporarily reduce **`Set Width` / `Set Height`** in the `.tape`. |
| **You want to skip VHS entirely** | Use the **same command sequence** as the tape while screen-recording (see below). |

**Drift GIF without VHS:** from **`packages/deterministic`**, start **ShareX** (GIF) / **OBS** / **ScreenToGif**, then run one of:

```bash
# Git Bash / WSL / macOS / Linux
bash scripts/run-demo-drift-sequence.sh
# Optional slower pacing: DEMO_DRIFT_PAUSE=4 bash scripts/run-demo-drift-sequence.sh
```

```powershell
# Windows PowerShell (from packages/deterministic)
powershell -ExecutionPolicy Bypass -File scripts/run-demo-drift-sequence.ps1
```

Trim the recording and export to GIF (ShareX can save directly to GIF; otherwise **`ffmpeg`** as in [Manual recording (no VHS)](#manual-recording-no-vhs) below). The **`.tape`** file remains the spec; the scripts are the **portable replay** for capture tools.

**asciinema** (terminal cast, then GIF with **[agg](https://github.com/asciinema/agg)**): `asciinema rec demo.cast`, run the same commands (or `bash scripts/run-demo-drift-sequence.sh` inside the session), then `agg demo.cast demo-drift.gif`.

### Install VHS on Windows

[VHS](https://github.com/charmbracelet/vhs) needs **`ffmpeg`** and **`ttyd`** on your `PATH`.

- **`ffmpeg is not installed`** → install ffmpeg (e.g. `winget install Gyan.FFmpeg`), restart terminal, `ffmpeg -version`.
- **`ttyd is not installed`** → `winget install -e --id tsl0922.ttyd` or `scoop install ttyd`, restart terminal, `ttyd --version`.

Typical paths:

1. **winget** (run in **elevated** PowerShell if prompted):
   ```powershell
   winget install charmbracelet.vhs
   winget install Gyan.FFmpeg
   winget install -e --id tsl0922.ttyd
   ```
   If **winget** has no **ttyd** package on your machine, use [ttyd releases](https://github.com/tsl0922/ttyd/releases) or **Scoop**: `scoop install ttyd`.

2. **Scoop** (user install):
   ```powershell
   scoop install vhs ffmpeg ttyd
   ```

3. **Go** (puts `vhs.exe` in `%USERPROFILE%\go\bin` — add that folder to PATH):
   ```powershell
   go install github.com/charmbracelet/vhs@latest
   ```

Close and reopen the terminal, then:

```powershell
npm run build
node dist/cli.js --version
npm run record:demo:validate
```

If `vhs` still says “not recognized,” run `where.exe vhs` or use the full path to `vhs.exe`.

Writes **`demo-validate.gif`** next to **`package.json`**. Add to **`README.md`** (below the title block):

```markdown
![ArchRAD 0.7.2 running the zero-setup deterministic demo and scanning a repository into cited draft IR](demo-validate.gif)
```

**`package.json` → `files`** already lists **`demo-validate.gif`** so it ships in the **npm tarball** once the file exists (commit the GIF or generate before publish).

Tweak **`Sleep`** in **`record-demo-validate.tape`** if the output scrolls too fast or slow. Target **&lt; ~3–5 MB** for npm/GitHub.

## Optional second GIF (`demo.gif`)

Export + listing generated files (no Docker in tape):

```bash
vhs scripts/record-demo.tape
```

Use only if you need a second motion graphic; prefer **one** GIF on npm.

## Phase A — payment + retry → FastAPI (`demo-payment-retry.gif`)

Golden fixture **`fixtures/payment-retry-demo.json`**, validate + export + **`grep`** on **`app/main.py`** for **`maxAttempts`**. Storyboard: **`DEMO_GIF_STORYBOARD.md`** (Phase A). From **`packages/deterministic`** (bash):

```bash
npm run build
vhs scripts/record-demo-payment-retry.tape
```

Writes **`demo-payment-retry.gif`** next to **`package.json`**. Not included in the default npm README hero slot unless you choose to ship it (watch tarball size).

## Deterministic drift (`demo-drift.gif`)

**`validate-drift`** after a deliberate edit to **`./out/app/main.py`** — see **`DEMO_GIF_STORYBOARD.md`**.

**Automated (VHS):** from **`packages/deterministic`**:

```bash
npm run record:demo:drift
```

**Manual capture (no VHS):** **`scripts/run-demo-drift-sequence.sh`** or **`scripts/run-demo-drift-sequence.ps1`** — see [When VHS fails](#when-vhs-fails) above.

Writes **`demo-drift.gif`** next to **`package.json`** when you export from your recorder. **`package.json` → `files`** includes **`demo-drift.gif`** when you publish.

---

## Trust loop drift (IDE + terminal)

For **skeptic-grade** drift marketing, show **edit → save → drift**, *and* bookend with **green** **`validate-drift`** before and after so it is not “only a failure.” Storyboard: **[DEMO_GIF_STORYBOARD.md](./DEMO_GIF_STORYBOARD.md)** (**Trust loop**). Tools: **ShareX**, **ScreenStudio**, **OBS**.

### Complete GIF — step by step (baseline OK → break → fail → fix → OK again)

Use **`packages/deterministic`**. Replace **`C:\scm\InkByte`** with your path.

**Drift check — pick one (avoids “Invoke-DriftCheck not recognized”):**

1. **Script (works in every new terminal)** — from **`packages/deterministic`**:

   ```powershell
   .\scripts\invoke-drift-check.ps1
   ```

2. **One-liner (paste anytime, same folder):**

   ```powershell
   node dist/cli.js validate-drift -i fixtures/payment-retry-demo.json -t python -o ./out --skip-host-port-check --skip-ir-lint
   ```

3. **Function (only in the same PowerShell session where you defined it):** if you use **`Invoke-DriftCheck`**, you must paste the **`function Invoke-DriftCheck { ... }`** block **in that same window** before calling it; **new tabs** do not keep the function.

**Before you record — rehearsal (optional):** run steps 1–4 once without ShareX so timings feel natural.

---

**Step 1 — Install / configure capture**  
- **ShareX:** **Task settings → Capture → Screen recording → GIF**; assign **record region** hotkey.  
- Or **OBS** / **Game Bar** → MP4 → **`ffmpeg`** (see [Manual recording](#manual-recording-no-vhs)).

**Step 2 — Layout**  
IDE (**VS Code** / **Cursor**) + **Windows Terminal** (PowerShell) visible together (**split screen** = one ShareX region covers both).

**Pasting commands (read this)**  
If you copy several lines and they end up **on one line** (e.g. `...deterministicnpm run build...` or `SilentlyContinuenode dist...`), PowerShell breaks and you may see **`Set-Location : Parameter name 'i' is ambiguous`** — the shell is no longer running **`node dist/cli.js export -i ...`** as intended. **Fix:** press **Enter after each line**, or paste the **single-line** version below (semicolons separate statements).

**Step 3 — Prep export (off-camera or start of clip)**  

Run **one line at a time**, or use this **paste-safe one-liner** (change the path if needed):

```powershell
Set-Location C:\scm\InkByte\packages\deterministic; npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; Remove-Item -Recurse -Force .\out -ErrorAction SilentlyContinue; node dist/cli.js export -i fixtures/payment-retry-demo.json -t python -o ./out --skip-host-port-check --skip-ir-lint
```

Multi-line (only if each line executes separately):

```powershell
Set-Location C:\scm\InkByte\packages\deterministic
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Remove-Item -Recurse -Force .\out -ErrorAction SilentlyContinue
node dist/cli.js export -i fixtures/payment-retry-demo.json -t python -o ./out --skip-host-port-check --skip-ir-lint
```

**Step 4 — Find the line you will edit (rehearsal)**  

```powershell
Select-String -Path .\out\app\main.py -Pattern "maxAttempts|max_attempts|retry" | Select-Object -First 10 LineNumber, Line
```

Pick one line (e.g. **`max_attempts`** / retry **`3`** → you will temporarily change to **`1`**).

**Step 5 — Start recording**  
ShareX **region** around IDE + terminal (or full screen for quick-cut editing later).

**Step 6 — Act A: export success (terminal)**  
If you did not show export in step 3 on camera, run the **`export`** block from step 3 now. Pause ~2s on **`archrad: wrote … files`** / success text.

**Step 7 — Act B: baseline drift check = success**  

```powershell
.\scripts\invoke-drift-check.ps1
```

(or the **one-liner** under *Drift check — pick one* above.)

**Expect:** exit code **0** and a line like **`no deterministic drift`**. This proves the tool **passes** when disk matches IR. Hold ~2–3s on screen.

**Step 8 — Act C: open editor**  

```powershell
code .\out\app\main.py
```

(or open the file manually). Scroll so the target line is visible.

**Step 9 — Act D: the edit + save**  
Change the value (e.g. **`3` → `1`**) or another obvious edit on that line → **Ctrl+S**. Pause ~1s.

**Step 10 — Act E: drift check = failure**  

```powershell
.\scripts\invoke-drift-check.ps1
```

**Expect:** **`DRIFT-MODIFIED`** / **`app/main.py`**, non-zero exit. Hold ~3s so viewers read it.

**Step 11 — Act F: fix (pick one)**

- **F1 — Undo in editor (best for “same tree” story):** **Ctrl+Z** until the line matches the export again → **Ctrl+S**.  
- **F2 — Re-export (regenerate story):** in terminal (one line, paste-safe):

```powershell
Remove-Item -Recurse -Force .\out -ErrorAction SilentlyContinue; node dist/cli.js export -i fixtures/payment-retry-demo.json -t python -o ./out --skip-host-port-check --skip-ir-lint
```

If you used **F2**, optionally show **IDE** refreshing **`main.py`** (reload from disk) so the number is **3** again.

**Step 12 — Act G: drift check = success again**  

```powershell
.\scripts\invoke-drift-check.ps1
```

**Expect:** exit **0**, **`no deterministic drift`** again. Hold ~2–3s — this is the **success case** that closes the loop.

**Step 13 — Stop recording**  
Trim dead air at start/end; if the GIF is huge, lower fps or shorten pauses in ShareX/ffmpeg. Save as **`demo-drift-trust-loop-full.gif`** (or your name).

**Step 14 — Sanity check**  
Watch once: **green → edit → red → fix → green**. If **red** never appears, the edit did not change bytes the export cares about; pick another line or use **`echo '# x' >> .\out\app\main.py`** only for the break (less “architectural” but still valid **DRIFT-MODIFIED**).

---

**Notes:** Substitute **`archrad`** for **`node dist/cli.js`** if the CLI is on **`PATH`**. Do not set **`NO_COLOR`** if you want red stderr. Terminal-only variant (no IDE): run **step 3**, then **7**, append a line with **`Add-Content`**, **10**, delete **`out`** and **export** again, **12** — still a full arc, weaker causality; see **`scripts/run-demo-drift-sequence.ps1`** for a partial terminal-only path (extend locally with a final **`validate-drift`** after you revert).

## Manual recording (no VHS)

Works in **PowerShell** — no `vhs` required. Run the command, then capture the terminal:

| Tool | Notes |
|------|--------|
| **ShareX** (free) | [getsharex.com](https://getsharex.com/) — can record **directly to GIF**. |
| **Xbox Game Bar** | `Win+G` → record → **MP4**; convert with **ffmpeg** (see below). |
| **Snipping Tool** (Win11) | **Record** if available → video → ffmpeg → GIF. |
| **ScreenToGif** | Optional; not required. |

**MP4 → GIF** (after Game Bar / OBS; requires **ffmpeg** on PATH):

```powershell
ffmpeg -i recording.mp4 -vf "fps=10,scale=800:-1:flags=lanczos" -loop 0 demo-validate.gif
```

**PowerShell:**

```powershell
cd C:\path\to\packages\deterministic
npm run build
node dist/cli.js validate -i fixtures/demo-direct-db-violation.json
node dist/cli.js validate -i fixtures/demo-direct-db-layered.json
```

**Bash / Git Bash:**

```bash
npm run build
node dist/cli.js validate -i fixtures/demo-direct-db-violation.json
node dist/cli.js validate -i fixtures/demo-direct-db-layered.json
```

---

## Full golden path (not for npm README hero)

**`archrad export`** → **`make run`** → **`curl`** → **422** on **`/signup`** — good for docs or video; Docker makes README GIFs long. Commands:

```bash
npm run build
node dist/cli.js export --ir fixtures/minimal-graph.json --target python --out ./out
cd ./out && make run
```

```bash
curl -sS -w "\nHTTP %{http_code}\n" -X POST http://localhost:8080/signup \
  -H "Content-Type: application/json" -d '{}'
```

Or **`bash scripts/golden-path-demo.sh`** / **`pwsh -File scripts/golden-path-demo.ps1`** for export + reminders.

## Other tools

| Tool | Notes |
|------|-------|
| **[VHS](https://github.com/charmbracelet/vhs)** | `.tape` → GIF; **`record-demo-validate.tape`**, **`record-demo.tape`**. |
| **[asciinema](https://asciinema.org/)** + **[agg](https://github.com/asciinema/agg)** | Terminal → GIF. |

## CI / repo size

Avoid multi‑MB GIFs without **Git LFS** if your policy requires it; npm and GitHub READMEs are usually fine under a few MB.
