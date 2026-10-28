import { describe, it, expect } from 'vitest';
import { issueQuotation, convertQuotation, freeQuotation, type Quotation, type QuotationLine } from '../../packages/suspended-sales/src/index';
import { billVoidRecorder, QUOTATION_FREED_EVENT } from '../../edge/store-edge/src/bill-void-at-lane';
import { billCancelAtTill, type BillCancelOps } from '../../apps/pos/src/bill-cancel-at-till';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { pathFor, EVENT_ROUTES } from '../../edge/sync-agent/src/http-transport';
import type { DurableLog } from '../../edge/store-edge/src/durability';

/**
 * **OB-523 (owner, 28 Oct 2026): cancelling a bill that rang a quotation up frees the quotation again, with a reason on record
 * (an append-only compensating event); it can then be rung up on a later bill. OB-525: a line below its product's floor needs
 * a second person.** The pure pieces: the quotation engine's release and line floors, the store computer's record of a
 * cancelled bill (each line's void, each quotation's release — on its disk, queued once), and the till's cancel step.
 */

const line = (over: Partial<QuotationLine> = {}): QuotationLine => ({ lineId: 'l1', productId: 'p-rice', description: 'Rice 25 kg', unitPriceMinor: 140_000, quantityMinor: 2, uom: 'ea', taxBps: 500, ...over });
const issued = (): Quotation => {
  const r = issueQuotation({ quotationId: '48151623', tenantId: 't', storeId: 'store-1', customerRef: 'Murugan', currency: 'INR', lines: [line()], issuedBy: 'u-mgr', issuedAt: '2030-06-01T06:00:00.000Z', validUntil: '2030-06-30' });
  return r.quotation!;
};
const converted = (): Quotation => convertQuotation({ quotation: issued(), saleId: 'B-lane-1-a', at: '2030-06-02T06:00:00.000Z' }).quotation;
const free = (q: Quotation, over: Partial<Parameters<typeof freeQuotation>[0]> = {}) => freeQuotation({
  quotation: q, freeId: 'BV-1-48151623', saleId: 'B-lane-1-a', freedBy: 'u-cash', reason: 'customer_left', laneId: 'lane-1',
  at: '2030-06-02T06:10:00.000Z', relayedBy: 'u-box', recordedAt: '2030-06-02T06:11:00.000Z', ...over,
});

describe('the quotation engine frees a quotation from its cancelled bill — a compensating fact (OB-523)', () => {
  it('frees it from the bill it is on: issued again, the release kept with who and why, the convert gone from the current state', () => {
    const out = free(converted());
    expect(out.outcome).toBe('freed');
    expect(out.quotation).toMatchObject({ state: 'issued', freedAt: '2030-06-02T06:11:00.000Z', releases: [{ freeId: 'BV-1-48151623', saleId: 'B-lane-1-a', freedBy: 'u-cash', reason: 'customer_left', laneId: 'lane-1', relayedBy: 'u-box' }] });
    expect(out.quotation.convertedSaleId).toBeUndefined();
    // A later bill rings it up — once again only one bill.
    const again = convertQuotation({ quotation: out.quotation, saleId: 'B-lane-2-b', at: '2030-06-03T06:00:00.000Z' });
    expect(again).toMatchObject({ converted: true, saleId: 'B-lane-2-b' });
    expect(again.quotation.releases).toHaveLength(1); // the history travels with it
    // Freed a second time from the second bill: both releases on record.
    const twice = free(again.quotation, { freeId: 'BV-2-48151623', saleId: 'B-lane-2-b' });
    expect(twice.quotation.releases?.map((r) => r.saleId)).toEqual(['B-lane-1-a', 'B-lane-2-b']);
  });

  it('refuses another bill\'s release, answers a re-send with the release on record, and needs a reason', () => {
    expect(free(converted(), { saleId: 'B-other' })).toMatchObject({ outcome: 'not_on_this_bill' });
    expect(free(issued())).toMatchObject({ outcome: 'not_on_this_bill' });
    const freed = free(converted()).quotation;
    expect(free(freed)).toMatchObject({ outcome: 'already_freed', release: { saleId: 'B-lane-1-a' } });
    expect(free(converted(), { reason: '  ' })).toMatchObject({ outcome: 'needs_a_reason' });
  });
});

describe('a quoted line below its product\'s floor needs a second person (OB-525)', () => {
  const base = { quotationId: 'Q1', tenantId: 't', storeId: 'store-1', customerRef: 'c', currency: 'INR', issuedBy: 'u-mgr', issuedAt: '2030-06-01T06:00:00.000Z', validUntil: '2030-06-30' };
  it('judges each line against head office\'s floor for its product; an approval for exactly it lets it through; not one\'s own', () => {
    const floors = { 'p-rice': 141_000 };
    expect(issueQuotation({ ...base, lines: [line()], lineFloorsMinor: floors })).toMatchObject({ issued: false, outcome: 'below_floor_unapproved' });
    expect(issueQuotation({ ...base, lines: [line({ unitPriceMinor: 141_000 })], lineFloorsMinor: floors }).issued).toBe(true);
    expect(issueQuotation({ ...base, lines: [line()], lineFloorsMinor: floors, approval: { subjectRef: 'Q1', status: 'approved', decidedBy: 'u-owner', reason: 'bulk' } })).toMatchObject({ issued: true, quotation: { marginApprovedBy: 'u-owner' } });
    expect(issueQuotation({ ...base, lines: [line()], lineFloorsMinor: floors, approval: { subjectRef: 'Q1', status: 'approved', decidedBy: 'u-mgr', reason: 'x' } })).toMatchObject({ outcome: 'self_approved' });
    expect(issueQuotation({ ...base, lines: [line()], lineFloorsMinor: floors, approval: { subjectRef: 'Q-other', status: 'approved', decidedBy: 'u-owner', reason: 'x' } })).toMatchObject({ outcome: 'below_floor_unapproved' });
  });
  it('a product whose floor head office cannot read is kept on the quotation and said — never a floor of zero', () => {
    // R9-A · OB-532: such a quotation needs the OWNER's approval; with it, the not-known floor is kept and said.
    const r = issueQuotation({ ...base, lines: [line({ productId: 'p-new' })], lineFloorsMinor: {}, floorNotKnown: ['p-new'], approval: { subjectRef: 'Q1', status: 'approved', decidedBy: 'u-owner', reason: 'new line', byOwner: true } });
    expect(r).toMatchObject({ issued: true, quotation: { floorNotKnown: ['p-new'] } });
  });
});

/** An in-memory durable log (what the box's fsync'd file is to the recorder). */
function memoryLog(fail = false): DurableLog & { records: string[] } {
  const records: string[] = [];
  return { records, capacityBytes: 1e9, usedBytes: async () => 0, append: async (r) => { if (fail) throw new Error('disk'); records.push(r); } };
}

describe('the store computer keeps a cancelled bill: each line\'s void and each quotation\'s release, on its disk, queued once (OB-523)', () => {
  const body = { kind: 'bill_void', activityId: 'BV-1', billRef: 'B-lane-1-a', reason: 'customer_left', lines: [{ lineId: 'L1', productId: 'p-rice', description: 'Rice 25 kg', valueMinor: 280_000 }, { lineId: 'L2', productId: 'p-dal', description: 'Dal', valueMinor: 7_200 }], quotationIds: ['48151623'] };
  it('writes the voids and the release before answering; a re-send records nothing twice; head office is told by the release\'s own route', async () => {
    const log = memoryLog();
    const outbox = new SyncOutbox();
    const keys = new Set<string>();
    const record = billVoidRecorder({ tenantId: 't', keys, log, outbox, now: () => '2030-06-02T06:10:00.000Z', tradingDayOf: () => '2030-06-02' });
    const out = await record({ laneId: 'lane-1', cashierId: 'u-cash', via: 'pin', body });
    expect(out).toMatchObject({ recorded: true, linesVoided: 2, quotationsFreed: ['48151623'] });
    expect(out.laneMessage).toBe('Bill cancelled: 2 line(s) voided with the reason. Quotation 48151623 is freed again — head office is told now, or as soon as its line is back; it can then be rung up on a later bill.');
    const events = log.records.map((r) => JSON.parse(r) as { type: string; payload: Record<string, unknown> });
    expect(events.map((e) => e.type)).toEqual(['TillActivityRecorded', 'TillActivityRecorded', QUOTATION_FREED_EVENT]);
    expect(events[0]!.payload).toMatchObject({ activityId: 'BV-1-L1', kind: 'void', cashierId: 'u-cash', billRef: 'B-lane-1-a', reason: 'customer_left', valueMinor: 280_000, tradingDay: '2030-06-02' });
    expect(events[2]!.payload).toMatchObject({ freeId: 'BV-1-48151623', quotationId: '48151623', saleId: 'B-lane-1-a', freedBy: 'u-cash', reason: 'customer_left', laneId: 'lane-1' });
    expect(outbox.pending()).toHaveLength(3);
    // The release travels to head office's own route for it.
    expect(EVENT_ROUTES[QUOTATION_FREED_EVENT]).toBe('/v1/pos/quotations/:quotationId/free/synced');
    expect(pathFor(outbox.pending()[2]!.event)).toBe('/v1/pos/quotations/48151623/free/synced');
    // The till asks again (its reply lost): nothing is written twice.
    expect((await record({ laneId: 'lane-1', cashierId: 'u-cash', via: 'pin', body })).recorded).toBe(true);
    expect(log.records).toHaveLength(3);
    expect(outbox.pending()).toHaveLength(3);
  });

  it('refuses what it cannot read, and a disk that will not keep it (nothing queued, the till keeps the bill)', async () => {
    const outbox = new SyncOutbox();
    const record = billVoidRecorder({ tenantId: 't', keys: new Set(), log: memoryLog(), outbox, now: () => '2030-06-02T06:10:00.000Z', tradingDayOf: () => '2030-06-02' });
    for (const bad of [{ ...body, reason: '' }, { ...body, billRef: '' }, { ...body, lines: [], quotationIds: [] }, { ...body, quotationIds: ['not a number!'] }, { ...body, lines: [{ lineId: 'L1' }] }]) {
      expect((await record({ laneId: 'lane-1', cashierId: 'u-cash', via: 'pin', body: bad as Record<string, unknown> })).recorded).toBe(false);
    }
    expect(outbox.pending()).toHaveLength(0);
    const broken = billVoidRecorder({ tenantId: 't', keys: new Set(), log: memoryLog(true), outbox, now: () => '2030-06-02T06:10:00.000Z', tradingDayOf: () => '2030-06-02' });
    expect(await broken({ laneId: 'lane-1', cashierId: 'u-cash', via: 'pin', body })).toMatchObject({ recorded: false, refusedBecause: 'could_not_write_durably' });
    expect(outbox.pending()).toHaveLength(0);
  });

  it('a bill whose lines were voided one by one still frees its quotation (lines empty, a quotation named)', async () => {
    const log = memoryLog();
    const record = billVoidRecorder({ tenantId: 't', keys: new Set(), log, outbox: new SyncOutbox(), now: () => '2030-06-02T06:10:00.000Z', tradingDayOf: () => '2030-06-02' });
    expect(await record({ laneId: 'lane-1', cashierId: 'u-cash', via: 'pin', body: { ...body, lines: [] } })).toMatchObject({ recorded: true, linesVoided: 0, quotationsFreed: ['48151623'] });
    expect(log.records.map((r) => (JSON.parse(r) as { type: string }).type)).toEqual([QUOTATION_FREED_EVENT]);
  });
});

describe('the till cancels the whole bill only once its store computer has it (OB-523)', () => {
  const state = () => {
    const s = { committed: false, awaiting: false, signed: true, lines: [{ lineId: 'L1', productId: 'p-rice', description: 'Rice', valueMinor: 280_000 }], voided: [] as string[], fresh: 0, quotations: ['48151623'] };
    const ops: BillCancelOps = {
      signedIn: () => s.signed, committed: () => s.committed, awaitingSave: () => s.awaiting, billRef: () => 'B-lane-1-a',
      liveLines: () => s.lines, quotationsOnBill: () => s.quotations, voidLine: (id) => { s.voided.push(id); }, newSale: () => { s.fresh += 1; }, newActivityId: () => 'BV-1',
    };
    return { s, ops };
  };
  it('sends the lines, the reason and the bill\'s quotations; voids and clears only on the box\'s yes', async () => {
    const { s, ops } = state();
    const sent: Record<string, unknown>[] = [];
    const cancel = billCancelAtTill({ ops, post: async (b) => { sent.push(b); return { recorded: true, laneMessage: 'Bill cancelled.', laneMessageTa: 'பில் ரத்து.', quotationsFreed: ['48151623'] }; } });
    expect(await cancel('customer_left')).toMatchObject({ ok: true, linesVoided: 1, quotationsFreed: ['48151623'], laneMessageTa: 'பில் ரத்து.' });
    expect(sent).toEqual([{ activityId: 'BV-1', kind: 'bill_void', billRef: 'B-lane-1-a', reason: 'customer_left', lines: s.lines, quotationIds: ['48151623'] }]);
    expect(s.voided).toEqual(['L1']);
    expect(s.fresh).toBe(1);
  });
  it('refuses a paid bill, one still being confirmed, no reason, nobody signed in, nothing to cancel; keeps the bill when the box says no or cannot be reached', async () => {
    const answers = [{ recorded: false, refusedBecause: 'could_not_write_durably', laneMessage: 'not kept' }];
    for (const [change, code] of [[(x: ReturnType<typeof state>['s']) => { x.committed = true; }, 'bill_already_paid'], [(x: ReturnType<typeof state>['s']) => { x.awaiting = true; }, 'bill_save_unconfirmed'],
      [(x: ReturnType<typeof state>['s']) => { x.signed = false; }, 'operator_not_signed_in'], [(x: ReturnType<typeof state>['s']) => { x.lines = []; x.quotations = []; }, 'nothing_to_cancel']] as const) {
      const { s, ops } = state();
      change(s);
      let posted = 0;
      expect(await billCancelAtTill({ ops, post: async () => { posted += 1; return { recorded: true }; } })('customer_left')).toMatchObject({ ok: false, refusedBecause: code });
      expect(posted).toBe(0);
    }
    const { s, ops } = state();
    expect(await billCancelAtTill({ ops, post: async () => answers[0]! })('customer_left')).toMatchObject({ ok: false, refusedBecause: 'could_not_write_durably', laneMessage: 'not kept' });
    expect(await billCancelAtTill({ ops, post: async () => { throw new Error('ECONNREFUSED'); } })('customer_left')).toMatchObject({ ok: false, refusedBecause: 'lane_unreachable' });
    expect(await billCancelAtTill({ ops, post: async () => ({ recorded: true }) })('')).toMatchObject({ ok: false, refusedBecause: 'reason_required' });
    expect(s.voided).toEqual([]);
    expect(s.fresh).toBe(0);
  });
});
