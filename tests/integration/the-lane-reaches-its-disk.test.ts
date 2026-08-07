import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge } from '../../edge/store-edge/src/main';
import { LANE_HOST } from '../../edge/store-edge/src/lane-server';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos, laneDurable } from '../../apps/pos/src/browser-entry';

/**
 * **The till's screen reaches the till's disk.**
 *
 * A browser cannot call `fsync`, so `PosSession` takes the durable write as a port — and until this
 * seam existed that port had nothing behind it, so the shell defaulted to a refusal. Honest, and it
 * meant a lane could not take money.
 *
 * ADR-0004 decided whose disk: **the lane's own**. One shared box would put a single point of
 * failure between the customer and the receipt, and it would fail on exactly the bad day
 * offline-first exists for.
 *
 * This drives the whole seam with nothing stubbed: a real edge process, a real loopback socket, a
 * real `PosSession`, and a real file on a real disk.
 */

const KEY = ['lane', 'to', 'disk', 'signing', 'key'].join('-').padEnd(48, '0');

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-lane-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const envFor = (dataDir: string, lanePort: string) => ({
  EDGE_DATA_DIR: dataDir,
  EDGE_TENANT_ID: 't-sre',
  PACK_SIGNING_KEY: KEY,
  EDGE_CAPACITY_BYTES: '10485760',
  EDGE_LANE_PORT: lanePort,
});

/** Start an edge with a lane socket on an ephemeral port, and remember to stop it. */
const startLane = async () => {
  const dir = await tempDir();
  const edge = (await startEdge(envFor(dir, '0'), () => {}))!;
  stops.push(() => edge.stop());
  return edge;
};

describe('a sale rung on the screen reaches this till\'s disk', () => {
  it('commits through the loopback socket, and the sale is on the disk afterwards', async () => {
    const edge = await startLane();
    const view = bootPos({ laneId: 'lane-1', durable: laneDurable(edge.lane!.port) });

    view.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
    const receipt = await view.tenderCash('S-1', 'R-0001', '2026-08-05T10:00:00Z');
    expect(receipt).toBe('R-0001');

    // On the disk, whole, and readable.
    const records = await readLog(edge.log.path);
    expect(records).toHaveLength(1);
    expect(records[0]?.ok === true && JSON.parse(records[0].record).id).toBe('S-1');
  });

  it('queues it for the cloud in the same breath', async () => {
    const edge = await startLane();
    const view = bootPos({ laneId: 'lane-1', durable: laneDurable(edge.lane!.port) });

    view.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
    await view.tenderCash('S-1', 'R-0001', '2026-08-05T10:00:00Z');

    // Durable AND queued. One without the other is a sale that either never happened or never
    // arrives — the seam found and fixed earlier today, asserted here from the screen's side.
    expect(edge.outbox.unsentCount()).toBe(1);
  });

  it('REFUSES the sale when this till\'s store is not running', async () => {
    // The screen's honest default. A lane with nowhere to write must not take money — and the
    // refusal reaches the cashier in words, before the receipt exists.
    const view = bootPos({ laneId: 'lane-1', durable: laneDurable(1) }); // nothing listens on port 1
    view.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });

    await expect(view.tenderCash('S-1', 'R-0001', '2026-08-05T10:00:00Z'))
      .rejects.toThrow(/not ready to take payment/);
  });
});

describe('nothing off this till can reach the socket', () => {
  it('binds to loopback and nowhere else — the bind address IS the control', async () => {
    // Bound to the network instead, any device on the shop wifi — including a customer's phone —
    // could post sales into this till's log.
    expect(LANE_HOST).toBe('127.0.0.1');
    expect(LANE_HOST).not.toBe('0.0.0.0');

    const edge = await startLane();
    const reachable = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'S-probe', total: 1 }),
    });
    expect(reachable.status).toBe(200);
  });

  it('serves exactly one route, and answers anything else with 404', async () => {
    // The smaller this surface is, the less there is to get wrong on a machine sitting in a shop.
    const edge = await startLane();
    for (const [method, path] of [['GET', '/lane/sales'], ['POST', '/'], ['POST', '/admin'], ['GET', '/']] as const) {
      const res = await fetch(`http://127.0.0.1:${edge.lane!.port}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it('refuses a payload too large to be a sale', async () => {
    const edge = await startLane();
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(300 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it('refuses a sale with no id — the field the record actually carries', async () => {
    // The first version of the server looked for `saleId` and the record carries `id`, so every
    // real sale was refused with "could not read the sale". Two files disagreeing about a field
    // name is a lane that cannot take money, and no unit test on either side would have shown it.
    const edge = await startLane();
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saleId: 'wrong field name', total: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses unreadable input in the cashier\'s words, not a stack trace', async () => {
    const edge = await startLane();
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json at all',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { committed: boolean; laneMessage: string };
    expect(body.committed).toBe(false);
    expect(body.laneMessage).toContain('Do not take payment');
  });
});

describe('an edge with no lane attached is the back-office box', () => {
  it('starts, and runs no lane socket at all', async () => {
    // ADR-0004: the same process does the shop-wide work with no screen attached. `null` rather
    // than a socket on a default port that nothing is supposed to be talking to.
    const dir = await tempDir();
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760',
    }, () => {}))!;
    stops.push(() => edge.stop());
    expect(edge.lane).toBeNull();
  });
});
