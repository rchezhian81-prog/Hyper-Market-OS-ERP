# Codex restart / refund review — findings register (RR-F01–RR-F06)

_Recorded so future sessions can recover these findings without the owner re-supplying them
(owner instruction, step 2). The four open findings are transcribed from the owner's brief; the
wording is preserved. **Do not reconstruct, substitute or renumber these.** New operational gaps
found while repairing are recorded separately (see the bottom of this file), never in place of these._

## Evidence baseline

- **Repository:** `rchezhian81-prog/Hyper-Market-OS-ERP`
- **Audited commit:** `12d84937457765acff7bc33a6c47499d0dc52f8e`
- **Attachment (external, not in repo):** `SRE_Continuation_Evidence.zip`
- **Tests (external):** `audit/refund-review.test.ts`
- **Recorded results (external):** `refund-review-results.json`
- The external tests use `F01`–`F06`; the report names them `RR-F01`–`RR-F06`. **These are separate
  from the requirements workbook's `F01`–`F50`.**
- Findings were reproduced at the audited commit. **Reproduce against current `main` before claiming
  they remain or are resolved.**

## Status (this session)

| ID | Title | Status |
|----|-------|--------|
| RR-F01 | Untrusted requests can mutate the lane's durable log | **RESOLVED** — commit `0adc015`; reproduced then fixed against current `main` |
| RR-F02 | A lost reply is incorrectly reported as definite failure | **RESOLVED** — commit `41cad65` |
| RR-F03 | Reusing a refund ID with different money succeeds | **RESOLVED** — commit `ededd39` |
| RR-F04 | A second full refund succeeds using stale caller history | **RESOLVED** — commit `26506ba` (local; cross-lane safe policy + GAP-REFUND-XLANE-01) |
| RR-F05 | Failed-sync record lost on restart (cursor stepped over in-memory dead-letter) | **RESOLVED** — PR #345, commit `98ea05b`; evidence `docs/evidence/rr-f05-f06-restart-recovery.md` |
| RR-F06 | Failed-sync records must survive restart with history | **RESOLVED** — PR #345, commit `98ea05b`; evidence `docs/evidence/rr-f05-f06-restart-recovery.md` |

Evidence for RR-F01–RR-F04: `docs/evidence/rr-f01-f04-refund-review.md`.

Repair order for the four open findings (owner-directed): **RR-F01 → RR-F03 → RR-F04 → RR-F02.**
RR-F02 last because its safe fix (status inquiry / idempotent retry under the same operation
identity) depends on the edge being idempotent (RR-F03) and entitlement-safe (RR-F04).

---

## RR-F01 — Untrusted requests can mutate the lane's durable log

A POST to `/lane/returns` with Origin `https://untrusted.invalid` and Content-Type `text/plain`
returned HTTP 200 and wrote one record. Expected: reject the untrusted request before any durable
mutation. Affected area: `edge/store-edge/src/lane-server.ts`. Implement server-side request
authorization, origin and content-type controls appropriate to the lane protocol. CORS response
headers and loopback binding alone do not establish caller authorization. The original probe proves
server behavior, not exploitation in every browser. Preserve authorized offline lane operation.

## RR-F02 — A lost reply is incorrectly reported as definite failure

The edge durably recorded and queued a refund. An injected loss of its response caused
`laneDurableReturn` to return `committed:false`. Affected area: `apps/pos/src/browser-entry.ts`.
Represent uncertain outcomes explicitly. Resolve through a durable status inquiry or safe retry using
the SAME operation identity. Distinguish recording, actual cash handover and provider settlement.
Never encourage a second refund because confirmation was lost.

## RR-F03 — Reusing a refund ID with different money succeeds

A refund with ID `R-repeat` for ₹50 succeeded; another with the SAME ID for ₹60 also succeeded.
Affected areas: till-session, returns, edge persistence/idempotency. Persist and atomically enforce
operation identity plus canonical payload identity. Identical retries return the original outcome
without extra effects; changed payloads produce an explicit conflict. Prove this across retries,
concurrency and restart.

## RR-F04 — A second full refund succeeds using stale caller history

After refunding one unit against receipt `S-1`, another refund with a NEW ID for that same unit
succeeded when the caller again supplied `originalQtyMinor=1` and omitted prior-return history.
Enforce entitlement using trusted original-sale data and durable return history, with atomic
reservation/accounting. Test a valid first refund followed by the invalid second refund. Do not "fix"
this by rejecting every refund. For disconnected cross-lane refunds, enforce an explicit safe policy
when entitlement cannot be established; do not claim global at-most-once behavior without supporting
coordination or allocation.

---

## Newly identified operational gaps (this session) — separate from the findings above

_Recorded here so they are not lost, and explicitly NOT a renumbering of RR-F01–RR-F06._

- **GAP-REFUND-XLANE-01 — cross-lane / disconnected refund at-most-once needs cloud reconciliation.**
  RR-F04 is fixed *locally*: an edge enforces entitlement for a sale it rang, from its own trusted
  sold + returned totals. But an edge only knows its own sales and returns. A refund against a sale
  rung on another lane (or with no receipt) cannot be entitlement-checked at that edge, so the edge
  applies the safe policy — allow it under the existing §28 approval/cap controls and mark it locally
  unverified — and does **not** claim global at-most-once. Enforcing at-most-once ACROSS lanes needs
  the cloud (which sees every lane's sales and returns) to reconcile refunds on sync — e.g. a
  cumulative-returned check on the `POST /v1/sales/:saleId/returns/synced` route, or a returned-units
  allocation handed to lanes. This is a cloud increment, separate from these findings and not a
  renumbering of them.
- **GAP-SALE-IDEMPOTENCY-01 — the sale path has the same reused-id exposure RR-F03 fixed for refunds.**
  `createEdgeNode.commit` appends a sale on every call with no operation-identity guard, so the same
  sale id committed twice with a different payload would double-append locally (the cloud dedups the
  send on the key, as with refunds pre-RR-F03). Not in the Codex findings (which are refund-focused)
  and the sale path is deliberately left untouched here; recorded for a future, separately-reviewed
  increment that applies the same durable idempotency guard to sales.
