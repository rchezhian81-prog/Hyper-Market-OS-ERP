import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Warehouse-to-store & inter-store transfers (M09-FR-03, API-04) end to end through the real API. A
// transfer moves through an explicit IN-TRANSIT state held at the destination (the van is a place);
// dispatch needs a SEPARATE approver (§28) — since SP-4 (F07) the AUTHENTICATED dispatcher, never a name in the
// body — over head office's OWN stock at the source (never a claimed quantity); recalled/quarantined stock is never
// sent (moving a problem to another branch launders it); a receipt shortfall is a VALUED exception, never a
// silent adjustment; and allocation proposes by DAYS OF COVER, committing nothing.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const propose = (h: ApiHarness, t: string, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/warehouse/transfers/${id}`, userId: u, tenantId: t, idempotencyKey: key ?? `tr-${id}`, body });
const dispatch = (h: ApiHarness, t: string, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/warehouse/transfers/${id}/dispatch`, userId: u, tenantId: t, idempotencyKey: key ?? `td-${id}`, body });
const receive = (h: ApiHarness, t: string, u: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/warehouse/transfers/${id}/receive`, userId: u, tenantId: t, idempotencyKey: `trc-${id}`, body });
const readTransfer = (h: ApiHarness, t: string, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/warehouse/transfers/${id}`, userId: u, tenantId: t });
const allocate = (h: ApiHarness, t: string, u: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/warehouse/allocation/propose`, userId: u, tenantId: t, idempotencyKey: `al-${String(body.tag ?? '')}`, body });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const LINE = { productId: 'P1', batchId: null, quantityMinor: 10, uom: 'EA', unitCost: { minor: 5_000, currency: 'INR' } };
const proposal = (over: Record<string, unknown> = {}) => ({ fromLocationId: 'WH', toLocationId: 'S1', lines: [LINE], ...over });
/** Head office's own stock at WH — the position the dispatch is checked against (SP-4, F07). */
const stock = (h: ApiHarness, qty: number, batchId?: string) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: `seed-${qty}-${batchId ?? ''}`,
    body: { movementId: `seed-${qty}-${batchId ?? ''}`, productId: 'P1', locationId: 'WH', kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: 'u-owner', ...(batchId === undefined ? {} : { batchId }) } });
/** The cast: the owner proposes, a store manager (a second person) dispatches. */
async function seeded(qty = 20): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-boss', 'store_manager');
  await stock(h, qty);
  return h;
}
interface Disc { productId: string; differenceMinor: number; value: { minor: number } }

describe('warehouse transfers: in-transit at destination, separate approver, valued shortfall, days-of-cover allocation (M09-FR-03)', () => {
  it('proposes, dispatches by a separate authenticated approver over head office\'s own stock, and holds it in transit', async () => {
    const h = await seeded(20);
    expect((await propose(h, A, 'u-owner', 't1', proposal())).status).toBe(201);

    // §28: the proposer dispatching is the proposer approving their own — refused.
    expect(codeOf(await dispatch(h, A, 'u-owner', 't1', {}, 'td-t1-self'))).toBe('transfer_refused');
    // SP-4 (F07): a body that still names an approver or claims stock is refused by name; nothing moves.
    expect(codeOf(await dispatch(h, A, 'u-boss', 't1', { approvedBy: 'u-boss' }, 'td-t1-claim'))).toBe('dispatch_carries_caller_claims');
    expect(codeOf(await dispatch(h, A, 'u-boss', 't1', { available: [{ productId: 'P1', batchId: null, quantityMinor: 999, state: 'on_hand' }] }, 'td-t1-claim2'))).toBe('dispatch_carries_caller_claims');

    const d = await dispatch(h, A, 'u-boss', 't1', {});
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ state: 'in_transit', approvedBy: 'u-boss', availableChecked: [{ productId: 'P1', quantityMinor: 20, state: 'on_hand', recalled: false }] });
    expect((await readTransfer(h, A, 'u-owner', 't1')).body).toMatchObject({ state: 'in_transit', requestedBy: 'u-owner', approvedBy: 'u-boss' });
  });

  it('refuses an over-draw against head office\'s stock, a recalled batch, and a batch under a quality hold', async () => {
    const h = await seeded(5); // only 5 at WH
    await propose(h, A, 'u-owner', 't1', proposal());
    const short = await dispatch(h, A, 'u-boss', 't1', {}, 'td-short');
    expect(codeOf(short)).toBe('transfer_refused');
    expect((short.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/only 5 of P1 available to send, not 10/);

    // A batch head office has RECALLED is never sent, however much of it there is.
    await stock(h, 50, 'B-RECALLED');
    expect((await h.request({ method: 'POST', path: '/v1/quality/recalls/B-RECALLED', userId: 'u-owner', tenantId: A, idempotencyKey: 'rc-1', body: { reason: 'contamination notice' } })).status).toBeLessThan(300);
    await propose(h, A, 'u-owner', 't2', proposal({ lines: [{ ...LINE, batchId: 'B-RECALLED' }] }));
    const recalled = await dispatch(h, A, 'u-boss', 't2', {}, 'td-r');
    expect(codeOf(recalled)).toBe('transfer_refused');
    expect((recalled.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/recalled/);

    // A batch under a quality HOLD is never sent either.
    await stock(h, 50, 'B-HELD');
    expect((await h.request({ method: 'POST', path: '/v1/quality/holds/B-HELD', userId: 'u-owner', tenantId: A, idempotencyKey: 'qh-1', body: { productId: 'P1', reason: 'temperature excursion' } })).status).toBeLessThan(300);
    await propose(h, A, 'u-owner', 't3', proposal({ lines: [{ ...LINE, batchId: 'B-HELD' }] }));
    const held = await dispatch(h, A, 'u-boss', 't3', {}, 'td-q');
    expect(codeOf(held)).toBe('transfer_refused');
    expect((held.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/quarantine/);
  });

  it('receives what arrived and raises a valued shortfall for what did not', async () => {
    const h = await seeded(20);
    await propose(h, A, 'u-owner', 't1', proposal());
    await dispatch(h, A, 'u-boss', 't1', {});

    const r = await receive(h, A, 'u-owner', 't1', { counted: [{ productId: 'P1', batchId: null, quantityMinor: 8 }] });
    expect(r.status).toBe(200);
    expect((r.body as { state: string }).state).toBe('received');
    const discs = (r.body as { discrepancies: Disc[] }).discrepancies;
    expect(discs).toHaveLength(1);
    expect(discs[0]).toMatchObject({ productId: 'P1', differenceMinor: -2 });
    expect(discs[0]?.value.minor).toBe(10_000);   // 2 missing × ₹50.00
  });

  it('proposes allocation by days of cover when stock is scarce', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // 100 available, 120 needed → scarce; share by rate of sale so each branch gets similar days.
    const out = (await allocate(h, A, 'u-owner', {
      productId: 'P1', fromLocationId: 'WH', availableMinor: 100,
      needs: [{ locationId: 'S1', shortfallMinor: 60, dailyDemandMinor: 5 }, { locationId: 'S2', shortfallMinor: 60, dailyDemandMinor: 50 }],
      tag: 'scarce',
    })).body as { proposals: { toLocationId: string; quantityMinor: number }[] };
    const s2 = out.proposals.find((p) => p.toLocationId === 'S2');
    const s1 = out.proposals.find((p) => p.toLocationId === 'S1');
    expect((s2?.quantityMinor ?? 0) + (s1?.quantityMinor ?? 0)).toBe(100);   // nothing stranded
    expect(s2!.quantityMinor).toBeGreaterThan(s1!.quantityMinor);            // the faster seller gets more
  });

  it('is authorized (move vs read), per-tenant, and refuses duplicate/unknown', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');   // proposes/dispatches/reads
    await h.provisionRole(A, 'u-cash', 'cashier');        // neither
    await propose(h, A, 'u-mgr', 't1', proposal());

    expect((await propose(h, A, 'u-cash', 't2', proposal())).status).toBe(403);
    expect((await dispatch(h, A, 'u-cash', 't1', {}, 'td-cash')).status).toBe(403);
    expect((await readTransfer(h, A, 'u-cash', 't1')).status).toBe(403);
    expect(codeOf(await propose(h, A, 'u-owner', 't1', proposal(), 'tr-t1-again'))).toBe('transfer_already_exists');
    expect((await readTransfer(h, A, 'u-owner', 'ghost')).status).toBe(404);

    await h.seedOwner(B, 'u-owner-b');
    expect((await readTransfer(h, B, 'u-owner-b', 't1')).status).toBe(404);
  });
});
