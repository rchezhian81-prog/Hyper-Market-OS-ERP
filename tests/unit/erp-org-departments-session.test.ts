import { describe, it, expect } from 'vitest';
import {
  createOrgDepartmentsSession, requestLine, reportLines, orgDeptOutcomeWords, ORG_DEPT_COPY, ORG_DEPT_COPY_KEYS,
  type OrgDepartmentsHttp, type LinkRequest,
} from '../../apps/web-erp/src/org-departments-session';
import type { HttpAnswer } from '../../apps/web-erp/src/finance-close-session';

// M01-FR-01 · M02-FR-02: the Departments part of the Organisation page — a thin client over head office's department
// routes. Saying which categories a department owns ALWAYS names the owner's approval (kind org_structure_change, never the
// asker): the page asks for EXACTLY the list it will send, then sends it naming the approval number. Synthetic data only.

const IT_ADMIN = ['org.branch.read', 'platform.setup.write'];
const MANAGER = ['org.branch.read', 'reporting.report.read'];

function fakeHttp(answers: Record<string, HttpAnswer>, fallback: HttpAnswer = { status: 201, body: {} }): OrgDepartmentsHttp & { calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    get: async (path) => { calls.push({ method: 'GET', path }); return answers[`GET ${path}`] ?? fallback; },
    post: async (path, body) => { calls.push({ method: 'POST', path, body }); return answers[`POST ${path}`] ?? fallback; },
  };
}

describe('the Departments part of the Organisation page (M01-FR-01)', () => {
  it('every word has a Tamil twin, and none is left in English', () => {
    for (const k of ORG_DEPT_COPY_KEYS) {
      expect(ORG_DEPT_COPY.ta[k].trim(), k).not.toBe('');
      expect(ORG_DEPT_COPY.ta[k], k).not.toBe(ORG_DEPT_COPY.en[k]);
    }
    expect(Object.keys(ORG_DEPT_COPY.ta).sort()).toEqual([...ORG_DEPT_COPY_KEYS].sort());
  });

  it('asks the owner for EXACTLY the list the change will send (unique, sorted), then sends it naming the approval number', async () => {
    const approved: LinkRequest = {
      requestId: 'areq-7', kind: 'org_structure_change', subjectRef: 'department:D-dairy', status: 'approved', decidedBy: 'u-owner', requestedAt: '2026-11-01T05:00:00Z',
      details: { categoryIds: ['cheese', 'dairy-cat'], reason: 'dairy counter', departmentId: 'D-dairy' },
    };
    const http = fakeHttp({
      'GET /v1/approvals/requests': { status: 200, body: { mine: [
        approved,
        { requestId: 'areq-8', kind: 'org_structure_change', subjectRef: 'B-1', status: 'waiting', requestedAt: '2026-11-01T06:00:00Z', details: { nodeId: 'B-1', action: 'activate' } },
        { requestId: 'areq-9', kind: 'org_structure_change', subjectRef: 'department:D-grocery', status: 'waiting', requestedAt: '2026-11-01T06:00:00Z', details: { categoryIds: [], reason: 'x', departmentId: 'D-grocery' } },
      ] } },
      'POST /v1/org/departments/D-dairy/categories': { status: 201, body: { departmentId: 'D-dairy', categoryIds: ['cheese', 'dairy-cat'], approvedBy: 'u-owner', approvalId: 'areq-7' } },
    });
    const s = createOrgDepartmentsSession({ permissions: IT_ADMIN }, http);
    expect(s.may).toEqual({ read: true, link: true, report: false });
    expect(await s.askLink({ departmentId: 'D-dairy', categoryIds: ['dairy-cat'], reason: ' ' })).toEqual({ kind: 'invalid', detail: 'reason' });
    expect(await s.askLink({ departmentId: '', categoryIds: ['dairy-cat'], reason: 'x' })).toEqual({ kind: 'invalid', detail: 'department' });
    expect(http.calls).toEqual([]);
    const asked = await s.askLink({ departmentId: 'D-dairy', categoryIds: ['dairy-cat', ' cheese ', 'dairy-cat'], reason: ' dairy counter ' });
    expect(orgDeptOutcomeWords('en', asked, 'ask').text).toMatch(/^Asked\. The owner decides it on the Approvals page/);
    expect(http.calls[0]).toEqual({ method: 'POST', path: '/v1/approvals/requests', body: {
      kind: 'org_structure_change', subjectRef: 'department:D-dairy', valueMinor: null,
      details: { categoryIds: ['cheese', 'dairy-cat'], reason: 'dairy counter', departmentId: 'D-dairy' },
      summary: 'Department D-dairy owns: cheese, dairy-cat', reason: 'dairy counter',
    } });
    const mine = await s.myRequests('D-dairy');
    expect(mine.kind === 'done' ? mine.body.map((r) => r.requestId) : mine).toEqual(['areq-7']); // never another department's, never an activation
    expect(requestLine('en', approved)).toBe('Approval number areq-7: cheese, dairy-cat — approved by u-owner');
    expect(requestLine('ta', { ...approved, status: 'waiting', details: { ...approved.details, categoryIds: [] } })).toBe('ஒப்புதல் எண் areq-7: எதுவுமில்லை — உரிமையாளருக்காகக் காத்திருக்கிறது');
    const saved = await s.saveApprovedLink(approved);
    expect(http.calls.at(-1)).toEqual({ method: 'POST', path: '/v1/org/departments/D-dairy/categories', body: { categoryIds: ['cheese', 'dairy-cat'], reason: 'dairy counter', approvalId: 'areq-7' } });
    expect(orgDeptOutcomeWords('en', saved, 'link').text).toBe('Saved at head office with the owner’s approval (u-owner).');
    expect(JSON.stringify(http.calls)).not.toContain('approvedBy');
  });

  it('a refusal is head office\'s own words; without setup rights nothing is sent; unreachable says nothing was saved', async () => {
    const refusing = fakeHttp({ 'POST /v1/org/departments/D-grocery/categories': { status: 409, body: { error: { code: 'category_owned_by_another_department', whatHappened: 'dairy-cat belongs to D-dairy — a category belongs to one department, or its sales would count twice.', nextSafeAction: 'Nothing was changed.' } } } });
    const s = createOrgDepartmentsSession({ permissions: IT_ADMIN }, refusing);
    const out = await s.saveApprovedLink({ requestId: 'areq-1', kind: 'org_structure_change', subjectRef: 'department:D-grocery', status: 'approved', requestedAt: '', details: { categoryIds: ['dairy-cat'], reason: 'x', departmentId: 'D-grocery' } });
    expect(orgDeptOutcomeWords('en', out, 'link').text).toBe('Head office refused: dairy-cat belongs to D-dairy — a category belongs to one department, or its sales would count twice. Nothing was changed.');
    const http = fakeHttp({});
    const reader = createOrgDepartmentsSession({ permissions: MANAGER }, http);
    const no = await reader.askLink({ departmentId: 'D-dairy', categoryIds: [], reason: 'x' });
    expect(orgDeptOutcomeWords('en', no, 'ask').text).toBe('Your role cannot change what a department owns.');
    expect(http.calls).toEqual([]);
    const down = createOrgDepartmentsSession({ permissions: IT_ADMIN }, fakeHttp({}, { status: 0, body: null }));
    expect(orgDeptOutcomeWords('en', await down.askLink({ departmentId: 'D-dairy', categoryIds: [], reason: 'x' }), 'ask').text).toBe('Head office cannot be reached — nothing was saved. Try again when the connection is back.');
    expect(orgDeptOutcomeWords('en', await down.departments(), 'read').text).toBe('Head office cannot be reached — it could not be read, so nothing is shown.');
  });

  it('reads one department\'s report for a day (or head office\'s today), and says it in plain lines with the unowned apart', async () => {
    const report = { departmentId: 'D-dairy', name: 'Dairy', tradingDay: '2030-05-20', categoryIds: ['dairy-cat'], products: [{ productId: 'p-milk', name: 'Milk 500 ml', quantityMinor: 2, valueMinor: 10_000, bills: 1 }], totalValueMinor: 10_000, unownedValueMinor: 5_000 };
    const http = fakeHttp({
      'GET /v1/org/departments/D-dairy/report?day=2030-05-20': { status: 200, body: report },
      'GET /v1/org/departments/D-dairy/report': { status: 200, body: { ...report, tradingDay: '2030-05-21', products: [], totalValueMinor: 0, unownedValueMinor: 0 } },
    });
    const s = createOrgDepartmentsSession({ permissions: MANAGER }, http);
    const out = await s.report('D-dairy', '2030-05-20');
    if (out.kind !== 'done') throw new Error('expected a report');
    expect(reportLines('en', out.body)).toEqual({ total: 'Dairy on 2030-05-20: ₹100.00', lines: ['Milk 500 ml: 2 sold on 1 bills, ₹100.00'], unowned: 'Sold that day in categories no department owns: ₹50.00' });
    const today = await s.report('D-dairy', '');
    if (today.kind !== 'done') throw new Error('expected a report');
    expect(reportLines('en', today.body).lines).toEqual(['No sale of this department’s products that day.']);
    expect(await s.report('D-dairy', '20/05/2030')).toEqual({ kind: 'invalid', detail: 'day' });
    expect(http.calls.map((c) => c.path)).toEqual(['/v1/org/departments/D-dairy/report?day=2030-05-20', '/v1/org/departments/D-dairy/report']);
    const it = createOrgDepartmentsSession({ permissions: IT_ADMIN }, fakeHttp({}));
    expect(orgDeptOutcomeWords('en', await it.report('D-dairy', ''), 'read').text).toBe('Your role cannot read reports.');
    expect(reportLines('en', { ...report, products: [], note: 'x' }).note).toBe('This department owns no categories yet, so nothing is counted to it.');
  });
});
