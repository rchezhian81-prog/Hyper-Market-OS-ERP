import { describe, it, expect, afterEach } from 'vitest';
import { instantOfTyped, shownShopDateTime, shopDay } from '../../packages/calendar/src/shop-day';
import { createDockDiarySession, instantOf as dockInstantOf } from '../../apps/web-erp/src/dock-diary-session';
import { createCorrelationSession } from '../../apps/web-erp/src/lp-correlation-session';
import { createCompetitorPriceSession, type CompetitorHttp } from '../../apps/web-erp/src/competitor-price-session';
import { createFinanceCloseSession, type FinanceCloseHttp } from '../../apps/web-erp/src/finance-close-session';
import { createIncidentsSession } from '../../apps/web-erp/src/incidents-session';
import { deadlineInstant } from '../../apps/web-erp/src/store-ops-session';
import { createAffinitySession } from '../../apps/web-erp/src/basket-affinity-session';
import { buildPackLabel, renderLabel, type PackLabel } from '../../packages/production/src/packing';
import { buildScaleLabel } from '../../packages/production/src/scale-label';
import { DEPARTMENT_CATALOGUE } from '../../packages/production/src/departments';
import { rosterGaps, type ShiftRequirement } from '../../packages/workforce/src/workforce';
import { rosterCopyOnBox } from '../../edge/store-edge/src/workforce-pack';
import { known, type StorePack } from '../../edge/store-edge/src/store-pack';

/**
 * **OB-608 (owner, 29 Oct 2026 · round 15, R15-A) — a date-time typed by hand is the SHOP's clock; and OB-607 outside the
 * screens — a printed food label and a staff roster message show the shop's clock.**
 *
 * The five forms that take a date-time typed by hand — dock booking, CCTV clip from/to, competitor price "seen at",
 * finance-close payment time, incident timeline "when it happened" — sent what was typed as the DEVICE's clock
 * (`new Date('2026-10-30T10:30')`): on a laptop in New York, "10:30" was stored as 14:30 UTC — 20:00 in the shop. Each now
 * reads it in the shop's zone (the one the store computer served the page, `window.shopTimeZone`), exactly as store tasks
 * already did (round 13): "10:30" is 05:00 UTC, on ANY device. What is stored stays a UTC instant.
 *
 * A printed USE BY and a roster gap's hour were the UTC clock of the ISO text (`.slice(0, 16)`): a pack good until 19:30
 * UTC printed "19:30" — the shop's 01:00 the next morning. Each now reads the shop's clock in the zone of the store pack
 * (the label printer, offline) or the tenant's calendar (head office); with none named, the shop default — never UTC.
 *
 * The device is set to New York for every form here (`process.env.TZ`), so the old reading cannot pass.
 */

const SHOP = 'Asia/Kolkata';
const TYPED = '2026-10-30T10:30';
/** "10:30" typed at the shop is 05:00 UTC; New York's 10:30 would be 14:30 UTC, and the UTC clock's 10:30Z. */
const MEANT = '2026-10-30T05:00:00.000Z';
const g = globalThis as { shopTimeZone?: unknown };
const realTz = process.env['TZ'];
const inNewYork = (): void => { process.env['TZ'] = 'America/New_York'; };
afterEach(() => {
  delete g.shopTimeZone;
  if (realTz === undefined) delete process.env['TZ']; else process.env['TZ'] = realTz;
});

describe('a typed date-time is read as the shop\'s clock (packages/calendar/src/shop-day.ts instantOfTyped)', () => {
  it('a datetime-local value is the shop\'s wall clock, on a device in New York', () => {
    inNewYork();
    expect(new Date(TYPED).toISOString()).toBe('2026-10-30T14:30:00.000Z'); // the device really is in New York: the old reading
    expect(instantOfTyped(TYPED, SHOP)).toBe(MEANT);
    expect(instantOfTyped(`${TYPED}:15`, SHOP)).toBe('2026-10-30T05:00:15.000Z');
    expect(instantOfTyped(' 2026-10-30T00:15 ', SHOP)).toBe('2026-10-29T18:45:00.000Z'); // just after the shop's midnight
    expect(instantOfTyped(TYPED, 'Asia/Dubai')).toBe('2026-10-30T06:30:00.000Z'); // another shop's zone moves it
  });

  it('with no zone handed in, the zone the store computer served the page; with none served, the shop default', () => {
    inNewYork();
    expect(instantOfTyped(TYPED)).toBe(MEANT);
    g.shopTimeZone = 'Asia/Dubai';
    expect(instantOfTyped(TYPED)).toBe('2026-10-30T06:30:00.000Z');
    g.shopTimeZone = 'Not/AZone';
    expect(instantOfTyped(TYPED)).toBe(MEANT);
  });

  it('a value that names its zone is kept as that instant; anything else is "" — nothing is made up', () => {
    expect(instantOfTyped('2026-10-30T10:30:00Z', SHOP)).toBe('2026-10-30T10:30:00.000Z');
    expect(instantOfTyped('2026-10-30T10:30+05:30', SHOP)).toBe(MEANT);
    for (const bad of ['', '   ', '2026-10-30', 'tomorrow', '2026-13-01T10:00', '2026-02-30T10:00', '2026-10-30T25:00', '2026-10-30T10:60', '2026-10-30T10:30:61', null, 42, undefined]) {
      expect(instantOfTyped(bad, SHOP), String(bad)).toBe('');
    }
  });

  it('store tasks (round 13) read their deadline by the same rule, and the shop\'s day field does too', () => {
    inNewYork();
    expect(deadlineInstant('2026-10-29T23:59', SHOP)).toBe('2026-10-29T18:29:00.000Z');
    expect(deadlineInstant('2026-10-29T23:59:00Z', SHOP)).toBe('2026-10-29T23:59:00.000Z');
    expect(shopDay(SHOP).instantOfField(TYPED)).toBe(MEANT);
    expect(shopDay(SHOP).instantOfField('2026-02-30T10:00')).toBe('');
  });
});

/** A recorder for the plain `fetch` the office sessions use. */
function recordFetch() {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (path: string, init?: { body?: string }) => {
    sent.push({ path, body: init?.body === undefined ? {} : JSON.parse(init.body) as Record<string, unknown> });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
/** A recorder for the get/post (send) ports the competitor and month-end sessions use. */
function recordHttp() {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const http: CompetitorHttp & FinanceCloseHttp = {
    get: async () => ({ status: 200, body: {} }),
    post: async (path, body) => { sent.push({ path, body: body as Record<string, unknown> }); return { status: 200, body: {} }; },
    send: async (_m, path, body) => { sent.push({ path, body: body as Record<string, unknown> }); return { status: 200, body: {} }; },
  };
  return { sent, http };
}

describe('OB-608: the five forms send what was typed as the shop\'s clock — on a device in New York', () => {
  it('dock booking: from and until', async () => {
    inNewYork();
    expect(dockInstantOf(TYPED, SHOP)).toBe(MEANT);
    expect(dockInstantOf('2026-10-30', SHOP)).toBeNull();
    const { sent, fetch } = recordFetch();
    const s = createDockDiarySession({ viewer: { userId: 'u-recv', permissions: ['inventory.movement.append'] }, fetch, newKey: () => 'k', newSlotId: () => 'slot-1', timeZone: SHOP });
    expect((await s.book({ storeId: 'S1', dockId: 'D1', startsAt: TYPED, endsAt: '2026-10-30T11:00', supplierId: 'SUP-1', poIds: '' })).result).toBe('ok');
    expect(sent[0]!.body).toMatchObject({ startsAt: MEANT, endsAt: '2026-10-30T05:30:00.000Z' });
    // the zone the store computer served, when none is handed in
    g.shopTimeZone = SHOP;
    const served = recordFetch();
    await createDockDiarySession({ viewer: { userId: 'u-recv', permissions: ['inventory.movement.append'] }, fetch: served.fetch }).book({ storeId: 'S1', dockId: 'D1', startsAt: TYPED, endsAt: '2026-10-30T11:00', supplierId: '', poIds: '' });
    expect(served.sent[0]!.body['startsAt']).toBe(MEANT);
    // an impossible time is refused, nothing sent
    expect(await s.book({ storeId: 'S1', dockId: 'D1', startsAt: '2026-10-30T25:00', endsAt: '2026-10-30T11:00', supplierId: '', poIds: '' })).toEqual({ result: 'invalid', why: 'needBooking' });
    expect(sent).toHaveLength(1);
  });

  it('CCTV clip: from and to', async () => {
    inNewYork();
    const { sent, fetch } = recordFetch();
    const s = createCorrelationSession({ viewer: { userId: 'u-lp', permissions: ['lp.case.manage'] }, fetch, newKey: () => 'k', newId: () => 'cctv-1', timeZone: SHOP });
    expect((await s.cctv('CASE-1', { cameraId: 'CAM-3', from: TYPED, to: '2026-10-30T10:45', collectedBy: 'u-lp' })).result).toBe('ok');
    expect(sent[0]!.body).toEqual({ cameraId: 'CAM-3', from: MEANT, to: '2026-10-30T05:15:00.000Z', collectedBy: 'u-lp' });
    expect(await s.cctv('CASE-1', { cameraId: 'CAM-3', from: 'yesterday', to: TYPED, collectedBy: 'u-lp' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await createCorrelationSession({ viewer: { userId: 'u-c', permissions: ['lp.case.read'] }, fetch }).cctv('CASE-1', { cameraId: 'C', from: TYPED, to: TYPED, collectedBy: 'x' })).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(sent).toHaveLength(1);
  });

  it('competitor price: "seen at" (empty → the box\'s own moment, kept as it is)', async () => {
    inNewYork();
    const { sent, http } = recordHttp();
    const viewer = { userId: 'u-buy', permissions: ['price.change.propose'], storeId: 'S1', now: '2026-10-29T19:30:00.000Z', timeZone: SHOP };
    const s = createCompetitorPriceSession(viewer, http, () => 'obs-1');
    await s.record({ productId: 'P1', competitor: 'Shop A', price: '95.00', source: 'shelf_visit', observedAt: TYPED });
    await s.record({ productId: 'P1', competitor: 'Shop A', price: '95.00', source: 'shelf_visit', observedAt: '' });
    expect(sent.map((c) => c.body['observedAt'])).toEqual([MEANT, '2026-10-29T19:30:00.000Z']);
    expect(await s.record({ productId: 'P1', competitor: 'Shop A', price: '95.00', source: 'shelf_visit', observedAt: '2026-10-30T10:61' })).toEqual({ kind: 'invalid', detail: '' });
    expect(await createCompetitorPriceSession({ ...viewer, permissions: ['catalogue.pack.read'] }, http).record({ productId: 'P1', competitor: 'A', price: '9', source: 'flyer', observedAt: TYPED })).toEqual({ kind: 'not_allowed', needs: 'price.change.propose' });
    expect(sent).toHaveLength(2);
  });

  it('month-end: the payment time from the provider\'s statement', async () => {
    inNewYork();
    const { sent, http } = recordHttp();
    const s = createFinanceCloseSession({ userId: 'u-acct', permissions: ['settlement.investigation.manage'], timeZone: SHOP }, http);
    await s.resolvePayment('PAY-1', { found: 'captured', amountMinor: 64_000, at: TYPED, statementComplete: true });
    expect(sent[0]!.body).toEqual({ authorisations: [{ ref: 'PAY-1', amountMinor: 64_000, status: 'captured', at: MEANT }], statementComplete: true });
    expect(await s.resolvePayment('PAY-2', { found: 'captured', amountMinor: 100, at: 'noon', statementComplete: true })).toEqual({ kind: 'invalid', detail: '' });
    expect(sent).toHaveLength(1);
  });

  it('incident timeline: "when it happened"', async () => {
    inNewYork();
    const { sent, fetch } = recordFetch();
    const s = createIncidentsSession({ viewer: { userId: 'u-ops', permissions: ['platform.alert.manage'] }, fetch, newKey: () => 'k', timeZone: SHOP });
    await s.addTimeline('INC-1', { happenedAt: TYPED, note: 'Till 2 printer jammed' });
    expect(sent[0]).toMatchObject({ path: '/v1/platform/incidents/INC-1/timeline', body: { happenedAt: MEANT, note: 'Till 2 printer jammed' } });
    expect(await s.addTimeline('INC-1', { happenedAt: '2026-10-30', note: 'x' })).toEqual({ result: 'invalid', why: 'needAll' });
    expect(await createIncidentsSession({ viewer: undefined, fetch }).addTimeline('INC-1', { happenedAt: TYPED, note: 'x' })).toEqual({ result: 'invalid', why: 'nobody' });
    expect(sent).toHaveLength(1);
  });
});

describe('OB-610: a promotion drafted from basket affinity runs whole SHOP days — on a device in New York', () => {
  const pair = { productA: 'p-tea', productB: 'p-biscuit', basketCount: 4, basketsWithA: 7, basketsWithB: 4, support: 0.4, confidenceAtoB: 0.57, confidenceBtoA: 1, lift: 1.43, suggestions: [] };
  const drafter = { userId: 'u-mgr', permissions: ['reporting.report.read', 'promotion.launch'] };

  it('from 00:00:00 on the first shop day to 23:59:59 on the last, never UTC day edges', async () => {
    inNewYork();
    const { sent, fetch } = recordFetch();
    const s = createAffinitySession({ viewer: drafter, fetch, newKey: () => 'k', timeZone: SHOP });
    expect((await s.draftPromotion(pair, '5', '2026-11-01', '2026-11-30')).result).toBe('ok');
    expect(sent[0]!.body).toMatchObject({ startsAt: '2026-10-31T18:30:00.000Z', endsAt: '2026-11-30T18:29:59.000Z' });
    expect(sent[0]!.body['startsAt']).not.toBe('2026-11-01T00:00:00.000Z');
    // another shop's zone moves the edges; with none handed in, the zone the store computer served
    await createAffinitySession({ viewer: drafter, fetch, timeZone: 'Asia/Dubai' }).draftPromotion(pair, '5', '2026-11-01', '2026-11-01');
    expect(sent[1]!.body).toMatchObject({ startsAt: '2026-10-31T20:00:00.000Z', endsAt: '2026-11-01T19:59:59.000Z' });
    g.shopTimeZone = SHOP;
    await createAffinitySession({ viewer: drafter, fetch }).draftPromotion(pair, '5', '2026-11-01', '2026-11-30');
    expect(sent[2]!.body['startsAt']).toBe('2026-10-31T18:30:00.000Z');
  });

  it('an impossible day, a range that runs backwards, or no right to draft — refused, nothing sent', async () => {
    const { sent, fetch } = recordFetch();
    const s = createAffinitySession({ viewer: drafter, fetch, timeZone: SHOP });
    expect(await s.draftPromotion(pair, '5', '2026-02-30', '2026-03-02')).toEqual({ result: 'invalid', why: 'needPromo' });
    expect(await s.draftPromotion(pair, '5', '2026-11-30', '2026-11-01')).toEqual({ result: 'invalid', why: 'needPromo' });
    expect(await createAffinitySession({ viewer: { userId: 'u-r', permissions: ['reporting.report.read'] }, fetch }).draftPromotion(pair, '5', '2026-11-01', '2026-11-30')).toEqual({ result: 'invalid', why: 'cannotDraft' });
    expect(sent).toEqual([]);
  });
});

describe('OB-607 outside the screens: what a person reads on a printed label or a roster message is the shop\'s clock', () => {
  /** 19:30 UTC is 01:00 the next morning in the shop. */
  const EVENING = '2026-10-29T19:30:00.000Z';
  const label = (over: Partial<PackLabel> = {}): PackLabel => ({
    productId: 'SAN', productName: 'Cheese sandwich', batchId: 'B-1', netQuantity: '180 g', packerDetails: 'SRE Hyper Market',
    useBy: EVENING, price: { minor: 9_000, currency: 'INR' }, allergens: ['milk'], vegClass: 'veg', producedAt: '2026-10-29T13:30:00.000Z', ...over,
  });
  const cafe = DEPARTMENT_CATALOGUE['cafe']!;

  it('shownShopDateTime: an instant at the shop\'s clock; a plain date or a zoneless wall clock kept; words kept as given', () => {
    expect(shownShopDateTime(EVENING, SHOP)).toBe('2026-10-30 01:00');
    expect(shownShopDateTime(EVENING, undefined)).toBe('2026-10-30 01:00'); // no zone named → the shop default, not UTC
    expect(shownShopDateTime(EVENING, 'Not/AZone')).toBe('2026-10-30 01:00');
    expect(shownShopDateTime(EVENING, 'Asia/Dubai')).toBe('2026-10-29 23:30');
    expect(shownShopDateTime('2026-10-31', SHOP)).toBe('2026-10-31');
    expect(shownShopDateTime('2026-10-31T09:00', SHOP)).toBe('2026-10-31 09:00');
    expect(shownShopDateTime(' end of day ', SHOP)).toBe('end of day');
  });

  it('a pack label printed at 01:00 shop time reads 01:00, not 19:30 — in the zone handed in, else the shop default', () => {
    inNewYork(); // the printer's machine zone never decides it either
    const prepared = buildPackLabel(label(), cafe);
    expect(renderLabel(prepared, SHOP)).toContain('USE BY 2026-10-30 01:00');
    expect(renderLabel(prepared)).toContain('USE BY 2026-10-30 01:00');
    expect(renderLabel(prepared, 'Asia/Dubai')).toContain('USE BY 2026-10-29 23:30');
    expect(renderLabel(prepared).join('\n')).not.toContain('19:30');
    expect(renderLabel(buildPackLabel(label({ useBy: '2026-10-31' }), cafe))).toContain('USE BY 2026-10-31');
  });

  it('a scale label, the same', () => {
    const pack = { itemCode: '123456', productName: 'Mutton mince', batchId: 'M-1', weightGrams: 500, pricePerKg: { minor: 80_000, currency: 'INR' as const }, useBy: EVENING, netQuantity: '500 g', packerDetails: 'SRE' };
    const rule = { prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' as const };
    expect(buildScaleLabel(pack, rule, SHOP).lines).toContain('USE BY 2026-10-30 01:00');
    expect(buildScaleLabel(pack, rule).lines).toContain('USE BY 2026-10-30 01:00');
    expect(buildScaleLabel(pack, rule, 'Asia/Dubai').lines).toContain('USE BY 2026-10-29 23:30');
  });

  const SHIFT: ShiftRequirement = { shiftId: 'SH-1', branchId: 'S1', startsAt: '2026-10-29T00:30:00.000Z', endsAt: '2026-10-29T08:30:00.000Z', requiredRoles: [{ role: 'opener', count: 1 }, { role: 'cashier', count: 2 }] };
  const ASHA = { employeeId: 'E-A', name: 'Asha', branchId: 'S1', roles: ['cashier'], active: true };

  it('a roster gap names the shift\'s hour on the shop\'s clock: 06:00, not 00:30', () => {
    const gaps = rosterGaps({ shifts: [SHIFT], assignments: [{ shiftId: 'SH-1', employeeId: 'E-A', role: 'cashier' }], employees: [ASHA] });
    expect(gaps.map((x) => x.detail)).toEqual(['2026-10-29 06:00 has NOBODY rostered as opener', '2026-10-29 06:00 is 1 short of cashier']);
    expect(rosterGaps({ shifts: [SHIFT], assignments: [], employees: [], timeZone: 'Asia/Dubai' })[0]!.detail).toBe('2026-10-29 04:30 has NOBODY rostered as opener');
    // a shift already written with its offset reads the same
    expect(rosterGaps({ shifts: [{ ...SHIFT, startsAt: '2026-10-29T06:00:00+05:30' }], assignments: [], employees: [], timeZone: SHOP })[0]!.detail).toBe('2026-10-29 06:00 has NOBODY rostered as opener');
    expect(gaps[0]!.startsAt).toBe('2026-10-29T00:30:00.000Z'); // what is kept is unchanged
  });

  it('the store computer\'s copy of the roster names the hour in the pack\'s zone (offline)', () => {
    const roster = { storeId: 'S1', asAt: '2026-10-28T03:30:00.000Z', employees: [{ employeeId: 'E-A', name: 'Asha', roles: ['cashier'], active: true }], shifts: [SHIFT], assignments: [], published: [] };
    const pack = { roster: known(roster) } as StorePack;
    expect(rosterCopyOnBox(pack, SHOP)!.gaps[0]!.detail).toBe('2026-10-29 06:00 has NOBODY rostered as opener');
    expect(rosterCopyOnBox(pack, 'Asia/Dubai')!.gaps[0]!.detail).toBe('2026-10-29 04:30 has NOBODY rostered as opener');
    expect(rosterCopyOnBox(pack)!.gaps[0]!.detail).toBe('2026-10-29 06:00 has NOBODY rostered as opener');
  });
});
