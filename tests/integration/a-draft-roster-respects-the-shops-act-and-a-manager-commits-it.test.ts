import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';

/**
 * D-9 (R3, OB-142 "A", OB-181) — on the real API, in memory and on PostgreSQL, with a cold restart: "from hourly sales
 * history, a forecast of staff hours needed per role per hour-slot for the next week. A draft roster meeting it within
 * labour-law limits (max daily and weekly hours, spread-over, weekly holiday) that a manager commits (P-05). Each uncovered
 * slot or rule breach is listed by name. Actual attendance versus the roster is reported." Cost is reported, not capped.
 */
const backings = r3OpsBackings();
const WEEK = '2026-10-05'; // a Monday, already past, so actual attendance can be recorded
const IST = 330;
const at = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00Z`) - IST * 60_000).toISOString();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.each(backings)('a draft roster meets the forecast within the Shops Act limits and a manager commits it — on $name (D-9)', ({ harness, restart }) => {
  it('standard → forecast → draft (pending limits named) → limits in force leave named gaps → manager commits → actuals vs roster', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-anu', 'cashier');
    const { req, ok, code } = tenantClient(() => h, T);
    for (const [id, name, rate] of [['u-anu', 'Anu', 10_000], ['u-bala', 'Bala', undefined], ['u-chitra', 'Chitra', 12_000]] as const) {
      await ok(req('POST', `/v1/hr/workforce/employees/${id}`, { name, branchId: 'S1', roles: ['cashier'], active: true, ...(rate === undefined ? {} : { hourlyRateMinor: rate }) }), `employee ${id}`);
    }
    // Eight weeks of bills at S1: one at 10:xx and two at 18:xx store time, every day.
    let n = 0;
    for (let i = 56; i >= 1; i--) {
      const day = addDays(WEEK, -i);
      for (const hhmm of ['10:15', '18:05', '18:40']) {
        n += 1;
        await ok(req('POST', '/v1/sales', {
          saleId: `S-${n}`, receiptNumber: `R-${n}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: day, committedAt: at(day, hhmm),
          totalMinor: 1_000, currency: 'INR', packVersion: 1,
          lines: [{ productId: 'p-tea', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }], tenders: [{ kind: 'cash', amountMinor: 1_000 }],
        }), `sale ${n}`);
      }
    }
    const q = { branchId: 'S1', weekStart: WEEK };
    // ── the forecast: the owner's service standard first, else said; Monday weeks only ─────────────────────────
    const before = (await ok(req('GET', '/v1/hr/workforce/labour-demand', undefined, 'u-mgr', q), 'demand before')).body as { slots: unknown[]; rolesNotForecast: { role: string }[]; workingTime: { allPending: boolean } };
    expect(before.slots).toEqual([]);
    expect(before.rolesNotForecast).toEqual([{ role: 'cashier', reason: 'standard_not_set' }]);
    expect(before.workingTime.allPending).toBe(true); // the CA has not filled the limits yet: shown, not invented
    expect((await req('POST', '/v1/hr/workforce/labour-standards/cashier', { billsPerStaffHour: 1 }, 'u-mgr')).status).toBe(403);
    await ok(req('POST', '/v1/hr/workforce/labour-standards/cashier', { billsPerStaffHour: 1 }), 'standard');
    expect(code(await req('GET', '/v1/hr/workforce/labour-demand', undefined, 'u-mgr', { branchId: 'S1', weekStart: '2026-10-06' }))).toBe('roster_week_starts_on_monday');
    const demand = (await ok(req('GET', '/v1/hr/workforce/labour-demand', undefined, 'u-mgr', q), 'demand')).body as { slots: { date: string; hour: number; staffNeeded: number }[]; staffHoursByRole: Record<string, number> };
    expect(demand.staffHoursByRole).toEqual({ cashier: 21 });
    expect(demand.slots.filter((s) => s.date === WEEK).map((s) => [s.hour, s.staffNeeded])).toEqual([[10, 1], [18, 2]]);

    // ── a draft with every limit pending: covered, each limit named "not checked" ───────────────────────────────
    const d1 = (await ok(req('POST', '/v1/hr/workforce/schedule-drafts/dr-1', q, 'u-mgr'), 'draft 1')).body as { draft: { draft: { uncovered: unknown[]; notChecked: { key: string }[]; assignments: unknown[] } }; committed: boolean };
    expect(d1.committed).toBe(false);
    expect(d1.draft.draft.uncovered).toEqual([]);
    expect(d1.draft.draft.assignments).toHaveLength(21);
    expect(d1.draft.draft.notChecked.map((x) => x.key)).toContain('maxWeeklyWorkMinutes');
    expect(((await req('GET', '/v1/hr/workforce/roster')).body as { shifts: unknown[] }).shifts).toEqual([]); // a draft rosters nobody

    // ── the CA's limits in force: the weekly cap and the weekly holiday leave gaps, each named ──────────────────
    for (const [k, v] of [['weeklyHolidayMinDays', 1], ['maxWeeklyWorkMinutes', 300]] as const) {
      await ok(req('POST', `/v1/hr/compliance/working-time/settings/${k}`, { value: v, source: 'synthetic provision', confirmation: 'synthetic CA reference' }), `limit ${k}`);
    }

    h = restart(h); // ── COLD RESTART ──────────────────────────────────────────────────────────────────────────

    const d2 = (await ok(req('POST', '/v1/hr/workforce/schedule-drafts/dr-2', q, 'u-mgr'), 'draft 2')).body as { draft: { draft: {
      uncovered: { detail: string; role: string; date: string }[]; breaches: unknown[]; assignments: { employeeId: string; shiftId: string }[];
      cost: { capped: boolean; notCostedPeople: string[]; knownMinor: number }; staffHoursNeeded: number; staffHoursRostered: number;
    } } };
    const draft = d2.draft.draft;
    expect(draft.assignments).toHaveLength(15);
    expect(draft.uncovered).toHaveLength(6);
    for (const u of draft.uncovered) expect(u.detail).toMatch(/^2026-10-\d\d \d\d:00–\d\d:00 needs one more cashier: /);
    expect(draft.breaches).toEqual([]);
    expect(draft).toMatchObject({ staffHoursNeeded: 21, staffHoursRostered: 15, cost: { capped: false, notCostedPeople: ['u-bala'] } });

    // ── a manager commits; a cashier cannot ─────────────────────────────────────────────────────────────────────
    expect((await req('POST', '/v1/hr/workforce/schedule-drafts/dr-2/commit', {}, 'u-anu')).status).toBe(403);
    // The first draft was made before the limits were in force: judged again now, it breaks them, so it cannot be committed.
    expect(code(await req('POST', '/v1/hr/workforce/schedule-drafts/dr-1/commit', {}, 'u-mgr'))).toBe('roster_breaks_working_time_limits');
    const committed = (await ok(req('POST', '/v1/hr/workforce/schedule-drafts/dr-2/commit', {}, 'u-mgr'), 'commit')).body as { rostered: { shifts: number; assignments: number } };
    expect(committed.rostered).toEqual({ shifts: 15, assignments: 15 });
    const roster = (await req('GET', '/v1/hr/workforce/roster')).body as { shifts: { shiftId: string }[]; assignments: { shiftId: string; employeeId: string }[] };
    expect(roster.assignments).toHaveLength(15);
    expect((await ok(req('POST', '/v1/hr/workforce/schedule-drafts/dr-2/commit', {}, 'u-mgr'), 'again')).body).toMatchObject({ alreadyCommitted: true });
    // A draft made before this commit is now stale: the roster it was checked against has changed.
    await ok(req('POST', '/v1/hr/workforce/schedule-drafts/dr-3', q, 'u-mgr'), 'draft 3');
    await ok(req('POST', '/v1/hr/workforce/shifts/extra-1', { branchId: 'S1', startsAt: at(WEEK, '07:00'), endsAt: at(WEEK, '08:00'), requiredRoles: [{ role: 'cashier', count: 1 }] }, 'u-mgr'), 'manual shift');
    expect(code(await req('POST', '/v1/hr/workforce/schedule-drafts/dr-3/commit', {}, 'u-mgr'))).toBe('roster_changed_since_draft');
    // The committed week checks clean against the R2 roster check.
    const check = (await req('GET', '/v1/hr/compliance/roster-check', undefined, 'u-mgr', q)).body as { breaches: unknown[] };
    expect(check.breaches).toEqual([]);

    // ── actual attendance against the roster (C21 marks by PIN, or recorded hours, or not recorded) ──────────────
    const anuMonday = draft.assignments.find((a) => a.employeeId === 'u-anu' && a.shiftId.includes(`-${WEEK}-`))!;
    const hour = Number(anuMonday.shiftId.split('-').at(-1));
    const hh = (x: number) => `${String(x).padStart(2, '0')}:00`;
    await ok(req('POST', '/v1/hr/workforce/attendance-marks/mk-1', { employeeId: 'u-anu', kind: 'in', method: 'pin', at: at(WEEK, hh(hour)) }, 'u-anu'), 'in');
    await ok(req('POST', '/v1/hr/workforce/attendance-marks/mk-2', { employeeId: 'u-anu', kind: 'out', method: 'pin', at: at(WEEK, hh(hour + 1)) }, 'u-anu'), 'out');
    const actuals = (await ok(req('GET', '/v1/hr/workforce/schedule/actuals', undefined, 'u-mgr', q), 'actuals')).body as { rows: { employeeId: string; date: string; status: string; source: string }[]; summary: Record<string, number> };
    expect(actuals.rows.find((r) => r.employeeId === 'u-anu' && r.date === WEEK)).toMatchObject({ status: 'as_rostered', source: 'attendance_marks' });
    expect(actuals.summary.asRostered).toBe(1);
    expect(actuals.summary.notRecorded).toBe(14); // the rest of the rostered days: said, never read as zero
  }, 180_000);
});
