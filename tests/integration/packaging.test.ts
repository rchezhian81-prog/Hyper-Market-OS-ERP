import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Packaging back-office — items, movements & circulation, end to end through the real API
// (M28-FR-03, API-04). A shop that treats a reusable crate as a consumable buys the same 400 crates
// every year and never asks where they went — so a returnable is projected IN CIRCULATION (out with a
// delivery, not yet back) with a loss rate, while a carry bag is simply gone. And a negative position is
// reported NEGATIVE, not clamped to zero, because bags going out with none recorded in is the evidence
// that a goods-in was never entered, and clamping destroys it. (The bag CHARGE itself is offline, in the
// price pack the lane holds — not on this surface.) Proves the wired packaging surface against real RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const item = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/packaging/items/${id}`, userId, tenantId, idempotencyKey: `it-${id}`, body });
const move = (h: ApiHarness, tenantId: string, userId: string, packagingId: string, movementId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/packaging/items/${packagingId}/movements/${movementId}`, userId, tenantId, idempotencyKey: `mv-${movementId}`, body });
const position = (h: ApiHarness, tenantId: string, userId: string, packagingId: string, branchId: string) =>
  h.request({ method: 'GET', path: `/v1/packaging/items/${packagingId}/position`, userId, tenantId, query: { branchId } });

interface Pos { onHand: number; inCirculation: number; issuedTotal: number; returnedTotal: number; writtenOff: number; lossRateBps: number | 'not_meaningful'; negative: boolean; detail: string }
const crate = { name: 'Green crate', kind: 'reusable_crate', returnable: true };

describe('packaging: crates circulate, bags are gone, a negative is evidence (M28-FR-03)', () => {
  it('projects a returnable in circulation with a loss rate', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await item(h, A, 'u-owner', 'crate-1', crate);
    await move(h, A, 'u-owner', 'crate-1', 'm1', { branchId: 'BR1', kind: 'received', qty: 400, at: '2026-08-01T09:00:00Z' });
    await move(h, A, 'u-owner', 'crate-1', 'm2', { branchId: 'BR1', kind: 'issued_to_delivery', qty: 100, at: '2026-08-02T09:00:00Z' });
    await move(h, A, 'u-owner', 'crate-1', 'm3', { branchId: 'BR1', kind: 'returned', qty: 82, at: '2026-08-05T09:00:00Z' });

    const p = (await position(h, A, 'u-owner', 'crate-1', 'BR1')).body as Pos;
    expect(p.onHand).toBe(382);          // 400 - 100 out + 82 back
    expect(p.inCirculation).toBe(18);    // 100 out, 82 back → 18 still with drivers/customers
    expect(p.lossRateBps).toBe(1_800);   // 18 of 100 = 18.0%
    expect(p.negative).toBe(false);
  });

  it('reports a negative on-hand as negative rather than clamping it to zero', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // A carry bag: not returnable, and 50 issued with none ever recorded in → the goods-in was missed.
    await item(h, A, 'u-owner', 'bag-1', { name: 'Carry bag', kind: 'carry_bag', returnable: false });
    await move(h, A, 'u-owner', 'bag-1', 'm1', { branchId: 'BR1', kind: 'issued_to_customer', qty: 50, at: '2026-08-01T09:00:00Z' });

    const p = (await position(h, A, 'u-owner', 'bag-1', 'BR1')).body as Pos;
    expect(p.onHand).toBe(-50);
    expect(p.negative).toBe(true);
    expect(p.inCirculation).toBe(0);          // a carry bag is gone, never "in circulation"
    expect(p.lossRateBps).toBe('not_meaningful');
    expect(p.detail).toContain('NEGATIVE');
  });

  it('treats a write-off as a compensating movement, and projects per branch', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await item(h, A, 'u-owner', 'crate-1', crate);
    await move(h, A, 'u-owner', 'crate-1', 'm1', { branchId: 'BR1', kind: 'received', qty: 100, at: '2026-08-01T09:00:00Z' });
    await move(h, A, 'u-owner', 'crate-1', 'm2', { branchId: 'BR1', kind: 'written_off', qty: 10, at: '2026-08-03T09:00:00Z' });

    const p = (await position(h, A, 'u-owner', 'crate-1', 'BR1')).body as Pos;
    expect(p.onHand).toBe(90);
    expect(p.writtenOff).toBe(10);
    // Another branch never saw these crates.
    expect(((await position(h, A, 'u-owner', 'crate-1', 'BR2')).body as Pos).onHand).toBe(0);
  });

  it('is authorized and per-tenant, and refuses unknown/malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not manage packaging stock
    await item(h, A, 'u-owner', 'crate-1', crate);

    expect((await item(h, A, 'u-cash', 'crate-x', crate)).status).toBe(403);
    expect((await move(h, A, 'u-owner', 'GHOST', 'm1', { branchId: 'BR1', kind: 'received', qty: 1, at: '2026-08-01T09:00:00Z' })).status).toBe(404);
    expect((await item(h, A, 'u-owner', 'bad-1', { name: 'x', kind: 'nonsense', returnable: true })).status).toBe(400);
    expect((await move(h, A, 'u-owner', 'crate-1', 'mbad', { branchId: 'BR1', kind: 'received', qty: 0, at: '2026-08-01T09:00:00Z' })).status).toBe(400); // qty must be positive
    expect((await position(h, A, 'u-owner', 'GHOST', 'BR1')).status).toBe(404);

    await h.seedOwner(B, 'u-owner-b');
    expect((await position(h, B, 'u-owner-b', 'crate-1', 'BR1')).status).toBe(404);
  });
});
