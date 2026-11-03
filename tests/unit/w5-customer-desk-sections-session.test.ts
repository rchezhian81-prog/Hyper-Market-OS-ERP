import { describe, it, expect } from 'vitest';
import {
  createDeskSession, deskWords, deskOutcomeWords, instantOf, paiseOf, listOf, DESK_COPY, SECTION_WORDS,
} from '../../apps/web-erp/src/customer-desk-sections-session';

/**
 * W5 · route audit bundle 8 — the sections added to twelve office pages over head-office routes no screen called:
 * M16-FR-04 (who looked) · C5 (nominee, DPDP s.14) · M20-FR-04 (sealed erasure record) · M01-FR-02 (processor register) ·
 * C2 (breach, DPDP s.8(6)) · M16-FR-02 (member leaves) · PA-08 r6 (template withdrawal) · M21-FR-01 (campaign log) ·
 * OB-324 (consent exceptions) · M21-FR-04 (first reply, compensation, CSAT) · PF-11 (carry out again) · M17-FR-04 (household
 * balance) · D09-FR-05 / WF-15 (proof of delivery) · M19-FR-02 (hand-back count) · M19-FR-01 (reassign) · FUL-14 (substitution
 * answer told to staff) · M20-FR-03 (order notices) · P-04 (refused-access register).
 * The session refuses only the cheap things before a request, sends each route exactly its documented body, and never
 * writes on open.
 */

type Sent = { method: string; path: string; body?: unknown; key?: string };
function fakeFetch(reply: (r: Sent) => { status?: number; body: unknown } = () => ({ body: {} })) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const r: Sent = { method: init?.method ?? 'GET', path: String(url), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }), ...(headers['idempotency-key'] ? { key: headers['idempotency-key'] } : {}) };
    sent.push(r);
    const out = reply(r);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const ALL = Object.values(SECTION_WORDS);
const desk = (perms: readonly string[] = ALL, f = fakeFetch(), userId: string | null = 'u-desk') =>
  ({ s: createDeskSession({ viewer: userId === null ? undefined : { userId, permissions: perms }, fetch: f.fetch, newKey: () => 'k-1' }), sent: f.sent });

describe('W5 customer-desk sections — the session (bundle 8)', () => {
  it('every word has a Tamil twin, and the outcome words name a refusal in head office\'s own sentence', () => {
    expect(Object.keys(DESK_COPY.ta).sort()).toEqual(Object.keys(DESK_COPY.en).sort());
    expect(deskWords('ta', 'viewsH')).not.toBe(deskWords('en', 'viewsH'));
    expect(deskOutcomeWords('en', { result: 'refused', status: 409, code: 'x', whatHappened: 'No.' })).toBe('Head office refused: No.');
    expect(deskOutcomeWords('en', { result: 'lost_link' })).toMatch(/cannot be reached/);
  });

  it('nobody signed in, or a role without the word: refused before any request — nothing is sent', async () => {
    const nobody = desk(ALL, fakeFetch(), null);
    expect(nobody.s.may.named).toBe(false);
    expect(await nobody.s.profileViews('c-1')).toEqual({ result: 'invalid', why: 'nobody' });
    const cashier = desk(['order.read']);
    expect(cashier.s.may.views).toBe(false); expect(cashier.s.may.orderRead).toBe(true);
    expect(await cashier.s.profileViews('c-1')).toEqual({ result: 'invalid', why: 'cannot' });
    expect(await cashier.s.grant('K-1', { kind: 'refund', rupees: '10', reason: 'x', approvalId: '' })).toEqual({ result: 'invalid', why: 'cannot' });
    expect(nobody.sent).toEqual([]); expect(cashier.sent).toEqual([]);
  });

  it('cheap refusals: an empty code, a bad amount, a score out of range, an unread time — nothing is sent', async () => {
    const { s, sent } = desk();
    expect(await s.profileViews('  ')).toEqual({ result: 'invalid', why: 'needCustomer' });
    expect(await s.grant('K-1', { kind: 'refund', rupees: '1.234', reason: 'late', approvalId: '' })).toEqual({ result: 'invalid', why: 'needRupees' });
    expect(await s.grant('K-1', { kind: 'refund', rupees: '0', reason: 'late', approvalId: '' })).toEqual({ result: 'invalid', why: 'needRupees' });
    expect(await s.rate('K-1', { customerRef: 'c-1', score: '6', comment: '' })).toEqual({ result: 'invalid', why: 'needScore' });
    expect(await s.assessBreach({ breachId: 'B-1', categories: 'phone', count: '3', discovered: 'yesterday' })).toEqual({ result: 'invalid', why: 'needWhen' });
    expect(await s.assessBreach({ breachId: 'B-1', categories: 'phone', count: 'three', discovered: '2026-11-03T10:00' })).toEqual({ result: 'invalid', why: 'needNumber' });
    expect(await s.handback('O-1', { L1: 'two' })).toEqual({ result: 'invalid', why: 'needNumber' });
    expect(await s.reassign('X-1', 'nobody_queue', 'wrong desk')).toEqual({ result: 'invalid', why: 'needText' });
    expect(await s.recordPreference('O-1', { preference: 'contact_me', method: 'carrier_pigeon', reference: 'r' })).toEqual({ result: 'invalid', why: 'needText' });
    expect(await s.leave('M-1', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.recordProcessor({ vendorId: 'v', vendorName: 'V', categories: '', purpose: 'p', contractRef: 'c', contractFrom: '2026-01-01', contractUntil: '' })).toEqual({ result: 'invalid', why: 'needText' });
    expect(sent).toEqual([]);
  });

  it('each read asks its own route; each write sends exactly its documented body with an idempotency key', async () => {
    const { s, sent } = desk();
    await s.profileViews('c 1');
    await s.nomination('c-1');
    await s.activateNominee('c-1', { nomineeRef: 'cust-2', basis: 'death', evidenceRef: 'DC-77' });
    await s.tombstone('dsr-1');
    await s.processors();
    await s.recordProcessor({ vendorId: 'sms-co', vendorName: 'SMS Co', categories: 'phone, name ,', purpose: 'order messages', contractRef: 'C-9', contractFrom: '2026-01-01', contractUntil: '' });
    await s.leave('M-1', 'asked to stop');
    await s.withdrawTemplate('tpl-1', 2, 'offer recalled');
    await s.campaignLog(); await s.consentExceptions();
    await s.firstReply('K-1'); await s.compensations('K-1');
    await s.grant('K-1', { kind: 'goodwill_credit', rupees: '150.5', reason: 'late delivery', approvalId: ' ap-1 ' });
    await s.carryOutAgain('K-1', 'comp-1');
    await s.rate('K-1', { customerRef: 'c-1', score: '4', comment: '' });
    await s.household('c-1'); await s.proof('O-1'); await s.proofImage('img-1'); await s.packLines('O-1');
    await s.handback('O-1', { L1: '2', L2: '0' });
    await s.reassign('X-1', 'duty_manager', 'needs a manager');
    await s.recordPreference('O-1', { preference: 'contact_me', method: 'phone', reference: 'call 10:42' });
    await s.orderNotices(); await s.accessRefusals();
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/customers/c%201/profile/views', 'GET /v1/privacy/nominees/c-1', 'POST /v1/privacy/nominees/c-1/activation',
      'GET /v1/privacy/data-requests/dsr-1/tombstone', 'GET /v1/privacy/processor-contracts', 'POST /v1/privacy/processor-contracts',
      'POST /v1/loyalty/members/M-1/leave', 'POST /v1/notifications/templates/tpl-1/withdrawal', 'GET /v1/service/campaigns/plans',
      'GET /v1/privacy/consent-manager/exceptions', 'POST /v1/service/cases/K-1/first-response', 'GET /v1/service/cases/K-1/compensations',
      'POST /v1/service/cases/K-1/compensation', 'POST /v1/service/cases/K-1/compensations/comp-1/fulfil', 'POST /v1/service/cases/K-1/satisfaction',
      'GET /v1/stored-value/households/c-1/balance', 'GET /v1/delivery/orders/O-1/proof', 'GET /v1/delivery/proof-images/img-1',
      'GET /v1/fulfilment/orders/O-1/pack', 'POST /v1/fulfilment/orders/O-1/handback', 'POST /v1/orders/substitution-exceptions/X-1/reassign',
      'POST /v1/orders/O-1/substitution-preference', 'GET /v1/storefront/order-notices', 'GET /v1/storefront/access-refusals',
    ]);
    const body = (p: string) => sent.find((r) => r.method === 'POST' && r.path === p)?.body;
    expect(body('/v1/privacy/nominees/c-1/activation')).toEqual({ activationId: 'act-c-1-cust-2-DC-77', nomineeRef: 'cust-2', basis: 'death', evidenceRef: 'DC-77' });
    expect(body('/v1/privacy/processor-contracts')).toEqual({ vendorId: 'sms-co', vendorName: 'SMS Co', dataCategories: ['phone', 'name'], purpose: 'order messages', contractRef: 'C-9', contractFrom: '2026-01-01' });
    expect(body('/v1/notifications/templates/tpl-1/withdrawal')).toEqual({ version: 2, reason: 'offer recalled' });
    expect(body('/v1/service/cases/K-1/compensation')).toEqual({ kind: 'goodwill_credit', amountMinor: 15_050, reason: 'late delivery', approvalId: 'ap-1' });
    expect(body('/v1/service/cases/K-1/satisfaction')).toEqual({ customerRef: 'c-1', score: 4 });
    expect(body('/v1/fulfilment/orders/O-1/handback')).toEqual({ lines: [{ lineId: 'L1', quantityMinor: 2 }, { lineId: 'L2', quantityMinor: 0 }] });
    expect(body('/v1/orders/substitution-exceptions/X-1/reassign')).toEqual({ toOwner: 'duty_manager', reasonCode: 'needs a manager' });
    expect(body('/v1/orders/O-1/substitution-preference')).toEqual({ rules: { preference: 'contact_me' }, contact: { method: 'phone', reference: 'call 10:42' } });
    expect(sent.filter((r) => r.method === 'POST').every((r) => r.key === 'k-1')).toBe(true);
    expect(sent.filter((r) => r.method === 'GET').every((r) => r.key === undefined)).toBe(true);
  });

  it('the breach times are the shop\'s own wall clock, sent as the instant they name; optional notice content only when typed', async () => {
    const { s, sent } = desk();
    await s.assessBreach({ breachId: 'B-1', categories: 'phone, address', count: '12', discovered: '2026-11-03T21:15', description: 'a list left on the counter', boardIntimatedAt: '2026-11-03T22:00' });
    expect(sent[0]!.body).toEqual({ breachId: 'B-1', discoveredAt: '2026-11-03T15:45:00.000Z', affectedDataCategories: ['phone', 'address'], affectedPrincipalCount: 12, description: 'a list left on the counter', boardIntimatedAt: '2026-11-03T16:30:00.000Z' });
    expect(instantOf('2026-11-04T00:30')).toBe('2026-11-03T19:00:00.000Z'); // the shop's small hours are the UTC evening before
    expect(instantOf('2026-11-04 00:30')).toBeUndefined();
    expect(paiseOf('150')).toBe(15_000); expect(paiseOf('150.5')).toBe(15_050); expect(paiseOf('-1')).toBeUndefined();
    expect(listOf(' a, ,b ')).toEqual(['a', 'b']);
  });

  it('the approved messages are the latest state of each version (a withdrawn one is not offered); finished erasures only', async () => {
    const f = fakeFetch((r) => (r.path === '/v1/notifications/templates'
      ? { body: { templates: [
        { templateId: 'b', version: 1, purpose: 'marketing', channel: 'sms', body: 'B', state: 'approved' },
        { templateId: 'a', version: 1, purpose: 'marketing', channel: 'sms', body: 'A', state: 'approved' },
        { templateId: 'a', version: 1, purpose: 'marketing', channel: 'sms', body: 'A', state: 'withdrawn' },
        { templateId: 'a', version: 2, purpose: 'marketing', channel: 'sms', body: 'A2', state: 'draft' },
      ] } }
      : { body: { queue: [
        { requestId: 'r1', customerRef: 'c1', kind: 'erasure', state: 'partially_fulfilled' }, { requestId: 'r2', customerRef: 'c2', kind: 'erasure', state: 'verified' },
        { requestId: 'r3', customerRef: 'c3', kind: 'export', state: 'fulfilled' }, { requestId: 'r4', customerRef: 'c4', kind: 'erasure', state: 'fulfilled' },
      ] } }));
    const { s } = desk(ALL, f);
    const t = await s.approvedTemplates();
    expect(t.result === 'ok' && t.value.map((x) => `${x.templateId}/${x.version}`)).toEqual(['b/1']);
    const e = await s.finishedErasures();
    expect(e.result === 'ok' && e.value.map((x) => x.requestId)).toEqual(['r1', 'r4']);
    expect(f.sent.map((r) => r.path)).toEqual(['/v1/notifications/templates', '/v1/privacy/data-requests?state=all']);
  });

  it('a refusal comes back in head office\'s words; a lost link says nothing was changed', async () => {
    const refused = desk(ALL, fakeFetch(() => ({ status: 409, body: { error: { code: 'case_not_resolved', whatHappened: 'Case K-1 is open.' } } })));
    expect(await refused.s.rate('K-1', { customerRef: 'c-1', score: '5', comment: 'great' })).toEqual({ result: 'refused', status: 409, code: 'case_not_resolved', whatHappened: 'Case K-1 is open.' });
    const lost = createDeskSession({ viewer: { userId: 'u', permissions: ALL }, fetch: (async () => { throw new Error('down'); }) as unknown as typeof globalThis.fetch });
    expect(await lost.household('c-1')).toEqual({ result: 'lost_link' });
  });
});
