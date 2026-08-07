# `packages/bank-controls/`

Bank fraud controls — supplier **bank-change verification** (**M06-FR-01**) and **duplicate
bank-account detection** (**M15-FR-03**). Two of the store's most important money-out safeguards.

- **`src/bank-verification.ts`**
  - `verifyBankChange(change)` — a supplier bank-detail change is verified only with an
    **independent approval** for that change, decided by **someone other than the requester**
    (§28). Otherwise `BankChangeUnverifiedError` — which **blocks payment**, never silent.
  - `isPayable(state)` — a supplier may be paid only when not blocked and with **no unverified
    bank change pending**.
- **`src/duplicate-bank.ts`**
  - `detectDuplicateBankAccounts(holders)` — flags any bank account shared by **two or more
    distinct holders** (suppliers and/or employees); the same holder listing an account twice is
    not a duplicate. Deterministic ordering.
  - `holdersBlockedForDuplicate(flags)` — the set of holder ids whose **payment must be blocked
    pending review** (M15-FR-03).

> Account references here are masked/tokenised (PRV — no raw account numbers). Composes
> `packages/approvals`. Tested in `tests/unit/bank-controls.test.ts`. Part of the repository
> layout in `CLAUDE.md`.
