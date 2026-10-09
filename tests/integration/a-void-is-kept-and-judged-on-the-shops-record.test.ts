import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill } from '../support/till-operator';

/**
 * **PF-07 — a void at the till is kept as evidence and judged by the store's rules on the shop's OWN record (Wave 4 ·
 * M15-FR-01 · M12-FR-04 · P-03 · P-08 · hard rule #6).**
 *
 * The audit reproduced it: the void's reason was gone once the basket moved on, and the rule evaluation ran only over
 * activity somebody pasted in. Real API, real store box, the real till session: a void goes to the box first (the line
 * stays if the box cannot keep it), is on the box's disk stamped with the cashier the box verified, reaches head office
 * through the real sync agent once, and head office runs the store's rules over the voids it holds AND the refunds it
 * banked — raising an exception for the cashier who breached, linked to the transactions, listed for the owner with the
 * case opened from it. The old evaluate route answers as a PREVIEW.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaf07';
const KEY = TEST_PACK_KEY;
const TODAY = new Date().toISOString().slice(0, 10);

describe('PF-07 — a void reaches head office and the rules run on it', () => {
  let h: ApiHarness;
  let dir: string;
  let edge: EdgeProcess;
  const savedFetch = globalThis.fetch;
  const call = (method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>) =>
    h.request({ method, path, userId: 'u-owner', tenantId: A, ...(method === 'POST' ? { idempotencyKey: `k-${Math.random()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-box', 'cashier'); // the store box's sync identity
    await h.provisionRole(A, 'u-lanecash', 'cashier');
    await h.provisionRole(A, 'u-manager', 'store_manager');
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-void-evidence-'));
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
      ...await prepareTillBox({ dir, key: KEY }),
    }, () => {}))!;
    // The store's rule: more than 2 voids in a day, or any single void over ₹500, is an exception.
    expect((await call('POST', '/v1/loss-prevention/rules/void', { maxCount: 2, maxSingleValueMinor: 50_000 })).status).toBe(201);
  });
  afterAll(async () => {
    await edge?.stop();
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  it('THE AUDIT\'S CASE: three voids with their reasons → on the box first → head office holds them → an exception is raised for that cashier, linked to the voids', async () => {
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(till, 'u-lanecash');
    till.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    till.scan({ productId: 'P2', description: 'Sugar 1kg', unitPriceMinor: 5_000, qty: 2 });
    till.scan({ productId: 'P3', description: 'Salt 1kg', unitPriceMinor: 2_000, qty: 1 });
    const [l1, l2, l3] = till.basket().map((l) => l.lineId);
    expect(await till.voidAtTill(l1!, 'customer changed mind')).toMatchObject({ ok: true });
    expect(await till.voidAtTill(l2!, 'scanned twice')).toMatchObject({ ok: true });
    expect(await till.voidAtTill(l3!, 'damaged pack')).toMatchObject({ ok: true });
    expect(till.basket().filter((l) => !l.voided)).toHaveLength(0);

    // On the box's disk, stamped with the cashier the BOX verified, before any line went.
    const onBox = (await readLog(edge.deviceEventsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string; payload: Record<string, unknown> }] : []))
      .filter((e) => e.type === 'TillActivityRecorded');
    expect(onBox.map((e) => [e.payload['productId'], e.payload['valueMinor'], e.payload['reason'], e.payload['cashierId']])).toEqual([
      ['P1', 64_000, 'customer changed mind', 'u-lanecash'], ['P2', 10_000, 'scanned twice', 'u-lanecash'], ['P3', 2_000, 'damaged pack', 'u-lanecash'],
    ]);

    // Through the real sync agent, once.
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect(await edge.syncOnce!()).toMatchObject({ sent: 0 });
    const held = (await call('GET', '/v1/loss-prevention/activity', undefined, { day: TODAY })).body as { count: number; voids: { cashierId: string; valueMinor: number }[] };
    expect(held.count).toBe(3);

    // Judged on the shop's own record: three voids (> 2) and one of ₹640 (> ₹500) — both for u-lanecash, linked to the lines.
    const ex = (await call('GET', '/v1/loss-prevention/exceptions', undefined, { day: TODAY })).body as { exceptions: { exceptionId: string; cashierId: string; kind: string; breach: string; observed: number; linkedTxnIds: string[]; raisedAt?: string }[]; source: string };
    expect(ex.source).toMatch(/own record/);
    expect(ex.exceptions.map((x) => [x.cashierId, x.kind, x.breach, x.observed])).toEqual(expect.arrayContaining([
      ['u-lanecash', 'void', 'count', 3], ['u-lanecash', 'void', 'single_value', 64_000],
    ]));
    for (const x of ex.exceptions) {
      expect(x.raisedAt).toEqual(expect.any(String)); // raised when the voids arrived, not only when someone looked
      expect(x.linkedTxnIds.length).toBeGreaterThan(0);
    }

    // A case is opened FROM the raised exception, and the list says so.
    const countEx = ex.exceptions.find((x) => x.breach === 'count')!;
    expect((await call('POST', '/v1/loss-prevention/cases/case-1', { raisedFromRef: countEx.exceptionId, subjectRef: 'u-lanecash', summary: 'three voids in a day', valueMinor: 76_000, assignedTo: 'u-manager' })).status).toBe(201);
    const after = (await call('GET', '/v1/loss-prevention/exceptions', undefined, { day: TODAY })).body as { exceptions: { exceptionId: string; caseId?: string }[] };
    expect(after.exceptions.find((x) => x.exceptionId === countEx.exceptionId)).toMatchObject({ caseId: 'case-1' });
  });

  it('the box cannot keep the void: the line STAYS on the bill', async () => {
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: 1, cashierId: 'u-lanecash' });
    till.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    const [l1] = till.basket().map((l) => l.lineId);
    expect(await till.voidAtTill(l1!, 'customer changed mind')).toMatchObject({ ok: false, refusedBecause: 'lane_unreachable' });
    expect(till.basket().filter((l) => !l.voided)).toHaveLength(1);
  });

  it('nobody signed in, or no reason: no void', async () => {
    const nobody = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    nobody.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    expect(await nobody.voidAtTill(nobody.basket()[0]!.lineId, 'x')).toMatchObject({ ok: false, refusedBecause: 'operator_not_signed_in' });
    const t = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(t, 'u-lanecash');
    t.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
    expect(await t.voidAtTill(t.basket()[0]!.lineId, '  ')).toMatchObject({ ok: false, refusedBecause: 'reason_required' });
  });

  it('refunds head office banked count too; the supplied-data evaluate answers as a PREVIEW', async () => {
    expect((await call('POST', '/v1/loss-prevention/rules/refund', { maxCount: 0 })).status).toBe(201);
    // A refund already banked at head office (a returns record), processed by u-lanecash today.
    const { STREAM } = await import('../../services/api/src/adapters');
    const { makeEvent } = await import('../../packages/contracts/src/event');
    const at = new Date().toISOString();
    await h.store.append(A, STREAM.returns, makeEvent({ id: 'r-1', type: 'ReturnRecorded', occurredAt: at, idempotencyKey: `return-proj-${A}-RT-9`, source: 'test', payload: { returnId: 'RT-9', processedBy: 'u-lanecash', processedAt: at, refundMinor: 9_000 } }));
    const ex = (await call('GET', '/v1/loss-prevention/exceptions', undefined, { day: TODAY })).body as { exceptions: { kind: string; linkedTxnIds: string[] }[] };
    expect(ex.exceptions.find((x) => x.kind === 'refund')).toMatchObject({ linkedTxnIds: ['RT-9'] });

    const preview = (await call('POST', '/v1/loss-prevention/evaluate', { events: [{ txnId: 'T1', kind: 'void', cashierId: 'u-x', at, valueMinor: 1 }] })).body as { preview: boolean; note: string };
    expect(preview).toMatchObject({ preview: true, note: expect.stringMatching(/not the shop's record/) });
  });

  it('a relayed void head office cannot read is refused by name (dead-lettered at the store, never repaired)', async () => {
    const res = await h.request({ method: 'POST', path: '/v1/loss-prevention/activity/V-bad/synced', userId: 'u-box', tenantId: A, idempotencyKey: 'k-bad', body: { activityId: 'V-bad', kind: 'void' } });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_readable_as_till_activity');
    // A person without the box's hop cannot post one.
    await h.provisionRole(A, 'u-visitor', 'customer');
    expect((await h.request({ method: 'POST', path: '/v1/loss-prevention/activity/V-x/synced', userId: 'u-visitor', tenantId: A, idempotencyKey: 'k-v', body: {} })).status).toBe(403);
  });
});
