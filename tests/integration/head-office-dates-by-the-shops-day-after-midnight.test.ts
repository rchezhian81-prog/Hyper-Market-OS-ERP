import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';

/**
 * **Re-audit lane 1 R1b · R1c · A12 (2) (M01-FR-02 · section 6): at 00:40 IST on 1 November, head office dates by the
 * shop's day — not by the UTC date, which is still 31 October (and still October).** On the real API, in memory and on real
 * PostgreSQL, with a cold restart:
 *   • a gift card issued for an identified supply records 1 November as its GST time of supply, and so does its
 *     redemption of an ordinary card (A12) — before, both said 31 October;
 *   • an attendance mark at 00:40 is dated 1 November (it feeds pay and overtime);
 *   • a price "effective from 31 October" is back-dated at 00:40 on 1 November, and refused; one from 1 November is not.
 * A person without the authority is refused (403) as before.
 */

const AT_0040_IST_1_NOV = new Date('2026-10-31T19:10:00.000Z');
const backings = r3OpsBackings();
afterEach(() => { vi.useRealTimers(); });

describe.each(backings)('head office dates by the shop day after midnight — on $name (R1b · R1c)', ({ harness, restart }) => {
  it('gift card time of supply, an attendance mark and the price back-dating guard all read 1 November at 00:40 IST', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(AT_0040_IST_1_NOV);
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-anu', 'cashier');
    await h.provisionRole(T, 'u-anita', 'accountant');
    const { req, ok, code } = tenantClient(() => h, T);
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-31'); // the UTC date — what the old code used

    // ── A12: a gift card's GST time of supply ──
    expect((await req('POST', '/v1/stored-value/instruments', { instrumentId: 'GC-X', kind: 'gift_card', ownerRef: 'c1', faceValueMinor: 50_000 }, 'u-anita')).status).toBe(403);
    const named = (await ok(req('POST', '/v1/stored-value/instruments', { instrumentId: 'GC-N', kind: 'gift_card', ownerRef: 'c1', faceValueMinor: 20_000, supplyIdentifiableAtIssue: true }), 'identified card')).body as { timeOfSupply: unknown };
    expect(named.timeOfSupply).toMatchObject({ basis: 'issue', timeOfSupply: '2026-11-01' });
    await ok(req('POST', '/v1/stored-value/instruments', { instrumentId: 'GC-O', kind: 'gift_card', ownerRef: 'c1', faceValueMinor: 30_000 }), 'ordinary card');
    const spent = (await ok(req('POST', '/v1/stored-value/instruments/GC-O/redeem', { movementId: 'm1', amountMinor: 10_000, channel: 'store' }), 'redeem')).body as { timeOfSupply: unknown };
    expect(spent.timeOfSupply).toMatchObject({ basis: 'redemption', timeOfSupply: '2026-11-01' });

    // ── an attendance mark at 00:40 IST ──
    await ok(req('POST', '/v1/hr/workforce/employees/u-anu', { name: 'Anu', branchId: 'S1', roles: ['cashier'], active: true }), 'employee');
    const mark = (await ok(req('POST', '/v1/hr/workforce/attendance-marks/mk-1', { employeeId: 'u-anu', kind: 'out', method: 'pin', at: AT_0040_IST_1_NOV.toISOString() }, 'u-anu'), 'mark')).body as { mark: { date: string } };
    expect(mark.mark.date).toBe('2026-11-01');

    // ── the price back-dating guard ──
    const price = (entryId: string, effectiveFrom: string) => req('POST', `/v1/prices/list/P1/entries/${entryId}`, {
      scope: 'store', scopeRef: 'store-1', priceMinor: 10_000, costMinor: 5_000, marginFloorBps: 2_000, mrpMinor: 20_000, currency: 'INR', effectiveFrom,
    });
    expect(code(await price('e-yesterday', '2026-10-31'))).toBe('price_back_dated');
    expect((await price('e-today', '2026-11-01')).status).toBe(201);

    // ── a cold restart: what was recorded is what is read ──
    h = restart(h);
    const card = (await ok(req('GET', '/v1/stored-value/instruments/GC-O'), 'card')).body as { redemptions: { movementId: string; timeOfSupply: unknown }[] };
    expect(card.redemptions).toEqual([expect.objectContaining({ movementId: 'm1', timeOfSupply: expect.objectContaining({ timeOfSupply: '2026-11-01' }) })]);
    const marks = (await ok(req('GET', '/v1/hr/workforce/attendance-marks', undefined, 'u-owner', { date: '2026-11-01' }), 'marks')).body as { marks: { markId: string; date: string }[] };
    expect(marks.marks.find((m) => m.markId === 'mk-1')?.date).toBe('2026-11-01');
  }, 60_000);
});
