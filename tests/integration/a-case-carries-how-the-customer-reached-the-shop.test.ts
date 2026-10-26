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

/**
 * **OB-390 (owner, 26 Oct 2026: "a case reply defaults to its channel") — a service case carries how the customer reached
 * the shop, so the desk's reply goes back that way by default (crm-service.md "open and reply to a case ≤3").**
 *
 * `POST /v1/service/cases/:id` takes an optional `channel` — phone, in person or email, the ways a person can reply today
 * (no SMS/WhatsApp provider is connected) — and the case list returns it. Anything else is refused by name and nothing is
 * opened. It is a default only: the reply still names its own channel when it is sent, and that is what is recorded. A case
 * opened without one carries none (never a guessed one). In memory and — with DATABASE_URL — on real PostgreSQL, with a
 * cold restart (a new harness over the same store).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

type Backing = { name: string; harness: (from?: ApiHarness) => ApiHarness };
const backings: Backing[] = [{ name: 'the in-memory event store', harness: (from) => (from === undefined ? apiHarness() : apiHarness({ store: from.store })) }];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });
}

const CASE = { kind: 'complaint', customerRef: 'c1', priority: 'normal', summary: 'the milk was sour', assignedTo: 'u-mgr' };

describe.each(backings)('a service case carries how the customer reached the shop (OB-390) — on $name', ({ harness }) => {
  it('kept on the case and listed; a case without one has none; an unknown channel is refused and nothing is opened; it survives a restart', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    let n = 0;
    const open = (userId: string, id: string, body: Record<string, unknown>) =>
      h.request({ method: 'POST', path: `/v1/service/cases/${id}`, userId, tenantId: T, idempotencyKey: `open-${id}-${n += 1}`, body });
    const list = async (hh: ApiHarness) => ((await hh.request({ method: 'GET', path: '/v1/service/cases', userId: 'u-owner', tenantId: T })).body as { cases: { caseId: string; channel?: string }[] }).cases;

    expect((await open('u-mgr', 'K-PHONE', { ...CASE, channel: 'phone' })).status).toBe(201);
    expect((await open('u-mgr', 'K-EMAIL', { ...CASE, channel: 'email' })).status).toBe(201);
    expect((await open('u-mgr', 'K-NONE', CASE)).status).toBe(201);

    // A channel nobody can reply on (no provider connected), or nonsense: refused by name, nothing opened.
    for (const channel of ['sms', 'whatsapp', 'carrier pigeon', 3]) {
      const r = await open('u-mgr', 'K-BAD', { ...CASE, channel });
      expect(r.status, String(channel)).toBe(400);
      expect((r.body as { error: { code: string; whatHappened: string } }).error).toMatchObject({ code: 'not_readable_as_a_case', whatHappened: expect.stringContaining('channel? (phone/in_person/email)') });
    }
    // Not the desk: refused, whatever the channel.
    expect((await open('u-cash', 'K-CASH', { ...CASE, channel: 'phone' })).status).toBe(403);

    const byId = (cases: { caseId: string; channel?: string }[]) => Object.fromEntries(cases.map((c) => [c.caseId, c.channel ?? null]));
    expect(byId(await list(h))).toEqual({ 'K-PHONE': 'phone', 'K-EMAIL': 'email', 'K-NONE': null });

    // A cold restart: a new API over the same store reads the same channels back.
    const again = harness(h);
    expect(byId(await list(again))).toEqual({ 'K-PHONE': 'phone', 'K-EMAIL': 'email', 'K-NONE': null });
  });
});
