import { describe, it, expect } from 'vitest';
import { createCustomersSession, readCandidates, CUSTOMERS_COPY } from '../../apps/web-erp/src/customers-session';
import { createAffinitySession, AFFINITY_COPY } from '../../apps/web-erp/src/basket-affinity-session';
import { createEventsSession, effectWords, EVENTS_COPY } from '../../apps/web-erp/src/demand-events-session';
import { createBriefSession, BRIEF_COPY } from '../../apps/web-erp/src/morning-brief-session';

/** R4 Lane 3 — the four insight pages' sessions: what they refuse before a request, and what they ask head office. */
function recorder() {
  const calls: { url: string; method: string; body: unknown; key: string | undefined }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), key: headers['idempotency-key'] });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const viewer = (...permissions: string[]) => ({ userId: 'u-1', permissions });

describe('the Customers session (M16)', () => {
  it('reads the desk\'s records line by line and refuses fewer than two', () => {
    expect(readCandidates('M-1, 98400 11111, yes, Anu\nM-2, 9840011111, no, Anu R')).toEqual([
      { customerId: 'M-1', phone: '98400 11111', phoneVerified: true, name: 'Anu' },
      { customerId: 'M-2', phone: '9840011111', phoneVerified: false, name: 'Anu R' },
    ]);
    expect(readCandidates('M-1, 1, yes')).toBeUndefined();
  });

  it('asks nothing without the permission or a reason; proposes, approves and undoes on head office\'s own routes', async () => {
    const r = recorder();
    const none = createCustomersSession({ viewer: undefined, fetch: r.fetch });
    expect(await none.overview()).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createCustomersSession({ viewer: viewer('customer.segment.read'), fetch: r.fetch });
    expect(await reader.propose('M-1', 'M-2', 'x')).toEqual({ result: 'invalid', why: 'cannotPropose' });
    expect(await reader.approve('mg-1')).toEqual({ result: 'invalid', why: 'cannotApprove' });
    expect(r.calls).toEqual([]);
    const s = createCustomersSession({ viewer: viewer('customer.segment.read', 'customer.identity.manage', 'customer.identity.approve'), fetch: r.fetch, newKey: () => 'k' });
    expect(await s.propose('M-1', 'M-2', '  ')).toEqual({ result: 'invalid', why: 'needReason' });
    await s.overview();
    await s.propose('M-1', 'M-2', 'same phone');
    await s.approve('mg-1');
    await s.undo('mg-1', 'two people');
    expect(r.calls.map((c) => `${c.method} ${c.url.replace(/mg-[A-Za-z0-9]{12}/, 'mg-X')}`)).toEqual(['GET /v1/customer/overview', 'POST /v1/customers/M-1/merges/mg-X', 'POST /v1/customers/merges/mg-1/approve', 'POST /v1/customers/merges/mg-1/reverse']);
    expect(r.calls.filter((c) => c.method === 'POST').every((c) => c.key === 'k')).toBe(true);
  });
});

describe('the Bought together session (D-23)', () => {
  it('invents no minimum; a promotion is a draft definition on the existing route', async () => {
    const r = recorder();
    const s = createAffinitySession({ viewer: viewer('reporting.report.read', 'promotion.launch'), fetch: r.fetch });
    expect(await s.pairs('2030-01-01', '2030-01-31', '', '')).toEqual({ result: 'invalid', why: 'needWindow' });
    await s.pairs('2030-01-01', '2030-01-31', '3', 'grocery');
    const pair = { productA: 'a', productB: 'b', basketCount: 3, basketsWithA: 3, basketsWithB: 3, support: 0.3, confidenceAtoB: 1, confidenceBtoA: 1, lift: 3.3, suggestions: [] };
    expect(await s.draftPromotion(pair, '0', '2030-02-01', '2030-02-28')).toEqual({ result: 'invalid', why: 'needPromo' });
    await s.draftPromotion(pair, '5', '2030-02-01', '2030-02-28');
    expect(r.calls[0]!.url).toBe('/v1/reporting/basket-affinity?from=2030-01-01&to=2030-01-31&minBaskets=3&department=grocery');
    expect(r.calls[1]!.url).toMatch(/^\/v1\/promotions\/aff-[A-Za-z0-9]+\/definition$/);
    expect(r.calls[1]!.body).toEqual({ kind: 'percent_off', percentBps: 500, productIds: ['a', 'b'], startsAt: '2030-02-01T00:00:00.000Z', endsAt: '2030-02-28T23:59:59.000Z' });
    expect(await createAffinitySession({ viewer: viewer('reporting.report.read'), fetch: r.fetch }).draftPromotion(pair, '5', '2030-02-01', '2030-02-28')).toEqual({ result: 'invalid', why: 'cannotDraft' });
  });
});

describe('the Store events session (D-24)', () => {
  it('only a manager records; the effect must be a positive number; the forecast is read with no extra step', async () => {
    const r = recorder();
    const reader = createEventsSession({ viewer: viewer('inventory.availability.read'), fetch: r.fetch });
    expect(await reader.record({ storeId: 'S1', label: 'Pongal', kind: 'festival', from: '2030-01-14', to: '2030-01-15', effect: '1.5', products: '' })).toEqual({ result: 'invalid', why: 'cannotManage' });
    const mgr = createEventsSession({ viewer: viewer('inventory.availability.read', 'inventory.demand-event.manage'), fetch: r.fetch });
    expect(await mgr.record({ storeId: 'S1', label: 'Pongal', kind: 'festival', from: '2030-01-14', to: '2030-01-15', effect: '0', products: '' })).toEqual({ result: 'invalid', why: 'needEvent' });
    await mgr.record({ storeId: 'S1', label: 'Pongal', kind: 'festival', from: '2030-01-14', to: '2030-01-15', effect: '1.5', products: 'p-tea, p-sugar' });
    await mgr.forecast('p-tea');
    expect(r.calls[0]!.body).toEqual({ storeId: 'S1', label: 'Pongal', kind: 'festival', from: '2030-01-14', to: '2030-01-15', multiplier: 1.5, productIds: ['p-tea', 'p-sugar'] });
    expect(r.calls[1]!.url).toBe('/v1/inventory/demand-forecast?productId=p-tea&horizonDays=7');
    expect(effectWords('en', { multiplier: 1.5, effect: { basis: 'manager_estimate', words: "manager's estimate" } })).toBe("×1.5 — manager's estimate");
  });
});

describe('the Morning brief session (EA-07)', () => {
  it('reads today\'s brief and nothing else', async () => {
    const r = recorder();
    expect(await createBriefSession({ viewer: viewer(), fetch: r.fetch }).today()).toEqual({ result: 'invalid', why: 'cannotRead' });
    await createBriefSession({ viewer: viewer('owner.kpi.read'), fetch: r.fetch }).today();
    expect(r.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/reporting/brief-today']);
  });
});

describe('every word has a Tamil twin', () => {
  it('the four word tables carry the same keys in both languages', () => {
    for (const copy of [CUSTOMERS_COPY, AFFINITY_COPY, EVENTS_COPY, BRIEF_COPY]) expect(Object.keys(copy.ta).sort()).toEqual(Object.keys(copy.en).sort());
  });
});
