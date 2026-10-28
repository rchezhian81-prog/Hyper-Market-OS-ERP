// SIGNING A CUSTOMER IN BY A CODE TO THEIR PHONE (M20-FR-01 · WF-13 · M02 · SEC-03/04 · OB-29 · OB-47 · OB-222 · hard rule #4).
//
// The customer app (apps/customer-app/web/app.js, login.js) asks for a code with `POST /auth/otp/begin` and signs in with
// `POST /auth/otp/verify`. Until now only the test stand-ins answered those; on the real public origin the proxy said
// "sign-in is not deployed". This is the real service behind them — built on the shared OTP engine
// (`beginOtpChallenge` / `verifyOtp`: the code is kept only as a salted hash, single use, five tries, five minutes).
//
// What it does:
//   • BEGIN — a 10-digit Indian mobile number → a fresh challenge; the code goes to the phone through the SMS PORT
//     (`OtpSender`, provider-neutral). With no SMS provider configured — the only state this product ships in (OB-222:
//     SMS, WhatsApp and voice stay OFF; no provider is chosen or bought) — it REFUSES in plain words and sends nothing;
//   • VERIFY — the code checked by the engine; a correct one signs the customer in through the SIGNER PORT (who signs the
//     customer's token — this service never mints one: ADR-0019, the `no-test-idp-in-production` guardrail); with no
//     signer configured it refuses in plain words, before any code is sent;
//   • SESSION — kept HERE, on the server: the browser holds a random id in an HttpOnly, Secure, SameSite=Strict cookie
//     scoped to /auth/otp/, and this service keeps only its hash beside the token. `POST /auth/otp/session` hands the page
//     a current token again (after a reload); `POST /auth/otp/check` says whether the session may do an action (step-up);
//   • SIGN-OUT — `POST /auth/otp/signout` ends the session here at once and clears the cookie; the old cookie is refused;
//   • RATE LIMITS and LOCKOUT — codes per number and per address are capped (token buckets); wrong codes lock the number
//     and the address out with a doubling cool-down (the kernel's `BackoffAuthThrottle`, the API's own sign-in lockout);
//   • NO CODE AND NO PHONE NUMBER IN ANY LOG — the audit lines carry the event, the reason and the signed-in subject only.
//
// Everything is held in memory, like the staff sign-in service: a restart signs every customer out and voids every code
// still waiting (they ask again). Nothing about a customer is written to disk here — the number lives only inside a
// waiting challenge for its five minutes.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { beginOtpChallenge, verifyOtp, evaluateStepUp, type OtpChallenge, type OtpSender, type StepUpPolicy } from '../../../packages/identity/src/index';
import { normaliseMobile } from '../../../packages/loyalty/src/index';
import { BackoffAuthThrottle, TokenBucketRateLimiter, type AuthThrottle, type RateLimiter } from '../../kernel/src/rate-limit';

/**
 * Who signs a customer's token once their code is right. Provider-neutral: this service never mints one (ADR-0019).
 * Which identity server signs customers is an OPEN owner decision (ADR-0031); until it is made, none is configured and
 * every sign-in is refused in plain words. Tests put the local test identity provider behind it.
 */
export interface CustomerSessionSigner {
  readonly name: string;
  signIn(input: {
    readonly tenantId: string;
    readonly phoneNumber: string;
    readonly amr: readonly string[];
    /** When the customer proved the code (epoch ms) — a renewal keeps the original. */
    readonly authTimeMs: number;
  }): Promise<{ readonly token: string; readonly subject: string; readonly expiresAtMs: number }>;
}

export interface CustomerSignInDeps {
  /** The one shop this public origin serves (the customer app belongs to one shop). */
  readonly tenantId: string;
  /** The public https origin the customer app is served from — a POST from anywhere else is refused. */
  readonly origin: string;
  /** The SMS port. Absent = no provider configured (OB-222): asking for a code is refused, nothing is sent. */
  readonly sender?: OtpSender;
  /** The signer port. Absent = nobody signs customers yet (ADR-0031): refused before a code is sent. */
  readonly signer?: CustomerSessionSigner;
  /** Which actions need more than a code (a money change needs the app-based factor). */
  readonly stepUp: StepUpPolicy;
  readonly now: () => number;
  /** The operator's log. NEVER a phone number, a code, a challenge id, a token or a session id. */
  readonly audit: (line: Record<string, unknown>) => void;
  /** Injectable limits (tests); production takes the defaults below. */
  readonly limits?: Partial<CustomerSignInLimits>;
  /** Injectable randomness (tests). */
  readonly randomId?: (bytes: number) => string;
}

export interface CustomerSignInLimits {
  readonly codesPerNumber: RateLimiter;
  readonly codesPerAddress: RateLimiter;
  readonly checksPerAddress: RateLimiter;
  readonly wrongCodesPerNumber: AuthThrottle;
  readonly wrongCodesPerAddress: AuthThrottle;
}

export interface CustomerSignInRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  /** The connection's own address, used when no proxy put one in front. */
  readonly remoteAddress?: string;
}
export interface CustomerSignInResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export const CUSTOMER_SESSION_COOKIE = 'sre_customer_session';
/** The cookie never leaves this service's own paths — it is not sent with the shop's /v1 calls. */
export const CUSTOMER_COOKIE_PATH = '/auth/otp/';
/** The longest a customer session lasts here, whatever the signer says: twelve hours, then a new code. */
export const CUSTOMER_SESSION_MAX_SECONDS = 12 * 60 * 60;
/** Renew the token when it has less than this left. */
export const CUSTOMER_REFRESH_MARGIN_SECONDS = 60;
/** The most codes waiting at once (memory bound) — beyond it new codes are refused until old ones lapse. */
export const MAX_WAITING_CODES = 10_000;
/** The most sessions held at once (memory bound). */
export const MAX_CUSTOMER_SESSIONS = 50_000;

/** The default limits (SEC-04): a person needs a code or two; a script needs thousands. */
export function defaultCustomerSignInLimits(now: () => number): CustomerSignInLimits {
  return {
    // Three codes back-to-back to one number, then one every ten minutes.
    codesPerNumber: new TokenBucketRateLimiter({ capacity: 3, refillPerSecond: 1 / 600 }, now),
    // Ten codes back-to-back from one address, then one every six minutes (a family on one connection still gets theirs).
    codesPerAddress: new TokenBucketRateLimiter({ capacity: 10, refillPerSecond: 1 / 360 }, now),
    // Thirty code checks back-to-back from one address, then one every two minutes.
    checksPerAddress: new TokenBucketRateLimiter({ capacity: 30, refillPerSecond: 1 / 120 }, now),
    // Five wrong codes for one number lock it for 5 minutes, doubling each further wrong code, at most a day.
    wrongCodesPerNumber: new BackoffAuthThrottle({ threshold: 5, baseCooldownSeconds: 300, maxCooldownSeconds: 86_400 }, now),
    // Ten wrong codes from one address lock it for a minute, doubling, at most an hour.
    wrongCodesPerAddress: new BackoffAuthThrottle({ threshold: 10, baseCooldownSeconds: 60, maxCooldownSeconds: 3_600 }, now),
  };
}

/** What a page may do with an SMS-code session: a money change needs the app-based factor (the existing step-up rule). */
export const CUSTOMER_STEP_UP_POLICY: StepUpPolicy = {
  secondFactorActions: ['change_bank_details'],
  secondFactorAmr: ['mfa'],
  maxAuthAgeSeconds: 3_600,
};

// ── the plain-words refusals ──────────────────────────────────────────────────────────────────────────────────────────

export const NO_SMS_PROVIDER = {
  code: 'sms_provider_not_configured',
  whatHappened: 'Sign-in by a code to your phone is switched off: no SMS provider is connected to this shop yet. No code was sent.',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Browse as a guest, or order at the store. Sign-in by code starts when the shop connects an SMS provider.',
} as const;
export const NO_SIGNER = {
  code: 'customer_sign_in_not_switched_on',
  whatHappened: 'Customer sign-in is not switched on: nobody is set to sign a customer\'s sign-in on this shop yet. No code was sent.',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Browse as a guest, or order at the store.',
} as const;

interface Session {
  readonly subject: string;
  readonly phoneNumber: string;
  readonly amr: readonly string[];
  readonly authTimeMs: number;
  readonly startedAt: number;
  token: string;
  tokenExpiresAtMs: number;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('base64url');
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-type': 'application/json; charset=utf-8' };

function cookieOf(headers: CustomerSignInRequest['headers']): string | undefined {
  for (const part of (headers['cookie'] ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === CUSTOMER_SESSION_COOKIE) return v.join('=');
  }
  return undefined;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const x = Buffer.from(new URL(a).origin);
    const y = Buffer.from(new URL(b).origin);
    return x.length === y.length && timingSafeEqual(x, y);
  } catch { return false; }
}

export function createCustomerSignInHandler(deps: CustomerSignInDeps): (req: CustomerSignInRequest) => Promise<CustomerSignInResponse> {
  const limits: CustomerSignInLimits = { ...defaultCustomerSignInLimits(deps.now), ...(deps.limits ?? {}) };
  const randomId = deps.randomId ?? ((n: number) => randomBytes(n).toString('base64url'));
  /** Waiting codes, by challenge id. Each holds the number for at most its five minutes. */
  const challenges = new Map<string, OtpChallenge>();
  /** Sessions, by the HASH of the cookie's id — the id itself is never kept. */
  const sessions = new Map<string, Session>();
  /** The limiter keys: a number is keyed by its hash, so the maps hold no number in the clear. */
  const numberKey = (phone: string): string => `n:${sha256(`${deps.tenantId}:${phone}`)}`;

  const json = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): CustomerSignInResponse =>
    ({ status, headers: { ...NO_STORE, ...extra }, body: JSON.stringify(body) });
  const refuse = (status: number, error: { code: string; whatHappened: string; wasItSaved: string; nextSafeAction: string }, extra: Record<string, string> = {}): CustomerSignInResponse =>
    json(status, { ok: false, reason: error.code, error }, extra);
  const tooMany = (retryAfterSeconds: number, what: string): CustomerSignInResponse => refuse(429, {
    code: 'too_many_tries', whatHappened: `${what} Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`, wasItSaved: 'not_saved',
    nextSafeAction: 'Wait, then ask for a new code. If you did not ask for these codes, ignore them.',
  }, { 'retry-after': String(retryAfterSeconds) });
  const cookie = (value: string, maxAge: number): string =>
    `${CUSTOMER_SESSION_COOKIE}=${value}; Path=${CUSTOMER_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

  const sweep = (nowMs: number): void => {
    for (const [k, c] of challenges) if (Date.parse(c.expiresAt) < nowMs || c.consumedAt !== undefined) challenges.delete(k);
    for (const [k, s] of sessions) if (nowMs - s.startedAt > CUSTOMER_SESSION_MAX_SECONDS * 1000) sessions.delete(k);
  };

  const addressOf = (req: CustomerSignInRequest): string =>
    `a:${req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.remoteAddress || 'unknown'}`;

  const bodyOf = (req: CustomerSignInRequest): Record<string, unknown> => {
    try {
      const v = JSON.parse(req.body === '' ? '{}' : req.body) as unknown;
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    } catch { return {}; }
  };

  /** The session a request's cookie names, its token renewed if it is about to run out; undefined when none or ended. */
  const current = async (req: CustomerSignInRequest): Promise<{ key: string; session: Session } | undefined> => {
    const id = cookieOf(req.headers);
    if (id === undefined || id === '') return undefined;
    const key = sha256(id);
    const session = sessions.get(key);
    if (session === undefined) return undefined;
    const nowMs = deps.now();
    if (nowMs - session.startedAt > CUSTOMER_SESSION_MAX_SECONDS * 1000) { sessions.delete(key); return undefined; }
    if (session.tokenExpiresAtMs - nowMs > CUSTOMER_REFRESH_MARGIN_SECONDS * 1000) return { key, session };
    if (deps.signer === undefined) { sessions.delete(key); return undefined; }
    try {
      const renewed = await deps.signer.signIn({ tenantId: deps.tenantId, phoneNumber: session.phoneNumber, amr: session.amr, authTimeMs: session.authTimeMs });
      if (renewed.subject !== session.subject) throw new Error('the signer named another customer');
      session.token = renewed.token;
      session.tokenExpiresAtMs = renewed.expiresAtMs;
      return { key, session };
    } catch (e) {
      sessions.delete(key);
      deps.audit({ event: 'customer_session_ended', subject: session.subject, why: `renewal refused: ${e instanceof Error ? e.message : String(e)}` });
      return undefined;
    }
  };

  return async (req) => {
    const url = new URL(req.url, 'https://customer-sign-in.invalid');
    const path = url.pathname;
    const nowMs = deps.now();
    sweep(nowMs);

    if (req.method !== 'POST') return refuse(405, { code: 'post_only', whatHappened: 'Sign-in takes POST requests only.', wasItSaved: 'not_saved', nextSafeAction: 'Use the sign-in screen.' }, { allow: 'POST' });
    // A request from another site is refused before anything is read (the cookie is SameSite=Strict as well).
    const origin = req.headers['origin'];
    if (origin !== undefined && (origin === 'null' || !sameOrigin(origin, deps.origin))) {
      deps.audit({ event: 'customer_sign_in_refused', why: 'cross-site request' });
      return refuse(403, { code: 'cross_site', whatHappened: 'This request did not come from the shop\'s own site, so it was refused.', wasItSaved: 'not_saved', nextSafeAction: 'Open the shop\'s own page and sign in there.' });
    }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return refuse(415, { code: 'json_only', whatHappened: 'Sign-in reads JSON only.', wasItSaved: 'not_saved', nextSafeAction: 'Use the sign-in screen.' });
    }
    const address = addressOf(req);

    // ── BEGIN: a code to the customer's phone ──────────────────────────────────────────────────────────────────────────
    if (path === '/auth/otp/begin') {
      // Said before anything else: with nothing to send through, or nobody to sign, no code is made at all.
      if (deps.sender === undefined) { deps.audit({ event: 'customer_code_refused', why: NO_SMS_PROVIDER.code }); return refuse(503, NO_SMS_PROVIDER); }
      if (deps.signer === undefined) { deps.audit({ event: 'customer_code_refused', why: NO_SIGNER.code }); return refuse(503, NO_SIGNER); }
      const phone = normaliseMobile(String(bodyOf(req)['phoneNumber'] ?? ''));
      if (phone === undefined) {
        return refuse(400, { code: 'not_a_mobile_number', whatHappened: 'That is not a 10-digit Indian mobile number.', wasItSaved: 'not_saved', nextSafeAction: 'Type the number again, like 98765 43210.' });
      }
      const locked = limits.wrongCodesPerNumber.status(numberKey(phone));
      if (locked.locked) { deps.audit({ event: 'customer_code_refused', why: 'number locked after wrong codes' }); return tooMany(locked.retryAfterSeconds, 'Too many wrong codes were typed for this number, so it is locked for a while.'); }
      const byAddress = await limits.codesPerAddress.take(address);
      if (!byAddress.allowed) { deps.audit({ event: 'customer_code_refused', why: 'too many codes from one address' }); return tooMany(byAddress.retryAfterSeconds, 'Too many codes were asked for from this connection.'); }
      const byNumber = await limits.codesPerNumber.take(numberKey(phone));
      if (!byNumber.allowed) { deps.audit({ event: 'customer_code_refused', why: 'too many codes for one number' }); return tooMany(byNumber.retryAfterSeconds, 'Too many codes were sent to this number.'); }
      if (challenges.size >= MAX_WAITING_CODES) {
        return refuse(503, { code: 'busy', whatHappened: 'Too many sign-ins are waiting at once. No code was sent.', wasItSaved: 'not_saved', nextSafeAction: 'Try again in a few minutes.' });
      }
      const challengeId = randomId(24);
      const begun = beginOtpChallenge({ challengeId, tenantId: deps.tenantId, phoneNumber: phone, purpose: 'login', now: new Date(nowMs).toISOString() });
      try {
        await deps.sender.send({ phoneNumber: phone, code: begun.code, purpose: 'login', tenantId: deps.tenantId });
      } catch (e) {
        deps.audit({ event: 'customer_code_not_sent', channel: deps.sender.channel, why: e instanceof Error ? e.name : 'send failed' });
        return refuse(502, { code: 'code_not_sent', whatHappened: 'The code could not be sent to your phone.', wasItSaved: 'not_saved', nextSafeAction: 'Check the number and try again in a minute.' });
      }
      challenges.set(challengeId, begun.challenge);
      deps.audit({ event: 'customer_code_sent', channel: deps.sender.channel });
      return json(200, { ok: true, challengeId, expiresAt: begun.challenge.expiresAt });
    }

    // ── VERIFY: the code the customer typed ────────────────────────────────────────────────────────────────────────────
    if (path === '/auth/otp/verify') {
      if (deps.signer === undefined) return refuse(503, NO_SIGNER);
      const addressLock = limits.wrongCodesPerAddress.status(address);
      if (addressLock.locked) return tooMany(addressLock.retryAfterSeconds, 'Too many wrong codes were typed from this connection.');
      const checks = await limits.checksPerAddress.take(address);
      if (!checks.allowed) return tooMany(checks.retryAfterSeconds, 'Too many codes were checked from this connection.');
      const b = bodyOf(req);
      const challenge = challenges.get(String(b['challengeId'] ?? ''));
      if (challenge === undefined) {
        limits.wrongCodesPerAddress.fail(address);
        return refuse(400, { code: 'no_such_code', whatHappened: 'That code has run out or was already used.', wasItSaved: 'not_saved', nextSafeAction: 'Ask for a new code.' });
      }
      const nKey = numberKey(challenge.phoneNumber);
      const numberLock = limits.wrongCodesPerNumber.status(nKey);
      if (numberLock.locked) return tooMany(numberLock.retryAfterSeconds, 'Too many wrong codes were typed for this number, so it is locked for a while.');
      const v = verifyOtp({ challenge, tenantId: deps.tenantId, submittedCode: String(b['code'] ?? '').trim(), now: new Date(nowMs).toISOString() });
      challenges.set(challenge.challengeId, v.challenge);
      if (!v.verified) {
        if (v.outcome === 'wrong_code') { limits.wrongCodesPerNumber.fail(nKey); limits.wrongCodesPerAddress.fail(address); }
        deps.audit({ event: 'customer_sign_in_refused', why: v.outcome });
        return refuse(401, {
          code: v.outcome,
          whatHappened: v.outcome === 'wrong_code' ? 'That code is not right.' : v.outcome === 'expired' ? 'That code has run out.' : 'That code cannot be used any more.',
          wasItSaved: 'not_saved',
          nextSafeAction: v.outcome === 'wrong_code' && v.challenge.attemptsRemaining > 0 ? 'Check the SMS and type the code again.' : 'Ask for a new code.',
        });
      }
      challenges.delete(challenge.challengeId); // single use: gone the moment it is spent
      limits.wrongCodesPerNumber.succeed(nKey);
      let signed: Awaited<ReturnType<CustomerSessionSigner['signIn']>>;
      try {
        signed = await deps.signer.signIn({ tenantId: deps.tenantId, phoneNumber: challenge.phoneNumber, amr: ['otp'], authTimeMs: nowMs });
      } catch (e) {
        deps.audit({ event: 'customer_sign_in_refused', why: `the signer refused: ${e instanceof Error ? e.message : String(e)}` });
        return refuse(503, { code: 'sign_in_not_confirmed', whatHappened: 'Your code was right, but the sign-in could not be confirmed.', wasItSaved: 'not_saved', nextSafeAction: 'Ask for a new code in a minute.' });
      }
      if (sessions.size >= MAX_CUSTOMER_SESSIONS) {
        return refuse(503, { code: 'busy', whatHappened: 'Too many customers are signed in at once.', wasItSaved: 'not_saved', nextSafeAction: 'Try again in a few minutes.' });
      }
      const id = randomId(32);
      sessions.set(sha256(id), {
        subject: signed.subject, phoneNumber: challenge.phoneNumber, amr: ['otp'], authTimeMs: nowMs, startedAt: nowMs,
        token: signed.token, tokenExpiresAtMs: signed.expiresAtMs,
      });
      deps.audit({ event: 'customer_signed_in', subject: signed.subject, by: 'otp', signer: deps.signer.name });
      return json(200, { ok: true, token: signed.token, expiresAt: new Date(signed.expiresAtMs).toISOString() }, { 'set-cookie': cookie(id, CUSTOMER_SESSION_MAX_SECONDS) });
    }

    // ── SESSION: the page asks for a current token again (after a reload, or before the last one runs out) ────────────
    if (path === '/auth/otp/session') {
      const here = await current(req);
      if (here === undefined) return refuse(401, { code: 'not_signed_in', whatHappened: 'You are not signed in.', wasItSaved: 'not_saved', nextSafeAction: 'Sign in with a code to your phone.' });
      return json(200, { ok: true, token: here.session.token, expiresAt: new Date(here.session.tokenExpiresAtMs).toISOString() });
    }

    // ── CHECK: may this session do this action, or must the customer prove more? ────────────────────────────────────────
    if (path === '/auth/otp/check') {
      const here = await current(req);
      if (here === undefined) return json(401, { ok: false, outcome: 'session_invalid' });
      const step = evaluateStepUp({ action: String(bodyOf(req)['action'] ?? ''), amr: here.session.amr, authTimeMs: here.session.authTimeMs, nowMs, policy: deps.stepUp });
      return json(200, { ok: true, outcome: step.outcome });
    }

    // ── SIGN-OUT: the session ends here at once; the cookie is cleared ─────────────────────────────────────────────────
    if (path === '/auth/otp/signout') {
      const id = cookieOf(req.headers);
      const key = id === undefined || id === '' ? undefined : sha256(id);
      const session = key === undefined ? undefined : sessions.get(key);
      if (key !== undefined) sessions.delete(key);
      if (session !== undefined) deps.audit({ event: 'customer_signed_out', subject: session.subject });
      return json(200, { ok: true, signedOut: session !== undefined }, { 'set-cookie': cookie('', 0) });
    }

    return refuse(404, { code: 'no_such_step', whatHappened: 'There is no such sign-in step.', wasItSaved: 'not_saved', nextSafeAction: 'Use the sign-in screen.' });
  };
}
