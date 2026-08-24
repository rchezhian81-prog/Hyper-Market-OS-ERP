# Change register

Deliberate changes to scope, sequence, milestones or a decision after it was
accepted. This is how the **scope ratchet (OD-02)** is honoured: nothing is
dropped or deferred silently — it is recorded here, in writing, with a named
target release and the owner's approval. Stable IDs `CH-##`.

Status legend: **Proposed** · **Approved** · **Rejected** · **Applied**.

| ID | Change | Reason | Impact (scope / date / cost) | Target release | Requested by | Owner decision | Date | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CH-01 | Defer the **cloud wiring** of the M21/M13 returns-and-exchanges side — specifically **exchanges** and **controlled no-receipt returns** — to a later release. The whole service-desk + CRM side of M21 (case lifecycle, both SLA clocks, §28 compensation, P-05 AI-draft approval, consent-gated campaigns, journeys + honest attribution, CSAT) is now wired on API-06. The tested return engines (`packages/returns` M13-FR-01/02/03: eligibility/condition/disposition, the double-refund register) and the cloud refund guard remain in place; this defers only the exchange and no-receipt cloud flows. | Owner instruction after the service-desk side was completed: "merge #275 then defer returns/exchanges to a later release." Exchanges + no-receipt returns are not needed in the current customer-commerce (R4) wiring pass. | **Scope:** the exchange + no-receipt-return cloud write-paths move out of the current pass; **nothing is dropped** — it is scheduled, not removed. **Maturity:** M21 stays **PARTIALLY_WIRED** (a deferred-but-unbuilt requirement is not counted as done — the completion headline is unchanged at 41.1%, not inflated by the deferral). **Date/cost:** no change to the R2 M13 foundations, which stand. | **R5** (Fulfilment — carries WF-16 online cancellation/return; the natural home for the exchange/return flows) | Claude (Delivery Engineer), on owner instruction | **Approved** — Mr. Elanchezhian, "merge #275 then defer returns/exchanges to a later release" | 2026-08-24 | **Approved** |

_A requirement may only be deferred through an Approved row here with a named target release (OD-02)._
