# Stage 7 gate evidence — purchase / GRN / invoice controls

**Gate:** roadmap Stage 7 — *"Purchase/GRN/invoice controls pass."* Modules M03–M07,
D01–D03/D06.

**Executed:** 5 August 2026 against **PostgreSQL 16.13**, walking **one delivery end to
end** with the real engines — no mocks except the absence of a real supplier.
Automated as `tests/integration/purchase-to-payment.test.ts`, run in CI against a real
PostgreSQL service container, and **verified repeatable** (run twice, green twice).

---

## The walk, and where each control bites

| # | Step | Control proven |
|---|---|---|
| 1 | Dock slot booked | A second lorry cannot be booked onto the same door at the same time |
| 2 | Purchase order issued, ₹4,000.00 | Issued only with an approver who is **not** the requisitioner (§28) |
| 3 | ASN promises 100 units | — |
| 4 | **3 cases scanned** | Converts to **72 units, not 3** (M03-FR-02 pack conversion) |
| 5 | **The handheld hesitates; the receiver scans again** | `duplicate_ignored` — the count stays 72. Without this it would be 144 (§31.1) |
| 6 | An **unknown barcode** is scanned | Goes to the resolution queue; **the delivery carries on** and the item never silently becomes another item |
| 7 | The receiver tries to **change the agreed price** | **Refused.** A receiver corrects quantities, batches and condition — never the price the three-way match depends on (§28) |
| 8 | 20 loose units scanned → 92 of 100 arrived | — |
| 9 | Compared with the ASN | **8 short.** *"the note is a promise, not a receipt"* |
| 10 | Capture | Shortage **valued at ₹320.00** with a credit note due; damaged milk **quarantined** and requiring a second person |
| 11 | Stock projection | Rice **92 sellable**; quarantined milk **0 sellable** — enforced by the stock model, not by remembering |
| 12 | Invoice arrives: 100 units at ₹44.00 | **Payment blocked twice over** — charged above the agreed price *and* for goods that never arrived |
| 13 | The receiver approves it themselves | **Still blocked.** *"the person who received the goods cannot approve the variance on them"* |
| 14 | Corrected invoice: 92 at ₹40.00 + ₹200 freight | **Payable.** Landed cost **₹3,880.00** — the freight lands on the goods, not in a corner of the accounts |
| 15 | Supplier scorecard | Fill rate **92.00%**, reported as *"the lost sale dwarfs any price advantage"* |
| 16 | GRN synced to the cloud ledger | Appended once; **a retried sync is deduped** and the stream still holds exactly one |

## Defect found and fixed during this work

Building the gate test surfaced a **name collision in the public API**: `packages/receiving`
exported two different `OrderedLine` shapes from one barrel — one keyed by invoice line for
the three-way match, one keyed by product for handheld scanning. TypeScript resolved the
ambiguity silently, so callers could import the wrong shape and only find out at runtime.
The receiver-side type is now `OrderedProduct`, with a comment saying why the two exist.

## Repeatability

The ledger is append-only and the database refuses `DELETE`, so a fixed idempotency key
would make the second run assert against the first run's data. The suite uses a run-scoped
key, which keeps both properties: the test is repeatable, **and** it still asserts that the
first append is new and the replay is deduped. Verified by running it twice.

---

**Stage 7 gate: PASSED.** M03, M04, M05, M06 complete; M07 complete
(FR-01 ASN/DSD/dock/handheld now built alongside FR-02/03/04).
