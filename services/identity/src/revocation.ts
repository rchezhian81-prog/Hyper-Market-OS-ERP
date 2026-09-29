// Token revocation — the API-tier denylist that cuts a session short of its expiry (GAP-SEC-05 · SEC-03 ·
// SEC-11 · OB-01 · hard rules #2, #6).
//
// A verified token is, by itself, good until `exp` — that is what makes it fast (no database hit per request).
// But some things must end a session NOW: a stolen or leaked token, a laptop left signed in, an employee who
// left this morning, a credential that was just rotated. None of them can wait for `exp`, and the token
// lifetime ceiling (`TokenPolicy.maxLifetimeSeconds`) only bounds how long "wait" could be. So this is the
// other half: an append-only, tenant-scoped list of revocations the authenticator consults AFTER the
// signature and claims verify and BEFORE the principal is handed to the pipeline.
//
// Two shapes of revocation, because two shapes of token exist:
//   • by `jti` — ONE token (the IdP put an id on it); the precise cut.
//   • by subject — EVERY token of one user issued at or before a moment (`issuedBefore`). This is the leaver /
//     "sign me out everywhere" / rotated-credential case, and it needs no `jti` at all. A token that carries no
//     `iat` under a subject revocation is refused — fail closed: a token that cannot prove it is newer than the
//     revocation is not newer than the revocation.
//
// The list is a per-tenant cache over an append-only store (the identity ledger in production), refreshed after
// `refreshAfterMs` so a revocation recorded by ANOTHER API instance is honoured within that window on this one
// (single instance: immediate, because the route that records it updates this cache directly). That window is
// the honest residual (GAP-SEC-05b); a shared store is the technology-baseline answer for a multi-instance cloud.
//
// `packages/identity/src/session-revocation.ts` holds the customer-portal (session-id) engine and its reasons;
// the reasons are shared so an auditor reads one vocabulary.

import type { Principal } from '../../kernel/src/index';
import type { RevocationReason } from '../../../packages/identity/src/session-revocation';
import { verifyToken, type TokenPolicy, type TokenRefusal } from './token';

export type { RevocationReason } from '../../../packages/identity/src/session-revocation';
export const REVOCATION_REASONS: readonly RevocationReason[] = ['signed_out', 'admin_revoked', 'security', 'credential_change'];

/** One recorded revocation. Exactly one of `jti` / `userId` is set. Append-only: never edited, never removed. */
export interface TokenRevocation {
  readonly id: string;
  readonly tenantId: string;
  /** Revoke ONE token by its id. */
  readonly jti?: string;
  /** Revoke EVERY token of this user issued at or before `issuedBefore`. */
  readonly userId?: string;
  /** Epoch seconds. Present with `userId`. */
  readonly issuedBefore?: number;
  readonly reason: RevocationReason;
  /** Who cut it off — the acting user, never client-supplied. */
  readonly revokedBy: string;
  readonly revokedAt: string;
}

/** The claims the revocation check reads, taken from the VERIFIED token. */
export interface RevocationClaims {
  readonly sub: string;
  readonly jti?: string;
  readonly iat?: number;
}

export interface RevocationDecision {
  readonly revoked: boolean;
  readonly because?: string;
}

/** Where revocations are kept durably — the identity ledger in production, memory in tests. */
export interface TokenRevocationStore {
  readonly load: (tenantId: string) => Promise<readonly TokenRevocation[]> | readonly TokenRevocation[];
  readonly record: (tenantId: string, revocation: TokenRevocation) => Promise<void> | void;
}

/** In-memory store — the behavioural reference; production wires the ledger-backed adapter. */
export class InMemoryTokenRevocationStore implements TokenRevocationStore {
  private readonly byTenant = new Map<string, TokenRevocation[]>();
  load(tenantId: string): readonly TokenRevocation[] { return [...(this.byTenant.get(tenantId) ?? [])]; }
  record(tenantId: string, revocation: TokenRevocation): void {
    const list = this.byTenant.get(tenantId) ?? [];
    if (!list.some((r) => r.id === revocation.id)) list.push(revocation);
    this.byTenant.set(tenantId, list);
  }
}

/** Pure: does this set of revocations cut off a token with these claims? */
export function decideRevocation(revocations: readonly TokenRevocation[], claims: RevocationClaims): RevocationDecision {
  for (const r of revocations) {
    if (r.jti !== undefined && claims.jti !== undefined && r.jti === claims.jti) {
      return { revoked: true, because: `token ${r.jti} was revoked (${r.reason}) by ${r.revokedBy} at ${r.revokedAt}` };
    }
    if (r.userId !== undefined && r.userId === claims.sub && r.issuedBefore !== undefined) {
      if (claims.iat === undefined) {
        return { revoked: true, because: `every token of ${r.userId} issued up to ${r.issuedBefore} was revoked (${r.reason}) and this one carries no iat, so it cannot show it is newer` };
      }
      if (claims.iat <= r.issuedBefore) {
        return { revoked: true, because: `every token of ${r.userId} issued up to ${r.issuedBefore} was revoked (${r.reason}) by ${r.revokedBy}; this one was issued at ${claims.iat}` };
      }
    }
  }
  return { revoked: false };
}

/**
 * The per-tenant revocation list the authenticator consults: a cache over the store, refreshed after
 * `refreshAfterMs` (default 60s) so another instance's revocation lands here within the window; a revocation
 * recorded THROUGH this list is in force on this instance at once.
 */
export class TokenRevocationList {
  private readonly cache = new Map<string, { at: number; items: readonly TokenRevocation[] }>();
  private readonly refreshAfterMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: TokenRevocationStore = new InMemoryTokenRevocationStore(),
    opts: { readonly refreshAfterMs?: number; readonly now?: () => number } = {},
  ) {
    this.refreshAfterMs = opts.refreshAfterMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async list(tenantId: string): Promise<readonly TokenRevocation[]> {
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && this.now() - cached.at < this.refreshAfterMs) return cached.items;
    const items = await this.store.load(tenantId);
    this.cache.set(tenantId, { at: this.now(), items });
    return items;
  }

  async isRevoked(tenantId: string, claims: RevocationClaims): Promise<RevocationDecision> {
    return decideRevocation(await this.list(tenantId), claims);
  }

  /** Record a revocation durably AND make it bite on this instance immediately. */
  async revoke(tenantId: string, revocation: TokenRevocation): Promise<void> {
    await this.store.record(tenantId, revocation);
    const items = await this.store.load(tenantId);
    this.cache.set(tenantId, { at: this.now(), items });
  }
}

/**
 * The kernel's `Authenticator`, revocation-aware: verifies exactly as `tokenAuthenticator` does (signature,
 * then claims, then the lifetime ceiling), then refuses a token the tenant has revoked. Like the plain
 * authenticator it returns a principal or nothing — never a reason — and sends the reason to the operator.
 */
export function revocationAwareAuthenticator(
  policy: TokenPolicy,
  revocations: TokenRevocationList,
  onRefusal?: (reason: TokenRefusal | 'revoked', detail: string) => void,
  now: () => number = () => Date.now(),
): (token: string) => Promise<Principal | undefined> {
  return async (token) => {
    const verdict = verifyToken(token, policy, now());
    if (!verdict.ok) {
      onRefusal?.(verdict.refusedBecause!, verdict.detail);
      return undefined;
    }
    const principal = verdict.principal!;
    const decision = await revocations.isRevoked(principal.tenantId, {
      sub: principal.userId,
      ...(verdict.claims?.jti === undefined ? {} : { jti: verdict.claims.jti }),
      ...(verdict.claims?.iat === undefined ? {} : { iat: verdict.claims.iat }),
    });
    if (decision.revoked) {
      onRefusal?.('revoked', decision.because ?? 'the token was revoked');
      return undefined;
    }
    return principal;
  };
}
