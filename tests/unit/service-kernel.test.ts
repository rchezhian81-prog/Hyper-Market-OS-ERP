import { describe, it, expect } from 'vitest';
import {
  buildRouter, Router, handle, apiError, ApiError, scanOutbound, looksLikeACardNumber,
  hashRequest, MemoryIdempotencyStore, TokenBucketRateLimiter, BackoffAuthThrottle,
  type Route, type HttpRequest, type Principal, type AuditSink, type Method,
} from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';

// §30 API conventions · §31.1 idempotency · §27.1 the three-part error · SEC-02/03/12 ·
// hard rules #3 and #4 · OB-01 tenant isolation. The foundation every API-01…13 endpoint runs in.

const ok = (body: unknown = { ok: true }) => () => ({ status: 200, body });

const route = (over: Partial<Route> = {}): Route => ({
  api: 'API-05', method: 'GET', path: '/v1/sales', permission: 'pos.sale.read',
  handler: ok(), ...over,
});

const ACCESS = new AccessControl(
  [{ id: 'cashier', name: 'Cashier', permissions: ['pos.sale.read', 'pos.sale.create'] }],
  [{ userId: 'u-meena', roleId: 'cashier', branchScope: ['b-main'] }],
);

const PRINCIPAL: Principal = { tenantId: 't-sre', userId: 'u-meena', branchId: 'b-main' };

const kernel = (routes: readonly Route[], over: Partial<Parameters<typeof handle>[0]> = {}) => {
  const built = buildRouter(routes);
  if (!built.ok) throw new Error(built.refusals.map((r) => r.detail).join('; '));
  return {
    router: built.router!, authenticate: (t: string) => (t === 'good' ? PRINCIPAL : undefined),
    access: ACCESS, idempotency: new MemoryIdempotencyStore(),
    newTraceId: () => 'trace-1', ...over,
  };
};

const req = (over: Partial<HttpRequest> = {}): HttpRequest => ({
  method: 'GET', path: '/v1/sales', headers: { authorization: 'Bearer good' }, ...over,
});

describe('the surface is checked when it is registered, not when it is called', () => {
  it('REFUSES an unversioned path', () => {
    const r = new Router().add(route({ path: '/sales' }));
    expect(r.refusedBecause).toBe('path_carries_no_version');
    expect(r.detail).toContain('a client we cannot redeploy in step');
  });

  it('REFUSES an endpoint that declares no permission', () => {
    const r = new Router().add(route({ permission: '' }));
    expect(r.refusedBecause).toBe('route_without_permission');
    expect(r.detail).toContain('has not been designed');
  });

  it('REFUSES a write that does not declare idempotency', () => {
    // The till resends what it could not confirm. A write that is not safe to repeat is a sale
    // banked twice — so this fails at startup, not on the one request that exercises it.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as Method[]) {
      const r = new Router().add(route({ method, permission: 'pos.sale.create' }));
      expect(r.refusedBecause, method).toBe('write_without_idempotency');
    }
    expect(new Router().add(route({ method: 'POST', permission: 'pos.sale.create', idempotent: true })).ok).toBe(true);
  });

  it('REFUSES a read that claims a guarantee nothing is applying to it', () => {
    const r = new Router().add(route({ idempotent: true }));
    expect(r.refusedBecause).toBe('read_declaring_idempotency');
    expect(r.detail).toContain('which is worse than not having it');
  });

  it('REFUSES two routes for one address', () => {
    const router = new Router();
    expect(router.add(route()).ok).toBe(true);
    const r = router.add(route({ handler: ok({ different: true }) }));
    expect(r.refusedBecause).toBe('two_routes_for_one_address');
    expect(r.detail).toContain('dead code that somebody believes is live');
  });

  it('names EVERY malformed route at once, so one restart shows the whole problem', () => {
    const built = buildRouter([
      route({ path: '/sales' }),
      route({ path: '/v1/a', permission: '' }),
      route({ path: '/v1/b', method: 'POST' }),
    ]);
    expect(built.ok).toBe(false);
    expect(built.refusals.map((r) => r.refusedBecause))
      .toEqual(['path_carries_no_version', 'route_without_permission', 'write_without_idempotency']);
    expect(built.router).toBeUndefined();
  });

  it('matches path parameters', () => {
    const built = buildRouter([route({ path: '/v1/products/:id/prices/:priceId' })]);
    const m = built.router!.match('GET', '/v1/products/P-1/prices/PR-9');
    expect(m?.params).toEqual({ id: 'P-1', priceId: 'PR-9' });
  });
});

describe('an error tells a person the one thing they need', () => {
  it('REFUSES to be built without saying whether the data was saved', () => {
    // A cashier whose tender times out does not need a stack trace. They need to know whether the
    // customer has been charged.
    try {
      apiError(500, {
        code: 'x', whatHappened: 'Something went wrong here.',
        wasItSaved: 'probably' as never, nextSafeAction: 'Try again later please.',
      });
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).body.code).toBe('no_statement_of_whether_it_saved');
      // The error about the error is itself complete, or it has the same defect.
      expect((e as ApiError).body.wasItSaved).toBe('unknown');
      expect((e as ApiError).body.nextSafeAction.length).toBeGreaterThan(10);
    }
  });

  it('REFUSES an error with no next action, and one with no description', () => {
    const bad = (over: Record<string, unknown>): string => {
      try {
        apiError(400, {
          code: 'x', whatHappened: 'The thing did not work.',
          wasItSaved: 'not_saved', nextSafeAction: 'Do the other thing.', ...over,
        });
        return 'not refused';
      } catch (e) { return (e as ApiError).body.code; }
    };
    expect(bad({ nextSafeAction: '' })).toBe('no_next_safe_action');
    expect(bad({ whatHappened: 'oops' })).toBe('no_description_of_what_happened');
  });

  it('answers "unknown" when a handler throws, because that is the truth', async () => {
    const k = kernel([route({ handler: () => { throw new Error('boom'); } })]);
    const res = await handle(k, req());
    expect(res.status).toBe(500);
    const body = res.body as { error: { wasItSaved: string; nextSafeAction: string } };
    expect(body.error.wasItSaved).toBe('unknown');
    // Saying "failed" here is the lie that causes the double charge.
    expect(body.error.nextSafeAction).toContain('Do not simply repeat it');
  });
});

describe('nobody reaches a handler without being who they say and being allowed', () => {
  it('refuses a request with no bearer token', async () => {
    const res = await handle(kernel([route()]), req({ headers: {} }));
    expect(res.status).toBe(401);
  });

  it('refuses a token the authenticator does not recognise', async () => {
    const res = await handle(kernel([route()]), req({ headers: { authorization: 'Bearer forged' } }));
    expect(res.status).toBe(401);
  });

  it('refuses a caller without the permission the route declares', async () => {
    const res = await handle(kernel([route({ permission: 'finance.period.close' })]), req());
    expect(res.status).toBe(403);
    expect((res.body as { error: { whatHappened: string } }).error.whatHappened)
      .toContain('finance.period.close');
  });

  it('checks permission BEFORE it looks at the body', async () => {
    // A caller who may not use an endpoint must not learn anything from how it answers a
    // malformed payload.
    let handlerRan = false;
    const k = kernel([route({
      method: 'POST', path: '/v1/sales', permission: 'finance.period.close', idempotent: true,
      handler: () => { handlerRan = true; return { status: 200, body: {} }; },
    })]);
    const res = await handle(k, req({ method: 'POST', body: { rubbish: true } }));
    expect(res.status).toBe(403);
    expect(handlerRan).toBe(false);
  });
});

describe('the surface refuses a flood and a brute force (audit FND-03)', () => {
  it('caps a per-IP flood with a 429 and a Retry-After', async () => {
    // capacity 1, negligible refill: the first request from an IP gets through, the second is refused
    // before authentication even runs.
    const rateLimit = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.0001 }, () => 0);
    const k = kernel([route()], { rateLimit });
    const from = { clientIp: '203.0.113.7' };

    expect((await handle(k, req(from))).status).toBe(200);
    const refused = await handle(k, req(from));
    expect(refused.status).toBe(429);
    expect((refused.body as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(refused.headers['retry-after']).toBeDefined();
  });

  it('gives each source its own budget — one IP\'s flood does not refuse another', async () => {
    // Two shops on two connections (distinct tenants, so the per-tenant bucket is not what binds).
    const rateLimit = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.0001 }, () => 0);
    const authenticate = (t: string): Principal | undefined =>
      t === 'a' ? { tenantId: 't-a', userId: 'u-meena', branchId: 'b-main' }
        : t === 'b' ? { tenantId: 't-b', userId: 'u-meena', branchId: 'b-main' } : undefined;
    const k = kernel([route()], { rateLimit, authenticate });
    const a = { clientIp: '203.0.113.1', headers: { authorization: 'Bearer a' } };
    const b = { clientIp: '203.0.113.2', headers: { authorization: 'Bearer b' } };

    expect((await handle(k, req(a))).status).toBe(200);
    expect((await handle(k, req(a))).status).toBe(429); // first IP spent
    expect((await handle(k, req(b))).status).toBe(200); // second, a different source, untouched
  });

  it('locks a source out of sign-in after repeated failures, then a valid token too', async () => {
    let nowMs = 0;
    const authThrottle = new BackoffAuthThrottle(
      { threshold: 2, baseCooldownSeconds: 30, maxCooldownSeconds: 900 }, () => nowMs,
    );
    const k = kernel([route()], { authThrottle });
    const from = { clientIp: '203.0.113.9' };
    const bad = { ...from, headers: { authorization: 'Bearer forged' } };

    expect((await handle(k, req(bad))).status).toBe(401); // failure 1
    expect((await handle(k, req(bad))).status).toBe(401); // failure 2 → now locked
    // Even a VALID token is refused while the source is locked — the brute-force run is stopped.
    const locked = await handle(k, req(from));
    expect(locked.status).toBe(429);
    expect((locked.body as { error: { code: string } }).error.code).toBe('too_many_sign_in_attempts');
    expect(locked.headers['retry-after']).toBeDefined();

    // After the cooldown, a valid token works again.
    nowMs += 30_000;
    expect((await handle(k, req(from))).status).toBe(200);
  });

  it('a genuine sign-in clears the failure count before it reaches a lockout', async () => {
    const authThrottle = new BackoffAuthThrottle(
      { threshold: 2, baseCooldownSeconds: 30, maxCooldownSeconds: 900 }, () => 0,
    );
    const k = kernel([route()], { authThrottle });
    const from = { clientIp: '203.0.113.5' };

    expect((await handle(k, req({ ...from, headers: { authorization: 'Bearer forged' } }))).status).toBe(401);
    expect((await handle(k, req(from))).status).toBe(200); // a good sign-in clears the one failure
    // One more failure is only the first again, so no lockout yet.
    expect((await handle(k, req({ ...from, headers: { authorization: 'Bearer forged' } }))).status).toBe(401);
    expect((await handle(k, req(from))).status).toBe(200);
  });
});

describe('a write is safe to repeat, which is what the till depends on', () => {
  const writeRoute = (handler = ok({ saleId: 'S-1' })): Route => ({
    api: 'API-05', method: 'POST', path: '/v1/sales', permission: 'pos.sale.create',
    idempotent: true, handler,
  });

  it('refuses a write with no Idempotency-Key', async () => {
    const res = await handle(kernel([writeRoute()]), req({ method: 'POST', body: { totalMinor: 25_000 } }));
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('idempotency_key_missing');
  });

  it('returns the FIRST result when the same request is resent', async () => {
    let calls = 0;
    const k = kernel([writeRoute(() => { calls += 1; return { status: 201, body: { saleId: `S-${calls}` } }; })]);
    const r = req({
      method: 'POST', body: { totalMinor: 25_000 },
      headers: { authorization: 'Bearer good', 'idempotency-key': 'k-1' },
    });

    const first = await handle(k, r);
    const second = await handle(k, r);
    expect(calls).toBe(1);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(first.headers['idempotent-replay']).toBeUndefined();
  });

  it('REFUSES a different request under a key already used — never the stored answer', async () => {
    // The failure a naive cache produces: a sale of 400 sent under the key of a sale of 250
    // reports success and banks 250. A silent wrong answer is worse than an error.
    const k = kernel([writeRoute()]);
    const headers = { authorization: 'Bearer good', 'idempotency-key': 'k-2' };
    await handle(k, req({ method: 'POST', body: { totalMinor: 25_000 }, headers }));
    const res = await handle(k, req({ method: 'POST', body: { totalMinor: 40_000 }, headers }));
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('idempotency_key_reused');
  });

  it('treats a body with reordered keys as the same request, not a different one', () => {
    expect(hashRequest('POST', '/v1/sales', { a: 1, b: 2 }))
      .toBe(hashRequest('POST', '/v1/sales', { b: 2, a: 1 }));
    expect(hashRequest('POST', '/v1/sales', { a: 1 }))
      .not.toBe(hashRequest('POST', '/v1/sales', { a: 2 }));
  });

  it('scopes keys by tenant, so one shop cannot collide with another', async () => {
    const store = new MemoryIdempotencyStore();
    store.put('t-a', 'k', { requestHash: 'h', status: 200, body: { from: 'a' } });
    expect(store.get('t-b', 'k')).toBeUndefined();
    expect(store.get('t-a', 'k')?.body).toEqual({ from: 'a' });
  });

  it('does not bank a reply that the outbound guards refused', async () => {
    // Storing it would make every replay return the reply that must not be sent.
    const k = kernel([writeRoute(() => ({ status: 201, body: { tenantId: 't-other' } }))]);
    const headers = { authorization: 'Bearer good', 'idempotency-key': 'k-3' };
    const first = await handle(k, req({ method: 'POST', body: { x: 1 }, headers }));
    expect(first.status).toBe(500);
    expect(await k.idempotency.get('t-sre', 'k-3')).toBeUndefined();
  });
});

describe('two things never leave the process', () => {
  it('detects a card number', () => {
    expect(looksLikeACardNumber('4111111111111111')).toBe(true);  // Visa
    expect(looksLikeACardNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeACardNumber('4111-1111-1111-1111')).toBe(true);
    expect(looksLikeACardNumber('5555555555554444')).toBe(true);  // Mastercard
    expect(looksLikeACardNumber('378282246310005')).toBe(true);   // Amex, 15 digits
    expect(looksLikeACardNumber('4111111111111112')).toBe(false); // fails Luhn
    expect(looksLikeACardNumber('1234567812345670')).toBe(false); // Luhn-valid, no issuer prefix
  });

  it('is SILENT on the retail traffic it has to live in', () => {
    // The defect the catalogue service found on day one: EAN-13's check digit is computed the same
    // alternating way Luhn is, so about one barcode in ten passes Luhn by chance. The first
    // version of this guard did 13–19 digits plus Luhn, and it blocked a catalogue pack — the
    // single most important response in the system. A guard that fires on ordinary data gets
    // switched off, and a switched-off guard is worse than none because everyone believes it runs.
    const eans = Array.from({ length: 200 }, (_, i) => `890000000${String(i).padStart(4, '0')}`);
    expect(eans.filter(looksLikeACardNumber)).toEqual([]);

    expect(looksLikeACardNumber('8901234567890')).toBe(false);    // EAN-13, India GS1
    expect(looksLikeACardNumber('40123456789012')).toBe(false);   // ITF-14 carton code
    expect(looksLikeACardNumber('012345678905')).toBe(false);     // UPC-A
    expect(looksLikeACardNumber('AA330426012345X')).toBe(false);  // GST acknowledgement
    expect(looksLikeACardNumber('123')).toBe(false);
  });

  it('REFUSES to send a response carrying card data (hard rule #3)', async () => {
    const k = kernel([route({ handler: ok({ tender: { ref: '4111111111111111' } }) })]);
    const res = await handle(k, req());
    expect(res.status).toBe(500);
    const err = (res.body as { error: { code: string; whatHappened: string } }).error;
    expect(err.code).toBe('card_data_in_response');
    expect(err.whatHappened).toContain('the fact it got this far is the finding');
  });

  it('REFUSES to send another tenant\'s data, however it got into the reply', async () => {
    // Every query is meant to be scoped. This is the backstop for the one that was not.
    const k = kernel([route({ handler: ok({ sales: [{ id: 'S-1', tenantId: 't-other' }] }) })]);
    const res = await handle(k, req());
    expect(res.status).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe('cross_tenant_in_response');
  });

  it('finds it however deep it is buried', () => {
    const findings = scanOutbound(
      { page: { items: [{ meta: { tenant_id: 't-other' } }] } }, 't-sre',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('$.page.items[0].meta.tenant_id');
  });

  it('leaves the caller\'s own tenant id alone', () => {
    expect(scanOutbound({ tenantId: 't-sre', items: [] }, 't-sre')).toEqual([]);
  });

  it('refuses rather than redacts', async () => {
    // Redacting sends a successful reply for a request that did something wrong, and the
    // wrongness is then invisible to everyone.
    const k = kernel([route({ handler: ok({ tenantId: 't-other', total: 5 }) })]);
    const res = await handle(k, req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('"total"');
  });
});

describe('every write is on the record', () => {
  it('audits the write with who, what, where and the trace id', async () => {
    const entries: unknown[] = [];
    const audit: AuditSink = { record: (e) => { entries.push(e); } };
    const k = kernel([{
      api: 'API-05', method: 'POST', path: '/v1/sales', permission: 'pos.sale.create',
      idempotent: true, handler: ok({ saleId: 'S-1' }),
    }], { audit });

    await handle(k, req({
      method: 'POST', body: { totalMinor: 1 },
      headers: { authorization: 'Bearer good', 'idempotency-key': 'k-9' },
    }));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tenantId: 't-sre', userId: 'u-meena', method: 'POST', path: '/v1/sales',
      status: 200, permission: 'pos.sale.create', idempotencyKey: 'k-9', traceId: 'trace-1',
    });
  });

  it('records the REFUSAL too — who tried is the question an audit trail exists for', async () => {
    // The first version of the pipeline audited only the success path, so somebody reaching for a
    // permission they do not hold left no trace at all and looked exactly like nothing happening.
    const entries: { permission: string; status: number; userId: string }[] = [];
    const audit: AuditSink = { record: (e) => { entries.push(e as never); } };
    const k = kernel([route({ permission: 'finance.period.close' })], { audit });

    const denied = await handle(k, req());
    expect(denied.status).toBe(403);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      permission: 'finance.period.close', status: 403, userId: 'u-meena',
    });
  });

  it('records an unauthenticated attempt, naming it as such rather than dropping it', async () => {
    const entries: { userId: string; status: number }[] = [];
    const k = kernel([route()], { audit: { record: (e) => { entries.push(e as never); } } });
    await handle(k, req({ headers: {} }));
    expect(entries[0]).toMatchObject({ userId: 'unauthenticated', status: 401 });
  });

  it('does not audit successful reads, so the writes are not buried', async () => {
    const entries: unknown[] = [];
    const k = kernel([route()], { audit: { record: (e) => { entries.push(e); } } });
    expect((await handle(k, req())).status).toBe(200);
    expect(entries).toEqual([]);
  });

  it('puts a trace id on every reply, including the failures', async () => {
    const k = kernel([route()]);
    expect((await handle(k, req())).headers['x-trace-id']).toBe('trace-1');
    const denied = await handle(k, req({ headers: {} }));
    expect((denied.body as { error: { traceId: string } }).error.traceId).toBe('trace-1');
  });
});
