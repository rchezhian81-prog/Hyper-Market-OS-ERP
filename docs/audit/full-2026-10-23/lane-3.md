# Full-roadmap gap audit — lane 3 (OB-288, 23 Oct 2026)

Slice: M19–M27 (36 FRs), WF-11–WF-15, QG-09–QG-12, MG-07–MG-12, D01–D07 (42 FRs), addendum B13–B24.
Read-only. Nothing edited, committed or pushed.

**How it was checked.** Each item was checked against the roadmap text (`roadmap-v2.0.txt`: §5, §16, §17, §22, §26 workflow table, §27 screen inventory, §31 offline matrix), `docs/requirements/M19–M27.md`, the addendum and gap analysis (B rows), `OWNER_DECISIONS_2026-08-11.md`, `docs/registers/decisions.md`, the signed R3/R4 sentences, and then **the code and tests themselves** (grep and read of `packages/`, `services/`, `apps/`, `edge/`, `infra/`, `tests/`). Labels in `traceability.md`, `completion-status.json` and `assignment-matrix-2026-10-10.md` were treated only as pointers. Some traceability rows are out of date. Example: D02-FR-06 is listed "NOT STARTED", but `services/finance/src/display-funding.ts` and `tests/integration/space-and-display.test.ts` exist.

**Tests run.** `npx vitest run` on the 241 unit and integration files for this slice (fulfilment, delivery, storefront, campaigns, service, b2b, supplier-portal, workforce, facilities, concession, period/tally, reconciliation, migration, EPR, restricted sales, label height, tobacco, HUID). Result: **235 files passed, 6 skipped. 2,286 tests passed, 52 skipped.** Log: `scratchpad/full/lane3-tests.log`. The skips are the PostgreSQL legs, because nothing was listening on 127.0.0.1:5432. So I did not use or drop any database. Browser e2e files (`tests/e2e/*.e2e.ts`) were **not run**. Where an e2e file is named below as evidence, I checked that it exists and what it covers; I did not run it.

**One cross-cutting gap: office screens.** Many headings below say "API + tests DONE, office screen missing." The roadmap requires screens for these. §27 lists "Delivery … assignments, route, … settlement", "CRM/Service … segments, campaigns", "Customer app … coupon, … loyalty", and "Finance … Tally queue". P-07 applies too: a non-programmer cannot drive a REST route. The web ERP navigation (`apps/web-erp/src/navigation.ts`) has **no page** for any of these:
- dispatch, waves and routes;
- B2B selling;
- campaigns;
- concessions;
- supplier-portal submissions review;
- facilities assets, cold rooms and energy;
- SOP and help.

I checked this against every `/v1/` path the ERP pages call.

---

## 1. Requirement table

Status key: DONE / PARTIAL / MISSING / DECISION / EXTERNAL. Size: S ≤1 day, M 2–4 days, L ≥1 week. "Pkg" = build package in §2.

### M19 — Picking, packing and delivery

| id | requirement (cited) | status | evidence (paths) | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M19-FR-01 | Wave/single picking, substitution preference, QC; assigned work cached offline (M19.md FR-01, §31 "Picking/delivery") | PARTIAL | Picker: `apps/picker-app/src/pick-session.ts` (bin-then-item scan, short, substitute, `failQuality`). Sync: `services/fulfilment/src/waves.ts`, `services/fulfilment/src/assignments.ts`. Tests: `tests/integration/picker-handheld-reaches-the-cloud-through-the-edge.test.ts`, `tests/e2e/picker-handheld-syncs-through-the-box.e2e.ts`, `tests/e2e/picker-substitution-delivery.e2e.ts`. | **Nobody can make a wave from confirmed orders.** `POST /v1/fulfilment/waves/:id/assignment` only accepts hand-written lines (lineId, bin, qty, price). Two things are needed. (1) A wave builder: take confirmed orders for a slot or store → lines with the bin from the location master and the price from the pack. Single-order picking is a wave of one. (2) A dispatcher page to build a wave, assign it and see progress. Pkg 1. | M | `packages/fulfilment/src/wave-plan.ts` (new), `services/fulfilment/src/assignments.ts`, `apps/web-erp/src/dispatch-session.ts` + `apps/web-erp/web/dispatch.{html,js}` (new), `apps/web-erp/src/navigation.ts` |
| M19-FR-02 | Pack with temperature/handling, weighed final price, cold-chain/tamper, manifest (FR-02, D09) | DONE | `packages/fulfilment/src/packing.ts`, `services/fulfilment/src/packing.ts`. Tests: `tests/unit/fulfilment-packing.test.ts`, `tests/integration/fulfilment-packing.test.ts`, `tests/integration/pick-to-doorstep.test.ts`. | — | — | — |
| M19-FR-03 | Own drivers **or delivery partners**, route **with geofence**, **proof photo/OTP/signature**, reassignment audited, PII minimised (FR-03) | PARTIAL | `packages/fulfilment/src/routing.ts` (`planDispatch`, `reassign`), `services/fulfilment/src/dispatch.ts`, `services/fulfilment/src/driver-runs.ts`, `apps/delivery-app/src/route-session.ts`. Tests: `tests/unit/dispatch-routing.test.ts`, `tests/integration/dispatch.test.ts`, `tests/e2e/delivery-route-partial-delivery.e2e.ts`. | (a) **The geofence is never worked out.** `deliver()` takes `withinGeofence`, but `apps/delivery-app/web/app.js` lines 705 and 772 never pass it, and no stop carries a fence. Fix: add a fence to each stop (coarse centre + radius) and check it on the phone, sending only yes or no; no coordinates leave the phone. (b) **The OTP is only a typed reference.** Nothing issues a code to the customer or checks it. Fix: a code per order shown in the customer app, checked at head office. (c) **"Photo" is just a kind plus a typed reference.** Fix: camera capture kept on the phone, with only a hash and a reference sent. (d) **There is no partner model** (`LocationKind 'partner'` exists only in the order router). That part is DECISION D-1. (e) The dispatcher page to plan, assign and reassign routes (shared with FR-01). Pkg 1. | L | `packages/fulfilment/src/routing.ts`, `packages/fulfilment/src/delivery.ts`, `apps/delivery-app/src/route-session.ts`, `apps/delivery-app/src/browser-entry.ts`, `apps/delivery-app/web/app.js`, `services/fulfilment/src/index.ts`, `services/orders/src/storefront.ts` (delivery code read) |
| M19-FR-04 | COD to the paisa, failure reason, reattempt/RTO, SLA, contribution stop, OB-09 outcomes (FR-04) | DONE | `packages/fulfilment/src/cod.ts`, `services/fulfilment/src/order-fulfilment.ts` (COD becomes a banked sale and reaches the day book), `services/fulfilment/src/driver-runs.ts`. SLA and contribution reports: `packages/reporting/src/catalogue.ts` (`delivery_sla`, `delivery_contribution`). Tests: `tests/integration/cod-reconciliation.test.ts`, `tests/integration/one-fulfilment-command.test.ts`, `tests/integration/a-late-delivery-exception-is-told-to-its-queue.test.ts`. | — | — | — |

### M20 — Customer app and web commerce

| id | requirement (cited) | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M20-FR-01 | OTP/account, search/filters, **barcode/voice input**, EN/TA (FR-01) | PARTIAL | `apps/customer-app/web/app.js` (`/auth/otp/begin`, `/auth/otp/verify`, EN/TA, search), `apps/customer-app/src/voice-search.ts` (switched off, OB-222), `packages/storefront/src/browse.ts`. Tests: `tests/unit/storefront-browse.test.ts`, `tests/unit/customer-app.test.ts`. | **Barcode means typing digits into search.** There is no camera scan. Fix: use the phone's camera barcode reader where the phone has one, with typing as the fallback. Low-spec safe. The SMS OTP provider is EXTERNAL (OB-222 stand-in). Pkg 2. | S | `apps/customer-app/web/app.js`, `apps/customer-app/web/index.html` |
| M20-FR-02 | Cart, lists, favourites, repeat, **consent-safe recommendations**; customer confirms substitution (FR-02; §27 "coupon … loyalty") | PARTIAL | Favourites, lists and repeat order are built: `services/orders/src/storefront-self.ts`, `apps/customer-app/src/shopping-session.ts`. Substitution is confirmed by the customer: `tests/integration/storefront-orders.test.ts`. | (a) **`recommend()` in `packages/storefront/src/browse.ts` is never called outside tests.** Fix: serve it on product/cart, scoped by the consent read. (b) **The online cart has no promotions, coupons or loyalty.** No promotion or discount code in `services/orders/src/storefront.ts`, `packages/storefront/src/checkout.ts` or the app. This breaks P-02 (one commerce truth) and §27. Fix: price the online basket through the same promotion engine and coupon redemption; show the points balance. Pkg 2. | M | `packages/storefront/src/checkout.ts`, `services/orders/src/storefront.ts`, `services/orders/src/storefront-self.ts`, `apps/customer-app/src/shopping-session.ts`, `apps/customer-app/web/app.js` |
| M20-FR-03 | Slots, online payment (provider token), tracking, **notifications**, digital receipts, support (FR-03) | PARTIAL | Built: slots (`packages/storefront/src/checkout.ts`, `serviceability-schedule.ts`); tracking (`tests/integration/a-customer-reads-a-delivery-in-progress.test.ts`); receipts (`services/customer/src/digital-receipts.ts`); support and complaints (`tests/integration/service-requests.test.ts`); out-of-area refusal (`a-delivery-slot-and-address-are-the-shops-to-judge.test.ts`). | (a) **No order-status notification is ever queued.** The only calls to `enqueue(` come from campaigns and the morning brief. Fix: on order confirmed, needs-your-decision, out for delivery, delivered and refund issued, enqueue a *service-purpose* message through `services/customer/src/notification-queue.ts`, which already checks consent. (b) The payment provider sheet is EXTERNAL (`app.js` sends `providerRef: window.shopPaymentRef ?? 'tok_pending'`). Pkg 2. | M | `services/orders/src/storefront.ts`, `services/fulfilment/src/order-fulfilment.ts`, `services/customer/src/notification-queue.ts`, `services/api/src/adapters.ts` |
| M20-FR-04 | Ratings, WCAG 2.2 AA, privacy centre, **account controls (addresses, payment tokens, delete)**, low bandwidth (FR-04) | PARTIAL | Ratings: `tests/integration/only-a-buyer-can-rate-a-product.test.ts`. WCAG: `tests/e2e/the-customer-app-meets-wcag-aa.e2e.ts`. Privacy and erasure: `apps/customer-app/src/privacy-centre.ts`, `tests/integration/data-rights.test.ts`. | (a) **No saved-address or saved-payment-token controls** (no `/v1/me/addresses` route). Fix: saved addresses (coarse, minimised) with delete, plus a "remove saved payment" stand-in. (b) **No low-bandwidth test** exists (test family "low-bandwidth performance"). Fix: a payload-budget test on the app shell plus a throttled-network e2e. A real low-spec phone is EXTERNAL. Pkg 2. | S | `services/orders/src/storefront-self.ts`, `apps/customer-app/web/app.js`, `tests/performance/customer-app-payload.test.ts` (new) |

### M21 — CRM, marketing and service desk

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M21-FR-01 | Consent-safe segments and sends, frequency caps, delivery status (FR-01; §27 "segments, campaigns") | PARTIAL | `packages/service-desk/src/campaigns.ts`, `services/customer/src/campaigns.ts`, `services/customer/src/campaign-send.ts`. Tests: `tests/integration/campaign-consent.test.ts`, `tests/integration/a-campaign-goes-through-the-queue-within-the-cap.test.ts`. | **There is no Campaigns page.** The ERP only calls `/v1/ai/marketing` drafts and never `/v1/service/campaigns/*`. Fix: build a page to plan (reachable count after consent), approve, send and see delivery status. The real providers are EXTERNAL. Pkg 2. | M | `apps/web-erp/src/campaigns-session.ts` + `apps/web-erp/web/campaigns.{html,js}` (new), `apps/web-erp/src/navigation.ts` |
| M21-FR-02 | Abandoned-cart, occasion and win-back journeys; attribution (FR-02) | PARTIAL | `POST /v1/service/campaigns/journeys/:kind/candidates`. Tests: `tests/integration/campaign-journeys.test.ts`. | **The triggers are typed in by the caller.** The cart lives only on the phone, so head office never learns of an abandoned cart. No occasion date is captured. Lapse is not worked out from sales. Fix: work the triggers out from stored facts (a server-held cart for signed-in customers, an occasion date captured with consent, the last purchase from the sales ledger), run them on a schedule, and keep the caps. Pkg 2. | M | `services/customer/src/campaigns.ts`, `services/orders/src/storefront-self.ts`, `packages/service-desk/src/campaigns.ts` |
| M21-FR-03 | Complaint/enquiry/warranty/lost-and-found, compensation maker-checker, AI drafts with human commit (FR-03) | DONE | `packages/service-desk/src/service-cases.ts`. Tests: `tests/integration/service-compensation.test.ts`, `tests/integration/service-ai-drafts.test.ts`, `tests/e2e/service-desk-and-assistant-drafts.e2e.ts`. | — | — | — |
| M21-FR-04 | SLA, escalation, resolution, CSAT, report (FR-04) | DONE | Tests: `tests/integration/service-cases.test.ts`, `tests/integration/service-csat.test.ts`; route `/v1/service/report`. | — | — | — |

### M22 — B2B and institutional sales

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M22-FR-01 | Per-customer **price list, credit limit, terms, contract**; expired contract per policy (FR-01) | PARTIAL | `packages/b2b/src/credit.ts`, `services/finance/src/b2b-credit.ts`. Tests: `tests/integration/b2b-credit.test.ts`. | **There is no contract record.** `contractExpired` is a flag the caller sends. Quotations take whatever price the caller gives. The `customer` price scope in `packages/price-list` is not tied to B2B. Fix: a B2B contract register (price list per product, valid from/to, terms, policy on expiry) with maker-checker; quotes and orders priced from it; expiry worked out from the dates. Pkg 3. | M | `packages/b2b/src/contracts.ts` (new), `services/finance/src/b2b-contracts.ts` (new), `services/finance/src/b2b-documents.ts`, `services/api/src/adapters.ts` |
| M22-FR-02 | Quote → order → proforma → challan → invoice, gap-free numbers, GST (FR-02) | PARTIAL | `packages/b2b/src/documents.ts`, `services/finance/src/b2b-documents.ts`. Tests: `tests/integration/b2b-documents-chain.test.ts`, `b2b-documents-chain-2.test.ts`. | The document flow is proven. **Staff have no page to run it** (P-07): no B2B entry in the ERP navigation. Fix: a B2B desk page (accounts, quotes, convert, challan, invoice, collections). The IRN for B2B invoices is the A20 lane, not here. Pkg 3. | M | `apps/web-erp/src/b2b-desk-session.ts` + `apps/web-erp/web/b2b.{html,js}` (new), `apps/web-erp/src/navigation.ts` |
| M22-FR-03 | Bulk/recurring orders, salesperson, exact commission (FR-03) | DONE | Routes `/v1/b2b/recurring*`, `/v1/b2b/commissions/*`. Tests: `tests/integration/b2b-commission.test.ts`, `tests/unit/b2b.test.ts`. | — | — | — |
| M22-FR-04 | Portal (own data only), outstanding, collections, AR reconcile (FR-04) | DONE | `apps/b2b-app/`. Tests: `tests/integration/b2b-portal.test.ts`, `tests/integration/b2b-reconcile-ar.test.ts`, `tests/e2e/b2b-portal-on-the-production-api.e2e.ts`. | — | — | — |

### M23 — Finance, tax and accounting bridge

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M23-FR-01 | Ledger mapping, journals, AP/AR, **cost/profit centres**; trial balance and AP/AR reports (FR-01) | PARTIAL | Mapping, journals and AP: `packages/finance/src/posting.ts`, `day-book.ts`, `payables.ts`, `services/finance/src/period-books.ts` (P&L). Tests: `tests/unit/finance-posting.test.ts`, `tests/integration/the-period-books-reconcile-and-show-profit.test.ts`. | (a) **Cost and profit centres appear only on payroll** (`services/finance/src/payroll.ts`). Sales, purchase and stock journals carry no centre, and there is no centre report. Fix: a department/branch centre field on postings plus a centre report that ties to the ledger. (b) **There is no trial balance report** (only P&L). Pkg 4. | M | `packages/finance/src/posting.ts`, `packages/finance/src/day-book.ts`, `services/finance/src/period-books.ts`, `apps/web-erp/web/finance.js` |
| M23-FR-02 | GST config, credit/debit notes, tax-audit evidence (FR-02) | DONE | Tests: `tests/integration/credit-note-reconciliation.test.ts`, `tests/integration/gst-returns.test.ts`, `tests/integration/gstr3b-matches-the-sales-ledger.test.ts` (R2/R3 signed). | — | — | — |
| M23-FR-03 | Cash/bank/card/UPI/gateway/refund reconciliation (FR-03) | DONE (stand-in files) | `packages/reconciliation/src/reconciliation.ts`, `packages/finance/src/bank-statement.ts`, `/v1/finance/bank-statements`, `/v1/finance/payment-exceptions`. Tests: `tests/unit/reconciliation.test.ts`, `tests/integration/order-channel-reconcile.test.ts`. | The bank and acquirer file formats are EXTERNAL (see §4). | — | — |
| M23-FR-04 | **Tally connector with retry and dead-letter queue**; balances validated at period close (FR-04; §27 "Tally queue") | PARTIAL | Engine only: `packages/period-close/src/tally-connector.ts` (`drainToTally`, `deadLetters`), tested in `tests/unit/period-close.test.ts`. Close and evidence: `services/finance/src/period-evidence.ts`, `tests/integration/period-evidence.test.ts`. | **The Tally bridge is not wired.** `drainToTally` has no caller in `services/` or `apps/`; no Tally posting queue is stored; there is no drain worker and no Tally adapter. The evidence pack's `deadLetteredCount` is a number the caller sends. Fix: a stored Tally queue fed from posted journals, a drain worker with backoff, a dead-letter list kept and shown, a Tally voucher adapter (an XML file to import or the Tally HTTP port, see D-12) proven against a stand-in, a "Tally queue" panel on the Finance page, and the close reading the real dead-letter count. Pkg 4. | L | `services/finance/src/tally-queue.ts` (new), `packages/period-close/src/tally-xml.ts` (new), `services/finance/src/period-evidence.ts`, `services/api/src/adapters.ts`, `services/api/src/main.ts`, `apps/web-erp/src/finance-session.ts`, `apps/web-erp/web/finance.js` |

### M24 — Supplier and partner portals

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M24-FR-01 | RFQ response, catalogue/cost proposals, ASN, invoice; nothing commits without buyer acceptance (FR-01) | PARTIAL | `packages/supplier-portal/src/portal.ts` (`SubmissionKind`), `services/purchase/src/supplier-portal.ts`, `apps/supplier-app/`. Tests: `tests/integration/supplier-portal-feeds-purchasing.test.ts`, `supplier-portal-scoping.test.ts`, `tests/e2e/supplier-portal-delivery.e2e.ts`. | **The buyer has no review page.** `/v1/supplier-portal/partners/:id/submissions/:sid/review` exists, but no ERP page calls it. Fix: a buyer review page (accept or reject with a reason). Pkg 3. | S | `apps/web-erp/src/supplier-submissions-session.ts` + `web/supplier-submissions.{html,js}` (new), `apps/web-erp/src/navigation.ts` |
| M24-FR-02 | PO acknowledgement, **delivery status update**, claims, statement tied to AP (FR-02) | PARTIAL | `po_acknowledgement` and `claim` kinds exist. Tests: `tests/integration/supplier-portal-statement.test.ts`, `supplier-portal.test.ts`. | **There is no delivery-status update** (dispatched / in transit / delayed with a date) that the buyer can see. Fix: add a `delivery_status` submission kind and show it on the PO. Pkg 3. | S | `packages/supplier-portal/src/portal.ts`, `services/purchase/src/supplier-portal.ts`, `apps/supplier-app/web/app.js` |
| M24-FR-03 | Isolation, document expiry blocks action, partner audit trail (FR-03) | DONE | Tests: `tests/integration/supplier-portal-compliance.test.ts`, `supplier-portal-probing.test.ts`, `supplier-portal-durability.test.ts`. | — | — | — |
| M24-FR-04 | API/**EDI** for high-volume partners, sandbox, certification (FR-04) | DECISION | Built: partner API keys, sandbox and certification (`/v1/platform/partners/*`, `tests/integration/partner-certification.test.ts`). No EDI format exists (no EDIFACT/X12/EANCOM code). | Which EDI standard, if any: see D-2. A real partner is EXTERNAL. | M | `packages/integration/src/edi-*.ts` (new, if chosen) |

### M25 — Workforce, tasks and enablement

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M25-FR-01 | Assignment, **authorization matches assignment**, roster, attendance (FR-01) | PARTIAL | `services/finance/src/roster-store.ts`, `attendance-store.ts`, `/v1/hr/workforce/roster-gaps`. Tests: `tests/integration/roster-store.test.ts`, `attendance-store.test.ts`, `workforce-roster.test.ts`. | **Workforce roles and sign-in permissions are separate records.** Nothing checks or reports that a person's grants match their assignment (acceptance: "an employee's access matches their assignment"). Fix: a check that compares roster roles and branches with the identity grants and lists each mismatch as an exception. Pkg 5. | S | `packages/workforce/src/access-match.ts` (new), `services/finance/src/roster-store.ts`, `services/identity/src/` (read only) |
| M25-FR-02 | Daily tasks, opening/closing, handover, escalation, offline completion (FR-02) | DONE | Tests: `tests/integration/offline-completions-reach-the-cloud-through-the-edge.test.ts`, `task-store.test.ts`, `checklist-store.test.ts`, `tests/e2e/checklist-delivery.e2e.ts`. | — | — | — |
| M25-FR-03 | **Training**, certification, **productivity**, incentives (FR-03) | PARTIAL | Certification gate and incentive: `services/finance/src/cert-store.ts`, `/v1/hr/workforce/incentive`. Tests: `tests/integration/cert-store.test.ts`. | **No assigning training, and no productivity measure** ("productivity" appears nowhere in `packages/workforce` or `services/finance`). Fix: a training-assignment register (assigned → completed → certificate) and a productivity measure (see D-10). Pkg 5. | M | `packages/workforce/src/training.ts` (new), `packages/workforce/src/productivity.ts` (new), `services/finance/src/cert-store.ts` |
| M25-FR-04 | Role-aware SOP/**help centre**, acknowledgement, **help works offline** (FR-04) | PARTIAL | `services/finance/src/sop-store.ts` stores only title, version and roles, with acknowledgements. Tests: `tests/integration/sop-store.test.ts`. | **SOPs have no content, and staff have no page to read or acknowledge them.** No app calls `/v1/hr/workforce/sops`. Nothing is cached offline. Fix: SOP body EN/TA with a version, a role-scoped help page in the ERP and on the handhelds, acknowledgement from the device, and help cached in the service worker. The existing `docs/sop/*.md` are the first content. Pkg 5. | M | `services/finance/src/sop-store.ts`, `apps/web-erp/web/help.{html,js}` (new), `apps/*/web/sw.js`, `apps/web-erp/src/navigation.ts` |

### M26 — Facilities, assets and maintenance

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M26-FR-01 | Asset, warranty, AMC, service, spares; expiry alerts (FR-01) | PARTIAL | `packages/facilities/src/assets.ts`, `services/platform/src/facilities-assets.ts`. Tests: `tests/integration/facilities-assets.test.ts`. | **No page for the asset register.** The Facilities page reads only `/overdue` and `/tasks`. Fix: an asset register page with AMC/warranty warnings. Pkg 5. | S | `apps/web-erp/src/facilities-session.ts`, `apps/web-erp/web/facilities.{html,js}` |
| M26-FR-02 | Cold room/power/UPS/DG, IoT-ready, breach → quality hold; **readings cache/queue offline** (FR-02) | PARTIAL | `packages/facilities/src/monitoring.ts`, `services/platform/src/facilities-monitoring.ts`. Tests: `tests/integration/facilities-monitoring.test.ts`, `cold-room-breach-holds-stock.test.ts`. | (a) **No page** for equipment ranges or readings. (b) **No offline queue on the store box** for manual readings (M26.md "readings cache/queue"; `edge/store-edge` has no equipment path). IoT sensors are EXTERNAL. Pkg 5. | M | `edge/store-edge/src/main.ts`, `edge/store-edge/src/cloud-facilities.ts` (new), `apps/web-erp/web/facilities.js` |
| M26-FR-03 | Cleaning, pest, fire, safety schedules; evidence; escalation (FR-03) | DONE | Tests: `tests/integration/facilities-schedules.test.ts`, `tests/e2e/facilities-delivery.e2e.ts`. | — | — | — |
| M26-FR-04 | Energy, downtime, incidents, compliance evidence (FR-04) | PARTIAL | `/v1/facilities/energy`, `/assets/downtime`, `/incidents`. Tests: `tests/integration/facilities-incidents.test.ts`. | **No page** for energy, downtime or facility incidents (`incidents.html` is the platform incident page). Pkg 5. | S | `apps/web-erp/web/facilities.js` |

### M27 — Concession and shop-in-shop

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| M27-FR-01 | Contracts, deposits, rent/revenue share, utilities (FR-01) | PARTIAL | `packages/concession/src/concession.ts`, `services/finance/src/concession.ts`. Tests: `tests/integration/concession.test.ts`, `tests/unit/concession.test.ts`. | **There is no concession page** (only an approval label in `approvals-session.ts`). Fix: a Concessions page (contracts, deposit, period charge, settlement, may-trade). Whether SRE runs any concessions is open: D-8. Pkg 3. | M | `apps/web-erp/src/concession-session.ts` + `web/concession.{html,js}` (new), `apps/web-erp/src/navigation.ts` |
| M27-FR-02 | Separate stock ownership, restricted access (FR-02) | DONE | Tests: `tests/integration/concession-store-valuation.test.ts`, `concession-write-off-guard.test.ts`; route `/v1/concession/stock-access`. | — | — | — |
| M27-FR-03 | Counter sales settlement and reconciliation (FR-03) | DONE | Tests: `tests/integration/concession-tags-reach-settlement.test.ts`, `till-concession-tags-reach-the-cloud-through-the-edge.test.ts`, `tests/e2e/till-concession-tag-through-the-box.e2e.ts`. | — | — | — |
| M27-FR-04 | Agreement/insurance/licence expiry **alerts**; lapse blocks sales (FR-04) | PARTIAL | Blocking is built (`/may-trade`, `/trading-breaches`, `tests/unit/concession.test.ts`). | **The warning reaches nobody.** It is worked out only when someone reads the route; there is no page and no item in the ops or owner inbox. Fix: a 30/7-day warning in the Concessions page and the owner's exceptions. Pkg 3. | S | `services/finance/src/concession.ts`, `apps/web-erp/web/concession.js` |

### Workflows WF-11 to WF-15 (§26)

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| WF-11 | POS return: eligibility → inspect → approval → refund/exchange/credit → disposition → reconcile | DONE (live refund reversal EXTERNAL) | Tests: `tests/integration/returns-reconcile-on-sync.test.ts`, `a-held-returned-unit-gets-a-persons-decision.test.ts`, `tests/e2e/held-returns-decided-on-the-production-api.e2e.ts`, `return-governance-delivery.e2e.ts`. | §26 also requires nine scenarios for every workflow (happy, alternate, cancellation, permission-denied, offline, timeout, duplicate, recovery, audit). No matrix records them anywhere. See the cross-cutting row below. | — | — |
| WF-12 | Day close: lane close → blind cash → pickups/safe → settlement → exceptions → store close → accounting | DONE (bank deposit and acquirer file EXTERNAL) | Tests: `tests/integration/a-day-closes-with-a-pending-payment-carried-to-head-office.test.ts`, `day-close-reconcile-on-sync.test.ts`, `tests/e2e/manager-day-close-delivery.e2e.ts`, `the-served-till-closes.e2e.ts`. | — | — | — |
| WF-13 | Customer order: serviceability → browse → **cart/promotion** → slot → payment → reserve/route → confirm | PARTIAL | Tests: `tests/integration/storefront-orders.test.ts`, `tests/e2e/customer-order-delivery.e2e.ts`. | **The promotion step is missing online** (same gap as M20-FR-02(b)). Payment is EXTERNAL. Pkg 2. | M | as M20-FR-02 |
| WF-14 | Fulfilment: wave/pick → substitution → weighted price → QC/pack → dispatch/pickup | PARTIAL | Tests: `tests/integration/pick-to-doorstep.test.ts`, `one-fulfilment-command.test.ts`, `tests/e2e/picker-substitution-delivery.e2e.ts`. | **The wave step cannot be started from orders** (M19-FR-01 wave builder and dispatcher page). Pkg 1. | M | as M19-FR-01 |
| WF-15 | Delivery: assign/route → handover → track → proof/COD → failure/reattempt/RTO → settlement | PARTIAL | `services/fulfilment/src/driver-runs.ts` (handover/settled synced). Tests: `tests/integration/delivery-state.test.ts`, `cod-reconciliation.test.ts`. | **Proof is not really captured** (geofence, OTP, photo) and there is no dispatcher page (M19-FR-03). The courier and maps provider is EXTERNAL. Pkg 1. | L | as M19-FR-03 |
| WF-11…15 matrix | §26 WORKFLOW RULE: nine scenarios per workflow; financial and stock effects reconcile | PARTIAL | No scenario-matrix test or document in `tests/` or `docs/` (searched). | A guardrail test that maps each of the nine scenarios of WF-11 to WF-15 to a named existing test, fails on a gap, and fills the gaps it finds. Pkg 4. | M | `tests/guardrails/every-workflow-has-its-nine-scenarios.test.ts` (new), `docs/traceability.md` |

### Quality gates QG-09 to QG-12 (§22)

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| QG-09 | Adoption: role curriculum, competency, floor support, SOP acknowledgements complete | MISSING | Nothing named curriculum, competency or floor champion exists in `packages`, `services` or `apps` (searched). SOP acknowledgement status exists (`/v1/hr/workforce/sop-status`). | An adoption gate report per role: curriculum items (D-11), competency signed by a second person, the floor-support rota, SOP acknowledgement of the current version, giving GO or HOLD with the missing names. Staff actually completing it is EXTERNAL. Builds on M25-FR-03 and FR-04. Pkg 5. | M | `packages/workforce/src/adoption-gate.ts` (new), `services/finance/src/adoption.ts` (new), `apps/web-erp/web/adoption.{html,js}` (new) |
| QG-10 | Production: health, smoke, **reconciliation**, monitoring and rollback verified **after every release** | PARTIAL | `infra/deploy/release.sh` (READY wait, stand-up check, bake/canary, automatic rollback). Tests: `tests/integration/the-release-script-deploys-and-rolls-back.test.ts`, `the-demo-smoke-script-proves-the-loop.test.ts`. | **No post-release reconciliation step, and no QG-10 record per release.** Fix: after READY, run a reconciliation probe (books to registers, sync lag, dead letters) and write a per-release record (health, smoke, reconcile, monitor, rollback-ready) that the release refuses to mark GREEN without. The production environment is EXTERNAL. Pkg 4. | S | `infra/deploy/release.sh`, `scripts/lib/post-release-check.mjs` (new), `tests/integration/the-release-script-deploys-and-rolls-back.test.ts` |
| QG-11 | AI: accuracy/safety evaluations, authority, evidence, override, budgets, kill switch | EXTERNAL | `services/ai/src/evaluation-set.ts` (`liveProviderGate`), `packages/ai/src/{authority,budget,safety,evaluation}.ts`. Tests: `tests/unit/ai-evaluation.test.ts`, `ai-authority.test.ts`, `ai-budget.test.ts`, `ai-safety.test.ts`, `tests/integration/ai-model-calls-are-governed.test.ts`. | The software is complete with the stand-in model. Accuracy against the live model needs a chosen provider. | — | — |
| QG-12 | Owner: **every gate ends GO, HOLD or REWORK with evidence; silence is not approval** | PARTIAL | Risk blocks gates: `services/compliance/src/risk.ts` (`/v1/compliance/gates/:gate/can-pass`), `apps/web-erp/web/risk-acceptance.*`. The cutover owner GO is in `packages/migration/src/cutover.ts`. | **There is no gate-decision register.** Nothing records, per gate and release, GO/HOLD/REWORK, the evidence links and the named decider, and nothing refuses a GO without evidence or with an open blocking risk. Fix: a register, a guardrail that no gate has a default decision, and an owner page. Pkg 4. | M | `packages/compliance/src/gate-decisions.ts` (new), `services/compliance/src/gate-decisions.ts` (new), `apps/web-erp/web/gates.{html,js}` (new) |

### Migration controls MG-07 to MG-12 (§17)

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| MG-07 | History: all usable history and attachments; any exclusion needs written evidence and owner approval | DONE (real extract EXTERNAL) | `packages/migration/src/history.ts`, `history-load.ts`. Tests: `tests/integration/migration-history-exclusions.test.ts`, `history-and-open-orders-load.test.ts`. | — | — | — |
| MG-08 | Opening state: stock by location/batch, open orders, outstanding, loyalty/gift, accounting; signed off | DONE (real data EXTERNAL) | Tests: `tests/integration/opening-state-loads.test.ts` (second-person sign-off), `an-opening-load-is-reversed-only-in-the-cutover-window.test.ts`. PostgreSQL legs skipped here. | — | — | — |
| MG-09 | Delta: freeze or capture changes after the final extract; load exactly once | DECISION | Apply-once is built: `tests/integration/a-delta-lands-once.test.ts`, `a-sale-delta-lands-once.test.ts`. Capture is written down only, not built: `docs/runbooks/real-data-load.md` (questions D-1/D-2 unanswered). | The capture method is D-5. | S–M | `packages/migration/src/export-diff.ts` (new, option b) |
| MG-10 | Parallel run for the approved period, **reconciled daily** | PARTIAL | `packages/migration/src/cutover.ts` (`COMPARISON_AREAS`: sales, count, stock movement, tax, payments, loyalty, item lines, bills), `parallel-day-sign.ts`, `evening-check.ts`. Tests: `tests/integration/a-parallel-day-cannot-be-signed-with-an-unexplained-difference.test.ts`, `tests/e2e/the-migration-screen-runs-a-parallel-day.e2e.ts`. | **Purchases, the stock balance, supplier/customer balances and margin are not compared each day** (STATUS "Known limits: purchase/balance/margin daily controls not covered"). Fix: add those comparison areas and their old-ERP report parsers. Pkg 4. | M | `packages/migration/src/cutover.ts`, `packages/migration/src/old-erp-reports.ts`, `packages/migration/src/evening-check.ts`, `services/migration/src/parallel-day-routes.ts` |
| MG-11 | Cutover: rehearsed checklist with **backup**, go/no-go, **rollback thresholds**, named command team | PARTIAL | `packages/migration/src/cutover.ts` (`decideCutover`, `RollbackTrigger`), `cutover-checklist.ts` (named team), `scripts/rollback-drill.mjs`. Tests: `tests/integration/a-rehearsed-rollback-reconciles.test.ts`, `tests/unit/the-rollback-drill-is-timed-and-refuses-production.test.ts`. | **The checklist has no backup check and no agreed rollback thresholds.** Fix: a `backup_verified` check (a verified backup within N hours, read from the backup report) and numeric thresholds agreed before the night (control-total difference, edge outage minutes, time window) that raise the rollback trigger by themselves. The rehearsal on the store PC (G9) is EXTERNAL. Pkg 4. | S | `packages/migration/src/cutover.ts`, `packages/migration/src/cutover-checklist.ts` |
| MG-12 | Archive/retire: legacy read-only until needs met; then revoke and retire | DONE (old-ERP revoke EXTERNAL) | `packages/migration/src/history.ts` (`assessRetirement`), `services/migration/src/legacy-history.ts`. Tests: `tests/integration/migration-retirement.test.ts`. | — | — | — |

### Extensions D01–D07 (§16)

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| D01-FR-01 | GS1/GTIN/EAN/UPC and internal barcodes | DONE | `packages/gs1/src/gs1.ts`. Tests: `tests/integration/barcode-register.test.ts`, `tests/unit/pos-barcode-scan.test.ts`. | — | — | — |
| D01-FR-02 | Alternate/embedded weight-price barcodes | DONE | `EmbeddedBarcodeRule` (catalogue), `packages/production/src/scale-label.ts`, `apps/pos/src/view-adapter.ts:261`. Tests: `tests/unit/the-till-judges-what-is-charged-and-its-own-units.test.ts`. | — | — | — |
| D01-FR-03 | Unit-inner-case-pallet hierarchy and pack breaking | DONE | Tests: `tests/integration/pack-hierarchy.test.ts`, `pack-chain-case-to-base.test.ts`. | — | — | — |
| D01-FR-04 | Ingredients, allergens, **nutrition**, origin, storage | PARTIAL | `packages/product/src/product.ts` (ingredients, allergens, countryOfOrigin, storageConditions). | **There is no nutrition field anywhere** (no "nutrition" in packages, services or apps). Fix: an optional nutrition panel on the product master, shown in the app; required only where the CA or legal list says. Pkg 6. | S | `packages/product/src/product.ts`, `services/catalogue/src/product-master.ts`, `apps/customer-app/web/app.js` |
| D01-FR-05 | Regulated-item flags and recall block | DONE | `packages/product/src/category-policy.ts`. Tests: `tests/integration/a-recalled-tin-cannot-be-sold.test.ts`, `a-recalled-batch-is-refused-and-its-sibling-sells-offline.test.ts`. | — | — | — |
| D01-FR-06 | App content, images, synonyms, typo tolerance, completeness | DONE | R4 signed (OB-215). Tests: `tests/integration/product-content-versions-and-images-are-kept-on-the-shops-server.test.ts`, `product-content-and-synonyms-reach-the-customer-app.test.ts`. | — | — | — |
| D02-FR-01 | Open-to-buy and category budgets | DONE | Tests: `tests/integration/a-purchase-order-is-checked-against-open-to-buy.test.ts`, `tests/e2e/open-to-buy-on-the-production-api.e2e.ts`. | — | — | — |
| D02-FR-02 | **Seasonal assortment and store clustering** | PARTIAL | Range decisions are effective-dated with a `seasonal_end` reason (`packages/merchandising/src/assortment.ts`). Price zones exist (`services/pricing/src/channel-pricing.ts`). | **Clustering was deferred to R8 (OB-65); OB-288 brings it back into scope.** Missing: a store→cluster register applied to the assortment, and a season plan (list from/to with automatic clearance at season end). Pkg 6. See D-4. | M | `packages/merchandising/src/clusters.ts` (new), `packages/merchandising/src/assortment.ts`, `services/inventory/src/assortment.ts` |
| D02-FR-03 | New/discontinued/clearance lifecycle | DONE | D-16 signed (OB-189). Tests: `tests/integration/a-discontinued-product-cannot-be-ordered-even-without-a-store-range.test.ts`. | — | — | — |
| D02-FR-04 | **Range gaps and private label** | DECISION | Only the own-brand flag exists, for EPR (`packages/epr/src/packaging-register.ts`). OB-65 deferred this to R6 "to be defined then". | The content needs a decision: D-3. | M | `packages/merchandising/src/range-gaps.ts` (new) |
| D02-FR-05 | Planogram, shelf capacity, sales per sq ft | DONE | `packages/merchandising/src/space.ts`, `services/inventory/src/space-performance.ts`. Tests: `tests/integration/planogram-compliance.test.ts`, `tests/unit/merchandising-space.test.ts`. | — | — | — |
| D02-FR-06 | Supplier-funded display space | DONE | `services/finance/src/display-funding.ts`. Tests: `tests/integration/space-and-display.test.ts`. (The traceability row "NOT STARTED" is stale.) | — | — | — |
| D03-FR-01 | MOQ, multiples, lead time, purchase budget | DONE | `packages/replenishment/src/constrained-order.ts`. Tests: `tests/unit/constrained-order.test.ts`, open-to-buy tests. | — | — | — |
| D03-FR-02 | Invoice OCR / e-invoice ingestion | EXTERNAL | `services/purchase/src/invoice-ingestion.ts`, `packages/purchasing/src/invoice-extraction.ts`. Tests: `tests/integration/a-supplier-bill-read-by-e-invoice-or-ocr-reaches-the-match.test.ts`. | The software path is proven with a typed scan. A real OCR engine or IRP feed is EXTERNAL (OB-222: nothing bought). | — | — |
| D03-FR-03 | Contracts, rebates, schemes, **funding claims** | PARTIAL | `services/purchase/src/rebates.ts` (schemes and accruals). Promotion vendor funding is reconciled in `services/pricing/src/promotions.ts`. Tests: `tests/integration/rebates.test.ts`. | **Earned rebates never become a claim on the supplier or a posting** (the file says "claim APPROVAL … is a separate flow"; no rebate code exists in `services/finance`). Fix: a rebate claim document (approved, sent, received, matched) posted as a receivable. Pkg 6. | S | `services/purchase/src/rebates.ts`, `packages/finance/src/posting.ts` (map key) |
| D03-FR-04 | **VMI** and consignment ownership | PARTIAL | Consignment ownership is on stock (`packages/concession/src/concession.ts` `OwnershipStatus`). | **There is no VMI** (supplier-proposed replenishment within agreed min/max, accepted by a buyer). It was deferred to R6 (OB-65) and is now in scope. Pkg 6. | M | `packages/purchasing/src/vmi.ts` (new), `services/purchase/src/supplier-portal.ts` (proposal kind) |
| D03-FR-05 | Landed cost, freight, **purchase-price variance** | PARTIAL | Landed charges are worked out at the match (`packages/receiving/src/three-way-match.ts` `LandedCharges`; `services/purchase/src/index.ts`). Price variance appears in the scorecard (`packages/purchasing/src/supplier-performance.ts`). | **The landed cost does not reach stock cost or valuation** (no reader outside the match). There is no PPV report per receipt or product. Fix: post the landed cost as the receipt's unit cost or a cost correction, plus a PPV report. Overlaps with the D10-FR-03 lane: coordinate. Pkg 6. | S | `services/purchase/src/index.ts`, `services/inventory/src/goods-receipt.ts` |
| D03-FR-06 | Supplier statement and bank-change verification | DONE | Tests: `tests/integration/duplicate-bank.test.ts`, `supplier-onboarding-on-postgresql.test.ts`, `supplier-portal-statement.test.ts`. | — | — | — |
| D04-FR-01 | LAN-first scan/weight/total | DONE | Tests: `tests/e2e/core-one-lane.test.ts`, `tests/integration/pos-offline.test.ts`, `tests/performance/pos-hot-path.test.ts`. | — | — | — |
| D04-FR-02 | Cash/card/UPI/split, pending-payment recovery | DONE (live acquirer EXTERNAL) | Tests: `tests/integration/pending-tender-recovery.test.ts`, `a-pending-card-answer-holds-the-day-close.test.ts`. | — | — | — |
| D04-FR-03 | Suspend/recall, exchange, refund, no-receipt policy | DONE | `packages/suspended-sales/`. Tests: `tests/integration/an-exchange-balance-refunded-to-a-card-is-a-till-refund.test.ts`, `the-till-returns-without-a-receipt.test.ts`, `cross-lane-refund-guard.test.ts`. | — | — | — |
| D04-FR-04 | Float, pickup, safe drop, blind count, closure | DONE | `packages/till/`, `packages/cash/`. Tests: `day-close-honestly.test.ts`, `tests/e2e/the-served-till-closes.e2e.ts`. | — | — | — |
| D04-FR-05 | **Mobile POS, queue busting**, customer display, peripheral health | PARTIAL | Built: customer display and peripheral health (`tests/e2e/the-served-till-drives-the-customer-display.e2e.ts`, `the-served-till-reports-its-devices.e2e.ts`). | **There is no mobile POS and no queue-busting.** They were deferred to R5 (OB-73) and are now in scope. Fix: the till on a handheld layout (same session, offline, own PIN). Queue-busting means a handheld pre-scans a basket into a suspended bill that the fixed till recalls. Real handheld or printer hardware is EXTERNAL. Pkg 6b. | L | `apps/pos/src/session.ts`, `apps/pos/web/*` (mobile layout), `packages/suspended-sales/src/suspended-bill.ts`, `edge/store-edge/src/lane-server.ts` |
| D04-FR-06 | Self-checkout, scan-and-go, price-kiosk **readiness** | DONE | `packages/self-checkout/src/self-checkout.ts`, `services/pos/src/self-checkout.ts` (assess, scan-and-go, kiosk-quote). Tests: `tests/integration/self-checkout-decisions.test.ts`. | (Readiness only, as §16 words it. A kiosk or self-checkout device UI is R8 hardware.) | — | — |
| D05-FR-01 | Perpetual event ledger and reconstruction | DONE | Tests: `tests/unit/ledger.test.ts`, `tests/guardrails/ledger-append-only.test.ts`. | — | — | — |
| D05-FR-02 | Shelf/back-room/bin and ownership status | DONE | Tests: `tests/integration/warehouse-bins.test.ts`, `concession-store-valuation.test.ts`. | — | — | — |
| D05-FR-03 | Online safety stock and reservation buffer | DONE | `services/inventory/src/online-buffer.ts`. Tests: `tests/integration/the-app-keeps-an-online-buffer-for-shoppers-in-the-store.test.ts`. | — | — | — |
| D05-FR-04 | Batch, FEFO, expiry, cold chain, quarantine | DONE | Tests: `tests/integration/inventory-fefo-allocation.test.ts`, `quality-cold-chain.test.ts`, `cold-chain-at-receiving.test.ts`. | — | — | — |
| D05-FR-05 | Blind counts, variance root cause, financial impact | DONE | Tests: `tests/integration/a-stock-count-is-planned-frozen-recounted-approved-and-booked.test.ts`, `tests/e2e/count-plans-on-the-production-api.e2e.ts`. | — | — | — |
| D05-FR-06 | Supplier/customer returns, recall, destruction evidence | DONE | Tests: `tests/integration/a-recall-runs-its-whole-lifecycle-on-postgresql.test.ts`, `goods-receipt-disposition.test.ts`, `tests/e2e/expiry-recall-delivery.e2e.ts`. | — | — | — |
| D06-FR-01 | Effective-dated zone/channel prices | DONE | D-19 signed. Tests: `tests/integration/a-channel-price-needs-its-approval-and-never-exceeds-mrp.test.ts`, `the-pack-carries-a-switched-on-zone-price.test.ts`. | — | — | — |
| D06-FR-02 | MRP, cost, margin-floor controls | DONE | Tests: `tests/unit/price-guard.test.ts`, `tests/integration/the-margin-floor-is-the-stores.test.ts`, `a-real-trading-bill-is-never-above-the-mrp-total.test.ts`. | — | — | — |
| D06-FR-03 | BOGO, mix-match, **multibuy, bundles**, coupons, **bank offers** | PARTIAL | `packages/promotions/src/promotions.ts`: `PromotionKind = percent_off, amount_off, buy_x_get_y, member_price`, with group tags for mix-match. Coupons are in `packages/loyalty/src/coupons.ts`. | **Missing: "N for ₹X" multibuy, a fixed-price bundle, and bank/UPI-app offers.** Bank offers need D-9, because standalone bank terminals never show the card issuer to the till. Pkg 6. | M | `packages/promotions/src/promotions.ts`, `packages/promotions/src/simulation.ts`, `services/pricing/src/promotions.ts` |
| D06-FR-04 | Best price, stacking/exclusion, abuse limits | DONE | Tests: `tests/unit/promotions.test.ts`, `tests/integration/promotion-abuse-check.test.ts`. | — | — | — |
| D06-FR-05 | Markdown ladder and competitor capture | DONE | Tests: `tests/integration/markdown.test.ts`, `a-competitor-gap-drafts-a-price-a-person-approves.test.ts`, `tests/e2e/the-served-till-charges-the-markdown.e2e.ts`. | — | — | — |
| D06-FR-06 | Shelf/POS/app/**ESL** price-integrity audit | EXTERNAL | Shelf/POS/app is built: `tests/integration/d7-price-integrity-is-reconciled-and-aged.test.ts`, `tests/integration/price-integrity.test.ts`. | The ESL leg needs electronic shelf labels (R8 hardware). The software can add an ESL adapter port with a stand-in. | S | `packages/self-checkout/src/price-integrity.ts` |
| D07-FR-01 | Guest/registered/household identity, duplicate merge | DONE | Tests: `tests/integration/customer-duplicates.test.ts`, `household-pooling.test.ts`. | — | — | — |
| D07-FR-02 | Consent, preference, rights, grievance centre | DONE | Tests: `tests/integration/data-rights.test.ts`, `a-nominee-can-be-recorded-and-a-grievance-has-the-published-sla.test.ts`, `privacy-consent-notice.test.ts`. | — | — | — |
| D07-FR-03 | Points, **tiers**, expiry, reversal, liability | PARTIAL | Points, expiry, reversal and liability: `packages/loyalty/src/loyalty.ts`, `tests/integration/loyalty-liability-reconciles-to-the-books.test.ts`, `tests/unit/loyalty-points-come-back-on-a-return.test.ts`. | **There is no tier engine** ("tier" appears only as a coupon-eligibility label). Fix: tier rules (qualify, recalculate, earn multiplier, downgrade). This is the same as M17-FR-01, so coordinate with the M17 lane; build once. | M | `packages/loyalty/src/tiers.ts` (new), `services/customer/src/loyalty-wallets.ts` |
| D07-FR-04 | Gift cards, store credit, membership, referral | DONE | R4 signed. Tests: `tests/integration/stored-value-liability.test.ts`, `referral-liability-reconciles-to-the-books.test.ts`, `tests/unit/loyalty-coupons.test.ts` (membership kind). | — | — | — |
| D07-FR-05 | Segments, CLV, campaign frequency, fraud controls | DONE | `packages/customer/src/segments.ts` (lifetime margin). Tests: `tests/integration/customer-segments.test.ts`, `campaign-consent.test.ts`; velocity flags in `packages/loyalty/src/stored-value.ts`. | — | — | — |
| D07-FR-06 | Service cases, compensation, satisfaction | DONE | As M21-FR-03/04. | — | — | — |

### Addendum B13–B24 (`roadmap-v2.1-addendum.md`, gap analysis rows 144–155)

| id | requirement | status | evidence | what finishes it | size | files |
|---|---|---|---|---|---|---|
| B13 | Gold HUID; POS blocks un-hallmarked gold (R3, OB-138) | DONE | Tests: `tests/integration/a-gold-piece-is-sold-once-with-its-huid.test.ts`, `tests/e2e/the-served-till-refuses-a-gold-piece-without-or-with-a-sold-huid.e2e.ts`. | — | — | — |
| B14 | Tobacco age-18 hard gate; no loose sticks (whole packs, OB-160) | DONE | Tests: `tests/unit/till-legal-gates.test.ts`, `tests/integration/restricted-sales.test.ts`, `the-till-enforces-the-legal-gates.test.ts`. | — | — | — |
| B15 | Statutory tobacco warning board ≥60×30 cm; **respect POS advertising limits** (COTPA s.5/s.6; OWNER_DECISIONS D3 "physical + config, R2") | PARTIAL | No code found. STATUS line 309 says "B15 … no code yet". | (a) The board itself is EXTERNAL (physical); add it to the go-live checklist. (b) **Software:** refuse a promotion, campaign, recommendation, online listing or customer-display offer that names a tobacco product. Today nothing in `packages/promotions`, `service-desk` or `storefront` mentions tobacco. Pkg 6. | S | `packages/restricted-sales/src/advertising.ts` (new), `services/pricing/src/promotions.ts`, `services/customer/src/campaigns.ts`, `services/orders/src/storefront-online-store.ts` |
| B16 | Block tobacco packs lacking the 85% warning (R3, OB-140/193) | DONE | Tests: `tests/integration/a-tobacco-pack-without-a-current-warning-attestation-is-not-sellable.test.ts`, `tests/unit/tobacco-warning-and-gold-huid-rules.test.ts`. | — | — | — |
| B17 | Do not enable liquor SKUs or POS sale in TN (TASMAC); OWNER_DECISIONS D3: "All liquor/excise items are out of scope" | MISSING | `RestrictionKind` includes `'liquor'` (`packages/restricted-sales/src/restricted-sales.ts:15`). Test fixtures create and sell a "Beer 650ml" with an age gate (`tests/integration/product-master.test.ts:56`, `catalogue-pack-preview.test.ts:17`). Nothing refuses it. | Refuse liquor/alcohol at product-master commit and pack publish for this tenant ("liquor not sold: TASMAC") and at till intake. Move the beer fixtures to a non-TN test tenant, or switch them to tobacco. Pkg 6. | S | `packages/product/src/product.ts`, `packages/product/src/category-policy.ts`, `services/catalogue/src/product-master.ts`, `services/pos/src/sale-intake.ts`, the test fixtures above |
| B18 | OTC household remedies: Schedule-K conditions; anything beyond needs a pharmacy licence | DECISION | `packages/product/src/category-presets.ts` (`OTC_PHARMA_LITE` off by default; `PRESCRIPTION_BLOCKED`). The drug licence is an M34 obligation. | The Schedule-K item list and conditions are not encoded. See D-6. | S–M | `packages/product/src/category-presets.ts` |
| B19 | Carry bags ≥120 µm, priced line; banned single-use plastics blocked | DONE | Tests: `tests/unit/single-use-plastic.test.ts`, `tests/integration/restricted-sales.test.ts`. | — | — | — |
| B20 | Own-brand plastic EPR register (R4, OB-212) | DONE | Tests: `tests/integration/epr-totals-plastic-by-category-for-the-year.test.ts`, `tests/unit/epr-registers.test.ts`, `tests/e2e/the-epr-page-meets-the-spec.e2e.ts`. | — | — | — |
| B21 | E-waste handover and take-back (R4) | DONE | Tests: `tests/integration/e-waste-and-batteries-go-only-to-a-registered-recycler.test.ts`. | — | — | — |
| B22 | Battery take-back (R4) | DONE | Same test as B21. | — | — | — |
| B23 | Online store display duties and grievance officer (R4, OB-223 pending) | DECISION | `packages/storefront/src/listing-duties.ts`, `services/orders/src/storefront-online-store.ts`. Tests: `tests/unit/online-listing-duties.test.ts`, `tests/integration/an-incomplete-product-is-not-published-online.test.ts`. | The software is finished and refuses to publish until a grievance officer is named. It needs the owner's name for the officer: D-7. | — | — |
| B24 | Statutory label character heights | DONE | Tests: `tests/unit/product-label-height.test.ts`, `tests/integration/catalogue-unit-price.test.ts`. | — | — | — |

---

## 2. Build packages (can run in parallel; the file sets do not overlap except where noted)

**Shared files.** `apps/web-erp/src/navigation.ts`, `apps/web-erp/src/browser-entry.ts` and `services/api/src/adapters.ts` / `main.ts` are touched by several packages. Each package should add **only its own entries** (one nav line, one adapter block) and rebase before merge. Every new ERP page gets its own `*-session.ts` and `web/*.{html,js}` so the pages never clash.

**Pkg 1 — Fulfilment and delivery (M19-FR-01/03, WF-14, WF-15).** L, about 2 weeks.
- Wave builder from confirmed orders.
- Dispatcher page: build and assign waves, plan, assign and reassign routes, COD settlement view.
- Geofence per stop, checked on the phone, yes/no only.
- Customer delivery code (OTP) shown in the customer app and checked at head office.
- Photo proof kept on the phone, with a hash sent.
- Delivery partner model once D-1 is decided.
- Files: `packages/fulfilment/src/{wave-plan.ts (new),routing.ts,delivery.ts}`, `services/fulfilment/src/{assignments.ts,index.ts,dispatch.ts}`, `apps/delivery-app/{src/route-session.ts,src/browser-entry.ts,web/app.js}`, `apps/web-erp/{src/dispatch-session.ts,web/dispatch.html,web/dispatch.js}` (new). Read-only touch: `services/orders/src/storefront.ts` (expose the delivery code).

**Pkg 2 — Customer commerce and CRM (M20-FR-01..04, M21-FR-01/02, WF-13).** L, about 2 weeks.
- Promotions, coupons and points in the online cart, through the shared engines.
- Recommendations served on product and cart.
- Camera barcode in the app.
- Order-status notifications into the consent-checked queue.
- Saved addresses and "remove saved payment".
- Low-bandwidth payload test.
- Campaigns page.
- Journey triggers worked out from facts.
- Files: `packages/storefront/src/checkout.ts`, `services/orders/src/{storefront.ts,storefront-self.ts}`, `apps/customer-app/{src/shopping-session.ts,web/app.js,web/index.html}`, `services/customer/src/{campaigns.ts,notification-queue.ts}`, `packages/service-desk/src/campaigns.ts`, `apps/web-erp/{src/campaigns-session.ts,web/campaigns.*}` (new), `tests/performance/customer-app-payload.test.ts` (new).
- Clash note: `services/orders/src/storefront.ts` is touched read-only by Pkg 1; Pkg 2 owns it.

**Pkg 3 — Commercial desks (M22-FR-01/02, M24-FR-01/02, M27-FR-01/04).** M–L, about 1.5 weeks.
- B2B contract register (price list, dates, terms, maker-checker) pricing quotes and orders.
- B2B desk page.
- Supplier-submission review page.
- `delivery_status` submission kind.
- Concessions page with expiry warnings into the owner's exceptions.
- Files: `packages/b2b/src/contracts.ts` (new), `services/finance/src/{b2b-contracts.ts (new),b2b-documents.ts,concession.ts}`, `packages/supplier-portal/src/portal.ts`, `services/purchase/src/supplier-portal.ts`, `apps/supplier-app/web/app.js`, `apps/web-erp/{src,web}/{b2b,supplier-submissions,concession}*` (new).

**Pkg 4 — Finance bridge, migration and gates (M23-FR-01/04, MG-10, MG-11, MG-09 option, QG-10, QG-12, WF scenario matrix).** L, about 2 weeks.
- Stored Tally queue, drain worker and dead letters; Tally voucher adapter with a stand-in; Tally queue panel.
- Trial balance; cost/profit centre on postings.
- MG-10 purchase, balance and margin comparison areas.
- MG-11 backup check and numeric rollback thresholds.
- MG-09 diff of two full exports (if D-5 = b).
- Post-release reconciliation and a per-release QG-10 record.
- QG-12 gate-decision register and page.
- WF-11..15 nine-scenario guardrail.
- Files: `services/finance/src/{tally-queue.ts (new),period-evidence.ts,period-books.ts}`, `packages/period-close/src/tally-xml.ts` (new), `packages/finance/src/{posting.ts,day-book.ts}`, `packages/migration/src/{cutover.ts,cutover-checklist.ts,old-erp-reports.ts,evening-check.ts,export-diff.ts (new)}`, `services/migration/src/parallel-day-routes.ts`, `infra/deploy/release.sh`, `scripts/lib/post-release-check.mjs` (new), `packages/compliance/src/gate-decisions.ts` (new), `services/compliance/src/gate-decisions.ts` (new), `apps/web-erp/{web/finance.js,src/finance-session.ts,web/gates.*}`, `tests/guardrails/every-workflow-has-its-nine-scenarios.test.ts` (new).
- Clash note: `packages/finance/src/posting.ts` is also touched by Pkg 6 (the rebate map key only). Pkg 4 owns the file; Pkg 6 adds one map key after Pkg 4 merges.

**Pkg 5 — Workforce, facilities and adoption (M25-FR-01/03/04, M26-FR-01/02/04, QG-09).** M–L, about 1.5 weeks.
- Access-versus-assignment check.
- Training assignment register and productivity measure.
- SOP content (EN/TA), role help page on the ERP and handhelds, acknowledgement from the device, offline cache.
- Facilities asset, equipment, readings and energy/downtime/incident page sections.
- Store-box offline queue for manual readings.
- QG-09 adoption gate report.
- Files: `packages/workforce/src/{access-match.ts,training.ts,productivity.ts,adoption-gate.ts}` (new), `services/finance/src/{sop-store.ts,cert-store.ts,roster-store.ts,adoption.ts (new)}`, `apps/web-erp/{src/facilities-session.ts,web/facilities.*,web/help.*,web/adoption.*}`, `edge/store-edge/src/{main.ts,cloud-facilities.ts (new)}`, `apps/*/web/sw.js` (help cache entries only).

**Pkg 6 — Product, buying, pricing and legal gates (D01-FR-04, D02-FR-02/04, D03-FR-03/04/05, D06-FR-03, D07-FR-03*, B15, B17, B18).** L, about 2 weeks.
- Nutrition panel.
- Store clusters and season plan.
- Range-gap report once D-3 is decided.
- Rebate claim posting.
- VMI proposals.
- Landed cost into the receipt cost, plus a PPV report.
- Multibuy, bundle and bank offers (D-9).
- Tobacco advertising guard (B15).
- Liquor refusal (B17) and fixture move.
- Schedule-K list (once D-6 is decided).
- *Tiers (D07-FR-03) only if the M17 lane is not building them.
- Files: `packages/product/src/{product.ts,category-policy.ts,category-presets.ts}`, `services/catalogue/src/product-master.ts`, `packages/merchandising/src/{clusters.ts,range-gaps.ts (new),assortment.ts}`, `services/purchase/src/{rebates.ts,index.ts}`, `packages/purchasing/src/vmi.ts` (new), `services/inventory/src/goods-receipt.ts`, `packages/promotions/src/{promotions.ts,simulation.ts}`, `services/pricing/src/promotions.ts`, `packages/restricted-sales/src/advertising.ts` (new), `services/pos/src/sale-intake.ts` (liquor flag only).

**Pkg 6b — Mobile POS and queue-busting (D04-FR-05).** L, about 1 week. Kept separate because it is the only package that touches the till.
- Files: `apps/pos/src/session.ts`, `apps/pos/web/*`, `packages/suspended-sales/src/suspended-bill.ts`, `edge/store-edge/src/lane-server.ts`.

---

## 3. Owner decisions needed (each with options)

- **D-1 Delivery partners and proof (M19-FR-03, AVR-13).**
  - (a) Own drivers only for now. Build a partner link switched off with a stand-in. Fast, and no cost.
  - (b) Own drivers plus one named courier partner. That needs the partner's API and a contract (EXTERNAL).
  - (c) Partner only. The driver app becomes a tracking view.

  For the proof code:
  - (a) A 4-digit code shown in the customer's app and read out to the driver. No SMS cost.
  - (b) An SMS code. Needs the SMS provider (OB-222).
- **D-2 EDI for big suppliers (M24-FR-04).**
  - (a) The versioned JSON API and CSV are enough. Record this in writing. No new build.
  - (b) Build EDIFACT orders, dispatch advice and invoices for a named supplier (M). Only useful if a supplier asks.
  - (c) GS1 EANCOM XML (M).
- **D-3 Range gaps and private label (D02-FR-04; OB-65 left it "to be defined").**
  - (a) A gap report from facts already held: lost sales (short-picks, unfilled substitutions, app searches with no result) per category and price band, plus private-label margin against branded. M.
  - (b) (a) plus recorded competitor ranges. M+.
  - (c) The private-label flag and margin view only. S.
- **D-4 Store clustering with one store (D02-FR-02).**
  - (a) Reuse the price-zone register as the cluster, so one register drives prices and range. S–M.
  - (b) A separate assortment-cluster register. M.
- **D-5 Delta capture (MG-09; runbook D-1/D-2).**
  - (a) The old ERP exports changes since a time. Needs the answer from the old ERP vendor.
  - (b) We compare two full exports; works with any old ERP. S–M, can be built now.
  - (c) Freeze item, price and barcode edits on the old ERP after the final export, plus a short hand-keyed list. No tool.
- **D-6 Medicines (B18).**
  - (a) Sell only Schedule-K household remedies. A pharmacist or lawyer supplies the list; everything else stays blocked. S–M.
  - (b) Get a drug licence and a pharmacist; needs a separate pharmacy extension. L.
  - (c) Sell no medicines; the category stays off. No build.
- **D-7 Grievance officer for the online store (B23, OB-223).**
  - (a) The owner names himself now.
  - (b) He names a staff member.
  - (c) The online store stays unpublished until he decides. B23 and WF-16 cannot pass.
- **D-8 Concessions (M27, AVR-12 Q1).**
  - (a) SRE runs none today. Build the page, keep the feature off.
  - (b) SRE runs some. Give the list and the rent or revenue-share terms so the screens are set up.
- **D-9 Bank offers (D06-FR-03).** The bank-supplied standalone terminals (OWNER_DECISIONS D5) never tell the till which bank a card is from.
  - (a) The cashier picks the bank offer after the terminal slip shows the bank, with a manager PIN and an audit.
  - (b) Offers on UPI only, by the UPI reference.
  - (c) No bank offers until integrated terminals arrive. Record it in writing with a named release.
- **D-10 Productivity and incentive measure (M25-FR-03; M25.md open item).**
  - (a) Sales per labour hour per department.
  - (b) Items scanned per hour per cashier.
  - (c) Tasks completed on time.
- **D-11 Who writes the role curriculum (QG-09).**
  - (a) Built from the existing SOP sheets and owner guide parts, one list per role, which the owner approves.
  - (b) The owner or store manager writes it.
- **D-12 Tally link (M23-FR-04, AVR-09).**
  - (a) A daily Tally XML file the accountant imports. Works with any Tally version; no network to the accountant's PC.
  - (b) Live posting to Tally's HTTP port on the accountant's PC through the store box.
  - (c) Both. Needs the Tally version and company structure (AVR-09).
- **D-13 Loyalty tiers (D07-FR-03 = M17-FR-01).** The qualifying spend and the earn multiplier per tier. For example: (a) two tiers at ₹25k per year; (b) three tiers at ₹10k, ₹25k and ₹50k; (c) no tiers, recorded in writing with a named release.

---

## 4. EXTERNAL items (what the software can still do with a stand-in)

| item | needs | software side now |
|---|---|---|
| M20-FR-03 / WF-13 online payment | RBI-authorised payment provider | The provider-token path and "payment uncertain → not confirmed" are already proven with a stand-in. Add a provider adapter port and contract test. |
| M20-FR-01 SMS OTP; M21-FR-01 sends; order notifications | SMS/WhatsApp/push providers (OB-222) | The recording transport is in place; the consent and budget queue is proven. |
| M23-FR-04 Tally | Real Tally plus AVR-09 | Build the queue and adapter against a Tally stand-in (Pkg 4). |
| M23-FR-03, WF-12 | Bank and acquirer statement files | The importers are proven on synthetic files; add a parser per real format when one arrives. |
| M19 / WF-15 | Courier and maps provider; masked customer calls (§27 Delivery "customer contact") | Offline route and proof are built; the partner link is switched off (D-1). |
| M26-FR-02 | IoT temperature sensors | `ReadingSource 'sensor'` is accepted already; feed it from a stand-in sensor. |
| D03-FR-02 | OCR engine / IRP feed | The typed-scan path is proven. |
| D06-FR-06 | Electronic shelf labels (R8 hardware) | Add an ESL port and a stand-in to the price-integrity audit. |
| D04-FR-02, D04-FR-05 | Live acquirer/UPI; handheld and Bluetooth printer | Stand-ins as today. |
| QG-11 | Live AI model provider | `liveProviderGate` runs the same evaluation set when one is chosen. |
| QG-10 | Production environment and domain | `release.sh` is proven in a sandbox. |
| QG-09 | Staff completing curriculum, competency and acknowledgement | The gate report shows HOLD with the names until they do (Pkg 5). |
| MG-07, 08, 10, 11, 12 | Real legacy extracts, a parallel run against the live old ERP, the G9 rehearsal on the store PC, revoking old-ERP access | All tools are proven on synthetic data. |
| M20-FR-04 | Test on a real low-spec Android phone | Payload budget and throttled test (Pkg 2). |
| B15 | The physical warning board | Go-live checklist line; the advertising guard (Pkg 6). |
| M24-FR-04 | A real EDI/API partner | Sandbox and certification are built. |
| WF-11 | Live card/UPI refund reversal | Stand-in reversal as today. |

---

## 5. Count (106 rows: 36 module FRs, 5 workflows plus the scenario-matrix row, 4 gates, 6 migration controls, 42 D-FRs, 12 B rows)

| status | count | items |
|---|---|---|
| DONE | 57 | M19-FR-02, 04; M21-FR-03, 04; M22-FR-03, 04; M23-FR-02, 03; M24-FR-03; M25-FR-02; M26-FR-03; M27-FR-02, 03 (13) · WF-11, WF-12 (2) · MG-07, 08, 12 (3) · D01-FR-01, 02, 03, 05, 06 · D02-FR-01, 03, 05, 06 · D03-FR-01, 06 · D04-FR-01, 02, 03, 04, 06 · D05-FR-01 to 06 · D06-FR-01, 02, 04, 05 · D07-FR-01, 02, 04, 05, 06 (31) · B13, B14, B16, B19, B20, B21, B22, B24 (8) |
| PARTIAL | 39 | M19-FR-01, 03; M20-FR-01 to 04; M21-FR-01, 02; M22-FR-01, 02; M23-FR-01, 04; M24-FR-01, 02; M25-FR-01, 03, 04; M26-FR-01, 02, 04; M27-FR-01, 04 (22) · WF-13, 14, 15, scenario matrix (4) · QG-10, QG-12 (2) · MG-10, MG-11 (2) · D01-FR-04, D02-FR-02, D03-FR-03, 04, 05, D04-FR-05, D06-FR-03, D07-FR-03 (8) · B15 (1) |
| MISSING | 2 | QG-09, B17 |
| DECISION | 5 | M24-FR-04, MG-09, D02-FR-04, B18, B23. Further decisions sit inside PARTIAL rows: D-1, D-4, D-8, D-9, D-10, D-11, D-12, D-13. |
| EXTERNAL | 3 | QG-11, D03-FR-02, D06-FR-06. Many DONE and PARTIAL rows also have an outside leg (M23-FR-03, D04-FR-02, WF-11, WF-12, MG-07/08/12, M20-FR-03 and others); see §4. |

**Total size of the software work** (packages 1 to 6b): about 10 to 11 builder-weeks, or about 2 to 3 weeks across four parallel lanes. The biggest items:
- the Tally bridge, which is not wired at all although the engine exists (M23-FR-04);
- promotions, coupons and loyalty missing from the online cart (WF-13, P-02);
- delivery proof that is only typed, never captured (M19-FR-03);
- the missing office screens for dispatch, B2B, campaigns, concessions, supplier review and facilities assets (§27, P-07).
