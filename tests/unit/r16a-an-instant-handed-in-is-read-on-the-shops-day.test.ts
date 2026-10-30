import { describe, it, expect } from 'vitest';
import { buildLotTraceChain } from '../../packages/quality/src/lot-trace-chain';
import { controlHealth } from '../../packages/compliance/src/risk';
import { dueToPlace, type SubscriptionPlan } from '../../packages/storefront/src/subscriptions';

/**
 * **Round 16 (R16-A · P4): the places the widened guardrail found — an instant HANDED IN to a function and sliced there to
 * its UTC date — now read the shop's date (Asia/Kolkata, the shop default, unless the caller's calendar names another).**
 *
 * The moment throughout is 19:30 UTC on 29 Oct 2026: 01:00 on 30 Oct in the shop.
 *   • a recall trace's dates (packages/quality lot-trace-chain.ts) — a receipt at 01:00 shop time is on the 30th;
 *   • a control's last attestation (packages/compliance risk.ts) — attested at 01:00 on the 30th is not stale on the 30th's
 *     window edge;
 *   • a repeat order's first day (packages/storefront subscriptions.ts) — a plan made at 01:00 on the 30th may place the 30th.
 */

const EVENING = '2026-10-29T19:30:00.000Z';

describe('a recall trace dates each hop on the shop\'s day', () => {
  it('a receipt at 01:00 shop time is dated the shop\'s day; a plain date is kept', () => {
    const chain = buildLotTraceChain({
      batchId: 'B-1',
      receipts: [
        { grnId: 'g1', supplierId: 's1', poId: 'po1', productId: 'p', locationId: 'S1', receivedAt: EVENING, quantityMinor: 5 },
        { grnId: 'g2', supplierId: 's1', poId: 'po1', productId: 'p', locationId: 'S1', receivedAt: '2026-10-28', quantityMinor: 5 },
      ],
      producedBy: [], transfers: [], usedIn: [] as never, sales: [],
    });
    const dates = (chain as unknown as { rows: { date: string }[] }).rows.map((r) => r.date).sort();
    expect(dates).toEqual(['2026-10-28', '2026-10-30']);
  });
});

describe('a control\'s attestation is dated the shop\'s day', () => {
  it('attested at 01:00 shop time on the window\'s first day is not stale', () => {
    const health = controlHealth({
      controls: [{ controlId: 'c1', title: 'Till drawer count', implements: 'P-04', ownerUserId: 'u-owner' }],
      incidents: [], remediations: [],
      attestations: [{ attestationId: 'a1', controlId: 'c1', attestedBy: 'u-owner', attestedAt: EVENING, statement: 'checked' }],
      asOfDate: '2026-11-29', attestationValidDays: 30, // stale from 30 Oct
    });
    expect(health[0]!.needsAttestation).toBe(false);
  });
});

describe('a repeat order may start on the shop\'s day it was made', () => {
  it('a plan made at 01:00 shop time on the 30th places the 30th', () => {
    const plan: SubscriptionPlan = { subscriptionId: 'sub-1', customerRef: 'c-1', lines: [{ productId: 'p', quantityMinor: 1 }], locationId: 'S1', schedule: { kind: 'every_days', days: 1 }, startsOn: '2026-10-29', fulfilment: 'pickup', createdAt: EVENING };
    const out = dueToPlace({ plan, changes: [], done: new Set(), today: '2026-10-30', now: EVENING });
    expect(out.place).toContain('2026-10-30');
    expect(out.missed).not.toContain('2026-10-29'); // made on the 30th in the shop: the 29th was never its day
  });
});

describe('the loss-prevention day with no calendar wired is the shop default\'s, never the UTC date', () => {
  it('a void at 01:00 shop time belongs to the shop\'s day; a refund then is read in that day\'s window', async () => {
    const { lpActivityAdapter } = await import('../../services/api/src/adapters');
    const { InMemoryEventStore } = await import('../../packages/persistence/src/event-store');
    const { makeEvent } = await import('../../packages/contracts/src/event');
    const store = new InMemoryEventStore();
    const lp = lpActivityAdapter({ store, now: () => EVENING });
    expect(await lp.tradingDayOf!('t-1', EVENING)).toBe('2026-10-30');
    await store.append('t-1', 'returns', makeEvent({ id: 'ret-1', type: 'ReturnRecorded', occurredAt: EVENING, idempotencyKey: 'ret-1', source: 'test', payload: { returnId: 'ret-1', processedBy: 'u-cash', processedAt: EVENING, refundMinor: 5_00 } }));
    expect((await lp.refundsOn!('t-1', '2026-10-30')).map((r) => r.txnId)).toEqual(['ret-1']);
  });
});

describe('the till\'s bundle-less stand-in dates by the shop\'s zone, never the UTC date', () => {
  it('its stand-in lane names the shop\'s date of a moment (apps/pos/web/app.js)', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync('apps/pos/web/app.js', 'utf8');
    expect(text).toContain("tradingDayAt: (at) => standInShopDate(at)");
    const body = /function standInShopDate\(at\) \{([\s\S]*?)\n\}/.exec(text)![1]!;
    const standIn = new Function('window', 'at', body) as (w: unknown, at: string) => string;
    expect(standIn({}, EVENING)).toBe('2026-10-30');
    expect(standIn({ shopTimeZone: 'Europe/London' }, EVENING)).toBe('2026-10-29');
    expect(standIn({ shopTimeZone: 'Mars/Olympus' }, EVENING)).toBe('2026-10-30');
  });
});
