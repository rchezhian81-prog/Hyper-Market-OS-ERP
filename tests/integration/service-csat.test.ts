import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Customer satisfaction, end to end (M21-FR-04 · CSAT · P-08, API-06). A customer rates a case that has
// been DEALT WITH — a score on an open case is a complaint in another field, not satisfaction. The manager's
// report carries CSAT with its RESPONSE RATE beside it, because 4.8 from six replies out of four hundred
// cases is six people, not a satisfaction score, and the six who reply are rarely the ones who left quietly.
// Append-only, gated service.case.manage (record) / .read (report).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CASE = { kind: 'complaint', customerRef: 'c1', priority: 'normal', summary: 'late delivery', assignedTo: 'u-agent' };

const open = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${id}`, userId: u, tenantId: A, idempotencyKey: `open-${id}`, body: CASE });
const resolve = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${id}/resolution`, userId: u, tenantId: A, idempotencyKey: `res-${id}`, body: { resolution: 'sorted' } });
const rate = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/service/cases/${id}/satisfaction`, userId: u, tenantId: A, idempotencyKey: key ?? `sat-${id}`, body });
const report = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/service/report', userId: u, tenantId: A });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // service.case.manage + .read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('CSAT capture + the service report (M21-FR-04)', () => {
  it('rates resolved cases and reports CSAT beside its response rate', async () => {
    const h = await seeded();
    await open(h, 'u-mgr', 'k1'); await resolve(h, 'u-mgr', 'k1');
    await open(h, 'u-mgr', 'k2'); await resolve(h, 'u-mgr', 'k2');
    await open(h, 'u-mgr', 'k3'); // left open, unrated
    expect((await rate(h, 'u-mgr', 'k1', { customerRef: 'c1', score: 5, comment: 'quick and kind' })).status).toBe(201);
    expect((await rate(h, 'u-mgr', 'k2', { customerRef: 'c2', score: 3 })).status).toBe(201);

    const r = (await report(h, 'u-owner')).body as { cases: number; resolved: number; csatHundredths: number; responseRateBps: number };
    // CSAT = (5 + 3) / 2 = 4.00 → 400 hundredths; 2 responses over 3 cases = 66.67% → 6667 bps.
    expect(r).toMatchObject({ cases: 3, resolved: 2, csatHundredths: 400, responseRateBps: 6667 });
  });

  it('refuses a score on an unresolved case, an out-of-range score, and an unknown case', async () => {
    const h = await seeded();
    await open(h, 'u-mgr', 'k1');
    expect(codeOf(await rate(h, 'u-mgr', 'k1', { customerRef: 'c1', score: 4 }))).toBe('case_not_resolved');
    await resolve(h, 'u-mgr', 'k1');
    expect(codeOf(await rate(h, 'u-mgr', 'k1', { customerRef: 'c1', score: 0 }, 'sat-lo'))).toBe('not_readable_as_a_score');
    expect(codeOf(await rate(h, 'u-mgr', 'k1', { customerRef: 'c1', score: 6 }, 'sat-hi'))).toBe('not_readable_as_a_score');
    expect((await rate(h, 'u-mgr', 'ghost', { customerRef: 'c1', score: 4 }, 'sat-ghost')).status).toBe(404);
  });

  it('is gated to service-desk staff and reports no_responses honestly when nobody has rated', async () => {
    const h = await seeded();
    await open(h, 'u-mgr', 'k1'); await resolve(h, 'u-mgr', 'k1');
    expect((await rate(h, 'u-cash', 'k1', { customerRef: 'c1', score: 5 }, 'sat-cash')).status).toBe(403);
    expect((await report(h, 'u-cash')).status).toBe(403);
    const r = (await report(h, 'u-owner')).body as { cases: number; resolved: number; csatHundredths: string };
    expect(r).toMatchObject({ cases: 1, resolved: 1, csatHundredths: 'no_responses' });
  });

  it('keeps recorded scores across a restart', async () => {
    const h = await seeded();
    await open(h, 'u-mgr', 'k1'); await resolve(h, 'u-mgr', 'k1');
    await rate(h, 'u-mgr', 'k1', { customerRef: 'c1', score: 5 });
    const restarted = apiHarness({ store: h.store });
    const r = (await report(restarted, 'u-owner')).body as { csatHundredths: number };
    expect(r.csatHundredths).toBe(500);
  });
});
