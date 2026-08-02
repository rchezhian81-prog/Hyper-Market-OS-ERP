# Requirement index

The catalogue of everything to be built: modules, extensions, workflows, gates,
agents, controls and targets.

> **Sourcing & status.** This index is populated from **Annexure H** (the build
> pack, which is itself built from the roadmap) and **Annexure G** (the audit).
> Where only the roadmap holds the detail — exact module titles, priorities and
> per-line functional requirements — the cell is marked **⛔ roadmap**. Setup 2
> completes this file verbatim once `docs/roadmap/roadmap-v2.0.docx` is present.
> Module areas below are derived from the scope each Annexure H stage prompt
> describes; confirm titles/priorities against the roadmap. Nothing is invented.

---

## Modules M01–M36

| ID | Area (from Annexure H scope) | Stage | Scope summary (source) | Title / priority |
| --- | --- | --- | --- | --- |
| M01 | Platform / admin foundation | 5 | Store Core scope (Stage 2). Identity, roles, config, audit sit under Stage 5. | ⛔ roadmap |
| M02 | Platform / admin foundation | 5 | Store Core scope. | ⛔ roadmap |
| M03 | Product & master data | 7 | Hierarchy, multiple barcodes, UOM & case-pack conversion, variable-weight barcodes, HSN & tax, MRP, allergens & storage, duplicate detection, bulk maintenance. | ⛔ roadmap |
| M04 | Product/master (cont.) | 7 | Store Core scope. | ⛔ roadmap |
| M05 | Pricing & promotions | 7 | Effective-dated price lists, margin floor & below-cost control, MRP validation, promotion engine (stacking/exclusion), markdown ladder, price-change history. | ⛔ roadmap |
| M06 | Supplier & procurement | 7 | Supplier onboarding w/ bank-change verification, requisition, RFQ, quotation comparison, PO, approvals, schemes, rebates, scorecards. | ⛔ roadmap |
| M07 | Receiving & three-way match | 7 | ASN & direct delivery, count, batch, expiry, MRP, damage/quality capture, quarantine, PO-GRN-invoice match w/ variance, landed cost. | ⛔ roadmap |
| M08 | Inventory ledger | 8 | Immutable movement ledger w/ balance projection; stock by status/location/batch. | ⛔ roadmap |
| M09 | Warehouse ops | 8 | Put-away, picking, transfer; min-max, safety stock, reorder point. | ⛔ roadmap |
| M10 | Counts & adjustments | 8 | Cycle & blind counts, variance root cause & financial impact; negative-stock controls w/ reason codes & approval. | ⛔ roadmap |
| M11 | Quality / fresh & cold chain | 8, 16 | Batch & FEFO allocation, expiry alerting & markdown proposal, cold-chain evidence, lot traceability, recall, wastage/destruction evidence. Fresh food ops conditional. | ⛔ roadmap |
| M12 | POS — sales | 9 | High-speed scan/search, qty & weight, price enquiry, customer display, suspend/recall, quotations, receipts. | ⛔ roadmap |
| M13 | POS — tender | 9 | Cash, card, UPI, store credit, split tender w/ offline rules; pending-payment recovery; supervisor overrides; age/restricted prompts; lane health. | ⛔ roadmap |
| M14 | Returns & exchanges | 9 | Receipt & controlled no-receipt policy, eligibility, condition, disposition, approval thresholds, payment-reversal reconciliation. | ⛔ roadmap |
| M15 | Cash office | 9 | Till float, pickup, safe drop, blind count, over/short, shift & day close w/ evidence; loss-prevention rules. | ⛔ roadmap |
| M16 | Customer identity | 14 | Unified identity across till & app, household & duplicate merge; consent purpose, channel preference, withdrawal history; rights centre & grievance route. | ⛔ roadmap |
| M17 | Loyalty & stored value | 14 | Earn/burn, tiers, expiry, reversal, liability; gift cards & store credit w/ fraud limits. | ⛔ roadmap |
| M18 | Order routing & fulfilment | 15 | Branch & capacity-aware routing w/ stock reservation; split/partial orders; picker app (aisle-sequenced), barcode & weight, substitution, QC & packing. | ⛔ roadmap |
| M19 | Delivery | 15 | Delivery app: route, geofence, proof of delivery, COD & rider cash reconciliation, failed delivery, reattempt, return to origin. | ⛔ roadmap |
| M20 | Customer app & web store | 14 | Android/iOS + responsive web; OTP onboarding, serviceability, catalogue, typo-tolerant Tamil/English search, live price/stock, cart, slots, payment, tracking, receipts, returns. | ⛔ roadmap |
| M21 | CRM & service desk | 14 | Consent-safe campaigns; service desk w/ SLA & compensation approval. | ⛔ roadmap |
| M22 | Enterprise / B2B & portals | 16 | Conditional — build only where operated. | ⛔ roadmap |
| M23 | Finance & accounting | 10 | Ledger mapping, journals, receivable/payable, cost centres; GST config, credit/debit notes, tax audit evidence; reconciliations; inventory valuation & write-off. | ⛔ roadmap |
| M24 | Enterprise module | 16 | Conditional — confirm department. | ⛔ roadmap |
| M25 | Workforce & task management | 16 | Training, competency, floor champion & adoption tracking (D11-FR-04). | ⛔ roadmap |
| M26 | Enterprise module | 16 | Conditional. | ⛔ roadmap |
| M27 | Enterprise module | 16 | Conditional. | ⛔ roadmap |
| M28 | Facilities / enterprise | 16 | Conditional. | ⛔ roadmap |
| M29 | Owner command centre | 10 | Sales, margin, cash, stock, purchase, customer & fulfilment KPIs, comparisons & drill-through, freshness indicator, thresholds, alerts, approval inbox; daily brief; exception alerts. | ⛔ roadmap |
| M30 | Import & export | 7 | Template-driven import w/ validate/preview/approve/commit; row-level errors; rollback; job history. | ⛔ roadmap |
| M31 | ⛔ roadmap | ⛔ | ⛔ roadmap | ⛔ roadmap |
| M32 | Store Core module | 2 | In Store Core scope (M32–M35). | ⛔ roadmap |
| M33 | Store Core module | 2 | In Store Core scope. | ⛔ roadmap |
| M34 | Store Core module | 2 | In Store Core scope. | ⛔ roadmap |
| M35 | Store Core module | 2 | In Store Core scope. | ⛔ roadmap |
| M36 | Multi-branch & innovation | 18 | Multi-branch operation; tenant/entitlement/config readiness; self-checkout, ESL, RFID, IoT as gated per-feature rollouts. | ⛔ roadmap |

_Store Core scope (Stage 2) = M01–M15, M23, M29, M30, M32–M35._

## Developer extensions D01–D14

| ID | Area | Stage | Known FR references | Status |
| --- | --- | --- | --- | --- |
| D01 | Product master aux | 7 | — | ⛔ roadmap |
| D02 | Product/import aux | 7 | — | ⛔ roadmap |
| D03 | Supplier invoice / OCR | 7 | D03-FR-02 invoice OCR | ⛔ roadmap |
| D04 | POS aux | 9 | — | ⛔ roadmap |
| D05 | Inventory/expiry aux | 8 | — | ⛔ roadmap |
| D06 | Pricing/promotions aux | 7 | — | ⛔ roadmap |
| D07 | Customer/loyalty aux | 14 | — | ⛔ roadmap |
| D08 | Mobile app | 14 | Mobile release safety: current+previous version, forced upgrade, remote kill (A-10) | ⛔ roadmap |
| D09 | Delivery contribution | 15 | D09-FR-06 contribution stop rules | ⛔ roadmap |
| D10 | Finance aux | 10 | — | ⛔ roadmap |
| D11 | Training & adoption | 16 | D11-FR-04 training/competency/floor-champion/adoption | ⛔ roadmap |
| D12 | ⛔ roadmap | ⛔ | — | ⛔ roadmap |
| D13 | Delivery contribution reporting | 10, 15 | D13-FR-04 delivery contribution reporting | ⛔ roadmap |
| D14 | ⛔ roadmap | ⛔ | — | ⛔ roadmap |

## Workflows WF-01 to WF-20
Detailed in Stage 1 (`docs/discovery/to-be-processes.md`), one to-be workflow per
WF with the role at each step and where approval is required. Individual titles
are **⛔ roadmap**.

## Quality gates QG-01 to QG-12

| ID | Gate (as referenced) | Source |
| --- | --- | --- |
| QG-01 | Entry conditions / gate entry | A-16 (Definition of Ready mirrors it) |
| QG-02 | Usability gate — actions ≤3 interactions; 30-minute new-cashier target | Stage 3, A-15 |
| QG-04 | Offline & sync test battery | Stage 6 |
| QG-09 | Training & adoption | Annexure G G-16 |
| QG-10 | Verified rollback after every release | A-10 |
| QG-12 | Gate sign-off — silence is not approval | Annexure H weekly rhythm |
| QG-03, QG-05–QG-08, QG-11 | ⛔ roadmap | — |

## Offline capability matrix (roadmap §31)
Per-capability offline class and rule. **⛔ roadmap** — reproduce §31 as a table in
Stage 4 (`docs/architecture/offline-sync.md`). Conflict rules (§31.1) are known:
append never merge; server projects the balance; conflicts become visible
exceptions, never silent last-write-wins; dead-letter items cannot be deleted by
an operator.

## Quantitative targets (roadmap §32)

| Target | Value | Source |
| --- | --- | --- |
| Minimum offline trading | **72 hours** | §32 / Annexure G |
| POS scan → line item (p95) | **< 300 ms** on certified pilot hardware | Stage 9 |
| Total & tender screen (p95) | **< 500 ms** excluding external authorisation | Stage 9 |
| _others_ | ⛔ roadmap §32 | — |

## AI agents A01–A10 (roadmap §17, Stage 17)

| ID | Agent | Authority | Source |
| --- | --- | --- | --- |
| A01 | Owner Intelligence | **Read-only** | Stage 17 |
| A02 | Purchase | Forecast, reorder recommendation, quotation comparison, draft PO; invoice reading (photo/PDF) → draft GRN, uncertain items flagged never guessed. **Buyer approves.** | Stage 17 |
| A03 | Inventory | Stockout/overstock/expiry prediction, transfer & markdown suggestions. **Manager approves.** | Stage 17 |
| A04–A10 | ⛔ roadmap | — | Build in authority order. |

**AI-NFR-12 (absolute, every agent):** no autonomous payment, refund, purchase
commitment, price change, stock adjustment or user-privilege change. No AI in the
billing path.

## Migration controls MG-01 to MG-12 (roadmap §34)

| Group | Controls | Stage | Scope (source) |
| --- | --- | --- | --- |
| Rehearsal | MG-01…MG-09 | 11 | Source discovery, verified source backup, immutable raw extracts w/ hashes & chain of custody, approved mappings, cleaning, repeatable full-volume load, per-domain reconciliation, quarantine. |
| Cutover | MG-10…MG-12 | 13 | Parallel run, daily reconciliation, cutover w/ freeze/delta rules, rollback thresholds, go/no-go. |

Individual MG text is **⛔ roadmap §34**.

## API & event catalogue (roadmap §30)
API-01 to API-13 and the core business events (§30.2) — catalogued in Stage 4
(`docs/api/`). **⛔ roadmap.**
