# Owner gap summary — using the new system day-to-day alongside the existing ERP

**Date:** 28 September 2026
**Status:** Prepared for the owner after the hosted demo of 28 Sep 2026.

Your question: *"I want to use this day-to-day in the hypermarket, in parallel with my existing ERP (the old billing and stock program) — are there any gaps in the requirements?"*

Short answer: the written requirements are essentially complete (99%). The gaps are not missing requirements; they are things only your shop can supply — data, hardware, staff sign-off, outside partners, one person reconciling daily. Nothing found is confirmed broken — one stock question (H-13, section 4) is still open — but much is unproven.

## If you read nothing else

1. **Nothing is broken.** Most of the software is built and 7,849 automatic tests pass on the demo server — but **0% has been tried by your staff in your shop.** That is the real gap.
2. **Running the new system alongside your old ERP is the project's own plan.** The old ERP stays the official record; you can always fall back to it.
3. **The gaps are things only you can supply:** your real data, store hardware, staff testing and sign-offs, outside accounts (most can wait in mirror mode), and **one named person reconciling the two systems every day.**
4. **One honest surprise:** the tool that loads your real data in bulk **does not exist yet** — your developer must build and test it first (weeks, not days). Details in the companion plan.
5. **Two decisions are yours now** (section 7): how to run in parallel (**Decision P**) and whether to start real-data preparation (**Decision L**). Silence is not approval.

## 1. The honest picture in two numbers

Three different things are measured below: how much has been written down, how much has been built, and how much has been proven in a real shop.

**Built:** 144 requirement rows — 140 built, 4 partly built, 0 not started (this counts the 144 detailed requirement rows; the 104-item ladder below counts differently) — about 97%, counted 5 August 2026.

**Proven:** how far each of the roadmap's 104 main items has climbed, from "code written" to "used in your shop" (figures dated 24–25 September 2026):

| Rung | Result | Plain meaning |
|---|---|---|
| Overall progress score | 55.7% | how far the code has climbed overall |
| Connected to a real screen | 44 of 104 (42.3%) | the rule is connected to a real screen or service |
| Proven by a test in a browser | 26 of 104 (25.0%) | a real browser drove it through the real server and database |
| Tried by your staff | 0 of 104 (0.0%) | your staff tried it in your shop and signed off (the project calls this UAT — user acceptance testing) |
| Used for real | 0 of 104 (0.0%) | run with real data, money and customers |

**0% tried by staff and 0% used for real means "not yet proven by your staff in your shop", not "broken".** Only you and your staff can move those rungs.

## 2. Your plan — run alongside the existing ERP — is the designed plan

The project's own words:

> "**Reversible:** the legacy system keeps running **in parallel** — it is **not retired**. Every pilot day is reconciled against it." (PILOT-READINESS-PACKAGE)

In plain words: your old billing program keeps running; every day, the two systems' figures are compared; if anything goes wrong you simply keep trading on the old one.

Roadmap control MG-10: "Parallel run — operate old + new for approved period; reconcile daily." Rollback trigger: a fault not fixable the same day, or an unexplained daily difference — you keep trading on the old system.

## 3. What stands between here and a safe parallel run

**(1) Your real data.** The demo server is required to hold only one made-up data set, the synthetic "tenant" `pilot-demo` (a tenant is one company's walled-off data inside the system; the stand-up runbook allows synthetic data only, confirmed at the 28 Sep 2026 hosted stand-up). It has no connection to your existing ERP and will not get one during the parallel run: data leaves the old system only as files that you or your operator export from a sealed copy (your decision OB-06), and our tools work only on those files. Loading real data is "Option 2", not yet approved in writing. Several software pieces are still missing (companion plan, section 4). The two that stop any load today: the Import & export screen's commit step only writes a log entry — no products or prices are created — and nothing yet describes how to create the separate real-data area or load into it (the pilot plan says the department's products and prices are "loaded with the import tools", but that import does not yet create them). Also still to build: the signed opening-figures page and the daily comparison record for the parallel run. *Who acts:* you (the written GO; a half-day with your CA — chartered accountant — to settle product categories, tax rates and settings; gathering bank statements, GST (Goods and Services Tax) returns and supplier statements); your developer (builds and tests the loading tool — none exists today); a named person you appoint runs every load and every price release to the tills; the AI only prepares and checks files and never loads, publishes or releases anything. [OB-06, KL-09, M30, MG-01–MG-09, UAT-02, UAT-50/51, G4]

**(2) Store hardware and the one-PC till.** Scanners, printers, scales, drawers: started, not in hand. The single-computer till can now be installed with one command and started with one click (KL-08 closed 29 Sep 2026, Stage D — `docs/runbooks/in-store-install.md`); a technician still has to run it on the shop PC; the shelf-edge and picker screens need a small computer inside the shop to run them (H-11 — reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge; see §4b). *Who acts:* you (nothing is purchased without your approval); your developer. [EX-09, KL-10, KL-08, H-11]

**(3) Outside accounts.** Card-payment company, GST filing account (with your CA), SMS/WhatsApp sender, Tally link (your accounting software), and a paid AI service. **If the new system only mirrors the old one (Decision P, option A), all of these can wait**: the existing ERP keeps taking money, filing GST and messaging customers for real; the new system runs them in test mode. Only the card-payment company (EX-03) becomes mandatory once a till takes real card/UPI money; GST filing, messaging, Tally and live AI stay deferred (EX-04–EX-07, EX-12). *Who acts:* you; your CA. [EX-03, EX-04, EX-05, EX-06, EX-07, EX-12, KL-01–KL-04, KL-07]

**(4) Sign-offs.** Staff testing not yet started (checkpoint G8 — the project calls each checkpoint a "gate"); the paid outside security test has started, not finished; your CA must sign the opening finance and tax totals; each shop licence needs its certificate and a named responsible person; the customer "delete my data" process needs a lawyer's confirmation; four approval roles (product owner, store operations lead, finance/CA reviewer, security/architecture reviewer) have no name against them yet. *Who acts:* you, CA, staff, lawyer. [G8, EX-13, KL-14, UAT-09, UAT-52, EX-08, KL-06]

**(5) Security items for production.** Payroll approve/lock/bank-file release and bulk or sensitive-category product publish **stay DISABLED** until the extra "prove it is really you" step is built and tested for them (GAP-SEC-06 follow-on). Seven security and data-safety items from the August review are still marked open; some have since been worked on, so the developer must re-check them, not redo them (list in the appendix). Separately, switching the server to a safer, key-based sign-in (no shared password) is ON HOLD by your decision and must be done before any real data goes on (reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge). *Who acts:* your developer; you. [GAP-SEC-02..06, GAP-DATA-01/02/06, GAP-ARCH-01]

**(6) The human daily-reconciliation role.** Risk R-05 is open: nobody has been given the job of running the side-by-side period. The project papers call this the most common point where a switch-over to a new system fails, and it fails for want of people, not software. Gate G10 needs a named incident owner and a daily reconciliation signed before end of day; no reconciliation sheet exists yet. *Who acts:* you (name the person, fund temp help, set a maximum parallel duration). [R-05, G10, MG-10]

## 4. Two things you asked about

**(a) "A sale does not reduce stock."** The project papers say the opposite: the stock rule M08-FR-01 requires on-hand to be worked out from an append-only list of movement events, and the M08 ledger note says "the movements are appended by POS/receiving/write-off"; stock movements are switched on for the pilot. (The failure drill "no oversell / no negative stock" is about order reservations never exceeding on-hand — it does not exercise a till sale.) On the demo, a till sale did not reduce on-hand stock on the stock screen, while sales history, stock turns and days of cover did update; logged as H-13, pending a roadmap check before any change (reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge). Not resolved either way here.

**(b) "Screens show sample data."** A data-loading step, not a fault: the demo runs on made-up data until your real products, prices and suppliers are approved and loaded by a named person. Also, 19 office pages show the demo data after sign-in, but the shop-floor screens show fixed sample pictures until a small computer inside the shop is set up to run them, H-11 (reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge).

## 5. What is already done

- **The daily trading path works in test mode:** sell, take payment, print receipt, handle a return, close the day; products, prices, offers and loyalty; stock moves, transfers, counts and write-offs; purchase order, goods-in and invoice matching; cash office; reports you can open in Excel; a log of every action that cannot be altered afterwards. 26 items proven in a browser test (appendix).
- **Anything that could cost money is switched off by default:** real GST filing, real payroll and bank payments, the AI acting on its own (its emergency stop is ON), real card payments, permanent loading into the live system. "Delete my data" for a real customer is gated — two people must approve, and the person who carries it out must pass the extra "prove it is really you" step — not a switch that is off, and in the pilot it runs only against made-up customer data.
- **Stand-in connections only:** payments, GST, SMS/WhatsApp, Tally and AI all run against test versions; the real ones can be connected later without rebuilding.
- **Hosted demo outcomes** (reported from the 28 Sep 2026 hosted stand-up; evidence on branch claude/pilot-hosted-standup, pending merge): 7,849 automatic tests pass on the server; each of the 7 demo roles sees only its own screens; after a restart the system was back in about 14 seconds with every record unchanged; a backup was restored into an empty database and matched; going back to the previous version and forward again both worked; six health checks run every 5 minutes and the alert emails arrived; the DEMO banner in English and Tamil shows on all 8 apps.

## 6. The short path to a safe parallel run

1. **You** decide Decision P and Decision L (section 7) in writing; name the daily reconciler and the incident owner (R-05, G10).
2. **Step 1 — real-data preparation** (companion plan `docs/pilot/STEP-1-REAL-DATA-PLAN.md`): the settings sitting with your CA; your staff export the data from the old program after taking a sealed copy and writing down the row counts; every file passes the completeness checker; bank, GST and supplier statements gathered. A named person runs every load; the AI only prepares and checks.
3. **Developer builds the missing pieces (loader, real-data area, signed page, daily comparison record), each with tests:** the import must actually create products and prices (today it only records the attempt) in the separate rehearsal tenant — never `pilot-demo`, never production — rehearsed at least twice on the isolated environment first. A named person runs each load; you and staff check that row counts in equal row counts out (UAT-50/51).
4. **You** buy the hardware; **your developer** packages the single-computer till, sets up the shop computer, does the server sign-in switch and answers H-13 in writing (EX-09, KL-08, H-11).
5. **Your staff** test on your real catalogue (G8); **your developer** rehearses going back to the old version on the real server (G9); **you and the daily reconciler** agree the daily comparison sheet; then run mirror days (both systems, old one in charge — see Decision P) until you have the agreed number of clean days in a row.
6. **You** hold a review day: if every agreed condition is met, you give the written pilot GO; then a separate production GO (OA-8) before live card/UPI settlement (EX-03), live GST filing (EX-07 with your CA) and customer launch (EX-13 penetration test). Real quiet-hours trading with cash real and card in test mode is already inside the pilot plan and needs the pilot GO, not these three.

## 7. Decisions needed from you

**Decision P — how to run in parallel.**
- *A — Mirror mode:* every sale is rung on the old till as now, then keyed or scanned into the new system as well; the old ERP's figures remain the official ones. No live payment or GST needed; zero customer risk; costs staff time.
- *B — Real quiet-hours trading in one department, as the pilot plan is written (`docs/runbooks/pilot-plan-narrow-deep.md`):* cash is real-flow; card/UPI go through the test-mode stand-in (OA-4); GST is calculated but not filed; real hardware (EX-09) is needed. Live payment (EX-03), GST credentials (EX-07) and the penetration test (EX-13) are not prerequisites — the plan says none of them blocks a test-mode pilot; they gate full production and customer launch. It does need your written pilot GO (OA-8), your real catalogue in the separate real-data area (never the demo server, which holds made-up data only) and the server sign-in switch from section 3(5). Faster proof; a fault touches real customers and real cash.
- *C — Wait* until UAT and hardware are complete. Safest; the 0% rungs cannot move without staff use.

**Decision L — start preparing real data now?**
This is the same choice as Decision D3 in the companion plan (`docs/pilot/STEP-1-REAL-DATA-PLAN.md`), which also asks Decision D0 (where the real-data copy lives) and Decision D4 (when to give the written GO). That plan offers a wider menu — whole catalogue, or one department first — and recommends one department first. Answer it there, once.
- *A — Yes, now:* you sign a written Option 2 GO for a controlled copy of one department's products and prices into a separate, walled-off practice area only — a new tenant that is not `pilot-demo`, on its own database and storage, marked rehearsal (never production), with no connection to your existing ERP. The GO must name that environment and tenant, name the person who runs the load, and state that `pilot-demo` is untouched. Preparation (exports, checks, CA sitting) starts at once; the load itself waits until your developer has built and tested the loader — weeks, not days.
- *B — After H-13 is resolved and hardware ordered:* a few weeks' delay; avoids loading twice if the stock finding changes the design.
- *C — Not yet:* the demo stays synthetic; nothing moves.

Silence is not approval: nothing starts until you write the choice down.

## 8. What you should check, and how

1. **Look for the banner** on any demo page: "DEMO / PILOT — NOT PRODUCTION" in English and Tamil.
2. **Try a wrong password** at the demo login, then sign in as a cashier and open an owner page; both must be refused.
3. **Ask your developer for the H-13 answer in writing:** which roadmap clause says a till sale reduces on-hand stock, and does the code do it.
4. **Confirm nothing real is on the server:** ask your developer to sign in beside you and show the tenant list — the only entry must be `pilot-demo`; then open the integrations page and confirm every payment, GST, Tally and SMS/WhatsApp connection reads sandbox/mock/off (test mode); then ask "is this server connected to our existing ERP in any way?" — the answer must be no. If a second data area exists before your written GO, stop.
5. **Check where the off-site backup copy is kept and who holds the credentials to it:** ask your developer to show you the latest backup manifest — its `offsiteLocation` entry (`BACKUP_OFFSITE`) says where the copy is, and its `encrypted` entry records whether the storage layer encrypts it. Then find the "down" and "up" alert emails from the 28 September demo in your inbox, and check the incident owner is written down — the demo notes name you (Chezhian) for the demo monitoring, but pilot checkpoint G10 still needs your written naming for the shop.

## Developer appendix — bucket → IDs → source documents

| Bucket | IDs | Source documents |
|---|---|---|
| Headline figures | 104 items; ladder counts 1 not started (MG-10, the parallel run) · 1 engine only (WF-19) · 58 partly wired · 7 wired · 11 integration tested · 26 end-to-end verified · 0 UAT · 0 production; 55.7% (JSON note; readiness page still prints 55.4% — 55.7% is fresher, after two re-ratings on 24 Sep) ; 42.3%; 25.0%; 0.0%; 99.0%; 144/140/4 | docs/completion-status.json:5-9; docs/readiness-to-go-live.md:16-33,49-51; docs/backlog.md:8-13; docs/STATUS.md:1276-1277 |
| E2E-verified items | M05, M06, M07, M08, M09, M10, M11, M12, M14, M15, M17, M24, M25, M26, M28, M30, M32, M33, M34, A06, A08, A10, WF-10, MG-04, MG-06, MG-11 | docs/completion-status.json items[] |
| Parallel run is the plan | MG-10, G10, rollback trigger; second quotation "Rollback target for the pilot: the existing legacy billing/ERP process, kept running in parallel" | docs/pilot/PILOT-READINESS-PACKAGE.md:30-41; docs/pilot/KNOWN-LIMITATIONS.md:28; docs/pilot/MIGRATION-AND-ROLLBACK.md:48-65; docs/requirements/index.md:156 |
| (1) Real data | OB-06, EX-02 CLOSED, KL-09, G4, Option 2 unapproved, M30-FR-01, MG-01–MG-09, UAT-02, UAT-50/51/52/55; import commit writes audit record only; no tenant-creation procedure (in-store-install uses a `<your tenant id>` placeholder); pilot plan "loaded with the import tools"; companion plan §4 items 1–6 (loader, templates, tenant, signed page, witness routes, parallel-day record) | docs/registers/decisions.md:33; docs/registers/external-dependencies.md:23; docs/STATUS.md:53-54; services/purchase/src/data-import.ts:170,181; services/api/src/adapters.ts:5192-5216; docs/runbooks/pilot-plan-narrow-deep.md:36-37; docs/runbooks/in-store-install.md:42,80,137; docs/pilot/STEP-1-REAL-DATA-PLAN.md:15,27,142-150,244-260,264-271,292; docs/runbooks/pilot-deployment.md:208-209; docs/runbooks/extraction-work-plan.md; docs/runbooks/legacy-self-extraction.md:332-346; docs/requirements/data-requirements.md:96-190; scripts/extract-check.mts:7-15 |
| (2) Hardware / one-PC till | EX-09, KL-08, KL-10, H-11 | docs/registers/external-dependencies.md:30; docs/pilot/KNOWN-LIMITATIONS.md:15,17; hosted stand-up notes (branch claude/pilot-hosted-standup) |
| (3) Outside accounts | EX-01, EX-03 (blocking at Stage 9 for live tender only), EX-04, EX-05, EX-06, EX-07, EX-12 (Deferred regardless of tender mode); KL-01–KL-04, KL-07; OA-4 | docs/registers/external-dependencies.md:22-35; docs/pilot/KNOWN-LIMITATIONS.md:8-14; docs/pilot/PILOT-FEATURE-MATRIX.md:22-36; docs/OWNER-ACTION-REGISTER.md:137 |
| (4) Sign-offs | G8, G9, EX-13, KL-14, UAT-09, UAT-52, UAT-53, UAT-11, EX-08, OC-19, UAT-04, KL-06, chartered_accountant role; blank named approvers = product owner, store operations lead, finance/CA reviewer, security/architecture reviewer ("Name required") | docs/pilot/PILOT-GATES.md:23-27,44-46; docs/registers/external-dependencies.md:29,34; docs/pilot/KNOWN-LIMITATIONS.md:13,21; docs/runbooks/store-go-live-checklist.md:200-232; services/api/src/roles.ts:241; docs/registers/decisions.md:74-82; docs/OWNER-ACTION-REGISTER.md:98 |
| (5) Security for production | Still open in the August register (re-check, not rebuild — newer traceability records work on several): data-request routes (GAP-SEC-02), audit-chain strength (GAP-SEC-03), rate limiting (GAP-SEC-04), database transactions and tenant isolation (GAP-DATA-01/02), erasure vs append-only store (GAP-DATA-06), thin services (GAP-ARCH-01); GAP-SEC-05; GAP-SEC-06 follow-on (payroll bank-file + bulk publish DISABLED); GAP-DATA-09 (closed); key-based login ON HOLD | docs/audit/GAP_REGISTER_AND_RISK_REGISTER.md:51-63; docs/pilot/PILOT-FEATURE-MATRIX.md:38-52; docs/pilot/FEATURE-SAFETY.md:17-69; docs/STATUS.md:56-62; docs/traceability.md:47-49,165-178,622; hosted stand-up notes |
| (6) Daily reconciliation role | R-05 (Open), R-19, G10, MG-10 NOT STARTED, WF-19 ENGINE ONLY, docs/cutover empty; Chezhian named incident owner for demo monitoring only (pilot gate still needs written naming) | docs/registers/risks.md:18,32; docs/pilot/PILOT-GATES.md:23-27; docs/traceability.md:314,337; docs/cutover/README.md:9-10; packages/migration/src/cutover.ts:67-212; docs/pilot/STEP-1-REAL-DATA-PLAN.md:207 |
| (a) Stock finding | H-13; M08-FR-01 (on-hand projected from append-only movement events); M08 evidence note ("the movements are appended by POS/receiving/write-off"); `bankSale` appends `SaleCommitted` only while availability projections fold `InventoryMoved`; drill "no oversell / no negative stock" concerns OMS reservations, not till sales; stock movements ON | docs/requirements/M08.md:9,20; docs/completion-status.json (M08 evidence); services/api/src/adapters.ts:1923,2127,2172,4442,4513; docs/pilot/FAILURE-DRILLS.md:22,34-39; docs/pilot/PILOT-FEATURE-MATRIX.md:11-24; hosted stand-up notes |
| (b) Sample data | pilot-demo seed (PILOT_DEMO_TENANT); Option 2; H-11; runbook rule "synthetic/demo data only" | docs/pilot/PILOT-SEED-DATASET.md:3-7,26-31; docs/pilot/DEMO-PILOT-STANDUP-RUNBOOK.md:8-15; db/seed/pilot/dataset.ts:29,92,204,321; hosted stand-up notes |
| Already done | ON / SIMULATED / DISABLED lists; default-safe tests; 26 E2E items; "Delete my data" execution gated (RBAC + two-person rule + subject verification + API-tier step-up), not a default-off flag; synthetic PII only in the pilot | docs/pilot/PILOT-FEATURE-MATRIX.md:11-52; docs/pilot/FEATURE-SAFETY.md:17-24,32-38; docs/pilot/FAILURE-DRILLS.md:4-5,41-55; docs/pilot/KNOWN-LIMITATIONS.md:13 |
| Hosted demo outcomes | 7,849 tests; 7 roles; ~14 s restart / 68 records; backup+restore (manifest `encrypted` from `BACKUP_ENCRYPTED`, `offsiteLocation` from `BACKUP_OFFSITE`; encryption at rest is the storage layer's — no owner-held key is defined); rollback to e72b4ae; 6 checks / 5 min; 8 app shells; 19 live-data pages; ADR 0016 | 28 Sep 2026 hosted stand-up notes; docs/pilot/HOSTED-DEMO-RESULTS.md (server branch claude/pilot-hosted-standup only, pending merge); scripts/backup.mjs:40-43; docs/pilot/BACKUP-RESTORE-REHEARSAL.md:58; docs/pilot/SAFE-PILOT-ENVIRONMENT.md:35 |
| Decisions | OA-8 (pilot GO vs production GO), Option 2 GO, R-05, G10; pilot plan §6 "None of these blocks a test-mode pilot" (EX-03 "Pilot runs in test mode without it"; EX-07 "calculates GST but does not file"; EX-13 "before customer launch"); companion plan Decisions D0/D3/D4 | docs/OWNER-ACTION-REGISTER.md:141; docs/runbooks/pilot-plan-narrow-deep.md:36-42,135-144,194-204; docs/registers/external-dependencies.md:17-18,24,28,34; docs/pilot/STEP-1-REAL-DATA-PLAN.md:264-271; docs/STATUS.md:53-54; docs/registers/risks.md:18 |
| Register inconsistencies to fix (docs only) | OA-2 still cites EX-02 as blocking; uat-calendar "28 items" vs workbook OC-01…47; migration-exceptions register cites AVR-03; db/seed README stale; readiness page 55.4% vs JSON 55.7%; PILOT-FEATURE-MATRIX lists "delete my data" execution as DISABLED while FEATURE-SAFETY says gated, not default-off | docs/OWNER-ACTION-REGISTER.md:135; docs/registers/uat-calendar.md:19; docs/runbooks/pilot-setup-workbook.md:15-16; docs/registers/migration-exceptions.md:7-9; db/seed/README.md:3-7; docs/readiness-to-go-live.md:8-10; docs/pilot/PILOT-FEATURE-MATRIX.md:43-44 vs docs/pilot/FEATURE-SAFETY.md:32-38 |

Not included anywhere in this document, by rule: the server address, any password, key, token or monitoring ping URL.

## Sources

- docs/completion-status.json (committed 25 Sep 2026) — maturity labels, 104-item denominator, 55.7% note, M08 evidence note
- docs/readiness-to-go-live.md (24 Sep 2026) — six-score table, weights, "cannot reach 100% alone", 1 April 2027 anchor
- docs/backlog.md (5 Aug 2026 count) — 144 / 140 / 4
- docs/audit/GAP_REGISTER_AND_RISK_REGISTER.md (2026-08-09; touched 26 Sep) — GAP-SEC/DATA/ARCH rows
- docs/traceability.md (25 Sep 2026) — MG-10 NOT STARTED, WF-19 ENGINE ONLY, GAP-tagged rows
- docs/registers/risks.md, decisions.md, external-dependencies.md, uat-calendar.md, migration-exceptions.md
- docs/OWNER-ACTION-REGISTER.md (25 Sep 2026)
- docs/pilot/KNOWN-LIMITATIONS.md, PILOT-FEATURE-MATRIX.md, FEATURE-SAFETY.md, FAILURE-DRILLS.md, PILOT-READINESS-PACKAGE.md, PILOT-GATES.md, PILOT-SEED-DATASET.md, MIGRATION-AND-ROLLBACK.md, DEMO-PILOT-STANDUP-RUNBOOK.md, BACKUP-RESTORE-REHEARSAL.md, SAFE-PILOT-ENVIRONMENT.md
- docs/runbooks/pilot-plan-narrow-deep.md, pilot-setup-workbook.md, legacy-self-extraction.md, extraction-work-plan.md, cutover-weekend.md, store-go-live-checklist.md, pilot-deployment.md, in-store-install.md
- docs/requirements/M08.md, M30.md, data-requirements.md, index.md; docs/architecture/migration-design.md; docs/cutover/README.md
- services/purchase/src/data-import.ts; services/api/src/adapters.ts; services/migration/src/index.ts; packages/migration/src/*; services/api/src/roles.ts; scripts/extract-check.mts; scripts/backup.mjs; db/seed/pilot/dataset.ts
- docs/STATUS.md entries of 24–27 Sep 2026
- 28 Sep 2026 hosted stand-up session notes (evidence on branch claude/pilot-hosted-standup, pending merge; results in docs/pilot/HOSTED-DEMO-RESULTS.md on that branch)
- Companion: docs/pilot/STEP-1-REAL-DATA-PLAN.md (prepared alongside this summary)
