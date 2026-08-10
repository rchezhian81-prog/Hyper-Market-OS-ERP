# Roadmap v2.1 Addendum — Ratified Requirements

_Ratified by the owner (Mr Elanchezhian) on **10 August 2026**: "Adopt your recommended R2 list and
resume CORE-01." This addendum is the authoritative record of that decision. It extends — never
replaces — `docs/roadmap/roadmap-v2.0.docx`, and closes open item **OA-1** (an owner-designated v2.1
that was not yet in the repository)._

## Provenance

These requirements were surfaced by the worldwide requirements-completeness sweep
(`docs/requirements/WORLDWIDE_REQUIREMENTS_GAP_ANALYSIS.md`, 132 cited candidates) and are adopted
here with the owner's ratification, so they are no longer "invented" — they are approved requirements
with a named target release and testable acceptance criteria, satisfying quality gate QG-01. Each
adopted item **earns its machine-checked row in `docs/traceability.md` when it is built** (an
implementation + test path, per the traceability guardrail); until then it is catalogued here.

## 1. ADOPTED into R2 (Store Core) — 52 requirements

Each row: the requirement, a **testable acceptance criterion**, the existing module it extends, and
the target execution stage. IDs match the gap-analysis (A/B/C/D series).

### 1.1 Fiscal / tax / statutory accounting — extends M23, M03, M34

| ID | Requirement | Acceptance criterion (testable) | Extends | Stage |
|---|---|---|---|---|
| A1 | All mandatory Rule 46 fields on every tax invoice | An invoice render asserts presence of GSTIN, "Tax Invoice", HSN, taxable value, rate, CGST/SGST split, place of supply, invoice no. + date; a missing field fails a contract test | M23/M03 | 10 |
| A2 | Consecutive, gap-free, ≤16-char invoice series per FY | A number allocator yields a strictly increasing gap-free series; a duplicate or gap is rejected by test; series resets on FY boundary | M23 | 10 |
| A3 | Offline-first fiscal numbering (unique, gap-free, no network) | With network calls removed at runtime, the till still allocates a unique number and reconciles idempotently on sync (extends the FND/SYNC offline proofs) | M23/M12 | 10 |
| A4 | HSN digit-count by turnover (6 if > ₹5 cr, else 4) | Given a turnover-band config, the invoice prints the correct HSN digit count; wrong count fails | M03 | 10 |
| A5 | GSTR-1 Table-12 export (dropdown HSN, B2B/B2C split) | Export groups lines by HSN from a closed master (no free text) and splits B2B/B2C; a free-text HSN is rejected | M23 | 10 |
| A6 | GST 2.0 slabs (0/5/18% + 40% demerit) with time-of-supply | Tax engine selects the rate in force on the supply date per HSN; a rate-change boundary test passes | M23/M03 | 10 |
| A7 | Compensation Cess + 28%+cess holdover on tobacco/pan-masala | Cess is computed for cess-liable HSNs; **activates only if tobacco/pan-masala is stocked** (data-gated, no build blocker) | M03/M23 | 10 |
| A8 | Place-of-supply: intra-State OTC vs inter-State delivery | OTC sale → CGST+SGST at store; a delivery terminating out-of-state → IGST; both proven | M23 | 10 |
| A9 | GST extracted from tax-inclusive MRP | Given MRP + rate, taxable value + tax reconcile to the MRP to the paisa | M23/M03 | 10 |
| A10 | Nearest-rupee rounding per tax component | Rounding matches ≥50p-up/<50p-down per component; asserted | M23 | 10 |
| A11 | s.15(3) discount eligibility | A discount reduces taxable value only when on-invoice, or pre-agreed + invoice-linked + ITC-reversal-flagged; otherwise it does not | M23 | 10 |
| A12 | BOGO / free-sample / loyalty / voucher tax treatment | BOGO adds no extra tax; a true free sample flags ITC reversal; voucher timing handled; asserted per CBIC rules | M23 | 10 |
| A13 | Credit/debit note linkage + 30-Nov time-bar | A note references its original invoice; one declared after 30 Nov of the next FY does not reduce output tax | M23 | 10 |
| A27 | Non-disableable dated audit trail of book changes | The audit trail (built on the FND-02 hash chain) cannot be disabled and stamps every book change with a date; a disable attempt fails. **Recommended build-regardless of entity type** | M34 | 10 |
| A28 | Statutory retention clocks (≥8 yr) + legal hold | Retention is configured per statute (GST 72 mo, IT 6 yr, Companies 8 yr = longest) with a legal-hold override that blocks deletion; asserted | M34 | 10 |
| A29 | Append-only evidence; corrections are compensating events | No delete/overwrite path exists for audit/dead-letter/edit-logs (guardrail-asserted); a correction is a new event | M34 | 10 |

### 1.2 Product / trade / consumer — extends M03, M10, M11, M12, M28, M34

| ID | Requirement | Acceptance criterion (testable) | Extends | Stage |
|---|---|---|---|---|
| B1 | Till blocks sale above printed MRP | A line priced above the SKU's MRP is refused; no override path exists (guardrail-asserted, alongside the existing below-cost rule) | M03/M12 | 9 |
| B2 | Dual-MRP guard | A SKU cannot carry two active MRPs for one pack; second MRP is rejected at master-data commit | M03 | 7 |
| B3 | Unit sale price on label/shelf tag | Label render computes and shows ₹ per g/kg/ml/l/unit from MRP + net qty (with the ≤100 cm² / ≤₹35 exemptions); asserted | M03 | 7 |
| B4 | Full statutory pack declarations | Master data requires net qty, mfg date, consumer-care contact, country of origin before a pack is sellable; a gap blocks activation | M03 | 7 |
| B5 | Weighed-price billing (charged = weighed × displayed) | A variable-weight line's amount equals weighed net qty × displayed ₹/kg, never rounded against the customer; asserted | M11/M12 | 9 |
| B6 | Verified-scale gate | Weight is accepted only from a scale whose verification is current; an expired-stamp scale blocks trading on that lane | M12/M34 | 9 |
| B7 | Weighing-instrument register + expiry alerts | Each scale record holds approval no./capacity/stamping/re-verification-due; an alert fires before expiry; asserted | M34 | 9 |
| B8 | Till hard-blocks expired-batch sale (FEFO at scan) | Scanning a past-use-by batch is refused at the line; asserted | M10/M12 | 9 |
| B9 | Loose-food allergen + veg/non-veg mark | Counter labels for in-store/loose food carry the 8 allergen groups + veg/non-veg symbol; a missing declaration blocks the label | M03/M11 | 9 |
| B10 | FSSAI licence capture + display + expiry | Licence no. is stored, surfaced for display, and its expiry alerts; asserted | M34 | 7 |
| B11 | Written recall plan + one-up/one-down batch export | Per batch, the system exports supplier→recipient records with batch/dates within the recall workflow; asserted | M10 | 9 |
| B14 | Tobacco age-18 hard gate + no loose single-stick | A tobacco line demands age-18 confirmation and refuses a below-pack quantity; asserted | M12 | 9 |
| B19 | 120-µm priced carry bags + banned-SUP block | A carry bag below 120 µm or a banned single-use-plastic SKU cannot be sold; a bag is a separate priced line; asserted | M28/M12 | 9 |
| B24 | Statutory label character-height rules | Self-printed label templates enforce minimum numeral/letter heights on the principal panel; a too-small render fails validation | M11 | 9 |
| B25 | Price-integrity reconciliation (shelf = scanned = billed) | The three prices for an item are reconciled; a mismatch surfaces as an exception, never a silent overcharge (see also D-7) | M12/M05 | 9 |

### 1.3 Data protection / payments / labour — extends M16, M25, M34, M35, M02

| ID | Requirement | Acceptance criterion (testable) | Extends | Stage |
|---|---|---|---|---|
| C1 | Itemised plain-language consent notice + withdraw/grievance/Board links | A consent notice lists each category + purpose and carries in-notice withdraw/grievance/Board links; withdrawal is as easy as giving; asserted | M16 | 8 |
| C2 | Breach-notification workflow (Board 72 h + affected persons) | A breach event triggers a two-stage Board notification (immediate + 72-hour) and per-principal notices with prescribed content; asserted | M16/M34 | 8 |
| C3 | Automated retention clock + erasure | Personal data is erased when purpose is served/consent withdrawn, via an auditable job with pre-erasure notice; asserted (honours the existing planErasure minimisation) | M16/M35 | 8 |
| C4 | Children's-data guard in loyalty/marketing | Loyalty enrolment/profiling of an under-18 without verifiable parental consent is blocked; no behavioural targeting of children; asserted | M16 | 8 |
| C6 | Data-processor contract register | Every vendor processing PII has a register entry with a contract reference; processing without one is flagged | M16/M32 | 8 |
| C7 | Security safeguards (PII-at-rest encryption/masking, security logs ≥1 yr) | PII columns are encrypted/masked; security logs retain ≥1 year; asserted alongside existing RBAC | M02/M34/M35 | 8 |
| C10 | Correct card tokenisation (token ref + last-4 only) | The tender surface stores only a network-token reference + last-4/network, never PAN/CVV/expiry (extends the card-data guardrail); a legacy-card-purge check passes | M12 | 9 |
| C12 | Payment-data India-residency | Payment data is pinned to an India region; a config putting it elsewhere fails a check | M32/M35 | 8 |
| C13 | Daily payment reconciliation with visible exceptions | POS/UPI/card captures are matched to aggregator T+1 settlement; shortfalls/chargebacks/refunds surface as exceptions (honours P-08) | M23/M14 | 10 |
| C15 | Statutory digital payslip | An itemised payslip with prescribed particulars is generated on/before pay date; asserted | M25 | 16 |
| C16 | Working-time + overtime engine | Minimum-wage floor enforced; overtime computed at ≥2× ordinary rate; actual hours recorded; asserted | M25 | 16 |
| C18 | TN Shops & Establishments compliance pack | Weekly-holiday, spread-over/hours caps, leave accrual and statutory registers are enforced/produced; asserted | M25 | 16 |
| C19 | EPF/ESI contribution capture | Contributions computed against headcount/wage thresholds (EPF 12%/₹15k ceiling; ESI 3.25%+0.75%/₹21k); asserted | M25 | 16 |
| C20 | POSH register + annual report | An Internal-Committee complaints register plus an annual-report generator (by 31 Jan) exist; asserted | M25/M34 | 16 |

### 1.4 Industry-standard grocery capability depth — extends M09, M10, M05, M11, M15

| ID | Requirement | Acceptance criterion (testable) | Extends | Stage |
|---|---|---|---|---|
| D-1 | Demand forecast per SKU-store-day | A forecast decomposes baseline + promo + seasonality + festival/weather signals + new-item cold-start; back-test error is bounded on a fixture | M09 | 8 |
| D-2 | Forecast-driven order proposals (constraint-aware) | Order quantities respect supplier calendar, lead time, MOQ/multiples, case/pallet rounding, open orders; asserted | M09/M06 | 8 |
| D-3 | Shelf-life-constrained perishable ordering | Perishable order-up-to is bounded by days-of-supply vs remaining shelf life; an over-order is prevented | M09/M10 | 8 |
| D-4 | Expiry-driven markdown ladders (human-approved) | The engine proposes progressive markdowns from remaining shelf life + sell-through; a human commits (hard rule #5); asserted | M05/M10 | 9 |
| D-5 | Reason-coded shrink/waste + analytics | Waste is captured against a closed reason taxonomy; analytics aggregate by SKU/dept/reason; a bare (reasonless) waste event is rejected | M10/M11 | 8 |
| D-6 | Digital food-safety / HACCP checklists | Scheduled temperature/equipment checks and cleaning/receiving checklists with corrective-action capture and a tamper-evident trail; a missed check surfaces | M10/M25 | 9 |
| D-7 | Automated price-integrity audit | Price-of-record vs shelf vs POS vs app are reconciled into an ageing exception report; asserted (pairs with B25) | M05/M12 | 9 |
| D-8 | Store task management / execution | SOP checklists + assigned tasks with deadlines, evidence capture and completion accountability; asserted | M25 | 8 |

## 2. Still gated on the ten owner decisions (NOT adopted — held, not dropped)

The owner adopted the recommended R2 list without yet answering the ten decisions in the gap analysis.
These items **remain pending those answers** and are not being built until then:

- **A20** e-invoicing (IRN/QR) — adopt now **only if turnover > ₹5 cr** (decision 2).
- **A21** 30-day IRN — adopt if turnover ≥ ₹10 cr (decision 2).
- **A7** activation, **A27** legal-vs-best-practice framing — depend on tobacco stocked (decision 3) and entity type (decision 1); the *mechanisms* are adopted above, only their legal trigger is pending.
- **C11** PCI scope/SAQ — needs the card-terminal model (decision 5).
- **C21** biometric-attendance consent + alternative — needs the attendance method (decision 6).
- **C15/C16/C19** may become process-only rather than software — needs the payroll-owner answer (decision 7).
- **B13, B15, B17, B18, B20** — depend on whether we sell gold / tobacco display / liquor / OTC medicines / own private-label (decisions 3, 4).

## 3. Deferred with a named release (not dropped)

All remaining gap-analysis items keep the disposition recorded in
`docs/requirements/WORLDWIDE_REQUIREMENTS_GAP_ANALYSIS.md`. In summary: A14–A19, A23, A24 →
R3 Finance; A22, A25, A26, A30 → note-only; B16 → R3; B21, B22 → R4; B23 → future online channel;
C5, C14 → R3; D-9, D-11, D-14, D-16, D-19, D-20, D-25, D-26 → R3; D-10, D-13, D-15, D-18, D-21,
D-22, D-23, D-24 → R4; D-12, D-17, D-27 → R5; D-29, D-30 → note-only; and the E-series competitive
items to R5/R6 or owner-decision as tabled.

## 4. What happens next

CORE-01 resumes immediately (the proven-engine ↔ running-service wiring, GAP-ARCH-01 / RTM-01). The
adopted R2 requirements above are folded into the R2 stage plan and each earns its `docs/traceability.md`
row (implementation + test) as it is built, at which point its acceptance criterion becomes a passing
automated test — the Definition of Done.
