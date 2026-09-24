import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-11 M36-FR-04 (certification) — is a partner's connector still certified? A connector certified
// against v1 and running unchanged against v4 is not certified, it is old with a badge. This wires the
// tested certificationStatus engine over a durable, append-only connector-certification registry: a
// never-certified connector CANNOT run in production; a stale-version or expired one still runs but is
// flagged and dated. Register gated platform.partner.manage, the status read platform.partner.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const registerCert = (h: ApiHarness, user: string, id: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/platform/partners/certifications/${id}`, userId: user, tenantId: A, idempotencyKey: `cert-${id}`, body });
const status = (h: ApiHarness, user: string, partnerId: string, connectorId: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/platform/partners/${partnerId}/certifications/${connectorId}/status`, userId: user, tenantId: A, idempotencyKey: `st-${partnerId}-${connectorId}-${Math.random()}`, body });

const CURRENT_V2 = { currentVersions: [{ contract: 'orders', version: 'v2', status: 'current' }] };
const cert = (over: Record<string, unknown> = {}) => ({
  partnerId: 'acme', connectorId: 'acme-orders', certifiedOn: '2026-01-01',
  againstVersions: [{ contract: 'orders', version: 'v2' }], certifiedBy: 'u-admin', ...over,
});

async function admin(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-admin', 'platform_admin');
  await h.provisionRole(A, 'u-cash', 'cashier');
  return h;
}

describe('partner connector certification register + status (M36-FR-04)', () => {
  it('registers a certification and reports it CURRENT against the current contracts', async () => {
    const h = await admin();
    expect((await registerCert(h, 'u-admin', 'cert-1', cert())).status).toBe(201);
    const res = await status(h, 'u-admin', 'acme', 'acme-orders', CURRENT_V2);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verdict: 'current', mayRunInProduction: true, connectorId: 'acme-orders' });
  });

  it('reports a never-certified connector as unable to run in production', async () => {
    const h = await admin();
    const res = await status(h, 'u-admin', 'acme', 'never-certified-connector', CURRENT_V2);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verdict: 'never_certified', mayRunInProduction: false });
  });

  it('flags a connector certified against an OLD version as stale — old with a badge, still runs', async () => {
    const h = await admin();
    await registerCert(h, 'u-admin', 'cert-2', cert({ connectorId: 'acme-old', againstVersions: [{ contract: 'orders', version: 'v1' }] }));
    const res = await status(h, 'u-admin', 'acme', 'acme-old', CURRENT_V2); // current is v2
    const body = res.body as { verdict: string; mayRunInProduction: boolean; behind: { contract: string; certified: string; current: string }[] };
    expect(body.verdict).toBe('stale_version');
    expect(body.mayRunInProduction).toBe(true);
    expect(body.behind).toEqual([{ contract: 'orders', certified: 'v1', current: 'v2' }]);
  });

  it('gates the register on platform.partner.manage and the status on platform.partner.read', async () => {
    const h = await admin();
    expect((await registerCert(h, 'u-cash', 'cert-x', cert())).status).toBe(403);
    await registerCert(h, 'u-admin', 'cert-y', cert({ connectorId: 'acme-y' }));
    expect((await status(h, 'u-cash', 'acme', 'acme-y', CURRENT_V2)).status).toBe(403);
  });
});
