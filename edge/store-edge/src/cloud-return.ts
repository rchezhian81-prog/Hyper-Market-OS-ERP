// The one place the lane's offline return and the cloud's synced-return contract meet —
// M13-FR-01, §31, §28, hard rules #1 #6 #10, P-02. The mirror of `cloud-sale.ts`, for the refund.
//
// A lane takes a refund with the cable out: `packages/returns` `commitReturn` moves the money against
// the local ledger and produces a `ReturnAccepted` payload. The edge durably persists that record and
// queues it; the sync agent later relays it to `POST /v1/sales/:saleId/returns/synced` (the route added
// in the transport-wire slice), which RE-VERIFIES the §28 approver on the cloud.
//
// This maps the edge's return record onto exactly the fields that route reads — `returnId`,
// `originalSaleId` (which `returnAcceptedRoute` turns into the path), `processedBy`, the lane approver
// `approvedBy`, `reasonCode`, `refundMinor`, `refundTender`, and the `lines` the at-most-once guard needs.
// Like `toCloudSale` it is TOLERANT of a record already in the cloud shape (the till mints this exact
// shape today) so it can never make a correct payload wrong, and it INVENTS nothing: a field it cannot
// read is left empty/zero for the cloud to raise as an exception (P-08), never guessed. Unlike the sale,
// there is no pack version to stamp — the refund's authority is decided at the lane and re-checked in
// the cloud, and the edge adds nothing of its own to it.

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A returned line as the cloud reads it: what product, how much, and where the unit goes. */
export interface CloudReturnLine {
  readonly productId: string;
  readonly uom: string;
  readonly quantityMinor: number;
  readonly disposition: string;
}

/** The synced-return payload: exactly the fields `POST /v1/sales/:saleId/returns/synced` reads. */
export interface CloudReturn {
  readonly returnId: string;
  /** The bill this return is against; null ONLY for a no-receipt return (M13-FR-01), which the transport
   *  routes to its own synced endpoint by the `noReceipt` flag below. */
  readonly originalSaleId: string | null;
  /** Set (true) only on a controlled no-receipt return — the transport's routing key for one, and what the
   *  cloud's no-receipt route records. Absent (never false) on a receipted return. */
  readonly noReceipt?: true;
  /** The lane the return was taken at — where a resold no-receipt unit goes back on the shelf when the lane
   *  named no location (the cloud states the assumption on the movement, P-08). */
  readonly laneId?: string;
  readonly number: string;
  readonly processedBy: string;
  /** The second person who approved a material refund at the lane (§28); absent when none was needed. */
  readonly approvedBy?: string;
  readonly reasonCode: string;
  readonly refundMinor: number;
  readonly refundTender: string;
  readonly processedAt: string;
  /** The customer a store-credit refund belongs to (M13-FR-03 / §31); absent for a cash/card refund or
   *  when no customer was captured at the lane. Carried so the cloud issues the credit to them on sync. */
  readonly customerRef?: string;
  /** WHERE a resold unit goes back on the shelf (M08-FR-01 · SP-9b-i · F17): the store this box belongs to, as its
   *  store pack names it — the same basis as the sale's `locationId`. Matters for a NO-RECEIPT return, which has no
   *  bill to take the location from: without it the cloud re-enters the unit at a location named after the LANE
   *  (stated as assumed, P-08) — a shelf nobody sells from, so the store's own figure stays short. A record that
   *  declares one keeps its own; a box that knows no store stamps nothing and the cloud's stated fallback stands. */
  readonly locationId?: string;
  /** Present only when this return is the returning half of an EXCHANGE taken at the till (SP-9b-ii · M13-FR-03):
   *  `refundMinor` is then the value credited against the bill and `refundTender` is `exchange`; this says which
   *  replacement sale the credit paid for, how much was applied, and which way (and how) the balance moved. Carried
   *  as the lane wrote it, every amount read defensively; the cloud records it on the return and the day book clears
   *  the `exchange_credit`. Absent on a plain refund. */
  readonly exchange?: CloudExchangeSettlement;
  /** Who the box verified processed it, sealed (ADR-0023) — carried exactly as written, for head office to check. */
  readonly operatorVerified?: Readonly<Record<string, unknown>>;
  /** The manager's approval the box issued and spent, sealed (ADR-0023) — carried exactly as written. */
  readonly approvalVerified?: Readonly<Record<string, unknown>>;
  readonly lines: readonly CloudReturnLine[];
}

export interface CloudExchangeSettlement {
  readonly exchangeId: string;
  readonly replacementSaleId: string;
  readonly replacementTotalMinor: number;
  readonly appliedMinor: number;
  readonly balance: string;
  readonly balanceMinor: number;
  readonly balanceTender?: string;
  readonly topUpTenders?: readonly { readonly kind: string; readonly amountMinor: number }[];
}

function toCloudExchange(v: unknown, returnId: string): CloudExchangeSettlement | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const x = v as Rec;
  const replacementSaleId = str(x['replacementSaleId']);
  if (replacementSaleId === undefined) return undefined; // not an exchange block we can relay — the cloud sees a plain 'exchange'-tender return and flags it
  const balanceTender = str(x['balanceTender']);
  const topUp = Array.isArray(x['topUpTenders'])
    ? (x['topUpTenders'] as unknown[]).map((t) => { const r = (t ?? {}) as Rec; return { kind: str(r['kind']) ?? '', amountMinor: int(r['amountMinor']) ?? 0 }; })
    : undefined;
  return {
    exchangeId: str(x['exchangeId']) ?? returnId,
    replacementSaleId,
    replacementTotalMinor: int(x['replacementTotalMinor']) ?? 0,
    appliedMinor: int(x['appliedMinor']) ?? 0,
    balance: str(x['balance']) ?? '',
    balanceMinor: int(x['balanceMinor']) ?? 0,
    ...(balanceTender === undefined ? {} : { balanceTender }),
    ...(topUp === undefined ? {} : { topUpTenders: topUp }),
  };
}

function toCloudLine(l: unknown): CloudReturnLine {
  const r = (l ?? {}) as Rec;
  return {
    productId: str(r['productId']) ?? '',
    uom: str(r['uom']) ?? '',
    quantityMinor: int(r['quantityMinor']) ?? 0,
    disposition: str(r['disposition']) ?? '',
  };
}

/**
 * Translate the edge's return record into the cloud synced-return contract. Pure; the record is
 * untrusted JSON off the disk, so every field is read defensively. `originalSaleId` is preserved as
 * `null` for a no-receipt return and `noReceipt: true` is carried with it — the transport routes on the
 * flag to the cloud's own no-receipt route (M13-FR-01), so squashing null to an empty string or dropping
 * the flag here would misroute it (a flagless, bill-less record is dead-lettered by name, hard rule #6).
 * `approvedBy` is carried only when present, so the cloud can tell "no approver" from "this approver" (§28).
 */
export function toCloudReturn(record: unknown, storeId?: string): CloudReturn {
  const r = (record !== null && typeof record === 'object' ? record : {}) as Rec;
  const originalSaleId = str(r['originalSaleId']);
  const approvedBy = str(r['approvedBy']);
  const customerRef = str(r['customerRef']);
  const laneId = str(r['laneId']);
  const locationId = str(r['locationId']) ?? str(storeId);
  const returnId = str(r['returnId']) ?? str(r['id']) ?? '';
  const exchange = toCloudExchange(r['exchange'], returnId);
  const lines: readonly CloudReturnLine[] = Array.isArray(r['lines'])
    ? (r['lines'] as unknown[]).map(toCloudLine)
    : [];
  return {
    returnId,
    // Preserve a genuine null (no-receipt); only an absent/empty value falls back to null.
    originalSaleId: originalSaleId ?? null,
    // The no-receipt flag is the routing key — carried only when the engine set it true (M13-FR-01).
    ...(r['noReceipt'] === true ? { noReceipt: true as const } : {}),
    ...(laneId === undefined ? {} : { laneId }),
    number: str(r['number']) ?? '',
    processedBy: str(r['processedBy']) ?? '',
    ...(approvedBy === undefined ? {} : { approvedBy }),
    reasonCode: str(r['reasonCode']) ?? '',
    refundMinor: int(r['refundMinor']) ?? 0,
    refundTender: str(r['refundTender']) ?? '',
    processedAt: str(r['processedAt']) ?? '',
    // Carried only when present, so a cash/card refund (and one with no customer captured) stays absent —
    // the cloud tells "no customer" apart from "this customer" and record-and-flags the former (P-08).
    ...(customerRef === undefined ? {} : { customerRef }),
    // The store the unit goes back to (F17) — the box's own, unless the record declared one. Absent when neither knows.
    ...(locationId === undefined ? {} : { locationId }),
    // The exchange's settlement, when this return is one (SP-9b-ii) — carried, never invented.
    ...(exchange === undefined ? {} : { exchange }),
    // The box's sealed stamps (ADR-0023): carried, never invented — absent when the box verified nobody.
    ...(isObject(r['operatorVerified']) ? { operatorVerified: r['operatorVerified'] as Record<string, unknown> } : {}),
    ...(isObject(r['approvalVerified']) ? { approvalVerified: r['approvalVerified'] as Record<string, unknown> } : {}),
    lines,
  };
}

const isObject = (v: unknown): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The return's identity as written to the disk record — `returnId`, tolerating a bare `id`. */
export function returnIdOf(record: unknown): string | undefined {
  const r = (record !== null && typeof record === 'object' ? record : {}) as Rec;
  return str(r['returnId']) ?? str(r['id']);
}
