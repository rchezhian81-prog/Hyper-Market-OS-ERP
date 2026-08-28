import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs operator script, imported for its pure token builder.
import { buildStoreToken } from '../../scripts/issue-store-token.mjs';
import { verifyToken } from '../../services/identity/src/token';
import { apiHarness, TEST_IDP } from '../support/api-harness';

/**
 * The store-edge token the pilot issues so the till's edge can sync its sales to the cloud. The
 * proof that matters is not "it produces a string" — it is that the string is one the REAL API
 * accepts and can bank a sale with, and that a wrong or stale one is refused by the same code.
 */

const NOW = Date.parse('2026-08-28T10:00:00Z');
const POLICY = TEST_IDP.policy();

describe('the store-edge token is one the real API accepts', () => {
  it('verifies through the REAL authenticator, carrying the tenant and user from the signed payload', () => {
    const token = buildStoreToken({ sub: 'store-edge', tenantId: 't-sre', ttlSeconds: 3600 }, POLICY, NOW);
    const v = verifyToken(token, POLICY, NOW);
    expect(v.ok).toBe(true);
    expect(v.principal!.tenantId).toBe('t-sre');
    expect(v.principal!.userId).toBe('store-edge');
  });

  it('is refused when signed with the wrong key — real crypto, not a rubber stamp', () => {
    const wrongKey = { ...POLICY, secret: ['a', 'different', 'signing', 'key'].join('-').padEnd(40, 'x') };
    const token = buildStoreToken({ sub: 'store-edge', tenantId: 't-sre', ttlSeconds: 3600 }, wrongKey, NOW);
    const v = verifyToken(token, POLICY, NOW);
    expect(v.ok).toBe(false);
    expect(v.refusedBecause).toBe('signature_does_not_verify');
  });

  it('is refused once it has expired (past the clock-skew leeway)', () => {
    const token = buildStoreToken({ sub: 'store-edge', tenantId: 't-sre', ttlSeconds: -3600 }, POLICY, NOW);
    const v = verifyToken(token, POLICY, NOW);
    expect(v.ok).toBe(false);
    expect(v.refusedBecause).toBe('expired');
  });
});

describe('a sale synced with the issued token reaches the books', () => {
  it('the edge, holding the token and the sync permission, banks a sale through the real pipeline', async () => {
    const h = apiHarness();
    // The store-edge service account, provisioned with a sync-capable role (owner carries
    // pos.sale.sync). In production this is a named store-edge login granted the sync permission.
    await h.seedOwner('t-sre', 'store-edge');

    const token = buildStoreToken({ sub: 'store-edge', tenantId: 't-sre', ttlSeconds: 3600 }, POLICY, Date.now());
    const res = await h.raw({
      method: 'POST', path: '/v1/sales', token, idempotencyKey: 'edge-t-sre-S-1',
      body: {
        saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-meena',
        tradingDay: '2026-08-01', committedAt: '2026-08-01T10:00:00Z',
        totalMinor: 100, currency: 'INR', packVersion: 0,
        lines: [], tenders: [{ kind: 'cash', amountMinor: 100 }],
      },
    });
    // The sale is banked (202 — the server never refuses a sale that happened).
    expect(res.status).toBe(202);
    expect((res.body as { banked: boolean }).banked).toBe(true);
  });

  it('an unauthenticated attempt at the same route is refused — the token is what let it in', async () => {
    const h = apiHarness();
    await h.seedOwner('t-sre', 'store-edge');
    const res = await h.raw({ method: 'POST', path: '/v1/sales', idempotencyKey: 'no-token', body: { saleId: 'S-2', totalMinor: 100, committedAt: '2026-08-01T10:00:00Z', lines: [], tenders: [], packVersion: 0 } });
    expect(res.status).toBe(401);
  });
});
