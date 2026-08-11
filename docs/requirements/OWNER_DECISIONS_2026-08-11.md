# Owner decisions — the ten gap-analysis questions (ratified 11 August 2026)

Ratified by the owner (Mr Elanchezhian) on 11 August 2026, answering the ten owner-only
decisions left open in `WORLDWIDE_REQUIREMENTS_GAP_ANALYSIS.md` (§ "Still gated on the ten
owner decisions"). This is the written record required by `CLAUDE.md`: nothing is silently
dropped — every consequence is adopted now, or deferred with a named target release, or
marked not-applicable with the reason.

**Overall sequencing choice: PHASE IT.** Open the store with what is legally required for
day-one trading; the larger back-office and channel items follow on dated targets. Nothing
below is dropped — items are sequenced, not cancelled.

---

## The decisions

| # | Question | Owner's answer |
| --- | --- | --- |
| D1 | Legal entity type | **Proprietorship / partnership firm** |
| D2 | Aggregate annual turnover band | **₹5–10 crore** |
| D3 | Regulated goods stocked | **Tobacco, gold/silver jewellery, OTC pharmacy** (no liquor) |
| D4 | Own private-label products? | **Yes** |
| D5 | Card terminal model | **Bank-supplied standalone machines** |
| D6 | Staff attendance method | **Both** — biometric *and* card/PIN |
| D7 | Payroll + PF/ESI | **In-house** (build it in the software) |
| D8 | ONDC seller node | **Defer** |
| D9 | Customer wallet / BNPL | **No, not now** |
| D10 | Own online store | **Yes — wanted soon** |

---

## What each decision triggers

### D1 — Entity: proprietorship / partnership
- **A27** (non-disableable, dated edit-log of the books) is **NOT legally mandatory** for a
  non-company. It is already built and stays switched on as **best practice** — reclassified
  from *legal duty* to *voluntary control*. **No new work; no exposure.**
- The MCA Companies-Act audit trail obligation does not apply.

### D2 — Turnover ₹5–10 crore  ⚠️ biggest consequence
- **A20 — e-invoicing (IRN + signed QR) is now MANDATORY → ADOPT NOW (target R2).**
  Every B2B invoice / export / credit-debit note must obtain an IRN and a signed QR from the
  IRP and print it. Currently *partial* (the M32 integration gateway exists); the live IRP
  connection + IRN/QR generation is a **new R2 build item**. B2C is excluded.
- **A21 — 30-day IRN reporting limit** applies only at **≥ ₹10 cr → NOT APPLICABLE now.**
  Deferred to **R3**, to be revisited if turnover crosses ₹10 cr.
- **A4 — HSN digit count = 6 digits** (turnover > ₹5 cr). Already built; the tenant
  turnover-band config is set to the **"> ₹5 cr"** band. **Config setting, no new build.**
- **A18 — GST annual return (GSTR-9)** applies → **R3 finance**.

### D3 — Regulated goods: tobacco, gold, pharmacy (liquor removed)
- **Tobacco** — **B14** age-18 gate at the till + block loose single-stick sale → **ADOPT NOW
  (R2, POS)**. **B15** statutory warning board (≥ 60×30 cm) → physical + config, **R2**.
  **B16** block packs lacking the 85% pictorial+text warning → **deferred R3** (as already
  recorded in the addendum).
- **Gold / silver jewellery** — BIS **hallmarking / HUID** validation → **R3**; **PMLA
  high-value cash-transaction** reporting → **R2/R3 finance** (it is cash-handling).
- **OTC pharmacy** — **drug-licence** captured as a compliance **obligation** (the
  M34-FR-03 register, already built and wired) → **config/setup**; **batch + expiry** handling
  already built (M10 quality / cold-chain) → **covered**.
- **Liquor — REMOVED.** Retail alcohol in Tamil Nadu is a TASMAC state monopoly; a private
  hypermarket cannot sell IMFL/beer. The owner confirmed the earlier selection meant a
  non-alcoholic line. **All liquor/excise items are out of scope.**

### D4 — Own private-label products: yes
- **B20–B22 — EPR (Extended Producer Responsibility) registration** for the packaging /
  batteries / e-waste the store is brand-owner of → **defer to R3/R4 with target**.
  Registration is a business/legal task; the software support for EPR declarations is R3.

### D5 — Card terminals: bank-supplied standalone
- **C11 — PCI scope is the smallest possible.** Card numbers never touch our software
  (already a hard rule: provider tokens only). **Confirms minimal compliance burden; no new
  work.** ✓

### D6 — Attendance: both biometric and card/PIN
- **C21 — biometric consent + alternative.** Because card/PIN is also offered, the required
  **non-biometric alternative already exists**; we add an **explicit-consent capture** step for
  the biometric path → **R3**, moderate.

### D7 — Payroll: in-house
- **C15 / C16 / C19 — payroll, Provident Fund, ESI** become **build items**, not a manual
  process. This is a **substantial module** and is **not needed to open the doors** →
  **defer to R4 with target** (payroll module).

### D8 — ONDC: defer
- **E2** — deferred with a later target (post-go-live). Recorded, not dropped.

### D9 — Wallet / BNPL: no
- **E4 / E5** — declined for now. Basic stored value (gift cards / store credit) is already
  built and covers the near-term need. Revisit later if desired.

### D10 — Own online store: wanted soon  ⚠️ significant near-term add
- **B23** (online sales channel), **A26** (online-channel tax/compliance) and the **DPDP
  customer-data-privacy surface** move into **near-term scope (R3/R4)**. The customer-app shell
  exists; the online commerce flow + DPDP consent/rights surface become **real build scope**.
  Note: this is the one item in tension with "phase it" — treated as its own scheduled phase
  rather than a go-live blocker.

---

## Consequence summary — what changed for the plan

**New / confirmed R2 (needed to open the doors):**
- A20 e-invoicing IRN + QR (the big new build) · A4 HSN 6-digit (config) · B14 tobacco
  age-gate + no-loose-stick · B15 tobacco warning board · pharmacy drug-licence obligation +
  batch/expiry (largely covered) · PMLA high-value cash reporting.

**Deferred with a named target (not dropped):**
- A21 30-day IRN → R3 (if ≥ ₹10 cr) · A18 GSTR-9 → R3 · B16 tobacco pictorial-warning block →
  R3 · gold hallmarking/HUID → R3 · B20–B22 EPR software → R3/R4 · C21 biometric consent → R3 ·
  C15/C16/C19 in-house payroll → R4 · D10 online store + DPDP → R3/R4 · E2 ONDC → post-go-live.

**Not applicable / dropped (with reason):**
- A27 legal audit-trail duty → not a company (kept as best practice) · liquor/excise → TN
  TASMAC monopoly · E4/E5 wallet/BNPL → declined for now.

**No new work, favourable:**
- D5 standalone card terminals → smallest PCI scope.

---

## Governance note
Per the addendum's rule, each **adopt-now** consequence earns its machine-checked row in
`docs/traceability.md` **when it is built** (not before — an unbuilt "Built" row would fail the
traceability guardrail). This document is the ratified decision record those future rows trace
back to. Deferred items carry their target release here, satisfying `CLAUDE.md` ("never
silently drop a requirement… defer it in writing with a named target release").
