import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M34-FR-03 (+ ratified R2 B7 weighing-cert alerts, B10 FSSAI-licence alerts): the compliance
// obligation register on the live API — register a licence/certificate/scale-stamping with its named
// owner and expiry, then read what needs attention (worst first) and whether the shop is compliant.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const register = (h: ApiHarness, userId: string, id: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/compliance/obligations/${id}`, userId, tenantId: A, idempotencyKey: `co-${id}`, body });
const alerts = (h: ApiHarness, userId: string, asOf: string) =>
  h.request({ method: 'GET', path: '/v1/compliance/alerts', userId, tenantId: A, query: { asOf } });
const status = (h: ApiHarness, userId: string, asOf: string) =>
  h.request({ method: 'GET', path: '/v1/compliance/status', userId, tenantId: A, query: { asOf } });

const LICENCE = { kind: 'licence', name: 'FSSAI licence', authority: 'FSSAI', reference: 'FSSAI-123', validFrom: '2025-09-01', expiresOn: '2026-09-01', responsible: { userId: 'u-mgr', name: 'A. Manager' } };
const SCALE_CERT = { kind: 'calibration', name: 'Scale stamping #3', authority: 'Legal Metrology', reference: 'LM-9', validFrom: '2025-08-01', expiresOn: '2026-08-01', responsible: { userId: 'u-mgr', name: 'A. Manager' } };

describe('compliance obligation register (M34-FR-03 / B7 / B10)', () => {
  it('registers obligations and surfaces expiring/expired alerts worst-first', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect((await register(h, 'u-owner', 'fssai', LICENCE)).status).toBe(201);   // expires 2026-09-01
    expect((await register(h, 'u-owner', 'scale3', SCALE_CERT)).status).toBe(201); // expired 2026-08-01

    const body = (await alerts(h, 'u-owner', '2026-08-10')).body as { count: number; alerts: { obligationId: string; level: string; daysRemaining: number; responsible: { name: string } }[] };
    expect(body.count).toBe(2);
    // Worst first: the expired scale certificate before the still-valid-but-warning licence.
    expect(body.alerts[0]!.level).toBe('expired');
    expect(body.alerts[0]!.obligationId).toBe('scale3');
    expect(body.alerts[0]!.responsible.name).toBe('A. Manager');
    expect(body.alerts[1]!.level).toBe('warning'); // licence 22 days out
  });

  it('reports the shop not compliant while a certificate is expired, and compliant once only future ones remain', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await register(h, 'u-owner', 'scale3', SCALE_CERT); // expired 2026-08-01

    expect(((await status(h, 'u-owner', '2026-08-10')).body as { compliant: boolean }).compliant).toBe(false);
    // Before the certificate lapses, it is compliant.
    expect(((await status(h, 'u-owner', '2026-07-01')).body as { compliant: boolean }).compliant).toBe(true);
  });

  it('refuses an obligation with no named responsible person, and a bad kind', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await register(h, 'u-owner', 'x1', { ...LICENCE, responsible: { userId: '', name: '' } })).status).toBe(400);
    expect((await register(h, 'u-owner', 'x2', { ...LICENCE, kind: 'made_up' })).status).toBe(400);
  });

  it('gates registration and reading on the compliance permissions', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no compliance.* permissions
    expect((await register(h, 'u-cash', 'fssai', LICENCE)).status).toBe(403);
    expect((await alerts(h, 'u-cash', '2026-08-10')).status).toBe(403);
  });
});
