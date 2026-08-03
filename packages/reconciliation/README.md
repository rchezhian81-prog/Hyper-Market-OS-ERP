# `packages/reconciliation/`

Payment reconciliation — **M23-FR-03**. Match provider settlement/statement lines against POS
electronic tenders so **every tender is independently reconcilable** (§6.2) and any mismatch is
an **owned, valued exception**, never a silent loss (P-08).

- **`src/reconciliation.ts`** — `reconcile(tenders, settlements)`:
  - Matches on the provider **reference/token** and the **amount**.
  - Surfaces valued exceptions: **`unsettled_tender`** (in POS, never settled),
    **`unknown_settlement`** (settled, no POS tender), **`amount_mismatch`** (same ref,
    different amount — with the `varianceMinor`), and **`duplicate_ref`** (ambiguous).
  - **Never uses a card PAN** (hard rule #3): a reference that looks like a raw card number
    (13–19 bare digits) is refused with `CardDataError` — tokens/refs only.
  - Pure and deterministic — output is ordered tenders-first then settlement-only.

> Cash is reconciled at the till close (`packages/till`); this is the electronic-settlement
> counterpart. The exceptions map to the `ReconciliationExceptionRaised/Resolved` events
> (§30.2). Tested in `tests/unit/reconciliation.test.ts`. Part of the repository layout in
> `CLAUDE.md`.
