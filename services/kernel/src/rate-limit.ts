// Rate limiting and auth-attempt lockout — SEC-03/SEC-04, audit FND-03 / GAP-SEC-04.
//
// The kernel had exactly one 429 in the whole product — the AI budget gate — so nothing capped the
// rate at which a caller could hammer the API, and nothing slowed a script guessing tokens against
// the sign-in path. Two distinct protections, deliberately kept apart because they answer different
// threats:
//
//   1. RATE LIMITING smooths VOLUME. A token bucket per key (a source IP, a tenant) refills at a
//      sustained rate and allows a burst up to a capacity; over-rate calls are refused with a
//      Retry-After telling the caller when to come back. It protects the shop's own API from a
//      runaway client and one tenant from another's flood (fair share).
//
//   2. AUTH-ATTEMPT LOCKOUT stops GUESSING. Consecutive failed sign-ins from one source trip an
//      exponential backoff: after a threshold, the source is locked for a cooldown that doubles with
//      each further failure up to a cap, so a brute-force or credential-stuffing run slows to a
//      crawl. A single success clears the count — a fat-fingered password is not a lockout.
//
// Both are PORTS with an in-process implementation here — a real limiter, not a test double (its
// state is ephemeral BY DESIGN, the same way `RequestMetrics` counters are: a fresh allowance after
// a restart is correct, not a lost record). It is correct as-is for the single-store box and a
// single API instance. A multi-instance cloud swaps the port for a shared store (Redis, per the
// technology baseline) so the limit is global rather than per pod and an auth lockout cannot be
// evaded by hitting another instance — the same port / deployment-adapter split as idempotency.
// The injected clock is what lets a test drive both the refusal and the recovery with no waiting.

// ─── Rate limiting (token bucket) ────────────────────────────────────────────

/** The answer to "may this call proceed?" — and, if not, when to try again. */
export interface RateDecision {
  readonly allowed: boolean;
  /** Whole seconds until a token is available; 0 when allowed. Never below 1 when refused. */
  readonly retryAfterSeconds: number;
}

/** Consumes one unit against `key` and says whether it was within the limit. */
export interface RateLimiter {
  take(key: string): RateDecision | Promise<RateDecision>;
}

export interface TokenBucketConfig {
  /** Burst size — the most calls allowed back-to-back before the sustained rate governs. */
  readonly capacity: number;
  /** Sustained rate the bucket refills at. */
  readonly refillPerSecond: number;
}

/**
 * In-memory token bucket. Each key gets a bucket that starts full, drains one token per call, and
 * refills continuously at `refillPerSecond` up to `capacity`. Deterministic under an injected clock,
 * so a test can prove both the refusal and the recovery without waiting.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAtMs: number }>();

  constructor(
    private readonly config: TokenBucketConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  take(key: string): RateDecision {
    const nowMs = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.config.capacity, updatedAtMs: nowMs };
    // Refill for the time since we last touched this bucket, capped at the burst capacity.
    const elapsedSec = Math.max(0, (nowMs - bucket.updatedAtMs) / 1000);
    const tokens = Math.min(this.config.capacity, bucket.tokens + elapsedSec * this.config.refillPerSecond);

    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, updatedAtMs: nowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    this.buckets.set(key, { tokens, updatedAtMs: nowMs });
    // Seconds until the bucket holds one whole token again.
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - tokens) / this.config.refillPerSecond));
    return { allowed: false, retryAfterSeconds };
  }
}

// ─── Auth-attempt lockout (exponential backoff) ──────────────────────────────

/** Whether a source is currently locked out of sign-in, and for how much longer. */
export interface AuthLockStatus {
  readonly locked: boolean;
  /** Whole seconds until the lock lifts; 0 when not locked. */
  readonly retryAfterSeconds: number;
}

/**
 * Tracks failed sign-in attempts per source and locks a source that keeps failing. `status` is
 * checked BEFORE attempting authentication (a locked source is refused without the credential even
 * being examined); `fail`/`succeed` record the outcome after.
 */
export interface AuthThrottle {
  status(key: string): AuthLockStatus;
  fail(key: string): void;
  succeed(key: string): void;
}

export interface AuthThrottleConfig {
  /** Consecutive failures tolerated before the first lockout. */
  readonly threshold: number;
  /** The first lockout's length; each further failure doubles it. */
  readonly baseCooldownSeconds: number;
  /** The ceiling the doubling is capped at, so a lockout is long but never unbounded. */
  readonly maxCooldownSeconds: number;
}

/**
 * In-memory auth-attempt throttle with exponential backoff. Below the threshold nothing is locked (a
 * mistyped password is not an attack). At and beyond it, the source is locked for
 * `base · 2^(failures − threshold)` seconds, capped at `max`. A success clears the source entirely.
 * Deterministic under an injected clock.
 */
export class BackoffAuthThrottle implements AuthThrottle {
  private readonly state = new Map<string, { failures: number; lockedUntilMs: number }>();

  constructor(
    private readonly config: AuthThrottleConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  status(key: string): AuthLockStatus {
    const entry = this.state.get(key);
    if (entry === undefined) return { locked: false, retryAfterSeconds: 0 };
    const remainingMs = entry.lockedUntilMs - this.now();
    if (remainingMs > 0) {
      return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
    }
    return { locked: false, retryAfterSeconds: 0 };
  }

  fail(key: string): void {
    const nowMs = this.now();
    const entry = this.state.get(key) ?? { failures: 0, lockedUntilMs: 0 };
    const failures = entry.failures + 1;
    let lockedUntilMs = entry.lockedUntilMs;
    if (failures >= this.config.threshold) {
      const overThreshold = failures - this.config.threshold; // 0 on the first lock, then 1, 2, …
      const cooldownSeconds = Math.min(
        this.config.maxCooldownSeconds,
        this.config.baseCooldownSeconds * 2 ** overThreshold,
      );
      lockedUntilMs = nowMs + cooldownSeconds * 1000;
    }
    this.state.set(key, { failures, lockedUntilMs });
  }

  succeed(key: string): void {
    // A genuine sign-in clears the slate — the next mistyped password starts from zero, not one
    // attempt from a lockout that a legitimate user would never understand.
    this.state.delete(key);
  }
}
