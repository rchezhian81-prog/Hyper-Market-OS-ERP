import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Loyalty durability — the money-like customer balances rebuild from the event store after a restart
// (M17-FR-01 points, M17-FR-03 gift cards / store credit; API-06, P-04 "tested recovery", P-08, FND-01).
//
// Points and stored value are MONEY-LIKE: each balance is projected from append-only movements, never a
// stored figure (hard rule #2). loyalty-points / stored-value prove the earn/burn/issue/redeem behaviour,
// the never-negative guards, idempotency and per-tenant isolation; coupons (FR-02) and household-pooling
// (FR-04) already carry their own restart proofs. The one property the points and stored-value ledgers did
// not prove is that a customer's balance SURVIVES the process restarting — a balance that silently resets to
// zero (or to "unknown") on a restart is money quietly lost or created. This closes that gap, mirroring the
// restart-rebuild bar the other event-sourced surfaces carry (goods-receipt, connector-delivery, facilities,
// production, warehouse).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// FR-01 points
const points = (h: ApiHarness, u: string, customerId: string, movementId: string, kind: string, pts: number) =>
  h.request({ method: 'POST', path: `/v1/customers/${customerId}/points`, userId: u, tenantId: A, idempotencyKey: `pm-${movementId}`, body: { movementId, kind, points: pts } });
const pointsBalance = (h: ApiHarness, u: string, customerId: string) =>
  h.request({ method: 'GET', path: `/v1/customers/${customerId}/points`, userId: u, tenantId: A });

// FR-03 stored value (gift card / store credit)
const issueGift = (h: ApiHarness, u: string, id: string, faceValueMinor: number) =>
  h.request({ method: 'POST', path: '/v1/stored-value/instruments', userId: u, tenantId: A, idempotencyKey: `iss-${id}`, body: { instrumentId: id, kind: 'gift_card', ownerRef: 'H1', faceValueMinor } });
const redeem = (h: ApiHarness, u: string, id: string, movementId: string, amountMinor: number) =>
  h.request({ method: 'POST', path: `/v1/stored-value/instruments/${id}/redeem`, userId: u, tenantId: A, idempotencyKey: `red-${movementId}`, body: { movementId, amountMinor, channel: 'store' } });
const giftBalance = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/stored-value/instruments/${id}`, userId: u, tenantId: A });

interface PointsBal { pointsBalance?: number; known: boolean }
interface GiftBal { balanceMinor: number }

describe('loyalty durability: points and gift-card balances rebuild from the event store after a restart (M17)', () => {
  it('replays a points balance and a gift-card balance to the same figure, and keeps applying movements', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // FR-01: earn 100, burn 30 → 70 points (assert on the projected balance the movement returns).
    expect(((await points(h, 'u-owner', 'C1', 'm1', 'earn', 100)).body as { balance: number }).balance).toBe(100);
    expect(((await points(h, 'u-owner', 'C1', 'm2', 'burn', 30)).body as { balance: number }).balance).toBe(70);
    // FR-03: issue a ₹1,000 gift card, redeem ₹300 → ₹700 left.
    expect(((await issueGift(h, 'u-owner', 'GC-1', 100_000)).body as GiftBal).balanceMinor).toBe(100_000);
    expect(((await redeem(h, 'u-owner', 'GC-1', 'r1', 30_000)).body as GiftBal).balanceMinor).toBe(70_000);

    // Restart: a NEW surface over the SAME persisted event store — both balances must rebuild from the log.
    const restarted = apiHarness({ store: h.store });

    const pb = (await pointsBalance(restarted, 'u-owner', 'C1')).body as PointsBal;
    expect(pb.known, 'the customer became UNKNOWN after the restart').toBe(true);
    expect(pb.pointsBalance, 'the points balance did not survive the restart').toBe(70);

    const gb = (await giftBalance(restarted, 'u-owner', 'GC-1')).body as GiftBal;
    expect(gb.balanceMinor, 'the gift-card balance did not survive the restart').toBe(70_000);

    // The rebuilt surface is LIVE, not a read-only replay: further movements land on top of the replayed
    // balances (and the never-negative guards still hold against the rebuilt state).
    expect(((await points(restarted, 'u-owner', 'C1', 'm3', 'burn', 20)).body as { balance: number }).balance).toBe(50);
    expect(((await redeem(restarted, 'u-owner', 'GC-1', 'r2', 20_000)).body as GiftBal).balanceMinor).toBe(50_000);
  });
});
