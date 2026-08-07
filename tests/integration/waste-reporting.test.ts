import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Waste & sustainability reporting, end to end through the real API (M28-FR-04, API-04). A store reports
// "waste down 18%" and waste is not down — RECORDING is down, because the careful manager went on leave.
// So coverage sits on the FACE of the report: below 80% of expected departments the total is
// `not_comparable` in those words and the silent departments are NAMED, and a period comparison REFUSES
// to call a fall an improvement when coverage moved. Waste is valued and broken down by source and
// department. Proves the wired reporting surface against the real pipeline and real RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const EXPECTED = [
  { branchId: 'BR1', departmentId: 'produce' },
  { branchId: 'BR1', departmentId: 'bakery' },
  { branchId: 'BR1', departmentId: 'dairy' },
];
const NAMES = { produce: 'Produce', bakery: 'Bakery', dairy: 'Dairy' };

const setCoverage = (h: ApiHarness, tenantId: string, userId: string, key = 'cov') =>
  h.request({ method: 'POST', path: '/v1/waste/coverage', userId, tenantId, idempotencyKey: key, body: { expected: EXPECTED, departmentNames: NAMES } });
const record = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/waste/records/${id}`, userId, tenantId, idempotencyKey: `w-${id}`, body });
const report = (h: ApiHarness, tenantId: string, userId: string, branchId: string, from: string, to: string) =>
  h.request({ method: 'GET', path: '/v1/waste/report', userId, tenantId, query: { branchId, from, to } });
const compare = (h: ApiHarness, tenantId: string, userId: string, branchId: string, from1: string, to1: string, from2: string, to2: string) =>
  h.request({ method: 'GET', path: '/v1/waste/compare', userId, tenantId, query: { branchId, from1, to1, from2, to2 } });

const w = (dept: string, source: string, valueMinor: number, grams: number, disposal: string, at: string) =>
  ({ branchId: 'BR1', departmentId: dept, productId: `p-${dept}`, source, valueMinor, grams, disposal, at });

interface Report { totalWasteValueMinor: number; coverageBps: number; confidence: string; notReporting: string[]; diversionBps: number | 'not_meaningful'; bySource: { key: string; valueMinor: number }[]; byDepartment: { label: string; valueMinor: number }[]; caveat?: string }
interface Trend { changeBps: number | 'not_meaningful'; direction: string; detail: string }

describe('waste reporting: coverage on the face, not_comparable below 80%, disputes on trend (M28-FR-04)', () => {
  it('reports a reliable total with a valued breakdown and a landfill-diversion rate', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setCoverage(h, A, 'u-owner');
    await record(h, A, 'u-owner', 'w1', w('produce', 'expiry', 180_000, 5_000, 'landfill', '2026-08-03T09:00:00Z'));
    await record(h, A, 'u-owner', 'w2', w('bakery', 'damage', 40_000, 1_000, 'donated', '2026-08-04T09:00:00Z'));
    await record(h, A, 'u-owner', 'w3', w('dairy', 'expiry', 20_000, 500, 'recycled', '2026-08-05T09:00:00Z'));

    const r = (await report(h, A, 'u-owner', 'BR1', '2026-08-01', '2026-08-31')).body as Report;
    expect(r.coverageBps).toBe(10_000);       // all three departments reported
    expect(r.confidence).toBe('reliable');
    expect(r.totalWasteValueMinor).toBe(240_000);
    expect(r.bySource[0]?.key).toBe('expiry'); // 180,000 + 20,000 = the biggest cause
    expect(r.byDepartment[0]?.label).toBe('Produce');
    expect(r.diversionBps).toBe(2_307);        // (1,000 donated + 500 recycled) of 6,500 weighed = 23.07%
    expect(r.caveat).toBeUndefined();
  });

  it('calls a total on partial coverage NOT comparable, and names the departments that went quiet', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setCoverage(h, A, 'u-owner');
    // Only produce logged anything — bakery and dairy are silent, so this total means less RECORDING.
    await record(h, A, 'u-owner', 'w1', w('produce', 'expiry', 180_000, 5_000, 'landfill', '2026-08-03T09:00:00Z'));

    const r = (await report(h, A, 'u-owner', 'BR1', '2026-08-01', '2026-08-31')).body as Report;
    expect(r.coverageBps).toBe(3_333);         // 1 of 3
    expect(r.confidence).toBe('not_comparable');
    expect(r.notReporting).toEqual(['Bakery', 'Dairy']);
    expect(r.caveat).toContain('NOT comparable');
  });

  it('compares like with like, and refuses to call a fall an improvement when coverage moved', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setCoverage(h, A, 'u-owner');
    // June: all three report, 180,000 total. July: all three report, 140,000 total. May: only produce.
    for (const [dept, val] of [['produce', 100_000], ['bakery', 50_000], ['dairy', 30_000]] as const) {
      await record(h, A, 'u-owner', `jun-${dept}`, w(dept, 'expiry', val, 100, 'landfill', '2026-06-10T09:00:00Z'));
    }
    for (const [dept, val] of [['produce', 80_000], ['bakery', 40_000], ['dairy', 20_000]] as const) {
      await record(h, A, 'u-owner', `jul-${dept}`, w(dept, 'expiry', val, 100, 'landfill', '2026-07-10T09:00:00Z'));
    }
    await record(h, A, 'u-owner', 'may-produce', w('produce', 'expiry', 90_000, 100, 'landfill', '2026-05-10T09:00:00Z'));

    // June (100% coverage) vs July (100% coverage): comparable → a real improvement.
    const like = (await compare(h, A, 'u-owner', 'BR1', '2026-06-01', '2026-06-30', '2026-07-01', '2026-07-31')).body as Trend;
    expect(like.direction).toBe('improved');
    expect(typeof like.changeBps).toBe('number');

    // June (100%) vs May (33%): coverage moved → we CANNOT tell, and it says so.
    const moved = (await compare(h, A, 'u-owner', 'BR1', '2026-06-01', '2026-06-30', '2026-05-01', '2026-05-31')).body as Trend;
    expect(moved.direction).toBe('unknown');
    expect(moved.changeBps).toBe('not_meaningful');
    expect(moved.detail).toContain('CANNOT');
  });

  it('is authorized (record vs read split), per-tenant, and refuses malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');   // neither records nor reads
    await h.provisionRole(A, 'u-acct', 'accountant'); // reads reports, does NOT log waste (SoD)
    await setCoverage(h, A, 'u-owner');

    expect((await record(h, A, 'u-cash', 'wx', w('produce', 'expiry', 1, 1, 'landfill', '2026-08-03T09:00:00Z'))).status).toBe(403);
    expect((await record(h, A, 'u-acct', 'wy', w('produce', 'expiry', 1, 1, 'landfill', '2026-08-03T09:00:00Z'))).status).toBe(403);
    expect((await report(h, A, 'u-acct', 'BR1', '2026-08-01', '2026-08-31')).status).toBe(200); // an accountant may read
    expect((await report(h, A, 'u-cash', 'BR1', '2026-08-01', '2026-08-31')).status).toBe(403);
    expect((await report(h, A, 'u-owner', 'BR1', 'not-a-date', '2026-08-31')).status).toBe(400);
    expect((await record(h, A, 'u-owner', 'wbad', w('produce', 'nonsense', 1, 1, 'landfill', '2026-08-03T09:00:00Z'))).status).toBe(400);

    await h.seedOwner(B, 'u-owner-b');
    expect(((await report(h, B, 'u-owner-b', 'BR1', '2026-08-01', '2026-08-31')).body as Report).totalWasteValueMinor).toBe(0);
  });
});
