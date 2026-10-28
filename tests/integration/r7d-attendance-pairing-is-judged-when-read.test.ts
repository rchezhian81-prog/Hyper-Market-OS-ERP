import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { addDays } from '../../packages/workforce/src/working-time';

// Round 7 · OB-507 follow-up — attendance "out of order" exceptions are judged when the manager READS the day, from every
// mark head office holds, never frozen on the record when a mark happened to arrive. Through the real API, in memory and
// (with DATABASE_URL) on real PostgreSQL, across cold restarts. Synthetic people only.
//   • an "out" that reaches head office BEFORE its "in" (two devices) is flagged until the "in" arrives — then it clears,
//     and the stored record is untouched (what was seen on arrival stays visible as `flaggedOnArrival`, hard rule #2);
//   • a rostered NIGHT shift (in 22:00, out 06:00 the next day) pairs across midnight with no exception;
//   • without a night shift on the roster the same-day rule stands;
//   • real exceptions stay visible: an out with no in at all; an in with no out once the day (or the shift) is over.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
type Read = { marks: { markId: string; employeeId: string; kind: string; exceptions?: string[]; flaggedOnArrival?: string[] }[]; withExceptions: number };
const IST = (day: string, hhmm: string): string => new Date(Date.parse(`${day}T${hhmm}:00+05:30`)).toISOString();

describe.each(backings)('OB-507 · attendance pairing is judged when read — on $name', ({ harness }) => {
  it('a late-arriving "in" clears the out\'s exception; a rostered night shift pairs across midnight; real exceptions stay', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    for (const p of ['u-rani', 'u-night', 'u-nonight', 'u-lone']) await h.provisionRole(T, p, 'cashier', ['br-1']);
    await h.provisionRole(T, 'u-box', 'store_computer', ['br-1']);
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(userId === 'u-box' ? { branchId: 'br-1' } : {}), ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    for (const [id, name] of [['u-rani', 'Rani'], ['u-night', 'Murugan'], ['u-nonight', 'Kavitha'], ['u-lone', 'Senthil']] as const) {
      await ok(call('POST', `/v1/hr/workforce/employees/${id}`, 'u-mgr', { name, branchId: 'br-1', roles: ['cashier'], active: true }), name);
    }
    const relay = (markId: string, employeeId: string, kind: 'in' | 'out', at: string) =>
      ok(call('POST', `/v1/hr/workforce/attendance-marks/${markId}/synced`, 'u-box', { markId, employeeId, kind, method: 'pin', at, storeId: 'br-1', source: 'self-service-screen' }), markId);
    const read = async (date: string): Promise<Read> => (await ok(call('GET', '/v1/hr/workforce/attendance-marks', 'u-mgr', undefined, { date }), `read ${date}`)).body as Read;
    const exOf = (r: Read, markId: string) => r.marks.find((m) => m.markId === markId)?.exceptions ?? [];

    const TODAY = shopDateIn(new Date().toISOString());
    const D = addDays(TODAY, -4); // days well in the past: every shift on them is over
    const D1 = addDays(D, 1);

    // ── (a) Rani's "out" reaches head office BEFORE her "in" (marked on two screens) ──
    await relay('R-OUT', 'u-rani', 'out', IST(D, '17:00'));
    let day = await read(D);
    expect(exOf(day, 'R-OUT')).toEqual(['out_without_in']); // flagged while the in is missing — it is
    expect(day.withExceptions).toBe(1);
    await relay('R-IN', 'u-rani', 'in', IST(D, '09:00'));
    h = harness(h); // ── COLD RESTART ──
    day = await read(D);
    expect(exOf(day, 'R-OUT')).toEqual([]); // the in arrived: the pair is whole, no exception
    expect(exOf(day, 'R-IN')).toEqual([]);
    expect(day.marks.find((m) => m.markId === 'R-OUT')?.flaggedOnArrival).toEqual(['out_without_in']); // the record is untouched
    expect(day.withExceptions).toBe(0);

    // ── (b) Murugan's night shift is on the roster: 22:00 on D to 06:00 on D+1 ──
    await ok(call('POST', '/v1/hr/workforce/shifts/SH-N', 'u-mgr', { branchId: 'br-1', startsAt: IST(D, '22:00'), endsAt: IST(D1, '06:00'), requiredRoles: [{ role: 'cashier', count: 1 }] }), 'night shift');
    await ok(call('POST', '/v1/hr/workforce/shifts/SH-N/assignments/u-night', 'u-mgr', { role: 'cashier' }), 'assign night');
    await relay('N-IN', 'u-night', 'in', IST(D, '21:55'));
    await relay('N-OUT', 'u-night', 'out', IST(D1, '06:05'));
    // ── … Kavitha works the same hours with NO night shift on the roster: the same-day rule stands ──
    await relay('K-IN', 'u-nonight', 'in', IST(D, '21:55'));
    await relay('K-OUT', 'u-nonight', 'out', IST(D1, '06:05'));
    // ── … Senthil: an "out" with no "in" at all, on D+1 — a real exception ──
    await relay('S-OUT', 'u-lone', 'out', IST(D1, '13:00'));

    h = harness(h); // ── COLD RESTART ──
    day = await read(D);
    expect(exOf(day, 'N-IN')).toEqual([]); // his out came the next morning, inside the rostered shift
    expect(exOf(day, 'K-IN')).toEqual(['in_without_out']); // no night shift rostered: the day ended with no out
    expect(exOf(day, 'R-OUT')).toEqual([]);
    expect(day.withExceptions).toBe(1);
    const next = await read(D1);
    expect(exOf(next, 'N-OUT')).toEqual([]); // paired across midnight — no exception
    expect(exOf(next, 'K-OUT')).toEqual(['out_without_in']);
    expect(exOf(next, 'S-OUT')).toEqual(['out_without_in']); // a real out with no in stays visible
    expect(next.withExceptions).toBe(2);
  });
});
