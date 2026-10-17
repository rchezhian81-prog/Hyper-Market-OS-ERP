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
 * **R2 addendum C18 on the live API — the follow-up to verifier lanes34 NEW-1 to NEW-3 and owner decisions OB-152,
 * OB-155, OB-156 and OB-166.**
 *   • NEW-1: a stretch with no rest split at local midnight is refused at publish;
 *   • NEW-2: Mon–Sat overnight shifts leave no weekly holiday, though no shift STARTS on Sunday — refused;
 *   • NEW-3 / OB-166 "A": staff see ONLY a published week; any edit after publishing returns the week to "needs
 *     publishing" and staff stop seeing it until it is checked and published again; deactivating a person does not
 *     hide their shifts from the check;
 *   • OB-155 "A": while limits are pending, publishing is allowed and the publication, the roster staff see and the
 *     registers name exactly which limits were not checked; OB-152 "A": a breach of a limit that IS filled is refused;
 *   • OB-156 "B": casual, sick, festival and unpaid leave are owner-set settings, recorded as not checked until filled,
 *     then checked against days a year with carry-over.
 * In-memory and, with DATABASE_URL, real PostgreSQL. Synthetic data and synthetic limits only.
 */

const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const at = (day: string, hhmm: string): string => new Date(Date.parse(`${day}T${hhmm}:00+05:30`)).toISOString();
const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
const SYNTHETIC: Readonly<Record<string, number>> = {
  weeklyHolidayMinDays: 1, maxDailyWorkMinutes: 540, maxWeeklyWorkMinutes: 2880, maxSpreadOverMinutes: 660,
  maxContinuousWorkMinutes: 300, minRestIntervalMinutes: 60, annualLeaveDaysWorkedPerDayEarned: 20,
};

interface MyRoster { readonly count: number; readonly notYetPublished: number; readonly shifts: readonly { shiftId: string; startsAt: string; endsAt: string }[]; readonly weeks: readonly { weekStart: string; limitsNotChecked: readonly string[] }[] }

async function shop(h: ApiHarness, t: string) {
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Readonly<Record<string, string>>) =>
    h.request({ method, path, userId, tenantId: t, ...(userId === 'u-mgr' ? { branchId: 'b1' } : {}), ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-mgr', 'store_manager', ['b1']);
  await h.provisionRole(t, 'E1', 'cashier');
  const setLimit = async (k: string, v = SYNTHETIC[k]!) =>
    expect((await call('POST', `/v1/hr/compliance/working-time/settings/${k}`, 'u-owner', { value: v, source: 'synthetic provision', confirmation: 'synthetic confirmation' }, `set-${k}-${v}-${randomUUID()}`)).status).toBe(200);
  const setAll = async () => { for (const k of Object.keys(SYNTHETIC)) await setLimit(k); };
  const employee = async (id: string, active = true) =>
    expect((await call('POST', `/v1/hr/workforce/employees/${id}`, 'u-mgr', { name: `Person ${id}`, branchId: 'b1', roles: ['cashier'], active }, `emp-${id}-${randomUUID()}`)).status).toBe(200);
  const shift = async (id: string, from: string, to: string) =>
    expect((await call('POST', `/v1/hr/workforce/shifts/${id}`, 'u-mgr', { branchId: 'b1', startsAt: from, endsAt: to, requiredRoles: [{ role: 'cashier', count: 1 }] }, `sh-${id}-${randomUUID()}`)).status).toBe(200);
  const assign = async (shiftId: string, employeeId = 'E1') =>
    expect((await call('POST', `/v1/hr/workforce/shifts/${shiftId}/assignments/${employeeId}`, 'u-mgr', { role: 'cashier' }, `as-${shiftId}-${employeeId}-${randomUUID()}`)).status).toBe(200);
  const publish = (id: string) => call('POST', `/v1/hr/compliance/roster-publications/${id}`, 'u-mgr', { branchId: 'b1', weekStart: WEEK[0] }, `pub-${id}`);
  const mine = async (): Promise<MyRoster> => (await call('GET', '/v1/hr/workforce/my-roster', 'E1')).body as MyRoster;
  const weekState = async (): Promise<string> =>
    ((await call('GET', '/v1/hr/compliance/roster-check', 'u-mgr', undefined, undefined, { branchId: 'b1', weekStart: WEEK[0]! })).body as { week: { state: string } }).week.state;
  return { call, setLimit, setAll, employee, shift, assign, publish, mine, weekState };
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

describe.each(backings)('C18 publishing is the gate staff see through — on $name', ({ harness }) => {
  it('NEW-1 / NEW-2: a no-rest stretch split at midnight, and overnight tails on the "day off", are refused at publish', async () => {
    const h = harness();
    const s = await shop(h, randomUUID());
    await s.setAll();
    await s.employee('E1');
    await s.shift('A', at(WEEK[1]!, '19:00'), at(WEEK[1]!, '23:59'));
    await s.shift('B', at(WEEK[2]!, '00:00'), at(WEEK[2]!, '04:59'));
    await s.assign('A'); await s.assign('B');
    const split = await s.publish('P-split');
    expect(split.status).toBe(422);
    // OB-168: the stretch counts in full against the daily cap too (9h 58m worked on the 20th > 9h).
    expect((split.body as { breaches: { rule: string; date: string; observed: number }[] }).breaches.map((b) => `${b.rule}@${b.date}:${b.observed}`))
      .toEqual(['maxContinuousWorkMinutes@2026-10-20:599', 'maxDailyWorkMinutes@2026-10-20:598']);
    expect((split.body as { error: { whatHappened: string } }).error.whatHappened).toContain('from 2026-10-20 19:00 to 2026-10-21 04:59');

    const h2 = harness();
    const s2 = await shop(h2, randomUUID());
    await s2.setAll();
    await s2.employee('E1');
    for (const [i, d] of WEEK.slice(0, 6).entries()) { await s2.shift(`N${i}`, at(d, '22:00'), at(WEEK[i + 1]!, '03:00')); await s2.assign(`N${i}`); }
    const tails = await s2.publish('P-tails');
    expect(tails.status).toBe(422);
    expect((tails.body as { breaches: { rule: string }[] }).breaches.map((b) => b.rule)).toEqual(['weeklyHolidayMinDays']);
  });

  it('NEW-3 / OB-166: staff see only a published week; an edit after publishing hides it until it is checked and published again', async () => {
    const h = harness();
    const s = await shop(h, randomUUID());
    await s.setAll();
    await s.employee('E1');
    await s.shift('S1', at(WEEK[0]!, '09:00'), at(WEEK[0]!, '13:00'));
    await s.assign('S1');

    // Rostered but not published: nothing shown to the person, the shift counted as waiting.
    expect(await s.mine()).toMatchObject({ count: 0, notYetPublished: 1 });
    expect(await s.weekState()).toBe('not_published');
    expect((await s.publish('P1')).status).toBe(201);
    expect(await s.weekState()).toBe('published');
    const seen = await s.mine();
    expect(seen).toMatchObject({ count: 1, notYetPublished: 0 });
    expect(seen.weeks).toEqual([{ branchId: 'b1', weekStart: WEEK[0], weekEnd: WEEK[6], limitsNotChecked: [] }]);

    // The verifier's (b): after the clean publish the manager stretches S1 to 06:00–23:00. The week needs publishing at
    // once and the person no longer sees it — neither the old nor the new time.
    await s.shift('S1', at(WEEK[0]!, '06:00'), at(WEEK[0]!, '23:00'));
    expect(await s.weekState()).toBe('needs_publishing');
    expect(await s.mine()).toMatchObject({ count: 0, notYetPublished: 1 });
    const pubs = (await s.call('GET', '/v1/hr/compliance/roster-publications', 'u-mgr', undefined, undefined, { branchId: 'b1' })).body as { publications: { publicationId: string; state: string }[]; weeks: { state: string }[] };
    expect(pubs.publications.map((p) => `${p.publicationId}:${p.state}`)).toEqual(['P1:roster_changed_since']);
    expect(pubs.weeks.map((w) => w.state)).toEqual(['needs_publishing']);
    // It is checked again before staff see it: the edited week breaks the limits, so it cannot be published.
    expect(codeOf(await s.publish('P2'))).toBe('roster_breaks_working_time_limits');
    expect(await s.mine()).toMatchObject({ count: 0 });
    // Fixed and published again: the person sees the corrected shift.
    await s.shift('S1', at(WEEK[0]!, '09:00'), at(WEEK[0]!, '14:00'));
    expect((await s.publish('P3')).status).toBe(201);
    const after = await s.mine();
    expect(after.count).toBe(1);
    expect(after.shifts[0]!.endsAt).toBe(at(WEEK[0]!, '14:00'));

    // A new shift in the week is an edit, and so is a new assignment to it.
    await s.shift('S2', at(WEEK[1]!, '09:00'), at(WEEK[1]!, '13:00'));
    expect(await s.weekState()).toBe('needs_publishing');
    expect((await s.publish('P4')).status).toBe(201);
    await s.assign('S2');
    expect(await s.weekState()).toBe('needs_publishing');
    expect(await s.mine()).toMatchObject({ count: 0, notYetPublished: 2 });
    expect((await s.publish('P5')).status).toBe(201);
    expect(await s.mine()).toMatchObject({ count: 2, notYetPublished: 0 });
  });

  it('NEW-3 (c): deactivating a person does not let a breaking week through, and reactivating does not revive a publication', async () => {
    const h = harness();
    const s = await shop(h, randomUUID());
    await s.setAll();
    await s.employee('E1');
    for (const [i, d] of WEEK.entries()) { await s.shift(`D${i}`, at(d, '09:00'), at(d, '17:00')); await s.assign(`D${i}`); }
    expect(codeOf(await s.publish('P1'))).toBe('roster_breaks_working_time_limits');
    await s.employee('E1', false);
    const inactive = await s.publish('P2');
    expect(inactive.status).toBe(422);
    expect((inactive.body as { error: { whatHappened: string } }).error.whatHappened).toContain('Person E1 (marked inactive) has 0 day(s) off');
    await s.employee('E1', true);
    expect(((await s.call('GET', '/v1/hr/compliance/roster-publications', 'u-mgr')).body as { count: number }).count).toBe(0);
    expect(await s.mine()).toMatchObject({ count: 0, notYetPublished: 7 });
  });

  it('OB-155 / OB-152: pending limits are published as NOT checked and shown to staff; a filled limit is enforced', async () => {
    const h = harness();
    const s = await shop(h, randomUUID());
    await s.employee('E1');
    // Only the daily cap is filled. A 10-hour day breaks it — refused, whatever is still pending.
    await s.setLimit('maxDailyWorkMinutes');
    await s.shift('L', at(WEEK[0]!, '08:00'), at(WEEK[0]!, '18:00'));
    await s.assign('L');
    const refused = await s.publish('P1');
    expect(refused.status).toBe(422);
    expect((refused.body as { breaches: { rule: string }[] }).breaches.map((b) => b.rule)).toEqual(['maxDailyWorkMinutes']);
    expect((refused.body as { notChecked: { key: string }[] }).notChecked.map((n) => n.key)).toEqual(['weeklyHolidayMinDays', 'maxWeeklyWorkMinutes', 'maxSpreadOverMinutes', 'maxContinuousWorkMinutes', 'minRestIntervalMinutes']);

    await s.shift('L', at(WEEK[0]!, '08:00'), at(WEEK[0]!, '16:00'));
    const ok = await s.publish('P2');
    expect(ok.status).toBe(201);
    expect((ok.body as { publication: { limitsNotChecked: { key: string }[] } }).publication.limitsNotChecked.map((n) => n.key)).toHaveLength(5);
    // The roster the person sees says which limits were not checked.
    const seen = await s.mine();
    expect(seen.count).toBe(1);
    expect(seen.weeks[0]!.limitsNotChecked).toContain('Weekly holiday — whole days off each person must have in every week');
    // So do the registers.
    for (const reg of ['attendance', 'holidays']) {
      const r = await s.call('GET', `/v1/hr/compliance/registers/${reg}`, 'u-owner', undefined, undefined, { from: WEEK[0]!, to: WEEK[6]! });
      expect(r.status).toBe(200);
      expect((r.body as { limitsNotChecked: { key: string }[] }).limitsNotChecked).toHaveLength(5);
    }
    const settings = (await s.call('GET', '/v1/hr/compliance/working-time/settings', 'u-mgr')).body as { limitsNotChecked: unknown[] };
    expect(settings.limitsNotChecked).toHaveLength(5);
  });

  it('OB-156: casual, sick, festival and unpaid leave — owner-set, recorded as not checked until filled, then checked with carry-over', async () => {
    const h = harness();
    const s = await shop(h, randomUUID());
    await s.employee('E1');
    const settings = (await s.call('GET', '/v1/hr/compliance/working-time/settings', 'u-owner')).body as { leaveTypes: { key: string; status: string }[] };
    expect(settings.leaveTypes.map((t) => `${t.key}:${t.status}`)).toEqual(['casual:pending', 'sick:pending', 'festival:pending', 'unpaid:pending']);

    // Pending: recorded, said to be not checked.
    const first = await s.call('POST', '/v1/hr/compliance/leave/E1/2026-02-02', 'u-mgr', { leaveType: 'casual' }, 'lv1');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ check: 'not_checked', leave: { leaveType: 'casual', kind: 'taken' } });
    expect((first.body as { notCheckedBecause: string }).notCheckedBecause).toContain('the days a year');

    // Only the owner fills a type; a manager is refused; a malformed one is refused by name.
    expect((await s.call('POST', '/v1/hr/compliance/working-time/settings/leave-casual', 'u-mgr', { daysPerYear: 2, carryOverMaxDays: 0, source: 'x', confirmation: 'y' }, 'm1')).status).toBe(403);
    expect(codeOf(await s.call('POST', '/v1/hr/compliance/working-time/settings/leave-casual', 'u-owner', { daysPerYear: -1, carryOverMaxDays: 0 }, 'o0'))).toBe('not_a_leave_type_setting');
    expect((await s.call('POST', '/v1/hr/compliance/working-time/settings/leave-casual', 'u-owner', { daysPerYear: 2, carryOverMaxDays: 0, source: 'synthetic provision', confirmation: 'synthetic confirmation' }, 'o1')).status).toBe(200);

    // Filled: checked — 2 a year; the second day fits, the third is refused.
    const second = await s.call('POST', '/v1/hr/compliance/leave/E1/2026-02-03', 'u-mgr', { leaveType: 'casual' }, 'lv2');
    expect(second.body).toMatchObject({ check: 'checked', balanceAfter: 0 });
    const third = await s.call('POST', '/v1/hr/compliance/leave/E1/2026-02-04', 'u-mgr', { leaveType: 'casual' }, 'lv3');
    expect(third.status).toBe(422);
    expect(codeOf(third)).toBe('leave_beyond_entitlement');
    // One leave a day: another kind on a day already on leave is refused, never silently replaced.
    expect(codeOf(await s.call('POST', '/v1/hr/compliance/leave/E1/2026-02-03', 'u-mgr', { leaveType: 'sick' }, 'lv4'))).toBe('other_leave_on_that_day');
    // The leave register shows each type for the year, checked or not.
    const reg = (await s.call('GET', '/v1/hr/compliance/registers/leave', 'u-owner', undefined, undefined, { asOf: '2026-12-31' })).body as { rows: { otherLeave: { type: string; check: string; taken: number; balance: number | null }[] }[]; leaveTypesNotChecked: { key: string }[] };
    expect(reg.rows[0]!.otherLeave.map((x) => `${x.type}:${x.check}:${x.taken}:${x.balance}`)).toEqual(['casual:checked:2:0', 'sick:not_checked:0:null', 'festival:not_checked:0:null', 'unpaid:not_checked:0:null']);
    expect(reg.leaveTypesNotChecked.map((x) => x.key)).toEqual(['sick', 'festival', 'unpaid']);
    // A cancellation compensates and frees the day.
    expect((await s.call('POST', '/v1/hr/compliance/leave/E1/2026-02-03', 'u-mgr', { kind: 'cancelled' }, 'lv5')).body).toMatchObject({ leave: { kind: 'cancelled', leaveType: 'casual' } });
    expect((await s.call('POST', '/v1/hr/compliance/leave/E1/2026-02-04', 'u-mgr', { leaveType: 'casual' }, 'lv6')).status).toBe(200);
  });
});
