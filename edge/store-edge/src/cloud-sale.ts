// The one place the lane's sale and the cloud's sale contract meet — API-05, §31.1, hard rules #1 #10, P-02.
//
// **The lane and the cloud describe the same sale in two different shapes, and until this file
// nothing translated between them.**
//
// The store edge — the lane, the receipt reprint, the store box's day figures — speaks the record
// the till writes to disk: `id`, `number`, `total`, and a tender as `{ kind, amount: { minor } }`.
// That is the right shape for the edge: it is what the read model folds and what a reprint needs,
// and the field names match the rest of the offline world (`the-lane-reaches-its-disk` fixed the
// lane server to read exactly these).
//
// The cloud intake (`POST /v1/sales`) speaks the other half of the same fix: `saleId`, `totalMinor`,
// a tender `amountMinor`, and — the field the disk record never carried — the `packVersion` the sale
// was priced against, which the intake needs to tell a stale-pack price difference from a real one.
//
// Both shapes are legitimate. What was missing was the seam between them. The sync outbox carried
// the disk record verbatim to `/v1/sales`, which read it, found no `saleId`/`totalMinor`/`packVersion`,
// and answered **400 — not readable as a sale**. A 400 is permanent, so the agent dead-lettered it:
// the money in the drawer, the receipt in the customer's hand, and **no record of the sale in the
// cloud** until a person worked the dead-letter queue. Every piece on either side was built and
// tested; nothing joined them, and nothing failed — which is exactly how it stayed invisible, the
// same way the lane-server field-name mismatch did one layer in.
//
// This maps the edge record onto the cloud contract, once, at the point the sync event is built. It
// is TOLERANT of a record already in the cloud shape (a caller that speaks it, or a future lane that
// does) so it can never make a correct payload wrong. It stamps `packVersion` from the pack the edge
// holds — the pack the lane priced this very sale from — because the disk record does not carry it;
// a record that already names one keeps it. It invents nothing else: a field it cannot read is left
// for the cloud to raise as an exception (P-08), never guessed.

import type { IncomingSale, IncomingSaleLine, IncomingTender } from '../../../services/pos/src/index';

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A tender in either shape → the cloud's `{ kind, amountMinor, ref? }`. */
function toCloudTender(t: unknown): IncomingTender {
  const r = (t ?? {}) as Rec;
  const amountMinor = int(r['amountMinor']) ?? int((r['amount'] as Rec | undefined)?.['minor']);
  const ref = str(r['ref']);
  return {
    kind: str(r['kind']) ?? '',
    ...(amountMinor === undefined ? {} : { amountMinor }),
    ...(ref === undefined ? {} : { ref }),
  } as IncomingTender;
}

/**
 * Translate the edge's sale record into the cloud sale contract, stamping the pack it was priced
 * against. Pure; the record is untrusted JSON off the disk, so every field is read defensively and a
 * missing one becomes an empty/zero the cloud will surface as an exception rather than a silent guess.
 */
export function toCloudSale(record: unknown, packVersion: number): IncomingSale {
  const r = (record !== null && typeof record === 'object' ? record : {}) as Rec;
  const lines: readonly IncomingSaleLine[] = Array.isArray(r['lines'])
    ? (r['lines'] as IncomingSaleLine[])
    : [];
  const tenders: readonly IncomingTender[] = Array.isArray(r['tenders'])
    ? (r['tenders'] as unknown[]).map(toCloudTender)
    : [];
  return {
    saleId: str(r['saleId']) ?? str(r['id']) ?? '',
    receiptNumber: str(r['receiptNumber']) ?? str(r['number']) ?? '',
    laneId: str(r['laneId']) ?? '',
    cashierId: str(r['cashierId']) ?? '',
    tradingDay: str(r['tradingDay']) ?? '',
    committedAt: str(r['committedAt']) ?? '',
    totalMinor: int(r['totalMinor']) ?? int(r['total']) ?? 0,
    currency: str(r['currency']) ?? 'INR',
    // The disk record does not carry it; the edge stamps the pack it holds. A record that already
    // names one (a caller in the cloud shape) keeps its own.
    packVersion: int(r['packVersion']) ?? packVersion,
    lines,
    tenders,
  };
}
