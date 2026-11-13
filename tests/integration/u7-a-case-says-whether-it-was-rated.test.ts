import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * U7 (OB-726) · M21-FR-04: the Customer satisfaction page could not say "already rated" — scores were readable only folded
 * into the report. `GET /v1/service/cases/:caseId/satisfaction` reads the scores recorded on ONE case (append-only, so
 * every one, oldest first): none yet is said as `rated: false`, never a 0 score; a case that does not exist is 404; the
 * read needs `service.case.read` (a cashier is refused).
 */
const A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CASE = { kind: 'complaint', customerRef: 'c1', priority: 'normal', summary: 'late delivery', assignedTo: 'u-agent' };

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-cash', 'cashier');
  return h;
}
const req = (h: ApiHarness, method: 'GET' | 'POST', path: string, u: string, body?: unknown, key?: string) =>
  h.request({ method, path, userId: u, tenantId: A, ...(key === undefined ? {} : { idempotencyKey: key }), ...(body === undefined ? {} : { body }) });

describe('U7 · one case says whether it was rated', () => {
  it('none yet → rated false; once rated → the score, who and when; unknown case 404; a cashier refused', async () => {
    const h = await seeded();
    expect((await req(h, 'POST', '/v1/service/cases/k1', 'u-mgr', CASE, 'open-k1')).status).toBeLessThan(300);
    expect((await req(h, 'POST', '/v1/service/cases/k1/resolution', 'u-mgr', { resolution: 'sorted' }, 'res-k1')).status).toBeLessThan(300);
    const read = () => req(h, 'GET', '/v1/service/cases/k1/satisfaction', 'u-mgr');
    const before = await read();
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ caseId: 'k1', rated: false, scores: [] });
    expect((await req(h, 'POST', '/v1/service/cases/k1/satisfaction', 'u-mgr', { customerRef: 'c1', score: 4, comment: 'fine' }, 'sat-k1')).status).toBe(201);
    const after = (await read()).body as { rated: boolean; scores: { score: number; customerRef: string; at: string; comment?: string }[] };
    expect(after.rated).toBe(true);
    expect(after.scores).toHaveLength(1);
    expect(after.scores[0]).toMatchObject({ score: 4, customerRef: 'c1', comment: 'fine' });
    expect((await req(h, 'GET', '/v1/service/cases/ghost/satisfaction', 'u-mgr')).status).toBe(404);
    expect((await req(h, 'GET', '/v1/service/cases/k1/satisfaction', 'u-cash')).status).toBe(403);
  });
});
