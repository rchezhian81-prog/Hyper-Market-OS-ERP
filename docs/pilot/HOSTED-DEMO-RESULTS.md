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
| 1 | Authenticated browser workflows | **Sign-in + access: ✅ all 7 roles** (28 Sep, `pnpm run check:browser`, headless Chromium over the live HTTPS URL; evidence + screenshots in `/var/lib/sre-pilot/evidence/browser-check/`). **Screens show no live shop data: ⛔ H-11.** See the table below. |
| 2 | RBAC + tenant isolation (live) | _pending seed_ |
| 3 | Restart + persistence | ✅ **28 Sep 07:22 UTC.** Whole `sre-pilot` stack stopped (site unreachable) and started: ready in ~14 s; ledger **68 events, max seq 68, content fingerprint `1eb109c4…` identical before/after**; 45 idempotency keys identical; `standup:check` GREEN 5/5. Docker + containerd enabled at boot; every demo container `unless-stopped` (edge deliberately stopped until connected). Server itself not rebooted (would drop the owner's SSH session). |
| 4 | Offline / reconnection + concurrent tills | ✅ **28 Sep 08:08 UTC, `pnpm run drill:offline` GREEN** (owner option A: synthetic machine login `pilot-store-edge`, role cashier, provisioned by the owner's seed run — grant recorded `approvedBy pilot-seed:Chezhian`; store token issued on the box straight into `.env.pilot`, never displayed). Real till code → real lane socket (loopback inside the edge container) → real edge. Cloud API **stopped**; two tills rang at the same moment, then a third sale: **3/3 durably committed at the edge in 2.3 s; cloud held 0**. API restarted after ~23 s offline: edge's own sync loop banked **all 3, exactly once, 115 s after reconnect**. Replay of a sale to the lane: "already recorded … nothing was written again"; cloud still **3 events / 3 distinct**. Edge dead-letter logs empty; `standup:check` GREEN with the box syncing. An earlier attempt (script bug: missing new-sale step, drill stopped itself and restarted the API) still left 2 offline sales from two lanes, each banked exactly once — kept as evidence. In a browser, offline remains blocked by the self-signed certificate (H-10). |
| 5 | Monitoring + test alert | ✅ **Confirmed end to end (28 Sep): the incident owner received both the DOWN and the UP email.** Owner created the Healthchecks.io check and saved the ping URL on the box (28 Sep 08:45 UTC); scheduled probes reported OK every 5 min (HTTP 200). **TEST ALERT `/fail` at 11:03:38 UTC → HTTP 200; all-fine probe at 11:03:47 UTC → HTTP 200.** Delivery confirmed by the owner. (Owner option A, 28 Sep.) Incident owner: **Chezhian (rchezhian81@gmail.com)**. `infra/pilot/health-probe/probe.mjs` runs every 5 min (systemd `sre-pilot-health.timer`, enabled) and checks the MONITORING-AND-ALERTS watch-list: services running, `standup:check`, edge dead letters, unsent sales not draining > 30 min, disk ≥ 85 %, audit chain. All OK → ping; any failure → `/fail` with the plain-English list; box down → Healthchecks emails after the grace period. Proven live: all 6 green; with the demo sign-in stopped it reported "PROBLEM — 1 of 6 checks failed … not running: sre-pilot-demo-login-1". Ping URL is a credential: root-only `/etc/sre-pilot/healthchecks-url`, never in git/output; report body redacted. Healthchecks.io Hobbyist plan: $0/month, 20 checks (pricing page read 28 Sep). Unit tests 11. |
| 6 | Backup → restore into clean DB | ✅ **28 Sep 07:23 UTC.** `db:backup` → `bk-2026-09-28T07-23-00-932Z` (sha256 `60d40a09…`, 8 tables: event_ledger 68, audit_log 201, idempotency_keys 45, schema_migrations 11) in `/var/lib/sre-pilot/backups` (root-only dir; **unencrypted**, not off-site). Restored into a separate throwaway PostgreSQL 16: **reconciles exactly**; ledger fingerprint `1eb109c4…` identical to live; audit hash chain **intact** (201 records; tenants = demo 120, the owner's failed first seed 45 under the old id, unauthenticated probes 36 — all kept, hard rule #6). Second restore over the non-empty target **REFUSED** without `--force`. Throwaway DB removed. |
| 7 | Deployment rollback | ✅ **28 Sep 07:37–07:45 UTC, owner option A (no restore over live).** Pre-drill backup `bk-2026-09-28T07-37-38-185Z`. Previous release `e72b4ae` built in a separate worktree (`/opt/sre/rollback-e72b4ae`; API image `sre-pilot-api:rollback-e72b4ae`, 8 shells). Compatibility: `services/ edge/ packages/ db/migrations/ infra/docker/` byte-identical `e72b4ae`..HEAD; the previous build's own migrator on the live demo DB → **11 checked, 0 applied**. **Rollback: 4 s** (API recreated on the old image; shells swapped — banner back to 1 of 8, as that release had) → ledger fingerprint `1eb109c4…` unchanged, `standup:check` GREEN, `/erp/` 200, `/login/` 200, `/v1` unauthenticated 401. **Roll forward: 3 s** → current image, banner 8 of 8, fingerprint unchanged, GREEN; full browser check green again (7 roles, 20/20 bridged page visits). Images kept for a real rollback: `sre-pilot-api:current-12f7d8b`, `sre-pilot-api:rollback-e72b4ae`. Note: the host config (HTTPS front, demo sign-in) stayed in place — rolling it back would re-expose plain HTTP (H-02). |

## §9.1 browser check — results (28 Sep 2026, after the owner's GREEN seed: 68 ledger events, demo tenant)

No session → `/v1/identity/me` **401**. Wrong password → **401**, no cookie. For every role, through the real sign-in page:

| Role (demo user) | Screen | Signed in | Cookie | Banner | `/v1/identity/me` | Out-of-role read | After sign-out |
|---|---|---|---|---|---|---|---|
| owner | /owner/ | ✅ | HttpOnly · Secure · SameSite=Strict | ✅ | 200 (226 perms) | in-role read 200 | 401 |
| store manager | /erp/ | ✅ | same | ✅ | 200 (149) | 403 | 401 |
| cashier | /pos/ | ✅ | same | ✅ | 200 (20) | 403 | 401 |
| accountant | /erp/finance.html | ✅ | same | ✅ | 200 (31) | 403 | 401 |
| chartered accountant | /erp/ | ✅ | same | ✅ | 200 (4) | 403 | 401 |
| platform admin | /erp/admin.html | ✅ | same | ✅ | 200 (25) | — | 401 |
| supplier | /supplier/ | ✅ | same | ✅ | 200 (2) | 403 | 401 |

**What the screens show (H-11):** none of the seven screens made a live `/v1` call; the manager screen reads
"Not known — this screen has not received that list from the store yet" (trading day 1970-01-01), finance /
admin / supplier say "Sample data — this is not your shop", the till is empty with no catalogue. Identity,
permissions and data reach the screens only from the store-edge screen server (ADR-0004), which the cloud
front does not provide. So: **authentication and authorisation are proven in a browser; working through a
role's actual workflow on screen is not yet possible on this host.** Temporary `check.*` logins were
created in memory for the run and removed afterwards (login file empty again).

## §9.1 identity bridge — live pages in a browser (28 Sep 2026, option A)

| Role | Bridged pages opened | Identified as the person | Live `/v1` reads |
|---|---|---|---|
| owner | operations, data-quality, workforce, integration-health, risk-acceptance, stored-value, production, facilities, checklist, return-governance, ess (11) | 11/11 | all 200 |
| store manager | rostering, loss-prevention, cash-office, stock-health, goods-receipt, day-reopen, data-io (7) | 7/7 | all 200 (stock health: 5 reads) |
| cashier | stock-health (out of role) | 1/1 | all **403** → "You do not have permission to see stock health." |
| supplier | supplier portal | 1/1 | statement + submissions 200 |

Screenshots per role + page: `/var/lib/sre-pilot/evidence/browser-check/`. The injected permissions only
decide what a screen offers; the API re-checks every read (the cashier row proves it).

## Defects found on the host (policy: `PILOT-GATES.md`)

| ID | Sev | Defect | State |
|---|---|---|---|
| H-01 | **P1** | **No browser sign-in existed.** The API accepts only `Authorization: Bearer` tokens; the shells call it with the session cookie (`credentials: 'same-origin'`) and never send a token; nothing issues a browser session (the test IdP is a test library, not a running service). So no role can use a shell against the live API. `KNOWN-LIMITATIONS.md` KL-01 ("staff/portal login works with test credentials") is therefore inaccurate for browsers. | **Built (owner decision A)** — DEMO-ONLY `infra/pilot/demo-login` (pilot overlay only; refuses to start outside the demo tenant; scrypt-hashed personal logins; throttle; HttpOnly+Secure+SameSite=Strict cookie → Bearer on `/v1/` only; single-factor, so step-up routes still refuse). Unit 18 + guardrail 5. Live: wrong password 401, cross-site 403, forged cookie 401. **Browser sign-in verified for all 7 roles (28 Sep).** |
| H-02 | P2 | The base compose file publishes the web port on **all interfaces**; on an internet-facing host that is plain HTTP, and Docker-published ports bypass UFW. | **Fixed** for the pilot: overlay `!override` → loopback + 443 only; guardrail `tests/guardrails/pilot-host-exposes-only-https.test.ts` (9). Base kept (a store LAN needs it). |
| H-03 | P2 | The `edge` container restart-loops when neither a cloud nor a lane/screen port is configured: `startEdge` returns with nothing holding the process, it exits 0, Docker restarts it. | **Mitigated on the demo** (28 Sep): edge now syncs to the cloud with a lane socket — running, 0 restarts. The underlying behaviour for an unconfigured edge remains open. |
| H-04 | P2 | The DEMO / NOT PRODUCTION banner was compiled into the ERP shell only. | **Fixed** — all 8 shells mount it from `PILOT_DEMO_BANNER`; `tests/unit/demo-banner-every-shell.test.ts` (16) builds each bundle and proves on-for-demo / off-for-production; verified live on all 8. |
| H-05 | P3 | `secret-scan` walks every file on disk, including git-ignored ones, so it always fails on a configured box (it flags the real `.env.pilot`, which cannot be committed). `pnpm run check` therefore cannot be green on any deployed host. | Open — scanner not changed on the box; committed content scanned from a clean export instead. |
| H-06 | P3 | `BOOTSTRAP_OWNER_*` are not passed to the `api` container by compose, so the documented genesis-owner-by-env does nothing in the compose stack. | Open (the seed's genesis hook covers the demo). |
| H-07 | P3 | Runbook §5 refers to "the repo's nginx TLS block", which did not exist. | Fixed — `infra/compose/nginx.pilot.conf`. |
| H-08 | **P1** | **The demo tenant id was `'pilot-demo'`, but the ledger's `tenant_id` is `uuid` (ADR-0003).** Every in-memory test accepted it; the first seed of the real demo DB failed RED on step one (`invalid input syntax for type uuid`), then every route 500'd. | **Fixed** — `PILOT_DEMO_TENANT = de300000-0000-4000-8000-000000000001` (label `pilot-demo`); box `.env.pilot` updated. Proven on a throwaway real PostgreSQL 16 (whole dataset ×2, all steps land) and the old id reproduces the failure; UUID-shape test always runs. Demo DB was untouched (0 rows). |
| H-09 | P2 | The demo sign-in mounted its login FILE; logins are replaced atomically, and a single-file bind mount keeps the old inode, so new logins were never seen. | **Fixed** — directory mount `/etc/sre-pilot/demo-login/`; guardrail asserts it. |
| H-10 | P2 | With the self-signed certificate, browsers refuse to register the shells' service worker ("SSL certificate error when fetching the script"), so **offline mode cannot be demonstrated in a browser** on this host. | Open — consequence of the no-domain choice; a real certificate (domain) removes it. |
| H-12 | P1 | Every real-browser sign-in was refused 403: the sign-in pages inherited `Referrer-Policy: no-referrer`, under which Chrome posts the form with `Origin: null`, which the cross-site check refuses. (curl, sending a real Origin, passed.) | **Fixed** — sign-in pages use `same-origin`; nginx `/login` no longer inherits the server header. Unit + guardrail tests; live browser check green. |
| H-13 | **P2 — owner decision** | **A banked sale does not reduce stock on hand.** `bankSale` appends `SaleCommitted` + `ReceiptNumberIssued`; on-hand / stock value fold `InventoryMoved` only (`services/api/src/adapters.ts`). Sales-derived figures (turns, days of cover, GMROI, sales history) do move. Found while writing ADR-0016. | Open — needs a roadmap check (inventory depletion by sale) and an owner decision; not changed. |
| H-11 | **P1** | **Screens got identity + data only from the store-edge screen server** (ADR-0004, loopback). Served from the cloud front, every screen booted without identity and showed its sample / "told me nothing" view, even after a valid sign-in. | **Mitigated for 19 pages (owner decision A, 28 Sep).** DEMO-ONLY identity bridge (`infra/pilot/demo-login/screen-bridge.ts`): the HTTPS front replaces `<!--SCREEN-DATA-->` with a classic script from `/login/screen-data.js`, which verifies the session and injects ONLY `{ userId, permissions }` read from the live `GET /v1/identity/me` — the same shape the store edge injects for these pages; no business data. 18 ERP pages + the supplier portal then read their own data live from `/v1`. Browser check: 20/20 bridged page visits identified, all live reads 200; the cashier on stock health gets 403 from the API and "You do not have permission". **Still sample-only (need the store edge):** ERP home/manager, finance, admin, buying, catalogue, reporting and the other edge-fed pages; POS, owner, picker, delivery, warehouse, customer shells; day-reopen is read-only (its Reopen posts to the store box). Tests: `tests/unit/demo-identity-bridge.test.ts` (28, incl. drift vs the edge's GLOBAL_FOR and marker-before-bundle for every bridged page) + guardrail. |

## Hardening (owner option B, 28 Sep 2026)

| Item | State |
|---|---|
| Non-root operator `sre` | ✅ created (uid 1000; groups `sudo`, `docker`; password locked until the owner sets it; empty `authorized_keys`). Note: uid 1000 is also the demo sign-in container's user, so the login-hash files show as owned by `sre` on the host — `sre` is an administrator anyway. |
| Key-only SSH, no direct root login | ⏳ **waiting for the owner's public key + `passwd sre` + confirmation of the provider's emergency console.** Password login and root login deliberately still ON until the new way in is proven from a second window. |
| Encrypted backups on the box (**option C**: off-site deferred until before real data) | ✅ `infra/pilot/backup/encrypted-backup.sh`: plain dump only in RAM (`/dev/shm`), `age`-encrypted to the PUBLIC key in `/etc/sre-pilot/backup-recipient.txt` (`age1xhedncczxcl40q6wae99w5mlgth3ehcdz9r5szhsusztc8r95aqqul4de7`); the box cannot decrypt. Nightly systemd timer (20:00 UTC / 01:30 IST); run once under systemd OK. Proven: restore with the owner key into a throwaway DB **reconciles exactly** (84 events, SaleCommitted ₹312.70); a different key cannot decrypt; the file is not readable as a dump. The two earlier plain backups were encrypted, verified by checksum, then shredded — **4 encrypted, 0 plain** on disk. Guardrail `pilot-backup-is-encrypted` (5). **Private key: copied off by the owner (28 Sep, confirmed "key saved") and shredded from the box; a search of the box found no other copy; a backup taken afterwards encrypted normally (6 encrypted, 0 plain).** The owner's copy is now the ONLY way to restore — its restorability is to be proven with a restore drill using that copy before any real data (Option 2). |

## Demo store box (ADR-0016, 28 Sep 2026) — in progress

| Part | State |
|---|---|
| ADR | ✅ `docs/adr/0016-demo-store-edge-on-the-hosted-demo.md` (DEMO ONLY; production edge unchanged). |
| Edge screens on (still loopback) + relay | ✅ `EDGE_SCREEN_PORT` 8097 bound 127.0.0.1 in the edge; `edge-relay` (nginx, `network_mode: service:edge`, no published port). |
| Sign-in gate | ✅ `/store/…` needs a valid demo session; `/store-lane/…` also needs `pos.sale.sync` (API-checked). Live: no login → `/store/pos/` 302 to sign-in; lane POST 401; forged cookie refused; ports 8095/8096/8097 not reachable from the network. |
| Till, demo build | ✅ `PILOT_DEMO_LANE_BASE=/store-lane` (build-time); production build proven unchanged (`tests/unit/pos-demo-lane-base.test.ts`). |
| Price list published to the demo tills | ⏳ **Owner to run.** Owner chose option A: the command `pnpm run demo:publish-pack -- --operator "<name>"` is written but **not run by the AI** (a price release — hard rule #5; the on-box approver had blocked the first attempt). Writing its test exposed a seed gap: the demo branch had **no store price-list entries**, so the pack came out empty (`empty_pack`, every product `no_price`). Fixed: the seed's catalogue step now adds store-scoped price-list entries through the real price gate; proven in-memory (pack contains the demo products; the store-box machine login is refused publish, 403) and on a throwaway real PostgreSQL. The owner must **re-run the seed, then publish**. |
| Price list picked up by the demo box | ✅ owner re-ran the seed (store prices) and published (all GREEN); the edge adopted **catalogue v1 at 15:28 UTC** (signature verified, saved to disk). |
| Store pack for the edge screens (owner option A, 28 Sep) | ⏳ **owner to run** `pnpm run demo:store-pack -- --operator "<name>"`. The edge's screens read a local STORE PACK the product never delivers (audit's biggest gap). Demo-only builder `db/seed/pilot/store-pack.ts`: products from the published pack (+ category from the product master, on-hand from the stock ledger); **no cost** (not in the published pack → sales "uncostable", not a false margin); no other section invented. Proven through the edge's own `readPack` + till payload (all 5 demo prices exact). Mounted read-only (`EDGE_PACK_FILE`); read at edge start-up. |
| Day-close redirect (owner option A) | ✅ the relay rewrites the edge-injected `window.laneWriteBase` from the loopback lane to `/store-lane` (seller-gated); verified: via relay `"/store-lane"`, direct on the box unchanged. |
| Till login + fake sale walkthrough | ⏸ after the store pack. |

## Open items (not done, and why)

- **Key-only SSH + non-root `sre` user** — deferred by owner instruction (no SSH key yet).
- **Off-site backups** — deferred by the owner (option C) until before real data (Option 2); on-box backups are now encrypted. No retention/deletion policy yet (nothing is deleted).
- **Human UAT** — blocked by H-01.
