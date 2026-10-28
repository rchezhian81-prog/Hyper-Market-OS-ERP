import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { addDays } from '../../packages/workforce/src/working-time';

// Round 7 · R7-D — head office's side, through the real API, in memory and (with DATABASE_URL) on real PostgreSQL, with
// cold restarts. Synthetic people only.
//   • OB-502 (M25-FR-03): recording a production / bakery run or a counter-food (weighed) run in the name of a person whose
//     food-handling certificate EXPIRED, or who has NONE (or only an unverified one), is refused in plain words naming the
//     certificate and its expiry; a renewed certificate lets it through; a run relayed from the store by such a person is
//     recorded (the food exists) and FLAGGED; the till and other work are untouched.
//   • OB-507 (M25-FR-01): the synced attendance-mark route — only the store computer relays; a mark it cannot read, for a
//     person not on the roster / not at its store / without the right, or dated in the future is refused by name; the same
//     mark again is one mark; a different mark under the same id is a conflict refused by name; an out-of-order mark is
//     booked and flagged; everything reads back the same after a restart.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const words = (r: Res): string => (r.body as { error?: { whatHappened?: string } }).error?.whatHappened ?? '';
const TODAY = shopDateIn(new Date().toISOString());

describe.each(backings)('OB-502 · OB-507 at head office — on $name', ({ harness }) => {
  it('an expired or missing food-handling certificate blocks recording food work, by name; a renewal lets it through; a relayed run is flagged', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-kumar', 'store_manager');
    await h.provisionRole(T, 'u-new', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-box', 'store_computer', ['br-1']);
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(userId === 'u-box' ? { branchId: 'br-1' } : {}), ...(method === 'POST' ? { idempotencyKey: key ?? `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/br-1', 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'branch');
    await ok(call('POST', '/v1/production/departments/cafe', 'u-owner', {}), 'cafe');
    await ok(call('POST', '/v1/production/recipes/r-cake', 'u-owner', { departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 1, outputUom: 'ea', inputs: [{ productId: 'FLOUR', quantityMinor: 100, uom: 'g' }], shelfLifeHours: 48 }), 'recipe');
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'seed-flour', productId: 'FLOUR', locationId: 'br-1', kind: 'received', quantityMinor: 5_000, uom: 'g', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), enteredBy: 'u-owner' }), 'flour');
    await ok(call('POST', '/v1/hr/workforce/employees/u-kumar', 'u-mgr', { name: 'Kumar', branchId: 'br-1', roles: ['cook'], active: true }), 'kumar');
    await ok(call('POST', '/v1/hr/workforce/employees/u-new', 'u-mgr', { name: 'Devi', branchId: 'br-1', roles: ['cook'], active: true }), 'devi');
    const expired = addDays(TODAY, -3);
    await ok(call('POST', '/v1/hr/workforce/certifications/C-K1', 'u-mgr', { employeeId: 'u-kumar', kind: 'food_handling', issuedOn: '2025-01-01', validUntil: expired, verifiedBy: 'u-mgr' }), 'kumar cert');
    // Devi's certificate was typed in but nobody verified it: it is not cover.
    await ok(call('POST', '/v1/hr/workforce/certifications/C-D1', 'u-mgr', { employeeId: 'u-new', kind: 'food-handling', issuedOn: '2026-01-01', validUntil: addDays(TODAY, 300) }), 'devi unverified');
    const runBody = (id: string) => ({ recipeId: 'r-cake', batches: 1, actualOutputMinor: 1, outputBatchId: `CAKE-${id}`, locationId: 'br-1' });

    // ── Kumar: EXPIRED — the run is refused, naming the certificate and the day it expired ──
    const k = await call('POST', '/v1/production/runs/run-k', 'u-kumar', runBody('k'));
    expect([k.status, codeOf(k)]).toEqual([422, 'food_handling_certificate_expired']);
    expect(words(k)).toContain(`Kumar's food-handling certificate expired on ${expired}`);
    expect(words(k)).toContain('Nothing was saved');
    // ── Devi: an UNVERIFIED certificate is no certificate; the owner, with no staff record at all, has none either ──
    expect(codeOf(await call('POST', '/v1/production/runs/run-d', 'u-new', runBody('d')))).toBe('food_handling_certificate_missing');
    const owner = await call('POST', '/v1/production/runs/run-o', 'u-owner', runBody('o'));
    expect(codeOf(owner)).toBe('food_handling_certificate_missing');
    expect(words(owner)).toContain('There is no verified food-handling certificate on file for u-owner');
    // ── counter food (a weighed run) is refused the same way ──
    const weigh = (id: string, userId: string) => call('POST', `/v1/production/weighed-runs/${id}`, userId, { departmentId: 'meat_fish', inputs: [{ productId: 'CHICKEN', weightGrams: 2_000, costPerKg: { minor: 18_000, currency: 'INR' } }], outputs: [{ productId: 'CUTS', weightGrams: 1_900 }] });
    expect(codeOf(await weigh('w-k', 'u-kumar'))).toBe('food_handling_certificate_expired');
    // Nothing was recorded for any refused run.
    expect(((await call('GET', '/v1/production/runs', 'u-owner')).body as { runs: unknown[] }).runs).toHaveLength(0);
    // A cashier is still refused by permission first (403), as before — the till and other work are untouched.
    expect((await call('POST', '/v1/production/runs/run-c', 'u-cash', runBody('c'))).status).toBe(403);

    h = harness(h); // ── COLD RESTART: the certificates are read back from the register ──
    expect(codeOf(await call('POST', '/v1/production/runs/run-k', 'u-kumar', runBody('k')))).toBe('food_handling_certificate_expired');
    // ── the manager records Kumar's RENEWED certificate: the same run now goes through ──
    await ok(call('POST', '/v1/hr/workforce/certifications/C-K2', 'u-mgr', { employeeId: 'u-kumar', kind: 'Food Handling', issuedOn: TODAY, validUntil: addDays(TODAY, 365), verifiedBy: 'u-mgr' }), 'renewal');
    expect((await call('POST', '/v1/production/runs/run-k', 'u-kumar', runBody('k'))).status).toBe(201);
    expect((await weigh('w-k', 'u-kumar')).status).toBe(201);

    // ── a run RELAYED from the store by Devi (unverified certificate): recorded — the food exists — and FLAGGED ──
    const relayed = await call('POST', '/v1/production/runs/run-r/synced', 'u-box', { runId: 'run-r', storeId: 'br-1', ...runBody('r'), producedBy: 'u-new', at: new Date(Date.now() - 60_000).toISOString(), source: 'production-screen' }, 'relay-r');
    expect(relayed.status, JSON.stringify(relayed.body)).toBe(202);
    h = harness(h); // ── COLD RESTART ──
    const board = ((await call('GET', '/v1/production/runs', 'u-owner')).body as { runs: { runId: string; syncFlags?: string[] }[] }).runs;
    expect(board.find((r) => r.runId === 'run-r')?.syncFlags).toContain('producer_food_certificate_not_valid');
    expect(board.find((r) => r.runId === 'run-k')?.syncFlags ?? []).not.toContain('producer_food_certificate_not_valid');
  });

  it('attendance marks relayed by the store computer: refusals by name, one mark per id, a conflict refused, out-of-order flagged — across a restart', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-rani', 'cashier', ['br-1']);
    await h.provisionRole(T, 'u-other', 'cashier', ['br-2']);
    await h.provisionRole(T, 'u-box', 'store_computer', ['br-1']);
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>, key?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(userId === 'u-box' || userId === 'u-rani' ? { branchId: 'br-1' } : {}), ...(method === 'POST' ? { idempotencyKey: key ?? `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(call('POST', '/v1/hr/workforce/employees/u-rani', 'u-mgr', { name: 'Rani', branchId: 'br-1', roles: ['cashier'], active: true }), 'rani');
    await ok(call('POST', '/v1/hr/workforce/employees/u-other', 'u-mgr', { name: 'Other', branchId: 'br-2', roles: ['cashier'], active: true }), 'other');
    await ok(call('POST', '/v1/hr/workforce/employees/u-left', 'u-mgr', { name: 'Gone', branchId: 'br-1', roles: ['cashier'], active: false }), 'leaver');
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const FIRST_IN = at(240);
    const markOf = (markId: string, over: Record<string, unknown> = {}) => ({ markId, employeeId: 'u-rani', kind: 'in', method: 'pin', at: FIRST_IN, storeId: 'br-1', source: 'self-service-screen', ...over });
    const relay = (markId: string, body: Record<string, unknown>, key = `relay-${markId}-${randomUUID()}`) => call('POST', `/v1/hr/workforce/attendance-marks/${markId}/synced`, 'u-box', body, undefined, key);

    // Only the store computer relays: a person (even the manager) cannot use the box's door.
    expect((await call('POST', '/v1/hr/workforce/attendance-marks/M-1/synced', 'u-mgr', markOf('M-1'))).status).toBe(403);
    expect((await call('POST', '/v1/hr/workforce/attendance-marks/M-1/synced', 'u-rani', markOf('M-1'))).status).toBe(403);
    // Malformed: the id must match, in/out only, PIN only, a real time, the store named. An identity number is never taken.
    for (const bad of [markOf('M-X'), markOf('M-1', { kind: 'lunch' }), markOf('M-1', { method: 'fingerprint' }), markOf('M-1', { at: 'yesterday' }), markOf('M-1', { storeId: '' })]) {
      expect(codeOf(await relay('M-1', bad))).toBe('not_readable_as_a_relayed_attendance_mark');
    }
    expect(codeOf(await relay('M-1', markOf('M-1', { aadhaarNumber: '0000' })))).toBe('identity_number_not_collected');
    expect(codeOf(await relay('M-1', markOf('M-1', { at: new Date(Date.now() + 3_600_000).toISOString() })))).toBe('mark_in_the_future');
    expect(codeOf(await relay('M-9', markOf('M-9', { employeeId: 'u-ghost' })))).toBe('person_not_on_the_roster');
    expect((await relay('M-8', markOf('M-8', { employeeId: 'u-other' }))).status).toBe(403); // another store's person — not this box's business
    expect(codeOf(await relay('M-7', markOf('M-7', { employeeId: 'u-left' })))).toBe('person_may_not_mark_attendance'); // holds no sign-in

    // The mark: booked once, as Rani's own, carried by the box.
    const first = await relay('M-1', markOf('M-1'), 'relay-M-1');
    expect(first.status).toBe(202);
    expect((first.body as { mark: Record<string, unknown> }).mark).toMatchObject({ markId: 'M-1', employeeId: 'u-rani', kind: 'in', method: 'pin', recordedBy: 'u-rani', relayed: { relayedBy: 'u-box', storeId: 'br-1' } });
    expect((first.body as { mark: Record<string, unknown> }).mark['exceptions']).toBeUndefined();
    // The same mark again (a re-send under a new key, after a lost reply): one mark.
    { const again = await relay('M-1', markOf('M-1')); expect(again.body, JSON.stringify(again.body)).toMatchObject({ alreadyRecorded: true }); }

    h = harness(h); // ── COLD RESTART ──
    // A DIFFERENT mark under the same id: a conflict, refused by name — never a silent overwrite.
    const conflict = await relay('M-1', markOf('M-1', { kind: 'out' }));
    expect([conflict.status, codeOf(conflict)]).toEqual([422, 'mark_conflicts_with_record']);
    expect(words(conflict)).toContain('The two cannot both be right');
    // A second "in" with no "out" between: booked (it happened) and flagged for the manager.
    expect(((await ok(relay('M-2', markOf('M-2', { at: at(200) })), 'second in')).body as { mark: { exceptions?: string[] } }).mark.exceptions).toEqual(['repeats_the_last_mark']);
    expect(((await ok(relay('M-3', markOf('M-3', { kind: 'out', at: at(10) })), 'out')).body as { mark: { exceptions?: string[] } }).mark.exceptions).toBeUndefined();

    h = harness(h); // ── COLD RESTART ──
    const day = shopDateIn(FIRST_IN);
    const read = (await ok(call('GET', '/v1/hr/workforce/attendance-marks', 'u-mgr', undefined, { date: day }), 'marks')).body as { marks: { markId: string; kind: string; exceptions?: string[] }[]; withExceptions: number };
    const mine = read.marks.filter((m) => m.markId.startsWith('M-'));
    expect(mine.map((m) => m.markId).sort()).toEqual(day === shopDateIn(at(10)) ? ['M-1', 'M-2', 'M-3'] : ['M-1', 'M-2']);
    expect(mine.find((m) => m.markId === 'M-1')?.kind).toBe('in'); // the conflict changed nothing
    expect(read.withExceptions).toBe(1);
  });
});
