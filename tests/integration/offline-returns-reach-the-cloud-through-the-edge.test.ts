import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **A refund taken at the lane with the cable out reaches the cloud, through the real edge — Slice 2b.**
 *
 * The transport wire (Slice 2a, merged) gave `ReturnAccepted` a route to the cloud's record-and-flag
 * endpoint. This is the edge-bootstrap half that FEEDS that wire: the edge now durably persists a
 * refund to its OWN log and queues it on its OWN outbox, drained by its own agent — the exact mirror
 * of the sale seam, and deliberately separate from it so the sale path is untouched by its existence.
 *
 * Everything below the socket is production: the real `startEdge` opens real durable logs on disk, the
 * real `SyncAgent` + `httpTransport` drain to a `fetch` that drives the real cloud API surface (router,
 * token auth, RBAC, the append-only register). Only the socket is replaced. The last thing this proves
 * is the safety property the whole design turns on: **a refund is never re-queued as a sale, nor a sale
 * as a refund** — the two logs and two cursors never cross.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-08-07T10:00:00.000Z';
const KEY = ['edge', 'returns', 'seam', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');

/** A bill banked in the cloud so a return has something to reconcile against — 3 units at ₹50. */
const sale = (saleId: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-08-07', committedAt: AT, totalMinor: 15000, currency: 'INR', packVersion: 0,
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amountMinor: 15000 }],
});
const bank = (h: ApiHarness, saleId: string) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: A, idempotencyKey: `bank-${saleId}`, body: sale(saleId) });
const refundableOf = async (h: ApiHarness, saleId: string): Promise<number> =>
  ((await h.request({ method: 'GET', path: `/v1/sales/${saleId}/returnable`, userId: 'u-owner', tenantId: A })).body as { refundableMinor: number }).refundableMinor;

/** A refund as the lane commits it offline — the ReturnAccepted payload `packages/returns` mints. */
const returnRecord = (returnId: string, originalSaleId: string, approvedBy: string) => JSON.stringify({
  returnId, number: returnId, originalSaleId, noReceipt: false, laneId: 'lane-1',
  processedBy: 'u-lanecash', approvedBy, reasonCode: 'customer_changed_mind',
  refundMinor: 5000, currency: 'INR', refundTender: 'cash', refundStatus: 'settled', processedAt: AT,
  lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' }],
});

/** An edge-committed sale, in the disk shape the lane writes and `toCloudSale` reads. */
const saleRecord = (saleId: string) => JSON.stringify({
  id: saleId, number: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-lanecash',
  tradingDay: '2026-08-07', committedAt: AT, total: 15000, currency: 'INR',
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amount: { minor: 15000, currency: 'INR' } }],
});

describe('offline returns reach the cloud through the real edge (M13-FR-01, §31)', () => {
  let h: ApiHarness;
  let dir: string;
  let online = true;
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, 'u-owner');                     // pos.return.sync + pos.return.approve + lp.case.read
    await h.provisionRole(A, 'u-mgr', 'store_manager');  // a genuine refund approver
    await h.provisionRole(A, 'u-sync', 'cashier');       // the store's sync identity: pos.return.sync
    for (const s of ['S1', 'S2', 'S3']) await bank(h, s);

    // `fetch` drives the real cloud surface. The edge's agents read `globalThis.fetch` at startup, so
    // it is set before any `startEdge` below (exactly as the sale-seam e2e does).
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'],
        path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''),
        idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;

    dir = await mkdtemp(join(tmpdir(), 'sre-edge-returns-'));
  });

  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const env = () => ({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    CLOUD_API_URL: 'https://cloud.example.test',
    // The store's sync token — a cashier who holds pos.return.sync. The cloud authenticates it and
    // re-verifies the relayed approver's authority itself.
    CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-sync', tenantId: A }),
  });

  it('QUEUES a refund the moment it is durably committed, without being told to', async () => {
    online = true;
    const edge = (await startEdge(env(), () => {}))!;
    const outcome = await edge.node.commitReturn('RT1', returnRecord('RT1', 'S1', 'u-mgr'));

    expect(outcome.committed).toBe(true);
    // Durable AND queued — one without the other is a refund that either never happened or never arrives.
    expect(edge.returnsAgent?.health().unsentCount).toBe(1);
    // The sale queue is untouched by a refund.
    expect(edge.agent?.health().unsentCount).toBe(0);
    await edge.stop();
  });

  it('and that queued refund reconciled into the cloud register after the edge stopped', async () => {
    // `stop()` drains before it goes. One of three units is now back: ₹50 off the ₹150 refundable.
    expect(await refundableOf(h, 'S1')).toBe(10000);
  });

  it('does not re-send it on the next start — the returns cursor remembers', async () => {
    const said: string[] = [];
    const edge = (await startEdge(env(), (l) => said.push(l)))!;
    expect(edge.returnsAgent?.health().unsentCount).toBe(0);
    expect(said.join('\n')).not.toContain('refund(s) from before are still to send');
    await edge.stop();
  });

  it('DOES re-send a refund that never got through, after a restart', async () => {
    // A refund committed with the cloud unreachable, then a restart. Re-queued from the returns log,
    // because the log is the system of record and the queue is only a view of it.
    online = false;
    const offline = (await startEdge(env(), () => {}))!;
    await offline.node.commitReturn('RT2', returnRecord('RT2', 'S2', 'u-mgr'));
    await offline.stop();
    expect(await refundableOf(h, 'S2')).toBe(15000); // nothing reconciled while offline

    online = true;
    const said: string[] = [];
    const back = (await startEdge(env(), (l) => said.push(l)))!;
    expect(said.join('\n')).toContain('1 refund(s) from before are still to send');
    expect(back.returnsAgent?.health().unsentCount).toBe(1);
    await back.stop();

    expect(await refundableOf(h, 'S2')).toBe(10000); // now it is in the cloud
  });

  it('reconciles a refund whose lane approver lacks authority, and flags it (§28) — never rejected', async () => {
    online = true;
    const edge = (await startEdge(env(), () => {}))!;
    // The lane relayed an approver who does not hold pos.return.approve. The money already left the
    // drawer, so the cloud RECORDS it and flags it — it never bounces a refund that happened.
    await edge.node.commitReturn('RT-BAD', returnRecord('RT-BAD', 'S3', 'u-nobody'));
    await edge.stop();

    expect(await refundableOf(h, 'S3')).toBe(10000); // recorded (the refund is real)
    const exc = (await h.request({ method: 'GET', path: '/v1/pos/return-governance-exceptions', userId: 'u-owner', tenantId: A })).body as { count: number; exceptions: { returnId: string; approvedBy?: string; governanceFlags: string[] }[] };
    expect(exc.exceptions.some((e) => e.returnId === 'RT-BAD' && e.approvedBy === 'u-nobody' && e.governanceFlags.includes('approver_lacks_authority'))).toBe(true);
  });

  it('keeps the sale and refund logs SEPARATE — neither is ever re-queued as the other', async () => {
    // The safety property the whole design turns on. A fresh dir so the assertion is exact.
    const dir2 = await mkdtemp(join(tmpdir(), 'sre-edge-sep-'));
    try {
      online = true;
      const env2 = { ...env(), EDGE_DATA_DIR: dir2 };
      const edge = (await startEdge(env2, () => {}))!;
      await edge.node.commit('S9', saleRecord('S9'));           // a sale
      await edge.node.commitReturn('RT9', returnRecord('RT9', 'S1', 'u-mgr')); // a refund
      await edge.stop();

      // Each landed in its OWN log, and only its own.
      const salesLog = await readLog(join(dir2, 'sales.log'));
      const returnsLogRecords = await readLog(join(dir2, 'returns.log'));
      expect(salesLog).toHaveLength(1);
      expect(returnsLogRecords).toHaveLength(1);
      expect(salesLog[0]?.ok && salesLog[0].record).toContain('S9');
      expect(returnsLogRecords[0]?.ok && returnsLogRecords[0].record).toContain('RT9');

      // Restart: BOTH cursors advanced independently, so neither queue re-sends — and crucially the
      // returns re-queue did not read the sale, nor the sale re-queue the refund.
      const said: string[] = [];
      const restarted = (await startEdge(env2, (l) => said.push(l)))!;
      expect(restarted.agent?.health().unsentCount).toBe(0);
      expect(restarted.returnsAgent?.health().unsentCount).toBe(0);
      expect(said.join('\n')).not.toContain('still to send');
      await restarted.stop();
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
