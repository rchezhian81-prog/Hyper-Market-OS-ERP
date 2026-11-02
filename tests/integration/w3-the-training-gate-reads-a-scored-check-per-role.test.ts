import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';

// W3 · OB-675 (QG-02 · roadmap §2.3 "Training success ≥ 90% role assessment (pilot) / ≥ 95% (final)"; §22 QG-02 "cashier
// training/performance targets proven"). Through the real API, in memory and — with DATABASE_URL — on real PostgreSQL,
// with a cold restart:
//
//   • QG-02 on the gate register is blocked while the cashier role has no check, no pass mark, or nobody trained — never a
//     pass from nothing; a GO is refused over it;
//   • a manager sets the check (questions and observed tasks); only the OWNER sets the pass mark ("not set" until he does);
//   • a trainer records each attempt item by item; the score is worked out by head office; nobody records their own;
//     the attempts are kept (append-only) and a retake is a new attempt — the latest counts;
//   • 9 of 10 trained cashiers passed (90%): the pilot level holds, so R2 is clear of QG-02 while R3 (final, 95%) still is
//     blocked, naming who did not pass; the retake brings it to 10 of 10 and R3 clears too; a restart reads the same.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
type Standing = { gate: string; blockers: { ref: string; reason: string }[] };

describe.each(backings)('the training gate reads a scored check per role (QG-02 · OB-675) — on $name', ({ harness }) => {
  it('not set → check and pass mark → attempts → pilot passes, final does not → retake → both pass', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash-01', 'cashier', ['br-1']);
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(userId.startsWith('u-cash') ? { branchId: 'br-1' } : {}), ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const cashiers = Array.from({ length: 10 }, (_, i) => `u-cash-${String(i + 1).padStart(2, '0')}`);
    for (const [i, id] of cashiers.entries()) await ok(call('POST', `/v1/hr/workforce/employees/${id}`, 'u-owner', { name: `Cashier ${i + 1}`, branchId: 'br-1', roles: ['cashier'], active: true }), `employee ${id}`);
    await ok(call('POST', '/v1/hr/workforce/employees/u-mgr', 'u-owner', { name: 'Bala', branchId: 'br-1', roles: ['store_manager'], active: true }), 'manager');
    const qg02 = async (release: string): Promise<Standing> =>
      ((await ok(call('GET', '/v1/compliance/gate-register', 'u-owner', undefined, { release }), `register ${release}`)).body as { gates: Standing[] }).gates.find((g) => g.gate === 'QG-02')!;
    const reading = async () => (await ok(call('GET', '/v1/hr/workforce/role-checks', 'u-mgr'), 'role checks')).body as { roles: { roleId: string; check: unknown; passMarkPercent: number | null; trained: { employeeId: string; latest: { scorePercent: number; passed: boolean } | null }[]; passedCount: number; pilot: string; final: string; why: string[] }[]; levels: { pilotPercent: number; finalPercent: number } };

    // ── nothing set: not passed, by name; a GO is refused over it ──
    let cashier = (await reading()).roles.find((r) => r.roleId === 'cashier')!;
    expect([cashier.check, cashier.passMarkPercent, cashier.trained, cashier.pilot]).toEqual([null, null, [], 'not_passed']);
    expect(cashier.why).toEqual(['cashier: no check has been set for this role', 'cashier: the pass mark is not set — the owner sets it', 'cashier: nobody is trained for this role yet']);
    expect((await qg02('R2')).blockers.map((b) => b.ref)).toEqual(expect.arrayContaining(['role-check:cashier', 'role-check:store_manager']));
    expect(codeOf(await call('POST', '/v1/compliance/gate-decisions/QG-02/R2', 'u-owner', { decision: 'GO', evidence: [{ label: 'x', ref: 'y' }], rationale: 'try' }))).toBe('go_refused_while_blocked');
    expect((await call('GET', '/v1/hr/workforce/role-checks', 'u-cash-01')).status, 'a cashier cannot read the staff reading').toBe(403);

    // ── the check (a manager), the pass mark (the owner only) ──
    const items = [
      { itemId: 'q1', kind: 'question', text: 'The scanner cannot read a barcode — what do you do?' },
      { itemId: 'q2', kind: 'question', text: 'When is a manager needed for a refund?' },
      { itemId: 't1', kind: 'task', text: 'Ring up a weighed item' },
      { itemId: 't2', kind: 'task', text: 'Count the drawer at the close' },
    ];
    expect((await call('POST', '/v1/hr/workforce/role-checks/cashier', 'u-cash-01', { items })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/hr/workforce/role-checks/cashier', 'u-mgr', { items: [] }))).toBe('not_readable_as_a_check');
    expect(codeOf(await call('POST', '/v1/hr/workforce/role-checks/cahsier', 'u-mgr', { items }))).toBe('role_not_known');
    await ok(call('POST', '/v1/hr/workforce/role-checks/cashier', 'u-mgr', { items }), 'check');
    // An attempt before the pass mark is set cannot be judged.
    const all = (fail: string[] = []) => items.map((i) => ({ itemId: i.itemId, passed: !fail.includes(i.itemId) }));
    expect(codeOf(await call('POST', `/v1/hr/workforce/role-checks/cashier/attempts/A-${randomUUID()}`, 'u-mgr', { employeeId: 'u-cash-01', results: all() }))).toBe('pass_mark_not_set');
    expect((await call('POST', '/v1/hr/workforce/role-checks/cashier/pass-mark', 'u-mgr', { passMarkPercent: 75 })).status, 'only the owner sets the pass mark').toBe(403);
    expect(codeOf(await call('POST', '/v1/hr/workforce/role-checks/cashier/pass-mark', 'u-owner', { passMarkPercent: 0 }))).toBe('not_readable_as_a_pass_mark');
    await ok(call('POST', '/v1/hr/workforce/role-checks/cashier/pass-mark', 'u-owner', { passMarkPercent: 75 }), 'pass mark');

    // ── attempts: scored here, never one's own, item by item ──
    expect(codeOf(await call('POST', `/v1/hr/workforce/role-checks/cashier/attempts/A-${randomUUID()}`, 'u-mgr', { employeeId: 'u-cash-01', results: all().slice(1) }))).toBe('results_do_not_match_the_check');
    expect((await call('POST', `/v1/hr/workforce/role-checks/cashier/attempts/A-${randomUUID()}`, 'u-mgr', { employeeId: 'u-ghost', results: all() })).status).toBe(404);
    await h.provisionRole(T, 'u-cash-02', 'store_manager'); // a cashier who also manages training cannot record her own
    expect(codeOf(await call('POST', `/v1/hr/workforce/role-checks/cashier/attempts/A-${randomUUID()}`, 'u-cash-02', { employeeId: 'u-cash-02', results: all() }))).toBe('cannot_record_own_attempt');
    for (const id of cashiers) {
      const r = await ok(call('POST', `/v1/hr/workforce/role-checks/cashier/attempts/A-${id}-1`, 'u-mgr', { employeeId: id, results: id === 'u-cash-07' ? all(['q2', 't2']) : all(['q1']) }), `attempt ${id}`);
      expect((r.body as { attempt: { scorePercent: number; passed: boolean } }).attempt).toMatchObject(id === 'u-cash-07' ? { scorePercent: 50, passed: false } : { scorePercent: 75, passed: true });
    }
    // The same attempt id again is the same attempt (idempotent), never a second one.
    expect(((await ok(call('POST', '/v1/hr/workforce/role-checks/cashier/attempts/A-u-cash-01-1', 'u-mgr', { employeeId: 'u-cash-01', results: all() }), 'again')).body as { alreadyRecorded?: boolean }).alreadyRecorded).toBe(true);

    cashier = (await reading()).roles.find((r) => r.roleId === 'cashier')!;
    expect([cashier.passMarkPercent, cashier.trained.length, cashier.passedCount, cashier.pilot, cashier.final]).toEqual([75, 10, 9, 'passed', 'not_passed']);
    expect(cashier.why[0]).toMatch(/9 of 10 trained passed \(90%\) — below the final 95%; not passed: Cashier 7 \(u-cash-07, 50%\)/);
    // The pilot (R2) is clear of the cashier role; after the pilot (R3) it is not.
    expect((await qg02('R2')).blockers.map((b) => b.ref)).not.toContain('role-check:cashier');
    expect((await qg02('R3')).blockers.map((b) => b.ref)).toContain('role-check:cashier:final');

    // ── a retake is a new attempt; the latest counts; both attempts are kept ──
    await ok(call('POST', '/v1/hr/workforce/role-checks/cashier/attempts/A-u-cash-07-2', 'u-mgr', { employeeId: 'u-cash-07', results: all(), note: 'retake after a week' }), 'retake');
    h = harness(h); // a cold restart over the same records
    cashier = (await reading()).roles.find((r) => r.roleId === 'cashier')!;
    expect([cashier.passedCount, cashier.pilot, cashier.final, cashier.why]).toEqual([10, 'passed', 'passed', []]);
    const history = (await ok(call('GET', '/v1/hr/workforce/role-checks/cashier/attempts', 'u-mgr'), 'history')).body as { attempts: { attemptId: string; employeeId: string; scorePercent: number }[] };
    expect(history.attempts.filter((a) => a.employeeId === 'u-cash-07').map((a) => [a.attemptId, a.scorePercent])).toEqual([['A-u-cash-07-1', 50], ['A-u-cash-07-2', 100]]);
    for (const r of ['R2', 'R3']) expect((await qg02(r)).blockers.map((b) => b.ref), r).not.toEqual(expect.arrayContaining(['role-check:cashier', 'role-check:cashier:final']));
    // The store manager role still has no check: QG-02 stays blocked by it, by name.
    expect((await qg02('R3')).blockers.map((b) => b.ref)).toContain('role-check:store_manager');
  }, 120_000);
});
