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
