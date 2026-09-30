import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Blind cycle-count reconciliation (M09-FR-04, API-04) end to end through the real API. The counter
// enters a BLIND physical count — the system-expected quantity is computed SERVER-SIDE (the
// authoritative M08 position plus any prior count corrections) and is NEVER an input. Since SP-4 (audit
// finding F07) neither are the VALUE (the cloud's own cost) or the THRESHOLD (the tenant's count policy)
// or an APPROVER: a count that matches reconciles with no adjustment; one that differs immaterially
// commits a reason-coded COMPENSATING adjustment (append-only, #2); a MATERIAL variance is HELD — recorded,
// valued, visible — until a SEPARATE person decides it, and the counter can never decide their own (§28).
// Idempotent on the count id; authorized; per-tenant isolated.
//
// SP-5b (audit finding F06): an applied correction is now ONE compensating M08 movement (`count:<countId>`, `adjusted` for
// stock found / `wasted` for stock missing) appended atomically with the count record — so ordinary availability and
// valuation read the corrected figure, the count view no longer layers it a second time, and a retry cannot post it twice.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Seed the authoritative M08 on-hand the blind count is reconciled against — a real received movement, at ₹1.00 a unit
// (the cloud's own value for any variance; the body carries none).
const seedOnHand = (h: ApiHarness, t: string, u: string, productId: string, locationId: string, qty: number, id?: string, unitCostMinor: number | null = 100) => {
  const movementId = id ?? `mv-${productId}-${locationId}`;
  return h.request({
    method: 'POST', path: '/v1/inventory/movements', userId: u, tenantId: t, idempotencyKey: movementId,
    body: { movementId, productId, locationId, kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: u, ...(unitCostMinor === null ? {} : { unitCostMinor }) },
  });
};

const count = (h: ApiHarness, t: string, u: string, countId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/inventory/counts/${countId}`, userId: u, tenantId: t, idempotencyKey: key ?? `ct-${countId}`, body });
const decide = (h: ApiHarness, t: string, u: string, countId: string, decision: string, key?: string, reason = 'recounted the shelf') =>
  h.request({ method: 'POST', path: `/v1/inventory/counts/${countId}/decide`, userId: u, tenantId: t, idempotencyKey: key ?? `cd-${countId}-${u}-${decision}`, body: { decision, reason } });
const policy = (h: ApiHarness, t: string, u: string, approvalThresholdMinor: number) =>
  h.request({ method: 'POST', path: '/v1/inventory/count-policy', userId: u, tenantId: t, idempotencyKey: `pol-${approvalThresholdMinor}`, body: { approvalThresholdMinor } });

const readCount = (h: ApiHarness, t: string, u: string, productId: string, locationId: string) =>
  h.request({ method: 'GET', path: '/v1/inventory/counts', userId: u, tenantId: t, query: { productId, locationId } });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface CountBody { expectedMinor: number; countedMinor: number; varianceMinor: number; valueMinor: number; reconciled: boolean; adjusted: boolean; requiredApproval: boolean; pendingApproval: boolean; flags: string[] }
interface PositionBody { systemOnHandMinor: number; countCorrectionMinor: number; postedCorrectionMinor: number; correctedOnHandMinor: number; pending: number; counts: { countId: string; adjusted: boolean; pendingApproval?: boolean; decision?: string; approvedBy: string | null; movementId?: string | null }[] }
const onHandAt = async (h: ApiHarness, t: string, productId: string, locationId: string): Promise<number> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: t, query: { productId } })).body as { rows: { locationId: string; onHandMinor: number }[] })
    .rows.filter((r) => r.locationId === locationId).reduce((s, r) => s + r.onHandMinor, 0);
const valueAt = async (h: ApiHarness, t: string, productId: string): Promise<number> =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/valuation', userId: 'u-owner', tenantId: t, query: { productId } })).body as { totalValueMinor: number }).totalValueMinor;
const ledger = async (h: ApiHarness, t: string) => (await h.store.readStream(t, 'inventory', { type: 'InventoryMoved' })).map((e) => e.event.payload as Record<string, unknown>);

// A count line: what the counter saw, and why they counted — NEVER the expected quantity, the value, the threshold or
// an approver, all of which are head office's (SP-4).
const line = (countedMinor: number, extra: Record<string, unknown> = {}) =>
  ({ productId: 'P1', locationId: 'S1', uom: 'EA', countedMinor, reasonCode: 'cycle_count', ...extra });

describe('cycle counts: blind reconciliation, cloud-valued variance, a material one held for a separate person, the correction posted to M08 (M09-FR-04)', () => {
  it('reconciles a blind count that matches the ledger with no adjustment', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'P1', 'S1', 100);

    const res = await count(h, A, 'u-owner', 'c1', line(100));
    expect(res.status).toBe(201);
    expect(res.body as CountBody).toMatchObject({ expectedMinor: 100, countedMinor: 100, varianceMinor: 0, reconciled: true, adjusted: false, requiredApproval: false, pendingApproval: false, flags: ['default_threshold'] });

    const pos = (await readCount(h, A, 'u-owner', 'P1', 'S1')).body as PositionBody;
    expect(pos).toMatchObject({ systemOnHandMinor: 100, countCorrectionMinor: 0, postedCorrectionMinor: 0, correctedOnHandMinor: 100, pending: 0 });
    expect(pos.counts).toHaveLength(1);
    expect(pos.counts[0]).toMatchObject({ countId: 'c1', movementId: null });
    expect((await ledger(h, A)).map((m) => m['movementId'])).toEqual(['mv-P1-S1']); // a match posts nothing
  });

  it('commits a valued compensating adjustment for an immaterial variance as ONE M08 movement every reader folds — valued at the cloud\'s cost (F06)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'P1', 'S1', 100);

    // Counted 98 vs expected 100 → variance -2 × ₹1.00 = ₹2.00 (200 minor), below the ₹1000 default threshold.
    const res = await count(h, A, 'u-owner', 'c2', line(98));
    expect(res.status).toBe(201);
    expect(res.body as CountBody).toMatchObject({ expectedMinor: 100, countedMinor: 98, varianceMinor: -2, valueMinor: 200, reconciled: false, adjusted: true, requiredApproval: false, pendingApproval: false, movementId: 'count:c2' });

    // SP-5b: the correction IS on M08 — availability and valuation read 98 / ₹98.00 — and the count view does not layer
    // it a second time (system 98, posted −2, layered 0, corrected 98).
    expect(await onHandAt(h, A, 'P1', 'S1')).toBe(98);
    expect(await valueAt(h, A, 'P1')).toBe(9_800);
    const pos = (await readCount(h, A, 'u-owner', 'P1', 'S1')).body as PositionBody;
    expect(pos).toMatchObject({ systemOnHandMinor: 98, countCorrectionMinor: 0, postedCorrectionMinor: -2, correctedOnHandMinor: 98 });
    // The movement names the count, the counter and the policy that let it post without a second person (M08-FR-01/03).
    expect((await ledger(h, A)).find((m) => m['movementId'] === 'count:c2')).toMatchObject({
      kind: 'wasted', quantityMinor: 2, productId: 'P1', locationId: 'S1', uom: 'EA', enteredBy: 'u-owner',
      reason: 'count c2 (cycle_count): counted 98, expected 100; immaterial under the tenant\'s count-approval threshold — no second approver required',
    });
    // The next count is measured against the corrected ledger, so a second 98 matches and posts nothing more.
    expect((await count(h, A, 'u-owner', 'c2b', line(98))).body as CountBody).toMatchObject({ expectedMinor: 98, varianceMinor: 0, adjusted: false, movementId: null });
    expect((await ledger(h, A)).filter((m) => String(m['movementId']).startsWith('count:'))).toHaveLength(1);
  });

  it('HOLDS a material variance — recorded, valued, not applied — until a separate person decides it; the counter cannot (§28); one decision per count', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-boss', 'store_manager'); // may decide a held count
    await seedOnHand(h, A, 'u-owner', 'P1', 'S1', 100);
    // The tenant's policy makes ₹10.00 material: counted 50 vs 100 → −50 × ₹1.00 = ₹50.00.
    expect((await policy(h, A, 'u-owner', 1_000)).status).toBe(201);

    const held = await count(h, A, 'u-owner', 'c3', line(50));
    expect(held.status).toBe(201);
    expect(held.body as CountBody).toMatchObject({ varianceMinor: -50, valueMinor: 5_000, adjusted: false, requiredApproval: true, pendingApproval: true, movementId: null, flags: [] });
    expect((await readCount(h, A, 'u-owner', 'P1', 'S1')).body as PositionBody).toMatchObject({ correctedOnHandMinor: 100, pending: 1 });
    expect(await onHandAt(h, A, 'P1', 'S1')).toBe(100); // held: nothing has moved

    // The counter cannot decide their own variance.
    const self = await decide(h, A, 'u-owner', 'c3', 'approved');
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('self_approval');
    expect(await onHandAt(h, A, 'P1', 'S1')).toBe(100);
    // A separate person approves: the correction posts to the ledger now — and only now (F06).
    const ok = await decide(h, A, 'u-boss', 'c3', 'approved');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ decision: 'approved', adjusted: true, approvedBy: 'u-boss', movementId: 'count:c3', alreadyDecided: false });
    const pos = (await readCount(h, A, 'u-owner', 'P1', 'S1')).body as PositionBody;
    expect(pos).toMatchObject({ systemOnHandMinor: 50, countCorrectionMinor: 0, postedCorrectionMinor: -50, correctedOnHandMinor: 50, pending: 0 });
    expect(pos.counts[0]).toMatchObject({ countId: 'c3', adjusted: true, pendingApproval: false, decision: 'approved', approvedBy: 'u-boss', movementId: 'count:c3' });
    expect(await onHandAt(h, A, 'P1', 'S1')).toBe(50);
    expect(await valueAt(h, A, 'P1')).toBe(5_000);
    expect((await ledger(h, A)).find((m) => m['movementId'] === 'count:c3')).toMatchObject({ kind: 'wasted', quantityMinor: 50, enteredBy: 'u-owner', approvedBy: 'u-boss', reason: expect.stringContaining('approved by u-boss') });
    // The same decision again is a no-op; a contradicting one is refused; a count that was never held cannot be decided.
    expect((await decide(h, A, 'u-boss', 'c3', 'approved', 'cd-c3-again')).body).toMatchObject({ alreadyDecided: true });
    expect(codeOf(await decide(h, A, 'u-boss', 'c3', 'rejected'))).toBe('count_already_decided');
    expect(await onHandAt(h, A, 'P1', 'S1')).toBe(50); // posted once, whatever is retried
    await count(h, A, 'u-owner', 'c3b', line(50)); // matches the corrected 50 → nothing to decide
    expect(codeOf(await decide(h, A, 'u-boss', 'c3b', 'approved'))).toBe('count_not_pending');
    expect(codeOf(await decide(h, A, 'u-boss', 'c-ghost', 'approved'))).toBe('count_unknown');

    // A REJECTED variance stands recorded and applies nothing.
    const held2 = await count(h, A, 'u-owner', 'c4', line(0));
    expect(held2.body as CountBody).toMatchObject({ varianceMinor: -50, pendingApproval: true });
    expect((await decide(h, A, 'u-boss', 'c4', 'rejected', undefined, 'shelf was restocked mid-count')).body).toMatchObject({ decision: 'rejected', adjusted: false, movementId: null });
    expect((await readCount(h, A, 'u-owner', 'P1', 'S1')).body as PositionBody).toMatchObject({ correctedOnHandMinor: 50, pending: 0 });
    expect(await onHandAt(h, A, 'P1', 'S1')).toBe(50);
    expect((await ledger(h, A)).filter((m) => String(m['movementId']).startsWith('count:'))).toHaveLength(1);
  });

  it('refuses a body that still carries a value, a threshold or an approver — by name, moving nothing (F07)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'P1', 'S1', 100);
    for (const [key, extra] of [['value', { valuePerUnitMinor: 0 }], ['threshold', { thresholdMinor: 1 }], ['approver', { approvedBy: 'u-boss' }]] as const) {
      const res = await count(h, A, 'u-owner', `c5-${key}`, line(0, extra));
      expect(res.status).toBe(400);
      expect(codeOf(res)).toBe('count_carries_caller_claims');
    }
    expect((await readCount(h, A, 'u-owner', 'P1', 'S1')).body as PositionBody).toMatchObject({ correctedOnHandMinor: 100, counts: [] });
    // An uncosted product's variance cannot be valued → held whatever its size, said as a flag.
    await seedOnHand(h, A, 'u-owner', 'P9', 'S1', 10, 'mv-p9', null); // received with no cost anywhere
    const off = await count(h, A, 'u-owner', 'c6', line(9, { productId: 'P9' }));
    expect(off.body as CountBody).toMatchObject({ varianceMinor: -1, valueMinor: 0, adjusted: false, pendingApproval: true });
    expect((off.body as CountBody).flags).toEqual(expect.arrayContaining(['value_unknown', 'default_threshold']));
  });

  it('is idempotent on the count id — a re-count is a new count', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'P1', 'S1', 100);

    expect((await count(h, A, 'u-owner', 'c4', line(100))).status).toBe(201);
    // Same count id, different transport key so it reaches the handler → refused as already reconciled.
    const again = await count(h, A, 'u-owner', 'c4', line(100), 'ct-c4-again');
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('count_already_reconciled');
  });

  it('is authorized (cashier may neither count, decide nor read), per-tenant isolated, and validates input', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');   // may count, decide and read
    await h.provisionRole(A, 'u-cash', 'cashier');        // may do none of it
    await seedOnHand(h, A, 'u-mgr', 'P1', 'S1', 100);

    expect((await count(h, A, 'u-mgr', 'c5', line(100))).status).toBe(201);
    expect((await count(h, A, 'u-cash', 'c6', line(100))).status).toBe(403);
    expect((await decide(h, A, 'u-cash', 'c5', 'approved')).status).toBe(403);
    expect((await readCount(h, A, 'u-cash', 'P1', 'S1')).status).toBe(403);

    // Malformed: the expected quantity is computed server-side and can never be supplied; a count with
    // no counted quantity is not readable; a decision needs a verdict and a reason.
    expect(codeOf(await count(h, A, 'u-owner', 'c7', { productId: 'P1', locationId: 'S1', uom: 'EA', reasonCode: 'cycle_count' }, 'ct-c7-bad'))).toBe('not_readable_as_a_count');
    expect((await h.request({ method: 'POST', path: '/v1/inventory/counts/c5/decide', userId: 'u-mgr', tenantId: A, idempotencyKey: 'cd-bad', body: { decision: 'maybe', reason: 'x' } })).status).toBe(400);

    // Per-tenant: tenant B sees none of tenant A's counts or stock.
    await h.seedOwner(B, 'u-owner-b');
    const posB = (await readCount(h, B, 'u-owner-b', 'P1', 'S1')).body as PositionBody;
    expect(posB).toMatchObject({ systemOnHandMinor: 0, countCorrectionMinor: 0, correctedOnHandMinor: 0 });
    expect(posB.counts).toHaveLength(0);
  });
});
