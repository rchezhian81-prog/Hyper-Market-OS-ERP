import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Warehouse-to-store & inter-store transfers (M09-FR-03, API-04) end to end through the real API. A
// transfer moves through an explicit IN-TRANSIT state held at the destination (the van is a place);
// dispatch needs a SEPARATE approver (§28); recalled/quarantined/expired/damaged stock is never sent
// (moving a problem to another branch launders it); a receipt shortfall is a VALUED exception, never a
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
const proposal = () => ({ fromLocationId: 'WH', toLocationId: 'S1', lines: [LINE] });
const onHand = (qty: number) => [{ productId: 'P1', batchId: null, quantityMinor: qty, state: 'on_hand' }];
interface Disc { productId: string; differenceMinor: number; value: { minor: number } }

describe('warehouse transfers: in-transit at destination, separate approver, valued shortfall, days-of-cover allocation (M09-FR-03)', () => {
  it('proposes, dispatches with a separate approver, and holds stock in transit', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await propose(h, A, 'u-owner', 't1', proposal())).status).toBe(201);

    // §28: the approver cannot be the requester.
    expect(codeOf(await dispatch(h, A, 'u-owner', 't1', { approvedBy: 'u-owner', available: onHand(20) }, 'td-t1-self'))).toBe('transfer_refused');

    const d = await dispatch(h, A, 'u-owner', 't1', { approvedBy: 'u-boss', available: onHand(20) });
    expect(d.status).toBe(200);
    expect((d.body as { state: string }).state).toBe('in_transit');
    expect((await readTransfer(h, A, 'u-owner', 't1')).status).toBe(200);
  });

  it('refuses sending recalled or quarantined stock and an over-draw', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await propose(h, A, 'u-owner', 't1', proposal());

    expect(codeOf(await dispatch(h, A, 'u-owner', 't1', { approvedBy: 'u-boss', available: [{ productId: 'P1', batchId: null, quantityMinor: 20, state: 'quarantine' }] }, 'td-q'))).toBe('transfer_refused');
    expect(codeOf(await dispatch(h, A, 'u-owner', 't1', { approvedBy: 'u-boss', available: [{ productId: 'P1', batchId: null, quantityMinor: 20, state: 'on_hand', recalled: true }] }, 'td-r'))).toBe('transfer_refused');
    expect(codeOf(await dispatch(h, A, 'u-owner', 't1', { approvedBy: 'u-boss', available: onHand(5) }, 'td-short'))).toBe('transfer_refused');
  });

  it('receives what arrived and raises a valued shortfall for what did not', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await propose(h, A, 'u-owner', 't1', proposal());
    await dispatch(h, A, 'u-owner', 't1', { approvedBy: 'u-boss', available: onHand(20) });

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
    expect((await dispatch(h, A, 'u-cash', 't1', { approvedBy: 'u-boss', available: onHand(20) }, 'td-cash')).status).toBe(403);
    expect((await readTransfer(h, A, 'u-cash', 't1')).status).toBe(403);
    expect(codeOf(await propose(h, A, 'u-owner', 't1', proposal(), 'tr-t1-again'))).toBe('transfer_already_exists');
    expect((await readTransfer(h, A, 'u-owner', 'ghost')).status).toBe(404);

    await h.seedOwner(B, 'u-owner-b');
    expect((await readTransfer(h, B, 'u-owner-b', 't1')).status).toBe(404);
  });
});
