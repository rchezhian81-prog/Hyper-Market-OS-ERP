# Fresh full roadmap re-audit, 30 Oct 2026: Lane 2

**Slice:** M10 to M18 (every FR in `docs/requirements/M10.md` to `M18.md`), WF-06 to WF-10, QG-05 to QG-08, MG-01 to MG-06, addendum A14 to A29 and B1 to B12 (79 rows).
**Repository:** `main` at `5c84f4c7`. This check was read-only; this file is the only change.
**Sources:** `CLAUDE.md`; the roadmap text (`roadmap-v2.0.docx`, extracted); `docs/roadmap/roadmap-v2.1-addendum.md`; `docs/requirements/M10.md` to `M18.md` and `docs/requirements/workflows/WF-06.md` to `WF-10.md`; `docs/registers/decisions.md` (OB-295 to OB-303, OB-325/326, OB-328/329, OB-332/333, OB-383/387/397/399 and OB-500 to OB-610). `docs/traceability.md` was used only to find code; every status below comes from reading the code path and the test assertions. The 23 Oct lane-2 table gave only the row list and the format.

**Method.** I re-read every row, including rows marked DONE before. For each row I read the code path and checked that a named test's assertions match the roadmap wording and the owner's decisions. I also checked that each office screen in this slice calls only routes that exist. The screens checked were the expiry/recall, recall-trace, order refunds, quotations, loyalty, investigations, customers, production, facilities (quality release), day book, bill findings and shelf tags screens. Each `/v1/...` path they call was matched against every `path:` registered in `services/` and `edge/`. No screen calls a route that does not exist.

**Tests run** (PostgreSQL on, `DATABASE_URL=postgres://postgres@localhost:5432/audit_lane_2`, so the real-database legs ran):

| set | files | tests | result |
|---|---|---|---|
| Every unit, integration and guardrail file named by the slice's trace rows | 292 | 2,635 | 2,632 passed, 3 failed. All 3 failures were the 5-second timeout while the machine ran four lanes at once (load average 15 on 4 cores): `tests/guardrails/a-real-trading-bill-is-never-above-the-mrp-total.test.ts`, the real-PostgreSQL legs of `tests/integration/a-repeat-order-is-placed-on-its-days-and-paused-or-cancelled-by-the-customer.test.ts` and `tests/integration/the-store-box-keeps-offline-work-and-books-it-once.test.ts`. All three passed when re-run alone (6 + 6 tests). |
| Migration and gate files (MG-01 to MG-06, QG-06, QG-08, WF matrix guardrail, A25) | 29 | 414 | 413 passed. 1 skipped: `opening-load-at-store-volume.test.ts`, which runs only when `GT05_STORE_VOLUME` is set; CI does not set it. |
| Same migration set, verbose (to find the skip) | 45 | 630 | 629 passed, 1 skipped (the same opt-in file) |
| Delivery-job integration (OB-299) | 3 | 18 | all passed |
| Browser (`vitest.e2e.config.ts`): every e2e file the slice's trace rows name | 47 | 130 | all passed |
| Performance (`vitest.perf.config.ts`): `pos-hot-path`, `sync-and-endurance`, `catalogue-search-p95`, `checkout-api-p95` | 4 | 24 | First run under load: 2 failed (Tamil customer search p95 1,166 ms; the lane-cache build hit its 5 s timeout). On a quieter re-run (load 7) all 16 tests in the two failing files passed: customer search p95 at most 707 ms, product master p95 382 ms, checkout p95 14 ms over 300 checkouts. These are CI headroom figures, not certification. |

Statuses: DONE · PARTIAL · MISSING · DECISION · EXTERNAL · DEFERRED (as in the brief). Sizes: S is up to 1 day, M is 2 to 4 days, L is a week or more.

---

## 1. Tables

### M10: Batch, expiry, quality and recall

| id | requirement (short quote) | status | evidence (code + test) | what finishes it | size |
|---|---|---|---|---|---|
| M10-FR-01 | "FEFO … expiry action list … expired stock auto-moves to expired state (not sellable)"; offline at edge | DONE | `packages/fefo/src/fefo.ts`, `services/inventory/src/expiry.ts` (`sweepExpiredBatches`, `/v1/inventory/expiry-sweep`, `/v1/inventory/expired-batches`). The worker wiring is `services/api/src/followups-adapters.ts` `expirySweepThatPublishes`, used at `services/api/src/main.ts:2740`; it re-signs the pack with the expired batches. Offline list: `apps/web-erp/src/expiry-session.ts`. Tests: `tests/integration/store-work-done-offline-is-booked-once-at-head-office.test.ts` (asserts sweep moves once, then `count: 0`, scoped register, 403 for cashier), `tests/integration/an-expired-batch-is-refused-on-its-batch-barcode-offline.test.ts`, `tests/unit/the-pack-carries-the-expired-batches.test.ts`, `tests/unit/fefo.test.ts` | Note: the expired register (`GET /v1/inventory/expired-batches`, "toBin") is read by no screen. This is not a row gap, because the expiry action list screen exists. | — |
| M10-FR-02 | quality status, sampling, cold-chain; "**Offline (§31): evidence captured offline; queued**" | PARTIAL | Temperature/food-safety checks, holds and releases: `services/inventory/src/quality-hold.ts`, `services/platform/src/food-safety.ts`, sync routes `FoodSafetyCheckRecorded` and `QualityHoldReleaseDecided` in `edge/sync-agent/src/http-transport.ts:257-261`. OB-513 (food batch needs a sample): `quality-hold.ts` `sample_required`. Tests: `tests/integration/a-quality-release-reads-the-samples-recorded-on-its-hold.test.ts`, `r7b-an-mrp-not-yet-in-force-and-a-held-food-batch.test.ts`, `a-quality-hold-is-released-at-the-store-offline-and-booked-once.test.ts`, `cold-room-breach-holds-stock.test.ts`, `tests/e2e/a-quality-hold-is-released-at-the-facilities-screen-with-the-line-down.e2e.ts` | **Sample results cannot be captured offline.** `POST /v1/quality/holds/:batchId/samples/:sampleId` is a head-office-only route. There is no box capture and no `EVENT_ROUTES` entry for a sample. The store's release screen (`apps/web-erp/src/quality-release-queue.ts`) only shows samples head office already holds. The relayed release refuses samples in its body (`SAMPLES_NOT_IN_A_RELEASE`). Together with OB-513, this means a held **food** batch cannot be sampled and released with the line down. The offline test records the sample at head office first (`a-quality-hold-is-released-at-the-store-offline-and-booked-once.test.ts:51`). **What finishes it:** a box-durable `QualitySampleRecorded` capture on the facilities screen, an `EVENT_ROUTES` entry to a new `/v1/quality/holds/:batchId/samples/:sampleId/synced` route that re-checks the recorder's `quality.hold.manage` right, and box-side ordering so the sample is relayed before the release. Add a test that samples and releases a food batch with the cable out and books both once. | M |
| M10-FR-03 | trace "backwards and forwards"; "trace queries logged" | DONE | `packages/quality/src/lot-trace-backward.ts`, `services/inventory/src/lot-trace-backward.ts` (`/v1/quality/lot-trace/backward/sales/:saleId`, `/customers/:customerRef`), `services/api/src/lane2-recall-adapters.ts`. Tests: `tests/integration/a-trace-runs-backwards-from-a-sale.test.ts` (403 cashier, 404, FIFO-estimate gaps, ingredient batches, sealed read trail at lines 148-155), `tests/unit/lane2-recall-and-trace-engines.test.ts`, `tests/integration/lot-trace.test.ts` | — | — |
| M10-FR-04 | "recall-block stops POS sale **and ordering**", notify per consent, owner informed, priority sync, closure with evidence | DONE | `services/purchase/src/recall-order-guard.ts` (409 `product_under_recall`), `services/catalogue/src/recall-republish.ts`, `services/customer/src/recall-notices.ts` (OB-297/OB-328 call list; SMS port off), `services/inventory/src/recall-withdrawal.ts` (OB-383/387/397/399). Tests: `tests/integration/a-recalled-product-cannot-be-ordered.test.ts`, `a-recall-blocks-the-offline-till-and-tells-the-owner-at-once.test.ts`, `a-recall-tells-the-customers-who-consented.test.ts`, `a-recall-started-by-mistake-is-withdrawn-only-before-anyone-is-told.test.ts`, `tests/e2e/recalls-and-trace-on-the-production-api.e2e.ts` | The live SMS provider is outside the repo; OB-297 decided "call list now, port off". | — |

### M11: Fresh food and internal production

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M11-FR-01 | recipe/BOM, issue, batch output; "production capture queue-capable" | DONE | `packages/production/src/recipe.ts`, `services/inventory/src/production.ts`, sync route `ProductionRunCaptured` (`edge/sync-agent/src/http-transport.ts:254`), `edge/store-edge/src/store-work.ts`, `apps/web-erp/src/production-queue.ts`. Tests: `tests/integration/the-store-box-keeps-offline-work-and-books-it-once.test.ts`, `production-durability.test.ts`, `tests/e2e/production-works-at-the-counter-with-the-line-down.e2e.ts` | — | — |
| M11-FR-02 | catch weight, yield, loss, costing; "weight capture offline" | DONE | `services/inventory/src/weighed-costing.ts`, sync route `WeighedRunCaptured`. Tests: `tests/integration/weighed-costing.test.ts`, `the-store-box-keeps-offline-work-and-books-it-once.test.ts` | — | — |
| M11-FR-03 | packing, scale labels, shelf life, quality release, **repacking**; "a repack is traceable to its source batch" | PARTIAL | Labels (box-side, offline): `edge/store-edge/src/store-work.ts` `counterLabelFor`, `packages/production/src/packing.ts`, `scale-label.ts`. Release relay: `ProductionReleaseDecided`. Tests: `tests/unit/the-counter-label-is-lawful-before-it-prints.test.ts`, `tests/integration/a-counter-label-carries-its-marks-sizes-and-unit-price.test.ts`, `tests/e2e/production-works-at-the-counter-with-the-line-down.e2e.ts` | **Repacking is not wired.** `repack()` in `packages/production/src/packing.ts:423` is called only by `tests/unit/production.test.ts:349`. No route, ledger move, screen or lot-trace link uses it (`grep -rli repack services apps edge` finds only false hits inside "store-pack"). **What finishes it:** a `POST /v1/production/repacks/:repackId` route that books the source-out/new-batch-in moves with the source's expiry, plus a link in `lot-trace-backward.ts`/`lot-trace-chain.ts` so a recall on the source reaches the repack. Add a button on the production screen and an integration test that recalls a source and finds its repack. The physical label printer and scale remain EXTERNAL (D14). | S–M |
| M11-FR-04 | only confirmed departments enabled | DONE | `packages/production/src/departments.ts`. Tests: `tests/integration/production.test.ts` (`department_not_operated`, `unknown_department`) | — | — |

### M12: POS sales and checkout

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M12-FR-01 | scan/search/weight/display; "scan-to-line p95 ≤ 300 ms on certified pilot hardware — measured and shown"; scale error | EXTERNAL | Telemetry: `edge/store-edge/src/peripheral-health.ts` (per-day log, `scanSpeedOf`). Shown on the till: `apps/pos/src/browser-entry.ts:2114-2135`, `apps/pos/web/app.js` "Scan speed" (EN/TA). OB-302: the weight is never keyed. Tests: `tests/integration/m12-fr-01-the-till-times-every-scan-and-the-box-keeps-it.test.ts`, `tests/unit/m12-fr-01-the-box-keeps-every-scan-time-and-reads-the-p95.test.ts`, `tests/performance/pos-hot-path.test.ts` | Certified pilot hardware run (AVR-06). | — |
| M12-FR-02 | suspend/recall, quotations, receipts, **delivery sales** | DONE | Quotations (OB-506/523/524/525/532/533/542/545/551/602): `services/pos/src/quotations.ts`, `apps/pos/src/quotation-at-till.ts`, `edge/store-edge/src/quotations-at-lane.ts`. Delivery (OB-299): `apps/pos/src/session.ts`, `services/api/src/till-side-adapters.ts` `tillDeliveryOnSale` (one job per sale). Tests: `tests/integration/quotations.test.ts`, `r9a-no-floor-quotes-held-quotations-and-bill-match.test.ts`, `f3-a-quotation-is-rung-only-at-its-store-and-freed-when-nothing-rings.test.ts`, `till-side-head-office-rules-reach-the-till-and-come-back.test.ts`, `tests/unit/till-side-the-till-carries-head-offices-catalogue-rules.test.ts`, `tests/e2e/the-served-till-delivers-a-bill-and-keeps-head-offices-rules.e2e.ts`, `the-served-till-rings-a-quotation-up-by-its-number.e2e.ts` | — | — |
| M12-FR-03 | cash/card/UPI/credit/split; never invent approval; no card data | DONE | `packages/tender/src/`, `services/finance/src/pending-tender.ts`. Tests: `tests/unit/tender.test.ts`, `tests/integration/pending-tender-recovery.test.ts`, `tests/guardrails/card-data.test.ts`, `pos-offline.test.ts` | An integrated provider is outside the repo (OB-511: standalone machines, typed approval number OB-274). | — |
| M12-FR-04 | overrides, age prompts, lane health | DONE | `apps/pos/src/lane-guards.ts`. Tests: `tests/unit/pos-lane-guards.test.ts`, `tests/e2e/the-till-asks-the-age-question.e2e.ts` | — | — |

### M13: Returns

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M13-FR-01 | receipt / controlled no-receipt; offline | DONE | `packages/returns/src/returns.ts`, `services/pos/src/no-receipt-returns.ts`. Tests: `tests/integration/no-receipt-returns.test.ts`, `offline-returns-reach-the-cloud.test.ts`, `tests/e2e/the-served-till-takes-a-refund.e2e.ts` | — | — |
| M13-FR-02 | eligibility, disposition; "recall-blocked item handled per M10" | DONE | `apps/pos/src/till-session.ts:177-188` (pack `blockedBatches`/`expiredBatches` force quarantine). Tests: `tests/integration/a-recalled-unit-returned-at-the-till-is-held-through-the-box.test.ts` (asserts `disposition: 'quarantine', recallHeld: true` though the cashier chose resell), `m13-fr-02-an-expired-batch-returned-at-the-till-is-held-through-the-box.test.ts`, `tests/e2e/the-served-till-holds-an-expired-batch-coming-back.e2e.ts` | — | — |
| M13-FR-03 | exchange, refund method, thresholds | DONE | `packages/returns/src/exchange.ts`, `services/pos/src/exchanges.ts`. Tests: `tests/integration/exchanges.test.ts`, `store-credit-refund.test.ts` | — | — |
| M13-FR-04 | reversal; never invent success | DONE | `packages/reversal/src/reversal.ts`, `services/finance/src/refund-exceptions.ts`. Tests: `tests/unit/reversal.test.ts`, `tests/integration/refund-exceptions.test.ts` | — | — |

### M14: Till, cash office and day close

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M14-FR-01 | till assignment, float, pickup, safe drop, offline | DONE | `packages/cash/src/cash.ts`, `edge/store-edge/src/till-cash.ts`. Tests: `tests/integration/till-cash-reaches-the-cloud.test.ts`, `tests/unit/edge-till-cash.test.ts` | — | — |
| M14-FR-02 | blind count, over/short | DONE | `packages/till/src/till.ts`. Tests: `tests/integration/shift-close.test.ts`, `tests/e2e/the-served-till-closes.e2e.ts` | — | — |
| M14-FR-03 | settlement, exceptions | DONE | `services/finance/src/settlement.ts`. Tests: `tests/integration/settlement-cash-office.test.ts`, `settlement-investigations.test.ts` | Real acquirer statement files are outside the repo. | — |
| M14-FR-04 | close, lock, reopen, **evidence pack** | DONE | Box gate: `edge/store-edge/src/main.ts:2390-2430` (unsent, exceptions, open shifts, pending payments). Pack: `tests/integration/m14-fr-04-a-closed-day-has-a-sealed-evidence-pack.test.ts` (hash, NOT FINAL after reopen, tamper check, CSV, history). Also `tests/unit/m14-fr-04-the-closed-day-evidence-pack.test.ts`, `tests/e2e/the-day-book-downloads-the-closed-day-evidence-pack.e2e.ts` | The CA's signature is outside the repo. | — |

### M15: Loss prevention and fraud

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M15-FR-01 | void/refund/discount/no-sale rules, owner alert | DONE | `packages/loss-prevention/src/loss-prevention.ts`; OB-609 page `apps/web-erp/src/findings-session.ts`. Tests: `tests/integration/loss-prevention-rules.test.ts`, `tests/e2e/a-manager-sees-the-bill-findings-and-attendance-flags.e2e.ts` | — | — |
| M15-FR-02 | coupon/loyalty/delivery/supplier signals that reconcile to source | DONE | `packages/loss-prevention/src/signal-sources.ts` (coupons, points, COD, supplier price vs history), `GET /v1/fraud-signals/stored`, screen `apps/web-erp/src/lp-signals-session.ts`. Tests: `tests/unit/stored-fraud-signals.test.ts` (COD and `supplier_price_out_of_history`), `tests/integration/the-fraud-signals-read-the-shops-own-records.test.ts`, `tests/e2e/the-investigations-page-reads-the-shops-own-records.e2e.ts` | — | — |
| M15-FR-03 | employee purchases, related party, duplicate bank (suppliers/employees) | DONE | OB-301: `packages/restricted-sales/src/staff-purchase.ts`, `edge/store-edge/src/staff-purchase-gate.ts`; `packages/loss-prevention/src/related-party.ts`; `services/purchase/src/related-party-order-guard.ts`. Tests: `tests/integration/a-related-party-order-needs-the-owner.test.ts`, `a-staff-purchase-is-judged-at-the-till-offline-through-the-box.test.ts`, `duplicate-bank.test.ts`, `tests/unit/related-party-controls.test.ts` | — | — |
| M15-FR-04 | cases, evidence preserved, outcome feedback | DONE | `packages/loss-prevention/src/cases.ts`. Tests: `tests/integration/loss-prevention-cases.test.ts` (append-only evidence, outcome required, rule-retirement feedback) | — | — |

### M16: Customer 360 and consent

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M16-FR-01 | one identity, household, verification, reversible merge | DONE | `services/customer/src/customer-360.ts`, `duplicates.ts`. Tests: `tests/integration/customer-duplicates.test.ts` | The SMS provider is outside the repo (OB-222/OB-510; switched off). | — |
| M16-FR-02 | consent per purpose/channel, enforced at send | DONE | `packages/customer/src/consent.ts`, `services/customer/src/campaign-send.ts`. Tests: `tests/integration/the-sender-rechecks-template-and-recipient.test.ts` | — | — |
| M16-FR-03 | access, correction, export, erasure | DONE | `services/customer/src/data-rights.ts`, `erasure-execution.ts`. Tests: `tests/integration/data-rights.test.ts` | — | — |
| M16-FR-04 | segments, CLV, "complaint history visible to service" | DONE | `services/customer/src/customer-overview.ts`, `customers-session.ts`. Tests: `tests/integration/the-customer-record-shows-the-complaints-the-desk-holds.test.ts`, `tests/e2e/the-customer-record-shows-the-desks-complaints.e2e.ts` | — | — |

### M17: Loyalty, membership and gift value

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M17-FR-01 | earn/burn, **tiers, expiry**, reversal, liability | DONE | OB-295: `packages/loyalty/src/tiers.ts`, `points-expiry.ts`, `services/customer/src/loyalty-programme.ts`; till wallet multiplier `packages/loyalty/src/wallet.ts`. Tests: `tests/unit/loyalty-tiers-and-points-expiry.test.ts`, `tests/integration/loyalty-tiers-and-expiry-stay-off-until-the-owner-sets-them.test.ts`, `tests/unit/till-side-the-tier-multiplier-rides-the-wallet-feed.test.ts` | The owner must enter the numbers ("not set" until then). | — |
| M17-FR-02 | coupons, referrals, memberships, **subscriptions**, personalised offers | DONE | Coupons/offers: `services/customer/src/coupons.ts`. Referrals (OB-351): `services/customer/src/referral-programme.ts`. Subscriptions (OB-303): `services/orders/src/storefront-subscriptions.ts`, timer at `services/api/src/customer-commerce-adapters.ts:441`, customer app `apps/customer-app/src/browser-entry.ts:707-717`. Tests: `tests/integration/coupons.test.ts`, `a-referral-rewards-both-sides-once-on-the-first-delivery.test.ts`, `a-repeat-order-is-placed-on-its-days-and-paused-or-cancelled-by-the-customer.test.ts` | Note: the staff list `GET /v1/repeat-orders` (days not placed) is read by no office screen; the customer sees each missed day in the app. | — |
| M17-FR-03 | gift cards, store credit, limits | DONE | `packages/loyalty/src/stored-value.ts`. Tests: `tests/integration/stored-value.test.ts`, `stored-value-liability.test.ts` | — | — |
| M17-FR-04 | household pooling, one balance | DONE | Tests: `tests/integration/household-pooling.test.ts` | — | — |

### M18: Orders and omnichannel

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M18-FR-01 | one lifecycle, serviceable branch | DONE | `packages/orders/src/lifecycle.ts`, `services/orders/src/serviceability.ts`. Tests: `tests/integration/orders-lifecycle.test.ts`, `serviceability-config.test.ts` | — | — |
| M18-FR-02 | reservation, routing, split/partial, backorder | DONE | OB-300 "never split (as built)": `packages/orders/src/fulfilment-plan.ts`; routing `services/fulfilment/src/order-routing.ts`. Tests: `tests/integration/orders-lifecycle.test.ts`, `a-placed-delivery-goes-to-the-branch-head-office-routes.test.ts` | — | — |
| M18-FR-03 | pickup, scheduled/express, dark store | DONE | `packages/orders/src/fulfilment-plan.ts`. Tests: `tests/integration/pick-to-doorstep.test.ts`, `serviceability-config.test.ts` | Road distance (maps) is outside the repo. | — |
| M18-FR-04 | cancel, confirmed substitution, refund by token, refund approval | EXTERNAL | `services/orders/src/payments.ts`; screen `apps/web-erp/src/order-refunds-session.ts`. Tests: `tests/integration/order-payments-and-refunds.test.ts`, `order-substitution.test.ts`, `tests/e2e/the-order-refunds-page-refunds-to-the-token-after-a-second-person.e2e.ts` | Needs a live RBI-authorised gateway (EX-03); a test-mode processor works today. | — |

### Workflows WF-06 to WF-10

Each workflow has a nine-scenario list in `docs/requirements/workflows/WF-0x.md`. The guardrail `tests/guardrails/every-workflow-scenario-points-at-a-real-test.test.ts` passed; it checks that each listed test exists.

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| WF-06 | replenishment | DONE | `docs/requirements/workflows/WF-06.md`; `tests/integration/floor-indents.test.ts`, `floor-indents-synced.test.ts`, `replenishment.test.ts` | — | — |
| WF-07 | stock transfer incl. cancellation and offline | DONE | `services/inventory/src/warehouse-transfers.ts`, sync routes `TransferDispatchRecorded`/`TransferReceiptRecorded`. Tests: `tests/integration/a-transfer-is-cancelled-before-it-leaves-and-relayed-offline.test.ts`, `the-store-box-keeps-offline-work-and-books-it-once.test.ts`, `tests/e2e/warehouse-handheld-transfers-with-the-line-down.e2e.ts` | — | — |
| WF-08 | stock count | DONE | `tests/integration/a-stock-count-is-planned-frozen-recounted-approved-and-booked.test.ts`, `a-count-sent-from-the-phone-whose-reply-is-lost-is-counted-once.test.ts` | — | — |
| WF-09 | expiry/recall | DONE | As M10-FR-01/03/04; `tests/integration/a-recall-runs-its-whole-lifecycle-on-postgresql.test.ts`, `a-recall-closure-re-sent-is-one-closure.test.ts` | — | — |
| WF-10 | POS sale | DONE | `tests/integration/the-store-trades-a-day.test.ts`, `sale-idempotency.test.ts`, `tests/e2e/the-store-trades-a-day.e2e.ts`, `tests/guardrails/pos-offline.test.ts` | Staff run on a real lane (SP-10) is outside the repo. | — |

### Quality gates QG-05 to QG-08

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| QG-05 | scan p95 ≤300 ms certified; search p95 ≤1 s; checkout p95 ≤2 s; 72 h; drain | EXTERNAL | `tests/performance/pos-hot-path.test.ts`, `catalogue-search-p95.test.ts`, `checkout-api-p95.test.ts`, `sync-and-endurance.test.ts` (all passed on a quiet re-run; see header) | Certified pilot hardware. | — |
| QG-06 | zero open critical/high; pen test | EXTERNAL | `packages/compliance/src/risk.ts` (`GATE_BLOCKING_SEVERITIES = critical, high`), `packages/compliance/src/findings.ts`; CI Semgrep, Trivy, ZAP, pnpm audit → `scripts/scan-findings.mts` (`.github/workflows/ci.yml:56, 308, 408-435`). Tests: `tests/unit/compliance-risk.test.ts`, `compliance-findings.test.ts`, `tests/integration/scanner-findings-and-gate-decisions-are-recorded.test.ts` | Independent penetration test; the owner names the security reviewer (OB-330). | — |
| QG-07 | control totals signed | EXTERNAL | `packages/migration/src/reconcile.ts`. Tests: `tests/integration/every-figure-has-a-witness-through-the-api.test.ts`, `the-old-shop-arrives-whole.test.ts` | Real legacy data and the CA. | — |
| QG-08 | restore, recovery, rollback, escalation rehearsed | EXTERNAL | `packages/ops/src/recovery-gate.ts` (OB-332 quarter expiry), `services/platform/src/dr-readiness.ts`. Tests: `tests/unit/ops-recovery-gate.test.ts`, `tests/integration/a-recovery-rehearsal-pass-expires-after-a-quarter.test.ts`, `recovery-rehearsal.test.ts`, `a-rehearsed-rollback-reconciles.test.ts`, `backup-is-one-moment.test.ts` | The rehearsals on the store computer with the incident team. | — |

### Migration controls MG-01 to MG-06

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| MG-01 | discovery | DONE | `packages/migration/src/discovery.ts`. Tests: `tests/unit/migration-discovery.test.ts`, `tests/integration/migration-pipeline.test.ts` | Running it on the old ERP is outside the repo. | — |
| MG-02 | preservation, hashes, chain of custody | DONE | `packages/migration/src/extraction.ts`, `load.ts`. Tests: `tests/unit/migration-load.test.ts`, `migration-preservation-route.test.ts`, `tests/integration/we-get-it-out-ourselves.test.ts` (PG) | — | — |
| MG-03 | mapping approval | DONE | `packages/migration/src/mapping.ts`. Tests: `tests/unit/migration-mapping.test.ts`, `migration-mapping-route.test.ts` | — | — |
| MG-04 | cleaning | DONE | `packages/migration/src/cleaning.ts`. Tests: `tests/unit/migration-cleaning.test.ts`, `tests/integration/migration-decisions-through-the-api.test.ts` | — | — |
| MG-05 | repeatable full-volume trial loads | DONE | `packages/migration/src/trial.ts`, `load-command.ts`. Tests: `tests/unit/migration-trial.test.ts`, `tests/integration/the-whole-load-runs-from-one-command.test.ts`; the store-volume file `opening-load-at-store-volume.test.ts` runs only with `GT05_STORE_VOLUME` set, and CI does not set it (see section 4) | The trial on the real extract is outside the repo. | — |
| MG-06 | reconciliation by domain | DONE | `packages/migration/src/reconcile.ts` and the `*-verification.ts` files. Tests: `tests/unit/migration-reconcile.test.ts`, `migration-tax-verification.test.ts`, `migration-loyalty-verification.test.ts`, `tests/integration/every-figure-has-a-witness-through-the-api.test.ts` | — | — |

### Addendum A14 to A29

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| A14 | RCM self-invoice (OB-143 off) | DONE | `packages/finance/src/rcm.ts`. Tests: `tests/integration/rcm-self-invoice-is-gap-free-and-cash-only.test.ts` | The CA's heads list is outside the repo. | — |
| A15 | GSTR-1/3B matched to sales | DONE | `packages/finance/src/gstr3b.ts`. Tests: `tests/integration/gstr3b-matches-the-sales-ledger.test.ts` | Portal filing is outside the repo. | — |
| A16 | 3B locked to filed GSTR-1 | DONE | Tests: `tests/guardrails/gstr3b-liability-cannot-be-edited-after-gstr1-is-filed.test.ts` | — | — |
| A17 | GSTR-2B/IMS ITC | DONE | `packages/input-tax/src/gstr2b.ts`. Tests: `tests/integration/itc-claims-only-accepted-2b-lines.test.ts`, `tests/e2e/the-itc-review-page-meets-the-spec.e2e.ts` | — | — |
| A18 | GSTR-9/9C | DONE | `packages/finance/src/gstr9.ts`. Tests: `tests/integration/gstr9-and-9c-fold-from-the-filed-year.test.ts` | — | — |
| A19 | 3-year time-bar warning | DONE | `packages/finance/src/filing-calendar.ts`. Tests: `tests/integration/an-unfiled-return-near-the-three-year-bar-reaches-the-owner.test.ts` | — | — |
| A20 | e-invoice IRN/QR if AATO > ₹5 cr | EXTERNAL | `packages/e-invoice/src/sandbox-gsp.ts`. Tests: `tests/integration/e-invoice-lifecycle.test.ts`, `e-invoice-sandbox.test.ts` | GSP credentials (EX-07). | — |
| A21 | 30-day IRN guard (off) | DONE | `packages/finance/src/einvoice-reporting-guard.ts`. Tests: `tests/integration/the-einvoice-30-day-guard-blocks-nothing-until-switched-on.test.ts` | — | — |
| A22 | B2C dynamic QR (OB-326 build OFF) | DONE | Tests: `tests/unit/a22-the-b2c-dynamic-qr.test.ts`, `tests/integration/a22-the-b2c-dynamic-qr-goes-from-store-setup-to-the-bill.test.ts`, `tests/e2e/the-served-till-prints-the-b2c-dynamic-qr-when-switched-on.e2e.ts` | — | — |
| A23 | e-way bill | DONE | `packages/e-way-bill/src/dispatch-check.ts`. Tests: `tests/integration/a-dispatch-above-the-threshold-needs-an-e-way-bill.test.ts`, `a-supplier-return-above-the-threshold-is-dispatched-under-an-e-way-bill.test.ts` | Live EWB portal is outside the repo. | — |
| A24 | TDS 194C/I/J (off) | DONE | `packages/withholding/src/tds.ts`. Tests: `tests/integration/tds-is-deducted-past-the-threshold-and-held-until-the-challan.test.ts` | — | — |
| A25 | 206C(1H) TCS **not** collected | DONE | Tests: `tests/guardrails/no-sale-of-goods-tcs.test.ts` | — | — |
| A26 | GST TCS s.52 own goods only | DONE | `packages/storefront/src/listing-duties.ts`. Tests: `tests/integration/an-incomplete-product-is-not-published-online.test.ts` | — | — |
| A27 | non-disableable audit trail | DONE | `services/kernel/src/audit-sink.ts`. Tests: `tests/guardrails/audit-trail-cannot-be-disabled.test.ts` | — | — |
| A28 | retention clocks + legal hold | DONE | `packages/audit/src/statutory-retention.ts`. Tests: `tests/integration/finance-retention.test.ts` | — | — |
| A29 | append-only evidence | DONE | `db/migrations/0004_append_only_guards.sql`. Tests: `tests/guardrails/ledger-append-only.test.ts` | — | — |

### Addendum B1 to B12

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| B1 | no sale above MRP | DONE | `packages/price-guard/src/price-guard.ts`. Tests: `tests/guardrails/a-real-trading-bill-is-never-above-the-mrp-total.test.ts` (passed alone) | — | — |
| B2 | dual-MRP guard | DONE | Tests: `tests/integration/a-pack-is-published-with-one-mrp-and-a-care-contact.test.ts`, `tests/e2e/the-product-screen-refuses-two-mrps-and-asks-for-a-care-contact.e2e.ts` | — | — |
| B3 | unit sale price on label/shelf tag (OB-505/549) | DONE | `packages/product/src/shelf-tag.ts`, `unit-price.ts`. Tests: `tests/unit/a-shelf-tag-is-lawful-before-it-prints.test.ts`, `tests/integration/shelf-tags-and-quotations-run-on-head-offices-records.test.ts` | The label printer is outside the repo. | — |
| B4 | pack declarations (OB-504 mfg date at receiving) | DONE | Tests: `tests/integration/r7b-receiving-carries-the-manufacture-date-the-cost-and-the-owner.test.ts`, `a-pack-is-published-with-one-mrp-and-a-care-contact.test.ts` | — | — |
| B5 | weighed price never against customer | DONE | Tests: `tests/integration/a-weighed-item-is-sold-and-returned-in-grams.test.ts` | — | — |
| B6 | verified-scale gate | DONE | `packages/facilities/src/weighing-verification.ts`. Tests: `tests/e2e/scales-on-the-production-api.e2e.ts` | Real scale certificates are outside the repo. | — |
| B7 | scale register + expiry alerts | DONE | Tests: `tests/integration/a-scale-stamp-falling-due-reaches-the-owner.test.ts` | — | — |
| B8 | expired batch refused at scan (OB-298 one tap for plain barcodes) | DONE | Tests: `tests/unit/b8-a-perishable-needs-its-pack-date-confirmed.test.ts`, `tests/integration/b8-a-perishables-pack-date-is-confirmed-at-the-till-and-reaches-head-office.test.ts`, `an-expired-batch-is-refused-on-its-batch-barcode-offline.test.ts`, `tests/e2e/the-served-till-checks-pack-dates-bis-licences-and-recalled-returns.e2e.ts` | — | — |
| B9 | allergen + veg mark | DONE | Tests: `tests/unit/the-counter-label-is-lawful-before-it-prints.test.ts` | — | — |
| B10 | FSSAI licence stored, displayed, expiry alerts | DONE | Tests: `tests/unit/b10-the-fssai-licence-number-is-on-every-bill.test.ts`, `tests/integration/b10-the-fssai-licence-goes-from-the-register-to-every-bill.test.ts`, `compliance-obligations.test.ts` | — | — |
| B11 | recall plan + one-up/one-down export | DONE | `packages/quality/src/lot-trace.ts`, `docs/runbooks/product-recall.md`. Tests: `tests/integration/lot-trace.test.ts` | — | — |
| B12 | BIS/ISI gate (OB-325 build ON) | DONE | `packages/restricted-sales/src/till-gate.ts`. Tests: `tests/unit/b12-bis-goods-need-a-current-licence-at-the-till.test.ts`, `tests/integration/b12-bis-goods-are-refused-offline-without-a-current-licence.test.ts` | — | — |

---

## 2. Summary

| status | count | rows |
|---|---|---|
| DONE | 70 | M10-FR-01, 03, 04; M11-FR-01, 02, 04; M12-FR-02, 03, 04; M13-FR-01 to 04; M14-FR-01 to 04; M15-FR-01 to 04; M16-FR-01 to 04; M17-FR-01 to 04; M18-FR-01, 02, 03; WF-06 to WF-10; MG-01 to MG-06; A14 to A19, A21 to A29; B1 to B12 |
| PARTIAL | 2 | M10-FR-02, M11-FR-03 (its label printer stays EXTERNAL as well) |
| MISSING | 0 | — |
| DECISION | 0 | — (every 23 Oct decision D1 to D10 is settled: OB-295 to OB-303, OB-325, OB-326) |
| EXTERNAL | 7 | M12-FR-01, M18-FR-04, QG-05, QG-06, QG-07, QG-08, A20 |
| DEFERRED | 0 | — |

Total: 79 rows.

**Rows that are not DONE, EXTERNAL or DEFERRED:**
1. **M10-FR-02**: quality **sample results cannot be recorded offline**. They exist only at `POST /v1/quality/holds/:batchId/samples/:sampleId` at head office (`services/inventory/src/quality-hold.ts:146`). There is no box capture or `EVENT_ROUTES` entry (`edge/sync-agent/src/http-transport.ts:252-261`), and the store release screen only displays samples (`apps/web-erp/src/quality-release-queue.ts`). With OB-513, a held food batch cannot be sampled and released with the line down. **Fix:** a box-durable sample capture plus a synced sample route that re-checks the recorder, relayed before the release, and an offline test.
2. **M11-FR-03**: **repacking is not wired.** `repack()` (`packages/production/src/packing.ts:423`) has no route, ledger move, screen or lot-trace link, and only a unit test calls it. **Fix:** a repack route booking the source-out/new-batch-in moves with the source expiry, a trace link so a recall on the source reaches the repack, a production-screen action, and an integration test.

## 3. Hard rules, dead routes, owner decisions

- **Hard-rule breaches:** none found in this slice. The expiry move appends `BatchExpired` facts and never edits a quantity (hard rule #2). Recall withdrawal and the "phoned" untick are compensating records (#6). The quality release re-checks the releaser at head office (#10).
- **Dead routes:** none. Every `/v1/...` call in the slice's office screens matches a registered route.
- **Two staff reads that no screen shows (P-08 observation, not a row gap):**
  - `GET /v1/inventory/expired-batches`, the expired register with "still to bin" (`services/inventory/src/expiry.ts`);
  - `GET /v1/repeat-orders`, every repeat-order day not placed, exceptions first (`services/orders/src/storefront-subscriptions.ts:167`).
  - The owner may want both on an office page.
- **Owner decisions in this slice:** all built as decided. Checked: OB-295, 297, 298, 299, 300, 301, 302, 303, 325, 326, 328, 383/387/397/399, 504, 505/549, 506/523/524/525/532/533/542/545/551/602, 513/526, 609. The OB-513 food-sample rule and the OB-333 offline release do not fit together offline; that gap is M10-FR-02 above, and neither decision is broken.

## 4. Test notes for the coordinator

- **Load-sensitive tests.** The three 5-second timeouts and the two first-run performance failures happened at load average 15 (four lanes on 4 cores). All passed when re-run alone. They are not regressions, but they are load-sensitive:
  - `tests/guardrails/a-real-trading-bill-is-never-above-the-mrp-total.test.ts` (300-session property test);
  - the PostgreSQL legs of `the-store-box-keeps-offline-work-and-books-it-once.test.ts` and `a-repeat-order-is-placed-on-its-days-and-paused-or-cancelled-by-the-customer.test.ts`.
- **Store-volume test.** `tests/integration/opening-load-at-store-volume.test.ts` (MG-05 at store volume) runs only when `GT05_STORE_VOLUME` is set, and no CI workflow sets it. So the default suite and CI never prove the store-volume trial.
