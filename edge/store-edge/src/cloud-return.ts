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
  /** The bill this return is against; null ONLY for a no-receipt return (no synced endpoint yet). */
  readonly originalSaleId: string | null;
  readonly number: string;
  readonly processedBy: string;
  /** The second person who approved a material refund at the lane (§28); absent when none was needed. */
  readonly approvedBy?: string;
  readonly reasonCode: string;
  readonly refundMinor: number;
  readonly refundTender: string;
  readonly processedAt: string;
  readonly lines: readonly CloudReturnLine[];
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
 * `null` for a no-receipt return — the transport has NO synced endpoint for one and dead-letters it by
 * name (hard rule #6), so squashing null to an empty string here would misroute it. `approvedBy` is
 * carried only when present, so the cloud can tell "no approver" from "this approver" (§28).
 */
export function toCloudReturn(record: unknown): CloudReturn {
  const r = (record !== null && typeof record === 'object' ? record : {}) as Rec;
  const originalSaleId = str(r['originalSaleId']);
  const approvedBy = str(r['approvedBy']);
  const lines: readonly CloudReturnLine[] = Array.isArray(r['lines'])
    ? (r['lines'] as unknown[]).map(toCloudLine)
    : [];
  return {
    returnId: str(r['returnId']) ?? str(r['id']) ?? '',
    // Preserve a genuine null (no-receipt); only an absent/empty value falls back to null.
    originalSaleId: originalSaleId ?? null,
    number: str(r['number']) ?? '',
    processedBy: str(r['processedBy']) ?? '',
    ...(approvedBy === undefined ? {} : { approvedBy }),
    reasonCode: str(r['reasonCode']) ?? '',
    refundMinor: int(r['refundMinor']) ?? 0,
    refundTender: str(r['refundTender']) ?? '',
    processedAt: str(r['processedAt']) ?? '',
    lines,
  };
}

/** The return's identity as written to the disk record — `returnId`, tolerating a bare `id`. */
export function returnIdOf(record: unknown): string | undefined {
  const r = (record !== null && typeof record === 'object' ? record : {}) as Rec;
  return str(r['returnId']) ?? str(r['id']);
}
