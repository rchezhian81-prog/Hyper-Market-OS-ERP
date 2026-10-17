import { describe, it, expect } from 'vitest';
import {
  poshComplaintView, admitPoshStep, poshAnnualReport, poshReportExceptions, poshReportDueBy,
  type PoshComplaint, type PoshStep,
} from '../../packages/workforce/src/index';

// R2 addendum C20 — the Internal Committee complaints register and annual report, engine level. Synthetic data only.

const complaint = (id: string, receivedOn: string): PoshComplaint => ({
  complaintId: id, receivedOn, complainantRef: `C-${id}`, respondentRef: `R-${id}`, summary: 'synthetic summary', recordedBy: 'u-ic', recordedAt: `${receivedOn}T10:00:00.000Z`,
});
const step = (complaintId: string, stepId: string, kind: PoshStep['kind'], on: string, outcome?: PoshStep['outcome']): PoshStep => ({
  complaintId, stepId, kind, on, ...(outcome === undefined ? {} : { outcome }), recordedBy: 'u-ic', recordedAt: `${on}T10:00:00.000Z`,
});

describe('C20 complaints register — append-only steps', () => {
  it('folds received → under inquiry → disposed', () => {
    const c = complaint('P1', '2026-03-01');
    expect(poshComplaintView(c, []).status).toBe('received');
    expect(poshComplaintView(c, [step('P1', 's1', 'inquiry_started', '2026-03-05')]).status).toBe('under_inquiry');
    const done = poshComplaintView(c, [step('P1', 's1', 'inquiry_started', '2026-03-05'), step('P1', 's2', 'disposed', '2026-05-01', 'upheld')]);
    expect(done).toMatchObject({ status: 'disposed', outcome: 'upheld', disposedOn: '2026-05-01' });
  });

  it('refuses a step before receipt, a second inquiry, a disposal with no outcome, and anything after disposal', () => {
    const c = complaint('P1', '2026-03-01');
    const open = poshComplaintView(c, []);
    expect(admitPoshStep(open, { kind: 'inquiry_started', on: '2026-02-01' })).toMatchObject({ ok: false, code: 'before_receipt' });
    expect(admitPoshStep(open, { kind: 'disposed', on: '2026-04-01' })).toMatchObject({ ok: false, code: 'outcome_needed' });
    expect(admitPoshStep(open, { kind: 'inquiry_started', on: '2026-03-02' })).toEqual({ ok: true });
    const inq = poshComplaintView(c, [step('P1', 's1', 'inquiry_started', '2026-03-02')]);
    expect(admitPoshStep(inq, { kind: 'inquiry_started', on: '2026-03-03' })).toMatchObject({ ok: false, code: 'inquiry_already_started' });
    const done = poshComplaintView(c, [step('P1', 's2', 'disposed', '2026-04-01', 'withdrawn')]);
    expect(admitPoshStep(done, { kind: 'disposed', on: '2026-04-02', outcome: 'upheld' })).toMatchObject({ ok: false, code: 'already_disposed' });
  });
});

describe('C20 annual report — counts only, due 31 January', () => {
  it('counts carried in, received, disposed by outcome and carried forward for the calendar year', () => {
    const complaints = [complaint('OLD', '2025-11-10'), complaint('A', '2026-02-01'), complaint('B', '2026-06-01'), complaint('NEXT', '2027-01-05')];
    const steps = [step('OLD', 'd', 'disposed', '2026-01-20', 'not_upheld'), step('A', 'd', 'disposed', '2026-04-01', 'conciliation')];
    const r = poshAnnualReport({ year: 2026, complaints, steps, generatedAt: '2027-01-10T00:00:00.000Z', generatedBy: 'u-ic' });
    expect(r).toMatchObject({
      year: 2026, periodFrom: '2026-01-01', periodTo: '2026-12-31', dueBy: '2027-01-31',
      pendingAtStart: 1, receivedInYear: 2, disposedInYear: 2, pendingAtEnd: 1,
      disposedByOutcome: { upheld: 0, not_upheld: 1, conciliation: 1, withdrawn: 0 },
    });
    // Nothing in the report names anybody.
    const text = JSON.stringify(r);
    for (const secret of ['C-A', 'R-A', 'synthetic summary']) expect(text).not.toContain(secret);
    expect(() => poshAnnualReport({ year: 1999, complaints, steps, generatedAt: 'x', generatedBy: 'u' })).toThrow(RangeError);
  });

  it('is DUE from 1 January to 31 January, OVERDUE after, and gone once filed — a year with no complaints still owes one', () => {
    expect(poshReportDueBy(2026)).toBe('2027-01-31');
    const due = poshReportExceptions({ asOf: '2027-01-10', firstYear: 2026, generatedYears: [], filings: [] });
    expect(due).toEqual([expect.objectContaining({ year: 2026, state: 'due', daysToDue: 21, generated: false })]);
    expect(due[0]!.detail).toBe('The Internal Committee annual report for 2026 is due to the District Officer by 2027-01-31 (21 day(s) left) — not generated yet');
    expect(poshReportExceptions({ asOf: '2027-01-31', firstYear: 2026, generatedYears: [2026], filings: [] })[0]).toMatchObject({ state: 'due', daysToDue: 0, generated: true });
    const late = poshReportExceptions({ asOf: '2027-02-03', firstYear: 2026, generatedYears: [2026], filings: [] });
    expect(late[0]).toMatchObject({ state: 'overdue', daysToDue: -3 });
    expect(poshReportExceptions({ asOf: '2027-02-03', firstYear: 2026, generatedYears: [2026], filings: [{ year: 2026, filedOn: '2027-01-30', reference: 'ack', recordedBy: 'u-owner', recordedAt: '2027-01-30T00:00:00.000Z' }] })).toEqual([]);
    // Two unfiled years both surface.
    expect(poshReportExceptions({ asOf: '2027-01-10', firstYear: 2025, generatedYears: [], filings: [] }).map((e) => `${e.year}:${e.state}`)).toEqual(['2025:overdue', '2026:due']);
  });
});
