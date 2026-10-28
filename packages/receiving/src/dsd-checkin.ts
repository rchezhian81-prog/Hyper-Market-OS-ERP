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
import { manufactureDateVerdict, batchTrackedVerdict } from './capture';

/** An expiry date as the door keys it: a real calendar date, YYYY-MM-DD. */
const EXPIRY_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const isDsdExpiryDate = (v: unknown): v is string => typeof v === 'string' && EXPIRY_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * B4 · OB-504 (round 11, the DSD door): judge one scan's batch facts by the SAME packed-goods rule every other receiving path
 * uses (capture.ts `manufactureDateVerdict`) — a packed product needs its month and year of manufacture; a date given must
 * read as one; an expiry given must be a real date. `packaged` is the product master's word (on the handheld: the store
 * pack's `packedProductIds`; at head office: its own product master), never the scan's. Undefined = the scan may be taken.
 */
export function dsdScanCaptureRefusal(scan: Pick<DsdScan, 'productId' | 'batchId' | 'expiry' | 'manufacturedOn'>, packaged: boolean, batchTracked = false): DsdRefusedError | undefined {
  // OB-605 (owner, 28 Oct 2026): a BATCH-TRACKED product needs its batch and its expiry — the goods receipt's own rule
  // (capture.ts `batchTrackedVerdict`), applied per scan; `batchTracked` is the product master's word, never the scan's.
  const tracked = batchTrackedVerdict(batchTracked, scan.batchId, scan.expiry);
  if (tracked === 'batch_missing') return new DsdRefusedError('batch_required', `${scan.productId} is batch-tracked: scan the batch number on the pack before it is scanned in (OB-605).`);
  if (tracked === 'expiry_missing') return new DsdRefusedError('expiry_required', `${scan.productId} is batch-tracked: key the expiry date printed on the pack before it is scanned in (OB-605).`);
  const verdict = manufactureDateVerdict(packaged, scan.manufacturedOn);
  if (verdict === 'missing') return new DsdRefusedError('manufacture_date_required', `${scan.productId} is a packed product: key the month and year of manufacture printed on the pack (YYYY-MM) before it is scanned in (OB-504).`);
  if (verdict === 'unreadable') return new DsdRefusedError('manufacture_date_required', `The manufacture date "${String(scan.manufacturedOn)}" for ${scan.productId} cannot be read: it is written YYYY-MM (or YYYY-MM-DD), as printed on the pack (OB-504).`);
  if (scan.expiry !== undefined && !isDsdExpiryDate(scan.expiry)) return new DsdRefusedError('expiry_not_readable', `The expiry "${scan.expiry}" for ${scan.productId} is not a date (YYYY-MM-DD).`);
  return undefined;
}

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

export interface DsdScan {
  readonly scanId: string; readonly productId: string; readonly quantityMinor: number; readonly at: string;
  /** B4 · OB-504 (round 11): the batch printed on the pack, as scanned off its label; absent when none was taken. */
  readonly batchId?: string;
  /** B4 · OB-504 (round 11): the batch's expiry date (YYYY-MM-DD), as printed; absent when none was taken. */
  readonly expiry?: string;
  /** B4 · OB-504 (round 11): the batch's month and year (YYYY-MM) or date of manufacture — required for a PACKED product. */
  readonly manufacturedOn?: string;
}
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
  /**
   * OB-604 (owner, 28 Oct 2026): the product's quantities SPLIT BY BATCH — present whenever a scan of it named batch facts
   * (batch, expiry or month of manufacture), one entry per distinct batch in the order it first came off the van. Each batch
   * becomes its own received (and, if held, its own held) movement, so a recall knows how much of each came in. How the
   * product's figures are split (said, never guessed silently):
   *   • goods HANDED BACK name no batch at the door — they come off the batch scanned LAST first (the newest crate on the trolley);
   *   • what is RECEIVABLE within the order is taken from the batches in the order they were first scanned; the rest of each
   *     batch's kept goods is HELD for a second person;
   *   • a SHORTAGE or EXCESS is against the order, which names products, not batches — it stays one discrepancy per product.
   * The batch parts always add up to the line's own figures.
   */
  readonly batches?: readonly DsdBatchPart[];
}

/** OB-604: one batch's share of a product's line at the door. */
export interface DsdBatchPart {
  readonly batchId: string | null;
  readonly expiry: string | null;
  readonly manufacturedOn: string | null;
  readonly scannedMinor: number;
  readonly handedBackMinor: number;
  readonly keptMinor: number;
  readonly receivableMinor: number;
  readonly heldMinor: number;
}

/**
 * OB-604: the deterministic key of a batch part — from its batch, expiry and month of manufacture only (never the scan order),
 * so a replayed close or decision derives the SAME movement id and never double-posts.
 */
export const dsdBatchKey = (b: Pick<DsdBatchPart, 'batchId' | 'expiry' | 'manufacturedOn'>): string =>
  [b.batchId ?? '', b.expiry ?? '', b.manufacturedOn ?? ''].map((x) => encodeURIComponent(x)).join('~');

/** OB-604: split a product's scans into batch parts (see `DsdLine.batches`). Undefined when no scan named a batch fact. */
function batchPartsOf(scans: readonly DsdScan[], handedBackMinor: number, receivableMinor: number): readonly DsdBatchPart[] | undefined {
  const parts = new Map<string, { batchId: string | null; expiry: string | null; manufacturedOn: string | null; scannedMinor: number }>();
  for (const s of scans) {
    const b = { batchId: s.batchId ?? null, expiry: s.expiry ?? null, manufacturedOn: s.manufacturedOn ?? null };
    const key = dsdBatchKey(b);
    const prior = parts.get(key);
    if (prior === undefined) parts.set(key, { ...b, scannedMinor: s.quantityMinor });
    else prior.scannedMinor += s.quantityMinor;
  }
  const list = [...parts.values()];
  if (!list.some((b) => b.batchId !== null || b.expiry !== null || b.manufacturedOn !== null)) return undefined;
  const back = new Array<number>(list.length).fill(0);
  let toHandBack = handedBackMinor;
  for (let i = list.length - 1; i >= 0 && toHandBack > 0; i -= 1) { const take = Math.min(list[i]!.scannedMinor, toHandBack); back[i] = take; toHandBack -= take; }
  let toReceive = receivableMinor;
  return list.map((b, i) => {
    const kept = b.scannedMinor - back[i]!;
    const receivable = Math.min(kept, toReceive);
    toReceive -= receivable;
    return { ...b, handedBackMinor: back[i]!, keptMinor: kept, receivableMinor: receivable, heldMinor: kept - receivable };
  });
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
    // OB-604: the line split by batch (absent when no scan named a batch fact — the line is then as it always was).
    const batches = batchPartsOf(input.scans.filter((s) => s.productId === productId), hb, receivable);
    lines.push({ productId, expectedMinor: exp, scannedMinor: sc, handedBackMinor: hb, keptMinor: kept, receivableMinor: receivable, heldMinor: held, unitCostMinor: cost, uom, ...(batches === undefined ? {} : { batches }) });
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
