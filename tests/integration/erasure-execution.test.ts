import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-06 Erasure EXECUTION on the live surface (M20-FR-04 / PRV / DPDP, owner decision — DEVELOPMENT-
// APPROVED, LEGAL CONFIRMATION REQUIRED). Locate PII → verify → checker approval → maker executes under the
// two-person control → PII-free tombstone sealed → processor notices enqueued → prevent-restore. Durable and
// per-tenant, rebuilt from the append-only store across a cold restart. The engines are @sre/customer; this
// proves the composition through the REAL pipeline (RBAC, idempotency, event store).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const raise = (h: ApiHarness, u: string, t: string, id: string) =>
  h.request({ method: 'POST', path: `/v1/privacy/data-requests/${id}`, userId: u, tenantId: t, idempotencyKey: `${id}-raise`, body: { customerRef: 'cust-1', kind: 'erasure' } });
const verify = (h: ApiHarness, u: string, t: string, id: string) =>
  h.request({ method: 'POST', path: `/v1/privacy/data-requests/${id}/verification`, userId: u, tenantId: t, idempotencyKey: `${id}-verify`, body: { verifiedBy: 'passport+otp' } });
const recordPii = (h: ApiHarness, u: string, t: string, customerRef: string, category: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/privacy/pii/${customerRef}/${category}`, userId: u, tenantId: t, idempotencyKey: `${customerRef}-${category}`, body });
const approve = (h: ApiHarness, u: string, t: string, id: string) =>
  h.request({ method: 'POST', path: `/v1/privacy/data-requests/${id}/erasure-approval`, userId: u, tenantId: t, idempotencyKey: `${id}-approve-${u}` });
const execute = (h: ApiHarness, u: string, t: string, id: string, processors?: unknown) =>
  h.request({ method: 'POST', path: `/v1/privacy/data-requests/${id}/erasure-execution`, userId: u, tenantId: t, idempotencyKey: `${id}-exec`, body: processors === undefined ? {} : { processors } });
const piiOf = (h: ApiHarness, u: string, t: string, customerRef: string) =>
  h.request({ method: 'GET', path: `/v1/privacy/pii/${customerRef}`, userId: u, tenantId: t });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const SMS = { processorId: 'sms-gw', name: 'SMS gateway', connectorId: 'conn-sms', connectorVersion: 'v1', categoriesShared: ['marketing_profile'] };

/** Seed the located PII for cust-1: an erasable marketing profile, a minimisable audit record, a retained invoice. */
async function seedPii(h: ApiHarness, maker: string): Promise<void> {
  await recordPii(h, maker, A, 'cust-1', 'marketing_profile', { recordCount: 3 });
  await recordPii(h, maker, A, 'cust-1', 'order_history', { recordCount: 5, retentionBasis: 'audit_evidence', minimisable: true });
  await recordPii(h, maker, A, 'cust-1', 'tax_invoice', { recordCount: 4, retentionBasis: 'tax_invoice', retainUntil: '2034-03-31' });
}

async function seedCast(h: ApiHarness): Promise<void> {
  await h.seedOwner(A, 'u-maker');
  await h.provisionOwner(A, 'u-checker'); // a second owner — distinct person for the two-person control
}

describe('erasure execution on the live surface (M20-FR-04)', () => {
  it('runs the full governed erasure: locate → verify → approve → execute → tombstone → notify', async () => {
    const h = apiHarness();
    await seedCast(h);
    await raise(h, 'u-maker', A, 'dsr-1');
    await verify(h, 'u-maker', A, 'dsr-1');
    await seedPii(h, 'u-maker');
    expect((await approve(h, 'u-checker', A, 'dsr-1')).status).toBe(200);

    const res = await execute(h, 'u-maker', A, 'dsr-1', [SMS]);
    expect(res.status).toBe(200);
    const body = res.body as { state: string; report: { totals: Record<string, number>; complete: boolean }; tombstone: { categoriesErased: string[]; categoriesMinimised: string[]; categoriesRetained: { category: string }[]; maker: string; checker: string }; notices: { processorId: string; categories: string[] }[] };
    expect(body.state).toBe('partially_fulfilled'); // the retained invoice keeps it honestly partial
    expect(body.report.totals).toMatchObject({ erased: 3, minimised: 5, retained: 4 });
    expect(body.report.complete).toBe(true); // every erase/minimise reached its (simulated) store
    expect(body.tombstone.categoriesErased).toEqual(['marketing_profile']);
    expect(body.tombstone.categoriesMinimised).toEqual(['order_history']);
    expect(body.tombstone.categoriesRetained.map((c) => c.category)).toEqual(['tax_invoice']);
    expect(body.tombstone).toMatchObject({ maker: 'u-maker', checker: 'u-checker' });
    // The processor that shares the erased marketing profile is notified; the retained invoice is not.
    expect(body.notices).toEqual([{ processorId: 'sms-gw', categories: ['marketing_profile'], messageId: 'erasure-dsr-1-sms-gw' }]);

    // The located PII now reads honestly: erased gone, minimised kept-marked, retained untouched.
    const pii = (await piiOf(h, 'u-maker', A, 'cust-1')).body as { categories: { category: string; state: string }[] };
    const state = (c: string) => pii.categories.find((e) => e.category === c)?.state;
    expect(state('marketing_profile')).toBe('erased');
    expect(state('order_history')).toBe('minimised');
    expect(state('tax_invoice')).toBe('held'); // the executor never touched the retained invoice (#6)
  });

  it('refuses when the same officer both approves and executes (SoD §28)', async () => {
    const h = apiHarness();
    await seedCast(h);
    await raise(h, 'u-maker', A, 'dsr-1');
    await verify(h, 'u-maker', A, 'dsr-1');
    await seedPii(h, 'u-maker');
    await approve(h, 'u-maker', A, 'dsr-1'); // maker approves their own request
    const res = await execute(h, 'u-maker', A, 'dsr-1');
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe('maker_is_checker');
  });

  it('refuses execution with no second approver (maker-checker needs two)', async () => {
    const h = apiHarness();
    await seedCast(h);
    await raise(h, 'u-maker', A, 'dsr-1');
    await verify(h, 'u-maker', A, 'dsr-1');
    await seedPii(h, 'u-maker');
    const res = await execute(h, 'u-maker', A, 'dsr-1'); // no approval recorded
    expect(res.status).toBe(428);
    expect(codeOf(res)).toBe('checker_missing');
  });

  it('will not approve an unverified request (the identity gate is carried through)', async () => {
    const h = apiHarness();
    await seedCast(h);
    await raise(h, 'u-maker', A, 'dsr-1'); // not verified
    const res = await approve(h, 'u-checker', A, 'dsr-1');
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('not_verified');
  });

  it('prevents restore — recording PII for an erased subject is refused (hard rule #10, P-08)', async () => {
    const h = apiHarness();
    await seedCast(h);
    await raise(h, 'u-maker', A, 'dsr-1');
    await verify(h, 'u-maker', A, 'dsr-1');
    await seedPii(h, 'u-maker');
    await approve(h, 'u-checker', A, 'dsr-1');
    await execute(h, 'u-maker', A, 'dsr-1');
    // A late re-import tries to re-create the erased subject's profile (a fresh idempotency key — this is a
    // genuinely new write attempt, not a replay of the earlier record).
    const res = await h.request({ method: 'POST', path: '/v1/privacy/pii/cust-1/marketing_profile', userId: 'u-maker', tenantId: A, idempotencyKey: 'late-reimport-attempt', body: { recordCount: 1 } });
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe('subject_was_erased');
  });

  it('gates the write-path — a cashier can neither record PII nor execute an erasure', async () => {
    const h = apiHarness();
    await seedCast(h);
    await h.provisionRole(A, 'u-cash', 'cashier');
    await raise(h, 'u-maker', A, 'dsr-1');
    await verify(h, 'u-maker', A, 'dsr-1');
    expect((await recordPii(h, 'u-cash', A, 'cust-1', 'marketing_profile', { recordCount: 1 })).status).toBe(403);
    expect((await execute(h, 'u-cash', A, 'dsr-1')).status).toBe(403);
  });

  it('is durable — the tombstone and the erased holdings survive a cold restart', async () => {
    const h = apiHarness();
    await seedCast(h);
    await raise(h, 'u-maker', A, 'dsr-1');
    await verify(h, 'u-maker', A, 'dsr-1');
    await seedPii(h, 'u-maker');
    await approve(h, 'u-checker', A, 'dsr-1');
    await execute(h, 'u-maker', A, 'dsr-1', [SMS]);

    const restarted = apiHarness({ store: h.store });
    const tomb = await restarted.request({ method: 'GET', path: '/v1/privacy/data-requests/dsr-1/tombstone', userId: 'u-maker', tenantId: A });
    expect(tomb.status).toBe(200);
    expect((tomb.body as { categoriesErased: string[] }).categoriesErased).toEqual(['marketing_profile']);
    const pii = (await piiOf(restarted, 'u-maker', A, 'cust-1')).body as { categories: { category: string; state: string }[] };
    expect(pii.categories.find((e) => e.category === 'marketing_profile')?.state).toBe('erased'); // correction survived
  });

  it('is per-tenant — one company\'s tombstone never appears for another', async () => {
    const h = apiHarness();
    await seedCast(h);
    await h.seedOwner(B, 'u-b');
    await raise(h, 'u-maker', A, 'dsr-1');
    await verify(h, 'u-maker', A, 'dsr-1');
    await seedPii(h, 'u-maker');
    await approve(h, 'u-checker', A, 'dsr-1');
    await execute(h, 'u-maker', A, 'dsr-1');
    // Tenant B has no such request/tombstone.
    const tomb = await h.request({ method: 'GET', path: '/v1/privacy/data-requests/dsr-1/tombstone', userId: 'u-b', tenantId: B });
    expect(tomb.status).toBe(404);
  });
});
