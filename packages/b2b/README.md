# `packages/b2b/`

B2B and institutional sales — **M22-FR-01…04**. A second commercial channel on the same
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

- **`src/documents.ts`** — the quote → order → proforma → challan → invoice chain (M22-FR-02).
  Every one of these documents is a legal or commercial claim about the same underlying order,
  and the failure everybody has seen is the chain drifting: an invoice for 40 cases when 38 were
  delivered, because the invoice was built from the **order** instead of from the **challan**.
  So each document is derived from the one before it, never from the one two steps back.
  - `issueQuotation(…)` — non-committing: it moves no stock, reserves nothing and creates no
    receivable. It fixes a price for a stated window so a customer can take it to a committee
    and come back to the same number. **A number is drawn only once the lines are valid**, so a
    rejected quote leaves no gap — a gap in a tax series is a question from an assessing officer
    with no good answer.
  - `convertQuotation(…)` — converts **at the quoted price**, not at today's price list, and
    refuses outside the window rather than re-pricing quietly. A silent re-price is discovered
    at the invoice and costs the account. Will not convert what credit control has blocked.
  - `issueProforma(…)` — **`taxClaimable: false`**, the single most important field on the
    document. A customer claiming input credit against a proforma is claiming against a document
    that was never filed, and it is the shop that gets the notice.
  - `issueChallan(…)` — **what actually left the building**. Quantities come from the dispatch,
    partial delivery produces a partial challan, and delivering *more* than was ordered is
    refused: an unordered case on an invoice is a dispute, and the driver has the argument.
  - `issueTaxInvoice(…)` — **built from the challans, never from the order.** Bill the ordered
    quantity and the customer is overcharged with a tax document to prove it; bill less and the
    shop has delivered goods it will never be paid for. An invoice exceeding what the challans
    record is refused outright. Tax is computed per line in BigInt and summed, never as a
    percentage of a total.
  - `checkChain(…)` — ordered vs delivered vs invoiced. Delivered-but-not-invoiced is the number
    that matters: goods gone out of the door with no claim on them, and nobody finds it by
    reading one document.

- **`src/collections.ts`** — the customer portal, ageing and collections (M22-FR-04).
  - `scopeToCustomer(…)` — the second place someone outside the business logs in (the first is
    `packages/supplier-portal`). **The customer id comes from the session, never from the
    request**; a request naming another customer is refused and marked a `securityEvent`. It
    will not cross a tenant boundary.
  - `ageReceivables(…)` — **ageing runs from the due date, not the invoice date.** An invoice on
    30-day terms issued 40 days ago is 10 days overdue, not 40. Ageing from the invoice date
    makes every account on terms look delinquent, the report gets ignored, and the genuinely
    overdue account is ignored with it. `chaseableMinor` excludes disputed invoices and is the
    only figure a dunning run may act on.
  - `allocatePayment(…)` — **a payment is allocated, not absorbed.** ₹50,000 against three open
    invoices has to land somewhere; netting it against a balance loses which invoice is still
    open, and then the customer and the shop argue about different invoices for three weeks.
    Oldest due first by default, the customer's named invoice first when they say so, and
    anything left over is **unapplied and visible** rather than quietly kept.
  - `decideDunning(…)` — **stopping supply is never automatic.** It ends a relationship, and a
    system that takes that decision on date arithmetic is one that cuts off a school on the
    morning of a function. The step is recommended; a person commits it (P-05, §28). A queried
    invoice never becomes a reminder letter, and a debt below the chase threshold goes on a
    statement instead.
  - `reconcileAr(…)` — the portal must agree with the ledger. A portal that disagrees is worse
    than no portal: the customer pays what the screen said and finance chases the difference.
    The difference is reported **exactly and with its sign**.

> Composes the exact `Money` primitives, `packages/approvals` and `packages/numbering`
> (gap-free series). No card data anywhere (hard rule #3). Tested in `tests/unit/b2b.test.ts`
> (10), `tests/unit/b2b-documents.test.ts` (21) and `tests/unit/b2b-collections.test.ts` (20),
> and proven end to end in `tests/integration/beyond-the-till.test.ts` (Stage 16 gate). Part of
> the repository layout in `CLAUDE.md`.
