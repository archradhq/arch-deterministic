# Engineering notes (audit responses & tradeoffs)

Internal reference for **quality posture** and known limits of `@archrad/deterministic`.

## TypeScript

- **`strict`: true** — enabled in `tsconfig.json` (with `noUnusedLocals` / `noUnusedParameters`). `tsconfig.build.json` extends it; **`npm test`** runs **`tsc -p tsconfig.build.json --noEmit`** before Vitest.
- **`skipLibCheck`: true** — keeps builds fast; dependency `.d.ts` issues are not typechecked. Acceptable while `strict` is on for first-party code.

## Linting (Biome)

- **Biome** is installed with a **minimal** ruleset (`biome.json`: `noDebugger` only) so `npm run lint` is green without a large style refactor. Expanding to `recommended` rules (and/or formatter) is a follow-up chore.

## IR-LINT-SYNC-CHAIN-001

- Depth uses **synchronous edges only**. Edges are excluded when `edgeRepresentsAsyncBoundary` is true — e.g. `metadata.protocol: async|message|queue|event`, `metadata.async: true`, `config.async: true`, top-level `edge.kind` merged into metadata, channel-like `kind`, edges **to** queue/topic/stream-like node types, or target nodes classified as queue-like (see `lint-graph.ts` / `graphPredicates.ts`). Document async boundaries in IR to avoid false positives.
- **HTTP entry selection:** The rule prefers HTTP-like nodes with **no incoming synchronous** edges as chain **starts**. If that set is empty (every HTTP-like node has an incoming sync edge — e.g. unusual modeling or an internal-only slice), the implementation **falls back** to using **all** HTTP-like nodes as possible starts so deep synchronous chains are still detectable. Interpret warnings in that case with your graph’s northbound entry model.

## CLI safety

- **`--danger-skip-ir-structural-validation`** is the **documented** escape hatch; **`--skip-ir-structural-validation`** remains as a **hidden** backward-compatible alias. Do not use either in CI for real bundles.

## `npm install` / `prepare`

- **`prepare`** was removed so installing the package does not always compile TS. **`prepublishOnly`** runs **`npm run build`** before **npm publish** (tarball includes `dist/`).
- **Monorepo / `file:..` consumers** (e.g. InkByte `server`) must **build** `packages/deterministic` **before** `npm ci` in the consumer — already covered in **`docs/DETERMINISTIC_OSS_SYNC.md`** and CI.

## OpenAPI pass

- Export only validates **document shape** (parse + required top-level fields), not Spectral-level spec lint. See README and `openapi-structural.ts`.

## Host port probe

- Preflight checks **127.0.0.1** only; bindings on `0.0.0.0` / IPv6 or other hosts may not be detected.

## Dependencies

- **Major bumps** (e.g. Commander) should be reviewed manually; do not auto-merge without checking CLI behavior.

## Versioning

- **0.1.0** / pre-1.0: public API and CLI flags may still evolve; follow **CHANGELOG.md**.
