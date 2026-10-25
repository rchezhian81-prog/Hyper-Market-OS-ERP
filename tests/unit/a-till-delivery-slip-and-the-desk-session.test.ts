import { describe, it, expect } from 'vitest';
import { PosSession, type ScanInput } from '../../apps/pos/src/session';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { readWalletFeed, walletAvailable } from '../../packages/loyalty/src/wallet';
import { createTillDeskSession, coordinateOf, tillDeskWords } from '../../apps/web-erp/src/till-delivery-desk-session';
import { appAccountOf } from '../../services/api/src/till-delivery-adapters';
import type { MemberAppLink } from '../../services/customer/src/digital-receipts';

// OB-352 (owner, 24 Oct 2026, in writing): the till delivery's address and slot — the till's half (the slip, or the app
// line, decided by what the store computer said), "has the app" in the member copy, and the delivery desk's session.

const AT = '2026-10-24T09:30:00.000Z';
const item = (productId: string, priceMinor: number): ScanInput => ({ productId, description: productId, unitPrice: money(priceMinor, 'INR'), quantityMinor: 1, uom: 'ea' });
const FEE: ScanInput = { ...item('p-del', 3_000), taxRate: rate(1800), hsnCode: '996813' };
const cash = (minor: number) => [{ kind: 'cash' as const, amount: money(minor, 'INR'), status: 'settled' as const }];
const till = (path?: 'customer_app' | 'delivery_desk') => new PosSession(
  { laneId: 'lane-1', cashierId: 'u-meena', currency: 'INR', defaultTaxRate: rate(500), clock: () => AT, deliveryFeeProductId: 'p-del' },
  new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
  async () => ({ committed: true, durable: true, detail: 'ok', laneMessage: 'Saved.', ...(path === undefined ? {} : { deliveryPath: path }) }) as never,
);

describe('OB-352 — the till\'s delivery slip', () => {
  it('no app: the slip with the job, the bill, and blank lines for the desk — in English and Tamil; never an address or phone', async () => {
    const s = till('delivery_desk');
    s.scan(item('p-rice', 10_000));
    s.markForDelivery(FEE);
    await s.commit('S-1', 'N-1', AT, cash(13_000));
    const slip = s.deliverySlip('en')!;
    expect(slip).toMatchObject({ path: 'delivery_desk', jobRef: 'till-S-1', receiptNumber: 'N-1', itemLines: 1 });
    expect(slip.lines.slice(0, 5)).toEqual(['DELIVERY SLIP', 'Delivery job: till-S-1', 'Bill: N-1', 'Billed: 2026-10-24 09:30', 'Item lines: 1']);
    expect(slip.lines).toContain('Address: ________________________');
    expect(slip.lines).toContain('Delivery slot (day and time): ________________________');
    expect(s.deliverySlip('ta')!.lines[0]).toBe('டெலிவரி சீட்டு');
    // A store computer that said nothing (an older box): the slip is printed — the desk can always enter it.
    const older = till();
    older.scan(item('p-rice', 10_000)); older.markForDelivery(FEE);
    await older.commit('S-2', 'N-2', AT, cash(13_000));
    expect(older.deliverySlip()!.path).toBe('delivery_desk');
  });

  it('a member with the app: one line — choose in the app; no blanks. A bill not for delivery has no slip; the next bill forgets it', async () => {
    const s = till('customer_app');
    s.scan(item('p-rice', 10_000));
    s.markForDelivery(FEE);
    await s.commit('S-3', 'N-3', AT, cash(13_000));
    expect(s.deliverySlip('en')!.lines).toEqual(['DELIVERY SLIP', 'Delivery job: till-S-3', 'Bill: N-3', 'The customer chooses the delivery address and slot in the SRE app (Deliveries from the shop).']);
    s.newSale();
    s.scan(item('p-rice', 10_000));
    await s.commit('S-4', 'N-4', AT, cash(10_000));
    expect(s.deliverySlip()).toBeUndefined();
  });
});

describe('OB-352 — "has the app", in head office\'s link register and the store computer\'s member copy', () => {
  it('an account whose CURRENT link points at the member; a link taken off, or moved to another member, is not', () => {
    const link = (customerRef: string, memberRef: string, linked: boolean, at: string): MemberAppLink => ({ customerRef, memberRef, linked, verifiedHow: 'seen_on_phone', by: 'u-desk', at });
    expect(appAccountOf([link('c-1', 'm-1', true, '2026-10-01')], 'm-1')).toBe('c-1');
    expect(appAccountOf([link('c-1', 'm-1', true, '2026-10-01'), link('c-1', 'm-1', false, '2026-10-02')], 'm-1')).toBeUndefined();
    expect(appAccountOf([link('c-1', 'm-1', true, '2026-10-01'), link('c-1', 'm-2', true, '2026-10-02')], 'm-1')).toBeUndefined();
    expect(appAccountOf([], 'm-1')).toBeUndefined();
  });

  it('the wallet feed carries appLinked only as true; anything else refuses the feed; the box answers it per member', () => {
    const member = (over: Record<string, unknown> = {}) => ({ memberRef: `m-${'a'.repeat(24)}`, points: 0, storeCreditMinor: 0, appliedSpendRefs: [], ...over });
    const feed = (m: unknown) => ({ tenantId: 't', generatedAt: AT, rule: { pointsPer100Inr: 0, pointValuePaise: 0, tillSpendCapPaise: 0 }, members: [m] });
    const read = readWalletFeed(feed(member({ appLinked: true })))!;
    expect(read.members[0]!.appLinked).toBe(true);
    expect(readWalletFeed(feed(member({ appLinked: 'yes' })))).toBeUndefined();
    expect(readWalletFeed(feed(member()))!.members[0]).not.toHaveProperty('appLinked');
    expect(walletAvailable({ feed: read, memberRef: `m-${'a'.repeat(24)}`, localSpends: [], tradingDay: '2026-10-24' }).appLinked).toBe(true);
    expect(walletAvailable({ feed: read, memberRef: `m-${'b'.repeat(24)}`, localSpends: [], tradingDay: '2026-10-24' }).appLinked).toBe(false);
  });
});

describe('OB-352 — the delivery desk\'s session on the Dispatch page', () => {
  const fake = () => {
    const sent: { method: string; path: string; body: unknown }[] = [];
    const fetch = (async (path: string, init: RequestInit = {}) => {
      sent.push({ method: init.method ?? 'GET', path, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { sent, fetch };
  };
  it('reads with delivery.run.read, books with delivery.dispatch.manage; the point is checked before anything is sent', async () => {
    expect(createTillDeskSession({ viewer: { userId: 'u-cash', permissions: [] } }).may).toEqual({ read: false, enter: false });
    const f = fake();
    const s = createTillDeskSession({ viewer: { userId: 'u-mgr', permissions: ['delivery.run.read', 'delivery.dispatch.manage'] }, fetch: f.fetch, newKey: () => 'k' });
    expect(s.may).toEqual({ read: true, enter: true });
    expect(await s.jobs('br-1', '24-10-2026')).toEqual({ result: 'invalid', why: 'badDate' });
    await s.jobs('br-1', '2026-10-25');
    expect(f.sent.at(-1)).toMatchObject({ method: 'GET', path: '/v1/delivery/till-jobs?storeId=br-1&day=2026-10-25' });
    expect(await s.enter('till-S-1', { slotStartsAt: '', lat: '11', lon: '76', landmark: '' })).toEqual({ result: 'invalid', why: 'needFields' });
    expect(await s.enter('till-S-1', { slotStartsAt: 'x', lat: '91', lon: '76', landmark: '' })).toEqual({ result: 'invalid', why: 'badPoint' });
    await s.enter('till-S-1', { slotStartsAt: '2026-10-25T05:30:00.000Z', lat: '11.03', lon: '76.97', landmark: ' temple ' });
    expect(f.sent.at(-1)).toMatchObject({ method: 'POST', path: '/v1/delivery/till-jobs/till-S-1/delivery', body: { slotStartsAt: '2026-10-25T05:30:00.000Z', deliveryLocation: { lat: 11.03, lon: 76.97 }, landmark: 'temple' } });
    expect([coordinateOf('11.0168', 90), coordinateOf('eleven', 90), coordinateOf('181', 180)]).toEqual([11.0168, undefined, undefined]);
    expect(tillDeskWords('ta', 'tillJobsH')).toBe('கவுண்டரிலிருந்து டெலிவரிகள்');
  });
  it('OB-369: for an app customer the reason is sent — a phone call needs its note (checked before anything is sent)', async () => {
    const f = fake();
    const s = createTillDeskSession({ viewer: { userId: 'u-mgr', permissions: ['delivery.run.read', 'delivery.dispatch.manage'] }, fetch: f.fetch, newKey: () => 'k' });
    const where = { slotStartsAt: '2026-10-25T05:30:00.000Z', lat: '11.03', lon: '76.97', landmark: '' };
    const before = f.sent.length;
    expect(await s.enter('till-S-2', { ...where, appCustomer: { because: 'customer_phoned', note: ' ok ' } })).toEqual({ result: 'invalid', why: 'needCallNote' });
    expect(f.sent.length).toBe(before);
    await s.enter('till-S-2', { ...where, appCustomer: { because: 'customer_phoned', note: ' phoned at 11:05 ' } });
    expect(f.sent.at(-1)).toMatchObject({ body: { appCustomer: { because: 'customer_phoned', note: 'phoned at 11:05' } } });
    await s.enter('till-S-3', { ...where, appCustomer: { because: 'wait_passed', note: '' } });
    expect((f.sent.at(-1) as { body: Record<string, unknown> }).body['appCustomer']).toEqual({ because: 'wait_passed' });
    for (const k of ['appEnterH', 'whyL', 'customer_phoned', 'wait_passed', 'noteL', 'needCallNote', 'waitNotSet', 'waitEnds', 'waitPassed', 'forApp']) expect(tillDeskWords('ta', k), k).toMatch(/[஀-௿]/);
  });
});
