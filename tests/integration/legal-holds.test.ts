import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Legal holds + retention plan + evidence pack, end to end (M34-FR-02, API-09). Two duties pull opposite
// ways: privacy says don't keep personal data for ever; evidence says never destroy what a court may need
// (hard rule #6). The resolution is that NOTHING here deletes — a legal hold FREEZES records regardless of
// age, the plan says what is deletable vs frozen, and a lift is a new state (the hold itself never erased).
// The key acceptance: a record PAST its retention date that a hold covers comes back `legal_hold`, not
// eligible. Writes gated audit.hold.manage; the plan/list/pack read audit.retention.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// An audit record for an invoice issued in 2020 — long past any short retention period.
const oldInvoice = { sequence: 1, objectType: 'invoice', objectId: 'inv-1', at: '2020-01-01T00:00:00Z', actorId: 'u-clerk', hash: 'h-inv-1' };
const POLICY = { objectType: 'invoice', retainDays: 30 };
const ASOF = '2026-09-03T00:00:00Z';

const placeHold = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'p-1') =>
  h.request({ method: 'POST', path: '/v1/audit/legal-holds', userId: u, tenantId: A, idempotencyKey: key, body });
const liftHold = (h: ApiHarness, u: string, holdId: string, key = 'l-1', body: Record<string, unknown> = {}) =>
  h.request({ method: 'POST', path: `/v1/audit/legal-holds/${holdId}/lift`, userId: u, tenantId: A, idempotencyKey: key, body });
const listHolds = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/audit/legal-holds', userId: u, tenantId: A });
const plan = (h: ApiHarness, u: string, key = 'plan-1', body: Record<string, unknown> = { records: [oldInvoice], policies: [POLICY], asOf: ASOF }) =>
  h.request({ method: 'POST', path: '/v1/audit/retention/plan', userId: u, tenantId: A, idempotencyKey: key, body });
const evidencePack = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'ev-1') =>
  h.request({ method: 'POST', path: '/v1/audit/evidence-pack', userId: u, tenantId: A, idempotencyKey: key, body });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                   // audit.hold.manage + audit.retention.read
  await h.provisionRole(A, 'u-book', 'accountant');  // audit.retention.read only (NOT hold.manage)
  await h.provisionRole(A, 'u-cash', 'cashier');     // neither
  return h;
}

describe('legal holds: a hold freezes a record past its retention date, and is never erased (M34-FR-02)', () => {
  it('a held record survives its retention date; lifting the hold releases it for review', async () => {
    const h = await cast();

    // Before any hold: the 2020 invoice is past its 30-day retention → eligible for a human decision.
    const before = (await plan(h, 'u-owner')).body as { eligibleForReview: { objectId: string }[]; heldCount: number };
    expect(before.eligibleForReview.map((d) => d.objectId)).toEqual(['inv-1']);
    expect(before.heldCount).toBe(0);

    // Place a hold over the whole invoice class.
    expect((await placeHold(h, 'u-owner', { holdId: 'h-dispute', reason: 'customer dispute in court', objectType: 'invoice' })).status).toBe(201);

    // Now the SAME old record is frozen — a hold beats the retention date.
    const held = (await plan(h, 'u-owner', 'plan-2')).body as { decisions: { objectId: string; outcome: string; holdId?: string }[]; eligibleForReview: unknown[]; heldCount: number };
    expect(held.decisions.find((d) => d.objectId === 'inv-1')).toMatchObject({ outcome: 'legal_hold', holdId: 'h-dispute' });
    expect(held.eligibleForReview).toHaveLength(0);
    expect(held.heldCount).toBe(1);

    // Lift the hold — recorded, and the record becomes eligible again.
    expect((await liftHold(h, 'u-owner', 'h-dispute', 'l-1', { reason: 'case closed' })).status).toBe(200);
    const after = (await plan(h, 'u-owner', 'plan-3')).body as { eligibleForReview: { objectId: string }[] };
    expect(after.eligibleForReview.map((d) => d.objectId)).toEqual(['inv-1']);

    // The hold is kept beside its lifted state — never erased (hard rule #6). Survives a restart.
    const h2 = apiHarness({ store: h.store });
    const holds = (await listHolds(h2, 'u-owner')).body as { holds: { holdId: string; liftedBy?: string }[]; active: number };
    expect(holds.active).toBe(0);
    expect(holds.holds.find((x) => x.holdId === 'h-dispute')).toMatchObject({ liftedBy: 'u-owner' });
  });

  it('refuses a hold with no reason, a duplicate hold, and lifting an unknown or already-lifted hold', async () => {
    const h = await cast();
    const noReason = await placeHold(h, 'u-owner', { holdId: 'h1' }); // no reason
    expect(noReason.status).toBe(400);
    expect(codeOf(noReason)).toBe('not_readable_as_a_hold');

    expect((await placeHold(h, 'u-owner', { holdId: 'h1', reason: 'a dispute' })).status).toBe(201);
    const dup = await placeHold(h, 'u-owner', { holdId: 'h1', reason: 'again' }, 'p-2');
    expect(dup.status).toBe(409);
    expect(codeOf(dup)).toBe('hold_already_placed');

    expect((await liftHold(h, 'u-owner', 'nope', 'l-x')).status).toBe(404);
    await liftHold(h, 'u-owner', 'h1', 'l-1');
    const again = await liftHold(h, 'u-owner', 'h1', 'l-2');
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('hold_already_lifted');
  });

  it('assembles an evidence pack for a period, named to the exporter and carrying the trail seal', async () => {
    const h = await cast();
    const records = [
      { sequence: 1, objectType: 'invoice', objectId: 'inv-1', at: '2026-06-01T00:00:00Z', actorId: 'u-clerk', hash: 'h1' },
      { sequence: 2, objectType: 'invoice', objectId: 'inv-2', at: '2026-06-15T00:00:00Z', actorId: 'u-clerk', hash: 'h2' },
      { sequence: 3, objectType: 'invoice', objectId: 'inv-3', at: '2026-09-01T00:00:00Z', actorId: 'u-clerk', hash: 'h3' }, // outside the period
    ];
    const res = await evidencePack(h, 'u-book', { records, from: '2026-06-01T00:00:00Z', until: '2026-07-01T00:00:00Z', sourceIntact: true });
    expect(res.status).toBe(200);
    const pack = res.body as { records: { objectId: string }[]; chainHash: string; exportedBy: string; sourceIntact: boolean };
    expect(pack.records.map((r) => r.objectId)).toEqual(['inv-1', 'inv-2']); // only the period, inv-3 excluded
    expect(pack.chainHash).toBe('h2'); // the seal of the last record in the pack
    expect(pack).toMatchObject({ exportedBy: 'u-book', sourceIntact: true });
  });

  it('gates placing/lifting on audit.hold.manage and the plan/list/pack on audit.retention.read', async () => {
    const h = await cast();
    await placeHold(h, 'u-owner', { holdId: 'h1', reason: 'a dispute' });

    // Accountant may read (plan, list) but not place or lift a hold.
    expect((await plan(h, 'u-book', 'plan-book')).status).toBe(200);
    expect((await listHolds(h, 'u-book')).status).toBe(200);
    expect((await placeHold(h, 'u-book', { holdId: 'h2', reason: 'x' }, 'p-book')).status).toBe(403);
    expect((await liftHold(h, 'u-book', 'h1', 'l-book')).status).toBe(403);

    // A cashier holds neither permission → refused everywhere.
    expect((await plan(h, 'u-cash', 'plan-cash')).status).toBe(403);
    expect((await listHolds(h, 'u-cash')).status).toBe(403);
    expect((await placeHold(h, 'u-cash', { holdId: 'h3', reason: 'x' }, 'p-cash')).status).toBe(403);
  });
});
