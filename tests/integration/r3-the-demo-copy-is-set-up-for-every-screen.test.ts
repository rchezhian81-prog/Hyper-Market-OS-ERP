// Round 3 of the screen gap audit (31 Oct 2026, "Round C — the demo is not set up"): the demo seed now leaves head office
// with what the screens need, each laid down through head office's REAL routes under the named person's own sign-in, and
// each proven here by using it through the same routes the screens call:
//   1. the seeded suppliers are in the supplier master (proposed by one person, approved by another), so buying accepts them;
//   2. the demo till is on head office's fleet register with its own bill-number prefix, which the store pack carries;
//   3. a warehouse supervisor is named, so a transfer one person proposed is sent by another (§28) and counted in —
//      Transfers could not be used with one manager alone;
//   4. the picker and driver handhelds get real work: an online order, its wave and its route, which the demo box pulls;
//   5. OB-559: business customers are switched on in the demo copy.
// Synthetic data only, in the demo tenant (hard rule #7).

import { describe, it, expect, beforeAll } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { applyPilotFoundation, applyPilotCatalogue, applyPilotTradingPartners, applyPilotTransactions } from '../../db/seed/pilot/apply';
import {
  PILOT_FOUNDATION, PILOT_CATALOGUE, PILOT_TRADING_PARTNERS, PILOT_TRANSACTIONS, PILOT_DEMO_TENANT, PILOT_DEMO_BRANCH,
  PILOT_DEMO_WAREHOUSE, PILOT_DEMO_TILL, PILOT_DEMO_ONLINE_ORDER, PILOT_DEMO_PICKER, PILOT_DEMO_DRIVER,
} from '../../db/seed/pilot/dataset';

const T = PILOT_DEMO_TENANT;
const OWNER = PILOT_FOUNDATION.genesisOwner.userId;
const SUPERVISOR = 'pilot-warehouse-supervisor';
let h: ApiHarness;

const get = async (path: string, userId: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path, userId, tenantId: T, ...(query === undefined ? {} : { query }) });
const post = async (path: string, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path, userId, tenantId: T, body, idempotencyKey: key });

beforeAll(async () => {
  h = apiHarness();
  for (const report of [
    await applyPilotFoundation(h, PILOT_FOUNDATION),
    await applyPilotCatalogue(h, PILOT_CATALOGUE, OWNER),
    await applyPilotTradingPartners(h, PILOT_TRADING_PARTNERS, OWNER),
    await applyPilotTransactions(h, PILOT_TRANSACTIONS, OWNER),
  ]) {
    expect(report.steps.filter((s) => !s.ok), JSON.stringify(report.steps.filter((s) => !s.ok))).toEqual([]);
  }
}, 120_000);

describe('Round 3: the demo copy is set up for every screen', () => {
  it('1. every seeded supplier is ACTIVE in the supplier master — proposed by the manager, approved by the accountant — and buying accepts it', async () => {
    const list = await get('/v1/purchase/suppliers', OWNER);
    expect(list.status).toBe(200);
    for (const s of PILOT_TRADING_PARTNERS.suppliers) {
      const one = await get(`/v1/purchase/suppliers/${s.partnerId}`, OWNER);
      expect(one.status).toBe(200);
      expect((one.body as { supplier: Record<string, unknown> }).supplier).toMatchObject({ status: 'active', createdBy: 'pilot-manager', approvedBy: 'pilot-accountant' });
    }
    // The buying page's own route: a purchase order to a seeded supplier is now accepted (before: 422 supplier_unknown).
    const po = await post('/v1/purchase/orders/po-r3-demo-1', 'pilot-manager', {
      supplierId: 'sup-demo-foods', deliverToLocationId: PILOT_DEMO_WAREHOUSE,
      lines: [{ productId: 'prod-rice', orderedQty: 10, uom: 'ea', unitCost: { minor: 5000, currency: 'INR' } }],
    }, 'r3-po-1');
    expect(po.status, JSON.stringify(po.body)).toBe(201);
  });

  it('2. the demo till is registered at head office and holds its own bill-number prefix, which the demo box\'s store pack carries', async () => {
    const fleet = await get('/v1/platform/devices', OWNER);
    expect(fleet.status).toBe(200);
    const devices = (fleet.body as { devices: readonly { deviceId: string; kind: string; branchId: string; status: string }[] }).devices;
    expect(devices.find((d) => d.deviceId === PILOT_DEMO_TILL.tillId)).toMatchObject({ kind: 'pos_lane', branchId: PILOT_DEMO_BRANCH, status: 'registered' });
    const prefixes = await get('/v1/receipt-prefixes', OWNER);
    expect(prefixes.status).toBe(200);
    expect(JSON.stringify(prefixes.body)).toContain(`"prefix":"${PILOT_DEMO_TILL.prefix}"`);
    // The box numbers its bills from what head office sends it.
    const pack = await get(`/v1/store-packs/${PILOT_DEMO_BRANCH}`, 'pilot-store-edge');
    expect(pack.status).toBe(200);
    const series = (pack.body as { sections: { receiptSeries?: readonly { laneId: string; prefix: string }[] } }).sections.receiptSeries;
    expect(series?.find((x) => x.laneId === PILOT_DEMO_TILL.tillId)?.prefix).toBe(PILOT_DEMO_TILL.prefix);
  });

  it('3. a warehouse supervisor is named, so a transfer is proposed, sent by the named supervisor (not the proposer) and counted in', async () => {
    const id = 'tr-r3-demo-1';
    const proposed = await post(`/v1/warehouse/transfers/${id}`, 'pilot-manager', {
      fromLocationId: PILOT_DEMO_WAREHOUSE, toLocationId: PILOT_DEMO_BRANCH, lines: [{ productId: 'prod-soap', quantityMinor: 10, uom: 'ea' }],
    }, 'r3-tr-propose');
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    // The proposer may not send their own transfer (§28) — the named supervisor does.
    expect((await post(`/v1/warehouse/transfers/${id}/dispatch`, 'pilot-manager', {}, 'r3-tr-self')).status).toBe(422);
    const sent = await post(`/v1/warehouse/transfers/${id}/dispatch`, SUPERVISOR, {}, 'r3-tr-dispatch');
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const counted = await post(`/v1/warehouse/transfers/${id}/receive`, 'pilot-manager', { counted: [{ productId: 'prod-soap', quantityMinor: 9 }] }, 'r3-tr-receive');
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    const one = await get(`/v1/warehouse/transfers/${id}`, OWNER);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).toContain(`"approvedBy":"${SUPERVISOR}"`);
  });

  it('4. the picker and driver handhelds get the online order\'s real wave and route, pulled by the demo box', async () => {
    const order = await get(`/v1/orders/${PILOT_DEMO_ONLINE_ORDER}`, OWNER);
    expect(order.status).toBe(200);
    const pulled = await get('/v1/fulfilment/assignments', 'pilot-store-edge', { storeId: PILOT_DEMO_BRANCH });
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
    const body = pulled.body as { waves: readonly { waveId: string; pickerId: string; lines: readonly { orderRef: string }[] }[]; routes: readonly { routeId: string; driverId: string; stops: readonly { orderRef: string }[] }[] };
    expect(body.waves.find((w) => w.waveId === 'wave-demo-1')).toMatchObject({ pickerId: PILOT_DEMO_PICKER });
    expect(body.waves[0]!.lines.every((l) => l.orderRef === PILOT_DEMO_ONLINE_ORDER)).toBe(true);
    expect(body.routes.find((r) => r.routeId === 'route-demo-1')).toMatchObject({ driverId: PILOT_DEMO_DRIVER });
  });

  it('5. OB-559: business customers are switched on in the demo copy', async () => {
    const res = await get('/v1/platform/entitlements', OWNER);
    expect((res.body as { entitled: readonly string[] }).entitled).toContain('b2b');
  });

  it('re-running the whole seed lands nothing twice and refuses nothing', async () => {
    for (const report of [
      await applyPilotFoundation(h, PILOT_FOUNDATION),
      await applyPilotTradingPartners(h, PILOT_TRADING_PARTNERS, OWNER),
      await applyPilotTransactions(h, PILOT_TRANSACTIONS, OWNER),
    ]) expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    const fleet = await get('/v1/platform/devices', OWNER);
    expect((fleet.body as { devices: readonly { deviceId: string }[] }).devices.filter((d) => d.deviceId === PILOT_DEMO_TILL.tillId)).toHaveLength(1);
  }, 120_000);
});
