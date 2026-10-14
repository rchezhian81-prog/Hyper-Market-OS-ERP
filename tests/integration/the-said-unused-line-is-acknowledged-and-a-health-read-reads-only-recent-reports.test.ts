import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore, type ReadOptions } from '../../packages/persistence/src/event-store';
import { InMemorySnapshotStore, SqlSnapshotStore, type SnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, storeComputerReading, storeComputerHistory, boxHealthAdapter } from '../../services/api/src/adapters';
import { judgeBoxes, UNRECEIVED_GRACE_MINUTES, UNUSED_RECEIVED_STAYS_WORDS, type BoxHealthRecord } from '../../services/platform/src/box-health';
import { DEFAULT_THRESHOLDS } from '../../packages/ops/src/index';
import { history, rng, iso, TEST_BOX_HISTORY_KEY } from '../support/box-history';

/**
 * **Round 28 · owner decisions OB-103 "A" and OB-104 "A" (13 Oct 2026, in writing) — through head office's production routes
 * and its store-computer reading, in memory and on PostgreSQL; refusals read back from audit_log on the served API.**
 *
 *   OB-103: the "said unused, but head office has the bill" line (`unused_number_received`) is acknowledged by the owner or
 *   head office business staff (all stores, never IT) with a reason — each acknowledgement kept with who, why and when; it
 *   holds while head office finds the same set of numbers; a new number needs a new acknowledgement. Refused by name: one
 *   store's manager, the IT administrator, a cashier, a count that changed, no such line, no reason.
 *   OB-104: the health read takes ONLY the box-health reports after its saved running result from the store (`sinceSeq`) —
 *   counted at the store — and every answer is the full reading's, on seeded random histories (memory and PostgreSQL),
 *   with the saved result set aside and rebuilt when a report arrives late, when it is deleted, or when a setting changes.
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const S2 = 'S2';
const P = 'S1L1-';
const P2 = 'S2L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 };
const UNUSED_ACK = '/v1/store-computers/unused-numbers-received/acknowledgements';
const BOX_HEALTH_STREAM = streamName(STREAM.org, 'store-computer-health');

interface Finding { kind: string; prefix: string; ranges?: [number, number][]; count?: number; since: string; detail: string }
interface Observed { observed: { boxes: { storeId: string; billNumberFindings?: Finding[] }[] } }
type Reply = { status: number; body: unknown };
type Call = (method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown, branchId?: string, key?: string) => Promise<Reply>;
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

afterEach(() => { vi.useRealTimers(); });

async function shop(h: ApiHarness): Promise<{ T: string; call: Call }> {
  const T = randomUUID();
  await h.seedOwner(T, OWNER);
  const call: Call = (method, path, user, body, branchId, key) => h.request({
    method, path, userId: user, tenantId: T, ...(branchId === undefined ? {} : { branchId }),
    ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }),
  });
  expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' })).status).toBe(200);
  for (const [id, body] of [
    ['C1', { kind: 'company', name: 'SRE Retail' }],
    [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }],
    [S2, { kind: 'branch', name: 'Store Two', parentId: 'C1', companyId: 'C1' }],
  ] as const) expect((await call('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBeLessThan(300);
  expect((await call('POST', `/v1/stores/${S1}/settings`, OWNER, SETTINGS)).status).toBeLessThan(300);
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
  await h.provisionRole(T, 'u-ho', 'store_manager', 'all'); // head office business staff, all stores
  await h.provisionRole(T, 'u-mgr1', 'store_manager', [S1]); // one store's manager
  await h.provisionRole(T, 'u-it', 'platform_admin', 'all'); // the IT / platform administrator
  expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P })).status).toBe(201);
  expect((await call('POST', `/v1/stores/${S2}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P2 })).status).toBe(201);
  return { T, call };
}
const bank = async (call: Call, numbers: readonly number[]): Promise<void> => {
  for (let i = 0; i < numbers.length; i += 16) {
    await Promise.all(numbers.slice(i, i + 16).map(async (n) => {
      const receipt = `${P}${pad(n)}`;
      const r = await call('POST', '/v1/sales', 'u-box', {
        saleId: `S-${receipt}`, receiptNumber: receipt, laneId: 'lane-1', locationId: S1, cashierId: 'u-cash', tradingDay: AT.slice(0, 10), committedAt: AT,
        totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }],
        tenders: [{ kind: 'cash', amountMinor: 1_000 }],
      }, S1);
      expect(r.status).toBe(202);
    }));
  }
};
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const report = async (call: Call, unused: [number, number][]): Promise<void> => {
  const r = await call('POST', '/v1/store-computers/health-reports', 'u-box', {
    observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
    queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ prefix: P, through: 110, soldThrough: 110, unsent: { count: 0 }, unused }],
  }, S1);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const findings = async (call: Call, kind: string): Promise<Finding[]> => {
  const r = await call('GET', '/v1/platform/operational-health/observed', OWNER);
  expect(r.status).toBe(200);
  return ((r.body as Observed).observed.boxes.find((b) => b.storeId === S1)?.billNumberFindings ?? []).filter((f) => f.kind === kind);
};
function clock(): { travel: (minutes: number) => void } {
  const t0 = Date.now();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  return { travel: (minutes) => { vi.setSystemTime(t0 + minutes * 60_000); } };
}

// ── OB-103: the "said unused, but head office has the bill" line, acknowledged ────────────────────────────────────────
async function theSaidUnusedLineIsAcknowledged(h: ApiHarness): Promise<void> {
  const { T, call } = await shop(h);
  await bank(call, range(1, 109)); // 105 and 107 sold and banked (a minute before the store computer's reports)
  const { travel } = clock();
  // The store computer keeps calling 105 given and never used — for hours after head office's sale under it.
  for (const k of [0, 30, 60, 90]) { travel(k); await report(call, [[105, 105]]); }
  travel(90 + UNRECEIVED_GRACE_MINUTES + 1);
  const line = async (): Promise<[number | undefined, [number, number][] | undefined][]> => (await findings(call, 'unused_number_received')).map((f) => [f.count, f.ranges]);
  expect(await line()).toEqual([[1, [[105, 105]]]]);
  expect((await findings(call, 'unused_number_received'))[0]!.detail).toContain(UNUSED_RECEIVED_STAYS_WORDS);
  // Round 29 · verifier r28 NEW-5: the acknowledgement names the EXACT numbers the page showed (and, optionally, how many).
  const ackBody = { storeId: S1, prefix: P, numbers: [[105, 105]], count: 1, reason: 'support checked the store computer; its unused list was faulty' };
  // Refused by name: one store's manager, the IT administrator, a cashier; a changed count; no such line; no reason.
  const no = async (user: string, body: unknown, status: number, code: string, branchId?: string): Promise<void> => {
    const r = await call('POST', UNUSED_ACK, user, body, branchId);
    expect(r.status, `${user} ${JSON.stringify(r.body)}`).toBe(status);
    expect(codeOf(r)).toBe(code);
  };
  await no('u-mgr1', ackBody, 403, 'acknowledgement_needs_all_stores_authority', S1);
  await no('u-it', ackBody, 403, 'acknowledgement_refused_to_platform_administrator');
  await no('u-cash', ackBody, 403, 'forbidden', S1);
  await no('u-ho', { ...ackBody, numbers: [[105, 106]], count: 2 }, 409, 'unused_received_set_changed');
  // NEW-5: one number the person never saw, with the same count, is refused; a count alone, or one that does not match, is not readable.
  await no('u-ho', { ...ackBody, numbers: [[106, 106]] }, 409, 'unused_received_set_changed');
  await no('u-ho', { storeId: S1, prefix: P, count: 1, reason: ackBody.reason }, 400, 'not_readable_as_acknowledgement');
  await no('u-ho', { ...ackBody, count: 2 }, 400, 'not_readable_as_acknowledgement');
  await no('u-ho', { ...ackBody, prefix: P2 }, 404, 'no_such_unused_received_finding');
  await no('u-ho', { ...ackBody, storeId: S2 }, 404, 'no_such_unused_received_finding');
  await no('u-ho', { ...ackBody, reason: 'ok' }, 400, 'not_readable_as_acknowledgement');
  expect(await line()).toEqual([[1, [[105, 105]]]]);
  const kept0 = await h.store.readStream(T, streamName(STREAM.org, 'store-computer-unused-received-acknowledgements'));
  expect(kept0).toEqual([]); // nothing refused was kept
  // Head office staff acknowledge it, and so does the owner — each kept with who, why and when.
  const key = `ack-${randomUUID()}`;
  const a = await call('POST', UNUSED_ACK, 'u-ho', ackBody, undefined, key);
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  expect((a.body as { acknowledged: Record<string, unknown> }).acknowledged).toMatchObject({ storeId: S1, prefix: P, numbers: [[105, 105]], count: 1, by: 'u-ho', reason: ackBody.reason, authority: 'all_stores' });
  // The same request re-sent answers the same acknowledgement (one record).
  const again = await call('POST', UNUSED_ACK, 'u-ho', ackBody, undefined, key);
  expect(again.status).toBe(201);
  expect(again.body).toEqual(a.body);
  expect((await call('POST', UNUSED_ACK, OWNER, { ...ackBody, reason: 'owner saw it with support' })).status).toBe(201);
  const kept = await h.store.readStream(T, streamName(STREAM.org, 'store-computer-unused-received-acknowledgements'));
  expect(kept.map((e) => [e.event.type, (e.event.payload as { by: string }).by])).toEqual([['BoxUnusedReceivedAcknowledged', 'u-ho'], ['BoxUnusedReceivedAcknowledged', OWNER]]);
  expect(await line()).toEqual([]);
  // The store computer repeats itself: still acknowledged (the same set).
  travel(150); await report(call, [[105, 105]]);
  expect(await line()).toEqual([]);
  // A NEW number: the line is back, naming both — the old acknowledgement does not cover it.
  travel(200); await report(call, [[105, 105], [107, 107]]);
  expect(await line()).toEqual([[2, [[105, 105], [107, 107]]]]);
  await no('u-ho', ackBody, 409, 'unused_received_set_changed');
  // NEW-5 (the verifier's race): the same COUNT with a set that differs — 105 and 106 — is refused; the set shown is kept.
  await no('u-ho', { ...ackBody, numbers: [[105, 106]], count: 2 }, 409, 'unused_received_set_changed');
  expect((await call('POST', UNUSED_ACK, 'u-ho', { ...ackBody, numbers: [[105, 105], [107, 107]], count: 2, reason: 'support checked 107 too' })).status).toBe(201);
  expect(await line()).toEqual([]);
}

describe('round 28 · OB-103 (memory)', () => {
  it('the "said unused, but head office has the bill" line is acknowledged by head office or the owner, and holds while the set is the same', async () => { await theSaidUnusedLineIsAcknowledged(apiHarness()); }, 180_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
const onPg = async (run: (h: ApiHarness) => Promise<void>): Promise<void> => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
  const sql = pgPoolClient(pool);
  try { await run(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) })); } finally { await pool.end(); }
};
describe.skipIf(DATABASE_URL === undefined)('round 28 · OB-103 (PostgreSQL)', () => {
  it('the "said unused, but head office has the bill" line is acknowledged by head office or the owner, and holds while the set is the same', async () => { await onPg(theSaidUnusedLineIsAcknowledged); }, 300_000);
});

describe.skipIf(DATABASE_URL === undefined)('round 28 · OB-103: refusals and the acknowledgement on the audit trail (served API, PostgreSQL)', () => {
  let cloud: RealCloud;
  let platform: Pool;
  const TENANT = randomUUID();
  const B = 'B1';
  const Q = 'B1L1-';
  beforeAll(async () => {
    platform = new Pool({ connectionString: DATABASE_URL, max: 2 });
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: TENANT, owner: OWNER, packSigningKey: ['r28', 'unused', 'key'].join('-').padEnd(48, '0') });
    await cloud.grant('u-ho', 'store_manager', undefined, 'all');
    await cloud.grant('u-mgr-b1', 'store_manager', undefined, [B]);
    await cloud.grant('u-box-b1', 'store_computer', undefined, [B]);
    const at = new Date().toISOString();
    const ledger = new SqlEventStore(pgPoolClient(platform));
    // The IT role, laid on the ledger by the operator (the owner may not hand out platform_admin's own permissions).
    await ledger.append(TENANT, STREAM.identity, makeEvent({
      id: `grant-it-${TENANT}`, type: 'RoleGranted', occurredAt: at, idempotencyKey: `grant-${TENANT}-platform_admin-u-it`, source: 'test/r28',
      payload: { userId: 'u-it', roleId: 'platform_admin', branchScope: 'all', request: { grantId: 'platform_admin-u-it', userId: 'u-it', roleId: 'platform_admin', branchScope: 'all', requestedBy: 'operator', approvedBy: 'operator', requestedAt: at } },
    }));
    expect((await cloud.request({ method: 'POST', path: `/v1/stores/${B}/tills/lane-1/receipt-prefix`, userId: OWNER, idempotencyKey: `pfx-${randomUUID()}`, body: { prefix: Q } })).status).toBe(201);
    // Head office holds a sale under B1L1-000105, made three hours ago (its receipt-number index, as a sale writes it).
    const made = new Date(Date.now() - 3 * 3_600_000).toISOString();
    await ledger.append(TENANT, STREAM.sales, makeEvent({
      id: `receipt-${Q}000105`, type: 'ReceiptNumberIssued', occurredAt: made, idempotencyKey: `receipt-${TENANT}-${Q}000105`, source: 'test/r28',
      payload: { receiptNumber: `${Q}000105`, saleId: `S-${Q}000105` },
    }));
    // The store computer now says it gave 105 and never used it.
    const r = await cloud.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: 'u-box-b1', idempotencyKey: `rep-${randomUUID()}`, body: {
      observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
      queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ prefix: Q, through: 105, soldThrough: 105, unsent: { count: 0 }, unused: [[105, 105]] }],
    } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }, 180_000);
  afterAll(async () => { await cloud?.stop(); await platform?.end(); });

  const onTheTrail = async (user: string, body: unknown, status: number, code: string | undefined, branchId?: string): Promise<void> => {
    const key = `r28-${randomUUID()}`;
    const r = await cloud.request({ method: 'POST', path: UNUSED_ACK, userId: user, idempotencyKey: key, body, ...(branchId === undefined ? {} : { branchId }) });
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    expect(codeOf(r)).toBe(code);
    const audit = await platform.query('SELECT status, permission FROM audit_log WHERE tenant_id = $1 AND user_id = $2 AND path = $3 AND idempotency_key = $4', [TENANT, user, UNUSED_ACK, key]);
    expect(audit.rows).toEqual([{ status, permission: 'platform.alert.manage' }]);
  };

  it('each refused acknowledgement is on the audit trail and nothing is kept; the owner\'s is kept, and on the trail too', async () => {
    const observed = await cloud.request({ method: 'GET', path: '/v1/platform/operational-health/observed', userId: OWNER });
    const line = ((observed.body as Observed).observed.boxes.find((b) => b.storeId === B)?.billNumberFindings ?? []).filter((f) => f.kind === 'unused_number_received');
    expect(line.map((f) => [f.prefix, f.ranges, f.count])).toEqual([[Q, [[105, 105]], 1]]);
    // Round 30 · OB-111: the real API seals the saved history with its key (from PACK_SIGNING_KEY) — never "no seal key".
    const components = (observed.body as { health: { components: { name: string; status: string }[] } }).health.components;
    expect(components.find((c) => c.name === 'box_history_seal')).toBeUndefined();
    const body = { storeId: B, prefix: Q, numbers: [[105, 105]], count: 1, reason: 'support checked the store computer' };
    await onTheTrail('u-mgr-b1', body, 403, 'acknowledgement_needs_all_stores_authority', B);
    await onTheTrail('u-it', body, 403, 'acknowledgement_refused_to_platform_administrator');
    await onTheTrail('u-ho', { ...body, numbers: [[104, 106]], count: 3 }, 409, 'unused_received_set_changed');
    await onTheTrail('u-ho', { ...body, numbers: [[106, 106]] }, 409, 'unused_received_set_changed');
    await onTheTrail('u-ho', { ...body, prefix: 'ZZ1-' }, 404, 'no_such_unused_received_finding');
    const none = await platform.query("SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1 AND type = 'BoxUnusedReceivedAcknowledged'", [TENANT]);
    expect(none.rows[0].n).toBe(0);
    await onTheTrail(OWNER, body, 201, undefined);
    const kept = await platform.query("SELECT payload->>'by' AS by, payload->>'reason' AS reason, payload->'numbers' AS numbers FROM event_ledger WHERE tenant_id = $1 AND type = 'BoxUnusedReceivedAcknowledged'", [TENANT]);
    expect(kept.rows).toEqual([{ by: OWNER, reason: body.reason, numbers: [[105, 105]] }]);
    const after = await cloud.request({ method: 'GET', path: '/v1/platform/operational-health/observed', userId: OWNER });
    expect(((after.body as Observed).observed.boxes.find((b) => b.storeId === B)?.billNumberFindings ?? []).filter((f) => f.kind === 'unused_number_received')).toEqual([]);
  }, 120_000);
});

// ── OB-104: the windowed reading is the full reading, at the store ───────────────────────────────────────────────────
/** Counts the box-health rows each read takes from the store, and whether it asked from a position. */
function counting(inner: EventStore): { store: EventStore; rows: () => number; positioned: () => number; reset: () => void } {
  let rows = 0; let positioned = 0;
  const store = new Proxy(inner, {
    get: (target, prop, receiver) => {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'readStream' || typeof v !== 'function') return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      return async (tenantId: string, stream: string, opts?: ReadOptions) => {
        const out = await (v as EventStore['readStream']).call(target, tenantId, stream, opts);
        if (stream === BOX_HEALTH_STREAM) { rows += out.length; if (opts?.sinceSeq !== undefined) positioned += 1; }
        return out;
      };
    },
  }) as EventStore;
  return { store, rows: () => rows, positioned: () => positioned, reset: () => { rows = 0; positioned = 0; } };
}

async function windowedIsFull(base: EventStore, snaps: () => SnapshotStore, seeds: readonly number[]): Promise<{ reads: number; resumed: number; asides: Record<string, number>; windowRows: number; fullRows: number }> {
  let reads = 0; let resumed = 0; let windowRows = 0; let fullRows = 0;
  const asides: Record<string, number> = {};
  for (const seed of seeds) {
    const T = randomUUID();
    await base.registerTenant(T, 'test/r28');
    const { store, rows, reset } = counting(base);
    const h = history(seed);
    const rnd = rng(seed * 31);
    // Head office issued A- to store S1 and B- to S1 (so S2's word about B- is judged away at read), as the prefix route does.
    await base.appendBatch(T, [['A-', S1], ['B-', S1]].map(([prefix, storeId]) => ({ stream: streamName(STREAM.org, 'till-receipt-prefixes'), event: makeEvent({
      id: `pfx-${prefix}`, type: 'TillReceiptPrefixIssued', occurredAt: iso(Date.parse('2026-02-01T00:00:00.000Z')), idempotencyKey: `pfx-${T}-${prefix}`, source: 'test/r28',
      payload: { storeId, tillId: `lane-${prefix}`, prefix, version: 1, setAt: '2026-02-01T00:00:00.000Z', setBy: OWNER },
    }) })));
    const windowed = snaps();
    const fullSnaps = new InMemorySnapshotStore();
    let banked = 0;
    let warnHours: number | undefined;
    let acksDone = 0; let atRiskDone = 0; let actsDone = 0;
    let i = 0;
    while (i < h.records.length) {
      const upTo = Math.min(h.records.length, i + 1 + Math.floor(rnd() * 8));
      for (; i < upTo; i += 1) {
        const { seq: _s, ...r } = h.records[i]!;
        void _s;
        await store.append(T, BOX_HEALTH_STREAM, makeEvent({ id: `bh-${T}-${i}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i}`, source: 'test/r28', payload: r }));
      }
      const lastMs = Math.max(...h.records.slice(0, i).map((r) => Date.parse(r.receivedAt)));
      const atMs = lastMs + Math.floor(rnd() * 3) * 20 * 60_000 + (rnd() < 0.2 ? UNRECEIVED_GRACE_MINUTES * 60_000 : 0);
      const at = iso(atMs);
      // What people did by now: acknowledgements and acts, appended as their routes would.
      for (; acksDone < h.refusalAcks.length && Date.parse(h.refusalAcks[acksDone]!.at) <= atMs; acksDone += 1) {
        await store.append(T, streamName(STREAM.org, 'store-computer-refusal-acknowledgements'), makeEvent({ id: `ra-${T}-${acksDone}`, type: 'BoxReportRefusalAcknowledged', occurredAt: h.refusalAcks[acksDone]!.at, idempotencyKey: `ra-${T}-${acksDone}`, source: 'test/r28', payload: h.refusalAcks[acksDone]! }));
      }
      for (; atRiskDone < h.atRiskAcks.length && Date.parse(h.atRiskAcks[atRiskDone]!.at) <= atMs; atRiskDone += 1) {
        await store.append(T, streamName(STREAM.org, 'store-computer-not-checked-acknowledgements'), makeEvent({ id: `na-${T}-${atRiskDone}`, type: 'BoxAtRiskNotCheckedAcknowledged', occurredAt: h.atRiskAcks[atRiskDone]!.at, idempotencyKey: `na-${T}-${atRiskDone}`, source: 'test/r28', payload: h.atRiskAcks[atRiskDone]! }));
      }
      for (; actsDone < h.acts.length && Date.parse(h.acts[actsDone]!.at) <= atMs; actsDone += 1) {
        await store.append(T, streamName(STREAM.org, 'store-computer-replacements'), makeEvent({ id: `sc-${T}-${actsDone}`, type: 'StoreComputerReplaced', occurredAt: h.acts[actsDone]!.at, idempotencyKey: `sc-${T}-${actsDone}`, source: 'test/r28', payload: h.acts[actsDone]! }));
      }
      // Head office banks more of A-'s bills now and then (the banked count only rises).
      if (rnd() < 0.3) {
        banked += 1 + Math.floor(rnd() * 4);
        await store.append(T, STREAM.sales, makeEvent({ id: `receipt-A-${pad(banked)}`, type: 'ReceiptNumberIssued', occurredAt: iso(lastMs), idempotencyKey: `receipt-${T}-A-${pad(banked)}`, source: 'test/r28', payload: { receiptNumber: `A-${pad(banked)}`, saleId: `S-A-${banked}` } }));
      }
      // A report that ARRIVES late, stamped well before the saved moment (set aside); a setting changed; the result deleted.
      if (rnd() < 0.06) {
        const { seq: _s, ...r } = h.records[Math.floor(rnd() * i)]!;
        void _s;
        const old = { ...r, receivedAt: iso(Date.parse(r.receivedAt) - 1), observedAt: iso(Date.parse(r.receivedAt) - 1) } as BoxHealthRecord;
        await store.append(T, BOX_HEALTH_STREAM, makeEvent({ id: `late-${T}-${i}`, type: 'StoreComputerHealthReported', occurredAt: old.receivedAt, idempotencyKey: `late-${T}-${i}`, source: 'test/r28', payload: old }));
      }
      if (rnd() < 0.04) warnHours = warnHours === undefined ? 1 : undefined;
      const opts = { timeZone: 'UTC', ...(warnHours === undefined ? {} : { unsentWarnHours: warnHours }) };
      // The full reading (every report — the code before this round).
      const records = await boxHealthAdapter({ store: base }).records(T);
      const replacements = await boxHealthAdapter({ store: base }).replacements(T);
      const full = await storeComputerReading(base, T, records, at, { ...opts, snapshots: fullSnaps });
      const fullBoxes = judgeBoxes({
        records, at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: full.findings, replacements, bindings: full.bindings, unusedNumbers: full.unused,
        ...(warnHours === undefined ? {} : { unsentWarnHours: warnHours }),
      });
      fullRows += records.length;
      // The windowed reading (the health read and the alert worker now).
      reset();
      const got = await storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, ...opts, snapshots: windowed });
      windowRows += rows();
      expect(got.reportsRead).toBe(rows());
      if (got.resumed) resumed += 1;
      if (got.setAside !== undefined) asides[got.setAside] = (asides[got.setAside] ?? 0) + 1;
      const ctx = `seed ${seed}, read ${reads} at ${at}`;
      expect(got.findings, ctx).toEqual(full.findings);
      expect(got.unused, ctx).toEqual(full.unused);
      expect(got.bindings, ctx).toEqual(full.bindings);
      const boxes = judgeBoxes({
        records: [], view: got.view, at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: got.findings, replacements, bindings: got.bindings, unusedNumbers: got.unused,
        ...(warnHours === undefined ? {} : { unsentWarnHours: warnHours }),
      });
      expect(boxes, ctx).toEqual(fullBoxes);
      reads += 1;
    }
  }
  return { reads, resumed, asides, windowRows, fullRows };
}

describe('round 28 · OB-104: the store-computer reading takes only the reports after its saved result (memory)', () => {
  it('seeded histories, read again and again: every answer is the full reading\'s; fewer rows are read', async () => {
    const out = await windowedIsFull(new InMemoryEventStore(), () => new InMemorySnapshotStore(), Array.from({ length: 40 }, (_, k) => 1_000 + k));
    console.log(`[OB-104 memory] ${out.reads} reads, ${out.resumed} resumed, set aside ${JSON.stringify(out.asides)}; box-health rows read ${out.windowRows} (the full reading read ${out.fullRows})`);
    expect(out.resumed).toBeGreaterThan(out.reads / 3);
    expect(out.asides['late_report'] ?? 0).toBeGreaterThan(0);
    expect(out.windowRows).toBeLessThan(out.fullRows); // short histories: the economy is shown at scale in tests/performance
  }, 300_000);

  it('a deleted saved result changes no answer: the next read rebuilds it from every report, once', async () => {
    const store = new InMemoryEventStore();
    const T = randomUUID();
    const h = history(77);
    for (const [i, { seq: _s, ...r }] of h.records.entries()) {
      void _s;
      await store.append(T, BOX_HEALTH_STREAM, makeEvent({ id: `bh-${i}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i}`, source: 'test/r28', payload: r }));
    }
    const at = iso(Math.max(...h.records.map((r) => Date.parse(r.receivedAt))) + 3_600_000);
    const snaps = new InMemorySnapshotStore();
    const first = await storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: snaps });
    const second = await storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: snaps });
    expect(first.reportsRead).toBe(h.records.length);
    expect(second.resumed).toBe(true);
    expect(second.reportsRead).toBe(0); // nothing after the saved result: nothing read
    const rebuilt = await storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: new InMemorySnapshotStore() });
    for (const r of [second, rebuilt]) { expect(r.findings).toEqual(first.findings); expect(r.unused).toEqual(first.unused); expect(r.bindings).toEqual(first.bindings); }
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 28 · OB-104: the store-computer reading takes only the reports after its saved result (PostgreSQL)', () => {
  it('seeded histories on the production store and projection_snapshot: every answer is the full reading\'s; the window is read from a position', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    try {
      const out = await windowedIsFull(new SqlEventStore(sql), () => new SqlSnapshotStore(sql), Array.from({ length: 12 }, (_, k) => 2_000 + k));
      console.log(`[OB-104 PostgreSQL] ${out.reads} reads, ${out.resumed} resumed, set aside ${JSON.stringify(out.asides)}; box-health rows read ${out.windowRows} (the full reading read ${out.fullRows})`);
      expect(out.resumed).toBeGreaterThan(out.reads / 3);
      expect(out.windowRows).toBeLessThan(out.fullRows); // short histories: the economy is shown at scale in tests/performance
      // The window is asked of PostgreSQL from a position (an index range scan), not filtered after a full read.
      const T = randomUUID();
      const base = new SqlEventStore(sql);
      await base.registerTenant(T, 'test/r28');
      const h = history(99);
      for (const [i, { seq: _s, ...r }] of h.records.entries()) {
        void _s;
        await base.append(T, BOX_HEALTH_STREAM, makeEvent({ id: `bh-${i}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${i}`, source: 'test/r28', payload: r }));
      }
      const at = iso(Math.max(...h.records.map((r) => Date.parse(r.receivedAt))) + 3_600_000);
      const snaps = new SqlSnapshotStore(sql);
      // The first read folds every report and saves the result — once the visibility fence has settled (on a busy database
      // cluster that can be a later pass: a transaction open anywhere holds it back; round 29 · OB-106: meanwhile the result is
      // kept in memory, and saved — as its JSON text — once a fence settles).
      const savedRow = () => pool.query("SELECT jsonb_array_length(((data->'result'->'state'->>'text')::jsonb)->'folded') AS above FROM projection_snapshot WHERE tenant_id = $1 AND projection = 'box-health-history@1'", [T]);
      // On a busy cluster the first save may stop low (a fence held by other files' writes); read again until it is saved
      // past most of the history — bounded, and asserted below.
      const savedFarEnough = async (): Promise<boolean> => {
        const r = await savedRow();
        return r.rows.length === 1 && Number((r.rows[0] as { above: string }).above) < h.records.length / 2;
      };
      for (let k = 0; k < 300 && !(await savedFarEnough()); k += 1) {
        await storeComputerHistory(base, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: snaps });
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
      const saved = await savedRow();
      expect(saved.rows).toHaveLength(1);
      const { store, rows, positioned } = counting(base);
      const next = await storeComputerHistory(store, T, at, { sealKey: TEST_BOX_HISTORY_KEY, snapshots: snaps });
      expect(next.resumed).toBe(true);
      // One read, asked from the saved position; it returns only the reports above it (none, or those the fence held back).
      expect([rows(), positioned()]).toEqual([Number(saved.rows[0].above), 1]);
      expect(rows()).toBeLessThan(h.records.length / 2);
    } finally { await pool.end(); }
  }, 600_000);
});
