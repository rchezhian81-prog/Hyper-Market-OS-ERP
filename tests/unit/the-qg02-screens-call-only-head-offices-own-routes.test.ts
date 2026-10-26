import { describe, it, expect } from 'vitest';
import { createDockDiarySession, dockDiaryOutcomeWords, dockDiaryWords, instantOf, NEXT_STATUSES, DOCK_DIARY_COPY } from '../../apps/web-erp/src/dock-diary-session';
import { createBlanketOrdersSession, blanketOutcomeWords, linesOf, paiseOf, BLANKET_ORDERS_COPY } from '../../apps/web-erp/src/blanket-orders-session';
import { createPromotionFundingSession, fundingOutcomeWords, PROMOTION_FUNDING_COPY } from '../../apps/web-erp/src/promotion-funding-session';
import { createSwitchesSession, previewWords, switchesOutcomeWords, SWITCHES_COPY } from '../../apps/web-erp/src/switches-session';

/**
 * **The four QG-02 screens: Dock diary, Standing orders, Supplier offer funding, Feature switches (M07-FR-01 · M06-FR-02 ·
 * M05-FR-04 · M01-FR-03 · lane 1 R4).**
 *
 * Each is a thin client over routes head office already has. Proven against a stand-in for head office: each session
 * calls ONLY its own routes, with the method and body those routes read; a person nobody named, or a role without the
 * word, is refused before any call; a form that does not read is refused by name before any call (nothing half-sent);
 * head office's refusal is its own words, a lost line is "unreachable"; and every word has a Tamil twin. Synthetic data.
 */

interface Call { readonly url: string; readonly method: string; readonly body: unknown; readonly key: string | null }
function headOffice(answer: (url: string, method: string) => { status: number; body: unknown } | 'throw' = () => ({ status: 200, body: {} })): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown, key: headers['idempotency-key'] ?? null });
    const a = answer(url, method);
    if (a === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const TAMIL = /[஀-௿]/;
const twins = (copy: { en: Record<string, string>; ta: Record<string, string> }): void => {
  expect(Object.keys(copy.ta).sort()).toEqual(Object.keys(copy.en).sort());
  for (const k of Object.keys(copy.en)) expect(copy.ta[k], k).toMatch(TAMIL);
};
const keys = (() => { let n = 0; return () => `k-${(n += 1)}`; })();

describe('Dock diary', () => {
  const receiver = { userId: 'u-recv', permissions: ['inventory.availability.read', 'inventory.movement.append'] };
  it('reads a store\'s day, books a door with an instant window, and moves a booking on — the diary routes only', async () => {
    const ho = headOffice();
    const s = createDockDiarySession({ viewer: receiver, fetch: ho.fetch, newKey: keys, newSlotId: () => 'slot-1' });
    expect(s.may).toEqual({ named: true, read: true, book: true });
    await s.day(' store-1 ', '2026-10-26');
    await s.day('store-1', '');
    await s.book({ storeId: 'store-1', dockId: 'dock-1', startsAt: '2026-10-26T10:00', endsAt: '2026-10-26T11:00', supplierId: 'SUP-1', poIds: 'PO-1, PO-2,' });
    await s.setStatus('slot-1', 'arrived', '');
    await s.setStatus('slot-1', 'cancelled', 'lorry broke down');
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/inventory/dock-diary?storeId=store-1&date=2026-10-26', 'GET /v1/inventory/dock-diary?storeId=store-1',
      'POST /v1/inventory/dock-diary/slot-1', 'POST /v1/inventory/dock-diary/slot-1/status', 'POST /v1/inventory/dock-diary/slot-1/status',
    ]);
    expect(ho.calls[2]!.body).toEqual({ storeId: 'store-1', dockId: 'dock-1', startsAt: new Date('2026-10-26T10:00').toISOString(), endsAt: new Date('2026-10-26T11:00').toISOString(), supplierId: 'SUP-1', poIds: ['PO-1', 'PO-2'] });
    expect(ho.calls[3]!.body).toEqual({ status: 'arrived' });
    expect(ho.calls[4]!.body).toEqual({ status: 'cancelled', reason: 'lorry broke down' });
    expect(ho.calls.filter((c) => c.method === 'POST').every((c) => c.key !== null), 'every write carries its own idempotency key').toBe(true);
  });

  it('refuses before any call: nobody named, a reader who may not book, a missing store or a malformed day, a half-filled booking, a no-show with no reason', async () => {
    const ho = headOffice();
    expect(await createDockDiarySession({ viewer: { permissions: receiver.permissions }, fetch: ho.fetch }).day('store-1', '')).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createDockDiarySession({ viewer: { userId: 'u-r', permissions: ['inventory.availability.read'] }, fetch: ho.fetch });
    expect(await reader.book({ storeId: 's', dockId: 'd', startsAt: '2026-10-26T10:00', endsAt: '2026-10-26T11:00', supplierId: '', poIds: '' })).toEqual({ result: 'invalid', why: 'cannotBook' });
    expect(await reader.setStatus('slot-1', 'arrived', '')).toEqual({ result: 'invalid', why: 'cannotBook' });
    const cashier = createDockDiarySession({ viewer: { userId: 'u-c', permissions: [] }, fetch: ho.fetch });
    expect(await cashier.day('store-1', '')).toEqual({ result: 'invalid', why: 'cannotRead' });
    const s = createDockDiarySession({ viewer: receiver, fetch: ho.fetch });
    expect(await s.day('  ', '')).toEqual({ result: 'invalid', why: 'needStore' });
    expect(await s.day('store-1', '26/10/2026')).toEqual({ result: 'invalid', why: 'needDate' });
    expect(await s.book({ storeId: 'store-1', dockId: '', startsAt: '2026-10-26T10:00', endsAt: '2026-10-26T11:00', supplierId: '', poIds: '' })).toEqual({ result: 'invalid', why: 'needBooking' });
    expect(await s.book({ storeId: 'store-1', dockId: 'd', startsAt: 'tomorrow', endsAt: '2026-10-26T11:00', supplierId: '', poIds: '' })).toEqual({ result: 'invalid', why: 'needBooking' });
    expect(await s.setStatus('slot-1', 'no_show', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(ho.calls).toEqual([]);
  });

  it('the next steps are head office\'s own rule; outcomes and refusals are said in words', async () => {
    expect(NEXT_STATUSES.booked).toEqual(['arrived', 'no_show', 'cancelled']);
    expect(NEXT_STATUSES.arrived).toEqual(['completed']);
    expect(NEXT_STATUSES.completed).toEqual([]);
    expect(instantOf('2026-10-26')).toBeNull();
    expect(dockDiaryOutcomeWords('en', { result: 'ok', value: { alreadyBooked: false } })).toBe('Booked.');
    expect(dockDiaryOutcomeWords('en', { result: 'ok', value: { alreadyBooked: true } })).toBe('Already booked with the same details — nothing changed.');
    expect(dockDiaryOutcomeWords('en', { result: 'ok', value: { alreadySet: false } })).toBe('Done — head office recorded it.');
    const clash = createDockDiarySession({ viewer: receiver, fetch: headOffice(() => ({ status: 409, body: { error: { code: 'dock_conflict', whatHappened: 'Dock dock-1 is booked by slot-0 from 10:00.' } } })).fetch });
    const out = await clash.book({ storeId: 's', dockId: 'dock-1', startsAt: '2026-10-26T10:30', endsAt: '2026-10-26T11:00', supplierId: '', poIds: '' });
    expect(dockDiaryOutcomeWords('en', out)).toBe('Head office refused: Dock dock-1 is booked by slot-0 from 10:00.');
    const down = createDockDiarySession({ viewer: receiver, fetch: headOffice(() => 'throw').fetch });
    expect(dockDiaryOutcomeWords('ta', await down.day('store-1', ''))).toBe(dockDiaryWords('ta', 'unreachable'));
    twins(DOCK_DIARY_COPY as never);
  });
});

describe('Standing orders', () => {
  const buyer = { userId: 'u-buyer', permissions: ['purchase.commitment.read', 'purchase.order.propose'] };
  it('lists, proposes (₹ as paise, lines as typed) and approves with a reason — the agreement routes only', async () => {
    const ho = headOffice();
    const s = createBlanketOrdersSession({ viewer: buyer, fetch: ho.fetch, newKey: keys, newAgreementId: () => 'BPO-1' });
    await s.list();
    await s.propose({ supplierId: ' SUP-1 ', ceilingRupees: '₹1,50,000', validFrom: '2026-11-01', validTo: '2027-03-31', deliverTo: 'store-1', lines: 'RICE-5, 310.50, 400\nOIL-1, 145\n' });
    const checker = createBlanketOrdersSession({ viewer: { userId: 'u-head', permissions: ['purchase.commitment.read', 'purchase.order.approve'] }, fetch: ho.fetch });
    await checker.approve('BPO-1', ' prices checked against last season ');
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/purchase/blanket-orders', 'POST /v1/purchase/blanket-orders/BPO-1', 'POST /v1/purchase/blanket-orders/BPO-1/approval']);
    expect(ho.calls[1]!.body).toEqual({
      supplierId: 'SUP-1', currency: 'INR', ceilingMinor: 1_50_000_00, validFrom: '2026-11-01', validTo: '2027-03-31', deliverToLocationId: 'store-1',
      lines: [{ productId: 'RICE-5', agreedUnitCost: { minor: 310_50, currency: 'INR' }, maxQty: 400 }, { productId: 'OIL-1', agreedUnitCost: { minor: 145_00, currency: 'INR' } }],
    });
    expect(ho.calls[2]!.body).toEqual({ reason: 'prices checked against last season' });
  });

  it('refuses before any call: nobody, a reader who may not propose or approve, a missing field, a line that does not read, an approval with no reason', async () => {
    const ho = headOffice();
    expect(await createBlanketOrdersSession({ viewer: undefined, fetch: ho.fetch }).list()).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createBlanketOrdersSession({ viewer: { userId: 'u-r', permissions: ['purchase.commitment.read'] }, fetch: ho.fetch });
    const form = { supplierId: 'S', ceilingRupees: '100', validFrom: '2026-11-01', validTo: '2026-12-01', deliverTo: '', lines: 'P1, 10' };
    expect(await reader.propose(form)).toEqual({ result: 'invalid', why: 'cannotPropose' });
    expect(await reader.approve('BPO-1', 'ok')).toEqual({ result: 'invalid', why: 'cannotApprove' });
    expect(await createBlanketOrdersSession({ viewer: { userId: 'u', permissions: [] }, fetch: ho.fetch }).list()).toEqual({ result: 'invalid', why: 'cannotRead' });
    const s = createBlanketOrdersSession({ viewer: { ...buyer, permissions: [...buyer.permissions, 'purchase.order.approve'] }, fetch: ho.fetch });
    expect(await s.propose({ ...form, ceilingRupees: '0' })).toEqual({ result: 'invalid', why: 'needFields' });
    expect(await s.propose({ ...form, validTo: 'March' })).toEqual({ result: 'invalid', why: 'needFields' });
    expect(await s.propose({ ...form, lines: 'P1, ten rupees' })).toEqual({ result: 'invalid', why: 'badLine' });
    expect(await s.propose({ ...form, lines: 'P1, 10, -3' })).toEqual({ result: 'invalid', why: 'badLine' });
    expect(await s.approve('BPO-1', '  ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(ho.calls).toEqual([]);
  });

  it('amounts are exact paise, never rounded; a line reads code, cost, most; outcomes in words', () => {
    expect(paiseOf('1,23,456.78')).toBe(1_23_456_78);
    expect(paiseOf('10.5')).toBe(10_50);
    expect(paiseOf('10.555')).toBeNull();
    expect(paiseOf('-1')).toBeNull();
    expect(linesOf('A, 1\n\nB, 2.25, 6')).toEqual({ ok: true, lines: [{ productId: 'A', agreedUnitCost: { minor: 100, currency: 'INR' } }, { productId: 'B', agreedUnitCost: { minor: 225, currency: 'INR' }, maxQty: 6 }] });
    expect(linesOf('A, 1\n, 2')).toEqual({ ok: false, line: 2 });
    expect(blanketOutcomeWords('en', { result: 'ok', value: { alreadyApproved: true } })).toBe('Already recorded — nothing changed.');
    expect(blanketOutcomeWords('en', { result: 'refused', status: 409, code: 'proposer_cannot_approve', whatHappened: 'u-buyer proposed this standing agreement and cannot also approve it.' }))
      .toBe('Head office refused: u-buyer proposed this standing agreement and cannot also approve it.');
    twins(BLANKET_ORDERS_COPY as never);
  });
});

describe('Supplier offer funding', () => {
  const finance = { userId: 'u-fin', permissions: ['finance.period.read', 'finance.journal.post'] };
  it('reads the register, records an agreement with Finance\'s approval number, records a receipt — the funding routes only', async () => {
    const ho = headOffice();
    const marketing = createPromotionFundingSession({ viewer: { userId: 'u-mkt', permissions: ['promotion.launch'] }, fetch: ho.fetch, newKey: keys });
    await marketing.agree({ promotionId: 'DIWALI-OIL', supplierId: 'SUP-9', perUnitRupees: '5', capRupees: '25,000', productIds: 'OIL-1, OIL-5', approvalId: ' apr-77 ' });
    await marketing.agree({ promotionId: 'DIWALI-OIL', supplierId: 'SUP-10', perUnitRupees: '2.50', capRupees: '', productIds: '', approvalId: '' });
    const s = createPromotionFundingSession({ viewer: finance, fetch: ho.fetch, newKey: keys, newReceiptId: () => 'rcpt-1' });
    await s.register();
    await s.receipt({ promotionId: 'DIWALI-OIL', supplierId: 'SUP-9', amountRupees: '12,500', receivedOn: '2026-11-20', reference: ' NEFT 4471 ' });
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /v1/promotions/DIWALI-OIL/funding/SUP-9', 'POST /v1/promotions/DIWALI-OIL/funding/SUP-10', 'GET /v1/finance/promotion-funding',
      'POST /v1/finance/promotion-funding/DIWALI-OIL/SUP-9/receipts/rcpt-1',
    ]);
    expect(ho.calls[0]!.body).toEqual({ perUnitMinor: 500, capMinor: 25_000_00, productIds: ['OIL-1', 'OIL-5'], approvalId: 'apr-77' });
    expect(ho.calls[1]!.body, 'no typed approver, no cap, no products when none are given').toEqual({ perUnitMinor: 250 });
    expect(ho.calls[3]!.body).toEqual({ amountMinor: 12_500_00, receivedOn: '2026-11-20', reference: 'NEFT 4471' });
  });

  it('refuses before any call, and says what head office answered', async () => {
    const ho = headOffice();
    expect(await createPromotionFundingSession({ viewer: { permissions: [] }, fetch: ho.fetch }).register()).toEqual({ result: 'invalid', why: 'nobody' });
    const s = createPromotionFundingSession({ viewer: finance, fetch: ho.fetch });
    expect(await s.agree({ promotionId: 'P', supplierId: 'S', perUnitRupees: '5', capRupees: '', productIds: '', approvalId: '' })).toEqual({ result: 'invalid', why: 'cannotRecord' });
    expect(await s.receipt({ promotionId: 'P', supplierId: 'S', amountRupees: '0', receivedOn: '2026-11-20', reference: 'r' })).toEqual({ result: 'invalid', why: 'needReceipt' });
    expect(await s.receipt({ promotionId: 'P', supplierId: 'S', amountRupees: '10', receivedOn: '20/11/2026', reference: 'r' })).toEqual({ result: 'invalid', why: 'needReceipt' });
    expect(await s.receipt({ promotionId: 'P', supplierId: 'S', amountRupees: '10', receivedOn: '2026-11-20', reference: ' ' })).toEqual({ result: 'invalid', why: 'needReceipt' });
    const mkt = createPromotionFundingSession({ viewer: { userId: 'u-m', permissions: ['promotion.launch'] }, fetch: ho.fetch });
    expect(await mkt.register()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await mkt.agree({ promotionId: 'P', supplierId: 'S', perUnitRupees: 'five', capRupees: '', productIds: '', approvalId: '' })).toEqual({ result: 'invalid', why: 'needAgreement' });
    expect(await mkt.agree({ promotionId: 'P', supplierId: 'S', perUnitRupees: '5', capRupees: 'lots', productIds: '', approvalId: '' })).toEqual({ result: 'invalid', why: 'needAgreement' });
    expect(ho.calls).toEqual([]);
    expect(fundingOutcomeWords('en', { result: 'ok', value: { approved: true } })).toBe('Recorded and approved by Finance.');
    expect(fundingOutcomeWords('en', { result: 'ok', value: { approved: false } })).toBe('Recorded — flagged "not approved" until Finance approves it.');
    expect(fundingOutcomeWords('en', { result: 'ok', value: { alreadyRecorded: true } })).toBe('Already recorded — nothing changed.');
    expect(fundingOutcomeWords('en', { result: 'lost_link' })).toBe('Head office cannot be reached — nothing was read or saved.');
    twins(PROMOTION_FUNDING_COPY as never);
  });
});

describe('Feature switches', () => {
  const admin = { userId: 'u-it', permissions: ['platform.flag.read', 'platform.flag.write'] };
  it('reads the board, previews, saves with a reason, reads history, rolls back — /v1/platform/flags* only', async () => {
    const ho = headOffice();
    const s = createSwitchesSession({ viewer: admin, fetch: ho.fetch, newKey: keys });
    await s.board();
    await s.preview(' offers.festive_banner ', true);
    await s.save('offers.festive_banner', true, ' Diwali week ', '');
    await s.save('payments.upi_intent', false, 'provider outage', ' apr-9 ');
    await s.history('offers.festive_banner');
    await s.rollback('offers.festive_banner', 1, 'back to before', '');
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/platform/flags', 'POST /v1/platform/flags/offers.festive_banner/preview', 'PUT /v1/platform/flags/offers.festive_banner',
      'PUT /v1/platform/flags/payments.upi_intent', 'GET /v1/platform/flags/offers.festive_banner/history', 'POST /v1/platform/flags/offers.festive_banner/rollback',
    ]);
    expect(ho.calls.every((c) => c.url.startsWith('/v1/platform/flags'))).toBe(true);
    expect(ho.calls[1]!.body).toEqual({ enabled: true });
    expect(ho.calls[2]!.body).toEqual({ enabled: true, reason: 'Diwali week' });
    expect(ho.calls[3]!.body, 'the owner\'s approval is named by its number, never a typed name').toEqual({ enabled: false, reason: 'provider outage', approvalId: 'apr-9' });
    expect(ho.calls[5]!.body).toEqual({ toVersion: 1, reason: 'back to before' });
  });

  it('reads head office\'s board ({ flags: { name: on/off } }) as rows in name order, keeping only real on/off answers', async () => {
    const s = createSwitchesSession({ viewer: admin, fetch: headOffice(() => ({ status: 200, body: { flags: { 'z.last': false, 'a.first': true, 'odd.value': 'yes' } } })).fetch });
    expect(await s.board()).toEqual({ result: 'ok', value: { flags: [{ key: 'a.first', enabled: true }, { key: 'z.last', enabled: false }] } });
    const none = createSwitchesSession({ viewer: admin, fetch: headOffice(() => ({ status: 200, body: { flags: {} } })).fetch });
    expect(await none.board()).toEqual({ result: 'ok', value: { flags: [] } });
    const down = createSwitchesSession({ viewer: admin, fetch: headOffice(() => 'throw').fetch });
    expect(await down.board()).toEqual({ result: 'lost_link' });
  });

  it('refuses before any call: nobody, a reader who may not change, a name head office would not take, a change with no reason', async () => {
    const ho = headOffice();
    expect(await createSwitchesSession({ viewer: undefined, fetch: ho.fetch }).board()).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createSwitchesSession({ viewer: { userId: 'u-r', permissions: ['platform.flag.read'] }, fetch: ho.fetch });
    expect(await reader.save('a.b', true, 'x', '')).toEqual({ result: 'invalid', why: 'cannotChange' });
    expect(await reader.rollback('a.b', 1, 'x', '')).toEqual({ result: 'invalid', why: 'cannotChange' });
    expect(await createSwitchesSession({ viewer: { userId: 'u', permissions: [] }, fetch: ho.fetch }).board()).toEqual({ result: 'invalid', why: 'cannotRead' });
    const s = createSwitchesSession({ viewer: admin, fetch: ho.fetch });
    for (const bad of ['', 'Offers.Banner', '../flags', 'a b']) expect(await s.preview(bad, true), bad).toEqual({ result: 'invalid', why: 'needKey' });
    expect(await s.save('a.b', true, ' ', '')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.rollback('a.b', 2, '', '')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(ho.calls).toEqual([]);
  });

  it('the preview says what changes and who must approve; outcomes in words', () => {
    expect(previewWords('en', { key: 'payments.x', current: null, currentVersion: 0, proposed: true, changes: true, highImpact: true, needsSecondPerson: true }))
      .toEqual({ change: 'Now: not set (off) becomes On', who: 'High-impact: the owner must approve exactly this change first, and you cannot approve your own.' });
    expect(previewWords('en', { key: 'a.b', current: true, currentVersion: 3, proposed: false, changes: true, highImpact: false, needsSecondPerson: false }).change).toBe('Now: On (version 3) becomes Off');
    expect(previewWords('en', { key: 'a.b', current: true, currentVersion: 3, proposed: true, changes: false, highImpact: false, needsSecondPerson: false }).change).toBe('That is already its state — nothing would change.');
    expect(previewWords('ta', { key: 'a.b', current: true, currentVersion: 3, proposed: true, changes: false, highImpact: false, needsSecondPerson: false }).who).toMatch(TAMIL);
    expect(switchesOutcomeWords('en', { result: 'refused', status: 422, code: 'high_impact_change_needs_owner_approval', whatHappened: 'Switch payments.x is high-impact.' })).toBe('Head office refused: Switch payments.x is high-impact.');
    twins(SWITCHES_COPY as never);
  });
});
