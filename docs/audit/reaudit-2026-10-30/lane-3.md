# Fresh full roadmap re-audit — lane 3 (30 Oct 2026)

**Slice.** M19–M27 (every FR, 36 rows), WF-11–WF-15 plus the §26 nine-scenario matrix (6 rows), QG-09–QG-12 (4), MG-07–MG-12 (6), D01–D07 (every FR, 42 rows), addendum B13–B24 (12). **106 rows.**

**Commit.** `main` at `5c84f4c7` (Merge PR #843). Read-only: the only file written is this one. No git state was changed.

**Sources.** `roadmap-v2.0.txt` (extract of `docs/roadmap/roadmap-v2.0.docx`: §5, §16, §17, §22, §26, §27, §31), `docs/roadmap/roadmap-v2.1-addendum.md`, `docs/requirements/M19.md`–`M27.md`, `docs/requirements/workflows/WF-11.md`–`WF-15.md`, `docs/registers/decisions.md` (all decisions, with OB-500 to OB-610 read one by one), `docs/runbooks/store-go-live-checklist.md`. The row list and format come from `docs/audit/full-2026-10-23/lane-3.md`. The earlier verdicts (`reaudit-2026-10-27/lane-3.md`, `reaudit-2026-10-28/lane-a.md` and `lane-b.md`) were used only to find code. They were not taken as proof. Every row was judged again from the code path and the test's assertions.

**How it was checked.**
- For each row I read the requirement text (roadmap line plus the `Mxx.md` "Shall/Flow/Acceptance" lines), then the route or screen code, then the test's `expect` lines.
- Every evidence path cited in the four earlier lane-3 files was checked to exist (624 paths). All exist except the "(new)" files the 23 Oct audit proposed, which were built under other names.
- A dead-route scan compared every `/v1/…` string in `apps/**` with every route `path:` registered in `services/**` and `edge/**`. It found no screen in this slice calling a route that does not exist. The other hits were template-string artefacts I checked by hand, e.g. `b2b-desk-session.ts:244` builds `/v1/b2b/documents/:customerId/{quotations|proformas|challans|invoices}/:id`, and all four are registered in `services/finance/src/b2b-documents.ts`.
- A scan for `UPDATE` / `DELETE FROM` in this slice's services (fulfilment, customer, finance, purchase, platform, migration, compliance, orders) found none.

**Tests run** (`DATABASE_URL=postgres://postgres@localhost:5432/audit_lane_3`, so the PostgreSQL legs ran):
- **Unit, integration and guardrail tests:** 244 files, every test file cited for this slice plus the decision tests (OB-502/507/514/517/522/530/531/539/609/610) and the hard-rule guardrails (`ledger-append-only`, `card-data`, `secrets`, `ai-agent-db-write`, `an-ai-agent-only-drafts`, `pos-offline`). Command: `pnpm exec vitest run <244 files>`. Result: **241 files passed, 3 failed; 1,647 tests passed, 3 failed, 0 skipped** (762 s; the machine was shared with three other lanes).
  - All 3 failures were `Error: Test timed out in 5000ms`. The tests were `picker-handheld-reaches-the-cloud-through-the-edge.test.ts:372` (HA-1), `a-stock-count-is-planned-frozen-recounted-approved-and-booked.test.ts:78` and `tests/guardrails/a-real-trading-bill-is-never-above-the-mrp-total.test.ts:114`.
  - Rerun alone with PostgreSQL: **3 files, 22 tests, all passed**. These are load timeouts, not product faults.
- **Performance:** `pnpm exec vitest run --config vitest.perf.config.ts tests/performance/customer-app-payload.test.ts`: **3 passed**.
- **Browser (Chromium):** `pnpm exec vitest run --config vitest.e2e.config.ts`, 9 files: `the-dispatch-page-runs-the-day`, `the-campaigns-page-sends-only-to-who-said-yes`, `the-quality-gates-page-records-the-owners-decision`, `a-manager-sees-the-bill-findings-and-attendance-flags`, `the-customer-app-meets-wcag-aa`, `facilities-delivery`, `delivery-route-partial-delivery`, `help-readings-and-losses-are-saved-at-the-store-with-the-line-down`, `till-concession-tag-through-the-box`. Result: **9 files, 18 tests, all passed**. The first three need `DATABASE_URL`, and were run with it after a first run without it had skipped them.
- An earlier, wider run (315 files, including other lanes' rows) was stopped at 54 files to stay inside this slice. It is not counted here.

---

## M19 — Picking, packing and delivery

| id | requirement (short quote) | status | evidence (code + test paths) | what finishes it | size |
|---|---|---|---|---|---|
| M19-FR-01 | "Wave/single picking, substitution preference and quality checks" | DONE | Waves are built from CONFIRMED orders. Bins come from the bin register and prices from the pack; an order is never split. Code: `packages/fulfilment/src/wave-plan.ts`, `services/fulfilment/src/wave-builder.ts` (`/v1/fulfilment/wave-candidates`, `/waves/:waveId/build`, `/wave-board`). Page: `apps/web-erp/web/dispatch.{html,js}` (nav `dispatch`, `navigation.ts:370`). Picker: `apps/picker-app/src/pick-session.ts` (short, substitute, `failQuality`). Tests: `tests/integration/the-dispatcher-builds-a-wave-from-confirmed-orders.test.ts` ("candidates → build (bins from the register, prices from the pack, an unbinned order kept out whole) → the box pulls it → the board → a restart"), `tests/unit/fulfilment-wave-plan.test.ts`, `tests/integration/picker-handheld-reaches-the-cloud-through-the-edge.test.ts`. | — | — |
| M19-FR-02 | "Packing, temperature/handling requirements and dispatch" | DONE | `packages/fulfilment/src/packing.ts`, `services/fulfilment/src/packing.ts`. Test: `tests/integration/fulfilment-packing.test.ts` (6 cases: price at packed weight, the cold chain cannot be switched off with `rules: []`, an unconfirmed order or a product not on it is refused, sealed crates before dispatch, and the role gate). | — | — |
| M19-FR-03 | "Driver/partner assignment, route, geofence and proof of delivery" | DONE | Own drivers only, with the courier link built and switched off (OB-294). Geofence 250 m, flagged and never refused (OB-343). 4-digit code checked at head office (OB-344). Camera photo and signature are hashed. Code: `apps/delivery-app/web/app.js:725` `capturePhoto`, `:749` `captureSignature`, `:785` `navigator.geolocation`; `packages/fulfilment/src/proof-capture.ts`. Test: `tests/integration/the-delivery-proof-is-captured-and-checked.test.ts`, which asserts:<br>• the phone is never handed the code or the door's coordinates (`not.toMatch(/"code"\|11\.02\|76\.96/)`);<br>• another customer's code request is refused and recorded;<br>• `proofCheck.fence.radiusMetres: 250` and `decidedBy: 'OB-343'`;<br>• a photo whose hash is not its own is refused;<br>• a wrong code raises the `delivery_code_wrong` flag;<br>• a started route cannot be taken back. | — | — |
| M19-FR-04 | "COD/failed delivery/return-to-origin and SLA management" | DONE | `packages/fulfilment/src/cod.ts`, `services/fulfilment/src/order-fulfilment.ts`, `services/fulfilment/src/driver-runs.ts`. Reports `delivery_sla` and `delivery_contribution` in `packages/reporting/src/catalogue.ts`. Tests: `tests/integration/cod-reconciliation.test.ts` (to the paisa; a card method is refused under hard rule 3), `tests/integration/one-fulfilment-command.test.ts`, `tests/integration/a-late-delivery-exception-is-told-to-its-queue.test.ts`. | — | — |

## M20 — Customer app and web commerce

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M20-FR-01 | "OTP/account, catalogue, search, filters, barcode/voice and multilingual UX" | EXTERNAL | Camera barcode through `BarcodeDetector`, with typing as the fallback: `apps/customer-app/web/customer-commerce.js:189`. Voice uses the phone's own recogniser behind a port, switched off (OB-322): `apps/customer-app/src/voice-search.ts`. EN/TA throughout. Customer sign-in uses Keycloak, off until SMS (OB-510): `services/customer/src/signup-sms-code.ts`. Tests: `tests/unit/the-customer-apps-commerce-rules.test.ts`, `tests/unit/voice-and-sms-links-are-switched-off.test.ts`, `tests/unit/storefront-browse.test.ts`. | A real SMS OTP provider (OB-222, nothing bought). | — |
| M20-FR-02 | "Cart, lists, favourites, repeat order and recommendations" | DONE | Consent-scoped `recommend()`: `services/orders/src/storefront-account.ts:156` passes the `profiling` consent only if given. The online basket is priced by the till's promotion and coupon engines. Tests: `tests/integration/the-online-basket-gets-the-tills-offers.test.ts` ("promotions and a coupon priced by the till's engines; the order placed at that price; the coupon spent once; member price and points…"), `tests/integration/the-customers-own-account-suggestions-and-help.test.ts`, `tests/integration/storefront-orders.test.ts` (FUL-14, the customer's own substitution yes). | — | — |
| M20-FR-03 | "Slots, payments, tracking, notifications, digital receipts and support" | EXTERNAL | Order notices go through the consent-checked queue: `services/orders/src/order-notices.ts`. Payment is a provider token; an unknown answer stays pending. Tests: `tests/integration/the-customer-is-told-where-their-order-is.test.ts`, `tests/integration/storefront-orders.test.ts` (FUL-03: a made-up token is not paid; a card number is refused), `tests/integration/a-delivery-slot-and-address-are-the-shops-to-judge.test.ts`, `tests/integration/service-requests.test.ts`. | A live RBI-authorised payment provider, and SMS/WhatsApp/push providers (OB-222). | — |
| M20-FR-04 | "Ratings, accessibility, privacy centre and account controls" | EXTERNAL | Routes `/v1/me/addresses*` and `/v1/me/payment-methods*/remove` (`services/orders/src/storefront-account.ts:88-139`). Tests: `tests/integration/only-a-buyer-can-rate-a-product.test.ts`, `tests/integration/data-rights.test.ts`, `tests/integration/the-customers-own-account-suggestions-and-help.test.ts`, `tests/e2e/the-customer-app-meets-wcag-aa.e2e.ts`, `tests/performance/customer-app-payload.test.ts`. | A test on a real low-spec Android phone. | — |

## M21 — CRM, marketing and service desk

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M21-FR-01 | "Campaign segments and consent-safe WhatsApp/SMS/email/push" | EXTERNAL | Campaigns page: `apps/web-erp/src/campaigns-session.ts`, `web/campaigns.*`, nav `navigation.ts:290`. Tests: `tests/integration/campaign-consent.test.ts`, `tests/integration/a-campaign-goes-through-the-queue-within-the-cap.test.ts` (memory + PostgreSQL), `tests/unit/the-campaigns-session.test.ts`, `tests/e2e/the-campaigns-page-sends-only-to-who-said-yes.e2e.ts`. | Real message providers (OB-222). | — |
| M21-FR-02 | "Abandoned cart, occasions, win-back and campaign attribution" | **PARTIAL** | Journeys are DONE: the triggers are worked out from stored facts (`packages/service-desk/src/journey-facts.ts`, `services/customer/src/journeys.ts`). Test: `tests/integration/journeys-are-worked-out-from-the-shops-own-facts.test.ts`. **Attribution is not derived.** `POST /v1/service/campaigns/:campaignId/attribution` (`services/customer/src/campaigns.ts:228-252`) takes `sentTo[]`, `sentAt` and `orders: [{customerRef, at, netMinor, marginMinor}]` from the caller's body and weighs them with `measureCampaign`. M21.md says "Rules: … attribution derived", and the acceptance says "attribution ties revenue to a campaign". No code reads the campaign's own send records or the order and sales ledgers for this. No screen calls the route (`grep attribution apps/web-erp/src/campaigns-session.ts` finds nothing). The only test (`tests/integration/campaign-journeys.test.ts:17`) posts typed orders. | Two changes:<br>1. Work attribution out on the server: `sentTo` and `sentAt` from the campaign's recorded sends and delivery reports, and the orders from storefront orders plus banked till bills by customer, inside the window, with the control group. Refuse a typed `orders` or `sentTo` body.<br>2. Show it on the Campaigns page.<br>Test: an integration test where a send plus a real bill inside the window is attributed, and a bill before the send or outside the window is not. | S–M |
| M21-FR-03 | "Complaint, enquiry, warranty, lost-and-found and compensation approval" | DONE | `CaseKind = 'complaint' \| 'enquiry' \| 'warranty' \| 'lost_and_found'` (`packages/service-desk/src/service-cases.ts:27`). Tests: `tests/integration/service-compensation.test.ts` (above the desk's authority an approval must be GIVEN by someone who holds it), `tests/integration/service-ai-drafts.test.ts` (a named human sends, P-05), `tests/e2e/service-desk-and-assistant-drafts.e2e.ts`. | — | — |
| M21-FR-04 | "SLA, escalation, resolution and satisfaction measurement" | DONE | Two SLA clocks with `shouldEscalate`. The breached queue (`?breached=true`) is sorted first on `apps/web-erp/web/service-desk.js:440`. Breaches are raised to A05 proposals (`services/api/src/ai-adapters.ts:548`). Report at `/v1/service/report`. Tests: `tests/integration/service-cases.test.ts`, `tests/integration/service-csat.test.ts`. | — | — |

## M22 — B2B and institutional sales

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M22-FR-01 | "Customer-specific price/credit/terms and contract" | DONE | `packages/b2b/src/contracts.ts`, `services/finance/src/b2b-contracts.ts`. There is no typed price (OB-361). The above-MRP ceiling is checked. Tests: `tests/integration/a-b2b-order-is-priced-from-its-approved-contract.test.ts` (proposed → approved by another person → quotes priced from it → expiry worked out from the dates), `tests/unit/b2b-contracts.test.ts`, `tests/integration/b2b-credit.test.ts`. | — | — |
| M22-FR-02 | "Quote, sales order, proforma, challan and invoice workflow" | DONE | `services/finance/src/b2b-documents.ts`. B2B desk page `apps/web-erp/web/b2b.*` (nav `navigation.ts:354`), switched off until the old system retires and the CA confirms (OB-359/OB-384). Tests: `tests/integration/b2b-documents-chain.test.ts` (gap-free numbers), `tests/integration/b2b-documents-chain-2.test.ts` (proforma, challan, invoice from challans, chain check), `tests/unit/the-commercial-desk-sessions.test.ts`. | — | — |
| M22-FR-03 | "Bulk/recurring orders, salesperson and commission" | DONE | Recurring orders, paused until approved again, with missed days not made up (OB-514): `services/finance/src/b2b-ordering.ts`. Commission derived from issued invoices under an approved rule: `services/finance/src/b2b-commission.ts:130`. Tests: `tests/integration/a-paused-recurring-order-never-makes-up-its-missed-days.test.ts`, `tests/integration/a-b2b-recurring-order-makes-itself-on-its-day.test.ts`, `tests/integration/b2b-commission.test.ts`. | (Note only: the older manual accrual route `/v1/b2b/commissions/:id/accruals/:id` still accepts a typed `baseMinor`. The invoice-derived path is the governed one.) | — |
| M22-FR-04 | "B2B portal, outstanding and collection tracking" | DONE | `apps/b2b-app/`. Tests: `tests/integration/b2b-portal.test.ts` (own data only; probing recorded), `tests/integration/b2b-reconcile-ar.test.ts` (memory + PostgreSQL), `tests/e2e/b2b-portal-on-the-production-api.e2e.ts`. | — | — |

## M23 — Finance, tax and accounting bridge

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M23-FR-01 | "Ledger mapping, journals, receivable/payable and cost/profit centres" | DONE | `packages/finance/src/trial-balance.ts`, `services/finance/src/ledger-reports.ts`, department split (OB-340). Tests: `tests/integration/the-trial-balance-and-centres-tie-to-the-ledger-and-the-close-checks-gst.test.ts`, `tests/unit/trial-balance-and-centres.test.ts`. | — | — |
| M23-FR-02 | "GST configuration, credit/debit notes and tax audit evidence" | DONE | `services/finance/src/credit-notes.ts`; GST returns; the close's GST check (above). Tests: `tests/integration/gst-returns.test.ts`, `tests/integration/gstr3b-matches-the-sales-ledger.test.ts`, `tests/integration/credit-note-reconciliation.test.ts`. | (Note only: the period credit-note reconciliation route still takes the two ledger figures as query values, e.g. `reconcile(…, '8000', '1440')` in that test. The month close compares from the ledger itself, so the row stands.) | — |
| M23-FR-03 | "Cash/bank/card/UPI/payment-gateway/refund reconciliation" | DONE (stand-in files) | `packages/reconciliation/src/reconciliation.ts`, `packages/finance/src/bank-statement.ts`. Tests: `tests/unit/reconciliation.test.ts`, `tests/integration/the-month-closes-on-independent-evidence.test.ts` (every card/UPI tender settled and every payout in the bank → closes on a second person's signature; a short settlement is refused by name), `tests/integration/a-t-plus-one-settlement-file-surfaces-shortfalls-chargebacks-and-refunds.test.ts`. | Real bank and acquirer file formats (outside). | — |
| M23-FR-04 | "Tally connector, retry queue, period close and balance validation" | DEFERRED (OB-293 + OB-381, R8) | The fallback is real: `services/finance/src/tally-outbox.ts`, `tally-export.ts`, page `apps/web-erp/web/tally-files.*` (nav `navigation.ts:200`). The close reads the real dead-letter count (`services/finance/src/period-evidence.ts`). Test: `tests/integration/the-daily-tally-file-carries-every-journal-and-keeps-a-dead-letter.test.ts`. | The live connector, at R8. | — |

## M24 — Supplier and partner portals

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M24-FR-01 | "RFQ response, catalogue/cost proposals, ASN and invoice submission" | DONE | `services/purchase/src/supplier-portal.ts` (decided-only kinds `catalogue`, `rfq_response`, `claim`), `services/purchase/src/rfq.ts`, review page `apps/web-erp/web/supplier-submissions.*`. Tests: `tests/integration/a-buyer-decides-supplier-submissions-from-one-queue.test.ts`, `tests/integration/supplier-portal-feeds-purchasing.test.ts`. | (Cosmetic: the 400 message at `supplier-portal.ts:288` omits `delivery_status` from its list of kinds.) | — |
| M24-FR-02 | "PO acknowledgement, delivery status, claims and statement" | DONE | `SubmissionKind` includes `delivery_status` (`packages/supplier-portal/src/portal.ts:245`). Tests: `tests/integration/a-supplier-sends-a-delivery-update-for-its-own-orders-only.test.ts`, `tests/integration/supplier-portal-statement.test.ts`. | — | — |
| M24-FR-03 | "Access isolation, document expiry and partner audit trail" | DONE | Tests: `tests/integration/supplier-portal-compliance.test.ts`, `supplier-portal-probing.test.ts`, `supplier-portal-durability.test.ts`. | — | — |
| M24-FR-04 | "API/EDI readiness for high-volume partners" | DEFERRED (OB-312, R8) | Partner API keys, a sandbox and certification. Test: `tests/integration/partner-certification.test.ts`. Guardrail `tests/guardrails/edi-is-deferred-in-writing.test.ts`. | EDI at R8, when a named supplier asks. | — |

## M25 — Workforce, tasks and enablement

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M25-FR-01 | "Employee assignment, authorization, shift/roster and attendance integration" | DONE | Access matches assignment: `packages/workforce/src/access-match.ts`. Roster and attendance offline on the store computer (OB-507), with the read-only copy when the sign-in fails (OB-531/OB-539, OB-541 as built). The attendance flags page (OB-609) is nav `findings` (`navigation.ts:309`). Tests: `tests/unit/workforce-enablement.test.ts`, `tests/integration/r7d-the-roster-and-certificates-ride-the-signed-pack-to-the-box.test.ts`, `tests/integration/r7d-attendance-pairing-is-judged-when-read.test.ts`, `tests/integration/r8c-certificates-recorded-and-verified-and-the-roster-copy-on-the-box.test.ts`, `tests/unit/r9b-handheld-builds-and-the-rota-on-a-refused-sign-in.test.ts`, `tests/unit/the-findings-page-shows-what-head-office-found.test.ts`. | — | — |
| M25-FR-02 | "Daily tasks, opening/closing, handover and escalation" | DONE | Tests: `tests/integration/offline-completions-reach-the-cloud-through-the-edge.test.ts`, `task-store.test.ts`, `checklist-store.test.ts`. | — | — |
| M25-FR-03 | "Training, certification, productivity and incentives" | DONE | `packages/workforce/src/training.ts`, `productivity.ts` (sales per labour hour per department, OB-317/OB-357). The food-certificate rule is `packages/workforce/src/food-handling.ts`: only an EXPIRED certificate blocks, and none on file does not (OB-502 as clarified by OB-544, lines 4–5 and 111–115). Certificates page (OB-522), and nobody verifies their own (OB-535). Tests: `tests/integration/r7d-an-expired-food-certificate-blocks-food-work-and-marks-are-relayed.test.ts` ("an EXPIRED … blocks …; none on file does not; a renewal lets it through"), `tests/integration/r8c-…` ("self- and proxy-verification refused"), `tests/integration/sales-per-labour-hour-from-the-roster.test.ts`. | — | — |
| M25-FR-04 | "Role-aware SOP/help centre and acknowledgement" | DONE | `packages/workforce/src/sop-library.generated.ts`, `apps/web-erp/web/help.*` (nav `navigation.ts:402`), served offline by the box. Tests: `tests/integration/the-help-centre-emergency-procedures-and-appointment-letters.test.ts`, `tests/unit/the-box-holds-the-help-library-and-the-rooms.test.ts`, `tests/guardrails/the-help-library-is-the-sheets.test.ts`. | — | — |

## M26 — Facilities, assets and maintenance

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M26-FR-01 | "Asset, warranty, AMC, service and spare tracking" | **PARTIAL** | The asset register, warranty/AMC alerts and service log are built: `packages/facilities/src/assets.ts`, `services/platform/src/facilities-assets.ts`, office view `apps/web-erp/src/facilities-office-session.ts` (in `web/facilities.html`). Test: `tests/integration/facilities-assets.test.ts`. **Spares are not tracked.** `ServiceLog.sparesUsed` exists only as a type field (`packages/facilities/src/assets.ts:64`). The route `POST /v1/facilities/assets/:assetId/services/:serviceId` (`services/platform/src/facilities-assets.ts:89-108`) never reads it and drops it from the stored record. No spare-parts register, spare stock or low-spare warning exists, and no test mentions spares. M26.md: "track assets with warranty, AMC, service history **and spares** … log service → **track spares**". | Four changes:<br>1. A spare-parts register: part, compatible assets, minimum level, with on-hand kept as append-only movements.<br>2. The service route accepts `sparesUsed` and books it as a consumption against the register, refusing more than is on hand.<br>3. A low-spare warning on the facilities office view.<br>4. An integration test (memory + PostgreSQL) proving a service draws the spare down and a restart reads the same.<br>(Hard rule 2: movements, never an overwritten quantity.) | S–M |
| M26-FR-02 | "Refrigeration/cold-room, power/UPS/DG and IoT readiness" | EXTERNAL | `packages/facilities/src/monitoring.ts`, `services/platform/src/facilities-monitoring.ts`, offline manual-reading queue on the box. Tests: `tests/integration/facilities-monitoring.test.ts`, `tests/integration/cold-room-breach-holds-stock.test.ts`, `tests/integration/the-store-computer-carries-readings-losses-and-acknowledgements.test.ts`, stand-in sensor in `tests/integration/p6-floor-devices-are-signed-switched-on-and-never-edit-a-ledger.test.ts`. | Real IoT sensors. | — |
| M26-FR-03 | "Cleaning, pest, fire, safety and maintenance schedules" | DONE | Tests: `tests/integration/facilities-schedules.test.ts`, `tests/e2e/facilities-delivery.e2e.ts`. | — | — |
| M26-FR-04 | "Energy, downtime, incidents and compliance evidence" | DONE | Routes `/v1/facilities/energy`, `/assets/downtime`, `/incidents`, shown on the facilities office view. Tests: `tests/integration/facilities-incidents.test.ts`, `tests/unit/lp-workforce-sessions.test.ts`. | — | — |

## M27 — Concession and shop-in-shop

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| M27-FR-01 | "Concessionaire contracts, deposits, rent/revenue share and utilities" | DONE | `services/finance/src/concession.ts` (`fixedRentMinor`, `revenueShareBps`, `utilitiesMinor`, deposit movements). Page `apps/web-erp/web/concessions.*` (nav `navigation.ts:207`), feature off (OB-304). Tests: `tests/integration/concession.test.ts`, `tests/unit/the-commercial-desk-sessions.test.ts`. | — | — |
| M27-FR-02 | "Separate stock ownership and restricted access" | DONE | Tests: `tests/integration/concession-store-valuation.test.ts`, `concession-write-off-guard.test.ts`, `concession.test.ts` ("values only the stock the store owns…"). | — | — |
| M27-FR-03 | "Counter sales settlement, **invoices** and reconciliation" | **PARTIAL** | Settlement and till-versus-counter reconciliation are built: `services/finance/src/concession.ts` (`/charge`, `/settlement`), `services/finance/src/concession-tags.ts` (`/tag-settlement`). Tests: `tests/integration/concession-tags-reach-settlement.test.ts` (memory + PostgreSQL), `tests/integration/till-concession-tags-reach-the-cloud-through-the-edge.test.ts`. **Two gaps.** (1) Nothing issues the shop's invoice to the concessionaire for the period's rent, revenue share and utilities. There is no "invoice" anywhere in `services/finance/src/concession*.ts`, and no document series. M27.md: "settle concession counter sales, **issue invoices** and reconcile". (2) The settlement is only computed on read. Nothing posts it to the books (no journal or posting in `concession*.ts`), so "settlement reconciles (M23)" cannot be shown against the ledger. OB-304 says "build screens fully, feature OFF", so the feature being off does not excuse the gap. | Two changes:<br>1. A concession settlement invoice on its own gap-free series, with the shop's GST on rent, share and utilities, made by one person and approved by another. It nets the counter's collected sales and leaves the deposit stated, not netted.<br>2. Post the settlement (liability to the concessionaire, income, GST output) through `packages/finance/src/posting.ts`, and add a reconcile check of settlement against ledger.<br>Show the invoice on the Concessions page. Integration test on memory + PostgreSQL. **The GST treatment needs the CA to confirm.** | M |
| M27-FR-04 | "Agreement/insurance/licence expiry alerts" | DONE | `/v1/concession/expiry-alerts/raise` (`services/finance/src/concession-desk.ts:63`). Tests: `tests/integration/a-concession-expiry-reaches-the-owner.test.ts` ("the owner is told once per step"), `tests/unit/concession-expiry-alerts-and-delivery-status.test.ts`. | — | — |

## Workflows WF-11 to WF-15 (§26)

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| WF-11 | POS return → refund/exchange/credit → disposition → reconcile | DONE | `docs/requirements/workflows/WF-11.md`: 10 rows, all COVERED. Tests: `tests/integration/returns-reconcile-on-sync.test.ts`, `a-held-returned-unit-gets-a-persons-decision.test.ts`. | (A live card/UPI refund reversal is outside.) | — |
| WF-12 | Day close → store close → accounting | DONE | `WF-12.md`: 10/10 COVERED. Tests: `tests/integration/a-day-closes-with-a-pending-payment-carried-to-head-office.test.ts`, `day-close-reconcile-on-sync.test.ts`. | (The bank deposit file is outside.) | — |
| WF-13 | Customer order with cart/promotion, slot, payment, confirm | EXTERNAL | `WF-13.md`: 10/10 COVERED. Test: `tests/integration/the-online-basket-gets-the-tills-offers.test.ts`. | A live payment provider. | — |
| WF-14 | Fulfilment: wave/pick → substitution → weighed price → QC/pack → dispatch | DONE | `WF-14.md`: 10/10 COVERED (as M19-FR-01/02). | — | — |
| WF-15 | Delivery: assign/route → proof/COD → failure/RTO → settlement | DONE | `WF-15.md`: 10/10 COVERED (as M19-FR-03/04). | — | — |
| WF-11…15 matrix | §26 nine scenarios plus reconcile per workflow | DONE | Guardrail `tests/guardrails/every-workflow-scenario-points-at-a-real-test.test.ts`: every cited test exists with that exact title, stale labels are refused, and there are tripwires. | — | — |

## Quality gates QG-09 to QG-12 (§22)

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| QG-09 | Adoption: curriculum, competency, floor support, SOP acknowledgements | EXTERNAL | `packages/workforce/src/adoption-gate.ts`, page `apps/web-erp/web/adoption.*` (nav `navigation.ts:404`). Test: `tests/integration/the-adoption-gate-names-who-is-not-ready.test.ts`. | Staff complete it, and the owner approves each role's list (OB-320). | — |
| QG-10 | Production: health, smoke, reconciliation, monitoring, rollback after every release | EXTERNAL | `infra/deploy/release.sh`, `scripts/release-reconcile.mjs`. Tests: `tests/guardrails/every-release-is-reconciled-and-leaves-a-qg10-record.test.ts`, `tests/unit/qg10-the-books-are-reconciled-around-every-release.test.ts`, `tests/integration/qg10-the-release-snapshot-reads-the-real-books-on-postgresql.test.ts`. | A real production environment. | — |
| QG-11 | AI evaluations, authority, evidence, budgets, kill switch | DEFERRED (OB-382, R8) | `packages/ai/src/{authority,budget,safety,evaluation}.ts`, `services/ai/src/evaluation-set.ts`. Tests: `tests/unit/ai-evaluation.test.ts`, `tests/integration/ai-model-calls-are-governed.test.ts`, guardrails `ai-agent-db-write`, `an-ai-agent-only-drafts`. | The live-model parts, at R8. | — |
| QG-12 | Every gate ends GO/HOLD/REWORK with evidence; silence is not approval | DONE | `packages/compliance/src/gate-decisions.ts`, `services/compliance/src/gate-decisions.ts`, page `apps/web-erp/web/gates.*`. Tests: `tests/integration/scanner-findings-and-gate-decisions-are-recorded.test.ts` ("the gate register refuses GO over a blocker"), `tests/guardrails/no-quality-gate-has-a-default-decision.test.ts`. | — | — |

## Migration controls MG-07 to MG-12 (§17)

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| MG-07 | All usable history and attachments; exclusions need evidence and owner approval | DONE (real extract outside) | `packages/migration/src/history.ts`, `history-load.ts` (attachments stored as bytes with SHA-256). Tests: `tests/integration/migration-history-exclusions.test.ts`, `history-and-open-orders-load.test.ts`. | — | — |
| MG-08 | Opening state loaded and signed off | DONE (real data outside) | Test: `tests/integration/opening-state-loads.test.ts` (memory + PostgreSQL; second-person sign-off; an interrupted load doubles nothing; a conflicting re-send gets a visible 409). | — | — |
| MG-09 | Delta after the final extract, loaded exactly once | DONE | OB-309: diff of two full exports. Code: `packages/migration/src/export-diff.ts`. Tests: `tests/integration/migration-delta-books-day-and-rollback-limits.test.ts` ("MG-09: two full exports become blocking exceptions…"), `a-delta-lands-once.test.ts`, `a-sale-delta-lands-once.test.ts`. | — | — |
| MG-10 | Parallel run reconciled daily | EXTERNAL | `packages/migration/src/cutover.ts` (`COMPARISON_AREAS` with purchases, balances, stock, margin). Tests: the same file ("MG-10 books side…"), `a-parallel-day-cannot-be-signed-with-an-unexplained-difference.test.ts`. | The real parallel run. | — |
| MG-11 | Cutover with backup, go/no-go, rollback thresholds, named team | EXTERNAL | `cutover-checklist.ts`, `rollback-limits.ts`. Tests: the same file ("…the limits raise the trigger once"), `tests/guardrails/the-cutover-gate-is-never-ticked.test.ts`, `a-rehearsed-rollback-reconciles.test.ts`. | The rehearsal on the store PC, and the owner naming the team. | — |
| MG-12 | Legacy read-only, then retire | DONE (old-ERP revoke outside) | `assessRetirement` in `packages/migration/src/history.ts`. Test: `tests/integration/migration-retirement.test.ts`. | — | — |

## Extensions D01–D07 (§16)

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| D01-FR-01 | GS1/GTIN/EAN/UPC and internal barcodes | DONE | `packages/gs1/src/gs1.ts`. Test: `tests/integration/barcode-register.test.ts` (a wrong check digit is refused). | — | — |
| D01-FR-02 | Embedded weight/price barcodes | DONE | `packages/production/src/scale-label.ts`, `apps/pos/src/view-adapter.ts`. Test: `tests/unit/the-till-judges-what-is-charged-and-its-own-units.test.ts`. | — | — |
| D01-FR-03 | Pack hierarchy and pack breaking | DONE | Tests: `tests/integration/pack-hierarchy.test.ts`, `pack-chain-case-to-base.test.ts`. | — | — |
| D01-FR-04 | Ingredients, allergens, nutrition, origin, storage | DONE | `packages/product/src/nutrition.ts`, required for SRE-packed food (OB-307). Test: `tests/integration/p2-the-product-master-keeps-variants-bundles-substitutes-and-nutrition.test.ts`. | — | — |
| D01-FR-05 | Regulated flags and recall block | DONE | Tests: `tests/guardrails/a-recalled-tin-cannot-be-sold.test.ts`, `tests/integration/a-recalled-batch-is-refused-and-its-sibling-sells-offline.test.ts`. | — | — |
| D01-FR-06 | App content, images, synonyms, completeness | DONE | Test: `tests/integration/product-content-and-synonyms-reach-the-customer-app.test.ts`. | — | — |
| D02-FR-01 | Open-to-buy and category budgets | DONE | Test: `tests/integration/a-purchase-order-is-checked-against-open-to-buy.test.ts` (with race cases). | — | — |
| D02-FR-02 | Seasonal assortment and store clustering | DONE | `packages/merchandising/src/clusters.ts` (cluster = price zone, OB-318). Test: `tests/integration/p2-the-floor-heat-map-clusters-seasons-and-range-gaps-are-head-offices.test.ts`. | — | — |
| D02-FR-03 | New/discontinued/clearance lifecycle | DONE | Test: `tests/integration/a-discontinued-product-cannot-be-ordered-even-without-a-store-range.test.ts`. | — | — |
| D02-FR-04 | Range gaps and private label | DONE | `packages/merchandising/src/range-gaps.ts` (OB-319). Same p2 test ("range-gap report folds short-picks, failed substitutions and no-result searches…"). | — | — |
| D02-FR-05 | Planogram, shelf capacity, sales per sq ft | DONE | Tests: `tests/integration/planogram-compliance.test.ts`, `space-and-display.test.ts`. | — | — |
| D02-FR-06 | Supplier-funded display space | DONE | `services/finance/src/display-funding.ts`. Test: `tests/integration/space-and-display.test.ts`. | — | — |
| D03-FR-01 | MOQ, multiples, lead time, budget | DONE | Test: `tests/unit/constrained-order.test.ts`. | — | — |
| D03-FR-02 | Invoice OCR / e-invoice ingestion | EXTERNAL | Test: `tests/integration/a-supplier-bill-read-by-e-invoice-or-ocr-reaches-the-match.test.ts`. | A real OCR engine or IRP feed. | — |
| D03-FR-03 | Contracts, rebates, schemes, funding claims | DONE | `packages/purchasing/src/rebate-claims.ts`, `services/purchase/src/rebate-claims.ts`. Tests: `tests/integration/a-rebate-claim-is-approved-by-finance-sent-and-matched.test.ts`, `a-rebate-claim-under-an-unapproved-scheme-warns-and-a-sent-claim-is-withdrawn-with-a-reason.test.ts` (OB-437), `rebates.test.ts`. | — | — |
| D03-FR-04 | VMI and consignment | DONE | Test: `tests/integration/a-supplier-proposes-replenishment-within-the-buyers-limits.test.ts` (OB-389). | — | — |
| D03-FR-05 | Landed cost, freight, purchase-price variance | DONE | `services/inventory/src/landed-cost.ts`. PPV is read from the bill matched to that receipt (OB-517/OB-530). Tests: `tests/integration/landed-cost-reaches-stock-value-to-the-paisa.test.ts`, `purchase-price-variance-per-product-and-receipt.test.ts` (asserts `not_yet_billed: 3` before the match). | — | — |
| D03-FR-06 | Supplier statement and bank-change verification | DONE | Tests: `tests/integration/duplicate-bank.test.ts`, `supplier-onboarding-on-postgresql.test.ts`, `supplier-portal-statement.test.ts`. | — | — |
| D04-FR-01 | LAN-first scan/weight/total | DONE | Tests: `tests/e2e/core-one-lane.test.ts`, `tests/guardrails/pos-offline.test.ts`. | — | — |
| D04-FR-02 | Cash/card/UPI/split, pending-payment recovery | DONE (live acquirer outside) | Tests: `tests/integration/pending-tender-recovery.test.ts`, `a-pending-card-answer-holds-the-day-close.test.ts`. | — | — |
| D04-FR-03 | Suspend/recall, exchange, refund, no-receipt | DONE | Tests: `tests/integration/the-till-returns-without-a-receipt.test.ts`, `cross-lane-refund-guard.test.ts`, `an-exchange-balance-refunded-to-a-card-is-a-till-refund.test.ts`. | — | — |
| D04-FR-04 | Float, pickup, safe drop, blind count | DONE | Test: `tests/integration/day-close-honestly.test.ts`. | — | — |
| D04-FR-05 | Mobile POS, queue busting, display, peripheral health | EXTERNAL | Tests: `tests/integration/the-queue-till-scans-pays-and-hands-over-through-the-store-computer.test.ts`, `tests/unit/queue-pos-session.test.ts` (no cash, OB-372). | A real handheld and printer, and the owner's money switch. | — |
| D04-FR-06 | Self-checkout / scan-and-go / kiosk readiness | DONE | Test: `tests/integration/self-checkout-decisions.test.ts`. | — | — |
| D05-FR-01 | Perpetual event ledger | DONE | Tests: `tests/unit/ledger.test.ts`, `tests/guardrails/ledger-append-only.test.ts`. | — | — |
| D05-FR-02 | Shelf/back-room/bin and ownership | DONE | Tests: `tests/integration/warehouse-bins.test.ts`, `concession-store-valuation.test.ts`. | — | — |
| D05-FR-03 | Online safety stock / reservation buffer | DONE | Test: `tests/integration/the-app-keeps-an-online-buffer-for-shoppers-in-the-store.test.ts`. | — | — |
| D05-FR-04 | Batch, FEFO, expiry, cold chain, quarantine | DONE | Tests: `tests/integration/inventory-fefo-allocation.test.ts`, `quality-cold-chain.test.ts`, `cold-chain-at-receiving.test.ts`. | — | — |
| D05-FR-05 | Blind counts, variance root cause, financial impact | DONE | `services/inventory/src/count-plans.ts:75` (root cause). Test: `tests/integration/a-stock-count-is-planned-frozen-recounted-approved-and-booked.test.ts`. | — | — |
| D05-FR-06 | Returns, recall, destruction evidence | DONE | Tests: `tests/integration/a-recall-runs-its-whole-lifecycle-on-postgresql.test.ts`, `goods-receipt-disposition.test.ts`. | — | — |
| D06-FR-01 | Effective-dated zone/channel prices | DONE | Tests: `tests/integration/a-channel-price-needs-its-approval-and-never-exceeds-mrp.test.ts`, `the-pack-carries-a-switched-on-zone-price.test.ts`. | — | — |
| D06-FR-02 | MRP, cost, margin-floor controls | DONE | Tests: `tests/unit/price-guard.test.ts`, `tests/integration/the-margin-floor-is-the-stores.test.ts`, `tests/guardrails/a-real-trading-bill-is-never-above-the-mrp-total.test.ts`. | — | — |
| D06-FR-03 | BOGO, mix-match, multibuy, bundles, coupons, bank offers | DONE | `PromotionKind` includes `multibuy`, `bundle_price`, `mix_match`, `bank_offer` (`packages/promotions/src/promotions.ts`). Bank offers are built and off until integrated terminals (OB-305/OB-349). Basket-affinity drafts run whole shop days (OB-610, `apps/web-erp/src/basket-affinity-session.ts`). Tests: `tests/unit/p2-offers-are-deterministic-and-never-reach-tobacco.test.ts`, `tests/integration/p2-offers-funding-and-results-are-folded-from-the-bills.test.ts`, `tests/unit/r15a-typed-times-and-labels-read-the-shops-clock.test.ts` (OB-610). | — | — |
| D06-FR-04 | Best price, stacking, abuse limits | DONE | Tests: `tests/unit/promotions.test.ts`, `tests/integration/promotion-abuse-check.test.ts`. | — | — |
| D06-FR-05 | Markdown ladder, competitor capture | DONE | Tests: `tests/integration/markdown.test.ts`, `a-competitor-gap-drafts-a-price-a-person-approves.test.ts`. | — | — |
| D06-FR-06 | Shelf/POS/app/ESL price-integrity audit | EXTERNAL | Tests: `tests/integration/price-integrity.test.ts`, the ESL stand-in in `p6-floor-devices-…test.ts`. | Real electronic shelf labels. | — |
| D07-FR-01 | Guest/registered/household identity, merge | DONE | Tests: `tests/integration/customer-duplicates.test.ts`, `household-pooling.test.ts`. | — | — |
| D07-FR-02 | Consent, preference, rights, grievance | DONE | Tests: `tests/integration/data-rights.test.ts`, `a-nominee-can-be-recorded-and-a-grievance-has-the-published-sla.test.ts`, `privacy-consent-notice.test.ts`. | — | — |
| D07-FR-03 | Points, tiers, expiry, reversal, liability | DONE | `packages/loyalty/src/tiers.ts` (off until the owner sets the numbers, OB-295). Tests: `tests/integration/loyalty-tiers-and-expiry-stay-off-until-the-owner-sets-them.test.ts`, `loyalty-liability-reconciles-to-the-books.test.ts`. | — | — |
| D07-FR-04 | Gift cards, store credit, membership, referral | DONE | Tests: `tests/integration/stored-value-liability.test.ts`, `referral-liability-reconciles-to-the-books.test.ts`. | — | — |
| D07-FR-05 | Segments, CLV, campaign frequency, fraud controls | DONE | Tests: `tests/integration/customer-segments.test.ts`, `campaign-consent.test.ts`. | — | — |
| D07-FR-06 | Service cases, compensation, satisfaction | DONE | As M21-FR-03/04. | — | — |

## Addendum B13–B24

| id | requirement | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| B13 | Gold HUID; POS blocks un-hallmarked gold | DONE | Test: `tests/integration/a-gold-piece-is-sold-once-with-its-huid.test.ts`. | — | — |
| B14 | Tobacco age-18 gate; no loose sticks | DONE | Tests: `tests/unit/till-legal-gates.test.ts`, `tests/integration/restricted-sales.test.ts`, `the-till-enforces-the-legal-gates.test.ts`. | — | — |
| B15 | Tobacco warning board; POS advertising limits | EXTERNAL | `packages/restricted-sales/src/advertising.ts`. Test: `tests/integration/b15-tobacco-is-never-promoted-on-any-surface.test.ts`. Checklist line 88 of `docs/runbooks/store-go-live-checklist.md`, pinned by `tests/guardrails/the-tobacco-warning-board-is-on-the-go-live-checklist.test.ts`. | The physical board, put up with a dated photo. | — |
| B16 | Block packs lacking the 85% warning | DONE | Test: `tests/integration/a-tobacco-pack-without-a-current-warning-attestation-is-not-sellable.test.ts`. | — | — |
| B17 | No liquor in TN (TASMAC) | DONE | `packages/restricted-sales/src/liquor.ts`. Tests: `tests/integration/product-master.test.ts` ("B17 — liquor is never published…"), the p2 product-master test. | — | — |
| B18 | OTC remedies / pharmacy licence | DONE | OB-310: no medicines. Code: `packages/restricted-sales/src/medicines.ts`. Test: `tests/integration/b18-a-medicine-is-refused-at-publish-the-pack-and-head-office.test.ts`. | — | — |
| B19 | Carry bags ≥120 µm; banned plastics blocked | DONE | Tests: `tests/unit/single-use-plastic.test.ts`, the B19 cases in `the-till-judges-what-is-charged-and-its-own-units.test.ts`. | — | — |
| B20 | Own-brand plastic EPR register | DONE | Test: `tests/integration/epr-totals-plastic-by-category-for-the-year.test.ts`. | — | — |
| B21 | E-waste take-back | DONE | Test: `tests/integration/e-waste-and-batteries-go-only-to-a-registered-recycler.test.ts`. | — | — |
| B22 | Battery take-back | DONE | Same test as B21. | — | — |
| B23 | Online store display duties, grievance officer | DONE | `packages/storefront/src/listing-duties.ts`; `apps/web-erp/web/online-store.js` (the officer stays "not set" until the owner types it, OB-311). Tests: `tests/unit/online-listing-duties.test.ts`, `tests/integration/an-incomplete-product-is-not-published-online.test.ts`. | (Owner act: type his name and contact.) | — |
| B24 | Statutory label character heights | DONE | Counter label 58 × 40 mm with 2 mm letters (OB-518, `packages/production/src/packing.ts:55`). Tests: `tests/unit/product-label-height.test.ts`, `tests/integration/a-counter-label-carries-its-marks-sizes-and-unit-price.test.ts`. | — | — |

---

## Summary

| status | count | rows |
|---|---|---|
| DONE | 86 | M19-FR-01–04 (4); M20-FR-02; M21-FR-03, 04; M22-FR-01–04; M23-FR-01–03; M24-FR-01–03; M25-FR-01–04; M26-FR-03, 04; M27-FR-01, 02, 04 (26 module rows) · WF-11, 12, 14, 15, matrix (5) · QG-12 (1) · MG-07, 08, 09, 12 (4) · D01–D07 except D03-FR-02, D04-FR-05, D06-FR-06 (39) · B13, 14, 16–24 (11) |
| PARTIAL | 3 | M21-FR-02, M26-FR-01, M27-FR-03 |
| MISSING | 0 | — |
| DECISION | 0 | (The GST treatment of the M27-FR-03 invoice needs the CA, inside the PARTIAL row.) |
| EXTERNAL | 14 | M20-FR-01, 03, 04; M21-FR-01; M26-FR-02; WF-13; QG-09; QG-10; MG-10; MG-11; D03-FR-02; D04-FR-05; D06-FR-06; B15 |
| DEFERRED | 3 | M23-FR-04 (OB-381), M24-FR-04 (OB-312), QG-11 (OB-382) |

Total 86 + 3 + 0 + 0 + 14 + 3 = **106**. Against the 27/28 Oct verdicts, two rows they called DONE are now PARTIAL: M26-FR-01 (spares) and M27-FR-03 (invoices). M21-FR-02 was DONE on 27 Oct; its journeys are proven, but the attribution half is not.

### The non-DONE, non-EXTERNAL, non-DEFERRED rows, with the exact gap

1. **M21-FR-02 — campaign attribution is typed, not derived.**
   - `services/customer/src/campaigns.ts:228-252` weighs `sentTo` and `orders` sent in the request body.
   - Nothing reads the campaign's own sends or the order and bill ledgers. No screen shows attribution.
   - M21.md says "attribution derived".
   - Size S–M.
2. **M26-FR-01 — spares are not tracked.**
   - `ServiceLog.sparesUsed` (`packages/facilities/src/assets.ts:64`) is dropped by the service route (`services/platform/src/facilities-assets.ts:89-108`).
   - There is no spare-parts register, no stock and no warning, and no test.
   - Size S–M.
3. **M27-FR-03 — no settlement invoice and no posting.**
   - Nothing in `services/finance/src/concession*.ts` issues the shop's invoice for rent, revenue share and utilities.
   - Nothing posts the settlement to the books, so it cannot be reconciled with the ledger (M23).
   - The GST on that invoice needs the CA.
   - Size M.

## Hard rules, dead routes, owner decisions

- **Hard-rule breaches in this slice: none found.**
  - No `UPDATE` / `DELETE FROM` in the slice's services.
  - The card-data, secrets, append-only ledger, AI-write and offline-POS guardrails pass (see Tests run).
  - The delivery proof keeps coordinates off the phone's list and the board (hard rule 3 does not apply; PII is minimised as M19.md asks).
- **Dead routes: none in this slice.** Every `/v1/…` path called by the slice's screens (dispatch, campaigns, b2b, concessions, supplier submissions, facilities office, help, adoption, gates, tally files, findings, certificates, online store) is a registered route.
- **Owner decisions OB-500 to OB-610 touching this slice are built as decided:**
  - OB-502 with OB-544 (expired only blocks food work), OB-522, OB-535, OB-538;
  - OB-507, OB-531, OB-539, OB-541 (roster offline and the copy);
  - OB-514 (recurring pause);
  - OB-517 and OB-530 (PPV from the bill matched to that receipt);
  - OB-518 (58 × 40 mm counter label);
  - OB-609 (findings page);
  - OB-610 (whole shop days).
  - **Small traceability gap:** OB-544, OB-535, OB-538, OB-541 and OB-518 are not named in any test file, although their behaviour is asserted (e.g. "none on file does not" in the r7d test, "self- and proxy-verification refused" in the r8c test). A later checker must search by behaviour, not by number.
- **Not a breach, but known flakiness under load:**
  - The three 5-second timeouts above (HA-1 picker assignment, the WF-08 stock-count path, and the 300-session MRP guardrail) fail when the machine is busy and pass alone. If CI runners are shared, these may turn a pull request red by chance. Raising their per-test timeout would fix it and change nothing in the product.
