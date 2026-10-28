import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { setApprovedCreditLimit } from '../support/approved-credit-limit';
import { onThePriceList, harnessPriceList } from '../support/b2b-price-on-record';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { commercialDesksSweep } from '../../services/api/src/commercial-desks-adapters';

/**
 * **OB-514 — a paused recurring business order stays paused until a second person approves it again, and the days it
 * missed while paused are NOT made up — not by the worker, and not by a person running a past date by hand
 * (M22-FR-03 · §28 · P-03 · P-08 · hard rules #2 #10).**
 *
 * The owner's decision: "a paused recurring business order stays paused until a second person approves it again; missed
 * days are not made up". The run route accepted any date and checked only whether the order was in force NOW — so once
 * it was approved again, anyone allowed to issue documents could run a Monday that fell inside the pause and make that
 * order. Now each day is judged AS OF ITS OWN DATE from the order's append-only history:
 *   • a Monday inside the pause, run after the re-approval → nothing made, and the answer says plainly why;
 *   • a Monday before the order was first approved → nothing made, said plainly;
 *   • the first Monday after the re-approval → made, once (a second run makes nothing more);
 *   • head office's own worker, run for the paused Monday after the re-approval, makes nothing either.
 * In memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data only.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr';
const RICE = { lineId: 'l1', productId: 'rice', description: 'Ponni rice 25kg', unitPriceMinor: 10_000, taxRateBps: 500 };
const at = (date: string): string => `${date}T04:30:00.000Z`; // 10:00 in the shop (IST)
// Mondays: 26 Oct (before approval) · 2 Nov (in force) · 9 Nov (inside the pause) · 16 Nov (after re-approval).
const BEFORE = '2026-10-26'; const IN_FORCE = '2026-11-02'; const PAUSED = '2026-11-09'; const AFTER = '2026-11-16';

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
afterEach(() => { vi.useRealTimers(); });

const backings: { name: string; fresh: () => { harness: ApiHarness; store: EventStore } }[] = [
  { name: 'the in-memory event store', fresh: () => { const harness = apiHarness(); return { harness, store: harness.store }; } },
];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', fresh: () => { const sql = pgPoolClient(pool!); const store = new SqlEventStore(sql); return { harness: apiHarness({ store, idempotency: new SqlIdempotencyStore(sql) }), store }; } });
}

describe.each(backings)('OB-514 — a paused recurring order never makes up its missed days — on $name', ({ fresh }) => {
  it('a day inside the pause (or before approval) makes nothing even after re-approval, said plainly; the next due day after re-approval is made once', async () => {
    // The clock walks through the weeks (it still advances): what was recorded when is what decides each day.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const clockAt = (date: string): void => { vi.setSystemTime(new Date(at(date))); };
    clockAt('2026-10-28');
    const { harness: h, store } = fresh();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.enableFeature(T, 'b2b');
    await h.provisionRole(T, MGR, 'store_manager');
    const call = (method: 'GET' | 'POST', path: string, user: string, body?: unknown) =>
      h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${user}-${randomUUID()}` }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    type Run = { generated: number; exceptions: number; runs: { scheduleId: string; on: string; orderId?: string }[]; notMade: { scheduleId: string; on: string; why: string }[] };
    const runDay = async (on: string): Promise<Run> => (await ok(call('POST', '/v1/b2b/recurring-runs', MGR, { on }), `run ${on}`)).body as Run;
    const runsOf = async (): Promise<{ on: string; outcome: string }[]> =>
      ((await call('GET', '/v1/b2b/recurring', OWNER)).body as { schedules: { scheduleId: string; runs: { on: string; outcome: string }[] }[] }).schedules.find((s) => s.scheduleId === 'rec-1')!.runs;

    await ok(call('POST', '/v1/inventory/movements', OWNER, { movementId: 'rice-in', productId: 'rice', locationId: 'S1', kind: 'received', quantityMinor: 50, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER }), 'stock');
    await ok(setApprovedCreditLimit(h, T, OWNER, 'CATERER', { creditLimitMinor: 10_000_000, paymentTermsDays: 30 }), 'terms');
    await ok(call('POST', '/v1/b2b/documents/CATERER/quotations/q-tpl', MGR, { lines: await onThePriceList(harnessPriceList(h, T, OWNER), 'CATERER', [{ ...RICE, qty: 2 }]), locationId: 'S1', validForDays: 365 }), 'template');
    // Every Monday from 19 Oct — so the Monday BEFORE its approval is a due day too.
    await ok(call('POST', '/v1/b2b/recurring/rec-1', MGR, { customerId: 'CATERER', fromQuotationId: 'q-tpl', cadence: 'weekly', dayOf: 1, startsOn: '2026-10-19' }), 'propose');
    await ok(call('POST', '/v1/b2b/recurring/rec-1/approve', OWNER, {}), 'approve (28 Oct)');

    // A Monday BEFORE its approval: nothing, said plainly.
    const before = await runDay(BEFORE);
    expect(before.generated).toBe(0);
    expect(before.runs).toEqual([]);
    expect(before.notMade).toEqual([expect.objectContaining({ scheduleId: 'rec-1', on: BEFORE })]);
    expect(before.notMade[0]!.why).toMatch(/not yet approved on 2026-10-26/);

    // In force on 2 Nov: made.
    clockAt(IN_FORCE);
    expect((await runDay(IN_FORCE)).generated).toBe(1);

    // Paused on 5 Nov; on 9 Nov (paused) nothing; re-approved by ANOTHER person on 12 Nov.
    clockAt('2026-11-05');
    await ok(call('POST', '/v1/b2b/recurring/rec-1/pause', MGR, { reason: 'canteen closed for Diwali' }), 'pause');
    clockAt(PAUSED);
    const whilePaused = await runDay(PAUSED);
    expect(whilePaused.generated).toBe(0);
    expect(whilePaused.notMade[0]!.why).toMatch(/is paused/);
    clockAt('2026-11-12');
    expect((await call('POST', '/v1/b2b/recurring/rec-1/approve', MGR, {})).status).toBe(403); // never its maker
    await ok(call('POST', '/v1/b2b/recurring/rec-1/approve', OWNER, {}), 're-approve (12 Nov)');

    // ── THE DEFECT: the paused Monday, run by hand AFTER the re-approval → nothing made, said plainly.
    const madeUp = await runDay(PAUSED);
    expect(madeUp.generated).toBe(0);
    expect(madeUp.exceptions).toBe(0);
    expect(madeUp.runs).toEqual([]);
    expect(madeUp.notMade).toEqual([expect.objectContaining({ scheduleId: 'rec-1', on: PAUSED })]);
    expect(madeUp.notMade[0]!.why).toMatch(/was paused on 2026-11-09 \(by u-mgr: canteen closed for Diwali\)\. Days missed while paused are not made up/);
    // Nor by head office's own worker, asked for that day.
    expect(await commercialDesksSweep({ store, now: () => at('2026-11-12'), recurring: {} })(T, at(PAUSED))).toBe(0);
    // And the day before approval still makes nothing.
    expect((await runDay(BEFORE)).generated).toBe(0);
    expect((await runsOf()).map((r) => r.on)).toEqual([IN_FORCE]);
    const desk = JSON.stringify((await call('GET', '/v1/b2b/desk/CATERER', OWNER)).body);
    expect(desk).not.toContain(`RSO-rec-1-${PAUSED}`);
    expect(desk).not.toContain(`RSO-rec-1-${BEFORE}`);

    // ── The first Monday after the re-approval → made, once.
    clockAt(AFTER);
    const after = await runDay(AFTER);
    expect(after.generated).toBe(1);
    expect(after.runs[0]!.orderId).toBe(`RSO-rec-1-${AFTER}`);
    expect(after.notMade).toEqual([]);
    expect((await runDay(AFTER)).generated).toBe(0);
    expect((await runsOf()).map((r) => r.on)).toEqual([IN_FORCE, AFTER]);
  }, 90_000);
});
