import { describe, it, expect } from 'vitest';
import {
  TokenBucketRateLimiter, BackoffAuthThrottle,
} from '../../services/kernel/src/rate-limit';

// Rate limiting and auth-attempt lockout (audit FND-03 / GAP-SEC-04). Both are driven by an injected
// clock, so these prove the refusal AND the recovery without any real waiting.

describe('TokenBucketRateLimiter (token bucket)', () => {
  it('allows a burst up to capacity, then refuses with a Retry-After', () => {
    const nowMs = 1_000_000;
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 1 }, () => nowMs);

    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(true);
    const refused = limiter.take('k');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(1); // one token in 1s at 1/s
  });

  it('refills over time and lets the caller back in after the wait', () => {
    let nowMs = 0;
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 2 }, () => nowMs);

    expect(limiter.take('k').allowed).toBe(true); // drains the one token
    expect(limiter.take('k').allowed).toBe(false);
    nowMs += 500; // 0.5s at 2/s = one token
    expect(limiter.take('k').allowed).toBe(true);
  });

  it('keeps each key in its own bucket — one caller cannot spend another\'s budget', () => {
    const nowMs = 0;
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.0001 }, () => nowMs);
    expect(limiter.take('ip:a').allowed).toBe(true);
    expect(limiter.take('ip:a').allowed).toBe(false); // a is spent
    expect(limiter.take('ip:b').allowed).toBe(true);  // b is untouched
  });

  it('never refills beyond capacity, however long it idles', () => {
    let nowMs = 0;
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 1 }, () => nowMs);
    nowMs += 1_000_000; // idle a long time
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(false); // only capacity, not the whole idle time
  });
});

describe('BackoffAuthThrottle (exponential backoff lockout)', () => {
  it('does not lock below the threshold — a mistyped password is not an attack', () => {
    const nowMs = 0;
    const throttle = new BackoffAuthThrottle(
      { threshold: 3, baseCooldownSeconds: 5, maxCooldownSeconds: 900 }, () => nowMs,
    );
    throttle.fail('ip');
    throttle.fail('ip');
    expect(throttle.status('ip').locked).toBe(false);
  });

  it('locks at the threshold, and the lock lifts after the cooldown', () => {
    let nowMs = 0;
    const throttle = new BackoffAuthThrottle(
      { threshold: 3, baseCooldownSeconds: 5, maxCooldownSeconds: 900 }, () => nowMs,
    );
    throttle.fail('ip'); throttle.fail('ip'); throttle.fail('ip'); // hit the threshold
    const locked = throttle.status('ip');
    expect(locked.locked).toBe(true);
    expect(locked.retryAfterSeconds).toBe(5);

    nowMs += 5_000; // wait out the cooldown
    expect(throttle.status('ip').locked).toBe(false);
  });

  it('backs off exponentially — each further failure doubles the cooldown, capped', () => {
    const nowMs = 0;
    const throttle = new BackoffAuthThrottle(
      { threshold: 1, baseCooldownSeconds: 2, maxCooldownSeconds: 10 }, () => nowMs,
    );
    throttle.fail('ip'); // failures=1 → 2^0 · 2 = 2s
    expect(throttle.status('ip').retryAfterSeconds).toBe(2);
    throttle.fail('ip'); // failures=2 → 2^1 · 2 = 4s
    expect(throttle.status('ip').retryAfterSeconds).toBe(4);
    throttle.fail('ip'); // failures=3 → 2^2 · 2 = 8s
    expect(throttle.status('ip').retryAfterSeconds).toBe(8);
    throttle.fail('ip'); // failures=4 → 2^3 · 2 = 16s, capped at 10
    expect(throttle.status('ip').retryAfterSeconds).toBe(10);
  });

  it('a success clears the slate — the next mistake starts from zero', () => {
    const nowMs = 0;
    const throttle = new BackoffAuthThrottle(
      { threshold: 2, baseCooldownSeconds: 5, maxCooldownSeconds: 900 }, () => nowMs,
    );
    throttle.fail('ip');
    throttle.succeed('ip'); // legitimate sign-in wipes the count
    throttle.fail('ip'); // this is the FIRST failure again, not the second
    expect(throttle.status('ip').locked).toBe(false);
  });

  it('keeps sources independent — one attacker cannot lock out an innocent one', () => {
    const nowMs = 0;
    const throttle = new BackoffAuthThrottle(
      { threshold: 1, baseCooldownSeconds: 5, maxCooldownSeconds: 900 }, () => nowMs,
    );
    throttle.fail('ip:attacker');
    expect(throttle.status('ip:attacker').locked).toBe(true);
    expect(throttle.status('ip:innocent').locked).toBe(false);
  });
});
