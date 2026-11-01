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
   and edit only what differs on your box. Keep `SRE_BUILD_ENV="PILOT_DEMO_BANNER=1 PILOT_DEMO_LANE_BASE=/store-lane"` on the demo box, exactly as the example has it: the banner,
   and the path the hosted till rings its sales on (ADR-0016) — without `PILOT_DEMO_LANE_BASE` the demo's till writes to
   the tester's own computer and no sale reaches the demo store box. (A guardrail holds this line and the example equal.)
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
- **One `ZZ…` bill after a rollback and roll-forward (expected).** Rolling back to a release before the store computer's
  bill-number witness (r19/r20) runs the edge without it, and the next roll-forward finds a witness it did not write last;
  that first start numbers under a brand-new `ZZ…` prefix until head office answers, then returns to the till's own prefix.
  The same happens once on the very first deploy of the witness release. No bill number is repeated; ring one test bill
  to see the till's own prefix again.

## One API version at a time (verifier r21)

Head office runs **exactly one API container**, and never two API versions side by side — not even for a moment during a
release. Why: a change to a setting (and every other guarded write) is protected from two people saving at the same
moment by a "guard" whose name the code chooses; round 21 made those names per item. An old and a new version running
together would use different guard names for the same setting, so two saves at the same moment could both land and the
later one silently replace the earlier (hard rule #10). So:

- **`release.sh` guarantees it.** `docker compose up -d --build` replaces the single `api` container *stop-first*: the old
  one stops before the new one starts, so the two never serve at once. `release.sh` counts the running `api` containers
  BEFORE `compose up` (round 23: a stack already running two is refused before anything is rebuilt, so the new version
  never starts beside them) and again straight after (the only window left: a compose file that itself scales the API
  above one). If `docker compose ps` cannot answer, that is `REFUSED — could not count the API containers …`, never read
  as "none running". If there is more than one (scaled by hand, or `deploy.replicas` added to a compose file) it says
  `REFUSED — N API containers are running …` and puts the previous release back. If the previous release runs two as
  well, it ends `ROLLBACK FAILED` — a person scales it back with `docker compose up -d --scale api=1` and deploys again.
- **Never** scale the `api` service above one, run a second API "for a quick test" against the live database, or do a
  rolling / blue-green release of the API. A future multi-API design needs an ADR first (guard names stable across versions).
- To check on the box: `docker compose ps api` shows one line.

## Settings a release needs

Before anything is rebuilt, `release.sh` runs `node scripts/standup-check.mjs --settings-only` against the box's
settings file (`/opt/sre/app/infra/compose/.env.pilot` by default). It prints setting **names** only, never a value. If a
setting the new release requires is missing or still the placeholder, the release is **REFUSED (exit 78,
`result=settings_missing` in the release log)** and the box stays on the release it was on — nothing rebuilt, nothing
restarted.

**Round 32 (owner decision OB-116) adds one: `BOX_HISTORY_SEAL_KEY`** — head office's own secret for the seal on the store
computers' saved history. The administrator adds it to the box's settings file ONCE, before the round-32 merge deploys:

1. On the box, make a **new** value and write it straight into the settings file — never shown on the screen or kept in the
   terminal's scrollback (round 33, verifier r32 note 2c). Check it is not there yet (`grep -c '^BOX_HISTORY_SEAL_KEY='
   /opt/sre/app/infra/compose/.env.pilot` prints `0`) and that the file ends with a new line, then:
   `printf 'BOX_HISTORY_SEAL_KEY=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> /opt/sre/app/infra/compose/.env.pilot`
   (the file stays mode 600, owned as before). Do not run `openssl rand` on its own — it prints the value. Never paste the
   value into a chat, an issue, the repository, a store computer's or a till's settings file.
2. The pre-check refuses, by name and without printing anything of the value: a missing line, the placeholder, a value
   shorter than 32 characters, or one equal to `PACK_SIGNING_KEY`, `PII_KEY_ENCRYPTION_KEY` or `IDP_SIGNING_KEY` (the API
   refuses all of these at start; round 33 checks them here first, before anything is rebuilt). A box that has only a till's
   settings file and no head-office one is refused too, naming the missing file.
3. Nothing else: the next release picks it up. The first health read afterwards rebuilds the saved store-computer history
   once (its seal changed) — the store computer checks may say "being prepared" for a little while; nothing is lost.

## When it goes red

| The job log says | What it means | What to do |
|---|---|---|
| `REFUSED — the settings file (…) is missing a setting … needs` (exit 78, `result=settings_missing`) | the release requires a setting the box's settings file does not have (the name is printed above the line); nothing was rebuilt or restarted | add it as in "Settings a release needs" above, then re-run the job |
| `REFUSED — commit … is not on origin/main` | somebody pointed the pipeline at a commit that did not go through a pull request | nothing was changed; find out how |
| `ROLLED BACK` (exit 70) | the new release did not come up; the box is on the previous one and GREEN | read the container log lines in the job; fix forward, merge again |
| `ROLLBACK FAILED` (exit 71) | neither release answered | a person on the box now: `docker compose … ps`, `… logs api migrate`, `pnpm run standup:check`; if the database is the problem, the backup runbook |
| `another deployment is running` (exit 75) | two merges landed close together | the second one re-runs by itself when you press *Re-run* on the job |
| `NOT SET UP` (exit 78) | `/opt/sre/app` is not the checkout, or `deploy.conf` points elsewhere | check step 1–3 |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` (then `ROLLBACK FAILED` on the same commit, nothing changed) | the modules directory was laid down by another pnpm version or user and pnpm wanted a yes nobody could give; releases before 3 Oct 2026 did not set `CI=true` | the release script now exports `CI=true`; on an older script, run `sudo -u deploy sh -c 'cd /opt/sre/app && CI=true pnpm install --frozen-lockfile'` once and re-run the job |
| `the public front did not answer at …/readyz` (NOT HEALTHY → rolled back) — or, on a script older than 3 Oct 2026, a GREEN job while `docker compose … ps` shows `proxy` `Restarting` and the demo address answers nothing | the proxy refused its configuration; most often an empty entry in `SRE_PUBLIC_HOST` (the list ending in a comma with nothing after it) | fix the line in `.env.pilot`, then `docker compose … up -d proxy`; `SRE_FRONT_URL` in `deploy.conf` names what the script checks — the loopback address by default; configuration B: the loopback port the proxy was given, e.g. `https://localhost:8443` |
| every `/store/…` screen answers `502 Bad Gateway` after a release, while the edge's own log says `screens on …:8091` | the demo relay shares the edge's network namespace and was not recreated when a release recreated the edge; it is attached to the old, dead network | `docker compose … up -d --force-recreate --no-deps edge-relay`; since 4 Oct 2026 the release does this on every run (`SRE_RECREATE_SERVICES`) |
| After a deploy the screens look exactly as before (old colours, no rail), while `releases.log` says deployed and the box is healthy | The browser kept the old shell. Every screen's service worker serves its committed files from a named cache and only drops that cache when a worker with a NEW name activates; until RL-1 (4 Oct 2026) the name was a number nobody bumped, so the new stylesheet and chrome reached the box and no browser | From RL-1 the name is a digest of the shell (`node scripts/sync-ui-foundation.mjs --check` refuses a stale one; every build stamps it) and an open page shows a strip with a Reload button when a new version arrives. For a browser that still holds a pre-RL-1 worker, once: open the page in a private window, or clear the site's data (browser settings → site data for the demo address), then reload |
| `Permission denied (publickey)` or `Host key verification failed` | the key or host key in the `demo` environment does not match the box | redo steps 5–7; never lower `StrictHostKeyChecking` |
| `REFUSED — the pre-release backup did not succeed` (exit 69) | the box's `SRE_PREDEPLOY_BACKUP_CMD` failed, so nothing was deployed | the box is untouched; fix the backup (backup runbook), then re-run the job |
| `failed its canary bake` (exit 70, `rolled_back_in_canary_bake`) in the **Canary stage** job | the release came up but lost READY or added server errors while it was being watched; the canary box is back on the previous release and the full rollout did not run | open an incident (below) naming the release commit; fix forward and merge again |
| `THE BOOKS DO NOT RECONCILE` (exit 70, `rolled_back_on_reconcile`) | the release came up healthy, but the ledger, the outbox or the sync backlog differ from the snapshot taken just before it — each `DIFFERENCE — …` line says which (an event lost or changed, a new dead letter, a grown backlog) | the box is back on the previous release; open an incident (below) naming the release commit and the differences. Nothing on the ledger is deleted or overwritten to "fix" it (hard rule #2) |
| `REFUSED — the books could not be read before the release` (exit 69, `reconcile_snapshot_failed`) | the snapshot (run in the stack's own `migrate` container) could not read the database, so the release would have nothing to be compared with | the box is untouched; check the database container is up (`docker compose … ps db`), then re-run the job |

## The canary stage and the backup before a release (WF-20, ADR-0026)

- **The canary box** is a box chosen by the owner to take every release first. Set it up exactly like steps 1–9, but
  put its secrets (the same five names) on a GitHub environment called **`canary`**, and in its `/opt/sre/deploy.conf`
  set `SRE_BAKE_SECONDS=600` (ten minutes of watching). The pipeline's *Canary stage* job deploys there first; the full
  rollout job waits for it and does not run if it goes red. With no `canary` secrets the stage says "skipped" and the
  demo rollout proceeds — allowed for synthetic data only; a box with real data needs a canary first.
- **The backup before a release:** set `SRE_PREDEPLOY_BACKUP_CMD` in `/opt/sre/deploy.conf` to a command that takes a
  backup and exits 0 only when it worked (the demo: `sudo /bin/systemctl start --wait sre-pilot-backup.service`, with a
  sudoers line allowing the `deploy` user exactly that). A failed backup stops the release before anything changes.

## The books, reconciled around every release, and the QG-10 record (QG-10, WF-20)

QG-10 asks that "health, smoke, reconciliation, monitoring and rollback" are verified after **every** release. The
release script now does the reconciliation itself:

- **Before** anything is rebuilt it snapshots head office's books: how many events the ledger holds, its last sequence
  number, a digest over every event, the count per ledger family (sales, stock, cash, …), and the outbox's pending and
  dead-letter counts. The snapshot runs inside the stack's own `migrate` container, which already has the database
  setting — the release script never reads a secret. It is read only.
- **After** the release is up, GREEN and (on the canary box) watched, it snapshots again and compares. Trading during the
  release is fine; an earlier event lost or changed, a new dead letter, or a sync backlog that grew past
  `SRE_RECONCILE_MAX_BACKLOG_GROWTH` (default 0) is a **difference**, and the release is rolled back (exit 70).
- **Every attempt** appends one line to `SRE_QG10_LOG` (default `/opt/sre/qg10-evidence.jsonl`) and prints it as
  `release: QG-10 record: {…}`: each of the five checks `verified`, `failed` or `not run`, the differences, and the words
  "evidence for the owner's QG-10 decision". The pipeline copies that line into the run's summary and keeps it as an
  artifact (`qg10-canary-…`, `qg10-demo-…`). It is **evidence, never a decision**: the owner (or the person he names)
  records GO / HOLD / REWORK for QG-10 in the gate register, citing it (QG-12 — silence is not approval).
- A box without a bake (the demo box) records monitoring as `not_run_on_this_box` — the canary box is where a release is
  watched. `SRE_RECONCILE=off` switches the reconcile off; the script says so on every run and the record says
  "not run". Leave it on.

### The QG-10 note on head office's gate register (OB-423)

After writing that line, the release script **posts the same line to head office's gate register**, and it appears on the
**Quality gates** page, under QG-10, as "Release evidence from the release script" — **every attempt of every release,
newest first** (owner's answer, 27 Oct 2026: show all reports), each with its outcome, box, run and attempt, ✓ (all five
verified) or ⚠ (naming what was not), and every difference in words. Nothing is hidden or collapsed into "latest". It is
still evidence, never a decision: QG-10 reads "Not decided" until the owner decides it.

- **Every attempt is its own note** (owner's answer, 27 Oct 2026: keep every attempt). A note is known by four things:
  the **box**, the **release commit**, the **pipeline run** and the **attempt**. The pipeline hands the box its run id
  (`GITHUB_RUN_ID`) and, after the optional signature, the word `attempt=<GITHUB_RUN_ATTEMPT>` — so "Re-run jobs" in
  GitHub is attempt 2, 3, … of the same run and each gets its own note. Run on a CI runner itself with no words, the
  script reads `GITHUB_RUN_ID` / `GITHUB_RUN_ATTEMPT` from its environment. Run **by hand** on the box, the run is
  `manual` and the attempt is the box's own UTC time of that attempt (`local-20261027T101500Z`; shown on the page as
  "by hand on this box, 2026-10-27 10:15:00 UTC") — one deployment runs at a time, so two attempts never share it.
- **Who may post it:** only a computer's own **QG-10 machine login**, role `qg10_release_evidence` — **one machine login
  per computer** (owner's answer, 27 Oct 2026). The login's user id names its computer: `qg10-release-<host name>`, where
  the host name is exactly what `hostname` prints on that box (it is the `box` in the line). That role can do exactly one
  thing — add a QG-10 release note. It cannot read the register, decide a gate or touch any other record. Head office
  refuses (403) a note from anyone else (the owner and the managers included), a note from **another computer's login**
  (`qg10_note_names_another_computer` — box A's login can never post box B's note), and a login that names no computer
  (`qg10_login_names_no_computer`); a note that is not exactly the script's QG-10 line (400, every problem named); and a
  **different** note claiming an attempt already recorded (409 — the first stands; nothing is overwritten or deleted).
  The same attempt's note sent again is "already recorded" (idempotent).
- **Settings** (in `/opt/sre/deploy.conf`, none of them secret): `SRE_QG10_REGISTER_URL` — head office's address (default
  `SRE_API_URL`, because on the pilot box head office is the box itself; https, or this box's own loopback only);
  `SRE_QG10_PUSH_TOKEN_FILE` — the **path** of the key file (default `/etc/sre-pilot/qg10-push.token`).
- **The key** — each computer's QG-10 machine login secret — is set by the custodian, **Mr Sivakumar** (the named IT
  custodian who also holds `RELEASE_SIGNING_KEY` and sets `FINDINGS_PUSH_TOKEN`; owner's answer, 27 Oct 2026, OB-423), at
  deploy time, and lives **only** in that file on that box: owned by the
  deploy user, `chmod 600`. Never in `deploy.conf`, the repository, an image, a chat, an e-mail or a log. The release
  script hands the tool only the file's path; the key travels only in the request's Authorization header and is never
  printed. Nothing about it goes into the CI pipeline: GitHub never sees this key.
- **What you will see in the release log**, one line, every release:
  - `release: QG-10 note posted to head office's gate register (release <sha>, box <name>, run <run>, attempt <n>).`
  - `release: QG-10 note already on head office's gate register …` — the same note was there already.
  - `release: QG-10 note NOT POSTED to head office's gate register … — <why>` — no key file, an empty one, head office
    not reachable, the key refused, the login belonging to another computer, or a different note already there for this
    release attempt. **The release still runs**; the line is still in `SRE_QG10_LOG` on the box (P-08: said, never
    silent).

#### The custodian's steps (Mr Sivakumar) — once per computer that runs releases

Every computer that runs `release.sh` (the canary box, the demo box, each real box) gets **its own** login and its own key.
Never copy one computer's key to another: head office would refuse that computer's notes by name.

1. **Read the computer's name** on that box: `hostname`. Call it `<box>`.
2. **Ask for that computer's grant** (an administrator, not the owner): on head office, `POST /v1/identity/grants` with
   `{ grantId, userId: "qg10-release-<box>", roleId: "qg10_release_evidence", branchScope: "all", reason: "OB-423 QG-10
   machine login for <box>" }`. The **owner approves** it (`POST /v1/identity/grants/<grantId>/approve`). The user id is
   a machine's, never a person's: head office refuses to give this role to anyone with a sign-in, or to give that user
   any other role.
3. **Issue the key out of band** on the administrator's own computer:
   `node scripts/issue-store-token.mjs --user qg10-release-<box> --tenant <shop id> --no-store`. It is shown once.
4. **Put it on that box** at deploy time: `sudo install -m 600 -o <deploy user> /dev/stdin /etc/sre-pilot/qg10-push.token`
   and paste it, then end with Ctrl-D. Nothing else holds a copy — not the repository, not GitHub, not a chat.
5. **Check the next release says posted** (with its run and attempt), and that the Quality gates page shows the note
   under QG-10 with this computer's name.
6. **If the key is lost or leaked**, the box is rebuilt or renamed, or before it expires: remove that computer's grant (its
   old key stops working at once), issue a new one (steps 1–4), and record a leak as an incident (below). Other
   computers' logins are not affected.

## Signed releases (WF-20, AID-08 "sign releases")

- **What is signed:** three lines that pin a merged commit exactly — `sre-release-v1`, `commit=<sha>`, `tree=<tree id>`
  (git's digest of every file). `scripts/release-signing.mjs sign <sha>` signs them with Ed25519.
- **The private key** is held by the release-signing custodian — **the named IT custodian, Mr Sivakumar** (owner
  decision OB-342, 24 Oct 2026, in writing) — and lives ONLY as the GitHub secret `RELEASE_SIGNING_KEY` (a PEM made
  with `openssl genpkey -algorithm ed25519`). Never in the repository, a settings file, an image, a chat, an e-mail or
  a log. With no secret, the build says *NOT SIGNED* on every merge and carries on — a missing secret never fails the
  build, and the demo keeps updating.
- **The build:** every run self-tests the signer with a throwaway key; on a merge to main it signs the commit and keeps
  `manifest.txt` and `signature.txt` as the `release-signature` artefact. If the public key is committed at
  `infra/deploy/release-signing.pub`, the build also checks its own signature against it. The signature (a public value,
  not a secret) is handed to the canary and full-rollout jobs, which pass it to `release.sh` as the **4th argument**
  (`release <sha> <actor> <run> <signature>`); with no signature they say *NOT SIGNED* and send three words.
- **The box:** put the PUBLIC key on the box and set `SRE_RELEASE_PUBKEY=/opt/sre/release-signing.pub` in
  `/opt/sre/deploy.conf`. From then on `release.sh` deploys only a release whose signature verifies, checked with
  `openssl` over the lines the box rebuilds from its own fetch, before the backup or anything else: unsigned or not
  verifying → exit **77**, the box untouched. A box without the setting deploys either way and says *release signature
  NOT CHECKED* on every run — and whether the release *arrived signed* or *arrived NOT SIGNED*.

### The custodian's steps (Mr Sivakumar) — once, in this order

1. **Make the key pair** on the custodian's own computer, never on a shared one:
   `openssl genpkey -algorithm ed25519 -out release-signing.key` and
   `openssl pkey -in release-signing.key -pubout -out release-signing.pub`.
2. **Put the private key in the GitHub secret store**: repository Settings → Secrets and variables → Actions → New
   repository secret, name `RELEASE_SIGNING_KEY`, value the whole content of `release-signing.key`. Then keep the key
   file offline (an encrypted USB drive in the office safe) and delete every other copy. Never paste it anywhere else.
3. **Check the next merge says signed**: in the build's summary for the next merge to main, the security-scans job says
   *Release … signed*, and the deploy steps say *(signed)*. The demo box log says *NOT CHECKED … the release arrived
   signed*. If it still says *NOT SIGNED*, the secret's name is wrong.
4. **Commit the PUBLIC key** (`release-signing.pub`, which is not a secret) at `infra/deploy/release-signing.pub`
   through a pull request, so the build checks its own signature against it.
5. **Only then turn the check on at each box**: copy `release-signing.pub` to `/opt/sre/release-signing.pub` and add
   `SRE_RELEASE_PUBKEY=/opt/sre/release-signing.pub` to `/opt/sre/deploy.conf` — the canary box first, then the demo
   box. The next release log says *release signature verified*. Before step 3 shows *signed*, do NOT set it: every
   release would be refused (safely, exit 77, the box untouched).
6. **If the key is lost or leaked**: make a new pair (step 1), replace the secret (step 2), commit the new public key
   (step 4), replace the box's public key (step 5), and record it as an incident (below). Releases signed with the old
   key are then refused by the box.

## When something went wrong — the incident record (WF-20, M35-FR-04)

A person with the alerts permission (the owner, a store manager, the platform administrator) records it at head office:
open it (`POST /v1/platform/incidents/<id>` with a title, severity sev1–3, what is known, the alert ids that fired and
the release commit), add what happened when (`…/timeline`), what will change and who owns it (`…/actions/<id>`), write
the post-mortem (`…/postmortem`: cause, impact, what to change), then close it (`…/close`). It closes only once the
post-mortem exists, and the person who closes it is recorded by their own sign-in. Nothing on it is ever edited or deleted.

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
