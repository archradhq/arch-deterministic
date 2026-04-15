# OSS documentation versioning — `@archrad/deterministic`

Tier-1 OSS documents are **released in lockstep** with **`@archrad/deterministic`**. When you cut **vX.Y.Z**, ship an updated **doc revision** for that tag and record **what changed** so readers can diff behavior vs the previous release.

---

## Tier-1 documents (must follow this process)

| Document | Role |
|----------|------|
| [OSS_DESIGN.md](./OSS_DESIGN.md) | Design record: scope, subsystems, boundaries |
| [OSS_ARCHITECTURE.md](./OSS_ARCHITECTURE.md) | Component diagram, dependencies, deployment |
| [OSS_FLOWS.md](./OSS_FLOWS.md) | Validate / export / drift / MCP flows |

Optional collateral (HTML slides, PDFs, diagrams exported from Mermaid) should carry the **same version label** in the title or footer and point here or to **`CHANGELOG.md`** for the authoritative list.

---

## On every release (with `RELEASING.md`)

1. **Implement** the product/code change and update **`CHANGELOG.md`** (Keep a Changelog) as today.
2. **Bump** **`package.json`** **`version`** to **vX.Y.Z**.
3. **Update tier-1 OSS docs** when anything user-visible changes:
   - New or removed CLI flags, MCP tools, rule codes, pipeline stages, or dependencies.
   - Corrections to architecture (module names, call order, data shapes).
4. **Add a “Changes in vX.Y.Z” subsection** under **Release history** below — use **Added / Changed / Removed / Fixed** so changes are **scannable** (same spirit as the main changelog).
5. **Set the doc revision line** at the top of each tier-1 file (see template below).
6. **Tag** **`vX.Y.Z`** on the OSS mirror; consumers can **`git show vX.Y.Z:docs/OSS_ARCHITECTURE.md`** to compare files across versions.

If a release has **no** doc-affecting changes, still bump the **doc revision date** to the release date and add one line: **“No substantive doc changes (version bump only).”**

---

## Doc revision line (copy into each tier-1 file)

Place **directly under the H1** (after the title line):

```markdown
**Doc revision:** vX.Y.Z · package `@archrad/deterministic` X.Y.Z · YYYY-MM-DD
```

Example:

```markdown
**Doc revision:** v0.1.7 · package `@archrad/deterministic` 0.1.7 · 2026-05-01
```

---

## How to “highlight” changes

- **In this file (history):** Use **`### [X.Y.Z] - YYYY-MM-DD`** and bullet lists with **Added / Changed / Removed / Fixed** per document filename.
- **In tier-1 docs:** Prefer **small, explicit edits** (new subsection, updated diagram, table row). Avoid long strike-through; git diff is the source of truth.
- **Optional** for big rewrites: add a short note at the top of the affected doc for one release only, e.g.  
  `> **Note (v0.2.0):** Export pipeline now …` then remove or shorten the next release.

---

## Release history (OSS tier-1 docs)

### [0.1.6] - 2026-04-10

#### Added

- **`OSS_DOCUMENTATION_VERSIONING.md`** (this file) — process for versioning tier-1 OSS docs with each package release.

#### Changed

- **`OSS_ARCHITECTURE.md`** — Clarified **`normalizeIrGraph`** (**`ir-structural.ts`**) vs **`materializeNormalizedGraph`** (**`ir-normalize.ts`**); CLI vs MCP entrypoints; **`policy-pack.ts`** → **`lint-graph.ts`** dependency; data table for IR / **`ParsedLintGraph`**.
- **`OSS_DESIGN.md`** — Normalization bullet: same module split as above.

#### Fixed

- Diagram edges: **`CLI`** does not connect only to **`normalizeIrGraph`**; validate calls **`validateIrStructural`** / **`validateIrLint`**.

---

## See also

- [`../RELEASING.md`](../RELEASING.md) — npm publish and OSS mirror
- [`CHANGELOG.md`](../CHANGELOG.md) — full product changelog
