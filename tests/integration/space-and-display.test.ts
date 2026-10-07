import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sentWithApproval } from '../support/approval-request';

// Space productivity + supplier display-contract governance, end to end (M04-FR-04 · D02-FR-06 · M23, API-04).
// Two questions a big shop usually answers by feel: is this space earning its keep (margin per square foot,
// not turnover), and is the supplier actually paying for the end-cap they are standing on. Gated
// merchandising.space.read (read/review) / merchandising.display.manage (record a contract).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const inr = (minor: number) => ({ minor, currency: 'INR' });

const spacePerf = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'sp') =>
  h.request({ method: 'POST', path: '/v1/merchandising/space/performance', userId: u, tenantId: A, idempotencyKey: key, body });
const recordContract = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/merchandising/display-contracts/${id}`, userId: u, tenantId: A, idempotencyKey: key ?? `dc-${id}`, body });
const review = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'rev') =>
  h.request({ method: 'POST', path: '/v1/merchandising/display-contracts/review', userId: u, tenantId: A, idempotencyKey: key, body });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const contract = (over: Record<string, unknown> = {}) =>
  ({ storeId: 's1', supplierId: 'sup1', description: 'end-cap by the door', fundingAmount: inr(50000), startsOn: '2026-01-01', endsOn: '2026-12-31', locationIds: ['end1'], ...over });
/** A display contract as two people make it (ADR-0024 · D02-FR-06 "Finance approves funding terms"): the merchandiser
 *  records it and asks; `checker` — someone who may approve suppliers (the owner, the accountant) — approves it. */
const approvedContract = (h: ApiHarness, u: string, checker: string, id: string, body: Record<string, unknown>, key = `dc-${id}`) =>
  sentWithApproval(h, A, u, checker, { kind: 'display_contract', subjectRef: id, pathIds: { contractId: id }, valueMinor: (body['fundingAmount'] as { minor: number }).minor },
    body, (b) => recordContract(h, u, id, b, key));

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // space.read + display.manage
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('space productivity + display-contract governance (M04-FR-04)', () => {
  it('ranks areas by margin per square foot and flags the ones taking more space than they earn', async () => {
    const h = await seeded();
    const res = await spacePerf(h, 'u-mgr', {
      currency: 'INR',
      areas: [
        { areaId: 'a1', storeId: 's1', name: 'Grocery', squareFeet: 1000 },
        { areaId: 'a2', storeId: 's1', name: 'Deli', squareFeet: 100 },
        { areaId: 'a3', storeId: 's1', name: 'Seasonal', squareFeet: 500 },
        { areaId: 'a4', storeId: 's1', name: 'Storeroom', squareFeet: 0 },
      ],
      sales: { a1: inr(200000), a2: inr(50000), a3: inr(10000) },
      grossMargin: { a1: inr(20000), a2: inr(30000), a3: inr(1000) },
    });
    expect(res.status).toBe(200);
    const body = res.body as { rows: { areaId: string; marginPerSqFt: { kind: string; minorPerSqFt?: number }; underperforming: boolean }[]; underperforming: number };
    // Deli earns 300/sq ft, Grocery 20, Seasonal 2 — ranked by MARGIN per sq ft, not turnover.
    expect(body.rows[0]?.areaId).toBe('a2');
    expect(body.rows[0]?.marginPerSqFt).toEqual({ kind: 'per_sq_ft', minorPerSqFt: 300 });
    // Grocery and Seasonal take materially more space than the margin they earn.
    expect(body.underperforming).toBe(2);
    expect(body.rows.find((r) => r.areaId === 'a1')?.underperforming).toBe(true);
    // A ratio that cannot be computed says so rather than a fabricated zero.
    expect(body.rows.find((r) => r.areaId === 'a4')?.marginPerSqFt.kind).toBe('not_meaningful');
  });

  it('records display contracts and reviews them — the expired end-cap still on the floor is the finding', async () => {
    const h = await seeded();
    await approvedContract(h, 'u-mgr', 'u-owner', 'c-active', contract({ fundingAmount: inr(50000) }));
    await approvedContract(h, 'u-mgr', 'u-owner', 'c-expired', contract({ endsOn: '2026-06-30', fundingAmount: inr(10000), locationIds: ['end2'] }));
    await recordContract(h, 'u-mgr', 'c-unapproved', contract({ locationIds: ['end3'] }));
    await approvedContract(h, 'u-mgr', 'u-owner', 'c-owing', contract({ fundingAmount: inr(20000), locationIds: ['end4'] }));

    const res = await review(h, 'u-mgr', {
      onDate: '2026-08-24', currency: 'INR',
      received: { 'c-active': inr(50000), 'c-owing': inr(5000) }, // c-owing underpaid; others as needed
      stillOccupying: ['c-expired'],
      warnDays: 30,
    });
    expect(res.status).toBe(200);
    const body = res.body as { statuses: { contractId: string; finding: string; detail: string }[]; flagged: number };
    const by = new Map(body.statuses.map((s) => [s.contractId, s]));
    expect(by.get('c-active')?.finding).toBe('active');
    expect(by.get('c-expired')?.finding).toBe('expired_still_occupying');
    expect(by.get('c-expired')?.detail).toContain('STILL on the floor');
    expect(by.get('c-unapproved')?.finding).toBe('unapproved');
    expect(by.get('c-owing')?.finding).toBe('funding_not_received');
    expect(body.flagged).toBe(3); // everything except the active one
  });

  it('is gated and rejects unreadable requests', async () => {
    const h = await seeded();
    expect((await spacePerf(h, 'u-cash', { currency: 'INR', areas: [{ areaId: 'a1', storeId: 's1', name: 'x', squareFeet: 1 }], sales: {}, grossMargin: {} }, 'sp-cash')).status).toBe(403);
    expect((await recordContract(h, 'u-cash', 'c1', contract(), 'dc-cash')).status).toBe(403);
    expect((await review(h, 'u-cash', { onDate: '2026-08-24', currency: 'INR' }, 'rev-cash')).status).toBe(403);
    expect(codeOf(await spacePerf(h, 'u-mgr', { currency: 'INR', areas: [], sales: {}, grossMargin: {} }, 'sp-bad'))).toBe('not_readable_as_a_space_request');
    expect(codeOf(await recordContract(h, 'u-mgr', 'c-bad', contract({ fundingAmount: undefined }), 'dc-bad'))).toBe('not_readable_as_a_display_contract');
  });

  it('the funding approver approves in their own session: a typed name, the recorder, or someone who may not approve suppliers is refused (2b-vi-c-1, PA-03)', async () => {
    const h = await seeded();
    // THE BYPASS, CLOSED: any typed name ("fin-lead") used to clear the `unapproved` finding.
    expect(codeOf(await recordContract(h, 'u-mgr', 'c-typed', contract({ approvedBy: 'fin-lead' }), 'dc-typed'))).toBe('approver_named_without_approval');
    expect(codeOf(await approvedContract(h, 'u-owner', 'u-owner', 'c-self', contract()))).toBe('self_approval');
    // A store manager handles display space but does not approve a supplier's funding terms.
    expect((await approvedContract(h, 'u-owner', 'u-mgr', 'c-mgr', contract())).status).toBe(403);
    const reviewed = (await review(h, 'u-owner', { onDate: '2026-08-24', currency: 'INR' }, 'rev-none')).body as { statuses: unknown[] };
    expect(reviewed.statuses).toEqual([]); // none of them was recorded
    // The approval is for exactly this funding: a different amount is a different contract.
    const ok = await approvedContract(h, 'u-mgr', 'u-owner', 'c-ok', contract());
    expect(ok.body).toMatchObject({ approved: true });
  });

  it('supersedes a corrected contract and survives a restart', async () => {
    const h = await seeded();
    await recordContract(h, 'u-mgr', 'c1', contract(), 'c1-v1'); // unapproved
    const before = (await review(h, 'u-mgr', { onDate: '2026-08-24', currency: 'INR', received: { c1: inr(50000) } }, 'rev-v1')).body as { statuses: { contractId: string; finding: string }[] };
    expect(before.statuses.find((s) => s.contractId === 'c1')?.finding).toBe('unapproved');

    // Finance approves the funding in their own session, and the contract is recorded again with that approval — a
    // DIFFERENT idempotency key, so it supersedes rather than dedups.
    expect((await approvedContract(h, 'u-mgr', 'u-owner', 'c1', contract(), 'c1-v2')).status).toBe(201);
    const restarted = apiHarness({ store: h.store });
    const after = (await review(restarted, 'u-owner', { onDate: '2026-08-24', currency: 'INR', received: { c1: inr(50000) } }, 'rev-v2')).body as { statuses: { contractId: string; finding: string }[] };
    expect(after.statuses.find((s) => s.contractId === 'c1')?.finding).toBe('active');
  });
});
