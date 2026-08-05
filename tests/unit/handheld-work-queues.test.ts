import { describe, it, expect } from 'vitest';
import { PickSession, type PickLineInput } from '../../apps/picker-app/src/index';
import { RouteSession, type StopInput } from '../../apps/delivery-app/src/index';
import { bootPicker } from '../../apps/picker-app/src/browser-entry';
import { bootDriver } from '../../apps/delivery-app/src/browser-entry';
import {
  DeviceOutbox,
  SyncOutbox,
  guardedStore,
  openDeviceOutbox,
  restoreItems,
  noDeviceStore,
} from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';

/**
 * **The work a handheld does has to leave the handheld.**
 *
 * Both session docstrings said the scans, the proof and the COD "queue for sync afterwards". They
 * did not. Every resolved line and every completed stop lived in a JavaScript object on a device
 * and nowhere else, so a wave picked perfectly offline — exactly as designed — existed only until
 * the app was closed.
 *
 * On the picker's handheld that loses an afternoon. On the driver's phone it loses **money that
 * has already changed hands**: ₹6,000 collected across four stops, a dead battery, and no record
 * anywhere that any of it was ever collected. The settlement has nothing to reconcile against.
 *
 * Nothing in the existing suite failed when the queueing was added, which is the whole reason this
 * file exists: the two halves were each correct and simply not joined.
 */

const AT = '2026-08-05T10:00:00.000Z';
const now = () => AT;

const WORK: PickLineInput[] = [
  { lineId: 'l1', orderRef: 'ORD-1', productId: 'p1', description: 'Rice 1kg', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPrice: money(100_00, 'INR') },
  { lineId: 'l2', orderRef: 'ORD-1', productId: 'p2', description: 'Tomato', bin: 'B-04', requiredQty: 1500, uom: 'kg', unitPrice: money(80_00, 'INR') },
];

const STOPS: StopInput[] = [
  { stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 250_00 },
  { stopId: 's2', orderRef: 'ORD-2', area: 'Gandhipuram', codMinor: 0 },
];

const OTP = { kind: 'otp' as const, ref: '4821' };

/** A stand-in for the device's own storage, with the same failure modes. */
const fakeStorage = (initial: Record<string, string> = {}) => {
  const held: Record<string, string> = { ...initial };
  return {
    held,
    getItem: (k: string) => held[k] ?? null,
    setItem: (k: string, v: string) => { held[k] = v; },
  };
};

describe('a picker’s scans reach the queue', () => {
  const newWave = (outbox: SyncOutbox) => new PickSession('wave-1', WORK, outbox, { now });

  it('queues every resolved line, whatever resolved it', () => {
    const outbox = new SyncOutbox();
    const wave = newWave(outbox);
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);
    wave.markUnavailable('l2', 'out_of_stock');

    const types = outbox.pending().map((i) => i.event.type);
    expect(types).toEqual(['PickLineResolved', 'PickLineResolved']);
  });

  it('queues the pack, with the cold-chain evidence attached', () => {
    // A crate that arrives warm is an argument nobody can settle afterwards without the
    // temperature that was recorded when it was sealed (M19-FR-02).
    const outbox = new SyncOutbox();
    const wave = newWave(outbox);
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);
    wave.markUnavailable('l2', 'out_of_stock');
    wave.pack({ packedBy: 'picker-1', at: AT, temperatureC: 4, tamperSealRef: 'SEAL-9' });

    const packed = outbox.pending().find((i) => i.event.type === 'WavePacked');
    expect(packed).toBeDefined();
    expect(packed!.event.payload).toMatchObject({ temperatureC: 4, tamperSealRef: 'SEAL-9', lineCount: 1 });
  });

  it('carries the order reference and NOT the customer (§31 PII minimisation)', () => {
    // A handheld gets left on a shelf and walks out in somebody's pocket. What is on it should be
    // worth nothing to whoever finds it.
    const outbox = new SyncOutbox();
    const wave = newWave(outbox);
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);

    const payload = JSON.stringify(outbox.pending()[0]?.event.payload);
    expect(payload).toContain('ORD-1');
    expect(payload).not.toMatch(/name|phone|email|address|customer(?!Approval)/i);
  });

  it('collapses a repeated identical outcome, and keeps a genuine change of outcome', () => {
    // "Picked 2" then "quality failed" is two things that happened to somebody's order, and the
    // cloud needs both. The same outcome recorded twice is one thing that happened.
    const outbox = new SyncOutbox();
    const wave = newWave(outbox);
    wave.scanBin('B-04');
    wave.markUnavailable('l2', 'out_of_stock');
    wave.markUnavailable('l2', 'out_of_stock'); // same outcome again
    expect(outbox.pending()).toHaveLength(1);

    wave.failQuality('l2', 'poor_quality');
    expect(outbox.pending()).toHaveLength(2);
  });

  it('queues a substitution together with the customer’s approval reference', () => {
    const outbox = new SyncOutbox();
    const wave = newWave(outbox);
    wave.markUnavailable('l1', 'out_of_stock');
    wave.substitute('l1', 'p1-alt', 'wa-msg-88421', 2, money(110_00, 'INR'));

    const swap = outbox.pending().find((i) => (i.event.payload as { substituted?: boolean }).substituted === true);
    expect(swap).toBeDefined();
    expect(JSON.stringify(swap!.event.payload)).toContain('wa-msg-88421');
  });
});

describe('a driver’s stops and cash reach the queue', () => {
  const newRoute = (outbox: SyncOutbox) =>
    new RouteSession('route-1', 'driver-1', STOPS, outbox, { currency: 'INR', now });

  it('queues every stop that moves', () => {
    const outbox = new SyncOutbox();
    const route = newRoute(outbox);
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 250_00, codMethod: 'cash' });

    const types = outbox.pending().map((i) => i.event.type);
    expect(types).toEqual(['DeliveryStopUpdated', 'DeliveryStopUpdated']);
  });

  it('records the money on the stop that collected it', () => {
    const outbox = new SyncOutbox();
    const route = newRoute(outbox);
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 250_00, codMethod: 'cash' });

    const delivered = outbox.pending().at(-1)!;
    expect(delivered.event.payload).toMatchObject({
      state: 'delivered', codExpectedMinor: 250_00, codCollectedMinor: 250_00, codMethod: 'cash',
    });
  });

  it('queues the proof KIND and never the photograph itself', () => {
    // A route's worth of doorstep photographs on a sync queue is a privacy problem being uploaded,
    // not a delivery being proved.
    const outbox = new SyncOutbox();
    const route = newRoute(outbox);
    route.depart('s1');
    route.deliver('s1', { kind: 'photo', ref: 'blob:a-very-large-image' }, { codCollectedMinor: 250_00, codMethod: 'cash' });

    const payload = JSON.stringify(outbox.pending().at(-1)!.event.payload);
    expect(payload).toContain('"proofKind":"photo"');
    expect(payload).not.toContain('blob:');
  });

  it('queues a failure with its reason, and the route it was sent down', () => {
    const outbox = new SyncOutbox();
    const route = newRoute(outbox);
    route.depart('s1');
    route.fail('s1', 'nobody_home');
    route.returnToOrigin('s1');

    const states = outbox.pending().map((i) => (i.event.payload as { state: string }).state);
    expect(states).toEqual(['out_for_delivery', 'failed', 'returned_to_origin']);
    expect(outbox.pending()[1]?.event.payload).toMatchObject({ failureReason: 'nobody_home' });
  });

  it('queues the settlement whatever it says, not only when it balances', () => {
    // A reconciliation that only reaches the cloud when it balances is one that can only ever
    // report success. The short and the over are the two outcomes anybody needs to see.
    const outbox = new SyncOutbox();
    const route = newRoute(outbox);
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 200_00, codMethod: 'cash' }); // ₹50 short
    route.settle();

    const settled = outbox.pending().find((i) => i.event.type === 'RouteSettled')!;
    expect(settled.event.payload).toMatchObject({ expectedMinor: 250_00, collectedMinor: 200_00, exceptionCount: 1 });
  });

  it('carries the order reference and NOT the customer (§31)', () => {
    const outbox = new SyncOutbox();
    const route = newRoute(outbox);
    route.depart('s1');
    const payload = JSON.stringify(outbox.pending()[0]?.event.payload);
    expect(payload).toContain('ORD-1');
    expect(payload).not.toMatch(/name|phone|email|"address"/i);
  });
});

describe('the cash handover is counted blind', () => {
  const newRoute = (outbox: SyncOutbox = new SyncOutbox()) =>
    new RouteSession('route-1', 'driver-1', STOPS, outbox, { currency: 'INR', now });

  it('offers no way to ask what the driver should be holding before they count', () => {
    // Structural, like the till drawer and the stock count. `codHeld` is the recorded total the
    // cash office reconciles against, and the screen does not show it until after `handOver`.
    const route = newRoute();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(route));
    expect(surface.filter((k) => /expected|shouldBe|target/i.test(k))).toEqual([]);
  });

  it('reveals the recorded figure only in the RESULT, after a count was given', () => {
    const route = newRoute();
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 250_00, codMethod: 'cash' });

    const handover = route.handOver({ countedMinor: 250_00, at: AT, toleranceMinor: 10_000 });
    expect(handover.recordedMinor).toBe(250_00);
    expect(handover.varianceMinor).toBe(0);
    expect(handover.material).toBe(false);
  });

  it('calls a material difference material, and a small one not', () => {
    const short = () => {
      const route = newRoute();
      route.depart('s1');
      route.deliver('s1', OTP, { codCollectedMinor: 250_00, codMethod: 'cash' });
      return route;
    };
    expect(short().handOver({ countedMinor: 240_00, at: AT, toleranceMinor: 10_000 }))
      .toMatchObject({ varianceMinor: -10_00, material: false });
    expect(short().handOver({ countedMinor: 100_00, at: AT, toleranceMinor: 10_000 }))
      .toMatchObject({ varianceMinor: -150_00, material: true });
  });

  it('queues the handover whatever it says', () => {
    const outbox = new SyncOutbox();
    const route = newRoute(outbox);
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 250_00, codMethod: 'cash' });
    route.handOver({ countedMinor: 100_00, at: AT, toleranceMinor: 10_000 });

    const event = outbox.pending().find((i) => i.event.type === 'DriverCashHandedOver')!;
    expect(event.event.payload).toMatchObject({ countedMinor: 100_00, recordedMinor: 250_00, material: true });
  });

  it('refuses a negative or fractional count rather than recording nonsense', () => {
    for (const countedMinor of [-1, 12.5, Number.NaN]) {
      expect(() => newRoute().handOver({ countedMinor, at: AT, toleranceMinor: 10_000 })).toThrow();
    }
  });
});

describe('the queue survives the device', () => {
  it('writes through to the device and comes back on the next boot', () => {
    const storage = fakeStorage();
    const outbox = openDeviceOutbox(guardedStore('k', storage, () => {}), () => {});
    const wave = new PickSession('wave-1', WORK, outbox, { now });
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);

    // The handheld is dropped, the battery dies, the app reopens.
    const reopened = openDeviceOutbox(guardedStore('k', storage, () => {}), () => {});
    expect(reopened.pending()).toHaveLength(1);
    expect(reopened.pending()[0]?.event.type).toBe('PickLineResolved');
  });

  it('does NOT resend work that was already acknowledged', () => {
    // A replay that reset every item to pending would resend acknowledged work and resurrect dead
    // letters. State and attempts come back exactly as they were.
    const storage = fakeStorage();
    const outbox = openDeviceOutbox(guardedStore('k', storage, () => {}), () => {});
    const route = new RouteSession('route-1', 'driver-1', STOPS, outbox, { currency: 'INR', now });
    route.depart('s1');
    const key = outbox.pending()[0]!.key;
    outbox.acknowledge(key);

    const reopened = openDeviceOutbox(guardedStore('k', storage, () => {}), () => {});
    expect(reopened.pending()).toHaveLength(0);
    expect(reopened.find(key)?.state).toBe('acknowledged');
  });

  it('keeps a dead letter dead across a restart (hard rule #6)', () => {
    const storage = fakeStorage();
    const outbox = openDeviceOutbox(guardedStore('k', storage, () => {}), () => {});
    const route = new RouteSession('route-1', 'driver-1', STOPS, outbox, { currency: 'INR', now });
    route.depart('s1');
    const key = outbox.pending()[0]!.key;
    outbox.deadLetter(key, 'the cloud rejected it');

    const reopened = openDeviceOutbox(guardedStore('k', storage, () => {}), () => {});
    expect(reopened.deadLetters().map((i) => i.reason)).toEqual(['the cloud rejected it']);
    expect(reopened.pending()).toHaveLength(0);
  });

  it('persists a failed attempt count, so a retry does not start from zero forever', () => {
    const storage = fakeStorage();
    const outbox = openDeviceOutbox(guardedStore('k', storage, () => {}), () => {});
    new RouteSession('route-1', 'driver-1', STOPS, outbox, { currency: 'INR', now }).depart('s1');
    const key = outbox.pending()[0]!.key;
    outbox.recordFailure(key);
    outbox.recordFailure(key);

    const reopened = openDeviceOutbox(guardedStore('k', storage, () => {}), () => {});
    expect(reopened.find(key)?.attempts).toBe(2);
  });

  it('says so when the device offers no storage at all', () => {
    const problems: string[] = [];
    const outbox = openDeviceOutbox(guardedStore('k', undefined, (why) => problems.push(why)), () => {});
    expect(problems[0]).toMatch(/will not survive a restart/);
    // The work is still recorded in memory — a picker who cannot work is worse off than one whose
    // queue is fragile, as long as they are told which they have.
    new PickSession('wave-1', WORK, outbox, { now }).markUnavailable('l1', 'out_of_stock');
    expect(outbox.pending()).toHaveLength(1);
  });

  it('says so when the device refuses the write, rather than swallowing it', () => {
    const problems: string[] = [];
    const store = guardedStore('k', {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    }, (why) => problems.push(why));
    const outbox = new DeviceOutbox(store);
    new PickSession('wave-1', WORK, outbox, { now }).markUnavailable('l1', 'out_of_stock');
    expect(problems[0]).toMatch(/could not be saved/);
  });

  it('treats an unreadable saved queue as unreadable, and LEAVES it alone', () => {
    // A device that cannot start is worse than one with an empty queue. But deleting the bad value
    // is the only action that cannot be undone, and unreadable work is still evidence of work.
    const storage = fakeStorage({ k: 'not json' });
    const problems: string[] = [];
    const outbox = openDeviceOutbox(guardedStore('k', storage, () => {}), (why) => problems.push(why));
    expect(outbox.pending()).toHaveLength(0);
    expect(problems[0]).toMatch(/left untouched/);
    expect(storage.held['k']).toBe('not json');
  });

  it('treats a saved value that is not a list as unreadable rather than trusting it', () => {
    const problems: string[] = [];
    expect(restoreItems({ read: () => '{"sneaky":1}', write: () => {} }, (why) => problems.push(why)))
      .toEqual([]);
    expect(problems[0]).toMatch(/could not be read/);
  });
});

describe('the composition roots the two devices actually boot', () => {
  it('builds no picker session without an assigned wave, and says nothing is wrong', () => {
    const outbox = new DeviceOutbox(noDeviceStore());
    expect(bootPicker(undefined, outbox, now)).toBeNull();
    expect(bootPicker({ waveId: 'w1' }, outbox, now)).toBeNull();
    expect(bootPicker({ waveId: 'w1', lines: [] }, outbox, now)).toBeNull();
  });

  it('builds a picker session that queues through to the device', () => {
    const storage = fakeStorage();
    const outbox = openDeviceOutbox(guardedStore('k', storage, () => {}), () => {});
    const wave = bootPicker({ waveId: 'w1', pickerId: 'u-picker', lines: WORK }, outbox, now)!;
    wave.scanBin('A-01');
    wave.pick('l1', 'p1', 2);
    expect(JSON.parse(storage.held['k'] ?? '[]')).toHaveLength(1);
  });

  it('builds no driver session without an assigned route', () => {
    const outbox = new DeviceOutbox(noDeviceStore());
    expect(bootDriver(undefined, outbox, now)).toBeNull();
    expect(bootDriver({ routeId: 'r1' }, outbox, now)).toBeNull();
    expect(bootDriver({ routeId: 'r1', driverId: 'd1', stops: [] }, outbox, now)).toBeNull();
  });

  it('builds a driver session that queues cash through to the device', () => {
    const storage = fakeStorage();
    const outbox = openDeviceOutbox(guardedStore('k', storage, () => {}), () => {});
    const route = bootDriver({ routeId: 'r1', driverId: 'd1', stops: STOPS }, outbox, now)!;
    route.depart('s1');
    route.deliver('s1', OTP, { codCollectedMinor: 250_00, codMethod: 'cash' });

    const saved = JSON.parse(storage.held['k'] ?? '[]') as { event: { payload: { codCollectedMinor?: number } } }[];
    expect(saved.some((i) => i.event.payload.codCollectedMinor === 250_00)).toBe(true);
  });

  it('passes the tenant’s contribution rule through, rather than hard-coding one', () => {
    const outbox = new DeviceOutbox(noDeviceStore());
    const route = bootDriver({
      routeId: 'r1', driverId: 'd1',
      stops: [{ stopId: 's1', orderRef: 'ORD-1', area: 'Far away', codMinor: 0, costMinor: 90_00, orderValueMinor: 100_00 }],
      contributionRule: { maxCostShareBps: 2_000 }, // 20%
    }, outbox, now)!;
    route.depart('s1');
    route.deliver('s1', OTP, {});
    expect(route.contributionFlags()).toHaveLength(1);
  });
});
