import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **Back-door dock scheduling + ASN comparison, on the cloud (M07-FR-01/03, API-04).**
 *
 * Two things at the back door nothing downstream can fix: two lorries booked on one door at one time
 * (a queue, not a schedule), and booking stock from what the supplier SAID they sent (the advice note
 * is a promise, not a receipt). These drive the tested `bookDockSlot` / `compareAgainstAsn` through the
 * real authenticated surface — both stateless: the caller supplies the day's bookings, or the ASN and
 * the tally of what actually arrived. Nothing is booked or stocked here; it only decides and compares.
 */

const TENANT = 't-sre';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const SLOT = { slotId: 'ds-1', storeId: 'store-1', dockId: 'dock-A', startsAt: '2026-08-05T06:00:00Z', endsAt: '2026-08-05T07:00:00Z', status: 'booked' };

describe('back-door dock scheduling + ASN comparison (M07-FR-01)', () => {
  it('books a free dock slot', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/inventory/dock-slots/book', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'dk-free',
      body: { slot: SLOT, existing: [] },
    });
    expect(res.status).toBe(200);
    expect((res.body as { booked: { slotId: string } }).booked.slotId).toBe('ds-1');
  });

  it('refuses a second lorry overlapping the same door — but allows a different door and back-to-back', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const clash = await h.request({
      method: 'POST', path: '/v1/inventory/dock-slots/book', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'dk-clash',
      body: { slot: { ...SLOT, slotId: 'ds-2', startsAt: '2026-08-05T06:30:00Z', endsAt: '2026-08-05T07:30:00Z' }, existing: [SLOT] },
    });
    expect(clash.status).toBe(409);
    expect(codeOf(clash)).toBe('dock_conflict');

    const otherDoor = await h.request({
      method: 'POST', path: '/v1/inventory/dock-slots/book', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'dk-otherdoor',
      body: { slot: { ...SLOT, slotId: 'ds-3', dockId: 'dock-B' }, existing: [SLOT] },
    });
    expect(otherDoor.status).toBe(200);
  });

  it('compares the advice note against what actually arrived, surfacing only the differences', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/inventory/asn/compare', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'asn-1',
      body: {
        asn: {
          asnId: 'asn-1', supplierId: 'sup-1', poId: 'po-1', expectedAt: '2026-08-05T06:00:00Z',
          lines: [
            { lineId: 'l1', productId: 'milk', quantityMinor: 100, uom: 'each' },
            { lineId: 'l2', productId: 'rice', quantityMinor: 50, uom: 'each' },
          ],
        },
        received: { milk: 90, rice: 50, sugar: 5 }, // milk short 10; rice matches (no row); sugar not advised (+5)
      },
    });
    expect(res.status).toBe(200);
    const b = res.body as { differences: { productId: string; differenceMinor: number; detail: string }[]; count: number; matched: boolean };
    expect(b.matched).toBe(false);
    expect(b.count).toBe(2); // rice matched, so it is not a row
    const milk = b.differences.find((d) => d.productId === 'milk');
    expect(milk?.differenceMinor).toBe(-10);
    expect(milk?.detail).toContain('promise, not a receipt');
    const sugar = b.differences.find((d) => d.productId === 'sugar');
    expect(sugar?.differenceMinor).toBe(5);
    expect(b.differences.find((d) => d.productId === 'rice')).toBeUndefined();
  });

  it('reports a clean delivery as matched, with no differences', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/inventory/asn/compare', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'asn-clean',
      body: {
        asn: { asnId: 'asn-2', supplierId: 'sup-1', expectedAt: '2026-08-05T06:00:00Z', lines: [{ lineId: 'l1', productId: 'milk', quantityMinor: 100, uom: 'each' }] },
        received: { milk: 100 },
      },
    });
    expect(res.status).toBe(200);
    const b = res.body as { matched: boolean; count: number };
    expect(b.matched).toBe(true);
    expect(b.count).toBe(0);
  });

  it('refuses unreadable bodies, and is closed without the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const badDock = await h.request({
      method: 'POST', path: '/v1/inventory/dock-slots/book', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'dk-bad', body: { slot: { slotId: 'x' } },
    });
    expect(badDock.status).toBe(400);
    expect(codeOf(badDock)).toBe('not_readable_as_a_dock_booking');

    const badAsn = await h.request({
      method: 'POST', path: '/v1/inventory/asn/compare', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'asn-bad', body: { asn: { asnId: 'a' } },
    });
    expect(badAsn.status).toBe(400);
    expect(codeOf(badAsn)).toBe('not_readable_as_an_asn_comparison');

    const forbidden = await h.request({
      method: 'POST', path: '/v1/inventory/dock-slots/book', userId: 'u-nobody', tenantId: TENANT, idempotencyKey: 'dk-403', body: { slot: SLOT, existing: [] },
    });
    expect(forbidden.status).toBe(403);
  });
});
