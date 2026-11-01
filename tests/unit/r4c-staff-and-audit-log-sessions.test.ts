import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createStaffSession, readNeeds, readRoles, STAFF_COPY } from '../../apps/web-erp/src/staff-session';
import { createAuditLogSession, auditRowOf, AUDIT_LOG_COPY } from '../../apps/web-erp/src/audit-log-session';
import { apiHarness } from '../support/api-harness';
import { aBranch } from '../support/a-branch';

/** Round 4c: the Staff list and Audit log sessions — what they refuse before sending, and exactly what they send. */

function fakeHeadOffice() {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ employee: { employeeId: 'u-a', name: 'A', branchId: 's1', roles: ['cashier'], active: true }, matches: [] }) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

describe('the Staff list session', () => {
  it('every word has a Tamil twin; needs and roles are read strictly', () => {
    expect(Object.keys(STAFF_COPY.ta).sort()).toEqual(Object.keys(STAFF_COPY.en).sort());
    expect(readNeeds('Cashier 2, picker x1')).toEqual([{ role: 'cashier', count: 2 }, { role: 'picker', count: 1 }]);
    expect(readNeeds('cashier')).toBeUndefined();
    expect(readNeeds('cashier 0')).toBeUndefined();
    expect(readRoles(' Cashier, picker, cashier ')).toEqual(['cashier', 'picker']);
  });

  it('refuses before sending, then sends the staff record and the shift on the shop\'s clock', async () => {
    const ho = fakeHeadOffice();
    expect(await createStaffSession({ viewer: { userId: 'u-c', permissions: ['workforce.roster.read'] }, fetch: ho.fetch }).save({ employeeId: 'x', name: 'x', branchId: 's1', roles: 'cashier', active: true })).toEqual({ result: 'invalid', why: 'cannotManage' });
    const s = createStaffSession({ viewer: { userId: 'u-m', permissions: ['workforce.roster.read', 'workforce.roster.manage'] }, fetch: ho.fetch, newId: () => 'shift-1', timeZone: 'Asia/Kolkata' });
    expect(await s.save({ employeeId: 'u-a', name: 'A', branchId: 's1', roles: ' ', active: true })).toEqual({ result: 'invalid', why: 'needRoles' });
    expect(await s.createShift({ branchId: 's1', startsAt: '2026-11-02T17:00', endsAt: '2026-11-02T09:00', needs: 'cashier 1' })).toEqual({ result: 'invalid', why: 'endsFirst' });
    expect(ho.sent).toEqual([]);
    await s.save({ employeeId: ' u-a ', name: ' A ', branchId: 's1', roles: 'Cashier', active: true });
    await s.createShift({ branchId: 's1', startsAt: '2026-11-02T09:00', endsAt: '2026-11-02T17:00', needs: 'cashier 1' });
    expect(ho.sent).toEqual([
      { method: 'POST', path: '/v1/hr/workforce/employees/u-a', body: { name: 'A', branchId: 's1', roles: ['cashier'], active: true } },
      { method: 'POST', path: '/v1/hr/workforce/shifts/shift-1', body: { branchId: 's1', startsAt: '2026-11-02T03:30:00.000Z', endsAt: '2026-11-02T11:30:00.000Z', requiredRoles: [{ role: 'cashier', count: 1 }] } },
    ]);
  });

  it('head office keeps a person\'s pay rate when a change from the Staff list carries none, and records who changed what', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await aBranch(h, T, 'u-owner', 's1');
    const post = (body: unknown) => h.request({ method: 'POST', path: '/v1/hr/workforce/employees/u-a', userId: 'u-owner', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
    expect((await post({ name: 'A', branchId: 's1', roles: ['cashier'], active: true, hourlyRateMinor: 12_000 })).status).toBe(200);
    const changed = await post({ name: 'A', branchId: 's1', roles: ['cashier', 'picker'], active: true });
    expect(changed.body).toMatchObject({ employee: { roles: ['cashier', 'picker'], hourlyRateMinor: 12_000 } });
    const trail = (await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'employee' } })).body as { matches: { action: string; after: Record<string, string> }[] };
    expect(trail.matches.map((r) => r.action)).toEqual(['staff.add', 'staff.change']);
    // The rate's figure is never written into the trail.
    expect(JSON.stringify(trail.matches)).not.toContain('12000');
  });
});

describe('the Audit log session', () => {
  it('every word has a Tamil twin; a search sends only what was typed, a shop day reaching its end', async () => {
    expect(Object.keys(AUDIT_LOG_COPY.ta).sort()).toEqual(Object.keys(AUDIT_LOG_COPY.en).sort());
    const ho = fakeHeadOffice();
    const s = createAuditLogSession({ viewer: { userId: 'u-o', permissions: ['audit.retention.read'] }, fetch: ho.fetch });
    expect(await s.search({ from: '1 Nov' })).toEqual({ result: 'invalid', why: 'badDate' });
    await s.search({ actorId: ' u-m ', until: '2026-10-31' });
    expect(ho.sent.map((x) => x.path)).toEqual(['/v1/audit/trail?actorId=u-m&until=2026-10-31T23%3A59%3A59.999Z']);
    expect(ho.sent.every((x) => x.method === 'GET')).toBe(true);
    expect(await createAuditLogSession({ viewer: { userId: 'u-m', permissions: [] }, fetch: ho.fetch }).verify()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(auditRowOf({ sequence: 1 })).toBeUndefined();
  });
});
