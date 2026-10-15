import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { LANE_PREFIXES_PER_COMPUTER_MAX, DOOR_REFUSAL_EXAMPLES_MAX } from '../../services/platform/src/box-health';
import { apiHarness, TEST_PACK_KEY } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **Round 33 · owner decision OB-121 "A" (15 Oct 2026, in writing, "Only known tills, pre-pilot"; verifier r32 NEW-4, NEW-5,
 * probes zz-v32-flood F4/F5 and zz-v32-rflood-pg)** — through the real API (memory) and the served API (PostgreSQL):
 *
 *   • a store computer's own lane prefixes (`R-<lane>-`) are REGISTERED at install by a named person
 *     (POST /v1/store-computers/lane-prefixes, `platform.setup.write`, append-only, on the audit trail); refused by name when
 *     the sign-in is not a store computer of that store, a lane is too long for a GST bill number, or there would be more than
 *     LANE_PREFIXES_PER_COMPUTER_MAX;
 *   • an honest store computer with its lanes registered is unaffected: its counts are kept and believed;
 *   • any prefix head office neither issued to the store's tills nor registered for THAT computer is refused at the door:
 *     never stored (not in the report kept), named in the reply, and counted in one bounded line per computer per day — the
 *     verifier's flood (10 new invented till names in each of 150 reports) keeps NOTHING of them: the kept reports stay the size
 *     of an honest computer's, and at most a handful of small count marks are kept a day;
 *   • a flood kept BEFORE the rule (the verifier's PostgreSQL probe wrote 150 such reports straight to the ledger: 47 MB of
 *     saved history) no longer grows the saved history — it reads as small as with no flood at all;
 *   • the migration: a store computer that numbered its own `R-<lane>-` bills before the rule keeps working — on its first report
 *     after the upgrade head office registers, once, the lanes it reported in kept reports AND holds real bills under; an
 *     invented lane with no bill is not registered.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner-r33l';
const IT = 'u-it-r33l';
const BOX = 'u-box-r33l';
const BAD = 'u-bad-r33l';
const OLD = 'u-old-r33l';
const S1 = 'S1';
const S2 = 'S2';
const LANES = '/v1/store-computers/lane-prefixes';
const REPORT = '/v1/store-computers/health-reports';
const HEALTH_STREAM = streamName(STREAM.org, 'store-computer-health');
const DOOR_STREAM = streamName(STREAM.org, 'store-computer-prefixes-refused-at-door');
const DISK = { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 };
const FLOOD = 150;

type Send = (userId: string, method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: unknown; key: string }>;
const err = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const issued = (xs: readonly [string, number][]) => xs.map(([prefix, through]) => ({ prefix, through, soldThrough: through, unsent: { count: 0 } }));
const report = (xs: readonly [string, number][], i = 0) => ({ observedAt: new Date(Date.now() - 1_000 + i).toISOString(), disk: { ...DISK, salesLogUsedBytes: 1000 + i }, queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: issued(xs) });
const invented = (i: number) => Array.from({ length: 10 }, (_, k) => [`R-${(i * 10 + k).toString(36)}-`, 5_000] as [string, number]);
const bytesOf = (events: readonly { event: { payload: unknown } }[]): number => events.reduce((n, e) => n + JSON.stringify(e.event.payload).length, 0);

/** A sale banked under a receipt number (the sales stream's receipt index), as a till's synced sale lays it down. */
const bank = (store: EventStore, T: string, receiptNumber: string) => store.append(T, STREAM.sales, makeEvent({
  id: `receipt-${T}-${receiptNumber}`, type: 'ReceiptNumberIssued', occurredAt: new Date().toISOString(), idempotencyKey: `receipt-${T}-${receiptNumber}`, source: 'tests/r33l', payload: { receiptNumber, saleId: `sale-${receiptNumber}` },
}));
/** A report as head office KEPT it before the rule (round 32 believed any `R-…-`): written straight to the ledger. */
const keptBefore = (T: string, by: string, storeId: string, xs: readonly [string, number][], minutesAgo: number, i: number) => {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return { stream: HEALTH_STREAM, event: makeEvent({
    id: `r33l-legacy-${T}-${by}-${i}`, type: 'StoreComputerHealthReported', occurredAt: at, idempotencyKey: `r33l-legacy-${T}-${by}-${i}`, source: 'tests/r33l',
    payload: { storeId, observedAt: at, receivedAt: at, reportedBy: by, clockAheadCorrected: false, tills: [], disk: DISK, queue: { unsent: 0, deadLettered: 0 }, receiptNumbersIssued: issued(xs) },
  }) };
};

async function story(send: Send, store: EventStore, T: string): Promise<string[]> {
  const audited: string[] = [];
  // ── Registration at install, by a named person ──
  const reg = await send(IT, 'POST', LANES, { computer: BOX, storeId: S1, lanes: ['L1', 'L2'], reason: 'installed at the front lanes' });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  expect(reg.body).toMatchObject({ registered: { computer: BOX, storeId: S1, prefixes: ['R-L1-', 'R-L2-'], by: IT, via: 'install', reason: 'installed at the front lanes' }, nowRegistered: ['R-L1-', 'R-L2-'] });
  audited.push(reg.key);
  for (const [body, status, code] of [
    [{ computer: 'u-cash-r33l', storeId: S1, lanes: ['L3'] }, 409, 'not_a_store_computer_of_that_store'],
    [{ computer: BOX, storeId: S1, lanes: ['L123456789'] }, 400, 'lane_prefix_too_long'],
    [{ computer: BOX, storeId: S1, lanes: Array.from({ length: LANE_PREFIXES_PER_COMPUTER_MAX }, (_, k) => `X${k}`) }, 409, 'too_many_lane_prefixes'],
    [{ computer: BOX, storeId: S1, lanes: [] }, 400, 'not_readable_as_lane_prefixes'],
    [{ computer: BOX, storeId: S1, lanes: ['L 1'] }, 400, 'not_readable_as_lane_prefixes'],
  ] as const) {
    const r = await send(IT, 'POST', LANES, body);
    expect([r.status, err(r)], JSON.stringify(body).slice(0, 80)).toEqual([status, code]);
    audited.push(r.key);
  }
  // A cashier may not register anything (no platform.setup.write).
  expect((await send('u-cash-r33l', 'POST', LANES, { computer: BOX, storeId: S1, lanes: ['L3'] })).status).toBe(403);

  // ── An honest store computer, its lanes registered: unaffected ──
  const honest = await send(BOX, 'POST', REPORT, report([['R-L1-', 5], ['R-L2-', 3]]));
  expect(honest.status, JSON.stringify(honest.body)).toBe(200);
  expect((honest.body as { recorded: { receiptNumbersIssued: { prefix: string }[] } }).recorded.receiptNumbersIssued.map((x) => x.prefix)).toEqual(['R-L1-', 'R-L2-']);
  expect(honest.body).not.toHaveProperty('refusedAtTheDoor');
  // Its own registered lane with an unregistered one beside it: the registered one kept, the other refused at the door.
  const mixed = await send(BOX, 'POST', REPORT, report([['R-L1-', 6], ['R-L7-', 9]], 1));
  expect((mixed.body as { recorded: { receiptNumbersIssued: { prefix: string }[] } }).recorded.receiptNumbersIssued.map((x) => x.prefix)).toEqual(['R-L1-']);
  expect(mixed.body).toMatchObject({ refusedAtTheDoor: { prefixes: ['R-L7-'], count: 1 } });

  // ── The verifier's flood: 10 NEW invented till names in every report, from a computer with no lanes registered ──
  const keptBeforeFlood = bytesOf(await store.readStream(T, HEALTH_STREAM, { type: 'StoreComputerHealthReported' }));
  for (let i = 0; i < FLOOD; i += 1) {
    const r = await send(BAD, 'POST', REPORT, report(invented(i), i));
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const door = (r.body as { refusedAtTheDoor: { prefixes: string[]; count: number; why: string } }).refusedAtTheDoor;
    expect(door.count).toBe(10);
    expect(door.prefixes).toHaveLength(DOOR_REFUSAL_EXAMPLES_MAX);
    expect(door.why).toMatch(/never issued these bill-number prefixes to this store's tills and they are not registered for this store computer \(owner decision OB-121\)/);
  }
  const kept = (await store.readStream(T, HEALTH_STREAM, { type: 'StoreComputerHealthReported' })).filter((e) => (e.event.payload as { reportedBy: string }).reportedBy === BAD);
  expect(kept).toHaveLength(FLOOD);
  // Not one invented name is kept…
  expect(kept.flatMap((e) => (e.event.payload as { receiptNumbersIssued?: { prefix: string }[] }).receiptNumbersIssued ?? [])).toEqual([]);
  expect(JSON.stringify(kept.map((e) => e.event.payload))).not.toMatch(/"R-[0-9a-z]+-"/);
  const floodBytes = bytesOf(kept);
  // …so each kept report is the size of an honest one with no bill numbers (about 300 bytes), never the flood's.
  expect(floodBytes / FLOOD).toBeLessThan(600);
  // The count of refused reports: a few small marks a day (at 1, 2, 4 … reports), whatever the store computer sends.
  const marks = await store.readStream(T, DOOR_STREAM, { type: 'StoreComputerPrefixesRefusedAtDoor' });
  const badMarks = marks.filter((e) => (e.event.payload as { computer: string }).computer === BAD);
  expect(badMarks.length).toBeLessThanOrEqual(Math.ceil(Math.log2(FLOOD)) + 2);
  expect(bytesOf(badMarks)).toBeLessThan(4_096);
  console.log(`OB-121 door: ${FLOOD} flood reports kept in ${(floodBytes / 1024).toFixed(1)} KB (honest reports before: ${(keptBeforeFlood / 1024).toFixed(1)} KB); ${badMarks.length} count marks, ${bytesOf(badMarks)} bytes`);
  // One line per computer per day: on GET, and on the health page — said, never silent.
  const listed = (await send(OWNER, 'GET', LANES)).body as { computers: { computer: string; prefixes: string[] }[]; refusedAtTheDoor: { computer: string; count: number; examples: string[] }[] };
  expect(listed.computers.find((x) => x.computer === BOX)).toMatchObject({ storeId: S1, prefixes: ['R-L1-', 'R-L2-'] });
  // The flooding computer's one-time migration found nothing to register (no kept report, no bill) — marked done, empty.
  expect(listed.computers.find((x) => x.computer === BAD)).toMatchObject({ storeId: S1, prefixes: [] });
  const line = listed.refusedAtTheDoor.find((l) => l.computer === BAD)!;
  expect(line.count).toBe(FLOOD);
  expect(line.examples.length).toBeLessThanOrEqual(DOOR_REFUSAL_EXAMPLES_MAX);
  expect(listed.refusedAtTheDoor.find((l) => l.computer === BOX)).toMatchObject({ count: 1, examples: ['R-L7-'] });
  const health = (await send(OWNER, 'GET', '/v1/platform/operational-health/observed')).body as { health: { components: { name: string; status: string; detail: string }[] } };
  const c = health.health.components.find((x) => x.name === `box_prefixes_refused:${S1}`);
  expect(c?.status).toBe('degraded');
  expect(c?.detail).toMatch(new RegExp(`computer ${BAD} sent ${FLOOD} report\\(s\\) on .* refused at the door and not kept \\(owner decision OB-121\\)`));

  // ── The migration: a computer that numbered its own R-<lane>- bills before the rule keeps working ──
  await bank(store, T, 'R-M1-000003');
  await store.appendBatch(T, [keptBefore(T, OLD, S2, [['R-M1-', 4], ['R-zz9-', 5]], 90, 0)]);
  const first = await send(OLD, 'POST', REPORT, report([['R-M1-', 5], ['R-zz9-', 6]]));
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect((first.body as { recorded: { receiptNumbersIssued: { prefix: string }[] } }).recorded.receiptNumbersIssued.map((x) => x.prefix)).toEqual(['R-M1-']);
  expect(first.body).toMatchObject({ refusedAtTheDoor: { prefixes: ['R-zz9-'] } });
  await send(OLD, 'POST', REPORT, report([['R-M1-', 6]], 1));
  const after = (await send(OWNER, 'GET', LANES)).body as { computers: { computer: string; prefixes: string[]; registrations: { by: string; via: string }[] }[] };
  expect(after.computers.find((x) => x.computer === OLD)).toMatchObject({ storeId: S2, prefixes: ['R-M1-'], registrations: [expect.objectContaining({ by: 'head-office', via: 'seen_before_registration' })] });
  // The flooding computer's own one-time migration found nothing to register (no kept report, no bill): still nothing.
  expect(after.computers.find((x) => x.computer === BAD)).toMatchObject({ prefixes: [] });
  return audited;
}

/** The verifier's PostgreSQL probe, as a test: a flood KEPT BEFORE the rule no longer grows the saved history. */
async function floodKeptBefore(send: Send, store: EventStore, T: string): Promise<number> {
  for (let i = 0; i < FLOOD; i += 50) {
    await store.appendBatch(T, Array.from({ length: 50 }, (_, j) => keptBefore(T, `${BAD}-legacy`, S1, [['R-L1-', 5], ...invented(i + j)], 180 - (i + j) / 4, i + j)));
  }
  let size: number | undefined;
  for (let k = 0; k < 240 && size === undefined; k += 1) {
    const h = (await send(OWNER, 'GET', '/v1/platform/operational-health/observed')).body as { health: { components: { name: string; status: string; evidence?: { sizeBytes?: number | null } }[] } };
    const c = h.health.components.find((x) => x.name === 'box_history');
    if (c !== undefined && c.status !== 'unknown' && typeof c.evidence?.sizeBytes === 'number') size = c.evidence.sizeBytes;
    else await new Promise((res) => { setTimeout(res, 250); });
  }
  expect(size, 'the saved history was never shown').toBeDefined();
  console.log(`OB-121 kept-before flood: ${FLOOD} reports of 10 invented till names each, saved history ${(size! / 1024).toFixed(1)} KB (round 32 on PostgreSQL: 47 MB)`);
  expect(size!).toBeLessThan(64 * 1024);
  return size!;
}

describe('round 33 · OB-121: head office believes only the till names it issued or registered (memory, the real pipeline)', () => {
  it('registered at install; an honest computer unaffected; a flood refused at the door, never kept, counted in one line; the migration', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.provisionOwner(T, OWNER);
    await h.provisionRole(T, IT, 'platform_admin', 'all');
    await h.provisionRole(T, 'u-cash-r33l', 'cashier', [S1]);
    for (const [u, s] of [[BOX, S1], [BAD, S1], [OLD, S2]] as const) await h.provisionRole(T, u, 'store_computer', [s]);
    const send: Send = async (userId, method, path, body) => {
      const key = `k-${randomUUID()}`;
      const r = await h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key }) });
      return { status: r.status, body: r.body, key };
    };
    await story(send, h.store, T);
    await floodKeptBefore(send, h.store, T);
  }, 300_000);
});

describe.skipIf(DATABASE_URL === undefined)('round 33 · OB-121: the same on the served API (PostgreSQL, audit_log read back)', () => {
  const clouds: RealCloud[] = [];
  afterAll(async () => { for (const c of clouds) await c.stop(); });

  it('the same story; each registration and refusal is on the audit trail; the verifier\'s flood keeps the saved history small', async () => {
    const tenantId = randomUUID();
    const cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: OWNER, packSigningKey: TEST_PACK_KEY, providers: { opsAlertWorkerIntervalMs: 3_600_000 } });
    clouds.push(cloud);
    const platform = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    try {
      const store = new SqlEventStore(pgPoolClient(platform));
      await store.append(tenantId, STREAM.identity, makeEvent({
        id: `grant-it-${tenantId}`, type: 'RoleGranted', occurredAt: new Date().toISOString(), idempotencyKey: `grant-${tenantId}-platform_admin-${IT}`, source: 'test/r33l',
        payload: { userId: IT, roleId: 'platform_admin', branchScope: 'all', request: { grantId: `platform_admin-${IT}`, userId: IT, roleId: 'platform_admin', branchScope: 'all', requestedBy: 'operator', approvedBy: 'operator', requestedAt: new Date().toISOString() } },
      }));
      await cloud.grant('u-cash-r33l', 'cashier', undefined, [S1]);
      for (const [u, s] of [[BOX, S1], [BAD, S1], [OLD, S2]] as const) await cloud.grant(u, 'store_computer', undefined, [s]);
      const send: Send = async (userId, method, path, body) => {
        const key = `k-${randomUUID()}`;
        const r = await cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key }) });
        return { status: r.status, body: r.body, key };
      };
      const audited = await story(send, store, tenantId);
      const audit = await platform.query<{ status: number; idempotency_key: string; user_id: string }>(
        'SELECT status, idempotency_key, user_id FROM audit_log WHERE tenant_id = $1 AND path = $2 AND idempotency_key = ANY($3::text[])', [tenantId, LANES, audited]);
      const byKey = new Map(audit.rows.map((r) => [r.idempotency_key, r]));
      expect(byKey.get(audited[0]!)).toMatchObject({ status: 201, user_id: IT });
      for (const key of audited.slice(1)) expect(byKey.get(key)?.status, key).toBeGreaterThanOrEqual(400);
      // The kept reports' size on the database itself.
      const sizes = await platform.query<{ n: string; bytes: string }>(
        "SELECT count(*) AS n, coalesce(sum(length(payload::text)), 0) AS bytes FROM event_ledger WHERE tenant_id = $1 AND type = 'StoreComputerHealthReported' AND payload->>'reportedBy' = $2", [tenantId, BAD]);
      expect(Number(sizes.rows[0]!.n)).toBe(FLOOD);
      expect(Number(sizes.rows[0]!.bytes) / FLOOD).toBeLessThan(600);
      await floodKeptBefore(send, store, tenantId);
    } finally { await platform.end(); }
  }, 600_000);
});
