import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M34-FR-03 obligation LIFECYCLE on the live API — the pieces around the register: CLOSE an obligation
// that no longer applies (it leaves the alert list but is never deleted — hard rule #6), FILE evidence
// after registration (only ever added), and read the EVIDENCE GAPS (active obligations with nothing on
// file — a finding in itself). Gated compliance.obligation.manage (writes) / .read (the gap report).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const register = (h: ApiHarness, u: string, id: string, body: unknown) =>
  h.request({ method: 'POST', path: `/v1/compliance/obligations/${id}`, userId: u, tenantId: A, idempotencyKey: `co-${id}`, body });
const alerts = (h: ApiHarness, u: string, asOf: string) =>
  h.request({ method: 'GET', path: '/v1/compliance/alerts', userId: u, tenantId: A, query: { asOf } });
const status = (h: ApiHarness, u: string, asOf: string) =>
  h.request({ method: 'GET', path: '/v1/compliance/status', userId: u, tenantId: A, query: { asOf } });
const close = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/compliance/obligations/${id}/close`, userId: u, tenantId: A, idempotencyKey: key, body });
const attach = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/compliance/obligations/${id}/evidence`, userId: u, tenantId: A, idempotencyKey: key, body });
const gaps = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/compliance/evidence-gaps', userId: u, tenantId: A });

const LICENCE = { kind: 'licence', name: 'FSSAI licence', authority: 'FSSAI', reference: 'FSSAI-123', validFrom: '2025-09-01', expiresOn: '2026-09-01', responsible: { userId: 'u-mgr', name: 'A. Manager' } };
const SCALE_CERT = { kind: 'calibration', name: 'Scale stamping #3', authority: 'Legal Metrology', reference: 'LM-9', validFrom: '2025-08-01', expiresOn: '2026-08-01', responsible: { userId: 'u-mgr', name: 'A. Manager' } };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                // compliance.obligation.manage + .read
  await h.provisionRole(A, 'u-cash', 'cashier');  // none
  return h;
}

describe('compliance obligation lifecycle: close, evidence, evidence-gaps (M34-FR-03)', () => {
  it('closes an obligation off the alert list with a reason — kept, never deleted — and survives a restart', async () => {
    const h = await cast();
    await register(h, 'u-owner', 'scale3', SCALE_CERT); // expired 2026-08-01

    expect(((await alerts(h, 'u-owner', '2026-08-10')).body as { count: number }).count).toBe(1);
    expect(((await status(h, 'u-owner', '2026-08-10')).body as { compliant: boolean }).compliant).toBe(false);

    const closed = await close(h, 'u-owner', 'scale3', { reason: 'scale scrapped' }, 'close-1');
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', closedReason: 'scale scrapped' });

    // Off the alert list, and the shop is compliant again — no active expired obligation.
    expect(((await alerts(h, 'u-owner', '2026-08-10')).body as { count: number }).count).toBe(0);
    expect(((await status(h, 'u-owner', '2026-08-10')).body as { compliant: boolean }).compliant).toBe(true);

    // Re-closing is a no-op — the original reason is not churned (distinct key so it isn't a kernel replay).
    const again = await close(h, 'u-owner', 'scale3', { reason: 'again' }, 'close-2');
    expect(again.body).toMatchObject({ alreadyClosed: true, status: 'closed', closedReason: 'scale scrapped' });

    const h2 = apiHarness({ store: h.store });
    expect(((await alerts(h2, 'u-owner', '2026-08-10')).body as { count: number }).count).toBe(0);
  });

  it('surfaces an evidence gap, clears it when evidence is filed, and only ever adds evidence', async () => {
    const h = await cast();
    await register(h, 'u-owner', 'fssai', LICENCE); // registered with NO evidence

    const g = (await gaps(h, 'u-owner')).body as { count: number; obligations: { obligationId: string }[] };
    expect(g.count).toBe(1);
    expect(g.obligations[0]!.obligationId).toBe('fssai');

    const att = await attach(h, 'u-owner', 'fssai', { evidenceId: 'doc-1', description: 'FSSAI certificate PDF' }, 'ev-1');
    expect(att.status).toBe(201);
    expect(att.body).toMatchObject({ evidenceCount: 1 });

    expect(((await gaps(h, 'u-owner')).body as { count: number }).count).toBe(0);

    // The same evidenceId again is a no-op — evidence is added, never duplicated or replaced.
    const dup = await attach(h, 'u-owner', 'fssai', { evidenceId: 'doc-1', description: 'a different label' }, 'ev-2');
    expect(dup.body).toMatchObject({ alreadyOnFile: true, evidenceCount: 1 });

    const h2 = apiHarness({ store: h.store });
    expect(((await gaps(h2, 'u-owner')).body as { count: number }).count).toBe(0);
  });

  it('refuses a close with no reason, an unknown id, bad evidence, and gates on the compliance permissions', async () => {
    const h = await cast();
    await register(h, 'u-owner', 'fssai', LICENCE);

    expect(codeOf(await close(h, 'u-owner', 'fssai', {}, 'c-noreason'))).toBe('close_needs_a_reason');
    expect((await close(h, 'u-owner', 'ghost', { reason: 'x' }, 'c-ghost')).status).toBe(404);
    expect(codeOf(await attach(h, 'u-owner', 'fssai', { evidenceId: '', description: '' }, 'e-bad'))).toBe('evidence_needs_id_and_description');
    expect((await attach(h, 'u-owner', 'ghost', { evidenceId: 'd', description: 'd' }, 'e-ghost')).status).toBe(404);

    // A cashier holds no compliance.* → refused on write and on the gap report.
    expect((await close(h, 'u-cash', 'fssai', { reason: 'x' }, 'c-cash')).status).toBe(403);
    expect((await attach(h, 'u-cash', 'fssai', { evidenceId: 'd', description: 'd' }, 'e-cash')).status).toBe(403);
    expect((await gaps(h, 'u-cash')).status).toBe(403);
  });
});
