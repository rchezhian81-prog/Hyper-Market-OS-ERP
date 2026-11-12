import { describe, it, expect } from 'vitest';
import { createStockLedgerSession, ledgerQuery, lineView, signedQuantity, STOCK_LEDGER_WORD_KEYS, text as ledgerText } from '../../apps/web-erp/src/stock-ledger-session';
import { createQuarantineSession, holdBody, holdView, lineView as qLineView, QUARANTINE_WORD_KEYS, text as qText } from '../../apps/web-erp/src/quarantine-session';
import { createStockAdjustmentsSession, askBody, requestView, checkAsk, quantityOf, STOCK_ADJUSTMENTS_WORD_KEYS, text as aText, type AdjustmentRequestRow } from '../../apps/web-erp/src/stock-adjustments-session';
import type { HeadOfficeHttp, HttpAnswer } from '../../apps/web-erp/src/head-office-http';

/**
 * **U6 (UI/UX gap audit, 1 Nov 2026 · §27 Inventory "Ledger" / "Quarantine" / "Adjustment"): the three stock screens' session
 * models — every word in both languages, the cheap checks before any request, the one request each sends, and head office's
 * refusal in head office's words.** The connected proof is `tests/e2e/u6-the-stock-ledger-quarantine-and-adjustment-pages.e2e.ts`.
 */

function fakeHttp(answer: HttpAnswer = { result: 'ok', status: 200, body: {} }) {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const http: HeadOfficeHttp = {
    get: async (path) => { sent.push({ method: 'GET', path }); return answer; },
    post: async (path, body) => { sent.push({ method: 'POST', path, body }); return answer; },
  };
  return { http, sent };
}
const MANAGER = { userId: 'u-mgr', permissions: ['inventory.availability.read', 'inventory.movement.append', 'inventory.adjustment.approve', 'quality.hold.manage', 'quality.hold.release'] };
const CASHIER = { userId: 'u-cash', permissions: ['pos.sale.commit'] };
const tamil = /[஀-௿]/;

describe('every word of the three sessions has a Tamil twin that is Tamil', () => {
  it.each([
    ['stock ledger', STOCK_LEDGER_WORD_KEYS, ledgerText],
    ['quarantine', QUARANTINE_WORD_KEYS, qText],
    ['adjust a quantity', STOCK_ADJUSTMENTS_WORD_KEYS, aText],
  ] as const)('%s', (_name, keys, text) => {
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) {
      expect(text('en', k), k).not.toBe(k);
      const ta = text('ta', k);
      if (ta === '—') continue; // a dash is a dash in both languages
      expect(tamil.test(ta), `${k} has Tamil`).toBe(true);
    }
  });
});

describe('the stock ledger session', () => {
  it('needs a product, refuses a window the wrong way round, and asks head office for one product at one place in a window of whole shop days', () => {
    expect(ledgerQuery({ productId: ' ', locationId: '', fromIso: '', toIso: '' })).toEqual({ key: 'needProduct' });
    expect(ledgerQuery({ productId: 'RICE', locationId: '', fromIso: '2026-11-05', toIso: '2026-11-01' })).toEqual({ key: 'badWindow' });
    expect(ledgerQuery({ productId: 'RICE', locationId: ' S1 ', fromIso: '2026-11-01', toIso: '2026-11-05' })).toEqual({ query: 'productId=RICE&locationId=S1&from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-05T23%3A59%3A59.999Z' });
  });
  it('reads in the person\'s own session, hands head office\'s answer through, and keeps a cashier off it before any request', async () => {
    const answer = { productId: 'RICE', locationId: null, from: null, to: null, lines: [{ movementId: 'm1', productId: 'RICE', locationId: 'S1', kind: 'received', effect: 1, quantityMinor: 100, uom: 'EA', occurredAt: '2026-11-01T04:30:00.000Z', batchId: null, expiry: null, reason: null, enteredBy: 'u-owner', approvedBy: null, balanceAfterMinor: 100 }], count: 1, inMinor: 100, outMinor: 0, places: [{ locationId: 'S1', onHandMinor: 100 }], movementsEver: 1, asAt: '2026-11-07T10:00:00.000Z' };
    const { http, sent } = fakeHttp({ result: 'ok', status: 200, body: answer });
    const s = createStockLedgerSession(MANAGER, http);
    const out = await s.read({ productId: 'RICE', locationId: '', fromIso: '', toIso: '' });
    expect(out).toMatchObject({ result: 'ok', ledger: { count: 1 } });
    expect(sent).toEqual([{ method: 'GET', path: '/v1/inventory/ledger?productId=RICE' }]);
    const cashier = createStockLedgerSession(CASHIER, fakeHttp().http);
    expect(cashier.may.read).toBe(false);
    expect(await cashier.read({ productId: 'RICE', locationId: '', fromIso: '', toIso: '' })).toEqual({ result: 'invalid', key: 'cannotRead' });
    expect(createStockLedgerSession(undefined, fakeHttp().http).nobody).toBe(true);
  });
  it('a line reads as a person reads it: the shop\'s moment, the kind in words, a signed quantity, the balance after', () => {
    const v = lineView('en', { movementId: 'm', productId: 'RICE', locationId: 'S1', kind: 'transferred_out', effect: -1, quantityMinor: 2_500, uom: 'kg', occurredAt: '2026-11-01T04:30:00.000Z', batchId: null, expiry: null, reason: null, enteredBy: 'u', approvedBy: null, balanceAfterMinor: 97_500 });
    expect([v.kindWord, v.quantity, v.balance, v.tone, v.batchWord, v.reasonWord]).toEqual(['Transferred out', '−2.500 kg', '97.500 kg', 'idle', '—', '—']);
    expect(v.when).toMatch(/^2026-11-01 10:00$/);
    expect(lineView('ta', { ...v, kind: 'received', effect: 1 }).kindWord).toBe('விநியோகம் பெறப்பட்டது');
    expect(signedQuantity({ effect: 1, quantityMinor: 3, uom: 'EA' })).toBe('+3');
  });
  it('says head office\'s refusal in the three parts, and a lost link honestly', () => {
    const s = createStockLedgerSession(MANAGER, fakeHttp({ result: 'refused', status: 403, code: 'forbidden', whatHappened: 'This account does not hold "inventory.availability.read".' }).http);
    expect(s.say('en', { result: 'refused', status: 403, code: 'forbidden', whatHappened: 'This account does not hold "inventory.availability.read".' }).words).toMatch(/Head office refused.*Nothing was changed/);
    expect(s.say('ta', { result: 'lost_link' })).toEqual({ tone: 'err', words: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.' });
  });
});

describe('the quarantine session', () => {
  it('a hold needs the batch, the product and the reason; the body is { productId, reason } under the batch id', () => {
    expect(holdBody({ batchId: ' ', productId: 'p', reason: 'r' })).toEqual({ key: 'needBatch' });
    expect(holdBody({ batchId: 'B-1', productId: ' ', reason: 'r' })).toEqual({ key: 'needProduct' });
    expect(holdBody({ batchId: 'B-1', productId: 'p', reason: ' ' })).toEqual({ key: 'needReason' });
    expect(holdBody({ batchId: ' B-1 ', productId: ' p-milk ', reason: ' awaiting result ' })).toEqual({ batchId: 'B-1', body: { productId: 'p-milk', reason: 'awaiting result' } });
  });
  it('reads the register, places a hold and releases a batch with NO samples in the body; a person without the release right is refused before any request', async () => {
    const { http, sent } = fakeHttp({ result: 'ok', status: 200, body: { holds: [], released: [], lines: [], counts: { batchesHeld: 0, batchesFailed: 0, receiptLines: 0, released: 0 }, asAt: 'x' } });
    const s = createQuarantineSession(MANAGER, http);
    expect((await s.read()).result).toBe('ok');
    expect((await s.hold({ batchId: 'B-1', productId: 'p-milk', reason: 'awaiting result' })).result).toBe('ok');
    expect((await s.release('B-1')).result).toBe('ok');
    expect(sent).toEqual([
      { method: 'GET', path: '/v1/inventory/quarantine' },
      { method: 'POST', path: '/v1/quality/holds/B-1', body: { productId: 'p-milk', reason: 'awaiting result' } },
      { method: 'POST', path: '/v1/quality/holds/B-1/release', body: {} },
    ]);
    const holder = createQuarantineSession({ userId: 'u-qc', permissions: ['quality.hold.manage'] }, fakeHttp().http);
    expect(holder.may).toEqual({ read: true, hold: true, release: false });
    expect(await holder.release('B-1')).toEqual({ result: 'invalid', key: 'cannotRelease' });
    expect(createQuarantineSession(CASHIER, fakeHttp().http).may.read).toBe(false);
  });
  it('a hold and a line read as a person reads them, in both languages', () => {
    const h = holdView('ta', { batchId: 'B-1', productId: 'p', status: 'failed', reason: 'listeria', heldAt: '2026-11-05T09:00:00.000Z', heldBy: 'u-qc' });
    expect([h.stateWord, h.inQuarantine, h.since]).toEqual(['சோதனையில் தோல்வி', true, '2026-11-05 14:30']);
    expect(holdView('en', { batchId: 'B-2', productId: 'p', status: 'released', reason: 'r', heldAt: '2026-11-05T09:00:00.000Z', heldBy: 'u', releasedAt: '2026-11-06T09:00:00.000Z', releasedBy: 'u-mgr' })).toMatchObject({ inQuarantine: false, releasedWhen: '2026-11-06 14:30', stateWord: 'Released' });
    const l = qLineView('en', { grnId: 'g', number: 'GRN-1', lineId: 'L1', productId: 'p-oil', warehouseId: 'S1', quantityMinor: 12, uom: 'EA', batchId: null, expiry: null, receivedBy: 'u', receivedAt: '2026-11-05T09:00:00.000Z', condition: 'quarantine' });
    expect([l.quantity, l.conditionWord, l.batchWord, l.expiryWord]).toEqual(['12', 'Quarantined', '—', '—']);
  });
});

describe('the adjust-a-quantity session', () => {
  const FORM = { productId: ' RICE ', locationId: ' S1 ', direction: 'less' as const, quantityText: '2.5', uom: 'kg', reasonCode: 'damaged', note: ' wet sack ' };
  it('refuses the cheap things before any request, and shapes the body in the unit\'s smallest step with the sign from the direction', () => {
    expect(askBody({ ...FORM, productId: ' ' })).toEqual({ key: 'needProduct' });
    expect(askBody({ ...FORM, locationId: '' })).toEqual({ key: 'needPlace' });
    expect(askBody({ ...FORM, quantityText: 'abc' })).toEqual({ key: 'needQty' });
    expect(askBody({ ...FORM, quantityText: '0' })).toEqual({ key: 'needQty' });
    expect(askBody({ ...FORM, reasonCode: 'because' })).toEqual({ key: 'needReason' });
    expect(askBody(FORM)).toEqual({ body: { productId: 'RICE', locationId: 'S1', deltaMinor: -2_500, uom: 'kg', reasonCode: 'damaged', note: 'wet sack' } });
    expect(askBody({ ...FORM, direction: 'more', quantityText: '3', uom: 'EA', note: '' })).toEqual({ body: { productId: 'RICE', locationId: 'S1', deltaMinor: 3, uom: 'EA', reasonCode: 'damaged' } });
    expect([checkAsk(FORM), checkAsk({ ...FORM, quantityText: '' }), quantityOf(FORM)]).toEqual([null, 'needQty', 2_500]);
  });
  it('asks under a fresh request id, decides with a reason, and keeps each act to the right the person holds', async () => {
    const { http, sent } = fakeHttp({ result: 'ok', status: 202, body: { requestId: 'adj-1', recorded: true, status: 'pending', valueMinor: 7_500, flags: [] } });
    const s = createStockAdjustmentsSession(MANAGER, http, { request: () => 'adj-1' });
    expect(await s.ask(FORM)).toMatchObject({ result: 'ok', requestId: 'adj-1', alreadyRecorded: false });
    expect(await s.decide('adj-2', 'approved', ' ')).toEqual({ result: 'invalid', key: 'needWhy' });
    expect((await s.decide('adj-2', 'rejected', 'already on a transfer')).result).toBe('ok');
    expect((await s.list()).result).toBe('ok');
    expect((await s.list(true)).result).toBe('ok');
    expect(sent.map((x) => [x.method, x.path])).toEqual([
      ['POST', '/v1/inventory/adjustment-requests/adj-1'], ['POST', '/v1/inventory/adjustment-requests/adj-2/decide'],
      ['GET', '/v1/inventory/adjustment-requests?status=pending'], ['GET', '/v1/inventory/adjustment-requests'],
    ]);
    const reader = createStockAdjustmentsSession({ userId: 'u-r', permissions: ['inventory.availability.read'] }, fakeHttp().http);
    expect(reader.may).toEqual({ read: true, ask: false, decide: false });
    expect(await reader.ask(FORM)).toEqual({ result: 'invalid', key: 'cannotAsk' });
    expect(await reader.decide('adj-1', 'approved', 'x')).toEqual({ result: 'invalid', key: 'cannotDecide' });
  });
  it('a request reads as a person reads it; the raiser is never offered their own; the flags are words', () => {
    const r: AdjustmentRequestRow = { requestId: 'adj-1', productId: 'RICE', locationId: 'S1', binId: null, deltaMinor: -2_500, uom: 'kg', reasonCode: 'damaged', note: 'wet sack', valueMinor: 7_500, requestedBy: 'u-mgr', at: '2026-11-07T04:30:00.000Z', storeId: 'S1', source: 'office', governanceFlags: ['value_unknown'], status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null, movementId: null };
    const mine = requestView('en', r, 'u-mgr', true);
    expect([mine.change, mine.value, mine.reasonWord, mine.stateWord, mine.sourceWord, mine.yours, mine.canDecide, mine.flags]).toEqual(['−2.500 kg', 'the product has no cost at head office — the value is not known', 'Damaged', 'Waiting for a decision', 'from the office', true, false, ['the product has no cost at head office — the value is not known']]);
    const other = requestView('ta', { ...r, governanceFlags: [] }, 'u-mgr2', true);
    expect([other.value, other.yours, other.canDecide, other.stateWord]).toEqual(['₹75.00', false, true, 'முடிவுக்காகக் காத்திருப்பு']);
    const decided = requestView('en', { ...r, status: 'posted', decidedBy: 'u-mgr2', decisionReason: 'checked', movementId: 'adj-req:adj-1' }, 'u-mgr2', true);
    expect([decided.canDecide, decided.decision]).toEqual([false, 'decided by u-mgr2 — checked']);
  });
});
