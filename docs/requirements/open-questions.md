# Open questions

Places where the plan is ambiguous, contradicts itself, or leaves something
undefined that must be known before building. **These are listed for the owner to
answer — never resolved by assumption** (`CLAUDE.md`).

Setup 2 will add more once the roadmap is read in full. The questions below are
already known from the Annexure G audit and Annexure H build pack, and most map
to a specific audit finding.

| # | Question | Options to choose from | Source |
| --- | --- | --- | --- |
| Q1 | What does **"usable history"** mean for migration? | (a) Extractable + identifiable key + totals reconcile (proposed default; anything failing one of the three goes to the exception register with a value and owner). (b) A different, owner-specified definition. | A-08 |
| Q2 | What are the **six business measures** and their Stage 1 baselines? | Proposed: minutes per supplier invoice · staff hours/week on data entry · expiry & wastage as % of sales · stock variance at count · days from month-end to owner seeing store P&L · Annexure C benchmark score. Confirm or amend, and confirm each baseline is **measured**, not estimated. | A-04 |
| Q3 | How is the **trading day** defined for a store trading past midnight? | Owner must state the cut-off; it then applies consistently to day-close, reporting and GST periods. | A-13 |
| Q4 | Who **runs the parallel period** — named person, funded hours/day, for how many weeks, with what temporary help — and the maximum duration before escalation to the owner? | Owner decision, written into §36 before GO. | A-05 |
| Q5 | What are the **M0–M8 target months**? | Ranges are acceptable; the point is that a date which cannot be met becomes visible early. | A-01 |
| Q6 | Are the **four M5 feasibility checkpoints** accepted, and written into §36.1? | Hardware certification by Nov 2026 · offline+POS slice by Dec 2026 · first full-volume migration rehearsal by Jan 2027 · parallel run started by mid-Feb 2027. | A-02 |
| Q7 | Add the **read-only supplier-invoice import** slice after Stage 5 as an early win? | (a) Yes — earliest visible benefit. (b) No — keep the current sequence. | A-03 |
| Q8 | Confirm the **external-dependency lead times** and start dates (payment aggregator + KYC, GST/e-invoice provider, WhatsApp Business API, Apple/Google developer accounts, independent penetration test). | Owner to supply an external-dependency table (owner, application date, lead time, milestone it blocks). | A-07 |
| Q9 | Confirm the two **DPDP dates** and retention rules are fixed and immovable. | 13 Nov 2026 Consent Manager framework operational · 13 May 2027 DPDP Rules full compliance (binds data already held at billing). Add the 72-hour breach report and a stated log-retention period (≥ 1 year). | A-06 |
| Q10 | Which of the **conditional enterprise departments** do we actually operate? | Fresh production, pharmacy, food court, liquor, concessionaires — build a module only for a department we have (Stage 16). | Annexure H, Stage 16 |
| Q11 | Confirm the **second technical custodian (D4)** name. | Owner decision. Annexure H will not start without it. | A-17 / D4 |

_Add roadmap-derived questions here during Setup 2._
