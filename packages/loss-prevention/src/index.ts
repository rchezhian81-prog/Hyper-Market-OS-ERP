// Public surface of @sre/loss-prevention — the whole M15 module.
//
//   • `loss-prevention.ts` (M15-FR-01) — configurable void/refund/discount/no-sale/cash
//     anomaly rules over till activity, returning linked exceptions for the owner.
//   • `fraud-signals.ts` (M15-FR-02) — cross-domain signals over coupons, loyalty,
//     cash on delivery and supplier invoices: the places value leaves the business
//     without a cashier touching anything.
//   • `cases.ts` (M15-FR-04) — investigation cases with append-only, sealed evidence
//     and outcomes that measurably tune the rules that raised them.
//
// Pure detection throughout. **Nothing in this package blocks, suspends, cancels or
// reverses anything** — it produces a prioritised list for a person to read (§7
// authority, hard rule #5, AI-NFR-12). Grows one reviewed, tested unit at a time.

export * from './loss-prevention';
export * from './fraud-signals';
export * from './cases';
