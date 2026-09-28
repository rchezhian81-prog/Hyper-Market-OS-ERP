# Hosted demo — actual results (MilesWeb VM3, Mumbai)

_Non-production, **synthetic data only**. Reported **separately** from the temporary-machine results in
`DEMO-PILOT-VERIFICATION.md` (owner instruction). Executed on the box by the on-server Claude Code
session following `DEMO-PILOT-STANDUP-RUNBOOK.md`, 27 September 2026._

**Status in one line:** the demo stack is up, HTTPS-only and GREEN on the box; the synthetic data load and
the remaining §9 host checks are in progress; **browser sign-in does not exist yet** (defect H-01, owner
decision required), so human UAT in a browser cannot start.

## Host + release

| Item | Value |
|---|---|
| Host | MilesWeb Managed VPS **VM3** — 2 vCPU / 4 GB / 80 GB, Mumbai, Ubuntu 22.04.1 LTS (order #7709463384) |
| Release | default branch at `e72b4ae` + the stand-up branch `claude/pilot-hosted-standup` (this PR) |
| Toolchain | Node 22.23.3, pnpm 10.33.0, Docker 29.8.1, Compose 5.5.1, PostgreSQL client 16.15 (PGDG) |
| Compose project | `sre-pilot` — `docker-compose.yml` + `docker-compose.pilot.yml`, settings in `infra/compose/.env.pilot` (root-only `0600`, git-ignored, secrets generated on the box, never printed) |
| Tenant | `pilot-demo` (synthetic), `MIGRATION_TARGET_KIND=rehearsal`, `NODE_ENV=production` |
| Demo URL | `https://45.195.229.215/` → `/erp/`; shells at `/pos/ /owner/ /erp/ /picker/ /delivery/ /customer/ /warehouse/ /supplier/`; API at `/v1/` |
| Certificate | self-signed (owner choice — no domain), 180 days to 26 Mar 2027, host path `/etc/sre-pilot/tls/`; SHA-256 fingerprint `32:C5:40:77:F8:39:7B:FE:F7:2B:2F:5B:F9:45:FF:26:52:88:9B:07:84:8F:B6:EF:FC:C3:92:0F:CA:02:2D:5A` |

## Runbook steps

| § | Step | Result |
|---|---|---|
| 1 | Harden | **Partial, by owner instruction.** UFW on: deny incoming by default, allow 22/tcp + 443/tcp. **Password SSH login kept ON** and no `sre` user yet: the owner logs in as root by password and has no SSH key, so key-only would lock him out. Deferred to a later hardening step (see Open items). |
| 2 | Toolchain | ✅ already present on the box (versions above). |
| 3 | Code | ✅ `/opt/sre/app` at `e72b4ae` (= `origin/main`); `pnpm install --frozen-lockfile` clean. |
| 4 | Secrets | ✅ generated on the box (`openssl rand`), hex DB password (URL-safe), 48-byte signing keys; no placeholder left. |
| 5 | HTTPS | ✅ `nginx.pilot.conf` (new): TLS 1.2/1.3 on :443 in the `web` container, `/v1/` proxied to the API, `X-Forwarded-For` **set** from the socket (not appended — the auth lockout keys on it). Probe: TLS 1.3 / `TLS_AES_256_GCM_SHA384`. |
| 6 | Stack + migrate + readiness | ✅ 11/11 migrations applied on the fresh `sre_pilot` DB; API up with 665 routes; `standup:check` **GREEN 5/5**. |
| 7 | Shells with banner | ✅ 8 shells built with `PILOT_DEMO_BANNER=1`. **Defect H-04:** the banner exists only in the ERP shell. |
| 8 | Synthetic seed | Runner built + tested (`pnpm run seed:pilot -- --operator "<name>"`); **run by the owner** (it provisions role grants — a privilege change, hard rule #5 keeps that a human act). First owner run 28 Sep: **RED, 0 steps** — defect H-08, fixed. _Re-run: pending._ Seed enables only `loyalty`, `delivery`, `dept.concession`; payroll bank-file release and bulk publish stay disabled. |
| 9 | Host-specific checks | See below. |
| 10 | Hand over | Pending H-01. |

## Network exposure (verified from the box against the public IP)

| Port | Reachable from the network? |
|---|---|
| 443 (HTTPS) | yes — the only one |
| 80, 8080 (plain HTTP) | **no** (8080 is loopback-only, for `standup:check`) |
| 8081 (API direct) | **no** (loopback-only; reached only via `/v1/` over HTTPS) |
| 5432 (database) | **no** (loopback-only) |
| 22 (SSH) | yes (UFW allow; password login still on — owner instruction) |

Unauthenticated `GET /v1/…` over HTTPS → **401** `unauthenticated`, "Nothing was changed".

## §9 host-specific checks

| # | Check | Result |
|---|---|---|
| 1 | Authenticated browser workflows | ⛔ **blocked by H-01** — there is no browser sign-in. |
| 2 | RBAC + tenant isolation (live) | _pending seed_ |
| 3 | Restart + persistence | _pending seed_ |
| 4 | Offline / reconnection + concurrent tills | _pending seed + edge token_ |
| 5 | Monitoring + test alert | ⛔ needs the named incident owner + alert channel (G10) |
| 6 | Backup → restore into clean DB | _pending seed_ |
| 7 | Deployment rollback | _pending — will pause for owner approval before any redeploy/restore over the running demo_ |

## Defects found on the host (policy: `PILOT-GATES.md`)

| ID | Sev | Defect | State |
|---|---|---|---|
| H-01 | **P1** | **No browser sign-in existed.** The API accepts only `Authorization: Bearer` tokens; the shells call it with the session cookie (`credentials: 'same-origin'`) and never send a token; nothing issues a browser session (the test IdP is a test library, not a running service). So no role can use a shell against the live API. `KNOWN-LIMITATIONS.md` KL-01 ("staff/portal login works with test credentials") is therefore inaccurate for browsers. | **Built (owner decision A)** — DEMO-ONLY `infra/pilot/demo-login` (pilot overlay only; refuses to start outside the demo tenant; scrypt-hashed personal logins; throttle; HttpOnly+Secure+SameSite=Strict cookie → Bearer on `/v1/` only; single-factor, so step-up routes still refuse). Unit 18 + guardrail 5. Live: wrong password 401, cross-site 403, forged cookie 401. **Full successful browser sign-in per role: pending the seed.** |
| H-02 | P2 | The base compose file publishes the web port on **all interfaces**; on an internet-facing host that is plain HTTP, and Docker-published ports bypass UFW. | **Fixed** for the pilot: overlay `!override` → loopback + 443 only; guardrail `tests/guardrails/pilot-host-exposes-only-https.test.ts` (9). Base kept (a store LAN needs it). |
| H-03 | P2 | The `edge` container restart-loops when neither a cloud nor a lane/screen port is configured: `startEdge` returns with nothing holding the process, it exits 0, Docker restarts it. | Open. Mitigated on the demo by configuring edge→cloud sync (needs the seeded store login). |
| H-04 | P2 | The DEMO / NOT PRODUCTION banner was compiled into the ERP shell only. | **Fixed** — all 8 shells mount it from `PILOT_DEMO_BANNER`; `tests/unit/demo-banner-every-shell.test.ts` (16) builds each bundle and proves on-for-demo / off-for-production; verified live on all 8. |
| H-05 | P3 | `secret-scan` walks every file on disk, including git-ignored ones, so it always fails on a configured box (it flags the real `.env.pilot`, which cannot be committed). `pnpm run check` therefore cannot be green on any deployed host. | Open — scanner not changed on the box; committed content scanned from a clean export instead. |
| H-06 | P3 | `BOOTSTRAP_OWNER_*` are not passed to the `api` container by compose, so the documented genesis-owner-by-env does nothing in the compose stack. | Open (the seed's genesis hook covers the demo). |
| H-07 | P3 | Runbook §5 refers to "the repo's nginx TLS block", which did not exist. | Fixed — `infra/compose/nginx.pilot.conf`. |
| H-08 | **P1** | **The demo tenant id was `'pilot-demo'`, but the ledger's `tenant_id` is `uuid` (ADR-0003).** Every in-memory test accepted it; the first seed of the real demo DB failed RED on step one (`invalid input syntax for type uuid`), then every route 500'd. | **Fixed** — `PILOT_DEMO_TENANT = de300000-0000-4000-8000-000000000001` (label `pilot-demo`); box `.env.pilot` updated. Proven on a throwaway real PostgreSQL 16 (whole dataset ×2, all steps land) and the old id reproduces the failure; UUID-shape test always runs. Demo DB was untouched (0 rows). |
| H-09 | P2 | The demo sign-in mounted its login FILE; logins are replaced atomically, and a single-file bind mount keeps the old inode, so new logins were never seen. | **Fixed** — directory mount `/etc/sre-pilot/demo-login/`; guardrail asserts it. |
| H-10 | P2 | With the self-signed certificate, browsers refuse to register the shells' service worker ("SSL certificate error when fetching the script"), so **offline mode cannot be demonstrated in a browser** on this host. | Open — consequence of the no-domain choice; a real certificate (domain) removes it. |
| H-11 | **P1** | **Screens get identity + data only from the store-edge screen server** (ADR-0004: `window.<screen>Data` injected at `<!--SCREEN-DATA-->`, loopback-only). Served statically from the cloud front, every screen boots without identity/permissions and shows its sample / "told me nothing" view — even after a valid sign-in. The live `/v1` calls (ERP pages, supplier portal) also gate client-side on injected permissions. | **Open — owner decision** (options in STATUS). The demo sign-in (H-01) is necessary but not sufficient for browser UAT. |

## Open items (not done, and why)

- **Key-only SSH + non-root `sre` user** — deferred by owner instruction (no SSH key yet).
- **Encrypted off-site backups** — destination/retention not chosen; `db:backup` output on the box is unencrypted and says so.
- **Human UAT** — blocked by H-01.
