# `packages/supplier-portal/`

Partner access, submissions and statements — **M24-FR-01…04** (§35, P-04, hard rule #6).

This is the only place in the whole product where **somebody outside the business logs in**.
That single fact makes it the highest-risk surface in the repository, and the risk is not
exotic: it is one supplier seeing another supplier's prices. Two suppliers competing for the
same shelf, both with a login, and a query that filters on a parameter the client sent — the
commonest multi-tenant breach there is, and usually one missing `where` clause.

- **`src/portal.ts`**
  - `scopeToPartner({ session, rows, grant, requestedPartnerId? })` — **every read is scoped
    server-side, from the session, never from the request.** The partner id is taken from the
    authenticated `PartnerSession` and the filter happens here.
    - A request naming another partner does **not** get an empty list. It gets
      `outcome: 'not_your_data'` with **`securityEvent: true`**, because a supplier probing
      for a competitor's invoices is not a UI mistake.
    - It will not cross a **tenant** boundary either, even for the same partner id — the
      same supplier trading with two of our tenants must not see both through one login
      (ADR-0003).
    - **A partner is never trusted with its own identity.** Nothing in this module reads a
      partner id out of a payload; there is no function that takes one, and
      `tests/unit/supplier-portal.test.ts` asserts that absence directly.
  - `checkPartnerCompliance({ partnerId, documents, required, today })` — checks documents
    **at the moment of the action**, not on a nightly sweep. The gap between the two is
    exactly where an expired supplier gets a purchase order, and once the shop accepts goods
    from an unlicensed food supplier it has inherited their non-compliance whatever its own
    paperwork says. Dates are **inclusive** — the last valid day is still valid.
    - A document that exists but was **never verified counts as missing**: an unverified
      licence is a photograph somebody uploaded.
    - It warns before it blocks (`expiring`), so somebody can chase it before a delivery is
      turned away at the door.
  - `acceptSubmission({ submissionId, session, kind, compliance, … })` — **the portal is a
    door, not an authority.** A catalogue, an RFQ response and a claim are *proposals*: they
    land with `requiresReview: true` and a buyer decides (§28). An ASN and an invoice still
    meet the receiving and three-way-match controls (M07). Non-compliance blocks the
    submissions that create an obligation; a retried submission is a `duplicate`, not a
    second invoice; and acknowledging another supplier's order is refused and recorded.
  - `buildStatement({ session, lines, openingMinor })` — built from the partner's own lines
    only, with the closing balance **derived and cross-checked** rather than stored.
    - A **disputed** line is reported separately — it is neither owed nor written off, and
      folding it into the balance is how a dispute quietly becomes a payment.
    - `reconciles` is a real guard: the balance is built from named buckets and checked a
      second way against the raw line amounts. Add a document kind and forget to categorise
      it and this goes **false**, rather than the line vanishing from a supplier's balance.
    - Without the statement grant, `accessible` is **false** and the detail says so — an
      empty statement is a permission answer, not "you owe nothing".
  - `auditPartnerAction(…)` / `findProbing(entries, threshold)` — **refusals are audited as
    loudly as successes** (hard rule #6). A system that logs only successes never sees the
    pattern it most needs to: one refusal is a mis-click, three is somebody trying doors, and
    the shop should hear it from its own system rather than from the supplier whose prices
    leaked.

> Pure and deterministic: the clock is injected, nothing is written here. Tested in
> `tests/unit/supplier-portal.test.ts` (26) and proven end to end in
> `tests/integration/beyond-the-till.test.ts` (Stage 16 gate). Part of the repository layout
> in `CLAUDE.md`.
