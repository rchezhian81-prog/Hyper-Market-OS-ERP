# Worldwide Requirements-Completeness Gap Analysis

_Prepared 9 August 2026, at the owner's instruction: **"have you thoroughly and deeply
researched entirely world wide for requirements? Please don't depend me to make and correct
requirements for this hybrid hyper market project."**_

> **RATIFICATION (10 August 2026):** the owner adopted the recommended **Adopt-now (R2)
> shortlist** — 52 requirements. They are now recorded as approved requirements with testable
> acceptance criteria in `docs/roadmap/roadmap-v2.1-addendum.md`. Items gated on the ten owner
> decisions are held (not dropped); all other items keep the deferred/target-release disposition
> tabled below. CORE-01 has resumed.

## What this document is, and is not

This is a **research proposal for the owner to ratify — it is not an approved requirement set.**
`CLAUDE.md` is explicit: _"Never invent a requirement. If it is not in the roadmap, stop and
ask."_ Every item below is therefore a **candidate**, raised for a decision, never silently added
to the build. On ratification each candidate is either (a) adopted into a roadmap **v2.1 addendum**
with a target release and then given a row in `docs/traceability.md`, or (b) **deferred in writing**
with a named release, or (c) **declined** with a reason. Nothing here changes what is being built
until the owner signs each line.

The controlling document remains `docs/roadmap/roadmap-v2.0.docx`. This analysis was run **against**
that roadmap's 36 modules (`docs/requirements/index.md`), so it reports only **genuine gaps** —
specific legal sub-obligations, depth shortfalls, or absent capabilities — not things the roadmap
already names.

## Method

Five independent research sweeps were run against authoritative worldwide and Indian sources
(current to 2026), each cross-checking every finding against the existing roadmap so a named-but-shallow
module is flagged as **Partial** and a genuinely missing one as **Absent**:

| Sweep | Domain | Primary sources |
| --- | --- | --- |
| A | India — fiscal / tax / statutory accounting | CBIC/GST Council notifications, CGST Act & Rules, Income-tax Act, MCA Companies (Accounts) Rules, GSTN advisories |
| B | India — product / trade / consumer / environmental | Legal Metrology Act & (Packaged Commodities) Rules, FSS Act & regulations, BIS, COTPA, Consumer Protection (E-Commerce) Rules, Plastic/E-Waste/Battery Waste Rules |
| C | India — data protection / payments / labour | DPDP Act 2023 & Rules 2025, RBI CoFT / PA Directions / data-localisation, PCI-DSS v4.0.1, Labour Codes 2019 & Central Rules 2026, TN Shops & Establishments Act, EPF/ESI/POSH |
| D | Industry-standard grocery ERP/POS capability model | NRF ARTS / UnifiedPOS, GS1 (incl. Sunrise 2027), RELEX / Blue Yonder / Logile / Reflexis benchmarks, FSMA 204 traceability |
| E | Competitive & emerging practice (India 2026–2028) | ONDC, RBI/NPCI payment trends, ESL/self-checkout/CV/IoT vendor reports, India quick-commerce & retail-media market data |

**132 candidate items** resulted: **~74 Legally-mandatory · ~34 Industry-standard · ~16
Competitive · ~8 Innovation** (the exact tag is on every row). Each row carries a citation, what the
source mandates, the roadmap's current coverage, and a recommended disposition.

## The honest headline

The worldwide sweep **confirms the roadmap's breadth is genuinely strong** — it already names almost
every area a modern hypermarket platform needs. The gaps are of three kinds, in rising order of
concern:

1. **Legal sub-obligations the roadmap names an area for but does not yet make enforceable** — e.g.
   the roadmap has an MRP field (M03) but no POS rule that makes selling *above* MRP impossible
   (B1); it names "GST" (M23) but not the ~16 mandatory invoice fields, the 2025 GST-2.0 slabs, or
   the offline gap-free invoice-numbering duty (A1, A6, A3).
2. **Depth shortfalls in named modules** — fresh is tracked (dates, temperature) but not *forecast*,
   not *shelf-life-constrained in ordering*, not *markdown-optimised*, not *waste-analysed* (D-1,
   D-3, D-4, D-5).
3. **Genuinely absent obligations/capabilities** — a data-breach notification workflow (C2, up to
   ₹200 crore exposure), a children's-data guard in loyalty (C4), payment-data India-residency
   (C12), store task-execution & digital HACCP (D-8, D-6), and a price-integrity audit (D-7).

**Two areas are missing as whole capabilities, not just depth: store labour/execution management
and a closed price-integrity loop.** Both are recommended for the next release.

## The two percentages the owner asked for

- **Requirements completeness ≈ 78%.** Breadth of *areas* covered by the roadmap is ~90%, but once
  the specific legal sub-obligations and depth gaps found here are counted as "named but not yet
  specified to a testable, compliance-complete standard," the honest figure for **fully-specified**
  requirements is ~78%. This sweep is what raises it toward 100% — by making the missing 22% visible
  and citable instead of latent.
- **Architecture completeness ≈ 55%** (unchanged by this sweep — it measured requirements, not
  build). The domain engines are strong (~8.5/10) but the running, wired, verified system is thin
  (GAP-ARCH-01); ~30% is wired-and-verified, 0% is in production. CORE-01 (paused) is the work that
  raises this.

---

## A. India — Fiscal / Tax / Statutory Accounting

Assumes a single TN store, GST-registered **regular** taxpayer. **Two owner/CA confirmations gate
several rows:** (1) legal entity type (company vs proprietorship/partnership) decides whether the
MCA audit-trail duty (A27) is law; (2) exact aggregate annual turnover (AATO) decides e-invoicing
(₹5 cr, A20), 30-day IRN (₹10 cr, A21) and annual returns (A18).

| # | Proposed requirement | Category | Source | Roadmap coverage | Disposition |
|---|---|---|---|---|---|
| A1 | POS/ERP prints every mandatory Rule 46 field on each tax invoice (GSTIN, "Tax Invoice", HSN, taxable value, rate, CGST/SGST split, place of supply, signature/DSC) | Legally-mandatory | CGST Rules 2017 Rule 46 r/w s.31; ₹25k/invoice penalty s.122 | Partial (M23/M03) | Adopt now (R2) |
| A2 | Invoice numbers consecutive, unique per FY, ≤16 chars, no gaps; series resets each FY | Legally-mandatory | CGST Rules 2017 Rule 46(b) | Partial (M23) | Adopt now (R2) |
| A3 | POS commits fiscal invoice offline first with guaranteed-unique gap-free number with no network, then syncs idempotently | Legally-mandatory | Rule 46(b) + P-01 / hard rule #1 | Partial (M23) | Adopt now (R2) |
| A4 | Product master maps each SKU to valid HSN; prints 6 digits if AATO > ₹5 cr, 4 if ≤ ₹5 cr | Legally-mandatory | Notification 78/2020-CT | Partial (M03) | Adopt now (R2) |
| A5 | GSTR-1 export populates Table 12 from GSTN dropdown (no free text), B2B/B2C split, value validations | Legally-mandatory | GSTN Table-12 Phase-III advisory, May 2025 | Partial (M23) | Adopt now (R2) |
| A6 | Tax engine applies current GST 2.0 slabs (0/5/18%, plus 40% demerit) per HSN; handles time-of-supply rate transitions | Legally-mandatory | GST Council 56th mtg, eff. 22 Sep 2025; s.14 | Partial (M23/M03) | Adopt now (R2) |
| A7 | Handle Compensation Cess + 28%+cess holdover on tobacco/pan-masala until migrated to 40% | Legally-mandatory | GST (Comp to States) Act 2017; 2025 | Partial (M03/M23) | Confirm w/ CA (adopt R2 if tobacco sold) |
| A8 | OTC sales intra-State CGST+SGST; delivered/inter-State derive place of supply | Legally-mandatory | IGST Act 2017 s.10 | Partial (M23) | Adopt now (R2) |
| A9 | POS back-calculates GST out of tax-inclusive MRP so taxable value + tax are correct | Legally-mandatory | s.15 CGST + Rule 46; LM MRP inclusive-of-tax | Partial (M23/M03) | Adopt now (R2) |
| A10 | Tax rounded to nearest rupee (≥50p up, <50p down), per component | Legally-mandatory | CGST Act 2017 s.170 r/w Rule 51 | Partial (M23) | Adopt now (R2) |
| A11 | Discounts reduce taxable value only when s.15(3) met (on invoice, or pre-agreed + linked + ITC reversed) | Legally-mandatory | CGST Act 2017 s.15(3) | Partial (M23) | Adopt now (R2) |
| A12 | BOGO / free samples / loyalty redemptions / vouchers taxed per CBIC rules | Legally-mandatory | CBIC Circ 92/11/2019 & 251/08/2025; s.12(4) | Partial (M23) | Adopt now (R2) — confirm w/ CA |
| A13 | Credit/debit notes reference original invoice, declared ≤30 Nov of following FY | Legally-mandatory | CGST Act 2017 s.34 r/w s.16(4) | Partial (M23) | Adopt now (R2) |
| A14 | RCM: self-invoice for purchases from unregistered suppliers, pay in cash, claim ITC separately | Legally-mandatory | CGST Act 2017 s.9(3)/9(4) | Absent | Adopt later (R3) — confirm heads w/ CA |
| A15 | File/export GSTR-1 (or QRMP quarterly if ≤₹5 cr) + GSTR-3B matching POS sales ledger | Legally-mandatory | CGST Act s.37/s.39; QRMP | Partial (M23) | Adopt later (R3) |
| A16 | GSTR-3B liability auto-locked from GSTR-1, non-editable; reconcile to locked figure | Legally-mandatory | GSTN advisory, 3B hard-lock from Jul 2025 | Partial (M23) | Adopt later (R3) |
| A17 | ITC via GSTR-2B + Invoice Management System (accept/reject/pending), reversal tracking | Legally-mandatory | GSTN IMS (live Oct 2024; changes Oct 2025) | Partial (M23) | Adopt later (R3) |
| A18 | GSTR-9 if AATO > ₹2 cr; self-certified GSTR-9C if > ₹5 cr; due 31 Dec | Legally-mandatory | CGST Act 2017 s.44 | Partial (M23) | Adopt later (R3) |
| A19 | Warn that any GST return unfiled 3 yrs past due is permanently barred | Legally-mandatory | Finance Act 2023; portal enforce Nov 2025 | Absent | Adopt later (R3) — note |
| A20 | If AATO > ₹5 cr: generate e-invoice (IRN) for every B2B invoice/export/CDN, get + print signed QR from IRP; B2C excluded | Legally-mandatory | Notification 10/2023-CT, eff. 1 Aug 2023 | Partial (M32) | Adopt now if >₹5 cr (R2); else later — confirm turnover |
| A21 | If AATO ≥ ₹10 cr: block any B2B invoice/CDN not reported to IRP within 30 days | Legally-mandatory | GSTN advisory, eff. 1 Apr 2025 | Absent | Adopt later (R3) — confirm turnover |
| A22 | Dynamic QR on B2C invoices (only if AATO > ₹500 cr) | Legally-mandatory | Notification 14/2020-CT | Absent | Note only (revisit at SaaS scale) |
| A23 | Generate e-way bill before goods movement: intra-TN > ₹1,00,000; inter-State > ₹50,000 (store transfers, supplier returns) | Legally-mandatory | CGST Rules 2017 Rule 138 | Absent | Adopt later (R3/R4) — confirm TN limit |
| A24 | Deduct/pay income-tax TDS on rent (194-I), contractors (194-C), professional (194-J) | Legally-mandatory | Income-tax Act 1961 ss.194C/194I/194J | Absent | Confirm w/ CA (adopt R3) |
| A25 | TCS on sale of goods u/s 206C(1H) NOT collected (provision withdrawn) | Legally-mandatory | Income-tax Act s.206C(1H) removed 1 Apr 2025 | Absent | Note only (ensure NOT implemented) |
| A26 | If own marketplace later: collect GST TCS 0.5% u/s 52 on third-party supplies, file GSTR-8 | Legally-mandatory | CGST Act 2017 s.52 | Absent | Adopt later (Rn, only if marketplace) |
| A27 | Non-disableable, dated edit-log audit trail of every change to the books — IF entity is a company | Legally-mandatory | Companies (Accounts) Rules 2014 Rule 3(1) proviso; eff. FY 1 Apr 2023 | Covered (M34) — verify non-disableable + books scope | Confirm entity type; build R2 regardless |
| A28 | Books + GST records retained ≥ 8 yrs (GST 72 mo; IT 6 yr; Companies Act 8 yr) with legal-hold override | Legally-mandatory | CGST s.36; IT s.44AA/Rule 6F; Companies Act s.128 | Covered (M34) — verify per-statute clocks | Adopt now (R2) — configure clocks |
| A29 | Audit evidence, dead-letter, migration exceptions, edit-logs never deleted; corrections are compensating entries | Legally-mandatory | Hard rules #2 & #6; MCA Rule 3(1) proviso | Covered (M34 + hard rules) | Adopt now (R2) |
| A30 | Composition scheme explicitly out of scope (regular registration assumed) | Legally-mandatory | CGST Act 2017 s.10 | Absent (n/a) | Note only (record assumption) |

**Top fiscal risks if omitted:** blocked buyer-ITC + ₹25k/invoice penalties (A1–A4, A11–A13); trading
halt or unfixable number-gaps offline (A2–A3); wrong tax collected after GST 2.0 (A6–A7); time-barred
returns + automated mismatch notices (A16–A19); invalid B2B invoices if the e-invoice/e-way threshold
is crossed unhandled (A20–A21, A23); auditor-reportable deficiency + director liability if a company
lacks the non-disableable audit trail (A27).

---

## B. India — Product / Trade / Consumer / Environmental

| # | Proposed requirement | Category | Source | Roadmap coverage | Disposition |
|---|---|---|---|---|---|
| B1 | POS **blocks** any sale above printed MRP for a pre-packaged commodity (impossible, not warned) | Legally-mandatory | LM (PC) Rules 2011 Rule 18(2); LM Act s.36 | Partial (M03/M12) | Adopt now (R2) |
| B2 | Product master rejects/flags a SKU carrying two different MRPs (dual-MRP) | Legally-mandatory | LM (PC) Rules 2011 + Consumer Protection Act 2019 | Absent | Adopt now (R2) |
| B3 | Every label/shelf tag shows the **unit sale price** (₹ per g/kg/ml/l/unit) computed from MRP + net qty | Legally-mandatory | LM (PC) Amendment Rules 2022 Rule 6(11) | Partial (M03) | Adopt now (R2) |
| B4 | Full statutory declaration set per pack: net qty, mfg date, consumer-care name/address/phone, country of origin | Legally-mandatory | LM (PC) Rules 2011 Rule 6; 2017 origin amendment | Partial (M03) | Adopt now (R2) |
| B5 | Loose/variable-weight items billed at weighed net qty × displayed ₹/kg; charged = weighed (no rounding against customer) | Legally-mandatory | LM Act 2009; LM (General) Rules 2011 | Partial (M11/M12) | Adopt now (R2) |
| B6 | POS accepts weight only from a trade-verified, model-approved scale; blocks trading on an expired-stamp scale | Legally-mandatory | LM (General) Rules 2011 (re-verify every 24 mo); Approval of Models Rules 2011 | Partial (M12/M34) | Adopt now (R2) |
| B7 | Register of each weighing instrument (approval no., capacity, 'e' value, stamping date, re-verification-due) with expiry alerts | Legally-mandatory | LM (Approval of Models) Rules 2011; (General) Rules 2011 | Partial (M34) | Adopt now (R2) |
| B8 | POS **hard-blocks** sale of expired/past use-by batch (FEFO at the scan) | Legally-mandatory | FSS Act 2006; FSS (Labelling & Display) Regs 2020 | Partial (M10) | Adopt now (R2) |
| B9 | Deli/bakery/meat counters display allergen info for loose/in-store food + veg/non-veg mark | Legally-mandatory | FSS (Labelling & Display) Regs 2020 | Partial (M03/M11) | Adopt now (R2) |
| B10 | Display FSSAI licence no. + Food Safety Display Board; capture licence + track expiry | Legally-mandatory | FSS (Licensing & Registration) Regs 2011; FSDB directive | Partial (M34) | Adopt now (R2) |
| B11 | Written food-recall plan + per-batch one-up/one-down records (supplier, recipient, batch, dates) on demand | Legally-mandatory | FSS (Food Recall Procedure) Regulations 2017 | Partial (M10) | Adopt now (R2) |
| B12 | Block stocking/selling packaged drinking water (or QCO goods) without valid BIS/ISI mark | Legally-mandatory | BIS Act 2016; FSS Prohibition & Restrictions Regs 2011; IS 14543 | Absent | Adopt now (R2) |
| B13 | If gold sold: every item carries 6-digit HUID hallmark; POS blocks un-hallmarked gold | Legally-mandatory | BIS hallmarking IS 1417:2016; HUID mandatory 1 Apr 2023 | Absent (if gold) | Confirm w/ owner |
| B14 | POS enforces age-18 gate for all tobacco (hard) + blocks loose single-stick sale | Legally-mandatory | COTPA 2003 s.6 & s.7 | Partial (M12) | Adopt now (R2) |
| B15 | Display statutory tobacco warning board (min 60×30 cm); respect POS advertising limits | Legally-mandatory | COTPA 2003 s.5 & s.6 + rules | Absent | Confirm w/ owner |
| B16 | Block tobacco packs lacking the 85% pictorial+text health warning | Legally-mandatory | COTPA 2003 s.7 + Packaging & Labelling Rules | Absent | Adopt later (R3) |
| B17 | Do not enable alcohol/liquor SKUs or POS sale in TN (TASMAC state monopoly) | Legally-mandatory | TN Prohibition Act; TASMAC monopoly | Absent (constraint) | Confirm w/ owner |
| B18 | If OTC household remedies sold: enforce Schedule-K conditions; anything beyond needs a pharmacy licence | Legally-mandatory | Drugs & Cosmetics Act 1940 / Rules 1945 Schedule K | Absent (if OTC) | Confirm w/ owner |
| B19 | Carry bags ≥120-micron (or approved compostable/cloth), billed as separate priced line; block banned single-use plastics | Legally-mandatory | Plastic Waste Management Rules 2016 (120 µm eff. 31 Dec 2022; 19 SUP banned 1 Jul 2022) | Partial (M28) | Adopt now (R2) |
| B20 | If own private-label plastic packaging: register Plastic EPR on CPCB portal + meet targets (unless genuine MSME) | Legally-mandatory | PWM Rules 2016 (EPR); Amendments 2022/2024 | Partial (M28) | Confirm w/ owner |
| B21 | If brand-owner/importer of electronics: E-Waste EPR; as bulk consumer channel e-waste to registered recyclers + take-back | Legally-mandatory | E-Waste (Management) Rules 2022 | Absent | Adopt later (R4) / confirm |
| B22 | Battery take-back; if brand-owner/importer of batteries, meet Battery EPR targets | Legally-mandatory | Battery Waste Management Rules 2022 | Absent | Adopt later (R4) / confirm |
| B23 | Future own online store: display price breakup, expiry, country of origin, seller identity, return terms + named grievance officer (48h ack / 1-mo redress) | Legally-mandatory | Consumer Protection (E-Commerce) Rules 2020 Rule 5 | Absent (future channel) | Adopt later (Rn) |
| B24 | Self-printed labels respect minimum numeral/letter heights on the principal display panel | Legally-mandatory | LM (PC) Rules 2011 Rules 8–9 | Partial (M11) | Adopt now (R2) |
| B25 | "Price displayed = price charged": shelf, scanned and billed price reconciled; mismatch surfaced as exception | Legally-mandatory | LM Act 2009 + Consumer Protection Act 2019 | Absent | Adopt now (R2) |

**Top product/trade risks if omitted:** MRP/overcharge breaches (B1, B2, B25) — LM offence + unfair
trade practice; unverified/expired scales (B5–B7) void the legal basis of every weighed sale;
food-safety (B8, B9, B11) — expired-batch or unlabelled-allergen sale is an FSS offence with health
liability; restricted goods (B14–B18) — loose cigarettes, under-18 tobacco, or any liquor SKU in TN
carry criminal/excise exposure; EPR blind spots (B19–B22) trigger CPCB liability the roadmap's
"recycling evidence" does not discharge.

---

## C. India — Data Protection / Payments / Labour

**In-force vs pending (Aug 2026):** Labour Codes are **live now** (in force 21 Nov 2025, Central
Rules 8 May 2026). Payments rules (CoFT, PCI-DSS v4.0.1, RBI data-localisation) are **in force now**.
DPDP substantive duties are **enforceable 13 May 2027** — a design runway, not an exemption; building
to the 2027 standard now avoids rework.

| # | Proposed requirement | Category | Source | Roadmap coverage | Disposition |
|---|---|---|---|---|---|
| C1 | Standalone itemised plain-language consent notice (each category + purpose) with in-notice links to withdraw / grievance / Board | Legally-mandatory | DPDP Rules 2025 Rule 3 (s.5–6); 13 May 2027 | Partial (M16) | Adopt now (R2) |
| C2 | Breach response: intimate DPB "without delay", full 72-hour report, notify each affected principal in plain language | Legally-mandatory | DPDP Act s.8(6); Rules 2025 Rule 7; penalty up to ₹200 cr | Absent | Adopt now (R2) |
| C3 | Automated retention clock + erasure on purpose-served/consent-withdrawn; auditable deletion job; pre-erasure notice | Legally-mandatory | DPDP Act s.8(7); Rules 2025 Rule 8 + Third Schedule | Partial (M16/M35) | Adopt now (R2) |
| C4 | Children's-data guard: block loyalty/profiling of under-18 without verifiable parental consent; never track/target children | Legally-mandatory | DPDP Act s.9(1) & s.9(3); Rules 2025 Rule 10 | Absent (consent engine not age-gated) | Adopt now (R2) |
| C5 | Data-principal right to nominate + published response/grievance SLA | Legally-mandatory | DPDP Act s.11–14 (s.14 nomination) | Partial (M16) | Adopt later (R3) |
| C6 | Data-processor contract register (every vendor processing PII: cloud, payment, SMS, analytics) | Legally-mandatory | DPDP Act s.8(2) | Absent | Adopt now (R2) |
| C7 | Reasonable security safeguards: PII-at-rest encryption/masking, RBAC, security logs retained ≥1 year, restorable backups | Legally-mandatory | DPDP Rules 2025 Rule 6; s.8(5) | Partial (M02/M34/M35) | Adopt now (R2) |
| C8 | Consent-Manager interoperability readiness | Industry-standard | DPDP Rules 2025 Rule 4 + First Schedule | Absent | Note only |
| C9 | Significant-Data-Fiduciary watch (DPIA + audit + India DPO if designated) | Legally-mandatory (conditional) | DPDP Act s.10; Rules 2025 Rule 12–13 | Absent | Note only |
| C10 | Card-on-File tokenisation done right: RBI-authorised token service, store only token ref + last-4/network, never PAN/CVV/expiry; purge legacy | Legally-mandatory | RBI CoFT eff. 1 Oct 2022 | Partial (hard rule #3) | Adopt now (R2) |
| C11 | Determine PCI scope + complete correct SAQ (standalone PTS IP terminals, no CHD → SAQ B-IP, Level 4); keep Attestation of Compliance | Industry-standard (contractual) | PCI-DSS v4.0.1; SAQ B-IP | Absent | Confirm w/ owner (terminal model) → Adopt now (R2) |
| C12 | Payment-data India-residency: payment data stored only in India; overseas-processed data purged abroad + returned within 1 business day | Legally-mandatory | RBI "Storage of Payment System Data" 6 Apr 2018 | Absent | Adopt now (R2) |
| C13 | Daily payment reconciliation with visible exceptions (POS/UPI/card vs aggregator T+1 settlement; shortfalls/chargebacks/refunds) | Legally-mandatory + Industry-standard | RBI PA Directions 2025; principle P-08 | Partial (P-08 principle) | Adopt now (R2) |
| C14 | Refund/chargeback: refunds via original channel; UPI P2M disputes within NPCI timelines (15-day response) | Industry-standard | RBI PA Directions 2025; NPCI UPI dispute rules 2025 | Partial | Adopt later (R3) |
| C15 | Statutory digital payslip (itemised, on/before pay date, prescribed particulars) | Legally-mandatory | Code on Wages 2019 s.50 (in force 21 Nov 2025) | Absent (M25) | Adopt now (R2) / confirm if payroll outsourced |
| C16 | Working-time + overtime engine: minimum-wage floor, OT at 2× ordinary rate, record actual hours | Legally-mandatory | Code on Wages 2019 (in force 21 Nov 2025) | Partial (M25) | Adopt now (R2) |
| C17 | Appointment letter to every worker, retained as HR evidence | Legally-mandatory | Four Labour Codes (in force 21 Nov 2025) | Absent | Confirm w/ owner (process vs software) |
| C18 | TN Shops & Establishments pack: registration, weekly-holiday, spread-over cap, annual leave accrual, statutory registers | Legally-mandatory | TN Shops and Establishments Act 1947 | Partial (M25) | Adopt now (R2) |
| C19 | EPF (≥20 staff, 12%, ₹15,000 ceiling) + ESI (≥10 staff, ≤₹21,000, 3.25%+0.75%) contribution capture | Legally-mandatory | EPF Act 1952; ESI Act 1948 | Absent/Partial (M25) | Adopt now (R2) / confirm w/ owner |
| C20 | POSH: Internal Committee (>10 staff), confidential complaints register, annual report to District Officer by 31 Jan | Legally-mandatory | POSH Act 2013 s.4, s.21 + Rule 14, s.26 | Absent | Adopt now (R2) / confirm w/ owner |
| C21 | Biometric attendance (if used): specific consent + non-biometric alternative; never mandate Aadhaar | Legally-mandatory | DPDP Act s.7; Aadhaar Act | Absent (M25 method unqualified) | Confirm w/ owner (method) → Adopt now (R2) if biometric |

**Top data/payments/labour risks if omitted:** breach blindness (C2, up to ₹200 cr after May 2027);
under-18 loyalty/marketing breaching DPDP s.9 (C4); PCI scope creep from a card-integrated/softPOS
till or payment data landing outside India (C10–C12); **live** labour violations *today* — missing
payslips, 2× overtime, statutory registers, POSH annual report (C15, C16, C18, C20); indefinite PII
retention and vendor processing without contracts (C3, C6); an accidental biometric-attendance
violation (C21).

---

## D. Industry-Standard Grocery ERP/POS Capabilities (depth / absence gaps only)

| # | Proposed capability | Category | Source | Roadmap coverage | Disposition |
|---|---|---|---|---|---|
| D-1 | Store-SKU-day ML demand forecast (baseline, promo uplift, seasonality, weather, festivals, elasticity, cannibalisation, new-item cold-start) | Industry-standard | RELEX / Blue Yonder demand planning | Partial (M09 min/max only) | Adopt now (R2) |
| D-2 | Forecast-driven order proposals respecting supplier calendar, lead time, MOQ/multiples, case/pallet rounding, open-order pipeline | Industry-standard | Blue Yonder Replenishment | Partial (M09) | Adopt now (R2) |
| D-3 | Constrain perishable ordering to what sells before expiry (shelf-life-bounded order-up-to) | Industry-standard | RELEX fresh replenishment | Partial (M09/M10 unlinked) | Adopt now (R2) |
| D-4 | Recommend automated reduced-to-clear / progressive markdown ladders for near-expiry fresh (human-approved) | Industry-standard | RELEX / Blue Yonder markdown optimisation | Partial (M05 manual) | Adopt now (R2) |
| D-5 | Reason-coded shrink/waste capture + waste analytics / root-cause by SKU/dept/reason | Industry-standard | Retail shrink/LP playbooks | Partial (no taxonomy/analytics) | Adopt now (R2) |
| D-6 | Digital food-safety / HACCP: scheduled temp & equipment checks, corrective-action capture, receiving/cleaning checklists, tamper-evident trail | Industry-standard | Logile; FSMA 204 | Partial (M10 temp only) | Adopt now (R2) |
| D-7 | Automated price-integrity audit: price-of-record vs shelf label vs POS vs app, exception report with ageing | Industry-standard | ESL / pricing-integration guidance | Absent | Adopt now (R2) |
| D-8 | Store task management/execution: SOP checklists, assigned tasks, deadlines, photo evidence, completion accountability | Industry-standard | Reflexis / Logile store execution | Absent | Adopt now (R2) |
| D-9 | Labour-demand forecasting + optimised shift scheduling with T&A + labour-law rules | Industry-standard | Logile / Reflexis WFM | Absent | Adopt later (R3) |
| D-10 | Supplier scorecards: fill rate, OTIF, lead-time reliability, order/invoice accuracy, quality/rejection | Industry-standard | Grocery supply-chain analytics | Absent (M06/M07 transact only) | Adopt later (R4) |
| D-11 | DSD door check-in: mobile scan-verify vs PO/route, discrepancy capture, on-spot returns, driver settlement | Industry-standard | DSD references | Partial (M07 names DSD) | Adopt later (R3) |
| D-12 | VMI / scan-based trading / consignment (vendor-owned stock, sell-through settlement) | Competitive | VMI industry data | Absent | Adopt later (R5) |
| D-13 | Automated planogram compliance: image-recognition shelf audits + score vs approved planogram | Competitive | Pazo / LEAFIO / FORM | Partial (M04 authors) | Adopt later (R4) |
| D-14 | On-shelf-availability / phantom-stock detection (on-hand > 0, no sales) → trigger count/replenish | Industry-standard | OSA best practice | Absent | Adopt later (R3) |
| D-15 | Data-driven store/section clustering + cluster-based assortment | Industry-standard | ToolsGroup / o9 / Board | Partial (M04) | Adopt later (R4) |
| D-16 | Product-lifecycle status (NPI/active/discontinued/clearance) auto-stops ordering + drives clearance | Industry-standard | Assortment/lifecycle norms | Partial (M04/M06) | Adopt later (R3) |
| D-17 | Open-to-buy / merchandise financial planning controls (budget/margin/inventory targets) | Competitive | MFP / OTB benchmark | Absent | Adopt later (R5) |
| D-18 | Competitor price capture feeding pricing rules (price intelligence) | Competitive | Retail price-intelligence practice | Absent | Adopt later (R4) |
| D-19 | Zone/channel pricing governed by cluster + channel (in-store/app/delivery) with approvals | Industry-standard | RELEX / Blue Yonder pricing | Partial (M05) | Adopt later (R3) |
| D-20 | Capture GS1 2D barcodes (DataMatrix / Digital Link) at POS carrying GTIN+batch+expiry → enforce FEFO + auto-markdown | Industry-standard | GS1 Sunrise 2027 | Partial (M03 1D only) | Adopt later (R3) |
| D-21 | LP analytics correlating POS exceptions + inventory shrink + CCTV into one investigable case | Industry-standard | Agilence / Solink EBR | Partial (M15 + D14) | Adopt later (R4) |
| D-22 | Personalised 1:1 offers / next-best-offer + targeted coupons from purchase history | Competitive | Grocery loyalty personalisation | Partial (M21 segment-level) | Adopt later (R4) |
| D-23 | Market-basket / affinity analysis → adjacency, cross-sell, bundle, promo design | Industry-standard | MBA practice | Partial (M29) | Adopt later (R4) |
| D-24 | Demand-sensing external signals (weather, events, festival calendar) into short-horizon forecasts | Competitive | Grocery demand-planning practice | Absent | Adopt later (R4) |
| D-25 | Forecast-driven fresh production/prep planning (bakery/deli/kitchen) with recipe/BOM yields + prep-batch traceability | Industry-standard | Logile fresh-ops | Partial (M11) | Adopt later (R3) |
| D-26 | One-up/one-down lot traceability + rapid recall trace + sortable electronic export within SLA (24 h) | Industry-standard | FDA FSMA 204 / GS1 US | Partial (M10) | Adopt later (R3) |
| D-27 | Scan-and-go: customer self-scan via phone/handheld + basket audit + controlled exit | Innovation | GS1 / grocery scan-and-go | Absent (M12 = staffed self-checkout) | Adopt later (R5) |
| D-28 | Digital / e-receipts linked to customer + loyalty | Industry-standard | Unified-commerce practice | Partial | Adopt later (R3) |
| D-29 | RFID / computer-vision assisted cycle counting | Innovation | Inventory-accuracy practice | Partial (D14 readiness) | Note only |
| D-30 | Shopper-facing price-verify / product-info kiosks (or app shelf-edge scan) | Competitive | POS/kiosk practice | Absent | Note only |

**Biggest capability gaps vs industry:** (1) fresh is managed defensively not intelligently (D-1, 3,
4, 5 — the single largest depth gap, and fresh is where hypermarket margin is won or lost); (2) store
labour + execution + digital HACCP are effectively missing (D-6, 8, 9 — structural, not depth); (3)
no closed price-integrity loop (D-7 — top trust and consumer-law failure); (4) supply-chain
intelligence thin above the transaction layer (D-2, 10, 11, 18, 24); (5) merchandising authored but
not verified (D-13, 14, 15, 17, 23).

---

## E. Competitive Differentiators & Emerging Practice (India 2026–2028)

_A menu, not a to-do list. Nothing here is a broken promise — these are moves competitors and
quick-commerce players make **beyond** the roadmap. Capital-heavy, scale-dependent items are flagged
Decline / Note for the multi-branch phase._

| # | Proposed capability | Category | Source | Roadmap coverage | Disposition |
|---|---|---|---|---|---|
| E1 | WhatsApp commerce — catalogue + conversational reorder + in-chat checkout (not just alerts) | Competitive | JioMart 1,500+ daily WhatsApp orders; 98% open rate | Partial (M21 messages only) | Adopt later (R6) |
| E2 | ONDC participation as seller node | Competitive | ONDC txns 1M→15M+; kirana margin +15–25% | Absent | **Evaluate / owner decision** |
| E3 | UPI-first checkout incl. RuPay-credit-on-UPI (offers, MDR-free < ₹2,000, credit at till) | Competitive | RuPay credit-on-UPI 100M users 2026 | Partial | Adopt later (R5) |
| E4 | BNPL / instalments at checkout | Competitive | BNPL lifts AOV 20–40% | Absent | **Evaluate / owner decision** |
| E5 | Store-branded closed-loop wallet / prepaid top-up with rewards | Competitive | India wallets 500M+ users | Partial (M17 gift cards) | **Evaluate / owner decision** |
| E6 | ESL dynamic-pricing execution (not readiness) — one-click price/promo + perishable markdown at shelf | Competitive | ESL "2026 operational standard"; LM shelf=checkout parity | Partial (D14 readiness) | Adopt later (R6) — pilot |
| E7 | Handheld / mobile POS line-buster (roaming Android billing at peak) | Competitive | Cheapest queue-buster | Absent | Adopt later (R5) — cheap, high impact |
| E8 | Scan-and-go / self-checkout lanes | Competitive | Self-checkout ~40% txns by 2026 | Absent | **Evaluate / owner decision** |
| E9 | In-store price-check kiosks + digital signage | Competitive | Connected 2026 touchpoint | Absent | Evaluate (low cost) |
| E10 | Smart carts (CV + weight) | Innovation | Caper / Shekel | Absent | Decline / out of scope |
| E11 | AI markdown / clearance optimisation for perishables (recommend; human commits per hard rule #5) | Competitive | AI markdown > 10% fresh-waste profit; 20–49% waste cuts | Partial (A02/A05) | Adopt later (R6) |
| E12 | CV loss-prevention / shrink detection at checkout & self-checkout | Competitive | NRF 2026: ~⅓ shrink at self-checkout; CV cuts up to 56% | Partial (D14 + A07) | Evaluate (adopt with self-checkout) |
| E13 | CV shelf monitoring — OSA & planogram-gap detection | Innovation | Trax / ShelfWise | Partial (D14 + A05) | Note / later |
| E14 | Conversational / agentic AI shopping assistant, extended to WhatsApp | Innovation | GenAI conversational commerce 2026 | Covered/Partial (A04 + M20) | Note only (extend agent) |
| E15 | Loyalty gamification — streaks, challenges, badges, leaderboards | Competitive | Indian gamified loyalty +50% participation | Partial (M17) | Adopt later (R6) |
| E16 | Coalition / cross-merchant loyalty | Innovation | 2026 coalition trend | Absent | Note only |
| E17 | IoT refrigeration / cold-chain monitoring execution (continuous temp + alerts) | Competitive | 2026 "cold room w/o IoT = liability"; $5–15k/store/yr | Partial (D14 readiness) | Adopt later (R6) |
| E18 | Store-as-dark-store express delivery (sub-30-min from store) | Competitive | Star Bazaar store-as-hub; q-comm 10–30 min | Partial (M18/M19) | **Evaluate / owner decision** |
| E19 | Food-surplus-to-donation flow (near-expiry routing + tracking) | Innovation | India wastes 78–80M t/yr | Absent | Evaluate (lightweight) |
| E20 | Supplier collaboration / vendor self-service portal (forecasts, POs, GRN) | Innovation | Composable partner ecosystems | Absent (A02 internal) | **Evaluate / owner decision** |
| E21 | RFID item/inventory tagging execution | Innovation | RFID accuracy vs cheap-labour ROI | Partial (D14 readiness) | Note only |
| E22 | Sustainability / carbon & food-waste reporting | Innovation | Food waste 8–10% global GHG | Absent | Note only |
| E23 | Micro-fulfilment / shelf-scanning robots | Innovation | Robotics/MFC | Absent | Decline / out of scope |
| E24 | Customer Data Platform — unified 360 across POS+loyalty+app+web with segmentation & activation | Competitive | 2026 unified first-party data "foundational" | Partial (P-02 + M21) | **Evaluate / owner decision** (foundational for multi-branch) |
| E25 | Retail media network — supplier-funded ad/promo slots | Innovation | India retail media ~₹6,000 cr | Absent | Note only (lightweight promo slot only near-term) |
| E26 | Headless / composable (MACH) architecture posture | Innovation | 61% stacks MACH by 2026 | Covered-ish (baseline = modular services + versioned APIs) | Note only (already aligned) |

**Top competitive moves to consider:** turn WhatsApp from a notification channel into a storefront
(E1); fix the two till pain-points — payments and queues (E3, E7); execute the shelf-edge and
cold-chain "readiness" items already listed (E6, E11, E17); make an explicit adopt/defer call on ONDC
(E2); stand up a CDP mindset early even if lightweight (E24); deliberately defer capital-heavy
scale-dependent items (E10, E16, E21, E23, E25).

---

## Consolidated "Adopt now (R2)" shortlist

If the owner ratifies nothing else, these are the candidates I recommend folding into the **next
release (R2 Store Core)** — every one is either a live legal duty or a high-value, low-cost control:

**Fiscal (make the till and invoice legally correct):** A1–A13, A28, A29 — mandatory invoice fields,
gap-free offline numbering, GST-2.0 slabs, tax-from-MRP, rounding, discount/scheme rules, credit-note
time-bar, retention clocks. _(A20 e-invoice also, if turnover > ₹5 cr.)_

**Product/trade (make illegal sales structurally impossible):** B1–B11, B14, B19, B24, B25 — MRP
ceiling, dual-MRP guard, unit price, statutory declarations, weighed-price billing, verified-scale
gate + register, expired-batch block, loose-food allergens, FSSAI display, recall plan, tobacco
age-gate + no-loose-stick, 120-µm/priced carry bags, label sizing, price-integrity reconciliation.

**Data/payments/labour (2027-ready + live labour law):** C1–C4, C6, C7, C10, C12, C13, C15, C16,
C18, C19, C20 — consent notice, breach workflow, retention/erasure, children's guard, processor
register, safeguards, tokenisation, payment-data residency, payment reconciliation, payslip,
overtime, TN shops-act pack, EPF/ESI, POSH.

**Industry depth (where hypermarket margin lives):** D-1, D-2, D-3, D-4, D-5, D-6, D-7, D-8 —
forecasting, forecast-driven + shelf-life-constrained ordering, markdown optimisation, reason-coded
waste, digital HACCP, price-integrity audit, store task execution.

## Owner decisions needed before ratification

Several candidates cannot be sized until the owner answers these. **Each is a genuine
owner-only decision — I will not assume any of them** (`CLAUDE.md`):

1. **Legal entity type** — company, or proprietorship/partnership? _(gates A27 MCA audit-trail
   duty)_
2. **Aggregate annual turnover band** — under ₹5 cr / ₹5–10 cr / over ₹10 cr? _(gates A20
   e-invoicing, A21 30-day IRN, A18 annual returns)_
3. **Which regulated goods do we actually sell** — gold jewellery? OTC medicines? packaged drinking
   water (own or third-party)? tobacco? _(gates B12–B18, A7)_
4. **Do we run any own private-label** packaged goods, batteries, or electronics? _(gates B20–B22
   EPR registration)_
5. **Card terminal model** — bank-supplied standalone terminals (card data never touches our
   systems), or integrated/softPOS? _(gates C11 PCI scope — decides how big our compliance job is)_
6. **Staff attendance method** — biometric (fingerprint/face) or not? _(gates C21 consent +
   alternative)_
7. **Who runs payroll + PF/ESI** — us in-software, or an external CA? _(decides whether C15, C16,
   C19 are build items or stay a process)_
8. **ONDC** — pursue as a seller node, or defer? _(E2 — strategic reach-vs-commission call)_
9. **Customer wallet / BNPL** — offer, or not? _(E4, E5 — touches money-handling rules)_
10. **Future own online store** — planned, and roughly when? _(gates B23, A26, and the DPDP
    customer-facing surface)_

## Recommended governance path

1. **Owner ratifies this document line-by-line** (adopt-now / defer-with-date / decline-with-reason)
   — ideally as a marked-up copy or a short decision list against the item IDs.
2. Ratified adopt-now items are written into a **roadmap v2.1 addendum** (closing open item OA-1 —
   the owner-designated v2.1 that is not yet in the repo) and given rows in `docs/traceability.md`
   with acceptance criteria, so they become machine-checked requirements like the existing 144.
3. Deferred items are recorded with their named target release (satisfying `CLAUDE.md`: "Never
   silently drop a requirement… ask the owner to defer it in writing with a named target release").
4. **Then CORE-01 resumes** — now building against a scope that has been checked against the world,
   not just against one roadmap.

_Sources for every row are named inline (rule numbers, notification numbers, effective dates, and
named industry benchmarks); the five underlying research briefs are retained and can be attached in
full on request._
