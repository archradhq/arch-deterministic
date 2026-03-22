# Concept, adoption, and limits (honest framing)

This doc captures how the **deterministic OSS package** fits in the market—not as marketing copy, but as a **product/engineering** read for contributors and partners.

## What’s compelling

- **IR as source of truth** — Separating *what should be built* (the graph) from *how it is generated* (templates/codegen) is a clean abstraction. Most tools skew either to opaque AI (hard to reproduce) or to dumb scaffolders (no architectural rigor).
- **Compiler mental model** — **`archrad validate`** treats the graph like source code: structural checks, lint rules, and CI gates. That discipline is rare in “architecture” tooling.
- **Tiered validation** — Structural → architecture lint → export-time OpenAPI **document-shape** is intentional: not “block on everything” or “warn on nothing.”
- **Determinism** — Same IR → same output matters for teams that want **reproducible CI** and defensible pipelines.

## Where the friction is (real adoption hurdles)

### Who owns the IR?

This package does **not** include a natural-language or visual **authoring** front-end. Input is **structured JSON** (or your own producer). The README states that **plain English → IR** is out of scope here: use **ArchRad Cloud**, an internal tool, or **your own LLM step**.

**Cold start:** Developers must hand-write graph JSON, generate IR from another system, or adopt upstream tooling. **Fixtures** help demos; they don’t remove the onboarding gap.

### One-way export (no round-trip)

**`archrad export`** produces a **FastAPI** or **Express** project you can run and edit. There is **no** supported path today to **edit generated code and merge changes back into the IR**. That’s honest: the value proposition is **greenfield / contract-first scaffolding and validation**, not ongoing bidirectional architecture management—unless you rebuild that workflow yourself (e.g. regenerate into a fresh tree, or treat IR as the only editable source).

## Strategic read (OSS vs Cloud)

A coherent story is:

1. **OSS** — Auditable, deterministic **compiler + linter** for a defined IR: trust, CI, and “read the same code that emitted your zip.”
2. **Cloud / product** — **IR production** (UX, AI-assisted graph), deeper **semantic/policy** validation, and org workflows.

If **IR** becomes a **shared format** beyond a single vendor (schemas, community examples, third-party generators), the OSS layer behaves like a **platform hook**. If IR stays **proprietary-in-practice**, the OSS repo is still valuable as a **spec and trust artifact**, but community leverage is smaller.

## What would make OSS adoption stronger (directional ideas)

None of these are commitments; they are **plausible** ways to narrow the cold-start gap **without** moving the whole product into OSS:

- **Lightweight IR authoring in OSS** — **`archrad yaml-to-ir`** converts **`graph:`** or bare **`nodes:`** YAML to canonical IR JSON (see **`fixtures/minimal-graph.yaml`**). Further ideas: richer **starter templates**, **VS Code** snippets.
- **Editor integration** — e.g. JSON Schema validation + snippets in **VS Code** / Cursor rules for graph files.
- **Clear “IR from OpenAPI / Postman”** one-way adapters (if they match your graph model).

For product strategy, treat this list as **roadmap candidates**, not shipped features.

## See also

- [IR_CONTRACT.md](./IR_CONTRACT.md) — parser boundary and normalized shapes  
- [STRUCTURAL_VS_SEMANTIC_VALIDATION.md](./STRUCTURAL_VS_SEMANTIC_VALIDATION.md) — OSS vs Cloud validation split  
- [README.md](../README.md) — usage and CLI  
