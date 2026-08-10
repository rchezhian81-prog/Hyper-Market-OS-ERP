import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Roadmap v2.1 A28 — statutory retention on the live API. GET /v1/finance/retention returns the
// governing (longest) retention period and whether a legal hold blocks deletion, gated on the finance read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const retention = (h: ApiHarness, userId: string, q: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/finance/retention', userId, tenantId: A, query: q });

interface Decision { retainUntil: string; mayDelete: boolean; blockedBy?: string; effective: { governingStatute: string } }

describe('GET /v1/finance/retention — statutory retention + legal hold (A28)', () => {
  it('applies the longest statute, honours a legal hold, and gates on the finance read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no finance.period.read
    const bound = { recordDate: '2026-08-10', statutes: 'gst,income_tax,companies_act' };

    // Longest statute (Companies Act, 8yr) governs → retain until 2034-08-10.
    const within = (await retention(h, 'u-owner', { ...bound, asOf: '2030-01-01' })).body as Decision;
    expect(within.retainUntil).toBe('2034-08-10');
    expect(within.effective.governingStatute).toBe('companies_act');
    expect(within.mayDelete).toBe(false);
    expect(within.blockedBy).toBe('retention_period');

    // Past the period, no hold → reviewable.
    expect(((await retention(h, 'u-owner', { ...bound, asOf: '2034-08-10' })).body as Decision).mayDelete).toBe(true);

    // A legal hold blocks deletion even long after expiry.
    const held = (await retention(h, 'u-owner', { ...bound, asOf: '2099-01-01', onLegalHold: 'true' })).body as Decision;
    expect(held.mayDelete).toBe(false);
    expect(held.blockedBy).toBe('legal_hold');

    // Bad statute → 400; the cashier (no finance.period.read) is refused.
    expect((await retention(h, 'u-owner', { recordDate: '2026-08-10', statutes: 'vat', asOf: '2030-01-01' })).status).toBe(400);
    expect((await retention(h, 'u-cash', { ...bound, asOf: '2030-01-01' })).status).toBe(403);
  });
});
