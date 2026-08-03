# `packages/b2b/`

B2B and institutional sales — **M22**. A second commercial channel on the same
one-commerce-truth core (P-02): businesses buy on terms, safely.

- **`src/credit.ts`** — `checkCredit(input)`: an order that would push a customer's balance past
  their **credit limit** is **blocked pending approval** (`over_limit`), never a silent override;
  an **expired contract** blocks (or falls back) per policy (`contract_expired`). An over-limit
  or blocked order proceeds **only** with a valid approval by **someone other than the person
  taking the order** (§28). Reports the **available credit** (limit − outstanding). B2B credit is
  evaluated online on fresh data (no unsafe stale credit).
- **`src/commission.ts`** — `computeCommission(base, rateBps, capMinor?)`: salesperson commission
  as a basis-points rate on a commissionable base, computed with **exact money** (no float,
  half-up rounding), with an optional cap (M22-FR-03).

> Composes the exact `Money` primitives and `packages/approvals` already built. The quote →
> order → proforma → challan → invoice document flow (M22-FR-02) uses `packages/numbering`
> (gap-free) and `packages/finance` (GST) — wired at the persistence layer. Tested in
> `tests/unit/b2b.test.ts`. Part of the repository layout in `CLAUDE.md`.
