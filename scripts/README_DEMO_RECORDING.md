# Recording the **npm README** demo GIF

**Scope:** the README for **`@archrad/deterministic`** on **npmjs.com** (package root **`README.md`**).  
**Storyboard:** [DEMO_GIF_STORYBOARD.md](./DEMO_GIF_STORYBOARD.md) — one recommended hero GIF.

## Recommended: `demo-validate.gif`

From **`packages/deterministic`**. The **`.tape`** files expect **bash** (Git Bash, WSL, or macOS/Linux). On **PowerShell alone**, `vhs` is not installed until you add it to `PATH` (see below).

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

```bash
npm run build
vhs scripts/record-demo-validate.tape
```

If `vhs` still says “not recognized”, run `where.exe vhs` or use the full path to `vhs.exe`. Easiest path on Windows is often **Git Bash** after install, since the tape uses `Set Shell "bash"`.

Writes **`demo-validate.gif`** next to **`package.json`**. Add to **`README.md`** (below the title block):

```markdown
![archrad validate — IR-STRUCT and IR-LINT findings](demo-validate.gif)
```

**`package.json` → `files`** already lists **`demo-validate.gif`** so it ships in the **npm tarball** once the file exists (commit the GIF or generate before publish).

Tweak **`Sleep`** in **`record-demo-validate.tape`** if the output scrolls too fast or slow. Target **&lt; ~3–5 MB** for npm/GitHub.

## Optional second GIF (`demo.gif`)

Export + listing generated files (no Docker in tape):

```bash
vhs scripts/record-demo.tape
```

Use only if you need a second motion graphic; prefer **one** GIF on npm.

---

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
node dist/cli.js validate --ir fixtures/ecommerce-with-warnings.json
```

**Bash / Git Bash:**

```bash
npm run build
node dist/cli.js validate --ir fixtures/ecommerce-with-warnings.json
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
