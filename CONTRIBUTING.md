# Contributing

Development usually happens in the **private InkByte monorepo** under `packages/deterministic`, so the server and package stay in sync.

When you change this package, follow the product monorepo checklist: **`docs/MONOREPO_OSS_DETERMINISTIC_ALIGNMENT.md`** (and run **`npm run test:deterministic`** from the **InkByte repo root**).

If you clone **only** this repository (`archradhq/arch-deterministic`):

```bash
npm ci
npm run build   # required: there is no prepare script (see docs/ENGINEERING_NOTES.md)
npm test        # runs tsc --noEmit then vitest
```

PRs: keep changes **free of product-specific** imports (no Firestore, no `server/` paths). Apache-2.0 — see `LICENSE`.
