# Recording a terminal GIF for the README

Goal: show **`archrad export`** → **`cd out && make run`** → **`curl`** → **422/400** on `/signup`.

## 1. One-shot command list (manual recording)

From **`packages/deterministic`**:

```bash
npm run build
node dist/cli.js export --ir fixtures/minimal-graph.json --target python --out ./out
cd ./out
make run
```

New terminal (wait until the API listens on **8080**):

```bash
curl -sS -w "\nHTTP %{http_code}\n" -X POST http://localhost:8080/signup \
  -H "Content-Type: application/json" -d '{}'
```

Or run **`bash scripts/golden-path-demo.sh`** / **`pwsh -File scripts/golden-path-demo.ps1`** for the export step + printed reminders.

## 2. Tools

| Tool | Notes |
|------|--------|
| **[VHS](https://github.com/charmbracelet/vhs)** | `.tape` file → GIF/MP4; great for repeatable README assets. |
| **[asciinema](https://asciinema.org/)** + **[agg](https://github.com/asciinema/agg)** | Terminal recording → GIF. |
| **ttygif** / **terminalizer** | Alternatives for cast → GIF. |

## 3. Tips

- Terminal width ~100–120 cols, large font, light or dark theme consistent with your brand.
- Trim idle time; speed up Docker pull if the GIF is long (or pre-pull images).
- Place the GIF near the top of **`README.md`** with alt text, e.g. `![60s golden path: export, docker, curl validation](docs/demo.gif)` (add `docs/demo.gif` when ready).

## 4. CI

Do not commit huge GIFs if the org prefers LFS; GitHub README images are usually fine under a few MB.
