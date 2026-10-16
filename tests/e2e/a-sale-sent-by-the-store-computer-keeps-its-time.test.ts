import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, holdSignedInAt } from '../support/till-operator';
import { bootPos, laneDurable } from '../../apps/pos/src/browser-entry';
import { SyncAgent } from '../../edge/sync-agent/src/agent';
import { httpTransport } from '../../edge/sync-agent/src/http-transport';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import type { HttpResponse } from '../../services/kernel/src/index';

/**
 * **Round 36 · M35-FR-03 · OB-108 / OB-124 (1) · verifier r34 NEW-6, verifier r35 note — the store computer's own time for a
 * bill is KEPT end to end, through the real store computer and the real sync agent, when the sync agent is signed in as the
 * store computer itself.**
 *
 * Round 35 proved "kept only from the store computer's own sign-in" through head office's routes (integration). The core
 * e2e lane (core-one-lane) signs its sync agent in as the owner, so end to end it goes through the "time ignored" path. This
 * runs the same production pieces — a real store edge with its lane socket and its disk, a real `PosSession` ringing a sale
 * offline, the real outbox, `SyncAgent` and `httpTransport`, and head office's real router, permission check and POS intake
 * — with the sync agent's requests carried as the STORE COMPUTER's machine identity (`store_computer` role for store S1):
 *
 *   • the edge stamps when it took the bill (`storeComputerTakenAt`, on its own clock) on the record it queues;
 *   • head office KEEPS that time on the banked sale (no "offered and ignored" note), and the reply says nothing was ignored;
 *   • the same record sent by a person (the owner) has the time ignored and noted — the contrast, so this proof cannot pass by
 *     head office keeping every time.
 */

const KEY = TEST_PACK_KEY;
const TENANT = 't-sre-r36';
const STORE = 'S1';
const BOX = 'u-box-r36';
const OWNER = 'u-owner-r36';
const COMMITTED_AT = new Date(Date.now() - 60_000).toISOString();
const TRADING_DAY = COMMITTED_AT.slice(0, 10);

/** A `fetch` that carries the sync agent's POST to the real cloud surface as the given principal (for its store). */
function cloudFetch(h: ApiHarness, userId: string, branchId?: string): typeof globalThis.fetch {
  return (async (url: string, init: RequestInit): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const res: HttpResponse = await h.request({
      method: 'POST', path: new URL(url).pathname, userId, tenantId: TENANT, ...(branchId === undefined ? {} : { branchId }),
      body: JSON.parse(String(init.body)) as unknown,
      ...(headers['idempotency-key'] === undefined ? {} : { idempotencyKey: headers['idempotency-key'] }),
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;
}
interface Banked { saleId: string; storeComputerTakenAt?: string; storeComputerTakenAtIgnored?: { offered: string; by: string } }
const banked = async (h: ApiHarness): Promise<readonly Banked[]> =>
  (await h.store.readStream(TENANT, STREAM.sales, { type: 'SaleCommitted' })).map((e) => e.event.payload as Banked);

describe('round 36 · the store computer\'s time for a bill, end to end through the real sync agent', () => {
  let dir: string;
  let edge: EdgeProcess;
  let h: ApiHarness;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sre-r36-box-time-'));
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      ...await prepareTillBox({ dir, key: KEY, people: [{ userId: 'cashier', displayName: 'Cashier' }], pack: { policies: { storeId: STORE }, receiptSeries: [{ laneId: 'lane-1', prefix: 'C1-', padTo: 6, rangeStart: 1, rangeEnd: 9999, bankedThrough: 0 }] } }),
    }, () => {}))!;
    await holdSignedInAt(edge.lane!.port, 'cashier');
    h = apiHarness();
    await h.seedOwner(TENANT, OWNER);
    // The store computer's own machine identity, for its store (OB-36 "A").
    await h.provisionRole(TENANT, BOX, 'store_computer', [STORE]);
    // Two bills rung offline on the lane, to the box's own disk — no cloud call.
    for (const id of ['S-1', 'S-2']) {
      const view = bootPos({ laneId: 'lane-1', cashierId: 'cashier', tradingDay: TRADING_DAY, durable: laneDurable(edge.lane!.port), lanePort: edge.lane!.port });
      view.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
      await view.tenderCash(id, await view.nextReceipt(), COMMITTED_AT);
    }
  });

  afterAll(async () => {
    await edge?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('M35-FR-03 OB-108 NEW-6: the sync agent signed in as the store computer — head office keeps the time the store computer took the bill', async () => {
    const queued = edge.outbox.all().filter((i) => (i.event.payload as { saleId?: string }).saleId !== undefined);
    expect(queued.length).toBe(2);
    // The edge stamped when it took each bill, on its own clock.
    for (const q of queued) expect(typeof (q.event.payload as { storeComputerTakenAt?: unknown }).storeComputerTakenAt).toBe('string');
    const stampOf = (saleId: string): string => (queued.find((q) => (q.event.payload as { saleId?: string }).saleId === saleId)!.event.payload as { storeComputerTakenAt: string }).storeComputerTakenAt;

    // The store computer's sync agent drains its outbox as ITSELF (its machine identity, for its own store).
    const agent = new SyncAgent(edge.outbox, httpTransport({ baseUrl: 'https://cloud.example.test', token: 'box-token', fetch: cloudFetch(h, BOX, STORE) }));
    const result = await agent.drain({ at: COMMITTED_AT });
    expect(result.deadLettered).toBe(0);
    expect(result.acknowledged).toBe(2);
    for (const id of ['S-1', 'S-2']) {
      const fromBox = (await banked(h)).find((s) => s.saleId === id)!;
      expect(fromBox.storeComputerTakenAt).toBe(stampOf(id)); // KEPT — the store computer's own word
      expect(fromBox.storeComputerTakenAtIgnored).toBeUndefined();
    }
  });

  it('M35-FR-03 OB-108 NEW-6: the same record from a person (the owner) — the time is not kept, and the bill says it was offered and ignored', async () => {
    const sent = edge.outbox.all().find((i) => (i.event.payload as { saleId?: string }).saleId === 'S-2')!;
    const body = { ...(sent.event.payload as Record<string, unknown>), saleId: 'S-2-owner', receiptNumber: 'C1-009999' };
    const res = await h.request({ method: 'POST', path: '/v1/sales', userId: OWNER, tenantId: TENANT, body, idempotencyKey: 'owner-posts-the-same-record' });
    expect(res.status).toBe(202);
    const fromOwner = (await banked(h)).find((s) => s.saleId === 'S-2-owner')!;
    expect(fromOwner.storeComputerTakenAt).toBeUndefined();
    expect(fromOwner.storeComputerTakenAtIgnored).toMatchObject({ by: OWNER });
    // And the store computer's own bills kept theirs.
    for (const s of (await banked(h)).filter((x) => x.saleId === 'S-1' || x.saleId === 'S-2')) {
      expect(s.storeComputerTakenAt).toBeDefined();
      expect(s.storeComputerTakenAtIgnored).toBeUndefined();
    }
  });
});
