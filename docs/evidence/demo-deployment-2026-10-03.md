# Demo deployment — executed by the administrator, verified by evidence (3 October 2026)

_The handover `docs/runbooks/demo-deployment-handover.md` was executed step by step by the administrator (the owner) with the
build session guiding over chat. Everything below is what the administrator saw and sent back, the box's address replaced by
`<box>`; no key, password or token passed through the build session. Decision context: OB-10 (Option 1, the administrator
executes) and OB-11 (Option 3, deploy `main` now)._

## What is deployed

| Item | Value |
|---|---|
| Commit on the box | `2f9714cdc91b45be0b7f7ce237046aa2e058a0e8` (`main`, PR #679) — replaced `c49073a7…` (PR #678), the box's checkout since step G |
| Deployed by | the pipeline, run 37125939387, job "Deploy the merged release to the demo box", merged by `rchezhian81-prog` |
| The box's own words | `release: DEPLOYED 2f9714c… (replaced c49073a…) … The stack is up and the stand-up check is GREEN.` · stand-up check 5/5 |
| Release log (`/opt/sre/releases.log`) | `… result=rollback_failed sha=c49073a… previous=c49073a… run=37120682570` (first attempt, see below) · `… result=deployed sha=2f9714c… previous=c49073a… run=37125939387` |
| Migrations | `apply 0012_row_level_security.sql` · `apply 0013_tenants.sql` · `Done — 13 migration(s) checked, 2 applied.` |
| Containers | api (healthy), db (healthy), demo-login, edge, edge-relay, proxy, web up; migrate exited 0 |

## Step K — what is actually running (administrator's output)

| Check | Result |
|---|---|
| `git -C /opt/sre/app rev-parse HEAD` | `2f9714cdc91b45be0b7f7ce237046aa2e058a0e8` |
| `curl http://127.0.0.1:8081/readyz` | `{"live":true,"ready":true,"detail":"live and ready","probe":"readyz"}` |
| `https://<box>/customer/` | `200` (a headers-only request answers `405` from the edge's screen server — not a fault; the sheet now says so) |
| `https://<box>/v1/floor/indents` | `401` — the API refuses an unauthenticated call by name |
| `https://<box>/pos/` | `302` → `/login/?next=/pos/` — the staff screens are behind the demo sign-in (ADR-0016 on ADR-0018) |
| `https://<box>/login/` | `200` — the demo sign-in page, with the DEMO / PILOT banner in English and Tamil (browser screenshot seen) |

## Step L — the deployed-workflow smoke (administrator's output)

`Deployed-workflow smoke — ALL STEPS PASSED (16/16)` · API `http://127.0.0.1:8081` · tenant `368d0d84-5a6d-4032-b16e-025c34344948` ·
run `10031349` · checkout `2f9714cdc91b45be0b7f7ce237046aa2e058a0e8` · `2026-10-03T13:49:06.906Z` · report `/opt/sre/smoke-2026-10-03.json`
on the box · `EXIT=0`. The two lines that answer the owner's question: _the cashier takes the float and SELLS one by barcode … ₹480
banked; floor 9_ and _an eligible RESALE return … floor back to 10_.

## What went wrong on the way, and what changed because of it

| Step | What the box showed | Cause | Now |
|---|---|---|---|
| E | `sre_pilot_app` was `Superuser … Bypass RLS`; `ALTER ROLE … NOSUPERUSER` → `The bootstrap user must have the SUPERUSER attribute` | the application login WAS the database's bootstrap user | `sre_app` created as the limited application login, every table/sequence handed over (tables first — a linked sequence moves with its table), `DATABASE_URL`/`APP_DB_USER` switched; `sre_pilot_app` stays the administrator. Written into step E. |
| J (first attempt) | `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` → `ROLLBACK FAILED` on the same commit | pnpm asked a yes/no with no terminal | `release.sh` exports `CI=true` (#679); the fix deployed itself — the first self-deployment |
| K | `proxy` `Restarting`, public address `000`, stand-up check GREEN | `SRE_PUBLIC_HOST=localhost, 127.0.0.1, ` — the address never typed in step F | line filled, `up -d proxy`; the release script now checks the public front after the stand-up check (`SRE_FRONT_URL`) and says NOT HEALTHY |
| L | `getaddrinfo ENOTFOUND db` | the settings name the database as the containers see it | ran against a temporary copy with `127.0.0.1`; the smoke now translates `db` itself (`scripts/lib/database-url-from-the-host.ts`) |

## Still pending

- ~~The owner's click-through after sign-in~~ — **done the same evening:** the owner signed in (login `owner1`, made by him on the box to replace the forgotten 28 September one) and the till opened; reported by the owner with a screen recording he kept.
- H-14: the five demo products carry units the till cannot price (`each`, `litre`); the seed's keys now follow the data, so the owner's re-run of the seed republishes them (`docs/STATUS.md` for the three commands).
- SP-10 staff/device UAT (`docs/registers/sp10-staff-uat.md`): none performed.
- The 28 September items that stay open: key-only SSH, off-site encrypted backups, a real domain and certificate.
