import { describe, it, expect } from 'vitest';
import {
  commitLocally, planShed, edgeHealth, SHED_ORDER, createEdgeNode,
  type DurableLog, type Usage,
} from '../../edge/store-edge/src/index';
import { publishPack, hmacSigner, type SignedPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

// P-01 · hard rule #1 · NFR-03 (zero acknowledged transaction loss) · §31.
// The box in the shop that keeps the lanes trading.

const NOW = '2026-08-07T12:00:00Z';

/** A log that records what it was asked to do and can be told to fail. */
class TestLog implements DurableLog {
  readonly written: string[] = [];
  failNext = false;
  used = 0;
  constructor(readonly capacityBytes = 10_000_000) {}
  async append(record: string): Promise<void> {
    if (this.failNext) throw new Error('disk write failed');
    this.written.push(record);
    this.used += record.length;
  }
  async usedBytes(): Promise<number> { return this.used; }
}

describe('the receipt prints after the durable write, never before', () => {
  it('commits a sale to the disk and says so', async () => {
    const log = new TestLog();
    const r = await commitLocally({ saleId: 'S-1', record: '{"saleId":"S-1"}', log });
    expect(r.committed).toBe(true);
    const durable: true = r.durable!;
    expect(durable).toBe(true);
    expect(log.written).toHaveLength(1);
    expect(r.detail).toContain('on the disk before the receipt printed');
  });

  it('REFUSES the sale when the disk write fails, BEFORE payment', async () => {
    // The worst failure this product could have is a sale the cashier saw succeed, the customer
    // paid for and walked away from, which was never written anywhere. Nobody finds out.
    const log = new TestLog();
    log.failNext = true;
    const r = await commitLocally({ saleId: 'S-1', record: '{}', log });
    expect(r.committed).toBe(false);
    expect(r.refusedBecause).toBe('could_not_write_durably');
    expect(r.durable).toBeUndefined();
    expect(r.laneMessage).toContain('Do not take payment');
    expect(r.laneMessage).toContain('do not hand over the goods');
  });

  it('is the one place in the product where refusing a sale is right', async () => {
    // The edge refuses BEFORE the sale completes — nothing has happened and the customer is still
    // standing there. The cloud refuses AFTER — the money is in the drawer and they have gone.
    // Same word, opposite consequences, and services/pos refuses nothing for exactly that reason.
    const posService = await import('../../services/pos/src/index');
    expect(Object.keys(posService)).toContain('acceptSale');
    const log = new TestLog();
    log.failNext = true;
    expect((await commitLocally({ saleId: 'S-1', record: '{}', log })).committed).toBe(false);
  });

  it('refuses before it runs out rather than after, keeping a reserve', async () => {
    const log = new TestLog(1_000);
    const r = await commitLocally({ saleId: 'S-1', record: 'x'.repeat(200), log, reserveBytes: 900 });
    expect(r.refusedBecause).toBe('no_room_left');
    expect(r.laneMessage).toContain('Do not take payment');
    expect(r.laneMessage).toContain('the other lanes may be fine');
  });

  it('writes nothing when it refuses', async () => {
    const log = new TestLog(1_000);
    await commitLocally({ saleId: 'S-1', record: 'x'.repeat(200), log, reserveBytes: 900 });
    expect(log.written).toEqual([]);
  });
});

describe('when the disk fills, the sale is the last thing to go', () => {
  const usage: Usage[] = [
    { kind: 'telemetry', bytes: 1_000 },
    { kind: 'prefetched_catalogue', bytes: 2_000 },
    { kind: 'synced_history', bytes: 5_000 },
    { kind: 'pending_movements', bytes: 3_000 },
    { kind: 'unsynced_sales', bytes: 9_000 },
  ];

  it('ranks unsynced sales last, and nothing may be added after them', () => {
    expect(SHED_ORDER[SHED_ORDER.length - 1]).toBe('unsynced_sales');
  });

  it('sheds the cheapest things first and stops as soon as it has enough', () => {
    const p = planShed(usage, 2_500);
    expect(p.shed.map((s) => s.kind)).toEqual(['telemetry', 'prefetched_catalogue']);
    expect(p.enough).toBe(true);
    expect(p.freedBytes).toBe(3_000);
  });

  it('NEVER sheds an unsynced sale, however short it still is', () => {
    // A design that treats all queued work alike stops accepting sales to preserve a telemetry
    // batch. This one gives up everything else and then says it is not enough.
    const p = planShed(usage, 50_000);
    expect(p.shed.map((s) => s.kind)).not.toContain('unsynced_sales');
    const sheds: false = p.shedsAnySale;
    expect(sheds).toBe(false);
    expect(p.enough).toBe(false);
    expect(p.ownerAction).toContain('will refuse new sales rather than delete them');
    expect(p.ownerAction).toContain('the money is safe on the disk and it is not anywhere else');
  });

  it('says WHY each kind may go, in terms a person can check', () => {
    const p = planShed(usage, 10_000);
    expect(p.shed.find((s) => s.kind === 'synced_history')?.why).toContain('the cloud has already acknowledged');
    expect(p.shed.find((s) => s.kind === 'pending_movements')?.why).toContain('a recount can rebuild it');
  });

  it('gives up pending movements before sales, because a recount can rebuild them', () => {
    const p = planShed(usage, 11_000);
    expect(p.shed.map((s) => s.kind)).toEqual([
      'telemetry', 'prefetched_catalogue', 'synced_history', 'pending_movements',
    ]);
  });
});

describe('what the shop is told', () => {
  const health = (over: Partial<Parameters<typeof edgeHealth>[0]> = {}) => edgeHealth({
    unsyncedSales: 0, deadLettered: 0, now: NOW,
    usedBytes: 1_000_000, capacityBytes: 10_000_000, bytesPerHour: 100_000, ...over,
  });

  it('says the shop keeps trading, whatever the line is doing', () => {
    const keeps: true = health({ unsyncedSales: 4_000 }).shopKeepsTrading;
    expect(keeps).toBe(true);
  });

  it('measures the backlog in HOURS BEHIND, not in items pending', () => {
    // "247 items pending" is a number staff learn to ignore. How long since anything reached the
    // cloud, and how much longer this will hold, are things they can act on.
    const h = health({ unsyncedSales: 247, lastSyncAt: '2026-08-07T06:00:00Z' });
    expect(h.staffMessage).toContain('Nothing has reached the cloud for 6 hour(s)');
    expect(h.staffMessage).toContain('room for about 90 more hour(s) of trading');
    expect(h.hoursOfHeadroom).toBe(90);
  });

  it('leads with "selling normally", because that is the fact that matters', () => {
    for (const h of [health(), health({ unsyncedSales: 500, lastSyncAt: '2026-08-01T00:00:00Z' }), health({ deadLettered: 3 })]) {
      expect(h.staffMessage.startsWith('Selling normally')).toBe(true);
    }
  });

  it('says a rejected item is not lost', () => {
    expect(health({ deadLettered: 3 }).staffMessage)
      .toContain('they are not lost and they are not going anywhere');
  });

  it('says so plainly when everything is through', () => {
    expect(health().staffMessage).toContain('Everything has reached the cloud');
  });
});

describe('the edge node the lane actually talks to', () => {
  const signer = hmacSigner(['edge', 'test', 'key'].join('-').padEnd(40, '0'));
  const snapshot = (version: number): CatalogueSnapshot => ({
    tenantId: 't-sre', version, builtAt: NOW,
    products: [{
      productId: 'P1', sku: 'SKU-1', name: 'Ghee 1L', baseUom: 'each',
      unitPriceMinor: 64_000, taxBps: 500, mrpMinor: 70_000, status: 'active',
    }],
    barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }],
  });
  const packOf = (v: number, previous?: SignedPack): SignedPack => publishPack({
    snapshot: snapshot(v), ...(previous === undefined ? {} : { previous }),
    approvals: [], signer, publishedBy: 'u-manager', publishedAt: NOW,
  }).pack!;

  it('prices from the pack it holds, with no network call', () => {
    const node = createEdgeNode({ tenantId: 't-sre', log: new TestLog(), signer, initialPack: packOf(1) });
    expect(node.pack()?.snapshot.products[0]?.unitPriceMinor).toBe(64_000);
  });

  it('takes a newer pack and keeps the old one when a pack fails its check', () => {
    const first = packOf(1);
    const node = createEdgeNode({ tenantId: 't-sre', log: new TestLog(), signer, initialPack: first });

    expect(node.takePack(packOf(2, first)).accepted).toBe(true);
    expect(node.pack()?.snapshot.version).toBe(2);

    const tampered: SignedPack = { ...packOf(3, first), signature: 'deadbeef' };
    const r = node.takePack(tampered);
    expect(r.accepted).toBe(false);
    expect(node.pack()?.snapshot.version).toBe(2); // still trading on the last one it trusted
    expect(r.staffMessage).toContain('Keep selling');
  });

  it('commits through the same durable path, so the lane cannot bypass it', async () => {
    const log = new TestLog();
    const node = createEdgeNode({ tenantId: 't-sre', log, signer, initialPack: packOf(1) });
    const r = await node.commit('S-1', '{"saleId":"S-1"}');
    expect(r.committed).toBe(true);
    expect(log.written).toHaveLength(1);

    log.failNext = true;
    expect((await node.commit('S-2', '{}')).committed).toBe(false);
  });

  it('offers the lane nothing that reaches the network (hard rule #1)', async () => {
    const edge = await import('../../edge/store-edge/src/index');
    for (const name of Object.keys(edge)) {
      expect(name).not.toMatch(/fetch|http|request|sync|upload|post/i);
    }
  });
});
