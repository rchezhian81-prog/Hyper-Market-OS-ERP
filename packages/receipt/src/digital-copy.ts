// A member's digital copy of a banked bill (R4 · D-28 · OB-214 · OB-222 · hard rules #1, #3).
//
//   • OPT-IN ONLY (OB-214): a copy exists only for a sale banked while the member had digital receipts switched ON in their
//     own app. Nobody is switched on by default; switching off stops new copies.
//   • THE SAME BILL: the same bill number, lines, tax and payments as the paper bill the till printed — built from the
//     BANKED sale head office holds, never re-priced.
//   • CARD = LAST FOUR ONLY (hard rule #3): a card payment shows "card ending 1234" and nothing else — no token, no
//     reference, no network detail beyond the name. Any other payment shows its kind and amount only.
//   • NEVER IN THE WAY OF A SALE (hard rule #1): this reads what was banked after the till synced; the till never waits
//     for it and nothing here can change a sale.
//
// Pure and deterministic.

export interface BankedSaleForCopy {
  readonly saleId: string;
  readonly receiptNumber: string;
  readonly tradingDay: string;
  readonly committedAt: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly customerRef?: string;
  readonly lines: readonly {
    readonly productId: string;
    readonly quantityMinor: number;
    readonly uom: string;
    readonly unitPriceMinor: number;
    readonly lineTotalMinor: number;
    readonly taxRateBps?: number;
  }[];
  readonly tenders: readonly {
    readonly kind: string;
    readonly amountMinor: number;
    readonly card?: { readonly last4?: unknown; readonly network?: unknown };
  }[];
}

export interface DigitalReceiptCopy {
  readonly receiptNumber: string;
  readonly saleId: string;
  readonly tradingDay: string;
  readonly committedAt: string;
  readonly currency: string;
  readonly lines: readonly { readonly productId: string; readonly name: string; readonly quantityMinor: number; readonly uom: string; readonly unitPriceMinor: number; readonly lineTotalMinor: number }[];
  /** GST inside the bill, per rate — the till's inclusive split. A line with no rate is counted in `taxNotKnownMinor`. */
  readonly taxBands: readonly { readonly rateBps: number; readonly netMinor: number; readonly taxMinor: number }[];
  readonly taxMinor: number;
  /** Line value whose tax rate the banked bill did not carry — said, never guessed as zero (P-08). */
  readonly taxNotKnownMinor: number;
  readonly totalMinor: number;
  readonly payments: readonly { readonly kind: string; readonly amountMinor: number; readonly cardLast4?: string; readonly say: string }[];
}

/** One choice the member made in their own app — append-only; the latest at a moment decides. */
export interface DigitalReceiptChoice {
  readonly customerRef: string;
  readonly on: boolean;
  readonly at: string;
}

/** Was the member switched ON at this moment? Off unless their latest choice at or before it says on (default OFF). */
export function switchedOnAt(choices: readonly DigitalReceiptChoice[], at: string): boolean {
  let on = false;
  for (const c of [...choices].sort((a, b) => a.at.localeCompare(b.at))) if (c.at <= at) on = c.on;
  return on;
}

const inr = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;
const LAST4 = /^[0-9]{4}$/;

/** The member's copy of one banked bill. `nameOf` gives each product's name from the catalogue (the id when unknown). */
export function digitalCopyOf(sale: BankedSaleForCopy, nameOf: (productId: string) => string | undefined = () => undefined): DigitalReceiptCopy {
  const bands = new Map<number, { gross: number }>();
  let taxNotKnownMinor = 0;
  for (const l of sale.lines) {
    if (l.taxRateBps === undefined || !Number.isInteger(l.taxRateBps) || l.taxRateBps < 0) { taxNotKnownMinor += l.lineTotalMinor; continue; }
    const b = bands.get(l.taxRateBps) ?? { gross: 0 };
    b.gross += l.lineTotalMinor;
    bands.set(l.taxRateBps, b);
  }
  const taxBands = [...bands.entries()].sort((a, b) => a[0] - b[0]).map(([rateBps, b]) => {
    const netMinor = Math.round((b.gross * 10_000) / (10_000 + rateBps));
    return { rateBps, netMinor, taxMinor: b.gross - netMinor };
  });
  return {
    receiptNumber: sale.receiptNumber, saleId: sale.saleId, tradingDay: sale.tradingDay, committedAt: sale.committedAt, currency: sale.currency,
    lines: sale.lines.map((l) => ({ productId: l.productId, name: nameOf(l.productId) ?? l.productId, quantityMinor: l.quantityMinor, uom: l.uom, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor })),
    taxBands, taxMinor: taxBands.reduce((t, b) => t + b.taxMinor, 0), taxNotKnownMinor, totalMinor: sale.totalMinor,
    // Hard rule #3: from a card payment ONLY the last four digits are carried — no token, no reference, nothing else.
    payments: sale.tenders.map((t) => {
      const last4 = t.kind === 'card' && typeof t.card?.last4 === 'string' && LAST4.test(t.card.last4) ? t.card.last4 : undefined;
      return {
        kind: t.kind, amountMinor: t.amountMinor, ...(last4 === undefined ? {} : { cardLast4: last4 }),
        say: t.kind === 'card' ? `Card${last4 === undefined ? '' : ` ending ${last4}`} ${inr(t.amountMinor)}` : `${t.kind.replace(/_/g, ' ')} ${inr(t.amountMinor)}`,
      };
    }),
  };
}

/** OB-222: sending by SMS or WhatsApp is built switched OFF. This is the only answer the send path gives while off. */
export const RECEIPT_SENDING = Object.freeze({
  switchedOn: false,
  channels: ['sms', 'whatsapp'] as const,
  say: 'Sending receipts by SMS or WhatsApp is switched off — nothing is sent. Your receipts are here in the app.',
});
