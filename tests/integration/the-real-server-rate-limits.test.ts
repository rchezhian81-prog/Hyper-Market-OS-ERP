import { describe, it, expect, afterAll } from 'vitest';
import {
  buildRouter, startHttpServer, MemoryIdempotencyStore, TokenBucketRateLimiter, BackoffAuthThrottle,
  type RunningServer,
} from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { buildSurface } from '../../services/api/src/main';

/**
 * **The REAL server rate-limits and locks out sign-in floods (audit FND-03 / GAP-SEC-04 · SEC-03 · §30 ·
 * OWASP API4:2023).** The limiter and the auth throttle were proven in isolation (`tests/unit/rate-limit.test.ts`)
 * and through the pipeline (`tests/unit/service-kernel.test.ts`); `main.ts` wires both into `startHttpServer`. What
 * nothing had shown is the whole thing on a SOCKET: a flood of real HTTP requests from one client address is
 * answered 429 with a `Retry-After` header and the three-part error, and repeated bad tokens lock sign-in from
 * that address — the production surface assembled exactly as `main.ts` assembles it, over a real port.
 *
 * Small buckets and a clock the test controls, so the refusal AND the recovery are proven without waiting.
 */

const KEY = ['rate', 'limit', 'server', 'signing', 'key'].join('-').padEnd(48, '0');
const running: RunningServer[] = [];
afterAll(async () => { for (const s of running) await s.stop(); });

const portOf = (s: RunningServer): number => (s.server.address() as { port: number }).port;
const wait = (s: RunningServer) => new Promise<void>((r) => {
  if (s.server.listening) { r(); return; }
  s.server.once('listening', () => { r(); });
});

function start(input: { rateLimit?: TokenBucketRateLimiter; authThrottle?: BackoffAuthThrottle; good?: string }): RunningServer {
  const built = buildRouter(buildSurface({ signingKey: KEY, migrationTargetKind: 'rehearsal' }));
  expect(built.ok, built.refusals.map((r) => r.detail).join('; ')).toBe(true);
  const s = startHttpServer({
    router: built.router!,
    authenticate: (t) => (input.good !== undefined && t === input.good ? { tenantId: 't-sre', userId: 'u-1', branchId: null } : undefined),
    access: new AccessControl([], []),
    idempotency: new MemoryIdempotencyStore(),
    newTraceId: () => 'trace-1',
    port: 0,
    dependenciesReachable: () => true,
    ...(input.rateLimit === undefined ? {} : { rateLimit: input.rateLimit }),
    ...(input.authThrottle === undefined ? {} : { authThrottle: input.authThrottle }),
  });
  running.push(s);
  return s;
}

const body = async (res: Response) => (await res.json()) as { error?: { code?: string; whatHappened?: string; wasItSaved?: string; nextSafeAction?: string } };

describe('a flood from one address is refused 429 on the real socket, and recovers when the bucket refills', () => {
  it('two requests pass, the third is 429 with Retry-After and the three-part error; after the refill it passes again', async () => {
    let nowMs = 1_000_000;
    const rateLimit = new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 1 }, () => nowMs);
    const s = start({ rateLimit });
    await wait(s);
    const url = `http://127.0.0.1:${portOf(s)}/v1/identity/me`;
    const headers = { authorization: 'Bearer nope', 'x-forwarded-for': '203.0.113.9' };

    // Unauthenticated (401) — but the per-IP bucket is spent BEFORE the token is even looked at (FND-03).
    expect((await fetch(url, { headers })).status).toBe(401);
    expect((await fetch(url, { headers })).status).toBe(401);
    const refused = await fetch(url, { headers });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    const err = await body(refused);
    expect(err.error?.code).toBe('rate_limited');
    expect(err.error?.wasItSaved).toBe('not_saved');
    expect(err.error?.nextSafeAction).toContain('Wait');

    // A DIFFERENT address is not punished for this one's flood.
    expect((await fetch(url, { headers: { ...headers, 'x-forwarded-for': '198.51.100.7' } })).status).toBe(401);

    // The bucket refills with time: one second later, one more request from the flooding address passes.
    nowMs += 1_000;
    expect((await fetch(url, { headers })).status).toBe(401);
  });
});

describe('repeated bad tokens lock sign-in from that address; a good token from elsewhere is unaffected', () => {
  it('locks after the threshold with 429 too_many_sign_in_attempts, and lifts after the cooldown', async () => {
    let nowMs = 5_000_000;
    const authThrottle = new BackoffAuthThrottle({ threshold: 3, baseCooldownSeconds: 10, maxCooldownSeconds: 60 }, () => nowMs);
    const s = start({ authThrottle, good: 'good-token' });
    await wait(s);
    const url = `http://127.0.0.1:${portOf(s)}/v1/identity/me`;
    const bad = { authorization: 'Bearer forged', 'x-forwarded-for': '203.0.113.42' };

    for (let i = 0; i < 3; i += 1) expect((await fetch(url, { headers: bad })).status).toBe(401);
    const locked = await fetch(url, { headers: bad });
    expect(locked.status).toBe(429);
    expect((await body(locked)).error?.code).toBe('too_many_sign_in_attempts');
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);

    // Even the RIGHT token is refused from the locked address while the cooldown runs — the lock is on the
    // address, which is the point of an auth-attempt lockout — but a good token from ANOTHER address works.
    expect((await fetch(url, { headers: { ...bad, authorization: 'Bearer good-token' } })).status).toBe(429);
    const elsewhere = await fetch(url, { headers: { authorization: 'Bearer good-token', 'x-forwarded-for': '198.51.100.1' } });
    expect(elsewhere.status).not.toBe(429);

    // After the cooldown the address may try again.
    nowMs += 11_000;
    expect((await fetch(url, { headers: { ...bad, authorization: 'Bearer good-token' } })).status).not.toBe(429);
  });
});
