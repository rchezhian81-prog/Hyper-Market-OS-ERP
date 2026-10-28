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

/** The box's decision for one cancelled bill (the person at the till already verified by the till door). Never throws. */
export function billVoidRecorder(deps: BillVoidDeps): (input: { readonly laneId: string; readonly cashierId: string; readonly via: string; readonly body: Record<string, unknown> }) => Promise<BillVoidAnswer> {
  return async ({ laneId, cashierId, via, body }) => {
    const lines = linesOf(body['lines']);
    const quotations = quotationsOf(body['quotationIds']);
    if (!isStr(body['activityId']) || !ID.test(body['activityId']) || !isStr(body['billRef']) || !ID.test(body['billRef']) || !isStr(body['reason'], 300)
      || lines === undefined || quotations === undefined || (lines.length === 0 && quotations.length === 0)) {
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
      ...quotations.map((quotationId) => {
        const freeId = `${activityId}-${quotationId}`;
        const key = `quotation-freed-${deps.tenantId}-${freeId}`;
        return { key, event: makeEvent({
          id: `quotation-freed-${freeId}`, type: QUOTATION_FREED_EVENT, occurredAt: at, idempotencyKey: key, source: `store-box/${laneId}`,
          payload: { freeId, quotationId, saleId: billRef, freedBy: cashierId, via, reason, laneId, at, tradingDay, billVoidId: activityId },
        }) };
      }),
    ];
    for (const r of records) {
      if (deps.keys.has(r.key)) continue; // a re-sent cancel: this part is already on the disk
      deps.keys.add(r.key);
      const outcome = await commitLocally({ saleId: r.key, record: JSON.stringify(r.event), log: deps.log });
      if (!outcome.committed) {
        deps.keys.delete(r.key);
        return {
          recorded: false, refusedBecause: outcome.refusedBecause ?? 'could_not_write_durably',
          laneMessage: 'The store computer could not keep the cancelled bill\'s record, so the bill stays as it is. Try again; if it fails again, tell the manager.',
          laneMessageTa: 'ரத்து செய்த பில்லின் பதிவைக் கடைக் கணினி வைத்துக்கொள்ள முடியவில்லை, எனவே பில் அப்படியே உள்ளது. மீண்டும் முயலவும்; மீண்டும் தோல்வியடைந்தால் மேலாளரிடம் சொல்லவும்.',
        };
      }
      deps.outbox.enqueue(r.event);
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
