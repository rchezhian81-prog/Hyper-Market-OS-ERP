import { describe, it, expect } from 'vitest';
import { createCompensationSession, COMPENSATION_COPY, planCompensation, requestsForCase } from '../../apps/web-erp/src/compensation-session';
import { createSatisfactionSession, SATISFACTION_COPY, ratableFirst } from '../../apps/web-erp/src/satisfaction-session';
import { createConsentCheckSession, CONSENT_CHECK_COPY, consentStateOf, matchCustomers, CHECKED_CHANNELS } from '../../apps/web-erp/src/consent-check-session';
import { mayWeSend, type ConsentRecord } from '../../services/customer/src/index';

/**
 * **U6 (UI/UX gap audit §27 CRM rows · M21-FR-03 · M21-FR-04 · M16-FR-02 · crm-service.md): the three CRM screens' sessions.**
 *
 *   • Compensation: the desk raises a compensation; within the agent's own authority it is GIVEN (one confirm); above it the
 *     page ASKS a second person through the approvals engine (`service_compensation`) and gives it only with that approval;
 *     above the desk ceiling nothing is sent — refused in words first. The details asked for are exactly the details the
 *     grant route fingerprints, so the approval opens for exactly this grant and nothing else.
 *   • Satisfaction: a resolved case is rated 1–5 in the case's own customer's name (never typed); the resolved cases come
 *     first; an open case is refused by head office in words (nothing weakened here).
 *   • Consent check by name: a few letters find the customer; the state per channel is the SAME rule head office applies at
 *     send time (`mayWeSend`, latest record wins) — pinned against it on the same records.
 */

function fakeHeadOffice(answer: (method: string, path: string, body: unknown) => unknown = () => ({})) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    sent.push({ method: init.method, path, body });
    return { ok: true, status: 200, json: async () => answer(init.method, path, body) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const v = (...permissions: string[]) => ({ userId: 'u-desk', permissions });
const LIMITS = { agentAuthorityMinor: 50_000, deskCeilingMinor: 500_000, ownAuthorityMinor: 50_000, isStandard: true };

describe('every word has a Tamil twin', () => {
  it('in each of the three word tables', () => {
    for (const c of [COMPENSATION_COPY, SATISFACTION_COPY, CONSENT_CHECK_COPY]) {
      expect(Object.keys(c.ta).sort()).toEqual(Object.keys(c.en).sort());
      for (const k of Object.keys(c.en)) expect((c.ta as Record<string, string>)[k], `ta.${k}`).not.toBe('');
    }
  });
});

describe('M21-FR-03 · Compensation raised for a separate approver', () => {
  it('nothing is asked of head office by nobody or by a role without the words', async () => {
    const ho = fakeHeadOffice();
    expect(await createCompensationSession({ viewer: undefined, fetch: ho.fetch }).cases()).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createCompensationSession({ viewer: v('service.case.read'), fetch: ho.fetch });
    expect(await reader.give('c-1', { kind: 'refund', amountMinor: 100, reason: 'late' })).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(await reader.ask('c-1', { kind: 'refund', amountMinor: 100, reason: 'late' })).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(ho.sent).toEqual([]);
  });

  it('plans the route before anything is sent: give within the agent\'s authority, ask above it, refuse above the ceiling', () => {
    expect(planCompensation({ kind: 'refund', rupees: '', reason: 'late' }, LIMITS)).toEqual({ result: 'invalid', why: 'needAmount' });
    expect(planCompensation({ kind: 'refund', rupees: 'abc', reason: 'late' }, LIMITS)).toEqual({ result: 'invalid', why: 'needMoney' });
    expect(planCompensation({ kind: 'refund', rupees: '100', reason: '  ' }, LIMITS)).toEqual({ result: 'invalid', why: 'needReason' });
    expect(planCompensation({ kind: 'cash', rupees: '100', reason: 'late' }, LIMITS)).toEqual({ result: 'invalid', why: 'needKind' });
    expect(planCompensation({ kind: 'refund', rupees: '500', reason: 'late delivery' }, LIMITS)).toEqual({ result: 'ok', value: { amountMinor: 50_000, route: 'give' } });
    expect(planCompensation({ kind: 'goodwill_credit', rupees: '500.01', reason: 'late delivery' }, LIMITS)).toEqual({ result: 'ok', value: { amountMinor: 50_001, route: 'ask' } });
    expect(planCompensation({ kind: 'refund', rupees: '5000.01', reason: 'late delivery' }, LIMITS)).toEqual({ result: 'invalid', why: 'overCeiling' });
    // a person who may approve gives up to the ceiling alone
    expect(planCompensation({ kind: 'refund', rupees: '4000', reason: 'late delivery' }, { ...LIMITS, ownAuthorityMinor: 500_000 })).toEqual({ result: 'ok', value: { amountMinor: 400_000, route: 'give' } });
  });

  it('asks the approvals engine for EXACTLY the details the grant route fingerprints, and gives with the approval it got', async () => {
    const ho = fakeHeadOffice((m, p) => (m === 'POST' && p === '/v1/approvals/requests' ? { requestId: 'areq-1', status: 'waiting', decider: { role: 'owner', named: true, displayName: 'Chezhian' } }
      : m === 'POST' && p.endsWith('/compensation') ? { caseId: 'c-1', compensationId: 'comp-1', granted: true, outcome: 'granted', amountMinor: 50_001, approvedBy: 'u-owner', detail: 'given' }
        : m === 'GET' && p === '/v1/approvals/requests' ? { waitingForMe: [], mine: [
          { requestId: 'areq-1', kind: 'service_compensation', subjectRef: 'c-1', valueMinor: 50_001, status: 'approved', decidedBy: 'u-owner', summary: 's', reason: 'late delivery', details: { kind: 'goodwill_credit', amountMinor: 50_001, reason: 'late delivery', caseId: 'c-1' } },
          { requestId: 'areq-9', kind: 'service_compensation', subjectRef: 'c-9', valueMinor: 1, status: 'waiting', details: {} },
          { requestId: 'areq-2', kind: 'price_change', subjectRef: 'c-1', valueMinor: 1, status: 'approved', details: {} },
        ] } : {}));
    const s = createCompensationSession({ viewer: v('service.case.read', 'service.case.manage'), fetch: ho.fetch });
    const asked = await s.ask('c-1', { kind: 'goodwill_credit', amountMinor: 50_001, reason: ' late delivery ' });
    expect(asked.result).toBe('ok');
    expect(ho.sent.at(-1)).toEqual({ method: 'POST', path: '/v1/approvals/requests', body: {
      kind: 'service_compensation', subjectRef: 'c-1', valueMinor: 50_001,
      details: { kind: 'goodwill_credit', amountMinor: 50_001, reason: 'late delivery', caseId: 'c-1' },
      summary: 'Goodwill credit of ₹500.01 on case c-1', reason: 'late delivery',
    } });
    // only this case's compensation requests, newest status as head office says it
    const rows = await s.requests('c-1');
    expect(rows.result === 'ok' && rows.value.map((r) => r.requestId)).toEqual(['areq-1']);
    expect(requestsForCase([{ requestId: 'x', kind: 'service_compensation', subjectRef: 'c-1', status: 'waiting' }, { requestId: 'y', kind: 'service_compensation', subjectRef: 'c-2', status: 'waiting' }], 'c-1').map((r) => r.requestId)).toEqual(['x']);
    const given = await s.give('c-1', { kind: 'goodwill_credit', amountMinor: 50_001, reason: 'late delivery', approvalId: 'areq-1' });
    expect(given.result === 'ok' && given.value.approvedBy).toBe('u-owner');
    expect(ho.sent.at(-1)).toEqual({ method: 'POST', path: '/v1/service/cases/c-1/compensation', body: { kind: 'goodwill_credit', amountMinor: 50_001, reason: 'late delivery', approvalId: 'areq-1' } });
  });

  it('reads the limits with the caller\'s own authority: an approver gives up to the ceiling alone', async () => {
    const ho = fakeHeadOffice((_m, p) => (p === '/v1/service/compensation-policy' ? { agentAuthorityMinor: 30_000, deskCeilingMinor: 300_000, isDefault: false } : {}));
    const agent = await createCompensationSession({ viewer: v('service.case.read', 'service.case.manage'), fetch: ho.fetch }).limits();
    expect(agent).toEqual({ result: 'ok', value: { agentAuthorityMinor: 30_000, deskCeilingMinor: 300_000, ownAuthorityMinor: 30_000, isStandard: false } });
    const approver = await createCompensationSession({ viewer: v('service.case.read', 'service.case.manage', 'service.compensation.approve'), fetch: ho.fetch }).limits();
    expect(approver.result === 'ok' && approver.value.ownAuthorityMinor).toBe(300_000);
  });
});

describe('M21-FR-04 · Customer satisfaction', () => {
  it('a rating is recorded in the case\'s own customer\'s name, a whole score 1–5, never for nobody', async () => {
    const ho = fakeHeadOffice((m, p) => (m === 'POST' ? { caseId: 'c-1', score: 4, at: '2026-11-07T10:00:00.000Z' } : p === '/v1/service/report' ? { cases: 3, resolved: 2, csatHundredths: 'no_responses', responseRateBps: 'not_meaningful', detail: 'd' } : {}));
    expect(await createSatisfactionSession({ viewer: undefined, fetch: ho.fetch }).report()).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createSatisfactionSession({ viewer: v('service.case.read'), fetch: ho.fetch });
    expect(await reader.record({ caseId: 'c-1', customerRef: 'M-1', score: '4', comment: '' })).toEqual({ result: 'invalid', why: 'cannotManage' });
    const s = createSatisfactionSession({ viewer: v('service.case.read', 'service.case.manage'), fetch: ho.fetch });
    expect(await s.record({ caseId: 'c-1', customerRef: 'M-1', score: '', comment: '' })).toEqual({ result: 'invalid', why: 'needScore' });
    expect(await s.record({ caseId: 'c-1', customerRef: 'M-1', score: '6', comment: '' })).toEqual({ result: 'invalid', why: 'needScore' });
    expect(await s.record({ caseId: 'c-1', customerRef: '', score: '4', comment: '' })).toEqual({ result: 'invalid', why: 'needCustomer' });
    expect(ho.sent).toEqual([]);
    const out = await s.record({ caseId: 'c-1', customerRef: 'M-1', score: '4', comment: '  quick and polite ' });
    expect(out.result).toBe('ok');
    expect(ho.sent.at(-1)).toEqual({ method: 'POST', path: '/v1/service/cases/c-1/satisfaction', body: { customerRef: 'M-1', score: 4, comment: 'quick and polite' } });
    const r = await s.report();
    expect(r.result === 'ok' && r.value.csat).toBe('no_responses');
  });

  it('the cases a customer can rate come first: resolved and closed, newest resolved first; open ones after, said as not ratable', () => {
    const rows = ratableFirst([
      { caseId: 'open', state: 'open', openedAt: '2026-11-01T00:00:00.000Z' },
      { caseId: 'r-old', state: 'resolved', openedAt: '2026-10-01T00:00:00.000Z', resolvedAt: '2026-10-02T00:00:00.000Z' },
      { caseId: 'closed', state: 'closed', openedAt: '2026-10-05T00:00:00.000Z', resolvedAt: '2026-10-06T00:00:00.000Z' },
      { caseId: 'r-new', state: 'resolved', openedAt: '2026-11-03T00:00:00.000Z', resolvedAt: '2026-11-04T00:00:00.000Z' },
      { caseId: 'waiting', state: 'waiting_on_customer', openedAt: '2026-11-02T00:00:00.000Z' },
    ] as never[]);
    expect(rows.map((r) => `${r.caseId}:${r.ratable}`)).toEqual(['r-new:true', 'closed:true', 'r-old:true', 'waiting:false', 'open:false']);
  });
});

describe('M16-FR-02 · Check a customer\'s consent by name', () => {
  const at = (h: number) => `2026-11-07T${String(h).padStart(2, '0')}:00:00.000Z`;
  const records: ConsentRecord[] = [
    { customerId: 'M-1', purpose: 'marketing', channel: 'whatsapp', given: true, recordedAt: at(1), evidence: 'signed the enrolment form at the desk' },
    { customerId: 'M-1', purpose: 'marketing', channel: 'sms', given: true, recordedAt: at(2), evidence: 'ticked yes on the app' },
    { customerId: 'M-1', purpose: 'marketing', channel: 'sms', given: false, recordedAt: at(3), evidence: 'replied STOP' },
    { customerId: 'M-1', purpose: 'profiling', channel: 'email', given: true, recordedAt: at(4), evidence: 'app settings' },
    { customerId: 'M-2', purpose: 'marketing', channel: 'email', given: true, recordedAt: at(5), evidence: 'another person' },
  ];

  it('the state per channel is head office\'s own send-time rule: the latest record wins, a withdrawal after a grant is a withdrawal', () => {
    const state = consentStateOf('M-1', records);
    expect(state.marketing.map((c) => `${c.channel}:${c.verdict}`)).toEqual(['whatsapp:may_send', 'sms:must_not_send', 'email:no_consent_on_record', 'push:no_consent_on_record', 'post:no_consent_on_record']);
    for (const channel of CHECKED_CHANNELS) {
      const mine = state.marketing.find((c) => c.channel === channel)!;
      expect(mine.verdict, channel).toBe(mayWeSend({ customerId: 'M-1', purpose: 'marketing', channel, records, now: at(9) }).verdict);
    }
    expect(state.marketing.find((c) => c.channel === 'sms')).toMatchObject({ evidence: 'replied STOP', at: at(3) });
    expect(state.profiling.map((c) => `${c.channel}:${c.verdict}`)).toContain('email:may_send');
    expect(state.records).toBe(4); // M-2's record is another person's, never shown here
  });

  it('a few letters of the name, or the number, find the customer; nothing matches on less than two letters', () => {
    const customers = [
      { customerRef: 'M-001', name: 'Kavitha Raman', segment: 'loyal' },
      { customerRef: 'M-002', name: 'Ravi Kumar', segment: 'regular' },
      { customerRef: 'M-003', name: null, segment: 'not_profiled' },
    ];
    expect(matchCustomers('ka', customers).map((c) => c.customerRef)).toEqual(['M-001']);
    expect(matchCustomers('RAM', customers).map((c) => c.customerRef)).toEqual(['M-001']);
    expect(matchCustomers('m-00', customers).map((c) => c.customerRef)).toEqual(['M-001', 'M-002', 'M-003']);
    expect(matchCustomers('k', customers)).toEqual([]);
    expect(matchCustomers('kumar', customers).map((c) => c.name)).toEqual(['Ravi Kumar']);
  });

  it('the session reads the directory and one customer\'s records with the consent word; without it nothing is asked', async () => {
    const ho = fakeHeadOffice((_m, p) => (p === '/v1/customer/overview' ? { customers: [{ customerRef: 'M-1', name: 'Kavitha Raman', segment: 'loyal' }] } : p === '/v1/customers/M-1/consent' ? { records } : {}));
    expect(await createConsentCheckSession({ viewer: v('customer.segment.read'), fetch: ho.fetch }).customers()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(ho.sent).toEqual([]);
    const s = createConsentCheckSession({ viewer: v('customer.consent.read', 'customer.segment.read'), fetch: ho.fetch });
    const list = await s.customers();
    expect(list.result === 'ok' && list.value[0]).toMatchObject({ customerRef: 'M-1', name: 'Kavitha Raman' });
    const one = await s.consent('M-1');
    expect(one.result === 'ok' && one.value.marketing.find((c) => c.channel === 'whatsapp')?.verdict).toBe('may_send');
    expect(ho.sent.map((x) => x.path)).toEqual(['/v1/customer/overview', '/v1/customers/M-1/consent']);
  });
});
