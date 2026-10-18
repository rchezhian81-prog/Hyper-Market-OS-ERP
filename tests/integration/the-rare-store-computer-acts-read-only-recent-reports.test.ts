import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore, type ReadOptions } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';
import type { BoxHealthRecord } from '../../services/platform/src/box-health';

/**
 * **Round 34 · M35-FR-03 · owner decision OB-124 (4) "A" (15 Oct 2026, in writing, "Build all five before pilot"), finishing
 * OB-104 "A" ("Before the pilot") — the three rare person acts no longer read every store-computer report; on memory and on
 * PostgreSQL, through head office's production routes, with every read of the reports COUNTED.**
 *
 * A store computer's 3,000 kept reports (a refused report, an at-risk list, a bound till prefix among them). Once the health
 * read has saved its running result, each act reads only the saved result and the few reports after it — never all 3,000:
 *   • acknowledging a refused report (head office business staff, a reason) — 201, the refusal found in the saved result;
 *     a count head office never held a refused report for is still 404;
 *   • acknowledging the "at-risk numbers not checked" line — 201 with the exact numbers; a stale set still 409;
 *   • "store computer replaced" (asked by head office, approved by the owner) — 201, the binding read from the saved result.
 * Before round 34 each of these read every report (3,000 rows each, counted here as a whole-stream read).
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const P = 'S1L1-';
const BOX = streamName(STREAM.org, 'store-computer-health');
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15 };
const REFUSAL_ACK = '/v1/store-computers/bill-number-refusals/acknowledgements';
const NOT_CHECKED_ACK = '/v1/store-computers/at-risk-not-checked/acknowledgements';
const REPLACE = '/v1/store-computers/replacements';
const REPORTS = 3_000;
type Reply = { status: number; body: unknown };
type Call = (method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown, branchId?: string) => Promise<Reply>;

/** Every read of the store-computer reports, counted: rows returned, and reads of the WHOLE stream (no position, no window). */
function counting(base: EventStore): { store: EventStore; rows: () => number; whole: () => number; reset: () => void } {
  let rows = 0;
  let whole = 0;
  const store = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'readStream') {
        return async (tenantId: string, stream: string, opts?: ReadOptions) => {
          const out = await target.readStream(tenantId, stream, opts);
          if (stream === BOX) { rows += out.length; if (opts?.sinceSeq === undefined && opts?.from === undefined && opts?.to === undefined) whole += 1; }
          return out;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { store, rows: () => rows, whole: () => whole, reset: () => { rows = 0; whole = 0; } };
}

async function theRareActsReadOnlyRecentReports(base: EventStore, idempotency?: SqlIdempotencyStore): Promise<void> {
  const c = counting(base);
  const h: ApiHarness = apiHarness({ store: c.store, ...(idempotency === undefined ? {} : { idempotency }) });
  const T = randomUUID();
  await h.seedOwner(T, OWNER);
  const call: Call = (method, path, user, body, branchId) => h.request({
    method, path, userId: user, tenantId: T, ...(branchId === undefined ? {} : { branchId }),
    ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }),
  });
  expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' })).status).toBe(200);
  for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }]] as const) {
    expect((await call('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBeLessThan(300);
  }
  expect((await call('POST', `/v1/stores/${S1}/settings`, OWNER, SETTINGS)).status).toBeLessThan(300);
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-box-new', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-ho', 'store_manager', 'all');
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P })).status).toBe(201);

  // 3,000 kept reports from u-box, one every 15 s, ending two hours ago: the till prefix rising; a refused word about another
  // store's prefix now and then; the latest naming at-risk numbers (more than the 500 checked, so a not-checked line).
  const end = Date.now() - 2 * 3_600_000;
  const records: BoxHealthRecord[] = Array.from({ length: REPORTS }, (_, i) => {
    const at = new Date(end - (REPORTS - 1 - i) * 15_000).toISOString();
    return {
      storeId: S1, observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
      disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000 + i, salesLogCapacityBytes: 1e9, reserveBytes: 1e6 },
      queue: { unsent: 0, deadLettered: 0 },
      receiptNumbersIssued: [{ prefix: P, through: 1_000 + i, soldThrough: 1_000 + i, unsent: { count: 0 }, ...(i >= REPORTS - 10 ? { atRisk: [[1, 700]] as [number, number][] } : {}) }],
      ...(i % 500 === 7 ? { receiptNumbersRefused: [{ prefix: 'D-', through: 9, because: 'prefix_of_another_store', bankedThrough: 0 }] } : {}),
    } as BoxHealthRecord;
  });
  for (let i = 0; i < records.length; i += 500) {
    await base.appendBatch(T, records.slice(i, i + 500).map((r, j) => ({
      stream: BOX, event: makeEvent({ id: `bh-${i + j}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i + j}`, source: 'test/r34', payload: r }),
    })));
  }
  // The health read builds the saved running result (on a busy database its save waits for the visibility fence: read again).
  const deadline = Date.now() + 120_000;
  for (;;) {
    c.reset();
    expect((await call('GET', '/v1/platform/operational-health/observed', OWNER)).status).toBe(200);
    if (c.whole() === 0 && c.rows() < 50) break; // a read resumed from the saved result
    if (Date.now() > deadline) throw new Error('the saved running result was never saved');
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }

  // ── The refused-report acknowledgement ──
  c.reset();
  const refusedAck = await call('POST', REFUSAL_ACK, 'u-ho', { storeId: S1, prefix: 'D-', through: 9, reason: 'support checked: another store\'s till' });
  expect(refusedAck.status, JSON.stringify(refusedAck.body)).toBe(201);
  expect([c.whole(), c.rows() < 50], 'refused acknowledgement').toEqual([0, true]);
  // Acknowledging the same count again is still kept (each its own record), and still reads no whole stream.
  c.reset();
  expect((await call('POST', REFUSAL_ACK, OWNER, { storeId: S1, prefix: 'D-', through: 9, reason: 'owner saw it too' })).status).toBe(201);
  expect(c.whole()).toBe(0);
  // A count never refused: 404 by name, nothing kept.
  c.reset();
  const none = await call('POST', REFUSAL_ACK, 'u-ho', { storeId: S1, prefix: 'D-', through: 77, reason: 'no such count' });
  expect([none.status, (none.body as { error?: { code?: string } }).error?.code]).toEqual([404, 'no_such_refused_report']);
  expect(c.whole()).toBe(0);
  const kept = await base.readStream(T, streamName(STREAM.org, 'store-computer-refusal-acknowledgements'));
  expect(kept.map((e) => (e.event.payload as { by: string }).by)).toEqual(['u-ho', OWNER]);

  // ── The not-checked acknowledgement ──
  c.reset();
  const stale = await call('POST', NOT_CHECKED_ACK, 'u-ho', { storeId: S1, prefix: P, numbers: [[1, 150]], reason: 'support compared the restore record' });
  expect([stale.status, (stale.body as { error?: { code?: string } }).error?.code]).toEqual([409, 'not_checked_set_changed']);
  const notChecked = await call('POST', NOT_CHECKED_ACK, 'u-ho', { storeId: S1, prefix: P, numbers: [[1, 200]], reason: 'x' });
  expect(notChecked.status).toBe(400); // a reason too short: refused before anything is read
  c.reset();
  const ok = await call('POST', NOT_CHECKED_ACK, 'u-ho', { storeId: S1, prefix: P, numbers: [[1, 200]], count: 200, reason: 'support compared the restore record' });
  // The latest report names [[1, 700]] at risk: the newest 500 (201–700) are checked, 1–200 are not.
  expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  expect((ok.body as { acknowledged: Record<string, unknown> }).acknowledged).toMatchObject({ storeId: S1, prefix: P, notChecked: [[1, 200]], count: 200, by: 'u-ho' });
  expect([c.whole(), c.rows() < 50], 'not-checked acknowledgement').toEqual([0, true]);

  // ── "Store computer replaced" ──
  const details = { storeId: S1, prefix: P, fromComputer: 'u-box', toComputer: 'u-box-new', reason: 'old store computer disk failed; replaced' };
  const asked = await call('POST', '/v1/approvals/requests', 'u-ho', { kind: 'store_computer_replaced', subjectRef: `${S1}/${P}`, details, summary: `Move ${P} to u-box-new`, reason: details.reason });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  const req = (asked.body as { requestId: string }).requestId;
  expect((await call('POST', `/v1/approvals/requests/${req}/decide`, OWNER, { decision: 'approved', reason: 'I checked the new machine at the store' })).status).toBeLessThan(300);
  c.reset();
  const moved = await call('POST', REPLACE, 'u-ho', { ...details, approvalId: req });
  expect(moved.status, JSON.stringify(moved.body)).toBe(201);
  expect((moved.body as { replacement: Record<string, unknown> }).replacement).toMatchObject({ storeId: S1, prefix: P, from: 'u-box', to: 'u-box-new', approvedBy: OWNER });
  expect([c.whole(), c.rows() < 50], 'store computer replaced').toEqual([0, true]);
  // The same move again: 409 by name (already bound to the new computer), still without reading every report.
  c.reset();
  const twice = await call('POST', REPLACE, 'u-ho', { ...details, approvalId: req });
  expect(twice.status).toBe(409);
  expect(c.whole()).toBe(0);
}

describe('round 34 · M35-FR-03 · OB-124 (4) / OB-104: the three rare person acts read only the saved result and recent reports (memory)', () => {
  it('M35-FR-03 OB-124 OB-104: refused-report and not-checked acknowledgements and "store computer replaced" — no whole-stream read of 3,000 reports, under 50 rows each', async () => {
    await theRareActsReadOnlyRecentReports(new InMemoryEventStore());
  }, 180_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('round 34 · M35-FR-03 · OB-124 (4) / OB-104: the three rare person acts read only the saved result and recent reports (PostgreSQL)', () => {
  it('M35-FR-03 OB-124 OB-104: refused-report and not-checked acknowledgements and "store computer replaced" — no whole-stream read of 3,000 reports, under 50 rows each', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try { await theRareActsReadOnlyRecentReports(new SqlEventStore(sql), new SqlIdempotencyStore(sql)); } finally { await pool.end(); }
  }, 300_000);
});
