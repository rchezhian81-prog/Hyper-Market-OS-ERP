# Open questions

Places where a decision or a real-world fact is still needed before the affected
work can be built. **Answered by the owner, never resolved by assumption**
(`CLAUDE.md`). With the roadmap now in the repo, the earlier "pending roadmap"
gaps are closed; what remains is genuinely owner-only input.

## A. Owner-closure fields (roadmap §25 / §39) — ✅ ALL FOUR ANSWERED

These held the M0 gate (Formal GO). **All four are now answered**; the authoritative record is
`docs/registers/decisions.md` and this table is a summary of it. Corrected 6 August 2026, when this
page was found still reporting them as blocking long after they were decided — a register that says
a gate is shut when it is open is worse than no register, because the one thing anybody reads it
for is what is outstanding.

| # | Question | Answer |
| --- | --- | --- |
| D3 | Monthly post-go-live running-cost ceiling (₹/month)? | **₹15,000 / month, platform runtime only** (owner, 4 Aug 2026, superseding the ₹20,000 of 2 Aug) |
| D4 | Second technical custodian — name? | **Mr Sivakumar** (owner, 2 Aug 2026) — custody (OD-09) and a quarterly rebuild/deploy (AID-10) still to be demonstrated |
| D5 | Formal GO date? | **2 August 2026** — GO given in session; a signed record still to be filed for the audit trail |
| D8 | Full-product completion target date? | **Store Core 1 April 2027** (confirmed 2 Aug 2026); the later releases are dated **release by release** as each approaches |

Two of these carry work that is **not** the decision itself and is still outstanding: Mr Sivakumar's
custody handover and quarterly rebuild (D4), and the signed GO record for the audit trail (D5).
Neither blocks the build; both block the audit trail being complete.

## B. Audit Validation Required (roadmap §13) — the 20 Stage 1 facts
Full list and owners in `docs/discovery/avr-closure.md`. The highest-leverage ones:

| # | Question | Maps to |
| --- | --- | --- |
| Q1 | Which conditional departments does the store operate (fresh production, pharmacy, food court, liquor, concessionaires)? Decides Stage 16 scope. | AVR-12 |
| Q2 | Previous-system export method and **lawful extraction rights**? Drives the vendor letter. | AVR-03 |
| Q3 | SKU / barcode / supplier / customer / transaction volumes? Sizes the system and performance targets. | AVR-04 |
| Q4 | Peak billing throughput and outage history? Sizes offline (72h) and POS performance. | AVR-17 |
| Q5 | Delivery radius/model/capacity and customer-app launch geography? | AVR-13, AVR-14 |
| Q6 | Payment providers, terminals, settlement/refund processes? | AVR-10 |

## C. Retained from the Annexure G audit (schedule/capacity, not features)
Tracked in `docs/registers/risks.md` (R-01…R-18).

| # | Question | Finding |
| --- | --- | --- |
| Q7 | Confirm the six business measures and capture their Stage 1 **measured** baselines. | A-04 (see `docs/discovery/baseline.md`) |
| Q8 | Define the **trading day** for a store trading past midnight (close, GST periods, shift reports). | A-13 |
| Q9 | Who runs the parallel period — named, funded hours/day, weeks, max duration before escalation? | A-05 |
| Q10 | Confirm external-onboarding lead times and start dates (payment aggregator+KYC, GST/e-invoice, WhatsApp API, Apple/Google, pentest). | A-07 |
| Q11 | Confirm the two DPDP dates and retention rules are fixed (13 Nov 2026; 13 May 2027; logs ≥ 1 year). | A-06 (see `docs/registers/compliance.md`) |

_New questions found while expanding requirements in Stage 2 are added here._
