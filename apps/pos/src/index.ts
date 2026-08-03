// Public surface of the POS app shell (M12 / D04) — the cashier terminal session
// that composes the tested engines behind the Sale screen. Synchronous by
// construction: a sale never awaits the network (hard rule #1).

export * from './session';
