import { describe, it, expect } from 'vitest';
import { createCampaignsSession } from '../../apps/web-erp/src/campaigns-session';
import { workedOutAttribution } from '../../services/customer/src/campaign-send';

/** Round 4d (M21-FR-02): attribution is worked out from each customer's own send time, and the page asks only the window. */

describe('worked-out attribution', () => {
  const T0 = '2026-11-01T10:00:00.000Z';
  const at = (h: number) => new Date(Date.parse(T0) + h * 3_600_000).toISOString();
  it('a bill counts only after THAT customer\'s message and inside the window; the control is read from the first send', () => {
    const r = workedOutAttribution({
      campaignId: 'c', attributionWindowHours: 24, controlGroup: ['x'],
      sentTo: [{ customerRef: 'a', handedAt: T0 }, { customerRef: 'b', handedAt: at(5) }],
      orders: [
        { orderId: 'o1', customerRef: 'a', at: at(1), netMinor: 100, marginMinor: 20, channel: 'store', marginComplete: true },
        { orderId: 'o2', customerRef: 'b', at: at(2), netMinor: 300, marginMinor: 60, channel: 'store', marginComplete: true }, // before b's own message
        { orderId: 'o3', customerRef: 'a', at: at(30), netMinor: 500, marginMinor: 90, channel: 'app', marginComplete: true }, // after the window
        { orderId: 'o4', customerRef: 'x', at: at(3), netMinor: 50, marginMinor: 10, channel: 'store', marginComplete: true },
      ],
    });
    expect(r).toMatchObject({ sent: 2, converted: 1, attributedRevenueMinor: 100, attributedMarginMinor: 20, controlConversionBps: 10_000, marginNotKnownOrders: 0, firstSentAt: T0 });
    expect(r.attributedOrders.map((o) => o.orderId)).toEqual(['o1']);
  });
  it('the margin is not known when any attributed bill\'s cost is not known', () => {
    const r = workedOutAttribution({ campaignId: 'c', attributionWindowHours: 24, controlGroup: [], sentTo: [{ customerRef: 'a', handedAt: T0 }], orders: [{ orderId: 'o1', customerRef: 'a', at: at(1), netMinor: 100, marginMinor: 0, channel: 'store', marginComplete: false }] });
    expect(r.attributedMarginMinor).toBeNull();
    expect(r.marginNotKnownOrders).toBe(1);
  });
});

describe('the Campaigns page asks only for the window and the comparison customers', () => {
  it('sends { attributionWindowHours, controlGroup } and refuses a window that is not a whole number', async () => {
    const sent: { path: string; body: unknown }[] = [];
    const fetch = (async (path: string, init: { body?: string }) => { sent.push({ path, body: init.body === undefined ? undefined : JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({}) } as unknown as Response; }) as unknown as typeof globalThis.fetch;
    const s = createCampaignsSession({ viewer: { userId: 'u-o', permissions: ['customer.campaign.read'] }, fetch });
    expect(await s.attribution('diwali', 'two days', '')).toEqual({ result: 'invalid', why: 'needWindow' });
    await s.attribution(' diwali ', '48', 'C7, C8 C7');
    expect(sent).toEqual([{ path: '/v1/service/campaigns/diwali/attribution', body: { attributionWindowHours: 48, controlGroup: ['C7', 'C8'] } }]);
  });
});
