import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { backingsFor, headOffice } from '../support/till-bill-world';
import { giftCardTimeOfSupplyAtIssue, giftCardTimeOfSupplyAtRedemption } from '../../services/customer/src/stored-value';

/**
 * **A12 (2) — a gift voucher's issue and redemption record their time of supply through the tested `voucherTimeOfSupply`
 * (CGST s.12(4)): a gift card that buys anything in the shop is not for a supply identifiable at issue, so GST on what it
 * buys is due on the REDEMPTION date; one issued for an identified supply is due on the issue date. Store credit is a
 * refund, not a voucher, and records none.** In memory AND on real PostgreSQL, read back after a cold restart.
 *
 * A12 (1), the free-sample ITC reversal, is NOT built here: no "free sample" stock issue exists, and how one is recorded and
 * how much credit it reverses is a question for the owner and the CA (the builder's report, A12-Q).
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

describe('A12 — the time of supply rules, as recorded', () => {
  it('an ordinary gift card: pending at issue, the redemption date at redemption; an identified one: the issue date', () => {
    expect(giftCardTimeOfSupplyAtIssue({ supplyIdentifiableAtIssue: false, issueDate: '2026-10-01' })).toMatchObject({ basis: 'redemption', pending: true });
    expect(giftCardTimeOfSupplyAtIssue({ supplyIdentifiableAtIssue: true, issueDate: '2026-10-01' })).toMatchObject({ basis: 'issue', timeOfSupply: '2026-10-01' });
    const card = { instrumentId: 'g1', kind: 'gift_card' as const, ownerRef: 'c1', issuedAt: '2026-10-01T10:00:00.000Z', timeOfSupply: { basis: 'redemption' as const, pending: true as const, detail: '' } };
    expect(giftCardTimeOfSupplyAtRedemption(card, '2026-10-23')).toMatchObject({ basis: 'redemption', timeOfSupply: '2026-10-23' });
    expect(giftCardTimeOfSupplyAtRedemption({ ...card, timeOfSupply: { basis: 'issue', timeOfSupply: '2026-10-01', detail: '' } }, '2026-10-23')).toMatchObject({ basis: 'issue', timeOfSupply: '2026-10-01' });
    expect(giftCardTimeOfSupplyAtRedemption({ ...card, kind: 'store_credit' }, '2026-10-23')).toBeUndefined();
  });
});

describe.each(backings)('A12 — a gift card records its time of supply at issue and redemption — on $name', (backing) => {
  it('issue → pending (redemption basis); redeem → that day; identified → issue day; store credit → none; an accountant 403; bad flag 400; read after a cold restart', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-anita', role: 'accountant' }]);
    const today = new Date().toISOString().slice(0, 10);
    expect((await ho.call('POST', '/v1/stored-value/instruments', 'u-anita', { instrumentId: 'GC-X', kind: 'gift_card', ownerRef: 'c1', faceValueMinor: 50_000 })).status).toBe(403);
    expect((await ho.call('POST', '/v1/stored-value/instruments', 'u-owner', { instrumentId: 'GC-BAD', kind: 'gift_card', ownerRef: 'c1', faceValueMinor: 50_000, supplyIdentifiableAtIssue: 'yes' })).status).toBe(400);
    const card = await ho.ok('POST', '/v1/stored-value/instruments', 'u-owner', { instrumentId: 'GC-1', kind: 'gift_card', ownerRef: 'c1', faceValueMinor: 50_000 });
    expect(card['timeOfSupply']).toMatchObject({ basis: 'redemption', pending: true });
    const named = await ho.ok('POST', '/v1/stored-value/instruments', 'u-owner', { instrumentId: 'GC-2', kind: 'gift_card', ownerRef: 'c1', faceValueMinor: 20_000, supplyIdentifiableAtIssue: true });
    expect(named['timeOfSupply']).toMatchObject({ basis: 'issue', timeOfSupply: today });
    const credit = await ho.ok('POST', '/v1/stored-value/instruments', 'u-owner', { instrumentId: 'SC-1', kind: 'store_credit', ownerRef: 'c1', faceValueMinor: 10_000 });
    expect(credit['timeOfSupply']).toBeUndefined();

    const r1 = await ho.ok('POST', '/v1/stored-value/instruments/GC-1/redeem', 'u-owner', { movementId: 'm1', amountMinor: 12_000, channel: 'store', saleId: 'S-1' });
    expect(r1['timeOfSupply']).toMatchObject({ basis: 'redemption', timeOfSupply: today });
    const r2 = await ho.ok('POST', '/v1/stored-value/instruments/GC-2/redeem', 'u-owner', { movementId: 'm2', amountMinor: 5_000, channel: 'store' });
    expect(r2['timeOfSupply']).toMatchObject({ basis: 'issue', timeOfSupply: today });
    const r3 = await ho.ok('POST', '/v1/stored-value/instruments/SC-1/redeem', 'u-owner', { movementId: 'm3', amountMinor: 1_000, channel: 'store' });
    expect(r3['timeOfSupply']).toBeUndefined();

    ho.restartCold(); // ── head office COLD: what was recorded is what is read ─────────────────────────────────────────
    const read = await ho.ok('GET', '/v1/stored-value/instruments/GC-1', 'u-owner') as { timeOfSupply: unknown; balanceMinor: number; redemptions: { movementId: string; timeOfSupply: unknown }[] };
    expect(read.balanceMinor).toBe(38_000);
    expect(read.timeOfSupply).toMatchObject({ basis: 'redemption', pending: true });
    expect(read.redemptions).toEqual([expect.objectContaining({ movementId: 'm1', amountMinor: 12_000, timeOfSupply: expect.objectContaining({ basis: 'redemption', timeOfSupply: today }) })]);
  }, 60_000);
});
