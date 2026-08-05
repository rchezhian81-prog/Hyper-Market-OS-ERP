// Turning a token into a principal — API-01, SEC-02/03, M02-FR-01, hard rules #3 #4.
//
// Until now the API's `authenticate` returned `undefined` for every caller. That was default-deny
// rather than a bypass, so nothing was exposed — but it also meant nobody could use the system.
// This is the piece that resolves a bearer token into *who is asking and on whose behalf*.
//
// **It verifies. It never issues, and it never stores a credential.** No password, no passkey, no
// MFA secret is held anywhere in this codebase — that belongs to the deployment's identity
// provider, and putting it here would break hard rule #4. M02-FR-01 is a deliberate partial for
// exactly this reason. What arrives is a token the IdP signed; what this decides is whether to
// believe it, and what scope it carries.
//
// The consequence is worth stating plainly: **until an identity provider is configured, nobody can
// log in.** That is the correct failure. Authentication without either an IdP or stored
// credentials is not something to improvise, and a system that lets people in while the question
// is unsettled is a system that will still be letting them in after it is settled.
//
// ── The attacks this is shaped around ────────────────────────────────────────
//
// Every one of these is a real, repeatedly-shipped bug in token verification, and every one of
// them comes from the same mistake — **believing something the token said about itself**:
//
//   • `alg: none`. The header claims the token is unsigned, the library obliges, and any string
//     is now a valid token. Here the algorithm comes from *our* configuration and the header's
//     `alg` is checked against it rather than read from it.
//   • **RS256 → HS256 confusion.** An attacker re-signs with HMAC using the public key as the
//     secret, and a library that picks its algorithm from the header verifies it happily. Same
//     defence: the header never chooses.
//   • **Reading claims before checking the signature.** Anything decoded from an unverified token
//     is attacker-controlled text. The signature is checked first, always.
//   • **A token with no expiry.** It works forever, including after the person leaves. `exp` is
//     required rather than defaulted.
//   • **A valid token from somewhere else.** Correctly signed, genuinely unexpired, and issued by
//     a different system or for a different service. `iss` and `aud` are pinned.
//   • **A tenant swapped in the claims.** The whole isolation boundary is `tenantId` (OB-01), so
//     it must come from the signed payload and nowhere else — never from a header, a query
//     parameter or a path segment a caller controls.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Principal } from '../../kernel/src/index';

/** Why a token was not believed. Never returned to the caller — the reply is always "unauthenticated". */
export type TokenRefusal =
  | 'not_three_parts'
  | 'header_unreadable'
  | 'payload_unreadable'
  | 'algorithm_not_ours'
  | 'signature_does_not_verify'
  | 'no_expiry'
  | 'expired'
  | 'not_yet_valid'
  | 'issuer_not_ours'
  | 'audience_not_ours'
  | 'no_subject'
  | 'no_tenant';

export interface TokenVerdict {
  readonly ok: boolean;
  readonly principal?: Principal;
  readonly refusedBecause?: TokenRefusal;
  /** For the audit log and the operator. It never contains any part of the token. */
  readonly detail: string;
}

export interface TokenPolicy {
  /** The IdP's shared secret. From configuration, never from the token. */
  readonly secret: string;
  /** Who must have issued it. */
  readonly issuer: string;
  /** Who it must have been issued *for* — this API, not another service of ours. */
  readonly audience: string;
  /**
   * Clock skew allowed, in seconds. Small and explicit.
   *
   * Some allowance is needed because two machines are never exactly in step, and a token rejected
   * for being one second early is an outage nobody can reproduce. Large allowance is a token that
   * outlives its own expiry, so this is seconds rather than minutes.
   */
  readonly leewaySeconds?: number;
}

const decode = (part: string): unknown => {
  const json = Buffer.from(part, 'base64url').toString('utf8');
  return JSON.parse(json) as unknown;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Does this token's audience list include ours?
 *
 * `aud` is allowed to be a string or an array of strings, and a token issued for three services
 * naming ours among them is legitimately for us. What is not allowed is the check reducing to
 * "some audience was present".
 */
const audienceIncludes = (aud: unknown, ours: string): boolean =>
  typeof aud === 'string' ? aud === ours
    : Array.isArray(aud) && aud.some((a) => a === ours);

/**
 * Verify a bearer token and resolve it to a principal.
 *
 * The order is deliberate and is the whole design: **shape, then algorithm, then signature, then
 * claims.** Nothing from the payload is trusted — or even read — until the signature has been
 * checked, because until then every byte of it is text an attacker wrote.
 */
export function verifyToken(token: string, policy: TokenPolicy, nowMs: number): TokenVerdict {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, refusedBecause: 'not_three_parts', detail: 'the token is not a three-part signed token' };
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: unknown;
  try { header = decode(headerPart); } catch {
    return { ok: false, refusedBecause: 'header_unreadable', detail: 'the token header is not readable JSON' };
  }
  if (!isRecord(header)) {
    return { ok: false, refusedBecause: 'header_unreadable', detail: 'the token header is not an object' };
  }

  // The algorithm is OURS. The header is checked against it, never consulted for it — which is
  // what makes `alg: none` and the RS256→HS256 confusion attack simply not apply.
  if (header['alg'] !== 'HS256') {
    return {
      ok: false, refusedBecause: 'algorithm_not_ours',
      detail: `the token asks to be verified with "${String(header['alg'])}" and this service verifies HS256. A token does not get to choose how it is checked`,
    };
  }

  const expected = createHmac('sha256', policy.secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest();
  let given: Buffer;
  try { given = Buffer.from(signaturePart, 'base64url'); } catch {
    return { ok: false, refusedBecause: 'signature_does_not_verify', detail: 'the signature is not readable' };
  }
  // Length first: `timingSafeEqual` throws on a mismatch rather than returning false.
  if (given.length !== expected.length || !timingSafeEqual(expected, given)) {
    return { ok: false, refusedBecause: 'signature_does_not_verify', detail: 'the signature does not verify against the issuer key' };
  }

  // ── Only now is the payload worth reading ─────────────────────────────────
  let payload: unknown;
  try { payload = decode(payloadPart); } catch {
    return { ok: false, refusedBecause: 'payload_unreadable', detail: 'the token payload is not readable JSON' };
  }
  if (!isRecord(payload)) {
    return { ok: false, refusedBecause: 'payload_unreadable', detail: 'the token payload is not an object' };
  }

  const leeway = (policy.leewaySeconds ?? 30) * 1000;

  if (typeof payload['exp'] !== 'number') {
    return {
      ok: false, refusedBecause: 'no_expiry',
      detail: 'the token carries no expiry. A token that never expires still works after the person who held it has left',
    };
  }
  if (payload['exp'] * 1000 + leeway < nowMs) {
    return { ok: false, refusedBecause: 'expired', detail: 'the token has expired' };
  }
  if (typeof payload['nbf'] === 'number' && payload['nbf'] * 1000 - leeway > nowMs) {
    return { ok: false, refusedBecause: 'not_yet_valid', detail: 'the token is not valid yet' };
  }

  if (payload['iss'] !== policy.issuer) {
    return {
      ok: false, refusedBecause: 'issuer_not_ours',
      detail: 'the token was issued by a different system. A correctly signed token from somewhere else is still not a token for here',
    };
  }
  if (!audienceIncludes(payload['aud'], policy.audience)) {
    return {
      ok: false, refusedBecause: 'audience_not_ours',
      detail: 'the token was issued for a different service. One of ours is not all of ours',
    };
  }

  const userId = payload['sub'];
  if (typeof userId !== 'string' || userId.trim() === '') {
    return { ok: false, refusedBecause: 'no_subject', detail: 'the token names no user' };
  }
  // The isolation boundary, taken from the signed payload and nowhere else (OB-01). A tenant read
  // off a header or a path is a tenant the caller chose.
  const tenantId = payload['tenant_id'];
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    return { ok: false, refusedBecause: 'no_tenant', detail: 'the token names no tenant' };
  }

  const branch = payload['branch_id'];
  return {
    ok: true,
    principal: {
      tenantId,
      userId,
      // Null is "every branch this user's roles allow", which RBAC then narrows. It is not "any".
      branchId: typeof branch === 'string' && branch !== '' ? branch : null,
    },
    detail: `${userId} of ${tenantId}`,
  };
}

/**
 * The kernel's `Authenticator`, built from a policy.
 *
 * It returns a principal or nothing — **never a reason**. The caller is told "unauthenticated" and
 * no more, because "the signature did not verify" and "that token expired" are different sentences
 * and the difference is free information for whoever is trying tokens. The reason goes to the
 * audit log via `onRefusal`, where the operator can read it and the caller cannot.
 */
export function tokenAuthenticator(
  policy: TokenPolicy,
  onRefusal?: (r: TokenRefusal, detail: string) => void,
  now: () => number = () => Date.now(),
): (token: string) => Principal | undefined {
  return (token) => {
    const verdict = verifyToken(token, policy, now());
    if (verdict.ok) return verdict.principal;
    onRefusal?.(verdict.refusedBecause!, verdict.detail);
    return undefined;
  };
}
