# Full-roadmap gap audit — Lane 2 (OB-288, 23 Oct 2026)

**Slice:** M10–M18 (every FR in `docs/requirements/M10.md`–`M18.md`), WF-06–WF-10, QG-05–QG-08, MG-01–MG-06, addendum A14–A29, addendum B1–B12.
**Method:** read-only. Every status below was checked in the code and tests, not taken from `docs/traceability.md` (several of its rows are stale in both directions: e.g. M16 merge/reverse, M13 exchanges and the expiry screen are built although the rows say "pending"; WF-08 is built although the evidence ledger says PARTIALLY_WIRED).
**Tests run here (all green):** 133 files named by the M10–M18 trace rows (1,393 passed, 37 skipped); 58 files for A14–A29/B1–B11 + payment/offline guardrails (459 passed); 31 workflow/migration/gate files (184 passed); the performance files `tests/performance/pos-hot-path.test.ts` and `sync-and-endurance.test.ts` (21 passed). PostgreSQL was **not running** on 127.0.0.1:5432, so the real-database halves (`describe.skipIf(!DATABASE_URL)`) were skipped locally; they are run by CI's "Stage gate suites (real PostgreSQL)" job (`.github/workflows/ci.yml`). No database was created or dropped.

Statuses: DONE = built and proven by a named automated test · PARTIAL = what is missing is stated · DECISION = roadmap leaves a choice open · EXTERNAL = needs an outside party, real device or staff. Sizes: S ≤1 day, M 2–4 days, L ≥1 week.

---

## 1. Requirement table

### M10 — Batch, expiry, quality and recall

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M10-FR-01 | FEFO allocation, expiry action list, markdown or disposal; "expired stock auto-moves to expired state (not sellable, M08-FR-02)"; offline "expiry list and FEFO computed at edge" (M10.md FR-01) | PARTIAL | `packages/fefo/src/fefo.ts`, `near-expiry.ts`, `services/inventory/src/expiry.ts`, `near-expiry.ts`, `apps/web-erp/src/expiry-session.ts` (box-served, offline), `packages/demand/src/markdown.ts` (D-4). Tests: `tests/unit/fefo.test.ts`, `fefo-near-expiry.test.ts`, `tests/integration/inventory-fefo-allocation.test.ts`, `inventory-near-expiry.test.ts`, `inventory-expiry-actions.test.ts` | No automatic move of a batch to the `expired` state when its date passes: nothing emits an `on_hand → expired` compensating movement (`grep "'expired'" services/inventory/src` finds only receiving postures). Expired batches are excluded only where a reader checks the date itself. Add a daily expiry sweep (cloud + box) that appends the state move once per batch, idempotent, with the dispose action linked to the M28 write-off. | M | `services/inventory/src/expiry.ts` (new sweep), `services/api/src/ops-alert-sweeps.ts`, `edge/store-edge/src/main.ts`, new test `tests/integration/an-expired-batch-moves-to-expired-once.test.ts` |
| M10-FR-02 | Quality status, sampling, cold-chain/temperature evidence; breach quarantines; "Offline (§31): evidence captured offline; queued" | PARTIAL | `packages/quality/src/cold-chain.ts` (statuses incl. `sampling`, sample-gated release), `services/inventory/src/cold-chain.ts`, `quality-hold.ts`, `services/platform/src/food-safety.ts` (sealed temperature checks). Tests: `tests/unit/quality-cold-chain.test.ts`, `tests/integration/quality-cold-chain.test.ts`, `cold-room-breach-holds-stock.test.ts`, `quality-hold.test.ts` | Offline capture is missing: `edge/sync-agent/src/http-transport.ts` `EVENT_ROUTES` has no route for a food-safety/temperature record, a sample result or a quality release, so these are cloud-only writes (only the arrival temperature rides `ReceivingScanned`). Add box-durable capture + synced routes that re-verify the recorder. | M | `edge/store-edge/src/main.ts`, `edge/sync-agent/src/http-transport.ts`, `services/platform/src/food-safety.ts` (synced route), `services/inventory/src/quality-hold.ts` (synced route) |
| M10-FR-03 | Lot trace supplier→customer **and customer→supplier** ("works backwards and forwards"); "trace queries logged" | PARTIAL | `packages/quality/src/lot-trace.ts`, `lot-trace-chain.ts`, `services/inventory/src/lot-trace.ts` (`/export`, `/:batchId/sold`), `lot-trace-chain.ts` (`/:batchId/chain`, 24-h requests). Tests: `tests/unit/quality-lot-trace.test.ts`, `tests/integration/lot-trace.test.ts`, `a-lot-trace-reaches-supplier-to-customer-from-stored-facts.test.ts` | (1) No backward query from a customer, sale or receipt to the batches and suppliers behind it — every route starts from a batch id. Add `GET /v1/quality/lot-trace/by-sale/:saleId` and `/by-customer/:customerRef` (PII-minimised, gated `quality.lottrace.read`). (2) Trace reads are not logged: `services/kernel/src/pipeline.ts` (`writeAudit`) audits writes and refusals only, "Successful reads are not audited". Record each lot-trace read that names customers (who, when, batch), as `customer-360.ts` already does for profile views. | M | `services/inventory/src/lot-trace.ts`, `lot-trace-chain.ts`, `services/api/src/adapters.ts` (or a new `lane2-trace-adapters.ts`), new integration test |
| M10-FR-04 | Recall: "recall-block stops POS sale **and ordering**"; affected customers "notify per consent"; "owner informed"; "recall block propagates as priority sync"; closure with evidence | PARTIAL | `packages/traceability/src/recall.ts`, `services/inventory/src/recall.ts`, `sale-blocks.ts` (recall → signed pack), `apps/web-erp/src/expiry-session.ts`. Tests: `tests/integration/recall.test.ts`, `recalls-reach-the-offline-till.test.ts`, `a-recalled-batch-is-refused-and-its-sibling-sells-offline.test.ts`, `a-recall-runs-its-whole-lifecycle-on-postgresql.test.ts`, `tests/guardrails/a-recalled-tin-cannot-be-sold.test.ts` | Missing: (1) **ordering block** — no purchase-order path checks an open recall (`grep recall services/purchase/src packages/purchasing/src` finds only `data-export.ts`); (2) **customer notification per consent** — nothing turns the lot-trace customer list into a consent-checked notice (`packages/notifications`, `services/customer` have no recall path); (3) **owner informed** — no owner alert/brief item on recall initiation; (4) **priority propagation** — `sale-blocks.ts` only says "publish the pack"; initiating a recall does not itself trigger a pack publish. | L | `services/inventory/src/recall.ts`, `services/purchase/src/` (PO create/approve guard), new `services/customer/src/recall-notices.ts`, `services/api/src/ops-alert-sweeps.ts`, `services/catalogue/src/pack.ts` (publish trigger) |

### M11 — Fresh food and internal production

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M11-FR-01 | Recipes/BOM, issue, plan, batch output; "Offline (§31): production capture queue-capable; reconciled on sync" | PARTIAL | `packages/production/src/recipe.ts`, `services/inventory/src/production.ts`, `production-plan.ts`. Tests: `tests/unit/production.test.ts`, `tests/integration/production.test.ts`, `production-durability.test.ts`, `production-moves-ordinary-stock.test.ts` | Production runs are cloud-only writes (`POST /v1/production/runs/:runId`); no box-durable capture and no `EVENT_ROUTES` entry. Add an offline run capture on the box, relayed to a synced route that re-runs `produceBatch` and record-and-flags a shortfall (hard rule #10). | M | `edge/store-edge/src/main.ts`, `edge/sync-agent/src/http-transport.ts`, `services/inventory/src/production.ts`, `apps/web-erp/src/production-session.ts` |
| M11-FR-02 | Catch weight, yield, process loss, costing; "Offline: weight capture offline; costing reconciles online" | PARTIAL | `packages/production/src/recipe.ts` (`costCatchWeight`), `services/inventory/src/weighed-costing.ts`. Tests: `tests/integration/weighed-costing.test.ts`, `goods-made-in-the-store-are-valued-at-their-production-run-cost.test.ts` | Weighed runs (`POST /v1/production/weighed-runs/:id`) are cloud-only. Same box queue as FR-01 for the weigh-in/weigh-out capture; costing stays at head office. | S (with FR-01) | same as FR-01 |
| M11-FR-03 | Packing, scale labels, shelf life, quality release, repack; "Offline: labelling/packing works at the counter offline" | PARTIAL | `packages/production/src/packing.ts`, `packages/product/src/loose-food-label.ts`, `label-height.ts`. Tests: `tests/unit/production.test.ts` (label round-trips through `CatalogueCache`), `tests/integration/production.test.ts` | Labels are issued only by the cloud route `POST /v1/production/runs/:runId/label`; there is no box-side label render for the counter with the cable out. Serve `buildPackLabel`/`renderLabel` from the box using the pack's label rules. Physical scale/label printer is EXTERNAL (D14). | M | `edge/store-edge/src/screen-server.ts`, `screen-data.ts`, `apps/web-erp/src/production-session.ts` |
| M11-FR-04 | Department configuration where applicable; only confirmed departments enabled | DONE | `packages/production/src/departments.ts`, `services/inventory/src/production.ts`; OB-04/OB-05. Tests: `tests/integration/production.test.ts` (`department_not_operated`, `unknown_department`) | — | — | — |

### M12 — POS sales and checkout

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M12-FR-01 | Scan/search, quantity, weight, price enquiry, customer display; "scan-to-line p95 ≤ 300 ms on certified pilot hardware — measured and shown"; "scan-performance telemetry"; "scale error → manual weight with supervisor rule" | PARTIAL | `apps/pos/src/session.ts`, `customer-display.ts`, `packages/catalogue/src/`. Tests: `tests/unit/pos-session.test.ts`, `pos-barcode-scan.test.ts`, `tests/performance/pos-hot-path.test.ts` (CI headroom, refuses to call it certification), `tests/e2e/the-served-till-takes-a-sale.e2e.ts` | (1) No scan-latency telemetry in the till: nothing in `apps/pos/src` or `edge/store-edge/src` records scan→line time, so the p95 cannot be "measured and shown" on the real lane. Add a per-scan timing sample kept on the box and a p95 read on the manager/devices screen. (2) Manual weight on scale error: the till refuses any typed weight (`session.ts` commit gate, B6) — conflicts with the FR's alternate path → **owner decision D1**. (3) Certified-hardware measurement is EXTERNAL. | S (telemetry) | `apps/pos/src/browser-entry.ts`, `apps/pos/src/session.ts`, `edge/store-edge/src/lane-server.ts`, `edge/store-edge/src/screen-data.ts` |
| M12-FR-02 | Suspend/recall, quotations, receipts, **delivery sales** ("mark a sale for delivery (feeds M18)") | PARTIAL | `edge/store-edge/src/held-bills.ts`, `packages/suspended-sales/src/`, `services/pos/src/quotations.ts`, `packages/receipt/src/receipt.ts` (reprint marked DUPLICATE). Tests: `tests/unit/suspended-bills.test.ts`, `quotations.test.ts`, `tests/integration/quotations.test.ts`, `tests/unit/receipt.test.ts` | Delivery sales are not built: no till path marks a bill for delivery and nothing creates an M18 order/fulfilment task from a till sale (`grep -i delivery apps/pos/web/app.js apps/pos/src/session.ts` is empty). Build a "deliver this bill" flag on the committed sale, relayed to a new orders route that opens an already-paid delivery order. Fee/payment-timing choices → **owner decision D10**. | M | `apps/pos/src/session.ts`, `apps/pos/web/app.js`, `services/pos/src/sale-intake.ts`, new `services/orders/src/store-delivery-sales.ts` |
| M12-FR-03 | Cash/card/UPI/store credit/split tender; never invent approval; no card data | DONE | `packages/tender/src/` (`tender.ts`, `card-token.ts`, `machine-reference.ts`, `pending-recovery.ts`), `services/finance/src/pending-tender.ts`. Tests: `tests/unit/tender.test.ts`, `pending-recovery.test.ts`, `tests/integration/pending-tender-recovery.test.ts`, `tests/guardrails/card-data.test.ts`, `pos-offline.test.ts` | Integrated provider authorisation (instead of the typed machine approval number, OB-274) is EXTERNAL. | — | — |
| M12-FR-04 | Supervisor overrides, age/restricted prompts, lane health | DONE | `apps/pos/src/lane-guards.ts`, `session.ts`. Tests: `tests/unit/pos-lane-guards.test.ts`, `pos-age-check-is-enforced-at-commit.test.ts`, `tests/integration/an-age-restricted-sale-reaches-head-office-with-its-check.test.ts` | — | — | — |

### M13 — Returns, exchanges and refunds

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M13-FR-01 | Receipt and controlled no-receipt returns; offline receipted return | DONE | `packages/returns/src/returns.ts`, `services/pos/src/returns.ts`, `no-receipt-returns.ts`, `edge/sync-agent/src/http-transport.ts` (`returnAcceptedRoute`). Tests: `tests/unit/returns.test.ts`, `tests/integration/no-receipt-returns.test.ts`, `returns-reconcile-on-sync.test.ts`, `offline-returns-reach-the-cloud.test.ts`, `the-till-returns-without-a-receipt.test.ts` (PG) | — | — | — |
| M13-FR-02 | Eligibility, reason, condition, serial/batch, disposition; "recall-blocked item handled per M10" | PARTIAL | `packages/returns/src/return-eligibility.ts`, `returns.ts` (`isRecalled` forces quarantine). Tests: `tests/unit/return-eligibility.test.ts`, `tests/integration/returns-eligibility.test.ts`, `tests/unit/returns.test.ts` | The till does not pass the recall set: `apps/pos/src/till-session.ts` calls `commitReturn(full, stockLedger, outbox)` with no `isRecalled`, so a recalled unit returned at the till can go back to sellable. Pass the box's cached recall/sale-block set; add a till-level test. | S | `apps/pos/src/till-session.ts`, `apps/pos/src/browser-entry.ts`, `edge/store-edge/src/lane-server.ts` |
| M13-FR-03 | Exchange, refund method, store credit, thresholds | DONE | `packages/returns/src/exchange.ts`, `services/pos/src/exchanges.ts`, `packages/loyalty/src/stored-value.ts`. Tests: `tests/unit/exchange-engine.test.ts`, `tests/integration/exchanges.test.ts`, `store-credit-refund.test.ts`, `returns-guard-the-refund.test.ts` | — | — | — |
| M13-FR-04 | Payment reversal, gateway status, reconciliation; never invent reversal success | DONE | `packages/reversal/src/reversal.ts`, `services/finance/src/refund-exceptions.ts`. Tests: `tests/unit/reversal.test.ts`, `tests/integration/refund-exceptions.test.ts` | Provider reversal adapter is EXTERNAL (standalone terminal: refund done on the machine with a manager PIN, round 6). | — | — |

### M14 — Till, cash office and day close

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M14-FR-01 | Till assignment, float, loan, pickup, safe drop, offline | DONE | `packages/cash/src/cash.ts`, `edge/store-edge/src/till-cash.ts`, `services/pos/src/cash.ts`. Tests: `tests/unit/cash.test.ts`, `edge-till-cash.test.ts`, `tests/integration/till-cash.test.ts`, `till-cash-reaches-the-cloud.test.ts` | — | — | — |
| M14-FR-02 | Shift, blind count, denomination, over/short | DONE | `packages/till/src/till.ts`, `assess-shift.ts`, `services/pos/src/shift.ts`. Tests: `tests/unit/till.test.ts`, `tests/integration/shift-close.test.ts`, `the-till-closes-through-the-box.test.ts` | — | — | — |
| M14-FR-03 | Card/UPI settlement, exception investigation | DONE | `packages/settlement/src/settlement.ts`, `services/finance/src/settlement.ts`. Tests: `tests/unit/settlement.test.ts`, `tests/integration/settlement-cash-office.test.ts`, `settlement-investigations.test.ts` | Real acquirer statement files are EXTERNAL. | — | — |
| M14-FR-04 | Day close, locking, controlled reopen, **"produce evidence pack (sales, tenders, cash, over/short, exceptions)"** | PARTIAL | `packages/day-close/src/day-close.ts`, `services/pos/src/day-close.ts`, `edge/store-edge/src/main.ts` (`closeDay`). Tests: `tests/unit/day-close.test.ts`, `tests/integration/day-close-reconcile-on-sync.test.ts`, `day-close-reaches-the-cloud-through-the-edge.test.ts`, `tests/e2e/manager-day-close-delivery.e2e.ts` | No per-day evidence pack exists: `services/pos/src/day-close.ts` only says the facts are "the spine the day-close evidence pack is built from"; the pack builder in `services/finance/src/period-evidence.ts` is month-level. Build a locked-day pack (sales, tenders, cash, over/short, exceptions, reopen history) with a hash, exportable for the CA. CA signature is EXTERNAL. | M | `packages/day-close/src/` (new `evidence-pack.ts`), `services/pos/src/day-close.ts`, `apps/web-erp/src/day-book-session.ts` |

### M15 — Loss prevention and fraud

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M15-FR-01 | Void/refund/discount/no-sale/cash-anomaly rules; alert to owner; rules as data | DONE | `packages/loss-prevention/src/loss-prevention.ts`, `services/pos/src/loss-prevention.ts` (`/activity/:id/synced`, `/exceptions`), `apps/owner-app/src/brief.ts`. Tests: `tests/unit/loss-prevention.test.ts`, `tests/integration/loss-prevention-rules.test.ts` | — | — | — |
| M15-FR-02 | Coupon, loyalty, delivery, supplier, purchase fraud signals; "cross-domain signals reconcile to their source" | PARTIAL | `packages/loss-prevention/src/fraud-signals.ts`, `services/pos/src/fraud-signals.ts`. Tests: `tests/unit/fraud-signals.test.ts`, `tests/integration/fraud-signals.test.ts` | `POST /v1/fraud-signals/evaluate` runs only over datasets the caller posts; nothing feeds it from the real coupon redemptions, points movements, COD handovers or supplier invoices, and no screen shows the signals (`grep fraud-signals apps/*/src` is empty). Add a stateful read over the stored ledgers and show the list in the loss-prevention inbox. | M | `services/pos/src/fraud-signals.ts`, new `services/api/src/lane2-lp-adapters.ts`, `apps/web-erp/src/loss-prevention-inbox-session.ts` |
| M15-FR-03 | Employee purchases, related-party, duplicate bank accounts across **suppliers/employees** | PARTIAL | `packages/bank-controls/src/duplicate-bank.ts` (supports `employee`), `services/pos/src/fraud-signals.ts`, `services/purchase/src/supplier-master.ts` (payment blocked on `duplicate_bank_account`). Tests: `tests/unit/bank-controls.test.ts`, `tests/integration/duplicate-bank.test.ts` | (1) `bankHolders` in `services/api/src/adapters.ts` folds supplier accounts only ("employee accounts would join … when they are recorded") although payroll holds them (`packages/payroll/src/bank-file.ts`). (2) Employee-purchase policy and related-party links are not built at all (no code found). Policy needs **owner decision D5**. | M | `services/api/src/adapters.ts` (`bankHolders`), `services/finance/src/payroll.ts`, new `packages/loss-prevention/src/related-party.ts`, `services/pos/src/fraud-signals.ts` |
| M15-FR-04 | Case management, evidence preserved, outcome feedback | DONE | `packages/loss-prevention/src/cases.ts`, `services/pos/src/loss-prevention.ts`. Tests: `tests/unit/lp-cases.test.ts`, `tests/integration/loss-prevention-cases.test.ts` | — | — | — |

### M16 — Customer 360 and consent

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M16-FR-01 | One identity, household, contact verification, governed reversible merge | DONE | `services/customer/src/customer-360.ts` (merge, approve, reverse, household), `duplicates.ts`, `signup-sms-code.ts` (switched off, OB-29/R4). Tests: `tests/integration/the-customer-record-is-built-from-what-they-bought.test.ts`, `customer-duplicates.test.ts`, `tests/unit/voice-and-sms-links-are-switched-off.test.ts` | Live SMS provider is EXTERNAL. | — | — |
| M16-FR-02 | Consent per purpose/channel, withdrawal, history, enforced at send | DONE | `packages/customer/src/consent.ts`, `services/customer/src/campaign-send.ts`, `notification-guard.ts`, `privacy-self.ts`. Tests: `tests/unit/customer.test.ts`, `tests/integration/customer-segments-stateful.test.ts`, `the-sender-rechecks-template-and-recipient.test.ts` | — | — | — |
| M16-FR-03 | Access, correction, export, erasure within retention; self-service | DONE | `packages/customer/src/data-rights.ts`, `services/customer/src/data-rights.ts`, `privacy-self.ts`, `erasure-execution.ts`. Tests: `tests/unit/customer-data-rights.test.ts`, `tests/integration/data-rights.test.ts`, `the-customer-privacy-centre-saves-on-the-shop.test.ts` | — | — | — |
| M16-FR-04 | Segments, CLV, **"complaint history is visible to service"** | PARTIAL | `packages/customer/src/segments.ts`, `services/customer/src/segments.ts`. Tests: `tests/unit/customer-segments.test.ts`, `tests/integration/customer-segments.test.ts` | Complaint facts are typed in by hand (`POST /v1/customer/facts/complaints/:caseId`) and the 360 profile (`customer-360.ts`) shows no complaints or service cases; `GET /v1/service/cases` cannot filter by customer. Derive complaint facts from the M21 service cases and show them on the customer record for the service desk. | S | `services/customer/src/customer-360.ts`, `service-cases.ts`, `apps/web-erp/src/customers-session.ts` |

### M17 — Loyalty, membership and gift value

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M17-FR-01 | Earn/burn, **tiers, expiry**, reversal, liability | DECISION | Earn/burn/reversal/liability built: `packages/loyalty/src/loyalty.ts`, `earn-rule.ts`, `services/finance/src/loyalty-liability.ts`. Tests: `tests/unit/loyalty.test.ts`, `tests/integration/loyalty-points.test.ts`, `loyalty-durability.test.ts` | Tiers are not built (no tier code in `packages/loyalty` or `services/customer`); points expiry is only a reason code (`PointsReason 'expiry'`) with no ageing job. Both need the owner's policy (AVR-14, OB-28 pattern) → **D3**. Then build settings-driven, off until set. | M | new `packages/loyalty/src/tiers.ts`, `points-expiry.ts`, `services/customer/src/loyalty-members.ts`, `packages/tenant/src/settings.ts` |
| M17-FR-02 | Coupons, referrals, memberships, **subscriptions**, personalised offers | DECISION | `packages/loyalty/src/coupons.ts` (incl. `membership` kind), `services/customer/src/coupons.ts`, `offer-liability.ts`. Tests: `tests/unit/loyalty-coupons.test.ts`, `tests/integration/coupons.test.ts`, `referral-liability-reconciles-…` (trace row 1159) | "Subscriptions" are not built and the roadmap does not say what they are (paid membership plan vs repeat online order) → **D4**. | M | depends on D4 |
| M17-FR-03 | Gift cards, store credit, fraud limits, reconciliation | DONE | `packages/loyalty/src/stored-value.ts`, `services/customer/src/stored-value.ts`. Tests: `tests/unit/loyalty-stored-value.test.ts`, `tests/integration/stored-value.test.ts`, `stored-value-liability.test.ts` | — | — | — |
| M17-FR-04 | Household pooling, one balance across channels | DONE | `householdBalance`, `findDoubleSpends` in `packages/loyalty/src/stored-value.ts`; OB-43 policy "nothing shared beyond the link". Tests: `tests/integration/household-pooling.test.ts` | — | — | — |

### M18 — Order management and omnichannel

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M18-FR-01 | One order lifecycle, serviceable branch selection | DONE | `packages/orders/src/lifecycle.ts`, `services/orders/src/index.ts`, `serviceability.ts`. Tests: `tests/unit/orders.test.ts`, `tests/integration/orders-lifecycle.test.ts`, `serviceability-config.test.ts` | — | — | — |
| M18-FR-02 | Reservation, routing, **split/partial**, backorder, no oversell | DECISION | `packages/orders/src/reservation.ts`, `services/orders/src/index.ts` (`/promise`, `/backorder`). Tests: `tests/unit/orders.test.ts`, `tests/integration/orders-lifecycle.test.ts` | Partial + backorder built; **split across branches** is not ("splitting it is a decision, not a default", `packages/orders/src/fulfilment-plan.ts:161`; D09-FR-01 cross-branch routing was deferred to R5 by OB-58, now in scope by OB-288) → **D9**, then build. | M | `packages/orders/src/fulfilment-plan.ts`, `services/orders/src/index.ts` |
| M18-FR-03 | Pickup, scheduled/express, dark store | DONE | `packages/orders/src/fulfilment-plan.ts`, `packages/storefront/src/serviceability-schedule.ts`. Tests: `tests/unit/orders-fulfilment-plan.test.ts`, `tests/integration/serviceability-config.test.ts`, `pick-to-doorstep.test.ts` (PG) | Road-distance maps EXTERNAL. | — | — |
| M18-FR-04 | Cancellation, customer-confirmed substitution, refunds by token, channel reconciliation; "refund approval per policy" | PARTIAL | `packages/orders/src/amendments.ts`, `payment-refunds.ts`, `services/orders/src/payments.ts`. Tests: `tests/integration/order-payments-and-refunds.test.ts`, `order-substitution.test.ts`, `order-channel-reconcile.test.ts` | No staff screen for order refunds: nothing in `apps/*` calls `/v1/orders/:orderId/refunds` or `/v1/orders/refunds/pending` (P-07). Build the desk refund + pending-refund worklist page. Live gateway is EXTERNAL (EX-03, test-mode processor today). | M | new `apps/web-erp/src/order-refunds-session.ts`, `apps/web-erp/web/` page, `apps/web-erp/src/navigation.ts` |

### Workflows WF-06 to WF-10 (roadmap §26; "Each workflow requires separate happy-path, alternate, cancellation, permission-denied, offline, timeout, duplicate, recovery and audit scenarios … incomplete until its financial and stock effects reconcile")

No per-workflow scenario matrix exists anywhere in the repo (`grep` of `docs/` and `tests/` for the nine scenario names finds only the rule itself in `docs/requirements/index.md`). Writing one matrix per workflow, each cell pointing to a test, is an S task per workflow and is the way to prove "DONE" against the rule.

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| WF-06 | Replenishment: shelf gap/min-max/forecast → task → pick → replenish → confirm variance | DONE | `services/inventory/src/replenishment.ts`, `floor-indents.ts` (incl. cancel, synced routes). Tests: `tests/integration/replenishment.test.ts`, `floor-indents.test.ts`, `floor-indents-synced.test.ts`, `floor-indents-handheld-issue.test.ts`, `tests/e2e/indents-delivery.e2e.ts` | Scenario matrix (S). | S | `docs/requirements/workflows/WF-06.md` (new) |
| WF-07 | Stock transfer: request → approve → pick/dispatch → in transit → receive/discrepancy → ledger; §31 "Receiving/count/transfer: queue-capable" | PARTIAL | `services/inventory/src/warehouse-transfers.ts`, `packages/warehouse/src/transfers.ts`. Tests: `tests/integration/warehouse-transfers.test.ts`, `a-transfer-sends-only-what-the-batch-holds.test.ts`, `a-dispatch-above-the-threshold-needs-an-e-way-bill.test.ts`, `tests/e2e/transfers-on-the-production-api.e2e.ts` | (1) **Cancellation scenario missing**: no cancel route before dispatch (routes: create, dispatch, receive, shortfall/resolution only). (2) **Offline** dispatch/receipt missing: no transfer event in `EVENT_ROUTES`. (3) Dispatch and receipt have no browser proof (evidence ledger note). | M | `services/inventory/src/warehouse-transfers.ts`, `edge/sync-agent/src/http-transport.ts`, `edge/store-edge/src/main.ts`, `apps/web-erp/src/transfers-session.ts` |
| WF-08 | Stock count: plan/freeze → blind count → recount → cause → approval → adjustment/accounting | DONE | `services/inventory/src/count-plans.ts`, `count-freeze.ts`, `packages/finance/src/day-book.ts` (`stock_count:shortage/surplus`). Tests: `tests/integration/a-stock-count-is-planned-frozen-recounted-approved-and-booked.test.ts`, `an-open-count-freezes-every-adjustment-and-write-off-path.test.ts`, `a-planned-count-on-the-phone-reaches-head-office-through-the-box.test.ts` | Evidence ledger label (PARTIALLY_WIRED, 11 Oct) is stale — refresh it. Scenario matrix (S). | S | `docs/completion-status.json`, `docs/evidence/evidence-ledger.json` (regenerate) |
| WF-09 | Expiry/recall: detect → quarantine/block → identify stock/sales/customers → return/dispose → evidence → close | PARTIAL | as M10-FR-01/03/04. Tests: `tests/integration/a-recall-runs-its-whole-lifecycle-on-postgresql.test.ts`, `tests/e2e/expiry-recall-delivery.e2e.ts` | Same gaps as M10-FR-04 (ordering block, customer notice, owner alert, priority propagation) and M10-FR-01 (automatic expiry move). | (in M10) | (in M10) |
| WF-10 | POS sale: open till → scan/weigh → price/promotion/customer → tender → commit locally → receipt → sync | DONE | Tests: `tests/integration/the-store-trades-a-day.test.ts` (PG), `sale-idempotency.test.ts`, `store-acceptance-journey.test.ts`, `tests/e2e/the-store-trades-a-day.e2e.ts` (connected), `tests/guardrails/pos-offline.test.ts` | Scenario matrix (S). Staff run on a real lane is EXTERNAL (SP-10). | S | `docs/requirements/workflows/WF-10.md` (new) |

### Quality gates QG-05 to QG-08 (roadmap §22, §32)

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| QG-05 | "Scan-to-line p95 ≤300 ms on certified pilot hardware; audited targets for other journeys" (§32: total/tender ≤500 ms; catalogue search p95 ≤1 s; customer checkout API p95 ≤2 s; 72-h offline; 24-h backlog drained in 2 h) | PARTIAL | `tests/performance/pos-hot-path.test.ts` (scan, total/tender headroom, `certifiedHardwareGate`), `sync-and-endurance.test.ts` (72 h, 24-h drain), `api-scales-with-the-shop.test.ts` | Missing load tests for **catalogue search p95 ≤1 s** and **customer checkout API p95 ≤2 s** (no performance test names either); missing the on-till measurement tool (see M12-FR-01). Certified hardware run is EXTERNAL. | M | new `tests/performance/catalogue-search-p95.test.ts`, `checkout-api-p95.test.ts`, `tests/performance/harness.ts` |
| QG-06 | "Zero open critical/**high** findings at go-live; independent penetration test before customer launch" | PARTIAL | `packages/compliance/src/risk.ts` (`blockedGates`), CI `pnpm audit --audit-level=high`, secret scan, guardrails. Tests: `tests/unit/compliance-risk.test.ts`, `tests/integration/risk-register.test.ts` | (1) `blockedGates` blocks only `severity === 'critical'` — an open **high** does not block QG-06. (2) No findings intake: scanner output is not recorded as findings with severity, owner and the §32 "emergency fix ≤72 h" clock. (3) No static-analysis or container-image scan in `.github/workflows/ci.yml`. Pen test EXTERNAL. | M | `packages/compliance/src/risk.ts`, `services/compliance/src/`, `.github/workflows/ci.yml` |
| QG-07 | "Migration, stock, financial, tax and loyalty control totals signed" | EXTERNAL | `packages/migration/src/reconcile.ts` (`TotalKind` covers all five; loader cannot sign; CA signs tax/finance), `packages/period-close/src/control-totals.ts`. Tests: `tests/unit/migration-reconcile.test.ts`, `tests/integration/every-figure-has-a-witness-through-the-api.test.ts`, `the-old-shop-arrives-whole.test.ts` (PG) | Software complete; signing needs the owner's real legacy data and the CA. | — | — |
| QG-08 | "Backup restore, store recovery, rollback and incident escalation rehearsed" | EXTERNAL | `scripts/restore.mjs`, `scripts/lib/rollback-drill.mjs`, `recovery-rehearsal.mjs`, `services/platform/src/dr-readiness.ts`, `ops-incidents.ts`; CI "Backup, destroy and restore, reconciled (QG-08)". Tests: `tests/integration/recovery-rehearsal.test.ts`, `a-rehearsed-rollback-reconciles.test.ts`, `backup-is-one-moment.test.ts` (PG) | Rehearsals must be run on the store computer with the named incident team (G9/G10). Small software helper (S): one gate read that says GO only when all four rehearsal records exist and passed. | S | `services/platform/src/dr-readiness.ts` |

### Migration controls MG-01 to MG-06 (roadmap §17)

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| MG-01 | Discovery: every source, volume, owner, retention | DONE | `packages/migration/src/discovery.ts` (no-owner / estimated-volume / no-retention findings), `extraction.ts`, `report-parser.ts`. Tests: `tests/unit/migration-discovery.test.ts`, `migration-extraction.test.ts`, `tests/integration/migration-pipeline.test.ts` | Running it on the old ERP is EXTERNAL. | — | — |
| MG-02 | Preservation: verified backups, immutable extracts, hashes, chain of custody | DONE | `packages/migration/src/extraction.ts`, `load.ts` (seal at extract, verify at load). Tests: `tests/unit/migration-load.test.ts`, `migration-preservation-route.test.ts`, `tests/integration/we-get-it-out-ourselves.test.ts` (PG) | Backup of the old ERP itself is EXTERNAL. | — | — |
| MG-03 | Mapping approval | DONE | `packages/migration/src/mapping.ts`. Tests: `tests/unit/migration-mapping.test.ts`, `migration-mapping-route.test.ts` | — | — | — |
| MG-04 | Cleaning: duplicates (products/barcodes/suppliers/customers), invalid tax, negative stock, incomplete batches | DONE | `packages/migration/src/cleaning.ts` (`duplicate_product`, `shared_barcode`, `duplicate_customer`, `duplicate_supplier_gstin`, `unmapped_tax_code`, `negative_stock`, `batch_without_expiry`, …). Tests: `tests/unit/migration-cleaning.test.ts`, `tests/integration/migration-decisions-through-the-api.test.ts` | — | — | — |
| MG-05 | Repeatable full-volume trial loads in non-production | DONE | `packages/migration/src/trial.ts`, `load-command.ts`, `slice-import.ts`. Tests: `tests/unit/migration-trial.test.ts`, `tests/integration/opening-load-at-store-volume.test.ts` (PG), `the-whole-load-runs-from-one-command.test.ts` | Full-volume trial on the real extract is EXTERNAL. | — | — |
| MG-06 | Reconciliation by domain (rows, quantities, values, balances, taxes, loyalty, document totals) | DONE | `packages/migration/src/reconcile.ts`, `count-verification.ts`, `tax-verification.ts`, `loyalty-verification.ts`, `books-verification.ts`, `banking-verification.ts`. Tests: `tests/unit/migration-reconcile.test.ts`, `migration-tax-verification.test.ts`, `migration-loyalty-verification.test.ts`, `tests/integration/every-figure-has-a-witness-through-the-api.test.ts` | — | — | — |

### Addendum A14–A29 (`docs/roadmap/roadmap-v2.1-addendum.md` §1.1, §2, §3; gap analysis rows 102–117; R3 signed sentences OB-188)

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| A14 | RCM self-invoice (R3, OB-143 switched off) | DONE | `packages/finance/src/rcm.ts`, `services/finance/src/rcm-store.ts`. Tests: `tests/unit/rcm-and-filing-calendar.test.ts`, `tests/integration/rcm-self-invoice-is-gap-free-and-cash-only.test.ts` | CA's payee/heads list is EXTERNAL. | — | — |
| A15 | GSTR-1/GSTR-3B matched to sales ledger | DONE | `packages/finance/src/gstr3b.ts`, `services/finance/src/gstr3b-store.ts`. Tests: `tests/unit/gstr3b.test.ts`, `tests/integration/gstr3b-matches-the-sales-ledger.test.ts` | Portal filing is EXTERNAL. | — | — |
| A16 | 3B locked to filed GSTR-1 | DONE | Tests: `tests/guardrails/gstr3b-liability-cannot-be-edited-after-gstr1-is-filed.test.ts`, `tests/integration/gstr3b-matches-the-sales-ledger.test.ts` | — | — | — |
| A17 | GSTR-2B/IMS ITC (OB-145 upload) | DONE | `packages/input-tax/src/gstr2b.ts`. Tests: `tests/unit/input-tax-gstr2b-match.test.ts`, `tests/integration/itc-claims-only-accepted-2b-lines.test.ts` | — | — | — |
| A18 | GSTR-9 / 9C | DONE | `packages/finance/src/gstr9.ts`. Tests: `tests/unit/gstr9.test.ts`, `tests/integration/gstr9-and-9c-fold-from-the-filed-year.test.ts` | — | — | — |
| A19 | 3-year time-bar warning (OB-191, 180 days) | DONE | `packages/finance/src/filing-calendar.ts`. Tests: `tests/integration/an-unfiled-return-near-the-three-year-bar-reaches-the-owner.test.ts`, `the-ops-alert-worker-raises-the-gst-time-bar.test.ts` | — | — | — |
| A20 | E-invoice IRN + signed QR if AATO > ₹5 cr (owner band ₹5–10 cr, OB-149) | EXTERNAL | `packages/e-invoice/src/e-invoice.ts`, `sandbox-gsp.ts`, `services/finance/src/e-invoice*.ts`. Tests: `tests/unit/e-invoice.test.ts`, `tests/integration/e-invoice-lifecycle.test.ts`, `e-invoice-sandbox.test.ts` | Live IRP needs GSP credentials (EX-07). Software stand-in (sandbox GSP) is built. | — | — |
| A21 | 30-day IRN guard (OB-149, switched off) | DONE | `packages/finance/src/einvoice-reporting-guard.ts`. Tests: `tests/integration/the-einvoice-30-day-guard-blocks-nothing-until-switched-on.test.ts` | — | — | — |
| A22 | Dynamic QR on B2C invoices if AATO > ₹500 cr — gap analysis "Note only" | DECISION | Not built; no trace row (`grep -i "dynamic qr" packages services` empty) | OB-288 says every addendum row is completed; this row's disposition is "note only" → **D7**. | S (if built switched off) | `packages/e-invoice/src/` |
| A23 | E-way bill (Rule 138), transfers and supplier returns | DONE | `packages/e-way-bill/src/e-way-bill.ts`, `dispatch-check.ts`, `sandbox-ewb.ts`. Tests: `tests/unit/e-way-bill.test.ts`, `e-way-bill-dispatch-gate.test.ts`, `tests/integration/a-dispatch-above-the-threshold-needs-an-e-way-bill.test.ts`, `a-supplier-return-above-the-threshold-is-dispatched-under-an-e-way-bill.test.ts` | Live EWB portal and the CA's confirmation of the TN ₹1 lakh threshold are EXTERNAL. | — | — |
| A24 | TDS 194C/I/J (OB-143 switched off) | DONE | `packages/withholding/src/tds.ts`. Tests: `tests/unit/withholding-tds.test.ts`, `tests/integration/tds-is-deducted-past-the-threshold-and-held-until-the-challan.test.ts` | CA rates/payees EXTERNAL. | — | — |
| A25 | TCS u/s 206C(1H) **NOT** collected (withdrawn 1 Apr 2025) — "Note only (ensure NOT implemented)" | PARTIAL | Correctly absent (`grep "206C" packages services` empty) | No automated test proves it stays absent. Add a guardrail asserting no sale-of-goods TCS line/rate exists. | S | new `tests/guardrails/no-sale-of-goods-tcs.test.ts` |
| A26 | GST TCS s.52 — own goods only (OB-211) | DONE | `packages/storefront/src/listing-duties.ts`. Tests: `tests/integration/an-incomplete-product-is-not-published-online.test.ts` | — | — | — |
| A27 | Non-disableable dated audit trail | DONE | `services/kernel/src/audit-sink.ts`, `services/api/src/main.ts`. Tests: `tests/guardrails/audit-trail-cannot-be-disabled.test.ts` | Entity-type legal trigger (decision 1) is framing only; mechanism built regardless. | — | — |
| A28 | Statutory retention clocks + legal hold | DONE | `packages/audit/src/statutory-retention.ts`, `services/finance/src/retention.ts`. Tests: `tests/unit/audit-statutory-retention.test.ts`, `tests/integration/finance-retention.test.ts` | — | — | — |
| A29 | Append-only evidence; corrections are compensating events | DONE | `db/migrations/0004_append_only_guards.sql`, `0008_audit_log.sql`. Tests: `tests/guardrails/ledger-append-only.test.ts` | — | — | — |

### Addendum B1–B12 (addendum §1.2; B12 from gap analysis row 143)

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| B1 | Till blocks sale above MRP, no override | DONE | `packages/price-guard/src/price-guard.ts`. Tests: `tests/guardrails/a-real-trading-bill-is-never-above-the-mrp-total.test.ts`, `the-r3-till-refusals-have-no-override.test.ts` + trace row 821 tests | — | — | — |
| B2 | Dual-MRP guard | DONE | `packages/product/src/dual-mrp.ts`. Tests: trace row 828 (passed) | — | — | — |
| B3 | Unit sale price with ≤100 cm² / ≤₹35 exemptions | DONE | `packages/product/src/unit-price.ts`. Tests: `tests/unit/product-unit-price.test.ts`, `tests/integration/catalogue-unit-price.test.ts` | — | — | — |
| B4 | Statutory pack declarations block activation | DONE | `packages/product/src/pack-declarations.ts`. Tests: trace row 827 (passed) | — | — | — |
| B5 | Weighed-price billing never against the customer | DONE | Tests: trace row 1077, `tests/integration/a-weighed-item-is-sold-and-returned-in-grams.test.ts` | — | — | — |
| B6 | Verified-scale gate (OB-151 weighed items only) | DONE | `packages/facilities/src/weighing-verification.ts`, `packages/restricted-sales/src/till-gate.ts`. Tests: trace rows 829/1078/1089/1092 | Real scale certificates EXTERNAL. | — | — |
| B7 | Weighing-instrument register + expiry alerts | DONE | `packages/compliance/src/obligations.ts`. Tests: `tests/integration/compliance-obligations.test.ts` | — | — | — |
| B8 | Till hard-blocks expired batch at scan | DECISION | `packages/catalogue/src/catalogue.ts` (`ExpiredItemError`), GS1 date parse, cloud `sold_expired_batch` CRITICAL. Tests: `tests/unit/catalogue.test.ts`, `pos-barcode-scan.test.ts`, `service-pos.test.ts` | Works only when the barcode carries the date/batch (GS1, own labels). A plain barcode carries no batch, so an expired unit of such a product still scans; how to block it is the owner's choice (like OB-139 for recalls) → **D2**. | S–M | `packages/catalogue/src/catalogue.ts`, `edge/store-edge/src/screen-data.ts` |
| B9 | Loose-food allergens + veg/non-veg | DONE | `packages/product/src/loose-food-label.ts`, `services/catalogue/src/labelling.ts`. Tests: trace row 826 (passed) | — | — | — |
| B10 | FSSAI licence "stored, **surfaced for display**, and its expiry alerts" | PARTIAL | `packages/compliance/src/obligations.ts` (licence obligation + alerts). Tests: `tests/integration/compliance-obligations.test.ts`, `licence-expiry.test.ts` | No display surface: the licence number is not on the bill (`grep -i fssai packages/receipt apps/pos edge/store-edge` empty), the online store or a printable display board. Add a read of the current FSSAI licence for display and put it on the receipt footer/display board. | S | `packages/receipt/src/receipt.ts`, `edge/store-edge/src/store-pack.ts`, `services/compliance/src/obligations.ts` |
| B11 | Written recall plan + one-up/one-down export | DONE | `packages/quality/src/lot-trace.ts`, `docs/runbooks/product-recall.md`. Tests: `tests/unit/quality-lot-trace.test.ts`, `tests/integration/lot-trace.test.ts` | — | — | — |
| B12 | Block packaged drinking water / QCO goods without valid BIS/ISI mark — gap analysis "Adopt now (R2)" but **not listed** in the addendum's adopted table, §2 or §3 | DECISION | Not built (no BIS/ISI field outside B13 HUID) | Ambiguous status in the controlling documents → **D6**. | M (if built) | `packages/product/src/product.ts`, `packages/restricted-sales/src/till-gate.ts`, `services/catalogue/src/master-data.ts` |

---

## 2. Build packages (parallel, no shared files)

`services/api/src/adapters.ts` is a 13,000-line shared file; each package that needs adapter code puts it in its own new file (the repo already does this: `r3-gst-adapters.ts`, `r3-ops-adapters.ts`) and only adds one wiring line in `services/api/src/main.ts`. The four wiring lines in `main.ts` are the only expected merge touch-point.

**P1 — Recall and trace completion (L)** — M10-FR-03, M10-FR-04, WF-09.
Ordering block for recalled products; consent-checked recall notice list and send (after D8); owner alert on recall initiation; automatic pack publish on recall initiation; backward trace by sale/customer; read-audit of trace queries.
Files: `services/inventory/src/recall.ts`, `lot-trace.ts`, `lot-trace-chain.ts`, `sale-blocks.ts`; `services/purchase/src/` (PO guard file); new `services/customer/src/recall-notices.ts`; `services/catalogue/src/pack.ts` (publish trigger); new `services/api/src/lane2-recall-adapters.ts`; tests `tests/integration/a-recalled-product-cannot-be-ordered.test.ts`, `a-recall-tells-the-customers-who-consented.test.ts`, `a-trace-runs-backwards-from-a-sale.test.ts`.

**P2 — Store-box offline queues (L)** — M10-FR-01 (expiry sweep), M10-FR-02, M11-FR-01/02/03, WF-07 (offline + cancel).
Box-durable capture and synced routes for food-safety/temperature records, quality release, production runs, weighed runs, counter labels, transfer dispatch/receipt; daily expiry state move; transfer cancel before dispatch.
Files: `edge/store-edge/src/main.ts`, `screen-server.ts`, `screen-data.ts`; `edge/sync-agent/src/http-transport.ts`; `services/inventory/src/production.ts`, `weighed-costing.ts`, `quality-hold.ts`, `expiry.ts`, `warehouse-transfers.ts`; `services/platform/src/food-safety.ts`; `apps/web-erp/src/production-session.ts`, `transfers-session.ts`.

**P3 — Till and cash office completion (M)** — M12-FR-01 (scan telemetry), M12-FR-02 (delivery sale, after D10), M13-FR-02 (till recall set), M14-FR-04 (day evidence pack), B10 (licence on the bill), B8 (after D2).
Files: `apps/pos/src/session.ts`, `till-session.ts`, `browser-entry.ts`, `apps/pos/web/app.js`; `edge/store-edge/src/lane-server.ts`, `store-pack.ts`; `services/pos/src/sale-intake.ts`, `day-close.ts`; new `packages/day-close/src/evidence-pack.ts`; `packages/receipt/src/receipt.ts`; `packages/catalogue/src/catalogue.ts`; new `services/orders/src/store-delivery-sales.ts`; `apps/web-erp/src/day-book-session.ts`.
Note: P2 and P3 both touch `edge/store-edge` — P2 owns `main.ts`/`screen-*.ts`, P3 owns `lane-server.ts`/`store-pack.ts`; if P3 needs a new box pipeline, it asks P2.

**P4 — Loss prevention and fraud (M)** — M15-FR-02, M15-FR-03 (after D5).
Stateful fraud signals over stored coupons/points/COD/supplier invoices; signals in the LP inbox; employee bank accounts in the duplicate fold; employee-purchase policy flags; related-party register and disclosure check.
Files: `services/pos/src/fraud-signals.ts`, `loss-prevention.ts`; `packages/loss-prevention/src/` (new `related-party.ts`, `employee-purchases.ts`); `services/finance/src/payroll.ts` (read only of employee accounts); new `services/api/src/lane2-lp-adapters.ts`; `apps/web-erp/src/loss-prevention-inbox-session.ts`.

**P5 — Customer, loyalty and orders (M–L)** — M16-FR-04, M17-FR-01 (after D3), M17-FR-02 (after D4), M18-FR-02 split (after D9), M18-FR-04 refund desk screen.
Files: `services/customer/src/customer-360.ts`, `service-cases.ts`, `loyalty-members.ts`; new `packages/loyalty/src/tiers.ts`, `points-expiry.ts`; `packages/tenant/src/settings.ts`; `packages/orders/src/fulfilment-plan.ts`; `services/orders/src/index.ts`, `payments.ts`; new `apps/web-erp/src/order-refunds-session.ts` + page; `apps/web-erp/src/customers-session.ts`, `navigation.ts`.

**P6 — Gates, workflow proof and compliance guards (M)** — QG-05, QG-06, QG-08 helper, WF-06–WF-10 scenario matrices, WF-08 ledger refresh, A25 guardrail, A22/B12 (after D6/D7).
Files: new `tests/performance/catalogue-search-p95.test.ts`, `checkout-api-p95.test.ts`; `tests/performance/harness.ts`; `packages/compliance/src/risk.ts` (high blocks QG-06; findings intake); `services/compliance/src/` (findings route); `.github/workflows/ci.yml` (SAST + image scan); `services/platform/src/dr-readiness.ts` (QG-08 gate read); new `docs/requirements/workflows/WF-06.md` … `WF-10.md`; new `tests/guardrails/no-sale-of-goods-tcs.test.ts`; `docs/evidence/evidence-ledger.json` (regenerate via `scripts/evidence-ledger.mjs`); B12 in `packages/product/src/product.ts`, `packages/restricted-sales/src/till-gate.ts` (only if D6 = build; `till-gate.ts` is otherwise untouched by P3).

---

## 3. Owner decisions needed (each with options)

**D1 — Weighing when the scale fails (M12-FR-01 alternate path vs B6 verified-scale gate).**
- A — Never key a weight. Weighed items stop on that lane; the cashier sends the customer to another lane with a verified scale (as built; safest legally).
- B — Supervisor keys the weight read from another verified scale's printed ticket; the line records that scale's id and the supervisor; shows on the loss-prevention list. More convenient; a keyed weight is easier to abuse.
- C — Same as B, but only for a fixed number of lines per day per lane (owner sets the number).

**D2 — Expired stock with a plain barcode (B8).** The till cannot tell which batch a plain barcode is.
- A — Block the whole product at the till while any of its on-hand batches is past its date and not yet written off (same as OB-139 for recalls). Forces staff to clear old stock fast; fresh stock of that product also stops until they do.
- B — Date-sensitive products must carry a date in the barcode (GS1 or own labels); plain-barcode products rely on the daily expiry list and the head-office CRITICAL exception. No till stops; some risk an expired unit is sold.
- C — For flagged perishables, the cashier confirms the printed date on the pack before the line is added. Catches it at the till; adds one tap per item.

**D3 — Loyalty tiers and points expiry (M17-FR-01, store fact AVR-14).**
- Tiers: A — one tier only (no tiers); B — tiers by 12-month spend with a points multiplier, thresholds set by the owner in store setup, off until set; C — tiers with non-points benefits (free delivery, early offers), defined later.
- Expiry: A — points never expire; B — points expire N months after they are earned (owner sets N, off until set); C — points expire after N months with no purchase.
Note: expiring points reduces the liability on the books; the CA should confirm the accounting.

**D4 — What "subscriptions" means (M17-FR-02).**
- A — A paid membership plan (yearly fee, member benefits), sold at the till or in the app.
- B — Repeat online orders (e.g. milk every morning), placed automatically into M18 on a schedule.
- C — Not offered by SRE: record a written deferral to a named release (it stays in the product for other shops, OB-05).

**D5 — Staff purchases and related parties (M15-FR-03).**
- Staff purchases: A — staff may not bill themselves; any sale naming a staff member as customer is flagged daily to the manager; B — staff buy only at the service desk with a staff discount cap the owner sets; C — no restriction, only a monthly report.
- Related parties: A — owner keeps a list of related people/firms; any supplier or customer matching by GSTIN, phone or bank account needs his written approval before a purchase order; B — the list is only reported monthly, no block.

**D6 — BIS/ISI mark gate for packaged drinking water and other quality-control goods (B12).** The gap analysis says "Adopt now (R2)" but the addendum does not list it.
- A — Build it now: products in a quality-control category need a BIS licence number and expiry before they can be sold; the till refuses otherwise.
- B — Build it switched off; any shop that sells such goods switches it on.
- C — Do not build; record in writing that B12 is dropped from the roadmap, with the reason.

**D7 — B2C dynamic QR above ₹500 crore turnover (A22, "note only").**
- A — Keep note-only, recorded in writing; build only if a shop on the system reaches ₹500 crore.
- B — Build a small switched-off QR on B2C bills now (about one day).
- C — Defer in writing to a named later release.

**D8 — How affected customers are told about a recall (M10-FR-04).**
- A — A call list for staff (name, last four phone digits, what they bought); no messages sent by the system.
- B — An SMS/WhatsApp notice through the message provider when one is connected (switched off until then); only customers with consent for service messages.
- C — Both: the call list now, messages added when the provider is connected.

**D9 — Splitting an online order across two branches (M18-FR-02).**
- A — Never split: fill what one branch has, backorder the rest (as built today).
- B — Offer the split to the customer, who confirms (two deliveries; owner sets whether a second delivery fee applies).
- C — Split automatically when no single branch can fill the order, one delivery fee.

**D10 — Delivery sales at the till (M12-FR-02).**
- A — The customer pays in full at the till; the bill is marked "deliver"; it becomes a delivery job with no extra fee.
- B — As A, plus a delivery-fee line set by the owner.
- C — Pay on delivery (cash collected by the driver); the bill is held until delivered.

---

## 4. EXTERNAL items (software side and stand-in)

| item | needs | what software can still do |
|---|---|---|
| QG-05 / M12-FR-01 certified p95 | certified pilot hardware (AVR-06) | ship the scan-timing telemetry and p95 screen (P3) so the number is read on the day; CI headroom tests already exist |
| QG-06 penetration test | independent security vendor | findings intake, high-blocks-gate, SAST/image scan (P6) |
| QG-07 signed control totals | owner's real legacy extract; CA signature | already built and tested on synthetic data |
| QG-08 rehearsals | store computer, named incident team (G9/G10) | QG-08 gate read (P6); drills scripted (`scripts/lib/rollback-drill.mjs`) |
| MG-01–MG-06 on real data | old ERP access, owner, CA | tools built; run per `docs/cutover/` runbooks |
| M12-FR-03 integrated card/UPI | RBI-authorised provider + certified terminal (AVR-10, EX-03) | typed approval number (OB-274) and pending-tender recovery built |
| M13-FR-04 provider reversal | provider API | uncertain-until-statement engine built |
| M14-FR-03 settlement files | acquirer statement format | import validated on a stand-in file |
| M14-FR-04 CA sign-off | CA | evidence pack (P3) |
| M11-FR-03 scale/label printer | D14 hardware | label render + POS round-trip tested |
| M16-FR-01 SMS one-time code | SMS provider | built switched off with a test stand-in |
| M18-FR-03 road distance | maps provider | straight-line distance, stated as such |
| M18-FR-04 order refunds | payment gateway (EX-03) | test-mode processor; refund desk screen (P5) |
| A14 / A24 | CA's payee/heads/rates list | built switched off |
| A15 filing, A20 IRN, A23 EWB | GST portal/GSP credentials (EX-07); CA confirms TN EWB threshold | sandbox GSP/EWB built |
| B6 / B7 / B10 | real scale certificates, FSSAI licence | registers and alerts built |
| WF-06–WF-10 staff proof | staff UAT (SP-10, 0 sessions) | browser tests exist |

---

## 5. Count (79 items)

| status | count | items |
|---|---|---|
| DONE | 49 | M11-FR-04; M12-FR-03, -04; M13-FR-01, -03, -04; M14-FR-01, -02, -03; M15-FR-01, -04; M16-FR-01, -02, -03; M17-FR-03, -04; M18-FR-01, -03; WF-06, WF-08, WF-10; MG-01–06; A14–A19, A21, A23, A24, A26–A29; B1–B7, B9, B11 |
| PARTIAL | 21 | M10-FR-01–04; M11-FR-01–03; M12-FR-01, -02; M13-FR-02; M14-FR-04; M15-FR-02, -03; M16-FR-04; M18-FR-04; WF-07, WF-09; QG-05, QG-06; A25; B10 |
| MISSING | 0 | (missing pieces sit inside PARTIAL rows: delivery sales, recall ordering block/customer notice, offline production, employee purchases/related party, order-refund screen) |
| DECISION | 6 | M17-FR-01, M17-FR-02, M18-FR-02, A22, B8, B12 |
| EXTERNAL | 3 | QG-07, QG-08, A20 |

Notes for the coordinator:
- A14–A19 are listed in the addendum §3 as "R3 Finance"; they are signed R3 items (OB-188) and built, so they count as DONE.
- B12 is in my slice by number but is **not** an addendum row; it exists only in the gap analysis (row 143). Flagged as D6 rather than silently dropped or silently built.
- `docs/traceability.md` rows for M10-FR-01, M13-FR-01/03, M16-FR-01/03 still say "pending"/"follow-on" for things that are built, and the evidence ledger still labels WF-08 PARTIALLY_WIRED although `tests/integration/a-stock-count-is-planned-frozen-recounted-approved-and-booked.test.ts` proves the whole path; both should be refreshed by whichever package touches them (P6).
