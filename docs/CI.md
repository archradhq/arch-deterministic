# CI integration — `archrad validate`

`archrad validate` is the usual gate for **architecture-as-code** in pipelines. It reads an IR JSON file and runs structural validation (IR-STRUCT-*) plus architecture lint (IR-LINT-*).

## Exit codes

| Situation | Default exit code |
|-----------|-------------------|
| No findings | **0** |
| Any finding with severity **`error`** (structural / blocking) | **1** |
| **Warnings only** (e.g. many IR-LINT-* rules) | **0** |

Optional stricter gates:

- **`--fail-on-warning`** — exit **1** if any warning exists.
- **`--max-warnings <n>`** — exit **1** if the warning count is **greater than** `n` (e.g. **`--max-warnings 0`** allows no warnings).

JSON output: add **`--json`** (findings array on stdout).

Policy packs: **`--policies <dir>`** (directory of PolicyPack YAML/JSON), merged after built-in IR-LINT-* (omit **`--skip-lint`** if you want lint + policies).

Example:

```bash
npx archrad validate --ir ./graph.json
npx archrad validate --ir ./graph.json --fail-on-warning
npx archrad validate --ir ./graph.json --max-warnings 0 --json
```

Install **`@archrad/deterministic`** as a dev dependency so `npx archrad` resolves locally, or invoke **`node node_modules/@archrad/deterministic/dist/cli.js`** explicitly.

---

## GitHub Actions

```yaml
jobs:
  archrad:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npx archrad validate --ir ./path/to/graph.json
```

With warnings as failures:

```yaml
      - run: npx archrad validate --ir ./path/to/graph.json --fail-on-warning
```

---

## GitLab CI

```yaml
archrad-validate:
  image: node:20-bookworm
  script:
    - npm ci
    - npx archrad validate --ir ./path/to/graph.json
```

---

## Bitbucket Pipelines

```yaml
pipelines:
  default:
    - step:
        name: ArchRad validate
        image: node:20
        script:
          - npm ci
          - npx archrad validate --ir ./path/to/graph.json
```

---

## Jenkins (Declarative)

```groovy
pipeline {
  agent any
  stages {
    stage('ArchRad') {
      steps {
        sh 'npm ci'
        sh 'npx archrad validate --ir ./path/to/graph.json'
      }
    }
  }
}
```

---

## Azure DevOps

```yaml
steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '20.x'
  - script: npm ci
    displayName: npm ci
  - script: npx archrad validate --ir ./path/to/graph.json
    displayName: archrad validate
```

---

## Notes

- Replace **`./path/to/graph.json`** with your IR path (repo-relative in CI).
- Ensure the job installs the same **`@archrad/deterministic`** version you use locally (`package.json` / lockfile).
- Drift checks use **`archrad validate-drift`** (separate command); see **`docs/DRIFT.md`**.
