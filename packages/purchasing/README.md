# `packages/purchasing/`

Purchase orders — **M06-FR-02** (issue with separation of duties) and **M06-FR-04**
(open-commitment tracking). Buy safely: an approved commitment, never one person's unchecked
order.

- **`src/purchasing.ts`**
  - `issuePurchaseOrder(input)` — issues a PO only when it has valid lines, an **unblocked
    supplier** (`BlockedSupplierError`, M06-FR-01), and a **valid approval by someone other than
    the requisitioner** (`ApprovalRequiredError`, §28) — the approver's value authority having
    been checked when the approval was decided (`packages/approvals`). Returns the issued PO with
    its total and the approver on record.
  - `computeOpenCommitment(lines, receivedByProduct, cancelledByProduct)` — **open = ordered −
    received − cancelled** per line, valued at the PO unit cost, so commitments **reconcile to
    receipts** (M06-FR-04). An over-receipt shows as a negative open quantity (a signal, not
    hidden). `fullyReceived` when nothing remains open.

> Connects reorder suggestions (M09-FR-02) → PO → goods receiving (M07). The
> `PurchaseOrderApproved` event (§30.2) is emitted by the persistence layer from the issued PO.
> Composes the `Money` primitive and `packages/approvals`. Tested in
> `tests/unit/purchasing.test.ts`. Part of the repository layout in `CLAUDE.md`.
