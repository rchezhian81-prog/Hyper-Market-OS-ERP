# `packages/e-invoice/`

GST e-invoicing — **roadmap v2.1 A20** (where aggregate annual turnover is over ₹5 crore,
every B2B / export / SEZ invoice and every credit/debit note must be registered with the
Invoice Registration Portal, which returns an IRN and a digitally **signed QR** to print;
B2C is excluded).

The deterministic core: the ₹5-crore-gated, B2C-excluded **eligibility** decision (the
threshold imported from `packages/finance` so it cannot drift from the HSN rule); the
canonical **IRP request** build (a Rule-46-invalid invoice is refused, not sent); and the
**never-fabricate** handling of the IRP's answer — a registration is stored only if it carries
a well-formed IRN and signed QR, and an `unknown` answer is a first-class state, never a
silent success. The live IRP submission is a certified-GSP deployment adapter (the
`EInvoiceProvider` port), the same shape as the payment-reversal provider.

## The sandbox GSP (`src/sandbox-gsp.ts`, WP2 inc1)

The engine defined the `EInvoiceProvider` port but nothing in the repo implemented it, so the
submit → register → apply loop could only be closed by a live, credentialed GSP. `sandboxGspProvider`
is a **deterministic simulator** of that port — a bring-up and testing tool that closes the loop with
no credentials and no network. Its answers are real in shape but unmistakably a sandbox: the IRN is
`sha256` of the invoice's identity basis (so the same invoice always yields the same IRN and a repeat
is a genuine `duplicate`), the signed QR is prefixed `SANDBOX.`, and there is no clock or randomness.
A non-positive taxable value is rejected even here, and `forceOutcome` drives the `unknown` (timeout)
and `rejected` branches for tests. `registerViaProvider(request, provider)` closes register →
`applyIrpResult` **provider-neutrally** — swap the sandbox for a real certified-GSP connector on the
same port and the downstream discipline (never fabricating a signature, `unknown` as its own state) is
identical. Wired at `POST /v1/finance/e-invoice/sandbox/register`. Tested in
`tests/unit/e-invoice-sandbox.test.ts` (8) and `tests/integration/e-invoice-sandbox.test.ts` (3).

**A live filing** still needs a certified GSP's credentials (from a vault), the e-invoicing feature
flag / kill-switch (a later increment), and CA/legal sign-off — the sandbox never produces a fileable
IRN.

## The GST-portal switch — feature flag + kill switch (`src/portal-switch.ts`, WP2 inc3)

The LIVE (non-sandbox) e-invoice and e-way-bill portal integrations ship **off by default** and must be
**killable instantly**. `assessGstPortalGate(controls, channel)` is the decision: two independent
controls — `enabled` (absent = not enabled, the safe default: off until certified-GSP credentials and
CA/legal sign-off are in place) and `killed` (an emergency stop that **overrides** `enabled`). Killed
beats enabled; absent flags mean not-live. `requireGstPortalLive` is the throw-style guard
(`GstPortalDisabledError`) a caller uses immediately before a real portal call.

The **sandbox routes are exempt** — they contact no portal and their output is non-fileable, so practice
mode is always available regardless of this switch. Where the two flags are stored is the deployment's
concern: per-tenant versioned config already exists (M01-FR-03). Wired at `POST /v1/finance/gst-portal/
gate` (`services/finance/src/gst-portal.ts`), gated `finance.einvoice.read`. Tested in
`tests/unit/e-invoice-portal-switch.test.ts` (5) and `tests/integration/gst-portal-switch.test.ts` (2).
This is the gate a deployment consults in front of the real GSP/portal connector; enforcing it on the
live submit path (default-off, with the tenant flag seeded in those tests) is a follow-up increment.

## Reconciliation for stuck / async e-invoices (item 2 inc1)

The IRP is asynchronous and can time out: an invoice can sit `submitted` with no answer, or land in
`pending_unknown` (a timeout — the IRN status is genuinely unknown, and the invoice is **not** e-invoiced
until the IRP confirms it). This adds the operator tools to resolve those safely, without ever fabricating
the government's signature.

- **Queue vocabulary** — `eInvoiceQueueCategory(state)` maps the lifecycle to an operator category
  (`processing` / `registered` / `rejected` / `unknown` / `error` / `cancelled`); `isEInvoiceException(state)`
  flags the three that need attention (`pending_unknown`, `provider_error`, `rejected`).
- **Poll (acknowledgement recovery)** — `POST /v1/finance/e-invoice/invoices/:id/poll` re-queries the
  (sandbox) IRP for a `submitted`/`pending_unknown` invoice and applies the answer through the
  never-fabricate `applyIrpResult`, so a lost acknowledgement is recovered without manual data entry. A
  terminal invoice (`registered`/`cancelled`/`rejected`) is a **safe no-op** — no duplicate registration.
- **Exception queue** — `GET /v1/finance/e-invoice/register?state=` lists every invoice's operator status,
  filterable by category or `exceptions`. It folds a tenant-wide index (`eInvoiceAdapter` writes an atomic
  `EInvoiceIndexed` fact beside each submit), so the queue is cheap; tenant-isolated and read-gated.

Sandbox only — a live GSP/IRP connection stays externally blocked and off-by-default (portal switch above).
Tested in `tests/unit/e-invoice-reconciliation.test.ts` and `tests/integration/e-invoice-reconciliation.test.ts`.
The e-way-bill equivalent is the next increment.

## Mismatch detection (item 2 inc4)

Poll resolves a *stuck* invoice; it deliberately leaves a **terminal** one alone. But a stored IRN can
silently drift from what the IRP holds. `POST /v1/finance/e-invoice/invoices/:id/verify` closes that:

- It re-queries the IRP for a **registered/cancelled** invoice (an in-flight one is refused with a 422
  pointing at poll) and **compares** the answer against the stored IRN via the pure `detectEInvoiceMismatch`.
- On **agreement** (same IRN) it is a no-op — nothing written.
- On a **disagreement** (a different registered IRN, or the IRP now reporting the invoice as rejected while
  an IRN is on file) it records a `MismatchObserved` fact — an **additive flag**, never an overwrite of the
  stored IRN (**hard rule #10**). `foldEInvoice` applies the flag without changing the state or the IRN, and
  `eInvoiceRowCategory`/`eInvoiceNeedsAttention` move the invoice into the **`mismatch`** queue category
  (and the `exceptions` filter). A human reconciles it out of band; the software never picks a winner.

The connector's own observation can be posted directly (`observed`), or the sandbox is re-queried
(`sandbox.forceOutcome`). Tested in the same two files (detector + additive replay-safe fold; agreement
no-ops; a forced rejection and a connector-observed different IRN both flag without overwriting;
`mismatch`/`exceptions` queue; in-flight 422; RBAC 403). The e-way-bill twin (`detectEwbMismatch` +
`…/verify`) mirrors it exactly.
