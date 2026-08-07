// Public surface of @sre/returns — the local return/refund commit (M13): put the
// goods back in the right stock state, refund honestly (card/UPI reversals stay
// pending), and gate material/no-receipt refunds on a separate human approver.
// Composes the foundation; works offline. Grows one reviewed, tested unit at a time.

export * from './returns';
export * from './return-register';
