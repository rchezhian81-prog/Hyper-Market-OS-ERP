import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { pinTheEveningClock } from '../support/evening-clock';
import { SqlEventStore, InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore, BackoffAuthThrottle } from '../../services/kernel/src/index';
import { officeSignInRecords, officeSignInStream } from '../../services/api/src/office-sign-in-log';

/**
 * **W3 · D13-FR-06 — failed office sign-ins and lockouts are KEPT, and the security report counts them.**
 *
 * Before: the office sign-in lockout lived only in the API's memory (`services/kernel/src/rate-limit.ts`), so the
 * security report said "not known" and a restart forgot every try. Now each failed try (a token the API did not
 * believe) and each lockout it trips is written append-only on the shop's own record; the lockout itself stays in
 * memory, for speed. Proven on PostgreSQL:
 *   • five forged tokens claiming this shop and person u-guess, from one public address: five failed tries kept, and the
 *     fifth trips the lockout — one lockout kept, with how long; the sixth try is refused while locked (429);
 *   • a COLD RESTART (a fresh head office over the same database) still reads them: the security report counts
 *     5 failed office sign-ins and 1 lockout, and its drill names who was tried and the address class;
 *   • what is kept never holds the token, its signature, or anything secret — and the address only with its last part masked;
 *   • a try that names no shop is not put on any shop's record (in memory, no database needed).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner';
const evening = pinTheEveningClock();
afterAll(() => { vi.useRealTimers(); });

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A token that CLAIMS a shop and a person but whose signature is not head office's. */
const forged = (tenantId: string, sub: string): string => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ tenant_id: tenantId, sub, iss: 'nobody', aud: 'nobody', exp: 9_999_999_999 })}.c2VjcmV0LXNpZ25hdHVyZS13cm9uZw`;

type Fig = { name: string; valueMinor?: number; notAvailableBecause?: string };
type Row = { what: string; who: string; detail: string };

async function tryFiveAndASixth(h: ApiHarness, T: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const r = await h.raw({ method: 'GET', path: '/v1/reports/security', token: forged(T, 'u-guess'), clientIp: '203.0.113.77' });
    expect(r.status).toBe(401);
  }
  const sixth = await h.raw({ method: 'GET', path: '/v1/reports/security', token: forged(T, 'u-guess'), clientIp: '203.0.113.77' });
  expect(sixth.status, 'the source is locked after five failures').toBe(429);
}

async function reportReads(h: ApiHarness, T: string): Promise<void> {
  const res = await h.request({ method: 'GET', path: '/v1/reports/security', userId: OWNER, tenantId: T, query: { day: evening.shopDate } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const body = res.body as { figures: Fig[]; rows: Row[] };
  const f = (n: string): Fig => body.figures.find((x) => x.name === n)!;
  expect(f('Office failed sign-ins').valueMinor).toBe(5);
  expect(f('Office sign-in lockouts').valueMinor).toBe(1);
  expect(f('Office sign-in lockouts').notAvailableBecause).toBeUndefined();
  // The report's rows name who was tried and from which address class.
  expect(body.rows.filter((r) => r.what === 'office_sign_in_failed').map((r) => r.who)).toEqual(['u-guess', 'u-guess', 'u-guess', 'u-guess', 'u-guess']);
  expect(body.rows.find((r) => r.what === 'office_sign_in_lockout')!.detail).toBe('office sign-in locked out a public address (203.0.113.x) for 5 s');
}

describe.skipIf(!DATABASE_URL)('D13-FR-06 — failed office sign-ins and lockouts on PostgreSQL, through a cold restart', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  }, 120_000);
  afterAll(async () => { await pool.end(); });

  it('each failed try and the lockout are kept, survive a restart, and are counted in the security report', async () => {
    const sql = pgPoolClient(pool);
    const T = randomUUID();
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), authThrottle: new BackoffAuthThrottle({ threshold: 5, baseCooldownSeconds: 5, maxCooldownSeconds: 900 }) });
    await h.seedOwner(T, OWNER);
    await tryFiveAndASixth(h, T);

    // A cold restart: a fresh head office (its in-memory lockout empty) over the same database.
    const again = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await reportReads(again, T);

    // What is kept: claims and an address class — never the token, its signature or any secret.
    const kept = await officeSignInRecords(new SqlEventStore(sql), T);
    expect(kept.map((k) => k.p.outcome)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed', 'locked_out']);
    expect(kept[5]!.p).toMatchObject({ claimedTenantId: T, claimedUserId: 'u-guess', sourceClass: 'public', sourceNetwork: '203.0.113.x', lockedForSeconds: 5, path: '/v1/reports/security' });
    const raw = JSON.stringify(kept);
    for (const secret of ['c2VjcmV0LXNpZ25hdHVyZS13cm9uZw', forged(T, 'u-guess'), '203.0.113.77', 'eyJ']) expect(raw).not.toContain(secret);
    // Append-only: the rows are on the ledger table, never overwritten.
    const rows = await pool.query('SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1 AND stream = $2', [T, officeSignInStream()]);
    expect(rows.rows[0].n).toBe(6);
  }, 120_000);
});

describe('D13-FR-06 — a try that names no shop is put on no shop\'s record (in memory)', () => {
  it('an unreadable token is refused, and nothing is written for the shop', async () => {
    const store = new InMemoryEventStore();
    const h = apiHarness({ store });
    const T = 'ab000000-0000-4000-8000-0000000d1306';
    await h.seedOwner(T, OWNER);
    expect((await h.raw({ method: 'GET', path: '/v1/reports/security', token: 'not-a-token-at-all', clientIp: '10.0.0.9' })).status).toBe(401);
    expect(await officeSignInRecords(store, T)).toEqual([]);
    // One that claims the shop is kept, from a private address.
    expect((await h.raw({ method: 'GET', path: '/v1/reports/security', token: forged(T, 'u-x'), clientIp: '10.0.0.9' })).status).toBe(401);
    expect((await officeSignInRecords(store, T)).map((k) => [k.p.outcome, k.p.sourceClass, k.p.sourceNetwork])).toEqual([['failed', 'private', '10.0.0.x']]);
  });
});
