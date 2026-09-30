import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { COUNT_FLAGS, DEFAULT_COUNT_APPROVAL_THRESHOLD_MINOR } from '../../services/inventory/src/counts-synced';

/**
 * **A blind count relayed from the store is reconciled at head office — expected, value and threshold all the cloud's,
 * a material variance recorded and HELD, never applied without a second person (SP-2b · F11 · F07 · M09-FR-04 · §28 ·
 * hard rules #2/#10, API-04).**
 *
 * The store box relays what the counter SAW under its sync credential (`inventory.count.sync`). This drives the real
 * surface: the expected quantity is computed from the authoritative ledger plus prior corrections and never sent; the
 * unit value is the cloud's weighted-average cost; the threshold is the tenant's count policy (or the default, flagged);
 * an immaterial variance corrects at once through the same tested engine as the direct route; a material one — or an
 * UNVALUED one — is recorded as awaiting approval with the correction NOT applied; the counter's authority is re-verified
 * and flagged; the same count again is 200; the wrong credential or tenant is refused. Synthetic data (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-09-30T10:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface CountBody {
  countId: string; recorded: boolean; alreadyRecorded?: boolean; expectedMinor: number; countedMinor: number; varianceMinor: number;
  valueMinor: number; adjusted: boolean; pendingApproval: boolean; flags: string[];
}
interface PositionBody {
  systemOnHandMinor: number; countCorrectionMinor: number; correctedOnHandMinor: number;
  counts: { countId: string; adjusted: boolean; requiredApproval: boolean; pendingApproval?: boolean; counterId: string; relayedBy?: string; governanceFlags?: string[] }[];
}

const blind = (countId: string, countedMinor: number, over: Record<string, unknown> = {}) => ({
  countId, productId: 'P1', locationId: 'S1', uom: 'EA', countedMinor, reasonCode: 'cycle_count', counterId: 'u-mgr', at: AT,
  storeId: 'store-1', source: 'manager-screen', ...over,
});

const relay = (h: ApiHarness, body: Record<string, unknown>, key: string, opts: { user?: string; tenant?: string; id?: string } = {}) =>
  h.request({
    method: 'POST', path: `/v1/inventory/counts/${opts.id ?? String(body['countId'])}/synced`,
    userId: opts.user ?? 'u-box', tenantId: opts.tenant ?? A, idempotencyKey: key, body,
  });
const position = async (h: ApiHarness, productId = 'P1', locationId = 'S1'): Promise<PositionBody> =>
  (await h.request({ method: 'GET', path: '/v1/inventory/counts', userId: 'u-owner', tenantId: A, query: { productId, locationId } })).body as PositionBody;

/** The cast, and 100 of P1 at S1 received at ₹25.00 a unit — the cloud's own expected quantity and unit value. */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds inventory.movement.append — may count
  await h.provisionRole(A, 'u-box', 'cashier');       // the store box's sync identity: inventory.count.sync
  await h.provisionRole(A, 'u-cust', 'customer');     // no inventory authority
  const seed = await h.request({
    method: 'POST', path: '/v1/inventory/goods-receipt/grn-seed', userId: 'u-mgr', tenantId: A, idempotencyKey: 'k-seed',
    body: {
      warehouseId: 'S1', receivedOnDate: '2026-09-01', currency: 'INR',
      lines: [{ lineId: 'L1', productId: 'P1', orderedMinor: 100, countedMinor: 100, uom: 'EA', unitCost: { minor: 2500, currency: 'INR' }, condition: 'good' }],
    },
  });
  expect(seed.status).toBe(201);
  return h;
}

describe('a blind count relayed from the store is reconciled at head office, on head office\'s own figures', () => {
  it('a count that matches reconciles with no adjustment — expected computed here, never sent — and only the missing policy is flagged', async () => {
    const h = await seeded();
    const res = await relay(h, blind('c1', 100), 'k-c1');
    expect(res.status).toBe(202);
    expect(res.body as CountBody).toMatchObject({ countId: 'c1', recorded: true, expectedMinor: 100, countedMinor: 100, varianceMinor: 0, valueMinor: 0, adjusted: false, pendingApproval: false, flags: ['default_threshold'] });
    const pos = await position(h);
    expect(pos).toMatchObject({ systemOnHandMinor: 100, countCorrectionMinor: 0, correctedOnHandMinor: 100 });
    expect(pos.counts).toHaveLength(1);
    expect(pos.counts[0]).toMatchObject({ countId: 'c1', counterId: 'u-mgr', relayedBy: 'u-box', adjusted: false, requiredApproval: false, pendingApproval: false, governanceFlags: ['default_threshold'] });
  });

  it('an IMMATERIAL variance corrects at once, valued at the cloud\'s cost — the correction layers on the position', async () => {
    const h = await seeded();
    // Counted 98 of 100 → −2 × ₹25.00 = ₹50.00 (5 000 minor), under the ₹1 000 default threshold.
    const res = await relay(h, blind('c2', 98), 'k-c2');
    expect(res.status).toBe(202);
    expect(res.body as CountBody).toMatchObject({ expectedMinor: 100, varianceMinor: -2, valueMinor: 5_000, adjusted: true, pendingApproval: false });
    expect(await position(h)).toMatchObject({ systemOnHandMinor: 100, countCorrectionMinor: -2, correctedOnHandMinor: 98 });
    // The next count is measured against the CORRECTED position (100 − 2), not the raw ledger.
    const next = await relay(h, blind('c3', 98), 'k-c3');
    expect(res.status).toBe(202);
    expect(next.body as CountBody).toMatchObject({ expectedMinor: 98, varianceMinor: 0, adjusted: false });
  });

  it('a MATERIAL variance is recorded, valued and HELD for a second person — the correction is not applied (§28, #10)', async () => {
    const h = await seeded();
    // Counted 50 of 100 → −50 × ₹25.00 = ₹1 250.00 (125 000 minor) ≥ the ₹1 000 default.
    const res = await relay(h, blind('c4', 50), 'k-c4');
    expect(res.status).toBe(202);
    expect(res.body as CountBody).toMatchObject({ expectedMinor: 100, varianceMinor: -50, valueMinor: 125_000, adjusted: false, pendingApproval: true, flags: ['default_threshold'] });
    const pos = await position(h);
    // Visible on the register, with nothing applied: the shelf figure head office holds is still 100.
    expect(pos).toMatchObject({ systemOnHandMinor: 100, countCorrectionMinor: 0, correctedOnHandMinor: 100 });
    expect(pos.counts[0]).toMatchObject({ countId: 'c4', adjusted: false, requiredApproval: true, pendingApproval: true });
    expect(DEFAULT_COUNT_APPROVAL_THRESHOLD_MINOR).toBe(100_000);
  });

  it('the tenant\'s count policy — set by the owner, read back — decides what is material; the default flag then goes', async () => {
    const h = await seeded();
    const set = await h.request({ method: 'POST', path: '/v1/inventory/count-policy', userId: 'u-owner', tenantId: A, idempotencyKey: 'k-pol-1', body: { approvalThresholdMinor: 1_000_000 } });
    expect(set.status).toBe(201);
    expect((set.body as { policy: { approvalThresholdMinor: number; setBy: string } }).policy).toMatchObject({ approvalThresholdMinor: 1_000_000, setBy: 'u-owner' });
    const read = await h.request({ method: 'GET', path: '/v1/inventory/count-policy', userId: 'u-owner', tenantId: A });
    expect(read.status).toBe(200);
    expect((read.body as { policy: { approvalThresholdMinor: number } }).policy.approvalThresholdMinor).toBe(1_000_000);

    // The same −50 count is now under the ₹10 000 threshold: corrected at once, nothing flagged.
    const res = await relay(h, blind('c5', 50), 'k-c5');
    expect(res.body as CountBody).toMatchObject({ varianceMinor: -50, valueMinor: 125_000, adjusted: true, pendingApproval: false, flags: [] });
    expect(await position(h)).toMatchObject({ correctedOnHandMinor: 50 });

    // A policy needs a whole threshold, and only somebody with the policy permission may set it.
    expect((await h.request({ method: 'POST', path: '/v1/inventory/count-policy', userId: 'u-owner', tenantId: A, idempotencyKey: 'k-pol-2', body: { approvalThresholdMinor: 'lots' } })).status).toBe(400);
    expect((await h.request({ method: 'POST', path: '/v1/inventory/count-policy', userId: 'u-mgr', tenantId: A, idempotencyKey: 'k-pol-3', body: { approvalThresholdMinor: 1 } })).status).toBe(403);
  });

  it('a variance head office CANNOT value waits for a person whatever its size — never priced at nothing and slipped under the threshold (F07)', async () => {
    const h = await seeded();
    // P9 was received with no cost anywhere: the valuation says not_known, so the route says value_unknown.
    const mv = await h.request({
      method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: 'mv-p9',
      body: { movementId: 'mv-p9', productId: 'P9', locationId: 'S1', kind: 'received', quantityMinor: 10, uom: 'EA', occurredAt: AT, enteredBy: 'u-owner' },
    });
    expect(mv.status).toBeLessThan(300);
    const off = await relay(h, blind('c6', 9, { productId: 'P9' }), 'k-c6');
    expect(off.status).toBe(202);
    expect(off.body as CountBody).toMatchObject({ expectedMinor: 10, varianceMinor: -1, valueMinor: 0, adjusted: false, pendingApproval: true });
    expect((off.body as CountBody).flags).toEqual(expect.arrayContaining(['value_unknown', 'default_threshold']));
    // …while an unvalued count that MATCHES is simply reconciled: there is nothing to judge.
    const match = await relay(h, blind('c7', 10, { productId: 'P9' }), 'k-c7');
    expect(match.body as CountBody).toMatchObject({ varianceMinor: 0, adjusted: false, pendingApproval: false });
    expect((match.body as CountBody).flags).toContain('value_unknown');
  });

  it('re-verifies the COUNTER from their grants — an unauthorised or unknown counter is recorded and flagged, never silently trusted', async () => {
    const h = await seeded();
    const lacks = await relay(h, blind('c8', 100, { counterId: 'u-cust' }), 'k-c8');
    expect(lacks.status).toBe(202);
    expect((lacks.body as CountBody).flags).toContain('counter_lacks_authority');
    const unknown = await relay(h, blind('c9', 100, { counterId: 'u-nobody' }), 'k-c9');
    expect((unknown.body as CountBody).flags).toContain('counter_unknown');
    for (const f of [lacks, unknown].flatMap((r) => (r.body as CountBody).flags)) expect(COUNT_FLAGS).toContain(f);
    expect((await position(h)).counts.map((c) => c.counterId).sort()).toEqual(['u-cust', 'u-nobody']);
  });

  it('the same count again — same key or re-keyed — is 200 alreadyRecorded with one record; a re-count is a NEW count id', async () => {
    const h = await seeded();
    expect((await relay(h, blind('c10', 98), 'k-c10')).status).toBe(202);
    const replay = await relay(h, blind('c10', 98), 'k-c10');
    expect(replay.status).toBeGreaterThanOrEqual(200);
    expect(replay.status).toBeLessThan(300);
    const rekeyed = await relay(h, blind('c10', 98), 'k-c10-again');
    expect(rekeyed.status).toBe(200);
    expect(rekeyed.body as CountBody).toMatchObject({ countId: 'c10', recorded: true, alreadyRecorded: true, adjusted: true, pendingApproval: false });
    expect(await position(h)).toMatchObject({ countCorrectionMinor: -2, correctedOnHandMinor: 98 }); // applied once
    expect((await position(h)).counts).toHaveLength(1);
  });

  it('refuses a payload it cannot read, a countId that does not match the path, a caller without the sync permission, and another tenant', async () => {
    const h = await seeded();
    const malformed = await relay(h, { countId: 'c11', productId: 'P1' }, 'k-c11');
    expect(malformed.status).toBe(400);
    expect(codeOf(malformed)).toBe('not_readable_as_a_relayed_count');
    // An expected figure in the body is not part of the contract and changes nothing — the cloud computes its own.
    const smuggled = await relay(h, blind('c12', 100, { expectedMinor: 5 }), 'k-c12');
    expect(smuggled.status).toBe(202);
    expect((smuggled.body as CountBody).expectedMinor).toBe(100);
    expect((await relay(h, blind('c13', 100), 'k-c13', { id: 'c14' })).status).toBe(400);
    expect((await relay(h, blind('c15', 100), 'k-c15', { user: 'u-cust' })).status).toBe(403);
    expect((await relay(h, blind('c16', 100), 'k-c16', { tenant: B })).status).toBe(403);
    expect((await position(h)).counts.map((c) => c.countId)).toEqual(['c12']);
  });
});
