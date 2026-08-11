// Public surface of @sre/finance — the accounting bridge.
//
// Mapping-driven double-entry posting (M23-FR-01/02): operational events become balanced
// journals with GST as a mapped component, from a configurable chart-of-accounts map, and an
// unmapped event surfaces as an exception rather than a silent gap.
//
// Credit and debit notes (M23-FR-02): the invoice is NEVER edited — CGST s.34 arrives at hard
// rule #2 independently, and reissuing an invoice at a lower figure is the commonest
// small-business accounting error there is, producing an input-credit mismatch the buyer
// notices first. Tax reverses in the proportion it was charged, a note is declared in the
// period it was ISSUED, and the section 34(2) deadline is stated plainly rather than
// discovered. Returns are reported split by REASON, each carrying who it is a conversation
// with, and the number that matters most is the value returned with no credit note against
// it — money owed to a customer that no credit-note report can see.

export * from './posting';
export * from './credit-notes';
export * from './inclusive-tax';
export * from './discount';
export * from './promo-tax';
export * from './rate';
export * from './hsn';
export * from './invoice-fields';
export * from './gstr1';
