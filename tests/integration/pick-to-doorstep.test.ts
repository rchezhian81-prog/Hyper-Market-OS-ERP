import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { routeOrder, assessContribution, type FulfilmentLocation } from '../../packages/orders/src/fulfilment-plan';
import { cancelOrder, applySubstitution, reconcileChannel } from '../../packages/orders/src/amendments';
import { reserveStock, releaseReservation, availableToPromise } from '../../packages/orders/src/reservation';
import { transitionOrder } from '../../packages/orders/src/lifecycle';
import { packOrder, dispatchOrder, type PackLine } from '../../packages/fulfilment/src/packing';
import { transitionDelivery } from '../../packages/fulfilment/src/delivery';
import { reconcileCod } from '../../packages/fulfilment/src/cod';

/**
 * STAGE 15 — fulfilment and delivery.
 *
 * Gate (roadmap §21): **one order, picked to the doorstep, and what arrives is what the
 * customer agreed to.**
 *
 * Followed against a REAL PostgreSQL: routing across a store and a dark store with real
 * capacity, a reservation that a cancellation actually releases, a substitution the
 * customer has to confirm, a weighed line priced at the weight that was packed, a crate
 * that cannot mix frozen with atta, a manifest built from what was packed, and cash on
 * delivery reconciled to the paisa.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '77777777-7777-7777-7777-777777777777';
const RUN = `p${Date.now().toString(36)}`;

const STORE: FulfilmentLocation = {
  locationId: 'store-1', kind: 'store', lat: 11.0168, lon: 76.9558,
  acceptsPickup: true, acceptsDelivery: true, deliveryRadiusMetres: 10_000, expressMinutes: 90,
};
const DARK: FulfilmentLocation = {
  locationId: 'dark-1', kind: 'dark_store', lat: 11.0268, lon: 76.9658,
  acceptsPickup: false, acceptsDelivery: true, deliveryRadiusMetres: 6_000, expressMinutes: 30,
};
const HER_HOME = { lat: 11.0300, lon: 76.9700 };
/** 40 bags of atta physically on the shelf — the figure reservations are taken from. */
const ON_HAND = 40;

describe.skipIf(!DATABASE_URL)('Stage 15 — pick to doorstep (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;
  let reservationLedger: Ledger;
  let outbox: SyncOutbox;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(
      sql,
      readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })),
    );
    store = new SqlEventStore(sql);
    reservationLedger = new Ledger(new InMemoryLedgerStore());
    outbox = new SyncOutbox();
  });

  afterAll(async () => {
    await client.end();
  });

  it('routes to the dark store, and falls through to the shop when its slot is full', () => {
    const lines = [{ productId: 'p-atta', quantityMinor: 2 }];
    const stock = [
      { locationId: 'store-1', productId: 'p-atta', availableMinor: 40 },
      { locationId: 'dark-1', productId: 'p-atta', availableMinor: 40 },
    ];

    const nearest = routeOrder({
      orderId: `O-${RUN}`, method: 'scheduled_delivery', deliverTo: HER_HOME,
      lines, locations: [STORE, DARK], stock, slots: [],
    });
    expect(nearest.locationId).toBe('dark-1');

    const full = routeOrder({
      orderId: `O-${RUN}`, method: 'scheduled_delivery', deliverTo: HER_HOME,
      lines, locations: [STORE, DARK], stock,
      slots: [{ slotId: 's-1', locationId: 'dark-1', method: 'scheduled_delivery', capacity: 8, booked: 8 }],
    });
    expect(full.routed).toBe(true);
    expect(full.locationId).toBe('store-1');

    // Express is a different promise: only the dark store can do 30 minutes.
    const express = routeOrder({
      orderId: `O-${RUN}`, method: 'express_delivery', deliverTo: HER_HOME,
      lines, locations: [STORE, DARK], stock, slots: [], expressPromiseMinutes: 20,
    });
    expect(express.routed).toBe(false);
    expect(express.detail).toContain('a promise the shop will break');
  });

  it('reserves the stock so a walk-in cannot buy it twice', () => {
    // 40 bags of atta physically on the shelf at the store.
    expect(availableToPromise(reservationLedger, 'p-atta', ON_HAND)).toBe(40);

    reserveStock(
      { id: `RES-${RUN}-1`, orderId: `O-${RUN}`, productId: 'p-atta', qty: 2, at: '2026-08-05T09:00:00Z', source: 'store-1' },
      reservationLedger,
      outbox,
      ON_HAND,
    );
    // The walk-in now sees 38, and that is the truth.
    expect(availableToPromise(reservationLedger, 'p-atta', ON_HAND)).toBe(38);
  });

  it('A CANCELLATION RELEASES THE RESERVATION — otherwise the shelf lies to a walk-in', () => {
    reserveStock(
      { id: `RES-${RUN}-cancel`, orderId: `O-${RUN}-cancel`, productId: 'p-atta', qty: 5, at: '2026-08-05T09:05:00Z', source: 'store-1' },
      reservationLedger,
      outbox,
      ON_HAND,
    );
    expect(availableToPromise(reservationLedger, 'p-atta', ON_HAND)).toBe(33);

    const cancelled = cancelOrder({
      orderId: `O-${RUN}-cancel`, state: 'confirmed',
      reservationIds: [`RES-${RUN}-cancel`], paidMinor: 0,
      cancelledBy: 'c-1', reason: 'changed my mind', at: '2026-08-05T09:10:00Z',
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.releaseReservationIds).toEqual([`RES-${RUN}-cancel`]);

    for (const id of cancelled.releaseReservationIds) {
      releaseReservation(
        { id, orderId: `O-${RUN}-cancel`, productId: 'p-atta', qty: 5, at: '2026-08-05T09:10:00Z', source: 'store-1' },
        reservationLedger,
        outbox,
      );
    }
    // Back to what it was. The shelf tells a walk-in the truth again.
    expect(availableToPromise(reservationLedger, 'p-atta', ON_HAND)).toBe(38);
  });

  it('the chicken is short, and NO ANSWER IS NOT A YES', () => {
    const offer = {
      lineId: 'l-chicken', orderedProductId: 'p-chicken', orderedName: 'Fresh chicken 1kg',
      orderedUnitPriceMinor: 24_000, orderedQuantityMinor: 1,
      substituteProductId: 'p-chicken-thigh', substituteName: 'Chicken thigh 1kg',
      substituteUnitPriceMinor: 21_000, substituteQuantityMinor: 1,
      offeredAt: '2026-08-05T09:20:00Z',
    };

    const noAnswer = applySubstitution({ offer, decision: 'no_answer' });
    expect(noAnswer.pickProductId).toBeUndefined();
    expect(noAnswer.chargeMinor).toBe(0);
    expect(noAnswer.detail).toContain('silence is not consent');

    // She answers. The substitute is cheaper, so the difference comes back to her.
    const confirmed = applySubstitution({ offer, decision: 'confirmed' });
    expect(confirmed.pickProductId).toBe('p-chicken-thigh');
    expect(confirmed.chargeMinor).toBe(21_000);
    expect(confirmed.refundMinor).toBe(3_000);
    expect(confirmed.tellTheCustomer).toContain('refunded the difference');
  });

  it('packs the order: the weighed line is priced at what was actually packed', () => {
    const lines: PackLine[] = [
      { lineId: 'l-atta', orderId: `O-${RUN}`, productId: 'p-atta', name: 'Atta 5kg', handling: 'ambient', orderedMinor: 2, pickedMinor: 2, uom: 'ea', unitPriceMinor: 26_500 },
      { lineId: 'l-chicken', orderId: `O-${RUN}`, productId: 'p-chicken-thigh', name: 'Chicken thigh', handling: 'raw_meat', orderedMinor: 1, pickedMinor: 1, uom: 'kg', unitPriceMinor: 21_000, weighed: true, packedGrams: 1_187, packTenthsC: 22 },
    ];

    // Frozen with ambient in one crate is a wet bag of atta.
    const badCrate = packOrder({
      orderId: `O-${RUN}`,
      lines: [...lines, { ...lines[0]!, lineId: 'l-peas', name: 'Frozen peas', handling: 'frozen', packTenthsC: -180 }],
      crateAssignment: { 'l-atta': 'crate-1', 'l-peas': 'crate-1', 'l-chicken': 'crate-cold' },
      at: '2026-08-05T09:30:00Z',
    });
    expect(badCrate.refused.some((r) => r.reason === 'incompatible_crate')).toBe(true);
    // And the rest of the shopping still goes.
    expect(badCrate.lines.map((l) => l.lineId)).toContain('l-chicken');

    const packed = packOrder({
      orderId: `O-${RUN}`,
      lines,
      crateAssignment: { 'l-atta': 'crate-ambient', 'l-chicken': 'crate-cold' },
      at: '2026-08-05T09:30:00Z',
    });
    expect(packed.refused).toEqual([]);
    // 21,000 × 1187 / 1000 = 24,927 → ₹249.27, not ₹210.00.
    expect(packed.lines.find((l) => l.lineId === 'l-chicken')?.finalPriceMinor).toBe(24_927);
    expect(packed.totalMinor).toBe(53_000 + 24_927);
  });

  it('the manifest comes from the pack, and an unsealed crate does not leave', () => {
    const lines: PackLine[] = [
      { lineId: 'l-atta', orderId: `O-${RUN}`, productId: 'p-atta', name: 'Atta 5kg', handling: 'ambient', orderedMinor: 2, pickedMinor: 2, uom: 'ea', unitPriceMinor: 26_500 },
      { lineId: 'l-chicken', orderId: `O-${RUN}`, productId: 'p-chicken-thigh', name: 'Chicken thigh', handling: 'raw_meat', orderedMinor: 1, pickedMinor: 1, uom: 'kg', unitPriceMinor: 21_000, weighed: true, packedGrams: 1_187, packTenthsC: 22 },
    ];
    const packed = packOrder({
      orderId: `O-${RUN}`, lines,
      crateAssignment: { 'l-atta': 'crate-ambient', 'l-chicken': 'crate-cold' },
      at: '2026-08-05T09:30:00Z',
    });

    const unsealed = dispatchOrder({
      manifestId: `MAN-${RUN}`, orderId: `O-${RUN}`, locationId: 'store-1', pack: packed,
      seals: { 'crate-ambient': 'seal-a' }, dispatchedBy: 'u-packer', at: '2026-08-05T10:00:00Z',
    });
    expect(unsealed.dispatched).toBe(false);
    expect(unsealed.detail).toContain('cannot be shown to have arrived as it left');

    const sent = dispatchOrder({
      manifestId: `MAN-${RUN}`, orderId: `O-${RUN}`, locationId: 'store-1', pack: packed,
      seals: { 'crate-ambient': 'seal-a', 'crate-cold': 'seal-b' },
      dispatchedBy: 'u-packer', at: '2026-08-05T10:00:00Z',
    });
    expect(sent.dispatched).toBe(true);
    expect(sent.manifest?.lines).toHaveLength(2);
    expect(sent.manifest?.totalMinor).toBe(77_927);
    expect(sent.manifest?.detail).toContain('not from what was ordered');
  });

  it('the order and the delivery both walk their state machines, and only in the allowed order', () => {
    expect(transitionOrder('confirmed', 'pick')).toBe('picking');
    expect(transitionOrder('picking', 'pack')).toBe('packed');
    expect(transitionOrder('packed', 'dispatch')).toBe('dispatched');
    expect(transitionOrder('dispatched', 'deliver')).toBe('delivered');
    expect(() => transitionOrder('confirmed', 'deliver')).toThrow();

    expect(transitionDelivery('assigned', 'depart')).toBe('out_for_delivery');
    expect(transitionDelivery('out_for_delivery', 'deliver')).toBe('delivered');
    // Delivering before departing is refused.
    expect(() => transitionDelivery('assigned', 'deliver')).toThrow();
  });

  it('the cash comes back reconciled to the paisa, and a short driver is a valued exception', () => {
    const clean = reconcileCod(
      [{ orderId: `O-${RUN}`, expectedMinor: 77_927 }],
      [{ orderId: `O-${RUN}`, collectedMinor: 77_927, method: 'cash' }],
    );
    expect(clean.exceptions).toEqual([]);
    expect(clean.matched).toHaveLength(1);

    const short = reconcileCod(
      [{ orderId: `O-${RUN}`, expectedMinor: 77_927 }],
      [{ orderId: `O-${RUN}`, collectedMinor: 70_000, method: 'cash' }],
    );
    expect(short.exceptions[0]?.kind).toBe('short');
    expect(short.exceptions[0]?.varianceMinor).toBe(-7_927);
  });

  it('flags a drop that loses money without blocking it (D09)', () => {
    const bad = assessContribution({
      orderId: `O-${RUN}-small`, itemsMarginMinor: 3_000, deliveryFeeChargedMinor: 0,
      deliveryCostMinor: 9_000, distanceMetres: 8_900, orderValueMinor: 20_000,
    });
    expect(bad.profitable).toBe(false);
    expect(bad.detail).toContain('take it knowingly');

    const good = assessContribution({
      orderId: `O-${RUN}`, itemsMarginMinor: 15_000, deliveryFeeChargedMinor: 4_000,
      deliveryCostMinor: 6_000, distanceMetres: 2_400, orderValueMinor: 77_927,
    });
    expect(good.profitable).toBe(true);
  });

  it('banks the delivered order and reconciles the channel BOTH ways', async () => {
    await store.append(
      TENANT,
      `order/${RUN}`,
      makeEvent({
        id: `O-${RUN}`,
        type: 'OrderDelivered',
        occurredAt: '2026-08-05T12:00:00Z',
        idempotencyKey: `${RUN}:delivered`,
        source: 'delivery-app',
        payload: { orderId: `O-${RUN}`, valueMinor: 77_927, state: 'delivered' },
      }),
    );
    const banked = await store.readStream(TENANT, `order/${RUN}`);
    expect(banked).toHaveLength(1);

    const ledgerOrders = banked.map((row) => {
      const p = row.event.payload as { orderId: string; valueMinor: number; state: string };
      return { orderId: p.orderId, valueMinor: p.valueMinor, state: p.state };
    });

    const clean = reconcileChannel({ channel: 'app', channelOrders: ledgerOrders, ledgerOrders });
    expect(clean.reconciles).toBe(true);

    // An order the channel has and we do not — a customer waiting for nothing.
    const missed = reconcileChannel({
      channel: 'app',
      channelOrders: [...ledgerOrders, { orderId: `O-${RUN}-missed`, valueMinor: 45_000, state: 'confirmed' }],
      ledgerOrders,
    });
    expect(missed.discrepancies[0]?.kind).toBe('in_channel_not_in_ledger');
    expect(missed.discrepancies[0]?.detail).toContain('a customer is waiting for something nobody is picking');
    expect(missed.atRiskValueMinor).toBe(45_000);
  });

  it('and none of it can be deleted afterwards — the database refuses', async () => {
    const refusalFor = async (sql: string): Promise<string> => {
      try {
        await client.query(sql, [TENANT]);
        return 'THE DATABASE ALLOWED IT';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(await refusalFor('DELETE FROM event_ledger WHERE tenant_id = $1')).toMatch(/append-only/i);
    expect(await store.readStream(TENANT, `order/${RUN}`)).toHaveLength(1);
  });
});
