// Provider-neutral OIDC/OAuth identity port (M02 / M20 / M22 — external customer & B2B login).
//
// The store must let outside people in — a B2B customer checking their collections, a retail
// customer managing their own data — WITHOUT the store ever holding their password. That is the
// whole point of federated identity: a provider authenticates the person and asserts a small set
// of TRUSTED CLAIMS about them; the store believes the claims (because they are signed) and binds
// its own accounts from them, never from anything the caller typed into a header or a path.
//
// This is the PORT — types only, so it is production-safe. A real OIDC/OAuth provider maps its
// ID-token claims onto `IdentityClaims`; a deterministic local/test IdP (`createLocalTestIdp`,
// which lives only in the repository's test-support tree) mints them for development and tests.
// Everything downstream depends on THIS interface, never a concrete provider — so swapping in a
// live provider later is a composition-root change, not a rewrite (P-06). Choosing the production
// provider and holding its credentials is the only externally-gated part; the contract is not.
//
// Deliberately, the port contains NO token-minting code. Production must never be able to mint a
// token — a module that can mint is a token factory (hard rule #4) — so the only implementations
// that MINT live in the test-support tree, where the `no-test-idp-in-production` guardrail proves no
// production source imports them. A real provider implements this port by VERIFYING its own
// upstream token and re-issuing a short-lived internal one at the edge, not by embedding a signer.
//
// The token a test IdP issues is the exact compact HS256 JWS that `services/identity/token.ts`
// `verifyToken` already checks — so issuance and verification are two ends of one wire, and the
// unit tests prove the round trip and every tampering refusal against the REAL verifier.

/**
 * The trusted claims a provider asserts about an authenticated subject.
 *
 * `subject` + `tenantId` are the isolation-critical pair: downstream binds accounts from these
 * (OB-01), and a tenant read from anywhere but a signed claim is a tenant the caller chose.
 */
export interface IdentityClaims {
  /** The provider's stable id for this person (`sub`). Never an email — emails get reassigned. */
  readonly subject: string;
  /** The isolation boundary (`tenant_id`). */
  readonly tenantId: string;
  /** The person's email, when the provider asserts one. */
  readonly email?: string;
  /** The person's phone, when the provider asserts one (a customer who logged in by OTP). */
  readonly phoneNumber?: string;
  /**
   * Authentication Methods References (`amr`) — how the person proved themselves this session,
   * e.g. `['pwd']`, `['otp']`, `['pwd','mfa']`. A sensitive action later reads this to decide
   * whether a re-authentication or a second factor is still required.
   */
  readonly amr?: readonly string[];
  /**
   * When the person actually authenticated (`auth_time`, epoch seconds) — distinct from when the
   * token was issued (`iat`), because a refreshed token keeps the original auth_time. A sensitive
   * action reads this to decide whether the login is still fresh enough or a re-authentication is due.
   */
  readonly authTime?: number;
  /** The branch the person is scoped to, when applicable (`branch_id`). */
  readonly branchId?: string;
}

/** A minted bearer token and when it stops being believed. */
export interface IssuedToken {
  /** The compact HS256 JWS `verifyToken` accepts (`header.payload.signature`, base64url). */
  readonly token: string;
  /** When the token expires (ISO 8601) — the same instant `exp` encodes, for the caller's clock. */
  readonly expiresAt: string;
}

/** How long a freshly minted token is valid, and the clock to stamp it from. */
export interface IssueOptions {
  /** "Now" in epoch milliseconds — injected, so issuance is deterministic and testable. */
  readonly issuedAtMs: number;
  /** Lifetime in seconds. Kept short; a portal renews rather than issuing long-lived tokens. */
  readonly ttlSeconds: number;
}

/**
 * Provider-neutral identity port.
 *
 * A real OIDC/OAuth provider and the deterministic local/test IdP both implement this. Downstream
 * services depend on the port; only the composition root names a concrete provider.
 */
export interface IdentityProviderPort {
  /** The provider's stable id — recorded on the audit trail so every login names its issuer. */
  readonly providerId: string;
  /** Mint a token carrying the trusted claims, verifiable by our own `verifyToken`. */
  issue(claims: IdentityClaims, options: IssueOptions): IssuedToken;
}
