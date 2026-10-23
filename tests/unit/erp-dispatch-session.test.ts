import { describe, it, expect } from 'vitest';
import { createDispatchSession, readDrivers, dispatchWords, rupees, DISPATCH_COPY } from '../../apps/web-erp/src/dispatch-session';

// The Dispatch office page's session (M19-FR-01/03/04 · WF-14/15 · OB-294 · OB-313): what it offers by the viewer's own
// grants, what it refuses on the page before asking, and exactly what it asks head office. Synthetic data.

interface Call { method: string; path: string; body: unknown; key?: string }
function fakeFetch(reply: (c: Call) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const calls: Call[] = [];
  const fetch = (async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const c: Call = { method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body), ...(init.headers['idempotency-key'] === undefined ? {} : { key: init.headers['idempotency-key'] }) };
    calls.push(c);
    const r = reply(c);
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const ALL = ['delivery.run.read', 'fulfilment.wave.assign', 'delivery.dispatch.manage', 'delivery.contribution.approve', 'delivery.controls.set', 'delivery.settlement.approve'];

describe('the drivers box', () => {
  it('reads one driver per line in shop time (India +5:30) and refuses a line it cannot read', () => {
    expect(readDrivers('u-ravi, 12, 09:00, 18:00\n\n u-mani ,4,13:30,20:00 ', '2026-10-24', 330)).toEqual([
      { driverId: 'u-ravi', maxStops: 12, availableFrom: '2026-10-24T03:30:00.000Z', availableUntil: '2026-10-24T12:30:00.000Z' },
      { driverId: 'u-mani', maxStops: 4, availableFrom: '2026-10-24T08:00:00.000Z', availableUntil: '2026-10-24T14:30:00.000Z' },
    ]);
    for (const bad of ['', 'u-ravi', 'u-ravi, 0, 09:00, 18:00', 'u-ravi, 3, 9am, 18:00', 'u-ravi, x, 09:00, 18:00']) expect(readDrivers(bad, '2026-10-24', 330)).toBeUndefined();
  });
});

describe('what the page offers, by the viewer\'s own grants', () => {
  it('nobody named — nothing is asked; a cashier\'s grants open nothing here', async () => {
    const f = fakeFetch();
    const nobody = createDispatchSession({ viewer: undefined, fetch: f.fetch });
    expect(await nobody.board('2026-10-24', 'S1')).toEqual({ result: 'invalid', why: 'nobody' });
    const cashier = createDispatchSession({ viewer: { userId: 'u-cash', permissions: ['pos.sale.read'] }, fetch: f.fetch });
    expect(cashier.may).toEqual({ named: true, read: false, waves: false, dispatch: false, decide: false, setNumbers: false, approveSettlement: false });
    expect(await cashier.candidates('S1')).toEqual({ result: 'invalid', why: 'cannotWave' });
    expect(await cashier.plan({ runDate: '2026-10-24', storeId: 'S1', driversText: 'u, 1, 09:00, 10:00', speed: '20', minutes: '5' })).toEqual({ result: 'invalid', why: 'cannotDispatch' });
    expect(await cashier.setNumber('geofenceRadiusMetres', '150')).toEqual({ result: 'invalid', why: 'cannotSet' });
    expect(f.calls).toEqual([]);
  });
  it('a store manager may do the day\'s work but not enter the owner\'s numbers', () => {
    const mgr = createDispatchSession({ viewer: { userId: 'u-mgr', permissions: ALL.filter((p) => p !== 'delivery.controls.set') } });
    expect(mgr.may).toMatchObject({ read: true, waves: true, dispatch: true, decide: true, setNumbers: false, approveSettlement: true });
  });
});

describe('what it refuses on the page, before asking anybody', () => {
  const s = () => { const f = fakeFetch(); return { f, s: createDispatchSession({ viewer: { userId: 'u-owner', permissions: ALL }, fetch: f.fetch }) }; };
  it('a wave needs the wave, the picker and at least one order; a plan needs a date, the store, drivers, speed and minutes', async () => {
    const { f, s: d } = s();
    expect(await d.buildWave({ waveId: 'W1', storeId: 'S1', pickerId: '', orderIds: ['O1'] })).toEqual({ result: 'invalid', why: 'needPicker' });
    expect(await d.buildWave({ waveId: 'W1', storeId: 'S1', pickerId: 'u-pick', orderIds: [] })).toEqual({ result: 'invalid', why: 'chooseOrders' });
    expect(await d.plan({ runDate: '24-10-2026', storeId: 'S1', driversText: 'u, 1, 09:00, 10:00', speed: '20', minutes: '5' })).toEqual({ result: 'invalid', why: 'badDate' });
    expect(await d.plan({ runDate: '2026-10-24', storeId: ' ', driversText: 'u, 1, 09:00, 10:00', speed: '20', minutes: '5' })).toEqual({ result: 'invalid', why: 'needStore' });
    expect(await d.plan({ runDate: '2026-10-24', storeId: 'S1', driversText: '', speed: '20', minutes: '5' })).toEqual({ result: 'invalid', why: 'needDrivers' });
    expect(await d.plan({ runDate: '2026-10-24', storeId: 'S1', driversText: 'u, 1, 09:00, 10:00', speed: '', minutes: '5' })).toEqual({ result: 'invalid', why: 'needSpeed' });
    expect(await d.offRoad({ runDate: '2026-10-24', storeId: 'S1', driverId: 'u', reason: 'ill', driversText: 'u, 1, 09:00, 10:00', speed: '20', minutes: '5' })).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await d.decide('O1', 'approve', 'ok')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await d.setNumber('geofenceRadiusMetres', '1.5')).toEqual({ result: 'invalid', why: 'needNumber' });
    expect(await d.setNumber('fleetRate', 'per_week 10')).toEqual({ result: 'invalid', why: 'needNumber' });
    expect(await d.recordPaid('R1', '12.345', 'V1')).toEqual({ result: 'invalid', why: 'needNumber' });
    expect(f.calls).toEqual([]);
  });
});

describe('exactly what it asks head office', () => {
  it('reads with GET; writes with POST and a fresh idempotency key each time', async () => {
    const f = fakeFetch();
    const d = createDispatchSession({ viewer: { userId: 'u-owner', permissions: ALL }, fetch: f.fetch, newKey: (() => { let n = 0; return () => `k${++n}`; })() });
    await d.candidates('S 1');
    await d.buildWave({ waveId: 'W-1', storeId: 'S1', pickerId: 'u-pick', orderIds: ['O1', 'O2'] });
    await d.plan({ runDate: '2026-10-24', storeId: 'S1', driversText: 'u-ravi, 12, 09:00, 18:00', speed: '18', minutes: '6' });
    await d.assign('2026-10-24', '2026-10-24:u-ravi:slot', 'S1');
    await d.offRoad({ runDate: '2026-10-24', storeId: 'S1', driverId: 'u-ravi', reason: 'van broke down', driversText: 'u-ravi, 12, 09:00, 18:00\nu-mani, 6, 09:00, 18:00', speed: '18', minutes: '6' });
    await d.board('2026-10-24', 'S1');
    await d.decide('O1', 'approve', 'regular customer, keep them');
    await d.setNumber('geofenceRadiusMetres', '150');
    await d.setNumber('fleetRate', 'per_drop 4000');
    await d.recordPaid('R1', '280.5', 'PV-7');
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/fulfilment/wave-candidates?storeId=S%201',
      'POST /v1/fulfilment/waves/W-1/build',
      'POST /v1/delivery/dispatch/2026-10-24/plan-from-orders',
      'POST /v1/delivery/dispatch/2026-10-24/routes/2026-10-24%3Au-ravi%3Aslot/assign',
      'POST /v1/delivery/dispatch/2026-10-24/reassign-driver',
      'GET /v1/delivery/dispatch/2026-10-24/board?storeId=S1',
      'POST /v1/delivery/contribution/O1/decision',
      'POST /v1/delivery/controls',
      'POST /v1/delivery/controls',
      'POST /v1/delivery/fleet-settlements/R1/paid',
    ]);
    expect(f.calls[1]!.body).toEqual({ storeId: 'S1', pickerId: 'u-pick', orderIds: ['O1', 'O2'] });
    expect(f.calls[2]!.body).toEqual({ storeId: 'S1', drivers: [{ driverId: 'u-ravi', maxStops: 12, availableFrom: '2026-10-24T03:30:00.000Z', availableUntil: '2026-10-24T12:30:00.000Z' }], averageSpeedKmh: 18, serviceMinutesPerStop: 6 });
    expect(f.calls[4]!.body).toMatchObject({ withoutDriverId: 'u-ravi', reason: 'van broke down' });
    expect(f.calls[7]!.body).toEqual({ geofenceRadiusMetres: 150 });
    expect(f.calls[8]!.body).toEqual({ fleetRate: { basis: 'per_drop', rateMinor: 4000 } });
    expect(f.calls[9]!.body).toEqual({ amountMinor: 280_50, voucherRef: 'PV-7' });
    const keys = f.calls.filter((c) => c.method === 'POST').map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(f.calls.filter((c) => c.method === 'GET').every((c) => c.key === undefined)).toBe(true);
  });
  it('says a refusal in head office\'s own words, and a lost link as a lost link', async () => {
    const refused = createDispatchSession({ viewer: { userId: 'u-owner', permissions: ALL }, fetch: fakeFetch(() => ({ status: 409, body: { error: { code: 'route_started', whatHappened: 'u-ravi has already recorded doors' } } })).fetch });
    expect(await refused.assign('2026-10-24', 'R1', 'S1')).toEqual({ result: 'refused', status: 409, code: 'route_started', whatHappened: 'u-ravi has already recorded doors' });
    const lost = createDispatchSession({ viewer: { userId: 'u-owner', permissions: ALL }, fetch: (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch });
    expect(await lost.board('2026-10-24', 'S1')).toEqual({ result: 'lost_link' });
  });
});

describe('the words', () => {
  it('every English word has a Tamil twin, and the rupees are whole paise with Indian grouping', () => {
    expect(Object.keys(DISPATCH_COPY.ta).sort()).toEqual(Object.keys(DISPATCH_COPY.en).sort());
    expect(dispatchWords('ta', 'title')).toBe('அனுப்புதல்');
    expect(rupees(1_23_456_78)).toBe('₹1,23,456.78');
    expect(rupees(-5)).toBe('-₹0.05');
  });
});
