# `.github/workflows/`

Continuous integration and delivery, in one file — `ci.yml`:

- **`verify`** — type check, lint, secret scan, the whole test suite, dependency scan (every pull request and
  every push to `main`).
- **`integration`** — the stage-gate and migration suites against a real PostgreSQL, then backup → destroy →
  restore reconciled (QG-08).
- **`deploy`** — the API image builds, refuses a bad configuration by name, and the whole compose stack comes
  up READY and drains cleanly.
- **`release`** — on a push to `main` only, after the three above passed on that commit: deploys exactly that
  commit to the demo box over a forced-command SSH key and rolls back if it does not come up (Stage F,
  ADR-0017, `docs/runbooks/automatic-deployment.md`). Deploys nothing until the `demo` environment holds its
  secrets.

> This folder is part of the SRE Retail OS repository layout defined in `CLAUDE.md`.
