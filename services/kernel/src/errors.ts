// The error a person actually reads — §27.1, P-08, API conventions (§30).
//
// Every API error in this product carries **three parts, and all three are mandatory**:
//
//   1. **What happened** — in words, not a code.
//   2. **Whether the data was saved** — and `unknown` is a legitimate, frequently correct answer.
//   3. **The next safe action** — what the person in front of the screen should do now.
//
// The second part is the one that matters and the one every API leaves out. A cashier whose
// tender request times out does not need a stack trace; they need to know whether the customer
// has been charged. Answer "failed" when the truth is "unknown" and the till takes the money
// twice. Answer nothing and somebody presses the button again, which does the same thing.
//
// So `wasItSaved` has no default. A handler that does not know says `unknown` and says what to do
// about not knowing, which is a real answer — *"check the last sale on this lane before retrying"*
// — and is the difference between an honest system and a reassuring one (P-08).

/** Did the write land? `unknown` is honest and is the answer for a timeout or a lost reply. */
export type SavedState = 'saved' | 'not_saved' | 'unknown';

export interface ApiErrorBody {
  readonly code: string;
  readonly whatHappened: string;
  readonly wasItSaved: SavedState;
  readonly nextSafeAction: string;
  /** Correlates this reply with the audit trail. Never carries business data. */
  readonly traceId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  /** For a 429/503, whole seconds the caller should wait — surfaced as a `Retry-After` header. */
  readonly retryAfterSeconds?: number;

  constructor(status: number, body: ApiErrorBody, retryAfterSeconds?: number) {
    super(body.whatHappened);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type ErrorRefusal =
  | 'no_description_of_what_happened'
  | 'no_statement_of_whether_it_saved'
  | 'no_next_safe_action';

/**
 * Build an error, or refuse to.
 *
 * Refusing at construction rather than validating on the way out is deliberate: an error missing
 * its "was it saved" line is not a smaller error, it is the one case where the person cannot act.
 * A validator that runs at the boundary is a validator somebody bypasses on the path that throws.
 */
export function apiError(status: number, body: ApiErrorBody, retryAfterSeconds?: number): ApiError {
  const missing = whatIsMissing(body);
  if (missing !== undefined) {
    // An error about an error still has to be a usable error, so this one is complete too.
    throw new ApiError(500, {
      code: missing,
      whatHappened: `An error reply was built without ${DESCRIBE[missing]}, so the original problem cannot be reported safely.`,
      wasItSaved: 'unknown',
      nextSafeAction: 'Treat the original request as unknown: check whether it applied before retrying it.',
    });
  }
  return new ApiError(status, body, retryAfterSeconds);
}

const DESCRIBE: Readonly<Record<ErrorRefusal, string>> = {
  no_description_of_what_happened: 'saying what happened',
  no_statement_of_whether_it_saved: 'saying whether the data was saved',
  no_next_safe_action: 'saying what to do next',
};

function whatIsMissing(body: ApiErrorBody): ErrorRefusal | undefined {
  if (body.whatHappened.trim().length < 10) return 'no_description_of_what_happened';
  if (!['saved', 'not_saved', 'unknown'].includes(body.wasItSaved)) {
    return 'no_statement_of_whether_it_saved';
  }
  if (body.nextSafeAction.trim().length < 10) return 'no_next_safe_action';
  return undefined;
}

// ── The errors the kernel itself raises ──────────────────────────────────────

export const unauthenticated = (): ApiError => apiError(401, {
  code: 'unauthenticated',
  whatHappened: 'This request carried no valid sign-in.',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Sign in again. Nothing was changed, so the request can be repeated as it was.',
});

export const forbidden = (permission: string): ApiError => apiError(403, {
  code: 'forbidden',
  whatHappened: `This account does not hold "${permission}".`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Ask somebody with that permission to do it. Nothing was changed.',
});

export const idempotencyKeyMissing = (): ApiError => apiError(400, {
  code: 'idempotency_key_missing',
  whatHappened: 'A write arrived without an Idempotency-Key, so a repeat of it could not be told from a new one.',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Send it again with an Idempotency-Key. Nothing was changed.',
});

/**
 * The same key with a different body.
 *
 * **Never answered with the stored result.** Returning the first reply would tell the caller their
 * second, different request succeeded — so a sale of 400 sent under a key already used for a sale
 * of 250 would report success and bank 250. That is a silent wrong answer, which is worse than an
 * error, and it is what a naive idempotency cache does.
 */
export const idempotencyKeyReused = (): ApiError => apiError(409, {
  code: 'idempotency_key_reused',
  whatHappened: 'This Idempotency-Key was already used for a different request, so the two cannot both be right.',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Check what was saved under this key. If the new request is genuinely different, send it under a new key.',
});

export const notFound = (what: string): ApiError => apiError(404, {
  code: 'not_found',
  whatHappened: `There is no ${what} here.`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Check the address. Nothing was changed.',
});

/** Too many requests in too short a time — the volume limit (audit FND-03 / SEC-04). */
export const rateLimited = (retryAfterSeconds: number): ApiError => apiError(429, {
  code: 'rate_limited',
  whatHappened: 'Too many requests arrived from here too quickly, so this one was not processed.',
  wasItSaved: 'not_saved',
  nextSafeAction: `Wait ${retryAfterSeconds} second(s) and send it again. Nothing was changed.`,
}, retryAfterSeconds);

/** Too many failed sign-ins from one source — the brute-force lockout (audit FND-03 / SEC-04). */
export const tooManySignInAttempts = (retryAfterSeconds: number): ApiError => apiError(429, {
  code: 'too_many_sign_in_attempts',
  whatHappened: 'Sign-in has been temporarily locked here after repeated failures.',
  wasItSaved: 'not_saved',
  nextSafeAction: `Wait ${retryAfterSeconds} second(s) before trying again. If this is not you, tell the manager. Nothing was changed.`,
}, retryAfterSeconds);
