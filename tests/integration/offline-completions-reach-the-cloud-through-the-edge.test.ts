import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **A checklist or task completed at the shop with the cable out reaches the cloud, through the real edge — M25-FR-02, §31.**
 *
 * Slice 1 (merged) gave the cloud two synced landing routes under the narrow `workforce.completion.sync`
 * permission; slice 2a (merged) gave `ChecklistCompleted`/`TaskCompleted` a wire to them and a defensive
 * translator. This is the edge-bootstrap half that FEEDS that wire: the box now durably persists a
 * completion to its OWN log and queues it on its OWN outbox, drained by its own agent — a third pipeline
 * beside sales and refunds, and deliberately separate from both so neither is touched by its existence.
 *
 * Everything below the socket is production: the real `startEdge` opens real durable logs on disk, the
 * real `SyncAgent` + `httpTransport` drain to a `fetch` that drives the real cloud API surface (router,
 * token auth, the narrow-permission RBAC gate, the append-only workforce stores). Only the socket is
 * replaced. The last thing this proves is the safety property the whole design turns on: **a completion
 * is never re-queued as a sale or a refund, nor either of those as a completion** — the three logs and
 * three cursors never cross (hard rule #1).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-14T21:00:00.000Z';
const KEY = ['edge', 'completions', 'seam', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');

/** A signed closing checklist, exactly as the box captured it offline — the id rides IN the record so the
 *  transport route template fills the `:checklistId` path segment from the translated payload. */
const checklistRecord = (checklistId: string) => JSON.stringify({
  checklistId, kind: 'closing', signedBy: 'Meena', branchId: 'b1',
  items: [
    { itemId: 'safe', description: 'Cash in the safe, counted', done: true, blocking: true },
    { itemId: 'log', description: 'Fridge temperature log filled', done: true, blocking: false },
  ],
});

/** A task marked done offline — the box's on-disk completion record. */
const taskDoneRecord = (taskId: string, doneBy: string) => JSON.stringify({ taskId, doneBy });

/** A bill banked in the cloud so the separation test's refund has something to reconcile against. */
const sale = (saleId: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-09-14', committedAt: AT, totalMinor: 15000, currency: 'INR', packVersion: 0,
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amountMinor: 15000 }],
});
const bank = (h: ApiHarness, saleId: string) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: A, idempotencyKey: `bank-${saleId}`, body: sale(saleId) });

/** An edge-committed sale + refund, in the disk shapes the lane writes (for the separation test). */
const saleRecord = (saleId: string) => JSON.stringify({
  id: saleId, number: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-lanecash',
  tradingDay: '2026-09-14', committedAt: AT, total: 15000, currency: 'INR',
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amount: { minor: 15000, currency: 'INR' } }],
});
const returnRecord = (returnId: string, originalSaleId: string, approvedBy: string) => JSON.stringify({
  returnId, number: returnId, originalSaleId, noReceipt: false, laneId: 'lane-1',
  processedBy: 'u-lanecash', approvedBy, reasonCode: 'customer_changed_mind',
  refundMinor: 5000, currency: 'INR', refundTender: 'cash', refundStatus: 'settled', processedAt: AT,
  lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' }],
});

const checklistComplete = async (h: ApiHarness, id: string): Promise<{ outcome: string; complete: boolean; signedBy?: string }> => {
  const body = (await h.request({ method: 'GET', path: `/v1/hr/workforce/checklists/${id}/status`, userId: 'u-mgr', tenantId: A }))
    .body as { assessment: { outcome: string; complete: boolean }; checklist: { signedBy?: string } };
  return { outcome: body.assessment.outcome, complete: body.assessment.complete, ...(body.checklist.signedBy === undefined ? {} : { signedBy: body.checklist.signedBy }) };
};
const taskStatus = async (h: ApiHarness, taskId: string): Promise<string | undefined> =>
  ((await h.request({ method: 'GET', path: '/v1/hr/workforce/tasks', userId: 'u-mgr', tenantId: A, query: { asOf: '2026-09-14T23:00:00Z' } }))
    .body as { tasks: readonly { taskId: string; status: string }[] }).tasks.find((t) => t.taskId === taskId)?.status;

describe('offline completions reach the cloud through the real edge (M25-FR-02, §31)', () => {
  let h: ApiHarness;
  let dir: string;
  let online = true;
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, 'u-owner');                     // banks the reference sale
    await h.provisionRole(A, 'u-mgr', 'store_manager');  // holds workforce.completion.sync (+ manage/read/task.read)
    await bank(h, 'S1');
    // A task defined online, so the offline completion has something on the shelf to mark done.
    await h.request({ method: 'POST', path: '/v1/hr/workforce/tasks/T-chiller', userId: 'u-mgr', tenantId: A, idempotencyKey: 'def-chiller',
      body: { description: 'Chiller temperature check', forRole: 'cashier', dueAt: '2026-09-14T06:00:00Z', critical: true } });

    // `fetch` drives the real cloud surface. The edge's agents read `globalThis.fetch` at startup, so
    // it is set before any `startEdge` below (exactly as the sale- and return-seam integration tests do).
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

    dir = await mkdtemp(join(tmpdir(), 'sre-edge-completions-'));
  });

  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const env = () => ({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    CLOUD_API_URL: 'https://cloud.example.test',
    // The store's sync token. A completion is signed by a MANAGER, and `workforce.completion.sync` is
    // held only by manager-and-above (slice 1 deliberately withholds it from the cashier and proves a
    // cashier is refused) — so the box relays a completion under a completion.sync-holding authority,
    // not the cashier identity the sale/refund pipelines can use. The cloud re-verifies the signer.
    CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-mgr', tenantId: A }),
  });

  it('QUEUES a checklist completion the moment it is durably committed, without being told to', async () => {
    online = true;
    const edge = (await startEdge(env(), () => {}))!;
    const outcome = await edge.node.commitCompletion('checklist', 'CL-1', checklistRecord('CL-1'));

    expect(outcome.committed).toBe(true);
    // Durable AND queued — on its own outbox, drained by its own agent.
    expect(edge.completionsAgent?.health().unsentCount).toBe(1);
    // The sale and refund queues are untouched by a completion.
    expect(edge.agent?.health().unsentCount).toBe(0);
    expect(edge.returnsAgent?.health().unsentCount).toBe(0);
    await edge.stop();
  });

  it('and that queued checklist reconciled into the SAME durable store the online route uses, after the edge stopped', async () => {
    // `stop()` drains before it goes. The status route (a read on the online store) now sees it, signed and complete.
    const status = await checklistComplete(h, 'CL-1');
    expect(status.outcome).toBe('complete');
    expect(status.complete).toBe(true);
    expect(status.signedBy).toBe('Meena');
  });

  it('does not re-send it on the next start — the completions cursor remembers', async () => {
    const said: string[] = [];
    const edge = (await startEdge(env(), (l) => said.push(l)))!;
    expect(edge.completionsAgent?.health().unsentCount).toBe(0);
    expect(said.join('\n')).not.toContain('completion(s) from before are still to send');
    await edge.stop();
  });

  it('DOES re-send a completion that never got through, after a restart', async () => {
    // A task completed with the cloud unreachable, then a restart. Re-queued from the completions log,
    // because the log is the system of record and the queue is only a view of it.
    online = false;
    const offline = (await startEdge(env(), () => {}))!;
    await offline.node.commitCompletion('task', 'T-chiller', taskDoneRecord('T-chiller', 'Meena'));
    await offline.stop();
    expect(await taskStatus(h, 'T-chiller')).not.toBe('done'); // nothing reconciled while offline

    online = true;
    const said: string[] = [];
    const back = (await startEdge(env(), (l) => said.push(l)))!;
    expect(said.join('\n')).toContain('1 completion(s) from before are still to send');
    expect(back.completionsAgent?.health().unsentCount).toBe(1);
    await back.stop();

    expect(await taskStatus(h, 'T-chiller')).toBe('done'); // now it is in the cloud
  });

  it('keeps the sale, refund and completion logs SEPARATE — none is ever re-queued as another', async () => {
    // The safety property the whole design turns on. A fresh dir so the assertion is exact.
    const dir2 = await mkdtemp(join(tmpdir(), 'sre-edge-sep3-'));
    try {
      online = true;
      const env2 = { ...env(), EDGE_DATA_DIR: dir2 };
      const edge = (await startEdge(env2, () => {}))!;
      await edge.node.commit('S9', saleRecord('S9'));                              // a sale
      await edge.node.commitReturn('RT9', returnRecord('RT9', 'S1', 'u-mgr'));      // a refund
      await edge.node.commitCompletion('checklist', 'CL-9', checklistRecord('CL-9')); // a completion
      await edge.stop();

      // Each landed in its OWN log, and only its own.
      const salesLog = await readLog(join(dir2, 'sales.log'));
      const returnsLogRecords = await readLog(join(dir2, 'returns.log'));
      const completionsLogRecords = await readLog(join(dir2, 'completions.log'));
      expect(salesLog).toHaveLength(1);
      expect(returnsLogRecords).toHaveLength(1);
      expect(completionsLogRecords).toHaveLength(1);
      expect(salesLog[0]?.ok && salesLog[0].record).toContain('S9');
      expect(returnsLogRecords[0]?.ok && returnsLogRecords[0].record).toContain('RT9');
      expect(completionsLogRecords[0]?.ok && completionsLogRecords[0].record).toContain('CL-9');

      // Restart: all THREE cursors advanced independently, so no queue re-sends — and crucially no
      // pipeline's re-queue read another pipeline's record.
      const said: string[] = [];
      const restarted = (await startEdge(env2, (l) => said.push(l)))!;
      expect(restarted.agent?.health().unsentCount).toBe(0);
      expect(restarted.returnsAgent?.health().unsentCount).toBe(0);
      expect(restarted.completionsAgent?.health().unsentCount).toBe(0);
      expect(said.join('\n')).not.toContain('still to send');
      await restarted.stop();
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
