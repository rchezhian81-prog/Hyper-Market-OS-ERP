import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Blind cycle-count reconciliation (M09-FR-04, API-04) end to end through the real API. The counter
// enters a BLIND physical count — the system-expected quantity is computed SERVER-SIDE (the
// authoritative M08 position plus any prior count corrections) and is NEVER an input. A count that
// matches reconciles with no adjustment; one that differs commits a reason-coded COMPENSATING
// adjustment (append-only, #2), and a MATERIAL variance needs a SEPARATE approver — the counter can
// never approve their own variance (§28). Idempotent on the count id; authorized; per-tenant isolated.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Seed the authoritative M08 on-hand the blind count is reconciled against — a real received movement.
const seedOnHand = (h: ApiHarness, t: string, u: string, productId: string, locationId: string, qty: number, id?: string) => {
  const movementId = id ?? `mv-${productId}-${locationId}`;
  return h.request({
    method: 'POST', path: '/v1/inventory/movements', userId: u, tenantId: t, idempotencyKey: movementId,
    body: { movementId, productId, locationId, kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: u },
  });
};

const count = (h: ApiHarness, t: string, u: string, countId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/inventory/counts/${countId}`, userId: u, tenantId: t, idempotencyKey: key ?? `ct-${countId}`, body });

const readCount = (h: ApiHarness, t: string, u: string, productId: string, locationId: string) =>
  h.request({ method: 'GET', path: '/v1/inventory/counts', userId: u, tenantId: t, query: { productId, locationId } });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface CountBody { expectedMinor: number; countedMinor: number; varianceMinor: number; valueMinor: number; reconciled: boolean; adjusted: boolean; requiredApproval: boolean }
interface PositionBody { systemOnHandMinor: number; countCorrectionMinor: number; correctedOnHandMinor: number; counts: unknown[] }

// A count line. The counter supplies the counted quantity, the reason, the per-unit value and the
// tenant's materiality threshold — NEVER the expected quantity, which the server computes.
const line = (countedMinor: number, valuePerUnitMinor: number, thresholdMinor: number, extra: Record<string, unknown> = {}) =>
  ({ productId: 'P1', locationId: 'S1', uom: 'EA', countedMinor, reasonCode: 'cycle_count', valuePerUnitMinor, thresholdMinor, ...extra });

describe('cycle counts: blind reconciliation, valued variance, separate-approver on material, layered on M08 (M09-FR-04)', () => {
  it('reconciles a blind count that matches the ledger with no adjustment', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'P1', 'S1', 100);

    const res = await count(h, A, 'u-owner', 'c1', line(100, 100, 100_000));
    expect(res.status).toBe(201);
    const b = res.body as CountBody;
    expect(b).toMatchObject({ expectedMinor: 100, countedMinor: 100, varianceMinor: 0, reconciled: true, adjusted: false, requiredApproval: false });

    const pos = (await readCount(h, A, 'u-owner', 'P1', 'S1')).body as PositionBody;
    expect(pos).toMatchObject({ systemOnHandMinor: 100, countCorrectionMinor: 0, correctedOnHandMinor: 100 });
    expect(pos.counts).toHaveLength(1);
  });

  it('commits a valued compensating adjustment for an immaterial variance and layers it on M08', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'P1', 'S1', 100);

    // Counted 98 vs expected 100 → variance -2 × ₹1.00 = ₹2.00 (200 minor), below the ₹1000 threshold.
    const res = await count(h, A, 'u-owner', 'c2', line(98, 100, 100_000));
    expect(res.status).toBe(201);
    const b = res.body as CountBody;
    expect(b).toMatchObject({ expectedMinor: 100, countedMinor: 98, varianceMinor: -2, valueMinor: 200, reconciled: false, adjusted: true, requiredApproval: false });

    // M08 is untouched; the count correction is layered on top of it (corrected on-hand = 98).
    const pos = (await readCount(h, A, 'u-owner', 'P1', 'S1')).body as PositionBody;
    expect(pos).toMatchObject({ systemOnHandMinor: 100, countCorrectionMinor: -2, correctedOnHandMinor: 98 });
  });

  it('refuses a material variance without a separate approver, and refuses the counter approving their own (§28)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'P1', 'S1', 100);

    // Counted 50 vs 100 → variance -50 × ₹10.00 = ₹500.00 (50 000 minor), at/above the ₹100 threshold.
    const material = () => line(50, 1_000, 10_000);

    // No approver → refused.
    const noAppr = await count(h, A, 'u-owner', 'c3', material(), 'ct-c3-noappr');
    expect(noAppr.status).toBe(422);
    expect(codeOf(noAppr)).toBe('count_needs_approval');

    // The counter cannot approve their own variance (§28) — u-owner is the counter here.
    const selfAppr = await count(h, A, 'u-owner', 'c3', { ...material(), approvedBy: 'u-owner' }, 'ct-c3-self');
    expect(selfAppr.status).toBe(422);
    expect(codeOf(selfAppr)).toBe('count_needs_approval');

    // A separate approver clears it.
    const ok = await count(h, A, 'u-owner', 'c3', { ...material(), approvedBy: 'u-boss' }, 'ct-c3-ok');
    expect(ok.status).toBe(201);
    expect(ok.body as CountBody).toMatchObject({ varianceMinor: -50, valueMinor: 50_000, adjusted: true, requiredApproval: true });
  });

  it('is idempotent on the count id — a re-count is a new count', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'P1', 'S1', 100);

    expect((await count(h, A, 'u-owner', 'c4', line(100, 100, 100_000))).status).toBe(201);
    // Same count id, different transport key so it reaches the handler → refused as already reconciled.
    const again = await count(h, A, 'u-owner', 'c4', line(100, 100, 100_000), 'ct-c4-again');
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('count_already_reconciled');
  });

  it('is authorized (cashier may neither count nor read), per-tenant isolated, and validates input', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');   // may count and read
    await h.provisionRole(A, 'u-cash', 'cashier');        // may do neither
    await seedOnHand(h, A, 'u-mgr', 'P1', 'S1', 100);

    expect((await count(h, A, 'u-mgr', 'c5', line(100, 100, 100_000))).status).toBe(201);
    expect((await count(h, A, 'u-cash', 'c6', line(100, 100, 100_000))).status).toBe(403);
    expect((await readCount(h, A, 'u-cash', 'P1', 'S1')).status).toBe(403);

    // Malformed: the expected quantity is computed server-side and can never be supplied; a count with
    // no counted quantity is not readable.
    expect(codeOf(await count(h, A, 'u-owner', 'c7', { productId: 'P1', locationId: 'S1', uom: 'EA', reasonCode: 'cycle_count', valuePerUnitMinor: 100, thresholdMinor: 100_000 }, 'ct-c7-bad'))).toBe('not_readable_as_a_count');

    // Per-tenant: tenant B sees none of tenant A's counts or stock.
    await h.seedOwner(B, 'u-owner-b');
    const posB = (await readCount(h, B, 'u-owner-b', 'P1', 'S1')).body as PositionBody;
    expect(posB).toMatchObject({ systemOnHandMinor: 0, countCorrectionMinor: 0, correctedOnHandMinor: 0 });
    expect(posB.counts).toHaveLength(0);
  });
});
