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
