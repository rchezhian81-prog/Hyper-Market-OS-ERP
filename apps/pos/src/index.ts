// Public surface of the POS app shell (M12 / D04) — the cashier terminal session
// that composes the tested engines behind the Sale screen. Synchronous by
// construction: a sale never awaits the network (hard rule #1).

export * from './session';
export * from './view-adapter';

// The till itself: money in and out of the drawer, refunds, and closing the shift.
export * from './till-session';

// The refund screen's tested view surface — display primitives in, one plain-English screen state
// out. The web UI (a following slice) binds to this; the money rules stay in the engine behind it.
export * from './refund-view';
