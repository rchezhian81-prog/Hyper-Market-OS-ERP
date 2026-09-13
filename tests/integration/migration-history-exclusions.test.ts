import { describe, it, expect } from 'vitest';
import type { HttpResponse } from '../../services/kernel/src/index';
import { apiHarness } from '../support/api-harness';

/**
 * **MG-07 history exclusions, through the REAL authenticated pipeline (API-12).**
 *
 * Leaving legacy data behind is a WRITTEN, VALUED, owner-approved decision — never a config cutoff.
 * The migration operator (store manager) PROPOSES; only the OWNER approves, and never a proposal they
 * made themselves (separation of duties, OD-05). Age alone is refused as a reason. Until the owner
 * decides, an exclusion explains nothing — it sits as an undecided figure the reconciliation stays open
 * on. Synthetic data only; the harness target is 'rehearsal' (never production, hard rule #7).
 */

const T = 't-sre';
const OWNER = 'u-owner';
const SM = 'u-sm';
const bodyOf = (res: HttpResponse) => (typeof res.body === 'string' ? JSON.parse(res.body) : res.body);
const codeOf = (res: HttpResponse) => (bodyOf(res) as { error?: { code?: string } }).error?.code;

async function seeded() {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, SM, 'store_manager'); // the migration operator who proposes
  return h;
}

const post = (h: Awaited<ReturnType<typeof seeded>>, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const get = (h: Awaited<ReturnType<typeof seeded>>, path: string, userId: string) =>
  h.request({ method: 'GET', path, userId, tenantId: T });

const goodExclusion = (over: Record<string, unknown> = {}) => ({
  exclusionId: 'X1', scope: 'documents_before',
  description: 'pre-2019 purchase documents',
  recordCount: 1200, valueMinor: 5_000_00,
  reason: 'tax rates changed in 2019; restating these would rewrite already-filed GST returns',
  ...over,
});

describe('MG-07 history exclusions over the real authenticated surface', () => {
  it('operator proposes, owner approves, and the approved figure shows on the position', async () => {
    const h = await seeded();
    const proposed = await post(h, '/v1/migration/history/exclusions', SM, 'p1', goodExclusion());
    expect(proposed.status).toBe(201);
    expect(bodyOf(proposed).status).toBe('proposed');

    // Until decided, it is an undecided figure — it explains nothing.
    const before = bodyOf(await get(h, '/v1/migration/history/exclusions', OWNER)).position;
    expect(before.approvedValueMinor).toBe(0);
    expect(before.undecidedValueMinor).toBe(500000);

    const approved = await post(h, '/v1/migration/history/exclusions/X1/decision', OWNER, 'd1', {
      approve: true, ownerStatement: 'I confirm these are not migrated; the reconciliation must be short by exactly this.',
    });
    expect(approved.status).toBe(200);
    expect(bodyOf(approved).status).toBe('approved');
    expect(bodyOf(approved).approvedBy).toBe(OWNER);

    const after = bodyOf(await get(h, '/v1/migration/history/exclusions', OWNER)).position;
    expect(after.approvedValueMinor).toBe(500000);
    expect(after.approvedRecords).toBe(1200);
    expect(after.undecidedValueMinor).toBe(0);
  });

  it('refuses the owner approving an exclusion they proposed themselves (separation of duties)', async () => {
    const h = await seeded();
    // The owner may propose, but then cannot be the one to confirm it.
    expect((await post(h, '/v1/migration/history/exclusions', OWNER, 'p1', goodExclusion())).status).toBe(201);
    const self = await post(h, '/v1/migration/history/exclusions/X1/decision', OWNER, 'd1', { approve: true, ownerStatement: 'ok' });
    expect(self.status).toBe(403);
    expect(codeOf(self)).toBe('proposer_cannot_approve');
  });

  it('refuses "age alone" as a reason for leaving data behind', async () => {
    const h = await seeded();
    const res = await post(h, '/v1/migration/history/exclusions', SM, 'p1', goodExclusion({ reason: 'too old' }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('age_alone');
  });

  it('is authorized (only the owner approves) and refuses a role with no migration authority', async () => {
    const h = await seeded();
    await h.provisionRole(T, 'u-cash', 'cashier');
    // A cashier can neither propose nor approve.
    expect((await post(h, '/v1/migration/history/exclusions', 'u-cash', 'p0', goodExclusion())).status).toBe(403);

    await post(h, '/v1/migration/history/exclusions', SM, 'p1', goodExclusion());
    // The store manager proposed it but holds no approve permission — refused at the door.
    const smApprove = await post(h, '/v1/migration/history/exclusions/X1/decision', SM, 'd1', { approve: true, ownerStatement: 'ok' });
    expect(smApprove.status).toBe(403);
  });

  it('is open-once per id and a decided exclusion cannot be re-decided', async () => {
    const h = await seeded();
    await post(h, '/v1/migration/history/exclusions', SM, 'p1', goodExclusion());
    // Same id again → 409.
    expect((await post(h, '/v1/migration/history/exclusions', SM, 'p2', goodExclusion())).status).toBe(409);

    expect((await post(h, '/v1/migration/history/exclusions/X1/decision', OWNER, 'd1', { approve: false, ownerStatement: 'migrate them after all' })).status).toBe(200);
    // Re-deciding a rejected (decided) exclusion is refused by the engine.
    const again = await post(h, '/v1/migration/history/exclusions/X1/decision', OWNER, 'd2', { approve: true, ownerStatement: 'changed my mind' });
    expect(again.status).toBe(422);
    expect(codeOf(again)).toBe('not_proposed');
  });
});
