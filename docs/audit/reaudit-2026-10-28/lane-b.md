# Lane B: final check of the EXTERNAL and DEFERRED rows (28 October 2026)

This was a read-only check. The checked-out commit is `6d13a778`. Its files are the same as `origin/main` at `edeb0a03` (`git diff origin/main HEAD` is empty). This file is the only one written.

**What was checked.** These are the rows the 27 Oct re-audit (`docs/audit/REAUDIT-2026-10-27.md`, lanes 1 to 4) marked EXTERNAL (39 rows) or DEFERRED. Each row was checked against the code, the tests and the roadmap text (`docs/roadmap/roadmap-v2.0.docx`, plus `roadmap-v2.1-addendum.md` for A20, B15, C11 and C21). The status labels in the documents were not trusted.

**Rule used.** A row is EXTERNAL only when the software is finished and tested, and what is left needs someone or something outside this repository. If any part of the gap could be closed by code here, the row is PARTIAL. A row is DEFERRED only when the owner deferred the missing part in writing to a named release, and a working fallback is in use today.

**Since 27 Oct.** The final batch (#818) and the follow-ups (#819 to #826) are now on main. Three of them matter here:
- B15: the tobacco board is now on the go-live checklist, and a guardrail keeps it there.
- D14-FR-05 and R8-7:
  - the interim security reviewer is named (OB-405);
  - a least-privilege Security reviewer role exists (OB-406);
  - switching on cameras, shelf labels, RFID or sensors needs both the owner and the named reviewer (OB-407);
  - only the named reviewer sees and decides a floor-device review (OB-420, built in #819).

## Result

| Verdict | Rows |
|---|---|
| EXTERNAL | 39 (all 39 stay EXTERNAL) |
| PARTIAL | 0 |
| DONE | 0 |
| DEFERRED | 6 distinct rows. The 27 Oct total of 7 counted QG-11 twice, once in lane 3 and once in lane 4. |

No row moved. B15 stays EXTERNAL: the software and the checklist line are done, but the physical board still has to go up on the wall.

## EXTERNAL rows

| id | 27 Oct | now | software evidence (files and test titles) | outside piece or deferral | what is still missing in software (or —) |
|---|---|---|---|---|---|
| WF-05 | EXTERNAL | EXTERNAL | Bill capture, then OCR or e-invoice, then the match: `tests/integration/a-supplier-bill-read-by-e-invoice-or-ocr-reaches-the-match.test.ts` ("OCR: with no engine the scan waits for typing (said); with the engine a smudged line needs the figures from the paper…"). Payables reach Tally: `tests/integration/payables-reach-tally-as-an-importable-voucher-file.test.ts`, `tests/unit/tally-export.test.ts`. The daily Tally file: `services/finance/src/tally-outbox.ts`. | A real OCR engine. A live IRP/GSP feed. One real import into the shop's Tally by the accountant. The live Tally connector is deferred to R8 (OB-381). | — |
| SEC-09 / §35.1 | EXTERNAL | EXTERNAL | Secure SDLC in CI (`.github/workflows/ci.yml`): Semgrep, Trivy and an OWASP ZAP baseline on the public origin (the step named "the software side of SEC-09"). Findings register: `tests/integration/scanner-findings-and-gate-decisions-are-recorded.test.ts`. | An independent outside penetration tester, and the report. | — |
| M11-FR-03 | EXTERNAL | EXTERNAL | `edge/store-edge/src/store-work.ts` (`counterLabelFor`). `tests/unit/the-box-works-from-what-it-holds.test.ts` ("the counter label, rendered on the box (M11-FR-03 offline)"). `tests/integration/production.test.ts` ("production quality release: nothing sellable until a named person passes it (M11-FR-03)", "issues a complete pack label, and refuses one missing a legally required field"). | A real label printer and a legal-metrology scale (certified hardware). | — |
| M12-FR-01 | EXTERNAL | EXTERNAL | `edge/store-edge/src/peripheral-health.ts` (`scanSpeedOf` p95). `tests/integration/m12-fr-01-the-till-times-every-scan-and-the-box-keeps-it.test.ts` ("…p95 read back; waits when the box is away; counted after a cold restart"). `tests/unit/m12-fr-01-the-box-keeps-every-scan-time-and-reads-the-p95.test.ts`. `tests/unit/customer-display-frame.test.ts`. | A p95 measured on certified pilot till hardware. | — |
| M18-FR-04 | EXTERNAL | EXTERNAL | `apps/web-erp/src/order-refunds-session.ts`. `tests/unit/the-order-refunds-session.test.ts` ("the approval asked for carries exactly the details the refund will send"). `tests/integration/order-payments-and-refunds.test.ts` ("the processor's answer is recorded as it came…"). | A live payment gateway. Today a test-mode stand-in is used (EX-03). | — |
| QG-05 | EXTERNAL | EXTERNAL | `tests/performance/catalogue-search-p95.test.ts` (worst customer search p95 330.3 ms at 50,000 SKUs). `tests/performance/checkout-api-p95.test.ts` (checkout p95 7.4 ms). The on-till scan p95 (M12-FR-01). | The scan-to-line p95 ≤300 ms run on certified pilot hardware. | — |
| QG-06 | EXTERNAL | EXTERNAL | `packages/compliance/src/risk.ts` (`GATE_BLOCKING_SEVERITIES`). `tests/unit/compliance-findings.test.ts`. `tests/integration/scanner-findings-and-gate-decisions-are-recorded.test.ts` ("findings block QG-06/QG-03 until a clean complete scan; the gate register refuses GO over a blocker…"). | An independent penetration test before customer launch. | — |
| QG-07 | EXTERNAL | EXTERNAL | `packages/migration/src/reconcile.ts`. `tests/unit/migration-reconcile.test.ts` ("REFUSES the self-comparison…"). | The owner's real legacy data. The control totals signed, with the CA. | — |
| QG-08 | EXTERNAL | EXTERNAL | `packages/ops/src/recovery-gate.ts`, `services/platform/src/dr-readiness.ts`. `tests/unit/ops-recovery-gate.test.ts` ("with nothing recorded, HOLD naming all four as not rehearsed — never GO from silence"). `tests/integration/a-recovery-rehearsal-pass-expires-after-a-quarter.test.ts`. | Real rehearsals on the store computer with the named incident team: restore, store recovery, rollback and escalation. | — |
| A20 | EXTERNAL | EXTERNAL | `packages/e-invoice/src/sandbox-gsp.ts`. `tests/integration/e-invoice-sandbox.test.ts` ("registers a valid request, returning a sandbox IRN + SANDBOX-marked QR…", "exercises the unknown (timeout) and rejected paths on demand"). | GSP credentials for the live IRP (EX-07). The addendum says it is needed only when turnover is above ₹5 crore. | — |
| M20-FR-01 | EXTERNAL | EXTERNAL | `apps/customer-app/web/customer-commerce.js` (camera barcode), `apps/customer-app/src/voice-search.ts`, `services/customer/src/signup-sms-code.ts` (SMS code built switched off). `tests/unit/the-customer-apps-commerce-rules.test.ts`. `tests/unit/voice-and-sms-links-are-switched-off.test.ts`. | A real SMS OTP provider (OB-222: nothing bought). | — |
| M20-FR-03 | EXTERNAL | EXTERNAL | `services/orders/src/order-notices.ts`. `tests/integration/the-customer-is-told-where-their-order-is.test.ts` ("needs you → confirmed → delivered → refunded, each queued once through the consent-checked queue…"). `tests/unit/order-notices-are-worked-out-from-the-order.test.ts`. `tests/integration/a-delivery-slot-and-address-are-the-shops-to-judge.test.ts`. | A live payment provider. SMS and WhatsApp providers (OB-222). | — |
| M20-FR-04 | EXTERNAL | EXTERNAL | Ratings: `tests/integration/only-a-buyer-can-rate-a-product.test.ts`. Privacy centre: `tests/integration/data-rights.test.ts`. Account controls: `services/orders/src/storefront-account.ts`, `tests/integration/the-customers-own-account-suggestions-and-help.test.ts` ("addresses kept minimised and removed in a tap; no saved card…"). Payload budget: `tests/performance/customer-app-payload.test.ts`. | A real low-spec Android phone (§19 "low-spec Android proof"). Live provider tokens for saved payment methods. | — (A throttled-network browser test is optional. Low bandwidth is part of D08-FR-06, not the text of this FR.) |
| M21-FR-01 | EXTERNAL | EXTERNAL | `apps/web-erp/src/campaigns-session.ts`. `tests/integration/campaign-consent.test.ts` ("sends only to the consented, and reports who was excluded and why"). `tests/unit/the-campaigns-session.test.ts`. | Real SMS, WhatsApp, email and push providers (OB-222). | — |
| M26-FR-02 | EXTERNAL | EXTERNAL | `tests/integration/facilities-monitoring.test.ts` ("names and holds every batch in a breached room…", "counts the unprotected gap before a generator caught…"). `tests/integration/the-store-computer-carries-readings-losses-and-acknowledgements.test.ts`. A stand-in IoT adapter: `tests/integration/p6-floor-devices-are-signed-switched-on-and-never-edit-a-ledger.test.ts`. | Real IoT sensors from a vendor. | — |
| WF-13 | EXTERNAL | EXTERNAL | `tests/integration/the-online-basket-gets-the-tills-offers.test.ts`. `docs/requirements/workflows/WF-13.md` (all 10 rows COVERED), enforced by `tests/guardrails/every-workflow-scenario-points-at-a-real-test.test.ts`. | A live payment provider. | — |
| QG-09 | EXTERNAL | EXTERNAL | `packages/workforce/src/adoption-gate.ts`. `tests/integration/the-adoption-gate-names-who-is-not-ready.test.ts` ("access match → proposed curriculum → owner approves → … → HOLD with names → GO"). `tests/unit/workforce-enablement.test.ts`. | Staff complete the curriculum. The owner approves each role's list. Floor champions are named. | — |
| QG-10 | EXTERNAL | EXTERNAL | `infra/deploy/release.sh`, `scripts/release-reconcile.mjs`. `tests/guardrails/every-release-is-reconciled-and-leaves-a-qg10-record.test.ts` ("snapshots before anything is rebuilt… rolls back on a difference"). `tests/unit/qg10-the-books-are-reconciled-around-every-release.test.ts`. | A real production environment, and real releases into it. | — |
| MG-10 | EXTERNAL | EXTERNAL | `packages/migration/src/cutover.ts` (`COMPARISON_AREAS`). `tests/integration/migration-delta-books-day-and-rollback-limits.test.ts` ("MG-10 books side and MG-11 limits: … margin not compared holds the signature…"). | The real parallel run, with the old ERP and staff, over the approved period. | — |
| MG-11 | EXTERNAL | EXTERNAL | `packages/migration/src/cutover-checklist.ts`, `rollback-limits.ts`. The same test ("…the limits raise the trigger once"). `tests/guardrails/the-cutover-gate-is-never-ticked.test.ts`. | A cutover rehearsal on the store computer. The owner names the command team. | — |
| D03-FR-02 | EXTERNAL | EXTERNAL | `tests/integration/a-supplier-bill-read-by-e-invoice-or-ocr-reaches-the-match.test.ts` ("e-invoice: a draft, the supplier by GSTIN, every line mapped by a person… matched by a second person"). | A real OCR engine, or an IRP/GSP e-invoice feed (OB-222). | — |
| D04-FR-05 | EXTERNAL | EXTERNAL | `tests/integration/the-queue-till-scans-pays-and-hands-over-through-the-store-computer.test.ts` ("off until switched on; a hand-over the till rings once; a card sale on the handheld; a cold restart…"). `tests/unit/queue-pos-session.test.ts`. `tests/integration/the-till-reports-its-devices-to-the-box.test.ts`. `tests/unit/lane-health-cards.test.ts`. | A real handheld and printer. The owner's approval before the money switch is turned on (ADR-0028 is still Proposed). | — |
| D06-FR-06 | EXTERNAL | EXTERNAL | `tests/integration/price-integrity.test.ts` ("ranks a shelf underpricing the till FIRST as a legal exposure…"). The ESL stand-in: `tests/integration/p6-floor-devices-are-signed-switched-on-and-never-edit-a-ledger.test.ts`. | Real electronic shelf labels (R8 hardware). | — |
| B15 | EXTERNAL | EXTERNAL (software and checklist done) | `packages/restricted-sales/src/advertising.ts`. `tests/integration/b15-tobacco-is-never-promoted-on-any-surface.test.ts`, `tests/unit/b15-…`. **New since 27 Oct:** `docs/runbooks/store-go-live-checklist.md` line 88, "Tobacco warning board (B15)", unticked, at least 60 × 30 cm, owner, before Phase 2. Guarded by `tests/guardrails/the-tobacco-warning-board-is-on-the-go-live-checklist.test.ts`. | The physical board on the wall where tobacco is sold, measured and photographed by the owner. | — |
| M29-FR-03 | EXTERNAL | EXTERNAL | `services/reporting/src/owner-exceptions.ts`, `services/identity/src/till-sign-in-log.ts`. `tests/integration/owner-exception-alerts-raise-themselves.test.ts` ("…each breach reaches every owner once…"). `tests/integration/the-till-sign-in-log-reaches-head-office-once-even-offline.test.ts`. `tests/unit/owner-alerts-session.test.ts`. | A phone push or messaging provider (OB-222). | — |
| M29-FR-04 | EXTERNAL | EXTERNAL | `services/reporting/src/report-schedules.ts`. `tests/integration/scheduled-reports-prepare-themselves.test.ts` ("each due run is prepared once, kept…"). `tests/unit/owner-reporting-engines.test.ts`. A rule-based narrative (OB-296). | A sending provider (OB-47, OB-222). | — Records note: the 27 Oct lane said the live-model narrative waits on OB-382. OB-382's text names only A01, A04, A05 and QG-11. The rule-based narrative is OB-296's written answer, so nothing is missing in software. |
| M32-FR-04 | EXTERNAL | EXTERNAL | `services/finance/src/tally-outbox.ts`, `packages/tally-export/src/gl-journals.ts`. `tests/integration/the-daily-tally-file-carries-every-journal-and-keeps-a-dead-letter.test.ts`. `tests/integration/integration-gateway.test.ts` ("refuses an inline credential, card-data retention, and an uncertified or unauthorised payment provider", "catches an adapter that has gone silent…"). | Payment, GSP/IRP, WhatsApp, maps and hardware providers. The live Tally connector is deferred to R8 (OB-381). | — |
| M35-FR-01 | EXTERNAL | EXTERNAL | `infra/pilot/backup/encrypted-backup.sh` and `.timer` (encrypted and scheduled, with an off-site copy step `SRE_BACKUP_OFFSITE_CMD`). `packages/ops/src/backup.ts`. `tests/integration/backup-verification.test.ts`. `tests/unit/the-store-computer-backs-up-restores-and-drills.test.ts`. `tests/integration/the-backup-job-reports-its-own-outcome.test.ts` (PostgreSQL only; skipped here). | An off-site immutable storage vendor (OB-02). A restore witnessed by the owner. | — |
| WF-16 | EXTERNAL | EXTERNAL | `services/orders/src/storefront-online-returns.ts` (reads "not set" until the owner gives a value). `tests/integration/an-online-return-refunds-only-what-came-back.test.ts` ("window "not set" → set by category → refused by name → … → refund to source"). `tests/integration/the-driver-collects-an-online-return-through-the-box.test.ts`. | The owner enters the return windows and the non-returnable list (OB-213), and the grievance contact (OB-311). A messaging provider for the customer notice. Then the R4 acceptance is run again (OB-227). | — |
| WF-19 | EXTERNAL | EXTERNAL | `services/migration/src/*`. `tests/integration/migration-pipeline.test.ts`, `migration-retirement.test.ts`. `tests/unit/migration-cutover.test.ts`, `migration-cutover-checklist.test.ts`. `tests/guardrails/the-cutover-gate-is-never-ticked.test.ts`, `the-cutover-tools-cannot-be-talked-round.test.ts`. | The legacy data, the parallel run and the owner's GO (QG-07). | — |
| D08-FR-04 | EXTERNAL | EXTERNAL | `tests/integration/a-delivery-slot-and-address-are-the-shops-to-judge.test.ts`. `tests/unit/storefront-checkout.test.ts`. `tests/integration/order-payments-and-refunds.test.ts` ("an UNKNOWN answer leaves the order payment-pending…"). | A live RBI-authorised payment gateway. | — |
| D08-FR-05 | EXTERNAL | EXTERNAL | The driver's last stamped stop with an ETA, and the hand-over code. `tests/integration/the-delivery-proof-is-captured-and-checked.test.ts`. `tests/unit/the-customer-apps-commerce-rules.test.ts`. Returns and refunds: see WF-16. | A maps provider for a live position. | — |
| D14-FR-01 | EXTERNAL | EXTERNAL | Device health: `tests/integration/a-hung-device-adapter-reads-stale-and-the-box-starts-from-its-index.test.ts`, `tests/integration/the-till-reports-its-devices-to-the-box.test.ts`. Device certification: `tests/integration/integration-gateway.test.ts` ("certifies a device, and refuses an uncertified or wrong-firmware one…"). Scales: `tests/integration/head-office-judges-scales-offers-and-card-data-itself.test.ts` ("L2: a certificate on every scale…"). | A certified device matrix tried on real scanners, printers, scales, drawers and displays. | — |
| D14-FR-03 | EXTERNAL | EXTERNAL | As M32-FR-04, plus `packages/notifications/src/transport.ts` (switched off). | Payment, GST and WhatsApp providers (OB-222). The live Tally connector is deferred to R8 (OB-381). | — |
| D14-FR-04 | EXTERNAL | EXTERNAL | `packages/fulfilment/src/delivery-economics.ts` (`SWITCHED_OFF_COURIER`). `tests/unit/fulfilment-delivery-economics.test.ts` ("the courier-partner link (OB-294: built, switched OFF)"). `tests/integration/the-contribution-rule-holds-and-the-fleet-is-settled.test.ts` ("…courier off; a restart"). | A maps provider or a delivery-partner contract. | — |
| D14-FR-05 | EXTERNAL | EXTERNAL | `services/platform/src/device-events.ts`, `packages/integration/src/floor-devices.ts`. `tests/integration/p6-floor-devices-are-signed-switched-on-and-never-edit-a-ledger.test.ts`. **New:** `tests/integration/the-security-reviewer-signs-and-floor-devices-need-owner-and-reviewer.test.ts` ("…cameras on only with both; off by one; restart-safe"). `tests/integration/only-the-named-security-reviewer-sees-and-decides-a-floor-device-review.test.ts`. `tests/unit/a-floor-device-is-switched-on-only-by-the-owner-and-the-named-reviewer.test.ts`. | The named interim reviewer (OB-405) must actually do the §8.2 privacy and security review and record it. The reviewer role must be granted through maker-checker (OB-406). ESL, RFID, CCTV and IoT vendors and hardware. | — |
| C11 | EXTERNAL | EXTERNAL | No card number, CVV or expiry is stored: `tests/guardrails/card-data.test.ts` ("the codebase stores no card number, CVV or expiry"), `tests/guardrails/no-card-number-in-a-digital-receipt.test.ts`, `tests/integration/head-office-judges-scales-offers-and-card-data-itself.test.ts` ("NEW-3: a card number in a tender is banked removed…"). | The card-terminal model. The PCI SAQ (B-IP) and the AoC, done between the owner and the acquiring bank. | — |
| C21 | EXTERNAL | EXTERNAL | `packages/workforce/src/biometric-consent.ts`. `tests/unit/biometric-consent.test.ts` ("a fingerprint mark is refused unless consent is given — no override", "no signed notice → refused by name…"). | The owner enters the grievance contact (OB-311) and signs the notice. An on-device fingerprint reader (to buy). | — |
| R8-7 | EXTERNAL | EXTERNAL | `tests/integration/p6-a-self-checkout-basket-reaches-loss-prevention-and-the-camera-links.test.ts` ("… → linked to a camera event"). `tests/unit/p6-floor-device-rules.test.ts`. The camera switch-on is gated as in D14-FR-05 (OB-407, OB-420). | The named reviewer's privacy review of the CCTV adapter. Cameras and a CCTV vendor. | — |

## DEFERRED rows (6 distinct; QG-11 was in lanes 3 and 4 and is counted once)

| id | 27 Oct | now | software evidence (files and test titles) | outside piece or deferral | what is still missing in software (or —) |
|---|---|---|---|---|---|
| M23-FR-04 | DEFERRED | DEFERRED | The fallback is real. The daily Tally file covers every journal, with a dead letter and requeue: `services/finance/src/tally-outbox.ts`, `tally-export.ts`, `apps/web-erp/web/tally-files.*`. `tests/integration/the-daily-tally-file-carries-every-journal-and-keeps-a-dead-letter.test.ts` ("…dead-letters an unnamed ledger by name, requeues, and hands the accountant an importable file…"). `tests/unit/tally-daily-outbox.test.ts`, `tests/unit/erp-tally-files-session.test.ts`, `tests/integration/period-evidence.test.ts`. | OB-293 plus OB-381 in `docs/registers/decisions.md`: "R8; the daily Tally file stays until then". DECIDED, owner, 26 Oct 2026, in writing. | The live Tally connector, deferred in writing to R8. |
| M24-FR-04 | DEFERRED | DEFERRED | The fallback is real. A versioned JSON API with partner keys, a sandbox and certification: `tests/integration/partner-sandbox.test.ts`, `tests/integration/partner-certification.test.ts`. CSV import and export: `tests/integration/data-export.test.ts`, `data-import.test.ts`. `docs/api/catalogue.md` says EDI is not built. Pinned by `tests/guardrails/edi-is-deferred-in-writing.test.ts`. | OB-312: JSON API plus CSV are enough; EDI waits until a named supplier asks, target R8. DECIDED, owner, 23 Oct 2026, in writing. | EDI, deferred in writing to R8. |
| A01 | DEFERRED | DEFERRED | The rule-based action list: `services/ai/src/control.ts`. `tests/integration/ai-agents-draft-for-people.test.ts`. The live parts are gated (see QG-11). | OB-382: R8, behind its gate with owner approval and a cost cap. DECIDED, owner, 26 Oct 2026, in writing. | Plain-language questions and causal hypotheses (live model), deferred to R8. |
| A04 | DEFERRED | DEFERRED | List-to-basket and in-stock alternatives: `tests/integration/ai-shopping-agent-offers-in-stock-alternatives.test.ts`. | OB-382 (R8). | Guided shopping (live model), deferred to R8. |
| A05 | DEFERRED | DEFERRED | Answers from the shop's records, escalating to a person: `services/orders/src/storefront-account.ts`, `services/ai/src/control.ts`. `tests/integration/the-customers-own-account-suggestions-and-help.test.ts`. | OB-382 (R8). | Free-text answers (live model), deferred to R8. |
| QG-11 | DEFERRED (lane 3 and lane 4) | DEFERRED | The live model really is gated off (`services/ai/src/model-gateway.ts`):<br>• no provider transport is set in production;<br>• free text is off until `PUT /v1/ai/free-text` (permission `ai.agent.enable`, held only by the owner role in `services/api/src/roles.ts`) switches it on;<br>• calls are refused over the budget cap, per-agent ceilings or the kill switch;<br>• calls are refused with no approved model.<br>Tests: `tests/integration/ai-governance-controls.test.ts` ("D3 cap, agent ceilings, scoped kill switch, evaluations, the model register, free text…"), `tests/integration/ai-model-calls-are-governed.test.ts`, `tests/unit/ai-evaluation.test.ts`, `tests/guardrails/the-evaluation-set-gates-the-release.test.ts`. `tests/integration/ai-proposes-people-decide.test.ts` needs PostgreSQL and was skipped. | OB-382 (R8). A live model provider must be chosen, approved and costed. | The live-provider evaluation runs, deferred to R8. |

## Records notes (no software gap)
- **M29-FR-04.** OB-382 does not name the daily AI narrative. Today's rule-based narrative rests on OB-296, which is in writing. If the owner wants a live-model narrative at R8, OB-382 could name it, so it is not forgotten.
- **M20-FR-04.** The traceability row still lists "registering the real domain stores" as a follow-on. In fact `services/customer/src/erasure-execution.ts` now registers the stores and calls `executeErasurePlan`. The row text is out of date.
- **D14-FR-05 and R8-7.** Nothing more needs building. These rows close only when the named reviewer does the review and records it, and only then may a camera be switched on.

## Tests run

These were run at `6d13a778`, whose files equal `origin/main` `edeb0a03`. `DATABASE_URL` was not set. Every skip is a real-PostgreSQL leg (`describe.skipIf(!DATABASE_URL)`), and those legs run in CI. Browser (`*.e2e.ts`) suites and the real-Keycloak proof were not run.

| Command | Files | Tests | Time |
|---|---|---|---|
| `pnpm exec vitest run <89 files listed below>` | 88 passed, 1 skipped | 636 passed, 19 skipped, 0 failed | 95 s |
| `pnpm exec vitest run --config vitest.perf.config.ts tests/performance/catalogue-search-p95.test.ts tests/performance/checkout-api-p95.test.ts tests/performance/customer-app-payload.test.ts` | 3 passed | 6 passed, 0 failed | about 30 s |
| `pnpm exec vitest run tests/unit/customer-display-frame.test.ts tests/unit/voice-and-sms-links-are-switched-off.test.ts tests/integration/the-backup-job-reports-its-own-outcome.test.ts tests/integration/partner-certification.test.ts` | 3 passed, 1 skipped | 11 passed, 5 skipped, 0 failed | 15 s |

**Skips in the main run (19).** They are all PostgreSQL legs:

| File | Skipped |
|---|---|
| `ai-proposes-people-decide` | 12 (the whole file) |
| `a-hung-device-adapter-reads-stale-and-the-box-starts-from-its-index` | 2 |
| `the-queue-till-scans-pays-and-hands-over-through-the-store-computer` | 1 |
| `ai-model-calls-are-governed` | 1 |
| `ai-shopping-agent-offers-in-stock-alternatives` | 1 |
| `owner-exception-alerts-raise-themselves` | 1 |
| `scheduled-reports-prepare-themselves` | 1 |

**Performance.**
- Worst customer search p95 at 50,000 SKUs: 330.3 ms.
- Checkout API p95: 7.4 ms over 300 checkouts.

**The 89 files.**
- **Integration:**
  - `payables-reach-tally-as-an-importable-voucher-file`
  - `a-supplier-bill-read-by-e-invoice-or-ocr-reaches-the-match`
  - `head-office-judges-scales-offers-and-card-data-itself`
  - `production`
  - `m12-fr-01-the-till-times-every-scan-and-the-box-keeps-it`
  - `order-payments-and-refunds`
  - `scanner-findings-and-gate-decisions-are-recorded`
  - `a-recovery-rehearsal-pass-expires-after-a-quarter`
  - `e-invoice-sandbox`
  - `the-customer-is-told-where-their-order-is`
  - `the-customers-own-account-suggestions-and-help`
  - `only-a-buyer-can-rate-a-product`
  - `data-rights`
  - `campaign-consent`
  - `the-store-computer-carries-readings-losses-and-acknowledgements`
  - `facilities-monitoring`
  - `p6-floor-devices-are-signed-switched-on-and-never-edit-a-ledger`
  - `the-online-basket-gets-the-tills-offers`
  - `the-adoption-gate-names-who-is-not-ready`
  - `migration-delta-books-day-and-rollback-limits`
  - `the-queue-till-scans-pays-and-hands-over-through-the-store-computer`
  - `the-till-reports-its-devices-to-the-box`
  - `price-integrity`
  - `b15-tobacco-is-never-promoted-on-any-surface`
  - `owner-exception-alerts-raise-themselves`
  - `the-till-sign-in-log-reaches-head-office-once-even-offline`
  - `scheduled-reports-prepare-themselves`
  - `the-daily-tally-file-carries-every-journal-and-keeps-a-dead-letter`
  - `period-evidence`
  - `integration-gateway`
  - `backup-verification`
  - `an-online-return-refunds-only-what-came-back`
  - `the-driver-collects-an-online-return-through-the-box`
  - `migration-pipeline`
  - `migration-retirement`
  - `a-delivery-slot-and-address-are-the-shops-to-judge`
  - `the-delivery-proof-is-captured-and-checked`
  - `a-hung-device-adapter-reads-stale-and-the-box-starts-from-its-index`
  - `the-contribution-rule-holds-and-the-fleet-is-settled`
  - `the-security-reviewer-signs-and-floor-devices-need-owner-and-reviewer`
  - `only-the-named-security-reviewer-sees-and-decides-a-floor-device-review`
  - `p6-a-self-checkout-basket-reaches-loss-prevention-and-the-camera-links`
  - `partner-sandbox`
  - `data-export`
  - `data-import`
  - `ai-agents-draft-for-people`
  - `ai-shopping-agent-offers-in-stock-alternatives`
  - `ai-model-calls-are-governed`
  - `ai-governance-controls`
  - `ai-proposes-people-decide`
- **Unit:**
  - `tally-export`
  - `the-box-works-from-what-it-holds`
  - `m12-fr-01-the-box-keeps-every-scan-time-and-reads-the-p95`
  - `the-order-refunds-session`
  - `compliance-findings`
  - `migration-reconcile`
  - `ops-recovery-gate`
  - `the-customer-apps-commerce-rules`
  - `order-notices-are-worked-out-from-the-order`
  - `the-campaigns-session`
  - `workforce-enablement`
  - `qg10-the-books-are-reconciled-around-every-release`
  - `queue-pos-session`
  - `b15-tobacco-is-never-promoted-on-any-surface`
  - `owner-alerts-session`
  - `owner-reporting-engines`
  - `tally-daily-outbox`
  - `erp-tally-files-session`
  - `the-store-computer-backs-up-restores-and-drills`
  - `migration-cutover`
  - `migration-cutover-checklist`
  - `storefront-checkout`
  - `lane-health-cards`
  - `fulfilment-delivery-economics`
  - `p6-floor-device-rules`
  - `floor-device-followups`
  - `a-floor-device-is-switched-on-only-by-the-owner-and-the-named-reviewer`
  - `a-floor-device-review-is-decided-only-by-the-named-reviewer`
  - `biometric-consent`
  - `ai-evaluation`
- **Guardrails:**
  - `card-data`
  - `no-card-number-in-a-digital-receipt`
  - `every-workflow-scenario-points-at-a-real-test`
  - `every-release-is-reconciled-and-leaves-a-qg10-record`
  - `the-tobacco-warning-board-is-on-the-go-live-checklist`
  - `the-cutover-gate-is-never-ticked`
  - `the-cutover-tools-cannot-be-talked-round`
  - `edi-is-deferred-in-writing`
  - `the-evaluation-set-gates-the-release`
