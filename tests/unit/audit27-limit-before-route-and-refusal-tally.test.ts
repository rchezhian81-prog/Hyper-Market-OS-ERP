import { describe, it, expect } from 'vitest';
import {
  buildRouter, handle, MemoryIdempotencyStore, TokenBucketRateLimiter, AuditedRefusalTally, parseRefusalTallyRow,
  type Route, type HttpRequest, type Principal, type AuditSink,
} from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';


/** The tally, built where the kernel has one (before the fix it had none: then nothing is tallied and every refusal is written). */
const tallyOver = (sink: AuditSink, cfg: { windowSeconds: number; maxKeys: number }, now: () => number): AuditedRefusalTally =>
  typeof AuditedRefusalTally === 'function' ? new AuditedRefusalTally(sink, cfg, now) : ({ flush: async () => {} } as unknown as AuditedRefusalTally);
const parse = (r: { readonly path: string; readonly permission: string }) => (typeof parseRefusalTallyRow === 'function' ? parseRefusalTallyRow(r) : undefined);

/**
 * **Audit 27 Nov 2026, item 2 — the per-address limit runs before route matching, and refusals of callers nobody signed
 * in as are counted, not written one database row each.**
 *
 * Before: a request to a path with no route was answered 404 BEFORE the per-address limit ran, so a scanner could hammer
 * unknown paths at full speed; and every refused request — 401, 404, 429 — wrote its own audit row, so a flood of
 * anonymous junk was a flood of database writes (one per request, all serialised on the one 'unauthenticated' chain).
 *
 * Now (hard rule 6 kept — nothing is dropped, the count is the evidence):
 *   • the per-address limit runs first, for every request, matched or not;
 *   • a refusal of a caller who is not signed in is counted per (status, reason, source network) per window: the FIRST
 *     of each is written at once (so a crash can never lose that it happened), the rest as ONE row with the count when the
 *     window closes;
 *   • every refusal of a SIGNED-IN person is still its own row, and so is every refused sign-in (a credential that was
 *     presented and not believed — a failed login is evidence on its own, M02 / M34-FR-01), and every 5xx.
 */

const ACCESS = new AccessControl(
  [{ id: 'cashier', name: 'Cashier', permissions: ['pos.sale.read'] }],
  [{ userId: 'u-meena', roleId: 'cashier', branchScope: ['b-main'] }],
);
const PRINCIPAL: Principal = { tenantId: 't-sre', userId: 'u-meena', branchId: 'b-main' };
const ROUTES: Route[] = [
  { api: 'API-05', method: 'GET', path: '/v1/sales', permission: 'pos.sale.read', handler: () => ({ status: 200, body: { ok: true } }) },
  { api: 'API-05', method: 'GET', path: '/v1/finance', permission: 'finance.read', handler: () => ({ status: 200, body: { ok: true } }) },
];
type Row = Parameters<AuditSink['record']>[0];

function kernel(over: Record<string, unknown> = {}) {
  const built = buildRouter(ROUTES);
  if (!built.ok) throw new Error('router');
  let n = 0;
  return {
    router: built.router!, authenticate: (t: string) => (t === 'good' ? PRINCIPAL : undefined), access: ACCESS,
    idempotency: new MemoryIdempotencyStore(), newTraceId: () => `trace-${(n += 1)}`, ...over,
  };
}
const recorder = () => { const rows: Row[] = []; return { rows, sink: { record: (r: Row) => { rows.push(r); } } satisfies AuditSink }; };
const req = (over: Partial<HttpRequest> = {}): HttpRequest => ({ method: 'GET', path: '/v1/sales', headers: {}, clientIp: '203.0.113.7', ...over });

describe('audit 27 Nov item 2 — the per-address limit runs before the route is looked up', () => {
  it('a scanner hammering paths that do not exist is refused 429 once its allowance is spent', async () => {
    const k = kernel({ rateLimit: new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 0.0001 }, () => 0) });
    for (let i = 0; i < 3; i += 1) expect((await handle(k, req({ path: `/v1/nothing-here-${i}` }))).status).toBe(404);
    const fourth = await handle(k, req({ path: '/v1/nothing-here-4' }));
    expect(fourth.status, 'an unmatched path must spend the same allowance').toBe(429);
    expect(fourth.headers['retry-after']).toBeDefined();
    // Another address is untouched.
    expect((await handle(k, req({ path: '/v1/nothing-here-5', clientIp: '198.51.100.2' }))).status).toBe(404);
  });
});

describe('audit 27 Nov item 2 — anonymous refusals are counted, not one database row each', () => {
  it('300 anonymous refusals (no sign-in, unknown paths) become a handful of rows that still add up to 300', async () => {
    let nowMs = 1_000_000;
    const { rows, sink } = recorder();
    const refusalTally = tallyOver(sink, { windowSeconds: 60, maxKeys: 1000 }, () => nowMs);
    const k = kernel({ audit: sink, refusalTally });
    for (let i = 0; i < 150; i += 1) expect((await handle(k, req({ path: `/v1/x-${i}` }))).status).toBe(404);
    for (let i = 0; i < 150; i += 1) expect((await handle(k, req())).status).toBe(401); // no token at all
    expect(rows.length, 'only the first of each kind is written while the window is open').toBe(2);

    nowMs += 61_000;
    await refusalTally.flush();
    expect(rows.length).toBe(4);
    const total = rows.map((r) => parse(r)?.count ?? 1).reduce((a, b) => a + b, 0);
    expect(total, 'every refusal is still on the record, as a count').toBe(300);
    const agg = rows.map(parse).filter((x) => x !== undefined);
    expect(agg.map((a) => [a!.status, a!.code, a!.source, a!.count]).sort()).toEqual([[401, 'unauthenticated', '203.0.113.x', 149], [404, 'not_found', '203.0.113.x', 149]].sort());
    for (const r of rows) expect(r.tenantId).toBe('unauthenticated');
  });

  it('a SIGNED-IN person\'s refusals and every refused sign-in are still one row each', async () => {
    const { rows, sink } = recorder();
    const refusalTally = tallyOver(sink, { windowSeconds: 60, maxKeys: 1000 }, () => 0);
    const k = kernel({ audit: sink, refusalTally });
    for (let i = 0; i < 5; i += 1) expect((await handle(k, req({ path: '/v1/finance', headers: { authorization: 'Bearer good' } }))).status).toBe(403);
    for (let i = 0; i < 5; i += 1) expect((await handle(k, req({ headers: { authorization: 'Bearer forged' } }))).status).toBe(401);
    expect(rows.filter((r) => r.userId === 'u-meena' && r.status === 403)).toHaveLength(5);
    expect(rows.filter((r) => r.tenantId === 'unauthenticated' && r.status === 401)).toHaveLength(5);
    expect(rows.every((r) => parse(r) === undefined)).toBe(true);
  });

  it('a flood from very many networks is capped: past the limit they share one "other" count, never one row each', async () => {
    const { rows, sink } = recorder();
    const refusalTally = tallyOver(sink, { windowSeconds: 60, maxKeys: 10 }, () => 0);
    const k = kernel({ audit: sink, refusalTally });
    for (let i = 0; i < 100; i += 1) await handle(k, req({ clientIp: `10.${i}.0.1` }));
    expect(rows.length).toBe(11); // ten networks' first rows, and one for "other"
    await refusalTally.flush();
    expect(rows.map((r) => parse(r)?.count ?? 1).reduce((a, b) => a + b, 0)).toBe(100);
  });
});
