import { describe, it, expect } from 'vitest';
import {
  approvalRequestRoutes, takeApproval, fingerprintOf, statusOf, namedSecondPersonRefusal, APPROVAL_KINDS, actionDetails, approvalNamedIn, NO_APPROVALS,
  type ApprovalDecision, type ApprovalRequest, type ApprovalState,
} from '../../services/identity/src/approval-requests';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **Head office's maker-checker engine (ADR-0024 · Wave 2b-vi · audit PA-03 · M02-FR-03 · §28).** The maker asks for
 * exactly what they will do; a different person who holds that kind's authority approves or rejects it with a reason, in
 * their own session; the action then uses the approval once — the same kind, subject, details, amount and maker, before
 * it expires, while the checker still holds the authority.
 */

const NOW = '2026-10-07T10:00:00.000Z';
const T = 't-sre';

const PEOPLE: Record<string, readonly string[]> = {
  'u-owner': ['purchase.supplier.bank', 'purchase.supplier.approve', 'purchase.import.record'],
  'u-acct': ['purchase.supplier.approve'],
  'u-mgr': ['purchase.import.record'],
  'u-cash': ['pos.sale.sync'],
};

function stub() {
  const requests = new Map<string, ApprovalRequest>();
  const decisions = new Map<string, ApprovalDecision>();
  const versions = new Map<string, number>();
  const routes = approvalRequestRoutes({
    recordRequest: (_t, r) => { requests.set(r.requestId, r); },
    recordDecision: (_t, d, expected) => {
      if ((versions.get(d.requestId) ?? 0) !== expected) throw new Error('conflict');
      decisions.set(d.requestId, d); versions.set(d.requestId, expected + 1);
    },
    approvalState: (_t, id) => {
      const request = requests.get(id);
      return request === undefined ? undefined : { request, ...(decisions.has(id) ? { decision: decisions.get(id)! } : {}) };
    },
    approvalVersion: (_t, id) => versions.get(id) ?? 0,
    allRequests: () => [...requests.values()].map((request) => ({ request, ...(decisions.has(request.requestId) ? { decision: decisions.get(request.requestId)! } : {}) })),
    permissionsOfUser: (_t, u) => PEOPLE[u],
    now: () => NOW,
  });
  return { routes, requests, decisions };
}
const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: T, userId: 'u-owner', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });
const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
interface Thrown { readonly status: number; readonly body: { readonly code: string } }
async function thrown(fn: () => unknown): Promise<Thrown> {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected a refusal');
}
const bankAsk = (over: Record<string, unknown> = {}) => ({
  kind: 'supplier_bank_change', subjectRef: 's-1', details: { supplierId: 's-1', newAccount: 'tok-1', requestedVia: 'letter' },
  summary: 'Pay Amma Traders into tok-1', reason: 'supplier letter, called back', ...over,
});
const ask = (routes: readonly Route[], body: unknown, userId = 'u-owner') => route(routes, 'POST', '/v1/approvals/requests').handler(ctx({ body, userId }));
const decideAs = (routes: readonly Route[], requestId: string, body: unknown, userId: string) =>
  route(routes, 'POST', '/v1/approvals/requests/:requestId/decide').handler(ctx({ body, userId, params: { requestId } }));
const inbox = (routes: readonly Route[], userId: string) => route(routes, 'GET', '/v1/approvals/requests').handler(ctx({ userId }));

describe('the fingerprint of an action\'s exact details', () => {
  it('is the same whatever order the details arrive in, and changes with any detail', () => {
    expect(fingerprintOf({ a: 1, b: { c: 'x', d: [1, 2] } })).toBe(fingerprintOf({ b: { d: [1, 2], c: 'x' }, a: 1 }));
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
    expect(fingerprintOf({ a: [1, 2] })).not.toBe(fingerprintOf({ a: [2, 1] }));
    expect(fingerprintOf({ a: 1, b: undefined })).toBe(fingerprintOf({ a: 1 }));
    expect(fingerprintOf({ newAccount: 'tok-1' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the maker asks, in their own session (POST /v1/approvals/requests)', () => {
  it('records the request as the caller\'s, fingerprinting the details; it waits', async () => {
    const { routes, requests } = stub();
    const res = await ask(routes, bankAsk({ requestedBy: 'u-someone-else' }));
    expect(res.status).toBe(201);
    const r = res.body as ApprovalRequest & { status: string };
    expect(r).toMatchObject({ kind: 'supplier_bank_change', subjectRef: 's-1', valueMinor: null, requestedBy: 'u-owner', requestedAt: NOW, status: 'waiting' });
    expect(r.requestId).toMatch(/^areq-/);
    expect(r.fingerprint).toBe(fingerprintOf(bankAsk().details));
    expect(requests.size).toBe(1);
  });
  it('only someone who may do the action may ask for it', async () => {
    const { routes } = stub();
    expect((await thrown(() => ask(routes, bankAsk(), 'u-mgr'))).status).toBe(403);
    expect((await thrown(() => ask(routes, bankAsk(), 'u-ghost'))).status).toBe(403);
  });
  it('names a known kind, the subject, the details, a summary and why; an amount in whole paise', async () => {
    const { routes } = stub();
    for (const bad of [bankAsk({ kind: 'anything' }), bankAsk({ subjectRef: '' }), bankAsk({ details: 'x' }), bankAsk({ details: [1] }),
      bankAsk({ summary: ' ' }), bankAsk({ reason: undefined }), bankAsk({ valueMinor: -1 }), bankAsk({ valueMinor: 1.5 })]) {
      expect((await thrown(() => ask(routes, bad))).body.code).toBe('not_readable_as_an_approval_request');
    }
    expect(((await ask(routes, bankAsk({ valueMinor: 5000 }))).body as ApprovalRequest).valueMinor).toBe(5000);
  });
});

describe('a different person with the authority decides, in their own session', () => {
  it('approves with a reason; the approval expires after the kind\'s window', async () => {
    const { routes } = stub();
    const r = (await ask(routes, bankAsk())).body as ApprovalRequest;
    const res = await decideAs(routes, r.requestId, { decision: 'approved', reason: 'called back on our number' }, 'u-acct');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ decision: 'approved', decidedBy: 'u-acct', decidedAt: NOW, expiresAt: '2026-10-08T10:00:00.000Z' });
    expect(APPROVAL_KINDS['supplier_bank_change']!.validForMinutes).toBe(24 * 60);
  });
  it('never the maker (§28), never without the authority, never without a reason', async () => {
    const { routes } = stub();
    const r = (await ask(routes, bankAsk())).body as ApprovalRequest;
    expect((await thrown(() => decideAs(routes, r.requestId, { decision: 'approved', reason: 'mine' }, 'u-owner'))).body.code).toBe('self_approval');
    expect((await thrown(() => decideAs(routes, r.requestId, { decision: 'approved', reason: 'x' }, 'u-mgr'))).status).toBe(403);
    expect((await thrown(() => decideAs(routes, r.requestId, { decision: 'approved' }, 'u-acct'))).body.code).toBe('not_readable_as_a_decision');
    expect((await thrown(() => decideAs(routes, r.requestId, { decision: 'maybe', reason: 'x' }, 'u-acct'))).body.code).toBe('not_readable_as_a_decision');
    expect((await thrown(() => decideAs(routes, 'areq-none', { decision: 'approved', reason: 'x' }, 'u-acct'))).status).toBe(404);
  });
  it('a decision is final: a different one is refused; the same one resent is the same answer', async () => {
    const { routes } = stub();
    const r = (await ask(routes, bankAsk())).body as ApprovalRequest;
    await decideAs(routes, r.requestId, { decision: 'rejected', reason: 'number not ours' }, 'u-acct');
    expect((await decideAs(routes, r.requestId, { decision: 'rejected', reason: 'again' }, 'u-acct')).body).toMatchObject({ alreadyDecided: true });
    expect((await thrown(() => decideAs(routes, r.requestId, { decision: 'approved', reason: 'changed my mind' }, 'u-acct'))).body.code).toBe('already_decided');
  });
  it('the inbox shows a checker what waits for them (never their own), and a maker what they asked', async () => {
    const { routes } = stub();
    const r = (await ask(routes, bankAsk())).body as ApprovalRequest;
    const forAcct = (await inbox(routes, 'u-acct')).body as { waitingForMe: { requestId: string; label: string; status: string }[]; mine: unknown[] };
    expect(forAcct.waitingForMe).toEqual([expect.objectContaining({ requestId: r.requestId, label: 'Change where a supplier is paid', status: 'waiting' })]);
    expect(forAcct.mine).toEqual([]);
    const forOwner = (await inbox(routes, 'u-owner')).body as { waitingForMe: unknown[]; mine: { status: string }[] };
    expect(forOwner.waitingForMe).toEqual([]); // the owner may approve bank changes — but not their own request
    expect(forOwner.mine).toEqual([expect.objectContaining({ status: 'waiting' })]);
    expect(((await inbox(routes, 'u-mgr')).body as { waitingForMe: unknown[] }).waitingForMe).toEqual([]); // no authority
  });
});

describe('an action uses an approval only when it is exactly what was approved (takeApproval)', () => {
  const details = { supplierId: 's-1', newAccount: 'tok-1' };
  const request: ApprovalRequest = {
    requestId: 'areq-1', kind: 'supplier_bank_change', subjectRef: 's-1', valueMinor: null, fingerprint: fingerprintOf(details),
    details, summary: 'Pay s-1 into tok-1', reason: 'r', requestedBy: 'u-owner', requestedAt: NOW,
  };
  const approved: ApprovalDecision = { requestId: 'areq-1', decision: 'approved', decidedBy: 'u-acct', reason: 'ok', decidedAt: NOW, expiresAt: '2026-10-08T10:00:00.000Z' };
  const take = (state: ApprovalState | undefined, over: Partial<Parameters<typeof takeApproval>[0]> = {}) => takeApproval({
    state, kind: 'supplier_bank_change', subjectRef: 's-1', details, valueMinor: null, maker: 'u-owner', usedBy: 'bank-change-s-1',
    now: '2026-10-07T12:00:00.000Z', checkerHolds: (u, p) => (PEOPLE[u] ?? []).includes(p), ...over,
  });

  it('resolves the decision when everything matches', async () => {
    expect(await take({ request, decision: approved })).toEqual(approved);
  });
  it('refuses an unknown request, a waiting one and a rejected one', async () => {
    expect((await thrown(() => take(undefined))).body.code).toBe('approval_unknown');
    expect((await thrown(() => take({ request }))).body.code).toBe('approval_still_waiting');
    expect((await thrown(() => take({ request, decision: { ...approved, decision: 'rejected', expiresAt: null } }))).body.code).toBe('approval_rejected');
  });
  it('refuses another kind, subject, maker, amount, or ANY changed detail', async () => {
    for (const over of [{ kind: 'data_import_commit' }, { subjectRef: 's-2' }, { maker: 'u-mgr' }, { valueMinor: 1 }, { details: { ...details, newAccount: 'tok-2' } }]) {
      expect((await thrown(() => take({ request, decision: approved }, over))).body.code).toBe('approval_does_not_match');
    }
  });
  it('refuses it once expired, and once used — strictly once, even by the same action under a new request', async () => {
    expect((await thrown(() => take({ request, decision: approved }, { now: '2026-10-08T10:00:00.000Z' }))).body.code).toBe('approval_expired');
    expect((await thrown(() => take({ request, decision: approved, usedBy: 'bank-change-s-9' }))).body.code).toBe('approval_already_used');
    expect((await thrown(() => take({ request, decision: approved, usedBy: 'bank-change-s-1' }))).body.code).toBe('approval_already_used');
  });
  it('refuses it when the checker no longer holds the authority', async () => {
    expect((await thrown(() => take({ request, decision: approved }, { checkerHolds: () => false }))).body.code).toBe('checker_may_not_approve');
  });
  it('says where a request stands', () => {
    const at = Date.parse('2026-10-07T12:00:00.000Z');
    expect(statusOf({ request }, at)).toBe('waiting');
    expect(statusOf({ request, decision: approved }, at)).toBe('approved');
    expect(statusOf({ request, decision: approved }, Date.parse('2026-10-09T00:00:00.000Z'))).toBe('expired');
    expect(statusOf({ request, decision: { ...approved, decision: 'rejected', expiresAt: null } }, at)).toBe('rejected');
    expect(statusOf({ request, decision: approved, usedBy: 'x' }, at)).toBe('used');
  });
  it('a typed second person is refused by name', () => {
    const e = namedSecondPersonRefusal('approvedBy', 'u-acct') as unknown as Thrown & { body: { whatHappened: string } };
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('approver_named_without_approval');
    expect(e.body.whatHappened).toContain('u-acct');
  });
});

describe('what an action asks approval FOR, and the common typed-name rule (2b-vi-b)', () => {
  it('the details are the body without its control fields, plus the route\'s path ids', () => {
    expect(actionDetails({ priceMinor: 6000, approvalId: 'areq-1', approval: { decidedBy: 'x' }, approvedBy: 'x', rationale: 'r' }, { productId: 'P1' }))
      .toEqual({ priceMinor: 6000, productId: 'P1' });
    expect(actionDetails(undefined)).toEqual({});
    expect(actionDetails([1, 2])).toEqual({});
    // The same body sent with or without an approval fingerprints the same — ask with exactly the body you will send.
    expect(fingerprintOf(actionDetails({ a: 1, approvalId: 'z' }))).toBe(fingerprintOf(actionDetails({ a: 1 })));
  });
  it('a typed name with no approval is refused by name; no approval at all is the action\'s own call', async () => {
    const base = { tenantId: T, kind: 'price_change', subjectRef: 'P1', details: {}, valueMinor: 1, maker: 'u-mgr', usedBy: 'x', now: NOW };
    expect((await thrown(() => approvalNamedIn(NO_APPROVALS, { ...base, approvalId: undefined, typedField: 'approval.decidedBy', typedValue: 'u-owner' }))).body.code)
      .toBe('approver_named_without_approval');
    expect(await approvalNamedIn(NO_APPROVALS, { ...base, approvalId: '  ', typedField: 'approvedBy', typedValue: undefined })).toBeUndefined();
    // An approval id with no engine behind it is unknown — never approved by accident.
    expect((await thrown(() => approvalNamedIn(undefined, { ...base, approvalId: 'areq-1', typedField: 'approvedBy', typedValue: 'u-owner' }))).body.code).toBe('approval_unknown');
  });
  it('a month is signed by whoever may sign a period, and a concession by another concession manager (2b-vi-b-2)', () => {
    for (const k of ['period_close', 'period_reopen']) {
      expect(APPROVAL_KINDS[k]).toMatchObject({ makerPermission: 'finance.period.close', checkerPermission: 'finance.period.sign' });
    }
    for (const k of ['concession_contract', 'concession_deposit_forfeit']) {
      expect(APPROVAL_KINDS[k]).toMatchObject({ makerPermission: 'concession.contract.manage', checkerPermission: 'concession.contract.manage' });
    }
  });
  it('every pricing kind is approved by the pricing-approval authority', () => {
    for (const k of ['price_change', 'price_list_entry', 'promotion_launch', 'quotation_below_floor']) {
      expect(APPROVAL_KINDS[k]!.checkerPermission).toBe('price.change.approve');
    }
  });
  it('stock, orders and purchasing (2b-vi-b-3): each second person holds the authority the route already named', () => {
    // A write-off and an upward correction: another person who may post stock movements (Manager/Owner) — as before.
    for (const k of ['stock_write_off', 'stock_adjustment_up']) {
      expect(APPROVAL_KINDS[k]).toMatchObject({ makerPermission: 'inventory.movement.append', checkerPermission: 'inventory.movement.append' });
    }
    // An online-order refund: issued by one person, approved by a holder of the refund-approval authority (M18-FR-04).
    expect(APPROVAL_KINDS['order_refund']).toMatchObject({ makerPermission: 'order.refund.issue', checkerPermission: 'order.refund.approve' });
    // Over-limit service compensation: approved by a holder of the compensation-approval authority (M21-FR-04).
    expect(APPROVAL_KINDS['service_compensation']).toMatchObject({ makerPermission: 'service.case.manage', checkerPermission: 'service.compensation.approve' });
    // A supplier bill: captured by the buyer, checked by someone who may match bills (SP-7a); a supplier payment: approved
    // by another person who may pay suppliers (M23-FR-01).
    expect(APPROVAL_KINDS['supplier_invoice_check']).toMatchObject({ makerPermission: 'purchase.invoice.capture', checkerPermission: 'purchase.invoice.match' });
    expect(APPROVAL_KINDS['supplier_payment']).toMatchObject({ makerPermission: 'purchase.supplier.pay', checkerPermission: 'purchase.supplier.pay' });
  });
  it('a supplier\'s terms (2b-vi-c-1) are approved by the authority that approves suppliers — Purchase Approver / Finance', () => {
    // M06-FR-01 names "Purchase Approver/Finance" as who approves a supplier; D02-FR-06 "Finance approves funding terms".
    expect(APPROVAL_KINDS['display_contract']).toMatchObject({ makerPermission: 'merchandising.display.manage', checkerPermission: 'purchase.supplier.approve' });
    for (const k of ['rebate_scheme', 'purchase_contract']) {
      expect(APPROVAL_KINDS[k]).toMatchObject({ makerPermission: 'purchase.contract.manage', checkerPermission: 'purchase.supplier.approve' });
    }
  });
  it('access (2b-vi-c-2): a store or HR manager asks, the owner approves — M02-FR-04 "separation between requester and granter"', () => {
    for (const k of ['emergency_access', 'access_change']) {
      expect(APPROVAL_KINDS[k]).toMatchObject({ makerPermission: 'identity.role.request', checkerPermission: 'identity.role.grant' });
    }
  });
  it('no kind is a dead end: some role may ask for it and some role may approve it — no permission was invented', () => {
    const held = new Set(ROLE_CATALOGUE.flatMap((r) => r.permissions));
    for (const spec of Object.values(APPROVAL_KINDS)) {
      expect(held.has(spec.makerPermission), `${spec.kind} maker ${spec.makerPermission}`).toBe(true);
      expect(held.has(spec.checkerPermission), `${spec.kind} checker ${spec.checkerPermission}`).toBe(true);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.validForMinutes).toBe(24 * 60);
    }
    expect(Object.keys(APPROVAL_KINDS)).toHaveLength(25); // FUL-14 substitution_above_cap + PA-04 branch_transition
  });
});
