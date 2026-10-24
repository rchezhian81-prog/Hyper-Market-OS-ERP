import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';

// OB-295 (owner, 23 Oct 2026) · M17-FR-01 · D07-FR-03 — loyalty TIERS by 12-month spend, each with a points multiplier, and
// POINTS EXPIRY N months after they are earned. BOTH stay OFF until the owner enters the numbers, and each reads "not
// set" until then; the CA's accounting note stands beside expiry. Proved through the real API, in memory and on real
// PostgreSQL with a cold restart:
//   • not set → base points only, nothing expires, and every read says "not set";
//   • only the owner sets the numbers (a manager is refused); a malformed ladder is refused by name;
//   • a bill earns its tier's multiplier, from the member's OWN spend in the 12 months BEFORE it (the bill itself not
//     counted); the member's standing shows the tier, the 12-month spend and what reaches the next tier;
//   • expiry takes what is left of a lot N months after it arrived, oldest first, once — a second run moves nothing; a
//     spend already taken from the old lot is not expired twice; switching expiry off stops it (a new fact).

const backings = useRestartableBackings();
const MOBILE = '98400 55501';
const MEMBER = memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), MOBILE)!;
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

interface Programme { tiers: { state: string; tiers: unknown[]; say: { en: string; ta: string } }; expiry: { state: string; months: number | null; say: { en: string; ta: string } }; accountingNote: { en: string; ta: string } }

describe.each(backings)('loyalty tiers and points expiry stay off until the owner sets them (OB-295) — on $name', ({ harness }) => {
  it('"not set" until entered; the owner alone sets them; a bill earns its tier; expiry once, oldest first; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (hh: ApiHarness, method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
      hh.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const programme = async (hh = h) => { const r = await call(hh, 'GET', '/v1/loyalty/programme', 'u-mgr'); expect(r.status).toBe(200); return r.body as Programme; };

    // Not set: both off, said in both languages, with the CA's note beside expiry.
    const first = await programme();
    expect(first.tiers.state).toBe('not_set');
    expect(first.tiers.say.en).toBe('Tiers: not set. Every member earns the base rule until the owner enters the tiers.');
    expect(first.expiry.state).toBe('not_set');
    expect(first.expiry.say.en).toMatch(/^Points expiry: not set\./);
    expect(first.accountingNote.en).toMatch(/Chartered Accountant must confirm how expired points are booked/);
    expect(first.accountingNote.ta.length).toBeGreaterThan(20);

    // The owner's base rule (1 point per ₹100, a point worth ₹1), and a member.
    for (const [key, value] of [['loyalty.points_per_100_inr', 1], ['loyalty.point_value_paise', 100]] as const) {
      expect((await h.request({ method: 'PUT', path: `/v1/platform/setup/${key}`, userId: 'u-owner', tenantId: T, idempotencyKey: `rule-${key}`, body: { value } })).status).toBeLessThan(300);
    }
    expect((await call(h, 'POST', '/v1/loyalty/members', 'u-mgr', { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' })).status).toBe(201);
    const bank = async (saleId: string, totalMinor: number, committedAt = new Date().toISOString()) => {
      const r = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-cash', tenantId: T, idempotencyKey: `bank-${saleId}`, body: {
        saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: committedAt.slice(0, 10), committedAt, totalMinor, currency: 'INR', packVersion: 1,
        lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: totalMinor, lineTotalMinor: totalMinor }], tenders: [{ kind: 'cash', amountMinor: totalMinor }], customerRef: MEMBER,
      } });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      return (r.body as { loyalty: { outcome: string; points?: number; detail: string } }).loyalty;
    };
    // A bill from before they joined counts towards their spend but earns nothing; tiers not set: the base rule alone.
    expect(await bank('S1', 125_000, daysAgo(40))).toMatchObject({ outcome: 'not_a_member' });
    expect(await bank('S0', 125_000)).toMatchObject({ outcome: 'earned', points: 12, detail: '12 point(s) earned.' });

    // Only the owner sets the numbers; a ladder that does not rise is refused by name.
    const ladder = [
      { tierId: 'silver', name: 'Silver', nameTa: 'வெள்ளி', minSpend12mMinor: 100_000, multiplierBps: 15_000 },
      { tierId: 'gold', name: 'Gold', nameTa: 'தங்கம்', minSpend12mMinor: 500_000, multiplierBps: 20_000 },
    ];
    expect((await call(h, 'PUT', '/v1/loyalty/programme/tiers', 'u-mgr', { tiers: ladder, reason: 'owner said' })).status).toBe(403);
    expect(codeOf(await call(h, 'PUT', '/v1/loyalty/programme/tiers', 'u-owner', { tiers: [ladder[1], ladder[0]], reason: 'wrong order' }))).toBe('tiers_thresholds_not_rising');
    expect(codeOf(await call(h, 'PUT', '/v1/loyalty/programme/tiers', 'u-owner', { tiers: ladder }))).toBe('reason_required');
    const set = await call(h, 'PUT', '/v1/loyalty/programme/tiers', 'u-owner', { tiers: ladder, reason: 'OB-295 numbers (synthetic)' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((set.body as Programme).tiers.state).toBe('set');

    // ₹2,500 already spent in the 12 months before this bill → Silver, ×1.5: 12 base points become 18.
    expect(await bank('S2', 125_000)).toMatchObject({ outcome: 'earned', points: 18, detail: '18 point(s) earned (Silver tier, ×1.5).' });
    const standing = async (hh = h) => { const r = await call(hh, 'GET', `/v1/loyalty/members/${MEMBER}/standing`, 'u-mgr'); expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body as { spend12mMinor: number; tier: { tierId: string } | null; multiplierBps: number; nextTier?: { tierId: string; moreSpendMinor: number }; pointsBalance: number; expiry: { state: string; next?: unknown; dueNow?: number } }; };
    const s1 = await standing();
    expect(s1.spend12mMinor).toBe(375_000);
    expect(s1.tier?.tierId).toBe('silver');
    expect(s1.nextTier).toEqual({ tierId: 'gold', name: 'Gold', moreSpendMinor: 125_000 });
    expect(s1.pointsBalance).toBe(30);
    expect(s1.expiry.state).toBe('not_set');

    // Expiry off: a run moves nothing and says so.
    const off = await call(h, 'POST', '/v1/loyalty/points-expiry/run', 'u-mgr', {});
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ on: false, pointsExpired: 0 });

    // Older points on the member's ledger (a synthetic opening load 14 and 2 months ago), and a spend 13 months ago that
    // already took 30 of the oldest 100.
    const movement = async (movementId: string, delta: number, reason: string, at: string) =>
      h.store.append(T, streamName(STREAM.loyalty, MEMBER), makeEvent({ id: `points-${movementId}`, type: 'PointsMovement', occurredAt: at, idempotencyKey: `points-${T}-${movementId}`, source: 'test/seed', payload: { movementId, customerId: MEMBER, delta, reason, sourceRef: 'synthetic', at } }));
    await movement('open-old', 100, 'earn', daysAgo(14 * 30));
    await movement('spend-old', -30, 'burn', daysAgo(13 * 30));
    await movement('open-recent', 50, 'earn', daysAgo(60));
    expect((await call(h, 'PUT', '/v1/loyalty/programme/expiry', 'u-mgr', { months: 12, reason: 'x' })).status).toBe(403);
    expect(codeOf(await call(h, 'PUT', '/v1/loyalty/programme/expiry', 'u-owner', { months: 0, reason: 'x' }))).toBe('expiry_months_unreadable');
    expect((await call(h, 'PUT', '/v1/loyalty/programme/expiry', 'u-owner', { months: 12, reason: 'OB-295 numbers (synthetic)' })).status).toBe(200);

    const run = await call(h, 'POST', '/v1/loyalty/points-expiry/run', 'u-mgr', {});
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    const r = run.body as { on: boolean; pointsExpired: number; expired: { lotMovementId: string; points: number }[]; detail: string; accountingNote: { en: string } };
    expect(r.on).toBe(true);
    expect(r.expired.map((e) => [e.lotMovementId, e.points])).toEqual([['open-old', 70]]);
    expect(r.detail).toBe('70 point(s) expired across 1 member(s), oldest first. The books are not changed until the CA confirms the journal.');
    // Once: a second run moves nothing.
    expect((await call(h, 'POST', '/v1/loyalty/points-expiry/run', 'u-mgr', {})).body).toMatchObject({ on: true, pointsExpired: 0 });
    const s2 = await standing();
    expect(s2.pointsBalance).toBe(30 + 100 - 30 + 50 - 70);
    expect(s2.expiry.state).toBe('set');
    // The member's own points read agrees with the ledger (append-only: the expiry is its own movement).
    const pts = (await call(h, 'GET', `/v1/customers/${MEMBER}/points`, 'u-owner')).body as { pointsBalance?: number };
    expect(pts.pointsBalance).toBe(80);

    // A cold restart reads the same settings and the same balance; switching expiry off is a new fact.
    const h2 = harness(h);
    const again = await programme(h2);
    expect(again.tiers.state).toBe('set');
    expect(again.expiry).toMatchObject({ state: 'set', months: 12 });
    expect((await standing(h2)).pointsBalance).toBe(80);
    expect((await call(h2, 'PUT', '/v1/loyalty/programme/expiry', 'u-owner', { months: null, reason: 'off again (synthetic)' })).status).toBe(200);
    expect((await programme(h2)).expiry.state).toBe('not_set');
  });
});
