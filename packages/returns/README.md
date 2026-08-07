# `packages/returns/`

Returns, exchanges and refunds — **M13**. Take goods back fairly and safely, put the
returned stock into the **right state**, and record the refund **honestly** — all offline
(M13-FR-01 acceptance: a receipted return works with the network cable out).

- **`src/returns.ts`** — `commitReturn(input, stockLedger, outbox)` composes the foundation
  and enforces the M13 rules:
  - **Returned at most once** (M13-FR-01): a line's cumulative return may not exceed what was
    sold — no double refund (`OverReturnError`).
  - **Disposition decides availability** (M13-FR-02): only `resell` re-enters **sellable**
    stock (`on_hand`); `quarantine`/`damaged` come back in a non-available state; `scrap` keeps
    no stock. Each kept line is an append-only `InventoryMoved` in the disposition's state.
  - **Refund never exceeds the allowed amount** (M13-FR-03): the refund is capped by the
    original paid amount (and by the no-receipt cap where it applies) — `ExcessRefundError`.
  - **Approval by a different person** (M13-FR-03 / §28): a material refund (at/above the
    tenant threshold) or **any** no-receipt return needs a valid `DecidedRequest` approved by
    someone other than the person processing it — `ApprovalRequiredError`. An AI agent can
    never authorise a refund (AI-NFR-12): the approval is a human decision produced upstream.
  - **Never invent a reversal** (M13-FR-04): a cash/store-credit refund settles offline; a
    card/UPI refund is recorded as a **pending** provider reversal, never assumed successful.
  - A `ReturnAccepted` event (§30.2) is queued to the outbox; idempotent on the return id.

> Composes `packages/approvals` (approval produced upstream), `packages/ledger`,
> `packages/sync` and the `Money`/`TenderKind` contracts. Tested in
> `tests/unit/returns.test.ts`. Part of the repository layout in `CLAUDE.md`.
