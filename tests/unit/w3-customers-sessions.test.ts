import { describe, it, expect } from 'vitest';
import { createDataRequestsSession, fateOf, DATA_REQUESTS_COPY } from '../../apps/web-erp/src/data-requests-session';
import { createCustomerValueSession, readRules, rulesView, CUSTOMER_VALUE_COPY, STANDARD_RULES } from '../../apps/web-erp/src/customer-value-session';
import { createMessageQueueSession, paiseOf, MESSAGE_QUEUE_COPY } from '../../apps/web-erp/src/message-queue-session';
import { createCompensationLimitsSession, COMPENSATION_LIMITS_COPY } from '../../apps/web-erp/src/compensation-limits-session';
import { createGiftCardsSession, GIFT_CARDS_COPY } from '../../apps/web-erp/src/gift-cards-session';
import { createCustomersSession, CUSTOMERS_COPY } from '../../apps/web-erp/src/customers-session';
import { DEFAULT_COMPENSATION_POLICY } from '../../packages/service-desk/src/service-cases';

/**
 * W3 (customers): the Customer data requests (M16-FR-03), Customer value (D07-FR-05 · M16-FR-04), Message queue (M31-FR-04),
 * Compensation limits (M21-FR-03) and Gift cards (D07-FR-04) sessions, and the Customers page's household link (M16-FR-01) —
 * each refuses the cheap things before anything is sent, and sends exactly what head office's route reads.
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
const v = (...permissions: string[]) => ({ userId: 'u-x', permissions });
const lost = (async () => { throw new Error('ENETUNREACH'); }) as unknown as typeof globalThis.fetch;

describe('every word has a Tamil twin', () => {
  it('in each of the six word tables', () => {
    for (const c of [DATA_REQUESTS_COPY, CUSTOMER_VALUE_COPY, MESSAGE_QUEUE_COPY, COMPENSATION_LIMITS_COPY, GIFT_CARDS_COPY, CUSTOMERS_COPY]) expect(Object.keys(c.ta).sort()).toEqual(Object.keys(c.en).sort());
  });
});

describe('M16-FR-03 · Customer data requests', () => {
  it('nothing is asked of head office by nobody, or by a role without the privacy word', async () => {
    const ho = fakeHeadOffice();
    expect(await createDataRequestsSession({ viewer: undefined, fetch: ho.fetch }).queue()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createDataRequestsSession({ viewer: v('customer.profile.read'), fetch: ho.fetch }).queue()).toEqual({ result: 'invalid', why: 'cannotRead' });
    const s = createDataRequestsSession({ viewer: v('privacy.request.manage'), fetch: ho.fetch });
    expect(await s.approve('r1')).toEqual({ result: 'invalid', why: 'cannotApprove' });
    expect(await s.execute('r1')).toEqual({ result: 'invalid', why: 'cannotExecute' });
    expect(await s.raise(' ', 'access')).toEqual({ result: 'invalid', why: 'needCustomer' });
    expect(await s.verify('r1', ' ')).toEqual({ result: 'invalid', why: 'needHow' });
    expect(ho.sent).toEqual([]);
  });

  it('the queue names the late requests from head office\'s overdue read; a request is raised, verified, approved and run on their routes', async () => {
    const ho = fakeHeadOffice((_m, p) => (p === '/v1/privacy/data-requests' ? { queue: [{ requestId: 'r1', customerRef: 'c-1', kind: 'erasure', state: 'verified', raisedAt: '2026-10-01T05:00:00.000Z', dueBy: '2026-10-16' }, { requestId: 'r2', customerRef: 'c-2', kind: 'access', state: 'raised', raisedAt: '2026-11-01T05:00:00.000Z', dueBy: '2026-11-16' }] }
      : p === '/v1/privacy/data-requests/overdue' ? { overdue: [{ requestId: 'r1', customerRef: 'c-1', kind: 'erasure', daysOverdue: 17 }] }
        : p.endsWith('/erasure-execution') ? { state: 'partially_fulfilled', customerStatement: ['Your contact details were erased.', '2 record(s) are kept in full because the GST law requires it.'] }
          : {}));
    const s = createDataRequestsSession({ viewer: v('privacy.request.manage', 'privacy.erasure.approve', 'privacy.erasure.execute'), fetch: ho.fetch });
    const q = await s.queue();
    expect(q.result === 'ok' && q.value.overdue.map((r) => r.requestId)).toEqual(['r1']);
    expect(q.result === 'ok' && q.value.queue).toHaveLength(2);
    await s.raise(' c-9 ', 'erasure');
    expect(ho.sent.at(-1)).toMatchObject({ method: 'POST', body: { customerRef: 'c-9', kind: 'erasure' } });
    expect(ho.sent.at(-1)!.path).toMatch(/^\/v1\/privacy\/data-requests\/dsr-[A-Za-z0-9]+$/);
    await s.verify('r2', ' saw her Aadhaar-free ration card at the desk ');
    expect(ho.sent.at(-1)).toEqual({ method: 'POST', path: '/v1/privacy/data-requests/r2/verification', body: { verifiedBy: 'saw her Aadhaar-free ration card at the desk' } });
    await s.approve('r1');
    expect(ho.sent.at(-1)).toEqual({ method: 'POST', path: '/v1/privacy/data-requests/r1/erasure-approval', body: {} });
    expect(await s.execute('r1')).toEqual({ result: 'ok', value: { state: 'partially_fulfilled', customerStatement: 'Your contact details were erased. 2 record(s) are kept in full because the GST law requires it.' } });
  });

  it('a copy is the record and the personal data head office holds, handed over through the fulfilment route, as a file', async () => {
    const ho = fakeHeadOffice((_m, p) => (p.endsWith('/profile') ? { customerRef: 'c-2', purchases: { count: 3 } }
      : p.startsWith('/v1/privacy/pii/') ? { categories: [{ category: 'contact', recordCount: 1, state: 'held' }] }
        : p.endsWith('/fulfilment') ? { payload: { customerRecord: { customerRef: 'c-2' } } } : {}));
    const s = createDataRequestsSession({ viewer: v('privacy.request.manage'), fetch: ho.fetch });
    const out = await s.exportFor({ requestId: 'r2', customerRef: 'c-2', kind: 'export', state: 'verified', raisedAt: '', dueBy: '' });
    expect(ho.sent.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/customers/c-2/profile', 'GET /v1/privacy/pii/c-2', 'POST /v1/privacy/data-requests/r2/fulfilment']);
    expect(ho.sent[2]!.body).toEqual({ held: { customerRecord: { customerRef: 'c-2', purchases: { count: 3 } }, personalDataHeld: [{ category: 'contact', recordCount: 1, state: 'held' }] } });
    expect(out.result === 'ok' && out.value.fileName).toBe('data-request-r2.json');
    expect(out.result === 'ok' && JSON.parse(out.value.contents).data).toEqual({ customerRecord: { customerRef: 'c-2' } });
  });

  it('a customer with no bill has no record at head office (404): the copy says null for it, never a made-up record; another refusal stops it', async () => {
    const answer = (status: number) => (async (path: string, init: { method: string; body?: string }) => {
      if (path.endsWith('/profile')) return { ok: false, status, json: async () => ({ error: { code: 'not_found', whatHappened: 'There is no a customer record' } }) };
      return { ok: true, status: 200, json: async () => (path.endsWith('/fulfilment') ? { payload: JSON.parse(init.body ?? '{}').held } : { categories: [] }) };
    }) as unknown as typeof globalThis.fetch;
    const r = { requestId: 'r3', customerRef: 'c-3', kind: 'access', state: 'verified', raisedAt: '', dueBy: '' };
    const ok = await createDataRequestsSession({ viewer: v('privacy.request.manage'), fetch: answer(404) }).exportFor(r);
    expect(ok.result === 'ok' && JSON.parse(ok.value.contents).data).toEqual({ customerRecord: null, personalDataHeld: [] });
    expect((await createDataRequestsSession({ viewer: v('privacy.request.manage'), fetch: answer(403) }).exportFor(r)).result).toBe('refused');
  });

  it('what an erasure will do is head office\'s planner rule: no legal basis → erased; a basis → kept, or name removed when minimisable', () => {
    expect(fateOf({ state: 'held' })).toBe('erase');
    expect(fateOf({ state: 'held', retentionBasis: 'tax_invoice' })).toBe('keep');
    expect(fateOf({ state: 'held', retentionBasis: 'gst_record', minimisable: true })).toBe('minimise');
    expect(fateOf({ state: 'erased' })).toBe('done');
  });

  it('a lost line is said, never guessed', async () => {
    expect(await createDataRequestsSession({ viewer: v('privacy.request.manage'), fetch: lost }).queue()).toEqual({ result: 'lost_link' });
  });
});

describe('D07-FR-05 · M16-FR-04 · Customer value', () => {
  it('the ranking is head office\'s, by profit with spend beside it; the rules show the standard numbers until the shop sets its own', async () => {
    const ho = fakeHeadOffice((_m, p) => (p.startsWith('/v1/customer/segments/value-ranking') ? { ranking: [{ customerRef: 'c-1', lifetimeMarginMinor: 600_000, lifetimeRevenueMinor: 2_000_000, marginBps: 3000 }, { customerRef: 'c-2', lifetimeMarginMinor: 200_000, lifetimeRevenueMinor: 5_000_000, marginBps: 400 }] }
      : { policy: { loyalAtOrders: 8 }, set: true }));
    const s = createCustomerValueSession({ viewer: v('customer.segment.read'), fetch: ho.fetch });
    const r = await s.ranking(5);
    expect(ho.sent.at(-1)!.path).toBe('/v1/customer/segments/value-ranking?top=5');
    expect(r.result === 'ok' && r.value.map((x) => [x.rank, x.customerRef, x.marginMinor, x.spendMinor])).toEqual([[1, 'c-1', 600_000, 2_000_000], [2, 'c-2', 200_000, 5_000_000]]);
    const rules = await s.rules();
    expect(rules.result === 'ok' && rules.value.rules.find((x) => x.rule === 'loyalAtOrders')).toEqual({ rule: 'loyalAtOrders', value: 8, shopsOwn: true });
    expect(rules.result === 'ok' && rules.value.rules.find((x) => x.rule === 'lapsedAfterDays')).toEqual({ rule: 'lapsedAfterDays', value: STANDARD_RULES.lapsedAfterDays, shopsOwn: false });
    expect(await s.saveRules({ loyalAtOrders: '6' })).toEqual({ result: 'invalid', why: 'cannotManage' });
  });

  it('the standard numbers are head office\'s engine defaults, not this page\'s', () => {
    expect(rulesView({}, false).rules.map((r) => r.value)).toEqual([2, 10, 60, 180, 1]);
  });

  it('saving sends only the rules typed (empty keeps the standard); a rule that is not a whole number is refused before sending', async () => {
    expect(readRules({ loyalAtOrders: '6', newBelowOrders: '' })).toEqual({ loyalAtOrders: 6 });
    expect(readRules({ lapsingAfterDays: '4.5' })).toBe('needWhole');
    const ho = fakeHeadOffice(() => ({ policy: { loyalAtOrders: 6 }, set: true }));
    const s = createCustomerValueSession({ viewer: v('customer.segment.read', 'customer.segment.manage'), fetch: ho.fetch });
    expect(await s.saveRules({ loyalAtOrders: 'six' })).toEqual({ result: 'invalid', why: 'needWhole' });
    expect(ho.sent).toEqual([]);
    const out = await s.saveRules({ loyalAtOrders: ' 6 ' });
    expect(ho.sent[0]).toEqual({ method: 'POST', path: '/v1/customer/segments/policy', body: { loyalAtOrders: 6 } });
    expect(out.result === 'ok' && out.value.set).toBe(true);
  });
});

describe('M31-FR-04 · Message queue', () => {
  it('a budget the owner has not set is null, never a made-up number; the three queues are read as head office keeps them', async () => {
    const ho = fakeHeadOffice((_m, p) => (p === '/v1/notifications/budget' ? { period: '2026-11', budget: null, spentMinor: 0, remainingMinor: 0, held: [{ id: 'n-1', channel: 'sms', attempts: 0, reason: 'no_budget_set: the owner has not set a messaging budget' }] }
      : p.endsWith('/pending') ? { pending: [{ id: 'n-1', channel: 'sms', state: 'pending', attempts: 0, reason: 'no_budget_set: x' }] }
        : p.endsWith('/withheld') ? { withheld: [] } : { deadLetters: [{ id: 'n-0', channel: 'whatsapp', state: 'dead_letter', attempts: 5, reason: 'provider said: number not on WhatsApp' }] }));
    const s = createMessageQueueSession({ viewer: v('notification.send.check'), fetch: ho.fetch });
    const b = await s.budget();
    expect(b.result === 'ok' && b.value.budget).toBeNull();
    expect(b.result === 'ok' && b.value.held).toHaveLength(1);
    const q = await s.queue();
    expect(q.result === 'ok' && q.value.deadLetters[0]).toEqual({ id: 'n-0', channel: 'whatsapp', attempts: 5, reason: 'provider said: number not on WhatsApp' });
    expect(await s.setBudget({ cap: '500', costs: { sms: '0.25' } })).toEqual({ result: 'invalid', why: 'cannotSet' });
  });

  it('the owner\'s budget is sent in paise exactly as typed in rupees; nothing is sent without a cap and one channel\'s cost', async () => {
    expect(paiseOf('0.25')).toBe(25); expect(paiseOf('500')).toBe(50_000); expect(paiseOf('1.5')).toBe(150); expect(paiseOf('0.255')).toBeUndefined(); expect(paiseOf('₹5')).toBeUndefined();
    const ho = fakeHeadOffice(() => ({ period: '2026-11', budget: { capMinor: 50_000, costMinorByChannel: { sms: 25 }, version: 1, setBy: 'u-x', setAt: 't' }, spentMinor: 0, remainingMinor: 50_000, held: [] }));
    const s = createMessageQueueSession({ viewer: v('notification.send.check', 'notification.budget.set'), fetch: ho.fetch });
    expect(await s.setBudget({ cap: '', costs: { sms: '0.25' } })).toEqual({ result: 'invalid', why: 'needCap' });
    expect(await s.setBudget({ cap: '500', costs: {} })).toEqual({ result: 'invalid', why: 'needCost' });
    expect(await s.setBudget({ cap: '500', costs: { sms: 'a quarter' } })).toEqual({ result: 'invalid', why: 'needMoney' });
    expect(ho.sent).toEqual([]);
    const out = await s.setBudget({ cap: '500', costs: { sms: '0.25', email: '' } });
    expect(ho.sent[0]).toEqual({ method: 'POST', path: '/v1/notifications/budget', body: { capMinor: 50_000, costMinorByChannel: { sms: 25 } } });
    expect(out.result === 'ok' && out.value.budget?.version).toBe(1);
  });
});

describe('M21-FR-03 · Compensation limits', () => {
  it('the limits in force say when they are head office\'s standard ones; only the owner\'s word may change them, the agent never above the ceiling', async () => {
    const ho = fakeHeadOffice(() => ({ ...DEFAULT_COMPENSATION_POLICY, isDefault: true }));
    const read = await createCompensationLimitsSession({ viewer: v('service.case.read'), fetch: ho.fetch }).limits();
    expect(read).toEqual({ result: 'ok', value: { agentAuthorityMinor: 50_000, deskCeilingMinor: 500_000, isStandard: true } });
    expect(await createCompensationLimitsSession({ viewer: v('service.case.read'), fetch: ho.fetch }).save({ agent: '300', ceiling: '3000' })).toEqual({ result: 'invalid', why: 'cannotSet' });
    const s = createCompensationLimitsSession({ viewer: v('service.case.read', 'service.compensation.approve'), fetch: ho.fetch });
    expect(await s.save({ agent: '3000', ceiling: '300' })).toEqual({ result: 'invalid', why: 'needOrder' });
    expect(await s.save({ agent: '', ceiling: '300' })).toEqual({ result: 'invalid', why: 'needBoth' });
    ho.sent.length = 0;
    await s.save({ agent: '300', ceiling: '3000' });
    expect(ho.sent[0]).toEqual({ method: 'POST', path: '/v1/service/compensation-policy', body: { agentAuthorityMinor: 30_000, deskCeilingMinor: 300_000 } });
  });
});

describe('D07-FR-04 · Gift cards on the office screen', () => {
  it('issue sends a gift card with its value in paise and its buyer; a blank card, buyer or a non-amount is refused first', async () => {
    const ho = fakeHeadOffice(() => ({ instrumentId: 'GC-1', kind: 'gift_card', balanceMinor: 100_000 }));
    const s = createGiftCardsSession({ viewer: v('loyalty.value.read', 'loyalty.value.issue', 'loyalty.value.redeem'), fetch: ho.fetch });
    expect(await s.issue({ card: ' ', boughtBy: 'c-1', value: '1000', expiresOn: '' })).toEqual({ result: 'invalid', why: 'needCard' });
    expect(await s.issue({ card: 'GC-1', boughtBy: '', value: '1000', expiresOn: '' })).toEqual({ result: 'invalid', why: 'needOwner' });
    expect(await s.issue({ card: 'GC-1', boughtBy: 'c-1', value: '0', expiresOn: '' })).toEqual({ result: 'invalid', why: 'needMoney' });
    expect(await s.issue({ card: 'GC-1', boughtBy: 'c-1', value: '1000', expiresOn: 'next year' })).toEqual({ result: 'invalid', why: 'needDate' });
    expect(ho.sent).toEqual([]);
    expect(await s.issue({ card: ' GC-1 ', boughtBy: 'c-1', value: '1000', expiresOn: '2027-11-01' })).toEqual({ result: 'ok', value: { balanceMinor: 100_000 } });
    expect(ho.sent[0]).toEqual({ method: 'POST', path: '/v1/stored-value/instruments', body: { instrumentId: 'GC-1', kind: 'gift_card', ownerRef: 'c-1', faceValueMinor: 100_000, channel: 'store', expiresOn: '2027-11-01' } });
  });

  it('a payment re-sent after a lost answer is the SAME redemption (one movement id per press), never a second one', async () => {
    const ho = fakeHeadOffice(() => ({ instrumentId: 'GC-1', balanceMinor: 70_000 }));
    const s = createGiftCardsSession({ viewer: v('loyalty.value.redeem'), fetch: ho.fetch });
    const first = await s.redeem({ card: 'GC-1', amount: '300', channel: 'phone' }, 'gcr-press-1');
    await s.redeem({ card: 'GC-1', amount: '300', channel: 'phone' }, 'gcr-press-1');
    expect(ho.sent.map((x) => x.body)).toEqual([{ movementId: 'gcr-press-1', amountMinor: 30_000, channel: 'phone' }, { movementId: 'gcr-press-1', amountMinor: 30_000, channel: 'phone' }]);
    expect(first).toEqual({ result: 'ok', value: { balanceMinor: 70_000, alreadyApplied: false, movementId: 'gcr-press-1' } });
    expect(await s.look('GC-1')).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await createGiftCardsSession({ viewer: v('loyalty.value.redeem'), fetch: lost }).redeem({ card: 'GC-1', amount: '1', channel: 'store' })).toEqual({ result: 'lost_link' });
  });
});

describe('M16-FR-01 · the Customers page links a household and reads the identity history', () => {
  it('a link and an unlink are head office\'s household route; a blank household is refused first; the reader cannot link', async () => {
    const ho = fakeHeadOffice(() => ({ customerRef: 'c-1', merges: [] }));
    const s = createCustomersSession({ viewer: v('customer.segment.read', 'customer.profile.read', 'customer.identity.manage'), fetch: ho.fetch });
    expect(await s.linkHousehold('c-1', ' ')).toEqual({ result: 'invalid', why: 'needHousehold' });
    expect(ho.sent).toEqual([]);
    await s.linkHousehold('c-1', ' kumar-family ');
    await s.unlinkHousehold('c-1');
    await s.identityHistory('c-1');
    expect(ho.sent).toEqual([
      { method: 'POST', path: '/v1/customers/c-1/household', body: { householdId: 'kumar-family' } },
      { method: 'POST', path: '/v1/customers/c-1/household', body: { unlink: true } },
      { method: 'GET', path: '/v1/customers/c-1/identity-history', body: undefined },
    ]);
    expect(await createCustomersSession({ viewer: v('customer.segment.read', 'customer.profile.read'), fetch: ho.fetch }).linkHousehold('c-1', 'h')).toEqual({ result: 'invalid', why: 'cannotLink' });
  });
});
