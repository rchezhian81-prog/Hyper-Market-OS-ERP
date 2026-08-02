# Requirement index

The catalogue of everything to be built, drawn from the controlling document
`docs/roadmap/roadmap-v2.0.docx` (Final Master Roadmap & Developer Requirements
v2.0, 39 sections). This is the Setup 2 output. Detail is expanded per requirement
in Stage 2 (`docs/requirements/<module>.md`) and traced in `docs/traceability.md`.

**Priority model (roadmap Appendix A):** `P0` architectural/security foundation ·
`P1` mandatory for controlled store pilot · `P2` post-pilot / omnichannel ·
`P3` enterprise/advanced · `P4` innovation/commercialization.

---

## Modules M01–M36 (roadmap §5)

| ID | Title | Priority | One-line purpose |
| --- | --- | --- | --- |
| M01 | Organization, branch and configuration | P0 | Companies, GST registrations, branches/stores/warehouses/departments; business dates, currencies, number series; feature flags & config versioning; branch lifecycle. |
| M02 | Identity, RBAC and approvals | P0 | Users, MFA/passkeys, sessions; role/branch/value/state authorization; maker-checker approvals; joiner-mover-leaver and emergency access. |
| M03 | Product information and master data | P0/P1 | Hierarchy/brand/attributes; multiple barcodes, UOM, case-pack, variable-weight; HSN/tax/MRP/allergens; lifecycle, duplicate detection, bulk maintenance. |
| M04 | Merchandising, space and planograms | P2 | Assortment/range review; aisle/shelf/capacity mapping; planogram compliance; display-space contracts and sales per sq ft. |
| M05 | Pricing and promotions | P1 | Effective-dated price lists; MRP/cost/margin-floor & below-cost controls; promotions (BOGO, coupons, member pricing); simulation, stacking, vendor funding. |
| M06 | Supplier and procurement | P1 | Supplier onboarding w/ bank-change verification; requisition/RFQ/PO/approvals; contracts/schemes/rebates/scorecards; open-commitment tracking. |
| M07 | Receiving, QC and three-way match | P1 | ASN/DSD receiving; count/batch/expiry/MRP/damage capture; quarantine & discrepancy approval; PO-GRN-invoice match and landed cost. |
| M08 | Inventory ledger and availability | P0/P1 | Immutable movement ledger; stock by status/location/batch; negative-stock controls; ageing/turns/GMROI/stockout reports. |
| M09 | Warehouse and replenishment | P1/P2 | Put-away/pick/pack/dispatch; min-max/safety stock/reorder; warehouse-to-store allocation; cycle & blind counts. |
| M10 | Batch, expiry, quality and recall | P1 | FEFO/expiry alerts/markdown/disposal; quality & cold-chain evidence; supplier-to-customer lot traceability; recall initiation & closure. |
| M11 | Fresh food and internal production | P2 | Recipes/BOM/production; catch/variable weight & yield; packing/scale labels/shelf life; bakery/kitchen/deli/meat config where applicable. |
| M12 | POS sales and checkout | P1 | High-speed scan/weight/price enquiry; suspend/recall/quotations/receipts; cash/card/UPI/split tender w/ offline rules; overrides, age prompts, lane health. |
| M13 | Returns, exchanges and refunds | P1 | Receipt & controlled no-receipt returns; eligibility/condition/disposition; refund method/store credit/approval thresholds; payment-reversal reconciliation. |
| M14 | Till, cash office and day close | P1 | Till assignment/float/pickup/safe drop; shift/blind count/over-short; card/UPI settlement; store/day close, locking & evidence pack. |
| M15 | Loss prevention and fraud | P1/P2 | Void/refund/discount/no-sale/cash-anomaly rules; coupon/loyalty/supplier fraud signals; employee/related-party controls; case management & evidence. |
| M16 | Customer 360 and consent | P1 | Unified guest/registered/household identity; consent purpose/preference/withdrawal history; access/correction/export/erasure; segments/CLV/complaints. |
| M17 | Loyalty, membership and gift value | P2 | Earn/burn/tiers/expiry/liability; coupons/referrals/memberships/subscriptions; gift cards/store credit/fraud limits; family pooling & omnichannel consistency. |
| M18 | Order management and omnichannel | P1/P2 | Unified order lifecycle & serviceability; stock reservation/routing/split/backorder; pickup/scheduled/express/dark-store; cancellation/substitution/channel reconciliation. |
| M19 | Picking, packing and delivery | P2 | Wave/single picking & substitution; packing/temperature/dispatch; driver/partner assignment/route/geofence/proof; COD/failed/RTO/SLA. |
| M20 | Customer mobile app and web commerce | P2 | OTP/catalogue/search/multilingual UX; cart/lists/repeat/recommendations; slots/payments/tracking/receipts/support; ratings/accessibility/privacy centre. |
| M21 | CRM, marketing and service desk | P2 | Consent-safe campaigns (WhatsApp/SMS/email/push); abandoned-cart/win-back/attribution; complaint/warranty/compensation; SLA/escalation/satisfaction. |
| M22 | B2B and institutional sales | P3 | Customer-specific price/credit/terms/contract; quote/SO/proforma/challan/invoice; bulk/recurring/commission; B2B portal & outstanding/collection. |
| M23 | Finance, tax and accounting bridge | P1 | Ledger mapping/journals/AP-AR/cost centres; GST/credit-debit notes/tax audit; cash/bank/gateway/refund reconciliation; Tally connector/period close/balance validation. |
| M24 | Supplier and external partner portals | P3 | RFQ response/catalogue/ASN/invoice submission; PO ack/delivery/claims/statement; access isolation & document expiry; API/EDI readiness. |
| M25 | Workforce, tasks and SOP | P2 | Assignment/roster/attendance; daily tasks/opening-closing/handover/escalation; training/competency/incentives; role-aware SOP & acknowledgement. |
| M26 | Facilities, assets and utilities | P3 | Asset/warranty/AMC/spares; refrigeration/power/UPS/IoT; cleaning/pest/fire/safety schedules; energy/downtime/incident/compliance evidence. |
| M27 | Concession and shop-in-shop | P3 | Concessionaire contracts/deposits/rent/revenue share; separate stock ownership & restricted access; counter settlement/reconciliation; agreement/licence expiry alerts. |
| M28 | Waste, disposal and sustainability | P3 | Wastage/damage/expiry/donation/destruction approvals; scrap/recycling evidence; carry bags/reusable packaging; waste/energy/sustainability reports. |
| M29 | Owner command centre and BI | P1/P2 | Sales/margin/cash/stock/purchase/customer/fulfilment KPIs; branch/category/vendor/staff comparisons & drill-through; freshness/thresholds/alerts/approval inbox; scheduled reports & daily AI narrative. |
| M30 | Import, export and data quality | P0/P1 | Template-driven import (validate-preview-approve-commit); exports for every domain; duplicate/mandatory-field/reference/reconciliation controls; job history/row errors/rollback/DQ score. |
| M31 | Document, notification and communications | P1 | Versioned document storage/templates/retention; receipt/invoice/PO/GRN/statement generation; email/SMS/WhatsApp/push routing & consent; retry/suppression/cost/template approval. |
| M32 | Integration and developer platform | P0/P1 | Versioned APIs/OAuth/webhooks/idempotency; connector SDK/mapping/throttling/retry/DLQ; sandbox/docs/secrets/usage monitoring; Tally/payments/GST/messaging/logistics/hardware adapters. |
| M33 | Platform administration and support | P0 | Tenant settings/jobs/feature flags/config history; device/terminal/version/remote-session controls; time-bound audited support access; status centre/diagnostics/licence/service mgmt. |
| M34 | Audit, risk and compliance evidence | P0/P1 | Immutable who/what/when/where/before/after; search/legal hold/retention; licence/food-safety/metrology/privacy evidence; risk/control/incident/attestation registers. |
| M35 | Backup, disaster recovery and observability | P0 | Encrypted/immutable/off-site backups & restore tests; RPO/RTO/store-cloud recovery/BC runbooks; metrics/logs/traces/sync lag/health; alert ownership/incident/postmortem/capacity. |
| M36 | Commercialization and multi-tenant readiness | P4 | Tenant isolation/plans/entitlements/metering/subscription; white-label without code forks; tenant export/closure/upgrade compatibility; partner & developer ecosystem. |

_Store Core scope (Stage 2 / R2) = M01–M15, M23, M29, M30, M32–M35._
Full FR lines for every module are in the roadmap §5 (`M##-FR-01…04`); Stage 2
expands each into a testable requirement record (Appendix B template).

## Developer extensions D01–D14 (roadmap §16)

| ID | Area | FR lines |
| --- | --- | --- |
| D01 | Product and catalogue | GS1/GTIN/EAN/UPC & internal barcodes · alternate/embedded weight-price barcodes · unit-inner-case-pallet hierarchy & pack breaking · ingredients/allergens/nutrition/origin/storage · regulated-item flags & recall block · customer-app content/images/synonyms/typo tolerance/completeness score |
| D02 | Merchandise planning | open-to-buy & category budgets · seasonal assortment & store clustering · new/discontinued/clearance lifecycle · range gaps & private label · planogram/shelf capacity/sales per sq ft · supplier-funded display space |
| D03 | Supplier and buying | MOQ/order multiples/lead time/purchase budget · invoice OCR/e-invoice ingestion · contracts/rebates/schemes/funding claims · VMI & consignment ownership · landed cost/freight/PPV · supplier statement & bank-change verification |
| D04 | POS and cash | LAN-first scan/weight/total · cash/card/UPI/split tender & pending-payment recovery · suspend/recall/exchange/refund/no-receipt policy · float/pickup/safe drop/blind count/closure · mobile POS/queue busting/customer display/peripheral health · self-checkout/scan-and-go/price-kiosk readiness |
| D05 | Inventory and quality | perpetual event ledger & reconstruction · shelf/back-room/bin & ownership status · online safety stock & reservation buffer · batch/FEFO/expiry/cold chain/quarantine · blind counts/variance root cause/financial impact · supplier-customer returns/recall/destruction evidence |
| D06 | Pricing and promotions | effective-dated zone/channel prices · MRP/cost/margin-floor controls · BOGO/mix-match/multibuy/bundles/coupons/bank offers · best-price/stacking/exclusion/abuse limits · markdown ladder & competitor capture · shelf/POS/app/ESL price-integrity audit |
| D07 | Customer and loyalty | guest/registered/household identity & duplicate merge · consent/preference/rights/grievance centre · points/tiers/expiry/reversal/liability · gift cards/store credit/membership/referral · segments/CLV/campaign frequency/fraud controls · service cases/compensation/satisfaction |
| D08 | Customer app/web | 10-km configurable serviceability · catalogue/filters/voice-barcode search/lists/favourites · cart/repeat order/substitutions/alternatives · slots/minimum order/fees/online payment/pickup · live tracking/receipts/return-refund/complaints · English-Tamil/accessibility/low-bandwidth/secure sessions |
| D09 | OMS and delivery | branch/capacity-aware routing & stock reservation · split/partial order & controlled substitutions · wave picking/weighted final price/quality check · packing/cold-chain/tamper/dispatch manifest · route/geofence/proof/COD/failure/reattempt/RTO · partner/fleet settlement & **contribution stop rules** |
| D10 | Finance and tax | chart/ledger mapping/AP-AR/advances · cash/bank/gateway/refund reconciliation · inventory valuation/cost correction/write-off · loyalty/gift/rebate liabilities · budgets/fixed-asset integration/period close · GST evidence/credit-debit notes/Tally control totals |
| D11 | Store and workforce | opening/closing & department checklists · roster/attendance integration & temporary access · task board/replenishment/price-change/handover · training/competency/floor champions/adoption · food safety/cleaning/pest/fire/maintenance · incident/injury/lost-and-found/emergency procedures |
| D12 | Platform/admin | company/branch/warehouse & feature entitlements · workflow/approval/number/template config · job/integration/device/version management · audited time-bound support access · data retention/archive/export/closure · future tenant/white-label/subscription readiness |
| D13 | Reporting/owner | sales/margin/basket/tender/cashier/hourly · purchase/supplier/stock/expiry/waste/shrinkage · customer/loyalty/marketing/complaints · orders/substitutions/delivery SLA/**contribution** · finance/GST/reconciliation/profitability · data freshness/sync health/security/AI outcomes |
| D14 | Hardware/integration | scanner/receipt-label printer/scale/drawer/display · handheld/payment terminal/price kiosk · Tally/payment/GST ecosystem/direct WhatsApp API · maps/logistics/delivery partners · ESL/RFID/CCTV-event/IoT readiness · versioned APIs/webhooks/sandbox/connector SDK |

## Workflows WF-01 to WF-20 (roadmap §26)

| WF | Workflow | Domains |
| --- | --- | --- |
| WF-01 | Product onboarding | M03, M04, M05, M30 |
| WF-02 | Supplier onboarding | M06, M24, M34 |
| WF-03 | Purchase planning | M06, M09, A02 |
| WF-04 | Receiving | M07, M08, M10 |
| WF-05 | Supplier invoice | M07, M23, M30 |
| WF-06 | Replenishment | M04, M09, M25 |
| WF-07 | Stock transfer | M08, M09 |
| WF-08 | Stock count | M08, M09, M23 |
| WF-09 | Expiry/recall | M10, M15, M28 |
| WF-10 | POS sale | M05, M12, M14 |
| WF-11 | POS return | M13, M14, M23 |
| WF-12 | Day close | M14, M23, M29 |
| WF-13 | Customer order | M16–M20 |
| WF-14 | Fulfilment | M18, M19 |
| WF-15 | Delivery | M19, M23 |
| WF-16 | Online cancellation/return | M18, M20, M21, M23 |
| WF-17 | Customer service | M21, M29 |
| WF-18 | Finance close | M23, M29 |
| WF-19 | Migration/cutover | MG-01–MG-12 |
| WF-20 | Release/incident | M33, M35, AID controls |

Each workflow requires happy-path, alternate, cancellation, permission-denied,
offline, timeout, duplicate, recovery and audit scenarios in Stage 2 design; it is
incomplete until its financial and stock effects reconcile.

## Quality gates QG-01 to QG-12 (roadmap §22)

| ID | Gate | Pass condition |
| --- | --- | --- |
| QG-01 | Requirements | No build without approved ID, rules, actors, errors, permissions and testable acceptance. |
| QG-02 | UX | Frequent action ≤3 interactions where feasible; cashier training/performance targets proven. |
| QG-03 | Code | Review, automated tests, security scans, SBOM and documentation green. |
| QG-04 | Offline | Core sale survives internet/cloud outage; sync retries produce one business effect. |
| QG-05 | Performance | Scan-to-line p95 ≤300 ms on certified pilot hardware; audited targets for other journeys. |
| QG-06 | Security | Zero open critical/high at go-live; independent penetration test before customer launch. |
| QG-07 | Data | Migration, stock, financial, tax and loyalty control totals signed. |
| QG-08 | Recovery | Backup restore, store recovery, rollback and incident escalation rehearsed. |
| QG-09 | Adoption | Role curriculum, competency, floor support and SOP acknowledgements complete. |
| QG-10 | Production | Health, smoke, reconciliation, monitoring and rollback verified after every release. |
| QG-11 | AI | Accuracy/safety evaluations, authority, evidence, human override, budgets and kill switch pass. |
| QG-12 | Owner | Every gate ends GO, HOLD or REWORK with evidence; silence is not approval. |

## AI agents A01–A10 (roadmap §7)

| ID | Agent | Authority |
| --- | --- | --- |
| A01 | Owner Intelligence | **Read-only initially** (KPI questions, daily brief, hypotheses, action list) |
| A02 | Purchase | Forecast/reorder/quotation comparison/draft PO — **buyer approval** |
| A03 | Inventory | Stockout/overstock/expiry prediction & transfer/markdown suggestion — **manager approval** |
| A04 | Customer Shopping | Search/list-to-cart/alternatives — **customer confirms cart** |
| A05 | Service | Policy/order answers, draft case responses — **escalate exceptions** |
| A06 | Operations | Explain sync/integration incidents, recommend runbook — **operator executes** |
| A07 | Security/Fraud | Summarize anomalies, prioritize investigation — **no autonomous sanctions** |
| A08 | Data Quality | Detect duplicates/missing attributes/suspicious mappings — **steward approval** |
| A09 | Marketing | Draft segments/campaigns/offers within consent & margin — **marketing approval** |
| A10 | Workforce/SOP | Role-aware guidance & task assistance — **no HR decisions** |

**AI-NFR-12 (absolute):** no autonomous payment, refund, purchase commitment,
price change, stock adjustment or user-privilege change. The language model never
writes directly to business databases. AI control requirements: AI-NFR-01…12 (§7.1).

## Migration controls MG-01 to MG-12 (roadmap §17)

| ID | Control |
| --- | --- |
| MG-01 | Discovery — inventory every DB/file/report/attachment/version/volume/owner/retention |
| MG-02 | Preservation — verified source backups; immutable raw extracts w/ hashes & chain of custody |
| MG-03 | Mapping — approve field/code/UOM/tax/branch/account/status/identity mappings |
| MG-04 | Cleaning — resolve duplicate products/barcodes/suppliers/customers, invalid tax, negative stock, incomplete batches |
| MG-05 | Trial loads — repeatable full-volume migrations in non-production |
| MG-06 | Reconciliation — prove row counts/quantities/values/balances/taxes/loyalty/document totals by domain |
| MG-07 | History — migrate all usable historical transactions; exclusions need evidence + owner approval |
| MG-08 | Opening state — load & sign off stock by location/batch, open orders, outstanding, loyalty/gift, accounting openings |
| MG-09 | Delta — freeze/capture changes after final extract; load controlled deltas exactly once |
| MG-10 | Parallel run — operate old + new for approved period; reconcile daily |
| MG-11 | Cutover — rehearsed checklist w/ backup, go/no-go, rollback thresholds, named command team |
| MG-12 | Archive/retire — legacy read-only until acceptance/retention met; then revoke & retire securely |

## Offline & synchronization capability matrix (roadmap §31)

| Capability | Offline class | Rule |
| --- | --- | --- |
| Product/barcode/price/tax | Full from signed versioned local cache | Publish version; retain last-known good |
| Core POS cash sale | **Full offline** | Durable local commit before receipt; sync idempotently |
| Card/UPI | Provider/risk dependent | Show pending/declined; **never invent approval**; reconcile |
| Promotion | Rules present in approved local pack | No expired/unpublished rule; deterministic best price |
| Customer lookup | Cached/minimized or online | Guest sale fallback; freshness visible |
| Loyalty/gift/store credit | Limited or online per risk | Offline caps; reserve/reconcile; prevent double spend |
| Return/refund | Receipt/policy/risk dependent | Queue; supervisor rule; payment reversal reconciles |
| Till/shift/close | **Full offline** | Local close evidence; cloud reconciliation later |
| Receiving/count/transfer | Queue-capable mobile/store | Globally unique command; conflict surfaced |
| Purchase/finance/admin | Generally online; draft cache where approved | No unsafe stale approval/period mutation |
| Customer app/order/payment | Online required for promise/authorization | Clear unavailable message; cart may cache |
| Picking/delivery | Assigned-work offline cache | Queue scans/proof; location/PII minimized |
| Owner dashboard | Last synchronized data only | Prominent freshness per branch/domain |
| AI agents | **Online only** | Normal system continues; no blocking dependency |

**Conflict rules (§31.1):** sales/tenders append never merge (collapse by
idempotency identity); master data — cloud-approved version wins prospectively,
in-flight keeps referenced version; inventory — append events, server projects
balance, conflicts become exceptions not silent last-write-wins; dead-letter items
remain visible and cannot be deleted by an operator.

## Quantitative non-functional targets (roadmap §32)

| Quality | Target |
| --- | --- |
| POS scan-to-line | p95 ≤ 300 ms on certified pilot hardware |
| POS total/tender screen | p95 ≤ 500 ms excluding external authorization |
| Core cash-sale availability | ≥ 99.95% during trading, independent of internet |
| Cloud service availability | ≥ 99.9% monthly for production APIs |
| Offline duration | **Minimum 72 hours** core trading |
| Transaction durability | Zero acknowledged transaction loss |
| Duplicate business effect | Zero after retries/replay |
| Sync recovery | Clear 24h peak backlog within 2h target |
| Dashboard freshness | ≤ 5 min normally; exact last-sync always visible |
| Catalogue search | p95 ≤ 1 s at audited scale |
| Customer checkout API | p95 ≤ 2 s excluding payment provider |
| Store-edge RPO/RTO | RPO 0 for committed local sales; RTO ≤ 30 min |
| Cloud DB RPO/RTO | RPO ≤ 15 min; RTO ≤ 4 h |
| Critical vulnerability | None open at release; emergency fix ≤ 72 h |
| Accessibility | WCAG 2.2 AA for customer/web; keyboard/touch staff paths |

_Stage 1 replaces "audited scale/peak" with measured volumes (see `docs/discovery/baseline.md`)._

## Releases R0–R8 (roadmap §15) and execution stages 0–19 (roadmap §21)

| Release | Content | Stages |
| --- | --- | --- |
| R0 Definition | Governance, requirements, process maps, architecture, data model, security, UI system, migration design | 0–4 |
| R1 Technical foundation | Repo, envs, CI/CD, IAM, RBAC, approvals, audit, config, API, observability, store edge & sync proof | 5–6 |
| R2 Store Core | Product→POS→finance/Tally→owner control; one store trades end-to-end | 7–12 |
| R3 Data cutover | Complete migration, reconciliation, opening balances, delta, parallel run, rollback, archive | 11–13 |
| R4 Customer commerce | Android/iOS, web, CRM, loyalty, catalogue, cart, payment, privacy, service | 14 |
| R5 Fulfilment | OMS, reservation, picker/packer, routing, delivery, proof, settlement | 15 |
| R6 Enterprise operations | Fresh, B2B, supplier portal, workforce, facilities, concessions, sustainability, advanced BI | 16 |
| R7 Governed AI | A01–A10 with evaluation, authority, privacy, kill-switch gates | 17 |
| R8 Scale & innovation | Multi-branch, SaaS readiness, self-checkout, ESL, RFID, IoT | 18–20 |

_Milestones (roadmap §36.1): M0 Formal GO (before coding; D3/D4/D5/D8 closure) ·
M1 Spec freeze · M2 Technical proof · M3 Store Core complete · M4 Migration
rehearsal · **M5 Controlled Store Core — target 1 April 2027** · M6 Customer
commerce · M7 Fulfilment/delivery · M8 Enterprise/AI/full scope._

## API, event & integration contracts (roadmap §30)
API-01 Identity/Admin · API-02 Catalogue · API-03 Purchase · API-04 Inventory ·
API-05 POS · API-06 Customer/Loyalty · API-07 OMS · API-08 Fulfilment/Delivery ·
API-09 Finance · API-10 Reporting · API-11 Platform · API-12 Migration ·
API-13 AI Gateway. Core business events catalogued in §30.2. Detailed contract
catalogue built in Stage 4 (`docs/api/`).

## Cross-cutting requirement sets
- **Security baseline** SEC-01…SEC-12 (§9.1) · **Privacy baseline** PRV-01…PRV-10 (§9.2)
- **Non-functional** NFR-01…NFR-15 (§10) · **AI control** AI-NFR-01…AI-NFR-12 (§7.1)
- **AI-assisted development governance** AID-01…AID-10 (§18)
- **Audit validation register** AVR-01…AVR-20 (§13 — see `docs/discovery/avr-closure.md`)
- **Owner decisions** OD-01…OD-10 (§14) and **decision fields** D1…D8 (§25) — see `docs/registers/decisions.md`
