# Risk register

Stable IDs `R-##`. Severity as assessed in the Annexure G audit where applicable.

> **Sourcing.** Rows R-01…R-17 are the seventeen open findings from the Annexure G
> audit (mapped to their `A-##` finding IDs). R-13…onward add structural
> programme risks. A full pass over roadmap §-by-§ (as Stage 0 requires) will add
> more once `docs/roadmap/roadmap-v2.0.docx` is present.

Status legend: **Open** · **Mitigating** · **Accepted** · **Closed**.

| ID | Risk | Severity | Mitigation / fix | Owner | Status | Source |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | Plan has one real date (M5 = 1 Apr 2027); feasibility cannot be tested, slippage cannot be seen. | HIGH | Put target months (ranges ok) against M0–M8; D8 completion date. | Owner | Open | A-01 |
| R-02 | M5 got harder but the date did not move — POS from scratch + full-history migration (2+ rehearsals) + 7-step hardware cert + 72h offline proof + daily-reconciled parallel run, in ~8 months. | HIGH | Four M5 feasibility checkpoints, checked monthly; move M5 if any slips >1 month. | Owner | Open | A-02 |
| R-03 | Nothing reaches the store before Release 2; staff goodwill spent with no visible benefit. | HIGH | Add read-only supplier-invoice import + OCR draft slice after Stage 5. | Owner | Open | A-03 |
| R-04 | Success measures measure the system, not the business; every gate could pass with all nine business outcomes unimproved. | HIGH | Add six business measures to §2.3, each with a Stage 1 measured baseline. | Owner | Open | A-04 |
| R-05 | Nobody allocated to run the parallel period; the most common cutover-failure point, and it fails for manpower reasons. | HIGH | Name who reconciles daily + funded temp help + max parallel duration before escalation. | Owner | Open | A-05 |
| R-06 | DPDP full-compliance deadline (13 May 2027) absent; breach-report and log-retention specifics missing. | HIGH | Add both DPDP dates as immovable; add 72h breach report + retention ≥1yr. See compliance C-04. | Owner | Open | A-06 |
| R-07 | External onboardings (payment aggregator+KYC, GST/e-invoice, WhatsApp API, Apple/Google, pentest) have 4–8 week leads and no plan; they start when you apply, not when you're ready. | MED-HIGH | External-dependency table (owner, apply date, lead time, milestone blocked); start early. | Owner | Open | A-07 |
| R-08 | "Usable history" undefined — the word migration arguments are fought over under time pressure. | MED | Define in Stage 1: extractable + identifiable key + totals reconcile; else exception register with value. | Owner | Open | A-08 |
| R-09 | No test-data strategy; production personal data forbidden in dev/test yet load tests need audited scale. | MED | Deliverable: anonymised production-shaped dataset generator, refreshed per release. | Tech custodian | Open | A-09 |
| R-10 | Mobile rollback treated like server rollback; users keep the version they have. | MED | Server supports current + previous app version; forced-upgrade w/ min version; remote kill. | Tech custodian | Open | A-10 |
| R-11 | AVR items have no entry-condition control — a list, not a control. | MED | §22: a stage may not enter GO while an AVR item mapped to it is open. | Tech custodian | Open | A-11 |
| R-12 | No schedule-variance trigger; with "nothing removed", slippage has no pressure valve except silence. | MED | A stage exceeding target by >30% raises an owner decision: re-sequence / add capacity / move milestone. | Owner | Open | A-12 |
| R-13 | Business date vs calendar date undefined for a store trading past midnight; close, GST periods and shift reports will disagree. | MED | Define the trading day in §29.1; apply to close, reporting and tax. | Tech custodian | Open | A-13 |
| R-14 | Annexure C 60-point scorecard not referenced as a Stage 1 output; no single baseline number. | MED | Make it a Stage 1 deliverable; re-score at M3, M5, M8. | Owner | Open | A-14 |
| R-15 | Usability gate soft edges: "≤3 interactions where feasible" is unenforceable; 30-minute new-cashier target absent. | LOW | Remove "where feasible", name exceptions explicitly; add the training-time target. | Owner | Open | A-15 |
| R-16 | No Definition of Ready; work can start on an under-specified requirement. | LOW | Add five entry conditions mirroring QG-01. | Tech custodian | Open | A-16 |
| R-17 | Four owner-closure fields blank — D3, D4, D5, D8. | LOW | Fill D4 today; the other three can close together at GO. | Owner | Open | A-17 |
| R-18 | Key-person risk — only one person can rebuild the system (largest, cheapest-to-close programme risk). | HIGH | Name D4 second custodian; AID-10 quarterly rebuild demonstration. | Owner | Open | Annexure G G-08 / Annexure H |
| R-19 | Migration data loss/corruption at cutover. | HIGH | ≥2 full-volume rehearsals + dress rehearsal; per-domain reconciliation; quarantine w/ value & owner; rehearsed rollback. | Tech custodian | Mitigating (by design) | Stage 11/13, MG-01…MG-12 |
| R-20 | Offline/sync incorrectness — lost, duplicated or last-write-wins transactions. | HIGH | Stage 6 vertical slice proven early; §4.2/§31.1 invariants; QG-04 test battery; owner pulls the plug. | Tech custodian | Mitigating (by design) | Stage 6 |
