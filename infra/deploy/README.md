# `infra/deploy/` — automatic deployment of merged releases (Stage F)

- **`release.sh`** — runs ON the box. Deploys exactly one merged commit of `main` (refuses anything else),
  waits for READY and the stand-up check, and puts the previous release back if the new one does not come
  up. Appends one line per attempt to the release log. Exit codes: 0 deployed · 65 refused · 70 rolled back ·
  71 rollback failed · 75 another deploy running · 78 box not set up.
- **`deploy.conf.example`** — the box's settings (no secrets); copy to `/opt/sre/deploy.conf`.
- **`authorized_keys.example`** — the forced-command line that pins the pipeline's SSH key to `release.sh`.

The pipeline half is the `release` job in `.github/workflows/ci.yml`; the plain-English guide with the
one-time human steps is `docs/runbooks/automatic-deployment.md`; the decision is ADR-0017. Proven by
`tests/integration/the-release-script-deploys-and-rolls-back.test.ts` (the script really runs in a sandbox)
and `tests/guardrails/merged-releases-deploy-themselves.test.ts`.

> Part of the SRE Retail OS repository layout defined in `CLAUDE.md`.
