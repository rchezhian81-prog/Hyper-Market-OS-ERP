import { describe, it, expect, afterAll } from 'vitest';
import { startScreenServer, SCREEN_HOST, DATA_MARKER, type ScreenServer } from '../../edge/store-edge/src/screen-server';
import { GLOBAL_FOR, SCREENS, type ScreenInput, type ScreenName } from '../../edge/store-edge/src/screen-data';
import { known, notKnown, type PackProduct, type StorePack } from '../../edge/store-edge/src/store-pack';
import type { LoggedSale } from '../../edge/store-edge/src/read-model';
import { SyncOutbox } from '../../packages/sync/src/index';
import { makeEvent } from '../../packages/contracts/src/event';
import { bootManager } from '../../apps/web-erp/src/browser-entry';
import { bootOwner, forgetfulQueueStore } from '../../apps/owner-app/src/browser-entry';
import { bootShop, forgetfulBasket } from '../../apps/customer-app/src/browser-entry';
import { bootPicker } from '../../apps/picker-app/src/browser-entry';
import { bootDriver } from '../../apps/delivery-app/src/browser-entry';
import { DeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';

/**
 * **The join, driven end to end over a real socket.**
 *
 * Every screen was built to read a global at boot and nothing ever set one, so six screens sat
 * honestly reporting that they had been told nothing. This proves the box now tells them — by
 * starting the real server, fetching the real shells from disk, pulling the injected payload out
 * of the HTML, and booting each screen's real session on it.
 *
 * Nothing is stubbed. If the marker were missing from a shell, if a payload builder produced the
 * wrong shape, or if a screen's global were renamed, this fails.
 *
 * **The headline case is the manager's day close.** It has refused to close for three sessions,
 * correctly, because the two registers it gates on had no producer anywhere. They do now.
 */

const NOW = '2026-08-05T14:00:00.000Z';
const DAY = '2026-08-05';

const PRODUCTS: PackProduct[] = [
  {
    productId: 'p1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 145_00,
    unitCostMinor: 100_00, uom: 'ea', barcodes: ['8901'], availableMinor: 10,
  },
];

const SALE: LoggedSale = {
  id: 'S-1', number: 'R-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: DAY,
  committedAt: NOW, total: 145_00, netMinor: 122_88, taxMinor: 22_12, currency: 'INR',
  lines: [{ productId: 'p1', quantityMinor: 1, uom: 'ea' }],
  tenders: [{ kind: 'cash', amount: { minor: 145_00 } }],
};

const pack = (over: Partial<StorePack> = {}): StorePack => ({
  receivedAt: NOW,
  version: 7,
  policies: known({
    storeId: 'store-1', branchId: 'b1', branchName: 'SRE Hyper Market',
    tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_00,
    handoverToleranceMinor: 100_00, privacySlaDays: 30, warehouseId: 'wh-1',
  }),
  products: known(PRODUCTS),
  approvals: known([{
    id: 'a1', subjectType: 'price_change', subjectRef: 'Toor dal 1kg',
    requestedBy: 'u-buyer', branchId: 'b1', valueMinor: 45_000,
  }]),
  checklist: known([]),
  wave: known({
    waveId: 'w1', pickerId: 'u-picker',
    lines: [{
      lineId: 'l1', orderRef: 'ORD-1', productId: 'p1', description: 'Toor dal 1kg',
      bin: 'A-01', requiredQty: 2, uom: 'ea', unitPriceMinor: 145_00,
    }],
  }),
  route: known({
    routeId: 'r1', driverId: 'd1',
    stops: [{ stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 250_00 }],
  }),
  slots: known([{
    slotId: 'today-evening', startsAt: '2026-08-05T17:00:00.000Z',
    endsAt: '2026-08-05T19:00:00.000Z', capacity: 5, booked: 0, kind: 'delivery',
  }]),
  lossPreventionRules: known([{ kind: 'refund', maxCount: 2 }]),
  consentPurposes: known([{ purpose: 'marketing', channel: 'sms' }]),
  ...over,
});

const servers: ScreenServer[] = [];
afterAll(async () => { for (const s of servers) await s.stop(); });

/** Start the real server against the real `apps/` folder on disk. */
async function serve(snapshot: () => ScreenInput): Promise<string> {
  const server = await startScreenServer({ port: 0, appsDir: 'apps', snapshot });
  servers.push(server);
  return `http://${SCREEN_HOST}:${server.port}`;
}

const snapshotOf = (over: Partial<ScreenInput> = {}): (() => ScreenInput) => () => ({
  pack: pack(), sales: [SALE], unreadableRecords: 0, outbox: new SyncOutbox(),
  now: NOW, tradingDay: DAY, ...over,
});

/** Fetch a screen and pull the payload the box injected out of its HTML. */
async function payloadFromScreen(base: string, screen: ScreenName): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${base}/${screen}`);
  expect(response.status, `${screen} did not serve`).toBe(200);
  const html = await response.text();
  const global = GLOBAL_FOR[screen];
  const match = new RegExp(`<script>window\\.${global} = ([\\s\\S]*?);</script>`).exec(html);
  if (match === null) {
    // The marker is still there, which means the box had nothing to say — a real, supported state.
    expect(html, `${screen} lost its data marker`).toContain(DATA_MARKER);
    return null;
  }
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

describe('every screen is served, and served its own data', () => {
  it('serves all six shells from disk with their payload injected', async () => {
    const base = await serve(snapshotOf());
    for (const screen of SCREENS) {
      const payload = await payloadFromScreen(base, screen);
      expect(payload, `${screen} was served nothing`).not.toBeNull();
    }
  });

  it('serves each screen’s static files too, so the shell actually runs', async () => {
    const base = await serve(snapshotOf());
    const response = await fetch(`${base}/manager/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
  });

  it('refuses anything that is not a screen, and anything that climbs out', async () => {
    const base = await serve(snapshotOf());
    expect((await fetch(`${base}/admin`)).status).toBe(404);
    expect((await fetch(`${base}/manager/..%2f..%2f..%2fpackage.json`)).status).toBe(400);
    expect((await fetch(`${base}/manager/nothing-here.js`)).status).toBe(404);
  });

  it('refuses to be written to — this socket only reads', async () => {
    const base = await serve(snapshotOf());
    expect((await fetch(`${base}/manager`, { method: 'POST' })).status).toBe(405);
  });

  it('sends the payload FRESH on every request, not the state at boot', async () => {
    // A manager reloading at four o'clock must see four o'clock's queue.
    const outbox = new SyncOutbox();
    const base = await serve(snapshotOf({ outbox }));
    expect((await payloadFromScreen(base, 'manager'))!['unsentItems']).toEqual([]);

    outbox.enqueue(makeEvent({
      id: 'e1', type: 'SaleCommitted', occurredAt: NOW, idempotencyKey: 'k1', source: 'lane-1', payload: {},
    }));
    expect((await payloadFromScreen(base, 'manager'))!['unsentItems']).toHaveLength(1);
  });
});

describe('the manager’s day close — the loop that has been open for three sessions', () => {
  const manager = (payload: Record<string, unknown>) => bootManager({
    storeId: 'store-1', branchId: 'b1', tradingDay: '2026-08-04', tradingDayCutoff: '02:00',
    managerId: 'u-mgr', approvalLimitMinor: 500_000, warehouseId: 'wh-1',
    data: payload as Parameters<typeof bootManager>[0] extends undefined ? never : NonNullable<Parameters<typeof bootManager>[0]>['data'],
  });

  it('CLOSES a clean day, now that both gates have a producer', async () => {
    // The whole point of the session. Every previous run refused — correctly — because the
    // exception register and the unsent register had nothing behind them anywhere in the system.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'manager'))!;

    const attempt = manager(payload).closeTheDay({
      dayCloseId: 'dc-1', closedAtLocal: '2026-08-05T02:30', closedAt: NOW,
    });
    expect(attempt.closed).toBe(true);
    if (!attempt.closed) return;
    expect(attempt.result.locked).toBe(true);
  });

  it('still refuses when something really is unsent', async () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(makeEvent({
      id: 'e1', type: 'SaleCommitted', occurredAt: NOW, idempotencyKey: 'k1', source: 'lane-1', payload: {},
    }));
    const base = await serve(snapshotOf({ outbox }));
    const payload = (await payloadFromScreen(base, 'manager'))!;

    const attempt = manager(payload).closeTheDay({
      dayCloseId: 'dc-2', closedAtLocal: '2026-08-05T02:30', closedAt: NOW,
    });
    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers[0]).toMatchObject({ kind: 'items_unsent', count: 1 });
  });

  it('still refuses when the box was never told the loss-prevention rules', async () => {
    // The section is absent, so the screen says "not known" — and a day is not locked on a
    // register nobody ever checked. This is the control that has been holding all along.
    const base = await serve(snapshotOf({ pack: pack({ lossPreventionRules: notKnown('no rules sent') }) }));
    const payload = (await payloadFromScreen(base, 'manager'))!;

    const attempt = manager(payload).closeTheDay({
      dayCloseId: 'dc-3', closedAtLocal: '2026-08-05T02:30', closedAt: NOW,
    });
    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers[0]).toMatchObject({ kind: 'cannot_see', source: 'exceptions' });
  });

  it('shows the approval the cloud routed here, and lets the manager clear it', async () => {
    const base = await serve(snapshotOf());
    const session = manager((await payloadFromScreen(base, 'manager'))!);

    const queue = session.approvalQueue();
    expect(queue.known).toBe(true);
    if (!queue.known) return;
    expect(queue.rows[0]?.request.id).toBe('a1');

    const outcome = session.decideApproval({
      requestId: 'a1', decision: 'approved', reasonCode: 'checked_the_stock', decidedAt: NOW,
    });
    expect(outcome.ok).toBe(true);
  });

  it('can value a stock count, because the box served the cost prices', async () => {
    // Without them the count is refused rather than valued at nothing — proved from the other side
    // in the manager's own tests. This is the half that makes it work in a real shop.
    const base = await serve(snapshotOf());
    const session = manager((await payloadFromScreen(base, 'manager'))!);
    const attempt = session.countStock({
      countId: 'c-1', productId: 'p1', locationId: 'aisle-1', uom: 'ea',
      countedMinor: 0, reasonCode: 'shrinkage', at: NOW,
    });
    expect(attempt.counted).toBe(true);
  });
});

describe('the other five screens boot on what the box served them', () => {
  it('the owner’s brief carries the day’s real takings and a real margin', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'owner'))!;
    const session = bootOwner(payload as Parameters<typeof bootOwner>[0], forgetfulQueueStore(), () => NOW)!;

    const brief = session.brief();
    expect(brief.kpis.grossSalesMinor).toBe(145_00);
    // ₹122.88 net − ₹100.00 cost. A margin that could only exist because the pack carried a cost.
    expect(brief.kpis.marginMinor).toBe(122_88 - 100_00);
    expect(brief.freshness.state).toBe('fresh');
  });

  it('the owner’s figures exclude what could not be costed, and say how many', async () => {
    const uncosted: LoggedSale = { ...SALE, id: 'S-2', lines: [{ productId: 'p-unknown', quantityMinor: 1, uom: 'ea' }] };
    const base = await serve(snapshotOf({ sales: [SALE, uncosted] }));
    const payload = (await payloadFromScreen(base, 'owner'))!;

    expect(payload['uncostable']).toMatchObject({ sales: 1, billCount: 2, products: ['p-unknown'] });
    const session = bootOwner(payload as Parameters<typeof bootOwner>[0], forgetfulQueueStore(), () => NOW)!;
    // One bill in the margin figures, two bills taken. Both true, and the gap is named.
    expect(session.brief().kpis.basketCount).toBe(1);
  });

  it('the customer app opens a real catalogue, tied to the pack version', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'customer'))!;
    const shop = bootShop(payload as Parameters<typeof bootShop>[0], forgetfulBasket(), () => 'DSR-1')!;

    // The hits ARRAY — the shape the engine actually returns. The view read `.hits` and reported
    // "nothing matched that" for every search there has ever been; found by driving this path.
    expect(shop.search('toor').length).toBeGreaterThan(0);
    expect(shop.search('toor')[0]?.product.name).toBe('Toor dal 1kg');
    expect(shop.slots()).toHaveLength(1);
    // The version is what lets a stale price be refused rather than quietly repriced (P-02).
    expect(payload['packVersion']).toBe(7);
  });

  it('the picker opens the wave the cloud assigned', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'picker'))!;
    const wave = bootPicker(payload as Parameters<typeof bootPicker>[0], new DeviceOutbox(noDeviceStore()), () => NOW)!;

    expect(wave.work()).toHaveLength(1);
    expect(wave.work()[0]?.bin).toBe('A-01');
  });

  it('the driver opens the route the cloud dispatched', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'driver'))!;
    const route = bootDriver(payload as Parameters<typeof bootDriver>[0], new DeviceOutbox(noDeviceStore()), () => NOW)!;

    expect(route.route()).toHaveLength(1);
    expect(route.route()[0]?.codMinor).toBe(250_00);
  });

  it('the till gets the catalogue it needs to scan with no line at all', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'pos'))!;
    const products = payload['products'] as { barcodes: string[] }[];
    expect(products[0]?.barcodes).toEqual(['8901']);
  });
});

describe('a box that has been told nothing tells every screen so', () => {
  const nothing = snapshotOf({
    pack: {
      receivedAt: null, version: 0,
      policies: notKnown('never'), products: notKnown('never'), approvals: notKnown('never'),
      checklist: notKnown('never'), wave: notKnown('never'), route: notKnown('never'),
      slots: notKnown('never'), lossPreventionRules: notKnown('never'), consentPurposes: notKnown('never'),
    },
    sales: [],
  });

  it('serves the shells with no payload at all, marker intact', async () => {
    const base = await serve(nothing);
    for (const screen of ['pos', 'owner', 'picker', 'driver', 'customer'] as const) {
      expect(await payloadFromScreen(base, screen), `${screen} invented something`).toBeNull();
    }
  });

  it('still tells the manager what it CAN answer, and stays silent on the rest', async () => {
    // The box always knows its own outbox, so the unsent register is answerable even on a box
    // that has never heard from the cloud. Everything else is absent rather than empty.
    const base = await serve(nothing);
    const payload = (await payloadFromScreen(base, 'manager'))!;
    expect(payload['unsentItems']).toEqual([]);
    for (const section of ['openExceptions', 'approvals', 'tasks', 'products']) {
      expect(section in payload, `"${section}" must be absent`).toBe(false);
    }
  });

  it('and the manager’s day close refuses, which is the correct answer', async () => {
    const base = await serve(nothing);
    const payload = (await payloadFromScreen(base, 'manager'))!;
    const attempt = bootManager({
      storeId: 'store-1', branchId: 'b1', tradingDay: '2026-08-04', tradingDayCutoff: '02:00',
      managerId: 'u-mgr', data: payload as never,
    }).closeTheDay({ dayCloseId: 'dc-9', closedAtLocal: '2026-08-05T02:30', closedAt: NOW });

    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers.some((b) => b.kind === 'cannot_see')).toBe(true);
  });
});
