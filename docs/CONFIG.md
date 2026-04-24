# Project config: `archrad.yml`

`archrad` looks for an `archrad.yml` (or `archrad.yaml`) starting in the
current directory and walking up toward the filesystem root. When found,
its values are used as **defaults** for matching CLI flags — explicit
flags on the command line always win.

This lets you run short commands like `archrad validate` or
`archrad export` in a repo without re-typing `--ir`, `--target`, etc.

## Location

- Default: any `archrad.yml` / `archrad.yaml` discovered by walking upward
  from the CWD.
- Explicit: `archrad --config path/to/custom.yml validate ...`
- Disable: `archrad --no-config validate ...`

When a config is used, `archrad` prints a one-line notice to stderr:

```
archrad: using config from ./archrad.yml
```

## Supported keys

```yaml
# archrad.yml
version: 1

# Inputs
ir: ./archrad-graph.json      # default --ir for validate / export / drift
target: python                # default --target for export / drift
output: ./generated           # default --output (init) and --out (export/drift)

# Policy + exit behaviour
policies: ./policies          # default --policies directory
failOn: error                 # default --fail-on (error | warning | never)
failOnWarning: false          # default --fail-on-warning
maxWarnings: 0                # default --max-warnings

# Lint toggles
skipLint: false               # validate: --skip-lint
skipIrLint: false             # export / drift: --skip-ir-lint

# Export / drift specifics
hostPort: 8080                # default --host-port
skipHostPortCheck: false      # export / drift: --skip-host-port-check
strictHostPort: false         # export: --strict-host-port
strictExtra: false            # drift: --strict-extra

# Output artefacts
report: ./archrad-report.html
findingsJsonOut: ./archrad-findings.json
metricsFile: ./archrad-metrics.json
```

All file-path values are resolved **relative to the directory that
contains the config file**, so commands behave the same whether you run
them from the repo root or a deeply nested subdirectory.

Unknown top-level keys are rejected with a clear error — typos fail
loudly rather than silently doing nothing.

## Precedence

1. Explicit CLI flags (`archrad validate --ir ./other.json`)
2. Values from `archrad.yml`
3. Commander / archrad built-in defaults

## Examples

### Minimal validate-only config

```yaml
# archrad.yml
ir: ./archrad-graph.json
failOn: warning
```

Then, from anywhere in the repo:

```bash
archrad validate
```

### Full export + drift workflow

```yaml
# archrad.yml
ir: ./archrad-graph.json
target: python
output: ./generated
policies: ./policies
failOn: error
hostPort: 8080
```

```bash
archrad validate          # uses ir, failOn, policies
archrad export            # uses ir, target, output, hostPort, policies
archrad validate-drift    # uses ir, target, output, hostPort
```

### Overriding on the command line

```bash
# Keeps ir:, target: from archrad.yml but writes to a different dir
archrad export --out ./scratch-build
```

### Bypassing config for CI reproducibility

```bash
# Uses only flags; ignores any archrad.yml present
archrad --no-config validate --ir ./graph.json --fail-on error
```

## Limitations

- Boolean flags (e.g. `--skip-lint`) that are `true` in config cannot be
  negated on the command line unless the command defines a `--no-*`
  variant. Use `--no-config` or `--config` to pick a different config
  file when you need to override.
- Config-level defaults are currently scoped to `validate`, `export`,
  `validate-drift`, and `init`. Other subcommands
  (`yaml-to-ir`, `ingest`, `fragment`) continue to require explicit flags.
