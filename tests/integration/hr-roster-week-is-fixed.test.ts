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
 * **C18 — the roster week is the shop's fixed week (owner decision OB-179 "A", 17 Oct 2026), closing verifier r2final
 * NEW-1 and L2.**
 *   • NEW-1: a roster is checked and published only for a week starting on the shop's roster week day (Monday as
 *     shipped). Any other weekStart is refused by name (400 `not_the_shops_roster_week`), so the verifier's trick —
 *     a Sunday-to-Saturday window and a Tuesday-to-Monday window laid across one real week of seven straight days —
 *     can never publish it, and a shift is shown to staff only while the publication of ITS OWN Monday week stands.
 *   • The week-start day is an owner setting, audited; changing it leaves the weeks published under the old setting
 *     unpublished for staff until they are published again.
 *   • L2: while the shortest rest interval is pending (OB-155), shifts less than 15 minutes apart are one stretch for
 *     the daily hours cap — a one-minute gap at midnight no longer splits a 10-hour stretch — and the publication says so.
 * In-memory and, with DATABASE_URL, real PostgreSQL. Synthetic data and synthetic limits only.
 */

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const at = (day: string, hhmm: string): string => new Date(Date.parse(`${day}T${hhmm}:00+05:30`)).toISOString();
// Monday 19 Oct 2026 to Sunday 25 Oct 2026.
const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
const SYNTHETIC: Readonly<Record<string, number>> = {
  weeklyHolidayMinDays: 1, maxDailyWorkMinutes: 540, maxWeeklyWorkMinutes: 2880, maxSpreadOverMinutes: 660,
  maxContinuousWorkMinutes: 300, minRestIntervalMinutes: 60, annualLeaveDaysWorkedPerDayEarned: 20,
};

interface MyRoster { readonly count: number; readonly notYetPublished: number; readonly shifts: readonly { shiftId: string }[]; readonly weeks: readonly { weekStart: string }[] }

async function shop(h: ApiHarness, t: string, limits: readonly string[] = Object.keys(SYNTHETIC)) {
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Readonly<Record<string, string>>) =>
    h.request({ method, path, userId, tenantId: t, ...(userId === 'u-mgr' ? { branchId: 'b1' } : {}), ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-mgr', 'store_manager', ['b1']);
  await h.provisionRole(t, 'E1', 'cashier');
  for (const k of limits) {
    expect((await call('POST', `/v1/hr/compliance/working-time/settings/${k}`, 'u-owner', { value: SYNTHETIC[k], source: 'synthetic provision', confirmation: 'synthetic confirmation' }, `set-${k}`)).status).toBe(200);
  }
  expect((await call('POST', '/v1/hr/workforce/employees/E1', 'u-mgr', { name: 'Person E1', branchId: 'b1', roles: ['cashier'], active: true }, 'emp-E1')).status).toBe(200);
  const shift = async (id: string, from: string, to: string) => {
    expect((await call('POST', `/v1/hr/workforce/shifts/${id}`, 'u-mgr', { branchId: 'b1', startsAt: from, endsAt: to, requiredRoles: [{ role: 'cashier', count: 1 }] }, `sh-${id}-${from}`)).status).toBe(200);
    expect((await call('POST', `/v1/hr/workforce/shifts/${id}/assignments/E1`, 'u-mgr', { role: 'cashier' }, `as-${id}`)).status).toBe(200);
  };
  const publish = (id: string, weekStart: string) => call('POST', `/v1/hr/compliance/roster-publications/${id}`, 'u-mgr', { branchId: 'b1', weekStart }, `pub-${id}`);
  const check = (weekStart: string) => call('GET', '/v1/hr/compliance/roster-check', 'u-mgr', undefined, undefined, { branchId: 'b1', weekStart });
  const mine = async (): Promise<MyRoster> => (await call('GET', '/v1/hr/workforce/my-roster', 'E1')).body as MyRoster;
  return { call, shift, publish, check, mine };
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

describe.each(backings)('C18 / OB-179 the roster week is the shop\'s fixed Monday week — on $name', ({ harness }) => {
  it('NEW-1: the overlapping-window trick is refused — Sunday and Tuesday "weeks" get 400 by name, and staff see nothing', async () => {
    const h = harness();
    const s = await shop(h, randomUUID());
    // Seven straight days, 5 h a day, Monday to Sunday: no weekly holiday.
    for (const d of WEEK) await s.shift(`D-${d}`, at(d, '09:00'), at(d, '14:00'));
    const mon = await s.publish('p-mon', WEEK[0]!);
    expect(mon.status).toBe(422);
    expect(codeOf(mon)).toBe('roster_breaks_working_time_limits');
    // The verifier's windows: Sunday 18 to Saturday 24 (the 18th "off") and Tuesday 20 to Monday 26 (the 26th "off").
    const sun = await s.publish('p-sun', '2026-10-18');
    const tue = await s.publish('p-tue', '2026-10-20');
    expect([sun.status, tue.status]).toEqual([400, 400]);
    expect(codeOf(sun)).toBe('not_the_shops_roster_week');
    expect(codeOf(tue)).toBe('not_the_shops_roster_week');
    expect((sun.body as { error: { whatHappened: string; nextSafeAction: string } }).error.whatHappened).toContain('2026-10-18 is a sunday');
    expect((sun.body as { error: { nextSafeAction: string } }).error.nextSafeAction).toContain('2026-10-12');
    expect((tue.body as { error: { nextSafeAction: string } }).error.nextSafeAction).toContain('2026-10-19');
    // The read-only check refuses the same windows: there is no other week to look through.
    expect(codeOf(await s.check('2026-10-18'))).toBe('not_the_shops_roster_week');
    expect((await s.check(WEEK[0]!)).status).toBe(200);
    const mine = await s.mine();
    expect(mine.count).toBe(0);
    expect(mine.notYetPublished).toBe(7);
    // Nothing was recorded for the refused windows.
    const pubs = (await s.call('GET', '/v1/hr/compliance/roster-publications', 'u-mgr', undefined, undefined, { branchId: 'b1' })).body as { count: number };
    expect(pubs.count).toBe(0);
  });

  it('NEW-1: a shift is shown only while the publication of ITS OWN Monday week stands', async () => {
    const h = harness();
    const s = await shop(h, randomUUID());
    // Week of 19 Oct: Mon–Sat worked, Sunday 25 off — lawful. Monday 26 belongs to the NEXT week.
    for (const d of WEEK.slice(0, 6)) await s.shift(`D-${d}`, at(d, '09:00'), at(d, '14:00'));
    await s.shift('D-2026-10-26', at('2026-10-26', '09:00'), at('2026-10-26', '14:00'));
    expect((await s.publish('p-1019', WEEK[0]!)).status).toBe(201);
    const mine = await s.mine();
    expect(mine.shifts.map((x) => x.shiftId)).not.toContain('D-2026-10-26');
    expect(mine.count).toBe(6);
    expect(mine.notYetPublished).toBe(1);
    expect(mine.weeks.map((w) => w.weekStart)).toEqual([WEEK[0]]);
    expect((await s.publish('p-1026', '2026-10-26')).status).toBe(201);
    expect((await s.mine()).count).toBe(7);
  });

  it('the week-start day is an owner setting (Monday as shipped), audited; changing it unpublishes the old weeks for staff', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);
    const st = (await s.call('GET', '/v1/hr/compliance/working-time/settings', 'u-owner')).body as { rosterWeek: { startsOn: string }; settings: { rosterWeekStartsOn: string } };
    expect(st.rosterWeek.startsOn).toBe('monday');
    expect(st.settings.rosterWeekStartsOn).toBe('monday');
    await s.shift('S1', at(WEEK[2]!, '09:00'), at(WEEK[2]!, '14:00'));
    expect((await s.publish('p-mon', WEEK[0]!)).status).toBe(201);
    expect((await s.mine()).count).toBe(1);
    // Only the owner sets it, and only to a day of the week.
    expect((await s.call('POST', '/v1/hr/compliance/working-time/settings/roster-week-start', 'u-mgr', { day: 'sunday' }, 'w-mgr')).status).toBe(403);
    expect(codeOf(await s.call('POST', '/v1/hr/compliance/working-time/settings/roster-week-start', 'u-owner', { day: 'someday' }, 'w-bad'))).toBe('not_a_roster_week_day');
    expect((await s.call('POST', '/v1/hr/compliance/working-time/settings/roster-week-start', 'u-owner', { day: 'sunday' }, 'w-sun')).status).toBe(200);
    // The Monday publication no longer stands: staff see nothing until the Sunday week is published.
    expect((await s.mine()).count).toBe(0);
    expect(codeOf(await s.publish('p-mon2', WEEK[0]!))).toBe('not_the_shops_roster_week');
    expect((await s.publish('p-sun', '2026-10-18')).status).toBe(201);
    expect((await s.mine()).count).toBe(1);
    const trail = await auditTrailAdapter({ store: h.store }).records(t);
    expect(trail.filter((r) => r.action === 'hr.working_time.setting.change' && r.objectId === 'rosterWeekStartsOn')).toHaveLength(1);
  });

  it('L2: while the rest interval is pending, a 1-minute gap at midnight does not split a 10-hour stretch for the daily cap', async () => {
    const h = harness();
    const s = await shop(h, randomUUID(), Object.keys(SYNTHETIC).filter((k) => k !== 'minRestIntervalMinutes'));
    await s.shift('A', at(WEEK[1]!, '19:00'), at(WEEK[1]!, '23:59'));
    await s.shift('B', at(WEEK[2]!, '00:00'), at(WEEK[2]!, '05:00'));
    const p = await s.publish('px', WEEK[0]!);
    expect(p.status).toBe(422);
    const breaches = (p.body as { breaches: readonly { rule: string; date: string; observed: number }[]; notChecked: readonly { key: string; meanwhile?: string }[] }).breaches;
    expect(breaches).toContainEqual(expect.objectContaining({ rule: 'maxDailyWorkMinutes', date: WEEK[1], observed: 599 }));
    // The publication check says what it does while the rest interval is pending.
    const rest = (p.body as { notChecked: readonly { key: string; meanwhile?: string }[] }).notChecked.find((n) => n.key === 'minRestIntervalMinutes');
    expect(rest?.meanwhile).toContain('less than 15 minutes apart');
    // 14 minutes apart is still one stretch; a real break (15 minutes or more) is two, each within the cap.
    await s.shift('B', at(WEEK[2]!, '00:13'), at(WEEK[2]!, '05:00'));
    expect((await s.publish('px2', WEEK[0]!)).status).toBe(422);
    await s.shift('B', at(WEEK[2]!, '00:14'), at(WEEK[2]!, '05:00'));
    const ok = await s.publish('px3', WEEK[0]!);
    expect(ok.status).toBe(201);
    expect((ok.body as { words: string }).words).toContain('less than 15 minutes apart');
  });
});
