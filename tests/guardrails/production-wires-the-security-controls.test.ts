import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GAP-SEC-04 (rate limiting + auth-attempt lockout), GAP-SEC-03 (the SHA-256 audit chain), SEC-03 (tokens verified
// by the pinned verifier), GAP-DATA-01 (the transactional store): each is a control the kernel types as OPTIONAL —
// deliberately, so a unit test that is not about it can leave it out — which means the one thing between
// "production enforces it" and "production silently does not" is that `main.ts` wires it, unconditionally.
// A refactor can erase any of those lines with the suite still green. So they are asserted here, on the production
// composition itself, and the tripwires prove each assertion bites. The register says these gaps are CLOSED; this is
// what keeps that sentence true tomorrow.

const ROOT = new URL('../../', import.meta.url).pathname;
const MAIN = readFileSync(join(ROOT, 'services/api/src/main.ts'), 'utf8');

const CONTROLS: readonly { readonly name: string; readonly pattern: RegExp; readonly gap: string }[] = [
  { name: 'per-IP + per-tenant rate limit', pattern: /\brateLimit:\s*new TokenBucketRateLimiter\(/, gap: 'GAP-SEC-04' },
  { name: 'auth-attempt lockout', pattern: /\bauthThrottle:\s*new BackoffAuthThrottle\(/, gap: 'GAP-SEC-04' },
  { name: 'SHA-256-chained audit sink', pattern: /\baudit:\s*new SqlAuditSink\(/, gap: 'GAP-SEC-03' },
  { name: 'pinned token verifier (revocation-aware since GAP-SEC-05)', pattern: /\bauthenticate:\s*revocationAwareAuthenticator\(/, gap: 'SEC-03 / GAP-SEC-05' },
  { name: 'token lifetime ceiling from configuration', pattern: /maxLifetimeSeconds:\s*Number\(settings\['IDP_MAX_TOKEN_LIFETIME_SECONDS'\]\)/, gap: 'GAP-SEC-05' },
  { name: 'transactional event store (atomic appendBatch)', pattern: /new SqlEventStore\(pgPoolClient\(/, gap: 'GAP-DATA-01' },
];

describe('guardrail: the production composition wires every security control the registers call CLOSED', () => {
  for (const c of CONTROLS) {
    it(`${c.gap}: ${c.name} is wired in services/api/src/main.ts`, () => {
      expect(c.pattern.test(MAIN), `${c.name} is no longer wired — ${c.gap} would silently reopen`).toBe(true);
    });
  }

  it('no flag can switch the limiter, the lockout or the verifier off in production', () => {
    expect(/disableRateLimit|RATE_LIMIT_(?:OFF|DISABLED)|noRateLimit|skipAuth|AUTH_(?:OFF|DISABLED)|disableAuthThrottle/i.test(MAIN)).toBe(false);
  });

  it('tripwire — each pattern fires on the real line and NOT on a commented-out or renamed one', () => {
    expect(CONTROLS[0]!.pattern.test('    rateLimit: new TokenBucketRateLimiter({ capacity: 240, refillPerSecond: 20 }),')).toBe(true);
    expect(CONTROLS[0]!.pattern.test('    // rateLimit: new TokenBucketRateLimiter(…) — the comment-out a refactor would leave')).toBe(true); // still matches: a comment-out must ALSO be caught by the next check
    expect(/^\s*\/\/.*rateLimit:/m.test(MAIN), 'the rate limit line is commented out').toBe(false);
    expect(/^\s*\/\/.*authThrottle:/m.test(MAIN), 'the auth throttle line is commented out').toBe(false);
    expect(/^\s*\/\/.*audit:\s*new SqlAuditSink/m.test(MAIN), 'the audit sink line is commented out').toBe(false);
    expect(CONTROLS[3]!.pattern.test('authenticate: () => undefined,')).toBe(false);
  });
});
