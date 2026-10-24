import { describe, it, expect } from 'vitest';
import { createScanAndGo, linesForTheShop, type ScanProduct } from '../../apps/customer-app/src/scan-and-go';
import { readReferralCode, referralWhy } from '../../apps/customer-app/src/customer-commerce';
import { foldControls, presentControls, DELIVERY_CONTROL_DEFAULTS } from '../../services/fulfilment/src/delivery-controls';
import { fleetMovements, presentSettlement, type FleetSettlementStep } from '../../services/fulfilment/src/fleet-settlement';
import { flagWords } from '../../apps/web-erp/src/dispatch-session';
import { readRupees, createLoyaltyDeskSession } from '../../apps/web-erp/src/loyalty-desk-session';
import { newReferralCode, rewardsInForce, REFERRAL_CODE, claimIdOf } from '../../services/customer/src/referral-programme';
import { httpPhoneBaskets } from '../../edge/store-edge/src/phone-baskets';

// The OB-288 customer & delivery follow-ups (owner, 24 Oct 2026), DOM-free: OB-343 · OB-344 · D09-FR-06 · OB-350 · OB-351.

describe('OB-343: the proof-location radius is 250 metres by default — flagged, never refused', () => {
  it('folds to 250 m until the owner enters another, and says it is the default with the decision named', () => {
    expect(DELIVERY_CONTROL_DEFAULTS).toEqual({ geofenceRadiusMetres: 250 });
    expect(foldControls([]).values.geofenceRadiusMetres).toBe(250);
    const shown = presentControls([]) as { numbers: { key: string; value: unknown; state: string; decidedBy?: string }[]; notSet: string[] };
    expect(shown.numbers.find((n) => n.key === 'geofenceRadiusMetres')).toMatchObject({ value: 250, state: 'default', decidedBy: 'OB-343' });
    expect(shown.notSet).not.toContain('geofenceRadiusMetres');
    // The owner's own number replaces it — a new record over the default, the default never edited.
    const set = foldControls([{ changes: { geofenceRadiusMetres: 400 }, setBy: 'u-owner', setAt: '2026-10-24T09:00:00.000Z' }]);
    expect(set.values.geofenceRadiusMetres).toBe(400);
    expect((presentControls([{ changes: { geofenceRadiusMetres: 400 }, setBy: 'u-owner', setAt: '2026-10-24T09:00:00.000Z' }]) as { numbers: { key: string; state: string }[] }).numbers.find((n) => n.key === 'geofenceRadiusMetres')!.state).toBe('set');
  });
  it('OB-344: a wrong code and a hand-over away from the address are flags in words, in both languages — never code words', () => {
    expect(flagWords('en', ['delivery_code_wrong', 'outside_geofence'])).toEqual(['the code the driver typed is NOT the customer’s', 'handed over away from the address (farther than the radius)']);
    expect(flagWords('ta', ['delivery_code_wrong'])[0]).toMatch(/குறியீடு/);
    expect(flagWords('en', ['something_new'])).toEqual(['something new']); // a flag with no words is still shown
  });
});

describe('D09-FR-06: the own-fleet settlement\'s movements for the books', () => {
  const steps: FleetSettlementStep[] = [
    { step: 'proposed', routeId: 'R1', driverId: 'd', drops: 2, rate: { basis: 'per_drop', rateMinor: 40_00 }, amountMinor: 80_00, by: 'a', at: '2026-10-24T18:00:00.000Z' },
    { step: 'approved', routeId: 'R1', amountMinor: 80_00, by: 'b', at: '2026-10-24T18:05:00.000Z' },
    { step: 'paid', routeId: 'R1', amountMinor: 75_00, voucherRef: 'PV-1', by: 'b', at: '2026-10-24T18:10:00.000Z' },
    { step: 'paid', routeId: 'R1', amountMinor: 75_00, voucherRef: 'PV-1', by: 'b', at: '2026-10-24T18:11:00.000Z' },
  ];
  it('the approval once and each voucher once — nothing before approval', () => {
    expect(fleetMovements('R1', steps.slice(0, 1))).toEqual([]);
    expect(fleetMovements('R1', steps).map((m) => [m.movementId, m.kind, m.amountMinor])).toEqual([['fleet:approved:R1', 'approved', 80_00], ['fleet:paid:R1:PV-1', 'paid', 75_00]]);
  });
  it('says whether the books carry them — never "posted" without a journal', () => {
    expect(presentSettlement('R1', steps)['books']).toMatchObject({ state: 'not_connected' });
    expect(presentSettlement('R1', steps, new Set(['fleet:approved:R1']))['books']).toMatchObject({ state: 'not_yet_posted', unposted: ['fleet:paid:R1:PV-1'] });
    expect(presentSettlement('R1', steps, new Set(['fleet:approved:R1', 'fleet:paid:R1:PV-1']))['books']).toMatchObject({ state: 'posted', unposted: [] });
    expect(presentSettlement('R1', steps.slice(0, 1), new Set())['books']).toMatchObject({ state: 'nothing_to_post' });
  });
});

describe('OB-351: referral codes and rewards', () => {
  it('a code is 8 characters with no look-alikes; the phone reads what was typed the same way', () => {
    let i = 0;
    const code = newReferralCode(() => (i++ * 7) % 31);
    expect(code).toMatch(REFERRAL_CODE);
    expect(readReferralCode(` ${code.toLowerCase()} `)).toBe(code);
    expect(readReferralCode('ABCD1234')).toBeUndefined(); // 1 is a look-alike, never issued
    expect(readReferralCode('short')).toBeUndefined();
    expect(claimIdOf('c-1')).toMatch(/^rf-[0-9a-f]{24}$/);
    expect(claimIdOf('c-1')).not.toBe(claimIdOf('c_1'));
  });
  it('each side is "not set" until the owner enters it; 0 is a real answer (no reward on that side)', () => {
    expect(rewardsInForce([])).toMatchObject({ referrerRewardMinor: null, referredRewardMinor: null, last: null });
    expect(rewardsInForce([{ referrerRewardMinor: 50_00, referredRewardMinor: null, reason: 'r', setBy: 'o', setAt: 't' }])).toMatchObject({ referrerRewardMinor: 50_00, referredRewardMinor: null });
    expect(referralWhy({ state: 'not_set' })).toEqual({ set: false });
    expect(referralWhy({ state: 'set', amountMinor: 0 })).toEqual({ set: true, amountMinor: 0 });
    expect(referralWhy(undefined)).toEqual({ set: false });
  });
  it('the owner types rupees; only the owner may save; a box left empty keeps that side', async () => {
    expect([readRupees('50'), readRupees('25.5'), readRupees('25.50'), readRupees('-1'), readRupees('abc')]).toEqual([50_00, 25_50, 25_50, undefined, undefined]);
    const calls: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => { calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ referrer: { state: 'set', amountMinor: 50_00 }, referred: { state: 'not_set' } }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
    const manager = createLoyaltyDeskSession({ viewer: { userId: 'u-m', permissions: ['loyalty.points.read'] } as never, fetch });
    expect(await manager.saveReferralRewards('50', '', 'launch')).toEqual({ result: 'invalid', why: 'cannotConfigure' });
    const owner = createLoyaltyDeskSession({ viewer: { userId: 'u-o', permissions: ['loyalty.points.read', 'loyalty.programme.configure'] } as never, fetch });
    expect(await owner.saveReferralRewards('', '', 'launch')).toEqual({ result: 'invalid', why: 'badReward' });
    expect(await owner.saveReferralRewards('5o', '', 'launch')).toEqual({ result: 'invalid', why: 'badReward' });
    expect(await owner.saveReferralRewards('50', '', '')).toEqual({ result: 'invalid', why: 'needReasonFirst' });
    expect(calls).toEqual([]);
    expect((await owner.saveReferralRewards('50', '', 'launch')).result).toBe('ok');
    expect(calls[0]).toMatchObject({ url: '/v1/loyalty/referral-rewards', body: { referrerRewardMinor: 50_00, reason: 'launch' } });
  });
});

describe('OB-350: the scan-and-go basket on the phone', () => {
  const products: ScanProduct[] = [
    { productId: 'MILK', name: 'Milk 1L', unitPriceMinor: 30_00, uom: 'ea', barcodes: ['8900000000029'], status: 'active' },
    { productId: 'RICE', name: 'Loose rice', unitPriceMinor: 60_00, uom: 'kg', barcodes: ['8900000000043'], status: 'active' },
    { productId: 'OLD', name: 'Old line', unitPriceMinor: 10_00, uom: 'ea', barcodes: ['8900000000036'], status: 'discontinued' },
  ];
  const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
  it('adds by barcode or id, counts, refuses a weighed or unsold item and an unknown barcode, and totals at shelf prices', () => {
    let n = 0;
    const sg = createScanAndGo({ products: () => products, newBasketId: () => `sg-test-${++n}` });
    expect(sg.add('8900000000029')).toMatchObject({ ok: true, line: { productId: 'MILK', quantityMinor: 1 } });
    expect(sg.add('MILK')).toMatchObject({ ok: true, line: { quantityMinor: 2 } });
    expect(sg.add('8900000000043')).toEqual({ ok: false, why: 'weighed_at_the_till' });
    expect(sg.add('8900000000036')).toEqual({ ok: false, why: 'not_on_sale' });
    expect(sg.add('1234')).toEqual({ ok: false, why: 'unknown_barcode' });
    expect([sg.units(), sg.shelfTotalMinor()]).toEqual([2, 60_00]);
    // What the shop is sent: ids and counts only — never a price.
    expect(linesForTheShop(sg.lines())).toEqual([{ productId: 'MILK', quantityMinor: 2 }]);
    sg.setQuantity('MILK', 0);
    expect(sg.lines()).toEqual([]);
  });
  it('is kept on the phone across a reload; once handed to the till it cannot change; a new trip starts empty', () => {
    const storage = memory();
    let n = 0;
    const first = createScanAndGo({ products: () => products, newBasketId: () => `sg-test-${++n}`, storage });
    first.add('MILK');
    const id = first.basketId();
    const reloaded = createScanAndGo({ products: () => products, newBasketId: () => `sg-test-${++n}`, storage });
    expect([reloaded.basketId(), reloaded.units()]).toEqual([id, 1]);
    reloaded.handed('123456');
    expect(reloaded.add('MILK')).toEqual({ ok: false, why: 'handed_to_the_till' });
    reloaded.setQuantity('MILK', 5);
    expect(reloaded.units()).toBe(1);
    expect(reloaded.tillCode()).toBe('123456');
    reloaded.newTrip();
    expect([reloaded.units(), reloaded.tillCode(), reloaded.basketId() === id]).toEqual([0, undefined, false]);
    // A phone that cannot keep it still works in memory.
    const broken = createScanAndGo({ products: () => products, newBasketId: () => 'sg-x-000001', storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
    expect(broken.add('MILK')).toMatchObject({ ok: true });
  });
});

describe('OB-350: the store computer asks head office for a phone basket — never throws, always in words', () => {
  const answering = (status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) =>
    (async (url: string, init: RequestInit) => { seen.url = url; seen.init = init; return new Response(JSON.stringify(body), { status }); }) as unknown as typeof globalThis.fetch;
  it('passes the lines on; refuses a bad code before asking; names a second recall; says when the line is down', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const ok = httpPhoneBaskets({ baseUrl: 'https://ho.test/', token: 'tok', fetch: answering(200, { recalled: true, lines: [{ productId: 'MILK', name: 'Milk', quantityMinor: 2, barcode: '8900000000029' }] }, seen) });
    expect(await ok.recall({ code: '123456', laneId: 'lane-1', cashierId: 'u-c' })).toMatchObject({ recalled: true, code: '123456', lines: [{ productId: 'MILK', quantityMinor: 2, barcode: '8900000000029' }] });
    expect(seen.url).toBe('https://ho.test/v1/store/scan-and-go/123456/recall');
    expect(JSON.parse(String(seen.init?.body))).toEqual({ laneId: 'lane-1', cashierId: 'u-c' });
    expect(await ok.recall({ code: '12345', laneId: 'lane-1', cashierId: 'u-c' })).toMatchObject({ recalled: false, refusedBecause: 'not_a_basket_code' });
    const twice = httpPhoneBaskets({ baseUrl: 'https://ho.test', token: 't', fetch: answering(409, { error: { whatHappened: 'already brought up at till lane-2' } }) });
    expect(await twice.recall({ code: '123456', laneId: 'lane-1', cashierId: 'u-c' })).toEqual({ recalled: false, refusedBecause: 'already_recalled', laneMessage: 'already brought up at till lane-2' });
    const down = httpPhoneBaskets({ baseUrl: 'https://ho.test', token: 't', fetch: (async () => { throw new Error('ENETUNREACH'); }) as unknown as typeof globalThis.fetch });
    expect(await down.recall({ code: '123456', laneId: 'lane-1', cashierId: 'u-c' })).toMatchObject({ recalled: false, refusedBecause: 'head_office_unreachable' });
    const garbled = httpPhoneBaskets({ baseUrl: 'https://ho.test', token: 't', fetch: answering(200, { recalled: true, lines: [{ productId: 'MILK' }] }) });
    expect(await garbled.recall({ code: '123456', laneId: 'lane-1', cashierId: 'u-c' })).toMatchObject({ recalled: false, refusedBecause: 'not_readable' });
  });
});
