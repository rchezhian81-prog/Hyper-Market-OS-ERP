import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Roadmap v2.1 B6 — the verified-scale gate on the live API. GET /v1/facilities/scale-verification says
// whether a scale's Legal Metrology verification is current, gated on the asset-register read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const scale = (h: ApiHarness, userId: string, q: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/facilities/scale-verification', userId, tenantId: A, query: q });

interface Status { verificationCurrent: boolean; tradingBlocked: boolean; level: string; daysRemaining: number }

describe('GET /v1/facilities/scale-verification — verified-scale gate (B6)', () => {
  it('reports current vs lapsed, and gates on the asset-register read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // has facilities.asset.read
    await h.provisionRole(A, 'u-cash', 'cashier');      // does not

    // Current well ahead of the due date.
    const current = (await scale(h, 'u-owner', { reverificationDueOn: '2027-01-01', asOf: '2026-08-10' })).body as Status;
    expect(current.verificationCurrent).toBe(true);
    expect(current.tradingBlocked).toBe(false);

    // Lapsed → trading blocked.
    const lapsed = (await scale(h, 'u-mgr', { reverificationDueOn: '2026-08-01', asOf: '2026-08-10' })).body as Status;
    expect(lapsed.tradingBlocked).toBe(true);
    expect(lapsed.level).toBe('expired');

    // Missing dates → 400; the cashier (no facilities.asset.read) is refused.
    expect((await scale(h, 'u-owner', { reverificationDueOn: '2026-08-01' })).status).toBe(400);
    expect((await scale(h, 'u-cash', { reverificationDueOn: '2026-08-01', asOf: '2026-08-10' })).status).toBe(403);
  });
});
