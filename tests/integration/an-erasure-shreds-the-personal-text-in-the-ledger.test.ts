import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import {
  InMemorySubjectKeyStore, SqlSubjectKeyStore, ERASED_TEXT, isSealed, type SubjectKeyStore,
} from '../../packages/persistence/src/personal-data';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/earn-rule';
import { personalDataStore, serviceCaseAdapter, fulfilmentAdapter, notificationQueueAdapter, STREAM, streamName } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { recordingTransport } from '../../packages/notifications/src/index';
// @ts-expect-error — a plain ES module script with no type declarations; exercised exactly as the CLI runs it.
import { takeBackup } from '../../scripts/lib/backup-snapshot.mjs';

/**
 * **An erasure makes the customer's own words unreadable IN THE LEDGER — crypto-shredding (audit FUL-12 · M16-FR-03 ·
 * M20-FR-04 · ADR-0025).**
 *
 * The verifier found that erasure and minimisation only APPENDED redaction events: the original events in the append-only
 * `event_ledger` still held the complaint text. The ledger may not be edited (hard rule #2) and evidence is never deleted
 * (#6), so the personal fields are now written ENCRYPTED under a per-customer, per-category data key held outside the
 * ledger, and an erasure DESTROYS the key. Proven here on real PostgreSQL by reading `event_ledger` directly:
 *
 *   • AT REST — before any erasure the complaint, the delivery note, the message words, the member's last four digits,
 *     the consent evidence and the loss-prevention summary are nowhere in the raw rows; every domain reads them in full.
 *   • ERASED — after the two-person erasure the raw rows are byte-for-byte the rows that were there (nothing edited,
 *     nothing deleted), the keys of the erased/minimised categories are destroyed and on the shredded-key list, the
 *     ciphertext no longer opens, and every domain reads the placeholder.
 *   • THE BUSINESS RECORD STAYS — the cash taken at the door, the order, the case's dates, the message's send record and
 *     the loss-prevention value read exactly as before.
 *   • RETAINED — the consent proof and the loss-prevention case keep their keys (the law keeps them) and still read.
 *   • PREVENT-RESTORE — new personal text for the erased customer is not kept (written as the placeholder).
 *   • BACKUP — a backup taken BEFORE the erasure holds the key; restored with the production tool and the newest
 *     shredded-key list, the key is destroyed again and the text stays unreadable. Without the list it WOULD come back —
 *     which is why the list wins at run time too: a listed key a restore brought back is destroyed on sight.
 *
 * Limit (ADR-0025): events written before the sealing layer existed hold their personal text in plain; they are not
 * re-written (append-only) — see the ADR. Synthetic data only (hard rule #7).
 */

const OWNER = 'u-owner'; const CHECKER = 'u-checker'; const DRIVER = 'u-driver';
const MOBILE = '9876543210';
// The customer IS a loyalty member: their customer ref is the member code the till derives from their number.
const C = memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), MOBILE)!;
const AT = '2026-10-10T10:00:00.000Z';
const WORDS = ['Gandhi Street', 'call me after six', 'Meena', 'neighbour at flat 4B', 'shoplifting near aisle'];

const ok = async (h: ApiHarness, T: string, userId: string, path: string, body: unknown, key: string): Promise<unknown> => {
  const r = await h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
  expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
};
const get = async (h: ApiHarness, T: string, path: string, userId = OWNER): Promise<unknown> => {
  const r = await h.request({ method: 'GET', path, userId, tenantId: T });
  expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  return r.body;
};

async function seed(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionOwner(T, CHECKER);
  await h.provisionRole(T, C, 'customer');
  await h.provisionRole(T, DRIVER, 'store_manager');
  await h.enableFeature(T, 'customer_app');
  await h.enableFeature(T, 'delivery');
  // Consent, captured at the desk — its evidence names the phone it was checked on (retained: audit evidence).
  await ok(h, T, OWNER, `/v1/customers/${C}/consent`, { purpose: 'marketing', channel: 'whatsapp', given: true, evidence: 'checked on 98765 43210 at the desk, call me after six' }, 'consent');
  // Loyalty membership (the last four digits are sealed).
  const enrolled = await ok(h, T, OWNER, '/v1/loyalty/members', { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' }, 'enrol') as { memberRef: string };
  expect(enrolled.memberRef).toBe(C);
  // A complaint in the customer's own words.
  await ok(h, T, OWNER, '/v1/service/cases/case-1', { kind: 'complaint', customerRef: C, priority: 'normal', summary: 'Delivered to 14 Gandhi Street, wrong flat, call me after six', assignedTo: OWNER }, 'case-1');
  // A storefront order (tax invoice — retained) and the driver's attempt at the door with a note.
  await ok(h, T, OWNER, '/v1/inventory/movements', { movementId: 'mv-1', productId: 'MILK', locationId: 'L1', kind: 'received', quantityMinor: 5, uom: 'each', occurredAt: AT, enteredBy: OWNER }, 'mv-1');
  await ok(h, T, C, '/v1/storefront/orders/ORD-1', { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: 'L1' }, 'ord-1');
  await ok(h, T, DRIVER, '/v1/delivery/attempts', { attemptId: 'att-1', orderId: 'ORD-1', driverId: DRIVER, attemptedAt: AT, outcome: 'delivered', proofRef: 'otp-ok', notes: 'left with neighbour at flat 4B, Gandhi Street', cashCollectedMinor: 52_00 }, 'att-1');
  // A message queued to the customer, from an approved template — its words carry their name.
  await ok(h, T, OWNER, '/v1/notifications/templates/thanks', { purpose: 'marketing', channel: 'whatsapp', body: 'Hello {name}, thank you for shopping with us.' }, 't1');
  await ok(h, T, CHECKER, '/v1/notifications/templates/thanks/approval', { version: 1 }, 't1a');
  await ok(h, T, OWNER, '/v1/notifications/budget', { capMinor: 100_000, costMinorByChannel: { whatsapp: 50 } }, 'b1');
  await ok(h, T, OWNER, '/v1/notifications/queue/n-1', { customerId: C, purpose: 'marketing', channel: 'whatsapp', templateId: 'thanks', values: { name: 'Meena' } }, 'n-1');
  // A loss-prevention case naming the customer (retained: a fraud investigation).
  await ok(h, T, OWNER, '/v1/loss-prevention/cases/lp-1', { raisedFromRef: 'signal-1', subjectRef: C, summary: 'suspected shoplifting near aisle 7', valueMinor: 450_00, assignedTo: CHECKER }, 'lp-1');
}

/** What each domain reads back — the words, and the business record beside them. */
async function readBack(h: ApiHarness, T: string) {
  // The service desk has no single-case read route; its own reader, over the same (sealing) store the routes write through.
  const kase = (await serviceCaseAdapter({ store: h.store, now: () => AT }).serviceCase(T, 'case-1'))!;
  // The driver's run register (its reader over the sealing store) and the run's reconciliation REPORT (the route).
  const run = { attempts: await fulfilmentAdapter({ store: h.store, now: () => AT }).attempts(T, DRIVER, '2026-10-10') };
  const runReport = (await h.request({ method: 'GET', path: `/v1/delivery/runs/${DRIVER}`, userId: OWNER, tenantId: T, query: { runDate: '2026-10-10', cashHandedInMinor: '5200' } })).body;
  // The queue's own log of what each message says (the sender renders from it), over the sealing store.
  const pending = (await notificationQueueAdapter({ store: h.store, now: () => AT }).events!(T)).filter((e) => e.change === 'enqueued');
  const lp = (await get(h, T, '/v1/loss-prevention/cases/lp-1')) as { summary: string; valueMinor: number };
  const consent = (await get(h, T, `/v1/customers/${C}/consent`)) as { records: { evidence: string }[] };
  const order = (await get(h, T, '/v1/storefront/orders/ORD-1', C)) as { lines: { productId: string; quantityMinor: number }[] };
  return { kase, run, runReport, pending, lp, consent, order };
}

interface Raw { readonly rows: () => Promise<readonly { seq: number; type: string; payload: string }[]> }

async function journey(h: ApiHarness, T: string, keys: SubjectKeyStore, raw: Raw, sent: ReturnType<typeof recordingTransport>): Promise<void> {
  await seed(h, T);

  // AT REST: the words are in no raw row; each domain reads them in full.
  const before = await raw.rows();
  for (const w of WORDS) expect(before.filter((r) => r.payload.includes(w)).map((r) => r.type), w).toEqual([]);
  expect(before.some((r) => /"\$pd": ?"v1"/.test(r.payload))).toBe(true);
  const read1 = await readBack(h, T);
  expect(read1.kase.summary).toContain('Gandhi Street');
  expect(read1.run.attempts.find((a) => a.attemptId === 'att-1')).toMatchObject({ notes: 'left with neighbour at flat 4B, Gandhi Street', cashCollectedMinor: 52_00 });
  expect(JSON.stringify(read1.pending)).toContain('Hello Meena');
  expect(read1.lp.summary).toBe('suspected shoplifting near aisle 7');
  expect(read1.consent.records[0]!.evidence).toContain('call me after six');

  // ERASURE — raised by the customer, verified, approved by a second officer, carried out by the first.
  await ok(h, T, C, '/v1/me/privacy/requests/DSR-1', { kind: 'erasure' }, 'raise');
  await ok(h, T, OWNER, '/v1/privacy/data-requests/DSR-1/verification', { verifiedBy: 'otp to registered phone' }, 'verify');
  await ok(h, T, CHECKER, '/v1/privacy/data-requests/DSR-1/erasure-approval', {}, 'approve');
  const located = ((await get(h, T, `/v1/privacy/pii/${C}`)) as { categories: { category: string; state: string }[] }).categories;
  expect(located.map((c) => c.category)).toEqual(['consent_history', 'delivery_records', 'loyalty_member', 'lp_records', 'notification_intents', 'service_cases', 'storefront_orders']);
  const run = (await ok(h, T, OWNER, '/v1/privacy/data-requests/DSR-1/erasure-execution', {}, 'exec')) as { report: { complete: boolean }; tombstone: { categoriesErased: string[]; categoriesMinimised: string[]; categoriesRetained: { category: string }[] } };
  expect(run.report.complete).toBe(true);
  expect(run.tombstone.categoriesErased.sort()).toEqual(['delivery_records', 'loyalty_member', 'notification_intents']);
  expect(run.tombstone.categoriesMinimised).toEqual(['service_cases']);
  expect(run.tombstone.categoriesRetained.map((c) => c.category).sort()).toEqual(['consent_history', 'lp_records', 'storefront_orders']);

  // The raw ledger: every row that was there is still there, byte for byte — nothing edited, nothing deleted.
  const after = await raw.rows();
  const bySeq = new Map(after.map((r) => [r.seq, r.payload]));
  for (const r of before) expect(bySeq.get(r.seq), `row ${r.seq} (${r.type})`).toBe(r.payload);
  for (const w of WORDS) expect(after.filter((r) => r.payload.includes(w)).map((r) => r.type), w).toEqual([]);
  // The destroyed keys are on the list and no longer open the ciphertext; the retained ones still do.
  const sealedRefs = new Set<string>();
  const walk = (v: unknown): void => {
    if (isSealed(v)) { if (v.s === C) sealedRefs.add(v.c); return; }
    if (Array.isArray(v)) v.forEach(walk); else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const r of after) walk(JSON.parse(r.payload));
  expect([...sealedRefs].sort()).toEqual(['consent_history', 'delivery_records', 'loyalty_member', 'lp_records', 'notification_intents', 'service_cases']);
  const k = await keys.keysForRead(T, [...sealedRefs].map((category) => ({ subjectRef: C, category })));
  const state = (category: string) => { const v = k.get(`${C}\u0000${category}`); return Buffer.isBuffer(v) ? 'held' : v; };
  for (const c of ['delivery_records', 'loyalty_member', 'notification_intents', 'service_cases']) {
    expect(state(c), c).toBe('shredded');
    expect(await keys.isShredded(T, { subjectRef: C, category: c })).toBe(true);
  }
  expect(state('consent_history')).toBe('held');
  expect(state('lp_records')).toBe('held');
  // The destruction itself is an audited, append-only fact — with no key material in it.
  const shredFacts = after.filter((r) => r.type === 'SubjectDataKeyShredded');
  expect(shredFacts.map((r) => (JSON.parse(r.payload) as { category: string }).category).sort()).toEqual(['delivery_records', 'loyalty_member', 'notification_intents', 'service_cases']);

  // Each domain now reads the placeholder; the business record beside it is exactly as it was.
  const read2 = await readBack(h, T);
  expect(read2.kase).toMatchObject({ summary: '[removed under privacy request DSR-1]', openedAt: read1.kase.openedAt, state: read1.kase.state, customerRef: C });
  expect(read2.run.attempts.find((a) => a.attemptId === 'att-1')).toMatchObject({ notes: ERASED_TEXT, cashCollectedMinor: 52_00 });
  expect(JSON.stringify(read2.pending)).not.toContain('Meena');
  expect(JSON.stringify(read2.pending)).toContain(ERASED_TEXT);
  expect(read2.lp).toMatchObject({ summary: 'suspected shoplifting near aisle 7', valueMinor: 450_00 }); // retained in full
  expect(read2.consent.records[0]!.evidence).toContain('call me after six');                         // retained in full
  expect(read2.order.lines).toEqual(read1.order.lines);
  expect(read2.runReport).toEqual(read1.runReport); // the run's cash reconciliation is unchanged, to the paisa
  expect(JSON.stringify(read1.runReport)).toMatch(/5200/);
  expect((await get(h, T, '/v1/loyalty/rule'))).toBeDefined();

  // The message queued before the erasure is WITHHELD at the send — a placeholder is never sent to a person.
  const drained = (await ok(h, T, OWNER, '/v1/notifications/queue/drain', {}, 'drain-1')) as { outcome: { id: string; result: string; detail: string }[] };
  expect(drained.outcome).toEqual([expect.objectContaining({ id: 'n-1', result: 'withheld', detail: expect.stringMatching(/erased/) })]);
  expect(sent.sent).toEqual([]);

  // PREVENT-RESTORE: new delivery notes for the erased customer are not kept.
  await ok(h, T, DRIVER, '/v1/delivery/attempts', { attemptId: 'att-2', orderId: 'ORD-1', driverId: DRIVER, attemptedAt: '2026-10-10T11:00:00.000Z', outcome: 'nobody_in', notes: 'rang Meena at Gandhi Street twice' }, 'att-2');
  const late = await raw.rows();
  for (const w of WORDS) expect(late.filter((r) => r.payload.includes(w)).map((r) => r.type), w).toEqual([]);
  const run3 = { attempts: await fulfilmentAdapter({ store: h.store, now: () => AT }).attempts(T, DRIVER, '2026-10-10') };
  expect(run3.attempts.find((a) => a.attemptId === 'att-2')?.notes).toBe(ERASED_TEXT);
}

describe('an erasure shreds the personal text in the ledger (FUL-12 · ADR-0025) — in memory', () => {
  it('seals at rest, destroys the erased categories\' keys, keeps the record and the retained categories', async () => {
    const inner = new InMemoryEventStore();
    const keys = new InMemorySubjectKeyStore();
    const transport = recordingTransport();
    const h = apiHarness({ store: inner, personalDataKeys: keys, notificationTransport: transport });
    const T = 'ab000000-0000-4000-8000-0000000f1201';
    await journey(h, T, keys, {
      rows: async () => (await inner.exportTenant(T)).map((r) => ({ seq: r.seq, type: r.event.type, payload: JSON.stringify(r.event.payload) })),
    }, transport);
  });

  it('a value sealed for one customer does not open as another\'s, and a dispatch plan\'s stop areas are sealed per customer', async () => {
    const inner = new InMemoryEventStore();
    const keys = new InMemorySubjectKeyStore();
    const store: EventStore = personalDataStore(inner, keys);
    const T = 'ab000000-0000-4000-8000-0000000f1202';
    for (const [o, c] of [['O-A', 'cust-a'], ['O-B', 'cust-b']] as const) {
      await store.append(T, streamName(STREAM.orders, o), makeEvent({ id: `p-${o}`, type: 'OrderPlaced', occurredAt: AT, idempotencyKey: `p-${o}`, source: 't', payload: { orderId: o, customerRef: c, locationId: 'L1', lines: [], state: 'placed', placedAt: AT } }));
    }
    await store.append(T, 'delivery/dispatch/2026-10-10', makeEvent({ id: 'd1', type: 'DispatchPlanned', occurredAt: AT, idempotencyKey: 'd1', source: 't', payload: { routes: [{ routeId: 'r1', stops: [{ orderId: 'O-A', area: 'Gandhi Street' }, { orderId: 'O-B', area: 'Nehru Road' }] }], unplanned: [] } }));
    const rawPlan = (await inner.readStream(T, 'delivery/dispatch/2026-10-10'))[0]!.event.payload as { routes: { stops: { area: unknown }[] }[] };
    expect(rawPlan.routes[0]!.stops.map((s) => (isSealed(s.area) ? s.area.s : s.area))).toEqual(['cust-a', 'cust-b']);
    await keys.shred(T, { subjectRef: 'cust-a', category: 'delivery_records' }, { requestId: 'DSR-X', shreddedBy: 't', at: AT });
    const opened = (await store.readStream(T, 'delivery/dispatch/2026-10-10'))[0]!.event.payload as { routes: { stops: { area: unknown }[] }[] };
    expect(opened.routes[0]!.stops.map((s) => s.area)).toEqual([ERASED_TEXT, 'Nehru Road']);
    // Moving cust-b's sealed value under cust-a's name does not open it (the subject is bound into the ciphertext).
    const moved = { ...(rawPlan.routes[0]!.stops[1]!.area as object), s: 'cust-c' };
    await store.append(T, 'x', makeEvent({ id: 'x1', type: 'DispatchPlanned', occurredAt: AT, idempotencyKey: 'x1', source: 't', payload: { routes: [{ routeId: 'r2', stops: [{ orderId: 'O-B', area: moved }] }], unplanned: [] } }));
    const forged = (await store.readStream(T, 'x'))[0]!.event.payload as { routes: { stops: { area: unknown }[] }[] };
    expect(forged.routes[0]!.stops[0]!.area).not.toBe('Nehru Road');
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = Date.now().toString(36);
const SOURCE_DB = `ful12_src_${RUN}`;
const RESTORED_DB = `ful12_dst_${RUN}`;
const BARE_DB = `ful12_bare_${RUN}`;
const urlFor = (db: string): string => { const u = new URL(DATABASE_URL!); u.pathname = `/${db}`; return u.toString(); };

describe.skipIf(!DATABASE_URL)('an erasure shreds the personal text in event_ledger — real PostgreSQL, and a restore does not bring it back (FUL-12)', () => {
  let admin: Pool; let source: Pool;
  const pools: Pool[] = [];
  const out = mkdtempSync(join(tmpdir(), 'ful12-'));
  const kek = randomBytes(32); // the key-encryption key, made at run time (no secret in code)
  const T = randomUUID();
  let manifestPath = '';

  const harnessOver = (pool: Pool) => {
    const sql = pgPoolClient(pool);
    const keys = new SqlSubjectKeyStore(sql, kek);
    const transport = recordingTransport();
    return { h: apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), personalDataKeys: keys, notificationTransport: transport }), keys, transport };
  };
  const rawRows = (pool: Pool): Raw => ({
    rows: async () => (await pool.query<{ seq: string; type: string; payload: string }>('SELECT seq, type, payload::text AS payload FROM event_ledger WHERE tenant_id = $1 ORDER BY seq', [T])).rows
      .map((r) => ({ seq: Number(r.seq), type: r.type, payload: r.payload })),
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: urlFor('postgres'), max: 1 });
    admin.on('error', () => { /* a scratch database is dropped WITH (FORCE); its idle connections are cut */ });
    await admin.query(`CREATE DATABASE ${SOURCE_DB}`);
    source = new Pool({ connectionString: urlFor(SOURCE_DB), max: 4, options: '-c app.tenant_id=*' });
    source.on('error', () => { /* the scratch database is dropped WITH (FORCE) at the end */ });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(source), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  }, 60_000);

  afterAll(async () => {
    for (const p of pools) await p.end();
    await source?.end();
    for (const db of [SOURCE_DB, RESTORED_DB, BARE_DB]) await admin?.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin?.end();
    rmSync(out, { recursive: true, force: true });
  });

  it('the raw event_ledger never holds the words; after erasure they cannot be recovered; the record and retained data stay', async () => {
    const { h, keys, transport } = harnessOver(source);
    // The backup is taken in the middle of the journey's seed — BEFORE the erasure — so it holds the live keys.
    const realSeed = h.request.bind(h);
    let backedUp = false;
    const wrapped: ApiHarness = {
      ...h,
      request: async (input) => {
        if (!backedUp && input.path === '/v1/me/privacy/requests/DSR-1') {
          backedUp = true;
          ({ manifestPath } = await takeBackup({ databaseUrl: urlFor(SOURCE_DB), outDir: out, env: process.env }));
        }
        return realSeed(input);
      },
    };
    await journey(wrapped, T, keys, rawRows(source), transport);
    expect(backedUp).toBe(true);

    // The key rows themselves: destroyed (no key material left), never deleted; the list holds the four.
    const keyRows = (await source.query<{ category: string; has_key: boolean; destroyed: boolean }>('SELECT category, wrapped_key IS NOT NULL AS has_key, destroyed_at IS NOT NULL AS destroyed FROM subject_data_keys WHERE tenant_id = $1 ORDER BY category', [T])).rows;
    expect(keyRows.filter((r) => r.destroyed).map((r) => r.category)).toEqual(['delivery_records', 'loyalty_member', 'notification_intents', 'service_cases']);
    expect(keyRows.filter((r) => r.has_key).map((r) => r.category)).toEqual(['consent_history', 'lp_records']);
    // The database refuses to bring a destroyed key back, or to delete the evidence that it existed.
    await expect(source.query("UPDATE subject_data_keys SET wrapped_key = '\\x00', destroyed_at = NULL WHERE tenant_id = $1 AND category = 'service_cases'", [T])).rejects.toThrow(/only change allowed/);
    await expect(source.query("DELETE FROM subject_data_keys WHERE tenant_id = $1", [T])).rejects.toThrow(/never deleted/);
    await expect(source.query("DELETE FROM subject_key_shreds WHERE tenant_id = $1", [T])).rejects.toThrow(/append-only/);

    // A restart over the same database reads the same: erased stays erased.
    const again = harnessOver(source);
    const kase = (await serviceCaseAdapter({ store: again.h.store, now: () => AT }).serviceCase(T, 'case-1'))!;
    expect(kase.summary).toBe('[removed under privacy request DSR-1]');
  }, 120_000);

  it('a backup from BEFORE the erasure, restored with the production tool and the newest list, does not resurrect the words', async () => {
    expect(manifestPath).not.toBe('');
    await admin.query(`CREATE DATABASE ${RESTORED_DB}`);
    const said = execFileSync('node', ['scripts/restore.mjs', '--manifest', manifestPath, '--target', urlFor(RESTORED_DB), '--shred-list-from', urlFor(SOURCE_DB)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(said).toMatch(/Restore reconciles exactly against the manifest/);
    expect(said).toMatch(/shredded-key list re-applied: 4 entries .* 4 added back, 4 restored key\(s\) destroyed again/);
    const restored = new Pool({ connectionString: urlFor(RESTORED_DB), max: 2, options: '-c app.tenant_id=*' });
    restored.on('error', () => { /* dropped WITH (FORCE) at the end */ });
    pools.push(restored);
    const { h } = harnessOver(restored);
    const run = { attempts: await fulfilmentAdapter({ store: h.store, now: () => AT }).attempts(T, DRIVER, '2026-10-10') };
    expect(run.attempts.find((a) => a.attemptId === 'att-1')).toMatchObject({ notes: ERASED_TEXT, cashCollectedMinor: 52_00 });
    const kase = (await serviceCaseAdapter({ store: h.store, now: () => AT }).serviceCase(T, 'case-1'))!;
    expect(kase.summary).toBe(ERASED_TEXT); // the backup predates the redacted state; its sealed original no longer opens
    const lp = (await h.request({ method: 'GET', path: '/v1/loss-prevention/cases/lp-1', userId: OWNER, tenantId: T })).body as { summary: string };
    expect(lp.summary).toBe('suspected shoplifting near aisle 7'); // retained, its key restored and kept
  }, 120_000);

  it('the hazard, and why the list wins at run time: restored WITHOUT the list the words come back — until the list is on it', async () => {
    await admin.query(`CREATE DATABASE ${BARE_DB}`);
    const said = execFileSync('node', ['scripts/restore.mjs', '--manifest', manifestPath, '--target', urlFor(BARE_DB)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(said).toMatch(/WARNING: no newer shredded-key list was given/);
    const bare = new Pool({ connectionString: urlFor(BARE_DB), max: 2, options: '-c app.tenant_id=*' });
    bare.on('error', () => { /* dropped WITH (FORCE) at the end */ });
    pools.push(bare);
    const { h } = harnessOver(bare);
    const caseNow = async () => (await serviceCaseAdapter({ store: h.store, now: () => AT }).serviceCase(T, 'case-1'))!.summary;
    expect(await caseNow()).toContain('Gandhi Street'); // an old backup alone WOULD resurrect it — the hazard is real
    // An operator puts the newest list's entry back (exactly what `--shred-list-from` does) — WITHOUT touching the key row.
    await bare.query("INSERT INTO subject_key_shreds (tenant_id, subject_ref, category, request_id, shredded_by) VALUES ($1, $2, 'service_cases', 'DSR-1', 'operator')", [T, C]);
    expect((await bare.query('SELECT wrapped_key IS NOT NULL AS has FROM subject_data_keys WHERE tenant_id = $1 AND subject_ref = $2 AND category = $3', [T, C, 'service_cases'])).rows[0].has).toBe(true);
    // The list wins on the next read: the restored key is destroyed on sight and the words do not open.
    expect(await caseNow()).toBe(ERASED_TEXT);
    expect((await bare.query('SELECT wrapped_key IS NOT NULL AS has FROM subject_data_keys WHERE tenant_id = $1 AND subject_ref = $2 AND category = $3', [T, C, 'service_cases'])).rows[0].has).toBe(false);
  }, 120_000);
});


describe.skipIf(!DATABASE_URL)('production seals personal data: the real API assembly (`startApi`) writes it encrypted (FUL-12 · ADR-0025)', () => {
  it('a consent captured through the real API reads back in full and is nowhere in event_ledger as text', async () => {
    const { startRealCloud } = await import('../support/real-store');
    const tenantId = randomUUID();
    const cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: 'u-owner', packSigningKey: randomBytes(32).toString('hex') });
    const platform = new Pool({ connectionString: DATABASE_URL, max: 1, options: '-c app.tenant_id=*' });
    platform.on('error', () => { /* a scratch database is dropped WITH (FORCE); its idle connections are cut */ });
    try {
      const words = `checked on the customer's phone ${randomUUID()}`;
      const put = await cloud.request({ method: 'POST', path: '/v1/customers/cust-prod-1/consent', userId: 'u-owner', idempotencyKey: 'c1', body: { purpose: 'marketing', channel: 'sms', given: true, evidence: words } });
      expect(put.status, JSON.stringify(put.body)).toBe(201);
      const read = await cloud.request({ method: 'GET', path: '/v1/customers/cust-prod-1/consent', userId: 'u-owner' });
      expect((read.body as { records: { evidence: string }[] }).records[0]!.evidence).toBe(words);
      const raw = (await platform.query<{ payload: string }>("SELECT payload::text AS payload FROM event_ledger WHERE tenant_id = $1 AND type = 'ConsentRecorded'", [tenantId])).rows;
      expect(raw).toHaveLength(1);
      expect(raw[0]!.payload).not.toContain(words);
      expect(raw[0]!.payload).toMatch(/"\$pd": ?"v1"/);
      const key = (await platform.query("SELECT category, wrapped_key IS NOT NULL AS held FROM subject_data_keys WHERE tenant_id = $1 AND subject_ref = 'cust-prod-1'", [tenantId])).rows;
      expect(key).toEqual([{ category: 'consent_history', held: true }]);
      expect(cloud.said.join('\n')).toMatch(/personal data: sealed under a key derived from the pack signing key/);
    } finally {
      await platform.end();
      await cloud.stop();
    }
  }, 60_000);
});
