# `.github/workflows/`

Continuous integration and delivery — `ci.yml` (every pull request and push), plus one nightly workflow:

- **`verify`** — type check, lint, secret scan, the whole test suite, dependency scan (every pull request and
  every push to `main`).
- **`integration`** — the stage-gate and migration suites against a real PostgreSQL, then backup → destroy →
  restore reconciled (QG-08).
- **`store-pc-windows`** — CR-01 step 1 (ADR-0032): on a clean Windows machine, the store computer is set up as the
  owner does it and its database, office API and till are installed as Windows services, no Docker; then Windows itself
  is asked whether each claim holds (`tests/windows/store-pc-on-windows.check.mjs`): running, starting at boot, each on
  its own account, this PC only, no secret in a definition or log, the API back by itself after being killed, the till
  selling with the API and the database stopped. Its record is the job's artifact.
- **`store-pc-setup`** — CR-01 step 2a (OI-01): builds the release folder and `SRE-Setup.exe`, runs it once silently
  on a clean Windows machine (no typed command), asks Windows the same 18 questions, runs it again (nothing replaced)
  and uninstalls it (services gone, data kept). `SRE-Setup.exe` is kept as the run's artifact for 14 days.
- **`store-pc-first-run`** — CR-01 step 2b (OI-02): the first-run screens on a clean Windows machine, filled in through
  their own door (`tests/windows/first-run-screens.drive.mjs`): a wrong GSTIN refused, then SETUP DONE with the shop
  prepared by the owner and approved by the accountant, then the 18 questions.
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

**`rollback-drill.yml`** (W4, 3 Nov 2026) — QG-08 / pilot gate G9: the timed rollback drill (`scripts/rollback-drill.mjs`)
runs **end to end with `--run`** against the whole composed stack on a fresh runner: the stack is put live on the current
commit of `main` by `infra/deploy/release.sh`, the drill backs it up, restores the copy into a separate empty database and
reconciles it, puts the previous commit back, then the current one again, all timed against §32. It runs **every week on
`main`** (Monday 03:43 shop time) and **on demand**, never on a pull request. Its artifact holds the drill record and the
rollback rehearsal body (`*.qg08-rollback.json`, the body of `POST /v1/platform/dr-drills`) — the evidence QG-08 reads.
