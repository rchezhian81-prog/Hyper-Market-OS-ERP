import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

import { recordedPayRun } from '../support/pay-run';

// Payroll bank-transfer file (WP3 inc5): a locked pay run's net pay → the bank bulk-salary upload.
// Confidential — owner-gated. Refuses unless the run is locked and every line is payable. Since 2b-vi-b-2 (audit PA-03,
// register row 12) the run is the one head office RECORDED — submitted, approved and locked by signed-in people —
// never a history in the request, whose approver was a string anyone could write; and when the run recorded its net
// total and headcount, the file pays exactly that.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINES = [
  { employeeId: 'e1', employeeName: 'Asha R', bankAccountNo: '123456789012', ifsc: 'HDFC0001234', netPayMinor: 1_444_000 },
  { employeeId: 'e2', employeeName: 'Bala', bankAccountNo: '987654321098', ifsc: 'ICIC0005678', netPayMinor: 2_320_000 },
];
const typedHistory = [
  { kind: 'drafted', payPeriod: '2026-08', by: 'maker', at: '2026-08-28T10:00:00Z' },
  { kind: 'submitted', by: 'maker', at: '2026-08-28T10:05:00Z' },
  { kind: 'approved', by: 'checker', at: '2026-08-28T11:00:00Z' },
  { kind: 'locked', at: '2026-08-28T11:30:00Z' },
];

const post = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/hr/payroll/bank-file', userId: u, tenantId: A, idempotencyKey: key, body });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
async function twoOwners(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionOwner(A, 'u-owner-2');
  return h;
}

describe('POST /v1/hr/payroll/bank-file', () => {
  it('builds the file from the recorded, locked run with a control total', async () => {
    const h = await twoOwners();
    await recordedPayRun(h, A, 'pr1', { maker: 'u-owner', checker: 'u-owner-2', netTotalMinor: 3_764_000, employeeCount: 2 });
    const f = (await post(h, 'u-owner', { payRunId: 'pr1', lines: LINES }, 'b1')).body as {
      recordCount: number; totalNetMinor: number; csv: string; confirmWithBank: boolean;
    };
    expect(f.recordCount).toBe(2);
    expect(f.totalNetMinor).toBe(3_764_000);
    expect(f.csv.split('\n')).toHaveLength(3); // header + 2
    expect(f.confirmWithBank).toBe(true);
  });

  it('the audit\'s case: a history in the request — an approver typed as a string — is refused; an unknown run is refused', async () => {
    const h = await twoOwners();
    expect(codeOf(await post(h, 'u-owner', { payRunId: 'pr-typed', events: typedHistory, lines: LINES }, 'b-typed'))).toBe('pay_run_is_read_from_the_record');
    expect(codeOf(await post(h, 'u-owner', { payRunId: 'pr-none', lines: LINES }, 'b-none'))).toBe('bank_file_no_run');
  });

  it('pays exactly what was approved — not more money, not more people', async () => {
    const h = await twoOwners();
    await recordedPayRun(h, A, 'pr-fix', { maker: 'u-owner', checker: 'u-owner-2', netTotalMinor: 3_764_000, employeeCount: 2 });
    const more = [{ ...LINES[0]!, netPayMinor: 1_544_000 }, LINES[1]!];
    expect(codeOf(await post(h, 'u-owner', { payRunId: 'pr-fix', lines: more }, 'b-more'))).toBe('bank_file_does_not_match_the_run');
    const extra = [...LINES, { employeeId: 'e9', employeeName: 'Ghost', bankAccountNo: '111122223333', ifsc: 'SBIN0000001', netPayMinor: 0 }];
    expect(codeOf(await post(h, 'u-owner', { payRunId: 'pr-fix', lines: extra }, 'b-extra'))).toBe('bank_file_does_not_match_the_run');
  });

  it('refuses a run that is not locked and a line that is not payable', async () => {
    const h = await twoOwners();
    await recordedPayRun(h, A, 'pr2', { maker: 'u-owner', checker: 'u-owner-2', stage: 'approved' });
    expect((await post(h, 'u-owner', { payRunId: 'pr2', lines: LINES }, 'b2')).status).toBe(422); // not locked
    await recordedPayRun(h, A, 'pr3', { maker: 'u-owner', checker: 'u-owner-2' });
    const badLine = [{ ...LINES[0], ifsc: 'nope' }];
    expect((await post(h, 'u-owner', { payRunId: 'pr3', lines: badLine }, 'b3')).status).toBe(422); // bad IFSC
  });

  it('refuses malformed input and gates on the confidential permission', async () => {
    const h = await twoOwners();
    await h.provisionRole(A, 'u-cash', 'cashier'); // no payroll.statutory.read
    expect((await post(h, 'u-owner', { payRunId: 'pr4' }, 'b4')).status).toBe(400); // no lines
    expect((await post(h, 'u-cash', { payRunId: 'pr5', lines: LINES }, 'b5')).status).toBe(403);
  });
});
