import { describe, it, expect } from 'vitest';
import { createScrapSession, scrapOutcomeWords, gramsOf, kgWords, SCRAP_COPY } from '../../apps/web-erp/src/scrap-session';
import { createPackagingSession, packagingOutcomeWords, bpsOf, PACKAGING_COPY } from '../../apps/web-erp/src/packaging-session';
import { createCompareSession, compareOutcomeWords, rowTransactions, keyOf, COMPARE_COPY, type CompareView } from '../../apps/web-erp/src/branch-compare-session';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { HEAD_OFFICE_PAGE_SCREENS, HEAD_OFFICE_PAGE_GLOBALS } from '../../edge/store-edge/src/head-office-pages';
import { buildSurface } from '../../services/api/src/main';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

/**
 * **Three head-office pages (round 6): Scrap and recycling (M28-FR-02), Packaging and crates (M28-FR-03) and Compare side by
 * side (M29-FR-02 · §27 Owner "branch comparison").** Thin clients, proven against a stand-in for head office: each session
 * calls ONLY head office's own routes (every one is in the route table production serves), with the method and body the
 * handler reads; a person nobody named, or a role without the word, is refused before any call; a form that does not read
 * is refused by name before any call; head office's refusal is its own words, a lost line is "unreachable"; the compare
 * ranks only the GOVERNED rows head office returned and opens a row to exactly those; every page is on the menu and served
 * by the store computer; every word has a Tamil twin.
 */

interface Call { readonly url: string; readonly method: string; readonly body: unknown; readonly key: string | null }
function headOffice(answer: (url: string, method: string, body: unknown) => { status: number; body: unknown } | 'throw' = () => ({ status: 200, body: {} })): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ url, method, body, key: headers['idempotency-key'] ?? null });
    const a = answer(url, method, body);
    if (a === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const TAMIL = /[஀-௿]/;
const keys = (() => { let n = 0; return () => `k-${(n += 1)}`; })();
const served = buildSurface({ signingKey: 'k'.repeat(48), migrationTargetKind: 'rehearsal', store: new InMemoryEventStore() });
const isServed = (method: string, url: string): boolean => {
  const path = url.split('?')[0]!;
  return served.some((r) => r.method === method && new RegExp(`^${r.path.replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`).test(path));
};

describe('Scrap and recycling — the session (M28-FR-02)', () => {
  const OWNER = { userId: 'u-owner', permissions: ['scrap.review.read', 'scrap.sale.record'] };
  const MANAGER = { userId: 'u-mgr', permissions: ['scrap.review.read'] };

  it('reviews a branch over a window, records a disposal (kg → grams, ₹ → paise, evidence split) and marks it taken into the books', async () => {
    const ho = headOffice();
    const s = createScrapSession({ viewer: OWNER, fetch: ho.fetch, newKey: keys, newScrapId: () => 'scrap-1' });
    expect(s.may).toEqual({ named: true, review: true, record: true });
    await s.review({ branchId: ' store-1 ', from: '2026-10-01', to: '2026-10-27' });
    await s.record({ branchId: 'store-1', category: 'cardboard', disposal: 'sold', kg: '12.5', proceedsRupees: '₹250', buyerName: ' Murugan Scrap ', evidence: 'slip-7, photo-3 ,', recyclerRegistration: '', handledBy: ' u-owner ' });
    await s.markPosted('scrap-1');
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/scrap/review?branchId=store-1&from=2026-10-01&to=2026-10-27', 'POST /v1/scrap/sales', 'POST /v1/scrap/sales/scrap-1/posted',
    ]);
    expect(ho.calls[1]!.body).toEqual({ scrapId: 'scrap-1', branchId: 'store-1', category: 'cardboard', disposal: 'sold', grams: 12_500, proceedsMinor: 25_000, handledBy: 'u-owner', buyerName: 'Murugan Scrap', evidenceRefs: ['slip-7', 'photo-3'] });
    expect(ho.calls.filter((c) => c.method === 'POST').every((c) => c.key !== null), 'every write carries its own idempotency key').toBe(true);
    for (const c of ho.calls) expect(isServed(c.method, c.url), `${c.method} ${c.url} is a route head office serves`).toBe(true);
  });

  it('refuses before any call: nobody named, a role without the word, a form that does not read', async () => {
    const ho = headOffice();
    expect(await createScrapSession({ viewer: undefined, fetch: ho.fetch }).review({ branchId: 's', from: '2026-10-01', to: '2026-10-02' })).toEqual({ result: 'invalid', why: 'nobody' });
    const mgr = createScrapSession({ viewer: MANAGER, fetch: ho.fetch });
    expect(mgr.may).toEqual({ named: true, review: true, record: false });
    expect(await mgr.record({ branchId: 's', category: 'metal', disposal: 'sold', kg: '1', proceedsRupees: '1', buyerName: '', evidence: '', recyclerRegistration: '', handledBy: 'u' })).toEqual({ result: 'invalid', why: 'cannotRecord' });
    expect(await mgr.markPosted('x')).toEqual({ result: 'invalid', why: 'cannotRecord' });
    expect(await mgr.review({ branchId: 's', from: '2026-10-05', to: '2026-10-01' })).toEqual({ result: 'invalid', why: 'needReview' });
    const own = createScrapSession({ viewer: OWNER, fetch: ho.fetch });
    for (const bad of [{ kg: '1.2345' }, { kg: 'heavy' }, { category: 'gold' }, { disposal: 'lost' }, { proceedsRupees: '' }, { handledBy: ' ' }, { branchId: '' }]) {
      expect(await own.record({ branchId: 's', category: 'metal', disposal: 'sold', kg: '1', proceedsRupees: '0', buyerName: '', evidence: '', recyclerRegistration: '', handledBy: 'u', ...bad }), JSON.stringify(bad)).toEqual({ result: 'invalid', why: 'needRecord' });
    }
    expect(ho.calls).toEqual([]);
    expect(gramsOf('0.5 kg')).toBe(500); expect(kgWords(12_500)).toBe('12.5 kg');
  });

  it('says head office\'s refusal in its words (another branch), and a lost line as unreachable', async () => {
    const refusing = headOffice(() => ({ status: 403, body: { error: { code: 'branch_not_in_scope', whatHappened: 'Branch store-2 is outside your access.' } } }));
    const out = await createScrapSession({ viewer: MANAGER, fetch: refusing.fetch }).review({ branchId: 'store-2', from: '2026-10-01', to: '2026-10-01' });
    expect(scrapOutcomeWords('en', out)).toBe('Head office refused: Branch store-2 is outside your access.');
    const lost = await createScrapSession({ viewer: MANAGER, fetch: headOffice(() => 'throw').fetch }).review({ branchId: 's', from: '2026-10-01', to: '2026-10-01' });
    expect(scrapOutcomeWords('ta', lost)).toMatch(TAMIL);
    expect(scrapOutcomeWords('en', { result: 'ok', value: { postedToFinance: false } })).toMatch(/NOT in the books until finance takes it up/);
  });
});

describe('Packaging and crates — the session (M28-FR-03)', () => {
  const MANAGER = { userId: 'u-mgr', permissions: ['inventory.availability.read', 'inventory.movement.append'] };
  const READER = { userId: 'u-box', permissions: ['inventory.availability.read'] };

  it('reads a position, registers an item (₹ → paise, % → basis points) and records a movement stamped now', async () => {
    const ho = headOffice();
    const s = createPackagingSession({ viewer: MANAGER, fetch: ho.fetch, newKey: keys, newMovementId: () => 'pmv-1', now: () => '2026-10-27T05:00:00.000Z' });
    await s.position(' crate-blue ', 'store-1');
    await s.register({ packagingId: 'crate-blue', name: ' Blue crate ', kind: 'reusable_crate', returnable: true, chargeRupees: '', taxPercent: '', depositRupees: '50' });
    await s.register({ packagingId: 'bag-m', name: 'Carry bag M', kind: 'carry_bag', returnable: false, chargeRupees: '5', taxPercent: '18', depositRupees: '' });
    await s.move({ packagingId: 'crate-blue', branchId: ' store-1 ', kind: 'issued_to_delivery', qty: ' 12 ', reference: ' run-4 ' });
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/packaging/items/crate-blue/position?branchId=store-1', 'POST /v1/packaging/items/crate-blue', 'POST /v1/packaging/items/bag-m', 'POST /v1/packaging/items/crate-blue/movements/pmv-1',
    ]);
    expect(ho.calls[1]!.body).toEqual({ name: 'Blue crate', kind: 'reusable_crate', returnable: true, depositMinor: 5_000 });
    expect(ho.calls[2]!.body).toEqual({ name: 'Carry bag M', kind: 'carry_bag', returnable: false, chargeMinor: 500, taxRateBps: 1_800 });
    expect(ho.calls[3]!.body).toEqual({ branchId: 'store-1', kind: 'issued_to_delivery', qty: 12, at: '2026-10-27T05:00:00.000Z', reference: 'run-4' });
    for (const c of ho.calls) expect(isServed(c.method, c.url), `${c.method} ${c.url}`).toBe(true);
    expect(packagingOutcomeWords('en', { result: 'ok', value: { movementId: 'pmv-1' } })).toBe('Recorded at head office.');
  });

  it('refuses before any call: nobody, a reader asked to write, a bad form', async () => {
    const ho = headOffice();
    expect(await createPackagingSession({ viewer: undefined, fetch: ho.fetch }).position('a', 'b')).toEqual({ result: 'invalid', why: 'nobody' });
    const reader = createPackagingSession({ viewer: READER, fetch: ho.fetch });
    expect(reader.may).toEqual({ named: true, read: true, move: false });
    expect(await reader.move({ packagingId: 'a', branchId: 'b', kind: 'received', qty: '1', reference: '' })).toEqual({ result: 'invalid', why: 'cannotMove' });
    const mgr = createPackagingSession({ viewer: MANAGER, fetch: ho.fetch });
    expect(await mgr.position('', 'b')).toEqual({ result: 'invalid', why: 'needPosition' });
    for (const qty of ['0', '-2', '1.5', '']) expect(await mgr.move({ packagingId: 'a', branchId: 'b', kind: 'received', qty, reference: '' }), qty).toEqual({ result: 'invalid', why: 'needMove' });
    expect(await mgr.move({ packagingId: 'a', branchId: 'b', kind: 'stolen', qty: '1', reference: '' })).toEqual({ result: 'invalid', why: 'needMove' });
    expect(await mgr.register({ packagingId: 'a', name: 'A', kind: 'box', returnable: false, chargeRupees: '', taxPercent: '', depositRupees: '' })).toEqual({ result: 'invalid', why: 'needItem' });
    expect(await mgr.register({ packagingId: 'a', name: 'A', kind: 'carry_bag', returnable: false, chargeRupees: 'five', taxPercent: '', depositRupees: '' })).toEqual({ result: 'invalid', why: 'needItem' });
    expect(ho.calls).toEqual([]);
    expect(bpsOf('12.5%')).toBe(1_250); expect(bpsOf('')).toBeUndefined(); expect(bpsOf('x')).toBeNull();
  });
});

describe('Compare side by side — the session (M29-FR-02)', () => {
  const OWNER = { userId: 'u-owner', permissions: ['owner.kpi.read', 'reporting.report.read'] };
  const txns = [
    { transactionId: 'S-1', at: '2026-10-27T05:00:00.000Z', branchId: 'store-1', staffId: 'u-c1', amountMinor: 30_000, description: 'bill R-1' },
    { transactionId: 'S-2', at: '2026-10-27T06:00:00.000Z', branchId: 'store-2', staffId: 'u-c2', amountMinor: 50_000, description: 'bill R-2' },
    { transactionId: 'S-3', at: '2026-10-27T07:00:00.000Z', branchId: 'store-1', amountMinor: 10_000, description: 'bill R-3' },
  ];

  it('branches: one governed drill over the period, then head office\'s compare over EXACTLY those rows — the scope is the server\'s', async () => {
    const ho = headOffice((url) => (url === '/v1/reporting/drill/governed'
      ? { status: 200, body: { transactions: txns, reconciles: true, withheldCount: 0, withheldTotalMinor: 0, figure: 'Taken', filters: { branchScope: 'all' } } }
      : { status: 200, body: { dimension: 'branch', metric: 'm', rows: [{ key: 'store-2', label: 'store-2', valueMinor: 50_000, transactionCount: 1, shareBps: 5_555 }, { key: 'store-1', label: 'store-1', valueMinor: 40_000, transactionCount: 2, shareBps: 4_444 }], totalMinor: 90_000, reconciles: true, detail: '' } }));
    const s = createCompareSession({ viewer: OWNER, fetch: ho.fetch, newKey: keys });
    const out = await s.compare({ by: 'branch', from: '2026-10-21', to: '2026-10-27' });
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /v1/reporting/drill/governed', 'POST /v1/reporting/compare']);
    expect(ho.calls[0]!.body).toEqual({ reportId: 'sales_by_day', figure: 'Taken', period: { from: '2026-10-21', to: '2026-10-27' } });
    expect(ho.calls[1]!.body).toEqual({ dimension: 'branch', metric: 'sales_by_day:Taken', transactions: txns }); // no branchScope sent: the server derives it
    expect(JSON.stringify(ho.calls.map((c) => c.body))).not.toContain('branchScope');
    for (const c of ho.calls) expect(isServed(c.method, c.url), `${c.method} ${c.url}`).toBe(true);
    if (out.result !== 'ok') throw new Error(JSON.stringify(out));
    expect(out.value.branchScope).toBe('all');
    expect(rowTransactions(out.value, 'store-1').map((t) => t.transactionId)).toEqual(['S-3', 'S-1']); // newest first, exactly the governed rows
    const staff: CompareView = { ...out.value, by: 'staff' };
    expect(rowTransactions(staff, 'unattributed').map((t) => t.transactionId)).toEqual(['S-3']);
    expect(keyOf(txns[2]!, 'staff')).toBe('unattributed');
  });

  it('departments: reads each day\'s figures, drills every "— taken" figure by name, ranks by category; suppliers: company-wide or said not available', async () => {
    const ho = headOffice((url, _m, body) => {
      if (url.startsWith('/v1/reports/units_by_category')) return { status: 200, body: { figures: [{ name: 'dairy', valueMinor: 3 }, { name: 'dairy — taken', valueMinor: 100 }, ...(url.endsWith('2026-10-27') ? [{ name: 'grocery — taken', valueMinor: 50 }] : [])] } };
      if (url === '/v1/reporting/drill/governed') return { status: 200, body: { transactions: [{ transactionId: `${(body as { figure: string }).figure}#1`, at: 'a', branchId: 'store-1', categoryId: (body as { figure: string }).figure.replace(' — taken', ''), amountMinor: 1, description: 'x' }], reconciles: true, withheldCount: 0, withheldTotalMinor: 0, figure: 'f' } };
      return { status: 200, body: { dimension: 'category', metric: 'm', rows: [], totalMinor: 0, reconciles: true, detail: '' } };
    });
    const out = await createCompareSession({ viewer: OWNER, fetch: ho.fetch }).compare({ by: 'category', from: '2026-10-26', to: '2026-10-27' });
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/reports/units_by_category?day=2026-10-26', 'GET /v1/reports/units_by_category?day=2026-10-27',
      'POST /v1/reporting/drill/governed', 'POST /v1/reporting/drill/governed', 'POST /v1/reporting/compare',
    ]);
    expect(ho.calls.slice(2, 4).map((c) => (c.body as { figure: string }).figure)).toEqual(['dairy — taken', 'grocery — taken']);
    expect((ho.calls[4]!.body as { dimension: string; transactions: unknown[] })).toMatchObject({ dimension: 'category', transactions: [{ categoryId: 'dairy' }, { categoryId: 'grocery' }] });
    expect(out.result).toBe('ok');
    for (const c of ho.calls) expect(isServed(c.method, c.url), `${c.method} ${c.url}`).toBe(true);

    const branchLimited = headOffice((url) => (url.startsWith('/v1/reports/purchases_by_supplier')
      ? { status: 200, body: { figures: [{ name: 'Ordered', notAvailableBecause: 'purchase orders are company-wide records; this needs company-wide report access' }] } }
      : { status: 500, body: {} }));
    const v = await createCompareSession({ viewer: OWNER, fetch: branchLimited.fetch }).compare({ by: 'vendor', from: '2026-10-27', to: '2026-10-27' });
    expect(v).toMatchObject({ result: 'ok', value: { notAvailable: 'purchase orders are company-wide records; this needs company-wide report access', transactions: [] } });
    expect(branchLimited.calls).toHaveLength(1); // nothing drilled, nothing ranked
  });

  it('refuses before any call; a drill that does not reconcile is carried to the page; head office\'s refusal is its words', async () => {
    const ho = headOffice();
    expect(await createCompareSession({ viewer: undefined, fetch: ho.fetch }).compare({ by: 'branch', from: '2026-10-01', to: '2026-10-01' })).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createCompareSession({ viewer: { userId: 'u-c', permissions: ['pos.sale.read'] }, fetch: ho.fetch }).compare({ by: 'branch', from: '2026-10-01', to: '2026-10-01' })).toEqual({ result: 'invalid', why: 'cannotCompare' });
    const kpiOnly = createCompareSession({ viewer: { userId: 'u-m', permissions: ['owner.kpi.read'] }, fetch: ho.fetch });
    expect(await kpiOnly.compare({ by: 'category', from: '2026-10-01', to: '2026-10-01' })).toEqual({ result: 'invalid', why: 'cannotList' });
    expect(await kpiOnly.compare({ by: 'region', from: '2026-10-01', to: '2026-10-01' })).toEqual({ result: 'invalid', why: 'needBy' });
    expect(await kpiOnly.compare({ by: 'branch', from: '2026-10-01', to: '2026-11-05' })).toEqual({ result: 'invalid', why: 'needDays' }); // 36 days > 31
    expect(await kpiOnly.compare({ by: 'branch', from: '2026-10-05', to: '2026-10-01' })).toEqual({ result: 'invalid', why: 'needDays' });
    expect(ho.calls).toEqual([]);
    const wrong = headOffice((url) => (url === '/v1/reporting/drill/governed'
      ? { status: 200, body: { transactions: [], reconciles: false, discrepancy: 'THESE TRANSACTIONS DO NOT ADD UP', withheldCount: 0, withheldTotalMinor: 0, figure: 'Taken' } }
      : { status: 200, body: { dimension: 'branch', metric: 'm', rows: [], totalMinor: 0, reconciles: true, detail: '' } }));
    const w2 = await createCompareSession({ viewer: OWNER, fetch: wrong.fetch }).compare({ by: 'staff', from: '2026-10-01', to: '2026-10-01' });
    expect(w2).toMatchObject({ result: 'ok', value: { drills: [{ reconciles: false, discrepancy: 'THESE TRANSACTIONS DO NOT ADD UP' }] } });
    const refusing = headOffice(() => ({ status: 409, body: { error: { code: 'figure_not_available', whatHappened: 'Taken is not available: no till has ever sent a sale to head office.' } } }));
    const r = await createCompareSession({ viewer: OWNER, fetch: refusing.fetch }).compare({ by: 'branch', from: '2026-10-01', to: '2026-10-01' });
    expect(compareOutcomeWords('en', r)).toBe('Head office refused: Taken is not available: no till has ever sent a sale to head office.');
    expect(compareOutcomeWords('ta', await createCompareSession({ viewer: OWNER, fetch: headOffice(() => 'throw').fetch }).compare({ by: 'branch', from: '2026-10-01', to: '2026-10-01' }))).toMatch(TAMIL);
  });
});

describe('the three pages are on the menu, served by the store computer, and every word has a Tamil twin', () => {
  it('menu items gated on the words their routes check; served by the box (OB-380)', () => {
    const byId = new Map(ERP_NAVIGATION.map((i) => [i.id, i]));
    expect(byId.get('scrap')).toMatchObject({ path: '/scrap', requires: 'scrap.review.read', group: 'Inventory' });
    expect(byId.get('packaging')).toMatchObject({ path: '/packaging', requires: 'inventory.availability.read', group: 'Inventory' });
    expect(byId.get('branch-compare')).toMatchObject({ path: '/branch-compare', requires: 'owner.kpi.read', group: 'Reports' });
    for (const id of ['scrap', 'packaging', 'branch-compare'] as const) {
      expect(byId.get(id)?.served ?? 'box').toBe('box');
      expect(byId.get(id)?.labelTa).toMatch(TAMIL);
      expect(HEAD_OFFICE_PAGE_SCREENS).toContain(id);
    }
    expect(HEAD_OFFICE_PAGE_GLOBALS).toMatchObject({ scrap: 'scrapData', packaging: 'packagingData', 'branch-compare': 'branchCompareData' });
  });

  it('every English word has a Tamil one', () => {
    for (const copy of [SCRAP_COPY, PACKAGING_COPY, COMPARE_COPY]) {
      expect(Object.keys(copy.ta).sort()).toEqual(Object.keys(copy.en).sort());
      for (const [k, v] of Object.entries(copy.ta)) if (!['from', 'to'].includes(k)) expect(v, k).toMatch(TAMIL);
    }
  });
});
