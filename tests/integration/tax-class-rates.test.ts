import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M03-FR-03 (tax) / A6: the per-HSN, effective-dated GST rate a product is taxed at, on the live API. A tax
// class is not one rate but a SCHEDULE — the rate that applies is the one in force on the supply date. A
// change is a new period on a LATER date (append-only); two DIFFERENT rates on the SAME date are refused as
// ambiguous. Setting a rate is gated catalogue.pack.publish; resolving/reading is catalogue.pack.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const setRate = (h: ApiHarness, u: string, hsn: string, from: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/tax-classes/${hsn}/rates/${from}`, userId: u, tenantId: A, idempotencyKey: key, body });
const resolve = (h: ApiHarness, u: string, hsn: string, on: string) =>
  h.request({ method: 'GET', path: `/v1/catalogue/tax-classes/${hsn}/rate`, userId: u, tenantId: A, query: { on } });
const listRates = (h: ApiHarness, u: string, hsn: string) =>
  h.request({ method: 'GET', path: `/v1/catalogue/tax-classes/${hsn}/rates`, userId: u, tenantId: A });

describe('tax-class GST-rate schedule (M03-FR-03 / A6)', () => {
  it('resolves the rate in force on the supply date across a mid-period change', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setRate(h, 'u-owner', '1905', '2017-07-01', { rateBps: 1800 }, 'k1'); // 18% from 2017
    await setRate(h, 'u-owner', '1905', '2025-09-22', { rateBps: 500 }, 'k2'); // cut to 5% from GST 2.0
    // A supply the day BEFORE the change gets the old rate; on/after the change gets the new one.
    expect((await resolve(h, 'u-owner', '1905', '2025-09-21')).body as { rate: { rateBps: number } }).toMatchObject({ rate: { rateBps: 1800 } });
    expect((await resolve(h, 'u-owner', '1905', '2025-09-22')).body as { rate: { rateBps: number } }).toMatchObject({ rate: { rateBps: 500 } });
  });

  it('refuses a DIFFERENT rate on the same date, but an identical re-send is a no-op', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setRate(h, 'u-owner', '2501', '2017-07-01', { rateBps: 500 }, 'k1');
    // A second, different rate that same day would let a supply be taxed two ways — refused.
    const clash = await setRate(h, 'u-owner', '2501', '2017-07-01', { rateBps: 1200 }, 'k2');
    expect(clash.status).toBe(409);
    expect(codeOf(clash)).toBe('rate_already_set_on_that_date');
    // The identical rate re-sent is harmless (an import re-run).
    expect((await setRate(h, 'u-owner', '2501', '2017-07-01', { rateBps: 500 }, 'k3')).status).toBe(201);
    // Still exactly one period.
    expect((await listRates(h, 'u-owner', '2501')).body as { count: number }).toMatchObject({ count: 1 });
  });

  it('404 for an HSN with no schedule; 422 when the supply date is before the earliest rate', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await resolve(h, 'u-owner', '9999', '2026-01-01')).status).toBe(404); // never set
    await setRate(h, 'u-owner', '1905', '2017-07-01', { rateBps: 1800 }, 'k1');
    const early = await resolve(h, 'u-owner', '1905', '2016-01-01'); // before the schedule begins
    expect(early.status).toBe(422);
    expect(codeOf(early)).toBe('no_rate_in_force'); // answered by extending the schedule, never a guess
  });

  it('gates setting on catalogue.pack.publish; a manager may resolve/read but not set; malformed → 400', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // has catalogue.pack.read, NOT catalogue.pack.publish
    await setRate(h, 'u-owner', '1905', '2017-07-01', { rateBps: 1800 }, 'k-seed');
    expect((await setRate(h, 'u-mgr', '1905', '2025-09-22', { rateBps: 500 }, 'k-mgr')).status).toBe(403); // cannot set
    expect((await resolve(h, 'u-mgr', '1905', '2020-01-01')).status).toBe(200); // can resolve
    expect((await listRates(h, 'u-mgr', '1905')).status).toBe(200);
    // Malformed: a negative rate, or a bad date, or a missing ?on.
    expect((await setRate(h, 'u-owner', '1905', '2017-07-01', { rateBps: -5 }, 'k-bad1')).status).toBe(400);
    expect((await setRate(h, 'u-owner', '1905', 'not-a-date', { rateBps: 500 }, 'k-bad2')).status).toBe(400);
    const noOn = await h.request({ method: 'GET', path: '/v1/catalogue/tax-classes/1905/rate', userId: 'u-owner', tenantId: A });
    expect(noOn.status).toBe(400);
    expect(codeOf(noOn)).toBe('not_readable_as_a_tax_rate');
  });
});
