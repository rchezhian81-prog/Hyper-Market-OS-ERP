// OB-256 (owner, 20 Oct 2026, "One 'paid on old' type") · OB-258 ("Ring on both") — the MIRROR PILOT's tender.
//
// In the mirror pilot (OB-248) the old ERP bills every customer and takes every payment; a trained person also rings the
// pilot department's lines on the new till so stock and sales can be compared each evening (MG-10). The new till
// therefore records the money it never touched as ONE non-cash tender kind, `paid_on_old_erp`:
//
//   • it is offered only while the store computer is set for the mirror pilot, and then it is the ONLY tender — for the
//     whole bill, settled, with no change, no card/UPI attempt and no provider reference (no approval copied or invented);
//   • the drawer expects no money from it (the blind cash-up counts `cash` only), and nothing waits on a provider for it,
//     so the day close is not held by it;
//   • a refund keyed on the new till (OB-258) goes back to the same tender, never as cash out of the drawer, and never
//     more than the bill was paid on the old system less what has already come back against it;
//   • head office keeps it as its own kind everywhere it names tenders — never folded into cash, card or UPI (P-08).
//
// The rules live here ONCE, pure, so the till decides before the disk and the store computer decides again before ITS
// disk with the same sentences (hard rule #1: no network in either).

export const PAID_ON_OLD_ERP = 'paid_on_old_erp';

/** What the till and the store computer say, in English. The till shows the same in Tamil from its own word list. */
export const PAID_ON_OLD_ERP_WORDS = {
  /** The tender's name on the till. */
  name: 'Paid on old system',
  /** The tender was used while the store computer is not set for the mirror pilot. */
  notOn: 'Paid on old system is only for the mirror pilot, and this store computer is not set for it. Take the payment another way. Nothing was saved.',
  /** A mirror sale paid any other way, or not for the whole bill. */
  saleNeedsIt: 'Mirror pilot: the customer pays on the old system, so this till records every sale as "Paid on old system" — for the whole bill, nothing else, no change. Nothing was saved.',
  /** A mirror refund given any other way. */
  refundNeedsIt: 'Mirror pilot: the refund is given on the old system and recorded here as "Paid on old system". No money comes out of this drawer. Nothing was recorded.',
  /** An exchange in the mirror pilot. */
  noExchange: 'Mirror pilot: an exchange is not keyed as one on this till. Record the item coming back as a refund (Paid on old system), then ring the new item as a sale. Nothing was recorded.',
  /** A refund to the tender against a bill that was not paid that way, or for more than is left of it. */
  overTheBill: 'This refund is more than this bill was paid on the old system, less what has already come back. Check the bill. Nothing was recorded.',
  /** A refund to the tender against a bill this store computer does not hold. */
  billNotHere: 'This store computer does not hold that bill, so a "Paid on old system" refund cannot be checked against it. Use the bill number from this till, or a return without receipt if the rules allow. Nothing was recorded.',
  /** The mirror pilot is on but guest sales only (OB-252) is not. */
  needsGuestOnly: 'This store computer is set for the mirror pilot but "guest sales only" is off. The mirror pilot needs both. Nothing was saved — tell the owner.',
  /** Said on the till when a refund to the tender is recorded. */
  refundDone: 'Refund recorded against the old system\'s payment. Do not take money from this drawer — give the refund on the old system as usual.',
} as const;

export type MirrorRefusal =
  | 'paid_on_old_erp_not_on'
  | 'mirror_sale_needs_paid_on_old_erp'
  | 'mirror_refund_needs_paid_on_old_erp'
  | 'mirror_no_exchange'
  | 'paid_on_old_erp_over_the_bill'
  | 'paid_on_old_erp_bill_not_here'
  | 'mirror_needs_guest_sales_only';

export interface MirrorRefused { readonly refusedBecause: MirrorRefusal; readonly laneMessage: string }

const refused = (refusedBecause: MirrorRefusal, laneMessage: string): MirrorRefused => ({ refusedBecause, laneMessage });

/** A tender as either shape carries it: the till's `{ kind, amount: { minor }, status }` or the cloud's `{ kind, amountMinor }`. */
const amountOf = (t: Record<string, unknown>): number | undefined => {
  if (typeof t['amountMinor'] === 'number') return t['amountMinor'];
  const a = t['amount'];
  return a !== null && typeof a === 'object' && typeof (a as Record<string, unknown>)['minor'] === 'number' ? (a as Record<string, unknown>)['minor'] as number : undefined;
};
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasValue = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/**
 * May a SALE with these tenders be recorded? `undefined` = yes. With the mirror pilot off, `paid_on_old_erp` is refused;
 * with it on, the bill is paid by `paid_on_old_erp` ALONE — every tender that kind, settled where a status is given, no
 * provider reference or card facts, adding up to the bill exactly (no change: no money was handed over here).
 */
export function saleTenderRefusal(input: { readonly mirrorOn: boolean; readonly totalMinor: number; readonly tenders: unknown }): MirrorRefused | undefined {
  const tenders = Array.isArray(input.tenders) ? input.tenders : [];
  const usesIt = tenders.some((t) => isObj(t) && t['kind'] === PAID_ON_OLD_ERP);
  if (!input.mirrorOn) return usesIt ? refused('paid_on_old_erp_not_on', PAID_ON_OLD_ERP_WORDS.notOn) : undefined;
  const allIt = tenders.length > 0 && tenders.every((t) => isObj(t) && t['kind'] === PAID_ON_OLD_ERP
    && (t['status'] === undefined || t['status'] === 'settled') && !hasValue(t['ref']) && !hasValue(t['card']) && Number.isInteger(amountOf(t)) && (amountOf(t) ?? 0) >= 0);
  const sum = tenders.reduce<number>((n, t) => n + (isObj(t) ? amountOf(t) ?? 0 : 0), 0);
  return allIt && sum === input.totalMinor ? undefined : refused('mirror_sale_needs_paid_on_old_erp', PAID_ON_OLD_ERP_WORDS.saleNeedsIt);
}

/**
 * May a REFUND given this way be recorded? `undefined` = yes. With the mirror pilot off, `paid_on_old_erp` is refused
 * (as the refund's tender or an exchange's balance tender); with it on, the refund goes back to `paid_on_old_erp` and an
 * exchange is not keyed as one (the item back is a refund, the new item a sale — both on the old system's payment).
 */
export function refundTenderRefusal(input: { readonly mirrorOn: boolean; readonly refundTender: unknown; readonly exchange?: unknown }): MirrorRefused | undefined {
  const exchange = isObj(input.exchange) ? input.exchange : undefined;
  const usesIt = input.refundTender === PAID_ON_OLD_ERP || exchange?.['balanceTender'] === PAID_ON_OLD_ERP
    || (Array.isArray(exchange?.['topUpTenders']) && (exchange!['topUpTenders'] as unknown[]).some((t) => isObj(t) && t['kind'] === PAID_ON_OLD_ERP));
  if (!input.mirrorOn) return usesIt ? refused('paid_on_old_erp_not_on', PAID_ON_OLD_ERP_WORDS.notOn) : undefined;
  if (exchange !== undefined || input.refundTender === 'exchange') return refused('mirror_no_exchange', PAID_ON_OLD_ERP_WORDS.noExchange);
  return input.refundTender === PAID_ON_OLD_ERP ? undefined : refused('mirror_refund_needs_paid_on_old_erp', PAID_ON_OLD_ERP_WORDS.refundNeedsIt);
}

/**
 * How much more may go back to `paid_on_old_erp` on this bill: what the bill was paid that way, capped at its total,
 * less EVERY refund already against it (any tender — the conservative reading: a bill cannot give back more than it
 * took). A bill not paid that way has no room.
 */
export function paidOnOldErpRoom(input: {
  readonly totalMinor: number;
  readonly tenders: readonly { readonly kind: string; readonly amountMinor: number }[] | undefined;
  readonly priorRefundsMinor: number;
}): number {
  const paid = (input.tenders ?? []).filter((t) => t.kind === PAID_ON_OLD_ERP).reduce((n, t) => n + t.amountMinor, 0);
  return Math.max(0, Math.min(paid, input.totalMinor) - Math.max(0, input.priorRefundsMinor));
}
