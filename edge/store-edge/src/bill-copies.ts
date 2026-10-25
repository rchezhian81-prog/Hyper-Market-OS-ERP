// A COPY OF A BILL BY ITS NUMBER, printed at a till through the store computer (OB-373 · M12-FR-02 "digital/print
// receipts" · D04-FR-05 · P-01 · P-08 · hard rules #1, #2, #3 and #6).
//
// The owner decided (25 Oct 2026): a sale paid on a handheld queue till gets its paper bill by REPRINT at a till or the
// service desk, by its bill number — there is no printer on the handheld. The handheld's sale is on THIS store computer's
// disk (its lane `device:<id>` writes through the box, ADR-0028), so any till served by this box can find it — offline.
//
//   • WHO: the person signed in at the till asking (the lane door verified their session — a till sign-in, for selling).
//   • WHAT: the bill this box holds under that number (or sale id) — this till's own, another lane's on this box, or a
//     handheld's. A bill this box does not hold is refused in words: it was rung on another store computer.
//   • THE RECORD FIRST: who printed which copy of which bill, at which till and why is written to the device-events log
//     (fsync'd) BEFORE the bill is answered, and then queued for head office as `BillCopyPrinted` — on the same dedupe set,
//     cursor and dead-letter queue as every relayed record. The copy number counts the copies already printed on this box
//     (the original is never counted); a retry with the same copy id is the same copy.
//   • WHAT IS ANSWERED: the bill exactly as it was saved — lines, prices, tax, tenders, the bill number, the date — never
//     re-priced, and nothing of the customer (no member code, no mobile, no card data: the disk holds none). The item names
//     come from this box's signed catalogue. The till prints it marked DUPLICATE (English or Tamil).

import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { commitLocally, type DurableLog } from './durability';

/** The event type head office's synced route takes it under. */
export const BILL_COPY_EVENT = 'BillCopyPrinted';

/** A prior copy of a bill, as this box's device-events log holds it. */
export interface PriorCopy { readonly copyId: string; readonly saleId: string; readonly copyNumber: number }

export interface BillCopyBoxDeps {
  readonly tenantId: string;
  /** Every device-event key this box has ever taken (shared with the device relay — one dedupe set). */
  readonly keys: Set<string>;
  readonly log: DurableLog;
  readonly outbox: SyncOutbox;
  readonly now: () => string;
  /** The shop's trading day an instant belongs to (the store pack's cut-off). */
  readonly tradingDayOf: (atIso: string) => string;
  /** The sale on this box's disk with this bill number (or sale id) — any lane this box numbers. Undefined = not here. */
  readonly findSale: (numberOrId: string) => Promise<Readonly<Record<string, unknown>> | undefined>;
  /** Every copy of a bill this box has printed (from its device-events log). */
  readonly priorCopies: () => Promise<readonly PriorCopy[]>;
  /** An item's names from this box's signed catalogue. */
  readonly productName: (productId: string) => { readonly name: string; readonly nameTa?: string } | undefined;
}

export type BillCopyAnswer =
  | {
    readonly printed: true; readonly copyId: string; readonly copyNumber: number; readonly billNumber: string; readonly saleId: string; readonly billLaneId: string;
    readonly bill: Readonly<Record<string, unknown>>; readonly names: Readonly<Record<string, { readonly name: string; readonly nameTa?: string }>>;
    readonly laneMessage: string; readonly laneMessageTa: string; readonly alreadyPrinted?: true;
  }
  | { readonly printed: false; readonly refusedBecause: string; readonly laneMessage: string; readonly laneMessageTa: string };

const isStr = (v: unknown, max = 120): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const pick = (o: Rec, keys: readonly string[]): Rec => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** The bill as it was saved, with nothing of the customer — what the till prints a copy from. */
export function billOfRecord(r: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const lines = (Array.isArray(r['lines']) ? r['lines'] : []).filter(isObj)
    .map((l) => pick(l, ['productId', 'quantityMinor', 'uom', 'unitPriceMinor', 'lineTotalMinor', 'taxRateBps', 'hsnCode', 'cess', 'cessMinor', 'huid', 'batchId']));
  const tenders = (Array.isArray(r['tenders']) ? r['tenders'] : []).filter(isObj).map((t) => {
    const amount = typeof t['amountMinor'] === 'number' ? t['amountMinor'] : isObj(t['amount']) && typeof t['amount']['minor'] === 'number' ? t['amount']['minor'] : undefined;
    return { kind: t['kind'], ...(amount === undefined ? {} : { amountMinor: amount }), ...(isStr(t['machineRef']) ? { machineRef: t['machineRef'] } : {}) };
  });
  return {
    ...pick(r as Rec, ['id', 'number', 'receiptNumber', 'laneId', 'cashierId', 'tradingDay', 'committedAt', 'total', 'netMinor', 'taxMinor', 'cessMinor', 'roundOffMinor', 'currency']),
    lines, tenders,
  };
}

const W = (en: string, ta: string) => ({ laneMessage: en, laneMessageTa: ta });

/** The box's decision for one copy (the till's person already verified by the lane door). */
export function billCopyRecorder(deps: BillCopyBoxDeps): (input: { readonly laneId: string; readonly cashierId: string; readonly via: string; readonly body: Record<string, unknown> }) => Promise<BillCopyAnswer> {
  // One copy at a time, so two tills asking for the same bill at once get copy 1 and copy 2 — never two copy 1s.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = chain.then(fn, fn); chain = next.catch(() => undefined); return next; };
  return (input) => serial(async (): Promise<BillCopyAnswer> => {
    const { laneId, cashierId, via, body } = input;
    if (!isStr(body['copyId']) || !isStr(body['billNumber'], 60) || !isStr(body['reason'], 300)) {
      return { printed: false, refusedBecause: 'not_readable', ...W('Type the bill number and choose why a copy is needed. Nothing was printed.', 'பில் எண்ணைத் தட்டச்சு செய்து, நகல் ஏன் தேவை என்பதைத் தேர்ந்தெடுக்கவும். எதுவும் அச்சிடப்படவில்லை.') };
    }
    const copyId = body['copyId'].trim();
    const asked = body['billNumber'].trim();
    const record = await deps.findSale(asked);
    if (record === undefined) {
      return {
        printed: false, refusedBecause: 'bill_not_on_this_store_computer',
        ...W(`Bill ${asked} is not on this store computer. Check the number on the customer's screen or slip — a bill rung on another store computer is printed at a till of that store computer. Nothing was printed.`,
          `பில் ${asked} இந்தக் கடை கணினியில் இல்லை. வாடிக்கையாளரின் திரை அல்லது சீட்டில் உள்ள எண்ணைச் சரிபார்க்கவும் — வேறு கடை கணினியில் போடப்பட்ட பில் அந்தக் கணினியின் பில்லிங்கில் அச்சிடப்படும். எதுவும் அச்சிடப்படவில்லை.`),
      };
    }
    const saleId = String(record['id'] ?? asked);
    const billNumber = String(record['number'] ?? record['receiptNumber'] ?? asked);
    const billLaneId = isStr(record['laneId']) ? record['laneId'] : 'unknown';
    const bill = billOfRecord(record);
    const names: Record<string, { name: string; nameTa?: string }> = {};
    for (const l of bill['lines'] as Rec[]) {
      const id = typeof l['productId'] === 'string' ? l['productId'] : '';
      const n = deps.productName(id);
      if (n !== undefined) names[id] = n;
    }
    const prior = await deps.priorCopies();
    const same = prior.find((c) => c.copyId === copyId);
    if (same !== undefined) {
      if (same.saleId !== saleId) {
        return { printed: false, refusedBecause: 'copy_id_reused', ...W('That copy was for another bill. Ask again. Nothing was printed.', 'அந்த நகல் வேறு பில்லுக்கானது. மீண்டும் கேட்கவும். எதுவும் அச்சிடப்படவில்லை.') };
      }
      return { printed: true, alreadyPrinted: true, copyId, copyNumber: same.copyNumber, billNumber, saleId, billLaneId, bill, names, ...W(`Copy ${same.copyNumber} of bill ${billNumber}.`, `பில் ${billNumber} — நகல் ${same.copyNumber}.`) };
    }
    const copyNumber = prior.filter((c) => c.saleId === saleId).length + 1;
    const key = `bill-copy-${deps.tenantId}-${copyId}`;
    if (deps.keys.has(key)) return { printed: false, refusedBecause: 'copy_id_reused', ...W('That copy was already asked for. Ask again. Nothing was printed.', 'அந்த நகல் ஏற்கனவே கேட்கப்பட்டது. மீண்டும் கேட்கவும். எதுவும் அச்சிடப்படவில்லை.') };
    const at = deps.now();
    const event: DomainEvent = makeEvent({
      id: `bill-copy-${copyId}`, type: BILL_COPY_EVENT, occurredAt: at, idempotencyKey: key, source: `store-box/${laneId}`,
      payload: {
        copyId, laneId, printedBy: cashierId, via, billNumber, saleId, billLaneId, copyNumber, reason: body['reason'].trim(), at, tradingDay: deps.tradingDayOf(at),
      },
    });
    deps.keys.add(key);
    const outcome = await commitLocally({ saleId: key, record: JSON.stringify(event), log: deps.log });
    if (!outcome.committed) {
      deps.keys.delete(key);
      return { printed: false, refusedBecause: outcome.refusedBecause ?? 'could_not_write_durably', ...W('The store computer could not record the copy, so none was printed. Tell the manager.', 'கடை கணினி நகலைப் பதிவு செய்ய முடியவில்லை; எதுவும் அச்சிடப்படவில்லை. மேலாளரிடம் சொல்லவும்.') };
    }
    deps.outbox.enqueue(event);
    return { printed: true, copyId, copyNumber, billNumber, saleId, billLaneId, bill, names, ...W(`Copy ${copyNumber} of bill ${billNumber} — printed as a duplicate.`, `பில் ${billNumber} — நகல் ${copyNumber} — நகலாக அச்சிடப்பட்டது.`) };
  });
}

/** The copies a device-events log holds (its `BillCopyPrinted` records), for `priorCopies`. */
export function priorCopiesIn(records: readonly string[]): readonly PriorCopy[] {
  const out: PriorCopy[] = [];
  for (const raw of records) {
    try {
      const e = JSON.parse(raw) as { type?: unknown; payload?: Rec };
      if (e.type !== BILL_COPY_EVENT || !isObj(e.payload)) continue;
      const p = e.payload;
      if (isStr(p['copyId']) && isStr(p['saleId']) && typeof p['copyNumber'] === 'number') out.push({ copyId: p['copyId'], saleId: p['saleId'], copyNumber: p['copyNumber'] });
    } catch { /* not a record — kept on the disk, skipped here */ }
  }
  return out;
}

/** The sale a sales log holds under this bill number or sale id (the FIRST seen — a re-append never shadows it). */
export function saleIn(records: readonly string[], numberOrId: string): Readonly<Record<string, unknown>> | undefined {
  for (const raw of records) {
    try {
      const r = JSON.parse(raw) as unknown;
      if (!isObj(r)) continue;
      if (r['id'] === numberOrId || r['number'] === numberOrId || r['receiptNumber'] === numberOrId) return r;
    } catch { /* skipped */ }
  }
  return undefined;
}
