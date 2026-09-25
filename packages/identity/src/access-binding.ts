// Binding a verified identity to a customer principal, and step-up for sensitive actions (M02 / M20 / M22).
//
// Once a provider has authenticated a person and their token has been verified (slice 1a), the store
// still has to answer two questions before it does anything on their behalf:
//
//   1. WHO is this, here? — resolve the verified claims into a principal scoped to THIS tenant, with
//      the org memberships they actually hold. The tenant and subject come from the signed claims,
//      never from a header or path (OB-01), and a token for one tenant can never act in another.
//   2. Is this enough for THIS action? — an ordinary read is fine on a single factor; changing bank
//      details or exporting everything is not. Step-up requires a second factor to have been used
//      AND the authentication to still be fresh, else the action is refused pending re-auth.
//
// Both are pure decisions over data the caller already holds (the verified claims, the person's
// memberships, the clock). Nothing here mints a token or reads a store.

import type { IdentityClaims } from './oidc-port';
import { type OrgMembership, type OrgRole } from './org-membership';

/** A verified customer, resolved to what they are WITHIN one tenant. */
export interface CustomerPrincipal {
  readonly tenantId: string;
  readonly subject: string;
  readonly email?: string;
  readonly phoneNumber?: string;
  /** The orgs this subject is an active member of, in this tenant, with their role in each. */
  readonly orgs: readonly { readonly orgId: string; readonly role: OrgRole }[];
  /** How the person proved themselves this session (`amr`). */
  readonly amr: readonly string[];
  /** When they authenticated (epoch ms), for freshness decisions; undefined if the claim was absent. */
  readonly authTimeMs?: number;
}

export type BindOutcome = 'bound' | 'tenant_mismatch';

export interface BindResult {
  readonly outcome: BindOutcome;
  readonly principal?: CustomerPrincipal;
}

/**
 * Resolve verified claims into a customer principal for the tenant the request is for.
 *
 * Refuses when the claims' tenant is not the tenant being acted in — the one check that keeps a
 * correctly-signed token for tenant A from doing anything in tenant B (OB-01).
 */
export function bindCustomerPrincipal(input: {
  readonly claims: IdentityClaims;
  readonly requestTenantId: string;
  readonly memberships: readonly OrgMembership[];
}): BindResult {
  if (input.claims.tenantId !== input.requestTenantId) return { outcome: 'tenant_mismatch' };

  const orgs = input.memberships
    .filter(
      (m) => m.state === 'active' && m.tenantId === input.claims.tenantId && m.subject === input.claims.subject,
    )
    .map((m) => ({ orgId: m.orgId, role: m.role }));

  return {
    outcome: 'bound',
    principal: {
      tenantId: input.claims.tenantId,
      subject: input.claims.subject,
      ...(input.claims.email === undefined ? {} : { email: input.claims.email }),
      ...(input.claims.phoneNumber === undefined ? {} : { phoneNumber: input.claims.phoneNumber }),
      orgs,
      amr: input.claims.amr ?? [],
      ...(input.claims.authTime === undefined ? {} : { authTimeMs: input.claims.authTime * 1000 }),
    },
  };
}

/** Policy for when an action needs more than a single, possibly-stale factor. */
export interface StepUpPolicy {
  /** Actions that demand a second factor to have been used this session. */
  readonly secondFactorActions: readonly string[];
  /** `amr` values that count as a second factor (e.g. 'otp', 'mfa'). */
  readonly secondFactorAmr: readonly string[];
  /** Maximum age (seconds) of the authentication for a sensitive action; older ⇒ re-auth. */
  readonly maxAuthAgeSeconds: number;
}

export type StepUpOutcome = 'allowed' | 'needs_second_factor' | 'needs_reauth';

export interface StepUpDecision {
  readonly outcome: StepUpOutcome;
  readonly reason: string;
}

/**
 * Decide whether an authenticated principal may perform an action now.
 *
 * An action outside the sensitive set is allowed. A sensitive one needs BOTH a second factor in the
 * session's `amr` AND an authentication no older than the policy allows — the second-factor gap is
 * reported first (it is the harder requirement to satisfy: it needs a fresh login WITH the factor),
 * then staleness, so the caller can prompt for exactly what is missing.
 */
export function evaluateStepUp(input: {
  readonly action: string;
  readonly amr: readonly string[];
  readonly authTimeMs?: number;
  readonly nowMs: number;
  readonly policy: StepUpPolicy;
}): StepUpDecision {
  if (!input.policy.secondFactorActions.includes(input.action)) {
    return { outcome: 'allowed', reason: `"${input.action}" is not a step-up action` };
  }

  const hasSecondFactor = input.amr.some((m) => input.policy.secondFactorAmr.includes(m));
  if (!hasSecondFactor) {
    return {
      outcome: 'needs_second_factor',
      reason: `"${input.action}" needs a second factor (one of ${input.policy.secondFactorAmr.join(', ')}); the session used ${input.amr.length > 0 ? input.amr.join(', ') : 'none'}`,
    };
  }

  const ageMs = input.authTimeMs === undefined ? Infinity : input.nowMs - input.authTimeMs;
  if (ageMs > input.policy.maxAuthAgeSeconds * 1000) {
    return {
      outcome: 'needs_reauth',
      reason: `"${input.action}" needs a recent login (within ${input.policy.maxAuthAgeSeconds}s); this one is ${input.authTimeMs === undefined ? 'of unknown age' : `${Math.floor(ageMs / 1000)}s old`}`,
    };
  }

  return { outcome: 'allowed', reason: `second factor present and login is fresh` };
}
