import { describe, it, expect } from 'vitest';
import {
  createApprovalRulesSession, approvalRulesWords, approvalRulesOutcomeWords, paiseFromRupees, limitWords, waitWords, limitsFromForm,
  APPROVAL_RULES_COPY, type RuleView, type LimitsValue,
} from '../../apps/web-erp/src/approval-rules-session';

/**
 * The Approval rules page's session (OB-290/291/292): it reads only on a click, asks for a change with exactly the new
 * figures and a reason, applies only what the owner approved, says "Not set" for a missing figure, and refuses the cheap
 * things before sending anything. English and Tamil for every word.
 */

const LIMITS: RuleView<LimitsValue> = {
  rule: 'limits', version: 0, source: 'owner_decision_23_oct_2026', changedBy: null, changedAt: null, reason: null,
  value: { byRole: { owner: { refund: null, purchase_order: null, stock_adjustment: null }, store_manager: { refund: 500_000, purchase_order: 2_500_000, stock_adjustment: 200_000 }, cashier: { refund: 0, purchase_order: 0, stock_adjustment: 0 } } },
};

function recorder(reply: (path: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { method: string; path: string; body: unknown; key?: string }[] = [];
  const fetch = (async (path: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    calls.push({ method: init.method ?? 'GET', path, body: init.body === undefined ? undefined : JSON.parse(init.body as string), ...(h['idempotency-key'] === undefined ? {} : { key: h['idempotency-key'] }) });
    const r = reply(path, init);
    return { ok: r.status < 300, status: r.status, json: async () => r.body } as Response;
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('the Approval rules session', () => {
  it('reads nothing and asks nothing for nobody, or for a role without the permission', async () => {
    const { calls, fetch } = recorder(() => ({ status: 200, body: {} }));
    expect(await createApprovalRulesSession({ viewer: undefined, fetch }).read()).toEqual({ result: 'invalid', why: 'nobody' });
    const cashier = createApprovalRulesSession({ viewer: { userId: 'u-cash', permissions: ['identity.self.read'] }, fetch });
    expect(cashier.may).toEqual({ named: true, read: false, propose: false });
    expect(await cashier.read()).toEqual({ result: 'invalid', why: 'cannotRead' });
    const reader = createApprovalRulesSession({ viewer: { userId: 'u-x', permissions: ['approvals.rules.read'] }, fetch });
    expect(await reader.ask('limits', { byRole: {} }, 'why', LIMITS)).toEqual({ result: 'invalid', why: 'cannotPropose' });
    expect(calls).toEqual([]);
  });

  it('asks with exactly the new figures, the version it read and a reason — then applies exactly that, naming the approval', async () => {
    const { calls, fetch } = recorder((path) => (path === '/v1/approvals/requests' ? { status: 201, body: { requestId: 'areq-1' } } : { status: 200, body: { version: 1, approvedBy: 'u-owner' } }));
    const s = createApprovalRulesSession({ viewer: { userId: 'u-acc', permissions: ['approvals.rules.read', 'approvals.rules.propose'] }, fetch, newKey: () => 'k1' });
    expect(await s.ask('limits', LIMITS.value, 'same', LIMITS)).toEqual({ result: 'invalid', why: 'noChange' });
    const next = limitsFromForm(LIMITS.value, { store_manager: { stock_adjustment: '3,000' } });
    expect(next).not.toBe('invalid');
    expect(await s.ask('limits', next, '  ', LIMITS)).toEqual({ result: 'invalid', why: 'noReason' });
    expect(calls).toEqual([]);
    expect((await s.ask('limits', next, ' Diwali write-offs ', LIMITS)).result).toBe('ok');
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/approvals/requests', key: 'k1', body: {
      kind: 'approval_rule_change', subjectRef: 'rule:limits', valueMinor: null, reason: 'Diwali write-offs', summary: 'Change the limits rule (from version 0)',
      details: { rule: 'limits', basedOnVersion: 0, reason: 'Diwali write-offs', value: { byRole: { ...LIMITS.value.byRole, store_manager: { refund: 500_000, purchase_order: 2_500_000, stock_adjustment: 300_000 } } } },
    } });
    const asked = { requestId: 'areq-1', rule: 'limits' as const, status: 'approved', details: (calls[0]!.body as { details: { rule: 'limits'; value: unknown; basedOnVersion: number; reason: string } }).details };
    expect((await s.apply(asked)).result).toBe('ok');
    expect(calls[1]).toMatchObject({ method: 'PUT', path: '/v1/approvals/rules/limits', body: { value: asked.details.value, basedOnVersion: 0, reason: 'Diwali write-offs', approvalId: 'areq-1' } });
    expect((calls[1]!.body as Record<string, unknown>)['rule']).toBeUndefined();
  });

  it('a refusal and a lost link are said in the page\'s words, in both languages', async () => {
    const refusing = createApprovalRulesSession({ viewer: { userId: 'u', permissions: ['approvals.rules.read'] }, fetch: recorder(() => ({ status: 403, body: { error: { code: 'forbidden', whatHappened: 'no' } } })).fetch });
    const out = await refusing.read();
    expect(approvalRulesOutcomeWords('en', out)).toBe('Head office refused: no');
    expect(approvalRulesOutcomeWords('ta', out)).toBe('தலைமை அலுவலகம் மறுத்தது: no');
    const lost = createApprovalRulesSession({ viewer: { userId: 'u', permissions: ['approvals.rules.read'] }, fetch: (async () => { throw new Error('offline'); }) as typeof globalThis.fetch });
    expect(approvalRulesOutcomeWords('en', await lost.read())).toBe('Head office cannot be reached — nothing was changed.');
  });

  it('reads money and says Not set, Unlimited or the figure — never a fake ₹0', () => {
    expect([paiseFromRupees('5000'), paiseFromRupees('₹5,000.50'), paiseFromRupees(''), paiseFromRupees('5k'), paiseFromRupees('1.234')]).toEqual([500_000, 500_050, undefined, 'invalid', 'invalid']);
    expect([limitWords('en', undefined), limitWords('en', null), limitWords('en', 500_000), limitWords('ta', undefined)]).toEqual(['Not set', 'Unlimited', '₹5,000.00', 'அமைக்கப்படவில்லை']);
    expect(waitWords('en', 60)).toBe('60 minutes (1 hour)');
    expect(waitWords('en', 2_880)).toBe('2880 minutes (48 hours)');
    expect(waitWords('en', 90)).toBe('90 minutes');
    // An emptied figure becomes Not set; the owner's row cannot be changed from the form.
    const cleared = limitsFromForm(LIMITS.value, { cashier: { refund: '' }, owner: { refund: '1' } }) as LimitsValue;
    expect(cleared.byRole['cashier']).toEqual({ purchase_order: 0, stock_adjustment: 0 });
    expect(cleared.byRole['owner']).toEqual(LIMITS.value.byRole['owner']);
    expect(limitsFromForm(LIMITS.value, { cashier: { refund: 'lots' } })).toBe('invalid');
  });

  it('has a Tamil word for every English one', () => {
    const missing = Object.keys(APPROVAL_RULES_COPY.en).filter((k) => !(k in APPROVAL_RULES_COPY.ta));
    expect(missing).toEqual([]);
    expect(approvalRulesWords('ta', 'title')).toBe('ஒப்புதல் விதிகள்');
  });
});
