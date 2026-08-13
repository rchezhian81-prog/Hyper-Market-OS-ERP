import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Payroll bank-transfer file (WP3 inc5): a locked pay run's net pay → the bank bulk-salary upload.
// Confidential — owner-gated. Refuses unless the run is locked and every line is payable.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINES = [
  { employeeId: 'e1', employeeName: 'Asha R', bankAccountNo: '123456789012', ifsc: 'HDFC0001234', netPayMinor: 1_444_000 },
  { employeeId: 'e2', employeeName: 'Bala', bankAccountNo: '987654321098', ifsc: 'ICIC0005678', netPayMinor: 2_320_000 },
];
const lockedEvents = [
  { kind: 'drafted', payPeriod: '2026-08', by: 'maker', at: '2026-08-28T10:00:00Z' },
  { kind: 'submitted', by: 'maker', at: '2026-08-28T10:05:00Z' },
  { kind: 'approved', by: 'checker', at: '2026-08-28T11:00:00Z' },
  { kind: 'locked', at: '2026-08-28T11:30:00Z' },
];
const approvedEvents = lockedEvents.slice(0, 3);

const post = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/hr/payroll/bank-file', userId: u, tenantId: A, idempotencyKey: key, body });

describe('POST /v1/hr/payroll/bank-file', () => {
  it('builds the file from a locked run with a control total', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const f = (await post(h, 'u-owner', { payRunId: 'pr1', events: lockedEvents, lines: LINES }, 'b1')).body as {
      recordCount: number; totalNetMinor: number; csv: string; confirmWithBank: boolean;
    };
    expect(f.recordCount).toBe(2);
    expect(f.totalNetMinor).toBe(3_764_000);
    expect(f.csv.split('\n')).toHaveLength(3); // header + 2
    expect(f.confirmWithBank).toBe(true);
  });

  it('refuses a run that is not locked and a line that is not payable', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await post(h, 'u-owner', { payRunId: 'pr2', events: approvedEvents, lines: LINES }, 'b2')).status).toBe(422); // not locked
    const badLine = [{ ...LINES[0], ifsc: 'nope' }];
    expect((await post(h, 'u-owner', { payRunId: 'pr3', events: lockedEvents, lines: badLine }, 'b3')).status).toBe(422); // bad IFSC
  });

  it('refuses malformed input and gates on the confidential permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no payroll.statutory.read
    expect((await post(h, 'u-owner', { payRunId: 'pr4', events: lockedEvents }, 'b4')).status).toBe(400); // no lines
    expect((await post(h, 'u-cash', { payRunId: 'pr5', events: lockedEvents, lines: LINES }, 'b5')).status).toBe(403);
  });
});
