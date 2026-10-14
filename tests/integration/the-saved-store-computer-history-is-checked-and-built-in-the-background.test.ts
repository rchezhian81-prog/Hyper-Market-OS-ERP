import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { takeHeldTransactionTurn } from '../support/held-transaction-turn';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore, type ReadOptions } from '../../packages/persistence/src/event-store';
import { SqlSnapshotStore, InMemorySnapshotStore, type SnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  STREAM, streamName, storeComputerReading, storeComputerHistory, boxHealthAdapter, observedHealthAdapter, boxHistoryBuilding, BOX_HISTORY_INLINE_MAX,
} from '../../services/api/src/adapters';
import { judgeObserved } from '../../services/platform/src/observed-health';
import { startOpsAlertWorker } from '../../services/platform/src/ops-alert-worker';
import {
  judgeBoxes, sealBoxHistory, boxHealthRoutes, boxHistoryToStore, boxHistoryFromStore, BoxHistoryPreparing, PREFIX_BINDINGS_PATH,
  type BoxHealthRecord, type BoxHistorySnapshot,
} from '../../services/platform/src/box-health';
import { DEFAULT_THRESHOLDS } from '../../packages/ops/src/index';
import { history, honestStore, iso } from '../support/box-history';

/**
 * **Round 29 · owner decision OB-106 "A" (14 Oct 2026, in writing, "Both before pilot"; verifier r28 NEW-2, NEW-7, NEW-8) — the
 * store computers' saved history is checked before it is used and built in the background; on memory and on PostgreSQL.**
 *
 *   • a DAMAGED saved result (every shape of the verifier's probe C1, written straight into the snapshot store / the
 *     `projection_snapshot` row) is set aside and rebuilt — the read never throws, and answers as the full reading does;
 *   • an ALTERED one that was even re-sealed (a binding moved to "u-evil") is set aside because that binding cannot be traced
 *     to a report from that store computer — its binding is never used;
 *   • a store with more than BOX_HISTORY_INLINE_MAX reports and nothing saved is built in the BACKGROUND, once (two reads at
 *     once start ONE build — counted at the store); meanwhile the reading says "being prepared", the health read says so
 *     (`box_history: unknown`, and `notObserved`), the routes answer 503 in words, and the alert worker skips with a note and
 *     clears none of the store computers' alerts; then it answers as the full reading does;
 *   • NEW-7 (the verifier's held-transaction probe, zz-v28-pg): a report written in a transaction held open while later
 *     reports commit and reads run — nothing saved below it; it is read when it commits; every answer equals the full
 *     reading, its full disk and refused count included; saving held back is said while the transaction is open.
 */

const BOX = streamName(STREAM.org, 'store-computer-health');
const DATABASE_URL = process.env['DATABASE_URL'];

interface Ctx { readonly store: EventStore; readonly snapshots: SnapshotStore; readonly T: string; readonly pool?: Pool }
async function onMemory(run: (c: Ctx) => Promise<void>): Promise<void> {
  await run({ store: new InMemoryEventStore(), snapshots: new InMemorySnapshotStore(), T: randomUUID() });
}
async function onPg(run: (c: Ctx) => Promise<void>): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
  const sql = pgPoolClient(pool);
  const store = new SqlEventStore(sql);
  const T = randomUUID();
  await store.registerTenant(T, 'r29');
  try { await run({ store, snapshots: new SqlSnapshotStore(sql), T, pool }); } finally { await pool.end(); }
}

async function put(store: EventStore, T: string, records: readonly BoxHealthRecord[], from = 0): Promise<void> {
  for (let i = 0; i < records.length; i += 500) {
    await store.appendBatch(T, records.slice(i, i + 500).map((r, j) => ({
      stream: BOX,
      event: makeEvent({ id: `bh-${from + i + j}`, type: 'StoreComputerHealthReported', occurredAt: r.receivedAt, idempotencyKey: `bh-${T}-${from + i + j}`, source: 'test/r29', payload: r }),
    })));
  }
}
const plain = (r: BoxHealthRecord & { seq?: number }): BoxHealthRecord => { const { seq: _s, ...rest } = r; void _s; return rest as BoxHealthRecord; };

/** The full reading over every report kept (the code before the saved result), and the store's health judged from it. */
async function fullOf(store: EventStore, T: string, at: string) {
  const records = await boxHealthAdapter({ store }).records(T);
  const full = await storeComputerReading(store, T, records, at, { timeZone: 'UTC', snapshots: new InMemorySnapshotStore() });
  return { full, boxes: judgeBoxes({ records, at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: full.findings, bindings: full.bindings, unusedNumbers: full.unused }) };
}
async function sameAsFull(store: EventStore, T: string, at: string, got: Awaited<ReturnType<typeof storeComputerHistory>>): Promise<void> {
  const { full, boxes } = await fullOf(store, T, at);
  expect(got.preparing).toBeUndefined();
  expect(got.findings).toEqual(full.findings);
  expect(got.unused).toEqual(full.unused);
  expect(got.bindings).toEqual(full.bindings);
  expect(judgeBoxes({ records: [], view: got.view, at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: got.findings, bindings: got.bindings, unusedNumbers: got.unused })).toEqual(boxes);
}

/** A shop with a seeded history (a few hundred reports, two stores, three store computers), read once so a result is saved. */
async function seeded(c: Ctx): Promise<{ at: string; saved: BoxHistorySnapshot }> {
  const t0 = Date.parse('2026-03-01T00:00:00.000Z');
  let all: BoxHealthRecord[] = [];
  for (const seed of [4242, 4243, 4244]) all = all.concat(history(seed).records.map(plain));
  all = all.map((r, i) => ({ ...r, receivedAt: iso(t0 + i * 15_000), observedAt: iso(t0 + i * 15_000) }));
  await put(c.store, c.T, all);
  const at = iso(t0 + all.length * 15_000 + 30 * 60_000);
  const first = await storeComputerHistory(c.store, c.T, at, { snapshots: c.snapshots, timeZone: 'UTC' });
  expect(first.preparing).toBeUndefined();
  const stored = (await c.snapshots.load<unknown>(c.T, BOX, 'box-health-history@1'))?.result.state;
  expect(stored).toMatchObject({ format: 'box-history-text@1' }); // kept as its JSON text, so jsonb never reorders what is sealed
  return { at, saved: boxHistoryFromStore(stored) as BoxHistorySnapshot };
}
/** Write a saved result's state straight into the store (as damage or an attacker with database access would). */
async function overwrite(c: Ctx, state: unknown): Promise<void> {
  const cur = (await c.snapshots.load<unknown>(c.T, BOX, 'box-health-history@1'))!;
  if (c.pool === undefined) { await c.snapshots.save({ ...cur, result: { ...cur.result, state } }); return; }
  await c.pool.query("UPDATE projection_snapshot SET data = jsonb_set(data, '{result,state}', $4::jsonb) WHERE tenant_id = $1 AND stream = $2 AND projection = $3", [c.T, BOX, 'box-health-history@1', JSON.stringify(state)]);
}

async function damagedIsSetAside(c: Ctx): Promise<void> {
  const { at, saved } = await seeded(c);
  // Damage as the text kept (every shape of probe C1, even RE-SEALED so only the shape check stands), and a row that is
  // not the saved form at all (a JSON tree, an empty object).
  const { check: _c0, sizeBytes: _s0, ...plainSaved } = saved;
  void _c0; void _s0;
  const resealed = (x: object): unknown => boxHistoryToStore(sealBoxHistory(x as never));
  const shapes: [string, unknown][] = [
    ['never missing', boxHistoryToStore({ ...saved, never: undefined } as never)],
    ['stores garbage', resealed({ ...plainSaved, stores: [['S1', null, 'x', 'y', 'z']] })],
    ['keys garbage', resealed({ ...plainSaved, never: { ...saved.never, keys: [{}] } })],
    ['text not JSON', { format: 'box-history-text@1', text: '{"version":2,' }],
    ['a JSON tree, not the saved form', saved],
    ['empty object', {}],
  ];
  for (const [name, state] of shapes) {
    await overwrite(c, state);
    const got = await storeComputerHistory(c.store, c.T, at, { snapshots: c.snapshots, timeZone: 'UTC' });
    expect(got.setAside, name).toMatch(/^unreadable: /);
    await sameAsFull(c.store, c.T, at, got);
  }
  // Altered AND re-sealed: the bindings moved to "u-evil" — the seal matches, but no report from u-evil names those prefixes.
  const fresh = boxHistoryFromStore((await c.snapshots.load<unknown>(c.T, BOX, 'box-health-history@1'))!.result.state) as BoxHistorySnapshot;
  const { check: _c, sizeBytes: _s, ...rest } = fresh;
  void _c; void _s;
  const evil = sealBoxHistory({ ...rest, rawBound: rest.rawBound.map((b) => ({ ...b, computer: 'u-evil' })), never: { ...rest.never, bound: rest.never.bound.map((b) => ({ ...b, computer: 'u-evil' })) } });
  await overwrite(c, boxHistoryToStore(evil));
  const got = await storeComputerHistory(c.store, c.T, at, { snapshots: c.snapshots, timeZone: 'UTC' });
  expect(got.setAside).toMatch(/^unreadable: its binding of .+ to u-evil names no report from that store computer/);
  expect(got.bindings.some((b) => b.computer === 'u-evil')).toBe(false);
  await sameAsFull(c.store, c.T, at, got);
  // And a result the next read made is used again (resumed, nothing set aside).
  const next = await storeComputerHistory(c.store, c.T, iso(Date.parse(at) + 60_000), { snapshots: c.snapshots, timeZone: 'UTC' });
  expect(next.setAside).toBeUndefined();
  expect(next.resumed).toBe(true);
}

function countingFullReads(inner: EventStore): { store: EventStore; full: () => number } {
  let full = 0;
  const store = new Proxy(inner, {
    get: (target, prop, receiver) => {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      if (prop !== 'readStream') return (v as (...a: unknown[]) => unknown).bind(target);
      return async (tenantId: string, stream: string, opts?: ReadOptions) => {
        if (stream === BOX && opts?.sinceSeq === undefined && opts?.from === undefined) full += 1;
        return (v as EventStore['readStream']).call(target, tenantId, stream, opts);
      };
    },
  }) as EventStore;
  return { store, full: () => full };
}

async function builtInTheBackground(c: Ctx): Promise<void> {
  const records = honestStore((BOX_HISTORY_INLINE_MAX + 760) / 5_760).map(plain);
  expect(records.length).toBeGreaterThan(BOX_HISTORY_INLINE_MAX);
  await put(c.store, c.T, records);
  const at = iso(Date.parse(records[records.length - 1]!.receivedAt) + 60_000);
  const { store, full } = countingFullReads(c.store);
  // Two reads at once: ONE build (one full read of the reports), both say "being prepared", since the same moment.
  // The routes that need it answer 503 in words while it builds (never a guess, nothing recorded) — asked at the same time.
  // The build is held open (between its steps) until the test lets it go, so "meanwhile" is certain, never a race.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const [a, b, route] = await Promise.all([
    storeComputerHistory(store, c.T, at, { snapshots: c.snapshots, timeZone: 'UTC', waitMs: 0, buildPause: () => gate }),
    storeComputerHistory(store, c.T, at, { snapshots: c.snapshots, timeZone: 'UTC', waitMs: 0 }),
    boxHealthAdapter({ store, snapshots: c.snapshots, settings: { timeZone: () => 'UTC' }, waitMs: 0 }).bindingsAt(c.T, at).then(() => 'answered', (e: unknown) => e),
  ]);
  expect(a.preparing?.why).toMatch(/nothing is saved yet/);
  expect(b.preparing).toEqual(a.preparing);
  expect([...a.findings.keys(), ...a.unused.keys(), ...a.bindings]).toEqual([]);
  expect(route).toBeInstanceOf(BoxHistoryPreparing);
  // Still being prepared while it is held; then it is let go.
  expect((await storeComputerHistory(store, c.T, at, { snapshots: c.snapshots, timeZone: 'UTC', waitMs: 20 })).preparing).toEqual(a.preparing);
  release();
  await boxHistoryBuilding(c.snapshots, c.T);
  expect(full()).toBe(1);
  const ready = await storeComputerHistory(store, c.T, at, { snapshots: c.snapshots, timeZone: 'UTC', waitMs: 0 });
  expect(ready.preparing).toBeUndefined();
  expect(ready.resumed).toBe(true);
  expect(full()).toBe(1);
  expect(ready.history.sizeBytes).toBeGreaterThan(0);
  await sameAsFull(c.store, c.T, at, ready);
}

describe('round 29 · OB-106 (memory)', () => {
  it('a damaged saved result — every shape, and one altered and re-sealed — is set aside and rebuilt; never thrown; the answers are the full reading\'s', async () => { await onMemory(damagedIsSetAside); }, 300_000);
  it('a big store with nothing saved is built in the background once; meanwhile "being prepared"; then the full reading\'s answers', async () => { await onMemory(builtInTheBackground); }, 300_000);

  it('the health read says "being prepared" (box_history unknown, not observed); the alert worker skips with a note and clears no store-computer alert', async () => {
    const store = new InMemoryEventStore();
    const snapshots = new InMemorySnapshotStore();
    const T = randomUUID();
    const records = honestStore((BOX_HISTORY_INLINE_MAX + 760) / 5_760).map(plain);
    await put(store, T, records);
    const now = (): string => iso(Date.parse(records[records.length - 1]!.receivedAt) + 60_000);
    const deps = observedHealthAdapter({ store, now, snapshots, storeTimeZone: async () => 'UTC', boxHistoryWaitMs: 0 });
    // An alert rule on the store's disk, and that alert open (raised earlier, before an upgrade).
    await deps.defineAlertRules(T, { version: 1, rules: [{ alertId: 'disk-s1', component: 'box_disk:S1', firesAt: 'degraded', ownerUserId: 'u-owner', ownerName: 'Owner', ackWithinMinutes: 30 }], thresholds: DEFAULT_THRESHOLDS, backupMaxAgeSeconds: 86_400, definedBy: 'u-owner', definedAt: now() });
    await deps.recordAlertEvent(T, { alertId: 'disk-s1', change: 'raised', by: 'u-owner', at: now(), alert: { alertId: 'disk-s1', component: 'box_disk:S1', status: 'down', detail: 'full', ownerUserId: 'u-owner', ownerName: 'Owner', ackDueBy: now() } as never }, 'raise-disk-s1');
    const judged = await judgeObserved(deps, T, now());
    expect(judged.observed.storeComputersPreparing?.why).toMatch(/nothing is saved yet/);
    const comp = judged.health.components.find((c) => c.name === 'box_history');
    expect(comp).toMatchObject({ status: 'unknown' });
    expect(comp!.detail).toMatch(/^being prepared — store computer checks not yet available/);
    expect(judged.observed.notObserved.join(' ')).toMatch(/being prepared/);
    expect(judged.observed.boxes).toEqual([]);
    const said: string[] = [];
    const worker = startOpsAlertWorker({ tenants: async () => [T], deps, intervalMs: 3_600_000, now, say: (l) => said.push(l) });
    try {
      const pass = await worker.runOnce();
      expect(pass.failed).toEqual([]);
      expect(pass.skipped.map((s) => s.tenantId)).toEqual([T]);
      expect(pass.cleared).toBe(0);
      expect(said.join('\n')).toMatch(/store computer checks are being prepared .* this pass skipped them and kept their open alerts as they were/);
      expect((await deps.alerts(T)).find((x) => x.alert.alertId === 'disk-s1')?.state).not.toBe('cleared');
    } finally { await worker.stop(); }
    await boxHistoryBuilding(snapshots, T);
    const after = await judgeObserved(deps, T, now());
    expect(after.observed.storeComputersPreparing).toBeNull();
    expect(after.health.components.find((c) => c.name === 'box_history')).toMatchObject({ status: 'ok' });
    expect(after.observed.boxes.map((b) => b.storeId)).toEqual(['S1']);
  }, 300_000);

  it('the routes answer 503 in words while it is being prepared', async () => {
    const routes = boxHealthRoutes({ now: () => '2026-03-01T00:00:00.000Z', record: async () => undefined, bindingsAt: async () => { throw new BoxHistoryPreparing('2026-03-01T00:00:00.000Z', 'nothing is saved yet'); } });
    const r = routes.find((x) => x.path === PREFIX_BINDINGS_PATH && x.method === 'GET')!;
    await expect(r.handler({ tenantId: 't', userId: 'u', branchScope: 'all' } as never)).rejects.toMatchObject({ status: 503, retryAfterSeconds: 60, body: { code: 'store_computer_checks_being_prepared' } });
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 29 · OB-106 (PostgreSQL)', () => {
  // These tests hold a database transaction open on purpose; they take turns with every other such test (see the helper).
  let endTurn: (() => Promise<void>) | undefined;
  beforeAll(async () => { endTurn = await takeHeldTransactionTurn(DATABASE_URL!); }, 1_800_000);
  afterAll(async () => { await endTurn?.(); });
  it('a damaged saved result — every shape (the projection_snapshot row written over), and one altered and re-sealed — is set aside and rebuilt; the answers are the full reading\'s', async () => { await onPg(damagedIsSetAside); }, 600_000);
  it('a big store with nothing saved is built in the background once; meanwhile "being prepared"; then the full reading\'s answers', async () => { await onPg(builtInTheBackground); }, 600_000);

  it('NEW-7 (the verifier\'s held-transaction probe): a report written in a transaction held open while later reports commit and reads run is read when it commits — its full disk and refused count are never lost', async () => {
    await onPg(async ({ store, snapshots, T, pool }) => {
      let all: BoxHealthRecord[] = [];
      for (const seed of [4242, 4243, 4244]) all = all.concat(history(seed).records.map(plain));
      const t0 = Date.parse('2026-03-01T00:00:00.000Z');
      all = all.map((r, i) => ({ ...r, receivedAt: iso(t0 + i * 15_000), observedAt: iso(t0 + i * 15_000) }));
      const half = Math.floor(all.length / 2);
      await put(store, T, all.slice(0, half));
      const held = await pool!.connect();
      const outcomes: string[] = [];
      try {
        await held.query('BEGIN');
        await held.query("SELECT set_config('app.tenant_id', $1, true)", [T]);
        // Stamped (by head office) at the half-way moment; the box's own time is the newest of all (so it is THE latest
        // report), its disk full, and it carries a refused count — any read that misses it answers differently.
        const late = {
          ...all[half - 1]!, storeId: 'S1', reportedBy: 'u-box', observedAt: iso(t0 + all.length * 15_000), receivedAt: all[half - 1]!.receivedAt,
          disk: { freeBytes: 0, totalBytes: 1e10, salesLogUsedBytes: 1e9, salesLogCapacityBytes: 1e9, reserveBytes: 1e6 },
          receiptNumbersRefused: [{ prefix: 'C-', through: 77_777, because: 'beyond_plausible_advance', bankedThrough: 0, plausibleThrough: 10_000 }],
        };
        await held.query(`INSERT INTO event_ledger (id, tenant_id, stream, type, occurred_at, idempotency_key, source, version, payload)
          SELECT $1::text, $2::uuid, $3::text, $4::text, $5::timestamptz, $6::text, $7::text, 1, $8::jsonb WHERE pg_current_xact_id() IS NOT NULL`,
        ['bh-late', T, BOX, 'StoreComputerHealthReported', late.receivedAt, `bh-${T}-late`, 'r29', JSON.stringify(late)]);
        await put(store, T, all.slice(half), half);
        const lastMs = t0 + (all.length - 1) * 15_000;
        for (let k = 0; k < 4; k += 1) {
          const r = await storeComputerHistory(store, T, iso(lastMs + (20 + k) * 60_000), { snapshots, timeZone: 'UTC' });
          outcomes.push(`open#${k}: resumed=${String(r.resumed)} aside=${r.setAside ?? '-'} read=${r.reportsRead}`);
          // Nothing may be SAVED below the open write; saving held back is said (shown on the health read past 5 minutes).
          expect(r.history.saveHeld).not.toBeNull();
          const row = await pool!.query("SELECT data->'result'->'state'->>'seq' AS seq FROM projection_snapshot WHERE tenant_id = $1 AND projection = 'box-health-history@1'", [T]);
          for (const x of row.rows as { seq: string }[]) expect(Number(x.seq)).toBeLessThan(half);
        }
        await held.query('COMMIT');
      } finally { held.release(); }
      for (let k = 0; k < 3; k += 1) {
        const at = iso(t0 + (all.length - 1) * 15_000 + (40 + k * 15) * 60_000);
        const got = await storeComputerHistory(store, T, at, { snapshots, timeZone: 'UTC' });
        outcomes.push(`after#${k}: resumed=${String(got.resumed)} aside=${got.setAside ?? '-'} read=${got.reportsRead}`);
        await sameAsFull(store, T, at, got);
        const records = await boxHealthAdapter({ store }).records(T);
        const boxes = judgeBoxes({ records: [], view: got.view, at, thresholds: DEFAULT_THRESHOLDS, billNumberFindings: got.findings, bindings: got.bindings, unusedNumbers: got.unused });
        // The late report is read: its full disk is the store's latest, and its refused count is a finding.
        expect(records.some((r) => r.receiptNumbersRefused?.some((x) => x.through === 77_777))).toBe(true);
        const s1 = boxes.boxes.find((x) => x.storeId === 'S1')!;
        expect([s1.disk?.freeBytes, s1.canRecordSales]).toEqual([0, false]); // its full disk is the store's latest word (stale by now: old news, said so)
        expect(JSON.stringify(got.findings.get('S1') ?? [])).toMatch(/077777|77777/);
        expect(got.history.saveHeld).toBeNull();
      }
      console.log(`[r29 NEW-7] ${outcomes.join(' | ')}`);
    });
  }, 600_000);
});
