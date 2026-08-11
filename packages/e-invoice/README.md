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
