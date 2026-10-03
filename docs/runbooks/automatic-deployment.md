# Runbook — automatic deployment of merged releases (Stage F)

_Plain English for the owner and the second custodian. No server address, no key and no password appears in
this document or anywhere in the repository — they live in the GitHub environment and on the box only._

## What happens now, without anyone doing anything

1. A pull request is merged into `main`. It could only be merged with every check green (branch protection,
   hard rule #8) — that is the approval.
2. The pipeline runs the three verification jobs again on the merged commit. If any fails, nothing deploys.
3. The `release` job then tells the demo box to deploy **exactly that commit**. On the box, `release.sh`
   fetches, refuses anything that is not on `main`, builds the app shells, brings the containers up
   (schema migrations run first, idempotently), waits for the API to say READY, and runs the stand-up check.
4. If the new release does not come up healthy within three minutes, the box **rolls back** to the release
   that was live before, and the pipeline job goes **red**. The shop is never left on a broken release.
5. Every attempt is written to an append-only release log on the box: when, which commit, what it replaced,
   the result, who merged it and which pipeline run.

## What you will see

- **GitHub → Actions → the run for the merge.** The last job is *"Deploy the merged release to the demo box"*.
  Green = the box is on the new release and the stand-up check is GREEN. Red = read the job's log: it says
  in words whether it was refused, rolled back, or needs a person.
- **On the box:** the release log (`/opt/sre/releases.log` unless you changed `deploy.conf`), one line per
  attempt, newest last.
- If the `demo` environment has **no secrets yet**, the job prints "No demo box is configured" and deploys
  nothing. That is the safe default — a copy of this repository cannot deploy anywhere by accident.

## One-time set-up — a person does this once per box

You need: a computer with `ssh`, the box's address and an administrator login to it, and the GitHub
repository settings. Nothing below is typed into this repository.

**On the box (as the administrator):**

1. Create a user that owns deployments and may run Docker:
   ```bash
   sudo adduser --disabled-password --gecos "" deploy
   sudo usermod -aG docker deploy
   sudo chown -R deploy:deploy /opt/sre
   ```
   (The application checkout is `/opt/sre/app`, as in the demo stand-up runbook. If yours lives elsewhere,
   say so in `deploy.conf` — step 3.)
2. Make sure the checkout can fetch from GitHub as the `deploy` user (the same read-only deploy key or
   token the stand-up used). Test: `sudo -u deploy git -C /opt/sre/app fetch origin main`.
3. Settings, no secrets: `sudo -u deploy cp /opt/sre/app/infra/deploy/deploy.conf.example /opt/sre/deploy.conf`
   and edit only what differs on your box. Keep `SRE_BUILD_ENV="PILOT_DEMO_BANNER=1"` on the demo box.
   The stack's public front (ADR-0018) reads `SRE_PUBLIC_HOST` / `SRE_TLS` from `infra/compose/.env.pilot`: set the
   box's domain there for a real certificate, or its public IP address for the proxy's own certificate (demo only).

**On your own computer:**

4. Make a key pair that exists for this one purpose:
   ```bash
   ssh-keygen -t ed25519 -N "" -C sre-retail-os-pipeline -f sre-pipeline-key
   ```
   This writes two files: `sre-pipeline-key` (**private** — goes into GitHub, then is deleted) and
   `sre-pipeline-key.pub` (**public** — goes onto the box).
5. Record the box's host key so the pipeline refuses to talk to any other machine:
   ```bash
   ssh-keyscan -t ed25519 -p 22 <the box's address>
   ```
   Keep the one output line that starts with the address (it is safe to hold; it is not a secret, but it
   goes into the environment like one so it is never written down here).

**On the box again:**

6. Install the PUBLIC key **as a forced command** — the key can then run `release.sh` and nothing else (no
   shell, no file copy, no forwarding). Copy the one line from `infra/deploy/authorized_keys.example`, replace
   `REPLACE_WITH_THE_PUBLIC_KEY` with the key part of `sre-pipeline-key.pub`, and put it in
   `/home/deploy/.ssh/authorized_keys` (mode 600, folder mode 700, owned by `deploy`).

**In GitHub (repository → Settings → Environments → New environment → `demo`):**

7. Add these environment secrets:

   | Secret | Value |
   |---|---|
   | `DEPLOY_HOST` | the box's address (host name or IP) |
   | `DEPLOY_USER` | `deploy` (only if you used another name) |
   | `DEPLOY_PORT` | the SSH port (only if it is not 22) |
   | `DEPLOY_SSH_KEY` | the **entire contents** of the private key file `sre-pipeline-key` |
   | `DEPLOY_HOST_KEY` | the one line from `ssh-keyscan` in step 5 |

8. Delete `sre-pipeline-key` from your computer. The private key now exists only in GitHub's secret store.
9. Test it: re-run the latest `main` workflow from the Actions tab (or merge the next pull request). The
   release job should turn green and the box's release log should gain a `result=deployed` line.

## Rollback — what it does and what it does not

- **Does:** if the new release is not READY and GREEN in time, the previous commit is checked out, rebuilt
  and brought up again; the job exits red with the word ROLLED BACK. Data is untouched: the ledger is
  append-only and every migration is additive (checked by `tests/migration`), so the previous code runs
  happily on the newer schema.
- **Does not:** undo a schema migration, restore a backup, or delete anything. It never runs
  `docker compose down -v`. If a release needs a data fix, that is a person's job with the backup runbook.
- **Manual rollback** (custodian, on the box): `sudo -u deploy /opt/sre/app/infra/deploy/release.sh <sha>`
  with any earlier commit that is on `main`. The same refusals and checks apply.

## When it goes red

| The job log says | What it means | What to do |
|---|---|---|
| `REFUSED — commit … is not on origin/main` | somebody pointed the pipeline at a commit that did not go through a pull request | nothing was changed; find out how |
| `ROLLED BACK` (exit 70) | the new release did not come up; the box is on the previous one and GREEN | read the container log lines in the job; fix forward, merge again |
| `ROLLBACK FAILED` (exit 71) | neither release answered | a person on the box now: `docker compose … ps`, `… logs api migrate`, `pnpm run standup:check`; if the database is the problem, the backup runbook |
| `another deployment is running` (exit 75) | two merges landed close together | the second one re-runs by itself when you press *Re-run* on the job |
| `NOT SET UP` (exit 78) | `/opt/sre/app` is not the checkout, or `deploy.conf` points elsewhere | check step 1–3 |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` (then `ROLLBACK FAILED` on the same commit, nothing changed) | the modules directory was laid down by another pnpm version or user and pnpm wanted a yes nobody could give; releases before 3 Oct 2026 did not set `CI=true` | the release script now exports `CI=true`; on an older script, run `sudo -u deploy sh -c 'cd /opt/sre/app && CI=true pnpm install --frozen-lockfile'` once and re-run the job |
| `the public front did not answer at …/readyz` (NOT HEALTHY → rolled back) — or, on a script older than 3 Oct 2026, a GREEN job while `docker compose … ps` shows `proxy` `Restarting` and the demo address answers nothing | the proxy refused its configuration; most often an empty entry in `SRE_PUBLIC_HOST` (the list ending in a comma with nothing after it) | fix the line in `.env.pilot`, then `docker compose … up -d proxy`; `SRE_FRONT_URL` in `deploy.conf` names what the script checks — the loopback address by default; configuration B: the loopback port the proxy was given, e.g. `https://localhost:8443` |
| `Permission denied (publickey)` or `Host key verification failed` | the key or host key in the `demo` environment does not match the box | redo steps 5–7; never lower `StrictHostKeyChecking` |

## Before this ever deploys real data

The demo box holds synthetic data, which is why a merge may deploy to it without a further click. A box that
holds real data is a **separate GitHub environment** with **required reviewers** switched on (Settings →
Environments → the environment → *Required reviewers* → the owner), its own key pair and its own
`deploy.conf` with `SRE_BUILD_ENV=""`. Nothing reaches it until a named person approves the run in GitHub —
that is the roadmap's approved, signed release (AID-08). Do not reuse the demo key.

## Security notes (P-04)

- The pipeline key can only run `release.sh` (forced command, `restrict`); the script accepts only a
  40-character commit id that is on `main`; the host key is pinned; the private key exists only in GitHub's
  secret store and in the runner's memory for the length of one job.
- The `deploy` user is in the `docker` group, which is administrator-equivalent on that one box. Accepted
  for a single-box demo and recorded in ADR-0017; the real-data box gets its own review.
- The script reads no secret: it hands the path of the env file to compose and the stand-up check.

**Related:** `infra/deploy/` · `.github/workflows/ci.yml` (`release` job) · `docs/adr/0017-automatic-deployment-of-merged-releases.md` ·
`docs/pilot/DEMO-PILOT-STANDUP-RUNBOOK.md` · `docs/runbooks/backup-and-recovery.md` · `docs/runbooks/branch-protection.md`.
