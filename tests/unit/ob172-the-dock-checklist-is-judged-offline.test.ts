import { describe, it, expect } from 'vitest';
import {
  judgeDockChecklist, readCarriedReceivingChecklist, readReceivingChecklistSetup, carriedChecklistDraft, coldChainAmong,
  receivingChecklistRecordId, RECEIVING_CHECKLIST_FIELD,
} from '../../packages/facilities/src/food-safety';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { makeEvent } from '../../packages/contracts/src/event';
import { createManagerSession, ReceivingChecklistRefusedError, type ManagerConfig } from '../../apps/web-erp/src/manager-session';
import { WarehouseSession, FEEDBACK_CODES } from '../../apps/warehouse-app/src/warehouse-session';
import { receivingChecklistFor } from '../../edge/store-edge/src/screen-data';
import { readPack } from '../../edge/store-edge/src/store-pack';

/**
 * **OB-172 "A" (owner, 17 Oct 2026, "Checklist on handheld") — the receiving checklist is judged at the dock with no network,
 * by head office's own D-6 rule, and travels inside the receipt.** The pure pieces, the manager's store screen session, the
 * warehouse handheld session and what the store computer serves them. Synthetic data only.
 */

const AT = '2026-10-17T06:30:00.000Z';
const SECTION = {
  checks: [
    { checkId: 'dock', branchId: 'store-1', title: 'Chilled and frozen delivery', kind: 'receiving', graceMinutes: 0, active: true, assignedRole: 'store_manager', escalatesTo: 'u-owner', items: [{ itemId: 'temp', label: 'Temperature taken' }, { itemId: 'pack', label: 'Packaging intact' }] },
    // Not a receiving check, an inactive one and a broken one are never offered.
    { checkId: 'chiller', branchId: 'store-1', title: 'Chiller', kind: 'temperature', graceMinutes: 0, everyMinutes: 60, startsAt: AT, minTenthsC: 0, maxTenthsC: 50, active: true, assignedRole: 'x', escalatesTo: 'y', items: [] },
    { checkId: 'old', branchId: 'store-1', title: 'Old', kind: 'receiving', graceMinutes: 0, active: false, assignedRole: 'x', escalatesTo: 'y', items: [{ itemId: 'a', label: 'A' }] },
    { checkId: 'broken', branchId: 'store-1', title: 'Broken', kind: 'receiving', graceMinutes: 0, active: true, assignedRole: 'x', escalatesTo: 'y', items: [] },
  ],
  coldChainProductIds: ['p-paneer', 'p-icecream', 'p-chicken'],
};

describe('the pure rule (packages/facilities)', () => {
  const setup = readReceivingChecklistSetup(SECTION)!;

  it('reads the store setup strictly: only whole, active receiving checklists; not a section → undefined', () => {
    expect(setup.checks.map((c) => c.checkId)).toEqual(['dock']);
    expect(readReceivingChecklistSetup({ checks: 'no' })).toBeUndefined();
    expect(readReceivingChecklistSetup(null)).toBeUndefined();
    expect(coldChainAmong(setup, ['p-dal', 'p-paneer', 'p-paneer'])).toEqual(['p-paneer']);
    expect(coldChainAmong(undefined, ['p-paneer'])).toEqual([]);
  });

  it('a cold-chain delivery needs it; dry goods do not; every item ticked; a failure needs what was done', () => {
    const base = { setup, grnId: 'g1', performedBy: 'u-mgr', performedAt: AT };
    expect(judgeDockChecklist({ ...base, productIds: ['p-dal'] })).toEqual({ ok: true, coldChain: [] });
    expect(judgeDockChecklist({ ...base, productIds: ['p-paneer', 'p-dal'] })).toMatchObject({ ok: false, refusal: 'checklist_required', coldChain: ['p-paneer'] });
    expect(judgeDockChecklist({ ...base, productIds: ['p-paneer'], answer: { itemResults: { temp: 'pass' } } })).toMatchObject({ ok: false, refusal: 'items_incomplete' });
    expect(judgeDockChecklist({ ...base, productIds: ['p-paneer'], answer: { itemResults: { temp: 'fail', pack: 'pass' } } })).toMatchObject({ ok: false, refusal: 'corrective_action_required' });
    expect(judgeDockChecklist({ ...base, productIds: ['p-paneer'], answer: { checkId: 'nope', itemResults: {} } })).toMatchObject({ ok: false, refusal: 'unknown_checklist' });
    const ok = judgeDockChecklist({ ...base, productIds: ['p-paneer'], answer: { itemResults: { temp: 'fail', pack: 'pass' }, correctiveAction: '  refused  ', readingTenthsC: 81 } });
    expect(ok).toEqual({ ok: true, coldChain: ['p-paneer'], carried: { checkId: 'dock', performedBy: 'u-mgr', performedAt: AT, itemResults: { temp: 'fail', pack: 'pass' }, readingTenthsC: 81, correctiveAction: 'refused' } });
    // Dry goods may carry one (optional).
    expect(judgeDockChecklist({ ...base, productIds: ['p-dal'], answer: { itemResults: { temp: 'pass', pack: 'pass' } } })).toMatchObject({ ok: true, carried: { checkId: 'dock' } });
    // A store computer that was never told the checklist cannot ask for it (head office then flags it missing).
    expect(judgeDockChecklist({ ...base, setup: undefined, productIds: ['p-paneer'] })).toEqual({ ok: true, coldChain: [] });
  });

  it('a carried checklist is read strictly — never repaired — and is the D-6 record rc-<grn> for its delivery', () => {
    const c = { checkId: 'dock', performedBy: 'u-mgr', performedAt: AT, itemResults: { temp: 'pass' as const } };
    expect(readCarriedReceivingChecklist(c)).toEqual(c);
    expect(readCarriedReceivingChecklist({ ...c, itemResults: { temp: 'ok' } })).toBeUndefined();
    expect(readCarriedReceivingChecklist({ ...c, performedAt: 'yesterday' })).toBeUndefined();
    expect(readCarriedReceivingChecklist({ ...c, readingTenthsC: 3.5 })).toBeUndefined();
    expect(carriedChecklistDraft('g9', c)).toEqual({ recordId: receivingChecklistRecordId('g9'), checkId: 'dock', subjectRef: 'g9', performedBy: 'u-mgr', performedAt: AT, itemResults: { temp: 'pass' } });
    expect(receivingChecklistRecordId('g9')).toBe('rc-g9');
    expect(RECEIVING_CHECKLIST_FIELD).toBe('receivingChecklist');
  });
});

describe('the manager\'s store screen (apps/web-erp manager-session)', () => {
  const session = (told = true) => {
    const setup = told ? readReceivingChecklistSetup(SECTION) : undefined;
    const outbox = new SyncOutbox();
    const config: ManagerConfig = {
      storeId: 'store-1', branchId: 'store-1', tradingDay: '2026-10-17', tradingDayRule: { cutoff: '02:00' } as unknown as ManagerConfig['tradingDayRule'],
      manager: { userId: 'u-mgr', branchScope: ['store-1'], authorityLimit: null }, currency: 'INR', warehouseId: 'wh-1',
      ...(setup === undefined ? {} : { receivingChecklist: setup }),
    };
    const ports = { approvals: () => ({ known: false as const, why: 'x' }), exceptions: () => ({ known: false as const, why: 'x' }), unsent: () => ({ known: false as const, why: 'x' }), tasks: () => ({ known: false as const, why: 'x' }), pendingPayments: () => ({ known: false as const, why: 'x' }) };
    return { s: createManagerSession(config, ports as never, new Ledger(new InMemoryLedgerStore()), outbox), outbox };
  };
  const lines = [{ productId: 'p-chicken', quantityMinor: 4, uom: 'ea' }];

  it('a raw-meat delivery is not saved — and no stock moves — without its checklist; with it, the checklist rides INSIDE the receipt in the manager\'s name', () => {
    const { s, outbox } = session();
    let e: unknown;
    try { s.receive({ grnId: 'g1', number: 'DN-1', poId: null, receivedAt: AT, lines }); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(ReceivingChecklistRefusedError);
    expect((e as ReceivingChecklistRefusedError).coldChain).toEqual(['p-chicken']);
    expect(outbox.pending()).toEqual([]);
    s.receive({ grnId: 'g1', number: 'DN-1', poId: null, receivedAt: AT, lines, checklist: { itemResults: { temp: 'pass', pack: 'pass' } } });
    const [item] = outbox.pending();
    expect(item!.event.type).toBe('GoodsReceived');
    expect((item!.event.payload as Record<string, unknown>)['receivingChecklist']).toEqual({ checkId: 'dock', performedBy: 'u-mgr', performedAt: AT, itemResults: { temp: 'pass', pack: 'pass' } });
  });

  it('dry goods save without one; a screen the store computer never told saves a cold delivery without one (head office flags it missing)', () => {
    const dry = session();
    dry.s.receive({ grnId: 'g2', number: 'DN-2', poId: null, receivedAt: AT, lines: [{ productId: 'p-dal', quantityMinor: 1, uom: 'ea' }] });
    expect((dry.outbox.pending()[0]!.event.payload as Record<string, unknown>)['receivingChecklist']).toBeUndefined();
    const untold = session(false);
    expect(untold.s.receivingChecklist()).toBeUndefined();
    untold.s.receive({ grnId: 'g3', number: 'DN-3', poId: null, receivedAt: AT, lines });
    expect(untold.outbox.pending()).toHaveLength(1);
  });
});

describe('the warehouse handheld (apps/warehouse-app warehouse-session)', () => {
  const handheld = (told = true) => {
    const outbox = new SyncOutbox();
    const s = new WarehouseSession({ assignmentId: 'A-1', workerId: 'u-worker', storeId: 'store-1', bins: [], ...(told ? { receivingChecklist: SECTION } : {}) }, outbox, { now: () => AT });
    outbox.enqueue(makeEvent({ id: 'recv-g-s1', type: 'ReceivingScanned', occurredAt: AT, idempotencyKey: 'recv:g:s1', source: 'A-1',
      payload: { grnId: 'g', commandId: 's1', productId: 'p-icecream', quantityMinor: 6, uom: 'EA', receivedBy: 'u-worker', storeId: 'store-1', at: AT, temperatureC: -18.5 } }));
    return { s, outbox };
  };
  const completion = (outbox: SyncOutbox) => outbox.all().find((i) => i.event.type === 'ReceivingCompleted')?.event.payload as Record<string, unknown> | undefined;

  it('"Delivery complete" on a frozen delivery needs the checklist (refused by its own code, nothing queued); with it, the completion carries it in the worker\'s name, the probed reading included', () => {
    const { s, outbox } = handheld();
    expect(s.deliveryChecklist('g')).toMatchObject({ known: true, coldChain: ['p-icecream'], check: { checkId: 'dock' } });
    const refused = s.completeReceiving({ grnId: 'g' });
    expect([refused.accepted, refused.signal.code]).toEqual([false, 'checklist_required']);
    expect(completion(outbox)).toBeUndefined();
    const half = s.completeReceiving({ grnId: 'g', checklist: { itemResults: { temp: 'fail', pack: 'pass' } } });
    expect([half.accepted, half.signal.code]).toEqual([false, 'checklist_incomplete']);
    expect(half.signal.detail).toMatch(/corrective action/);
    expect(s.completeReceiving({ grnId: 'g', checklist: { itemResults: { temp: 'pass', pack: 'pass' } } }).accepted).toBe(true);
    expect(completion(outbox)).toMatchObject({ completedBy: 'u-worker', receivingChecklist: { checkId: 'dock', performedBy: 'u-worker', readingTenthsC: -185, itemResults: { temp: 'pass', pack: 'pass' } } });
  });

  it('a handheld the store computer never told completes without one; the shell has words for the two new codes', () => {
    const { s, outbox } = handheld(false);
    expect(s.deliveryChecklist('g')).toEqual({ known: false, coldChain: [] });
    expect(s.completeReceiving({ grnId: 'g' }).accepted).toBe(true);
    expect(completion(outbox)!['receivingChecklist']).toBeUndefined();
    expect(FEEDBACK_CODES).toEqual(expect.arrayContaining(['checklist_required', 'checklist_incomplete']));
  });
});

describe('the store computer serves what the store setup says — absent stays absent', () => {
  it('the section, read strictly, goes to the manager screen and the handheld; a pack without it serves nothing (never an empty list)', () => {
    const told = readPack({ version: 1, receivingChecklist: SECTION }, AT);
    const served = receivingChecklistFor({ pack: told } as never) as { receivingChecklist?: { checks: { checkId: string }[]; coldChainProductIds: string[] } };
    expect(served.receivingChecklist?.checks.map((c) => c.checkId)).toEqual(['dock']);
    expect(served.receivingChecklist?.coldChainProductIds).toEqual(SECTION.coldChainProductIds);
    expect(receivingChecklistFor({ pack: readPack({ version: 1 }, AT) } as never)).toEqual({});
  });
});
