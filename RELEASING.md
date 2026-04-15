# Releasing `@archrad/deterministic` on npm

## One-time setup

1. Create an npm account and enable **2FA** (recommended).
2. Create or claim the npm org/scope **`@archrad`** (or publish under your own scope and change `package.json` `name` — not covered here).
3. Log in locally:

   ```bash
   npm login
   npm whoami
   ```

4. First publish of a **scoped** public package must allow public access (already set via `publishConfig.access` in `package.json`, or pass **`--access public`** once).

## Each release

1. **Changelog** — Edit **`CHANGELOG.md`**: move `[Unreleased]` items under a new version section with date.
2. **OSS tier-1 docs** — If the release changes behavior, CLI/MCP surface, rule codes, or architecture, update **`docs/OSS_DESIGN.md`**, **`docs/OSS_ARCHITECTURE.md`**, and **`docs/OSS_FLOWS.md`** as needed; bump the **Doc revision** line in each; append a **`### [X.Y.Z]`** entry under **Release history** in **`docs/OSS_DOCUMENTATION_VERSIONING.md`** with **Added / Changed / Removed / Fixed** per doc. See **`docs/OSS_DOCUMENTATION_VERSIONING.md`** for the full checklist.
3. **Version** — Bump in **`package.json`** (and lockfile if you commit it):

   ```bash
   npm version patch   # or minor / major
   ```

   Or edit `"version"` manually, then `npm install` to refresh lockfile if needed.

4. **Build & test**

   ```bash
   npm ci
   npm run build
   npm test
   ```

5. **Publish**

   ```bash
   npm publish --access public
   ```

   Dry run: `npm publish --dry-run`

6. **Git** — Tag matches npm (if you use `npm version`, it creates a git tag when run in a git repo):

   ```bash
   git push origin main --follow-tags
   ```

7. **GitHub** — Create a **Release** on [`archradhq/arch-deterministic`](https://github.com/archradhq/arch-deterministic) with release notes from `CHANGELOG.md`.

## GitHub OSS mirror (`archradhq/arch-deterministic`)

The public repo is fed from this monorepo with **`git subtree split`** (only `packages/deterministic/` history — no monorepo secrets in those commits).

### From the next release onward: branch → PR → `main`

Do **not** push the split branch straight to **`main`** on `deterministic`. Instead:

1. After you have the release commit on **InkByte** `main`, create the split branch locally (from repo root):

   ```bash
   git fetch origin
   git subtree split --prefix=packages/deterministic -b oss-deterministic-release
   ```

2. Push it as a **feature branch** on the OSS remote (name it by version, e.g.):

   ```bash
   git push deterministic oss-deterministic-release:release/v0.1.7
   ```

3. On GitHub, open a **Pull Request** into **`main`** (`release/v0.1.7` → `main`), review, merge.

4. Tag **`v0.1.7`** (or whatever version) **on the merge commit** on `main` (or on the PR merge commit GitHub creates), then push the tag:

   ```bash
   git fetch deterministic
   git rev-parse deterministic/main   # use this SHA if tagging locally
   git tag -a v0.1.7 -m "@archrad/deterministic 0.1.7" <merge-commit-sha>
   git push deterministic v0.1.7
   ```

   Alternatively, create the tag in the GitHub UI after merge (**Releases → Draft → choose tag**).

5. Publish the **GitHub Release** from that tag (notes from `CHANGELOG.md`).

**Why:** Keeps **`main`** protected, reviewable, and aligned with normal OSS workflow; avoids force-push to `main` except when you intentionally choose to.

### Earlier releases (e.g. 0.1.6)

`main` may have been updated via direct `git push deterministic …:main --force-with-lease` from a split branch. That was a one-off to unblock the mirror; use the **branch + PR** flow above going forward.

## Notes

- **`prepare`** runs **`npm run build`** on `npm install`; consumers get **`dist/`** from the published tarball (`files` field).
- Do **not** publish with secrets in the tree; `npm publish` respects **`files`** and `.gitignore` / `.npmignore`.
