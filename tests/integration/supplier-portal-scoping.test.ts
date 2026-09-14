import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M24-FR-01 · §35 · P-04 — server-side supplier scoping, the read-isolation half ("a supplier cannot see
// another supplier's data"). The supplier portal is the ONE place a party outside the business logs in, so
// the risk is the commonest multi-tenant breach there is: one supplier seeing a competitor's prices. The
// `scopeToPartner` engine has always enforced it; this proves the SUPPLIER-FACING routes wire it — the
// partner id comes from the session's stored login binding, NEVER the request, and a cross-partner read is
// refused AND recorded (feeding findProbing, M24-FR-04), never silently emptied.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const configurePartner = (h: ApiHarness, partnerId: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}`, userId: 'u-owner', tenantId: A, idempotencyKey: `cfg-${partnerId}`, body });
const submitAck = (h: ApiHarness, partnerId: string, submissionId: string) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}/submissions`, userId: 'u-owner', tenantId: A, idempotencyKey: `sub-${submissionId}`, body: { submissionId, kind: 'po_acknowledgement' } });
const recordLine = (h: ApiHarness, partnerId: string, ref: string, amountMinor: number) =>
  h.request({ method: 'POST', path: `/v1/supplier-portal/partners/${partnerId}/statement/lines/${ref}`, userId: 'u-owner', tenantId: A, idempotencyKey: `line-${partnerId}-${ref}`, body: { kind: 'invoice', date: '2026-09-14', amountMinor } });

const meSubmissions = (h: ApiHarness, userId: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/supplier-portal/me/submissions', userId, tenantId: A, query });
const meStatement = (h: ApiHarness, userId: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/supplier-portal/me/statement', userId, tenantId: A, query });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code ?? (res.body as { code?: string }).code;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner'); // the BUYER — configures partners + reads the tenant-wide probing view
  // Two competing suppliers, each with its own portal login bound by the buyer.
  await configurePartner(h, 'ALPHA', { grants: ['view_orders', 'view_statement', 'acknowledge_orders'], logins: ['u-alpha'] });
  await configurePartner(h, 'BETA', { grants: ['view_orders', 'view_statement', 'acknowledge_orders'], logins: ['u-beta'] });
  await submitAck(h, 'ALPHA', 'A-ACK-1');
  await submitAck(h, 'BETA', 'B-ACK-1');
  await recordLine(h, 'ALPHA', 'A-INV-1', 5000);
  await recordLine(h, 'BETA', 'B-INV-1', 9900);
  // The supplier logins, plus one bound to no partner at all.
  await h.provisionRole(A, 'u-alpha', 'supplier');
  await h.provisionRole(A, 'u-beta', 'supplier');
  await h.provisionRole(A, 'u-nobody', 'supplier');
  return h;
}

describe('supplier portal server-side scoping (M24-FR-01, §35)', () => {
  it('a supplier reads its OWN submissions and statement — the partner id from the session, not the request', async () => {
    const h = await cast();
    const subs = (await meSubmissions(h, 'u-alpha')).body as { partnerId: string; submissions: { submissionId: string }[] };
    expect(subs.partnerId).toBe('ALPHA');
    expect(subs.submissions.map((s) => s.submissionId)).toEqual(['A-ACK-1']);

    const stmt = (await meStatement(h, 'u-alpha')).body as { partnerId: string; accessible: boolean; closingMinor: number };
    expect(stmt).toMatchObject({ partnerId: 'ALPHA', accessible: true, closingMinor: 5000 });

    // The other supplier sees only ITS own — never ALPHA's — from the same route with a different session.
    const betaSubs = (await meSubmissions(h, 'u-beta')).body as { partnerId: string; submissions: { submissionId: string }[] };
    expect(betaSubs.partnerId).toBe('BETA');
    expect(betaSubs.submissions.map((s) => s.submissionId)).toEqual(['B-ACK-1']);
  });

  it('a request that names another partner is REFUSED and RECORDED — not silently emptied (probing, M24-FR-04)', async () => {
    const h = await cast();
    // Three distinct cross-partner reaches by ALPHA's login — the pattern a competitor probe makes.
    expect((await meSubmissions(h, 'u-alpha', { partnerId: 'BETA' })).status).toBe(403);
    expect(codeOf(await meSubmissions(h, 'u-alpha', { partnerId: 'BETA' }))).toBe('not_your_data');
    expect((await meSubmissions(h, 'u-alpha', { partnerId: 'GAMMA' })).status).toBe(403);
    expect((await meStatement(h, 'u-alpha', { partnerId: 'DELTA' })).status).toBe(403);

    // The buyer's tenant-wide probing view surfaces it — recorded, not lost (hard rule #6).
    const probing = (await h.request({ method: 'GET', path: '/v1/supplier-portal/probing', userId: 'u-owner', tenantId: A, query: { threshold: '3' } }))
      .body as { count: number; probing: { partnerId: string; userId: string; attempts: number }[] };
    const hit = probing.probing.find((p) => p.partnerId === 'ALPHA' && p.userId === 'u-alpha');
    expect(hit?.attempts).toBe(3);
  });

  it('a login bound to no supplier is refused — not a supplier login', async () => {
    const h = await cast();
    const res = await meSubmissions(h, 'u-nobody');
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('not_a_supplier_login');
  });

  it('the buyer does not use the /me routes — they lack supplier.portal.self and get a permission refusal', async () => {
    const h = await cast();
    // u-owner holds manage/submit/review (the BUYER authority) but NOT supplier.portal.self.
    expect((await meSubmissions(h, 'u-owner')).status).toBe(403);
    expect((await meStatement(h, 'u-owner')).status).toBe(403);
  });
});
