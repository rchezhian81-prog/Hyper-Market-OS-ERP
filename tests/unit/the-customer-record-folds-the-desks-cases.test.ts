import { describe, it, expect } from 'vitest';
import { serviceHistoryOf, complaintFactsOf, type ServiceCaseFact } from '../../services/customer/src/customer-360';
import { createCustomersSession } from '../../apps/web-erp/src/customers-session';

// OB-288 · M16-FR-04: the customer's record folds the service desk's own cases — complaints first, open ones counted,
// newest first, one per case — and segmentation reads complaint facts DERIVED from those cases.

const c = (caseId: string, kind: string, state: string, openedAt: string, customerRef = 'M-1'): ServiceCaseFact =>
  ({ caseId, customerRef, kind, state, summary: `${caseId} (synthetic)`, openedAt });

describe('the customer record folds the desk\'s cases (M16-FR-04)', () => {
  it('complaints apart from the rest, open counted, newest first, a case seen twice counted once', () => {
    const h = serviceHistoryOf([
      c('C1', 'complaint', 'open', '2026-10-01T10:00:00.000Z'),
      c('C2', 'complaint', 'resolved', '2026-10-03T10:00:00.000Z'),
      c('C2', 'complaint', 'resolved', '2026-10-03T10:00:00.000Z'),
      c('C3', 'enquiry', 'waiting_on_customer', '2026-10-02T10:00:00.000Z'),
    ]);
    expect(h.complaints.count).toBe(2);
    expect(h.complaints.open).toBe(1);
    expect(h.complaints.recent.map((x) => x.caseId)).toEqual(['C2', 'C1']);
    expect(h.otherCases).toMatchObject({ count: 1, open: 1 });
    expect(h.lastComplaintAt).toBe('2026-10-03T10:00:00.000Z');
    expect(h.say).toBe('2 complaint(s) on record, 1 still open — answer those first.');
  });

  it('no complaint is said as such — never a blank', () => {
    const h = serviceHistoryOf([c('C3', 'enquiry', 'open', '2026-10-02T10:00:00.000Z')]);
    expect(h.complaints.count).toBe(0);
    expect(h.lastComplaintAt).toBeNull();
    expect(h.say).toBe('No complaint has been raised by this customer.');
    expect(serviceHistoryOf([c('C9', 'complaint', 'closed', '2026-10-02T10:00:00.000Z')]).say).toBe('1 complaint(s) on record, all dealt with.');
  });

  it('complaint facts for segmentation: complaints only, resolved once dealt with, the latest state of each case', () => {
    expect(complaintFactsOf([
      c('C1', 'complaint', 'open', '2026-10-01T10:00:00.000Z'),
      c('C1', 'complaint', 'resolved', '2026-10-01T10:00:00.000Z'),
      c('C4', 'complaint', 'waiting_on_customer', '2026-10-04T10:00:00.000Z', 'M-2'),
      c('C3', 'enquiry', 'open', '2026-10-02T10:00:00.000Z'),
    ])).toEqual([
      { caseId: 'C1', customerRef: 'M-1', at: '2026-10-01T10:00:00.000Z', resolved: true },
      { caseId: 'C4', customerRef: 'M-2', at: '2026-10-04T10:00:00.000Z', resolved: false },
    ]);
  });

  it('the Customers page opens a record only for a person who may, and only with a code', async () => {
    const asked: string[] = [];
    const fetch = (async (path: string) => { asked.push(String(path)); return new Response(JSON.stringify({ customerRef: 'M-1' }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
    const cashier = createCustomersSession({ viewer: { userId: 'u-cash', permissions: ['customer.segment.read'] }, fetch });
    expect(cashier.may.record).toBe(false);
    expect(await cashier.record('M-1')).toEqual({ result: 'invalid', why: 'cannotRecord' });
    const desk = createCustomersSession({ viewer: { userId: 'u-mgr', permissions: ['customer.profile.read'] }, fetch });
    expect(await desk.record('  ')).toEqual({ result: 'invalid', why: 'needRef' });
    expect(asked).toEqual([]);
    expect((await desk.record('M 1')).result).toBe('ok');
    expect(asked).toEqual(['/v1/customers/M%201/profile']);
  });
});
