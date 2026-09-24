import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-11 M36-FR-04 (sandbox) — a partner sandbox holds generated data and NOTHING else (hard rule #7).
// Production data is refused outright, whatever the reason given — the temptation ("the partner needs
// realistic data to test against") ends with a copy of a retailer's customer list on a developer's
// laptop. This wires the tested seedSandbox engine over a durable sandbox-tenant registry: a seed with
// any production-origin record refuses the WHOLE seed; an expired sandbox refuses. Gated
// platform.partner.manage.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const registerSandbox = (h: ApiHarness, user: string, id: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/platform/partners/sandboxes/${id}`, userId: user, tenantId: A, idempotencyKey: `sb-${id}`, body });
const seed = (h: ApiHarness, user: string, id: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/platform/partners/sandboxes/${id}/seed`, userId: user, tenantId: A, idempotencyKey: `seed-${id}-${Math.random()}`, body });

async function admin(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-admin', 'platform_admin');
  await h.provisionRole(A, 'u-cash', 'cashier');
  return h;
}

const live = { partnerId: 'acme', createdOn: '2026-01-01', expiresOn: '2030-01-01' };

describe('partner sandbox register + seed (M36-FR-04)', () => {
  it('seeds a sandbox with generated records', async () => {
    const h = await admin();
    expect((await registerSandbox(h, 'u-admin', 'sb-1', live)).status).toBe(201);
    const res = await seed(h, 'u-admin', 'sb-1', { records: [{ recordId: 'r1', origin: 'generated' }, { recordId: 'r2', origin: 'generated' }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ seeded: true, outcome: 'seeded', records: 2 });
  });

  it('REFUSES the whole seed when any record came from production (hard rule #7)', async () => {
    const h = await admin();
    await registerSandbox(h, 'u-admin', 'sb-2', live);
    const res = await seed(h, 'u-admin', 'sb-2', { records: [{ recordId: 'r1', origin: 'generated' }, { recordId: 'r2', origin: 'production' }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ seeded: false, outcome: 'production_data_refused', records: 0 });
  });

  it('refuses a seed into an expired sandbox', async () => {
    const h = await admin();
    await registerSandbox(h, 'u-admin', 'sb-3', { ...live, expiresOn: '2026-01-02' }); // long past
    const res = await seed(h, 'u-admin', 'sb-3', { records: [{ recordId: 'r1', origin: 'generated' }] });
    expect(res.body).toMatchObject({ seeded: false, outcome: 'expired' });
  });

  it('404s a seed into an unknown sandbox, and gates register + seed on platform.partner.manage', async () => {
    const h = await admin();
    expect((await seed(h, 'u-admin', 'ghost', { records: [] })).status).toBe(404);
    expect((await registerSandbox(h, 'u-cash', 'sb-x', live)).status).toBe(403);
    await registerSandbox(h, 'u-admin', 'sb-y', live);
    expect((await seed(h, 'u-cash', 'sb-y', { records: [{ recordId: 'r1', origin: 'generated' }] })).status).toBe(403);
  });
});
