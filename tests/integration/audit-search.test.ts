import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { AuditTrail, InMemoryAuditStore, type AuditRecord, type AuditEntry } from '../../packages/audit/src/index';

// Audit-trail search / reconstruct / verify, end to end (M34-FR-01, API-09). The tested @sre/audit trail is
// the tamper-evident memory of the system — who did what, when, where, before/after, each record sealed with
// the hash of the one before it. This wires its three read capabilities over a supplied sealed trail (an
// export): SEARCH narrows it, RECONSTRUCT rebuilds an object's state from evidence alone, and VERIFY names
// EVERY place the chain does not hold up. Pure reads; there is no operation to edit or drop a record
// (M34-FR-01). Gated audit.retention.read.
//
// The test builds a REAL sealed trail with the same engine the route uses, then feeds it in — so a passing
// verify means the wiring verifies genuine seals, and a tampered record is genuinely caught.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

/** A real, correctly-sealed trail, produced by the engine — the records the routes then inspect. */
function sealedTrail(): readonly AuditRecord[] {
  const trail = new AuditTrail(new InMemoryAuditStore());
  const entries: AuditEntry[] = [
    { actorId: 'u-mgr', action: 'price.change', objectType: 'product', objectId: 'prod-1', at: '2026-06-01T10:00:00Z', origin: { tenantId: A, branchId: null }, before: null, after: { price: '100' } },
    { actorId: 'u-owner', action: 'price.change', objectType: 'product', objectId: 'prod-1', at: '2026-06-02T10:00:00Z', origin: { tenantId: A, branchId: null }, before: { price: '100' }, after: { price: '120' } },
    { actorId: 'u-mgr', action: 'refund.approve', objectType: 'refund', objectId: 'ref-9', at: '2026-06-03T10:00:00Z', origin: { tenantId: A, branchId: 'b1' }, before: null, after: { amount: '500' } },
  ];
  for (const e of entries) trail.record(e);
  return trail.all();
}

const search = (h: ApiHarness, u: string, body: unknown, key = 's-1') =>
  h.request({ method: 'POST', path: '/v1/audit/trail/search', userId: u, tenantId: A, idempotencyKey: key, body });
const reconstruct = (h: ApiHarness, u: string, body: unknown, key = 'r-1') =>
  h.request({ method: 'POST', path: '/v1/audit/trail/reconstruct', userId: u, tenantId: A, idempotencyKey: key, body });
const verify = (h: ApiHarness, u: string, body: unknown, key = 'v-1') =>
  h.request({ method: 'POST', path: '/v1/audit/trail/verify', userId: u, tenantId: A, idempotencyKey: key, body });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                   // audit.retention.read
  await h.provisionRole(A, 'u-book', 'accountant');  // audit.retention.read
  await h.provisionRole(A, 'u-cash', 'cashier');     // neither
  return h;
}

describe('audit-trail search, reconstruct & verify over a supplied sealed trail (M34-FR-01)', () => {
  it('verifies an intact trail, and names the exact record when one is tampered with', async () => {
    const h = await cast();
    const records = sealedTrail();

    const ok = await verify(h, 'u-owner', { records });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ intact: true, recordsChecked: 3, findings: [] });

    // Change one byte of one record's after-state — its seal no longer matches its contents.
    const tampered = JSON.parse(JSON.stringify(records)) as AuditRecord[];
    (tampered[1] as { after: Record<string, string> }).after.price = '9';
    const bad = await verify(h, 'u-owner', { records: tampered }, 'v-2');
    const result = bad.body as { intact: boolean; findings: { sequence: number; reason: string }[] };
    expect(result.intact).toBe(false);
    expect(result.findings.some((f) => f.sequence === 2 && f.reason === 'hash_mismatch')).toBe(true);
  });

  it('searches by actor, and reconstructs an object’s state from the evidence alone', async () => {
    const h = await cast();
    const records = sealedTrail();

    const byActor = await search(h, 'u-book', { records, query: { actorId: 'u-mgr' } });
    expect(byActor.status).toBe(200);
    const matches = (byActor.body as { matches: { objectId: string }[]; total: number });
    expect(matches.total).toBe(2); // the price.change and the refund.approve u-mgr made
    expect(matches.matches.map((m) => m.objectId).sort()).toEqual(['prod-1', 'ref-9']);

    const rebuilt = await reconstruct(h, 'u-owner', { records, objectType: 'product', objectId: 'prod-1' });
    const body = rebuilt.body as { state: Record<string, string>; changes: number };
    expect(body.state).toEqual({ price: '120' }); // the latest after-state, rebuilt from the two changes
    expect(body.changes).toBe(2);
  });

  it('rejects a malformed trail (400) and gates on audit.retention.read', async () => {
    const h = await cast();
    const records = sealedTrail();

    const bad = await verify(h, 'u-owner', { records: 'nope' }, 'v-bad');
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_an_audit_trail');

    const noObject = await reconstruct(h, 'u-owner', { records }, 'r-noobj');
    expect(noObject.status).toBe(400);

    // Accountant may read the trail; a cashier (no audit.retention.read) is refused.
    expect((await verify(h, 'u-book', { records }, 'v-book')).status).toBe(200);
    expect((await verify(h, 'u-cash', { records }, 'v-cash')).status).toBe(403);
    expect((await search(h, 'u-cash', { records, query: {} }, 's-cash')).status).toBe(403);
  });
});
