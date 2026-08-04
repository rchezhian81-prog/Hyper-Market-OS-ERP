# `packages/settlement/`

Card / UPI / gateway settlement and exception investigation — **M14-FR-03** (§6.2).

`packages/reconciliation` (M23-FR-03) answers *"does this tender match that credit?"*.
This package is the **cash office's day**: getting the provider's file in safely, telling
apart the two problems that look identical, and making sure the ones that matter end up
owned by a person with a date against them.

- **`importSettlementBatch(batch, alreadyImported)`** — a provider file must reconcile
  **to its own declared figures** before it goes anywhere near the POS tenders: the lines
  must sum to the declared gross, and `gross − fees = net` must hold on the provider's own
  arithmetic. A file that does not add up will not stop being wrong once it is inside the
  system — reconciling against it *invents* differences that are not there. Re-importing
  the same batch is refused: it would double every credit in it.

- **`reviewSettlement(...)`** — composes the M23-FR-03 matcher, then does the thing the
  matcher deliberately does not:
  - **Late is not lost.** A card tender with no credit yet is normal at T+1 and serious at
    T+9. Unmatched tenders are aged against the provider's contracted cycle, and only
    become an exception once they are genuinely late. Without this the cash office either
    buries the real one among a hundred normal ones, or learns to clear the list without
    reading it.
  - **Fees are not shortfalls.** The bank credits net of commission; per-transaction
    "shortfalls" that are really the fee model belong in the batch fee line, and the
    exception says so.
  - An **over**-settlement is reported as loudly as a short one. Four findings, four
    different problems: overdue, short, over, unknown credit, ambiguous reference —
    ordered worst first, every one valued.

- **Investigation** — `openInvestigation` demands a **named** owner and a future due date,
  and **refuses to open a case on money that is simply not due yet** (opening one trains
  people to close cases without reading them). `attachEvidence` is append-only.
  `resolveInvestigation` closes **only with an outcome and a note**, refuses to let the
  person who raised a difference also write it off (§28), and returns concrete
  **feedback** — a timing exception means the configured cycle is wrong, a recurring
  provider error belongs at the contract review (M06-FR-03), a write-off is a real loss
  that belongs in the finance posting (M23), not in a cleared list.

- **`ageInvestigations(...)`** — open cases by age bucket, because the oldest unmatched
  money is the money least likely ever to arrive.

> No card data anywhere: references are provider tokens, enforced by reusing the same
> refusal `packages/reconciliation` applies (hard rule #3). Pure and deterministic — the
> file is passed in, the clock is injected. Tested in `tests/unit/settlement.test.ts` (23)
> and proven end to end in `tests/integration/day-close-honestly.test.ts` (Stage 9 gate).
> Part of the repository layout in `CLAUDE.md`.
