# Every piece of data this system needs, and where it comes from

**Purpose.** The owner asked what data we need from the store and from the migration. This is the
complete answer, researched rather than guessed, so that nothing is discovered late.

**How to read it.** Four parts, and they are in the order the work happens:

| Part | What it is | Who provides it |
| --- | --- | --- |
| **A** | Facts about the shop | The owner and the store, once |
| **B** | Data out of the old system | Us, by extraction |
| **C** | Evidence from outside the old system | The bank, the CA, suppliers, the shelves |
| **D** | What the law requires us to hold | Research below, then confirmed by the CA |

Every row says **what breaks without it**, because that is the only honest way to prioritise. Rows
marked **BLOCKING** stop the system doing something a shop must do. Rows marked *deferrable* can
carry a stated default until the pilot.

> **Live data comes later, deliberately.** The owner's instruction stands: we build against the
> researched standard now and confirm against the shop's real figures after the first live test.
> What this document exists to prevent is *finding out at the pilot* that a field nobody thought
> about is the one the law requires.

---

# Part A — Facts about the shop

Collected once, on `docs/discovery/store-facts-questionnaire.md`. Fifteen minutes of the owner's
time; most of it he knows without looking anything up.

## A1. The business itself — BLOCKING

| What | Format | Why it is blocking |
| --- | --- | --- |
| Registered legal name | Text | Goes on every invoice and every filed return |
| **GSTIN** | 15 characters | Without it no tax invoice is legal. It also encodes the state code, which decides CGST+SGST vs IGST on every single line |
| PAN | 10 characters | Filings, TDS |
| **FSSAI licence number** | 14 digits | Must be displayed and printed. A food business trading without it displayed is an offence |
| Registered address, and the store address if different | Text | Place of supply; the invoice |
| Shops & Establishments registration (Tamil Nadu) | Number | Employment records, working hours |
| CIN, if a company | 21 characters | Statutory |
| **Aggregate annual turnover, last financial year** | ₹ | Decides *two* things: whether e-invoicing applies (₹5 crore) and whether HSN codes must be 4 or 6 digits |

**Why turnover matters more than it looks.** E-invoicing is mandatory above ₹5 crore aggregate
annual turnover in **any** year since 2017–18 — and once crossed, it applies forever, even if
turnover later falls. So the question is not "what is turnover now" but "has it ever been above
₹5 crore since 2017". If yes, every B2B invoice must be registered with the government portal
before it is issued, and that is a build item, not a setting.

## A2. How the shop trades — BLOCKING

| What | Format | Why |
| --- | --- | --- |
| **Trading day cut-off** | HH:MM | A shop trading past midnight books those sales to the day still open. Every report and every cash-up depends on this one number |
| Opening and closing hours, per day of week | Times | Shift planning, delivery slots |
| Number of tills / lanes | Count | Licences, hardware, the sync design |
| Departments operated | List | The owner has already said **cafe** (OB-04). Anything with in-store production needs recipe and yield handling |
| Number of staff, and roles | Counts | Who gets which role; the FoSTaC ratio below |
| Base currency | INR | Fixed |
| Languages on screens and receipts | en, ta | Already the default |

## A3. Money — BLOCKING

| What | Format | Why |
| --- | --- | --- |
| Bank account(s) used for takings | Account, IFSC | The sales-vs-bank check has nothing to work against otherwise |
| **Card machine commission rate** | % from the agreement | Named as blocking in the migration runbook already: without the real figure the banking check refuses to run, deliberately, because a commission *derived from the difference* makes every shortfall commission by definition |
| Card settlement cycle | T+1 / T+2 | Decides which day's takings land on which bank date |
| UPI provider and settlement cycle | Text | Same |
| Payment provider(s) | Names | Card data is **never** stored — provider tokens only (RBI rule, and hard rule #3) |
| Opening cash float per till | ₹ | Cash-up arithmetic |
| Cash variance tolerance | ₹ | Above it, a reason is required |

## A4. Tax policy — BLOCKING, and the CA must confirm it

| What | Why |
| --- | --- |
| GST rate per product category | Every line on every bill |
| **HSN code per product** | 4 digits if turnover ≤ ₹5 crore, **6 digits above**. Mandatory on B2B invoices |
| Composition scheme? | Changes the whole invoice format |
| Reverse-charge suppliers | Unregistered suppliers change who pays |
| TCS / TDS applicability | Filings |

## A5. The physical shop

| What | Why |
| --- | --- |
| Locations/zones (shop floor, cold room, back store, cafe) | Stock is held *somewhere*; a balance with no location is not actionable |
| Weighing scales: make, model, **legal metrology stamping date** | Verification is **annual** for counter machines. An unverified scale is a ₹2,000–₹10,000 fine per offence, rising to imprisonment |
| Cold-chain equipment and temperature limits | Food safety records |
| Delivery radius, and minimum order value | Serviceability |
| Delivery vehicles and drivers | Route planning, cash-per-driver settlement |

---

# Part B — Data out of the old system

Extracted by us (OB-06). The runbook is `docs/runbooks/extraction-work-plan.md`; this is the field
list. **Every export must pass `scripts/extract-check.mts` before anything reads it.**

## B1. Products — BLOCKING

The single most important export. A missing product is a customer whose item will not scan.

| Field | Required | Note |
| --- | --- | --- |
| Item code | **Yes** | The identity everything else joins on |
| Description | **Yes** | Printed on the bill |
| **Barcode(s)** | **Yes** | Multiple per item is normal. See B1a |
| Category / department | **Yes** | Reporting, tax class |
| Unit of measure | **Yes** | each / kg / litre — decides whether it is weighed |
| **MRP** | **Yes** | The lane may never charge above it |
| Selling price | **Yes** | |
| Cost price | **Yes** | Margin, stock valuation |
| **Tax rate** | **Yes** | |
| **HSN code** | **Yes** | *Probably missing from the old system.* See the gap note below |
| Brand, manufacturer | Preferred | |
| Pack size / net quantity | Preferred | Legal Metrology declaration |
| Supplier code | Preferred | Reordering |
| Reorder level, reorder quantity | Preferred | Replenishment |
| Shelf life / expiry tracked? | **Yes for food** | Drives FEFO and the expiry alerts |
| Age-restricted? | **Yes if any** | Owner has set 18 (OB-03) |
| Active / discontinued | **Yes** | A discontinued item that arrives active gets sold |

> **The HSN gap, and it is likely.** Small ERP systems in India often hold a tax *rate* and no HSN
> code. If SRE's does, we cannot simply invent one: HSN decides the rate, the input credit and the
> return. The plan is a mapping table built from the government's published list, reviewed
> **category by category with the CA**, and every product without a confirmed HSN is an exception
> the owner signs — not a default.

### B1a. Barcodes, including the ones that are not really barcodes

Three kinds, and a hypermarket has all three:

1. **Standard GTIN/EAN-13** — the manufacturer's barcode. One product, many barcodes is normal
   (different pack sizes, old and new stock).
2. **In-store variable-measure barcodes** — printed by the deli/cafe scale, carrying the *weight or
   price inside the barcode itself*. These begin with a reserved prefix (commonly `02` for in-store
   use; `20`–`29` are the GS1 range reserved for this). The till must know to read the embedded
   value rather than treat it as a product number. **This is a build item and it is not optional
   for a shop with a cafe.**
3. **PLU codes** — loose produce, typed rather than scanned.

## B2. Suppliers — BLOCKING

Name, code, **GSTIN**, address, contact, payment terms, bank details, opening balance.

> **Bank details need special care.** A supplier bank change is the highest-value fraud target in
> retail, and the system already refuses one that was not verified out of band. Migrated bank
> details arrive *unverified by definition*, so they are loaded and then **confirmed by a phone
> call to a number we already held**, one supplier at a time, before the first payment run.

## B3. Customers and loyalty — BLOCKING if loyalty is carried

Customer code, name, phone, address, **loyalty points balance**, tier, **consent state**, join date.

> **Consent almost certainly does not exist in the old system**, and under the DPDP Act 2023 —
> whose rules were notified in November 2025, with core obligations due by **13 May 2027** —
> processing personal data for marketing needs consent that is free, specific, informed and
> unambiguous. Migrated customers therefore arrive with **no marketing consent**, and the system
> already fails closed that way. Re-consent is a campaign, not a data field.

## B4. Stock — BLOCKING

Item code, location, **quantity on hand**, cost, batch/lot, **expiry date**, last counted date.

> Stock is the figure most likely to be wrong, and it is the only one with an outside witness that
> costs nothing: **the shelves**. That is why the migration refuses to accept a stock figure checked
> only against the old system's own valuation report.

## B5. Open transactions — BLOCKING

Open purchase orders, goods received not invoiced, unpaid supplier invoices (with ageing), unpaid
customer invoices, open customer orders, supplier credit notes, customer deposits.

## B6. Financial opening balances — BLOCKING

Trial balance as at cutover, chart of accounts, bank balances, cash in hand, **and the CA's
journals-only list** (depreciation, provisions, accruals, drawings) — which exists nowhere in the
old system and is the single most valuable document in the whole exercise.

## B7. History — *deferrable, and worth deciding deliberately*

Sales history, purchase history, stock movements, price history.

**Recommendation: carry 24 months of sales history if it can be extracted, and no more.** Reasons:
demand forecasting and reorder levels need at least one full seasonal cycle including the festival
peak; anything older is not how the shop trades now. If history cannot be extracted, the system
works from day one and its forecasts improve over the first year — that is a real cost, and it is
survivable. It is **not** a reason to delay the cutover.

---

# Part C — Evidence from outside the old system

Already specified in `docs/runbooks/legacy-self-extraction.md`, restated here because it is data and
the owner asked for the full list. **None of it comes from the vendor. All of it is the owner's to
gather.**

| Evidence | From | Proves |
| --- | --- | --- |
| Bank statements, running **past** the period end | The bank | The sales figure. The last week's card money lands after the period closes |
| Filed GST returns, with **acknowledgement numbers** | GST portal | The tax figure. Without the ARN the software will not use the file |
| Supplier statements of account | **Every** supplier | What we owe. A supplier who does not reply is recorded by name as unproved |
| Signed accounts + journals-only list | The CA | Opening books |
| Card machine agreement | The file | The real commission percentage |
| A physical stock count | Your own shelves | Stock. Value-weighted: high-value lines in full, a thin sample elsewhere |

---

# Part D — What the law requires, researched

Confirmed against public sources in August 2026. **The CA confirms all of it before go-live** — this
is research, not advice.

## D1. GST

| Rule | Requirement | Impact on us |
| --- | --- | --- |
| **E-invoicing** | Mandatory above **₹5 crore** aggregate annual turnover in any year since FY 2017–18. Once crossed, permanent | If SRE is above it, **every B2B invoice must be registered with the IRP and carry an IRN + signed QR before issue**. This is a build item — see the gap analysis |
| **HSN digits** | **6 digits** above ₹5 crore turnover; **4 digits** at or below, on B2B invoices | Product master field, and a mapping exercise with the CA |
| **E-way bill** | Tamil Nadu intra-state threshold **₹1,00,000**; inter-state **₹50,000** | Needed for wholesale/B2B deliveries and stock transfers, not for a customer walking out with a trolley |
| Invoice contents | Supplier GSTIN, buyer GSTIN for B2B, invoice number and date, HSN, taxable value, rate and amount per tax head, place of supply | The receipt and invoice templates |
| Returns | GSTR-1 and GSTR-3B monthly | Export from finance, and the migration check compares the two against each other |

## D2. Food safety — FSSAI

- **Licence number displayed** at the premises and printed on documents.
- **One FoSTaC-certified Food Safety Supervisor per 25 food handlers**, present during operating
  hours. That is a *staffing* requirement with a *data* consequence: we must hold each food
  handler's training certificate and its expiry, and warn before it lapses.
- Schedule 4 hygiene records: temperature logs, cleaning, pest control, water testing, medical
  fitness of food handlers.

## D3. Legal Metrology

- Packaged goods must declare: manufacturer/packer/importer name and address, generic name, **net
  quantity**, **MRP inclusive of all taxes**, date of manufacture, country of origin, and
  **unit sale price** rounded to two decimals.
- The 2026 amendments tightened e-commerce disclosure specifically — **country of origin and the
  full declaration set must appear on the online listing**, which lands directly on our customer
  app and storefront.
- **Weighing instruments must be verified and stamped annually** (counter machines re-verified on a
  24-month cycle for weights and measures). We hold the stamping date and warn before expiry.

## D4. Data protection — DPDP Act 2023

- Rules notified **13 November 2025**; core compliance deadline **13 May 2027**.
- Consent must be free, specific, informed, unconditional, unambiguous, and **itemised** — one
  consent per purpose, not a blanket tick.
- Withdrawal must be **as easy as giving**.
- Breach notification obligations.
- **Verifiable parental consent** before processing a child's data — relevant if loyalty accepts
  under-18s, which is a policy decision for the owner.

## D5. Payments — RBI

- **Merchants may not store card numbers, expiry dates or CVV.** Card-on-file tokenisation only.
  Card data may be held for at most four days or until settlement, whichever is sooner.
- This is already hard rule #3 and is enforced in code by a guard that refuses to *send* anything
  card-shaped, not merely to store it.

## D6. Employment — Tamil Nadu

Shops & Establishments registration, working hours and overtime records, professional tax, ESI and
PF where applicable, minimum wages, leave records.

---

# What we do about the fields that will be missing

Researching the requirement is half the work; the other half is deciding, **now**, what happens when
the old system does not have it. In every case the answer is the same shape and it is the shape this
whole product is built on: **say we do not know, rather than substitute a number.**

| Missing | What we do | What we do NOT do |
| --- | --- | --- |
| HSN code | Map by category with the CA; each unmapped product is a named exception the owner signs | Guess from the description |
| Cost price | Load as **unknown**; margin reports say so | Default to zero (a 100% margin) or to selling price (a zero margin) |
| Expiry dates on existing stock | Load as **unknown** and exclude those lines from FEFO until counted | Assume a shelf life |
| Customer consent | **No consent**, for every migrated customer | Assume consent because they were on the old list |
| Supplier bank details | Load, then **verify by call-back before the first payment** | Pay against them |
| Loyalty points | Load, and prove against a sample of customers drawn **before** anybody is told | Take the old system's word |
| Opening stock | Load, and prove against a counted shelf | Take the valuation report |

---

## Related

- `docs/discovery/store-facts-questionnaire.md` — Part A as a form
- `docs/runbooks/extraction-work-plan.md` — how Part B is gathered
- `docs/runbooks/legacy-self-extraction.md` — why Part C is the only honest proof
- `docs/runbooks/cutover-weekend.md` — the weekend all of it converges on
- `docs/architecture/gap-analysis.md` — what this data has nowhere to go yet

## Sources

- [E-invoicing threshold, GST](https://tallysolutions.com/accounting/e-invoicing-rules-in-india/) ·
  [₹5 crore rule](https://www.gimbooks.com/blog/5-crore-e-invoice-turnover-rule-2026/)
- [HSN digits by turnover, PIB](https://www.pib.gov.in/PressReleasePage.aspx?PRID=1708713) ·
  [6-digit mandate](https://www.ginesys.in/blog/6-digit-hsn-code-mandate-in-e-invoices-from-december-2023)
- [E-way bill state thresholds](https://cleartax.in/s/state-wise-threshold-limits-e-way-bills)
- [FoSTaC supervisor ratio, FSSAI](https://fostac.fssai.gov.in/index) ·
  [FoSTaC guide](https://velcolegalindia.com/blog/fssai-food-safety-training-fostac-complete-guide)
- [Legal Metrology packaged commodity declarations](https://ssrana.in/articles/labelling-on-retail-packages/) ·
  [2026 amendments](https://www.mondaq.com/india/dodd-frank-consumer-protection-act/1806934/legal-metrology-packaged-commodities-amendment-rules-2026-enhancing-transparency-and-consumer-protection-in-e-commerce)
- [Weighing scale verification and stamping](https://legalmetrology.org/stamping-verification-under-legal-metrology)
- [DPDP Rules 2025 and the 2027 deadline](https://www.ey.com/en_in/insights/cybersecurity/decoding-the-digital-personal-data-protection-act-2023)
- [RBI card tokenisation, no merchant card storage](https://razorpay.com/blog/card-tokenisation-all-you-need-to-know/)
- [GS1 variable measure barcodes](https://www.gs1uk.org/knowledge-hub/barcodes/how-to-barcode-variable-measure-items)
