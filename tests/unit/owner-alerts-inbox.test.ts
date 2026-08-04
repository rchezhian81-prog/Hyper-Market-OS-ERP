import { describe, it, expect } from 'vitest';
import {
  raiseOwnerAlerts,
  buildInbox,
  type ExceptionEvent,
  type OwnerThresholds,
  type InboxApproval,
} from '../../packages/owner-control/src/alerts-inbox';

// M29-FR-03 acceptance: "a voided-bill exception REACHES THE OWNER AND IS REAL; the
// owner approves a pending item from the inbox and it commits; freshness is always
// visible." Roadmap Annexure H names the five kinds.

const ev = (over: Partial<ExceptionEvent>): ExceptionEvent => ({
  eventId: 'e-1',
  kind: 'voided_bill',
  at: '2026-08-04T14:00:00Z',
  branchId: 'store-1',
  actorId: 'u-cashier-7',
  valueMinor: 50_000,
  transactionRef: 'S-1',
  ...over,
});

const THRESHOLDS: OwnerThresholds = {
  largeDiscountMinor: 50_000,
  voidedBillCount: 3,
  priceOverrideCount: 2,
  tradingHours: [6, 23],
  cashShortMinor: 20_000,
};

describe('alerts are grouped, not streamed (M29-FR-03)', () => {
  it('turns six voided bills into ONE alert with a count and a value', () => {
    const events = Array.from({ length: 6 }, (_, i) =>
      ev({ eventId: `e-${i}`, transactionRef: `S-${i}`, at: `2026-08-04T1${i}:00:00Z` }),
    );
    const alerts = raiseOwnerAlerts({ events, thresholds: THRESHOLDS });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.count).toBe(6);
    expect(alerts[0]?.valueMinor).toBe(300_000);
    expect(alerts[0]?.headline).toBe('u-cashier-7 voided 6 bills at store-1 worth 300000');
    // Every transaction is kept for the drill-through (M29-FR-02).
    expect(alerts[0]?.transactionRefs).toHaveLength(6);
    // Twice the threshold, so it escalates.
    expect(alerts[0]?.severity).toBe('urgent');
  });

  it('stays quiet below the owner\'s own threshold', () => {
    const events = Array.from({ length: 2 }, (_, i) => ev({ eventId: `e-${i}`, transactionRef: `S-${i}` }));
    expect(raiseOwnerAlerts({ events, thresholds: THRESHOLDS })).toEqual([]);
  });

  it('raises nothing at all for a kind the owner has not configured', () => {
    const events = Array.from({ length: 20 }, (_, i) => ev({ eventId: `e-${i}`, transactionRef: `S-${i}` }));
    expect(raiseOwnerAlerts({ events, thresholds: {} })).toEqual([]);
  });

  it('keeps two people\'s behaviour as two alerts — one conversation each', () => {
    const events = [
      ...Array.from({ length: 3 }, (_, i) => ev({ eventId: `a-${i}`, transactionRef: `S-a${i}` })),
      ...Array.from({ length: 3 }, (_, i) => ev({ eventId: `b-${i}`, actorId: 'u-cashier-9', transactionRef: `S-b${i}` })),
    ];
    const alerts = raiseOwnerAlerts({ events, thresholds: THRESHOLDS });
    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map((a) => a.actorId))).toEqual(new Set(['u-cashier-7', 'u-cashier-9']));
  });
});

describe('the five exception kinds the roadmap names (Annexure H)', () => {
  it('large discount — one big one is enough, and five times the limit is urgent', () => {
    const one = raiseOwnerAlerts({
      events: [ev({ kind: 'large_discount', valueMinor: 60_000, transactionRef: 'S-9' })],
      thresholds: THRESHOLDS,
    });
    expect(one[0]?.severity).toBe('attention');
    expect(one[0]?.headline).toContain('gave a discount of 60000');

    const huge = raiseOwnerAlerts({
      events: [ev({ kind: 'large_discount', valueMinor: 400_000, transactionRef: 'S-9' })],
      thresholds: THRESHOLDS,
    });
    expect(huge[0]?.severity).toBe('urgent');
  });

  it('large discount — ignores the small ones inside the group', () => {
    const alerts = raiseOwnerAlerts({
      events: [
        ev({ kind: 'large_discount', eventId: 'e-1', valueMinor: 60_000, transactionRef: 'S-1' }),
        ev({ kind: 'large_discount', eventId: 'e-2', valueMinor: 500, transactionRef: 'S-2' }),
      ],
      thresholds: THRESHOLDS,
    });
    expect(alerts[0]?.count).toBe(1);
    expect(alerts[0]?.valueMinor).toBe(60_000);
    expect(alerts[0]?.transactionRefs).toEqual(['S-1']);
  });

  it('price override', () => {
    const alerts = raiseOwnerAlerts({
      events: Array.from({ length: 4 }, (_, i) => ev({ kind: 'price_override', eventId: `e-${i}`, transactionRef: `S-${i}` })),
      thresholds: THRESHOLDS,
    });
    expect(alerts[0]?.headline).toContain('overrode the price 4 times');
  });

  it('after-hours login is ALWAYS urgent — somebody in the system when the shop is shut', () => {
    const alerts = raiseOwnerAlerts({
      events: [
        ev({ kind: 'after_hours_login', eventId: 'e-1', at: '2026-08-04T02:30:00Z', transactionRef: 'L-1' }),
        ev({ kind: 'after_hours_login', eventId: 'e-2', at: '2026-08-04T10:00:00Z', transactionRef: 'L-2' }),
      ],
      thresholds: THRESHOLDS,
    });
    expect(alerts[0]?.severity).toBe('urgent');
    expect(alerts[0]?.count).toBe(1); // only the 02:30 one is outside hours
    expect(alerts[0]?.transactionRefs).toEqual(['L-1']);
  });

  it('cash short — one shift is attention, repeated shifts are urgent', () => {
    const once = raiseOwnerAlerts({
      events: [ev({ kind: 'cash_short', valueMinor: 30_000, transactionRef: 'T-1' })],
      thresholds: THRESHOLDS,
    });
    expect(once[0]?.severity).toBe('attention');
    expect(once[0]?.headline).toContain('till was 30000 short');

    const repeated = raiseOwnerAlerts({
      events: [
        ev({ kind: 'cash_short', eventId: 'e-1', valueMinor: 30_000, transactionRef: 'T-1' }),
        ev({ kind: 'cash_short', eventId: 'e-2', valueMinor: 25_000, transactionRef: 'T-2' }),
      ],
      thresholds: THRESHOLDS,
    });
    expect(repeated[0]?.severity).toBe('urgent');
    expect(repeated[0]?.valueMinor).toBe(55_000);
  });

  it('orders urgent first, then by value', () => {
    const alerts = raiseOwnerAlerts({
      events: [
        ev({ kind: 'cash_short', eventId: 'c-1', actorId: 'u-a', valueMinor: 25_000, transactionRef: 'T-1' }),
        ev({ kind: 'cash_short', eventId: 'c-2', actorId: 'u-a', valueMinor: 30_000, transactionRef: 'T-2' }),
        ev({ kind: 'large_discount', eventId: 'd-1', actorId: 'u-b', valueMinor: 60_000, transactionRef: 'S-d' }),
      ],
      thresholds: THRESHOLDS,
    });
    // cash_short on two shifts is urgent; one large discount is only attention.
    expect(alerts.map((a) => a.kind)).toEqual(['cash_short', 'large_discount']);
  });

  it('PUTS AN UNVALUED ALERT ABOVE A VALUED ONE OF THE SAME SEVERITY', () => {
    // "Someone signed in at 3am" carries ₹0 and is the most important line on the list.
    // A pure value sort would bury it under every void and discount — which is to say
    // at the bottom, which is to say nowhere.
    const alerts = raiseOwnerAlerts({
      events: [
        ...Array.from({ length: 6 }, (_, i) =>
          ev({ eventId: `v-${i}`, actorId: 'u-a', valueMinor: 90_000, transactionRef: `S-v${i}` }),
        ),
        ev({ kind: 'after_hours_login', eventId: 'l-1', actorId: 'u-b', at: '2026-08-04T03:00:00Z', valueMinor: 0, transactionRef: 'L-1' }),
      ],
      thresholds: THRESHOLDS,
    });
    expect(alerts.map((a) => a.severity)).toEqual(['urgent', 'urgent']);
    expect(alerts.map((a) => a.kind)).toEqual(['after_hours_login', 'voided_bill']);
    // The ₹5,400.00 of voids is still there, second — not lost, just not first.
    expect(alerts[1]?.valueMinor).toBe(540_000);
  });
});

describe('the approval inbox says WHY, never a button that fails (§28 / §31.1)', () => {
  const approval = (over: Partial<InboxApproval>): InboxApproval => ({
    requestId: 'AP-1',
    subjectType: 'price_change',
    subjectRef: 'price:p-rice',
    requestedBy: 'u-buyer',
    branchId: 'store-1',
    valueMinor: 50_000,
    requestedAt: '2026-08-04T09:00:00Z',
    subjectVersion: 'v7',
    summary: 'Rice 5kg price change',
    ...over,
  });

  const viewer = { userId: 'u-owner', branchScope: 'all' as const, authorityLimitMinor: null };
  const at = '2026-08-05T09:00:00Z';

  it('marks an item ready when it is genuinely actionable', () => {
    const [item] = buildInbox({
      approvals: [approval({})],
      viewer,
      currentSubjectVersions: { 'price:p-rice': 'v7' },
      at,
    });
    expect(item?.status).toBe('actionable');
    expect(item?.waitingHours).toBe(24);
  });

  it('FLAGS AN ITEM THE WORLD HAS OVERTAKEN rather than offering to commit it (§31.1)', () => {
    const [item] = buildInbox({
      approvals: [approval({})],
      viewer,
      // The price changed again after this approval was raised.
      currentSubjectVersions: { 'price:p-rice': 'v9' },
      at,
    });
    expect(item?.status).toBe('superseded');
    expect(item?.detail).toContain('undo the newer change');
  });

  it('never lets you decide your own request', () => {
    const [item] = buildInbox({
      approvals: [approval({ requestedBy: 'u-owner' })],
      viewer,
      currentSubjectVersions: {},
      at,
    });
    expect(item?.status).toBe('your_own_request');
    expect(item?.detail).toContain('someone else must decide it');
  });

  it('escalates beyond authority instead of offering a decision that would fail', () => {
    const [item] = buildInbox({
      approvals: [approval({ valueMinor: 500_000 })],
      viewer: { userId: 'u-mgr', branchScope: ['store-1'], authorityLimitMinor: 100_000 },
      currentSubjectVersions: {},
      at,
    });
    expect(item?.status).toBe('exceeds_authority');
    expect(item?.detail).toContain('above your limit of 100000');
  });

  it('hides nothing but explains out-of-scope items', () => {
    const [item] = buildInbox({
      approvals: [approval({ branchId: 'branch-2' })],
      viewer: { userId: 'u-mgr', branchScope: ['store-1'], authorityLimitMinor: null },
      currentSubjectVersions: {},
      at,
    });
    expect(item?.status).toBe('out_of_scope');
    expect(item?.detail).toContain('outside your access');
  });

  it('orders actionable first, then by value', () => {
    const items = buildInbox({
      approvals: [
        approval({ requestId: 'AP-own', requestedBy: 'u-owner' }),
        approval({ requestId: 'AP-small', valueMinor: 10_000 }),
        approval({ requestId: 'AP-big', valueMinor: 900_000 }),
        approval({ requestId: 'AP-old', subjectRef: 'price:p-oil', subjectVersion: 'v1' }),
      ],
      viewer,
      currentSubjectVersions: { 'price:p-oil': 'v4' },
      at,
    });
    expect(items.map((i) => i.requestId)).toEqual(['AP-big', 'AP-small', 'AP-old', 'AP-own']);
  });
});
