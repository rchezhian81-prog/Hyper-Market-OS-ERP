import { describe, it, expect } from 'vitest';
import {
  costTheDay, readSales, activityFrom, exceptionsFor, type LoggedSale,
} from '../../edge/store-edge/src/read-model';
import {
  emptyPack, readPack, known, notKnown, orElse, type PackProduct, type StorePack,
} from '../../edge/store-edge/src/store-pack';
import {
  payloadFor, managerPayload, ownerPayload, posPayload, customerPayload,
  pickerPayload, driverPayload, GLOBAL_FOR, SCREENS, type ScreenInput,
} from '../../edge/store-edge/src/screen-data';
import { embed, injectPayload, routeOf, safeFile, DATA_MARKER, APP_DIR } from '../../edge/store-edge/src/screen-server';
import { SyncOutbox } from '../../packages/sync/src/index';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **The store box feeding the six screens.**
 *
 * Every screen in this product was built to be told the truth, including the truth that the box
 * does not know something — and until now nothing told them anything at all. This is the join.
 *
 * The rule under test throughout is one character wide. `?? []` turns *"the cloud has never told
 * this box about approvals"* into *"no approvals are waiting"*. The manager's day close is built
 * to refuse the first and proceed on the second, so that one character decides whether a trading
 * day locks correctly or locks on nothing.
 */

const NOW = '2026-08-05T14:00:00.000Z';
const DAY = '2026-08-05';

const PRODUCTS: PackProduct[] = [
  {
    productId: 'p1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 145_00,
    unitCostMinor: 100_00, uom: 'ea', barcodes: ['8901'], availableMinor: 10,
  },
  {
    productId: 'p2', name: 'Tomato', categoryId: 'produce', unitPriceMinor: 80_00,
    unitCostMinor: 50_00, uom: 'kg', barcodes: ['8902'], availableMinor: 20_000,
  },
];

const sale = (over: Partial<LoggedSale> = {}): LoggedSale => ({
  id: 'S-1', number: 'R-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: DAY,
  committedAt: NOW, total: 145_00, netMinor: 122_88, taxMinor: 22_12, currency: 'INR',
  lines: [{ productId: 'p1', quantityMinor: 1, uom: 'ea' }],
  tenders: [{ kind: 'cash', amount: { minor: 145_00 } }],
  ...over,
});

const fullPack = (over: Partial<StorePack> = {}): StorePack => ({
  receivedAt: NOW,
  version: 7,
  policies: known({
    storeId: 'store-1', branchId: 'b1', branchName: 'SRE Hyper Market',
    tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_00,
    handoverToleranceMinor: 100_00, privacySlaDays: 30, warehouseId: 'wh-1',
  }),
  products: known(PRODUCTS),
  approvals: known([]),
  checklist: known([]),
  wave: known(null),
  route: known(null),
  deliveries: known([]),
  drivers: known([]),
  routingPolicy: known({
    storeLocation: { lat: 11, lon: 77 }, radiusMetres: 10_000,
    averageSpeedKmh: 20, serviceMinutesPerStop: 5,
  }),
  slots: known([]),
  lossPreventionRules: known([{ kind: 'refund', maxCount: 2 }]),
  consentPurposes: known([]),
  ...over,
});

const input = (over: Partial<ScreenInput> = {}): ScreenInput => ({
  pack: fullPack(), sales: [sale()], unreadableRecords: 0,
  outbox: new SyncOutbox(), now: NOW, tradingDay: DAY, ...over,
});

describe('a pack that never arrived is not an empty pack', () => {
  it('starts every section as NOT KNOWN, with the reason', () => {
    const pack = emptyPack();
    for (const section of [pack.policies, pack.products, pack.approvals, pack.checklist, pack.slots, pack.lossPreventionRules]) {
      expect(section.known).toBe(false);
      if (!section.known) expect(section.why).toMatch(/never received a pack/);
    }
    expect(pack.receivedAt).toBeNull();
  });

  it('keeps a section the cloud did not send as NOT KNOWN, rather than empty', () => {
    // The subtler half: a pack arrived, and it carried no approvals section at all.
    const pack = readPack({ version: 3, products: [] }, NOW);
    expect(pack.products).toEqual({ known: true, value: [] });
    expect(pack.approvals.known).toBe(false);
    if (!pack.approvals.known) expect(pack.approvals.why).toMatch(/carried no approvals/);
  });

  it('treats a pack it cannot read as knowing nothing, not as knowing zero', () => {
    for (const bad of [null, 'a string', 42]) {
      expect(readPack(bad, NOW).products.known).toBe(false);
    }
  });

  it('distinguishes a known-empty list from an unknown one at the reading end too', () => {
    expect(orElse(known<readonly string[]>([]), ['fallback'])).toEqual([]);
    expect(orElse(notKnown<readonly string[]>('down'), ['fallback'])).toEqual(['fallback']);
  });
});

describe('the two gates on a day close are produced HERE, not fetched', () => {
  it('serves the box’s own outbox as the unsent register', () => {
    // Nothing else in the system knows what has not reached the cloud — by definition, the cloud
    // does not. This is the only honest source there is.
    const outbox = new SyncOutbox();
    outbox.enqueue(makeEvent({
      id: 'e1', type: 'SaleCommitted', occurredAt: NOW, idempotencyKey: 'k1', source: 'lane-1', payload: {},
    }));
    const payload = managerPayload(input({ outbox }));
    expect(payload['unsentItems']).toEqual([{ id: 'k1', what: 'SaleCommitted' }]);
  });

  it('drops an item from the unsent register once it is acknowledged', () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(makeEvent({
      id: 'e1', type: 'SaleCommitted', occurredAt: NOW, idempotencyKey: 'k1', source: 'lane-1', payload: {},
    }));
    outbox.acknowledge('k1');
    expect(managerPayload(input({ outbox }))['unsentItems']).toEqual([]);
  });

  it('evaluates the day’s exceptions locally, against the store’s own thresholds', () => {
    // Waiting for the cloud to notice a refund spike would blank the register exactly when the
    // line is down, which is when a shop is least supervised.
    const refunds = [
      sale({ id: 'S-1', total: -100_00 }),
      sale({ id: 'S-2', total: -200_00 }),
      sale({ id: 'S-3', total: -300_00 }),
    ];
    const payload = managerPayload(input({ sales: refunds }));
    const exceptions = payload['openExceptions'] as { id: string; what: string }[];
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.what).toMatch(/refund by u-meena: 3 against a limit of 2/);
  });

  it('OMITS the exception register entirely when the pack carried no rules', () => {
    // Zero exceptions with no rules is not a clean shop; it is a shop nobody is watching. The
    // section is absent, so the manager's screen says "not known" and refuses to close the day.
    const payload = managerPayload(input({ pack: fullPack({ lossPreventionRules: notKnown('no rules sent') }) }));
    expect('openExceptions' in payload).toBe(false);
  });

  it('raises an unreadable record on this disk as an exception in its own right', () => {
    // It is evidence that something went wrong here. Excluding it from the figures AND from the
    // list of things wrong with the day would make a power cut invisible (hard rule #6).
    const payload = managerPayload(input({ unreadableRecords: 2 }));
    const exceptions = payload['openExceptions'] as { id: string; what: string }[];
    expect(exceptions.some((e) => e.id === 'edge:unreadable-records')).toBe(true);
    expect(exceptions.find((e) => e.id === 'edge:unreadable-records')?.what).toMatch(/power cut/);
  });

  it('omits approvals, tasks and product costs when the pack has not carried them', () => {
    const bare = managerPayload(input({
      pack: fullPack({
        approvals: notKnown('x'), checklist: notKnown('x'), products: notKnown('x'),
      }),
    }));
    for (const section of ['approvals', 'tasks', 'products']) {
      expect(section in bare, `"${section}" must be ABSENT, not empty`).toBe(false);
    }
    // But the two gates it CAN answer are still answered.
    expect('unsentItems' in bare).toBe(true);
    expect('openExceptions' in bare).toBe(true);
  });

  it('serves a known-empty checklist as an empty task list, not as unknown', () => {
    expect(managerPayload(input())['tasks']).toEqual([]);
  });

  it('marks a blocking checklist item as one the shop cannot close without', () => {
    const payload = managerPayload(input({
      pack: fullPack({
        checklist: known([
          { itemId: 'c1', description: 'Chiller temperature logged', done: false, blocking: true },
          { itemId: 'c2', description: 'Aisle 4 faced up', done: false, blocking: false },
          { itemId: 'c3', description: 'Safe locked', done: true, blocking: true },
        ]),
      }),
    }));
    const tasks = payload['tasks'] as { id: string; what: string }[];
    expect(tasks.map((t) => t.id)).toEqual(['c1', 'c2']); // the done one is gone
    expect(tasks[0]?.what).toMatch(/cannot close without/);
    expect(tasks[1]?.what).not.toMatch(/cannot close without/);
  });
});

describe('margin is only served where it can genuinely be worked out', () => {
  it('costs a sale from the pack’s cost prices', () => {
    const day = costTheDay([sale()], PRODUCTS);
    expect(day.facts).toHaveLength(1);
    expect(day.facts[0]?.cogsMinor).toBe(100_00);
    expect(day.uncostableSales).toBe(0);
  });

  it('costs a weighed line by weight, in exact integers', () => {
    // 1.5 kg of tomatoes at ₹50/kg cost ₹75.00 — and the arithmetic never touches a float.
    const day = costTheDay([sale({
      id: 'S-2', lines: [{ productId: 'p2', quantityMinor: 1500, uom: 'kg' }],
    })], PRODUCTS);
    expect(day.facts[0]?.cogsMinor).toBe(75_00);
  });

  it('EXCLUDES a sale it cannot cost, and counts it, rather than costing it at zero', () => {
    // Zero cost reports a 100% margin. That is a lie that reads as very good news, so it would be
    // believed — which is exactly why it must not be possible to produce it.
    const day = costTheDay([
      sale({ id: 'S-1' }),
      sale({ id: 'S-2', total: 300_00, lines: [{ productId: 'p-unknown', quantityMinor: 1, uom: 'ea' }] }),
    ], PRODUCTS);

    expect(day.facts.map((f) => f.saleId)).toEqual(['S-1']);
    expect(day.uncostableSales).toBe(1);
    expect(day.productsWithoutCost).toEqual(['p-unknown']);
    // The money is still a fact — the shop took it either way.
    expect(day.takenMinor).toBe(145_00 + 300_00);
    expect(day.billCount).toBe(2);
  });

  it('treats a product present in the pack but with no cost price as uncostable', () => {
    const noCost: PackProduct[] = [{ ...PRODUCTS[0]!, unitCostMinor: undefined }];
    const day = costTheDay([sale()], noCost);
    expect(day.uncostableSales).toBe(1);
    expect(day.productsWithoutCost).toEqual(['p1']);
  });

  it('reports the gap on the owner’s payload, naming the products', () => {
    // The person who can fix a missing cost price is exactly the person reading this screen.
    const payload = ownerPayload(input({
      sales: [sale(), sale({ id: 'S-2', lines: [{ productId: 'p-unknown', quantityMinor: 1, uom: 'ea' }] })],
    }))!;
    expect(payload['uncostable']).toMatchObject({ sales: 1, billCount: 2, products: ['p-unknown'] });
  });
});

describe('the day is read from the disk honestly', () => {
  it('drops a record it cannot parse, and counts it', () => {
    // A half-written record from a power cut is not a sale with fields missing; it is a thing
    // nobody can vouch for. Turning it into a zero-value sale would put a fiction in the figures.
    const result = readSales([JSON.stringify(sale()), 'not json', '{"no":"id"}']);
    expect(result.sales).toHaveLength(1);
    expect(result.unreadable).toBe(2);
  });

  it('reads a refund from the sign of the total rather than a flag nobody sets', () => {
    expect(activityFrom([sale({ total: -100_00 })])).toEqual([
      { txnId: 'S-1', kind: 'refund', cashierId: 'u-meena', valueMinor: 100_00, at: NOW },
    ]);
    expect(activityFrom([sale()])).toEqual([]);
  });

  it('says whether the rules were known, so an empty list is never mistaken for clean', () => {
    expect(exceptionsFor([], undefined)).toEqual({ exceptions: [], rulesKnown: false });
    expect(exceptionsFor([], [])).toEqual({ exceptions: [], rulesKnown: true });
  });
});

describe('each screen gets what it needs, and nothing when the box has nothing', () => {
  it('gives the till a catalogue, and null when there is none', () => {
    expect(posPayload(input())).toMatchObject({ version: 7 });
    expect(posPayload(input({ pack: fullPack({ products: notKnown('x') }) }))).toBeNull();
  });

  it('gives the customer app the PACK VERSION, so a stale price cannot be paid against', () => {
    // Without the version the app cannot tell that prices moved while somebody was deciding, and
    // the check that refuses to charge a figure they never saw stops working entirely (P-02).
    expect(customerPayload(input())).toMatchObject({ packVersion: 7 });
  });

  it('gives the picker nothing when no wave was assigned, rather than an empty wave', () => {
    expect(pickerPayload(input())).toBeNull();
    const assigned = pickerPayload(input({
      pack: fullPack({
        wave: known({
          waveId: 'w1', pickerId: 'u-picker',
          lines: [{ lineId: 'l1', orderRef: 'ORD-1', productId: 'p1', description: 'Toor dal', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPriceMinor: 145_00 }],
        }),
      }),
    }))!;
    expect(assigned['waveId']).toBe('w1');
    expect((assigned['lines'] as { unitPrice: unknown }[])[0]?.unitPrice).toEqual({ minor: 145_00, currency: 'INR' });
  });

  it('gives the driver nothing when no route was dispatched (M20)', () => {
    expect(driverPayload(input())).toBeNull();
    const dispatched = driverPayload(input({
      pack: fullPack({
        route: known({
          routeId: 'r1', driverId: 'd1',
          stops: [{ stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 250_00 }],
        }),
      }),
    }))!;
    expect(dispatched['routeId']).toBe('r1');
    // The tenant's own handover tolerance travels with it rather than being a constant anywhere.
    expect(dispatched['handoverToleranceMinor']).toBe(100_00);
  });

  it('gives the owner nothing when the box does not even know which shop it is', () => {
    expect(ownerPayload(input({ pack: fullPack({ policies: notKnown('x') }) }))).toBeNull();
  });

  it('has a builder and a global for every screen, with no drift', () => {
    for (const screen of SCREENS) {
      expect(typeof GLOBAL_FOR[screen], `${screen} has no global`).toBe('string');
      expect(APP_DIR[screen], `${screen} has no app folder`).toBeTruthy();
      // Every one must be callable — a screen with no builder would 500 on its own URL.
      expect(() => payloadFor(screen, input())).not.toThrow();
    }
    expect(Object.keys(GLOBAL_FOR).sort()).toEqual([...SCREENS].sort());
  });
});

describe('the payload reaches the screen safely', () => {
  it('injects at the marker, above the bundle that reads it', () => {
    const html = `<head></head><body>${DATA_MARKER}<script type="module" src="./x.bundle.js"></script></body>`;
    const out = injectPayload(html, 'managerData', { a: 1 });
    expect(out).toContain('<script>window.managerData = {"a":1};</script>');
    expect(out.indexOf('window.managerData')).toBeLessThan(out.indexOf('x.bundle.js'));
  });

  it('leaves the shell untouched when there is nothing to say', () => {
    // The screen then falls back to its sample data, which it announces. Injecting `null` would
    // be worse: the shell reads a defined-but-empty global as real, and stops warning.
    const html = `x${DATA_MARKER}y`;
    expect(injectPayload(html, 'managerData', null)).toBe(html);
  });

  it('cannot be escaped out of by a product name (script injection)', () => {
    // A product name is text somebody typed into a spreadsheet, and it reaches this payload
    // verbatim. `</script>` inside it would end the element and everything after becomes markup.
    const nasty = embed({ name: '</script><script>alert(1)</script>' });
    expect(nasty).not.toContain('</script>');
    expect(nasty).toContain('\\u003c');
    expect(JSON.parse(nasty) as { name: string }).toEqual({ name: '</script><script>alert(1)</script>' });
  });
});

describe('the screens socket refuses what it should', () => {
  it('routes a screen path, and refuses anything that is not a screen', () => {
    expect(routeOf('/manager')).toEqual({ screen: 'manager', file: 'index.html' });
    expect(routeOf('/manager/app.js')).toEqual({ screen: 'manager', file: 'app.js' });
    expect(routeOf('/owner/?x=1')).toEqual({ screen: 'owner', file: 'index.html' });
    expect(routeOf('/admin')).toBeNull();
    expect(routeOf('/')).toBeNull();
  });

  it('refuses a path that climbs out of the screen’s folder', () => {
    // The oldest request in the book, and this server reads files from disk by name.
    for (const attack of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', '/etc/passwd', 'a/../../b']) {
      expect(safeFile(attack), attack).toBeNull();
    }
  });

  it('allows an ordinary file inside the folder', () => {
    expect(safeFile('app.js')).toBe('app.js');
    expect(safeFile('manifest.webmanifest')).toBe('manifest.webmanifest');
  });

  it('decodes BEFORE it checks, because %2e%2e is not .. until it is decoded', () => {
    expect(safeFile('%2e%2e/secrets')).toBeNull();
  });
});
