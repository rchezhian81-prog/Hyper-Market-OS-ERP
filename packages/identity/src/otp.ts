// One-time-passcode challenge/verify for customer mobile login (M02 / M20 / M22).
//
// A retail customer has no company laptop and no password manager — the honest second factor for
// them is a code to the phone they already hold. This is the engine that makes that safe. It does
// three jobs and refuses to do a fourth:
//
//   • it MINTS a short-lived numeric code and stores only its HASH — the code itself is a credential
//     and is never written to the challenge, a log or the database (hard rule #4). The plaintext
//     lives just long enough to hand to the sender;
//   • it VERIFIES a submitted code against that hash, within a time window and a small attempt
//     budget, and is SINGLE-USE — a verified code cannot be replayed;
//   • it is TENANT-SCOPED — a code issued for one tenant cannot be spent by another (OB-01), even
//     when the digits are right.
//
// It does NOT send the SMS. Delivery is a provider-neutral port (`OtpSender`); a real SMS/WhatsApp
// provider implements it (externally gated), and a test simulator implements it for development and
// E2E. So the whole OTP flow is buildable and testable now, with the live sender the only gate.
//
// Pure and deterministic: the clock is injected, and the code is injectable so a test is repeatable;
// only the hashing and the default code generation touch `node:crypto`, both deterministic given
// their inputs.

import { createHash, randomInt } from 'node:crypto';

/** Why a code is being asked for. A login code must not be spendable as a re-auth code. */
export type OtpPurpose = 'login' | 'reauth' | 'enrolment';

export interface OtpChallenge {
  readonly challengeId: string;
  readonly tenantId: string;
  readonly phoneNumber: string;
  readonly purpose: OtpPurpose;
  /** `sha256(challengeId:code)` — the code itself is NEVER stored (it is a credential, hard rule #4). */
  readonly codeHash: string;
  readonly expiresAt: string;
  readonly attemptsRemaining: number;
  /** Set once a correct code is accepted, so the code cannot be replayed (single-use). */
  readonly consumedAt?: string;
}

/** Hash a code for storage/comparison. The challengeId salts it, so the same code in two challenges
 *  hashes differently and a stolen hash from one is useless against another. */
const hashCode = (challengeId: string, code: string): string =>
  createHash('sha256').update(`${challengeId}:${code}`).digest('hex');

/**
 * Generate a numeric OTP of `digits` length (default 6) using the crypto RNG.
 *
 * Padded so a leading-zero code keeps its length — `randomInt` can return e.g. 42, which as "42"
 * would be a two-digit code a user is told is six.
 */
export function generateOtpCode(digits = 6): string {
  const max = 10 ** digits;
  return String(randomInt(0, max)).padStart(digits, '0');
}

export interface BegunOtp {
  readonly challenge: OtpChallenge;
  /** The plaintext code to hand to the sender. Transient — never store it, never log it. */
  readonly code: string;
}

/**
 * Begin an OTP challenge: mint (or accept) a code, store its hash, and return both the persistable
 * challenge and the transient code to send.
 */
export function beginOtpChallenge(input: {
  readonly challengeId: string;
  readonly tenantId: string;
  readonly phoneNumber: string;
  readonly purpose: OtpPurpose;
  /** Injectable for deterministic tests; a real caller omits it and one is generated. */
  readonly code?: string;
  readonly now: string;
  readonly ttlSeconds?: number;
  readonly maxAttempts?: number;
}): BegunOtp {
  const code = input.code ?? generateOtpCode();
  const ttl = input.ttlSeconds ?? 300; // five minutes
  const maxAttempts = input.maxAttempts ?? 5;
  const expiresAt = new Date(Date.parse(input.now) + ttl * 1000).toISOString();
  return {
    code,
    challenge: {
      challengeId: input.challengeId,
      tenantId: input.tenantId,
      phoneNumber: input.phoneNumber,
      purpose: input.purpose,
      codeHash: hashCode(input.challengeId, code),
      expiresAt,
      attemptsRemaining: maxAttempts,
    },
  };
}

export type OtpOutcome =
  | 'verified'
  | 'wrong_code' // a wrong guess — one attempt is spent
  | 'expired'
  | 'no_attempts_left' // the budget is used up; a fresh challenge is required
  | 'already_used' // this challenge was already spent (single-use)
  | 'tenant_mismatch'; // the code belongs to a different tenant (OB-01)

export interface OtpVerification {
  readonly outcome: OtpOutcome;
  readonly verified: boolean;
  /** The challenge's new state (attempts decremented, or marked consumed) — the caller persists it. */
  readonly challenge: OtpChallenge;
}

/**
 * Verify a submitted code against a stored challenge, for the tenant that is asking.
 *
 * Order matters: a spent or wrong-tenant or expired or exhausted challenge is refused BEFORE the
 * code is compared, so a guesser learns nothing from timing, and a correct guess on a dead challenge
 * is still no. Every refusal returns the (possibly updated) challenge so nothing is lost silently.
 */
export function verifyOtp(input: {
  readonly challenge: OtpChallenge;
  readonly tenantId: string;
  readonly submittedCode: string;
  readonly now: string;
}): OtpVerification {
  const { challenge } = input;
  const refuse = (outcome: OtpOutcome, next: OtpChallenge = challenge): OtpVerification =>
    ({ outcome, verified: false, challenge: next });

  if (challenge.consumedAt !== undefined) return refuse('already_used');
  if (input.tenantId !== challenge.tenantId) return refuse('tenant_mismatch');
  if (Date.parse(input.now) > Date.parse(challenge.expiresAt)) return refuse('expired');
  if (challenge.attemptsRemaining <= 0) return refuse('no_attempts_left');

  if (hashCode(challenge.challengeId, input.submittedCode) !== challenge.codeHash) {
    return refuse('wrong_code', { ...challenge, attemptsRemaining: challenge.attemptsRemaining - 1 });
  }

  return {
    outcome: 'verified',
    verified: true,
    challenge: { ...challenge, consumedAt: input.now },
  };
}

/**
 * Provider-neutral OTP delivery. A real SMS/WhatsApp provider implements this (externally gated);
 * a test simulator implements it for development and E2E. The engine hands the transient code here
 * and holds only the hash.
 */
export interface OtpSender {
  /** The channel this sender delivers on — recorded so a login's second factor is auditable. */
  readonly channel: string;
  send(input: {
    readonly phoneNumber: string;
    readonly code: string;
    readonly purpose: OtpPurpose;
    readonly tenantId: string;
  }): void | Promise<void>;
}
