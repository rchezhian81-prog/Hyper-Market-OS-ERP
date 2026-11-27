import { describe, it, expect } from 'vitest';
import { TokenBucketRateLimiter, BackoffAuthThrottle } from '../../services/kernel/src/rate-limit';

/**
 * **Audit 27 Nov 2026, item 5 — the limiters forget idle callers and never grow without bound, and a flood can never be
 * used to wipe out somebody's lockout.**
 *
 * Before: `TokenBucketRateLimiter` kept a bucket for every key it ever saw and `BackoffAuthThrottle` an entry for every
 * key that ever failed — forever. Every new address (and, since item 1, every claimed name in a forged token) was a few
 * more bytes for the life of the process: a slow memory leak an attacker can speed up.
 *
 * Now:
 *   • a bucket that has refilled to full says nothing a fresh one would not, so it is removed; an auth entry whose lock
 *     has run out and that has not failed for `forgetAfterSeconds` is removed;
 *   • each holds at most `maxKeys` keys: past it, the least recently used FULL / IDLE entries go first, then the least
 *     recently used unlocked ones — an ACTIVE LOCKOUT is never removed before its time, however many keys flood in.
 */

/** How many keys a limiter holds — read from its own map, so the count is the memory actually kept. */
const held = (x: TokenBucketRateLimiter | BackoffAuthThrottle): number => {
  const inner = x as unknown as { buckets?: Map<string, unknown>; state?: Map<string, unknown> };
  return (inner.buckets ?? inner.state)!.size;
};

describe('audit 27 Nov item 5 — the token bucket forgets full buckets and is capped', () => {
  it('a bucket that has refilled to full is forgotten (a million passing addresses do not stay in memory)', () => {
    let nowMs = 0;
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 1, maxKeys: 1000 }, () => nowMs);
    for (let i = 0; i < 500; i += 1) limiter.take(`ip:a${i}`);
    nowMs += 10_000; // every bucket is full again
    for (let i = 0; i < 500; i += 1) limiter.take(`ip:b${i}`);
    expect(held(limiter), 'the full buckets of the first 500 are gone').toBeLessThanOrEqual(510);
  });

  it('never holds more than maxKeys, however many addresses arrive at once', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 5, refillPerSecond: 0.001, maxKeys: 100 }, () => 0);
    for (let i = 0; i < 10_000; i += 1) limiter.take(`ip:${i}`);
    expect(held(limiter)).toBeLessThanOrEqual(100);
  });

  it('a caller still being limited keeps its bucket when it is recent: the newest are never evicted first', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.001, maxKeys: 10 }, () => 0);
    for (let i = 0; i < 50; i += 1) limiter.take(`ip:old-${i}`);
    expect(limiter.take('ip:flooder').allowed).toBe(true);
    expect(limiter.take('ip:flooder').allowed).toBe(false);
    for (let i = 0; i < 5; i += 1) limiter.take(`ip:new-${i}`);
    expect(limiter.take('ip:flooder').allowed, 'still limited').toBe(false);
  });
});

describe('audit 27 Nov item 5 — the auth throttle forgets idle callers, is capped, and never drops an active lockout', () => {
  const config = { threshold: 3, baseCooldownSeconds: 60, maxCooldownSeconds: 900, forgetAfterSeconds: 3600, maxKeys: 100 };

  it('an entry whose lock has run out and that has not failed for an hour is forgotten', () => {
    let nowMs = 0;
    const t = new BackoffAuthThrottle(config, () => nowMs);
    for (let i = 0; i < 50; i += 1) t.fail(`ip:x|as:${i}`);
    expect(held(t)).toBe(50);
    nowMs += 3_601_000;
    t.fail('ip:y|as:someone');
    expect(held(t), 'the fifty idle entries are gone').toBeLessThanOrEqual(5);
  });

  it('a flood of new names never holds more than maxKeys (active lockouts aside) — and never removes an active lockout', () => {
    let nowMs = 0;
    const t = new BackoffAuthThrottle(config, () => nowMs);
    // The guesser is locked first — the OLDEST entry, the first a naive cap would throw away.
    for (let i = 0; i < 3; i += 1) t.fail('ip:203.0.113.7|as:shop/u-target');
    const before = t.status('ip:203.0.113.7|as:shop/u-target');
    expect(before.locked).toBe(true);

    // Ten thousand forged names to push it out.
    nowMs += 1_000;
    for (let i = 0; i < 10_000; i += 1) t.fail(`ip:203.0.113.7|as:shop/flood-${i}`);
    expect(held(t)).toBeLessThanOrEqual(101);
    const after = t.status('ip:203.0.113.7|as:shop/u-target');
    expect(after.locked, 'the lockout survives the flood').toBe(true);
    expect(after.retryAfterSeconds).toBe(before.retryAfterSeconds - 1);

    // …and its count survives too: once the lock lifts, the next failure locks again for DOUBLE the time.
    nowMs += 60_000;
    expect(t.status('ip:203.0.113.7|as:shop/u-target').locked).toBe(false);
    t.fail('ip:203.0.113.7|as:shop/u-target');
    expect(t.status('ip:203.0.113.7|as:shop/u-target').retryAfterSeconds).toBe(120);
  });

  it('when every entry is an active lockout, a new one is still counted (the cap gives way, never a lock)', () => {
    const t = new BackoffAuthThrottle({ ...config, threshold: 1, maxKeys: 5 }, () => 0);
    for (let i = 0; i < 8; i += 1) t.fail(`ip:z|as:${i}`);
    for (let i = 0; i < 8; i += 1) expect(t.status(`ip:z|as:${i}`).locked, `lock ${i}`).toBe(true);
  });

  it('a recent failure below the threshold is not forgotten early by a flood of OTHER addresses\' failures ahead of it', () => {
    let nowMs = 0;
    const t = new BackoffAuthThrottle({ ...config, maxKeys: 50 }, () => nowMs);
    for (let i = 0; i < 40; i += 1) t.fail(`ip:old|as:${i}`);
    nowMs += 1_000;
    t.fail('ip:203.0.113.7|as:shop/u-target');
    t.fail('ip:203.0.113.7|as:shop/u-target');
    for (let i = 0; i < 20; i += 1) t.fail(`ip:other|as:${i}`);
    t.fail('ip:203.0.113.7|as:shop/u-target'); // the third — still remembered, so it locks
    expect(t.status('ip:203.0.113.7|as:shop/u-target').locked).toBe(true);
  });
});
