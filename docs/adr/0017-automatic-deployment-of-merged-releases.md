# ADR 0017 — Automatic deployment of merged releases to the single box (push over a forced-command SSH key)

- **Status:** Accepted (owner program directive, Stage F, 29 September 2026: "complete the coding after the
  CI is green and merged … we will deploy it, and then we will use it in a real-time pilot")
- **Date:** 29 September 2026
- **Context:** §19/§20 fix delivery as containers + IaC + CI/CD; AID-02 (protected branches, pull requests),
  AID-08 ("sign releases, stage rollout and prove rollback — never auto-deploy unapproved generated changes");
  `docs/architecture/infrastructure.md §4`. The hosted demo (MilesWeb VM3, ADR-0002 single-VM shape within the
  D3 ceiling) was stood up by hand from `docs/pilot/DEMO-PILOT-STANDUP-RUNBOOK.md`: `git clone` of `main`,
  secrets generated on the box into `infra/compose/.env.pilot`, `docker compose -p sre-pilot … up -d`, the shells
  built on the box, `standup:check` GREEN. Every later release would have needed a person to repeat that. The
  CI already builds and smoke-tests the image and the compose stack on every pull request (`deploy` job) but
  deployed nowhere.

## Decision

1. **A merge to `main` is the approval.** Main is protected: a commit reaches it only through a pull request
   whose checks are green and whose code owner is the owner (`.github/CODEOWNERS`). The pipeline's `release`
   job runs only for a push to `main`, only after the three verification jobs passed on that exact commit.
2. **Push-based, over SSH, from the pipeline to the box.** The job connects with a key held as a GitHub
   *environment* secret and asks the box to deploy `$GITHUB_SHA`. Pinned host key (`StrictHostKeyChecking=yes`
   from a `DEPLOY_HOST_KEY` secret, no first-use trust), `BatchMode`, `IdentitiesOnly`; the key file exists for
   the length of one job. Read-only repository permissions stay (`contents: read`).
3. **The key can run one thing.** On the box the public key is installed as a **forced command** with
   `restrict`: `infra/deploy/release.sh`. The script accepts only a 40-hex commit id that is an ancestor of
   `origin/main` (anything else: refused, exit 65, nothing touched), remembers the live commit, checks the new
   one out and **re-executes itself from that checkout**, so the deploy logic is the one shipped with the
   release and the pinned command never needs to change.
4. **Build on the box, as the stand-up did.** `pnpm install --frozen-lockfile`, the app shells
   (`scripts/build-app.mjs`, with the box's `SRE_BUILD_ENV` — `PILOT_DEMO_BANNER=1` on the demo), then
   `docker compose … up -d --build` (the `migrate` service applies new, additive migrations first). No image
   registry, no second machine: the demo is one VM under the cost ceiling, and images built in CI would need a
   registry account the box can pull from — deferred to the reconsider-when below.
5. **Proven rollback, automatically.** READY (`/readyz`) within a timeout and `standup:check` GREEN, or the
   previous commit is checked out, rebuilt and brought up again, and the job exits red (70). If that also fails:
   red 71 and a plain message that a person is needed. Migrations are not reversed (they are additive by
   guardrail; the previous code runs on the newer schema); data is never restored or deleted by the script; it
   never runs `docker compose down -v`.
6. **One at a time, and recorded.** A file lock serialises deployments (exit 75); the workflow's concurrency
   group queues rather than cancels. Every attempt appends one line to `/opt/sre/releases.log`: time, commit,
   what it replaced, result, who merged, which run.
7. **Environments carry the trust.** `demo` (synthetic data) deploys on merge once its secrets exist. A box
   holding real data is a separate environment with **required reviewers** (the owner) — a run pauses until a
   named person approves in GitHub, which is the roadmap's approved, signed release. With no secrets set, the
   job deploys nothing and says so.

What this ADR does **not** decide: the image registry, multi-instance rollout, the external-login auth backend
and the one-origin reverse proxy (the other Stage F items), or the vendor question of ADR-0002.

## Consequences

- Every merged pull request is live on the demo box minutes later, or the pipeline is red and the box is on
  the previous release. The custodian's quarterly rebuild (AID-10) is one re-run of the job.
- The `deploy` user is in the `docker` group — administrator-equivalent on that one box — accepted for the
  single-box demo; the real-data box gets its own key, environment and review.
- The box needs the toolchain the stand-up installed (Node 22, pnpm, Docker) and network access to GitHub to
  fetch. A box that cannot fetch fails loudly at step one.
- Proven by `tests/integration/the-release-script-deploys-and-rolls-back.test.ts` (the real script in a
  sandbox: refusals, a good deploy, a rollback, the forced command, the lock, a failed rollback, no secret
  printed) and `tests/guardrails/merged-releases-deploy-themselves.test.ts` (the job's gating and the script's
  properties). Runbook: `docs/runbooks/automatic-deployment.md`.

## Reconsider-when

- A second box or a managed container service (ADR-0002 item 4 decided): build images once in CI, publish to
  a registry with digests, and let each box pull — the script's shape (verify → up → READY → rollback) stays.
- Real data on any box: required reviewers before the first deploy secret is created; consider a pull-based
  agent so no inbound SSH from the pipeline exists at all.
- More than one merge per hour: consider batching or a release-tag trigger instead of every merge.
