import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The GST government-portal switch route: the feature flag + kill switch decision for LIVE e-invoice /
// e-way-bill portal calls (off by default, killable). Sandbox routes are exempt.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const gate = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/finance/gst-portal/gate', userId: u, tenantId: A, idempotencyKey: key, body });

describe('POST /v1/finance/gst-portal/gate', () => {
  it('is not live by default, live when enabled, and killed overrides enabled', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect(((await gate(h, 'u-owner', {}, 'p1')).body as { canGoLive: boolean; reason: string })).toMatchObject({ canGoLive: false, reason: 'not_enabled' });
    expect(((await gate(h, 'u-owner', { enabled: true }, 'p2')).body as { canGoLive: boolean; reason: string })).toMatchObject({ canGoLive: true, reason: 'live' });
    expect(((await gate(h, 'u-owner', { enabled: true, killed: true }, 'p3')).body as { canGoLive: boolean; reason: string })).toMatchObject({ canGoLive: false, reason: 'killed' });
  });

  it('honours the channel and rejects bad input; gates on the GST-portal read permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no finance.einvoice.read
    expect(((await gate(h, 'u-owner', { channel: 'e_way_bill', enabled: true }, 'p4')).body as { channel: string }).channel).toBe('e_way_bill');
    expect((await gate(h, 'u-owner', { channel: 'nope' }, 'p5')).status).toBe(400);
    expect((await gate(h, 'u-owner', { enabled: 'yes' }, 'p6')).status).toBe(400);
    expect((await gate(h, 'u-cash', { enabled: true }, 'p7')).status).toBe(403);
  });
});
