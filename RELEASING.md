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
2. **Version** — Bump in **`package.json`** (and lockfile if you commit it):

   ```bash
   npm version patch   # or minor / major
   ```

   Or edit `"version"` manually, then `npm install` to refresh lockfile if needed.

3. **Build & test**

   ```bash
   npm ci
   npm run build
   npm test
   ```

4. **Publish**

   ```bash
   npm publish --access public
   ```

   Dry run: `npm publish --dry-run`

5. **Git** — Tag matches npm (if you use `npm version`, it creates a git tag when run in a git repo):

   ```bash
   git push origin main --follow-tags
   ```

6. **GitHub** — Create a **Release** on [`archradhq/arch-deterministic`](https://github.com/archradhq/arch-deterministic) with release notes from `CHANGELOG.md`.

## Notes

- **`prepare`** runs **`npm run build`** on `npm install`; consumers get **`dist/`** from the published tarball (`files` field).
- Do **not** publish with secrets in the tree; `npm publish` respects **`files`** and `.gitignore` / `.npmignore`.
