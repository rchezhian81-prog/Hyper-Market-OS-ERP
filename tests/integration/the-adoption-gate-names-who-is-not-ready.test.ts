import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';

// QG-09 Adoption · M25-FR-01/03/04 · D11-FR-04 · OB-320 (owner, 23 Oct 2026: "the role curriculum is built from the
// SOP sheets and the owner guide, one list per role; the owner approves it on screen before it counts; until then QG-09
// reads not proven"). Through the real API, in memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.
//
//   • access matches assignment: a leaver still holding a till grant (critical), a manager not on the staff list, a
//     cashier rostered with no sign-in — each named; a cashier is refused the read (403);
//   • the curriculum is proposed from the shop's own sheets; nothing counts until the owner approves a role's list — the
//     gate reads NOT_PROVEN; a manager cannot approve (403);
//   • training: nobody records their own; competency is signed by a second person (not the trainee, not the trainer);
//   • SOPs: the shop's sheets are published with their words; a person acknowledges the CURRENT version for themselves;
//     an acknowledgement given on the store computer's help page is carried back, the person re-checked;
//   • floor support: the owner names a champion per department ("not set" until he does);
//   • the gate goes NOT_PROVEN → HOLD (every missing name) → GO, read again after a restart.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('the adoption gate names who is not ready (QG-09) — on $name', ({ harness }) => {
  it('access match → proposed curriculum → owner approves → training, competency, SOP acknowledgements, champions → HOLD with names → GO', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-mgr-b1', 'store_manager', ['br-1']);
    await h.provisionRole(T, 'u-mgr2', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier', ['br-1']);
    await h.provisionRole(T, 'u-left', 'cashier', ['br-1']);
    await h.provisionRole(T, 'box-1', 'store_computer', ['br-1']);
    await h.provisionRole(T, 'u-it', 'platform_admin');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(['u-cash', 'u-left', 'u-mgr-b1', 'box-1'].includes(userId) ? { branchId: 'br-1' } : {}), ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const employee = (id: string, name: string, roles: string[], active = true) => ok(call('POST', `/v1/hr/workforce/employees/${id}`, 'u-owner', { name, branchId: 'br-1', roles, active }), `employee ${id}`);
    await employee('u-cash', 'Asha', ['cashier']);
    await employee('u-mgr', 'Bala', ['store_manager']);
    await employee('u-left', 'Chitra', ['cashier'], false);
    await employee('u-new', 'Devi', ['cashier', 'opener']);

    // ── access matches assignment (M25-FR-01) ──
    expect((await call('GET', '/v1/hr/workforce/access-match', 'u-cash')).status).toBe(403);
    const access = (await ok(call('GET', '/v1/hr/workforce/access-match', 'u-owner'), 'access match')).body as { mismatches: { kind: string; severity: string; userId: string; roleId: string; detail: { en: string; ta: string } }[]; notCompared: { roleId: string }[] };
    expect(access.mismatches.map((m) => [m.severity, m.kind, m.userId, m.roleId])).toEqual([
      ['critical', 'leaver_still_has_access', 'u-left', 'cashier'],
      ['warning', 'not_on_staff_list', 'u-it', 'platform_admin'],
      ['warning', 'branch_outside_assignment', 'u-mgr', 'store_manager'], // rostered at br-1, holds every branch
      ['warning', 'not_on_staff_list', 'u-mgr-b1', 'store_manager'],
      ['warning', 'not_on_staff_list', 'u-mgr2', 'store_manager'],
      ['info', 'assignment_without_grant', 'u-new', 'cashier'],
    ]);
    expect(access.mismatches[0]!.detail.en).toBe('Chitra (u-left) has left but can still sign in as cashier. Take the access away now.');
    expect(access.notCompared.map((r) => r.roleId)).toEqual(['owner', 'store_computer']);
    // A manager of br-1 reads the people of br-1 only (no company-wide "not on the staff list").
    const brOne = (await ok(h.request({ method: 'GET', path: '/v1/hr/workforce/access-match', userId: 'u-mgr-b1', tenantId: T, branchId: 'br-1' }), 'br-1 access')).body as { mismatches: { kind: string; userId: string }[]; scope: string[] };
    expect([brOne.scope, brOne.mismatches.map((m) => [m.kind, m.userId])]).toEqual([['br-1'], [['leaver_still_has_access', 'u-left'], ['branch_outside_assignment', 'u-mgr'], ['assignment_without_grant', 'u-new']]]);
    await employee('u-new', 'Devi', ['opener']); // Devi is not a cashier after all — her duty is opening only

    // ── the curriculum: proposed from the sheets; NOT PROVEN until the owner approves ──
    const cur = (await ok(call('GET', '/v1/hr/workforce/curriculum', 'u-mgr'), 'curriculum')).body as { roles: { roleId: string; proposed: { itemId: string }[]; approved: unknown }[] };
    expect(cur.roles.map((r) => [r.roleId, r.proposed.map((i) => i.itemId).filter((i) => !i.startsWith('owner-guide')), r.approved])).toEqual([
      ['cashier', ['SOP-01', 'SOP-02', 'SOP-04'], null], ['owner', ['SOP-03', 'SOP-04'], null], ['store_manager', ['SOP-01', 'SOP-02'], null],
    ]);
    expect(cur.roles.find((r) => r.roleId === 'owner')!.proposed.some((i) => i.itemId === 'owner-guide-30')).toBe(true);
    expect((await ok(call('GET', '/v1/hr/workforce/adoption-gate', 'u-mgr'), 'gate')).body).toMatchObject({ gate: 'QG-09', verdict: 'NOT_PROVEN' });
    expect((await call('GET', '/v1/hr/workforce/adoption-gate', 'u-cash')).status).toBe(403);
    const item = (itemId: string) => ({ itemId, title: itemId, source: itemId });
    expect((await call('POST', '/v1/hr/workforce/curriculum/cashier', 'u-mgr', { items: [item('SOP-04')] })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/hr/workforce/curriculum/cashier', 'u-owner', { items: [] }))).toBe('not_readable_as_a_curriculum');
    // The owner approves each role's list — as he changed it (a shorter list for the pilot).
    await ok(call('POST', '/v1/hr/workforce/curriculum/cashier', 'u-owner', { items: [item('SOP-04')] }), 'cashier list');
    await ok(call('POST', '/v1/hr/workforce/curriculum/store_manager', 'u-owner', { items: [item('SOP-01')] }), 'manager list');
    await ok(call('POST', '/v1/hr/workforce/curriculum/owner', 'u-owner', { items: [item('SOP-03')] }), 'owner list');

    // ── SOPs: publish the shop's own sheets, with their words ──
    expect((await call('POST', '/v1/hr/workforce/help/built-in/SOP-01/publish', 'u-cash', {})).status).toBe(403);
    for (const id of ['SOP-01', 'SOP-03', 'SOP-04']) await ok(call('POST', `/v1/hr/workforce/help/built-in/${id}/publish`, 'u-mgr', {}), `publish ${id}`);
    const sheets = (await ok(call('GET', '/v1/hr/workforce/help/built-in', 'u-mgr'), 'sheets')).body as { sheets: { sopId: string; state: string }[] };
    expect(sheets.sheets.map((s) => [s.sopId, s.state])).toEqual([['SOP-01', 'published'], ['SOP-02', 'not_published'], ['SOP-03', 'published'], ['SOP-04', 'published']]);

    h = harness(h); // ── COLD RESTART ──
    const hold = (await ok(call('GET', '/v1/hr/workforce/adoption-gate', 'u-owner'), 'gate')).body as { verdict: string; roles: { roleId: string; verdict: string; gaps: { employeeId: string; notCompetent: string[]; notAcknowledged: string[] }[] }[]; why: string[]; floorSupport: { complete: boolean } };
    expect(hold.verdict).toBe('HOLD');
    expect(hold.roles.map((r) => [r.roleId, r.verdict, r.gaps.map((g) => [g.employeeId, g.notCompetent, g.notAcknowledged])])).toEqual([
      ['cashier', 'HOLD', [['u-cash', ['SOP-04'], ['SOP-01', 'SOP-04']]]],
      ['owner', 'HOLD', [['u-owner', ['SOP-03'], ['SOP-03', 'SOP-04']]]],
      ['store_manager', 'HOLD', [['u-mgr', ['SOP-01'], ['SOP-01']]]],
    ]);
    expect(hold.why).toContain('cashier: Asha (u-cash) not signed competent on SOP-04; has not acknowledged SOP-01, SOP-04.');
    expect(hold.why).toContain('Floor support: no departments are recorded, so no floor champion can be named (not set).');

    // ── training and competency ──
    const train = async (assignmentId: string, employeeId: string, itemId: string, trainer: string, signer: string) => {
      await ok(call('POST', `/v1/hr/workforce/training/${assignmentId}`, 'u-mgr2', { employeeId, itemId, title: itemId, dueOn: '2030-01-31' }), `assign ${assignmentId}`);
      await ok(call('POST', `/v1/hr/workforce/training/${assignmentId}/completion`, trainer, { evidenceRef: `sheet-signed-${assignmentId}` }), `complete ${assignmentId}`);
      await ok(call('POST', `/v1/hr/workforce/training/${assignmentId}/competency`, signer, { outcome: 'competent', note: 'watched them do it' }), `competent ${assignmentId}`);
    };
    await ok(call('POST', '/v1/hr/workforce/training/T-1', 'u-mgr', { employeeId: 'u-cash', itemId: 'SOP-04', title: 'Forgotten PIN' }), 'assign T-1');
    expect(codeOf(await call('POST', '/v1/hr/workforce/training/T-1/competency', 'u-mgr2', { outcome: 'competent' }))).toBe('not_completed_yet');
    expect((await call('POST', '/v1/hr/workforce/training/T-1/completion', 'u-cash', {})).status).toBe(403); // a cashier holds no training right
    await ok(call('POST', '/v1/hr/workforce/training/T-1/completion', 'u-mgr', {}), 'complete T-1');
    expect(codeOf(await call('POST', '/v1/hr/workforce/training/T-1/competency', 'u-mgr', { outcome: 'competent' }))).toBe('second_person_required');
    await ok(call('POST', '/v1/hr/workforce/training/T-1/competency', 'u-mgr2', { outcome: 'not_yet', note: 'unsure of step 5' }), 'not yet');
    expect(((await ok(call('GET', '/v1/hr/workforce/training', 'u-mgr', undefined, { employeeId: 'u-cash' }), 'rows')).body as { rows: { state: string }[] }).rows.map((r) => r.state)).toEqual(['not_yet_competent']);
    await ok(call('POST', '/v1/hr/workforce/training/T-1/competency', 'u-mgr2', { outcome: 'competent' }), 'competent T-1');
    expect(codeOf(await call('POST', '/v1/hr/workforce/training/T-9', 'u-mgr', { employeeId: 'u-left', itemId: 'SOP-04', title: 'x' }))).toBe('employee_has_left');
    await train('T-2', 'u-mgr', 'SOP-01', 'u-mgr2', 'u-owner');
    // The owner's own: a manager records it and another signs — the owner never signs his own.
    await ok(call('POST', '/v1/hr/workforce/training/T-3', 'u-mgr2', { employeeId: 'u-owner', itemId: 'SOP-03', title: 'Evening check' }), 'assign T-3');
    expect(codeOf(await call('POST', '/v1/hr/workforce/training/T-3/completion', 'u-owner', {}))).toBe('trainee_cannot_record_own_training');
    await ok(call('POST', '/v1/hr/workforce/training/T-3/completion', 'u-mgr2', {}), 'complete T-3');
    await ok(call('POST', '/v1/hr/workforce/training/T-3/competency', 'u-mgr', { outcome: 'competent' }), 'competent T-3');

    // ── SOP acknowledgements: for myself, the current version only; from the store computer, the person re-checked ──
    expect(codeOf(await call('POST', '/v1/hr/workforce/sops/SOP-01/acknowledge', 'u-cash', { version: 0 }))).toBe('not_the_current_version');
    expect(codeOf(await call('POST', '/v1/hr/workforce/sops/SOP-03/acknowledge', 'u-cash', { version: 1 }))).toBe('not_for_your_role');
    await ok(call('POST', '/v1/hr/workforce/sops/SOP-04/acknowledge', 'u-cash', { version: 1 }), 'ack SOP-04');
    const relayed = { sopId: 'SOP-01', employeeId: 'u-cash', version: 1, acknowledgedAt: new Date(Date.now() - 3_600_000).toISOString() };
    expect((await call('POST', '/v1/hr/workforce/sops/SOP-01/acknowledgements/u-cash/synced', 'u-cash', relayed)).status).toBe(403);
    expect((await ok(call('POST', '/v1/hr/workforce/sops/SOP-01/acknowledgements/u-cash/synced', 'box-1', relayed), 'relayed')).status).toBe(202);
    expect(codeOf(await call('POST', '/v1/hr/workforce/sops/SOP-01/acknowledgements/u-nobody/synced', 'box-1', { ...relayed, employeeId: 'u-nobody' }))).toBe('person_may_not_acknowledge');
    for (const [who, sop] of [['u-mgr', 'SOP-01'], ['u-owner', 'SOP-03'], ['u-owner', 'SOP-04']] as const) await ok(call('POST', `/v1/hr/workforce/sops/${sop}/acknowledge`, who, { version: 1 }), `ack ${who} ${sop}`);

    // ── floor support: a department and its champion (an owner input) ──
    await ok(call('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/br-1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' }), 'branch');
    await ok(call('POST', '/v1/org/nodes/D-groc', 'u-it', { kind: 'department', name: 'Grocery', parentId: 'br-1' }), 'department');
    const champs = (await ok(call('GET', '/v1/hr/workforce/floor-champions', 'u-mgr'), 'champions')).body as { departments: { departmentId: string; state: string }[] };
    expect(champs.departments).toEqual([expect.objectContaining({ departmentId: 'D-groc', state: 'not_set', employeeId: null })]);
    expect((await call('POST', '/v1/hr/workforce/floor-champions/D-groc', 'u-mgr', { employeeId: 'u-cash' })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/hr/workforce/floor-champions/D-groc', 'u-owner', { employeeId: 'u-left' }))).toBe('champion_not_on_staff_list');
    await ok(call('POST', '/v1/hr/workforce/floor-champions/D-groc', 'u-owner', { employeeId: 'u-cash' }), 'champion');

    h = harness(h); // ── COLD RESTART ──
    const go = (await ok(call('GET', '/v1/hr/workforce/adoption-gate', 'u-owner'), 'gate')).body as { verdict: string; why: string[]; roles: { verdict: string }[]; floorSupport: { complete: boolean; departments: { championName: string }[] } };
    expect([go.verdict, go.why, go.roles.map((r) => r.verdict), go.floorSupport.complete, go.floorSupport.departments[0]!.championName]).toEqual(['GO', [], ['GO', 'GO', 'GO'], true, 'Asha']);
    // Every act was sealed with its maker.
    const trail = (await ok(call('GET', '/v1/audit/trail', 'u-owner', undefined, { action: 'workforce.competency.signed' }), 'trail')).body as { matches: { actorId: string; objectId: string; after: Record<string, string> }[] };
    expect(trail.matches.map((m) => [m.actorId, m.objectId, m.after['outcome']])).toEqual([['u-mgr2', 'T-1', 'not_yet'], ['u-mgr2', 'T-1', 'competent'], ['u-owner', 'T-2', 'competent'], ['u-mgr', 'T-3', 'competent']]);

    // A new version of a sheet's role list re-opens the gate: the owner adds SOP-04 for the store manager.
    await ok(call('POST', '/v1/hr/workforce/curriculum/store_manager', 'u-owner', { items: [item('SOP-01'), item('SOP-04')] }), 'manager list v2');
    const again = (await ok(call('GET', '/v1/hr/workforce/adoption-gate', 'u-owner'), 'gate')).body as { verdict: string; why: string[] };
    expect([again.verdict, again.why]).toEqual(['HOLD', ['store_manager: Bala (u-mgr) not signed competent on SOP-04.']]);
  }, 180_000);
});
