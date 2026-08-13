# `packages/e-way-bill/`

GST **e-way bill** — the document that must travel with a movement of goods (roadmap gap **A23**,
CGST Rules 2017 **Rule 138**). Before goods move — a sale delivered, a stock transfer between
branches, a return to a supplier — an e-way bill must be generated on the government portal once the
consignment value crosses a threshold, and it carries a validity that runs out by distance. It is the
transport twin of the e-invoice: the same disciplines, a different document.

## Two thresholds that are not the same

The single most common way to get this wrong:

- **inter-State** — required above **₹50,000** consignment value (Rule 138, national).
- **intra-State (within Tamil Nadu)** — required above **₹1,00,000** (the TN notification raises the
  floor).

Both are named constants (`EWB_INTER_STATE_THRESHOLD_MINOR`, `EWB_INTRA_STATE_THRESHOLD_MINOR`), not
buried magic numbers, so a correction is one edit. **The exact intra-TN figure should be confirmed
with the CA before a live run** — getting it wrong in either direction is a real cost (too low blocks
small transfers for a document they don't need; too high sends goods travelling illegal).

## The engine (`src/e-way-bill.ts`)

Mirrors the e-invoice engine deliberately — one shape to learn:

- `assessEwayBillRequirement` — the threshold decision (with exempt-goods and fail-loud on an
  unreadable value).
- `ewayBillValidity` — validity by distance (Rule 138(10): one day per 200 km, or per 20 km for
  over-dimensional cargo), with the last valid day.
- `buildEwayBillRequest` — the canonical **Part-A** request from validated fields (a malformed request
  is refused, not sent to the portal), with the FY and the idempotency key. Part-B (transporter /
  vehicle) is added before the goods actually move.
- `applyEwbResult` — turns the portal's answer into the record to store, **never fabricating the
  12-digit EWB number**; an `unknown`/timeout is a first-class state, never a silent success.
- `assessEwbCancellation` — the 24-hour cancellation window (and not once verified in transit).
- `foldEwayBill` — the append-only lifecycle (submitted → generated → cancelled; generated is final).

## The sandbox portal (`src/sandbox-ewb.ts`)

`sandboxEwbProvider` implements the `EwayBillProvider` port deterministically — a bring-up and testing
tool that closes the build → generate → apply loop with no credentials and no network. The EWB number
is a deterministic 12-digit value derived from the movement's identity (so a repeat is a genuine
`duplicate`), and it is unmistakably a sandbox — never a number the portal issued and never valid to
travel with real goods. `generateViaProvider` closes generate → `applyEwbResult` provider-neutrally;
swap the sandbox for a real portal connector on the same port and the downstream handling is identical.

Wired at `POST /v1/finance/e-way-bill/{eligibility,validity,sandbox/generate}` (`services/finance/
src/e-way-bill.ts`), gated on the GST-portal permissions. Tested in `tests/unit/e-way-bill.test.ts`
(17) and `tests/integration/e-way-bill.test.ts` (5).

**A live run** still needs the certified portal/GSP credentials (from a vault), a feature flag /
kill-switch, and CA confirmation of the intra-TN threshold — the sandbox never produces a fileable
number.

## The durable lifecycle store (A23, item 2 inc2)

The e-way bill was stateless (eligibility / validity / a sandbox generate). This adds the **durable
register** — the transport twin of the e-invoice register — so a movement's e-way-bill state survives a
restart and "current" is a fold of the stored facts:

- `POST /v1/finance/e-way-bill/movements/:movementId/submit` — build the Part-A request from
  `assessEwayBillRequirement` + `buildEwayBillRequest` (a not-required movement returns 200 with no store; a
  malformed request is 422 **before** anything is stored) and record the intent.
- `POST …/:movementId/record-response` — the portal connector posts the answer; `applyEwbResult` turns it
  into the record, **never fabricating the 12-digit EWB number**. A `generated` EWB is FINAL; `unknown`
  stays retryable; a re-posted answer collapses.
- `POST …/:movementId/cancel` — cancel a generated EWB within the 24-hour window (`assessEwbCancellation`,
  and never once verified in transit).
- `GET …/:movementId` — the current folded state.

Wired via `eWayBillAdapter` (`services/api/src/adapters.ts`) — a per-movement event stream plus an atomic
tenant-wide `EwayBillIndexed` index (so the reconciliation queue is cheap). Gated the same operator
permissions as e-invoicing (`finance.einvoice.generate`/`.read`). The operator queue vocabulary
(`ewbQueueCategory` / `isEwbException`) is added here and consumed by the **poll + exception queue**
increment (inc3). Sandbox only — a live portal connection stays externally blocked and off-by-default.
Tested in `tests/unit/e-way-bill-reconciliation.test.ts` and `tests/integration/e-way-bill-register.test.ts`.

## Reconciliation — poll + exception queue (A23, item 2 inc3)

A `submit` that timed out lands `pending_unknown` — the portal may or may not have generated the bill,
and a manual retry risks a second number for the same movement. This increment closes that gap the same
way the e-invoice register does, so the two read alike:

- `POST /v1/finance/e-way-bill/movements/:movementId/poll` — **acknowledgement recovery**. Re-query the
  portal for a stuck (`pending_unknown`) movement and apply the answer through the same `applyEwbResult`
  path, so the 12-digit number is still only ever what the portal returned. A `generated`, `cancelled`
  or `rejected` movement is terminal — a poll on it is a **safe no-op** (`polled: false`), never a second
  submission. Gated `finance.einvoice.generate`; idempotent. Sandbox-driven (`?sandbox.forceOutcome=` in
  the body exercises the timeout/rejection branches); a live portal poll stays externally blocked.
- `GET /v1/finance/e-way-bill/register?state=` — the **reconciliation / exception queue**. Every movement
  in the lifecycle with its operator category (`ewbQueueCategory`); `?state=exceptions` narrows to the
  ones needing attention (`pending_unknown` + `provider_error` + `rejected` — `isEwbException`), or a
  single category (`generated`/`rejected`/`unknown`/…). Read-gated (`finance.einvoice.read`) and
  tenant-isolated. Nothing is rewritten — an exception is surfaced for a human to work, never
  auto-corrected.

Tested in `tests/integration/e-way-bill-register.test.ts` (poll `pending_unknown` → generated + terminal
no-op; a forced timeout staying unknown and an outage classifying rejected; the exception queue listing
unknown + rejected while generated is separate, with RBAC 403 and tenant isolation).
