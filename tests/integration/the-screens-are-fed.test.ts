import { describe, it, expect, afterAll } from 'vitest';
import { startScreenServer, SCREEN_HOST, DATA_MARKER, type ScreenServer } from '../../edge/store-edge/src/screen-server';
import { GLOBAL_FOR, SCREENS, type ScreenInput, type ScreenName } from '../../edge/store-edge/src/screen-data';
import { known, notKnown, type PackProduct, type StorePack } from '../../edge/store-edge/src/store-pack';
import type { LoggedSale } from '../../edge/store-edge/src/read-model';
import { SyncOutbox } from '../../packages/sync/src/index';
import { resolvePrice } from '../../packages/price-list/src/index';
import { makeEvent } from '../../packages/contracts/src/event';
import { bootBuying, bootCatalogue, bootManager, buyingGaps, catalogueGaps } from '../../apps/web-erp/src/browser-entry';
import { bootOwner, forgetfulQueueStore } from '../../apps/owner-app/src/browser-entry';
import { bootShop, forgetfulBasket } from '../../apps/customer-app/src/browser-entry';
import { bootPicker } from '../../apps/picker-app/src/browser-entry';
import { bootDriver } from '../../apps/delivery-app/src/browser-entry';
import { DeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import type { PackDelivery, PackDriver } from '../../edge/store-edge/src/store-pack';

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

const SHELF_LOCATIONS = [
  { storeId: 'store-1', locationId: 'L-A1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, label: 'A1' },
  // Physically the FIRST thing you walk past, and it must still be collected last.
  { storeId: 'store-1', locationId: 'L-COLD', aisle: 0, rack: 1, bay: 1, shelf: 1, position: 1, label: 'Chiller', zone: 'chilled' as const },
];

const SHELF_ASSIGNMENTS = [
  { storeId: 'store-1', productId: 'p1', locationId: 'L-A1', capacityMinor: 24, primary: true },
  { storeId: 'store-1', productId: 'p-milk', locationId: 'L-COLD', capacityMinor: 60, primary: true },
];

const CATEGORIES = [{
  categoryId: 'grocery', name: 'Grocery', parentId: null,
  attributes: [{ key: 'packSize', label: 'a pack size', type: 'text' as const, required: true }],
}];

const MASTER = [{
  productId: 'p1', tenantId: 't1', sku: 'SKU-1', name: 'Toor dal 1kg', brand: 'Aachi',
  primaryCategoryId: 'grocery', baseUom: 'ea', taxClass: '0713',
  attributes: { packSize: '1kg' },
  mrpHistory: [{ value: { minor: 160_00, currency: 'INR' as const }, effectiveFrom: '2026-01-01' }],
  lifecycle: 'active' as const,
}];

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
    // Deliberately in the order a CUSTOMER would type it: milk, dal, milk again. Nothing had ever
    // re-sequenced a wave, so this is exactly the walk a picker used to be given.
    lines: [
      {
        lineId: 'l0', orderRef: 'ORD-1', productId: 'p-milk', description: 'Milk 1L',
        bin: 'C-01', requiredQty: 1, uom: 'ea', unitPriceMinor: 60_00,
      },
      {
        lineId: 'l1', orderRef: 'ORD-1', productId: 'p1', description: 'Toor dal 1kg',
        bin: 'A-01', requiredQty: 2, uom: 'ea', unitPriceMinor: 145_00,
      },
    ],
  }),
  route: known({
    routeId: 'r1', driverId: 'd1',
    stops: [{ stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 250_00 }],
  }),
  deliveries: known([]),
  drivers: known([]),
  routingPolicy: known({
    storeLocation: { lat: 11, lon: 77 }, radiusMetres: 10_000,
    averageSpeedKmh: 20, serviceMinutesPerStop: 5,
  }),
  slots: known([{
    slotId: 'today-evening', startsAt: '2026-08-05T17:00:00.000Z',
    endsAt: '2026-08-05T19:00:00.000Z', capacity: 5, booked: 0, kind: 'delivery',
  }]),
  purchaseOrders: known([{
    poId: 'PO-1', supplierId: 'sup-1',
    lines: [{ productId: 'p1', qty: 10, unitMinor: 90_00 }],
  }]),
  receipts: known([{ poId: 'PO-1', lines: [{ productId: 'p1', qty: 10 }] }]),
  supplierInvoices: known([]),
  buyingPolicy: known({
    buyerId: 'u-buyer', approvers: ['u-manager', 'u-buyer'],
    quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100,
  }),
  categories: known(CATEGORIES),
  productMaster: known(MASTER),
  priceEntries: known([{
    id: 'pe-1', productId: 'p1', scope: 'store', scopeRef: 'store-1',
    priceMinor: 145_00, effectiveFrom: '2026-01-01', status: 'active', version: 1,
  }]),
  pricingPolicy: known({
    userId: 'u-pricing', approvers: ['u-manager', 'u-pricing'], marginFloorBps: 2000,
  }),
  shelfLocations: known(SHELF_LOCATIONS),
  shelfAssignments: known(SHELF_ASSIGNMENTS),
  shelfPolicy: known({ zoneOrder: ['ambient', 'chilled', 'frozen'] }),
  lossPreventionRules: known([{ kind: 'refund', maxCount: 2 }]),
  consentPurposes: known([{ purpose: 'marketing', channel: 'sms' }]),
  ...over,
});

const STORE = { lat: 11.0, lon: 77.0 };
const DELIVERIES: PackDelivery[] = [
  { orderId: 'ORD-1', slotId: 'evening', slotStartsAt: '2026-08-05T17:00:00.000Z', slotEndsAt: '2026-08-05T19:00:00.000Z', area: 'Anna Nagar', location: { lat: 11.04, lon: 77.0 }, codMinor: 250_00 },
  { orderId: 'ORD-2', slotId: 'evening', slotStartsAt: '2026-08-05T17:00:00.000Z', slotEndsAt: '2026-08-05T19:00:00.000Z', area: 'Gandhipuram', location: { lat: 11.005, lon: 77.0 }, codMinor: 0 },
  { orderId: 'ORD-3', slotId: 'evening', slotStartsAt: '2026-08-05T17:00:00.000Z', slotEndsAt: '2026-08-05T19:00:00.000Z', area: 'Unknown', codMinor: 0 },
];
const DRIVERS: PackDriver[] = [
  { driverId: 'd1', maxStops: 10, availableFrom: '2026-08-05T16:00:00.000Z', availableUntil: '2026-08-05T21:00:00.000Z' },
];
const ROUTING = {
  storeLocation: STORE, radiusMetres: 10_000, averageSpeedKmh: 20, serviceMinutesPerStop: 5,
};

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

    expect(wave.work()).toHaveLength(2);
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
      deliveries: notKnown('never'), drivers: notKnown('never'), routingPolicy: notKnown('never'),
      slots: notKnown('never'), purchaseOrders: notKnown('never'), receipts: notKnown('never'),
      supplierInvoices: notKnown('never'), buyingPolicy: notKnown('never'),
      categories: notKnown('never'), productMaster: notKnown('never'),
      priceEntries: notKnown('never'), pricingPolicy: notKnown('never'),
      shelfLocations: notKnown('never'), shelfAssignments: notKnown('never'),
      shelfPolicy: notKnown('never'),
      lossPreventionRules: notKnown('never'), consentPurposes: notKnown('never'),
    },
    sales: [],
  });

  it('serves the shells with no payload at all, marker intact', async () => {
    const base = await serve(nothing);
    for (const screen of ['pos', 'owner', 'picker', 'driver', 'customer', 'buying', 'catalogue'] as const) {
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

describe('the box plans the driver’s route itself (M19-FR-03)', () => {
  const dispatching = snapshotOf({
    pack: pack({
      route: known(null), // nothing hand-written, so the planner decides
      deliveries: known(DELIVERIES),
      drivers: known(DRIVERS),
      routingPolicy: known(ROUTING),
    }),
  });

  it('serves a planned route the driver’s phone can open', async () => {
    // Dispatch runs on the BOX. A shop whose routes could only be planned when the internet was
    // up would stop delivering on the afternoon the router dies (P-01).
    const base = await serve(dispatching);
    const payload = (await payloadFromScreen(base, 'driver'))!;

    expect(payload['plannedBy']).toBe('this store box');
    expect(payload['distancesAre']).toBe('straight_line');

    const route = bootDriver(payload as Parameters<typeof bootDriver>[0], new DeviceOutbox(noDeviceStore()), () => NOW)!;
    // The two that could be placed, nearest first. The third had no location.
    expect(route.route().map((s) => s.orderRef)).toEqual(['ORD-2', 'ORD-1']);
    expect(route.route()[0]?.codMinor).toBe(0);
  });

  it('puts the order it could NOT plan on the manager’s exception register', async () => {
    // An undispatched order is a customer who ordered, paid and is waiting. It belongs where
    // somebody looks — and it holds the day close, which is correct.
    const base = await serve(dispatching);
    const manager = (await payloadFromScreen(base, 'manager'))!;
    const exceptions = manager['openExceptions'] as { id: string; what: string }[];

    const unplanned = exceptions.find((e) => e.id === 'dispatch:ORD-3');
    expect(unplanned).toBeDefined();
    expect(unplanned?.what).toMatch(/no delivery location/i);
  });

  it('and the day will not close while that order is still unplanned', async () => {
    const base = await serve(dispatching);
    const attempt = bootManager({
      storeId: 'store-1', branchId: 'b1', tradingDay: '2026-08-04', tradingDayCutoff: '02:00',
      managerId: 'u-mgr', data: (await payloadFromScreen(base, 'manager'))! as never,
    }).closeTheDay({ dayCloseId: 'dc-r', closedAtLocal: '2026-08-05T02:30', closedAt: NOW });

    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers.find((b) => b.kind === 'exceptions_open')?.items.some((i) => i.id === 'dispatch:ORD-3')).toBe(true);
  });

  it('lets a dispatcher override the planner, and says which the driver is holding', async () => {
    // Software that cannot be overridden gets worked around — which means a driver with a piece
    // of paper and a screen that disagrees with it.
    const base = await serve(snapshotOf({
      pack: pack({
        deliveries: known(DELIVERIES), drivers: known(DRIVERS), routingPolicy: known(ROUTING),
        route: known({
          routeId: 'by-hand', driverId: 'd1',
          stops: [{ stopId: 's1', orderRef: 'ORD-9', area: 'Wherever the dispatcher said', codMinor: 0 }],
        }),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'driver'))!;
    expect(payload['routeId']).toBe('by-hand');
    expect(payload['plannedBy']).toBe('a dispatcher, by hand');
  });

  it('serves nothing when the box has not been told the orders or the fleet', async () => {
    // Not an empty route. "Nobody has any deliveries today" and "I have not been told what today's
    // deliveries are" are different sentences, and the screen says which.
    const base = await serve(snapshotOf({
      pack: pack({ route: known(null), deliveries: notKnown('never sent'), drivers: known(DRIVERS), routingPolicy: known(ROUTING) }),
    }));
    expect(await payloadFromScreen(base, 'driver')).toBeNull();
  });

  it('re-plans the day around a van that is off the road', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        route: known(null), deliveries: known(DELIVERIES), routingPolicy: known(ROUTING),
        drivers: known([
          { ...DRIVERS[0]!, unavailable: true },
          { driverId: 'd2', maxStops: 10, availableFrom: '2026-08-05T16:00:00.000Z', availableUntil: '2026-08-05T21:00:00.000Z' },
        ]),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'driver'))!;
    expect(payload['driverId']).toBe('d2');
    expect((payload['stops'] as unknown[])).toHaveLength(2);
  });
});

/**
 * **The buyer's screen, driven over the same socket (M06 · M07 · §28).**
 *
 * This is the one screen where being wrong costs money that has already left. So it is driven the
 * hard way: the real server, the real `buying.html` off disk, the payload pulled back out of the
 * page, and the real `BuyingSession` booted on it — the same code path a buyer standing at the
 * goods-in door would be running.
 */
describe('the buyer’s screen is fed, and fed only what the box actually knows', () => {
  /** A clean two-line invoice for the products the pack carries: 10 × ₹90 = ₹900.00 */
  const FILE = [
    'productId,quantity,unitPriceMinor,lineTotalMinor',
    'p1,10,9000,90000',
  ].join('\n');
  const TOTAL = 90_000;

  const approvalBy = (decidedBy: string, invoiceId: string) => ({
    id: `ap-${invoiceId}`, subjectType: 'supplier_invoice', subjectRef: invoiceId,
    requestedBy: 'u-buyer', branchId: null, value: null,
    status: 'approved' as const, decidedBy, reason: 'checked_with_supplier', decidedAt: NOW,
  });

  it('serves the buyer their OWN page, not the manager’s', async () => {
    // Both screens live in `apps/web-erp/web` and share one bundle. A bare `/buying` that resolved
    // to `index.html` would put a day close in front of somebody who came to capture an invoice.
    const base = await serve(snapshotOf());
    const html = await (await fetch(`${base}/buying`)).text();
    expect(html).toContain('id="declared-total"');
    expect(html, 'the manager’s screen was served to the buyer').not.toContain('id="close-title"');
    // …and the manager's own page is still the manager's.
    const manager = await (await fetch(`${base}/manager`)).text();
    expect(manager).toContain('id="close-title"');
  });

  it('removes the buyer from their own approver list before the page is even built', async () => {
    // The pack lists `u-buyer` among the approvers — a tenant misconfiguration, and exactly the
    // one that separation of duties is supposed to survive. It must never reach the screen.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'buying'))!;
    expect(payload['approvers']).toEqual(['u-manager']);
    expect(payload['buyerId']).toBe('u-buyer');
  });

  it('captures a whole supplier invoice in one go, once somebody else has checked it', async () => {
    // Audit finding A-03: eighty lines retyped by hand every week. This is the replacement.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'buying'))!;
    const buying = bootBuying(payload as never)!;

    const preview = buying.previewInvoice({ text: FILE, declaredTotalMinor: TOTAL });
    expect(preview.problems).toEqual([]);
    expect(preview.readyToApprove).toBe(true);

    const outcome = buying.captureInvoice({
      invoiceId: 'INV-1', supplierId: 'sup-1', preview, approval: approvalBy('u-manager', 'INV-1'),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.lines).toHaveLength(1);
    expect(outcome.totalMinor).toBe(TOTAL);
  });

  it('refuses the buyer’s own approval, on the payload the box actually served', async () => {
    const base = await serve(snapshotOf());
    const buying = bootBuying((await payloadFromScreen(base, 'buying'))! as never)!;
    const preview = buying.previewInvoice({ text: FILE, declaredTotalMinor: TOTAL });
    const outcome = buying.captureInvoice({
      invoiceId: 'INV-2', supplierId: 'sup-1', preview, approval: approvalBy('u-buyer', 'INV-2'),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('approved_by_the_person_who_captured_it');
  });

  it('catches a missing line that every remaining line would pass', async () => {
    // The control total is the only figure in the flow that does not come from the file. A file
    // whose lines are each perfect and whose sum is short is a file missing a line, and nothing
    // else in the system can notice.
    const base = await serve(snapshotOf());
    const buying = bootBuying((await payloadFromScreen(base, 'buying'))! as never)!;
    const preview = buying.previewInvoice({ text: FILE, declaredTotalMinor: TOTAL + 45_00 });

    expect(preview.problems).toEqual([]); // every line is individually fine
    expect(preview.readyToApprove).toBe(false);
    const outcome = buying.captureInvoice({
      invoiceId: 'INV-3', supplierId: 'sup-1', preview, approval: approvalBy('u-manager', 'INV-3'),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('does_not_add_up_to_the_invoice_total');
  });

  it('will not call an uncaptured invoice agreed with the order', async () => {
    // *Not checked* is not *clean*. Three documents cannot agree when we are holding two of them.
    const base = await serve(snapshotOf());
    const buying = bootBuying((await payloadFromScreen(base, 'buying'))! as never)!;
    const result = buying.match({ poId: 'PO-1', invoiceId: 'INV-NEVER-CAPTURED' });
    expect(result.blocked).toBe(true);
  });

  it('matches a captured invoice against what was ordered and what arrived', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        supplierInvoices: known([{
          invoiceId: 'INV-9',
          lines: [{ productId: 'p1', quantity: 10, unitPriceMinor: 90_00, lineTotalMinor: 900_00 }],
        }]),
      }),
    }));
    const buying = bootBuying((await payloadFromScreen(base, 'buying'))! as never)!;
    const result = buying.match({ poId: 'PO-1', invoiceId: 'INV-9' });
    expect(result.blocked).toBe(false);
    expect(result.payableMinor).toBe(900_00);
  });

  it('adds up two deliveries against one order rather than losing the first', async () => {
    // Half on Monday and the rest on Thursday is an ordinary week. Overwriting would report that
    // only Thursday's half arrived, and the match would withhold payment for goods on the shelf.
    const base = await serve(snapshotOf({
      pack: pack({
        receipts: known([
          { poId: 'PO-1', lines: [{ productId: 'p1', qty: 4 }] },
          { poId: 'PO-1', lines: [{ productId: 'p1', qty: 6 }] },
        ]),
        supplierInvoices: known([{
          invoiceId: 'INV-9',
          lines: [{ productId: 'p1', quantity: 10, unitPriceMinor: 90_00, lineTotalMinor: 900_00 }],
        }]),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'buying'))!;
    const received = payload['received'] as Record<string, { qty: number }[]>;
    expect(received['PO-1']?.[0]?.qty).toBe(10);

    const buying = bootBuying(payload as never)!;
    expect(buying.match({ poId: 'PO-1', invoiceId: 'INV-9' }).blocked).toBe(false);
  });

  it('serves the buyer nothing at all when the box has no buying policy', async () => {
    // A screen inventing its own match tolerances would be deciding, on its own authority, how big
    // a price difference is worth nobody's attention.
    const base = await serve(snapshotOf({ pack: pack({ buyingPolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'buying')).toBeNull();
    expect(bootBuying(undefined)).toBeNull();
  });

  it('names what it was NOT told, rather than letting a refusal read as a supplier’s fault', async () => {
    // Every gap here already fails toward a refusal. That is the safe direction and still not
    // honest on its own: "this was never ordered" looks identical whether the supplier invented
    // the line or the box was simply never sent the order, and only one is an argument to have.
    const base = await serve(snapshotOf({
      pack: pack({ purchaseOrders: notKnown('never sent'), receipts: notKnown('never sent') }),
    }));
    const payload = (await payloadFromScreen(base, 'buying'))!;
    expect('ordered' in payload, '"ordered" must be absent, not empty').toBe(false);
    expect(buyingGaps(payload as never)).toEqual(['what_was_ordered', 'what_arrived']);
  });

  it('reports an unserved approver list as a gap, because it stops the same work', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        buyingPolicy: known({
          buyerId: 'u-buyer', approvers: ['u-buyer'], // only the buyer — stripped, leaving nobody
          quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100,
        }),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'buying'))!;
    expect(payload['approvers']).toEqual([]);
    expect(buyingGaps(payload as never)).toContain('who_may_approve');
  });
});

/**
 * **A bare screen path, driven over the real socket.**
 *
 * `/pos` and `/pos/` look like the same address and are not: without the trailing slash a browser
 * resolves `./pos.bundle.js` against `/`, asks this box for `/pos.bundle.js`, and gets nothing —
 * so the page opens with no bundle, no view and no service worker registered. A blank screen, with
 * nothing anywhere saying why, served with a cheerful 200.
 */
describe('the box sends a bare screen path to its own folder first', () => {
  it('redirects `/<screen>` to `/<screen>/` for every screen it serves', async () => {
    const base = await serve(snapshotOf());
    for (const screen of SCREENS) {
      const response = await fetch(`${base}/${screen}`, { redirect: 'manual' });
      expect(response.status, `${screen} was served without a redirect`).toBe(301);
      expect(response.headers.get('location')).toBe(`/${screen}/`);
    }
  });

  it('keeps the query string across the redirect', async () => {
    const base = await serve(snapshotOf());
    const response = await fetch(`${base}/driver?driverId=d1`, { redirect: 'manual' });
    expect(response.headers.get('location')).toBe('/driver/?driverId=d1');
  });

  it('serves the screen itself once the slash is there, payload intact', async () => {
    const base = await serve(snapshotOf());
    const html = await (await fetch(`${base}/pos/`)).text();
    expect(html).toContain('window.posCatalogue');
    expect(html).toContain('./pos.bundle.js');
  });

  it('still refuses a path that is not a screen at all', async () => {
    const base = await serve(snapshotOf());
    expect((await fetch(`${base}/admin`, { redirect: 'manual' })).status).toBe(404);
  });

  it('serves each screen’s service worker, so there is something to register', async () => {
    // It existed for weeks and only the owner's phone ever registered it.
    const base = await serve(snapshotOf());
    for (const screen of SCREENS) {
      const response = await fetch(`${base}/${screen}/sw.js`);
      expect(response.status, `${screen} has no service worker to fetch`).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/javascript/);
      expect(await response.text()).toContain('shellCachedAt');
    }
  });
});

/**
 * **The product-and-pricing screen, driven over the same socket (M03 · M05 · D01 · §28).**
 *
 * Everything needed to police a price was built and tested — the MRP ceiling, the margin floor, the
 * effective-dated resolution, the append-only history, the catalogue snapshot that carries it to a
 * lane — and **nothing anywhere produced a price**. This proves the whole chain now runs: the box
 * serves the master records and the tenant's own rules, the screen makes a price, and the price the
 * lane would resolve is the one the screen decided.
 */
describe('the product-and-pricing screen is fed, and cannot break the law', () => {
  const approvalBy = (decidedBy: string, subjectRef: string) => ({
    id: `ap-${subjectRef}`, subjectType: 'price_change', subjectRef,
    requestedBy: 'u-pricing', branchId: null, value: null,
    status: 'approved' as const, decidedBy, reason: 'clearance', decidedAt: NOW,
  });

  it('serves its OWN page, not the manager’s and not the buyer’s', async () => {
    const base = await serve(snapshotOf());
    const html = await (await fetch(`${base}/catalogue/`)).text();
    expect(html).toContain('id="floor-value"');
    expect(html).not.toContain('id="close-title"');
    expect(html).not.toContain('id="declared-total"');
  });

  it('removes the person setting prices from their own approver list', async () => {
    // The pack lists `u-pricing` among the approvers — a tenant misconfiguration, and exactly the
    // one that separation of duties has to survive. It must never reach the screen.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'catalogue'))!;
    expect(payload['approvers']).toEqual(['u-manager']);
    expect(payload['userId']).toBe('u-pricing');
  });

  it('serves the shop’s trading day rather than leaving the screen to read a clock', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'catalogue'))!;
    expect(payload['today']).toBe(DAY);
  });

  it('makes a price, and the lane would resolve exactly that price', async () => {
    // The whole chain, end to end: nothing has ever produced a `PriceEntry` before this.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'catalogue'))!;
    const catalogue = bootCatalogue(payload as never)!;

    const proposal = catalogue.proposePrice({
      id: 'pc-1', productId: 'p1', priceMinor: 150_00, effectiveFrom: DAY,
    });
    expect(proposal.refusals).toEqual([]);
    const outcome = catalogue.activatePrice(proposal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The same engine the till's catalogue snapshot uses, given the new entry alongside the old.
    const resolved = resolvePrice(
      [...(payload['priceEntries'] as Parameters<typeof resolvePrice>[0]), outcome.entry],
      { productId: 'p1', at: `${DAY}T12:00:00.000Z`, storeId: 'store-1' },
    );
    expect(resolved?.price.minor).toBe(150_00);
    expect(resolved?.id).toBe('pc-1');
  });

  it('refuses a price above the MRP the box served, whoever approves it', async () => {
    const base = await serve(snapshotOf());
    const catalogue = bootCatalogue((await payloadFromScreen(base, 'catalogue'))! as never)!;
    const proposal = catalogue.proposePrice({
      id: 'pc-2', productId: 'p1', priceMinor: 175_00, effectiveFrom: DAY,
    });
    expect(proposal.refusals).toContain('above_the_printed_mrp');
    expect(catalogue.activatePrice(proposal, approvalBy('u-manager', 'pc-2')).ok).toBe(false);
  });

  it('needs an approver for a below-floor price, using the tenant’s own floor', async () => {
    // Cost ₹100 from the pack, floor 20% from the pack ⇒ under ₹125 is below the floor.
    const base = await serve(snapshotOf());
    const catalogue = bootCatalogue((await payloadFromScreen(base, 'catalogue'))! as never)!;
    const proposal = catalogue.proposePrice({
      id: 'pc-3', productId: 'p1', priceMinor: 110_00, effectiveFrom: DAY,
    });
    expect(proposal.refusals).toEqual(['below_the_margin_floor']);
    expect(catalogue.activatePrice(proposal).ok).toBe(false);
    expect(catalogue.activatePrice(proposal, approvalBy('u-manager', 'pc-3')).ok).toBe(true);
  });

  it('will not check a margin against a cost the box never sent', async () => {
    // The pack's product carries no `unitCostMinor` here, so the payload's cost map has no entry —
    // NOT a zero, which would make every price look like a 100% margin.
    const base = await serve(snapshotOf({
      pack: pack({ products: known([{ ...PRODUCTS[0]!, unitCostMinor: undefined }]) }),
    }));
    const payload = (await payloadFromScreen(base, 'catalogue'))!;
    expect(payload['costsMinor']).toEqual({});

    const catalogue = bootCatalogue(payload as never)!;
    const proposal = catalogue.proposePrice({
      id: 'pc-4', productId: 'p1', priceMinor: 1_00, effectiveFrom: DAY,
    });
    expect(proposal.refusals).toEqual(['the_cost_is_not_known_so_the_margin_was_never_checked']);
    expect(catalogue.activatePrice(proposal).ok).toBe(false);
  });

  it('scores what is missing from a record, against the tenant’s own department rules', async () => {
    const base = await serve(snapshotOf());
    const catalogue = bootCatalogue((await payloadFromScreen(base, 'catalogue'))! as never)!;
    const view = catalogue.shelf()[0]!;
    expect(view.score.knowable).toBe(true);
    if (!view.score.knowable) return;
    expect(view.score.percent).toBe(100);
    expect(view.score.publishable).toBe(true);
  });

  it('says a record is NOT KNOWABLE when the box never sent its department', async () => {
    // A zero would read as "somebody has filled in nothing" and send a person to fix a finished
    // record. The reason names the department nobody told this screen about.
    const base = await serve(snapshotOf({ pack: pack({ categories: known([]) }) }));
    const catalogue = bootCatalogue((await payloadFromScreen(base, 'catalogue'))! as never)!;
    const score = catalogue.shelf()[0]!.score;
    expect(score.knowable).toBe(false);
    if (score.knowable) return;
    expect(score.why).toContain('grocery');
  });

  it('serves the screen nothing at all when the box has no pricing policy', async () => {
    const base = await serve(snapshotOf({ pack: pack({ pricingPolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'catalogue')).toBeNull();
    expect(bootCatalogue(undefined)).toBeNull();
  });

  it('names what it was NOT told rather than letting a refusal read as somebody’s fault', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ categories: notKnown('never sent'), priceEntries: notKnown('never sent') }),
    }));
    const payload = (await payloadFromScreen(base, 'catalogue'))!;
    expect('categories' in payload, '"categories" must be absent, not empty').toBe(false);
    expect(catalogueGaps(payload as never)).toEqual(['what_each_department_needs', 'the_prices_already_set']);
  });
});

/**
 * **The picker's walk, sequenced by the shop's own shelf map (M04-FR-02).**
 *
 * `ShelfMap.routeFor` was written, tested and **never called by anything** — so every wave was
 * walked in whatever order the cloud sent it, which on an online grocery order is the order the
 * customer typed: dairy, rice, back to dairy. The roadmap's audit calls picking time the largest
 * controllable cost in this business, and it is decided here.
 */
describe('the box puts the picker’s list in the order they walk the shop', () => {
  it('re-sequences the wave, and collects the chiller last', async () => {
    // The wave arrives milk-then-dal. The chiller is aisle 0 — physically the FIRST thing you walk
    // past — and it must still be collected last, because this store said so.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'picker'))!;
    const lines = payload['lines'] as { productId: string; shelf?: string }[];

    expect(lines.map((l) => l.productId)).toEqual(['p1', 'p-milk']);
    expect(lines[1]?.shelf).toBe('Chiller (chilled)');
    expect(payload['orderedBy']).toContain('in the order this store set');
  });

  it('and the picker’s real session keeps that order and shows the shelf', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'picker'))!;
    const picker = bootPicker(payload as never, new DeviceOutbox(noDeviceStore()), () => NOW)!;
    expect(picker.work().map((l) => l.productId)).toEqual(['p1', 'p-milk']);
    expect(picker.work()[0]?.shelf).toBe('A1');
  });

  it('applies NO zone order when the store has not said which zones to collect last', async () => {
    // Guessing a cold-chain order would be this repository deciding a licensed matter for every
    // tenant, and the wrong guess is silent: the route looks sensible and the milk is warm.
    const base = await serve(snapshotOf({ pack: pack({ shelfPolicy: known({}) }) }));
    const payload = (await payloadFromScreen(base, 'picker'))!;
    const lines = payload['lines'] as { productId: string }[];
    // Aisle 0 first, on physical position alone.
    expect(lines.map((l) => l.productId)).toEqual(['p-milk', 'p1']);
    expect(payload['orderedBy']).toContain('has not said which zones');
  });

  it('puts a line with no shelf address LAST and names it, rather than hiding it', async () => {
    // Hiding it would send the picker back across the shop; dropping it would lose the line.
    const base = await serve(snapshotOf({
      pack: pack({ shelfAssignments: known([SHELF_ASSIGNMENTS[0]!]) }),
    }));
    const payload = (await payloadFromScreen(base, 'picker'))!;
    const lines = payload['lines'] as { productId: string; unmapped: boolean }[];
    expect(lines.map((l) => l.productId)).toEqual(['p1', 'p-milk']);
    expect(lines[1]?.unmapped).toBe(true);
    expect(payload['unmapped']).toEqual(['p-milk']);
  });

  it('says the list is in the order it arrived when the shop has no shelf map', async () => {
    // A shop that has not addressed its shelves is a real state, not a degraded one. What must
    // never happen is a picker believing a list is sequenced when nothing sequenced it.
    const base = await serve(snapshotOf({ pack: pack({ shelfLocations: notKnown('never sent') }) }));
    const payload = (await payloadFromScreen(base, 'picker'))!;
    expect((payload['lines'] as { productId: string }[]).map((l) => l.productId))
      .toEqual(['p-milk', 'p1']);
    expect(payload['orderedBy']).toContain('no shelf map');
  });

  it('drops one contradictory assignment rather than taking the whole map down', async () => {
    // A pack claiming two homes for one product must not blank the route for every OTHER product
    // in the shop. The bad row is dropped and the product reads as unmapped — which it is.
    const base = await serve(snapshotOf({
      pack: pack({
        shelfAssignments: known([
          ...SHELF_ASSIGNMENTS,
          { storeId: 'store-1', productId: 'p1', locationId: 'L-COLD', capacityMinor: 5, primary: true },
        ]),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'picker'))!;
    expect((payload['lines'] as { productId: string }[]).map((l) => l.productId))
      .toEqual(['p1', 'p-milk']);
    expect(payload['unmapped']).toEqual([]);
  });

  it('serves the shelf map to the product screen, so somebody can fix an unmapped item', async () => {
    const base = await serve(snapshotOf());
    const catalogue = bootCatalogue((await payloadFromScreen(base, 'catalogue'))! as never)!;
    expect(catalogue.shelves().map((l) => l.locationId)).toEqual(['L-COLD', 'L-A1']);
    expect(catalogue.shelfOf('p1')?.label).toBe('A1');
  });
});
