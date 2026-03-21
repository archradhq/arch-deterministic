# Security policy

## Supported versions

We publish **`@archrad/deterministic`** on npm from the [`archradhq/arch-deterministic`](https://github.com/archradhq/arch-deterministic) repository. Security fixes are applied on the **latest** minor release line when practical; use the newest version when possible.

## Reporting a vulnerability

**Please do not** open a public GitHub issue for undisclosed security problems.

Instead:

1. Prefer **GitHub private vulnerability reporting** on [`archradhq/arch-deterministic`](https://github.com/archradhq/arch-deterministic/security) if enabled; otherwise email the **repository maintainers** with:
   - A short description and impact
   - Steps to reproduce (if safe to share)
   - Affected versions / environments (Node, OS) if known

2. We aim to acknowledge within **a few business days** and coordinate disclosure and a fix release.

## Scope

This package is a **local** CLI and library: **IR JSON → project files**. It does not ship a network service by default. Reports about **generated application code** (e.g. a user’s Docker image) are usually out of scope unless the issue is in **this package’s** templates or logic.

## Dependency advisories

Run `npm audit` in your project after installing. We use **Dependabot** on the GitHub repo for dependency update PRs.
