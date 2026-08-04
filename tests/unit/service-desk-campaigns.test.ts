import { describe, it, expect } from 'vitest';
import {
  planCampaign,
  findJourneyCandidates,
  measureCampaign,
  type Campaign,
  type RecipientConsent,
  type JourneyTrigger,
} from '../../packages/service-desk/src/campaigns';

// M21-FR-01: "send across WhatsApp/SMS/email/push ONLY WITHIN CONSENT"; module acceptance:
// "consent-safe send (no non-consented / over-frequency)". M21-FR-02: attribution.

const CAMPAIGN: Campaign = {
  campaignId: 'CMP-1',
  purpose: 'marketing',
  channel: 'whatsapp',
  templateId: 'tpl-diwali',
  templateApproved: true,
  containsPromotion: true,
  frequencyCapInWindow: 2,
};

const consent = (over: Partial<RecipientConsent>): RecipientConsent => ({
  customerRef: 'c-1',
  granted: [{ purpose: 'marketing', channel: 'whatsapp' }],
  ...over,
});

describe('consent is checked per recipient, at the send (M21-FR-01)', () => {
  it('sends only to those who consented on THAT channel for THAT purpose', () => {
    const plan = planCampaign({
      campaign: CAMPAIGN,
      audience: ['c-1', 'c-2', 'c-3', 'c-4'],
      consents: [
        consent({ customerRef: 'c-1' }),
        consent({ customerRef: 'c-2', granted: [{ purpose: 'marketing', channel: 'email' }] }),
        consent({ customerRef: 'c-3', granted: [{ purpose: 'service', channel: 'whatsapp' }] }),
        // c-4 has no consent record at all.
      ],
    });

    expect(plan.sendTo).toEqual(['c-1']);
    expect(plan.excludedCount).toBe(3);
    expect(plan.excluded.find((e) => e.customerRef === 'c-2')?.detail).toContain(
      'consent to one channel is not consent to another',
    );
  });

  it('ALWAYS REPORTS THE EXCLUDED COUNT so the check stays defensible', () => {
    const plan = planCampaign({
      campaign: CAMPAIGN,
      audience: ['c-1', 'c-2'],
      consents: [consent({ customerRef: 'c-1' })],
    });
    expect(plan.detail).toContain('1 excluded');
    expect(plan.detail).toContain('the number is stated so the check stays defensible');
    expect(plan.excludedByReason).toEqual({ no_consent: 1 });
  });

  it('honours a withdrawal and a do-not-contact flag', () => {
    const plan = planCampaign({
      campaign: CAMPAIGN,
      audience: ['c-withdrawn', 'c-dnc'],
      consents: [
        consent({ customerRef: 'c-withdrawn', withdrawnAt: '2026-08-01T00:00:00Z' }),
        consent({ customerRef: 'c-dnc', doNotContact: true }),
      ],
    });
    expect(plan.sendTo).toEqual([]);
    expect(plan.excludedByReason).toEqual({ withdrawn: 1, do_not_contact: 1 });
  });

  it('enforces the frequency cap', () => {
    const plan = planCampaign({
      campaign: CAMPAIGN,
      audience: ['c-fresh', 'c-tired'],
      consents: [
        consent({ customerRef: 'c-fresh', sentInWindow: 1 }),
        consent({ customerRef: 'c-tired', sentInWindow: 2 }),
      ],
    });
    expect(plan.sendTo).toEqual(['c-fresh']);
    expect(plan.excluded[0]?.reason).toBe('frequency_cap');
  });

  it('BLOCKS THE WHOLE CAMPAIGN on an unapproved template', () => {
    const plan = planCampaign({
      campaign: { ...CAMPAIGN, templateApproved: false },
      audience: ['c-1'],
      consents: [consent({})],
    });
    expect(plan.blocked).toBe(true);
    expect(plan.sendTo).toEqual([]);
    expect(plan.detail).toContain('not approved — nothing is sent');
  });

  it('CLOSES THE LOOPHOLE: a promotion cannot ride inside a transactional message', () => {
    const plan = planCampaign({
      campaign: { ...CAMPAIGN, purpose: 'transactional', containsPromotion: true },
      audience: ['c-nope'],
      consents: [consent({ customerRef: 'c-nope', granted: [] })],
    });
    expect(plan.blocked).toBe(true);
    expect(plan.detail).toContain('route around marketing consent');
  });

  it('lets a genuine transactional message through without marketing consent', () => {
    const plan = planCampaign({
      campaign: { ...CAMPAIGN, purpose: 'transactional', containsPromotion: false, frequencyCapInWindow: undefined },
      audience: ['c-1'],
      consents: [consent({ customerRef: 'c-1', granted: [] })],
    });
    expect(plan.blocked).toBe(false);
    expect(plan.sendTo).toEqual(['c-1']);
  });

  it('still refuses a transactional message to a do-not-contact customer', () => {
    const plan = planCampaign({
      campaign: { ...CAMPAIGN, purpose: 'transactional', containsPromotion: false },
      audience: ['c-dnc'],
      consents: [consent({ customerRef: 'c-dnc', doNotContact: true, granted: [] })],
    });
    expect(plan.sendTo).toEqual([]);
  });
});

describe('a journey waits before it speaks (M21-FR-02)', () => {
  const triggers: JourneyTrigger[] = [
    { customerRef: 'c-just-now', kind: 'abandoned_cart', triggeredAt: '2026-08-05T09:55:00Z', valueMinor: 120_000, ref: 'cart-1' },
    { customerRef: 'c-ready', kind: 'abandoned_cart', triggeredAt: '2026-08-05T07:00:00Z', valueMinor: 250_000, ref: 'cart-2' },
    { customerRef: 'c-stale', kind: 'abandoned_cart', triggeredAt: '2026-08-01T07:00:00Z', valueMinor: 400_000, ref: 'cart-3' },
    { customerRef: 'c-bought', kind: 'abandoned_cart', triggeredAt: '2026-08-05T07:00:00Z', valueMinor: 90_000, ref: 'cart-4' },
    { customerRef: 'c-small', kind: 'abandoned_cart', triggeredAt: '2026-08-05T07:00:00Z', valueMinor: 500, ref: 'cart-5' },
  ];
  const now = '2026-08-05T10:00:00Z';

  it('REFUSES TO MESSAGE SOMEONE FIVE MINUTES AFTER THEY PUT THEIR PHONE DOWN', () => {
    const candidates = findJourneyCandidates({ kind: 'abandoned_cart', triggers, now, quietMinutes: 60 });
    const tooSoon = candidates.find((c) => c.customerRef === 'c-just-now');
    expect(tooSoon?.eligible).toBe(false);
    expect(tooSoon?.detail).toContain('reads as surveillance, not a reminder');
  });

  it('skips a trigger too old to be relevant, and one already completed', () => {
    const candidates = findJourneyCandidates({
      kind: 'abandoned_cart', triggers, now,
      quietMinutes: 60, staleAfterMinutes: 2_880, completedRefs: ['c-bought'], minimumValueMinor: 10_000,
    });
    const byRef = new Map(candidates.map((c) => [c.customerRef, c]));
    expect(byRef.get('c-stale')?.eligible).toBe(false);
    expect(byRef.get('c-bought')?.detail).toContain('an apology waiting to happen');
    expect(byRef.get('c-small')?.eligible).toBe(false);
    expect(byRef.get('c-ready')?.eligible).toBe(true);
  });

  it('orders by value, biggest cart first', () => {
    const candidates = findJourneyCandidates({ kind: 'abandoned_cart', triggers, now });
    expect(candidates[0]?.customerRef).toBe('c-stale');
    expect(candidates.map((c) => c.valueMinor)).toEqual([400_000, 250_000, 120_000, 90_000, 500]);
  });
});

describe('attribution is measured honestly, against a control group', () => {
  const orders = [
    { customerRef: 'c-1', at: '2026-08-05T12:00:00Z', netMinor: 200_000, marginMinor: 40_000 },
    { customerRef: 'c-2', at: '2026-08-05T13:00:00Z', netMinor: 100_000, marginMinor: 20_000 },
    // Placed BEFORE the message — not caused by it.
    { customerRef: 'c-3', at: '2026-08-05T09:00:00Z', netMinor: 500_000, marginMinor: 90_000 },
    // Outside the window.
    { customerRef: 'c-4', at: '2026-08-09T12:00:00Z', netMinor: 300_000, marginMinor: 60_000 },
  ];

  it('counts only orders AFTER the send, inside the window, by people who received it', () => {
    const result = measureCampaign({
      campaignId: 'CMP-1',
      sentTo: ['c-1', 'c-2', 'c-3', 'c-4'],
      sentAt: '2026-08-05T10:00:00Z',
      attributionWindowHours: 48,
      orders,
    });
    expect(result.converted).toBe(2);
    expect(result.attributedRevenueMinor).toBe(300_000);
    expect(result.attributedMarginMinor).toBe(60_000);
    expect(result.conversionBps).toBe(5_000);
  });

  it('SAYS IT CANNOT BE CALLED UPLIFT with no control group', () => {
    const result = measureCampaign({
      campaignId: 'CMP-1', sentTo: ['c-1', 'c-2'], sentAt: '2026-08-05T10:00:00Z',
      attributionWindowHours: 48, orders,
    });
    expect(result.controlConversionBps).toBe('no_control_group');
    expect(result.upliftBps).toBe('not_meaningful');
    expect(result.detail).toContain('cannot be called uplift, only activity');
  });

  it('reports real uplift when the campaign beat doing nothing', () => {
    const result = measureCampaign({
      campaignId: 'CMP-1',
      sentTo: ['c-1', 'c-2', 'c-5', 'c-6'],
      sentAt: '2026-08-05T10:00:00Z',
      attributionWindowHours: 48,
      orders,
      controlGroup: ['c-7', 'c-8', 'c-9', 'c-10'],
    });
    expect(result.conversionBps).toBe(5_000);
    expect(result.controlConversionBps).toBe(0);
    expect(result.upliftBps).toBe(5_000);
    expect(result.detail).toContain('points of real uplift');
  });

  it('SAYS SO when the campaign did not beat doing nothing', () => {
    const controlOrders = [
      ...orders,
      { customerRef: 'c-7', at: '2026-08-05T12:00:00Z', netMinor: 100_000, marginMinor: 20_000 },
      { customerRef: 'c-8', at: '2026-08-05T12:00:00Z', netMinor: 100_000, marginMinor: 20_000 },
      { customerRef: 'c-9', at: '2026-08-05T12:00:00Z', netMinor: 100_000, marginMinor: 20_000 },
    ];
    const result = measureCampaign({
      campaignId: 'CMP-1',
      sentTo: ['c-1', 'c-2', 'c-5', 'c-6'],
      sentAt: '2026-08-05T10:00:00Z',
      attributionWindowHours: 48,
      orders: controlOrders,
      controlGroup: ['c-7', 'c-8', 'c-9', 'c-10'],
    });
    expect(result.controlConversionBps).toBe(7_500);
    expect(result.detail).toContain('did not beat doing nothing');
  });

  it('handles a campaign sent to nobody without dividing by zero', () => {
    const result = measureCampaign({
      campaignId: 'CMP-1', sentTo: [], sentAt: '2026-08-05T10:00:00Z', attributionWindowHours: 48, orders,
    });
    expect(result.conversionBps).toBe(0);
    expect(result.converted).toBe(0);
  });
});
