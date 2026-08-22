import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Data-subject rights lifecycle, end to end (M20-FR-04 / M16-FR-03 · DPDP, API-06). Two absolutes: a
// request is VERIFIED before it is fulfilled (an unverified erasure deletes someone else's account), and
// an erasure produces an honest PLAN — erase what can go, keep what the law requires, and tell the
// customer which and why (audit evidence is minimised, never deleted; hard rule #6). Append-only, so an
// auditor reads exactly what was asked, when it was verified, and what was done. Gated privacy.request.manage.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const raise = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/privacy/data-requests/${id}`, userId: u, tenantId: A, idempotencyKey: `raise-${id}`, body });
const verify = (h: ApiHarness, u: string, id: string, verifiedBy = 'passport-checked') =>
  h.request({ method: 'POST', path: `/v1/privacy/data-requests/${id}/verification`, userId: u, tenantId: A, idempotencyKey: `vfy-${id}`, body: { verifiedBy } });
const fulfil = (h: ApiHarness, u: string, id: string, held: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/privacy/data-requests/${id}/fulfilment`, userId: u, tenantId: A, idempotencyKey: key ?? `ful-${id}`, body: { held } });
const erasurePlan = (h: ApiHarness, u: string, id: string, categories: unknown[]) =>
  h.request({ method: 'POST', path: `/v1/privacy/data-requests/${id}/erasure-plan`, userId: u, tenantId: A, idempotencyKey: `era-${id}`, body: { categories } });
const overdue = (h: ApiHarness, u: string, asOf?: string) =>
  h.request({ method: 'GET', path: '/v1/privacy/data-requests/overdue', userId: u, tenantId: A, ...(asOf ? { query: { asOf } } : {}) });
const getOne = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/privacy/data-requests/${id}`, userId: u, tenantId: A });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // privacy.request.manage
  await h.provisionRole(A, 'u-cash', 'cashier');       // not
  return h;
}

describe('data-subject rights: verify before fulfil, and erase honestly (M20-FR-04, DPDP)', () => {
  it('fulfils an access request only after it is verified, and hands back the held data', async () => {
    const h = await cast();
    expect((await raise(h, 'u-mgr', 'a1', { customerRef: 'c1', kind: 'access' })).status).toBe(201);

    // Fulfilling before verification is how one person reads another's shopping history — refused.
    expect(codeOf(await fulfil(h, 'u-mgr', 'a1', { orders: [1, 2] }))).toBe('not_verified');

    expect((await verify(h, 'u-mgr', 'a1')).status).toBe(200);
    const done = await fulfil(h, 'u-mgr', 'a1', { orders: [{ id: 'o1' }], profile: { name: 'redacted' } });
    expect(done.status).toBe(200);
    expect((done.body as { outcome: string; state: string; payload: Record<string, unknown> })).toMatchObject({ outcome: 'fulfilled', state: 'fulfilled' });
    expect((done.body as { payload: Record<string, unknown> }).payload).toHaveProperty('orders');

    // Already fulfilled — not fulfilled twice (distinct transport key so the kernel reaches the handler).
    expect(codeOf(await fulfil(h, 'u-mgr', 'a1', { orders: [] }, 'ful-a1-again'))).toBe('wrong_state');
  });

  it('plans an erasure honestly: erase what can go, minimise audit evidence, keep what the law requires', async () => {
    const h = await cast();
    await raise(h, 'u-mgr', 'e1', { customerRef: 'c2', kind: 'erasure' });
    // An unverified erasure is refused — it is how one person deletes another's account.
    expect(codeOf(await erasurePlan(h, 'u-mgr', 'e1', [{ category: 'x', recordCount: 1 }]))).toBe('not_verified');

    await verify(h, 'u-mgr', 'e1');
    const res = await erasurePlan(h, 'u-mgr', 'e1', [
      { category: 'marketing_profile', recordCount: 3 }, // no legal basis → erased
      { category: 'tax_invoices', recordCount: 12, retentionBasis: 'tax_invoice', retainUntil: '2034-03-31' }, // kept
      { category: 'audit_log', recordCount: 40, retentionBasis: 'audit_evidence', minimisable: true }, // minimised, never deleted
    ]);
    expect(res.status).toBe(200);
    const plan = res.body as { partial: boolean; erasedRecordCount: number; minimisedRecordCount: number; retainedRecordCount: number; state: string; customerStatement: string[]; plan: { category: string; disposition: string }[] };
    expect(plan).toMatchObject({ partial: true, erasedRecordCount: 3, minimisedRecordCount: 40, retainedRecordCount: 12, state: 'partially_fulfilled' });
    expect(plan.plan.find((p) => p.category === 'marketing_profile')?.disposition).toBe('erase');
    expect(plan.plan.find((p) => p.category === 'tax_invoices')?.disposition).toBe('retain');
    expect(plan.plan.find((p) => p.category === 'audit_log')?.disposition).toBe('minimise');
    // The customer is told, not left to believe they were fully erased.
    expect(plan.customerStatement.join(' ')).toContain('could not be deleted');

    // A full erasure (nothing the law keeps) closes as fulfilled, not partial.
    await raise(h, 'u-mgr', 'e2', { customerRef: 'c3', kind: 'erasure' });
    await verify(h, 'u-mgr', 'e2');
    const full = (await erasurePlan(h, 'u-mgr', 'e2', [{ category: 'newsletter', recordCount: 1 }])).body as { partial: boolean; state: string };
    expect(full).toMatchObject({ partial: false, state: 'fulfilled' });
  });

  it('surfaces overdue requests worst-first, flags the unverified one, and keeps the two paths apart', async () => {
    const h = await cast();
    await raise(h, 'u-mgr', 'od1', { customerRef: 'c4', kind: 'access', slaDays: 1 }); // due soonest, left UNVERIFIED
    await raise(h, 'u-mgr', 'od2', { customerRef: 'c5', kind: 'access', slaDays: 5 });
    await verify(h, 'u-mgr', 'od2');

    const body = (await overdue(h, 'u-owner', '2030-01-01')).body as { overdue: { requestId: string; daysOverdue: number; detail: string }[]; count: number };
    expect(body.count).toBe(2);
    expect(body.overdue[0]?.requestId).toBe('od1'); // due earliest → most overdue, first
    expect(body.overdue[0]?.detail).toContain('NOT VERIFIED'); // the queue that is entirely ours

    // An erasure is not fulfilled by handing data back; an access request has no erasure plan.
    await raise(h, 'u-mgr', 'mix', { customerRef: 'c6', kind: 'erasure' });
    expect(codeOf(await fulfil(h, 'u-mgr', 'mix', {}))).toBe('erasure_needs_a_plan');
    expect(codeOf(await erasurePlan(h, 'u-mgr', 'od2', [{ category: 'x', recordCount: 1 }]))).toBe('not_an_erasure_request');
  });

  it('is manager-gated, and the lifecycle survives a restart (rebuilt from the event store)', async () => {
    const h = await cast();
    // A cashier does not handle data-subject requests.
    expect((await raise(h, 'u-cash', 'x1', { customerRef: 'c7', kind: 'access' })).status).toBe(403);
    expect((await overdue(h, 'u-cash')).status).toBe(403);

    await raise(h, 'u-mgr', 'r1', { customerRef: 'c8', kind: 'access' });
    await verify(h, 'u-mgr', 'r1', 'in-store-id');

    const restarted = apiHarness({ store: h.store });
    const one = (await getOne(restarted, 'u-owner', 'r1')).body as { state: string; verifiedBy: string };
    expect(one).toMatchObject({ state: 'verified', verifiedBy: 'in-store-id' });
  });
});
