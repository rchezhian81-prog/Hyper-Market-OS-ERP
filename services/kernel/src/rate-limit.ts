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
  /**
   * Audit 27 Nov 2026 item 5: the most keys held at once (default 100 000). A bucket that has refilled to full is
   * forgotten anyway (it says nothing a fresh bucket would not); past this, the least recently used buckets go first.
   */
  readonly maxKeys?: number;
}

/** Default cap on the keys one limiter or throttle holds (audit 27 Nov 2026 item 5). */
export const DEFAULT_MAX_KEYS = 100_000;


/**
 * In-memory token bucket. Each key gets a bucket that starts full, drains one token per call, and
 * refills continuously at `refillPerSecond` up to `capacity`. Deterministic under an injected clock,
 * so a test can prove both the refusal and the recovery without waiting.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  // Insertion order is recency: every take moves its key to the end, so the first entries are the least recently used.
  private readonly buckets = new Map<string, { tokens: number; updatedAtMs: number }>();
  private readonly maxKeys: number;

  constructor(
    private readonly config: TokenBucketConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.maxKeys = Math.max(1, config.maxKeys ?? DEFAULT_MAX_KEYS);
  }

  /** How many keys are held now (audit 27 Nov 2026 item 5). */
  get size(): number { return this.buckets.size; }

  take(key: string): RateDecision {
    const nowMs = this.now();
    const held = this.buckets.get(key);
    this.forgetFull(nowMs, key);
    if (held === undefined) this.makeRoom(nowMs);
    const bucket = held ?? { tokens: this.config.capacity, updatedAtMs: nowMs };
    // Refill for the time since we last touched this bucket, capped at the burst capacity.
    const tokens = this.levelAt(bucket, nowMs);
    this.buckets.delete(key); // re-inserted below, at the most-recent end

    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, updatedAtMs: nowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    this.buckets.set(key, { tokens, updatedAtMs: nowMs });
    // Seconds until the bucket holds one whole token again.
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - tokens) / this.config.refillPerSecond));
    return { allowed: false, retryAfterSeconds };
  }

  private levelAt(bucket: { tokens: number; updatedAtMs: number }, nowMs: number): number {
    const elapsedSec = Math.max(0, (nowMs - bucket.updatedAtMs) / 1000);
    return Math.min(this.config.capacity, bucket.tokens + elapsedSec * this.config.refillPerSecond);
  }

  /**
   * Forget the least recently used buckets that have refilled to full — nothing is lost: a full bucket is a fresh one.
   * Walks from the oldest and stops at the first that is not full, so each bucket is looked at about once (no pause).
   */
  private forgetFull(nowMs: number, except: string): void {
    for (const [k, b] of this.buckets) {
      if (k === except || this.levelAt(b, nowMs) < this.config.capacity) break;
      this.buckets.delete(k);
    }
  }

  /** Before a new key is added at the cap: drop every full bucket, then the least recently used, until there is room. */
  private makeRoom(nowMs: number): void {
    if (this.buckets.size < this.maxKeys) return;
    for (const [k, b] of this.buckets) if (this.levelAt(b, nowMs) >= this.config.capacity) this.buckets.delete(k);
    // Still full: the least recently used go — the buckets nearest to full, so the least is given back.
    for (const k of this.buckets.keys()) {
      if (this.buckets.size < this.maxKeys) break;
      this.buckets.delete(k);
    }
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
  /**
   * Audit 27 Nov 2026 item 5: a source whose lock has run out and that has not failed for this long is forgotten (its
   * count starts again from zero). Default one day; never less than `maxCooldownSeconds`, so a lock always runs out first.
   */
  readonly forgetAfterSeconds?: number;
  /**
   * Audit 27 Nov 2026 item 5: the most sources held at once (default 100 000). Past it, idle entries go first, then the
   * least recently failed UNLOCKED ones. An active lockout is never removed before its time — the cap gives way instead.
   */
  readonly maxKeys?: number;
}

/**
 * In-memory auth-attempt throttle with exponential backoff. Below the threshold nothing is locked (a
 * mistyped password is not an attack). At and beyond it, the source is locked for
 * `base · 2^(failures − threshold)` seconds, capped at `max`. A success clears the source entirely.
 * Deterministic under an injected clock.
 */
export class BackoffAuthThrottle implements AuthThrottle {
  // Insertion order is the order of the last failure: every fail moves its key to the end, so the first entries are the
  // ones that failed longest ago — and, because a lock never outlasts `forgetAfterSeconds`, the idle ones lead the map.
  private readonly state = new Map<string, { failures: number; lockedUntilMs: number; lastFailMs: number }>();
  private readonly forgetAfterMs: number;
  private readonly maxKeys: number;

  constructor(
    private readonly config: AuthThrottleConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.forgetAfterMs = Math.max(config.forgetAfterSeconds ?? 86_400, config.maxCooldownSeconds) * 1000;
    this.maxKeys = Math.max(1, config.maxKeys ?? DEFAULT_MAX_KEYS);
  }

  /** How many sources are held now (audit 27 Nov 2026 item 5). */
  get size(): number { return this.state.size; }

  status(key: string): AuthLockStatus {
    const entry = this.state.get(key);
    if (entry === undefined) return { locked: false, retryAfterSeconds: 0 };
    const nowMs = this.now();
    const remainingMs = entry.lockedUntilMs - nowMs;
    if (remainingMs > 0) {
      return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
    }
    if (this.idle(entry, nowMs)) this.state.delete(key);
    return { locked: false, retryAfterSeconds: 0 };
  }

  fail(key: string): void {
    const nowMs = this.now();
    this.forgetIdle(nowMs);
    const held = this.state.get(key);
    const entry = held === undefined || this.idle(held, nowMs) ? { failures: 0, lockedUntilMs: 0 } : held;
    if (held === undefined) this.makeRoom(nowMs);
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
    this.state.delete(key); // re-inserted at the most-recent end
    this.state.set(key, { failures, lockedUntilMs, lastFailMs: nowMs });
  }

  succeed(key: string): void {
    // A genuine sign-in clears the slate — the next mistyped password starts from zero, not one
    // attempt from a lockout that a legitimate user would never understand.
    this.state.delete(key);
  }

  private idle(entry: { lockedUntilMs: number; lastFailMs: number }, nowMs: number): boolean {
    return entry.lockedUntilMs <= nowMs && nowMs - entry.lastFailMs >= this.forgetAfterMs;
  }

  /**
   * Forget the longest-ago entries that are idle (lock run out, no failure for `forgetAfterSeconds`). They lead the map,
   * so the walk stops at the first that is not idle: each entry is looked at about once (no pause).
   */
  private forgetIdle(nowMs: number): void {
    for (const [k, e] of this.state) {
      if (!this.idle(e, nowMs)) break;
      this.state.delete(k);
    }
  }

  /**
   * Before a new source is added at the cap: drop every idle entry, then the longest-ago UNLOCKED ones, until there is
   * room. A locked entry is never dropped — flooding the throttle with new names cannot wipe out somebody's lockout; if
   * every entry is locked, the cap gives way (each lock runs out within `maxCooldownSeconds`).
   */
  private makeRoom(nowMs: number): void {
    if (this.state.size < this.maxKeys) return;
    for (const [k, e] of this.state) {
      if (!this.idle(e, nowMs)) break;
      this.state.delete(k);
    }
    for (const [k, e] of this.state) {
      if (this.state.size < this.maxKeys) break;
      if (e.lockedUntilMs > nowMs) continue;
      this.state.delete(k);
    }
  }
}
