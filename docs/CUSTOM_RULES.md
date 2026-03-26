# Custom architecture rules (org / enterprise)

OSS **`@archrad/deterministic`** ships a fixed set of **`IR-LINT-*`** visitors in **`src/lint-rules.ts`**. They are **deterministic** graph checks — not Spectral, not LLM, not org policy packs (those sit in **ArchRad Cloud** or your own stack).

This doc shows a **minimal, real extension point**: the same **`ParsedLintGraph`** built-ins use, returning **`IrStructuralFinding[]`** with **`layer: 'lint'`**.

## Two supported paths

| Path | When to use | `archrad validate` CLI |
|------|----------------|-------------------------|
| **Compose in your pipeline** | CI / IDP runs Node; you call the library | Unchanged — your script runs custom rules after **`validateIrLint`** or replaces it with the composed function below. |
| **Fork `arch-deterministic`** | You want **`archrad validate`** itself to emit **`ORG-*`** codes | Append your visitor to **`LINT_RULE_REGISTRY`** in **`lint-rules.ts`**, rebuild, publish / vendor the fork. |

**Do not mutate** **`LINT_RULE_REGISTRY`** from application code at runtime: it is typed as **`ReadonlyArray`** and the project may freeze or replace that array in the future. Treat **`runArchitectureLinting`** as the built-in runner only.

## Worked example: timeout on `service` nodes

Assume IR nodes use **`type: "service"`** and you require **`config.timeout`** (milliseconds) on each.

**`my-org/require-service-timeout.ts`**

```typescript
import type { IrStructuralFinding, ParsedLintGraph } from '@archrad/deterministic';

function nodeType(n: Record<string, unknown>): string {
  return String(n.type ?? n.kind ?? '').toLowerCase();
}

export function ruleRequireServiceTimeout(g: ParsedLintGraph): IrStructuralFinding[] {
  const findings: IrStructuralFinding[] = [];
  for (const [id, n] of g.nodeById) {
    if (nodeType(n) !== 'service') continue;
    const cfg = (n.config as Record<string, unknown> | undefined) ?? {};
    if (cfg.timeout == null || cfg.timeout === '') {
      findings.push({
        code: 'ORG-001',
        severity: 'warning',
        layer: 'lint',
        message: `Service node "${id}" has no config.timeout`,
        nodeId: id,
        fixHint: 'Set config.timeout (e.g. milliseconds) on this node.',
      });
    }
  }
  return findings;
}
```

**`my-org/validate-with-org-lint.ts`** — same entry shape as **`validateIrLint`**:

```typescript
import {
  buildParsedLintGraph,
  isParsedLintGraph,
  runArchitectureLinting,
} from '@archrad/deterministic';
import { ruleRequireServiceTimeout } from './require-service-timeout.js';

/** Built-in IR-LINT-* plus org rules (drop-in mental model for validateIrLint). */
export function validateIrLintWithOrg(ir: unknown) {
  const built = buildParsedLintGraph(ir);
  if (!isParsedLintGraph(built)) return built.findings;
  return [...runArchitectureLinting(built), ...ruleRequireServiceTimeout(built)];
}
```

Wire **`validateIrLintWithOrg`** (or your own name) into CI instead of plain **`validateIrLint`** when you need **`ORG-*`** findings. Combine with **`validateIrStructural`**, **`sortFindings`**, and **`shouldFailFromFindings`** the same way as the README library example.

## CLI without a fork

There is **no** `archrad validate --rules ./extra.js` flag today. Options:

- **Wrapper script** that loads IR JSON, runs **`validateIrStructural`** + **`validateIrLintWithOrg`**, prints findings, exits **`1`** on your policy (mirror **`cli-findings`** formatting if you want).
- **Fork** and register **`ruleRequireServiceTimeout`** inside **`LINT_RULE_REGISTRY`** so the stock **`archrad validate`** binary includes it.

## Conventions (match built-in rules)

- Return **`layer: 'lint'`** for architecture heuristics; use your own **`code`** prefix (**`ORG-*`**, **`ACME-*`**) to avoid colliding with **`IR-LINT-*`** / **`IR-STRUCT-*`**.
- Use **`ParsedLintGraph`**: **`g.nodeById`**, **`g.edges`**, **`g.adj`**, **`g.inDegree`** / **`g.outDegree`** — see **`src/lint-graph.ts`**.
- Reuse predicates when it helps: **`isHttpLikeType`**, **`isDbLikeType`**, **`isQueueLikeNodeType`** (exported from the package).
- Heavy or semantic policy (SOC2 mapping, “is this PII?”) belongs in **product** or a separate engine; keep OSS visitors **fast and deterministic**.

## See also

- **[STRUCTURAL_VS_SEMANTIC_VALIDATION.md](./STRUCTURAL_VS_SEMANTIC_VALIDATION.md)** — OSS vs Cloud boundary.
- **[IR_CONTRACT.md](./IR_CONTRACT.md)** — normalized node/edge shapes before lint runs.
- **`src/lint-rules.ts`** — reference implementations for **`IR-LINT-*`**.
