// The CUSTOMER DISPLAY (D04-FR-05 · M12-FR-01 "drive a customer display — all from the local edge with no cloud
// round-trip" · P-01 · hard rule #3).
//
// What the customer sees on the screen facing them: each line as it is rung, the saving, and the amount to pay — from the
// till's OWN basket, the moment it changes, with no network at all. The till hands a FRAME to a display port; in a browser
// the port is a BroadcastChannel to a second window on the same till computer (the display page), so it works with the
// cable out. A hardware pole display or a second monitor driven another way is the same port with another adapter — that
// device is external (a physical gate), the frame is not.
//
// The frame carries nothing a customer must not see: no cashier PIN or token, no card data (hard rule #3), no cost, no
// other bill. Pure: no clock, no I/O.

/** One line as the customer sees it. */
export interface DisplayLine {
  readonly description: string;
  readonly qty: number;
  readonly uom: string;
  readonly amountMinor: number;
}

/** Everything the customer display shows at one moment. */
export interface CustomerDisplayFrame {
  /** `idle` between customers (a welcome), `basket` while items are being rung. */
  readonly state: 'idle' | 'basket';
  readonly laneId: string | null;
  readonly lines: readonly DisplayLine[];
  /** The promotion saving on the bill (0 when none). */
  readonly savedMinor: number;
  /** What the customer pays. */
  readonly payableMinor: number;
  readonly currency: string;
  /** A counter that rises with every frame the till publishes — a display drops a frame older than one it showed. */
  readonly seq: number;
}

/**
 * The channel the till and its display page share. A BroadcastChannel never leaves one browser on one computer, and one
 * till computer runs one till — so one name; the frame still names its lane, and the display shows it.
 */
export const CUSTOMER_DISPLAY_CHANNEL = 'sre-customer-display';

/** Build the frame from the till's basket and totals. Voided lines are not shown; an empty basket is a welcome. */
export function customerDisplayFrame(input: {
  readonly laneId: string | null;
  readonly basket: readonly { readonly description: string; readonly qty: number; readonly uom: string; readonly voided: boolean }[];
  /** The active lines' amounts before the offer, in basket order (the till's own arithmetic — never recomputed here). */
  readonly lineTotalsMinor: readonly number[];
  readonly promotionDiscountMinor: number;
  readonly payableMinor: number;
  readonly currency: string;
  readonly seq: number;
}): CustomerDisplayFrame {
  const active = input.basket.filter((l) => !l.voided);
  const lines = active.map((l, i) => ({ description: l.description, qty: l.qty, uom: l.uom, amountMinor: input.lineTotalsMinor[i] ?? 0 }));
  return {
    state: lines.length === 0 ? 'idle' : 'basket',
    laneId: input.laneId, lines,
    savedMinor: Math.max(0, input.promotionDiscountMinor),
    payableMinor: lines.length === 0 ? 0 : input.payableMinor,
    currency: input.currency, seq: input.seq,
  };
}

/** Where a frame goes. The browser adapter is a BroadcastChannel; a pole display is another adapter (external). */
export interface CustomerDisplayPort {
  show(frame: CustomerDisplayFrame): void;
}

/** A port that remembers what it was shown — the stand-in for tests and for a till with no display attached. */
export function recordingDisplay(): CustomerDisplayPort & { readonly shown: CustomerDisplayFrame[] } {
  const shown: CustomerDisplayFrame[] = [];
  return { shown, show: (frame) => { shown.push(frame); } };
}
