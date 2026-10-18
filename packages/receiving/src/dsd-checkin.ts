// D-11 (R3, OB-141 "A") — direct-store-delivery (DSD) door check-in. Pure and deterministic.
//
// Signed test sentence: "a DSD delivery is checked in against its vendor and PO or route. Every scan difference is
// captured as a discrepancy line. Goods handed back are recorded as an on-spot return linked to a debit note. The delivery
// cannot close until settlement is recorded per the Q10 answer." OB-141 (Q10 "A"): NO CASH AT THE DOOR — the driver gets
// a signed delivery note listing what was kept and what was handed back, and the bill is paid later like any supplier bill.
//
// The rules, in full:
//   • the delivery is judged against what head office expects: the purchase order's lines, or the vendor's route sheet;
//   • every difference between what was SCANNED and what was EXPECTED is a discrepancy line: `short` (fewer than expected),
//     `over` (more than expected), `not_expected` (an item on neither the order nor the route sheet);
//   • goods HANDED BACK to the driver are an on-spot return, each linked to the delivery's one debit note; nothing can be
//     handed back that was not scanned in;
//   • KEPT = scanned − handed back. What is kept within the order is received; what is kept beyond the order — or anything
//     kept from a route sheet, which carries no purchase order — is HELD for a second person (the existing DSD rule,
//     packages/receiving/src/asn.ts `dsd_needs_approval`: every DSD needs a second person until the owner raises the cap);
//   • the delivery CLOSES only with a signed delivery note (the driver's name, the receiver, when) that states the kept and
//     handed-back lines; the settlement is always `supplier_bill_later`. Any cash, tender or payment at the door is refused
//     by name (`no_cash_at_the_door`) — there is no field for it and no override.

import { valueAtUnitCost } from '../../contracts/src/quantity';
import { DEFAULT_RECEIVING_POLICY } from './asn';

/** Why goods were handed back to the driver — from the receiving engine's own conditions and outcomes. */
export const DSD_HAND_BACK_REASONS = Object.freeze(['damaged', 'temperature_breach', 'expired', 'not_ordered', 'other'] as const);
export type DsdHandBackReason = (typeof DSD_HAND_BACK_REASONS)[number];
export const isDsdHandBackReason = (v: unknown): v is DsdHandBackReason => typeof v === 'string' && (DSD_HAND_BACK_REASONS as readonly string[]).includes(v);

export interface DsdExpectedLine {
  readonly productId: string;
  readonly expectedMinor: number;
  /** Cost per whole unit, minor units, from the order line or the route sheet; undefined when not known. */
  readonly unitCostMinor?: number;
  readonly uom?: string;
}

export interface DsdScan { readonly scanId: string; readonly productId: string; readonly quantityMinor: number; readonly at: string }
export interface DsdHandBack { readonly handBackId: string; readonly productId: string; readonly quantityMinor: number; readonly reason: DsdHandBackReason; readonly note: string | null; readonly at: string }

export type DsdDiscrepancyKind = 'short' | 'over' | 'not_expected';
export interface DsdDiscrepancy { readonly productId: string; readonly kind: DsdDiscrepancyKind; readonly expectedMinor: number; readonly scannedMinor: number; readonly differenceMinor: number }

export interface DsdLine {
  readonly productId: string;
  readonly expectedMinor: number;
  readonly scannedMinor: number;
  readonly handedBackMinor: number;
  readonly keptMinor: number;
  /** Kept and within the order: received at close. */
  readonly receivableMinor: number;
  /** Kept beyond the order, or kept from a route sheet: held for a second person. */
  readonly heldMinor: number;
  readonly unitCostMinor: number | null;
  readonly uom: string;
}

export interface DsdReconciliation {
  readonly lines: readonly DsdLine[];
  readonly discrepancies: readonly DsdDiscrepancy[];
  readonly handedBack: readonly DsdHandBack[];
  /** Σ handed back at cost — the debit note's value; null when a handed-back line has no known cost (said, never zero). */
  readonly handedBackValueMinor: number | null;
  readonly heldValueMinor: number | null;
}

export class DsdRefusedError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DsdRefusedError'; }
}

const sumBy = <T>(xs: readonly T[], key: (x: T) => string, qty: (x: T) => number): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + qty(x));
  return m;
};

/** Reconcile what came off the van against what head office expects. `against` says whether there is an order. */
export function reconcileDsd(input: {
  readonly against: 'po' | 'route';
  readonly expected: readonly DsdExpectedLine[];
  readonly scans: readonly DsdScan[];
  readonly handBacks: readonly DsdHandBack[];
}): DsdReconciliation {
  for (const s of input.scans) if (!Number.isSafeInteger(s.quantityMinor) || s.quantityMinor <= 0) throw new DsdRefusedError('not_a_quantity', `Scan ${s.scanId} must be a whole positive quantity.`);
  for (const h of input.handBacks) {
    if (!Number.isSafeInteger(h.quantityMinor) || h.quantityMinor <= 0) throw new DsdRefusedError('not_a_quantity', `Hand-back ${h.handBackId} must be a whole positive quantity.`);
    if (!isDsdHandBackReason(h.reason)) throw new DsdRefusedError('no_reason', `Hand-back ${h.handBackId} needs a reason from ${DSD_HAND_BACK_REASONS.join(' / ')}.`);
  }
  const expected = new Map(input.expected.map((e) => [e.productId, e] as const));
  const scanned = sumBy(input.scans, (s) => s.productId, (s) => s.quantityMinor);
  const back = sumBy(input.handBacks, (h) => h.productId, (h) => h.quantityMinor);
  for (const [p, q] of back) {
    if (q > (scanned.get(p) ?? 0)) throw new DsdRefusedError('hand_back_more_than_scanned', `${q} of ${p} handed back but only ${scanned.get(p) ?? 0} scanned in — only goods that came off the van can be handed back.`);
  }
  const ids = [...new Set([...expected.keys(), ...scanned.keys()])].sort();
  const lines: DsdLine[] = [];
  const discrepancies: DsdDiscrepancy[] = [];
  let backValue: number | null = 0; let heldValue: number | null = 0;
  for (const productId of ids) {
    const e = expected.get(productId);
    const exp = e?.expectedMinor ?? 0;
    const sc = scanned.get(productId) ?? 0;
    const hb = back.get(productId) ?? 0;
    const kept = sc - hb;
    const receivable = input.against === 'po' ? Math.min(kept, exp) : 0;
    const held = kept - receivable;
    const uom = e?.uom ?? 'ea';
    const cost = e?.unitCostMinor ?? null;
    lines.push({ productId, expectedMinor: exp, scannedMinor: sc, handedBackMinor: hb, keptMinor: kept, receivableMinor: receivable, heldMinor: held, unitCostMinor: cost, uom });
    if (e === undefined) discrepancies.push({ productId, kind: 'not_expected', expectedMinor: 0, scannedMinor: sc, differenceMinor: sc });
    else if (sc < exp) discrepancies.push({ productId, kind: 'short', expectedMinor: exp, scannedMinor: sc, differenceMinor: sc - exp });
    else if (sc > exp) discrepancies.push({ productId, kind: 'over', expectedMinor: exp, scannedMinor: sc, differenceMinor: sc - exp });
    const value = (q: number): number | null => (q === 0 ? 0 : cost === null ? null : valueAtUnitCost(q, uom, cost));
    const bv = value(hb); const hv = value(held);
    backValue = backValue === null || bv === null ? null : backValue + bv;
    heldValue = heldValue === null || hv === null ? null : heldValue + hv;
  }
  return { lines, discrepancies, handedBack: input.handBacks, handedBackValueMinor: backValue, heldValueMinor: heldValue };
}

/** Whether kept goods held beyond the order need a second person (the existing DSD cap, owner-raisable). */
export const heldNeedsSecondPerson = (heldValueMinor: number | null, capMinor = DEFAULT_RECEIVING_POLICY.dsdApprovalAboveMinor): boolean =>
  heldValueMinor === null || heldValueMinor > capMinor;

/** The fields a close must never carry (OB-141): cash, tender or payment at the door. */
export const CASH_AT_THE_DOOR_FIELDS = Object.freeze(['cash', 'cashMinor', 'tender', 'tenders', 'payment', 'paymentMinor', 'paidMinor', 'amountPaidMinor', 'settlementCashMinor']);

export interface DsdDeliveryNote {
  readonly noteRef: string;
  /** The driver's name as they signed the note. */
  readonly driverSignedName: string;
  /** The person who received (the signed-in user, never typed). */
  readonly receiverId: string;
  readonly signedAt: string;
  readonly kept: readonly { readonly productId: string; readonly quantityMinor: number }[];
  readonly handedBack: readonly { readonly productId: string; readonly quantityMinor: number; readonly reason: DsdHandBackReason }[];
  readonly settlement: 'supplier_bill_later';
}

/** Build the signed delivery note a close records. Refuses cash at the door and an unsigned note, by name. */
export function signDeliveryNote(input: {
  readonly body: Readonly<Record<string, unknown>>;
  readonly reconciliation: DsdReconciliation;
  readonly receiverId: string;
  readonly at: string;
}): DsdDeliveryNote {
  const cash = CASH_AT_THE_DOOR_FIELDS.filter((f) => input.body[f] !== undefined);
  const nested = input.body['deliveryNote'];
  const note = nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : undefined;
  const nestedCash = note === undefined ? [] : CASH_AT_THE_DOOR_FIELDS.filter((f) => note[f] !== undefined);
  if (cash.length + nestedCash.length > 0 || (input.body['settlement'] !== undefined && input.body['settlement'] !== 'supplier_bill_later')) {
    throw new DsdRefusedError('no_cash_at_the_door', `No cash is paid at the door for a direct delivery (OB-141). The driver gets the signed delivery note and the supplier is paid later, as a supplier bill. Refused: ${[...cash, ...nestedCash, ...(input.body['settlement'] !== undefined ? ['settlement'] : [])].join(', ')}.`);
  }
  const signed = note?.['driverSignedName'];
  const ref = note?.['noteRef'];
  if (typeof signed !== 'string' || signed.trim() === '' || typeof ref !== 'string' || ref.trim() === '') {
    throw new DsdRefusedError('delivery_note_not_signed', 'The delivery cannot close until the delivery note is signed: it needs the note reference and the driver\'s name as signed (OB-141).');
  }
  return {
    noteRef: ref.trim(), driverSignedName: signed.trim(), receiverId: input.receiverId, signedAt: input.at,
    kept: input.reconciliation.lines.filter((l) => l.keptMinor > 0).map((l) => ({ productId: l.productId, quantityMinor: l.keptMinor })),
    handedBack: input.reconciliation.handedBack.map((h) => ({ productId: h.productId, quantityMinor: h.quantityMinor, reason: h.reason })),
    settlement: 'supplier_bill_later',
  };
}
