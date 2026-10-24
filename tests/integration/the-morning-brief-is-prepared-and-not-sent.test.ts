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
import { recordingTransport } from '../../packages/notifications/src/index';
import { ownerApprovedSetting } from '../support/owner-approved-setting';

/**
 * **EA-07 (R4, signed OB-227 · OB-222): the owner's morning brief, sending switched off.** "The morning brief is still
 * prepared every day, but its sending is a switched-off link with a test stand-in. Nothing is sent while switched off,
 * and the brief's screen says it was not sent." Production's wiring (no sending link) — even with a message transport
 * present and a messaging budget set — prepares the brief from the governed figures, queues nothing, sends nothing, keeps
 * the day unsent, and the brief's read says so. In memory and on real PostgreSQL.
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

const transport = recordingTransport();
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness({ notificationTransport: transport }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), notificationTransport: transport }); } });

type Res = { status: number; body: unknown };

describe.each(backings)('the morning brief is prepared and not sent — on $name (EA-07 · OB-222)', ({ harness }) => {
  it('a due brief is composed, never queued or sent; the day stays unsent; the brief\'s screen says "not sent"', async () => {
    const h = harness();
    const T = randomUUID();
    if (h.store instanceof SqlEventStore) await h.store.registerTenant(T, 'test/provision');
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    await ok(ownerApprovedSetting(h, T, 'locale.time_zone', { value: 'UTC' }), 'tz');
    const today = new Date().toISOString().slice(0, 10);
    await ok(req('POST', '/v1/sales', {
      saleId: `S-${T.slice(0, 8)}`, receiptNumber: 'R-1', laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: today,
      committedAt: new Date().toISOString(), totalMinor: 123_400, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'P-X', quantityMinor: 1, uom: 'ea', unitPriceMinor: 123_400, lineTotalMinor: 123_400 }], tenders: [{ kind: 'cash', amountMinor: 123_400 }],
    }), 'sale');
    await ok(req('POST', '/v1/notifications/budget', { capMinor: 100_000, costMinorByChannel: { whatsapp: 50 } }), 'budget');
    await ok(req('POST', '/v1/reporting/brief-schedule', { dueAt: [0, 0] }), 'schedule');
    const sentBefore = transport.sent.length;

    const run = (await ok(req('POST', '/v1/reporting/brief-schedule/run', {}), 'run')).body as { ran: { tradingDay: string; outcome: string; detail: string; lines: string[]; deterministic: boolean }[] };
    expect(run.ran).toHaveLength(1);
    expect(run.ran[0]!.outcome).toBe('composed_not_sent');
    expect(run.ran[0]!.detail).toMatch(/NOT sent: sending is switched off \(OB-222\)/);
    expect(run.ran[0]!.deterministic).toBe(true);
    expect(run.ran[0]!.lines.join('\n')).toMatch(/1,234/);
    // Nothing went onto the queue and nothing reached any transport.
    expect(((await ok(req('POST', '/v1/notifications/queue/drain', { maxAttempts: 5 }), 'drain')).body as { outcome: unknown[] }).outcome).toEqual([]);
    expect(transport.sent.length).toBe(sentBefore);
    // The day is not marked sent; the next run prepares it again and still sends nothing.
    expect(((await ok(req('GET', '/v1/reporting/brief-schedule'), 'schedule read')).body as { schedule: { sentDays: string[] } }).schedule.sentDays).toEqual([]);
    expect(((await ok(req('POST', '/v1/reporting/brief-schedule/run', {}), 'run 2')).body as { ran: { outcome: string }[] }).ran.map((r) => r.outcome)).toEqual(['composed_not_sent']);

    // The brief's screen: prepared, not sent, in those words.
    const screen = (await ok(req('GET', '/v1/reporting/brief-today'), 'brief today')).body as { tradingDay: string; prepared: boolean; sending: string; sent: boolean; detail: string; lines: string[] };
    expect([screen.tradingDay, screen.prepared, screen.sending, screen.sent]).toEqual([today, true, 'switched_off', false]);
    expect(screen.detail).toMatch(/NOT sent/);
    expect(screen.lines.length).toBeGreaterThan(0);
    expect((await req('GET', '/v1/reporting/brief-today', undefined, 'u-cash')).status).toBe(403);
    expect(transport.sent.length).toBe(sentBefore);
  }, 120_000);
});
