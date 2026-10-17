import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useBackings } from '../support/backings';

/**
 * **NEW-8 (verifier, D-6) — redefining a check never erases the checks it already missed.** The verifier's case: a chiller
 * check hourly from six hours ago, never recorded — seven slots missed; the store manager re-sends the definition with a
 * start in the next hour (or inactive) and the misses vanished (7 → 0). Now, on the real API in memory and on PostgreSQL:
 * a redefinition is a new VERSION in force from now — every slot that fell due under the earlier version stays, missed and
 * escalated; the new version's slots start from the redefinition; deactivating stops the future only; a missed slot can
 * still be recorded late (judged by the version it fell under); the same definition re-sent changes nothing; and each
 * redefinition is sealed in the audit trail with what changed, which verifies intact.
 */

const backings = useBackings();
const HOUR = 3_600_000;
type Res = { status: number; body: unknown };
interface Slot { checkId: string; slotDueAt: string; state: string; escalateTo?: string }

describe.each(backings)('NEW-8 — a redefined check keeps its missed history — on $name', ({ harness }) => {
  it('a later start and then "inactive" keep every missed slot; the change is a version from now on, audited', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner'); await h.provisionRole(T, 'u-mgr', 'store_manager');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body, idempotencyKey: randomUUID() }), ...(query === undefined ? {} : { query }) });
    const H = Math.floor(Date.now() / HOUR) * HOUR;
    const at = (hours: number) => new Date(H + hours * HOUR).toISOString();
    const def = (body: Record<string, unknown>) => call('POST', '/v1/facilities/food-safety/checks/chiller', 'u-mgr', {
      branchId: 'BR1', title: 'Chiller', kind: 'temperature', minTenthsC: 0, maxTenthsC: 50, graceMinutes: 15, assignedRole: 'store_manager', escalatesTo: 'u-owner', everyMinutes: 60, ...body,
    });
    const status = async (): Promise<{ missedCount: number; slots: Slot[] }> =>
      (await call('GET', '/v1/facilities/food-safety/status', 'u-owner', undefined, { from: at(-7), asOf: at(3) })).body as { missedCount: number; slots: Slot[] };
    const missedSlots = (s: { slots: Slot[] }) => s.slots.filter((x) => x.state === 'missed').map((x) => x.slotDueAt);

    expect((await def({ startsAt: at(-6) })).status).toBe(201);
    const before = await status();
    // Read three hours ahead: the six past slots, this hour's and the next three hours' — none recorded.
    const pastMissed = [at(-6), at(-5), at(-4), at(-3), at(-2), at(-1)];
    expect(missedSlots(before).slice(0, 6)).toEqual(pastMissed);

    // The same definition again: nothing changes, no new version.
    const same = await def({ startsAt: at(-6) });
    expect(same.status).toBe(200);
    expect((same.body as { unchanged?: boolean }).unchanged).toBe(true);

    // The verifier's move: start the schedule next hour. The six past misses stay — and stay escalated.
    const moved = await def({ startsAt: at(1) });
    expect(moved.status).toBe(201);
    expect(moved.body).toMatchObject({ redefined: true });
    const afterMove = await status();
    expect(missedSlots(afterMove).filter((s) => s < at(0))).toEqual(pastMissed);
    expect(afterMove.slots.filter((x) => x.state === 'missed' && x.slotDueAt < at(0)).every((x) => x.escalateTo === 'u-owner')).toBe(true);

    // A missed slot of the old version can still be recorded — late, never green — and the miss stays visible as late.
    const late = await call('POST', `/v1/facilities/food-safety/checks/chiller/records/r-late`, 'u-mgr', { slotDueAt: at(-6), readingTenthsC: 30 });
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    expect((late.body as { record: { late: boolean } }).record.late).toBe(true);

    // Set inactive: the future stops; the history does not.
    expect((await def({ startsAt: at(1), active: false })).status).toBe(201);
    const afterOff = await status();
    expect(afterOff.slots.find((x) => x.slotDueAt === at(-6))!.state).toBe('done_late');
    expect(missedSlots(afterOff).filter((s) => s < at(0))).toEqual(pastMissed.slice(1));
    expect(afterOff.missedCount).toBeGreaterThanOrEqual(5);

    // The trail: one define, then two redefinitions with what changed — and it verifies intact.
    const trail = (await call('GET', '/v1/audit/trail', 'u-owner', undefined, { objectType: 'food_safety_check' })).body as { matches: { action: string; actorId: string; before: Record<string, string> | null; after: Record<string, string>; reason?: string }[] };
    const defs = trail.matches.filter((m) => m.action.startsWith('food_safety.check.') && m.action.endsWith('define'));
    expect(defs.map((m) => [m.action, m.actorId])).toEqual([['food_safety.check.define', 'u-mgr'], ['food_safety.check.redefine', 'u-mgr'], ['food_safety.check.redefine', 'u-mgr']]);
    expect(defs[1]!.before).toMatchObject({ startsAt: at(-6), active: 'true' });
    expect(defs[1]!.after).toMatchObject({ startsAt: at(1), active: 'true' });
    expect(defs[1]!.reason).toMatch(/every slot due before stays as it was/);
    expect(defs[2]!.after).toMatchObject({ active: 'false' });
    expect(((await call('GET', '/v1/audit/trail/verify', 'u-owner')).body as { intact: boolean }).intact).toBe(true);
  });
});
