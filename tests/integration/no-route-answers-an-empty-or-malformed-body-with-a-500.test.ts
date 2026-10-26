import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { servedRoutes } from '../support/derived-contract';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { OPTIONAL_FEATURES } from '../../packages/tenant/src/tenant';

/**
 * **P-08 "no silent failure" — no write route answers an empty or malformed body with a 500.** A 500 tells the person
 * nothing: not what was wrong, not whether anything was saved. Every write route on the served surface is sent `{}`, a
 * body that is not an object (`[]`, `"text"`, `null`), and no body at all, by a person holding every staff role; none may
 * answer 500 — a missing or unreadable body is a NAMED refusal (400 / 422, or the route's own 403 / 404 / 409). Synthetic
 * data; in memory (the shape of the body is judged before anything is read from the store).
 */

const STAFF = ['owner', 'store_manager', 'internal_committee', 'cashier', 'platform_admin', 'accountant', 'chartered_accountant'];
const BODIES: readonly { readonly name: string; readonly body?: unknown }[] = [
  { name: '{}', body: {} }, { name: '[]', body: [] }, { name: '"text"', body: 'text' }, { name: 'null', body: null }, { name: 'no body' },
];

describe('P-08: no write route answers an empty or malformed body with a 500', () => {
  let h: ApiHarness;
  let T: string;
  beforeAll(async () => {
    h = apiHarness();
    T = randomUUID();
    for (const r of ROLE_CATALOGUE) if (STAFF.includes(r.id)) await h.provisionRole(T, 'u-all', r.id);
    // And every OTHER role (machines, portals) on a second identity, so a route only they reach is probed too.
    for (const r of ROLE_CATALOGUE) if (!STAFF.includes(r.id)) await h.provisionRole(T, 'u-other', r.id);
    for (const f of OPTIONAL_FEATURES) await h.enableFeature(T, f);
  });

  it('every write route refuses by name, never 500', async () => {
    const fivehundreds: string[] = [];
    let checked = 0;
    for (const r of servedRoutes()) {
      if (r.method === 'GET') continue;
      for (const userId of ['u-all', 'u-other']) for (const b of BODIES) {
        checked += 1;
        const res = await h.request({
          method: r.method, path: r.path.replace(/:[A-Za-z0-9_]+/g, 'p08-x'), userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`,
          ...(b.name === 'no body' ? {} : { body: b.body }),
        });
        if (res.status === 500) fivehundreds.push(`${r.method} ${r.path} as ${userId} with ${b.name} → ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      }
    }
    expect(checked).toBeGreaterThan(6000);
    expect(fivehundreds, 'a route answered a missing or malformed body with a 500').toEqual([]);
  }, 600_000);

  it('the two finance routes the audit named refuse an empty or malformed body by name', async () => {
    for (const body of [{}, [], 'text', null, { lines: 'x' }, { entryId: 'j-1', lines: [{}] }]) {
      const j = await h.request({ method: 'POST', path: '/v1/finance/journals', userId: 'u-all', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
      expect([400, 422], `journals ${JSON.stringify(body)}: ${j.status} ${JSON.stringify(j.body)}`).toContain(j.status);
      expect((j.body as { error?: { code?: string } }).error?.code, JSON.stringify(j.body)).toBeTruthy();
    }
    for (const body of [{}, [], 'text', null, { approvalId: 12 }]) {
      const c = await h.request({ method: 'POST', path: '/v1/finance/periods/2026-09/close', userId: 'u-all', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
      expect([400, 422], `close ${JSON.stringify(body)}: ${c.status} ${JSON.stringify(c.body)}`).toContain(c.status);
      expect((c.body as { error?: { code?: string } }).error?.code, JSON.stringify(c.body)).toBeTruthy();
    }
  }, 60_000);
});
