import { describe, it, expect } from 'vitest';
import {
  planPayablesPostings, postPayables, ledgerHoldsRoundOff, PURCHASE_ROUND_OFF_WAITING, PAYABLES_POSTING_RULES, POSTING_LEGS_TO_NAME, DEFAULT_RETAIL_POSTING_MAP,
  type PayablesAccount, type PostedPayable, type PostingMap,
} from '../../packages/finance/src/index';
import { readRoundOff, withRoundOff, MAX_ROUND_OFF_MINOR, type SupplierInvoiceRecord } from '../../services/purchase/src/index';
import type { MatchResult } from '../../packages/purchasing/src/three-way-match';
import { signedRupeesToPaise, typedCaptureBody, presentMatch } from '../../apps/web-erp/src/supplier-bills-session';
import { kindRows, mapToSave, type Rule } from '../../apps/web-erp/src/posting-map-session';
import { payablesReasonWords } from '../../apps/web-erp/src/supplier-bills-to-the-books-session';

// OB-866 B (owner, 19 Nov 2026, in writing) · M07-FR-04 · WF-05 · pilot audit B-10 — a supplier bill's "Round off" line.

const day = (iso: string): string => iso.slice(0, 10);
const account = (roundOffMinor: number | undefined, payableMinor: number): PayablesAccount => ({
  supplierId: 'sup-1',
  invoices: [{ invoiceId: 'inv-1', payableMinor, matched: true, matchedAt: '2026-11-19T06:00:00.000Z', ...(roundOffMinor === undefined ? {} : { roundOffMinor }) }],
  debitNotes: [], payments: [],
});
const withAccount = (map: PostingMap, account: string): PostingMap => ({
  rules: map.rules.map((r) => (r.kind === 'supplier_invoice'
    ? { kind: r.kind, legs: [...r.legs, { account, side: 'debit' as const, component: 'purchase_round_off_up' }, { account, side: 'credit' as const, component: 'purchase_round_off_down' }] }
    : r.kind === 'supplier_invoice_reversal'
      ? { kind: r.kind, legs: [...r.legs, { account, side: 'credit' as const, component: 'purchase_round_off_up' }, { account, side: 'debit' as const, component: 'purchase_round_off_down' }] }
      : r)),
});
const MAP: PostingMap = { rules: [...PAYABLES_POSTING_RULES] };

describe('OB-866 B — the payables posting of a supplier bill\'s round off (packages/finance)', () => {
  it('splits the round off out of the goods: −0.40 is credited, +0.60 debited; a bill without one reads exactly as before', () => {
    const [down] = planPayablesPostings([account(-40, 49_960)], [], day);
    expect(down!.components).toEqual({ payable: 49_960, taxable: 50_000, cgst: 0, sgst: 0, igst: 0, purchase_round_off_up: 0, purchase_round_off_down: 40 });
    const [up] = planPayablesPostings([account(60, 50_060)], [], day);
    expect(up!.components).toMatchObject({ payable: 50_060, taxable: 50_000, purchase_round_off_up: 60, purchase_round_off_down: 0 });
    const [plain] = planPayablesPostings([account(undefined, 50_000)], [], day);
    expect(plain!.components).toEqual({ payable: 50_000, taxable: 50_000, cgst: 0, sgst: 0, igst: 0 });
  });

  it('WAITS, by name and in plain words, until the accountant names the account — nothing goes into purchases', () => {
    const out = postPayables(planPayablesPostings([account(-40, 49_960)], [], day), MAP, 'INR');
    expect(out.journals).toEqual([]);
    expect(out.exceptions).toHaveLength(1);
    expect(out.exceptions[0]).toMatchObject({ reason: 'purchase_round_off_not_named', sourceIds: ['inv-1'], kind: 'supplier_invoice' });
    expect(out.exceptions[0]!.detail).toMatch(/^Bill inv-1 \(supplier sup-1\) has a round off of −₹0\.40; it was captured and matched, and nothing of it was posted\./);
    expect(PURCHASE_ROUND_OFF_WAITING).toBe('Accounting entry waiting — the accountant has not named the Purchase round-off account');
    // Even a rule someone widened so the bill would balance without a round-off leg is refused — never posted into purchases.
    const sneaky: PostingMap = { rules: MAP.rules.map((r) => (r.kind === 'supplier_invoice' ? { kind: r.kind, legs: r.legs.map((l) => (l.component === 'taxable' ? { ...l, component: 'payable' } : l)) } : r)) };
    expect(postPayables(planPayablesPostings([account(-40, 49_960)], [], day), sneaky, 'INR').exceptions[0]!.reason).toBe('purchase_round_off_not_named');
  });

  it('posts once the account is named — balanced, on its own account — and a bill with no round off still posts under the widened rule', () => {
    const named = withAccount(MAP, 'acct-pro');
    const out = postPayables(planPayablesPostings([account(-40, 49_960)], [], day), named, 'INR');
    expect(out.exceptions).toEqual([]);
    expect(out.journals[0]!.entry.lines.map((l) => [l.account, l.side, l.amount.minor])).toEqual([['purchases_grni', 'debit', 50_000], ['supplier_payable', 'credit', 49_960], ['acct-pro', 'credit', 40]]);
    const plain = postPayables(planPayablesPostings([account(undefined, 50_000)], [], day), named, 'INR');
    expect(plain.exceptions).toEqual([]);
    expect(plain.journals[0]!.entry.lines).toHaveLength(2);
  });

  it('is posted once: what the ledger holds of the round off is counted, and a lowered bill takes it back with a reversal', () => {
    const named = withAccount(MAP, 'acct-pro');
    const [first] = planPayablesPostings([account(-40, 49_960)], [], day);
    const prior: PostedPayable[] = [{ kind: first!.kind, sourceKind: first!.sourceKind, sourceId: first!.sourceId, supplierId: 'sup-1', components: first!.components }];
    expect(ledgerHoldsRoundOff(prior, 'supplier_invoice', 'inv-1')).toBe(-40);
    expect(planPayablesPostings([account(-40, 49_960)], prior, day), 'a re-run posts nothing twice').toEqual([]);
    // A re-match now blocks the bill: the round off is withheld (0) and part of the goods too — one reversal, balanced.
    const [rev] = planPayablesPostings([account(undefined, 40_000)], prior, day);
    expect(rev!.kind).toBe('supplier_invoice_reversal');
    expect(rev!.components).toMatchObject({ amount: 9_960, taxable: 10_000, purchase_round_off_up: 0, purchase_round_off_down: 40 });
    const posted = postPayables([rev!], named, 'INR');
    expect(posted.exceptions).toEqual([]);
    expect(posted.journals[0]!.entry.totalDebit.minor).toBe(posted.journals[0]!.entry.totalCredit.minor);
  });

  it('the posting map offers the figures to name, and suggests no account for them (never invented)', () => {
    expect(POSTING_LEGS_TO_NAME.map((t) => t.kind)).toEqual(['supplier_invoice', 'supplier_invoice_reversal']);
    expect(JSON.stringify(DEFAULT_RETAIL_POSTING_MAP)).not.toContain('purchase_round_off');
  });
});

describe('OB-866 B — the bill and its match (services/purchase)', () => {
  it('reads a signed round off of at most ±₹1.00', () => {
    expect(MAX_ROUND_OFF_MINOR).toBe(100);
    expect([readRoundOff(undefined), readRoundOff(null), readRoundOff(-40), readRoundOff(100), readRoundOff(-100)]).toEqual([0, 0, -40, 100, -100]);
    expect([readRoundOff(101), readRoundOff(-101)]).toEqual(['too_large', 'too_large']);
    expect([readRoundOff(-0.4), readRoundOff('-40'), readRoundOff({})]).toEqual(['invalid', 'invalid', 'invalid']);
  });

  it('rides the match like a charge: payable with the bill, withheld with it while it is blocked', () => {
    const invoice = { roundOffMinor: -40 } as SupplierInvoiceRecord;
    const agreed = { blocked: false, payableMinor: 50_000, invoicedMinor: 50_000, withheldMinor: 0, lines: [] } as unknown as MatchResult;
    const ok = withRoundOff(agreed, invoice);
    expect([ok.payableMinor, ok.invoicedMinor, ok.withheldMinor, ok.roundOffMinor]).toEqual([agreed.payableMinor - 40, agreed.invoicedMinor - 40, agreed.withheldMinor, -40]);
    const blocked = withRoundOff({ ...agreed, blocked: true }, invoice);
    expect([blocked.payableMinor, blocked.withheldMinor]).toEqual([agreed.payableMinor, agreed.withheldMinor - 40]);
    expect(withRoundOff(agreed, {} as SupplierInvoiceRecord)).toBe(agreed);
  });
});

describe('OB-866 B — the screens (apps/web-erp)', () => {
  it('reads the round off as the paper prints it — minus or plus, the Unicode minus too', () => {
    expect(['-0.40', '−0.40', '+0.60', '0.60', ' ₹ -1 ', '', '-0', undefined].map((t) => signedRupeesToPaise(t))).toEqual([-40, -40, 60, 60, -100, 0, 0, 0]);
    expect(['minus', '0.405', '--1'].map((t) => signedRupeesToPaise(t))).toEqual([undefined, undefined, undefined]);
  });

  it('sends the round off with the typed bill (none when blank), and says plainly when it is not money', () => {
    const base = { invoiceId: 'inv-1', supplierId: 'sup-1', total: '499.60', lines: [{ productId: 'rice', quantity: '10', unitPrice: '50', amount: '500' }] };
    const typed = typedCaptureBody({ ...base, roundOff: '−0.40' });
    expect(typed.ok && typed.body['roundOffMinor']).toBe(-40);
    const none = typedCaptureBody({ ...base, roundOff: '' });
    expect(none.ok && 'roundOffMinor' in none.body).toBe(false);
    expect(typedCaptureBody({ ...base, roundOff: 'forty paise' })).toEqual({ ok: false, problem: 'round_off_not_money' });
    expect(presentMatch({ invoiceId: 'inv-1', blocked: false, lines: [], roundOffMinor: -40 })!.roundOffMinor).toBe(-40);
    expect(presentMatch({ invoiceId: 'inv-1', blocked: false, lines: [] })!.roundOffMinor).toBe(0);
  });

  it('offers the round-off figures blank and optional on the supplier-bill rule; left blank they are not saved', () => {
    const rule: Rule = { kind: 'supplier_invoice', legs: [{ account: 'purchases_grni', side: 'debit', component: 'taxable' }, { account: 'supplier_payable', side: 'credit', component: 'payable' }] };
    const rows = kindRows([rule], [], [], POSTING_LEGS_TO_NAME);
    expect(rows[0]!.legs.slice(2)).toEqual([
      { account: '', side: 'debit', component: 'purchase_round_off_up', optional: true },
      { account: '', side: 'credit', component: 'purchase_round_off_down', optional: true },
    ]);
    expect(rows[0]!.inForce, 'the rule in force is what head office holds').toEqual(rule.legs);
    // Named: offered no longer; kept blank: dropped from the save (no "blank account" refusal blocks other changes).
    expect(kindRows([{ kind: rule.kind, legs: [...rule.legs, { account: 'x', side: 'debit', component: 'purchase_round_off_up' }, { account: 'x', side: 'credit', component: 'purchase_round_off_down' }] }], [], [], POSTING_LEGS_TO_NAME)[0]!.legs).toHaveLength(4);
    const blank = mapToSave([rule], new Map([[rule.kind, rows[0]!.legs]]));
    expect(blank).toEqual({ ok: true, rules: [rule] });
    const named = mapToSave([rule], new Map([[rule.kind, rows[0]!.legs.map((l) => (l.optional ? { ...l, account: ' Purchase round off ' } : l))]]));
    expect(named.ok && named.rules[0]!.legs.slice(2)).toEqual([
      { account: 'Purchase round off', side: 'debit', component: 'purchase_round_off_up' },
      { account: 'Purchase round off', side: 'credit', component: 'purchase_round_off_down' },
    ]);
  });

  it('says the waiting reason in plain words, in both languages', () => {
    expect(payablesReasonWords('en', 'purchase_round_off_not_named')).toBe(PURCHASE_ROUND_OFF_WAITING);
    expect(payablesReasonWords('ta', 'purchase_round_off_not_named')).toMatch(/^கணக்குப் பதிவு காத்திருக்கிறது/);
    expect(payablesReasonWords('en', 'tax_not_mapped')).toBe('tax_not_mapped');
  });
});
