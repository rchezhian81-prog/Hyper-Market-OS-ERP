import { describe, it, expect } from 'vitest';
import { RecallRegistry, RecallWithdrawRefusedError } from '../../packages/traceability/src/index';
import {
  createExpirySession, WITHDRAW_REFUSAL_KINDS,
  type ExpiryPorts, type RecallRecord, type RecallCloudResult,
} from '../../apps/web-erp/src/expiry-session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';

/**
 * **OB-383 — a recall started by mistake may be withdrawn only before any customer is called or any stock is disposed
 * of; after that it is closed with evidence.** The tested rule (`RecallRegistry.withdraw`) and the recall screen's session.
 */

const AT = '2026-10-26T09:00:00.000Z';
const refusalOf = (f: () => unknown): string => {
  try { f(); return 'no refusal'; } catch (e) { return e instanceof RecallWithdrawRefusedError ? e.refusal : `other: ${String(e)}`; }
};

describe('RecallRegistry.withdraw (OB-383)', () => {
  const opened = () => {
    const r = new RecallRegistry();
    r.initiate({ batchId: 'B-1', reason: 'wrong code typed', initiatedBy: 'u-qc', at: AT });
    return r;
  };
  const input = { batchId: 'B-1', withdrawnBy: 'u-qc', reason: 'typed B-1 for B-11', at: AT, customersContacted: 0, stockDisposed: 0 };

  it('withdraws an open recall nobody was told about: kept, marked withdrawn, the block lifts', () => {
    const r = opened();
    expect(r.isRecalled('B-1')).toBe(true);
    const w = r.withdraw(input);
    expect(w).toMatchObject({ status: 'withdrawn', initiatedBy: 'u-qc', withdrawal: { withdrawnBy: 'u-qc', reason: 'typed B-1 for B-11' } });
    expect(r.isRecalled('B-1')).toBe(false);
    expect(r.find('B-1')?.status).toBe('withdrawn'); // retained, never deleted
    expect(() => { r.assertSellable('B-1'); }).not.toThrow();
  });

  it('refuses by name once a customer was contacted or stock disposed of — and the recall stays open', () => {
    const r = opened();
    expect(refusalOf(() => r.withdraw({ ...input, customersContacted: 1 }))).toBe('customers_already_contacted');
    expect(refusalOf(() => r.withdraw({ ...input, stockDisposed: 3 }))).toBe('stock_already_disposed');
    expect(r.isRecalled('B-1')).toBe(true);
    // …after which it closes with evidence as before.
    expect(r.close({ batchId: 'B-1', closedBy: 'u-qc', evidenceRef: 'EV-1', at: AT }).status).toBe('closed');
  });

  it('refuses without a reason, and on a recall that is not open (never started, closed, or withdrawn already)', () => {
    expect(refusalOf(() => opened().withdraw({ ...input, reason: '  ' }))).toBe('needs_a_reason');
    expect(refusalOf(() => new RecallRegistry().withdraw(input))).toBe('no_open_recall');
    const closed = opened();
    closed.close({ batchId: 'B-1', closedBy: 'u-qc', evidenceRef: 'EV', at: AT });
    expect(refusalOf(() => closed.withdraw(input))).toBe('no_open_recall');
    const twice = opened();
    twice.withdraw(input);
    expect(refusalOf(() => twice.withdraw(input))).toBe('no_open_recall');
    expect(() => twice.close({ batchId: 'B-1', closedBy: 'u-qc', evidenceRef: 'EV', at: AT })).toThrow();
  });
});

describe('the recall screen withdraws a recall started by mistake (OB-383)', () => {
  const recall: RecallRecord = { recallId: 'RC-1', batchId: 'B-1', productId: 'p1', reason: 'wrong code', startedBy: 'u-qc', startedAt: AT };
  const portsWith = (answer: RecallCloudResult, calls: unknown[]): ExpiryPorts => ({
    batches: () => [{ batchId: 'B-1', productId: 'p1', qty: 5, expiry: '2026-12-01' }],
    ledger: () => new Ledger(new InMemoryLedgerStore()),
    recalls: () => [recall],
    productNames: () => ({ p1: 'Toor dal' }),
    recallCloud: {
      initiate: async () => ({ recorded: true }),
      close: async () => ({ recorded: true }),
      withdraw: async (i) => { calls.push(i); return answer; },
    },
  });
  const cfg = { tenantId: 't', storeId: 's', userId: 'u-qc', now: AT, nearExpiryDays: 7 };

  it('sends the reason and the no-phone-call word; reports withdrawn only when head office saved it; then refuses to close it', async () => {
    const calls: unknown[] = [];
    const s = createExpirySession(cfg, portsWith({ recorded: true }, calls));
    const out = await s.withdraw({ recallId: 'RC-1', reason: 'typed the wrong batch', noCustomerPhoned: true });
    expect(out).toMatchObject({ ok: true, recall: { withdrawal: { withdrawnBy: 'u-qc', reason: 'typed the wrong batch' } } });
    expect(calls).toEqual([{ batchId: 'B-1', reason: 'typed the wrong batch', noCustomerPhoned: true }]);
    expect(s.recalls()[0]?.open).toBe(false);
    expect(await s.close({ recallId: 'RC-1', evidence: 'x', recoveredQty: 0, disposedQty: 0 })).toMatchObject({ ok: false, refusal: 'already_closed' });
  });

  it('refuses locally without the no-phone-call word or a reason — nothing sent', async () => {
    const calls: unknown[] = [];
    const s = createExpirySession(cfg, portsWith({ recorded: true }, calls));
    expect(await s.withdraw({ recallId: 'RC-1', reason: 'typed the wrong batch', noCustomerPhoned: false })).toMatchObject({ ok: false, refusal: 'confirm_no_customer_phoned' });
    expect(await s.withdraw({ recallId: 'RC-1', reason: 'no', noCustomerPhoned: true })).toMatchObject({ ok: false, refusal: 'needs_a_reason' });
    expect(await s.withdraw({ recallId: 'RC-9', reason: 'typed the wrong batch', noCustomerPhoned: true })).toMatchObject({ ok: false, refusal: 'no_such_recall' });
    expect(await createExpirySession({ ...cfg, userId: null }, portsWith({ recorded: true }, calls)).withdraw({ recallId: 'RC-1', reason: 'typed the wrong batch', noCustomerPhoned: true }))
      .toMatchObject({ ok: false, refusal: 'nobody_is_named_at_this_desk' });
    expect(calls).toEqual([]);
    expect(WITHDRAW_REFUSAL_KINDS).toContain('confirm_no_customer_phoned');
  });

  it('a head-office refusal by name keeps the recall open, and a dropped link is "not sent" — never a false withdrawn', async () => {
    const refused = createExpirySession(cfg, portsWith({ recorded: false, reason: '1 customer(s) have already been contacted', code: 'recall_customers_already_contacted' }, []));
    expect(await refused.withdraw({ recallId: 'RC-1', reason: 'typed the wrong batch', noCustomerPhoned: true }))
      .toMatchObject({ ok: false, refusedByHeadOffice: true, code: 'recall_customers_already_contacted' });
    expect(refused.recalls()[0]?.open).toBe(true);
    const dropped = createExpirySession(cfg, portsWith({ recorded: false, reason: 'no connection' }, []));
    expect(await dropped.withdraw({ recallId: 'RC-1', reason: 'typed the wrong batch', noCustomerPhoned: true })).toMatchObject({ ok: false, notSent: true });
    expect(dropped.recalls()[0]?.open).toBe(true);
  });
});
