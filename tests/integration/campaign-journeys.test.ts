import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Journeys and honest attribution, end to end (M21-FR-02 · PRV · P-08, API-06). Two disciplines the
// roadmap insists on: a journey has a QUIET PERIOD, because a message fired minutes after someone put
// their phone down is surveillance, not a nudge — and attribution reports the CONTROL GROUP beside the
// result, because "recovered" customers who were coming back anyway are a cost dressed as a win (with no
// control it is activity, not uplift). Nothing is sent here — this decides eligibility and measures.
// Gated customer.campaign.send (who to reach) / .read (measurement).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const minsAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

const journeys = (h: ApiHarness, u: string, kind: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/service/campaigns/journeys/${kind}/candidates`, userId: u, tenantId: A, idempotencyKey: key, body });
const attribution = (h: ApiHarness, u: string, campaignId: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/service/campaigns/${campaignId}/attribution`, userId: u, tenantId: A, idempotencyKey: key, body });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const trig = (customerRef: string, kind: string, agoMin: number, valueMinor: number) =>
  ({ customerRef, kind, triggeredAt: minsAgo(agoMin), valueMinor, ref: `${customerRef}-r` });

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // campaign.send + .read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('campaign journeys + honest attribution (M21-FR-02)', () => {
  it('holds back a too-soon nudge, a stale trigger and a completed customer; reaches the rest', async () => {
    const h = await seeded();
    const res = await journeys(h, 'u-mgr', 'abandoned_cart', {
      triggers: [
        trig('c-soon', 'abandoned_cart', 5, 5000),      // 5 min ago — quiet period, surveillance
        trig('c-ripe', 'abandoned_cart', 120, 8000),    // 2 h ago — a reminder, eligible
        trig('c-stale', 'abandoned_cart', 4320, 9000),  // 3 days ago — too late to be relevant
        trig('c-done', 'abandoned_cart', 120, 7000),     // ripe, but already completed
      ],
      completedRefs: ['c-done'],
    }, 'j1');
    expect(res.status).toBe(200);
    const body = res.body as { eligibleCount: number; count: number; candidates: { customerRef: string; eligible: boolean }[] };
    expect(body.count).toBe(4);
    expect(body.eligibleCount).toBe(1);
    expect(body.candidates.filter((c) => c.eligible).map((c) => c.customerRef)).toEqual(['c-ripe']);
  });

  it('applies a minimum-value threshold and only weighs triggers of the path kind', async () => {
    const h = await seeded();
    const res = await journeys(h, 'u-mgr', 'abandoned_cart', {
      minimumValueMinor: 6000,
      triggers: [
        trig('c-big', 'abandoned_cart', 120, 8000),   // eligible
        trig('c-small', 'abandoned_cart', 120, 3000),  // below threshold
        trig('c-other', 'win_back', 120, 9000),        // a DIFFERENT journey — not weighed here
      ],
    }, 'j2');
    const body = res.body as { count: number; eligibleCount: number; candidates: { customerRef: string; eligible: boolean }[] };
    // The win_back trigger is filtered out entirely; only the two abandoned_cart triggers are weighed.
    expect(body.count).toBe(2);
    expect(body.candidates.map((c) => c.customerRef).sort()).toEqual(['c-big', 'c-small']);
    expect(body.eligibleCount).toBe(1);
    expect(body.candidates.find((c) => c.customerRef === 'c-big')?.eligible).toBe(true);
  });

  it('attributes only post-send in-window orders by recipients, and reports the control beside it', async () => {
    const h = await seeded();
    const sentAt = '2026-08-20T10:00:00.000Z';
    const orders = [
      { customerRef: 'c1', at: '2026-08-20T11:00:00.000Z', netMinor: 50000, marginMinor: 10000 }, // in window, recipient
      { customerRef: 'c2', at: '2026-08-20T09:00:00.000Z', netMinor: 30000, marginMinor: 6000 },   // BEFORE the send
      { customerRef: 'x1', at: '2026-08-20T12:00:00.000Z', netMinor: 20000, marginMinor: 4000 },   // a control member converts
    ];
    // No control group → activity, not uplift.
    const noCtrl = await attribution(h, 'u-mgr', 'camp-a', { sentTo: ['c1', 'c2', 'c3'], sentAt, attributionWindowHours: 24, orders }, 'a1');
    expect(noCtrl.status).toBe(200);
    expect(noCtrl.body).toMatchObject({
      sent: 3, converted: 1, conversionBps: 3333, attributedRevenueMinor: 50000, attributedMarginMinor: 10000,
      controlConversionBps: 'no_control_group', upliftBps: 'not_meaningful',
    });
    expect((noCtrl.body as { detail: string }).detail).toContain('activity');

    // With a control group, uplift is measured against it.
    const withCtrl = await attribution(h, 'u-mgr', 'camp-a', { sentTo: ['c1', 'c2'], sentAt, attributionWindowHours: 24, orders, controlGroup: ['x1', 'x2'] }, 'a2');
    const w = withCtrl.body as { conversionBps: number; controlConversionBps: number; upliftBps: number };
    expect(w.conversionBps).toBe(5000);      // c1 of {c1,c2}
    expect(w.controlConversionBps).toBe(5000); // x1 of {x1,x2}
    expect(w.upliftBps).toBe(0);              // did not beat doing nothing
  });

  it('is gated to campaign staff and rejects an unreadable request', async () => {
    const h = await seeded();
    expect((await journeys(h, 'u-cash', 'abandoned_cart', { triggers: [] }, 'jx')).status).toBe(403);
    expect((await attribution(h, 'u-cash', 'camp-x', { sentTo: ['c1'], sentAt: '2026-08-20T10:00:00.000Z', attributionWindowHours: 24, orders: [] }, 'ax')).status).toBe(403);
    expect(codeOf(await journeys(h, 'u-mgr', 'not_a_kind', { triggers: [] }, 'jbad'))).toBe('not_readable_as_a_journey');
    expect(codeOf(await attribution(h, 'u-mgr', 'camp-y', { sentTo: ['c1'], sentAt: '2026-08-20T10:00:00.000Z', attributionWindowHours: 0, orders: [] }, 'abad'))).toBe('not_readable_as_an_attribution');
  });
});
