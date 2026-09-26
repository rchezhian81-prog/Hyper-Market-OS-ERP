// Local / test identity provider — a standards-compliant HS256 JWT issuer (Phase 2, supports OA-4).
//
// Production issues NO tokens: `services/identity` verifies and never mints, because a module that
// can mint tokens is a token factory (hard rule #4). This is the counterpart that lives OUTSIDE
// production — a small, standards-compliant issuer that stands in for the deployment identity
// provider until one is chosen (OA-4). It signs exactly what `verifyToken` expects: HS256 over
// { sub, tenant_id, branch_id?, iss, aud, exp, nbf? }. A guardrail proves that nothing under
// `services/`, `apps/`, or `edge/` imports it, so the "no minting in production" property holds.

import { createHmac } from 'node:crypto';
import type {
  IdentityClaims,
  IdentityProviderPort,
  IssueOptions,
  IssuedToken,
} from '../../packages/identity/src/index';

export interface IdpClaims {
  readonly sub: string;
  readonly tenantId: string;
  readonly branchId?: string;
  /** Seconds from now until expiry (default 3600). A negative value mints an already-expired token. */
  readonly ttlSeconds?: number;
  /** Not-before, seconds from now (optional). */
  readonly notBeforeSeconds?: number;
  /**
   * `auth_time` for step-up (SEC-03 / GAP-SEC-06), as SECONDS FROM NOW (0 = just re-authenticated;
   * negative = in the past). Default `0` (a fresh sign-in), so an ordinary token satisfies a step-up
   * route. Pass a large negative (e.g. `-10000`) to mint a stale re-auth, or `null` to omit the claim
   * entirely (a token with NO re-auth evidence).
   */
  readonly authTimeFromNowSeconds?: number | null;
  /**
   * `amr` — the authentication methods to record. Default `['pwd', 'mfa']` (a real, MFA-backed
   * sign-in). Pass `['pwd']` to mint a single-factor sign-in, or `null` to omit the claim.
   */
  readonly amr?: readonly string[] | null;
}

export interface LocalIdpConfig {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  readonly now?: () => number;
  /** Header algorithm. Real issuers use HS256; a test can force 'none' etc. to prove rejection. */
  readonly alg?: string;
}

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

/**
 * A standards-compliant local IdP. `issue()` mints a signed token for a principal; the same secret,
 * issuer and audience configured on the API's `tokenAuthenticator` (via `policy()`) verify it.
 */
export class LocalIdp {
  constructor(private readonly config: LocalIdpConfig) {}

  issue(claims: IdpClaims): string {
    const nowSec = Math.floor((this.config.now?.() ?? Date.now()) / 1000);
    const header = b64url({ alg: this.config.alg ?? 'HS256', typ: 'JWT' });
    // Step-up evidence carried by default so an ordinary token satisfies a sensitive route
    // (SEC-03 / GAP-SEC-06). `null` on either field omits it, for the "no/weak re-auth" negatives.
    const authTime = claims.authTimeFromNowSeconds === null
      ? undefined
      : nowSec + (claims.authTimeFromNowSeconds ?? 0);
    const amr = claims.amr === null ? undefined : (claims.amr ?? ['pwd', 'mfa']);
    const payload = b64url({
      sub: claims.sub,
      tenant_id: claims.tenantId,
      ...(claims.branchId === undefined ? {} : { branch_id: claims.branchId }),
      ...(claims.notBeforeSeconds === undefined ? {} : { nbf: nowSec + claims.notBeforeSeconds }),
      ...(authTime === undefined ? {} : { auth_time: authTime }),
      ...(amr === undefined ? {} : { amr: [...amr] }),
      iss: this.config.issuer,
      aud: this.config.audience,
      exp: nowSec + (claims.ttlSeconds ?? 3600),
    });
    const signature = createHmac('sha256', this.config.secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  /** The verifier policy that matches this issuer — pass straight to `tokenAuthenticator`. */
  policy(): { readonly secret: string; readonly issuer: string; readonly audience: string } {
    return { secret: this.config.secret, issuer: this.config.issuer, audience: this.config.audience };
  }

  /** A sibling issuer with a DIFFERENT secret — for "correctly signed by the wrong key" tests. */
  withDifferentKey(secret: string): LocalIdp {
    return new LocalIdp({ ...this.config, secret });
  }
}

// ── Provider-neutral port implementation (M02 / M20 / M22) ───────────────────
//
// `IdentityProviderPort` (the productized contract) lives in `packages/identity` as types only —
// production-safe. This is its deterministic TEST implementation, carrying the full claim set the
// port defines (including email / phone / amr, which the older `LocalIdp.issue` above does not).
// It lives HERE, in tests/support, for the same reason `LocalIdp` does: production must never be
// able to mint a token (hard rule #4), which the `no-test-idp-in-production` guardrail enforces.

/** What the local/test IdP needs to interlock with the API's `TokenPolicy`. */
export interface LocalTestIdpConfig {
  /** The provider's stable id (recorded on the audit trail). */
  readonly providerId: string;
  /** Who the token says issued it (`iss`) — must equal the verifier's `policy.issuer`. */
  readonly issuer: string;
  /** Who the token is for (`aud`) — must include the verifier's `policy.audience`. */
  readonly audience: string;
  /** The HMAC signing secret — must equal the verifier's `policy.secret`. From configuration only. */
  readonly secret: string;
}

/**
 * A deterministic local/test identity provider that implements the provider-neutral port.
 *
 * It mints the exact compact HS256 JWS `verifyToken` verifies. Deterministic: the same claims and
 * options produce the same token, byte for byte. Pure of I/O — the clock is injected via
 * `IssueOptions.issuedAtMs`.
 */
export function createLocalTestIdp(config: LocalTestIdpConfig): IdentityProviderPort {
  return {
    providerId: config.providerId,
    issue(claims: IdentityClaims, options: IssueOptions): IssuedToken {
      const iat = Math.floor(options.issuedAtMs / 1000);
      const exp = iat + options.ttlSeconds;
      const header = b64url({ alg: 'HS256', typ: 'JWT' });
      // Key order fixed literally so the encoding is deterministic; `verifyToken` reads by key.
      const payloadObject: Record<string, unknown> = {
        iss: config.issuer,
        aud: config.audience,
        sub: claims.subject,
        tenant_id: claims.tenantId,
        iat,
        exp,
      };
      if (claims.branchId !== undefined) payloadObject['branch_id'] = claims.branchId;
      if (claims.email !== undefined) payloadObject['email'] = claims.email;
      if (claims.phoneNumber !== undefined) payloadObject['phone_number'] = claims.phoneNumber;
      if (claims.amr !== undefined) payloadObject['amr'] = [...claims.amr];
      if (claims.authTime !== undefined) payloadObject['auth_time'] = claims.authTime;

      const payload = b64url(payloadObject);
      const signature = createHmac('sha256', config.secret)
        .update(`${header}.${payload}`)
        .digest('base64url');
      return {
        token: `${header}.${payload}.${signature}`,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    },
  };
}

/** Corrupt a token's signature (flip the last character) — for "bad signature" tests. */
export function tamperSignature(token: string): string {
  const [h, p, s] = token.split('.');
  const sig = s ?? '';
  // Flip a character at the FRONT, never the end. The last base64url char of a 32-byte HMAC signature
  // carries only 4 significant bits — the decoder discards the low 2 as padding — so flipping it
  // (e.g. 'A'↔'B') can decode to the SAME bytes and leave the signature genuinely valid, which made
  // this helper pass ~1 run in 16 and flaked the auth suite. The first char's 6 bits are all
  // significant, so changing it always changes the signature: the tamper is now real every time.
  const first = sig.charAt(0) === 'A' ? 'B' : 'A';
  return `${h}.${p}.${first}${sig.slice(1)}`;
}
