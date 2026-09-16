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
const grantBody = (o: { grantId: string; userId: string; requestedBy: string; approvedBy: string }) =>
  ({ grantId: o.grantId, userId: o.userId, roleId: 'cashier', branchScope: 'all', requestedBy: o.requestedBy, approvedBy: o.approvedBy, requestedAt: '2026-09-16T10:00:00.000Z' });
const grant = (h: ApiHarness, actor: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: '/v1/identity/grants', userId: actor, tenantId: A, idempotencyKey: key, body });

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

const saleBody = () => ({
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-09-16', committedAt: '2026-09-16T10:00:00.000Z', totalMinor: 15_000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 15_000 }],
  tenders: [{ kind: 'cash', amountMinor: 15_000 }],
});
const bankSale = (h: ApiHarness, u: string) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: 'bank-S1', body: saleBody() });
const doReturn = (h: ApiHarness, u: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/sales/S1/returns', userId: u, tenantId: A, idempotencyKey: `ret-${body['returnId']}`, body });

describe('the audit trail records a refund — a money action — with no tender data (M34 slice 5)', () => {
  it('seals the refund fact (amount, reason, status, approver) attributed to the processor; never the tender', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');                         // the refund processor + audit reader
    await h.provisionRole(A, 'u-mgr', 'store_manager');      // a genuine §28 approver (holds pos.return.approve)
    expect((await bankSale(h, 'u-owner')).status).toBe(202);

    const r = await doReturn(h, 'u-owner', {
      returnId: 'RT1', reasonCode: 'customer_changed_mind',
      lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' }],
      refundMinor: 5_000, refundTender: 'cash', approvedBy: 'u-mgr',
    });
    expect(r.status).toBe(201);

    const body = (await trail(h, 'u-owner', { objectType: 'sale', objectId: 'S1' })).body as { matches: Rec[]; total: number };
    expect(body.total).toBe(1);
    const rec = body.matches[0]!;
    expect(rec).toMatchObject({ action: 'refund.accept', objectType: 'sale', objectId: 'S1', actorId: 'u-owner' });
    expect(rec.after).toMatchObject({ refundMinor: '5000', reasonCode: 'customer_changed_mind', refundStatus: 'settled', approvedBy: 'u-mgr' });
    // The refund FACT only — never the tender instrument (hard rule #3). refundTender ('cash') is omitted,
    // so no tender word may appear anywhere in the sealed record.
    expect(JSON.stringify(rec)).not.toMatch(/card|cvv|expiry|tender|cash|upi/i);
    expect((await verify(h, 'u-owner')).body).toMatchObject({ intact: true, recordsChecked: 1 });
  });
});

const PRICE_CTX = { mrpMinor: 10_000, costMinor: 5_000, marginFloorBps: 2_000, currency: 'INR' } as const;
const proposePrice = (h: ApiHarness, actor: string, priceMinor: number, key: string) =>
  h.request({
    method: 'POST', path: '/v1/prices/changes', userId: actor, tenantId: A, idempotencyKey: key,
    body: { productId: 'P1', priceMinor, ...PRICE_CTX },
  });

describe('the audit trail records a money action — a price change (M34 slice 4, money recorders)', () => {
  it('seals who moved the price, to what, attributed to the acting user; verifies intact; carries no tender data', async () => {
    const h = apiHarness();
    await h.provisionOwner(A, 'u-pricer'); // holds price.change.propose + audit.retention.read

    const r = await proposePrice(h, 'u-pricer', 8_000, 'kp1'); // within MRP, above the cost floor → allowed
    expect(r.status).toBe(201);

    const body = (await trail(h, 'u-pricer', { objectType: 'product', objectId: 'P1' })).body as { matches: Rec[]; total: number };
    expect(body.total).toBe(1);
    const rec = body.matches[0]!;
    expect(rec).toMatchObject({ action: 'price.change', objectType: 'product', objectId: 'P1', actorId: 'u-pricer' });
    expect(rec.after).toMatchObject({ priceMinor: '8000', currency: 'INR', verdict: 'ok' });
    // A price is a public shelf figure — but the record must never carry card/tender data (hard rule #3).
    expect(JSON.stringify(rec)).not.toMatch(/card|cvv|expiry|tender/i);
    expect((await verify(h, 'u-pricer')).body).toMatchObject({ intact: true, recordsChecked: 1 });
  });
});

describe('concurrent sensitive actions never fork the sealed chain (M34 slice 3)', () => {
  it('serialises per tenant — five SIMULTANEOUS records chain 1..5 and verify intact', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Fire five distinct credential registrations at once. Their audit seals fold-then-append the same
    // per-tenant chain; without the per-tenant lock two would seal the same sequence and fork it.
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const results = await Promise.all(
      ids.map((id) => register(h, 'u-owner', `pay-${id}`, secret({ vaultRef: `vault://p/${id}#v1` }), `k-${id}`)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);

    const body = (await trail(h, 'u-owner')).body as { matches: Rec[]; total: number };
    expect(body.total).toBe(5);
    // A clean, gap-free chain 1..5 — no two records claimed the same sequence.
    expect(body.matches.map((r) => r.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect((await verify(h, 'u-owner')).body).toMatchObject({ intact: true, recordsChecked: 5, findings: [] });
  });
});

describe('the audit trail spans producers — a role grant (privilege change) is sealed too (M34 slice 2)', () => {
  it('records who was granted what, by whom, attributed to the ACTING user, and verifies intact', async () => {
    const h = apiHarness();
    await h.provisionOwner(A, 'u-owner-1');    // requester/actor — holds identity.role.grant + audit.retention.read
    await h.provisionOwner(A, 'u-owner-2');    // the second person who approves (§28)

    const g = await grant(h, 'u-owner-1', grantBody({ grantId: 'g1', userId: 'u-cash', requestedBy: 'u-owner-1', approvedBy: 'u-owner-2' }), 'kg1');
    expect(g.status).toBe(201);

    const body = (await trail(h, 'u-owner-1', { objectType: 'user', objectId: 'u-cash' })).body as { matches: Rec[]; total: number };
    expect(body.total).toBe(1);
    const rec = body.matches[0]!;
    // Attributed to the user who executed the grant — never a client-supplied actor.
    expect(rec).toMatchObject({ action: 'role.grant', objectType: 'user', objectId: 'u-cash', actorId: 'u-owner-1' });
    // The §28 evidence — what was granted, by whom, approved by whom — is on the record.
    expect(rec.after).toMatchObject({ roleId: 'cashier', requestedBy: 'u-owner-1', approvedBy: 'u-owner-2' });
    expect((await verify(h, 'u-owner-1')).body).toMatchObject({ intact: true, recordsChecked: 1 });
  });
});
