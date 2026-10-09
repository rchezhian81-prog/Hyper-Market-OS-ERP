import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';

/**
 * **SF-05 — a loss is worth what the stock cost head office, never what the caller types (Wave 3 · M28-FR-01 ·
 * M08-FR-03 · §28 · P-03).**
 *
 * The audit received 100 units at ₹50 each (₹5,000) and a manager wrote all 100 off "worth 0": 201, no approval and no
 * evidence asked for, and on-hand went 100 → 0. A loss's value is now quantity × head office's own average cost of that
 * stock at that place. A different figure from the caller is refused by name; leaving it out is fine; the capture screen
 * reads the figure (and whether it is a big loss) before anything is recorded. Where head office holds no cost, the
 * caller must state a value and the loss is governed as a big one whatever that figure is — evidence and a second person
 * — and the record says the cost was unknown.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function cast(): Promise<{ h: ApiHarness; post: (id: string, body: Record<string, unknown>, u?: string) => Promise<{ status: number; body: unknown }>; onHand: (productId: string) => Promise<number> }> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  expect((await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: 'mv-oil',
    body: { movementId: 'oil', productId: 'OIL-5L', locationId: 'store-1', kind: 'received', quantityMinor: 100, uom: 'ea', occurredAt: '2026-08-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 5_000 } })).status).toBe(202);
  // stock head office holds NO cost for — received without a unit cost
  expect((await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: 'mv-gift',
    body: { movementId: 'gift', productId: 'GIFT-BOX', locationId: 'store-1', kind: 'received', quantityMinor: 10, uom: 'ea', occurredAt: '2026-08-01T09:00:00.000Z', enteredBy: 'u-owner' } })).status).toBe(202);
  return {
    h,
    post: (id, body, u = 'u-mgr') => h.request({ method: 'POST', path: `/v1/inventory/write-off/${id}`, userId: u, tenantId: A, idempotencyKey: id, body }),
    onHand: async (productId) => ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId } })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0),
  };
}
const loss = (over: Record<string, unknown> = {}) => ({ productId: 'OIL-5L', locationId: 'store-1', qty: 100, uom: 'ea', lossType: 'damage', reasonCode: 'leaking', ...over });

describe('SF-05 — a loss is valued from the stock\'s own cost', () => {
  it('THE AUDIT\'S CASE: 100 units at ₹50 written off "worth 0" is refused by name — nothing leaves the shelf', async () => {
    const { post, onHand } = await cast();
    const zero = await post('wo-1', loss({ valueMinor: 0 }));
    expect(zero.status).toBe(422);
    expect(codeOf(zero)).toBe('write_off_value_is_the_stock_cost');
    expect((zero.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/worth 500000 paise .*100 × 5000.*said 0/);
    expect(await onHand('OIL-5L')).toBe(100);
  });

  it('sent without a value, the loss takes head office\'s figure — ₹5,000, a big loss: evidence and a second person, then recorded', async () => {
    const { h, post, onHand } = await cast();
    const bare = await post('wo-2', loss());
    expect(codeOf(bare)).toBe('write_off_needs_evidence');
    const noApproval = await post('wo-2b', loss({ evidenceRef: 'photo-1' }));
    expect(codeOf(noApproval)).toBe('write_off_needs_approval');
    const body = await approvedBody(h, A, 'u-mgr', 'u-owner', 'stock_write_off', 'wo-3', loss({ evidenceRef: 'photo-1' }), { writeOffId: 'wo-3' }, 500_000);
    const ok = await post('wo-3', body);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ valueMinor: 500_000, valueSource: 'stock_cost', requiredApproval: true });
    expect(await onHand('OIL-5L')).toBe(0);
    const listed = (await h.request({ method: 'GET', path: '/v1/inventory/write-offs', userId: 'u-owner', tenantId: A })).body as { writeOffs: Record<string, unknown>[]; totalLossMinor: number };
    expect(listed.writeOffs[0]).toMatchObject({ valueMinor: 500_000, valueSource: 'stock_cost', unitCostMinor: 5_000, approvedBy: 'u-owner', raisedBy: 'u-mgr' });
    expect(listed.totalLossMinor).toBe(500_000);
  });

  it('a small loss at the stock\'s cost goes on the raiser\'s own; the right figure sent with it is accepted', async () => {
    const { post } = await cast();
    const small = await post('wo-4', loss({ qty: 6, valueMinor: 30_000 }));
    expect(small.status).toBe(201);
    expect(small.body).toMatchObject({ valueMinor: 30_000, valueSource: 'stock_cost', requiredApproval: false });
  });

  it('the value is read BEFORE recording — what the screen shows, and whether it is a big loss', async () => {
    const { h } = await cast();
    const read = (q: Record<string, string>, u = 'u-mgr') => h.request({ method: 'GET', path: '/v1/inventory/write-off-value', userId: u, tenantId: A, query: q });
    expect((await read({ productId: 'OIL-5L', locationId: 'store-1', qty: '6' })).body).toEqual({
      productId: 'OIL-5L', locationId: 'store-1', qty: 6, known: true, unitCostMinor: 5_000, valueMinor: 30_000, material: false, thresholdMinor: 50_000,
    });
    expect((await read({ productId: 'OIL-5L', locationId: 'store-1', qty: '10' })).body).toMatchObject({ valueMinor: 50_000, material: true });
    expect((await read({ productId: 'GIFT-BOX', locationId: 'store-1', qty: '1' })).body).toMatchObject({ known: false, valueMinor: null, material: true });
    expect(codeOf(await read({ productId: 'OIL-5L', locationId: 'store-1', qty: '0' }))).toBe('not_readable_as_a_loss_to_value');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await read({ productId: 'OIL-5L', locationId: 'store-1', qty: '1' }, 'u-cash')).status).toBe(403);
  });

  it('cost unknown: a value must be stated, and even a small one needs evidence and a second person; the record says so', async () => {
    const { h, post } = await cast();
    expect(codeOf(await post('wo-5', loss({ productId: 'GIFT-BOX', qty: 1 })))).toBe('write_off_cost_unknown');
    expect(codeOf(await post('wo-6', loss({ productId: 'GIFT-BOX', qty: 1, valueMinor: 100 })))).toBe('write_off_needs_evidence');
    expect(codeOf(await post('wo-7', loss({ productId: 'GIFT-BOX', qty: 1, valueMinor: 100, evidenceRef: 'photo-2' })))).toBe('write_off_needs_approval');
    const body = await approvedBody(h, A, 'u-mgr', 'u-owner', 'stock_write_off', 'wo-8', loss({ productId: 'GIFT-BOX', qty: 1, valueMinor: 100, evidenceRef: 'photo-2' }), { writeOffId: 'wo-8' }, 100);
    const ok = await post('wo-8', body);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ valueMinor: 100, valueSource: 'cost_unknown', requiredApproval: true });
  });
});
