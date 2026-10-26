import { describe, it, expect } from 'vitest';
import { RecallRegistry, RecallWithdrawRefusedError } from '../../packages/traceability/src/index';
import { buildRecallNoticeList, type RecallBuyer, type RecallPhonedTick } from '../../services/customer/src/recall-notices';

/**
 * **OB-387 (owner decision, 26 Oct 2026) — a "phoned" tick per customer on the recall call list; any tick refuses the
 * withdrawal.** The tested rule (`RecallRegistry.withdraw`) and the call list's fold (`buildRecallNoticeList`).
 */

const AT = '2030-06-11T00:00:00.000Z';
const refusalOf = (f: () => unknown): string => {
  try { f(); return 'no refusal'; } catch (e) { return e instanceof RecallWithdrawRefusedError ? e.refusal : `other: ${String(e)}`; }
};

describe('RecallRegistry.withdraw refuses once any customer is ticked as phoned (OB-387)', () => {
  const opened = () => {
    const r = new RecallRegistry();
    r.initiate({ batchId: 'B-1', reason: 'wrong code typed', initiatedBy: 'u-qc', at: AT });
    return r;
  };
  const input = { batchId: 'B-1', withdrawnBy: 'u-qc', reason: 'typed B-1 for B-11', at: AT, customersContacted: 0, stockDisposed: 0 };

  it('one tick is enough: refused by name, the recall stays open and closes with evidence', () => {
    const r = opened();
    expect(refusalOf(() => r.withdraw({ ...input, customersPhoned: 1 }))).toBe('customers_already_phoned');
    expect(r.find('B-1')?.status).toBe('open');
    expect(r.isRecalled('B-1')).toBe(true);
    expect(r.close({ batchId: 'B-1', closedBy: 'u-qc', evidenceRef: 'phoned cust-A; told to return it', at: AT }).status).toBe('closed');
  });

  it('no tick (zero) is no bar; the message and disposal refusals still stand beside it', () => {
    expect(opened().withdraw({ ...input, customersPhoned: 0 }).status).toBe('withdrawn');
    expect(refusalOf(() => opened().withdraw({ ...input, customersPhoned: 2, stockDisposed: 1 }))).toBe('customers_already_phoned');
    expect(refusalOf(() => opened().withdraw({ ...input, customersContacted: 1, customersPhoned: 1 }))).toBe('customers_already_contacted');
  });
});

describe('the call list carries each customer\'s "phoned" tick — who and when (OB-387)', () => {
  const buyer = (saleId: string, customerRef?: string): RecallBuyer =>
    ({ saleId, soldDate: '2030-06-10', quantityMinor: 1, source: 'captured', ...(customerRef === undefined ? {} : { customerRef }), via: { kind: 'this_batch' } });
  const recall = { batchId: 'M-9', status: 'open' as const, reason: 'r', initiatedAt: AT, closedAt: null };
  const tick = (customerRef: string, phonedBy: string, phonedAt: string): RecallPhonedTick => ({ batchId: 'M-9', customerRef, recallStartedAt: AT, phonedBy, phonedAt });

  it('a ticked customer shows who and when; the others show null; the count and the words say how many', () => {
    const list = buildRecallNoticeList({
      recall, buyers: [buyer('S1', 'a'), buyer('S2', 'b'), buyer('S3')],
      consentOf: new Map(), nameOf: new Map(), phoneLast4Of: new Map(),
      phonedOf: new Map([['a', tick('a', 'u-mgr', '2030-06-11T10:00:00.000Z')]]),
      now: '2030-06-12T00:00:00Z',
    });
    expect(list.callList.map((c) => [c.customerRef, c.phoned])).toEqual([
      ['a', { by: 'u-mgr', at: '2030-06-11T10:00:00.000Z' }],
      ['b', null],
    ]);
    expect(list.phonedCount).toBe(1);
    expect(list.detail).toMatch(/1 ticked as phoned/);
  });

  it('without any tick handed in, nobody is shown as phoned (never assumed)', () => {
    const list = buildRecallNoticeList({ recall, buyers: [buyer('S1', 'a')], consentOf: new Map(), nameOf: new Map(), phoneLast4Of: new Map(), now: AT });
    expect(list.callList[0]?.phoned).toBeNull();
    expect(list.phonedCount).toBe(0);
  });
});
