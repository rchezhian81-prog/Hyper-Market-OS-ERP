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
 * **D-6 (roadmap v2.1 addendum, ratified R2) — "Scheduled temperature/equipment checks and cleaning/receiving checklists
 * with corrective-action capture and a tamper-evident trail; a missed check surfaces".**
 *
 * End to end on the real API, in memory and — with DATABASE_URL — on real PostgreSQL, joined to what M26 already had: the
 * cold room's PROBE (M26-FR-02, `/v1/facilities/equipment/...`) breaches on its own, and the person's SCHEDULED check of the
 * same cold room is recorded beside it. Each of the four kinds is defined and done in the doer's own name; a failure with
 * no corrective action is refused (nothing written); a slot nobody did is MISSED and escalated by name; a late one is kept
 * as late; a slot cannot be recorded twice; every definition and record is sealed into the hash-chained audit trail and
 * the trail verifies intact.
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
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const HOUR = 3_600_000;
interface Slot { checkId: string; slotDueAt: string; state: string; escalateTo?: string; correctiveAction?: string; performedBy?: string }
interface Status { missed: Slot[]; failed: Slot[]; due: Slot[]; slots: Slot[]; receiving: { recordId: string; subjectRef: string; outcome: string }[]; missedCount: number }

describe.each(backings)('D-6 — food-safety checks are scheduled, corrected and sealed — on $name', ({ harness }) => {
  it('four kinds of check; a failure needs its action; a missed slot surfaces and escalates; the trail verifies', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body, idempotencyKey: `k-${n++}` }), ...(query === undefined ? {} : { query }) });

    // The schedule is anchored to this hour, so the records the route stamps "now" fall in known slots.
    const H = Math.floor(Date.now() / HOUR) * HOUR;
    const at = (hours: number) => new Date(H + hours * HOUR).toISOString();
    const define = (id: string, body: Record<string, unknown>) => call('POST', `/v1/facilities/food-safety/checks/${id}`, 'u-owner', { branchId: 'BR1', assignedRole: 'store_manager', escalatesTo: 'u-owner', ...body });
    const record = (id: string, recordId: string, body: Record<string, unknown>, by = 'u-mgr') => call('POST', `/v1/facilities/food-safety/checks/${id}/records/${recordId}`, by, body);

    // ── joined to M26: the cold room's probe breaches by itself ───────────────────────────────────────────────
    expect((await call('POST', '/v1/facilities/equipment/cold-1/range', 'u-owner', { branchId: 'BR1', name: 'Cold room 1', minTenthsC: 0, maxTenthsC: 50, graceMinutes: 30, expectEveryMinutes: 120 })).status).toBeLessThan(300);
    await call('POST', '/v1/facilities/equipment/cold-1/readings/p1', 'u-owner', { tenthsC: 90, at: at(-2), source: 'sensor', recordedBy: 'probe-1' });
    await call('POST', '/v1/facilities/equipment/cold-1/readings/p2', 'u-owner', { tenthsC: 95, at: at(-1), source: 'sensor', recordedBy: 'probe-1' });
    expect(((await call('GET', '/v1/facilities/equipment/cold-1', 'u-owner', undefined, { asOf: at(0) })).body as { state: string }).state).toBe('breach');

    // ── "scheduled temperature/equipment checks and cleaning/receiving checklists" ─────────────────────────────
    expect((await define('cold-1-temp', { title: 'Cold room 1 temperature', kind: 'temperature', everyMinutes: 60, startsAt: at(-6), graceMinutes: 60, minTenthsC: 0, maxTenthsC: 50, equipmentId: 'cold-1' })).status).toBe(201);
    expect((await define('slicer', { title: 'Slicer guard', kind: 'equipment', everyMinutes: 1_440, startsAt: at(-1), graceMinutes: 120, items: [{ itemId: 'guard', label: 'Guard in place' }] })).status).toBe(201);
    expect((await define('deli-clean', { title: 'Deli clean', kind: 'cleaning', everyMinutes: 1_440, startsAt: at(0), graceMinutes: 120, items: [{ itemId: 'boards', label: 'Boards washed' }, { itemId: 'slicer', label: 'Slicer sanitised' }] })).status).toBe(201);
    expect((await define('dock', { title: 'Chilled delivery', kind: 'receiving', graceMinutes: 0, minTenthsC: 0, maxTenthsC: 50, items: [{ itemId: 'pack', label: 'Packaging intact' }] })).status).toBe(201);
    // A malformed check, and one defined by somebody without the authority, are refused.
    expect(codeOf(await define('bad', { title: 'No limits', kind: 'temperature', everyMinutes: 60, startsAt: at(0), graceMinutes: 10 }))).toBe('not_readable_as_a_food_safety_check');
    expect((await call('POST', '/v1/facilities/food-safety/checks/x', 'u-cash', { branchId: 'BR1', title: 't', kind: 'cleaning', everyMinutes: 60, startsAt: at(0), graceMinutes: 0, items: [{ itemId: 'a', label: 'a' }], assignedRole: 'r', escalatesTo: 'u' })).status).toBe(403);

    // ── "corrective-action capture" ────────────────────────────────────────────────────────────────────────────
    // The scheduled reading confirms what the probe saw: outside the limits with no action → refused, nothing written.
    const noAction = await record('cold-1-temp', 'rec-now', { slotDueAt: at(0), readingTenthsC: 92 });
    expect(noAction.status).toBe(422);
    expect(codeOf(noAction)).toBe('corrective_action_required');
    // The record is the signed-in person's; a typed name is refused by name.
    expect(codeOf(await record('cold-1-temp', 'rec-now', { slotDueAt: at(0), readingTenthsC: 92, correctiveAction: 'x', performedBy: 'u-cash' }))).toBe('actor_is_the_caller');
    const fixed = await record('cold-1-temp', 'rec-now', { slotDueAt: at(0), readingTenthsC: 92, correctiveAction: 'Moved dairy to cold room 2; engineer called', evidenceRefs: ['photo-door-seal'] });
    expect(fixed.status).toBe(201);
    expect(fixed.body).toMatchObject({ record: { outcome: 'fail', performedBy: 'u-mgr', late: false, correctiveAction: 'Moved dairy to cold room 2; engineer called' } });
    // One slot, one record — never overwritten.
    expect(codeOf(await record('cold-1-temp', 'rec-again', { slotDueAt: at(0), readingTenthsC: 40 }))).toBe('check_already_recorded');
    // The 6-hours-ago slot, done now: kept, marked late.
    expect(((await record('cold-1-temp', 'rec-old', { slotDueAt: at(-6), readingTenthsC: 30 })).body as { record: { late: boolean } }).record.late).toBe(true);
    // Equipment and cleaning checklists: every item ticked; a failed item needs its action.
    expect(codeOf(await record('slicer', 'rec-slicer', { slotDueAt: at(-1), itemResults: {} }))).toBe('items_incomplete');
    expect((await record('slicer', 'rec-slicer', { slotDueAt: at(-1), itemResults: { guard: 'pass' } })).status).toBe(201);
    expect(codeOf(await record('deli-clean', 'rec-clean', { slotDueAt: at(0), itemResults: { boards: 'fail', slicer: 'pass' } }))).toBe('corrective_action_required');
    expect((await record('deli-clean', 'rec-clean', { slotDueAt: at(0), itemResults: { boards: 'fail', slicer: 'pass' }, correctiveAction: 'Re-washed the boards at 90°C' })).status).toBe(201);
    // Receiving: per delivery, names its goods receipt.
    expect(codeOf(await record('dock', 'rec-dock', { itemResults: { pack: 'pass' }, readingTenthsC: 40 }))).toBe('needs_a_delivery');
    expect((await record('dock', 'rec-dock', { subjectRef: 'GRN-17', itemResults: { pack: 'pass' }, readingTenthsC: 40 })).status).toBe(201);
    // A cashier may not record a check (facilities.task.record).
    expect((await record('slicer', 'rec-cash', { slotDueAt: at(-1), itemResults: { guard: 'pass' } }, 'u-cash')).status).toBe(403);

    // ── "a missed check surfaces" ─────────────────────────────────────────────────────────────────────────────
    const read = await call('GET', '/v1/facilities/food-safety/status', 'u-owner', undefined, { from: at(-6), asOf: new Date(H + HOUR - 1_000).toISOString() }); // the end of this hour: every record above is before it
    expect(read.status).toBe(200);
    const s = read.body as Status;
    const temp = s.slots.filter((x) => x.checkId === 'cold-1-temp').map((x) => [x.slotDueAt, x.state]);
    expect(temp).toEqual([
      [at(-6), 'done_late'], [at(-5), 'missed'], [at(-4), 'missed'], [at(-3), 'missed'], [at(-2), 'missed'], [at(-1), 'missed'],
      [at(0), 'done_failed'], [at(1), 'due'],
    ]);
    expect(s.missedCount).toBe(5);
    expect(s.missed.every((m) => m.escalateTo === 'u-owner')).toBe(true);
    expect(s.failed.map((f) => [f.checkId, f.correctiveAction])).toEqual([
      ['cold-1-temp', 'Moved dairy to cold room 2; engineer called'], ['deli-clean', 'Re-washed the boards at 90°C'],
    ]);
    expect(s.slots.find((x) => x.checkId === 'slicer')).toMatchObject({ state: 'done', performedBy: 'u-mgr' });
    expect(s.receiving.map((r) => [r.recordId, r.subjectRef, r.outcome])).toEqual([['rec-dock', 'GRN-17', 'pass']]);

    // ── "a tamper-evident trail" ──────────────────────────────────────────────────────────────────────────────
    const trail = (await call('GET', '/v1/audit/trail', 'u-owner', undefined, { objectType: 'food_safety_check' })).body as { matches: { action: string; actorId: string; objectId: string; reason?: string }[] };
    expect(trail.matches.filter((m) => m.action === 'food_safety.check.define')).toHaveLength(4);
    const done = trail.matches.filter((m) => m.action.startsWith('food_safety.check.') && m.action !== 'food_safety.check.define');
    expect(done.map((m) => [m.objectId, m.action, m.actorId])).toEqual([
      ['cold-1-temp', 'food_safety.check.failed', 'u-mgr'], ['cold-1-temp', 'food_safety.check.passed', 'u-mgr'],
      ['slicer', 'food_safety.check.passed', 'u-mgr'], ['deli-clean', 'food_safety.check.failed', 'u-mgr'], ['dock', 'food_safety.check.passed', 'u-mgr'],
    ]);
    expect(done[0]!.reason).toBe('Moved dairy to cold room 2; engineer called');
    const verify = (await call('GET', '/v1/audit/trail/verify', 'u-owner')).body as { intact: boolean };
    expect(verify.intact).toBe(true);
  });
});
