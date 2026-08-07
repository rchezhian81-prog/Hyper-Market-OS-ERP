// Local / test identity provider — a standards-compliant HS256 JWT issuer (Phase 2, supports OA-4).
//
// Production issues NO tokens: `services/identity` verifies and never mints, because a module that
// can mint tokens is a token factory (hard rule #4). This is the counterpart that lives OUTSIDE
// production — a small, standards-compliant issuer that stands in for the deployment identity
// provider until one is chosen (OA-4). It signs exactly what `verifyToken` expects: HS256 over
// { sub, tenant_id, branch_id?, iss, aud, exp, nbf? }. A guardrail proves that nothing under
// `services/`, `apps/`, or `edge/` imports it, so the "no minting in production" property holds.

import { createHmac } from 'node:crypto';

export interface IdpClaims {
  readonly sub: string;
  readonly tenantId: string;
  readonly branchId?: string;
  /** Seconds from now until expiry (default 3600). A negative value mints an already-expired token. */
  readonly ttlSeconds?: number;
  /** Not-before, seconds from now (optional). */
  readonly notBeforeSeconds?: number;
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
    const payload = b64url({
      sub: claims.sub,
      tenant_id: claims.tenantId,
      ...(claims.branchId === undefined ? {} : { branch_id: claims.branchId }),
      ...(claims.notBeforeSeconds === undefined ? {} : { nbf: nowSec + claims.notBeforeSeconds }),
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

/** Corrupt a token's signature (flip the last character) — for "bad signature" tests. */
export function tamperSignature(token: string): string {
  const [h, p, s] = token.split('.');
  const sig = s ?? '';
  const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A');
  return `${h}.${p}.${flipped}`;
}
