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
import { auditTrailAdapter } from '../../services/api/src/adapters';

/**
 * **R2 addendum C18 — the TN Shops and Establishments working-time pack, on the live API.**
 *   • every limit is a setting (value + provision of the Act + who confirmed it); while any is pending a roster cannot be
 *     published — refused by name, nothing recorded;
 *   • only the owner sets a limit; every change is audited;
 *   • publishing a week that breaks a limit is REFUSED with each breach in words; the dry run shows the same; a clean
 *     week publishes, is audited, and survives a restart; a manager of another branch cannot publish this one;
 *   • annual leave accrues from recorded days worked; leave beyond the balance is refused; a cancellation compensates;
 *   • the attendance, leave and holiday registers are produced from the stored roster and attendance.
 * In-memory and, with DATABASE_URL, real PostgreSQL. Synthetic data and SYNTHETIC limits only (no legal figure).
 */

type Body = Record<string, unknown>;
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

// IST local times → UTC instants.
const at = (day: string, hhmm: string): string => new Date(Date.parse(`${day}T${hhmm}:00+05:30`)).toISOString();
const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
const SYNTHETIC: Readonly<Record<string, number>> = {
  weeklyHolidayMinDays: 1, maxDailyWorkMinutes: 540, maxWeeklyWorkMinutes: 2880, maxSpreadOverMinutes: 660,
  maxContinuousWorkMinutes: 300, minRestIntervalMinutes: 60, annualLeaveDaysWorkedPerDayEarned: 20,
};

async function shop(h: ApiHarness, t: string) {
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Readonly<Record<string, string>>) =>
    h.request({ method, path, userId, tenantId: t, ...(userId === 'u-mgr' ? { branchId: 'b1' } : userId === 'u-mgr2' ? { branchId: 'b2' } : {}), ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-mgr', 'store_manager', ['b1']);
  await h.provisionRole(t, 'u-mgr2', 'store_manager', ['b2']);
  await h.provisionRole(t, 'u-cash', 'cashier');
  const employee = async (id: string, branchId = 'b1') =>
    expect((await call('POST', `/v1/hr/workforce/employees/${id}`, branchId === 'b1' ? 'u-mgr' : 'u-mgr2', { name: `Person ${id}`, branchId, roles: ['cashier'], active: true }, `emp-${id}`)).status).toBe(200);
  const shift = async (id: string, day: string, from: string, to: string) => {
    expect((await call('POST', `/v1/hr/workforce/shifts/${id}`, 'u-mgr', { branchId: 'b1', startsAt: at(day, from), endsAt: at(day, to), requiredRoles: [{ role: 'cashier', count: 1 }] }, `sh-${id}-${day}-${from}-${to}`)).status).toBe(200);
  };
  const assign = async (shiftId: string, employeeId: string) =>
    expect((await call('POST', `/v1/hr/workforce/shifts/${shiftId}/assignments/${employeeId}`, 'u-mgr', { role: 'cashier' }, `as-${shiftId}-${employeeId}`)).status).toBe(200);
  const setAll = async () => {
    for (const [k, v] of Object.entries(SYNTHETIC)) {
      expect((await call('POST', `/v1/hr/compliance/working-time/settings/${k}`, 'u-owner', { value: v, source: 'synthetic test provision', confirmation: 'synthetic test confirmation' }, `set-${k}-${v}`)).status).toBe(200);
    }
  };
  const publish = (id: string, weekStart = WEEK[0]!, userId = 'u-mgr') => call('POST', `/v1/hr/compliance/roster-publications/${id}`, userId, { branchId: 'b1', weekStart }, `pub-${id}`);
  return { call, employee, shift, assign, setAll, publish };
}

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

describe.each(backings)('C18 — working-time limits enforced at publish, registers produced — on $name', ({ harness }) => {
  it('refuses to publish while a limit is pending; only the owner sets one; every limit change is audited', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);
    await s.employee('E1');
    await s.shift('S1', WEEK[0]!, '09:00', '17:00');
    await s.assign('S1', 'E1');

    const settings = await s.call('GET', '/v1/hr/compliance/working-time/settings', 'u-mgr');
    expect(settings.status).toBe(200);
    expect((settings.body as { pending: string[] }).pending).toHaveLength(7);

    const refused = await s.publish('P0');
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe('working_time_limits_pending');
    expect((refused.body as { error: { whatHappened: string } }).error.whatHappened).toContain('Daily hours cap');
    expect(((await s.call('GET', '/v1/hr/compliance/roster-publications', 'u-mgr')).body as { count: number }).count).toBe(0);

    // A manager may not set a legal limit; a cashier may not even read them.
    expect((await s.call('POST', '/v1/hr/compliance/working-time/settings/maxDailyWorkMinutes', 'u-mgr', { value: 600, source: 'x', confirmation: 'y' }, 'm1')).status).toBe(403);
    expect((await s.call('GET', '/v1/hr/compliance/working-time/settings', 'u-cash')).status).toBe(403);
    // A value with no confirmation is recorded but stays pending.
    expect((await s.call('POST', '/v1/hr/compliance/working-time/settings/maxDailyWorkMinutes', 'u-owner', { value: 540, source: 'synthetic' }, 'o1')).status).toBe(200);
    const half = (await s.call('GET', '/v1/hr/compliance/working-time/settings', 'u-owner')).body as { limits: { key: string; status: string; missing?: string }[] };
    expect(half.limits.find((l) => l.key === 'maxDailyWorkMinutes')).toMatchObject({ status: 'pending', missing: 'needs who confirmed it (owner or CA)' });
    expect(codeOf(await s.call('POST', '/v1/hr/compliance/working-time/settings/maxDailyWorkMinutes', 'u-owner', { value: 0 }, 'o2'))).toBe('not_a_working_time_limit');
    expect((await s.call('POST', '/v1/hr/compliance/working-time/settings/noSuchLimit', 'u-owner', { value: 1 }, 'o3')).status).toBe(404);

    await s.setAll();
    const full = (await s.call('GET', '/v1/hr/compliance/working-time/settings', 'u-owner')).body as { pending: string[] };
    expect(full.pending).toEqual([]);
    const trail = await auditTrailAdapter({ store: h.store }).records(t);
    expect(trail.filter((r) => r.action === 'hr.working_time.setting.change').length).toBe(8);
  });

  it('refuses a week that breaks a limit — each breach in words — and publishes the corrected week', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);
    await s.setAll();
    await s.employee('E1');
    await s.employee('E2');
    // E1: seven days of 09:00-13:00 + 14:00-18:00 (no weekly holiday, 56h). E2: one 10-hour day with no rest.
    for (const [i, d] of WEEK.entries()) {
      await s.shift(`M${i}`, d, '09:00', '13:00'); await s.assign(`M${i}`, 'E1');
      await s.shift(`A${i}`, d, '14:00', '18:00'); await s.assign(`A${i}`, 'E1');
    }
    await s.shift('LONG', WEEK[2]!, '08:00', '18:00'); await s.assign('LONG', 'E2');

    const dry = await s.call('GET', '/v1/hr/compliance/roster-check', 'u-mgr', undefined, undefined, { branchId: 'b1', weekStart: WEEK[0]! });
    expect(dry.status).toBe(200);
    const dryBody = dry.body as { publishable: boolean; breaches: { employeeId: string; rule: string }[] };
    expect(dryBody.publishable).toBe(false);
    expect(dryBody.breaches.map((b) => `${b.employeeId}:${b.rule}`).sort()).toEqual([
      'E1:maxWeeklyWorkMinutes', 'E1:weeklyHolidayMinDays', 'E2:maxContinuousWorkMinutes', 'E2:maxDailyWorkMinutes',
    ]);

    const refused = await s.publish('P1');
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('roster_breaks_working_time_limits');
    const words = (refused.body as { error: { whatHappened: string } }).error.whatHappened;
    expect(words).toContain('Person E1 has 0 day(s) off in the week of 2026-10-19 — the weekly holiday needs at least 1');
    expect(words).toContain('Person E2 is rostered 10h on 2026-10-21 — more than the daily cap of 9h');
    expect((refused.body as { breaches: unknown[] }).breaches).toHaveLength(4);
    expect(((await s.call('GET', '/v1/hr/compliance/roster-publications', 'u-mgr')).body as { count: number }).count).toBe(0);

    // Fix: E1 gets Sunday off (the shifts are moved to the next week); E2's day becomes two halves with a rest.
    await s.shift('M6', '2026-10-26', '09:00', '13:00');
    await s.shift('A6', '2026-10-26', '14:00', '18:00');
    await s.shift('LONG', WEEK[2]!, '08:00', '12:00');
    await s.shift('LONG2', WEEK[2]!, '13:00', '17:00'); await s.assign('LONG2', 'E2');

    // A manager of another branch cannot publish this one.
    expect((await s.publish('P2', WEEK[0]!, 'u-mgr2')).status).toBe(403);
    const ok = await s.publish('P2');
    expect(ok.status).toBe(201);
    expect((ok.body as { publication: Body }).publication).toMatchObject({ branchId: 'b1', weekStart: WEEK[0], weekEnd: WEEK[6], employeesChecked: 2, publishedBy: 'u-mgr' });
    // The same id is never overwritten.
    expect(codeOf(await s.call('POST', '/v1/hr/compliance/roster-publications/P2', 'u-mgr', { branchId: 'b1', weekStart: WEEK[0] }, 'pub-P2-again'))).toBe('publication_id_taken');

    const restarted = apiHarness({ store: h.store });
    const list = (await restarted.request({ method: 'GET', path: '/v1/hr/compliance/roster-publications', userId: 'u-owner', tenantId: t })).body as { publications: Body[] };
    expect(list.publications.map((p) => p['publicationId'])).toEqual(['P2']);
    expect((await auditTrailAdapter({ store: h.store }).records(t)).some((r) => r.action === 'hr.roster.publish' && r.objectId === 'P2')).toBe(true);
  });

  it('accrues annual leave from days worked, refuses leave beyond it, and produces the three registers', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);
    await s.setAll(); // synthetic: 20 days worked earn 1 day of leave
    await s.employee('E1');
    await s.employee('E9', 'b2');
    const days = Array.from({ length: 21 }, (_, i) => new Date(Date.parse('2026-09-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10));
    for (const d of days) expect((await s.call('POST', `/v1/hr/workforce/attendance/E1/${d}`, 'u-mgr', { hours: 8 }, `att-${d}`)).status).toBe(200);
    await s.shift('W1', WEEK[0]!, '09:00', '17:00'); await s.assign('W1', 'E1');

    const first = await s.call('POST', '/v1/hr/compliance/leave/E1/2026-10-05', 'u-mgr', {}, 'lv1');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ accrual: 'in_force', balanceAfter: 0 });
    const second = await s.call('POST', '/v1/hr/compliance/leave/E1/2026-10-06', 'u-mgr', {}, 'lv2');
    expect(second.status).toBe(422);
    expect(codeOf(second)).toBe('leave_beyond_accrued_balance');
    // A cancellation compensates; the day can then be taken elsewhere.
    expect((await s.call('POST', '/v1/hr/compliance/leave/E1/2026-10-05', 'u-mgr', { kind: 'cancelled' }, 'lv3')).status).toBe(200);
    expect((await s.call('POST', '/v1/hr/compliance/leave/E1/2026-10-06', 'u-mgr', {}, 'lv4')).status).toBe(200);
    expect(codeOf(await s.call('POST', '/v1/hr/compliance/leave/E1/2026-10-07', 'u-mgr', { kind: 'cancelled' }, 'lv5'))).toBe('no_leave_to_cancel');
    // A b2 manager cannot record leave for a b1 person.
    expect((await s.call('POST', '/v1/hr/compliance/leave/E1/2026-10-08', 'u-mgr2', {}, 'lv6')).status).toBe(403);

    const leave = await s.call('GET', '/v1/hr/compliance/registers/leave', 'u-mgr', undefined, undefined, { asOf: '2026-10-31' });
    expect(leave.status).toBe(200);
    const lb = leave.body as { rows: Body[]; accrual: { status: string } };
    expect(lb.accrual.status).toBe('in_force');
    // The b1 manager sees only b1 staff.
    expect(lb.rows).toEqual([expect.objectContaining({ employeeId: 'E1', daysWorked: 21, earned: 1, taken: 1, takenDates: ['2026-10-06'], balance: 0 })]);

    const att = await s.call('GET', '/v1/hr/compliance/registers/attendance', 'u-owner', undefined, undefined, { from: '2026-09-20', to: '2026-09-22', branchId: 'b1' });
    expect(att.status).toBe(200);
    const row = (att.body as { rows: { employeeId: string; days: { date: string; status: string; hoursRecorded: number | null }[] }[] }).rows[0]!;
    expect(row.days.map((d) => `${d.date}:${d.status}`)).toEqual(['2026-09-20:present', '2026-09-21:present', '2026-09-22:off']);

    expect((await s.call('POST', '/v1/hr/compliance/working-time/settings/public-holidays', 'u-owner', { dates: [{ date: WEEK[0], name: 'Synthetic holiday' }], source: 'synthetic list', confirmation: 'synthetic' }, 'ph')).status).toBe(200);
    const hol = await s.call('GET', '/v1/hr/compliance/registers/holidays', 'u-mgr', undefined, undefined, { from: WEEK[0]!, to: WEEK[6]!, branchId: 'b1' });
    expect(hol.status).toBe(200);
    const hb = hol.body as { people: { weeks: { daysOff: string[]; weeklyHolidayGiven: boolean | null }[] }[]; publicHolidays: Body[] };
    expect(hb.people[0]!.weeks[0]).toMatchObject({ weeklyHolidayGiven: true });
    expect(hb.people[0]!.weeks[0]!.daysOff).toHaveLength(6);
    expect(hb.publicHolidays).toEqual([{ date: WEEK[0], name: 'Synthetic holiday', workedBy: ['E1'] }]);

    // A cashier reads no register; a manager cannot read another branch's; the period is bounded.
    expect((await s.call('GET', '/v1/hr/compliance/registers/attendance', 'u-cash', undefined, undefined, { from: '2026-09-20', to: '2026-09-22' })).status).toBe(403);
    expect((await s.call('GET', '/v1/hr/compliance/registers/attendance', 'u-mgr', undefined, undefined, { from: '2026-09-20', to: '2026-09-22', branchId: 'b2' })).status).toBe(403);
    expect(codeOf(await s.call('GET', '/v1/hr/compliance/registers/attendance', 'u-owner', undefined, undefined, { from: '2026-01-01', to: '2026-12-31' }))).toBe('register_needs_a_period');
  });
});
