import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { seedOnlineShop, callsFor, OWNER, MANAGER, CASHIER, CUSTOMER, OTHER_CUSTOMER } from '../support/online-shop';

/**
 * **U6 · M17-FR-01 · M20 · §27 "Customer: Loyalty" (7 Nov 2026) — the signed-in customer reads THEIR OWN points in the app.**
 * Through the real API, in memory and on real PostgreSQL: an app account not tied to a member is told so and what to do;
 * once the desk ties it to a member (OB-29) the balance, the value of a point and how to spend them are read back; the
 * value "not set" is said, never ₹0; another customer's app reads its own (nothing of the member's); staff cannot use the
 * customer's route; nothing here moves a point.
 */
const MOBILE = '9876500011';
const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

describe.each(backings)('my points in the app — on $name', ({ harness }) => {
  it('not tied: said with the next step; tied at the desk: the balance, the value, how to spend; value not set is said; own only; staff refused', async () => {
    const h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    await seedOnlineShop(h, T, c);
    const me = (who: string) => c.req('GET', '/v1/me/loyalty', undefined, who);

    const before = await me(CUSTOMER);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ member: false });
    expect((before.body as { say: string }).say).toContain('service desk');

    // The desk enrols the member and ties the app account to it, having seen the number on the customer's phone (OB-29).
    await c.ok(c.req('POST', '/v1/loyalty/members', { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' }, MANAGER), 'enrol');
    await c.ok(c.req('POST', '/v1/loyalty/members/app-link', { mobile: MOBILE, appCustomerRef: CUSTOMER, verifiedHow: 'seen_on_phone' }, MANAGER), 'link');
    const tied = await me(CUSTOMER);
    expect(tied.body).toMatchObject({ member: true, pointsBalance: 0, pointValuePaise: 0 });
    expect((tied.body as { say: string }).say).toContain('has not set what a point is worth');
    expect((tied.body as { worthMinor?: number }).worthMinor).toBeUndefined();
    expect((tied.body as { howToSpend: string }).howToSpend).toContain('At the till');

    // The owner sets a point's worth: the same figure the till uses (M17-FR-01); still no points earned, so worth ₹0.00 said as such.
    await c.ok(c.req('PUT', '/v1/platform/setup/loyalty.point_value_paise', { value: 100 }), 'point value');
    const valued = await me(CUSTOMER);
    expect(valued.body).toMatchObject({ member: true, pointsBalance: 0, pointValuePaise: 100, worthMinor: 0 });
    expect((valued.body as { say: string }).say).toBe('You have 0 point(s), worth ₹0.00 at the till.');

    // Another app customer reads their own — not tied, nothing of the member's. Staff cannot use the customer's route.
    expect((await me(OTHER_CUSTOMER)).body).toMatchObject({ member: false });
    expect((await me(CASHIER)).status).toBe(403);
    expect((await me(OWNER)).status).toBe(403);
  });
});
