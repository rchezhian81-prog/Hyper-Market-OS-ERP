import { describe, it, expect } from 'vitest';
import { createAuditLogSession } from '../../apps/web-erp/src/audit-log-session';

// U7 (OB-726) · the Audit log reads ONE page of head office's trail at a time through the register's loader: the
// page's own boxes (who, what, which thing, shop days) still narrow it, the register's search and sort go to head office,
// and with no sort chosen the newest record comes first — as the page always showed it. The shop-day window (Group A,
// U7) is kept: "until 31 Oct" runs to the shop's next midnight.

const OWNER = { userId: 'u-owner', permissions: ['audit.retention.read'] };
const rec = (sequence: number) => ({ sequence, at: '2026-10-31T05:00:00.000Z', actorId: 'u-owner', action: 'role.grant', objectType: 'user', objectId: 'u-new', origin: { branchId: null }, before: null, after: { roleId: 'cashier' } });

function fake(body: unknown, status = 200) {
  const asked: string[] = [];
  const fetch = (async (url: string) => { asked.push(String(url)); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof globalThis.fetch;
  return { asked, fetch };
}

describe('the Audit log session reads one page', () => {
  it('sends the page\'s boxes with the register\'s page, newest first when no sort is chosen, and reads the total', async () => {
    const f = fake({ matches: [rec(9), rec(8)], total: 31, paging: { page: 1, size: 10, total: 31, pages: 4 } });
    const s = createAuditLogSession({ viewer: OWNER, fetch: f.fetch });
    const out = await s.page({ action: 'role.grant', until: '2026-10-31' }, { page: 0, size: 10, search: '', sort: null, dir: 'asc' });
    expect(f.asked).toEqual(['/v1/audit/trail?action=role.grant&until=2026-10-31T18%3A30%3A00.000Z&page=1&size=10&sort=sequence&dir=desc']);
    expect(out.result).toBe('ok');
    if (out.result !== 'ok') return;
    expect(out.value.total).toBe(31);
    expect(out.value.rows.map((r) => r.sequence)).toEqual([9, 8]);
  });

  it('sorts by the column chosen, at head office, and searches there', async () => {
    const f = fake({ matches: [], total: 0, paging: { page: 2, size: 10, total: 0, pages: 0 } });
    const s = createAuditLogSession({ viewer: OWNER, fetch: f.fetch });
    await s.page({}, { page: 1, size: 10, search: 'ravi', sort: 'who', dir: 'asc' });
    expect(f.asked).toEqual(['/v1/audit/trail?page=2&size=10&search=ravi&sort=actorId&dir=asc']);
  });

  it('refuses a wrong date before asking, and a person who may not read is told so', async () => {
    const f = fake({});
    expect(await createAuditLogSession({ viewer: OWNER, fetch: f.fetch }).page({ from: '31/10/2026' }, { page: 0, size: 10, search: '', sort: null, dir: 'asc' })).toEqual({ result: 'invalid', why: 'badDate' });
    expect(await createAuditLogSession({ viewer: { userId: 'u-c', permissions: [] }, fetch: f.fetch }).page({}, { page: 0, size: 10, search: '', sort: null, dir: 'asc' })).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(f.asked).toEqual([]);
  });
});
