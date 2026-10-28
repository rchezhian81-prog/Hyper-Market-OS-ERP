// A WHOLE BILL CANCELLED AT THE TILL, kept on the store computer and carried to head office (OB-523 · M15-FR-01 · M12-FR-02 ·
// P-01 · P-08 · hard rules #1, #2, #6 and #10).
//
// The cashier cancels a bill that is not paid (the customer walked away, the wrong customer's quotation was keyed). It arrives
// on the till's own till-activity door (`POST /lane/till-activity`, kind `bill_void`), so the person is the one THIS box
// verified at the till, never a typed name. The box then, before the till clears anything:
//   • keeps each line still on the bill as its own VOID — exactly the record a single line's void leaves
//     (`TillActivityRecorded`, kind `void`, the reason, the value) — so loss prevention sees a cancelled bill line by line;
//   • for each quotation the bill rang up (OB-523), keeps a RELEASE (`QuotationFreedAtTill`): the quotation, the cancelled
//     bill, who cancelled it, why, at which till and when. Head office frees the quotation again from it — a compensating
//     fact beside the convert, never an erasure — and a later bill may ring it up.
// Every record is written to the device-events log (fsync'd) and only then queued for head office, on the same dedupe set,
// cursor and dead-letter queue as every relayed record: with head office out of reach it waits on the box's disk and is
// sent ONCE when the line is back; a refusal there (another bill already has the quotation) is a visible dead letter.
// Each sub-record is keyed on the till's own activity id, so a re-sent cancel after a lost reply records only what is
// missing. Nothing here is on the sale path; nothing asks head office.

import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { commitLocally, type DurableLog } from './durability';

/** The event type head office's synced route frees a quotation under (`/v1/pos/quotations/:quotationId/free/synced`). */
export const QUOTATION_FREED_EVENT = 'QuotationFreedAtTill';

export interface BillVoidDeps {
  readonly tenantId: string;
  /** Every device-event key this box has ever taken (shared with the device relay and the till's voids — one dedupe set). */
  readonly keys: Set<string>;
  readonly log: DurableLog;
  readonly outbox: SyncOutbox;
  readonly now: () => string;
  /** The shop's trading day an instant belongs to (the store pack's cut-off). */
  readonly tradingDayOf: (atIso: string) => string;
}

export type BillVoidAnswer =
  | { readonly recorded: true; readonly laneMessage: string; readonly laneMessageTa: string; readonly linesVoided: number; readonly quotationsFreed: readonly string[] }
  | { readonly recorded: false; readonly refusedBecause: string; readonly laneMessage: string; readonly laneMessageTa?: string };

const isStr = (v: unknown, max = 120): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const QUOTATION = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

interface BillLine { readonly lineId: string; readonly productId: string; readonly description: string; readonly valueMinor: number }

function linesOf(v: unknown): BillLine[] | undefined {
  if (!Array.isArray(v) || v.length > 500) return undefined;
  const out: BillLine[] = [];
  for (const l of v) {
    if (l === null || typeof l !== 'object') return undefined;
    const r = l as Record<string, unknown>;
    if (!isStr(r['lineId']) || !ID.test(r['lineId']) || !isStr(r['productId']) || typeof r['description'] !== 'string' || !whole(r['valueMinor'])) return undefined;
    out.push({ lineId: r['lineId'], productId: r['productId'], description: r['description'], valueMinor: r['valueMinor'] });
  }
  return new Set(out.map((l) => l.lineId)).size === out.length ? out : undefined;
}

function quotationsOf(v: unknown): string[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 20 || !v.every((q) => typeof q === 'string' && QUOTATION.test(q))) return undefined;
  return [...new Set(v as string[])];
}

/**
 * R9-A · OB-533: the bill each quotation was rung up on, when it is not this bill's own reference — a basket that was held and
 * recalled carries its quotations on the bill they were converted to. Absent → every quotation is on this bill. Read strictly.
 */
function quotationBillsOf(v: unknown): Record<string, string> | undefined {
  if (v === undefined) return {};
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [q, sale] of Object.entries(v as Record<string, unknown>)) {
    if (!QUOTATION.test(q) || typeof sale !== 'string' || !ID.test(sale)) return undefined;
    out[q] = sale;
  }
  return out;
}

/** One quotation to free, and the bill it was rung up on at head office (OB-523 · OB-533). */
export interface QuotationToFree { readonly quotationId: string; readonly saleId: string }

/** Read a held basket's quotations strictly (OB-533) — an unreadable entry is a basket the box will not pretend to keep. */
export function heldQuotationsOf(v: unknown): QuotationToFree[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 20) return undefined;
  const out: QuotationToFree[] = [];
  for (const q of v) {
    if (q === null || typeof q !== 'object') return undefined;
    const r = q as Record<string, unknown>;
    if (typeof r['quotationId'] !== 'string' || !QUOTATION.test(r['quotationId']) || typeof r['saleId'] !== 'string' || !ID.test(r['saleId'])) return undefined;
    if (!out.some((o) => o.quotationId === r['quotationId'])) out.push({ quotationId: r['quotationId'], saleId: r['saleId'] });
  }
  return out;
}

/**
 * The RELEASE records for quotations freed at this box (OB-523 a cancelled bill · OB-533 a held basket given up): one
 * `QuotationFreedAtTill` per quotation, keyed on `releaseId` + quotation, so a re-sent cancel or give-up is the same record.
 */
export function quotationReleaseRecords(deps: Pick<BillVoidDeps, 'tenantId'>, input: {
  readonly releaseId: string; readonly laneId: string; readonly cashierId: string; readonly via: string; readonly reason: string;
  readonly at: string; readonly tradingDay: string; readonly quotations: readonly QuotationToFree[];
  /** What freed it, carried on the record: `{ billVoidId }` or `{ heldBillId }`. */
  readonly cause: Readonly<Record<string, string>>;
}): { readonly key: string; readonly event: DomainEvent }[] {
  return input.quotations.map(({ quotationId, saleId }) => {
    const freeId = `${input.releaseId}-${quotationId}`;
    const key = `quotation-freed-${deps.tenantId}-${freeId}`;
    return { key, event: makeEvent({
      id: `quotation-freed-${freeId}`, type: QUOTATION_FREED_EVENT, occurredAt: input.at, idempotencyKey: key, source: `store-box/${input.laneId}`,
      payload: { freeId, quotationId, saleId, freedBy: input.cashierId, via: input.via, reason: input.reason, laneId: input.laneId, at: input.at, tradingDay: input.tradingDay, ...input.cause },
    }) };
  });
}

/**
 * Keep records on this box's disk (fsync'd), then queue each for head office — on the shared dedupe set: a record already
 * taken is skipped, never written twice. Stops at the first record the disk refuses (the caller says so; nothing else is
 * cleared on the till).
 */
export async function keepAndQueue(deps: Pick<BillVoidDeps, 'keys' | 'log' | 'outbox'>, records: readonly { readonly key: string; readonly event: DomainEvent }[]): Promise<{ readonly kept: true } | { readonly kept: false; readonly refusedBecause: string }> {
  for (const r of records) {
    if (deps.keys.has(r.key)) continue; // a re-sent cancel or give-up: this part is already on the disk
    deps.keys.add(r.key);
    const outcome = await commitLocally({ saleId: r.key, record: JSON.stringify(r.event), log: deps.log });
    if (!outcome.committed) {
      deps.keys.delete(r.key);
      return { kept: false, refusedBecause: outcome.refusedBecause ?? 'could_not_write_durably' };
    }
    deps.outbox.enqueue(r.event);
  }
  return { kept: true };
}

/** The box's decision for one cancelled bill (the person at the till already verified by the till door). Never throws. */
export function billVoidRecorder(deps: BillVoidDeps): (input: { readonly laneId: string; readonly cashierId: string; readonly via: string; readonly body: Record<string, unknown> }) => Promise<BillVoidAnswer> {
  return async ({ laneId, cashierId, via, body }) => {
    const lines = linesOf(body['lines']);
    const quotations = quotationsOf(body['quotationIds']);
    const quotationBills = quotationBillsOf(body['quotationBills']);
    if (!isStr(body['activityId']) || !ID.test(body['activityId']) || !isStr(body['billRef']) || !ID.test(body['billRef']) || !isStr(body['reason'], 300)
      || lines === undefined || quotations === undefined || quotationBills === undefined || (lines.length === 0 && quotations.length === 0)) {
      return {
        recorded: false, refusedBecause: 'not_readable',
        laneMessage: 'The till did not say which bill, its lines and why it is cancelled. Nothing was cancelled — try again.',
        laneMessageTa: 'எந்த பில், அதன் வரிகள், ஏன் ரத்து என்று பில்லிங் சொல்லவில்லை. எதுவும் ரத்து செய்யப்படவில்லை — மீண்டும் முயலவும்.',
      };
    }
    const activityId = body['activityId'].trim();
    const billRef = body['billRef'].trim();
    const reason = body['reason'].trim();
    const at = deps.now();
    const tradingDay = deps.tradingDayOf(at);
    const records: { key: string; event: DomainEvent }[] = [
      ...lines.map((l) => {
        const id = `${activityId}-${l.lineId}`;
        const key = `till-activity-${deps.tenantId}-${id}`;
        return { key, event: makeEvent({
          id: `till-activity-${id}`, type: 'TillActivityRecorded', occurredAt: at, idempotencyKey: key, source: `store-box/${laneId}`,
          payload: { activityId: id, kind: 'void', laneId, cashierId, via, reason, at, tradingDay, billRef, lineId: l.lineId, productId: l.productId, description: l.description, valueMinor: l.valueMinor, billVoidId: activityId },
        }) };
      }),
      // OB-523: each quotation freed from the bill it is on — this bill, or (OB-533) the bill a recalled basket carried it from.
      ...quotationReleaseRecords(deps, {
        releaseId: activityId, laneId, cashierId, via, reason, at, tradingDay, cause: { billVoidId: activityId },
        quotations: quotations.map((quotationId) => ({ quotationId, saleId: quotationBills[quotationId] ?? billRef })),
      }),
    ];
    const kept = await keepAndQueue(deps, records);
    if (!kept.kept) {
      return {
        recorded: false, refusedBecause: kept.refusedBecause,
        laneMessage: 'The store computer could not keep the cancelled bill\'s record, so the bill stays as it is. Try again; if it fails again, tell the manager.',
        laneMessageTa: 'ரத்து செய்த பில்லின் பதிவைக் கடைக் கணினி வைத்துக்கொள்ள முடியவில்லை, எனவே பில் அப்படியே உள்ளது. மீண்டும் முயலவும்; மீண்டும் தோல்வியடைந்தால் மேலாளரிடம் சொல்லவும்.',
      };
    }
    const freed = quotations.length === 0 ? '' : ` Quotation ${quotations.join(', ')} is freed again — head office is told now, or as soon as its line is back; it can then be rung up on a later bill.`;
    const freedTa = quotations.length === 0 ? '' : ` விலைப்புள்ளி ${quotations.join(', ')} மீண்டும் விடுவிக்கப்பட்டது — தலைமை அலுவலகத்துக்கு இப்போதே, அல்லது இணைப்பு திரும்பியதும் தெரிவிக்கப்படும்; பிறகு வேறு பில்லில் சேர்க்கலாம்.`;
    return {
      recorded: true, linesVoided: lines.length, quotationsFreed: quotations,
      laneMessage: `Bill cancelled: ${lines.length} line(s) voided with the reason.${freed}`,
      laneMessageTa: `பில் ரத்து செய்யப்பட்டது: ${lines.length} வரி(கள்) காரணத்துடன் நீக்கப்பட்டன.${freedTa}`,
    };
  };
}

/**
 * R9-A · OB-533 (owner, 28 Oct 2026): a HELD basket that rang a quotation up was given up at the till — free each quotation it
 * carried, exactly as a cancelled bill does (OB-523): a `QuotationFreedAtTill` per quotation, from the bill it was rung up on,
 * with who gave the basket up (the person this box verified) and why; on the disk first, then queued for head office (offline
 * it waits and is sent once). Keyed on the held basket and quotation, so a re-sent give-up writes nothing twice.
 */
export function heldQuotationReleaser(deps: BillVoidDeps): (input: {
  readonly heldBillId: string; readonly laneId: string; readonly byUserId: string; readonly reason: string; readonly quotations: readonly QuotationToFree[];
}) => Promise<{ readonly kept: true } | { readonly kept: false; readonly refusedBecause: string }> {
  return async ({ heldBillId, laneId, byUserId, reason, quotations }) => {
    const at = deps.now();
    return keepAndQueue(deps, quotationReleaseRecords(deps, {
      releaseId: heldBillId, laneId, cashierId: byUserId, via: 'held_basket_given_up', reason: reason.trim() === '' ? 'held basket given up' : reason.trim(),
      at, tradingDay: deps.tradingDayOf(at), quotations, cause: { heldBillId },
    }));
  };
}
