import { describe, it, expect } from 'vitest';
import { inForcePlanogram, type StoredPlanogram } from '../../services/inventory/src/planograms';
import { assembleCatalogueSnapshot, type CataloguePreviewDeps } from '../../services/catalogue/src/catalogue-preview';
import { floorDeviceRoutes, type FloorDeviceDeps, type FloorDeviceLogEntry, type StoredFloorEvent } from '../../services/platform/src/device-events';
import { rebateClaimRoutes, type RebateClaimDeps } from '../../services/purchase/src/rebate-claims';
import type { RebateClaimFact } from '../../packages/purchasing/src/index';
import type { StoredRebateAccrual } from '../../services/purchase/src/rebates';
import type { ProductRecord } from '../../packages/product/src/index';
import type { Route, RequestContext } from '../../services/kernel/src/index';

/**
 * **Round 16 (R16-A · P2, P3 · M01-FR-02 · P-08): what head office dates by "today" is the SHOP's date of the moment.**
 *
 * The moment used throughout is 19:30 UTC on 29 Oct 2026 — 01:00 on 30 Oct in the shop (Asia/Kolkata). Before round 16
 * each of these took the UTC date (29 Oct):
 *   • the plan in force (planograms.ts `inForcePlanogram`);
 *   • the price pack's build date — the MRP, the GST rate and the tobacco-warning picture in force (catalogue-preview.ts);
 *   • a camera event's day for the CCTV links (device-events.ts);
 *   • a rebate claim's "raised on" (its document, and the sent-on check) (rebate-claims.ts).
 * Each now takes the shop's date in the tenant's calendar (`calendar`, else the shop default — never UTC).
 */

const EVENING = '2026-10-29T19:30:00.000Z'; // 01:00 on 30 Oct in the shop
const SHOP_DAY = '2026-10-30';
const UTC_DAY = '2026-10-29';
const KOLKATA = () => ({ timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' });
const LONDON = () => ({ timeZone: 'Europe/London', tradingDayCutoff: '00:00' });

describe('the plan in force is the plan of the shop\'s today (P2)', () => {
  const base = { storeId: 'S1', assignments: [], createdBy: 'u', shelfMapVersion: 1, version: 1 };
  const all: StoredPlanogram[] = [
    { ...base, planogramId: 'PG-OLD', effectiveFrom: '2026-01-01', publishedAt: '2026-01-01T00:00:00Z' },
    { ...base, planogramId: 'PG-TODAY', effectiveFrom: SHOP_DAY, publishedAt: '2026-10-20T00:00:00Z' },
  ];
  it('at 01:00 shop time the plan effective that day is in force (the shop default zone, or the zone named)', () => {
    expect(inForcePlanogram(all, EVENING)?.planogramId).toBe('PG-TODAY');
    expect(inForcePlanogram(all, EVENING, 'Asia/Kolkata')?.planogramId).toBe('PG-TODAY');
  });
  it('in a zone still on the UTC date it is not yet; a shop date given is kept as it is', () => {
    expect(inForcePlanogram(all, EVENING, 'Europe/London')?.planogramId).toBe('PG-OLD');
    expect(inForcePlanogram(all, UTC_DAY, 'Asia/Kolkata')?.planogramId).toBe('PG-OLD');
    expect(inForcePlanogram(all, SHOP_DAY, 'Europe/London')?.planogramId).toBe('PG-TODAY');
  });
});

describe('the price pack is built as of the shop\'s date (P2)', () => {
  const product = { productId: 'p-oil', tenantId: 't-1', sku: 'SKU-OIL', name: 'Oil 1 L', primaryCategoryId: 'grocery', baseUom: 'each', taxClass: '15079010', lifecycle: 'active',
    mrpHistory: [{ value: { minor: 100_00, currency: 'INR' }, effectiveFrom: '2026-01-01' }, { value: { minor: 120_00, currency: 'INR' }, effectiveFrom: SHOP_DAY }] } as unknown as ProductRecord;
  const deps = (calendar?: CataloguePreviewDeps['calendar'], gst: { effectiveFrom: string; rateBps: number }[] = [{ effectiveFrom: '2017-07-01', rateBps: 500 }]): CataloguePreviewDeps => ({
    products: () => [product],
    priceEntries: () => [{ id: 'e1', productId: 'p-oil', scope: 'store', scopeRef: 'S1', price: { minor: 95_00, currency: 'INR' }, effectiveFrom: '2026-01-01T00:00:00.000Z', status: 'active', version: 1 }],
    barcodes: () => [], taxSchedule: () => gst, now: () => EVENING,
    ...(calendar === undefined ? {} : { calendar }),
  });
  const built = (d: CataloguePreviewDeps, asOf = EVENING) => assembleCatalogueSnapshot(d, { tenantId: 't-1', storeId: 'S1', asOf, version: 1 });
  it('an MRP that starts on the shop\'s today reaches a pack built at 01:00 shop time', async () => {
    expect((await built(deps())).snapshot.products[0]).toMatchObject({ productId: 'p-oil', mrpMinor: 120_00 });
    expect((await built(deps(KOLKATA))).snapshot.products[0]).toMatchObject({ mrpMinor: 120_00 });
  });
  it('a GST rate starting on the shop\'s today is the pack\'s rate; the tenant\'s own zone decides', async () => {
    const rates = [{ effectiveFrom: '2017-07-01', rateBps: 500 }, { effectiveFrom: SHOP_DAY, rateBps: 1_200 }];
    expect((await built(deps(KOLKATA, rates))).snapshot.products[0]).toMatchObject({ taxBps: 1_200 });
    expect((await built(deps(LONDON, rates))).snapshot.products[0]).toMatchObject({ taxBps: 500, mrpMinor: 100_00 });
  });
  it('a date given (?asOf=YYYY-MM-DD) is already the shop\'s date', async () => {
    expect((await built(deps(LONDON), SHOP_DAY)).snapshot.products[0]).toMatchObject({ mrpMinor: 120_00 });
  });
});

const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({ tenantId: 't-1', userId: 'u-owner', branchId: null, scope: 'all', params: {}, query: {}, body: undefined, traceId: 't', ...over } as RequestContext);

describe('the CCTV links of a day are the shop\'s day (P3)', () => {
  const log: FloorDeviceLogEntry[] = [{ entry: 'registered', by: 'u-it', at: '2026-10-01T00:00:00.000Z', registration: { deviceId: 'cam-1', branchId: 'B1', label: 'Lane camera', vendor: 'stand-in', publicKey: 'k', binding: { kind: 'cctv_source', cameraId: 'CAM-1', laneIds: ['lane-1'] } } as never }];
  const events: StoredFloorEvent[] = [{
    deviceId: 'cam-1', branchId: 'B1', kind: 'cctv_source', eventId: 'c1', receivedAt: EVENING, relayedBy: 'u-gw',
    event: { eventId: 'c1', type: 'cctv.event', at: EVENING, from: EVENING, to: '2026-10-29T19:35:00.000Z', eventKind: 'lane_activity' } as never,
    outcome: { state: 'recorded', detail: 'kept' },
  }];
  const routes = (calendar?: FloorDeviceDeps['calendar']) => floorDeviceRoutes({ now: () => EVENING, log: async () => log, events: async () => events, laneExceptions: async () => [], ...(calendar === undefined ? {} : { calendar }) } as unknown as FloorDeviceDeps);
  const links = async (day: string, calendar?: FloorDeviceDeps['calendar']) => ((await route(routes(calendar), 'GET', '/v1/devices/cctv/links').handler(ctx({ query: { branchId: 'B1', day } }))).body as { links: { eventId: string }[] }).links.map((l) => l.eventId);
  it('a camera event at 01:00 shop time is on the shop\'s day, not the UTC day before', async () => {
    expect(await links(SHOP_DAY)).toEqual(['c1']);
    expect(await links(UTC_DAY)).toEqual([]);
    expect(await links(SHOP_DAY, KOLKATA)).toEqual(['c1']);
  });
  it('the tenant\'s own zone decides', async () => {
    expect(await links(UTC_DAY, LONDON)).toEqual(['c1']);
    expect(await links(SHOP_DAY, LONDON)).toEqual([]);
  });
});

describe('a rebate claim is raised on the shop\'s date (P3)', () => {
  function stub(calendar?: RebateClaimDeps['calendar']) {
    const facts: RebateClaimFact[] = [{ type: 'raised', claimId: 'c-1', schemeId: 'rb-1', supplierId: 'sup-1', amountMinor: 1_500, raisedBy: 'u-buyer', raisedAt: EVENING }];
    const accrual = { schemeId: 'rb-1', supplierId: 'sup-1', basisAmount: { minor: 80_000, currency: 'INR' }, accrued: { minor: 2_400, currency: 'INR' }, received: { minor: 0, currency: 'INR' }, outstanding: { minor: 2_400, currency: 'INR' }, thresholdMet: true, detail: '', accrualId: 'q' } as StoredRebateAccrual;
    const deps: RebateClaimDeps = {
      schemes: () => [{ schemeId: 'rb-1', supplierId: 'sup-1', basis: 'purchase_value', rateBp: 300, startsOn: '2026-01-01', endsOn: '2026-12-31', approvedBy: 'u-fin' }],
      accruals: () => [accrual], receipts: () => [], claimFacts: () => facts, claimsVersion: () => 0,
      recordFact: async (_t, _s, f) => { facts.push(f); },
      answerPeriods: () => [], recordAnswerPeriod: () => {},
      now: () => '2026-10-30T06:00:00.000Z',
      ...(calendar === undefined ? {} : { calendar }),
    };
    return rebateClaimRoutes(deps);
  }
  it('the claim document says it was raised on the shop\'s date', async () => {
    const doc = (await route(stub(), 'GET', '/v1/purchase/rebate-claims/:claimId/document').handler(ctx({ params: { claimId: 'c-1' } }))).body as { document?: { raisedOn: string }; raisedOn?: string };
    expect(doc.document?.raisedOn ?? doc.raisedOn).toBe(SHOP_DAY);
  });
  it('a claim raised at 01:00 shop time cannot be recorded as sent the day before (the UTC date) — refused by name', async () => {
    const send = route(stub(), 'POST', '/v1/purchase/rebate-claims/:claimId/send');
    await expect(send.handler(ctx({ params: { claimId: 'c-1' }, body: { approvalId: 'areq-1', sentOn: UTC_DAY } }))).rejects.toMatchObject({ status: 422, body: { code: 'sent_on_outside_the_claim' } });
    // In a zone still on the UTC date it WAS raised on 29 Oct: sent that day is not refused for its date.
    const london = route(stub(LONDON), 'POST', '/v1/purchase/rebate-claims/:claimId/send');
    await expect(london.handler(ctx({ params: { claimId: 'c-1' }, body: { approvalId: 'areq-1', sentOn: UTC_DAY } }))).rejects.not.toMatchObject({ body: { code: 'sent_on_outside_the_claim' } });
  });
});
