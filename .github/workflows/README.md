# `.github/workflows/`

Continuous integration and delivery — `ci.yml` (every pull request and push), plus one nightly workflow:

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

**`store-volume.yml`** (Round 3, 31 Oct 2026) — GT-05's opening load at a real store's volume (15 000 products, four
locations, a third batch-tracked) on a real PostgreSQL, read back to the unit and the paisa. It takes 25 minutes or more, so
it runs **every night on `main`** (03:17 shop time) and **on demand** (Actions → this workflow → Run workflow, choosing the
product count) — never on a pull request, so no pull request waits for it. A skipped run is refused, not counted green.
