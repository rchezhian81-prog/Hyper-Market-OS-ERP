# Baseline — the numbers to measure in the store this month

**Why this matters.** Annexure G finding A-04 says the plan measured the *system*,
not the *business*, and A-14 says there is no single baseline number. A measure
without a baseline cannot be a gate. These numbers must be **measured in the store
this month**, not estimated — otherwise, at the end, no one can prove the project
improved anything.

Fill the two right-hand columns from real observation. Where a number needs a
short study (e.g. timing invoices), do it on a normal trading day, not a quiet one.

> Prepared during Stage 0. The measuring happens in Stage 1. Capture baselines
> **before** any feature changes how the work is done.

## The six business measures (findings A-04 / A-14)
These six are the ones the audit asks to be tied to gates and re-checked at M3,
M5 and M8.

| # | Measure | How to measure | Unit | Baseline value | Date / who measured |
| --- | --- | --- | --- | --- | --- |
| B1 | Minutes per supplier invoice | Time entry of several real invoices end-to-end; average | minutes/invoice | | |
| B2 | Staff hours per week on data entry | Sum hours across staff doing keying, for one normal week | hours/week | | |
| B3 | Expiry & wastage write-off as % of sales | Value written off ÷ sales, over a month | % of sales | | |
| B4 | Stock variance at count | Value/■% difference at the last physical count | % (and ₹) | | |
| B5 | Days from month-end to owner seeing store P&L | Count calendar days for the last close | days | | |
| B6 | Annexure C benchmark score | Score the current system on the 60-point scorecard | /60 | | |

## Operating baseline (sizing the system correctly)
These size the design and the performance targets; measure them too.

| # | Measure | How to measure | Unit | Baseline value | Date / who measured |
| --- | --- | --- | --- | --- | --- |
| B7 | Peak bills per hour | Busiest hour on a busy day, count bills | bills/hour | | |
| B8 | SKU count | Active sellable items in the current system | count | | |
| B9 | Average lines per bill | Total lines ÷ bills over a day | lines/bill | | |
| B10 | Supplier count | Active suppliers | count | | |
| B11 | Customer records held | Customer/loyalty records in the current system | count | | |

## How the baselines are used
- They become the **targets** the six business measures are checked against, and
  are **re-scored at M3, M5 and M8** (A-14).
- B6 (Annexure C score) is the single number that describes where you started.
- B7–B9 set the **POS performance envelope** (scan p95 < 300 ms, tender p95 < 500 ms)
  and the offline sizing (72-hour store-and-forward).

> ⛔ The **Annexure C 60-point scorecard** (B6) and the roadmap's own §2.3 measures
> should be reconciled against `docs/roadmap/roadmap-v2.0.docx` and Annexure C when
> those documents are available. The six measures above are taken directly from the
> Annexure G fix for A-04.
