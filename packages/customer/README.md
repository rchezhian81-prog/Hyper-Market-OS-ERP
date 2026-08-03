# `packages/customer/`

Customer 360 — one customer truth (**M16**). Find duplicates safely and never misuse personal
data.

- **`src/matching.ts`** — `detectDuplicateCustomers(customers)`: proposes duplicate pairs. A
  shared **verified** phone/email is a **high-confidence merge candidate**; a shared unverified
  contact or a matching name only is **low-confidence → review**. Nothing is ever **auto-merged**
  — an uncertain match is a **review exception** (P-08); a merge is a governed, reversible,
  audited act (§28, M16-FR-01). Compares normalized values only.
- **`src/consent.ts`** — `hasConsent(state, purpose, channel)` and `canSend(input)`: a message
  may be sent **only** with consent for that purpose+channel that hasn't been withdrawn, and
  within the frequency cap. A breaching send is **blocked, not warned** (`no_consent` /
  `withdrawn` / `frequency_cap`); withdrawal takes effect immediately (M16-FR-02).

> Pure and deterministic. PII is minimized and compared via normalized values only. Tested in
> `tests/unit/customer.test.ts`. Part of the repository layout in `CLAUDE.md`.
