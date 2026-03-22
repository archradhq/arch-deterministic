# Demo GIF — **npm README only** (`@archrad/deterministic`)

This doc is for the **README shown on npmjs.com** (same as repo **`README.md`** at package root). For **how** to record, see **[README_DEMO_RECORDING.md](./README_DEMO_RECORDING.md)**.

## One GIF to ship

| Output file | Tape | What viewers see |
|-------------|------|------------------|
| **`demo-validate.gif`** | **`record-demo-validate.tape`** | `archrad validate` on **`fixtures/ecommerce-with-warnings.json`** → **IR-STRUCT-*** + **IR-LINT-*** (matches the tagline *Validate your architecture before you write code*). No Docker — short and readable. |

**Do not** overload the npm README with a second GIF unless you keep total size small (&lt; ~3–5 MB). Optional second: **`demo.gif`** via **`record-demo.tape`** (export + file list) — only if you need “IR → project files” in motion.

## npm tarball checklist

- Put **`demo-validate.gif`** next to **`package.json`** so the README can use **`![…](demo-validate.gif)`** (relative URL; works on **npm** and **GitHub**).
- Ensure **`files`** in **`package.json`** includes the GIF if you use a whitelist (many packages use `"files": ["dist", ...]` — add **`demo-validate.gif`** or a glob so the image is **in the published tarball**).
- **Record from a clone** of this package (fixtures + `dist/` after **`npm run build`**). Recording from **`npx`** install is possible if you copy a fixture path that exists in your env.

## Script beats (the one we recommend)

1. Comment: *Validate your architecture before you write code (deterministic lint)*
2. `node dist/cli.js validate --ir fixtures/ecommerce-with-warnings.json`
3. Hold on output long enough to read one code + **Fix:**

## Quality

- Font **16–18px**, width **~1200px** in the tape, trim **Sleep** so the GIF stays under a few MB.
- **Windows:** VHS needs **bash** (Git Bash / WSL).

## Not in scope here

Live investor demos, server API export, or Docker + **curl** — use **`docs/INVESTOR_DEMO.md`** / **`golden-path-demo`** scripts if you need that story elsewhere.
