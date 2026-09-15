import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M34-FR-01 — the domain audit trail is now PRODUCED, durable and verifiable, not just readable over a
// supplied export. A sensitive action (slice 1: the credential lifecycle) seals a record into a
// tamper-evident chain, attributed to the ACTING USER (never a client-supplied actor), with NO secret
// value — a vault reference and state only (hard rule #4). The stored trail is then searched,
// reconstructed and verified over the SAME tested @sre/audit engine. Reads gated audit.retention.read;
// there is no route anywhere to edit or drop a record (hard rule #6).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const secret = (over: Record<string, unknown> = {}) =>
  ({ kind: 'payment_provider', vaultRef: 'vault://payments/live#v1', owner: 'u-owner', protects: 'the live payment key', rotateEveryDays: 90, environment: 'production', ...over });

const register = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/integration/secrets/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const rotate = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/integration/secrets/${id}/rotation`, userId: u, tenantId: A, idempotencyKey: key, body });
const trail = (h: ApiHarness, u: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/audit/trail', userId: u, tenantId: A, ...(query ? { query } : {}) });
const verify = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/audit/trail/verify', userId: u, tenantId: A });
const reconstruct = (h: ApiHarness, u: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/audit/trail/reconstruct', userId: u, tenantId: A, query });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // platform.setup.write + audit.retention.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

type Rec = { sequence: number; actorId: string; action: string; objectType: string; objectId: string; before: unknown; after: Record<string, string> | null };

describe('the domain audit trail is produced, durable and verifiable (M34-FR-01)', () => {
  it('seals a credential action, attributes it to the ACTING USER, and records NO secret value', async () => {
    const h = await cast();
    await register(h, 'u-owner', 'pay', secret(), 'k1');

    const res = await trail(h, 'u-owner', { objectType: 'secret', objectId: 'pay' });
    expect(res.status).toBe(200);
    const body = res.body as { matches: Rec[]; total: number };
    expect(body.total).toBe(1);
    const rec = body.matches[0]!;
    expect(rec).toMatchObject({ action: 'secret.register', objectType: 'secret', objectId: 'pay', actorId: 'u-owner' });
    expect(rec.before).toBeNull();
    // A vault REFERENCE, never a value — the trail can never leak the key (hard rule #4).
    expect(rec.after?.['vaultRef']).toMatch(/^vault:\/\//);
    expect(JSON.stringify(rec)).not.toContain('sk_live');
  });

  it('chains a second action, verifies the whole stored chain, and reconstructs the object from evidence alone (NFR-15)', async () => {
    const h = await cast();
    await register(h, 'u-owner', 'pay', secret(), 'k1');
    await rotate(h, 'u-owner', 'pay', { newVaultRef: 'vault://payments/live#v2', graceDays: 7 }, 'k2');

    // Two sealed records, in the order they happened.
    const body = (await trail(h, 'u-owner', { objectType: 'secret', objectId: 'pay' })).body as { matches: Rec[]; total: number };
    expect(body.matches.map((r) => r.action)).toEqual(['secret.register', 'secret.rotate']);
    expect(body.matches.map((r) => r.sequence)).toEqual([1, 2]);

    // The chain verifies — nothing has been tampered with (P-08).
    expect((await verify(h, 'u-owner')).body).toMatchObject({ intact: true, recordsChecked: 2, findings: [] });

    // Rebuilt from the evidence alone: the current state reflects the rotation to v2.
    const rc = (await reconstruct(h, 'u-owner', { objectType: 'secret', objectId: 'pay' })).body as { state: Record<string, string> | null; changes: number };
    expect(rc.changes).toBe(2);
    expect(rc.state).toMatchObject({ vaultRef: 'vault://payments/live#v2', version: '2', state: 'active' });
  });

  it('gates every read on audit.retention.read — a cashier sees nothing', async () => {
    const h = await cast();
    await register(h, 'u-owner', 'pay', secret(), 'k1');
    expect((await trail(h, 'u-cash', { objectType: 'secret', objectId: 'pay' })).status).toBe(403);
    expect((await verify(h, 'u-cash')).status).toBe(403);
    expect((await reconstruct(h, 'u-cash', { objectType: 'secret', objectId: 'pay' })).status).toBe(403);
    // Reconstruct without an object is refused cleanly.
    expect(((await reconstruct(h, 'u-owner', {})).body as { error?: { code?: string } }).error?.code).toBe('reconstruct_needs_an_object');
  });

  it('the sealed trail survives a restart and still verifies', async () => {
    const h = await cast();
    await register(h, 'u-owner', 'pay', secret(), 'k1');
    await rotate(h, 'u-owner', 'pay', { newVaultRef: 'vault://payments/live#v2', graceDays: 7 }, 'k2');

    const restarted = apiHarness({ store: h.store });
    const body = (await trail(restarted, 'u-owner', { objectType: 'secret', objectId: 'pay' })).body as { total: number };
    expect(body.total).toBe(2);                                  // the chain rebuilt from the store
    expect((await verify(restarted, 'u-owner')).body).toMatchObject({ intact: true, recordsChecked: 2 });
  });
});
