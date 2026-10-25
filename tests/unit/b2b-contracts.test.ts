import { describe, it, expect } from 'vitest';
import {
  readContractTerms, sameTerms, standingOf, contractPosition, contractsEndingWithin, priceFromRecord,
  type StoredB2BContract,
} from '../../packages/b2b/src/index';
import { b2bContractRoutes, type B2BContractsDeps } from '../../services/finance/src/b2b-contracts';
import type { RequestContext } from '../../services/kernel/src/index';

// OB-288 commercial desks — M22-FR-01: the B2B contract register's pure rules, and the route's MRP ceiling.

const approved = (over: Partial<StoredB2BContract> = {}): StoredB2BContract => ({
  contractId: 'K-1', customerId: 'SCHOOL', validFrom: '2026-10-01', validTo: '2026-12-31', onExpiry: 'block',
  prices: [{ productId: 'rice', priceMinor: 120_000 }], state: 'approved', proposedBy: 'u-acct', proposedAt: '2026-09-30T10:00:00Z',
  approvedBy: 'u-owner', approvedAt: '2026-09-30T11:00:00Z', ...over,
});

describe('reading a contract', () => {
  const ids = { customerId: 'SCHOOL', contractId: 'K-1' };
  const body = { validFrom: '2026-10-01', validTo: '2026-12-31', onExpiry: 'fallback', prices: [{ productId: 'rice', priceMinor: 1 }] };
  it('reads well-formed terms and sorts the price list', () => {
    const r = readContractTerms({ ...body, prices: [{ productId: 'z', priceMinor: 2 }, { productId: 'a', priceMinor: 1 }] }, ids);
    expect(r.ok && r.value.prices.map((p) => p.productId)).toEqual(['a', 'z']);
  });
  it.each([
    ['dates the wrong way round', { ...body, validTo: '2026-09-30' }],
    ['no price list', { ...body, prices: [] }],
    ['a product twice', { ...body, prices: [{ productId: 'a', priceMinor: 1 }, { productId: 'a', priceMinor: 2 }] }],
    ['a fractional price', { ...body, prices: [{ productId: 'a', priceMinor: 1.5 }] }],
    ['an unknown expiry policy', { ...body, onExpiry: 'ignore' }],
    ['terms beyond a year', { ...body, paymentTermsDays: 400 }],
    ['a negative limit', { ...body, creditLimitMinor: -1 }],
  ])('refuses %s', (_why, b) => {
    expect(readContractTerms(b, ids).ok).toBe(false);
  });
  it('compares terms exactly', () => {
    const a = readContractTerms(body, ids); const b = readContractTerms({ ...body, prices: [{ productId: 'rice', priceMinor: 2 }] }, ids);
    expect(a.ok && b.ok && sameTerms(a.value, a.value)).toBe(true);
    expect(a.ok && b.ok && sameTerms(a.value, b.value)).toBe(false);
  });
});

describe('where a contract stands — worked out from its dates, never a flag', () => {
  it('proposed → awaiting approval; then not started / in force / expired by the day', () => {
    expect(standingOf(approved({ state: 'proposed' }), '2026-10-15')).toBe('awaiting_approval');
    expect(standingOf(approved(), '2026-09-30')).toBe('not_started');
    expect(standingOf(approved(), '2026-12-31')).toBe('in_force'); // the last day is inclusive
    expect(standingOf(approved(), '2027-01-01')).toBe('expired');
  });
  it('the position: in force with days left; else the latest lapsed, blocking only when it says block', () => {
    const p = contractPosition([approved()], 'SCHOOL', '2026-12-25');
    expect([p.inForce?.contractId, p.daysToExpiry, p.blocked]).toEqual(['K-1', 6, false]);
    expect(contractPosition([approved()], 'SCHOOL', '2027-01-02')).toMatchObject({ blocked: true });
    expect(contractPosition([approved({ onExpiry: 'fallback' })], 'SCHOOL', '2027-01-02')).toMatchObject({ blocked: false });
    // A renewal that starts the day after takes over; another customer's contract is never this one's.
    const renewal = approved({ contractId: 'K-2', validFrom: '2027-01-01', validTo: '2027-12-31' });
    expect(contractPosition([approved(), renewal], 'SCHOOL', '2027-01-02').inForce?.contractId).toBe('K-2');
    expect(contractPosition([approved()], 'HOSTEL', '2026-12-25').inForce).toBeUndefined();
  });
  it('warns 30 days ahead — unless an approved renewal already covers it', () => {
    expect(contractsEndingWithin([approved()], '2026-12-05', 30).map((x) => x.daysLeft)).toEqual([26]);
    expect(contractsEndingWithin([approved()], '2026-11-25', 30)).toEqual([]);
    expect(contractsEndingWithin([approved(), approved({ contractId: 'K-2', validFrom: '2027-01-01', validTo: '2027-12-31' })], '2026-12-05', 30)).toEqual([]);
    expect(contractsEndingWithin([approved(), approved({ contractId: 'K-2', state: 'proposed', validFrom: '2027-01-01', validTo: '2027-12-31' })], '2026-12-05', 30)).toHaveLength(1);
  });
});

describe('pricing a quotation from the record', () => {
  const list = (p: string): number | undefined => (p === 'dal' ? 9_000 : undefined);
  const inForce = contractPosition([approved()], 'SCHOOL', '2026-10-15');
  it('contract price first, then the price list — and a product with neither is refused, typed price or not (OB-361)', () => {
    const r = priceFromRecord({ position: inForce, listPriceOf: list, lines: [{ lineId: 'a', productId: 'rice' }, { lineId: 'b', productId: 'dal' }] });
    expect(r).toEqual({ ok: true, lines: [
      { lineId: 'a', productId: 'rice', unitPriceMinor: 120_000, priceSource: 'contract', contractId: 'K-1' },
      { lineId: 'b', productId: 'dal', unitPriceMinor: 9_000, priceSource: 'price_list' },
    ] });
    expect(priceFromRecord({ position: inForce, listPriceOf: list, lines: [{ lineId: 'c', productId: 'salt' }] })).toMatchObject({ ok: false, code: 'no_price_on_record', lineId: 'c' });
    // OB-361: before, a product with no price on record kept the typed price ("typed (no price on record)"). Now refused.
    expect(priceFromRecord({ position: inForce, listPriceOf: list, lines: [{ lineId: 'c', productId: 'salt', typedPriceMinor: 2_000 }] })).toMatchObject({ ok: false, lineId: 'c' });
    expect(priceFromRecord({ position: contractPosition([], 'SCHOOL', '2026-10-15'), listPriceOf: () => undefined, lines: [{ lineId: 'c', productId: 'salt' }] })).toMatchObject({ ok: false, code: 'no_price_on_record' });
  });
  it('OB-361: no typed price on a business quotation at all — differing, matching, or on an item with no price', () => {
    for (const line of [
      { lineId: 'a', productId: 'rice', typedPriceMinor: 1 }, // differs from the contract
      { lineId: 'a', productId: 'rice', typedPriceMinor: 120_000 }, // the contract's own price, typed
      { lineId: 'b', productId: 'dal', typedPriceMinor: 9_000 }, // the price list's own price, typed
      { lineId: 'c', productId: 'salt', typedPriceMinor: 2_000 }, // no price on record
    ]) {
      const r = priceFromRecord({ position: inForce, listPriceOf: list, lines: [{ lineId: 'z', productId: 'dal' }, line] });
      expect(r, JSON.stringify(line)).toMatchObject({ ok: false, code: 'typed_price_refused', lineId: line.lineId });
    }
  });
  it('a lapsed "block" contract refuses; a lapsed "fallback" one prices from the list', () => {
    expect(priceFromRecord({ position: contractPosition([approved()], 'SCHOOL', '2027-02-01'), listPriceOf: list, lines: [{ lineId: 'b', productId: 'dal' }] })).toMatchObject({ ok: false, code: 'contract_expired' });
    const fb = priceFromRecord({ position: contractPosition([approved({ onExpiry: 'fallback' })], 'SCHOOL', '2027-02-01'), listPriceOf: list, lines: [{ lineId: 'b', productId: 'dal' }] });
    expect(fb).toMatchObject({ ok: true, lines: [{ priceSource: 'price_list', unitPriceMinor: 9_000 }] });
    // …and a product on the lapsed contract is NOT given the old contract price.
    expect(priceFromRecord({ position: contractPosition([approved({ onExpiry: 'fallback' })], 'SCHOOL', '2027-02-01'), listPriceOf: list, lines: [{ lineId: 'a', productId: 'rice' }] })).toMatchObject({ ok: false, code: 'no_price_on_record' });
  });
});

describe('the contract route refuses a price above the printed MRP (a legal ceiling)', () => {
  const recorded: StoredB2BContract[] = [];
  const deps: B2BContractsDeps = {
    contracts: async () => recorded, recordContract: async (_t, c) => { recorded.push(c); },
    mrpOf: async (_t, p) => (p === 'rice' ? 110_000 : undefined), now: () => '2026-10-15T10:00:00.000Z',
  };
  const route = b2bContractRoutes(deps).find((r) => r.method === 'POST')!;
  const ctx = (body: unknown): RequestContext => ({ tenantId: 't', userId: 'u-acct', branchId: null, scope: 'all', params: { customerId: 'SCHOOL', contractId: 'K-1' }, query: {}, body, traceId: 'x' }) as RequestContext;
  it('above MRP → 422 and nothing recorded; at or below → recorded as proposed', async () => {
    await expect(route.handler(ctx({ validFrom: '2026-10-15', validTo: '2026-12-31', onExpiry: 'block', prices: [{ productId: 'rice', priceMinor: 120_000 }] }))).rejects.toMatchObject({ status: 422 });
    expect(recorded).toEqual([]);
    const r = await route.handler(ctx({ validFrom: '2026-10-15', validTo: '2026-12-31', onExpiry: 'block', prices: [{ productId: 'rice', priceMinor: 110_000 }] }));
    expect(r.status).toBe(201);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ state: 'proposed', proposedBy: 'u-acct' });
  });
});
