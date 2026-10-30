# Lane 4 re-audit, 30 Oct 2026: M28–M36, WF-16–WF-20, D08–D14, A01–A10 and AI governance, addendum C1–C21, R8 scale items

**Slice.** Modules M28–M36 (every FR), workflows WF-16–WF-20, extensions D08–D14 (every FR), AI agents A01–A10, AI governance (roadmap §7.1, §27 "AI control", §29, §30.2 AI events, QG-11), addendum C1–C21 (`docs/requirements/WORLDWIDE_REQUIREMENTS_GAP_ANALYSIS.md`) and the R8 scale items (§15 R8, §21 Stage 18, §8.2).

**Main commit.** `5c84f4c7` (read-only; no file changed except this one).

**Sources.** Roadmap text extracted from `docs/roadmap/roadmap-v2.0.docx` (§5, §7, §7.1, §15, §16, §26, §27, §30, §31); `docs/roadmap/roadmap-v2.1-addendum.md`; `docs/requirements/M28.md`–`M36.md`; `docs/requirements/WORLDWIDE_REQUIREMENTS_GAP_ANALYSIS.md`; `docs/registers/decisions.md` (OB-293, OB-311–OB-324, OB-345, OB-350, OB-365, OB-374, OB-379, OB-381, OB-382, OB-405–OB-407, OB-420, OB-500–OB-610). The 23 Oct lane-4 audit (`docs/audit/full-2026-10-23/lane-4.md`) was used only for the row list; every verdict below is new. `docs/traceability.md` was used only to find code and tests, which were then read.

**How it was checked.** For each row: the code path, the route it is served on (`docs/api/openapi.json`, generated from the router), the screen that calls it where a person must act, and the assertions of the named test. A script compared every `/v1/...` path the apps and the store computer call against the 1,508 OpenAPI paths: **no screen calls a route that does not exist** (the only unmatched strings were comments and the deliberately absent `/v1/ingest`, which is named only in a comment in `edge/sync-agent/src/http-transport.ts`).

**Tests run** (PostgreSQL `audit_lane_4`, trust auth):
TESTRUN_PLACEHOLDER

---

## 1. Modules M28–M36

| id | requirement (short quote) | status | evidence (code + test paths) | what finishes it | size |
|---|---|---|---|---|---|
| M28-FR-01 | "wastage/damage/expiry/donation/destruction with reason codes and approval"; offline "queued; approval on sync" | DONE | `services/inventory/src/write-off.ts`, `write-off-captured.ts`, `apps/web-erp/src/write-off-queue-session.ts`; `tests/integration/the-store-computer-carries-readings-losses-and-acknowledgements.test.ts` (small loss posts on relay; ≥₹500 needs photo, waits `awaiting_approval`, raiser refused `self_approval`, rejected keeps nothing, cold restart), `tests/integration/waste-write-off.test.ts`, `tests/e2e/help-readings-and-losses-are-saved-at-the-store-with-the-line-down.e2e.ts` | — | — |
| M28-FR-02 | "scrap/recycling sales with evidence" | DONE | `services/finance/src/scrap.ts`, `apps/web-erp/web/scrap.*`; `tests/integration/scrap.test.ts` (incl. OB-515: manager refused recording, accountant records), `tests/e2e/the-scrap-and-packaging-screens-work-through-the-store-computer.e2e.ts` | — | — |
| M28-FR-03 | carry bags, reusable packaging, packaging stock | DONE | `services/inventory/src/packaging.ts`, `apps/web-erp/web/packaging.*`; `tests/integration/packaging.test.ts`, same e2e | — | — |
| M28-FR-04 | "waste, energy and sustainability metrics … with drill-through" | DONE | `services/api/src/owner-reporting-adapters.ts`; `tests/integration/owner-dashboard-covers-every-domain.test.ts` (energy and scrap "not known" until recorded, then 1,200 kWh / ₹750 scrap with drill to records) | — | — |
| M29-FR-01 | sales, margin, cash, stock, purchase, customer, fulfilment KPIs | DONE | `services/api/src/dashboard-figures.ts`; `tests/integration/owner-dashboard-covers-every-domain.test.ts` (seven domains, figures equal their reports, branch scope, cashier 403) | — | — |
| M29-FR-02 | branch/category/vendor/staff comparisons, drill-through | DONE | `services/reporting/src/drill-through.ts`, `apps/web-erp/web/branch-compare.*`; `tests/integration/owner-drill-through.test.ts`, `tests/e2e/the-compare-screen-ranks-and-drills-within-the-readers-branches.e2e.ts` | — | — |
| M29-FR-03 | freshness, thresholds, exception alerts, approval inbox | EXTERNAL | `services/reporting/src/owner-exceptions.ts`, `services/api/src/ops-alert-sweeps.ts`, `apps/web-erp/web/owner-alerts.*`, OB-609 page (`GET /v1/sales/exceptions`); `tests/integration/owner-exception-alerts-raise-themselves.test.ts`, `tests/unit/owner-alerts-session.test.ts` | Phone push needs a messaging provider (OB-222). | — |
| M29-FR-04 | scheduled reports, exports, daily narrative | EXTERNAL | `services/reporting/src/report-schedules.ts`, `scheduled-brief.ts`; `tests/integration/scheduled-reports-prepare-themselves.test.ts`, `tests/integration/scheduled-brief.test.ts`; rule-based narrative (OB-296) | Sending needs a provider (OB-47, OB-222). | — |
| M30-FR-01 | template import for any authorised domain | DONE | `services/purchase/src/import-templates-domains.ts` (supplier, price list, opening stock, customer, loyalty opening — OB-315 "all"); `tests/integration/every-domain-imports-with-a-dry-run-and-an-undo.test.ts`, `tests/unit/import-templates-domains.test.ts` | — | — |
| M30-FR-02 | exports for every master and transaction domain | DONE | `services/purchase/src/data-export.ts` `EXPORT_COVERAGE`: 25 domains, none `not_yet`; `tests/integration/the-further-domains-export.test.ts`, `tests/integration/data-export.test.ts` | — | — |
| M30-FR-03 | duplicate, mandatory, reference, reconciliation controls | DONE | `packages/import/src/import-job.ts`; `tests/integration/data-import.test.ts` | — | — |
| M30-FR-04 | job history, row errors, rollback, data-quality score | DONE | `services/purchase/src/import-quality.ts`; `tests/integration/import-quality.test.ts` | — | — |
| M31-FR-01 | versioned documents, templates, retention | DONE | `services/platform/src/documents.ts`; `tests/integration/documents-templates.test.ts`, `documents-retention.test.ts` | — | — |
| M31-FR-02 | receipt/invoice/PO/GRN/statement generation | DONE | `services/api/src/document-sources.ts`; `tests/integration/documents-issue-from-their-records.test.ts` | — | — |
| M31-FR-03 | routing, consent + frequency check, delivery status | DONE | `services/customer/src/notification-queue.ts` (cap at enqueue and at send), frequency policy on `apps/web-erp/web/campaigns.html`; `tests/integration/do-not-contact-frequency-cert-in-and-capacity.test.ts` (no cap → `frequency_cap_not_set`; lowered cap holds waiting message), `tests/integration/delivery-reports-are-the-providers.test.ts`. Live providers EXTERNAL. | — | — |
| M31-FR-04 | retry, **suppression**, cost, template approval | PARTIAL | Stored register built: `services/customer/src/suppression-register.ts`, routes `POST /v1/notifications/suppressions/:customerId`, `/lift`, `GET /v1/notifications/suppressions`; guard, queue and campaigns read it; `tests/integration/do-not-contact-frequency-cert-in-and-capacity.test.ts`. **No screen calls these routes** (`grep -r suppressions apps/ edge/` finds nothing), so a customer who says "never contact me" at the desk cannot be recorded without a programmer. | Add the do-not-contact list (add with reason/source, lift with reason, history) to the customer or campaigns page (`apps/web-erp/src/customers-session.ts` or `campaigns-session.ts`), with a unit test of the session and a browser test. | S |
| M32-FR-01 | versioned APIs, service identities, signed webhooks, idempotency; §30.1 machine-readable contract | DONE | `docs/api/openapi.json` (OpenAPI 3.1, 1,508 paths), `docs/api/asyncapi.json` (AsyncAPI 3.0), `services/platform/src/api-contracts.ts`, `api-body-derive.ts`; `tests/guardrails/the-openapi-and-asyncapi-documents-equal-the-router.test.ts`, `tests/integration/money-route-schemas-match-the-handlers.test.ts`, `tests/integration/webhooks.test.ts`. See observation O-1 on §30.2 event coverage. | — | — |
| M32-FR-02 | connector SDK, mapping, throttling, retry, dead letter | DONE | `services/platform/src/connector-delivery.ts`; `tests/integration/connector-delivery.test.ts`, `connector-mapping.test.ts` | — | — |
| M32-FR-03 | sandbox, API docs, secrets, usage monitoring | DONE | `services/platform/src/secrets.ts`, `partners.ts`; `tests/integration/managed-secrets.test.ts`, `partner-sandbox.test.ts` | — | — |
| M32-FR-04 | Tally, payments, GST, messaging, logistics, hardware adapters | EXTERNAL | Daily Tally file with dead letter: `services/finance/src/tally-outbox.ts`; `tests/integration/the-daily-tally-file-carries-every-journal-and-keeps-a-dead-letter.test.ts`, `tests/integration/integration-gateway.test.ts`. Live Tally connector deferred to R8 (OB-381). | Payment, GSP/IRP, WhatsApp, maps and hardware providers. | — |
| M33-FR-01 | tenant settings, jobs, feature flags, config history | DONE | `packages/tenant/src/settings.ts`; `tests/integration/background-jobs.test.ts`, `config-rollback.test.ts` | — | — |
| M33-FR-02 | devices, versions, remote sessions | DONE | `packages/platform-admin/src/client-version.ts`, `handheld-build.ts`, `apps/web-erp/src/fleet-version-exceptions.ts` (OB-501, OB-521, OB-537, OB-540, OB-601, OB-603 built as decided); `tests/unit/r10a-devices-section-and-the-accountant.test.ts`, `tests/unit/r11a-the-checkers-gaps.test.ts`, `tests/integration/r11a-the-checkers-gaps.test.ts`, `tests/integration/remote-sessions.test.ts` | — | — |
| M33-FR-03 | time-bound audited support access | DONE | `/v1/platform/support-access/*`; `tests/integration/support-and-remote-sessions-bind-the-sign-in.test.ts` | — | — |
| M33-FR-04 | status centre, diagnostics, licence, service management | DONE | `services/platform/src/status-centre.ts`, `licences.ts`, `service-requests.ts`; `tests/integration/licence-expiry.test.ts`, `service-requests.test.ts` | — | — |
| M34-FR-01 | immutable who/what/when/where/before/after | DONE | `services/finance/src/audit-trail-store.ts`; `tests/integration/audit-trail-store.test.ts` | — | — |
| M34-FR-02 | search, export, legal hold, retention | DONE | `services/finance/src/legal-holds.ts`; `tests/integration/legal-holds.test.ts` | — | — |
| M34-FR-03 | licence, food-safety, metrology, privacy evidence | DONE | `services/compliance/src/obligations.ts`; `tests/integration/compliance-obligation-lifecycle.test.ts` | — | — |
| M34-FR-04 | risk, control, incident, remediation, attestation | DONE | `services/compliance/src/risk.ts`; `tests/integration/risk-register.test.ts`, `risk-followthrough.test.ts` | — | — |
| M35-FR-01 | encrypted backups, immutable off-site copy, restore tests | EXTERNAL | `packages/ops/src/backup.ts`, `infra/pilot/backup/encrypted-backup.sh`; `tests/integration/backup-verification.test.ts` | Off-site immutable store (OB-02) and an owner-witnessed restore. | — |
| M35-FR-02 | RPO/RTO, recovery, runbooks | DONE | `services/platform/src/dr-readiness.ts`; `tests/integration/dr-readiness.test.ts` | — | — |
| M35-FR-03 | metrics, logs, traces, sync lag, queue and integration health | DONE | `services/platform/src/observed-health.ts`; `tests/integration/observed-health.test.ts` | — | — |
| M35-FR-04 | alert ownership, escalation, incident/postmortem, **CERT-In 6-hour workflow, capacity planning** | PARTIAL | Built at head office: `POST /v1/platform/incidents/:id/cert-in`, `/cert-in/report`, `GET /v1/platform/cert-in`, `GET /v1/platform/capacity-report`, `PUT /v1/platform/capacity-plan`; overdue alert via `services/api/src/ops-messaging-adapters.ts`; `tests/integration/do-not-contact-frequency-cert-in-and-capacity.test.ts`, `tests/unit/cert-in-capacity-and-suppression.test.ts`. **No screen calls any of these**: the incidents page (`apps/web-erp/src/incidents-session.ts`) has no "reportable to CERT-In" classification or "reported" action, and no page shows the capacity report or takes the growth figure. The overdue alert reaches the owner, but he cannot answer it on screen. | Add CERT-In classify and report actions to the incidents page and a capacity panel (report + plan form, owner only) on the status/health page, with session unit tests and a browser test. | S |
| M36-FR-01 | isolation, plans, entitlements, metering, subscription readiness | DONE | `services/platform/src/metering.ts` (stores, lanes, users, AI spend, information only — OB-321, OB-366), `apps/web-erp/src/rollout-session.ts`; `tests/integration/the-shop-is-metered-for-information.test.ts`, `tenant-entitlements.test.ts` | — | — |
| M36-FR-02 | white label without code forks | DONE | `packages/platform/src/branding.ts`; `tests/integration/tenant-branding.test.ts` | — | — |
| M36-FR-03 | tenant export, closure, support boundaries, upgrade compatibility | DONE | `services/platform/src/tenant-lifecycle.ts`, `upgrade-compatibility.ts`; `tests/integration/a-shop-account-closes-only-approved-with-its-export.test.ts`, `tests/guardrails/an-upgrade-never-breaks-a-live-shop.test.ts`, `tests/integration/tenant-export.test.ts` | — | — |
| M36-FR-04 | partner implementation and developer ecosystem | DONE | `packages/partner-sdk/src/{client,webhooks}.ts`; `tests/unit/the-partner-sdk-keeps-its-promises.test.ts`, `tests/integration/a-partner-builds-against-the-sandbox-with-the-sdk.test.ts` | — | — |

## 2. Workflows WF-16–WF-20

| id | requirement (short quote) | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| WF-16 | online cancellation/return: eligibility → collect → disposition → refund → notice | EXTERNAL | `services/orders/src/storefront-online-returns.ts`, `apps/web-erp/web/online-store.js`; `tests/integration/an-online-return-refunds-only-what-came-back.test.ts`, `the-driver-collects-an-online-return-through-the-box.test.ts` | Owner enters return windows and non-returnable list (OB-213) and the grievance contact (OB-311); messaging provider for the notice; R4 acceptance re-run (OB-227). | — |
| WF-17 | case → SLA → investigate → compensation → resolve → feedback | DONE | `services/customer/src/service-cases.ts`; `tests/integration/ai-service-agent.test.ts`, `tests/e2e/service-desk-and-assistant-drafts.e2e.ts` | — | — |
| WF-18 | finance close: stock/tenders/banks/AP/AR/tax → exceptions → close → P&L | DONE | `services/api/src/adapters.ts` `bookChecksFor`, `services/finance/src/gst-returns.ts`; `tests/integration/the-close-checks-credit-customer-receivables.test.ts`, `a-return-reverses-the-same-gst-in-the-books-and-the-gst-return.test.ts` | — | — |
| WF-19 | migration/cutover through archive/retire | EXTERNAL | `services/migration/src/*`; `tests/integration/migration-pipeline.test.ts`, `tests/guardrails/the-cutover-gate-is-never-ticked.test.ts` | Legacy data, parallel run, owner's GO (QG-07). | — |
| WF-20 | release/incident: approve → backup → canary → smoke/reconcile → monitor → rollback | DONE | `infra/deploy/release.sh`, `scripts/release-signing.mjs`, `scripts/release-reconcile.mjs`, `.github/workflows/ci.yml` (Semgrep SAST, Trivy image/IaC scans, ZAP DAST, pnpm audit, SBOM, signing); `tests/integration/the-release-script-deploys-and-rolls-back.test.ts`, `tests/guardrails/releases-are-signed-and-checked.test.ts`, `tests/unit/qg10-the-books-are-reconciled-around-every-release.test.ts` | — | — |

All five carry scenario lists held by `tests/guardrails/every-workflow-scenario-points-at-a-real-test.test.ts`.

## 3. Extensions D08–D14

| id | requirement (short quote) | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| D08-FR-01 | 10-km configurable serviceability | DONE | `services/orders/src/serviceability.ts`; `tests/integration/serviceability-config.test.ts` | — | — |
| D08-FR-02 | catalogue, filters, voice/barcode search, lists, favourites | DONE | `apps/customer-app/src/barcode-scan.ts` (BarcodeDetector), `voice-search.ts` (phone recogniser, switchable off — OB-322); `tests/unit/the-customer-apps-commerce-rules.test.ts`, `tests/unit/voice-and-sms-links-are-switched-off.test.ts`, `tests/e2e/the-customer-app-prices-with-offers-and-keeps-my-account.e2e.ts` | — | — |
| D08-FR-03 | cart, repeat order, substitutions and alternatives | DONE | `apps/customer-app/src/browser-entry.ts` (`PUT storefront/substitution-preferences`, alternatives with AI notice); same e2e | — | — |
| D08-FR-04 | slots, minimum order, fees, online payment, pickup | EXTERNAL | `tests/integration/a-delivery-slot-and-address-are-the-shops-to-judge.test.ts`, `tests/integration/order-payments-and-refunds.test.ts` | Live RBI-authorised gateway. | — |
| D08-FR-05 | live tracking, receipts, return/refund, complaints | EXTERNAL | `packages/fulfilment/src/delivery-eta.ts`; `tests/integration/the-delivery-proof-is-captured-and-checked.test.ts` (code and ETA from last stamped stop) | Maps provider for a live position. | — |
| D08-FR-06 | English/Tamil, accessibility, low bandwidth, secure sessions | DONE | `apps/customer-app/web/*`, `sw.js`; `tests/e2e/the-customer-app-meets-wcag-aa.e2e.ts`, `tests/performance/customer-app-payload.test.ts` | (SMS code provider is OB-222, EXTERNAL.) | — |
| D09-FR-01 | branch/capacity-aware routing, reservation | DONE | `services/fulfilment/src/order-routing.ts`; `tests/integration/an-online-order-is-routed-to-one-branch.test.ts`, `a-placed-delivery-goes-to-the-branch-head-office-routes.test.ts` | — | — |
| D09-FR-02 | split/partial order, controlled substitutions | DONE | `packages/orders/src/substitution-policy.ts`; `tests/e2e/substitution-exception-claim-resolve.e2e.ts` | — | — |
| D09-FR-03 | wave picking, weighted price, QC | DONE | `apps/picker-app/src/*`; M19 tests | — | — |
| D09-FR-04 | packing, cold chain, tamper, manifest | DONE | M19-FR-02 code and tests | — | — |
| D09-FR-05 | route/geofence, proof, COD, failure, reattempt, RTO | DONE | `packages/fulfilment/src/proof-capture.ts` (250 m default, OB-343/344), `services/fulfilment/src/driver-runs.ts`; `tests/integration/the-delivery-proof-is-captured-and-checked.test.ts`, `cod-reconciliation.test.ts`, `tests/e2e/the-dispatch-page-runs-the-day.e2e.ts` | — | — |
| D09-FR-06 | partner/fleet settlement, contribution stop rules | DONE | `services/fulfilment/src/delivery-controls.ts` (OB-313: below threshold → held for a manager; "not set" → flag only), `fleet-settlement.ts`; `tests/integration/the-contribution-rule-holds-and-the-fleet-is-settled.test.ts` | — | — |
| D10-FR-01 | ledger mapping, AP/AR, **advances** | PARTIAL | `services/finance/src/supplier-advances.ts` (`/v1/finance/supplier-advances*`); `tests/integration/supplier-advances-and-earned-rebates-reach-the-books.test.ts` (paid with second-person approval, set against a bill, reversal). **No screen calls `/v1/finance/supplier-advances`** (no match in `apps/` or `edge/`), so the accountant cannot record or apply an advance. | Add a supplier-advances section to the finance or supplier-bills page (record, approve, apply to bill, reverse), with a session unit test and a browser test. | S |
| D10-FR-02 | cash/bank/gateway/refund reconciliation | DONE | `services/finance/src/payment-exceptions.ts`; C13 tests | — | — |
| D10-FR-03 | valuation, cost correction, write-off | DONE | `services/finance/src/period-books.ts`, `stock-period.ts` | — | — |
| D10-FR-04 | loyalty/gift/rebate liabilities | DONE | `services/finance/src/loyalty-liability.ts`; rebate accruals posted: `tests/integration/supplier-advances-and-earned-rebates-reach-the-books.test.ts`; `apps/web-erp/src/rebates-session.ts` | — | — |
| D10-FR-05 | budgets, fixed assets, period close | DONE | `services/finance/src/budgets-assets.ts` | — | — |
| D10-FR-06 | GST evidence, CN/DN, Tally control totals | DONE | `packages/tally-export/src/gl-journals.ts`, `services/finance/src/tally-export.ts` (`validateTallyImport` against control totals); tally tests above | — | — |
| D11-FR-01 | opening/closing and department checklists | DONE | `apps/web-erp/web/checklist.*`; `tests/integration/checklist-store.test.ts` | — | — |
| D11-FR-02 | roster/attendance, temporary access | DONE | roster/attendance (OB-507), `services/identity/src/emergency-access.ts` | — | — |
| D11-FR-03 | task board, replenishment, price-change, handover | DONE | `services/pricing/src/relabel-tasks.ts`, `apps/web-erp/web/relabel.js`; `tests/integration/the-store-computer-carries-readings-losses-and-acknowledgements.test.ts` (relabel task per shelf place), `tests/e2e/the-facilities-office-write-off-decisions-and-relabel-tasks-on-the-production-api.e2e.ts` | — | — |
| D11-FR-04 | training, competency, floor champions, adoption | DONE | `packages/workforce/src/adoption-gate.ts`, `services/finance/src/workforce-enablement.ts`; `tests/integration/the-adoption-gate-names-who-is-not-ready.test.ts`, `tests/unit/workforce-enablement.test.ts` | — | — |
| D11-FR-05 | food safety, cleaning, pest, fire, maintenance | DONE | `services/platform/src/facilities.ts`, `food-safety.ts` | — | — |
| D11-FR-06 | incident, injury, lost-and-found, emergency procedures | DONE | `services/finance/src/help-centre.ts` (emergency contacts "not set", drills, acknowledgements, offline via store computer); `tests/integration/the-help-centre-emergency-procedures-and-appointment-letters.test.ts` | — | — |
| D12-FR-01 | company/branch/warehouse, entitlements | DONE | `packages/org/src/hierarchy.ts`; `tests/integration/branch-lifecycle.test.ts` | — | — |
| D12-FR-02 | workflow/approval/number/template config | DONE | approval engine, receipt prefixes, templates | — | — |
| D12-FR-03 | job, integration, device, version management | DONE | as M33-FR-01/02 | — | — |
| D12-FR-04 | audited time-bound support access | DONE | as M33-FR-03 | — | — |
| D12-FR-05 | retention, archive, export, closure | DONE | as M36-FR-03 | — | — |
| D12-FR-06 | future tenant, white label, subscription readiness | DONE | as M36-FR-01/02; billing sandbox `services/platform/src/billing-routes.ts` (live merchant account EXTERNAL) | — | — |
| D13-FR-01 | sales, margin, basket, tender, cashier, hourly | DONE | `services/api/src/report-producers.ts`; `tests/integration/the-other-sixteen-reports-reconcile-sales-and-stock.test.ts` | — | — |
| D13-FR-02 | purchase, supplier, stock, expiry, waste, shrinkage | DONE | `report-producers-more.ts`; `the-other-sixteen-reports-reconcile-buying-fulfilment-customer-ai.test.ts` | — | — |
| D13-FR-03 | customer, loyalty, marketing, complaints | DONE | same producers and tests | — | — |
| D13-FR-04 | orders, substitutions, delivery SLA, contribution | DONE | same | — | — |
| D13-FR-05 | finance, GST, reconciliation, profitability | DONE | same | — | — |
| D13-FR-06 | freshness, sync health, security, AI outcomes | DONE | `security` report in `packages/reporting/src/catalogue.ts`; `tests/integration/owner-dashboard-covers-every-domain.test.ts` (access given counted; failed till sign-ins "not known" until the box log arrives — OB-365; office lockouts said to be in memory) | — | — |
| D14-FR-01 | scanner, printers, scale, drawer, display | EXTERNAL | `edge/store-edge/src/peripheral-health.ts`; `tests/integration/integration-gateway.test.ts` | Certified device matrix on real devices. | — |
| D14-FR-02 | handheld, payment terminal, price kiosk | DONE | `apps/price-kiosk/*`; `tests/unit/p6-self-checkout-lane-and-kiosk.test.ts`, `tests/e2e/the-price-kiosk-quotes-from-the-signed-list-and-says-how-old-it-is.e2e.ts`; terminal is standalone by OB-511 | — | — |
| D14-FR-03 | Tally, payment, GST, WhatsApp | EXTERNAL | as M32-FR-04; `packages/notifications/src/transport.ts` (off) | Providers (OB-222); live Tally deferred R8 (OB-381). | — |
| D14-FR-04 | maps/logistics, delivery partners | EXTERNAL | `packages/fulfilment/src/delivery-economics.ts` (courier link off, OB-294) | Maps provider or partner contract. | — |
| D14-FR-05 | ESL, RFID, CCTV-event, IoT readiness | EXTERNAL | `services/platform/src/device-events.ts`, `packages/integration/src/floor-devices.ts`; `tests/integration/p6-floor-devices-are-signed-switched-on-and-never-edit-a-ledger.test.ts`, `the-security-reviewer-signs-and-floor-devices-need-owner-and-reviewer.test.ts` | Named reviewer's §8.2 review (OB-405/406/420); vendors and hardware. | — |
| D14-FR-06 | versioned APIs, webhooks, sandbox, connector SDK | DONE | as M32-FR-01..03, M36-FR-04 | — | — |

## 4. AI agents A01–A10

| id | requirement (short quote) | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| A01 | NL KPI questions, daily brief, causal hypotheses, action list; read-only | DEFERRED | Rule-based action list and causal hypotheses (same weekday last week, OB-516): `services/ai/src/control.ts`, `services/api/src/ai-owner-causes.ts`; `tests/integration/a01-says-why-the-takings-fell.test.ts`, `tests/integration/ai-agents-draft-for-people.test.ts` | Natural-language questions on a live model: OB-382 (R8). | — |
| A02 | forecast, reorder, quotation comparison, draft PO; buyer approves | DONE | `services/api/src/ai-predictions.ts`, `ai-adapters.ts`; proposals and outcome on `apps/web-erp/web/ai.js`; `tests/integration/ai-agents-draft-for-people.test.ts`; eval cases in `services/ai/src/evaluation-set.ts` | — | — |
| A03 | stockout/overstock/expiry prediction, transfer/markdown; manager approves | DONE | `services/api/src/ai-predictions.ts`; `tests/integration/ai-inventory-predicts-expiry-and-overstock.test.ts`, `ai-agents-draft-for-people.test.ts` | — | — |
| A04 | search, list-to-cart, alternatives, guided shopping; customer confirms | DEFERRED | `services/api/src/ai-shopping.ts`, customer app ideas panel; `tests/integration/ai-shopping-agent-offers-in-stock-alternatives.test.ts`, customer-app e2e | Guided shopping on a live model: OB-382 (R8). | — |
| A05 | policy/order answers, case drafts, escalation | DEFERRED | `services/orders/src/storefront-account.ts`, `services/ai/src/drafting-legs.ts`; `tests/integration/the-customers-own-account-suggestions-and-help.test.ts`, `ai-service-agent.test.ts` | Free-text answers on a live model: OB-382 (R8). | — |
| A06 | explain incidents, recommend runbook | DONE | `/v1/ai/operations/worklist`; `tests/integration/ai-operations-worklist.test.ts` | — | — |
| A07 | summarise anomalies, prioritise; no sanctions | DONE | `/v1/ai/security/anomaly-summaries`; e2e service-desk | — | — |
| A08 | duplicates, missing attributes, mappings | DONE | `/v1/ai/data-quality/*`; `tests/integration/ai-data-quality-worklist.test.ts` | — | — |
| A09 | draft segments, campaigns, offers within consent/margin | DONE | `services/api/src/ai-adapters.ts` `offerProposals` (offer idea routed to promotion simulate/launch by marketing approver; no discount invented, per D-22/D-23); `tests/integration/ai-marketing-agent.test.ts` | — | — |
| A10 | workforce/SOP guidance; no HR decisions | DONE | `/v1/ai/workforce/*`; `tests/integration/ai-workforce-worklist.test.ts` | — | — |

## 5. AI governance

| id | requirement (short quote) | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| AI-NFR-01 | central gateway and approved-model registry | DONE | `services/ai/src/model-registry.ts`, `model-gateway.ts` (`/v1/ai/models`, withdraw); `tests/integration/ai-governance-controls.test.ts`, `tests/unit/ai-governance-rules.test.ts` | — | — |
| AI-NFR-02 | role/branch/purpose/tool scope | DONE | `packages/ai/src/authority.ts`; `tests/integration/ai-inboxes-keep-to-the-readers-branches.test.ts` | — | — |
| AI-NFR-03 | read-only default, explicit action permissions | DONE | agents off until `PUT /v1/ai/agents/enabled`; proposals `committed:false` | (Screen gap: see AI-SCREEN.) | — |
| AI-NFR-04 | citations, confidence and uncertainty | DONE | `confidence` band + `uncertainty` on proposals; shown in `apps/web-erp/web/ai.js`; `tests/unit/ai-governance-rules.test.ts` | — | — |
| AI-NFR-05 | injection, malicious-document, exfiltration defences | DONE | `tests/integration/ai-model-calls-are-governed.test.ts` | — | — |
| AI-NFR-06 | minimisation and redaction | DONE | `services/ai/src/minimise.ts` run in `model-gateway.ts`; `tests/unit/ai-governance-rules.test.ts` | — | — |
| AI-NFR-07 | human approval, limits, separation of duties | DONE | `tests/guardrails/ai-agent-db-write.test.ts`, `no-ai-issues-an-offer-or-a-price.test.ts` | — | — |
| AI-NFR-08 | immutable prompt/context/tool/result audit | DONE | `AiModelCallAudited` hash chain; `ai-model-calls-are-governed.test.ts` | — | — |
| AI-NFR-09 | evaluation sets, thresholds, regression | DONE | `services/ai/src/evaluations.ts`, `evaluation-set.ts`; `tests/guardrails/the-evaluation-set-gates-the-release.test.ts` | — | — |
| AI-NFR-10 | budgets, rate limits, fallback, kill switch | DONE | `services/ai/src/governance.ts` (scoped kill switches with reason, per-agent ceilings, rate limit, D3 ₹15,000); `tests/integration/ai-governance-controls.test.ts`, `tests/guardrails/the-kill-switch-actually-stops-it.test.ts` | — | — |
| AI-NFR-11 | customer disclosure/consent | DONE | notice + opt-in (OB-314): `services/ai/src/control.ts`, `apps/customer-app/web/customer-commerce.js` `#ai-notice`, consent purpose `ai_personalisation`; `tests/e2e/the-customer-app-prices-with-offers-and-keeps-my-account.e2e.ts` | — | — |
| AI-NFR-12 | no autonomous payment/refund/purchase/price/stock/privilege change | DONE | `FORBIDDEN_TOOLS` (`packages/ai/src/authority.ts`); guardrails above | — | — |
| AI-SCREEN | §27 AI control: registry, tools/authority, model/provider, prompts, evaluations, usage/cost, incidents, kill switch | PARTIAL | `apps/web-erp/web/ai.js`, `apps/web-erp/src/ai-control.ts` read `GET /v1/ai/control` and act on kill switches, evaluations, incidents and proposal outcomes; `tests/e2e/the-ai-control-screen-reaches-head-office.e2e.ts`, `tests/unit/erp-ai-control.test.ts`. **Missing:** the page shows "not switched on" per agent but offers no way to switch one on (`PUT /v1/ai/agents/enabled`) or to set the shop or per-agent spending limit (`PUT /v1/ai/budget`, `PUT /v1/ai/agents/:agent/budget`); no screen in `apps/` calls them, and the e2e enables agents by calling the API directly (line 114). Every agent therefore stays off unless a programmer calls the API. | Add owner-only "switch on/off" per agent and limit forms to the AI page, through the existing routes, with unit and browser tests. | S |
| AI-INCIDENTS | §27 incidents, `AI_incident`, `AIToolCallBlocked`, approved/rejected | DONE | `services/ai/src/ai-incidents.ts`, `governance.ts`; `/v1/ai/incidents*`, `/v1/ai/proposals/:id/outcome`; `tests/integration/ai-governance-controls.test.ts` | — | — |
| QG-11 | evaluations, authority, evidence, override, budgets, kill switch pass | DEFERRED | Simulator-based gate passes (`tests/guardrails/the-evaluation-set-gates-the-release.test.ts`); live-provider runs gated off in `services/ai/src/model-gateway.ts` | Live provider evaluation: OB-382 (R8). | — |

## 6. Addendum C1–C21

| id | requirement (short quote) | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| C1 | itemised consent notice with withdraw/grievance/Board links | DONE | `packages/customer/src/consent-notice.ts` (grievance contact entered on screen, OB-311) | — | — |
| C2 | DPDP breach notification | DONE | `packages/customer/src/breach-notification.ts` | — | — |
| C3 | retention clock and erasure | DONE | `packages/customer/src/retention-clock.ts` | — | — |
| C4 | children's-data guard | DONE | `packages/customer/src/child-data-guard.ts` | — | — |
| C5 | nomination + 15-day reply | DONE | `packages/customer/src/nomination.ts`, `data-rights.ts` | — | — |
| C6 | data-processor contract register | DONE | traceability C6 rows; tests in run | — | — |
| C7 | PII-at-rest encryption/masking, logs ≥1 year | DONE | `PII_FIELD_INVENTORY` guardrail | — | — |
| C8 | consent-manager interoperability | DONE | OB-324: `services/customer/src/consent-manager.ts`, `packages/customer/src/consent-manager-format.ts`, on `apps/web-erp/src/rollout-session.ts`; `tests/integration/consent-manager-records-and-the-data-volume-watch.test.ts` | — | — |
| C9 | significant-data-fiduciary watch | DONE | OB-324: `/v1/privacy/data-volume-watch*` ("not set" until the CA sets it; one alert per owner); same test | — | — |
| C10 | card tokenisation (token + last 4 + network) | DONE | `tests/guardrails/card-data.test.ts` | — | — |
| C11 | PCI scope, SAQ B-IP, AoC | EXTERNAL | OB-511: standalone bank machines; card-data guardrails | SAQ and AoC between the owner and the bank. | — |
| C12 | payment data stays in India | DONE | `tests/guardrails/payment-data-never-leaves-india.test.ts` | — | — |
| C13 | daily T+1 reconciliation | DONE | C13 rows; tests in run | — | — |
| C14 | refund to source, disputes | DONE | OB-144, OB-200 rows | — | — |
| C15 | statutory digital payslip | DONE | OB-229 row (CA confirms particulars) | — | — |
| C16 | overtime ≥2×, minimum wage | DONE | row 1146 (CA supplies figures) | — | — |
| C17 | appointment letter to every worker | DONE | OB-323 both: `packages/workforce/src/appointment-letter.ts`, `services/finance/src/appointment-letters.ts`; `tests/integration/the-help-centre-emergency-procedures-and-appointment-letters.test.ts` (letter from record; signed scan SHA-256 checked, kept, audited), `tests/e2e/the-people-and-loss-prevention-pages-on-the-production-api.e2e.ts` | — | — |
| C18 | TN Shops & Establishments pack | DONE | rows 1066 etc. (limits named "unchecked" until CA, OB-155) | — | — |
| C19 | EPF/ESI capture | DONE | OB-208 row (rates "not confirmed" until CA) | — | — |
| C20 | POSH register + annual report | DONE | rows 1067 etc. | — | — |
| C21 | biometric consent + non-biometric alternative | EXTERNAL | `packages/workforce/src/biometric-consent.ts`; `tests/unit/biometric-consent.test.ts` | Owner signs notice; an on-device reader. PIN works now. | — |

## 7. R8 scale and innovation

| id | requirement (short quote) | status | evidence | what finishes it | size |
|---|---|---|---|---|---|
| R8-1 | multi-branch | DONE | branch scope everywhere, consolidation, routing (D09-FR-01), per-branch rollout (R8-9); `tests/integration/branch-scope-every-family.test.ts` | — | — |
| R8-2 | SaaS readiness | DONE | M36 rows; pricing for outside shops "not set" by OB-321/OB-366 | — | — |
| R8-3 | self-checkout, scan-and-go, price kiosk | DONE | `apps/self-checkout/*` (OB-374 colleague PIN), `services/orders/src/storefront-scan-and-go.ts` + `edge/store-edge/src/phone-baskets.ts` (OB-350), `apps/price-kiosk/*`; `tests/e2e/the-self-checkout-lane-sends-what-the-customer-must-not-decide-to-a-colleague.e2e.ts`, `the-served-till-brings-up-a-phone-basket.e2e.ts`, `tests/integration/a-scan-and-go-basket-is-paid-at-a-till-lane.test.ts` | (A security scale is hardware.) | — |
| R8-4 | ESL | EXTERNAL | stand-in adapter behind branch switch: `services/platform/src/device-events.ts`; `p6-floor-devices-are-signed-switched-on-and-never-edit-a-ledger.test.ts` | Vendor, hardware, reviewer's review (OB-407). | — |
| R8-5 | RFID | EXTERNAL | RFID reads as count comparisons, never ledger edits; same files and test | Reader hardware, reviewer's review. | — |
| R8-6 | IoT | EXTERNAL | signed sensor readings into facilities; same files and test | Sensors, reviewer's review. | — |
| R8-7 | advanced loss prevention | EXTERNAL | `tests/integration/p6-a-self-checkout-basket-reaches-loss-prevention-and-the-camera-links.test.ts` | Reviewer's CCTV privacy review; cameras/vendor. | — |
| R8-8 | store clustering (D02-FR-02; OB-318 "reuse price-zone register as the cluster") | PARTIAL | `packages/merchandising/src/clusters.ts`, routes `/v1/merchandising/clusters*`, `/season-plans*`; `tests/integration/p2-the-floor-heat-map-clusters-seasons-and-range-gaps-are-head-offices.test.ts`. **No screen calls `/v1/merchandising/clusters`, `/season-plans` or `/assortment`** (§27 Product "assortment"), so a cluster range or season cannot be set without a programmer. | Add a clusters and seasons section (list stores per zone, list/drop a product for a cluster, season plans) to the merchandising page (`apps/web-erp/src/merchandising-session.ts`), with tests. Check with the lane that audits D02/M04 for the per-store assortment screen. | M |
| R8-9 | per-feature controlled rollout | DONE | OB-316 per branch and lane: `packages/platform/src/rollout.ts`, `services/platform/src/rollout.ts`, `apps/pos/src/lane-rollout.ts`, `apps/web-erp/src/rollout-session.ts`; `tests/integration/rollout-switches-go-per-branch-and-lane-to-the-till.test.ts`, `tests/e2e/trial-switches-and-the-shop-account-on-the-production-api.e2e.ts` | — | — |

---

## 8. Summary

COUNTS_PLACEHOLDER

**Rows not DONE, not EXTERNAL, not DEFERRED (all PARTIAL; each is a missing screen over a built, tested route):**
1. **M31-FR-04** — do-not-contact register has no screen (`/v1/notifications/suppressions*` called by nothing in `apps/`).
2. **M35-FR-04** — CERT-In classify/report and the capacity plan/report have no screen (`apps/web-erp/src/incidents-session.ts` lacks them).
3. **D10-FR-01** — supplier advances have no screen (`/v1/finance/supplier-advances*` called by nothing in `apps/`).
4. **AI-SCREEN** — the AI page cannot switch an agent on or set spending limits (`PUT /v1/ai/agents/enabled`, `/v1/ai/budget`, `/v1/ai/agents/:agent/budget` called by nothing in `apps/`).
5. **R8-8** — clusters and season plans have no screen (`/v1/merchandising/clusters*`, `/season-plans*`).

No row is MISSING. No row is DECISION: every choice left open on 23 Oct (D-1 to D-10) now has a written owner decision (OB-313 to OB-316, OB-321 to OB-324, OB-382) and each was found built as decided.

## 9. Hard rules, dead routes and owner decisions

- **Hard-rule breaches:** none seen in the slice. Write-offs, suppressions, kill switches, AI incidents and evaluations are append-only facts; the AI writes nothing (guardrails `ai-agent-db-write`, `no-ai-issues-an-offer-or-a-price`, `FORBIDDEN_TOOLS`); RFID and ESL echoes are observations, never ledger edits; card data guardrails pass.
- **Dead routes:** none. Every `/v1/...` path called from `apps/` and `edge/` resolves to an OpenAPI path.
- **Owner decisions OB-500 to OB-610 in this slice:** OB-501, OB-521, OB-537, OB-540, OB-601, OB-603 (versions; M33-FR-02/D12-FR-03), OB-511 (C11), OB-515 (scrap roles), OB-516 (A01 weekday), OB-609 (bill findings page) — each found built as decided with a test. No decision found built otherwise.
- **Observation O-1 (for the lane that audits §30):** `docs/api/asyncapi.json` has 25 events from `packages/contracts/src/event.ts` `KNOWN_EVENT_TYPES` (6 marked "not published"). Many §30.2 names (ProductApproved/Published, PriceActivated/RolledBack, PromotionActivated/Stopped, PurchaseOrderApproved, SupplierInvoiceMatched, BatchQuarantined/Recalled, OrderPlaced…Returned, ConsentGranted/Withdrawn, LoyaltyEarned/Redeemed/Reversed, SyncDelayed/Recovered, BackupVerified/Failed, SecurityIncidentRaised, AIRecommendation*, AIKillSwitchActivated) are recorded internally under other names but are not in the published event contract. This does not change M32-FR-01 (the contract exists and equals the router), but §30.2 as a list is not fully in the AsyncAPI document.
- **Observation O-2 (usability, P-07):** the AI page shows each proposal's "To act:" as a raw route (`apps/web-erp/web/ai.js` line 458, e.g. "POST /v1/promotions/:promotionId/simulate …"). A plain-language action or a link to the right page would suit the owner better.
