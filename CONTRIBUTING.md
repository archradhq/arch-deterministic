# Contributing

Development usually happens in the **private InkByte monorepo** under `packages/deterministic`, so the server and package stay in sync.

If you clone **only** this repository (`archradhq/arch-deterministic`):

```bash
npm ci
npm run build
npm test
```

PRs: keep changes **free of product-specific** imports (no Firestore, no `server/` paths). Apache-2.0 — see `LICENSE`.
